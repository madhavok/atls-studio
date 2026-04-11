import { describe, expect, it } from 'vitest';
import { runMockSwarmWorker } from './mockSwarmWorker';

describe('runMockSwarmWorker', () => {
  it('returns configured result per task id', async () => {
    const r = await runMockSwarmWorker('t1', { t1: { ok: false, error: 'x' } });
    expect(r).toEqual({ ok: false, error: 'x' });
  });

  it('defaults to success', async () => {
    const r = await runMockSwarmWorker('unknown', {});
    expect(r.ok).toBe(true);
  });
});
