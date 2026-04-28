import { describe, it, expect } from 'vitest';
import { looksLikeNaturalStop, mergeReasoningAndText, streamChatForSwarm } from './swarmChat';

describe('swarmChat', () => {
  it('exports streamChatForSwarm', () => {
    expect(typeof streamChatForSwarm).toBe('function');
  });

  it('looksLikeNaturalStop detects sentence-like endings', () => {
    expect(looksLikeNaturalStop('Done.')).toBe(true);
    expect(looksLikeNaturalStop('Really?')).toBe(true);
    expect(looksLikeNaturalStop('no')).toBe(false);
    expect(looksLikeNaturalStop('')).toBe(false);
  });

  it('mergeReasoningAndText wraps reasoning and preserves body', () => {
    expect(mergeReasoningAndText('', 'hi')).toBe('hi');
    expect(mergeReasoningAndText('think', '')).toContain('<<PRIOR_THOUGHT>>');
    expect(mergeReasoningAndText('think', 'out')).toMatch(/PRIOR_THOUGHT/);
    expect(mergeReasoningAndText('think', 'out')).toContain('out');
  });
});
