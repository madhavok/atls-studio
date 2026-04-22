import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

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
  COVERAGE_PROMOTE_RATIO,
  MAX_REFETCHES_PER_ROUND_DEFAULT,
  applyFillToView,
  applyFullBodyToView,
  applyRefetchCap,
  clearPendingRefetches,
  clearRemovedMarker,
  composeFullBodyFromRegions,
  computeFileViewHash,
  computeFileViewHashParts,
  createFileView,
  dropRegionByChunk,
  matchesViewRef,
  mergeFilledRegion,
  onConstituentChunkRemoved,
  parseRowsByLine,
  reconcileFileView,
  shiftRowsByLine,
  shouldAutoPromoteToFullBody,
} = await import('./fileViewStore');
const { clearFreshnessJournal, recordFreshnessJournal } = await import('./freshnessJournal');

function fakeSkeleton(opts: {
  path?: string;
  revision?: string;
  rows?: string[];
  sigLevel?: 'sig' | 'fold';
  totalLines?: number;
} = {}) {
  return {
    path: opts.path ?? 'src/foo.ts',
    revision: opts.revision ?? 'rev1',
    totalLines: opts.totalLines ?? 100,
    rows: opts.rows ?? [
      '   1|import { x } from "./x";',
      '  42|fn bar(): T { ... } [42-56]',
    ],
    tokens: 20,
    sigLevel: (opts.sigLevel ?? 'sig') as 'sig' | 'fold',
  };
}

function row(line: number, content: string): string {
  return `${String(line).padStart(4)}|${content}`;
}

describe('fileViewStore — mergeFilledRegion', () => {
  it('adds a non-overlapping region in sorted order', () => {
    const regions = [
      {
        start: 100,
        end: 110,
        content: row(100, 'a') + '\n' + row(110, 'b'),
        chunkHashes: ['h1'],
        tokens: 10,
        origin: 'read' as const,
      },
    ];
    const merged = mergeFilledRegion(regions, {
      start: 200,
      end: 210,
      content: row(200, 'c') + '\n' + row(210, 'd'),
      chunkHash: 'h2',
    });
    expect(merged.length).toBe(2);
    expect(merged[0].start).toBe(100);
    expect(merged[1].start).toBe(200);
    expect(merged[1].chunkHashes).toEqual(['h2']);
  });

  it('merges overlapping regions into a single range', () => {
    const regions = [
      {
        start: 100,
        end: 120,
        content: [row(100, 'a'), row(110, 'b'), row(120, 'c')].join('\n'),
        chunkHashes: ['h1'],
        tokens: 15,
        origin: 'read' as const,
      },
    ];
    const merged = mergeFilledRegion(regions, {
      start: 115,
      end: 130,
      content: [row(115, 'X'), row(120, 'Y'), row(130, 'Z')].join('\n'),
      chunkHash: 'h2',
    });
    expect(merged.length).toBe(1);
    expect(merged[0].start).toBe(100);
    expect(merged[0].end).toBe(130);
    expect(merged[0].chunkHashes.sort()).toEqual(['h1', 'h2']);
    // Incoming wins for overlap (line 120): Y not c
    expect(merged[0].content).toContain('120|Y');
    expect(merged[0].content).not.toContain('120|c');
  });

  it('merges adjacent regions (end+1 touches next start)', () => {
    const regions = [
      {
        start: 100,
        end: 110,
        content: row(100, 'a') + '\n' + row(110, 'b'),
        chunkHashes: ['h1'],
        tokens: 10,
        origin: 'read' as const,
      },
    ];
    // incoming starts at 111 — adjacent, should merge
    const merged = mergeFilledRegion(regions, {
      start: 111,
      end: 120,
      content: row(111, 'X') + '\n' + row(120, 'Y'),
      chunkHash: 'h2',
    });
    expect(merged.length).toBe(1);
    expect(merged[0].start).toBe(100);
    expect(merged[0].end).toBe(120);
  });

  it('ignores inverted incoming ranges', () => {
    const regions = [
      {
        start: 100,
        end: 110,
        content: row(100, 'a'),
        chunkHashes: ['h1'],
        tokens: 5,
        origin: 'read' as const,
      },
    ];
    const merged = mergeFilledRegion(regions, {
      start: 200,
      end: 150, // inverted
      content: 'junk',
      chunkHash: 'h2',
    });
    expect(merged).toEqual(regions);
  });

  it('preserves origin and refetchedAtRound from incoming', () => {
    const merged = mergeFilledRegion([], {
      start: 100,
      end: 110,
      content: row(100, 'a'),
      chunkHash: 'h1',
      origin: 'refetch',
      refetchedAtRound: 7,
    });
    expect(merged[0].origin).toBe('refetch');
    expect(merged[0].refetchedAtRound).toBe(7);
  });
});

