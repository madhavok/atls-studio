/**
 * Delegate operation handlers — subagent dispatch for all roles.
 */

import type { HandlerContext, OpHandler, StepOutput, SubAgentProgressEvent } from '../types';
import type { SubAgentProgress } from '../../subagentService';

const DELEGATE_FINAL_TEXT_CAP = 2000;
const FOCUS_CONTEXT_CAP = 3000;

function ok(summary: string, refs: string[], content?: unknown): StepOutput {
  return { kind: 'raw', ok: true, refs, summary, content };
}

function err(summary: string): StepOutput {
  return { kind: 'raw', ok: false, refs: [], summary, error: summary };
}

/**
 * Resolve focus file paths to structured context lines using chunks/staged data.
 * Returns lines like: `- src/api.ts (h:abc1:1-150, 150 lines) — exports: fn1, fn2`
 * When no cached context exists, performs a live signature read via the batch
 * executor to pre-seed the subagent with actual code content.
 *
 * @param ctxStore - pre-imported context store (caller already has it from await import)
 */
async function resolveFocusFileContext(
  focusFiles: string[],
  ctxStore: { getState: () => { stagedSnippets: Map<string, { source?: string; content: string; tokens: number; lines?: string; stageState?: string; suspectSince?: number; freshness?: string }>; chunks: Map<string, { source?: string; shortHash: string; tokens: number; editDigest?: string; digest?: string; summary?: string; suspectSince?: number; freshness?: string }> } },
): Promise<string | undefined> {
  if (focusFiles.length === 0) return undefined;
  try {
    const ctx = ctxStore.getState();
    const lines: string[] = [];
    const unresolvedPaths: string[] = [];

    for (const filePath of focusFiles) {
      const normPath = filePath.replace(/\\/g, '/');
      let resolved = false;

      for (const [, snippet] of ctx.stagedSnippets) {
        if (!snippet.source) continue;
        if (snippet.stageState === 'stale' || snippet.suspectSince != null || snippet.freshness === 'suspect' || snippet.freshness === 'changed') continue;
        const normSrc = snippet.source.replace(/\\/g, '/');
        if (normSrc === normPath || normSrc.endsWith('/' + normPath)) {
          const lineInfo = snippet.lines ? `, ${snippet.lines}` : '';
          const preview = snippet.content.length > 200
            ? snippet.content.slice(0, 200).replace(/\n/g, ' ') + '...'
            : snippet.content.replace(/\n/g, ' ');
          lines.push(`- ${filePath} (${snippet.tokens}tk${lineInfo}) — ${preview}`);
          resolved = true;
          break;
        }
      }
      if (resolved) continue;

      for (const [, chunk] of ctx.chunks) {
        if (!chunk.source) continue;
        if (chunk.suspectSince != null || chunk.freshness === 'suspect' || chunk.freshness === 'changed') continue;
        const normSrc = chunk.source.replace(/\\/g, '/');
        if (normSrc === normPath || normSrc.endsWith('/' + normPath)) {
          const ref = `h:${chunk.shortHash}`;
          const summary = chunk.editDigest || chunk.digest || chunk.summary || '';
          const summaryText = summary ? ` — ${summary.slice(0, 200)}` : '';
          lines.push(`- ${filePath} (${ref}, ${chunk.tokens}tk)${summaryText}`);
          resolved = true;
          break;
        }
      }
      if (resolved) continue;

      unresolvedPaths.push(filePath);
    }

    if (unresolvedPaths.length > 0) {
      try {
        const { executeToolCall } = await import('../../aiService');
        const result = await executeToolCall('batch', {
          steps: unresolvedPaths.map((p, i) => ({
            id: `ff${i}`,
            use: 'read.shaped',
            with: { file_paths: [p], shape: 'sig', max_files: 1 },
          })),
          version: '1.0',
        });
        const resultStr = typeof result === 'string' ? result : String(result);
        const sigPreview = resultStr.length > FOCUS_CONTEXT_CAP
          ? resultStr.slice(0, FOCUS_CONTEXT_CAP) + '...'
          : resultStr;
        lines.push(sigPreview);
      } catch {
        for (const p of unresolvedPaths) lines.push(`- ${p}`);
      }
    }

    const result = lines.join('\n');
    return result.length > FOCUS_CONTEXT_CAP
      ? result.slice(0, FOCUS_CONTEXT_CAP) + '\n... (truncated)'
      : result;
  } catch {
    return undefined;
  }
}

