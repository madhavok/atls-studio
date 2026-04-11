import { beforeEach, describe, expect, it, vi } from 'vitest';

function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
}

Object.defineProperty(globalThis, 'localStorage', {
  value: createLocalStorageMock(),
  configurable: true,
});

vi.mock('./batch/executor', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./batch/executor')>();
  return {
    ...mod,
    executeUnifiedBatch: vi.fn(),
  };
});

vi.mock('./toolHelpers', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./toolHelpers')>();
  return {
    ...mod,
    resolveToolParams: vi.fn(async (p: Record<string, unknown>) => ({ ...p })),
  };
});

import type { UnifiedBatchResult } from './batch/types';

const { formatBatchResult } = await import('./batch/resultFormatter');
const { useAppStore } = await import('../stores/appStore');
const { useContextStore } = await import('../stores/contextStore');
const { executeUnifiedBatch } = await import('./batch');
const { executeToolCall } = await import('./aiService');

describe('executeToolCall', () => {
  beforeEach(() => {
    vi.mocked(executeUnifiedBatch).mockReset();
    useContextStore.getState().resetSession();
    useAppStore.setState({ chatMode: 'agent' });
  });

  it('runs batch and returns formatBatchResult output', async () => {
    const mockResult: UnifiedBatchResult = {
      ok: true,
      summary: 'done',
      duration_ms: 3,
      step_results: [
        { id: 's1', use: 'session.stats', ok: true, duration_ms: 1, summary: 'tok stats' },
      ],
    };
    vi.mocked(executeUnifiedBatch).mockResolvedValue(mockResult);

    const out = await executeToolCall('batch', {
      version: '1.0',
      steps: [{ id: 's1', use: 'session.stats', with: {} }],
    });

    expect(out).toBe(formatBatchResult(mockResult));
    expect(vi.mocked(executeUnifiedBatch)).toHaveBeenCalledTimes(1);
  });

  it('task_complete advances non-done subtasks and lists files_changed', async () => {
    useContextStore.setState({
      taskPlan: {
        id: 'p1',
        goal: 'g',
        subtasks: [
          { id: 'st1', title: 't1', status: 'pending' },
          { id: 'st2', title: 't2', status: 'done' },
        ],
        activeSubtaskId: 'st1',
        status: 'active',
        createdAt: 1,
        retryCount: 0,
        evidenceRefs: [],
      },
    });
    const advanceSpy = vi.spyOn(useContextStore.getState(), 'advanceSubtask');

    const out = await executeToolCall('task_complete', {
      summary: 'all done',
      files_changed: ['src/a.ts'],
    });

    expect(out).toContain('\u2713 Task complete: all done');
    expect(out).toContain('src/a.ts');
    expect(advanceSpy).toHaveBeenCalledWith('st1', 'all done');
    advanceSpy.mockRestore();
  });

  it('task_complete accepts filesChanged camelCase', async () => {
    const out = await executeToolCall('task_complete', {
      summary: 'ok',
      filesChanged: ['b.ts'],
    });
    expect(out).toContain('b.ts');
  });

  it('rejects invalid or too-short tool names', async () => {
    const a = await executeToolCall('', {});
    expect(a).toMatch(/Invalid or empty tool name/);

    const b = await executeToolCall('x', {});
    expect(b).toMatch(/Invalid or empty tool name/);
  });

  it('steers unsupported tools to batch', async () => {
    const out = await executeToolCall('grep', {});
    expect(out).toMatch(/Unsupported tool: grep/);
    expect(out).toMatch(/batch\(\)/);
  });

  it('propagates executeUnifiedBatch errors', async () => {
    vi.mocked(executeUnifiedBatch).mockRejectedValue(new Error('boom'));

    const out = await executeToolCall('batch', {
      version: '1.0',
      steps: [{ id: 's1', use: 'session.stats', with: {} }],
    });

    expect(out).toBe('Error: boom');
  });
});