describe('fileViewStore — shouldAutoPromoteToFullBody', () => {
  it('returns false when fullBody already set', () => {
    expect(
      shouldAutoPromoteToFullBody({
        filledRegions: [],
        totalLines: 100,
        fullBody: 'already',
      }),
    ).toBe(false);
  });

  it('returns true when filled tokens >= threshold × totalLines × avgPerLine', () => {
    // totalLines=100, avg=10 → estimated=1000. threshold=0.9 → 900.
    const regions = [
      {
        start: 1,
        end: 100,
        content: 'x',
        chunkHashes: ['h'],
        tokens: 950,
        origin: 'read' as const,
      },
    ];
    expect(
      shouldAutoPromoteToFullBody({
        filledRegions: regions,
        totalLines: 100,
        fullBody: undefined,
      }),
    ).toBe(true);
  });

  it('returns false when filled tokens below threshold', () => {
    const regions = [
      {
        start: 1,
        end: 100,
        content: 'x',
        chunkHashes: ['h'],
        tokens: 500,
        origin: 'read' as const,
      },
    ];
    expect(
      shouldAutoPromoteToFullBody({
        filledRegions: regions,
        totalLines: 100,
        fullBody: undefined,
      }),
    ).toBe(false);
  });

  it('returns false for zero-line files (no denominator)', () => {
    expect(
      shouldAutoPromoteToFullBody({
        filledRegions: [
          { start: 0, end: 0, content: '', chunkHashes: [], tokens: 10, origin: 'read' as const },
        ],
        totalLines: 0,
        fullBody: undefined,
      }),
    ).toBe(false);
  });

  it('default threshold exposed as const', () => {
    expect(COVERAGE_PROMOTE_RATIO).toBe(0.9);
  });
});

describe('fileViewStore — createFileView + applyFillToView', () => {
  it('creates a view around a skeleton with empty regions', () => {
    const v = createFileView(fakeSkeleton());
    expect(v.filePath).toBe('src/foo.ts');
    expect(v.filledRegions).toEqual([]);
    expect(v.totalLines).toBe(100);
    expect(v.pinned).toBe(false);
    expect(v.hash).toMatch(/^h:[0-9a-f]{6}$/);
    expect(v.shortHash).toMatch(/^[0-9a-f]{6}$/);
    expect(v.hash).toBe(`h:${v.shortHash}`);
  });

  it('applies a fill but keeps the hash stable (identity per file/revision)', () => {
    const v0 = createFileView(fakeSkeleton());
    const v1 = applyFillToView(v0, {
      start: 42,
      end: 56,
      content: [row(42, 'fn bar() {'), row(56, '}')].join('\n'),
      chunkHash: 'hABC',
      tokens: 5,
    });
    expect(v1.filledRegions.length).toBe(1);
    expect(v1.filledRegions[0].start).toBe(42);
    // Identity is stable across fills — same (filePath, revision) → same h:<short>.
    // This is what makes the view ref a usable single retention identity.
    expect(v1.hash).toBe(v0.hash);
  });

  it('coverage auto-promote materializes fullBody when threshold crossed', () => {
    const v0 = createFileView(fakeSkeleton({ totalLines: 10 }));
    const v1 = applyFillToView(v0, {
      start: 1,
      end: 10,
      content: Array.from({ length: 10 }, (_, i) => row(i + 1, `line${i + 1}`)).join('\n'),
      chunkHash: 'hFULL',
      tokens: 95, // > 0.9 * (10 * 10) = 90
    });
    expect(v1.fullBody).toBeDefined();
    expect(v1.fullBodyChunkHash).toBe('hFULL');
    // P2.1: auto-promotion from applyFillToView must tag origin so the
    // header can render `[fullBody: promoted]` and downstream consumers can
    // distinguish stitched regions from an explicit read.
    expect(v1.fullBodyOrigin).toBe('coverage_promote');
  });

  it('applyFullBodyToView sets fullBody directly without region merge', () => {
    const v0 = createFileView(fakeSkeleton());
    const v1 = applyFullBodyToView(v0, 'the whole file', 'hFULL');
    expect(v1.fullBody).toBe('the whole file');
    expect(v1.fullBodyChunkHash).toBe('hFULL');
    expect(v1.filledRegions).toEqual([]);
    // P2.1: explicit full-body reads are tagged 'read', NOT 'coverage_promote'.
    expect(v1.fullBodyOrigin).toBe('read');
  });

  it('applyFillToView below auto-promote threshold leaves fullBodyOrigin unset', () => {
    const v0 = createFileView(fakeSkeleton({ totalLines: 100 }));
    const v1 = applyFillToView(v0, {
      start: 1,
      end: 10,
      content: Array.from({ length: 10 }, (_, i) => row(i + 1, `line${i + 1}`)).join('\n'),
      chunkHash: 'hPARTIAL',
      tokens: 50,
    });
    expect(v1.fullBody).toBeUndefined();
    expect(v1.fullBodyOrigin).toBeUndefined();
  });
});

