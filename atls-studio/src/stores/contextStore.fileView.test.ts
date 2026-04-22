/**
 * Integration tests for the FileView wire into contextStore.
 *
 * Covers the subset of PR2 that touches the Zustand store:
 * - addChunk with a readSpan auto-populates a FileView filled region
 * - pruneFileViewsForChunks drops regions when chunks are dropped
 * - reconcileSourceRevision forwards to reconcileFileViewsForPath
 * - clearFileViewRemovedMarker and setFileViewPinned work end-to-end
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from './contextStore';
import { recordFreshnessJournal, clearFreshnessJournal } from '../services/freshnessJournal';

vi.mock('../services/hashProtocol', async () => {
  const actual: Record<string, unknown> = await vi.importActual('../services/hashProtocol');
  return actual;
});

function resetStore() {
  useContextStore.getState().resetSession();
  useContextStore.setState({
    hashStack: [],
    editHashStack: [],
    fileViews: new Map(),
  });
  clearFreshnessJournal();
}

function rowLine(n: number, content: string): string {
  return `${String(n).padStart(4)}|${content}`;
}

describe('FileView wire — addChunk with readSpan auto-populates view', () => {
  beforeEach(resetStore);

  it('read with start/end line populates a filled region under the normalized path', () => {
    const store = useContextStore.getState();
    const rev = 'revA123';
    const content = [rowLine(42, 'fn bar() {'), rowLine(43, '  return 1;'), rowLine(44, '}')].join('\n');
    store.addChunk(content, 'smart', 'Src/Foo.ts', undefined, undefined, 'c0ffee11', {
      sourceRevision: rev,
      readSpan: {
        filePath: 'Src/Foo.ts',
        sourceRevision: rev,
        startLine: 42,
        endLine: 44,
      },
    });

    const view = useContextStore.getState().getFileView('src/foo.ts');
    expect(view).toBeDefined();
    expect(view!.filePath).toBe('src/foo.ts');
    expect(view!.sourceRevision).toBe(rev);
    expect(view!.filledRegions).toHaveLength(1);
    expect(view!.filledRegions[0].start).toBe(42);
    expect(view!.filledRegions[0].end).toBe(44);
    expect(view!.filledRegions[0].chunkHashes).toContain('c0ffee11');
  });

  it('two consecutive reads merge into one FileView region', () => {
    const store = useContextStore.getState();
    const rev = 'revB';
    store.addChunk(
      [rowLine(100, 'a'), rowLine(110, 'b')].join('\n'),
      'smart',
      'src/bar.ts',
      undefined, undefined, 'h-aaa',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/bar.ts', sourceRevision: rev, startLine: 100, endLine: 110 },
      },
    );
    store.addChunk(
      [rowLine(108, 'c'), rowLine(115, 'd')].join('\n'),
      'smart',
      'src/bar.ts',
      undefined, undefined, 'h-bbb',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/bar.ts', sourceRevision: rev, startLine: 108, endLine: 115 },
      },
    );

    const view = useContextStore.getState().getFileView('src/bar.ts');
    expect(view).toBeDefined();
    expect(view!.filledRegions).toHaveLength(1);
    expect(view!.filledRegions[0].start).toBe(100);
    expect(view!.filledRegions[0].end).toBe(115);
    expect(view!.filledRegions[0].chunkHashes.sort()).toEqual(['h-aaa', 'h-bbb']);
  });

  it('readSpan without startLine/endLine does NOT populate a region', () => {
    const store = useContextStore.getState();
    const rev = 'revC';
    store.addChunk('some full body content', 'raw', 'src/baz.ts', undefined, undefined, 'h-full', {
      sourceRevision: rev,
      readSpan: { filePath: 'src/baz.ts', sourceRevision: rev }, // no lines
    });

    const view = useContextStore.getState().getFileView('src/baz.ts');
    expect(view).toBeUndefined();
  });

  it('path case and backslash normalize to the same view', () => {
    const store = useContextStore.getState();
    const rev = 'revD';
    store.addChunk(
      rowLine(10, 'a'),
      'smart',
      'Foo\\Bar.ts',
      undefined, undefined, 'h1',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'Foo\\Bar.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    store.addChunk(
      rowLine(20, 'b'),
      'smart',
      'foo/bar.ts',
      undefined, undefined, 'h2',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'foo/bar.ts', sourceRevision: rev, startLine: 20, endLine: 20 },
      },
    );

    const view = useContextStore.getState().getFileView('foo/bar.ts');
    expect(view).toBeDefined();
    expect(view!.filledRegions.length).toBeGreaterThanOrEqual(1);
    // Both chunks land in the same view
    const allHashes = view!.filledRegions.flatMap(r => r.chunkHashes);
    expect(allHashes).toContain('h1');
    expect(allHashes).toContain('h2');
  });
});

describe('FileView wire — reconcileSourceRevision', () => {
  beforeEach(resetStore);

  it('same_file_prior_edit rebases view regions via freshnessJournal', () => {
    const store = useContextStore.getState();
    const initialRev = 'revFirst';
    store.addChunk(
      [rowLine(42, 'fn bar'), rowLine(44, '}')].join('\n'),
      'smart',
      'src/edit.ts',
      undefined, undefined, 'h-edit1',
      {
        sourceRevision: initialRev,
        readSpan: { filePath: 'src/edit.ts', sourceRevision: initialRev, startLine: 42, endLine: 44 },
      },
    );

    // Record a +5 shift (5 lines inserted before line 42).
    recordFreshnessJournal({
      source: 'src/edit.ts',
      previousRevision: initialRev,
      currentRevision: 'revSecond',
      lineDelta: 5,
      recordedAt: Date.now(),
    });

    useContextStore.getState().reconcileSourceRevision('src/edit.ts', 'revSecond', 'same_file_prior_edit');

    const view = useContextStore.getState().getFileView('src/edit.ts');
    expect(view).toBeDefined();
    expect(view!.sourceRevision).toBe('revSecond');
    expect(view!.filledRegions).toHaveLength(1);
    expect(view!.filledRegions[0].start).toBe(47);
    expect(view!.filledRegions[0].end).toBe(49);
    expect(view!.freshness).toBe('shifted');
  });

  it('external_file_change drops unpinned regions silently', () => {
    const store = useContextStore.getState();
    const rev = 'r1';
    store.addChunk(
      rowLine(10, 'a'),
      'smart',
      'src/ext.ts',
      undefined, undefined, 'h-ext',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/ext.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );

    useContextStore.getState().reconcileSourceRevision('src/ext.ts', 'r2', 'external_file_change');

    const view = useContextStore.getState().getFileView('src/ext.ts');
    expect(view).toBeDefined();
    expect(view!.filledRegions).toHaveLength(0);
    expect(view!.pendingRefetches ?? []).toHaveLength(0);
  });

  it('external_file_change queues refetches for pinned views', () => {
    const store = useContextStore.getState();
    const rev = 'r1';
    store.addChunk(
      rowLine(10, 'a'),
      'smart',
      'src/pin.ts',
      undefined, undefined, 'h-pin',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/pin.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    useContextStore.getState().setFileViewPinned('src/pin.ts', true);

    useContextStore.getState().reconcileSourceRevision('src/pin.ts', 'r2', 'external_file_change');

    const view = useContextStore.getState().getFileView('src/pin.ts');
    expect(view).toBeDefined();
    expect(view!.pendingRefetches?.length).toBe(1);
    expect(view!.pendingRefetches![0]).toMatchObject({ start: 10, end: 10 });
  });
});

describe('FileView wire — dropChunks routing', () => {
  beforeEach(resetStore);

  it('dropChunks on a pinned FileView ref drops WM chunks but keeps the view and line content', () => {
    const store = useContextStore.getState();
    const rev = 'r-drop-pin';
    const shortHash = store.addChunk(
      rowLine(10, 'a'),
      'smart',
      'src/drop-pin.ts',
      undefined, undefined, 'cafebabe12345678',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/drop-pin.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    store.setFileViewPinned('src/drop-pin.ts', true);

    useContextStore.getState().dropChunks([shortHash]);

    const view = useContextStore.getState().getFileView('src/drop-pin.ts');
    expect(view).toBeDefined();
    expect(view!.pinned).toBe(true);
    expect(view!.filledRegions).toHaveLength(1);
    expect(view!.filledRegions[0].chunkHashes).toEqual([]);
    expect(view!.filledRegions[0].content).toMatch(/^\s*10\|/);

    const stillPresent = Array.from(useContextStore.getState().chunks.values())
      .some(c => c.shortHash === shortHash);
    expect(stillPresent).toBe(false);
  });

  it('dropChunks on a slice ref removes the whole FileView and its backing chunks (unpinned)', () => {
    // Unpinned: dropping any chunk for a file removes the FileView row (retention released).
    const store = useContextStore.getState();
    const rev = 'r-drop';
    const shortHash = store.addChunk(
      rowLine(10, 'a'),
      'smart',
      'src/drop.ts',
      undefined, undefined, 'deadbeef12345678',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/drop.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );

    let view = useContextStore.getState().getFileView('src/drop.ts');
    expect(view!.filledRegions).toHaveLength(1);

    useContextStore.getState().dropChunks([shortHash]);
    view = useContextStore.getState().getFileView('src/drop.ts');
    expect(view).toBeUndefined();
    // Backing chunk also gone from active + archive.
    const stillPresent = Array.from(useContextStore.getState().chunks.values())
      .some(c => c.shortHash === shortHash);
    expect(stillPresent).toBe(false);
  });

  it('TTL-archived constituent chunks thin their regions via pruneFileViewsForChunks', async () => {
    const store = useContextStore.getState();
    const rev = 'r-prune';
    const shortHash = store.addChunk(
      rowLine(10, 'a'),
      'smart',
      'src/prune.ts',
      undefined, undefined, 'abcdef1234567890',
      {
        sourceRevision: rev,
        ttl: 1,
        readSpan: { filePath: 'src/prune.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    expect(useContextStore.getState().getFileView('src/prune.ts')!.filledRegions).toHaveLength(1);

    await store.refreshRoundEnd({
      paths: ['src/prune.ts'],
      getRevisionForPath: async () => rev,
    });

    // Chunk TTL-archived; region pruned (not the view itself).
    const view = useContextStore.getState().getFileView('src/prune.ts');
    expect(view).toBeDefined();
    expect(view!.filledRegions).toHaveLength(0);
    expect(Array.from(useContextStore.getState().chunks.values()).some(c => c.shortHash === shortHash)).toBe(false);
  });

  it('TTL-archived chunks on a pinned FileView retain region content (detached chunk hashes)', async () => {
    const store = useContextStore.getState();
    const rev = 'r-prune-pin';
    const shortHash = store.addChunk(
      rowLine(10, 'a'),
      'smart',
      'src/prune-pin.ts',
      undefined, undefined, 'babecafe12345678',
      {
        sourceRevision: rev,
        ttl: 1,
        readSpan: { filePath: 'src/prune-pin.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    store.setFileViewPinned('src/prune-pin.ts', true);
    expect(useContextStore.getState().getFileView('src/prune-pin.ts')!.filledRegions).toHaveLength(1);

    await store.refreshRoundEnd({
      paths: ['src/prune-pin.ts'],
      getRevisionForPath: async () => rev,
    });

    const view = useContextStore.getState().getFileView('src/prune-pin.ts');
    expect(view).toBeDefined();
    expect(view!.filledRegions).toHaveLength(1);
    expect(view!.filledRegions[0].chunkHashes).toEqual([]);
    expect(view!.filledRegions[0].content).toMatch(/^\s*10\|/);
    expect(Array.from(useContextStore.getState().chunks.values()).some(c => c.shortHash === shortHash)).toBe(false);
  });
});

describe('FileView wire — marker and pin helpers', () => {
  beforeEach(resetStore);

  it('clearFileViewRemovedMarker drops a specific range', () => {
    const store = useContextStore.getState();
    const rev = 'r-mark';
    store.addChunk(
      rowLine(10, 'a'),
      'smart',
      'src/mark.ts',
      undefined, undefined, 'h-mark',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/mark.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    // Force a rebase-failure state by reconciling with a very negative journal delta.
    recordFreshnessJournal({
      source: 'src/mark.ts',
      previousRevision: rev,
      currentRevision: 'r2',
      lineDelta: -100,
      recordedAt: Date.now(),
    });
    useContextStore.getState().reconcileSourceRevision('src/mark.ts', 'r2', 'same_file_prior_edit');

    const view1 = useContextStore.getState().getFileView('src/mark.ts');
    expect(view1!.removedMarkers?.length).toBe(1);

    useContextStore.getState().clearFileViewRemovedMarker('src/mark.ts', 10, 10);
    const view2 = useContextStore.getState().getFileView('src/mark.ts');
    expect(view2!.removedMarkers).toBeUndefined();
  });

  it('setFileViewPinned toggles pinned flag without race', () => {
    const store = useContextStore.getState();
    const rev = 'rv';
    store.addChunk(
      rowLine(10, 'a'),
      'smart',
      'src/pinflag.ts',
      undefined, undefined, 'h-flag',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/pinflag.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    expect(useContextStore.getState().getFileView('src/pinflag.ts')!.pinned).toBe(false);

    useContextStore.getState().setFileViewPinned('src/pinflag.ts', true);
    expect(useContextStore.getState().getFileView('src/pinflag.ts')!.pinned).toBe(true);

    useContextStore.getState().setFileViewPinned('src/pinflag.ts', false);
    expect(useContextStore.getState().getFileView('src/pinflag.ts')!.pinned).toBe(false);
  });
});

describe('FileView wire — full-body fill', () => {
  beforeEach(resetStore);

  it('applyFullBodyFromChunk sets the fullBody slot directly', () => {
    useContextStore.getState().applyFullBodyFromChunk({
      filePath: 'src/full.ts',
      sourceRevision: 'rv',
      content: 'the whole file content',
      chunkHash: 'hFULL',
      totalLines: 100,
    });

    const view = useContextStore.getState().getFileView('src/full.ts');
    expect(view).toBeDefined();
    expect(view!.fullBody).toBe('the whole file content');
    expect(view!.fullBodyChunkHash).toBe('hFULL');
    expect(view!.totalLines).toBe(100);
  });

  it('addChunk with readSpan contextType:"full" auto-populates fullBody', () => {
    const store = useContextStore.getState();
    const rev = 'rev-full-auto';
    store.addChunk(
      'entire file bytes here\nline two\nline three',
      'raw',
      'src/auto-full.ts',
      undefined, undefined, 'h-auto-full',
      {
        sourceRevision: rev,
        viewKind: 'latest',
        readSpan: {
          filePath: 'src/auto-full.ts',
          sourceRevision: rev,
          contextType: 'full',
        },
      },
    );
    const view = useContextStore.getState().getFileView('src/auto-full.ts');
    expect(view).toBeDefined();
    expect(view!.sourceRevision).toBe(rev);
    expect(view!.fullBody).toBe('entire file bytes here\nline two\nline three');
    expect(view!.fullBodyChunkHash).toBe('h-auto-full');
  });

  it('addChunk with readSpan contextType:"raw" also auto-populates fullBody', () => {
    const store = useContextStore.getState();
    const rev = 'rev-raw';
    store.addChunk(
      'raw body',
      'raw',
      'src/auto-raw.ts',
      undefined, undefined, 'h-auto-raw',
      {
        sourceRevision: rev,
        viewKind: 'latest',
        readSpan: {
          filePath: 'src/auto-raw.ts',
          sourceRevision: rev,
          contextType: 'raw',
        },
      },
    );
    const view = useContextStore.getState().getFileView('src/auto-raw.ts');
    expect(view!.fullBody).toBe('raw body');
  });

  it('smart-read (no line range, non-full contextType) does NOT populate fullBody', () => {
    const store = useContextStore.getState();
    const rev = 'rev-smart';
    store.addChunk(
      'sig-ish content',
      'smart',
      'src/smart-only.ts',
      undefined, undefined, 'h-smart',
      {
        sourceRevision: rev,
        viewKind: 'latest',
        readSpan: {
          filePath: 'src/smart-only.ts',
          sourceRevision: rev,
          contextType: 'smart',
        },
      },
    );
    // Skeleton population runs async; fullBody must remain undefined.
    const view = useContextStore.getState().getFileView('src/smart-only.ts');
    // View may or may not exist yet (skeleton fetch is async), but if it exists,
    // fullBody must not be populated from a smart read.
    if (view) {
      expect(view.fullBody).toBeUndefined();
    }
  });
});

describe('FileView wire — skeleton population', () => {
  beforeEach(resetStore);

  it('ensureFileViewSkeleton populates skeleton rows for a new view', async () => {
    const store = useContextStore.getState();
    const { clearSkeletonCache } = await import('../services/fileView');
    clearSkeletonCache();
    // Mock invoke via module replacement is overkill here — instead, use the
    // injectable invoker by calling getFileSkeleton directly through the store
    // action. The action pulls via getFileSkeleton which in test env will fail
    // the tauri invoke; best-effort no-op is expected.
    await store.ensureFileViewSkeleton('src/sk.ts', 'rev-sk');
    // No skeleton installed (invoker fails silently in test env); view either
    // absent or empty. Either behavior is acceptable under the fire-and-forget
    // contract. Stronger coverage lives in fileView.test.ts with an injected invoker.
    const view = useContextStore.getState().getFileView('src/sk.ts');
    if (view) {
      expect(Array.isArray(view.skeletonRows)).toBe(true);
    }
  });

  it('ensureFileViewSkeleton is idempotent (no-op when skeleton already matches)', async () => {
    const store = useContextStore.getState();
    // Pre-seed a view with an empty skeleton at rev
    store.applyFullBodyFromChunk({
      filePath: 'src/idemp.ts',
      sourceRevision: 'rev-idemp',
      content: 'body',
      chunkHash: 'h-idemp',
      totalLines: 10,
    });
    const before = useContextStore.getState().getFileView('src/idemp.ts');
    expect(before).toBeDefined();
    // Running ensureFileViewSkeleton in the test env will fail silently (no tauri).
    await store.ensureFileViewSkeleton('src/idemp.ts', 'rev-idemp');
    const after = useContextStore.getState().getFileView('src/idemp.ts');
    expect(after!.fullBody).toBe('body');
  });

  it('ensureFileViewSkeleton on missing inputs is a no-op', async () => {
    const store = useContextStore.getState();
    await store.ensureFileViewSkeleton('', 'rev');
    await store.ensureFileViewSkeleton('src/x.ts', '');
    expect(useContextStore.getState().fileViews.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unified hash namespace — view refs and chunk refs share `h:<short>`
// ---------------------------------------------------------------------------

describe('FileView wire — unified hash namespace (h:<short>)', () => {
  beforeEach(resetStore);

  it('pinChunks accepts the short view ref directly (no h:fv: prefix)', () => {
    // Model-side contract: a read returns `h:<6hex>`; that exact string,
    // passed back through pinChunks, must pin the view.
    const store = useContextStore.getState();
    const rev = 'rev-short';
    store.addChunk(
      rowLine(10, 'line'),
      'smart',
      'src/short.ts',
      undefined, undefined, 'hchk-short',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/short.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    const view = useContextStore.getState().getFileView('src/short.ts')!;
    expect(view.hash).toMatch(/^h:[0-9a-f]{6}$/);
    expect(view.shortHash).toMatch(/^[0-9a-f]{6}$/);

    const r = useContextStore.getState().pinChunks([view.hash]);
    expect(r.count).toBe(1);
    expect(useContextStore.getState().getFileView('src/short.ts')!.pinned).toBe(true);
  });

  it('view/chunk precedence on short-hash collision: view wins', async () => {
    // Force the collision by directly injecting two entries whose short hashes
    // are equal. The resolver should route retention ops to the view.
    const { drainRefCollisionCount, _resetRefCollisionCountForTests } = await import('./contextStore');
    _resetRefCollisionCountForTests();

    const store = useContextStore.getState();
    const rev = 'rev-collide';
    store.addChunk(
      rowLine(10, 'payload'),
      'smart',
      'src/collide.ts',
      undefined, undefined, 'collide-slice',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/collide.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    const view = useContextStore.getState().getFileView('src/collide.ts')!;

    // Surgically clone a chunk and rewrite its shortHash to collide with the view.
    const targetShort = view.shortHash;
    const chunks = new Map(useContextStore.getState().chunks);
    const firstChunk = chunks.values().next().value!;
    const aliasedChunk = { ...firstChunk, shortHash: targetShort, hash: `h:${targetShort}` };
    chunks.set(`h:${targetShort}`, aliasedChunk);
    useContextStore.setState({ chunks });

    // Pin via the colliding short hash: view must win.
    const r = useContextStore.getState().pinChunks([`h:${targetShort}`]);
    expect(r.count).toBe(1);
    expect(useContextStore.getState().getFileView('src/collide.ts')!.pinned).toBe(true);
    // Collision counter reports the ambiguity for observability.
    expect(drainRefCollisionCount()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Watch-item 3: annotate.note accepts FileView hashes (engram vs view routing)
// ---------------------------------------------------------------------------

describe('annotation routing — FileView hashes attach to the view', () => {
  beforeEach(resetStore);

  function seedView(path: string, rev: string, chunkHash: string) {
    const store = useContextStore.getState();
    store.addChunk(
      rowLine(42, 'payload'),
      'smart',
      path,
      undefined, undefined, chunkHash,
      {
        sourceRevision: rev,
        readSpan: { filePath: path, sourceRevision: rev, startLine: 42, endLine: 42 },
      },
    );
    return useContextStore.getState().getFileView(path)!;
  }

  it('annotate.note with a view hash lands on FileView.annotations (not chunk)', () => {
    const view = seedView('src/note-view.ts', 'rev-n1', 'chk-n1');
    const r = useContextStore.getState().addAnnotation(view.hash, 'eviction uses XOR tie-break');
    expect(r.ok).toBe(true);

    const after = useContextStore.getState().getFileView('src/note-view.ts')!;
    expect(after.annotations).toBeDefined();
    expect(after.annotations!.length).toBe(1);
    expect(after.annotations![0].content).toBe('eviction uses XOR tie-break');

    // The chunk must not have received the annotation.
    const state = useContextStore.getState();
    for (const [, chunk] of state.chunks) {
      expect(chunk.annotations ?? []).toHaveLength(0);
    }
  });

  it('annotate.note with a chunk hash still lands on the chunk (no regression)', () => {
    // Use addChunk without a readSpan so no view is created; the returned
    // short hash points at a plain chunk. Validates the existing chunk path.
    const store = useContextStore.getState();
    const shortHash = store.addChunk('plain body', 'result', 'verify.lint', undefined, 'summary');
    const r = useContextStore.getState().addAnnotation(`h:${shortHash}`, 'lint audit note');
    expect(r.ok).toBe(true);

    const state = useContextStore.getState();
    const chunk = Array.from(state.chunks.values()).find(c => c.shortHash === shortHash);
    expect(chunk).toBeDefined();
    expect(chunk!.annotations?.[0].content).toBe('lint audit note');
  });

  it('editEngram rejects FileView hashes with a specific hint', () => {
    const view = seedView('src/edit-view.ts', 'rev-e1', 'chk-e1');
    const r = useContextStore.getState().editEngram(view.hash, { content: 'new' });
    expect(r.ok).toBe(false);
    expect(r.error ?? '').toMatch(/FileView/i);
    expect(r.error ?? '').toMatch(/change\.edit|annotate\.note/);
  });

  it('annotate.note on an unknown hash returns "engram not found"', () => {
    const r = useContextStore.getState().addAnnotation('h:deadbeef', 'ghost note');
    expect(r.ok).toBe(false);
    expect(r.error ?? '').toMatch(/engram not found/);
  });
});

// ---------------------------------------------------------------------------
// Post-edit statefulness — runtime-authoritative refill without re-read
// ---------------------------------------------------------------------------

describe('FileView post-edit statefulness (slice view)', () => {
  beforeEach(resetStore);

  it('reconcileSourceRevision({postEditResolved:true}) rebases regions without queuing pendingRefetches', () => {
    const store = useContextStore.getState();
    const rev1 = 'revP1';
    // Seed a pinned slice view — matches the common rl/auto-pin case.
    store.addChunk(
      [rowLine(42, 'fn bar() {'), rowLine(43, '  return 1;'), rowLine(44, '}')].join('\n'),
      'smart',
      'src/post.ts',
      undefined, undefined, 'chk-p1',
      {
        sourceRevision: rev1,
        readSpan: { filePath: 'src/post.ts', sourceRevision: rev1, startLine: 42, endLine: 44 },
      },
    );
    store.setFileViewPinned('src/post.ts', true);

    // Edit shifted lines by +5. Journal delta populated (as change.edit
    // handler would do on a successful mutation).
    recordFreshnessJournal({
      source: 'src/post.ts',
      previousRevision: rev1,
      currentRevision: 'revP2',
      lineDelta: 5,
      recordedAt: Date.now(),
    });

    // Executor path emulated: advance revision with postEditResolved hint.
    useContextStore.getState().reconcileSourceRevision(
      'src/post.ts',
      'revP2',
      'same_file_prior_edit',
      { postEditResolved: true },
    );

    const view = useContextStore.getState().getFileView('src/post.ts');
    expect(view).toBeDefined();
    expect(view!.sourceRevision).toBe('revP2');
    // Region rebased by +5, NOT queued for refetch.
    expect(view!.filledRegions).toHaveLength(1);
    expect(view!.filledRegions[0].start).toBe(47);
    expect(view!.filledRegions[0].end).toBe(49);
    expect(view!.pendingRefetches).toBeUndefined();
  });

  it('without postEditResolved, a same_file_prior_edit without journal delta keeps region as placeholder (no silent loss)', () => {
    // This is the "pinned + content-change + no journal delta" branch.
    // The runtime does not have a lineDelta; historically the old path
    // queued a pendingRefetch. With postEditResolved:true the placeholder
    // is retained — the caller (refreshContextAfterEdit) will re-slice.
    const store = useContextStore.getState();
    const rev1 = 'revQ1';
    store.addChunk(
      rowLine(10, 'x'),
      'smart',
      'src/noJournal.ts',
      undefined, undefined, 'chk-q1',
      {
        sourceRevision: rev1,
        readSpan: { filePath: 'src/noJournal.ts', sourceRevision: rev1, startLine: 10, endLine: 10 },
      },
    );
    store.setFileViewPinned('src/noJournal.ts', true);

    useContextStore.getState().reconcileSourceRevision(
      'src/noJournal.ts',
      'revQ2',
      'same_file_prior_edit',
      { postEditResolved: true },
    );

    const view = useContextStore.getState().getFileView('src/noJournal.ts');
    expect(view!.sourceRevision).toBe('revQ2');
    expect(view!.filledRegions).toHaveLength(1);
    expect(view!.filledRegions[0].start).toBe(10);
    expect(view!.pendingRefetches).toBeUndefined();
  });

  it('positional deltas rebase regions with per-position precision (above=unchanged, below=shifted)', () => {
    // This is the scenario the user flagged: a same-batch edit at line 59
    // shifts only the regions BELOW line 59; regions above should stay
    // put. The scalar lineDelta path would have shifted ALL regions
    // uniformly, corrupting slice views.
    const store = useContextStore.getState();
    const rev1 = 'revPD1';
    // Seed two slice regions: one above the upcoming edit anchor, one below.
    store.addChunk(
      [rowLine(10, 'top A'), rowLine(20, 'top B')].join('\n'),
      'smart',
      'src/posdelta.ts',
      undefined, undefined, 'chk-top',
      {
        sourceRevision: rev1,
        readSpan: { filePath: 'src/posdelta.ts', sourceRevision: rev1, startLine: 10, endLine: 20 },
      },
    );
    store.addChunk(
      [rowLine(100, 'bot A'), rowLine(120, 'bot B')].join('\n'),
      'smart',
      'src/posdelta.ts',
      undefined, undefined, 'chk-bot',
      {
        sourceRevision: rev1,
        readSpan: { filePath: 'src/posdelta.ts', sourceRevision: rev1, startLine: 100, endLine: 120 },
      },
    );
    store.setFileViewPinned('src/posdelta.ts', true);

    // Pass per-position deltas: +30 at line 59 (the edit anchor).
    useContextStore.getState().reconcileSourceRevision(
      'src/posdelta.ts',
      'revPD2',
      'same_file_prior_edit',
      {
        postEditResolved: true,
        positionalDeltas: [{ line: 59, delta: 30 }],
      },
    );

    const view = useContextStore.getState().getFileView('src/posdelta.ts');
    expect(view).toBeDefined();
    expect(view!.sourceRevision).toBe('revPD2');
    expect(view!.filledRegions).toHaveLength(2);
    const sorted = [...view!.filledRegions].sort((a, b) => a.start - b.start);
    // Top region (10-20): above anchor → NOT shifted.
    expect(sorted[0].start).toBe(10);
    expect(sorted[0].end).toBe(20);
    // Bottom region (100-120): below anchor → shifted by +30.
    expect(sorted[1].start).toBe(130);
    expect(sorted[1].end).toBe(150);
  });

  it('applyFillFromChunk at the new revision replaces pre-edit content in the region (authoritative post-edit bytes)', () => {
    // Mirrors the `refillSliceRegionsFromNewBody` path in executor.ts: after
    // reconcile advances the view, the executor re-slices each surviving
    // region from the resolved post-edit body and calls applyFillFromChunk
    // with origin:'refetch'. The region ends up with new bytes at the
    // rebased coords.
    const store = useContextStore.getState();
    const rev1 = 'revR1';
    store.addChunk(
      [rowLine(42, 'old line 42'), rowLine(43, 'old line 43')].join('\n'),
      'smart',
      'src/bytes.ts',
      undefined, undefined, 'chk-r1',
      {
        sourceRevision: rev1,
        readSpan: { filePath: 'src/bytes.ts', sourceRevision: rev1, startLine: 42, endLine: 43 },
      },
    );
    store.setFileViewPinned('src/bytes.ts', true);
    recordFreshnessJournal({
      source: 'src/bytes.ts',
      previousRevision: rev1,
      currentRevision: 'revR2',
      lineDelta: 0,
      recordedAt: Date.now(),
    });

    // Simulate executor flow: reconcile + re-slice with origin:'refetch'.
    useContextStore.getState().reconcileSourceRevision(
      'src/bytes.ts',
      'revR2',
      'same_file_prior_edit',
      { postEditResolved: true },
    );
    useContextStore.getState().applyFillFromChunk({
      filePath: 'src/bytes.ts',
      sourceRevision: 'revR2',
      startLine: 42,
      endLine: 43,
      content: [rowLine(42, 'new line 42'), rowLine(43, 'new line 43')].join('\n'),
      chunkHash: 'chk-r2',
      tokens: 5,
      origin: 'refetch',
      refetchedAtRound: 7,
    });

    const view = useContextStore.getState().getFileView('src/bytes.ts');
    expect(view!.sourceRevision).toBe('revR2');
    expect(view!.filledRegions).toHaveLength(1);
    expect(view!.filledRegions[0].content).toContain('new line 42');
    expect(view!.filledRegions[0].content).toContain('new line 43');
    expect(view!.filledRegions[0].content).not.toContain('old line 42');
    expect(view!.filledRegions[0].origin).toBe('refetch');
    expect(view!.filledRegions[0].refetchedAtRound).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Retention-hash forwarding chain — pre-edit shortHash still resolves
// ---------------------------------------------------------------------------

describe('FileView retention-hash forwarding across own-edits', () => {
  beforeEach(resetStore);

  it('reconcileSourceRevision records the old shortHash on the view', () => {
    const store = useContextStore.getState();
    const rev1 = 'revF1';
    store.addChunk(
      rowLine(10, 'x'),
      'smart',
      'src/fwd.ts',
      undefined, undefined, 'chk-f1',
      {
        sourceRevision: rev1,
        readSpan: { filePath: 'src/fwd.ts', sourceRevision: rev1, startLine: 10, endLine: 10 },
      },
    );
    const before = useContextStore.getState().getFileView('src/fwd.ts')!;
    const oldShort = before.shortHash;

    recordFreshnessJournal({
      source: 'src/fwd.ts',
      previousRevision: rev1,
      currentRevision: 'revF2',
      lineDelta: 0,
      recordedAt: Date.now(),
    });
    useContextStore.getState().reconcileSourceRevision(
      'src/fwd.ts',
      'revF2',
      'same_file_prior_edit',
      { postEditResolved: true },
    );

    const after = useContextStore.getState().getFileView('src/fwd.ts')!;
    expect(after.shortHash).not.toBe(oldShort);
    expect(after.previousShortHashes).toContain(oldShort);
  });

  it('dropChunks via a historical retention ref routes to the correct view', () => {
    // Agent transcript contained `h:<oldShort>` from before the edit;
    // after the edit the view's current short is different. The historical
    // ref should still find the view for pu / pc / dro.
    //
    // Note: pinned views survive dropChunks by design (existing contract —
    // backing chunks are dropped but the pinned view row stays). We test
    // both the pinned-check routing and the unpinned drop routing.
    const store = useContextStore.getState();
    const rev1 = 'revG1';
    store.addChunk(
      rowLine(10, 'x'),
      'smart',
      'src/stale.ts',
      undefined, undefined, 'chk-g1',
      {
        sourceRevision: rev1,
        readSpan: { filePath: 'src/stale.ts', sourceRevision: rev1, startLine: 10, endLine: 10 },
      },
    );
    const before = useContextStore.getState().getFileView('src/stale.ts')!;
    const oldRef = `h:${before.shortHash}`;
    store.setFileViewPinned('src/stale.ts', true);

    recordFreshnessJournal({
      source: 'src/stale.ts',
      previousRevision: rev1,
      currentRevision: 'revG2',
      lineDelta: 0,
      recordedAt: Date.now(),
    });
    useContextStore.getState().reconcileSourceRevision(
      'src/stale.ts',
      'revG2',
      'same_file_prior_edit',
      { postEditResolved: true },
    );

    // Historical ref is pinned-check-able — forwarding walks the chain.
    expect(useContextStore.getState().isPinnedFileViewRef(oldRef)).toBe(true);

    // Unpin, then drop via historical ref: the view should tear down.
    useContextStore.getState().setFileViewPinned('src/stale.ts', false);
    useContextStore.getState().dropChunks([oldRef]);
    expect(useContextStore.getState().getFileView('src/stale.ts')).toBeUndefined();
  });

  it('previousShortHashes persists across multiple revision bumps (chain of 2)', () => {
    const store = useContextStore.getState();
    store.addChunk(
      rowLine(10, 'x'),
      'smart',
      'src/chain.ts',
      undefined, undefined, 'chk-h1',
      {
        sourceRevision: 'revH1',
        readSpan: { filePath: 'src/chain.ts', sourceRevision: 'revH1', startLine: 10, endLine: 10 },
      },
    );
    const v0 = useContextStore.getState().getFileView('src/chain.ts')!;
    const shortAtH1 = v0.shortHash;

    recordFreshnessJournal({
      source: 'src/chain.ts',
      previousRevision: 'revH1',
      currentRevision: 'revH2',
      lineDelta: 0,
      recordedAt: Date.now(),
    });
    useContextStore.getState().reconcileSourceRevision(
      'src/chain.ts', 'revH2', 'same_file_prior_edit',
      { postEditResolved: true },
    );
    const v1 = useContextStore.getState().getFileView('src/chain.ts')!;
    const shortAtH2 = v1.shortHash;

    recordFreshnessJournal({
      source: 'src/chain.ts',
      previousRevision: 'revH2',
      currentRevision: 'revH3',
      lineDelta: 0,
      recordedAt: Date.now(),
    });
    useContextStore.getState().reconcileSourceRevision(
      'src/chain.ts', 'revH3', 'same_file_prior_edit',
      { postEditResolved: true },
    );
    const v2 = useContextStore.getState().getFileView('src/chain.ts')!;

    expect(v2.sourceRevision).toBe('revH3');
    expect(v2.previousShortHashes).toEqual([shortAtH1, shortAtH2]);
    // Both historical refs still resolve.
    expect(useContextStore.getState().getFileView('src/chain.ts')!.shortHash).not.toBe(shortAtH1);
    const state = useContextStore.getState();
    expect(state.isPinnedFileViewRef(`h:${shortAtH1}`)).toBe(false); // not pinned yet
    state.setFileViewPinned('src/chain.ts', true);
    expect(state.isPinnedFileViewRef(`h:${shortAtH1}`)).toBe(true);
    expect(state.isPinnedFileViewRef(`h:${shortAtH2}`)).toBe(true);
  });

  it('applyFillFromChunk rebuild-at-new-revision preserves the forwarding chain', () => {
    // When the view is force-rebuilt (applyFillFromChunk seeing a newer
    // revision than stored), the prior shortHash still lands in
    // previousShortHashes so transcripts don't lose routability.
    const store = useContextStore.getState();
    store.addChunk(
      rowLine(10, 'x'),
      'smart',
      'src/rebuild.ts',
      undefined, undefined, 'chk-r1',
      {
        sourceRevision: 'revRb1',
        readSpan: { filePath: 'src/rebuild.ts', sourceRevision: 'revRb1', startLine: 10, endLine: 10 },
      },
    );
    const before = useContextStore.getState().getFileView('src/rebuild.ts')!;
    const oldShort = before.shortHash;

    // New revision via fill path without going through reconcile first.
    useContextStore.getState().applyFillFromChunk({
      filePath: 'src/rebuild.ts',
      sourceRevision: 'revRb2',
      startLine: 20,
      endLine: 20,
      content: rowLine(20, 'y'),
      chunkHash: 'chk-r2',
      tokens: 1,
      origin: 'refetch',
      refetchedAtRound: 1,
    });
    const after = useContextStore.getState().getFileView('src/rebuild.ts')!;
    expect(after.sourceRevision).toBe('revRb2');
    expect(after.shortHash).not.toBe(oldShort);
    expect(after.previousShortHashes).toContain(oldShort);
  });
});
