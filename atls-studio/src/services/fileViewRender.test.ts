import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      settings: {
        selectedProvider: 'anthropic',
        selectedModel: 'claude-3-5-sonnet-20241022',
      },
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));

const {
  collectFileViewChunkHashes,
  renderAllFileViewBlocks,
  renderFileViewBlock,
} = await import('./fileViewRender');
const { applyFillToView, applyFullBodyToView, createFileView } = await import('./fileViewStore');

function sk(opts: {
  path?: string;
  revision?: string;
  totalLines?: number;
  rows?: string[];
  sigLevel?: 'sig' | 'fold';
} = {}) {
  return {
    path: opts.path ?? 'src/foo.ts',
    revision: opts.revision ?? 'rev123abc',
    totalLines: opts.totalLines ?? 100,
    rows: opts.rows ?? [
      '   1|import { foo } from "./foo";',
      '  42|export function bar(): T { ... } [42-56]',
      '  60|export function baz(): U { ... } [60-80]',
    ],
    tokens: 30,
    sigLevel: (opts.sigLevel ?? 'sig') as 'sig' | 'fold',
  };
}

function row(n: number, c: string): string {
  return `${String(n).padStart(4)}|${c}`;
}

describe('fileViewRender — renderFileViewBlock', () => {
  it('renders header, skeleton rows, and closing fence', () => {
    const view = createFileView(sk());
    const text = renderFileViewBlock(view, { currentRound: 1 });
    expect(text).toContain('=== src/foo.ts @h:rev123');
    expect(text).toContain('(100 lines)');
    expect(text.startsWith('=== ')).toBe(true);
    expect(text.endsWith('\n===')).toBe(true);
    expect(text).toContain('1|import { foo } from "./foo";');
    expect(text).toContain('42|export function bar');
  });

  it('overlays a filled region, suppressing skeleton rows inside the range', () => {
    const view0 = createFileView(sk());
    const view = applyFillToView(view0, {
      start: 42,
      end: 56,
      content: [row(42, 'export function bar() {'), row(56, '}')].join('\n'),
      chunkHash: 'hFILL',
    });
    const text = renderFileViewBlock(view, { currentRound: 1 });
    // Folded skeleton row should be replaced by real content
    expect(text).not.toContain('export function bar(): T { ... } [42-56]');
    expect(text).toContain('42|export function bar() {');
    expect(text).toContain('56|}');
    // Adjacent skeleton rows stay
    expect(text).toContain('60|export function baz');
  });

  it('emits [edited L..-.. this round] marker for freshly-refetched regions', () => {
    const view0 = createFileView(sk());
    const view = applyFillToView(view0, {
      start: 42,
      end: 56,
      content: row(42, 'refreshed content'),
      chunkHash: 'hRef',
      origin: 'refetch',
      refetchedAtRound: 5,
    });
    const textSameRound = renderFileViewBlock(view, { currentRound: 5 });
    expect(textSameRound).toContain('[edited L42-56 this round]');

    const textNextRound = renderFileViewBlock(view, { currentRound: 6 });
    expect(textNextRound).not.toContain('[edited L42-56 this round]');
  });

  it('emits [REMOVED was L..-..] markers persistently', () => {
    const view0 = createFileView(sk());
    const view = {
      ...view0,
      removedMarkers: [
        { start: 100, end: 120 },
        { start: 200, end: 205 },
      ],
    };
    const text = renderFileViewBlock(view, { currentRound: 1 });
    expect(text).toContain('[REMOVED was L100-120]');
    expect(text).toContain('[REMOVED was L200-205]');
  });

  it('emits [pending refetch] aggregate hint when regions queued', () => {
    const view0 = createFileView(sk());
    const view = {
      ...view0,
      pendingRefetches: [
        { start: 10, end: 20, cause: 'external_file_change' as const, detectedAtRound: 3 },
        { start: 30, end: 40, cause: 'external_file_change' as const, detectedAtRound: 3 },
      ],
    };
    const text = renderFileViewBlock(view, { currentRound: 3 });
    expect(text).toMatch(/\[changed: 2 regions pending refetch/);
  });

  it('renders pinned marker in header', () => {
    const view = { ...createFileView(sk()), pinned: true };
    const text = renderFileViewBlock(view, { currentRound: 1 });
    expect(text).toContain('[pinned]');
  });

  it('emits fullBody verbatim when set, ignoring regions/skeleton', () => {
    const view0 = createFileView(sk());
    const view = applyFullBodyToView(view0, 'the\nwhole\nfile', 'hFULL');
    const text = renderFileViewBlock(view, { currentRound: 1 });
    expect(text).toContain('the\nwhole\nfile');
    // Skeleton rows should NOT appear when fullBody is set
    expect(text).not.toContain('42|export function bar(): T { ... } [42-56]');
  });

  it('emits unparseable placeholder when skeleton is empty and no regions/fullBody', () => {
    const view = createFileView(sk({ rows: [] }));
    const text = renderFileViewBlock(view, { currentRound: 1 });
    expect(text).toContain('(no sig extracted — read lines to explore)');
  });

  it('uses regions directly when skeleton is empty but regions exist', () => {
    const view0 = createFileView(sk({ rows: [] }));
    const view = applyFillToView(view0, {
      start: 10,
      end: 15,
      content: [row(10, 'a'), row(15, 'b')].join('\n'),
      chunkHash: 'h1',
    });
    const text = renderFileViewBlock(view, { currentRound: 1 });
    expect(text).toContain('10|a');
    expect(text).toContain('15|b');
    expect(text).not.toContain('(no sig extracted');
  });
});

describe('fileViewRender — renderAllFileViewBlocks', () => {
  it('sorts pinned first, then by lastAccessed desc', () => {
    const old = { ...createFileView(sk({ path: 'src/a.ts' })), lastAccessed: 100 };
    const recent = { ...createFileView(sk({ path: 'src/b.ts' })), lastAccessed: 500 };
    const pinned = { ...createFileView(sk({ path: 'src/c.ts' })), lastAccessed: 10, pinned: true };
    const blocks = renderAllFileViewBlocks([old, recent, pinned], { currentRound: 1 });
    expect(blocks[0]).toContain('src/c.ts'); // pinned first
    expect(blocks[1]).toContain('src/b.ts'); // then most recent
    expect(blocks[2]).toContain('src/a.ts'); // then oldest
  });

  it('skips empty views with nothing to render', () => {
    const empty = createFileView(sk({ rows: [] }));
    const populated = applyFillToView(createFileView(sk({ path: 'src/x.ts' })), {
      start: 10,
      end: 20,
      content: row(10, 'a'),
      chunkHash: 'h',
    });
    const blocks = renderAllFileViewBlocks([empty, populated], { currentRound: 1 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('src/x.ts');
  });

  it('keeps a view with only a removed marker', () => {
    const v = {
      ...createFileView(sk({ rows: [] })),
      removedMarkers: [{ start: 10, end: 20 }],
    };
    const blocks = renderAllFileViewBlocks([v], { currentRound: 1 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('[REMOVED was L10-20]');
  });
});

describe('fileViewRender — collectFileViewChunkHashes', () => {
  it('returns every chunk hash referenced by any view', () => {
    const v1 = applyFillToView(createFileView(sk({ path: 'src/a.ts' })), {
      start: 1,
      end: 10,
      content: row(1, 'a'),
      chunkHash: 'h1',
    });
    const v2 = applyFullBodyToView(createFileView(sk({ path: 'src/b.ts' })), 'body', 'h2');
    const set = collectFileViewChunkHashes([v1, v2]);
    expect(set.has('h1')).toBe(true);
    expect(set.has('h2')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('returns an empty set when no views carry chunk hashes', () => {
    const v = createFileView(sk());
    const set = collectFileViewChunkHashes([v]);
    expect(set.size).toBe(0);
  });
});
