import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from '../../../stores/contextStore';
import { materialize as hppMaterialize } from '../../hashProtocol';
import { handleEmit, handleLoad, handleRead, handleReadLines, handleReadShaped, handleShape } from './context';

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

  it('multi-path load surfaces _hash_warnings when a reused ref is suspect (external stale)', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [
          { file: 'src/a.ts', content: 'export const a = 1;\n', content_hash: 'hashaaa1' },
          { file: 'src/b.ts', content: 'export const b = 2;\n', content_hash: 'hashbbb1' },
        ],
      }),
    });

    await handleLoad({ file_paths: ['src/a.ts', 'src/b.ts'] }, ctx);

    const st0 = useContextStore.getState();
    for (const [, c] of st0.chunks) {
      const lineCount = (c.content.match(/\n/g) || []).length + 1;
      hppMaterialize(
        c.hash,
        c.type,
        c.source,
        c.tokens,
        lineCount,
        c.editDigest || c.digest || '',
        c.shortHash,
      );
    }

    const st = useContextStore.getState();
    const aEntry = [...st.chunks.entries()].find(([, c]) => c.source === 'src/a.ts');
    expect(aEntry).toBeDefined();
    const [aKey, aChunk] = aEntry!;
    useContextStore.setState((s) => {
      const nc = new Map(s.chunks);
      nc.set(aKey, {
        ...aChunk,
        suspectSince: Date.now(),
        freshnessCause: 'external_file_change',
      });
      return { chunks: nc };
    });

    const result = await handleLoad({ file_paths: ['src/a.ts', 'src/b.ts'] }, ctx);

    expect(result.ok).toBe(true);
    const withWarn = result as { _hash_warnings?: string[]; summary: string };
    expect(withWarn._hash_warnings).toBeDefined();
    expect(withWarn._hash_warnings![0]).toMatch(/stale|externally/i);
    expect(withWarn.summary).toMatch(/stale|externally/i);
  });

  it('returns canonical snapshot results for read.context', async () => {
    const ctx = makeCtx({
      atlsBatchQuery: vi.fn().mockResolvedValue({
        results: [{ file: 'src/demo.ts', content: 'const demo = 1;\n', content_hash: 'canon1234' }],
      }),
    });

    const result = await handleRead({ type: 'full', file_paths: ['src/demo.ts'] }, ctx);

    expect(result.ok).toBe(true);
    // Primary ref is h:fv:<hash> (the FileView retention identity). The slice
    // hash for the chunk itself travels on `slice_ref` for edit citation.
    const results = (result.content as { results: Array<Record<string, unknown>> }).results;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      file: 'src/demo.ts',
      h: expect.stringMatching(/^h:fv:/),
      content_hash: 'canon1234',
    });
    expect(results[0]).toHaveProperty('slice_ref');
    expect(String(results[0].slice_ref)).toMatch(/^h:/);
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

  it('keeps shaped reads tied to the backend snapshot authority and returns h:fv: as the retention ref', async () => {
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
    // Primary ref is h:fv:<hash> — the file's stable FileView identity.
    expect(results[0]).toMatchObject({
      file: 'src/demo.ts',
      h: expect.stringMatching(/^h:fv:/),
      content_hash: 'canon1234',
      selector: 'sig',
    });
    expect(results[0]).toHaveProperty('shape_hash');
    // read.shaped no longer auto-stages — the FileView holds the skeleton.
    const staged = [...useContextStore.getState().stagedSnippets.values()];
    expect(staged).toHaveLength(0);
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

  it('read.lines on search engram slices in-memory body without calling read_lines', async () => {
    const atls = vi.fn();
    const ctx = makeCtx({ atlsBatchQuery: atls });
    const short = useContextStore.getState().addChunk(
      'hit one\nhit two\nhit three',
      'search',
      'myQuery',
    );

    const result = await handleReadLines({ hash: `h:${short}`, lines: '1-2' }, ctx);

    expect(atls).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('engram:h:');
    expect(result.summary).toContain('hit one');
    expect(result.summary).toContain('hit two');
    expect(result.summary).toContain('search');
    const c = result.content as Record<string, unknown>;
    expect(String(c.file)).toMatch(/^engram:h:/);
    expect(typeof c.content_hash).toBe('string');
    expect(String(c.content_hash).length).toBeGreaterThan(0);
    expect(result.refs?.[0]).toMatch(/^h:[0-9a-f]+:1-2$/i);
  });

  it('read.lines on symbol engram uses in-memory path and ignores history flag', async () => {
    const atls = vi.fn();
    const ctx = makeCtx({ atlsBatchQuery: atls });
    const short = useContextStore.getState().addChunk('sym:a\nsym:b', 'symbol', 'foo');

    const result = await handleReadLines({ hash: `h:${short}`, lines: '2', history: true }, ctx);

    expect(atls).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('sym:b');
  });

  it('read.lines with explicit file_path still uses backend for file-backed reads', async () => {
    const atls = vi.fn().mockResolvedValue({
      file: 'src/demo.ts',
      h: 'h:abad1dea',
      content_hash: 'abad1dea00000000000000000000',
      target_range: [[1, 1]],
      actual_range: [[1, 1]],
      context_lines: 3,
      content: '   1|x',
    });
    const ctx = makeCtx({ atlsBatchQuery: atls });
    useContextStore.getState().addChunk('search blob', 'search', 'q');

    const result = await handleReadLines({
      hash: 'h:abad1dea00000000000000000000',
      lines: '1',
      file_path: 'src/demo.ts',
    }, ctx);

    expect(atls).toHaveBeenCalledWith('read_lines', expect.objectContaining({
      hash: 'h:abad1dea00000000000000000000',
      lines: '1',
      file_path: 'src/demo.ts',
    }));
    expect(result.ok).toBe(true);
  });
});

