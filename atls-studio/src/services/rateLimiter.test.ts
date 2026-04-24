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

  it('uses explicit retry-after seconds for recordRateLimitError', () => {
    rateLimiter.recordRateLimitError('google', 10);
    expect(rateLimiter.getWaitTime('google')).toBeGreaterThan(9000);
  });

  it('backs off after repeated recordError', () => {
    rateLimiter.recordError('vertex');
    rateLimiter.recordError('vertex');
    rateLimiter.recordError('vertex');
    expect(rateLimiter.canProceed('vertex', 100)).toBe(false);
  });

  it('blocks on token and day limits and reports wait from getWaitTime', () => {
    rateLimiter.setConfig('lmstudio', {
      requestsPerMinute: 100,
      tokensPerMinute: 100,
      requestsPerDay: 2,
      tokensPerDay: 500,
    });
    expect(rateLimiter.canProceed('lmstudio', 200)).toBe(false);
    rateLimiter.setConfig('lmstudio', { tokensPerMinute: 1_000_000 });
    expect(rateLimiter.canProceed('lmstudio', 100)).toBe(true);
    rateLimiter.recordSuccess('lmstudio', 100, 100);
    rateLimiter.recordSuccess('lmstudio', 100, 100);
    expect(rateLimiter.getWaitTime('lmstudio')).toBeGreaterThan(0);
  });

  it('blocks when concurrent request slots are full', async () => {
    rateLimiter.setConfig('anthropic', { requestsPerMinute: 50, tokensPerMinute: 1_000_000, concurrentRequests: 1 });
    const first = await rateLimiter.acquire('anthropic', 10);
    expect(first).toBe(true);
    expect(rateLimiter.canProceed('anthropic', 10)).toBe(false);
    rateLimiter.release('anthropic');
    expect(rateLimiter.canProceed('anthropic', 10)).toBe(true);
  });

  it('exposes getState and getAllStates', () => {
    const s = rateLimiter.getState('anthropic');
    expect(s).not.toBeNull();
    expect(s?.minuteUsage.limit.requests).toBeGreaterThan(0);
    const all = rateLimiter.getAllStates();
    expect(Object.keys(all).sort()).toEqual(['anthropic', 'google', 'lmstudio', 'openai', 'vertex'].sort());
  });

  it('rejects queued acquires on reset', async () => {
    rateLimiter.setConfig('openai', { requestsPerMinute: 1, tokensPerMinute: 1_000_000 });
    rateLimiter.recordSuccess('openai', 1, 1);
    const p = rateLimiter.acquire('openai', 10);
    rateLimiter.reset();
    await expect(p).rejects.toThrow(/reset/);
  });
});
