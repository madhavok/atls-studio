import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runMockSwarmWorker } from './mockSwarmWorker';

describe('runMockSwarmWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns configured result per task id', async () => {
    const r = await runMockSwarmWorker('t1', { t1: { ok: false, error: 'x' } });
    expect(r).toEqual({ ok: false, error: 'x' });
  });

  it('defaults to success', async () => {
    const r = await runMockSwarmWorker('unknown', {});
    expect(r.ok).toBe(true);
  });

  it('honors delay before resolving (worker latency simulation)', async () => {
    const p = runMockSwarmWorker('slow', { slow: { ok: true, summary: 'done' } }, 50);
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, summary: 'done' });
  });
});