describe('context handlers validation and errors', () => {
  beforeEach(() => {
    resetContextStore();
    invokeMock.mockReset();
    invokeWithTimeoutMock.mockReset();
  });

  it('handleLoad errors when file_paths missing', async () => {
    const r = await handleLoad({}, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing file_paths/);
  });

  it('handleRead errors when file_paths missing', async () => {
    const r = await handleRead({ type: 'full' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing file_paths/);
  });

  it('handleRead maps backend failure', async () => {
    const r = await handleRead(
      { type: 'full', file_paths: ['a.ts'] },
      makeCtx({ atlsBatchQuery: vi.fn().mockRejectedValue(new Error('ctx down')) }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ctx down/);
  });

  it('handleReadLines rejects non-stringifiable ref', async () => {
    const r = await handleReadLines({ ref: {} as unknown as string, lines: '1' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ref must be a string/);
  });

  it('handleReadLines rejects ref that is too long', async () => {
    const r = await handleReadLines({ ref: `h:${'a'.repeat(220)}:1-2`, lines: '1' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ref too long/);
  });

  it('handleReadLines rejects ref not starting with h:', async () => {
    const r = await handleReadLines({ ref: 'path/to:1-2', lines: '1' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/must start with h:/);
  });

  it('handleReadLines requires start_line and end_line together with file_path', async () => {
    const r = await handleReadLines({ file_path: 'x.ts', start_line: 1 }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/paired range required/);
  });

  it('handleReadLines requires lines when hash present', async () => {
    const r = await handleReadLines({ hash: 'h:deadbeef12' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/requires lines/);
  });

  it('handleReadLines surfaces backend read_lines error', async () => {
    const r = await handleReadLines(
      { hash: 'h:abad1dea00000000000000000000', lines: '1' },
      makeCtx({
        atlsBatchQuery: vi.fn().mockResolvedValue({ error: 'stale', hint: 're-read' }),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stale/);
    expect(r.error).toMatch(/re-read/);
  });

  it('handleReadLines errors on invalid engram line spec', async () => {
    const ctx = makeCtx({ atlsBatchQuery: vi.fn() });
    const short = useContextStore.getState().addChunk('one\ntwo', 'search', 'q');
    const r = await handleReadLines({ hash: `h:${short}`, lines: 'garbage-range' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid lines spec/);
  });

  it('handleReadShaped errors when file_paths missing', async () => {
    const r = await handleReadShaped({ shape: 'sig' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing file_paths/);
  });

  it('handleReadShaped errors when shape missing', async () => {
    const r = await handleReadShaped({ file_paths: ['a.ts'] }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing shape/);
  });

  it('handleShape errors when hash missing', async () => {
    const r = await handleShape({}, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing hash/);
  });

  it('handleShape maps resolve failure', async () => {
    invokeWithTimeoutMock.mockRejectedValueOnce(new Error('no such ref'));
    const r = await handleShape({ hash: 'deadbeef12' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no such ref/);
  });

  it('handleEmit errors when content missing', async () => {
    const r = await handleEmit({ label: 'x' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing content/);
  });

  it('handleEmit adds chunk and registers hash', async () => {
    invokeMock.mockResolvedValue(undefined);
    const r = await handleEmit({ content: 'hello emit', label: 'lbl' }, makeCtx());
    expect(r.ok).toBe(true);
    expect(r.refs?.[0]).toMatch(/^h:/);
    expect(invokeMock).toHaveBeenCalledWith(
      'register_hash_content',
      expect.objectContaining({ content: 'hello emit', source: 'lbl' }),
    );
  });
});