describe('fileViewStore — chunk eviction prunes regions', () => {
  it('onConstituentChunkRemoved drops region when sole owner (unpinned)', () => {
    const v = applyFillToView(createFileView(fakeSkeleton()), {
      start: 42,
      end: 56,
      content: row(42, 'fn bar'),
      chunkHash: 'hABC',
      tokens: 5,
    });
    const v2 = onConstituentChunkRemoved(v, 'hABC');
    expect(v2.filledRegions).toEqual([]);
  });

  it('onConstituentChunkRemoved retains sole-owner region content when pinned (chunkHashes detached)', () => {
    const v0 = createFileView(fakeSkeleton(), { pinned: true });
    const v = applyFillToView(v0, {
      start: 42,
      end: 56,
      content: row(42, 'fn bar'),
      chunkHash: 'hABC',
      tokens: 5,
    });
    const v2 = onConstituentChunkRemoved(v, 'hABC');
    expect(v2.filledRegions).toHaveLength(1);
    expect(v2.filledRegions[0].chunkHashes).toEqual([]);
    expect(v2.filledRegions[0].content).toContain('fn bar');
  });

  it('onConstituentChunkRemoved clears fullBody when unpinned and fullBodyChunkHash matches', () => {
    const v0 = createFileView(fakeSkeleton());
    const v1 = applyFullBodyToView(v0, 'whole file', 'hFULL');
    const v2 = onConstituentChunkRemoved(v1, 'hFULL');
    expect(v2.fullBody).toBeUndefined();
    expect(v2.fullBodyChunkHash).toBeUndefined();
  });

  it('onConstituentChunkRemoved keeps fullBody when pinned and fullBodyChunkHash matches', () => {
    const v0 = createFileView(fakeSkeleton(), { pinned: true });
    const v1 = applyFullBodyToView(v0, 'whole file', 'hFULL');
    const v2 = onConstituentChunkRemoved(v1, 'hFULL');
    expect(v2.fullBody).toBe('whole file');
    expect(v2.fullBodyChunkHash).toBeUndefined();
  });

  it('keeps region but drops the hash when shared', () => {
    const merged = mergeFilledRegion(
      [
        {
          start: 10,
          end: 20,
          content: row(10, 'a') + '\n' + row(20, 'b'),
          chunkHashes: ['h1', 'h2'],
          tokens: 5,
          origin: 'read' as const,
        },
      ],
      {
        start: 15,
        end: 25,
        content: row(15, 'c') + '\n' + row(25, 'd'),
        chunkHash: 'h3',
      },
    );
    const pruned = dropRegionByChunk(merged, 'h2');
    expect(pruned.length).toBe(1);
    expect(pruned[0].chunkHashes).not.toContain('h2');
    expect(pruned[0].chunkHashes).toContain('h1');
    expect(pruned[0].chunkHashes).toContain('h3');
  });
});

