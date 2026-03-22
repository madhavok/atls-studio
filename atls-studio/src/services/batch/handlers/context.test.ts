import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from '../../../stores/contextStore';
import { handleRead, handleReadLines, handleReadShaped } from './context';

const invokeMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('../../toolHelpers', () => ({
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
}));

function resetContextStore() {
  useContextStore.getState().resetSession();
  useContextStore.setState({ hashStack: [], editHashStack: [] });
}

function makeCtx(overrides?: Partial<Parameters<typeof handleRead>[1]>) {
  return {
    atlsBatchQuery: vi.fn(),
    expandFilePathRefs: vi.fn(async (filePaths: string[]) => ({
      items: filePaths.map((path) => ({ kind: 'path', path })),
      notes: [],
    })),
    store: () => useContextStore.getState(),
    getProjectPath: () => null,
    ...overrides,
  } as unknown as Parameters<typeof handleRead>[1];
}

describe('context handlers snapshot authority', () => {
  beforeEach(() => {
    resetContextStore();
    invokeMock.mockReset();
    invokeWithTimeoutMock.mockReset();
  });

  it('returns canonical snapshot results for read.context', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/demo.ts', content: 'const demo = 1;\n', snapshot_hash: 'canon1234' }],
      }),
    });

    const result = await handleRead({ type: 'full', file_paths: ['src/demo.ts'] }, ctx);

    expect(result.ok).toBe(true);
    expect((result.content as { results: Array<Record<string, unknown>> }).results).toEqual([
      { file: 'src/demo.ts', h: expect.any(String), snapshot_hash: 'canon1234' },
    ]);
  });

  it('keeps shaped reads tied to the backend snapshot authority', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/demo.ts', content: 'function demo() {\n  return 1;\n}\n', snapshot_hash: 'canon1234' }],
      }),
    });

    invokeWithTimeoutMock.mockResolvedValueOnce({
      content: 'function demo() {\n  return 1;\n}\n',
      source: 'src/demo.ts',
      snapshot_hash: 'canon1234',
    });
    invokeWithTimeoutMock.mockResolvedValueOnce({
      content: 'function demo();',
      source: 'src/demo.ts',
      snapshot_hash: 'canon1234',
      selector: 'sig',
    });

    const result = await handleReadShaped({ file_paths: ['src/demo.ts'], shape: 'sig' }, ctx);

    expect(result.ok).toBe(true);
    const results = (result.content as { results: Array<Record<string, unknown>> }).results;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ file: 'src/demo.ts', h: 'h:canon1', snapshot_hash: 'canon1234', selector: 'sig' });
    expect(results[0]).toHaveProperty('shape_hash');
    const staged = [...useContextStore.getState().stagedSnippets.values()];
    expect(staged[0]?.sourceRevision).toBe('canon1234');
  });

  it('includes snapshot_hash in read.lines content payloads', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        file: 'src/demo.ts',
        h: 'h:canon1',
        snapshot_hash: 'canon1234',
        target_range: [[2, 3]],
        actual_range: [[2, 3]],
        context_lines: 2,
        content: 'const demo = 1;',
      }),
    });

    const result = await handleReadLines({ hash: 'h:canon1234', lines: '2-3' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.refs).toEqual(['h:canon1']);
    expect(result.content).toMatchObject({
      file: 'src/demo.ts',
      snapshot_hash: 'canon1234',
    });
  });
});
