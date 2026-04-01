import { describe, it, expect } from 'vitest';
import { executeWithConcurrency } from './aiConcurrency';

describe('executeWithConcurrency', () => {
  it('runs all tasks with limit 1 in order', async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map(
      n => () =>
        new Promise<number>(resolve => {
          order.push(n);
          resolve(n * 2);
        }),
    );
    const out = await executeWithConcurrency(tasks, 1);
    expect(out).toEqual([2, 4, 6]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('respects concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return i;
    });
    await executeWithConcurrency(tasks, 3);
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('throws first task error after all complete', async () => {
    const tasks = [
      () => Promise.resolve(1),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve(3),
    ];
    await expect(executeWithConcurrency(tasks, 2)).rejects.toThrow('boom');
  });

  it('returns sparse results when already aborted before work runs', async () => {
    const controller = new AbortController();
    controller.abort();
    const tasks = [
      () => new Promise<number>(() => {}),
      () => new Promise<number>(() => {}),
    ];
    const out = await executeWithConcurrency(tasks, 1, controller.signal);
    expect(out.length).toBe(2);
    expect(out.every(x => x === undefined)).toBe(true);
  });
});