describe('fileViewStore — reconcileFileView', () => {
  beforeEach(() => {
    clearFreshnessJournal();
  });

  afterEach(() => {
    clearFreshnessJournal();
  });

  it('returns no-op when revision unchanged', () => {
    const v = applyFillToView(createFileView(fakeSkeleton()), {
      start: 42,
      end: 56,
      content: row(42, 'fn bar'),
      chunkHash: 'h',
      tokens: 5,
    });
    const { view, updated, refetchRequests } = reconcileFileView(v, {
      currentRevision: 'rev1',
      cause: 'unknown',
      round: 1,
    });
    expect(updated).toBe(false);
    expect(refetchRequests).toEqual([]);
    expect(view).toBe(v);
  });

  it('same_file_prior_edit with journal delta rebases region line numbers', () => {
    recordFreshnessJournal({
      source: 'src/foo.ts',
      previousRevision: 'rev1',
      currentRevision: 'rev2',
      lineDelta: 5, // 5 lines inserted above the region
      recordedAt: Date.now(),
    });
    const v = applyFillToView(createFileView(fakeSkeleton()), {
      start: 42,
      end: 56,
      content: [row(42, 'fn bar'), row(56, '}')].join('\n'),
      chunkHash: 'h',
      tokens: 5,
    });
    const { view, updated, refetchRequests, rebaseFailures } = reconcileFileView(v, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 2,
    });
    expect(updated).toBe(true);
    expect(refetchRequests).toEqual([]);
    expect(rebaseFailures).toEqual([]);
    expect(view.filledRegions.length).toBe(1);
    expect(view.filledRegions[0].start).toBe(47);
    expect(view.filledRegions[0].end).toBe(61);
    expect(view.filledRegions[0].content).toContain('47|fn bar');
    expect(view.filledRegions[0].content).toContain('61|}');
    expect(view.freshness).toBe('shifted');
  });

  it('pinned content-change queues refetch requests', () => {
    const v0 = applyFillToView(
      { ...createFileView(fakeSkeleton()), pinned: true },
      {
        start: 42,
        end: 56,
        content: row(42, 'fn bar'),
        chunkHash: 'h',
        tokens: 5,
      },
    );
    const { view, refetchRequests } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'external_file_change',
      round: 3,
    });
    expect(refetchRequests.length).toBe(1);
    expect(refetchRequests[0]).toMatchObject({
      start: 42,
      end: 56,
      cause: 'external_file_change',
      detectedAtRound: 3,
    });
    expect(view.filledRegions).toEqual([]);
    expect(view.pendingRefetches?.length).toBe(1);
  });

  it('unpinned content-change drops regions silently', () => {
    const v0 = applyFillToView(createFileView(fakeSkeleton()), {
      start: 42,
      end: 56,
      content: row(42, 'fn bar'),
      chunkHash: 'h',
      tokens: 5,
    });
    const { view, refetchRequests } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'external_file_change',
      round: 3,
    });
    expect(refetchRequests).toEqual([]);
    expect(view.filledRegions).toEqual([]);
    expect(view.pendingRefetches).toBeUndefined();
  });

  it('rebase failure when delta pushes region below line 1', () => {
    recordFreshnessJournal({
      source: 'src/foo.ts',
      previousRevision: 'rev1',
      currentRevision: 'rev2',
      lineDelta: -50,
      recordedAt: Date.now(),
    });
    const v0 = applyFillToView(createFileView(fakeSkeleton()), {
      start: 42,
      end: 56,
      content: row(42, 'fn bar'),
      chunkHash: 'h',
      tokens: 5,
    });
    const { view, rebaseFailures } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 4,
    });
    expect(rebaseFailures.length).toBe(1);
    expect(rebaseFailures[0]).toEqual({ start: 42, end: 56 });
    expect(view.filledRegions).toEqual([]);
    expect(view.removedMarkers?.length).toBe(1);
  });

  it('clears fullBody on any revision change', () => {
    const v0 = applyFullBodyToView(createFileView(fakeSkeleton()), 'body', 'hFULL');
    const { view } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'external_file_change',
      round: 5,
    });
    expect(view.fullBody).toBeUndefined();
    expect(view.fullBodyChunkHash).toBeUndefined();
  });

  it('adopts new skeleton rows when provided', () => {
    const v0 = createFileView(fakeSkeleton());
    const newSkel = fakeSkeleton({
      revision: 'rev2',
      rows: ['   1|NEW imports', '  50|NEW fn()'],
      sigLevel: 'fold',
      totalLines: 200,
    });
    const { view } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'external_file_change',
      round: 6,
      newSkeleton: newSkel,
    });
    expect(view.skeletonRows).toEqual(['   1|NEW imports', '  50|NEW fn()']);
    expect(view.sigLevel).toBe('fold');
    expect(view.totalLines).toBe(200);
  });
});

