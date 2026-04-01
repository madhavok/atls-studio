import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { rateLimiter } from './rateLimiter';

describe('rateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    rateLimiter.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under per-minute cap', () => {
    expect(rateLimiter.canProceed('anthropic', 1000)).toBe(true);
  });

  it('blocks when minute request cap is exceeded', () => {
    rateLimiter.setConfig('anthropic', { requestsPerMinute: 2, tokensPerMinute: 1_000_000 });
    rateLimiter.recordSuccess('anthropic', 100, 100);
    rateLimiter.recordSuccess('anthropic', 100, 100);
    expect(rateLimiter.canProceed('anthropic', 100)).toBe(false);
  });

  it('resets minute window after MINUTE_MS', () => {
    rateLimiter.setConfig('anthropic', { requestsPerMinute: 1, tokensPerMinute: 1_000_000 });
    expect(rateLimiter.canProceed('anthropic', 100)).toBe(true);
    rateLimiter.recordSuccess('anthropic', 100, 100);
    expect(rateLimiter.canProceed('anthropic', 100)).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(rateLimiter.canProceed('anthropic', 100)).toBe(true);
  });

  it('applies backoff after recordRateLimitError', () => {
    rateLimiter.recordRateLimitError('openai', 2);
    expect(rateLimiter.canProceed('openai', 100)).toBe(false);
    vi.advanceTimersByTime(2001);
    expect(rateLimiter.canProceed('openai', 100)).toBe(true);
  });
});
