import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from '../../../stores/contextStore';
import { handleLoad, handleRead, handleReadLines, handleReadShaped } from './context';

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

  it('multi-path read.file (load) ingests one chunk per file and returns multiple refs', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [
          { file: 'src/a.ts', content: 'export const a = 1;\n', content_hash: 'ha111111' },
          { file: 'src/b.ts', content: 'export const b = 2;\n', content_hash: 'hb222222' },
        ],
      }),
    });

    const result = await handleLoad({ file_paths: ['src/a.ts', 'src/b.ts'] }, ctx);

    expect(result.ok).toBe(true);
    expect(result.refs).toHaveLength(2);
    expect(result.refs?.every(r => typeof r === 'string' && r.startsWith('h:'))).toBe(true);
    const content = result.content as { results: Array<{ file: string; h: string }> };
    expect(content?.results).toHaveLength(2);
    expect(useContextStore.getState().chunks.size).toBe(2);
  });

  it('returns canonical snapshot results for read.context', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/demo.ts', content: 'const demo = 1;\n', content_hash: 'canon1234' }],
      }),
    });

    const result = await handleRead({ type: 'full', file_paths: ['src/demo.ts'] }, ctx);

    expect(result.ok).toBe(true);
    expect((result.content as { results: Array<Record<string, unknown>> }).results).toEqual([
      { file: 'src/demo.ts', h: expect.any(String), content_hash: 'canon1234' },
    ]);
  });

  it('exposes content.file_paths and content.tree for type tree (intent.survey bindings)', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [
          {
            root: 'src',
            tree: '  a.ts (10L)',
            file_paths: ['src/a.ts', 'src/b.ts'],
            file_paths_truncated: false,
          },
        ],
      }),
    });

    const result = await handleRead({ type: 'tree', file_paths: ['src'] }, ctx);

    expect(result.ok).toBe(true);
    const c = result.content as {
      results: Array<Record<string, unknown>>;
      file_paths: string[];
      tree: string;
      file_paths_truncated?: boolean;
    };
    expect(c.file_paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(c.tree).toBe('  a.ts (10L)');
    expect(c.file_paths_truncated).toBeUndefined();
    expect(c.results[0]).toMatchObject({ file: 'src', h: expect.any(String), root: 'src' });
  });

  it('keeps shaped reads tied to the backend snapshot authority', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/demo.ts', content: 'function demo() {\n  return 1;\n}\n', content_hash: 'canon1234' }],
      }),
    });

    invokeWithTimeoutMock.mockResolvedValueOnce({
      content: 'function demo() {\n  return 1;\n}\n',
      source: 'src/demo.ts',
      content_hash: 'canon1234',
    });
    invokeWithTimeoutMock.mockResolvedValueOnce({
      content: 'function demo();',
      source: 'src/demo.ts',
      content_hash: 'canon1234',
      selector: 'sig',
    });

    const result = await handleReadShaped({ file_paths: ['src/demo.ts'], shape: 'sig' }, ctx);

    expect(result.ok).toBe(true);
    const results = (result.content as { results: Array<Record<string, unknown>> }).results;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ file: 'src/demo.ts', h: 'h:canon1', content_hash: 'canon1234', selector: 'sig' });
    expect(results[0]).toHaveProperty('shape_hash');
    const staged = [...useContextStore.getState().stagedSnippets.values()];
    expect(staged[0]?.sourceRevision).toBe('canon1234');
  });

  it('caps file_paths with max_files before expandFilePathRefs', async () => {
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'];
    const expand = vi.fn(async (filePaths: string[]) => ({
      items: filePaths.map((path) => ({ kind: 'path' as const, path })),
      notes: [] as string[],
    }));
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: paths.slice(0, 2).map(f => ({ file: f, content: 'x\n', content_hash: 'canon1234' })),
      }),
      expandFilePathRefs: expand,
    });
    invokeWithTimeoutMock
      .mockResolvedValueOnce({ content: 'x\n', source: 'src/a.ts', content_hash: 'canon1234' })
      .mockResolvedValueOnce({ content: 'sig a', source: 'src/a.ts', content_hash: 'canon1234', selector: 'sig' })
      .mockResolvedValueOnce({ content: 'x\n', source: 'src/b.ts', content_hash: 'canon1234' })
      .mockResolvedValueOnce({ content: 'sig b', source: 'src/b.ts', content_hash: 'canon1234', selector: 'sig' });

    const result = await handleReadShaped(
      { file_paths: paths, shape: 'sig', max_files: 2 },
      ctx,
    );

    expect(expand).toHaveBeenCalledWith(['src/a.ts', 'src/b.ts']);
    expect(result.summary).toContain('capped to 2 (max_files)');
    expect(result.ok).toBe(true);
  });

  it('includes content_hash in read.lines content payloads', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        file: 'src/demo.ts',
        h: 'h:deadbeefcafe',
        content_hash: 'deadbeefcafe1234567890abcdef',
        target_range: [[2, 3]],
        actual_range: [[2, 3]],
        context_lines: 2,
        content: 'const demo = 1;',
      }),
    });

    const result = await handleReadLines({ hash: 'h:deadbeefcafe1234567890abcdef', lines: '2-3' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.refs).toEqual(['h:deadbeefcafe:2-3']);
    expect(result.content).toMatchObject({
      file: 'src/demo.ts',
      content_hash: 'deadbeefcafe1234567890abcdef',
    });
  });
});