describe('fileViewStore — applyRefetchCap', () => {
  it('passes through when within cap', () => {
    const r = applyRefetchCap([1, 2, 3]);
    expect(r.processed).toEqual([1, 2, 3]);
    expect(r.skipped).toBe(0);
  });

  it('truncates to cap when over', () => {
    const arr = Array.from({ length: 15 }, (_, i) => i);
    const r = applyRefetchCap(arr, 10);
    expect(r.processed.length).toBe(10);
    expect(r.skipped).toBe(5);
  });

  it('default cap is exposed and reasonable', () => {
    expect(MAX_REFETCHES_PER_ROUND_DEFAULT).toBeGreaterThan(0);
    expect(MAX_REFETCHES_PER_ROUND_DEFAULT).toBeLessThan(100);
  });
});

describe('fileViewStore — ephemeral marker fade', () => {
  it('refetch fills carry refetchedAtRound; clearPendingRefetches resets queue', () => {
    const v0 = {
      ...createFileView(fakeSkeleton()),
      pendingRefetches: [{ start: 42, end: 56, cause: 'external_file_change' as const, detectedAtRound: 3 }],
    };
    const afterFill = applyFillToView(v0, {
      start: 42,
      end: 56,
      content: row(42, 'refreshed content'),
      chunkHash: 'hRefetch',
      tokens: 5,
      origin: 'refetch',
      refetchedAtRound: 4,
    });
    expect(afterFill.filledRegions[0].origin).toBe('refetch');
    expect(afterFill.filledRegions[0].refetchedAtRound).toBe(4);

    const cleared = clearPendingRefetches(afterFill);
    expect(cleared.pendingRefetches).toBeUndefined();
  });

  it('clearRemovedMarker drops a specific range', () => {
    const v0 = {
      ...createFileView(fakeSkeleton()),
      removedMarkers: [
        { start: 42, end: 56 },
        { start: 100, end: 120 },
      ],
    };
    const next = clearRemovedMarker(v0, 42, 56);
    expect(next.removedMarkers).toEqual([{ start: 100, end: 120 }]);

    const finalClear = clearRemovedMarker(next, 100, 120);
    expect(finalClear.removedMarkers).toBeUndefined();
  });
});

describe('fileViewStore — hash identity', () => {
  it('path-case collapses to the same key and hash', () => {
    const a = computeFileViewHash('Src\\Foo.ts', 'rev1');
    const b = computeFileViewHash('src/foo.ts', 'rev1');
    expect(a).toBe(b);
  });

  it('hash is stable per (path, revision) — unchanged by fills or fullBody', () => {
    // This is the property that lets the view's `h:<short>` be a valid single
    // retention ref: identity does not drift as the view progressively fills.
    const base = computeFileViewHash('src/foo.ts', 'rev1');
    // Same inputs should yield the same hash — no region/fullBody arg in the
    // new signature at all.
    expect(computeFileViewHash('src/foo.ts', 'rev1')).toBe(base);
  });

  it('hash changes on revision bump', () => {
    const a = computeFileViewHash('src/foo.ts', 'rev1');
    const b = computeFileViewHash('src/foo.ts', 'rev2');
    expect(a).not.toBe(b);
  });
});

