import { describe, it, expect } from 'vitest';
import type { UnifiedBatchResult } from './batch/types';

const {
  getProviderFromModel,
  areToolsEnabledForProvider,
  deriveMutationCompletionBlocker,
  mergeCompletionBlockers,
} = await import('./aiService');

describe('aiService exported helpers', () => {
  it('getProviderFromModel maps model id prefixes', () => {
    expect(getProviderFromModel('gpt-4o')).toBe('openai');
    expect(getProviderFromModel('o3-mini')).toBe('openai');
    expect(getProviderFromModel('gemini-2.0-flash')).toBe('google');
    expect(getProviderFromModel('claude-3-5-sonnet-20241022')).toBe('anthropic');
    expect(getProviderFromModel('unknown-model')).toBe('anthropic');
  });

  it('areToolsEnabledForProvider disables tools in ask mode only', () => {
    expect(areToolsEnabledForProvider('anthropic', 'ask')).toBe(false);
    expect(areToolsEnabledForProvider('anthropic', 'agent')).toBe(true);
  });

  it('deriveMutationCompletionBlocker returns undefined when nothing blocks', () => {
    const empty: UnifiedBatchResult = {
      ok: true,
      summary: '',
      duration_ms: 0,
      step_results: [],
    };
    expect(deriveMutationCompletionBlocker(empty)).toBeUndefined();
  });
});

describe('mergeCompletionBlockers', () => {
  it('returns null when no entries', () => {
    expect(mergeCompletionBlockers([])).toBeNull();
  });

  it('returns null when all blockers are null', () => {
    expect(mergeCompletionBlockers([
      { toolName: 'task_complete', blocker: null },
      { toolName: 'batch', blocker: null },
    ])).toBeNull();
  });

  it('returns first non-null blocker (batch before task_complete)', () => {
    expect(mergeCompletionBlockers([
      { toolName: 'batch', blocker: 'verify.build failed.' },
      { toolName: 'task_complete', blocker: null },
    ])).toBe('verify.build failed.');
  });

  it('returns non-null blocker even when task_complete entry appears first', () => {
    expect(mergeCompletionBlockers([
      { toolName: 'task_complete', blocker: null },
      { toolName: 'batch', blocker: 'Final verification is still required before task completion.' },
    ])).toBe('Final verification is still required before task completion.');
  });

  it('returns first non-null when multiple blockers exist', () => {
    expect(mergeCompletionBlockers([
      { toolName: 'batch', blocker: 'verify.build failed.' },
      { toolName: 'batch', blocker: 'Verify artifact stale.' },
    ])).toBe('verify.build failed.');
  });

  it('treats undefined blocker as non-blocking (skips it)', () => {
    expect(mergeCompletionBlockers([
      { toolName: 'batch', blocker: undefined },
      { toolName: 'batch', blocker: 'verify needed' },
    ])).toBe('verify needed');
  });
});
