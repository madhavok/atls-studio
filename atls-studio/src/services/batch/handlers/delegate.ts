/**
 * Delegate operation handlers — subagent dispatch for all roles.
 */

import type { HandlerContext, OpHandler, StepOutput, SubAgentProgressEvent } from '../types';

function ok(summary: string, refs: string[], content?: unknown): StepOutput {
  return { kind: 'raw', ok: true, refs, summary, content };
}

function err(summary: string): StepOutput {
  return { kind: 'raw', ok: false, refs: [], summary, error: summary };
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

    const wsRev = (await import('../../../stores/contextStore')).useContextStore.getState().getCurrentRev();
    const queryWithContext = `${String(params.query || '')} [workspace_rev=${wsRev}]`;

    const { executeSubagent } = await import('../../subagentService');
    const onProgress = (ctx?.onSubagentProgress && stepId)
      ? (p: { toolName?: string; status?: string; round?: number; done?: boolean }) => {
          ctx.onSubagentProgress!(stepId, {
            toolName: p.toolName ?? 'unknown',
            status: p.status ?? '',
            round: p.round ?? 0,
            done: p.done ?? false,
          } satisfies SubAgentProgressEvent);
        }
      : undefined;
    const result = await executeSubagent({
      type: role,
      query: queryWithContext,
      focus_files: Array.isArray(params.focus_files) ? params.focus_files as string[] : undefined,
      max_tokens: typeof params.max_tokens === 'number' ? params.max_tokens as number : undefined,
      token_budget: typeof params.token_budget === 'number' ? params.token_budget as number : undefined,
    }, onProgress);

    const pinnedHashes = result.refs
      .filter(r => r.pinned || r.type === 'staged')
      .map(r => `h:${r.hash}`);
    const refHashes = result.refs.map(r => `h:${r.shortHash}`);
    const summary = `${role}: ${result.refs.length} refs (${(result.pinTokens / 1000).toFixed(1)}k tk), ${result.rounds} rounds` +
      (result.bbKeys.length > 0 ? ` | BB: ${result.bbKeys.join(', ')}` : '');

    return ok(summary, pinnedHashes, {
      refs: result.refs,
      bbKeys: result.bbKeys,
      pinCount: result.pinCount,
      pinTokens: result.pinTokens,
      rounds: result.rounds,
      toolCalls: result.toolCalls,
      invocationId: result.invocationId,
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
