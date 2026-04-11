import { describe, it, expect } from 'vitest';

describe('swarmChat', () => {
  it('exports streamChatForSwarm', async () => {
    const mod = await import('./swarmChat');
    expect(typeof mod.streamChatForSwarm).toBe('function');
  });

  it('looksLikeNaturalStop detects sentence-like endings', async () => {
    const { looksLikeNaturalStop } = await import('./swarmChat');
    expect(looksLikeNaturalStop('Done.')).toBe(true);
    expect(looksLikeNaturalStop('Really?')).toBe(true);
    expect(looksLikeNaturalStop('no')).toBe(false);
    expect(looksLikeNaturalStop('')).toBe(false);
  });

  it('mergeReasoningAndText wraps reasoning and preserves body', async () => {
    const { mergeReasoningAndText } = await import('./swarmChat');
    expect(mergeReasoningAndText('', 'hi')).toBe('hi');
    expect(mergeReasoningAndText('think', '')).toContain('<<PRIOR_THOUGHT>>');
    expect(mergeReasoningAndText('think', 'out')).toMatch(/PRIOR_THOUGHT/);
    expect(mergeReasoningAndText('think', 'out')).toContain('out');
  });
});
