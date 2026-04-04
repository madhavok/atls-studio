import { describe, expect, it } from 'vitest';
import { getProviderFromModel, mergeCompletionBlockers } from './aiService';

describe('getProviderFromModel', () => {
  it('maps known model id prefixes', () => {
    expect(getProviderFromModel('gpt-4o')).toBe('openai');
    expect(getProviderFromModel('gemini-2.0')).toBe('google');
    expect(getProviderFromModel('claude-3-5')).toBe('anthropic');
    expect(getProviderFromModel('unknown-model')).toBe('anthropic');
  });
});

describe('mergeCompletionBlockers', () => {
  it('returns first non-null blocker', () => {
    expect(
      mergeCompletionBlockers([
        { toolName: 'a', blocker: null },
        { toolName: 'b', blocker: 'stop' },
        { toolName: 'c', blocker: 'ignored' },
      ]),
    ).toBe('stop');
  });

  it('returns null when all clear', () => {
    expect(mergeCompletionBlockers([{ toolName: 'a', blocker: undefined }])).toBeNull();
  });
});
