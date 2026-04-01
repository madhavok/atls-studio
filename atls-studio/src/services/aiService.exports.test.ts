import { describe, it, expect } from 'vitest';
import type { UnifiedBatchResult } from './batch/types';

const {
  getProviderFromModel,
  areToolsEnabledForProvider,
  deriveMutationCompletionBlocker,
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