describe('fileViewStore — helpers', () => {
  it('shiftRowsByLine rewrites N| prefixes by delta', () => {
    const content = [row(10, 'a'), row(15, 'b')].join('\n');
    const shifted = shiftRowsByLine(content, 5);
    expect(shifted).toContain('15|a');
    expect(shifted).toContain('20|b');
  });

  it('shiftRowsByLine no-op on delta 0', () => {
    const content = row(10, 'a');
    expect(shiftRowsByLine(content, 0)).toBe(content);
  });

  it('composeFullBodyFromRegions concatenates in region order', () => {
    const regions = [
      { start: 1, end: 5, content: row(1, 'a') + '\n' + row(5, 'b'), chunkHashes: ['h1'], tokens: 5, origin: 'read' as const },
      { start: 10, end: 15, content: row(10, 'c') + '\n' + row(15, 'd'), chunkHashes: ['h2'], tokens: 5, origin: 'read' as const },
    ];
    const body = composeFullBodyFromRegions({ filledRegions: regions });
    expect(body).toContain('1|a');
    expect(body).toContain('15|d');
  });

  it('parseRowsByLine skips malformed lines', () => {
    const content = [row(1, 'a'), 'garbage', row(3, 'c')].join('\n');
    const map = parseRowsByLine(content);
    expect(map.size).toBe(2);
    expect(map.get(1)).toContain('|a');
    expect(map.get(3)).toContain('|c');
  });
});

describe('fileViewStore — postEditResolved hint', () => {
  beforeEach(() => {
    clearFreshnessJournal();
  });

  afterEach(() => {
    clearFreshnessJournal();
  });

  it('suppresses pendingRefetches when caller promises to refill (same_file_prior_edit, no journal delta)', () => {
    // Pinned view, content-change branch, NO freshness journal. Without the
    // hint this would queue a pendingRefetch and render
    // `[changed: N pending refetch — re-read on demand]`. With the hint the
    // region is kept at its pre-edit coords as a placeholder for the caller
    // to re-slice against the new body, and NO pendingRefetch is emitted.
    const v0 = applyFillToView(
      { ...createFileView(fakeSkeleton()), pinned: true },
      {
        start: 42,
        end: 56,
        content: row(42, 'fn bar'),
        chunkHash: 'h',
        tokens: 5,
      },
    );
    const { view, refetchRequests } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 3,
      postEditResolved: true,
    });
    expect(refetchRequests).toEqual([]);
    expect(view.pendingRefetches).toBeUndefined();
    expect(view.filledRegions.length).toBe(1);
    expect(view.filledRegions[0].start).toBe(42);
    expect(view.filledRegions[0].end).toBe(56);
    expect(view.sourceRevision).toBe('rev2');
  });

  it('hint does NOT interfere with journal-delta rebase (regions still shift)', () => {
    recordFreshnessJournal({
      source: 'src/foo.ts',
      previousRevision: 'rev1',
      currentRevision: 'rev2',
      lineDelta: 5,
      recordedAt: Date.now(),
    });
    const v0 = applyFillToView(
      { ...createFileView(fakeSkeleton()), pinned: true },
      { start: 42, end: 56, content: row(42, 'fn bar'), chunkHash: 'h', tokens: 5 },
    );
    const { view, refetchRequests } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 3,
      postEditResolved: true,
    });
    expect(refetchRequests).toEqual([]);
    expect(view.pendingRefetches).toBeUndefined();
    expect(view.filledRegions[0].start).toBe(47);
    expect(view.filledRegions[0].end).toBe(61);
  });

  it('hint is IGNORED for external_file_change — external changes still queue refetches', () => {
    const v0 = applyFillToView(
      { ...createFileView(fakeSkeleton()), pinned: true },
      { start: 42, end: 56, content: row(42, 'fn bar'), chunkHash: 'h', tokens: 5 },
    );
    const { view, refetchRequests } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'external_file_change',
      round: 3,
      postEditResolved: true, // should be ignored — we don't have the content
    });
    expect(refetchRequests.length).toBe(1);
    expect(view.pendingRefetches?.length).toBe(1);
  });
});

