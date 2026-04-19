/**
 * Delegate operation handlers — subagent dispatch for all roles.
 */

import type { HandlerContext, OpHandler, StepOutput, SubAgentProgressEvent } from '../types';
import type { SubAgentProgress, SubAgentToolTraceEntry } from '../../subagentService';
import { countTokensSync } from '../../../utils/tokenCounter';

/** Max chars for assistant-only block when no blackboard body is inlined. */
const DELEGATE_FINAL_TEXT_CAP = 2000;
/** Per-BB-key cap; total findings section also bounded by DELEGATE_FINDINGS_TOTAL_CAP. */
const DELEGATE_BB_PER_KEY_CAP = 2800;
/** Combined cap for inlined blackboard text + optional final assistant turn in the step summary. */
const DELEGATE_FINDINGS_TOTAL_CAP = 5200;
/** Hard cap on the per-round action trace we inline into the delegate summary. */
const DELEGATE_TRACE_MAX_TOKENS = 300;
/** Max actions surfaced per round in the trace digest. */
const DELEGATE_TRACE_ACTIONS_PER_ROUND = 3;
/** Max chars for a single compacted trace message. */
const DELEGATE_TRACE_MSG_CAP = 60;
const FOCUS_CONTEXT_CAP = 3000;

/**
 * Build the delegate "findings" appendix: blackboard bodies first (canonical), then optional final assistant text.
 */
function buildDelegateFindingsAppendix(
  bbKeys: string[],
  getBlackboardEntry: (key: string) => string | null,
  finalText: string | undefined,
): string {
  let budget = DELEGATE_FINDINGS_TOTAL_CAP;
  const chunks: string[] = [];

  for (const key of bbKeys) {
    const raw = getBlackboardEntry(key);
    if (!raw?.trim()) continue;
    const header = `\n\n--- Blackboard (${key}) ---\n`;
    const overhead = header.length + 24;
    const maxBody = Math.min(DELEGATE_BB_PER_KEY_CAP, Math.max(0, budget - overhead));
    if (maxBody < 40) break;
    const body = raw.length > maxBody
      ? `${raw.slice(0, maxBody)}\n... [truncated]`
      : raw;
    const block = header + body;
    chunks.push(block);
    budget -= block.length;
  }

  const trimmedFinal = finalText?.trim();
  if (trimmedFinal) {
    // After blackboard blocks, optional assistant text uses a distinct heading; assistant-only
    // runs keep the legacy "--- Delegate Findings ---" label.
    const header = chunks.length > 0
      ? `\n\n--- Assistant (final turn) ---\n`
      : `\n\n--- Delegate Findings ---\n`;
    const room = budget - header.length;
    if (room > 40) {
      const cap = Math.min(DELEGATE_FINAL_TEXT_CAP, room);
      const text = trimmedFinal.length > cap
        ? `${trimmedFinal.slice(0, cap)}... [truncated]`
        : trimmedFinal;
      chunks.push(header + text);
    }
  }

  return chunks.join('');
}

function ok(summary: string, refs: string[], content?: unknown): StepOutput {
  return { kind: 'raw', ok: true, refs, summary, content };
}

function err(summary: string): StepOutput {
  return { kind: 'raw', ok: false, refs: [], summary, error: summary };
}

/**
 * Strip the common progress-prefix ("Searching: ", "Reading: ", ...) and
 * truncate to a compact form for inline display in the delegate summary.
 */
function compactTraceMsg(message: string): string {
  const stripped = message.replace(/^(Searching|Reading|Pinning|Editing|Verifying|Processing):\s*/i, '');
  return stripped.length > DELEGATE_TRACE_MSG_CAP
    ? stripped.slice(0, DELEGATE_TRACE_MSG_CAP - 1) + '…'
    : stripped;
}

/**
 * Build a compact per-round action digest from the subagent's toolTrace.
 * Surfaces up to N actions per round so the caller can inspect what the
 * sub-agent actually did without having to dig through the batch UI's
 * synthetic child tool calls.
 *
 * Budget: capped at DELEGATE_TRACE_MAX_TOKENS to stay within the
 * overhead-<=10% ATLS gate on delegate summaries.
 */
export function buildRoundDigest(toolTrace: SubAgentToolTraceEntry[] | undefined): string {
  if (!toolTrace || toolTrace.length === 0) return '';
  const byRound = new Map<number, string[]>();
  for (const entry of toolTrace) {
    if (entry.done) continue;
    const bucket = byRound.get(entry.round) ?? [];
    if (bucket.length >= DELEGATE_TRACE_ACTIONS_PER_ROUND) continue;
    bucket.push(compactTraceMsg(entry.message));
    byRound.set(entry.round, bucket);
  }
  if (byRound.size === 0) return '';
  const rounds = [...byRound.keys()].sort((a, b) => a - b);
  const lines = rounds.map(r => `R${r + 1}: ${(byRound.get(r) ?? []).join(' · ')}`);
  const digest = `\n  trace: ${lines.join(' | ')}`;
  if (countTokensSync(digest) <= DELEGATE_TRACE_MAX_TOKENS) return digest;
  // Truncate from the tail: drop later rounds until under cap.
  for (let end = lines.length - 1; end > 0; end--) {
    const truncated = `\n  trace: ${lines.slice(0, end).join(' | ')} | …`;
    if (countTokensSync(truncated) <= DELEGATE_TRACE_MAX_TOKENS) return truncated;
  }
  // Single round already over cap: hard-truncate its text.
  return `\n  trace: ${lines[0].slice(0, DELEGATE_TRACE_MSG_CAP * 2)}…`;
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
      fileClaims: ctx?.fileClaims,
    }, onProgress);

    const pinnedHashes = result.refs
      .filter(r => r.pinned || r.type === 'staged')
      .map(r => `h:${r.hash}`);
    const refHashes = result.refs.map(r => `h:${r.shortHash}`);
    let summary = `${role}: ${result.refs.length} refs (${(result.pinTokens / 1000).toFixed(1)}k tk), ${result.rounds} rounds` +
      (result.bbKeys.length > 0 ? ` | BB: ${result.bbKeys.join(', ')}` : '');

    const store = useContextStore.getState();
    summary += buildDelegateFindingsAppendix(
      result.bbKeys,
      (key) => store.getBlackboardEntry(key),
      result.finalText,
    );

    // Round digest: compact per-round action trace so the caller can
    // verify what the sub-agent did before trusting its refs.
    summary += buildRoundDigest(result.toolTrace);

    if (refHashes.length > 0) {
      summary += '\n⚠ VOLATILE — delegate refs expire next round. pin key refs or `bw` to persist findings.';
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
      toolTrace: result.toolTrace,
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
