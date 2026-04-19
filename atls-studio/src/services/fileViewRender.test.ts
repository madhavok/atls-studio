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
const { applyFillToView, applyFullBodyToView, createFileView, computeFileViewHashParts } = await import('./fileViewStore');

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
  it('renders header with dual hash identity (retention + cite), skeleton rows, and closing fence', () => {
    const view = createFileView(sk());
    const text = renderFileViewBlock(view, { currentRound: 1 });
    const { shortHash } = computeFileViewHashParts('src/foo.ts', 'rev123abc');
    // Retention ref = view.shortHash (derived from path + revision) —
    // the token pu/pc/dro must receive.
    expect(text).toContain(`=== src/foo.ts h:${shortHash}`);
    // Citation hash = sourceRevision prefix — the token for content_hash in edits.
    expect(text).toContain('cite:@h:rev123');
    // Retention and cite must be different hex by construction.
    expect(shortHash).not.toBe('rev123');
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
  it('renders only pinned views; unpinned views roll out of the prompt', () => {
    const unpinnedA = { ...createFileView(sk({ path: 'src/a.ts' })), lastAccessed: 100 };
    const unpinnedB = { ...createFileView(sk({ path: 'src/b.ts' })), lastAccessed: 500 };
    const pinnedC = { ...createFileView(sk({ path: 'src/c.ts' })), lastAccessed: 10, pinned: true };
    const blocks = renderAllFileViewBlocks([unpinnedA, unpinnedB, pinnedC], { currentRound: 1 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('src/c.ts');
    expect(blocks.join('\n')).not.toContain('src/a.ts');
    expect(blocks.join('\n')).not.toContain('src/b.ts');
  });

  it('sorts pinned views by lastAccessed desc', () => {
    const oldPinned = { ...createFileView(sk({ path: 'src/a.ts' })), lastAccessed: 100, pinned: true };
    const midPinned = { ...createFileView(sk({ path: 'src/b.ts' })), lastAccessed: 300, pinned: true };
    const recentPinned = { ...createFileView(sk({ path: 'src/c.ts' })), lastAccessed: 500, pinned: true };
    const blocks = renderAllFileViewBlocks([oldPinned, midPinned, recentPinned], { currentRound: 1 });
    expect(blocks[0]).toContain('src/c.ts');
    expect(blocks[1]).toContain('src/b.ts');
    expect(blocks[2]).toContain('src/a.ts');
  });

  it('skips empty pinned views with nothing to render', () => {
    const empty = { ...createFileView(sk({ rows: [] })), pinned: true };
    const populated0 = applyFillToView(createFileView(sk({ path: 'src/x.ts' })), {
      start: 10,
      end: 20,
      content: row(10, 'a'),
      chunkHash: 'h',
    });
    const populated = { ...populated0, pinned: true };
    const blocks = renderAllFileViewBlocks([empty, populated], { currentRound: 1 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('src/x.ts');
  });

  it('keeps a pinned view with only a removed marker', () => {
    const v = {
      ...createFileView(sk({ rows: [] })),
      pinned: true,
      removedMarkers: [{ start: 10, end: 20 }],
    };
    const blocks = renderAllFileViewBlocks([v], { currentRound: 1 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('[REMOVED was L10-20]');
  });

  it('emits zero blocks when every view is unpinned (dormant rollout)', () => {
    const v1 = applyFillToView(createFileView(sk({ path: 'src/a.ts' })), {
      start: 1, end: 10, content: row(1, 'a'), chunkHash: 'h1',
    });
    const v2 = applyFullBodyToView(createFileView(sk({ path: 'src/b.ts' })), 'body', 'h2');
    const blocks = renderAllFileViewBlocks([v1, v2], { currentRound: 1 });
    expect(blocks).toHaveLength(0);
  });

  it('renders view-level annotations as header lines (capped at 3 + overflow)', () => {
    const base = createFileView(sk());
    const view = {
      ...base,
      annotations: [
        { id: 'a1', content: 'eviction uses XOR tie-break', createdAt: 1, tokens: 6 },
        { id: 'a2', content: 'hot path: materialize()', createdAt: 2, tokens: 5 },
        { id: 'a3', content: 'short-hash index is O(1)', createdAt: 3, tokens: 6 },
        { id: 'a4', content: 'overflow note 4', createdAt: 4, tokens: 3 },
        { id: 'a5', content: 'overflow note 5', createdAt: 5, tokens: 3 },
      ],
    };
    const text = renderFileViewBlock(view, { currentRound: 1 });
    expect(text).toContain('note: eviction uses XOR tie-break');
    expect(text).toContain('note: hot path: materialize()');
    expect(text).toContain('note: short-hash index is O(1)');
    expect(text).toContain('note: +2 more');
    // Notes precede the body
    const firstNoteIdx = text.indexOf('note: eviction');
    const firstRowIdx = text.indexOf('1|import');
    expect(firstNoteIdx).toBeGreaterThan(0);
    expect(firstRowIdx).toBeGreaterThan(firstNoteIdx);
  });

  it('emits no annotation lines when the view has none (zero overhead)', () => {
    const view = createFileView(sk());
    const text = renderFileViewBlock(view, { currentRound: 1 });
    expect(text).not.toContain('note:');
  });
});

describe('fileViewRender — collectFileViewChunkHashes', () => {
  it('returns every chunk hash referenced by any pinned view', () => {
    const v1 = {
      ...applyFillToView(createFileView(sk({ path: 'src/a.ts' })), {
        start: 1, end: 10, content: row(1, 'a'), chunkHash: 'h1',
      }),
      pinned: true,
    };
    const v2 = {
      ...applyFullBodyToView(createFileView(sk({ path: 'src/b.ts' })), 'body', 'h2'),
      pinned: true,
    };
    const set = collectFileViewChunkHashes([v1, v2]);
    expect(set.has('h1')).toBe(true);
    expect(set.has('h2')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('ignores chunk hashes owned by unpinned views (so chunks can re-surface in ACTIVE ENGRAMS)', () => {
    const unpinned = applyFillToView(createFileView(sk({ path: 'src/a.ts' })), {
      start: 1, end: 10, content: row(1, 'a'), chunkHash: 'h1',
    });
    const pinned = {
      ...applyFullBodyToView(createFileView(sk({ path: 'src/b.ts' })), 'body', 'h2'),
      pinned: true,
    };
    const set = collectFileViewChunkHashes([unpinned, pinned]);
    expect(set.has('h1')).toBe(false);
    expect(set.has('h2')).toBe(true);
  });

  it('returns an empty set when all views are unpinned', () => {
    const v1 = applyFillToView(createFileView(sk({ path: 'src/a.ts' })), {
      start: 1, end: 10, content: row(1, 'a'), chunkHash: 'h1',
    });
    const v2 = applyFullBodyToView(createFileView(sk({ path: 'src/b.ts' })), 'body', 'h2');
    const set = collectFileViewChunkHashes([v1, v2]);
    expect(set.size).toBe(0);
  });

  it('returns an empty set when no views carry chunk hashes', () => {
    const v = { ...createFileView(sk()), pinned: true };
    const set = collectFileViewChunkHashes([v]);
    expect(set.size).toBe(0);
  });
});