describe('fileViewStore — per-position delta rebase', () => {
  beforeEach(() => {
    clearFreshnessJournal();
  });

  afterEach(() => {
    clearFreshnessJournal();
  });

  function mkSliceView(regionStart: number, regionEnd: number) {
    return applyFillToView(createFileView(fakeSkeleton({ revision: 'rev1' })), {
      start: regionStart,
      end: regionEnd,
      content: [row(regionStart, 'a'), row(regionEnd, 'b')].join('\n'),
      chunkHash: `h-${regionStart}-${regionEnd}`,
      tokens: 5,
    });
  }

  it('region strictly ABOVE the edit anchor does NOT shift', () => {
    // Edit at line 59 inserting 30 lines. Region spans 1-30. The scalar-
    // lineDelta path would shift EVERY region by +30 — this per-position
    // path leaves regions above the anchor put.
    const v0 = mkSliceView(1, 30);
    const { view } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 1,
      positionalDeltas: [{ line: 59, delta: 30 }],
    });
    expect(view.filledRegions).toHaveLength(1);
    expect(view.filledRegions[0].start).toBe(1);
    expect(view.filledRegions[0].end).toBe(30);
  });

  it('region strictly BELOW the edit anchor shifts by the net delta', () => {
    // Edit at line 59 insert +30. Region spans 100-150. Both edges are
    // below the anchor, so both shift by +30.
    const v0 = mkSliceView(100, 150);
    const { view } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 1,
      positionalDeltas: [{ line: 59, delta: 30 }],
    });
    expect(view.filledRegions).toHaveLength(1);
    expect(view.filledRegions[0].start).toBe(130);
    expect(view.filledRegions[0].end).toBe(180);
  });

  it('region SPANNING the edit anchor expands to absorb the delta', () => {
    // Edit at line 59 insert +30. Region spans 40-100 (covers the anchor).
    // start (40) is above anchor → no shift. end (100) is below → +30.
    // Net effect: the region stretches from 40 to 130.
    const v0 = mkSliceView(40, 100);
    const { view } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 1,
      positionalDeltas: [{ line: 59, delta: 30 }],
    });
    expect(view.filledRegions).toHaveLength(1);
    expect(view.filledRegions[0].start).toBe(40);
    expect(view.filledRegions[0].end).toBe(130);
  });

  it('multiple deltas cumulate correctly per-region', () => {
    // Two edits: +5 at line 10, +10 at line 200. Region at 100-150 sits
    // between the two anchors — should shift by +5 (only the first edit
    // is above it) but NOT +15.
    const v0 = mkSliceView(100, 150);
    const { view } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 1,
      positionalDeltas: [
        { line: 10, delta: 5 },
        { line: 200, delta: 10 },
      ],
    });
    expect(view.filledRegions[0].start).toBe(105);
    expect(view.filledRegions[0].end).toBe(155);
  });

  it('deletion below region (negative delta) still leaves region put when above', () => {
    // Region at 1-20, delete 5 lines at line 50. Region is above the
    // delete — it should stay at 1-20.
    const v0 = mkSliceView(1, 20);
    const { view } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 1,
      positionalDeltas: [{ line: 50, delta: -5 }],
    });
    expect(view.filledRegions[0].start).toBe(1);
    expect(view.filledRegions[0].end).toBe(20);
  });

  it('rebase failure when net shift pushes start below 1', () => {
    // Region at 3-10, delete 20 lines at line 1 (full-file deletion
    // starting at top). Start+end both shift by -20 → below line 1.
    const v0 = mkSliceView(3, 10);
    const { view, rebaseFailures } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 1,
      positionalDeltas: [{ line: 1, delta: -20 }],
    });
    expect(view.filledRegions).toHaveLength(0);
    expect(rebaseFailures).toEqual([{ start: 3, end: 10 }]);
  });

  it('lineInclusive delta shifts a region whose start EQUALS the anchor', () => {
    // insert_before at line 50 → lineInclusive:true. Region at 50-60 has
    // its start EQUAL to the anchor; with lineInclusive it shifts by +5.
    const v0 = mkSliceView(50, 60);
    const { view } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 1,
      positionalDeltas: [{ line: 50, delta: 5, lineInclusive: true }],
    });
    expect(view.filledRegions[0].start).toBe(55);
    expect(view.filledRegions[0].end).toBe(65);
  });

  it('positional deltas take precedence over freshnessJournal scalar', () => {
    // Populate the journal with a scalar +100 (garbage value). With
    // positional deltas provided, reconcile should IGNORE the journal.
    recordFreshnessJournal({
      source: 'src/foo.ts',
      previousRevision: 'rev1',
      currentRevision: 'rev2',
      lineDelta: 100,
      recordedAt: Date.now(),
    });
    const v0 = mkSliceView(50, 60);
    const { view } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 1,
      positionalDeltas: [{ line: 40, delta: 3 }],
    });
    // Per-position: line 40 < start 50, so shift by +3 (NOT +100).
    expect(view.filledRegions[0].start).toBe(53);
    expect(view.filledRegions[0].end).toBe(63);
  });

  it('no positional deltas + no journal + postEditResolved keeps region as placeholder', () => {
    // No journal entry, no positional deltas, but postEditResolved:true
    // (runtime will refill from new body). Region stays at original
    // coordinates as a placeholder.
    const v0 = mkSliceView(50, 60);
    const { view, refetchRequests } = reconcileFileView(v0, {
      currentRevision: 'rev2',
      cause: 'same_file_prior_edit',
      round: 1,
      postEditResolved: true,
    });
    expect(view.filledRegions[0].start).toBe(50);
    expect(view.filledRegions[0].end).toBe(60);
    expect(refetchRequests).toEqual([]);
    expect(view.pendingRefetches).toBeUndefined();
  });
});

