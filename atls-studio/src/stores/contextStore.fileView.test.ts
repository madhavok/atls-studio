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
// Static import — dynamic `await import()` can time out under heavy
// parallel vitest load on Windows when the executor module's transitive
// deps spool up (large graph). Static import fixes the timeout flake.
import { buildPerFileDeltaMap } from '../services/batch/executor';

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

describe('FileView stable identity across own-edits', () => {
  beforeEach(resetStore);

  it('reconcileSourceRevision preserves the shortHash across revision bumps (stable pin)', () => {
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
    const stableShort = before.shortHash;

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
    // The same retention ref the model pinned in round N still matches the
    // view in round N+1 — no chain walk, no dormancy. sourceRevision moved
    // internally for backend resolution; the model-visible identity did not.
    expect(after.shortHash).toBe(stableShort);
    expect(after.sourceRevision).toBe('revF2');
    // Chain stays empty for path-derived identity; only migrated legacy
    // views populate it.
    expect(after.previousShortHashes).toBeUndefined();
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

  it('shortHash stays stable across any number of sequential edits', () => {
    // This is the property that makes "pinned = always fresh" work. The
    // model's transcript cites `h:<short>` in round 1; that same short is
    // still the live view ref in round 100 regardless of how many edits
    // happened between. No dormancy accumulation, no forwarding chain
    // lookup on the hot path.
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
    const stableShort = useContextStore.getState().getFileView('src/chain.ts')!.shortHash;

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
    expect(v1.shortHash).toBe(stableShort);

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
    expect(v2.shortHash).toBe(stableShort);
    expect(v2.previousShortHashes).toBeUndefined();

    // The original pin ref is the only one needed — it still matches.
    useContextStore.getState().setFileViewPinned('src/chain.ts', true);
    expect(useContextStore.getState().isPinnedFileViewRef(`h:${stableShort}`)).toBe(true);
  });

  it('REPRO transcript flow: rf(full) then N sequential edits — fullBody reflects latest content', () => {
    // Transcript scenario: create file → rf type:full → 3 sequential edits
    // (replace, delete, insert_after) → multi-region edit. Final view should
    // render post-edit content. The transcript showed ORIGINAL content
    // instead — this test pins down whether the store-level contract holds.
    const store = useContextStore.getState();
    const path = 'test-edit-ops.txt';
    const revInit = 'revinit1';
    const bodyInit = [
      'Line 1: Hello World',
      'Line 2: This is a test file',
      'Line 3: For testing edit operations',
      'Line 4: Replace me',
      'Line 5: Delete me',
      'Line 6: Keep me',
      'Line 7: Insert after me',
      'Line 8: Final line',
    ].join('\n');

    // Simulate rf type:full: addChunk with readSpan contextType='full'.
    // This is what ingestStandardContextItems does for `rf type:full` reads.
    store.addChunk(
      bodyInit, 'raw', path, undefined, undefined, revInit,
      {
        sourceRevision: revInit,
        viewKind: 'latest',
        readSpan: { filePath: path, sourceRevision: revInit, contextType: 'full' },
      },
    );
    // Then auto-pin like autoPinViewAfterRead does.
    useContextStore.getState().setFileViewPinned(path, true);

    // Simulate a seeded skeleton (ensureFileViewSkeleton runs async after
    // read; for plain-text files sig may return the whole file as rows).
    // This is the path where the bug shows up — if fullBody gets cleared
    // and not restored, the render falls back to these skeleton rows.
    const skeletonRows = bodyInit.split('\n').map((l, i) => `${String(i + 1).padStart(4)}|${l}`);
    useContextStore.setState(state => {
      const next = new Map(state.fileViews);
      const view = next.get(path);
      if (view) next.set(path, { ...view, skeletonRows, totalLines: 8 });
      return { fileViews: next };
    });

    const v0 = useContextStore.getState().getFileView(path)!;
    expect(v0.fullBody).toBe(bodyInit);
    expect(v0.skeletonRows.length).toBe(8);

    // Executor's refreshContextAfterEdit flow — one deterministic call
    // per edit with the positional deltas the executor already computed
    // from line_edits. No fullBody-clear-then-restore dance, no reconcile.
    const applyEdit = (newRev: string, newBody: string, deltas: Array<{ line: number; delta: number; lineInclusive?: boolean; consumes?: number }>): void => {
      useContextStore.getState().addChunk(
        newBody, 'file', path, undefined, undefined, newRev,
        { sourceRevision: newRev, origin: 'edit-refresh', viewKind: 'latest' },
      );
      useContextStore.getState().reconcileSourceRevision(
        path, newRev, 'same_file_prior_edit',
        { postEditResolved: true, skipViewReconcile: true },
      );
      useContextStore.getState().applyEditToFileView({
        filePath: path,
        sourceRevision: newRev,
        newBody,
        deltas,
        round: 1,
      });
    };

    // Round 4 batch: e1 replace L4, e2 delete L5, e3 insert_after L7.
    //   e1: replace in-place (0 delta)
    const bodyAfterE1 = bodyInit.replace('Line 4: Replace me', 'Line 4: I have been REPLACED!');
    applyEdit('rev-e1', bodyAfterE1, []);
    const v1 = useContextStore.getState().getFileView(path)!;
    expect(v1.fullBody).toBe(bodyAfterE1);

    //   e2: delete L5 (-1 delta at anchor 5; consumes: 1 → row at L5 drops)
    const bodyAfterE2 = bodyAfterE1.split('\n').filter(l => l !== 'Line 5: Delete me').join('\n');
    applyEdit('rev-e2', bodyAfterE2, [{ line: 5, delta: -1, consumes: 1 }]);
    const v2 = useContextStore.getState().getFileView(path)!;
    expect(v2.fullBody).toBe(bodyAfterE2);

    //   e3: insert_after request targets the current L6 ("Line 7: Insert after me",
    //   post-e2 state). Executor emits {line: 6, delta: +1, lineInclusive: false}.
    const bodyAfterE3 = (() => {
      const rows = bodyAfterE2.split('\n');
      const idx = rows.indexOf('Line 7: Insert after me');
      rows.splice(idx + 1, 0, 'Line 7.5: I was INSERTED after line 7');
      return rows.join('\n');
    })();
    applyEdit('rev-e3', bodyAfterE3, [{ line: 6, delta: +1 }]);
    const v3 = useContextStore.getState().getFileView(path)!;
    expect(v3.fullBody).toBe(bodyAfterE3);

    // Round 5 multi-region edit e4: replace current L1, L6, L8 all in-place
    // (0 net delta). By now the post-e3 file has different CONTENT at
    // those lines than the original — replace by index, not by content.
    const bodyAfterE4 = (() => {
      const rows = bodyAfterE3.split('\n');
      rows[0] = 'Line 1: CHANGED A'; // L1
      rows[5] = 'Line 6: CHANGED B'; // L6
      rows[7] = 'Line 8: CHANGED C'; // L8
      return rows.join('\n');
    })();
    applyEdit('rev-e4', bodyAfterE4, []);
    const v4 = useContextStore.getState().getFileView(path)!;
    expect(v4.fullBody).toBe(bodyAfterE4);

    // Skeleton also tracked post-edit state — splice keeps it fresh.
    // Final skeleton rows derive from bodyAfterE4, 1-indexed.
    const finalLines = bodyAfterE4.split('\n');
    expect(v4.skeletonRows.length).toBe(finalLines.length);
    v4.skeletonRows.forEach((row, i) => {
      expect(row).toBe(`${String(i + 1).padStart(4)}|${finalLines[i]}`);
    });
    // Identity stability (path-derived) — shortHash never rotates.
    expect(v4.shortHash).toBe(v0.shortHash);
  });

  it('sparse sig skeleton survives edit — rows stay put, inserts don\'t add rows', () => {
    // Code-file flow: sig shape gives a sparse skeleton (one row per
    // signature + fold marker). An edit inside a body must not corrupt the
    // skeleton — signatures keep their line numbers (shifted), folds
    // rebase, nothing new gets synthesized.
    const store = useContextStore.getState();
    const path = 'src/foo.ts';
    const revInit = 'revsigskel';
    const bodyInit = [
      'import { x } from "./x";', // L1
      '',                          // L2
      'export function alpha(): number {', // L3
      '  return 1;',               // L4
      '}',                         // L5
      '',                          // L6
      'export function beta(): string {', // L7
      '  return "b";',             // L8
      '}',                         // L9
    ].join('\n');
    // Sparse skeleton: imports + 2 signatures with fold markers.
    const sparseSkeleton = [
      '   1|import { x } from "./x";',
      '   3|export function alpha(): number { ... } [3-5]',
      '   7|export function beta(): string { ... } [7-9]',
    ];

    store.addChunk(
      bodyInit, 'raw', path, undefined, undefined, revInit,
      {
        sourceRevision: revInit,
        viewKind: 'latest',
        readSpan: { filePath: path, sourceRevision: revInit, contextType: 'full' },
      },
    );
    useContextStore.getState().setFileViewPinned(path, true);
    useContextStore.setState(state => {
      const next = new Map(state.fileViews);
      const v = next.get(path);
      if (v) next.set(path, { ...v, skeletonRows: sparseSkeleton, totalLines: 9, fullBody: undefined });
      return { fileViews: next };
    });

    // Edit: insert_after L4 with 2 new lines (inside alpha body).
    // Post-edit body has 11 lines. alpha's fold should expand to [3-7];
    // beta's fold shifts to [9-11]. Skeleton row count stays 3 (sparse).
    const bodyAfterEdit = [
      'import { x } from "./x";',
      '',
      'export function alpha(): number {',
      '  return 1;',
      '  const y = 2;',
      '  const z = 3;',
      '}',
      '',
      'export function beta(): string {',
      '  return "b";',
      '}',
    ].join('\n');
    const rev2 = 'revsigskel2';
    useContextStore.getState().addChunk(
      bodyAfterEdit, 'file', path, undefined, undefined, rev2,
      { sourceRevision: rev2, origin: 'edit-refresh', viewKind: 'latest' },
    );
    useContextStore.getState().reconcileSourceRevision(
      path, rev2, 'same_file_prior_edit',
      { postEditResolved: true, skipViewReconcile: true },
    );
    useContextStore.getState().applyEditToFileView({
      filePath: path,
      sourceRevision: rev2,
      newBody: bodyAfterEdit,
      deltas: [{ line: 4, delta: +2 }], // insert_after L4 adds 2 lines
      round: 1,
    });

    const v = useContextStore.getState().getFileView(path)!;
    // Sparse skeleton stays 3 rows (no synthesis of new signature rows).
    expect(v.skeletonRows.length).toBe(3);
    expect(v.skeletonRows[0]).toBe('   1|import { x } from "./x";');
    // alpha's fold rebased: signature line unchanged (L3), fold end shifts +2 → [3-7].
    expect(v.skeletonRows[1]).toContain('   3|');
    expect(v.skeletonRows[1]).toContain('[3-7]');
    // beta's signature shifts L7 → L9; fold [7-9] → [9-11].
    expect(v.skeletonRows[2]).toContain('   9|');
    expect(v.skeletonRows[2]).toContain('[9-11]');
    expect(v.totalLines).toBe(11);
  });

  it('E2E sparse-sig insert via f:h:HASH:N hash-ref shape — deltas backfill from edits_resolved, skeleton rebases', () => {
    // This is the bug observed live: rs shape:sig → ce f:h:HASH:4 le:[{action:"insert_after",content:"..."}]
    // The le entry lacks `line` (it's on the hash-ref). mergedParams.line_edits the executor sees
    // stays without `line`, so buildPerFileDeltaMap used to emit zero deltas → skeleton didn't
    // rebase → alpha's fold stayed stale at [3-5] and beta's signature line stayed at 7.
    //
    // This test drives buildPerFileDeltaMap with the EXACT shape the executor receives after
    // the change.edit handler runs (artifact contains edits_resolved; mergedParams.line_edits
    // still lacks `line`). The fix backfills from artifact.edits_resolved[i].resolved_line.
    const store = useContextStore.getState();
    const path = 'src/sparsesig.ts';
    const revInit = 'revsparse1';
    const bodyInit = [
      'import { x } from "./x";',          // L1
      '',                                   // L2
      'export function alpha(): number {', // L3
      '  return 1;',                        // L4
      '}',                                  // L5
      '',                                   // L6
      'export function beta(): string {',  // L7
      '  return "b";',                      // L8
      '}',                                  // L9
    ].join('\n');
    const sparseSkeleton = [
      '   1|import { x } from "./x";',
      '   3|export function alpha(): number { ... } [3-5]',
      '   7|export function beta(): string { ... } [7-9]',
    ];
    store.addChunk(
      bodyInit, 'raw', path, undefined, undefined, revInit,
      {
        sourceRevision: revInit,
        viewKind: 'latest',
        readSpan: { filePath: path, sourceRevision: revInit, contextType: 'full' },
      },
    );
    useContextStore.getState().setFileViewPinned(path, true);
    useContextStore.setState(state => {
      const next = new Map(state.fileViews);
      const v = next.get(path);
      if (v) next.set(path, { ...v, skeletonRows: sparseSkeleton, totalLines: 9, fullBody: undefined });
      return { fileViews: next };
    });

    // mergedParams as the executor sees them — the `f:h:HASH:4` hash-ref
    // shape means `line_edits[0].line` is ABSENT at this layer. Only after
    // the change.edit handler's `resolveEditOperation` runs does `line: 4`
    // get injected into its own local copy — but that doesn't flow back.
    const mergedParams = {
      file: path,
      line_edits: [
        { action: 'insert_after', content: '  const y = 2;\n  const z = 3;' },
      ],
    };
    // The artifact from the completed backend call — includes edits_resolved
    // with the resolved_line the Rust backend computed.
    const artifact = {
      drafts: [{ file: path, content_hash: 'rev2', h: 'h:rev2' }],
      edits_resolved: [{ resolved_line: 4, action: 'insert_after', lines_affected: 2 }],
    };

    const deltaMap = buildPerFileDeltaMap(mergedParams, artifact);
    const deltas = deltaMap.get(path);
    // WITHOUT the fix: deltas === undefined → skeleton doesn't shift → bug.
    // WITH the fix: deltas === [{line:4, delta:+2, lineInclusive:false}] → skeleton shifts.
    expect(deltas).toBeDefined();
    expect(deltas).toEqual([{ line: 4, delta: 2, lineInclusive: false }]);

    // Now run the full post-edit refresh with those deltas — this is what
    // refreshContextAfterEdit does when it calls applyEditToFileView.
    const bodyAfterEdit = [
      'import { x } from "./x";',
      '',
      'export function alpha(): number {',
      '  return 1;',
      '  const y = 2;',
      '  const z = 3;',
      '}',
      '',
      'export function beta(): string {',
      '  return "b";',
      '}',
    ].join('\n');
    useContextStore.getState().addChunk(
      bodyAfterEdit, 'file', path, undefined, undefined, 'rev2',
      { sourceRevision: 'rev2', origin: 'edit-refresh', viewKind: 'latest' },
    );
    useContextStore.getState().reconcileSourceRevision(
      path, 'rev2', 'same_file_prior_edit',
      { postEditResolved: true, skipViewReconcile: true },
    );
    useContextStore.getState().applyEditToFileView({
      filePath: path,
      sourceRevision: 'rev2',
      newBody: bodyAfterEdit,
      deltas: deltas ?? [],
      round: 1,
    });

    const v = useContextStore.getState().getFileView(path)!;
    expect(v.totalLines).toBe(11);
    expect(v.skeletonRows.length).toBe(3);
    expect(v.skeletonRows[0]).toBe('   1|import { x } from "./x";');
    // alpha fold: [3-5] → [3-7] after the +2 insert inside the body.
    expect(v.skeletonRows[1]).toContain('   3|');
    expect(v.skeletonRows[1]).toContain('[3-7]');
    // beta signature: L7 → L9; fold [7-9] → [9-11].
    expect(v.skeletonRows[2]).toMatch(/^ {3}9\|/);
    expect(v.skeletonRows[2]).toContain('[9-11]');
  });

  it('delete drops the row at the deleted line AND shifts rows below', () => {
    // Pin-down test for the `consumes` field on delete deltas — rows at
    // the deleted line must drop, not stay in place and collide with the
    // shifted-up neighbor. This is the core bug the splice path fixes.
    const store = useContextStore.getState();
    const path = 'delete-one.txt';
    const rev1 = 'revdel1';
    const body1 = ['alpha', 'beta', 'gamma', 'delta'].join('\n');
    store.addChunk(
      body1, 'raw', path, undefined, undefined, rev1,
      {
        sourceRevision: rev1,
        viewKind: 'latest',
        readSpan: { filePath: path, sourceRevision: rev1, contextType: 'full' },
      },
    );
    useContextStore.getState().setFileViewPinned(path, true);
    const denseSkel = body1.split('\n').map((l, i) => `${String(i + 1).padStart(4)}|${l}`);
    useContextStore.setState(state => {
      const next = new Map(state.fileViews);
      const v = next.get(path);
      if (v) next.set(path, { ...v, skeletonRows: denseSkel, totalLines: 4 });
      return { fileViews: next };
    });

    // Delete L2 ("beta"). Result: ['alpha', 'gamma', 'delta']
    const body2 = ['alpha', 'gamma', 'delta'].join('\n');
    const rev2 = 'revdel2';
    useContextStore.getState().addChunk(
      body2, 'file', path, undefined, undefined, rev2,
      { sourceRevision: rev2, origin: 'edit-refresh', viewKind: 'latest' },
    );
    useContextStore.getState().reconcileSourceRevision(
      path, rev2, 'same_file_prior_edit',
      { postEditResolved: true, skipViewReconcile: true },
    );
    useContextStore.getState().applyEditToFileView({
      filePath: path,
      sourceRevision: rev2,
      newBody: body2,
      deltas: [{ line: 2, delta: -1, consumes: 1 }],
      round: 1,
    });

    const v = useContextStore.getState().getFileView(path)!;
    expect(v.totalLines).toBe(3);
    expect(v.skeletonRows).toEqual([
      '   1|alpha',
      '   2|gamma',
      '   3|delta',
    ]);
  });

  it('applyEditToFileView drops trailing empty line — totalLines matches Rust .lines().count()', () => {
    // Regression: files normalized from disk end with `\n`, which makes JS
    // `split('\n')` return a trailing empty string. Counting that empty as
    // a real line made the fence header read +1 vs the backend's
    // `current_content.lines().count()` (visible in change.edit drafts as
    // `lines:N`). Live symptom: `(206 lines)` for a 205-line file right
    // after any own-edit refresh.
    const store = useContextStore.getState();
    const path = 'trailing-nl.txt';
    const rev1 = 'revtn1';
    // Body WITH trailing newline — 3 real content lines, total file "lines" = 3.
    const body1 = 'alpha\nbeta\ngamma\n';
    store.addChunk(
      body1, 'raw', path, undefined, undefined, rev1,
      {
        sourceRevision: rev1,
        viewKind: 'latest',
        readSpan: { filePath: path, sourceRevision: rev1, contextType: 'full' },
      },
    );
    useContextStore.getState().setFileViewPinned(path, true);
    // Seed a dense 3-row skeleton so `wasDense` triggers the full-body
    // regen path (the one used for plain-text files in live runs).
    useContextStore.setState(state => {
      const next = new Map(state.fileViews);
      const v = next.get(path);
      if (v) next.set(path, {
        ...v,
        skeletonRows: ['   1|alpha', '   2|beta', '   3|gamma'],
        totalLines: 3,
      });
      return { fileViews: next };
    });

    // Replace line 2 in-place (same line count). Body stays 3 lines + trailing \n.
    const body2 = 'alpha\nBETA\ngamma\n';
    const rev2 = 'revtn2';
    useContextStore.getState().applyEditToFileView({
      filePath: path,
      sourceRevision: rev2,
      newBody: body2,
      deltas: [],
      round: 1,
    });

    const v = useContextStore.getState().getFileView(path)!;
    // 3 content lines, not 4. This is what Rust reports via
    // `current_content.lines().count()` and what editors display.
    expect(v.totalLines).toBe(3);
    expect(v.skeletonRows).toEqual([
      '   1|alpha',
      '   2|BETA',
      '   3|gamma',
    ]);
  });

  it('applyEditToFileView without trailing newline still counts correctly', () => {
    // Companion to the trailing-newline test: bodies that DON'T end in `\n`
    // stay N lines too. No trailing empty to strip, no change from prior
    // behavior.
    const store = useContextStore.getState();
    const path = 'no-trailing-nl.txt';
    const rev1 = 'revntn1';
    const body1 = 'alpha\nbeta\ngamma'; // no trailing \n
    store.addChunk(
      body1, 'raw', path, undefined, undefined, rev1,
      {
        sourceRevision: rev1,
        viewKind: 'latest',
        readSpan: { filePath: path, sourceRevision: rev1, contextType: 'full' },
      },
    );
    useContextStore.getState().setFileViewPinned(path, true);
    useContextStore.setState(state => {
      const next = new Map(state.fileViews);
      const v = next.get(path);
      if (v) next.set(path, {
        ...v,
        skeletonRows: ['   1|alpha', '   2|beta', '   3|gamma'],
        totalLines: 3,
      });
      return { fileViews: next };
    });

    const body2 = 'alpha\nBETA\ngamma';
    useContextStore.getState().applyEditToFileView({
      filePath: path,
      sourceRevision: 'revntn2',
      newBody: body2,
      deltas: [],
      round: 1,
    });

    const v = useContextStore.getState().getFileView(path)!;
    expect(v.totalLines).toBe(3);
  });

  it('applyFillFromChunk at a new revision keeps the same shortHash', () => {
    // The rebuild-at-new-revision branch used to rotate the shortHash and
    // push the old one onto the chain. With path-derived identity there's
    // nothing to rotate; the same short is the right answer at every
    // revision for this path.
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
    const stableShort = before.shortHash;

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
    expect(after.shortHash).toBe(stableShort);
    // Chain stays empty — nothing to forward through.
    expect(after.previousShortHashes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyRestoreToFileView — deterministic rollback restore
// ---------------------------------------------------------------------------

describe('applyRestoreToFileView — rollback restore', () => {
  beforeEach(resetStore);

  function seedView(opts: {
    filePath: string;
    sourceRevision: string;
    totalLines: number;
    body: string;
    pinned?: boolean;
    withFullBody?: boolean;
    filledRegion?: { start: number; end: number; content: string };
  }) {
    const skeleton = opts.body.split('\n').filter(Boolean).map(
      (line, i) => rowLine(i + 1, line),
    );
    const view = {
      filePath: opts.filePath,
      sourceRevision: opts.sourceRevision,
      observedRevision: opts.sourceRevision,
      totalLines: opts.totalLines,
      skeletonRows: skeleton,
      sigLevel: 'sig' as const,
      filledRegions: opts.filledRegion
        ? [{ ...opts.filledRegion, tokens: 10, origin: 'read' as const }]
        : [],
      fullBody: opts.withFullBody ? opts.body : undefined,
      fullBodyChunkHash: opts.withFullBody ? opts.sourceRevision : undefined,
      fullBodyOrigin: opts.withFullBody ? 'read' as const : undefined,
      hash: `h:${opts.sourceRevision.slice(0, 6)}`,
      shortHash: opts.sourceRevision.slice(0, 6),
      lastAccessed: Date.now(),
      pinned: opts.pinned ?? false,
      freshness: 'fresh' as const,
    };
    const fvMap = new Map(useContextStore.getState().fileViews);
    fvMap.set(opts.filePath.replace(/\\/g, '/').toLowerCase(), view);
    useContextStore.setState({ fileViews: fvMap });
    return view;
  }

  it('refills filledRegions from restored body at original coordinates', () => {
    seedView({
      filePath: 'src/foo.ts',
      sourceRevision: 'editedHash123456',
      totalLines: 3,
      body: 'edited line 1\nline 2\nline 3',
      filledRegion: { start: 1, end: 2, content: rowLine(1, 'edited line 1') + '\n' + rowLine(2, 'line 2') },
    });

    const restoredBody = 'original line 1\nline 2\nline 3';
    const didUpdate = useContextStore.getState().applyRestoreToFileView({
      filePath: 'src/foo.ts',
      sourceRevision: 'restoredHash1234',
      newBody: restoredBody,
      round: 0,
    });

    expect(didUpdate).toBe(true);
    const view = useContextStore.getState().fileViews.get('src/foo.ts');
    expect(view).toBeDefined();
    expect(view!.sourceRevision).toBe('restoredHash1234');
    expect(view!.filledRegions).toHaveLength(1);
    expect(view!.filledRegions[0].content).toContain('original line 1');
    expect(view!.filledRegions[0].start).toBe(1);
    expect(view!.filledRegions[0].end).toBe(2);
  });

  it('repopulates fullBody when view previously had it', () => {
    seedView({
      filePath: 'src/bar.ts',
      sourceRevision: 'editedHash654321',
      totalLines: 2,
      body: 'edited a\nedited b',
      withFullBody: true,
    });

    const restoredBody = 'original a\noriginal b';
    useContextStore.getState().applyRestoreToFileView({
      filePath: 'src/bar.ts',
      sourceRevision: 'restoredHash6543',
      newBody: restoredBody,
      round: 0,
    });

    const view = useContextStore.getState().fileViews.get('src/bar.ts');
    expect(view!.fullBody).toBe(restoredBody);
    expect(view!.fullBodyChunkHash).toBe('restoredHash6543');
  });

  it('does not set fullBody when view did not have it', () => {
    seedView({
      filePath: 'src/nofull.ts',
      sourceRevision: 'editedHash999999',
      totalLines: 2,
      body: 'line a\nline b',
      withFullBody: false,
    });

    useContextStore.getState().applyRestoreToFileView({
      filePath: 'src/nofull.ts',
      sourceRevision: 'restoredHash9999',
      newBody: 'restored a\nrestored b',
      round: 0,
    });

    const view = useContextStore.getState().fileViews.get('src/nofull.ts');
    expect(view!.fullBody).toBeUndefined();
  });

  it('appends pre-rollback shortHash to previousShortHashes', () => {
    const seeded = seedView({
      filePath: 'src/chain.ts',
      sourceRevision: 'editedHashABCDEF',
      totalLines: 1,
      body: 'x',
    });
    const oldShort = seeded.shortHash;

    useContextStore.getState().applyRestoreToFileView({
      filePath: 'src/chain.ts',
      sourceRevision: 'restoredHashXYZW',
      newBody: 'y',
      round: 0,
    });

    const view = useContextStore.getState().fileViews.get('src/chain.ts');
    expect(view!.previousShortHashes).toContain(oldShort);
  });

  it('emits freshness: fresh and freshnessCause: rollback', () => {
    seedView({
      filePath: 'src/fresh.ts',
      sourceRevision: 'editedHash000000',
      totalLines: 1,
      body: 'x',
    });

    useContextStore.getState().applyRestoreToFileView({
      filePath: 'src/fresh.ts',
      sourceRevision: 'restoredHash0000',
      newBody: 'y',
      round: 0,
    });

    const view = useContextStore.getState().fileViews.get('src/fresh.ts');
    expect(view!.freshness).toBe('fresh');
    expect(view!.freshnessCause).toBe('rollback');
    expect(view!.pendingRefetches).toBeUndefined();
    expect(view!.removedMarkers).toBeUndefined();
  });

  it('returns false when no FileView exists for the path', () => {
    const didUpdate = useContextStore.getState().applyRestoreToFileView({
      filePath: 'src/nonexistent.ts',
      sourceRevision: 'whatever',
      newBody: 'content',
      round: 0,
    });
    expect(didUpdate).toBe(false);
  });
});
