/**
 * Delegate operation handlers — retriever and design subagent dispatch.
 */

import type { OpHandler, StepOutput } from '../types';

function ok(summary: string, content?: unknown): StepOutput {
  return { kind: 'raw', ok: true, refs: [], summary, content };
}

function err(summary: string): StepOutput {
  return { kind: 'raw', ok: false, refs: [], summary, error: summary };
}

export const handleDelegateRetrieve: OpHandler = async (params, _ctx) => {
  try {
    const { useAppStore } = await import('../../../stores/appStore');
    const appStore = useAppStore.getState();
    if (!appStore.projectPath) return err('delegate.retrieve: ERROR no project path set');

    const settings = appStore.settings;
    if (settings.subagentModel === 'none') {
      return err('delegate.retrieve: ERROR subagent is disabled');
    }

    const { executeRetriever } = await import('../../subagentService');
    const result = await executeRetriever({
      type: 'retriever',
      query: String(params.query || ''),
      focus_files: Array.isArray(params.focus_files) ? params.focus_files as string[] : undefined,
      max_tokens: typeof params.max_tokens === 'number' ? params.max_tokens as number : undefined,
    });

    return ok(result.content, result);
  } catch (delegateErr) {
    return err(`delegate.retrieve: ERROR ${delegateErr instanceof Error ? delegateErr.message : String(delegateErr)}`);
  }
};

export const handleDelegateDesign: OpHandler = async (params, _ctx) => {
  try {
    const { useAppStore } = await import('../../../stores/appStore');
    const appStore = useAppStore.getState();
    if (!appStore.projectPath) return err('delegate.design: ERROR no project path set');

    const settings = appStore.settings;
    if (settings.subagentModel === 'none') {
      return err('delegate.design: ERROR subagent is disabled');
    }

    const { executeDesign } = await import('../../subagentService');
    const result = await executeDesign({
      type: 'design',
      query: String(params.query || ''),
      focus_files: Array.isArray(params.focus_files) ? params.focus_files as string[] : undefined,
      max_tokens: typeof params.max_tokens === 'number' ? params.max_tokens as number : undefined,
    });

    return ok(result.content, result);
  } catch (delegateErr) {
    return err(`delegate.design: ERROR ${delegateErr instanceof Error ? delegateErr.message : String(delegateErr)}`);
  }
};
