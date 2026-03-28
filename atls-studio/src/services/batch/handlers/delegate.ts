/**
 * Delegate operation handlers — subagent dispatch for all roles.
 */

import type { OpHandler, StepOutput } from '../types';

function ok(summary: string, refs: string[], content?: unknown): StepOutput {
  return { kind: 'raw', ok: true, refs, summary, content };
}

function err(summary: string): StepOutput {
  return { kind: 'raw', ok: false, refs: [], summary, error: summary };
}

async function runDelegate(
  role: 'retriever' | 'design' | 'coder' | 'tester',
  params: Record<string, unknown>,
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
    const result = await executeSubagent({
      type: role,
      query: queryWithContext,
      focus_files: Array.isArray(params.focus_files) ? params.focus_files as string[] : undefined,
      max_tokens: typeof params.max_tokens === 'number' ? params.max_tokens as number : undefined,
      token_budget: typeof params.token_budget === 'number' ? params.token_budget as number : undefined,
    });

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

export const handleDelegateRetrieve: OpHandler = async (params) => {
  return runDelegate('retriever', params);
};

export const handleDelegateDesign: OpHandler = async (params) => {
  return runDelegate('design', params);
};

export const handleDelegateCode: OpHandler = async (params) => {
  return runDelegate('coder', params);
};

export const handleDelegateTest: OpHandler = async (params) => {
  return runDelegate('tester', params);
};