async function runDelegate(
  role: 'retriever' | 'design' | 'coder' | 'tester',
  params: Record<string, unknown>,
  ctx?: HandlerContext,
  stepId?: string,
): Promise<StepOutput> {
  try {
    const { useAppStore } = await import('../../../stores/appStore');
    const appStore = useAppStore.getState();
    if (!appStore.projectPath) return err(`delegate.${role}: ERROR no project path set`);

    const settings = appStore.settings;
    if (settings.subagentModel === 'none') {
      return err(`delegate.${role}: ERROR subagent is disabled`);
    }

    const { useContextStore } = await import('../../../stores/contextStore');
    const wsRev = useContextStore.getState().getCurrentRev();
    const queryWithContext = `${String(params.query || '')} [workspace_rev=${wsRev}]`;

    const focusFiles = Array.isArray(params.focus_files) ? params.focus_files as string[] : undefined;
    const focusFileContext = focusFiles ? await resolveFocusFileContext(focusFiles, useContextStore) : undefined;

    const { executeSubagent } = await import('../../subagentService');
    const onProgress = (ctx?.onSubagentProgress && stepId)
      ? (p: SubAgentProgress) => {
          ctx.onSubagentProgress!(stepId, {
            toolName: p.toolName ?? 'unknown',
            status: p.message || p.status,
            round: p.round ?? 0,
            done: p.done ?? false,
          } satisfies SubAgentProgressEvent);
        }
      : undefined;
    const result = await executeSubagent({
      type: role,
      query: queryWithContext,
      focus_files: focusFiles,
      focus_file_context: focusFileContext,
      max_tokens: typeof params.max_tokens === 'number' ? params.max_tokens as number : undefined,
      token_budget: typeof params.token_budget === 'number' ? params.token_budget as number : undefined,
    }, onProgress);

    const pinnedHashes = result.refs
      .filter(r => r.pinned || r.type === 'staged')
      .map(r => `h:${r.hash}`);
    const refHashes = result.refs.map(r => `h:${r.shortHash}`);
    let summary = `${role}: ${result.refs.length} refs (${(result.pinTokens / 1000).toFixed(1)}k tk), ${result.rounds} rounds` +
      (result.bbKeys.length > 0 ? ` | BB: ${result.bbKeys.join(', ')}` : '');

    if (result.finalText) {
      const capped = result.finalText.length > DELEGATE_FINAL_TEXT_CAP
        ? result.finalText.slice(0, DELEGATE_FINAL_TEXT_CAP) + '... [truncated]'
        : result.finalText;
      summary += `\n\n--- Delegate Findings ---\n${capped}`;
    }

    return ok(summary, pinnedHashes, {
      refs: result.refs,
      bbKeys: result.bbKeys,
      pinCount: result.pinCount,
      pinTokens: result.pinTokens,
      rounds: result.rounds,
      toolCalls: result.toolCalls,
      invocationId: result.invocationId,
      finalText: result.finalText,
      refHashes,
    });
  } catch (delegateErr) {
    return err(`delegate.${role}: ERROR ${delegateErr instanceof Error ? delegateErr.message : String(delegateErr)}`);
  }
}

export const handleDelegateRetrieve: OpHandler = async (params, ctx, stepId) => {
  return runDelegate('retriever', params, ctx, stepId);
};

export const handleDelegateDesign: OpHandler = async (params, ctx, stepId) => {
  return runDelegate('design', params, ctx, stepId);
};

export const handleDelegateCode: OpHandler = async (params, ctx, stepId) => {
  return runDelegate('coder', params, ctx, stepId);
};

export const handleDelegateTest: OpHandler = async (params, ctx, stepId) => {
  return runDelegate('tester', params, ctx, stepId);
};
