/**
 * Context store tests — exercises queryBySetSelector for all selector kinds,
 * recency stack management, and createSetRefLookup wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setRoundRefreshRevisionResolver, setBulkRevisionResolver, setWorkspacesAccessor, useContextStore } from './contextStore';
import { STAGED_ANCHOR_BUDGET_TOKENS, STAGED_TOTAL_HARD_CAP_TOKENS, MAX_PERSISTENT_STAGE_ENTRIES } from '../services/promptMemory';

function resetStore() {
  useContextStore.getState().resetSession();
  useContextStore.setState({ hashStack: [], editHashStack: [] });
  setWorkspacesAccessor(() => []);
  setRoundRefreshRevisionResolver(null);
  setBulkRevisionResolver(null);
}

function addTestChunk(
  content: string,
  type: string,
  source?: string,
  opts?: Parameters<ReturnType<typeof useContextStore.getState>['addChunk']>[6],
) {
  const store = useContextStore.getState();
  return store.addChunk(content, type as import('../utils/contextHash').ChunkType, source, undefined, undefined, undefined, opts);
}

describe('queryBySetSelector', () => {
  beforeEach(() => resetStore());

  it('kind=all returns all active chunks', () => {
    addTestChunk('fn foo() {}', 'file', 'src/foo.ts');
    addTestChunk('fn bar() {}', 'file', 'src/bar.ts');
    addTestChunk('tool output', 'result');

    const result = useContextStore.getState().queryBySetSelector({ kind: 'all' });
    expect(result.hashes).toHaveLength(3);
    expect(result.entries).toHaveLength(3);
  });

  it('kind=edited returns only edit-origin chunks', () => {
    addTestChunk('fn foo() {}', 'file', 'src/foo.ts');
    addTestChunk('tool output 1', 'result', undefined, { origin: 'edit' });
    addTestChunk('tool output 2', 'result', undefined, { origin: 'edit' });

    const result = useContextStore.getState().queryBySetSelector({ kind: 'edited' });
    expect(result.hashes).toHaveLength(2);
    result.entries.forEach(e => {
      expect(e.content).toMatch(/^tool output/);
    });
  });

  it('kind=pinned returns only pinned chunks', () => {
    const h1 = addTestChunk('fn foo() {}', 'file', 'src/foo.ts');
    addTestChunk('fn bar() {}', 'file', 'src/bar.ts');

    useContextStore.getState().pinChunks([h1]);

    const result = useContextStore.getState().queryBySetSelector({ kind: 'pinned' });
    expect(result.hashes).toHaveLength(1);
    expect(result.entries[0].source).toBe('src/foo.ts');
  });

  it('pinChunks accepts shaped ref (h:XXXX:15-50) and pins base chunk', () => {
    const shortHash = addTestChunk('fn foo() { return 1; }\nfn bar() { return 2; }', 'file', 'src/foo.ts');
    addTestChunk('other', 'file', 'src/other.ts');

    const { count } = useContextStore.getState().pinChunks([`h:${shortHash}:15-50`]);

    expect(count).toBe(1);
    const result = useContextStore.getState().queryBySetSelector({ kind: 'pinned' });
    expect(result.hashes).toHaveLength(1);
    expect(result.entries[0].source).toBe('src/foo.ts');
  });

  it('kind=type filters by chunk type', () => {
    addTestChunk('fn foo() {}', 'file', 'src/foo.ts');
    addTestChunk('tool output', 'result');
    addTestChunk('search hit', 'search');

    const fileResult = useContextStore.getState().queryBySetSelector({ kind: 'type', chunkType: 'file' });
    expect(fileResult.hashes).toHaveLength(1);

    const searchResult = useContextStore.getState().queryBySetSelector({ kind: 'type', chunkType: 'search' });
    expect(searchResult.hashes).toHaveLength(1);
  });

  it('kind=file with glob pattern matches source paths', () => {
    addTestChunk('fn foo() {}', 'file', 'src/components/Button.tsx');
    addTestChunk('fn bar() {}', 'file', 'src/components/Modal.tsx');
    addTestChunk('fn baz() {}', 'file', 'src/utils/hash.ts');

    const result = useContextStore.getState().queryBySetSelector({
      kind: 'file',
      pattern: 'src/components/*',
    });
    expect(result.hashes).toHaveLength(2);
  });

  it('kind=file with exact name matches basename', () => {
    addTestChunk('fn foo() {}', 'file', 'src/deep/nested/Button.tsx');
    addTestChunk('fn bar() {}', 'file', 'src/other/Modal.tsx');

    const result = useContextStore.getState().queryBySetSelector({
      kind: 'file',
      pattern: 'Button.tsx',
    });
    expect(result.hashes).toHaveLength(1);
    expect(result.entries[0].source).toBe('src/deep/nested/Button.tsx');
  });

  it('kind=workspace matches directory boundaries instead of substrings', () => {
    setWorkspacesAccessor(() => [{ name: 'app', path: 'packages/app' }]);
    addTestChunk('real workspace file', 'file', 'packages/app/src/main.ts');
    addTestChunk('substring collision', 'file', 'packages/application/src/main.ts');

    const result = useContextStore.getState().queryBySetSelector({ kind: 'workspace', name: 'app' }, 'active');

    expect(result.hashes).toHaveLength(1);
    expect(result.entries[0].source).toBe('packages/app/src/main.ts');
  });

  it('kind=latest returns N most recent by access time', () => {
    addTestChunk('first', 'file', 'src/a.ts');
    addTestChunk('second', 'file', 'src/b.ts');
    addTestChunk('third', 'file', 'src/c.ts');

    const result = useContextStore.getState().queryBySetSelector({
      kind: 'latest',
      count: 2,
    });
    expect(result.hashes).toHaveLength(2);
  });

  it('kind=subtask filters by subtaskId', () => {
    const h1 = addTestChunk('task-a content', 'file', 'src/a.ts');
    addTestChunk('task-b content', 'file', 'src/b.ts');

    const chunks = useContextStore.getState().chunks;
    const chunk = Array.from(chunks.values()).find(c => c.shortHash === h1);
    if (chunk) chunk.subtaskId = 'task-a';

    const result = useContextStore.getState().queryBySetSelector({
      kind: 'subtask',
      id: 'task-a',
    });
    expect(result.hashes).toHaveLength(1);
    expect(result.entries[0].source).toBe('src/a.ts');
  });

  it('kind=search returns empty (pre-resolved externally)', () => {
    addTestChunk('some content', 'file', 'src/a.ts');

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = useContextStore.getState().queryBySetSelector({
      kind: 'search',
      query: 'test',
    });
    expect(result.hashes).toHaveLength(0);
    consoleSpy.mockRestore();
  });

  it('returns entries with content and source', () => {
    addTestChunk('function authenticate() {}', 'file', 'src/auth.ts');

    const result = useContextStore.getState().queryBySetSelector({ kind: 'all' });
    expect(result.entries[0].content).toBe('function authenticate() {}');
    expect(result.entries[0].source).toBe('src/auth.ts');
  });
});

describe('per-file hash forwarding', () => {
  beforeEach(() => resetStore());

  it('compresses previous chunk when re-reading same file', () => {
    const h1 = addTestChunk('original content', 'raw', 'src/foo.ts');
    const h2 = addTestChunk('updated content', 'raw', 'src/foo.ts');

    const chunks = useContextStore.getState().chunks;
    const first = Array.from(chunks.values()).find(c => c.shortHash === h1);
    const second = Array.from(chunks.values()).find(c => c.shortHash === h2);

    expect(first?.compacted).toBe(true);
    expect(first?.content).not.toBe('original content');
    expect(second?.compacted).toBeFalsy();
    expect(second?.content).toBe('updated content');
  });

  it('does not compress batch chunk when re-reading single file', () => {
    addTestChunk('combined a+b', 'smart', 'src/a.ts, src/b.ts');
    const h2 = addTestChunk('just a', 'smart', 'src/a.ts');

    const chunks = useContextStore.getState().chunks;
    const batch = Array.from(chunks.values()).find(c => c.source?.includes(','));
    const single = Array.from(chunks.values()).find(c => c.shortHash === h2);

    expect(batch?.compacted).toBeFalsy();
    expect(single?.compacted).toBeFalsy();
    expect(chunks.size).toBe(2);
  });
});

describe('createSetRefLookup', () => {
  beforeEach(() => resetStore());

  it('returns a function that delegates to queryBySetSelector', () => {
    addTestChunk('fn foo() {}', 'file', 'src/foo.ts');
    addTestChunk('tool output', 'result', undefined, { origin: 'edit' });

    const lookup = useContextStore.getState().createSetRefLookup();
    const allResult = lookup({ kind: 'all' });
    expect(allResult.hashes).toHaveLength(2);

    const editedResult = lookup({ kind: 'edited' });
    expect(editedResult.hashes).toHaveLength(1);
  });
});

describe('same-source reconciliation', () => {
  beforeEach(() => resetStore());

  it('updates latest entries, invalidates derived entries, and preserves snapshots', () => {
    const store = useContextStore.getState();
    // Use a separate source for the latest chunk so addChunk doesn't auto-compact it
    // when the derived chunk is added for the same file.
    const latestHash = store.addChunk(
      'export const current = 1;',
      'smart',
      'src/reconcile.ts',
      undefined,
      undefined,
      'rev-old',
      { sourceRevision: 'rev-old', viewKind: 'latest' },
    );
    const derivedHash = store.addChunk(
      'sig current(): number',
      'smart',
      'src/reconcile-derived.ts',
      undefined,
      undefined,
      'derived-old',
      { sourceRevision: 'derived-old', viewKind: 'derived' },
    );
    const snapshotHash = store.addChunk(
      'previous snapshot',
      'smart',
      'src/reconcile-snap.ts',
      undefined,
      undefined,
      'snap-old',
      { sourceRevision: 'snap-old', viewKind: 'snapshot' },
    );
    store.stageSnippet('stage:derived', 'shaped', 'src/reconcile-derived.ts', 'sig', 'derived-old', 'sig', 'derived');
    useContextStore.setState((state) => ({
      chunks: new Map([...state.chunks].map(([key, chunk]) => [
        key,
        chunk.shortHash === latestHash ? { ...chunk, suspectSince: Date.now() } : chunk,
      ])),
    }));

    // Reconcile the latest chunk's source
    const statsLatest = store.reconcileSourceRevision('src/reconcile.ts', 'rev-new');
    expect(statsLatest.updated).toBeGreaterThanOrEqual(1);

    // Reconcile the derived chunk's source
    const statsDerived = store.reconcileSourceRevision('src/reconcile-derived.ts', 'rev-new');
    expect(statsDerived.invalidated).toBeGreaterThanOrEqual(1);

    // Reconcile the snapshot chunk's source
    const statsSnap = store.reconcileSourceRevision('src/reconcile-snap.ts', 'rev-new');
    expect(statsSnap.preserved).toBe(1);

    const chunks = Array.from(useContextStore.getState().chunks.values());
    const latest = chunks.find((chunk) => chunk.shortHash === latestHash);
    const derived = chunks.find((chunk) => chunk.shortHash === derivedHash);
    const snapshot = chunks.find((chunk) => chunk.shortHash === snapshotHash);

    expect(latest?.sourceRevision).toBe('rev-new');
    expect(latest?.suspectSince).toBeUndefined();
    expect(derived).toBeUndefined();
    expect(snapshot?.sourceRevision).toBe('snap-old');
    expect(useContextStore.getState().stagedSnippets.has('stage:derived')).toBe(false);
    const latestEvent = useContextStore.getState().memoryEvents[useContextStore.getState().memoryEvents.length - 1];
    expect(latestEvent?.action).toBe('reconcile');
  });

  it('clears external-change freshness hints after a successful reread', () => {
    const store = useContextStore.getState();
    const latestHash = store.addChunk(
      'export const latest = 1;',
      'smart',
      'src/reconcile.ts',
      undefined,
      undefined,
      'rev-old',
      { sourceRevision: 'rev-old', viewKind: 'latest' },
    );
    useContextStore.setState((state) => ({
      chunks: new Map([...state.chunks].map(([key, chunk]) => [
        key,
        chunk.shortHash === latestHash
          ? { ...chunk, suspectSince: Date.now(), freshness: 'suspect', freshnessCause: 'external_file_change' as const }
          : chunk,
      ])),
    }));

    const stats = store.reconcileSourceRevision('src/reconcile.ts', 'rev-new', 'external_file_change');
    const latest = Array.from(useContextStore.getState().chunks.values())
      .find((chunk) => chunk.shortHash === latestHash);

    expect(stats.updated).toBe(1);
    expect(latest?.suspectSince).toBeUndefined();
    expect(latest?.freshness).toBeUndefined();
    expect(latest?.freshnessCause).toBeUndefined();
  });
});

describe('refreshRoundEnd', () => {
  beforeEach(() => resetStore());

  it('unchanged file: refresh with same revision yields no invalidation, stats reflect preserved', async () => {
    const store = useContextStore.getState();
    store.addChunk('export const x = 1;', 'smart', 'src/unchanged.ts', undefined, undefined, 'rev-1', { sourceRevision: 'rev-1', viewKind: 'latest' });
    const stats = await store.refreshRoundEnd({
      paths: ['src/unchanged.ts'],
      getRevisionForPath: async () => 'rev-1',
    });
    expect(stats.pathsProcessed).toBe(1);
    expect(stats.invalidated).toBe(0);
    expect(stats.updated).toBeGreaterThanOrEqual(1);
    const chunk = Array.from(useContextStore.getState().chunks.values()).find(c => c.source === 'src/unchanged.ts');
    expect(chunk?.sourceRevision).toBe('rev-1');
  });

  it('external revision change: invalidates derived, updates latest, preserves snapshot', async () => {
    const store = useContextStore.getState();
    // Use separate sources to prevent addChunk auto-compaction (same-source forwarding)
    const latestHash = store.addChunk('export const x = 2;', 'smart', 'src/refresh.ts', undefined, undefined, 'rev-old', { sourceRevision: 'rev-old', viewKind: 'latest' });
    store.addChunk('sig x(): number', 'smart', 'src/refresh-derived.ts', undefined, undefined, 'derived-old', { sourceRevision: 'derived-old', viewKind: 'derived' });
    store.addChunk('snapshot', 'smart', 'src/refresh-snap.ts', undefined, undefined, 'snap-old', { sourceRevision: 'snap-old', viewKind: 'snapshot' });
    const stats = await store.refreshRoundEnd({
      paths: ['src/refresh.ts', 'src/refresh-derived.ts', 'src/refresh-snap.ts'],
      getRevisionForPath: async () => 'rev-new',
    });
    expect(stats.invalidated).toBeGreaterThanOrEqual(1);
    expect(stats.updated).toBeGreaterThanOrEqual(1);
    expect(stats.preserved).toBe(1);
    const latest = Array.from(useContextStore.getState().chunks.values()).find(c => c.shortHash === latestHash);
    expect(latest?.sourceRevision).toBe('rev-new');
    const derived = Array.from(useContextStore.getState().chunks.values()).find(c => c.viewKind === 'derived');
    expect(derived).toBeUndefined();
  });

  it('derived invalidation: derived chunks with stale sourceRevision are removed', async () => {
    const store = useContextStore.getState();
    store.addChunk('shaped', 'result', 'src/derived.ts', undefined, undefined, 'derived-rev', { sourceRevision: 'derived-rev', viewKind: 'derived' });
    const stats = await store.refreshRoundEnd({
      paths: ['src/derived.ts'],
      getRevisionForPath: async () => 'fresh-rev',
    });
    expect(stats.invalidated).toBe(1);
    const derived = Array.from(useContextStore.getState().chunks.values()).find(c => c.viewKind === 'derived');
    expect(derived).toBeUndefined();
  });

  it('pinned snapshot preservation: snapshot viewKind untouched', async () => {
    const store = useContextStore.getState();
    const snapHash = store.addChunk('old snapshot', 'smart', 'src/snap.ts', undefined, undefined, 'snap-rev', { sourceRevision: 'snap-rev', viewKind: 'snapshot' });
    const stats = await store.refreshRoundEnd({
      paths: ['src/snap.ts'],
      getRevisionForPath: async () => 'new-rev',
    });
    expect(stats.preserved).toBe(1);
    const snapshot = Array.from(useContextStore.getState().chunks.values()).find(c => c.shortHash === snapHash);
    expect(snapshot?.sourceRevision).toBe('snap-rev');
    expect(snapshot?.viewKind).toBe('snapshot');
  });

  it('staged and latest chunks both updated per reconcile rules', async () => {
    const store = useContextStore.getState();
    store.addChunk('chunk', 'smart', 'src/staged.ts', undefined, undefined, 'rev-old', { sourceRevision: 'rev-old', viewKind: 'latest' });
    store.stageSnippet('stage:1', 'snippet', 'src/staged.ts', undefined, 'rev-old', undefined, 'latest');
    const stats = await store.refreshRoundEnd({
      paths: ['src/staged.ts'],
      getRevisionForPath: async () => 'rev-fresh',
    });
    expect(stats.updated).toBeGreaterThanOrEqual(2);
    const chunk = Array.from(useContextStore.getState().chunks.values()).find(c => c.source === 'src/staged.ts');
    const staged = Array.from(useContextStore.getState().stagedSnippets.values()).find(s => s.source === 'src/staged.ts');
    expect(chunk?.sourceRevision).toBe('rev-fresh');
    expect(staged?.sourceRevision).toBe('rev-fresh');
  });

  it('returns zero stats when no getRevisionForPath and no stored resolver', async () => {
    setRoundRefreshRevisionResolver(null);
    const store = useContextStore.getState();
    store.addChunk('x', 'smart', 'src/foo.ts', undefined, undefined, 'rev', { sourceRevision: 'rev', viewKind: 'latest' });
    const stats = await store.refreshRoundEnd();
    expect(stats).toEqual({ total: 0, updated: 0, invalidated: 0, preserved: 0, pathsProcessed: 0 });
  });

  it('bulk resolver: matching revisions preserve engrams without suspect', async () => {
    const store = useContextStore.getState();
    const hash = store.addChunk('export const a = 1;', 'smart', 'src/a.ts', undefined, undefined, 'rev-1', { sourceRevision: 'rev-1', viewKind: 'latest' });
    store.stageSnippet('stage:a', 'staged a', 'src/a.ts', undefined, 'rev-1', undefined, 'latest');

    const stats = await store.refreshRoundEnd({
      bulkGetRevisions: async (paths) => new Map(paths.map(p => [p, 'rev-1'])),
    });

    expect(stats.pathsProcessed).toBe(1);
    expect(stats.invalidated).toBe(0);
    expect(stats.updated).toBeGreaterThanOrEqual(1);

    const chunk = Array.from(useContextStore.getState().chunks.values()).find(c => c.shortHash === hash);
    expect(chunk?.suspectSince).toBeUndefined();
    expect(chunk?.sourceRevision).toBe('rev-1');
    const staged = Array.from(useContextStore.getState().stagedSnippets.values()).find(s => s.source === 'src/a.ts');
    expect(staged?.suspectSince).toBeUndefined();
  });

  it('bulk resolver: mismatched revisions reconcile correctly', async () => {
    const store = useContextStore.getState();
    const latestHash = store.addChunk('export const b = 1;', 'smart', 'src/b.ts', undefined, undefined, 'rev-old', { sourceRevision: 'rev-old', viewKind: 'latest' });
    store.addChunk('sig b(): number', 'smart', 'src/b-derived.ts', undefined, undefined, 'derived-old', { sourceRevision: 'derived-old', viewKind: 'derived' });

    const stats = await store.refreshRoundEnd({
      paths: ['src/b.ts', 'src/b-derived.ts'],
      bulkGetRevisions: async (paths) => new Map(paths.map(p => [p, 'rev-new'])),
    });

    expect(stats.updated).toBeGreaterThanOrEqual(1);
    expect(stats.invalidated).toBeGreaterThanOrEqual(1);

    const latest = Array.from(useContextStore.getState().chunks.values()).find(c => c.shortHash === latestHash);
    expect(latest?.sourceRevision).toBe('rev-new');
    const derived = Array.from(useContextStore.getState().chunks.values()).find(c => c.viewKind === 'derived');
    expect(derived).toBeUndefined();
  });

  it('bulk resolver: unresolvable file-like paths are marked suspect; directory-like paths are skipped', async () => {
    const store = useContextStore.getState();
    const fileHash = store.addChunk('export const c = 1;', 'smart', 'src/c.ts', undefined, undefined, 'rev-1', { sourceRevision: 'rev-1', viewKind: 'latest' });
    store.addChunk('tree listing', 'smart', 'src/', undefined, undefined, 'rev-dir', { sourceRevision: 'rev-dir', viewKind: 'latest' });

    const stats = await store.refreshRoundEnd({
      bulkGetRevisions: async (paths) => new Map(paths.map(p => [p, null])),
    });

    expect(stats.updated).toBe(0);
    expect(stats.invalidated).toBe(0);

    const fileChunk = Array.from(useContextStore.getState().chunks.values()).find(c => c.shortHash === fileHash);
    expect(fileChunk?.suspectSince).toBeDefined();
    expect(fileChunk?.freshness).toBe('suspect');

    const events = useContextStore.getState().memoryEvents;
    const unresolved = events.filter(e => e.reason === 'refresh_unresolved_paths');
    expect(unresolved.length).toBeGreaterThanOrEqual(1);
    const refs = unresolved[0]?.refs ?? [];
    expect(refs.some(r => r.startsWith('file_marked:'))).toBe(true);
  });

  it('bulk resolver takes precedence over per-path resolver', async () => {
    const store = useContextStore.getState();
    store.addChunk('export const d = 1;', 'smart', 'src/d.ts', undefined, undefined, 'rev-old', { sourceRevision: 'rev-old', viewKind: 'latest' });

    const perPathSpy = vi.fn(async () => 'should-not-be-used');
    const bulkSpy = vi.fn(async (paths: string[]) => new Map(paths.map(p => [p, 'rev-bulk'] as const)));

    await store.refreshRoundEnd({
      getRevisionForPath: perPathSpy,
      bulkGetRevisions: bulkSpy,
    });

    expect(bulkSpy).toHaveBeenCalledOnce();
    expect(perPathSpy).not.toHaveBeenCalled();
  });

  it('falls back to stored bulk resolver when no options provided', async () => {
    const store = useContextStore.getState();
    store.addChunk('export const e = 1;', 'smart', 'src/e.ts', undefined, undefined, 'rev-old', { sourceRevision: 'rev-old', viewKind: 'latest' });

    setBulkRevisionResolver(async (paths) => new Map(paths.map(p => [p, 'rev-bulk'])));

    const stats = await store.refreshRoundEnd();
    expect(stats.updated).toBeGreaterThanOrEqual(1);

    const chunk = Array.from(useContextStore.getState().chunks.values()).find(c => c.source === 'src/e.ts');
    expect(chunk?.sourceRevision).toBe('rev-bulk');
    expect(chunk?.suspectSince).toBeUndefined();
  });
});

describe('exact-file suspect marking', () => {
  beforeEach(() => resetStore());

  it('marks only exact latest entries and skips snapshots, derived, archived, and sibling paths', () => {
    const store = useContextStore.getState();
    const latestHash = store.addChunk(
      'export const latest = 1;',
      'smart',
      'src/exact.ts',
      undefined,
      undefined,
      'rev-1',
      { sourceRevision: 'rev-1', viewKind: 'latest' },
    );
    const siblingHash = store.addChunk(
      'export const sibling = 1;',
      'smart',
      'src/exact.tsx',
      undefined,
      undefined,
      'rev-sibling',
      { sourceRevision: 'rev-sibling', viewKind: 'latest' },
    );
    const snapshotHash = store.addChunk(
      'snapshot',
      'smart',
      'src/exact.ts',
      undefined,
      undefined,
      'snap-1',
      { sourceRevision: 'snap-1', viewKind: 'snapshot' },
    );
    const derivedHash = store.addChunk(
      'sig exact(): number',
      'result',
      'src/exact.ts',
      undefined,
      undefined,
      'derived-1',
      { sourceRevision: 'derived-1', viewKind: 'derived' },
    );
    store.stageSnippet('stage:latest', 'latest stage', 'src/exact.ts');
    store.stageSnippet('stage:derived', 'derived stage', 'src/exact.ts', '1-2', undefined, 'sig', 'derived');

    useContextStore.setState((state) => {
      const archivedEntry = Array.from(state.chunks.entries()).find(([, chunk]) => chunk.shortHash === siblingHash);
      if (!archivedEntry) return {};
      const [archivedKey, archivedChunk] = archivedEntry;
      const chunks = new Map(state.chunks);
      const archivedChunks = new Map(state.archivedChunks);
      chunks.delete(archivedKey);
      archivedChunks.set(archivedKey, archivedChunk);
      return { chunks, archivedChunks };
    });

    const marked = store.markEngramsSuspect(['src/exact.ts']);

    const chunks = Array.from(useContextStore.getState().chunks.values());
    const latest = chunks.find((chunk) => chunk.shortHash === latestHash);
    const snapshot = chunks.find((chunk) => chunk.shortHash === snapshotHash);
    const derived = chunks.find((chunk) => chunk.shortHash === derivedHash);
    const stagedLatest = useContextStore.getState().stagedSnippets.get('stage:latest');
    const stagedDerived = useContextStore.getState().stagedSnippets.get('stage:derived');
    const archivedSibling = Array.from(useContextStore.getState().archivedChunks.values())
      .find((chunk) => chunk.shortHash === siblingHash);

    expect(marked).toBe(2);
    expect(latest?.suspectSince).toBeTypeOf('number');
    expect(snapshot?.suspectSince).toBeUndefined();
    expect(derived?.suspectSince).toBeUndefined();
    expect(stagedLatest?.suspectSince).toBeTypeOf('number');
    expect(stagedDerived?.suspectSince).toBeUndefined();
    expect(archivedSibling?.suspectSince).toBeUndefined();
  });

  it('marks archived latest entries when the exact source file changes', () => {
    const store = useContextStore.getState();
    const archivedHash = store.addChunk(
      'export const archived = 1;',
      'smart',
      'src/exact.ts',
      undefined,
      undefined,
      'rev-archived',
      { sourceRevision: 'rev-archived', viewKind: 'latest' },
    );

    useContextStore.setState((state) => {
      const archivedEntry = Array.from(state.chunks.entries()).find(([, chunk]) => chunk.shortHash === archivedHash);
      if (!archivedEntry) return {};
      const [archivedKey, archivedChunk] = archivedEntry;
      const chunks = new Map(state.chunks);
      const archivedChunks = new Map(state.archivedChunks);
      chunks.delete(archivedKey);
      archivedChunks.set(archivedKey, archivedChunk);
      return { chunks, archivedChunks };
    });

    const marked = store.markEngramsSuspect(['src/exact.ts'], 'watcher_event');
    const archived = Array.from(useContextStore.getState().archivedChunks.values())
      .find((chunk) => chunk.shortHash === archivedHash);

    expect(marked).toBe(1);
    expect(archived?.suspectSince).toBeTypeOf('number');
    expect(archived?.freshnessCause).toBe('watcher_event');
  });
});

describe('findReusableRead and getChunkContent', () => {
  beforeEach(() => resetStore());

  it('findReusableRead returns null for compacted chunks with matching revision', () => {
    const store = useContextStore.getState();
    const readSpan = { filePath: 'src/foo.ts', sourceRevision: 'rev1' };
    store.addChunk('original content', 'file', 'src/foo.ts', undefined, undefined, undefined, { readSpan });
    // Re-add same file — hash forwarding compacts the first chunk
    store.addChunk('updated content', 'file', 'src/foo.ts');

    const result = store.findReusableRead(readSpan);
    expect(result).toBeNull();
  });

  it('getChunkContent returns archived content for compacted chunks', () => {
    const store = useContextStore.getState();
    const fullContent = 'function foo() { return 42; }';
    const shortHash = store.addChunk(fullContent, 'file', 'src/bar.ts');
    store.compactChunks([`h:${shortHash}`]);

    const content = store.getChunkContent(`h:${shortHash}`);
    expect(content).toBe(fullContent);
  });

  it('splitEngram uses archived full content when active chunk is compacted', () => {
    const store = useContextStore.getState();
    const multiline = 'line one\nline two\nline three';
    const shortHash = store.addChunk(multiline, 'file', 'src/split-compact.ts');
    const { compacted } = store.compactChunks([`h:${shortHash}`]);
    expect(compacted).toBe(1);

    const result = store.splitEngram(`h:${shortHash}`, 2);
    expect(result.ok).toBe(true);
    expect(result.hashes).toHaveLength(2);
  });
});

describe('staged lifecycle policy', () => {
  beforeEach(() => resetStore());

  it('demotes oversized entry snippets out of persistent-anchor class', () => {
    const store = useContextStore.getState();
    const result = store.stageSnippet('entry:big.ts', 'x'.repeat(1500), 'src/big.ts', 'sig', undefined, 'sig', 'derived');

    expect(result.ok).toBe(true);
    const snippet = useContextStore.getState().stagedSnippets.get('entry:big.ts');
    expect(snippet?.admissionClass).toBe('transientAnchor');
    expect(snippet?.persistencePolicy).toBe('persistAsDemoted');
    expect(snippet?.demotedFrom).toBe('persistentAnchor');
  });

  it('keeps persistent staged anchors bounded by count and budget', () => {
    const store = useContextStore.getState();
    for (let i = 0; i < 20; i++) {
      store.stageSnippet(`entry:file-${i}.ts`, `anchor-${i}`.repeat(20), `src/file-${i}.ts`, 'sig', undefined, 'sig', 'derived');
    }

    const entries = Array.from(useContextStore.getState().stagedSnippets.entries())
      .filter(([key, snippet]) => key.startsWith('entry:') && snippet.admissionClass === 'persistentAnchor');
    const tokens = entries.reduce((sum, [, snippet]) => sum + snippet.tokens, 0);

    expect(entries.length).toBeLessThanOrEqual(MAX_PERSISTENT_STAGE_ENTRIES);
    expect(tokens).toBeLessThanOrEqual(STAGED_ANCHOR_BUDGET_TOKENS);
  });

  it('evicts staged entries when total tokens exceed STAGED_TOTAL_HARD_CAP_TOKENS', () => {
    const store = useContextStore.getState();
    const chunk = 'x'.repeat(3000);
    for (let i = 0; i < 100; i++) {
      store.stageSnippet(`bulk:${i}`, chunk, `src/bulk-${i}.ts`, undefined, undefined, undefined, 'derived');
    }
    let total = 0;
    useContextStore.getState().stagedSnippets.forEach(s => { total += s.tokens; });
    expect(total).toBeLessThanOrEqual(STAGED_TOTAL_HARD_CAP_TOKENS);
  });
});

describe('recency stack management', () => {
  beforeEach(() => resetStore());

  it('pushHash adds to front of stack', () => {
    const store = useContextStore.getState();
    store.pushHash('aabb1122');
    store.pushHash('ccdd3344');

    expect(store.resolveRecencyRef(0)).toBe('ccdd3344');
    expect(store.resolveRecencyRef(1)).toBe('aabb1122');
  });

  it('pushHash deduplicates (moves to front)', () => {
    const store = useContextStore.getState();
    store.pushHash('aabb1122');
    store.pushHash('ccdd3344');
    store.pushHash('aabb1122');

    expect(useContextStore.getState().resolveRecencyRef(0)).toBe('aabb1122');
    expect(useContextStore.getState().resolveRecencyRef(1)).toBe('ccdd3344');
  });

  it('resolveRecencyRef returns null for out-of-bounds offset', () => {
    useContextStore.getState().pushHash('aabb1122');

    const state = useContextStore.getState();
    expect(state.resolveRecencyRef(0)).toBe('aabb1122');
    expect(state.resolveRecencyRef(1)).toBeNull();
    expect(state.resolveRecencyRef(100)).toBeNull();
  });

  it('stack is bounded to 50 entries', () => {
    const store = useContextStore.getState();
    for (let i = 0; i < 60; i++) {
      store.pushHash(`hash${i.toString().padStart(4, '0')}pad`);
    }
    const state = useContextStore.getState();
    expect(state.hashStack.length).toBeLessThanOrEqual(50);
    expect(state.resolveRecencyRef(0)).toBe('hash0059pad');
  });

  it('pushEditHash manages edit stack independently', () => {
    const store = useContextStore.getState();
    store.pushHash('recency1');
    store.pushEditHash('edit0001');
    store.pushEditHash('edit0002');

    expect(useContextStore.getState().resolveRecencyRef(0)).toBe('recency1');
    expect(useContextStore.getState().resolveEditRecencyRef(0)).toBe('edit0002');
    expect(useContextStore.getState().resolveEditRecencyRef(1)).toBe('edit0001');
  });

  it('addChunk with result type does not push to hashStack', () => {
    addTestChunk('fn foo() {}', 'file', 'src/foo.ts');
    const afterFile = useContextStore.getState().hashStack.slice();
    expect(afterFile.length).toBe(1);

    addTestChunk('batch output', 'result');
    const afterResult = useContextStore.getState().hashStack;
    expect(afterResult).toEqual(afterFile);
  });

  it('addChunk with file-relevant types pushes to hashStack', () => {
    addTestChunk('content a', 'smart', 'src/a.ts');
    addTestChunk('content b', 'raw', 'src/b.ts');
    addTestChunk('content c', 'search');
    expect(useContextStore.getState().hashStack.length).toBe(3);
  });

  it('edit stack is bounded to 50 entries', () => {
    const store = useContextStore.getState();
    for (let i = 0; i < 60; i++) {
      store.pushEditHash(`edit${i.toString().padStart(4, '0')}pad`);
    }
    const state = useContextStore.getState();
    expect(state.editHashStack.length).toBeLessThanOrEqual(50);
  });

  it('resolveEditRecencyRef returns null for out-of-bounds', () => {
    expect(useContextStore.getState().resolveEditRecencyRef(0)).toBeNull();
    useContextStore.getState().pushEditHash('edit0001');
    expect(useContextStore.getState().resolveEditRecencyRef(0)).toBe('edit0001');
    expect(useContextStore.getState().resolveEditRecencyRef(1)).toBeNull();
  });
});

describe('memory telemetry', () => {
  beforeEach(() => resetStore());

  it('preserves rebind metadata on recorded memory events', () => {
    const store = useContextStore.getState();
    store.recordMemoryEvent({
      action: 'block',
      reason: 'identity_lost',
      refs: ['h:aabb1122'],
      confidence: 'low',
      strategy: 'blocked',
      factors: ['identity_lost'],
    });

    const event = useContextStore.getState().memoryEvents.at(-1);
    expect(event?.confidence).toBe('low');
    expect(event?.strategy).toBe('blocked');
    expect(event?.factors).toEqual(['identity_lost']);
  });

  it('summarizes memory telemetry in stats', () => {
    const store = useContextStore.getState();
    store.recordMemoryEvent({
      action: 'retry',
      reason: 'medium_confidence_rebind',
      confidence: 'medium',
      strategy: 'fingerprint_match',
      factors: ['fingerprint_unique'],
    });
    store.recordMemoryEvent({
      action: 'block',
      reason: 'identity_lost',
      confidence: 'low',
      strategy: 'blocked',
      factors: ['identity_lost'],
    });

    const stats = useContextStore.getState().getStats();
    expect(stats.memoryTelemetry).toMatchObject({
      eventCount: 2,
      blockCount: 1,
      retryCount: 1,
      rebindCount: 2,
      lowConfidenceCount: 1,
      mediumConfidenceCount: 1,
    });
    expect(stats.memoryTelemetry.strategyCounts).toMatchObject({
      fingerprint_match: 1,
      blocked: 1,
    });
  });

  it('includes telemetry aggregates in formatted working memory', () => {
    const store = useContextStore.getState();
    store.recordMemoryEvent({
      action: 'retry',
      reason: 'medium_confidence_rebind',
      confidence: 'medium',
      strategy: 'symbol_identity',
      factors: ['symbol_identity'],
    });
    store.recordMemoryEvent({
      action: 'block',
      reason: 'stale_hash',
    });

    const formatted = store.getWorkingMemoryFormatted();
    expect(formatted).toContain('events:2');
    expect(formatted).toContain('rebinds:1');
    expect(formatted).toContain('blocks:1');
    expect(formatted).toContain('retries:1');
    expect(formatted).toContain('medium_conf:1');
  });
});

// ---------------------------------------------------------------------------
// getStagedBlock deduplication with active engrams
// ---------------------------------------------------------------------------

describe('getStagedBlock active engram dedup', () => {
  beforeEach(() => resetStore());

  it('emits pointer instead of full content when source has an active engram', () => {
    const store = useContextStore.getState();
    const fileContent = 'export const x = 1;\nexport const y = 2;\n';

    store.addChunk(fileContent, 'smart', 'src/utils.ts');

    store.stageSnippet('utils', fileContent, 'src/utils.ts');

    const block = store.getStagedBlock();
    expect(block).toContain('src/utils.ts');
    expect(block).toContain('active engram exists');
    expect(block).not.toContain('export const x = 1');
  });

  it('emits full content when source has no active engram', () => {
    const store = useContextStore.getState();
    const fileContent = 'export const z = 3;\n';

    store.stageSnippet('other', fileContent, 'src/other.ts');

    const block = store.getStagedBlock();
    expect(block).toContain('src/other.ts');
    expect(block).toContain('export const z = 3');
    expect(block).not.toContain('active engram exists');
  });
});

// ---------------------------------------------------------------------------
// Hash collision disambiguation
// ---------------------------------------------------------------------------

describe('hash collision disambiguation', () => {
  beforeEach(() => resetStore());

  it('assigns a unique shortHash when content-hash collides', () => {
    const fixedHash = 'deadbeef12345678';
    useContextStore.getState().addChunk('original content', 'result', 'src/a.ts', undefined, undefined, fixedHash);
    expect(useContextStore.getState().chunks.has(fixedHash)).toBe(true);

    // Tamper the stored entry's content so the next addChunk with the same
    // backendHash sees different content and enters the collision branch.
    useContextStore.setState(state => {
      const chunks = new Map(state.chunks);
      const existing = chunks.get(fixedHash)!;
      chunks.set(fixedHash, { ...existing, content: 'tampered' });
      return { chunks };
    });

    // Re-add with same backendHash but original content → collision
    useContextStore.getState().addChunk('original content', 'result', 'src/b.ts', undefined, undefined, fixedHash);

    const allChunks = Array.from(useContextStore.getState().chunks.values());
    const shortHashes = allChunks.map(c => c.shortHash);
    expect(allChunks.length).toBe(2);
    expect(new Set(shortHashes).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// queryBySetSelector reachable pool deduplication
// ---------------------------------------------------------------------------

describe('queryBySetSelector reachable dedup', () => {
  beforeEach(() => resetStore());

  it('does not return duplicate entries when a chunk exists in both active and archive', () => {
    const store = useContextStore.getState();
    const hash = store.addChunk('export const x = 1;', 'smart', 'src/dup.ts');

    // Compact it so it also appears in archivedChunks
    store.compactChunks([hash]);

    const result = store.queryBySetSelector({ kind: 'all' }, 'reachable');
    const sourceMatches = result.entries.filter(e => e.source === 'src/dup.ts');
    expect(sourceMatches.length).toBe(1);
  });

  it('does not return duplicate entries when a chunk is both active and staged', () => {
    const store = useContextStore.getState();
    const content = 'export const y = 2;\n';
    store.addChunk(content, 'smart', 'src/staged-dup.ts');
    store.stageSnippet('h:abc12345', content, 'src/staged-dup.ts');

    const result = store.queryBySetSelector({ kind: 'all' }, 'reachable');
    const hashes = result.hashes;
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

// ---------------------------------------------------------------------------
// registerEditHash origin tagging (Issue 4)
// ---------------------------------------------------------------------------

describe('registerEditHash origin tagging', () => {
  beforeEach(() => resetStore());

  it('tags registered edit hash with origin:edit', () => {
    useContextStore.getState().registerEditHash('aabb112233445566', 'src/foo.ts');
    const chunk = useContextStore.getState().chunks.get('aabb112233445566');
    expect(chunk).toBeDefined();
    expect(chunk!.origin).toBe('edit');
  });

  it('tags registered edit hash with editSessionId', () => {
    useContextStore.getState().registerEditHash('ccdd112233445566', 'src/bar.ts', 'session-42');
    const chunk = useContextStore.getState().chunks.get('ccdd112233445566');
    expect(chunk).toBeDefined();
    expect(chunk!.editSessionId).toBe('session-42');
  });

  it('edit-registered chunks appear in @edited selector', () => {
    addTestChunk('fn foo() {}', 'file', 'src/foo.ts');
    useContextStore.getState().registerEditHash('eeff112233445566', 'src/foo.ts', 'sess-1');
    const result = useContextStore.getState().queryBySetSelector({ kind: 'edited' });
    expect(result.hashes).toContain('eeff112233445566');
  });
});

// ---------------------------------------------------------------------------
// addSynapse evicted engram error (Issue 5)
// ---------------------------------------------------------------------------

describe('addSynapse evicted engram handling', () => {
  beforeEach(() => resetStore());

  it('returns actionable error when source engram is in droppedManifest', () => {
    const shortH1 = addTestChunk('fn foo() {}', 'file', 'src/foo.ts');
    const shortH2 = addTestChunk('fn bar() {}', 'file', 'src/bar.ts');

    // addChunk returns shortHash; find the full hash key used in the map
    const state0 = useContextStore.getState();
    const fullH1 = Array.from(state0.chunks.entries()).find(([, c]) => c.shortHash === shortH1)?.[0];
    expect(fullH1).toBeDefined();

    // Simulate eviction: move h1 to droppedManifest, remove from chunks + archived
    useContextStore.setState(state => {
      const newChunks = new Map(state.chunks);
      newChunks.delete(fullH1!);
      const newArchived = new Map(state.archivedChunks);
      newArchived.delete(fullH1!);
      const newManifest = new Map(state.droppedManifest);
      newManifest.set(fullH1!, {
        hash: fullH1!,
        shortHash: shortH1,
        type: 'file' as import('../utils/contextHash').ChunkType,
        source: 'src/foo.ts',
        tokens: 20,
        droppedAt: Date.now(),
      });
      return { chunks: newChunks, archivedChunks: newArchived, droppedManifest: newManifest };
    });

    const result = useContextStore.getState().addSynapse(`h:${shortH1}`, `h:${shortH2}`, 'depends_on');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('evicted');
    expect(result.error).toContain('session.recall');
  });

  it('returns generic error when engram is completely unknown', () => {
    const h1 = addTestChunk('fn foo() {}', 'file', 'src/foo.ts');
    const result = useContextStore.getState().addSynapse('h:deadbeef12345678', `h:${h1}`, 'related_to');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// resolveLinkRefToHash (annotate.link path / short-hash endpoints)
// ---------------------------------------------------------------------------

describe('resolveLinkRefToHash', () => {
  beforeEach(() => resetStore());

  it('maps file basename to canonical h:fullHash', () => {
    addTestChunk('export const x = 1', 'file', 'src/utils/contextHash.ts');
    const full = Array.from(useContextStore.getState().chunks.values())[0]!.hash;
    const r = useContextStore.getState().resolveLinkRefToHash('contextHash.ts');
    expect(r).toBe(`h:${full}`);
  });

  it('canonicalizes short h: ref to h:fullHash', () => {
    const short = addTestChunk('fn x() {}', 'file', 'src/a.ts');
    const full = Array.from(useContextStore.getState().chunks.entries()).find(([, c]) => c.shortHash === short)?.[0];
    expect(full).toBeDefined();
    const r = useContextStore.getState().resolveLinkRefToHash(`h:${short}`);
    expect(r).toBe(`h:${full}`);
  });

  it('passes through unresolved path', () => {
    addTestChunk('a', 'file', 'src/only.ts');
    const r = useContextStore.getState().resolveLinkRefToHash('nonexistent.ts');
    expect(r).toBe('nonexistent.ts');
  });
});

// ---------------------------------------------------------------------------
// clearReadSpansForPaths (rollback readSpan invalidation)
// ---------------------------------------------------------------------------

describe('clearReadSpansForPaths', () => {
  beforeEach(() => resetStore());

  it('nullifies readSpan on chunks matching a rolled-back path', () => {
    addTestChunk('fn main() {}', 'raw', 'src/lib.rs', {
      readSpan: { filePath: 'src/lib.rs', sourceRevision: 'abc123' },
    });
    const before = Array.from(useContextStore.getState().chunks.values()).find(c => c.source === 'src/lib.rs');
    expect(before?.readSpan).toBeDefined();

    useContextStore.getState().clearReadSpansForPaths(['src/lib.rs']);

    const after = Array.from(useContextStore.getState().chunks.values()).find(c => c.source === 'src/lib.rs');
    expect(after?.readSpan).toBeUndefined();
  });

  it('causes findReusableRead to return null after clearing', () => {
    addTestChunk('fn main() {}', 'raw', 'src/lib.rs', {
      sourceRevision: 'abc123',
      readSpan: { filePath: 'src/lib.rs', sourceRevision: 'abc123' },
    });
    const reuseBefore = useContextStore.getState().findReusableRead({ filePath: 'src/lib.rs', sourceRevision: 'abc123' });
    expect(reuseBefore).not.toBeNull();

    useContextStore.getState().clearReadSpansForPaths(['src/lib.rs']);

    const reuseAfter = useContextStore.getState().findReusableRead({ filePath: 'src/lib.rs', sourceRevision: 'abc123' });
    expect(reuseAfter).toBeNull();
  });

  it('does not affect chunks for unrelated files', () => {
    addTestChunk('fn main() {}', 'raw', 'src/lib.rs', {
      readSpan: { filePath: 'src/lib.rs', sourceRevision: 'abc123' },
    });
    addTestChunk('use super::*;', 'raw', 'src/pty.rs', {
      readSpan: { filePath: 'src/pty.rs', sourceRevision: 'def456' },
    });

    useContextStore.getState().clearReadSpansForPaths(['src/lib.rs']);

    const libChunk = Array.from(useContextStore.getState().chunks.values()).find(c => c.source === 'src/lib.rs');
    const ptyChunk = Array.from(useContextStore.getState().chunks.values()).find(c => c.source === 'src/pty.rs');
    expect(libChunk?.readSpan).toBeUndefined();
    expect(ptyChunk?.readSpan).toBeDefined();
    expect(ptyChunk?.readSpan?.sourceRevision).toBe('def456');
  });
});