describe('fileViewStore — retention-hash forwarding chain', () => {
  beforeEach(() => {
    clearFreshnessJournal();
  });

  afterEach(() => {
    clearFreshnessJournal();
  });

  it('reconcile records the old shortHash in previousShortHashes on revision bump', () => {
    const v0 = createFileView(fakeSkeleton({ revision: 'revA' }));
    const oldShort = v0.shortHash;
    expect(v0.previousShortHashes).toBeUndefined();

    const { view } = reconcileFileView(v0, {
      currentRevision: 'revB',
      cause: 'same_file_prior_edit',
      round: 1,
    });
    expect(view.shortHash).not.toBe(oldShort);
    expect(view.previousShortHashes).toEqual([oldShort]);
  });

  it('reconcile preserves an existing chain and appends when the short changes again', () => {
    const v0 = createFileView(fakeSkeleton({ revision: 'revA' }));
    const oldAShort = v0.shortHash;
    const { view: vB } = reconcileFileView(v0, {
      currentRevision: 'revB',
      cause: 'same_file_prior_edit',
      round: 1,
    });
    const oldBShort = vB.shortHash;
    const { view: vC } = reconcileFileView(vB, {
      currentRevision: 'revC',
      cause: 'same_file_prior_edit',
      round: 2,
    });
    expect(vC.previousShortHashes).toEqual([oldAShort, oldBShort]);
  });

  it('reconcile does not push when the shortHash is unchanged (no-op revisions)', () => {
    const v0 = createFileView(fakeSkeleton({ revision: 'revA' }));
    const { view, updated } = reconcileFileView(v0, {
      currentRevision: 'revA',
      cause: 'unknown',
      round: 1,
    });
    expect(updated).toBe(false);
    expect(view.previousShortHashes).toBeUndefined();
  });

  it('matchesViewRef resolves the current shortHash', () => {
    const v = createFileView(fakeSkeleton({ revision: 'rX' }));
    expect(matchesViewRef(v, v.shortHash)).toBe(true);
  });

  it('matchesViewRef resolves a historical shortHash via the forwarding chain', () => {
    const v0 = createFileView(fakeSkeleton({ revision: 'rA' }));
    const oldShort = v0.shortHash;
    const { view } = reconcileFileView(v0, {
      currentRevision: 'rB',
      cause: 'same_file_prior_edit',
      round: 1,
    });
    expect(matchesViewRef(view, view.shortHash)).toBe(true);
    expect(matchesViewRef(view, oldShort)).toBe(true);
  });

  it('matchesViewRef rejects an unrelated short', () => {
    const v = createFileView(fakeSkeleton({ revision: 'rA' }));
    // Deliberately derive a short from an unrelated (path, revision).
    const foreign = computeFileViewHashParts('src/other.ts', 'rA').shortHash;
    expect(matchesViewRef(v, foreign)).toBe(false);
  });

  it('matchesViewRef handles prefix matches symmetrically', () => {
    const v = createFileView(fakeSkeleton({ revision: 'rA' }));
    const full = v.shortHash;
    // 4-char prefix should still match (findViewByRef's relaxed rule).
    expect(matchesViewRef(v, full.slice(0, 4))).toBe(true);
  });
});
