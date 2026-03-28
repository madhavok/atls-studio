/**
 * BB Reasoning Freshness tests — exercises automatic supersession of
 * file-bound blackboard entries on canonical read/edit, prompt filtering,
 * and key parsing utilities.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useContextStore,
  parseBbKey,
  inferBbFilePath,
  setWorkspacesAccessor,
  setRoundRefreshRevisionResolver,
  setBulkRevisionResolver,
  type BbArtifactKind,
  type BbArtifactState,
} from './contextStore';

function resetStore() {
  useContextStore.getState().resetSession();
  useContextStore.setState({ hashStack: [], editHashStack: [] });
  setWorkspacesAccessor(() => []);
  setRoundRefreshRevisionResolver(null);
  setBulkRevisionResolver(null);
}

function getEntry(key: string) {
  return useContextStore.getState().blackboardEntries.get(key);
}

// ---------------------------------------------------------------------------
// parseBbKey
// ---------------------------------------------------------------------------

describe('parseBbKey', () => {
  it.each<[string, BbArtifactKind, string | undefined]>([
    ['plan:hashResolver.ts', 'plan', 'hashResolver.ts'],
    ['bugs:contextStore', 'bug', 'contextStore'],
    ['bug:foo.ts', 'bug', 'foo.ts'],
    ['repair:hashResolver.ts', 'repair', 'hashResolver.ts'],
    ['status:build', 'status', 'build'],
    ['err:hashResolver.ts', 'err', 'hashResolver.ts'],
    ['fix:hashResolver.ts', 'fix', 'hashResolver.ts'],
    ['edit:hashResolver.ts', 'edit', 'hashResolver.ts'],
    ['impl-decisions', 'general', undefined],
    ['root-cause', 'general', undefined],
  ])('parseBbKey(%s) -> kind=%s, basename=%s', (key, expectedKind, expectedBasename) => {
    const result = parseBbKey(key);
    expect(result.kind).toBe(expectedKind);
    expect(result.basename).toBe(expectedBasename);
  });
});

// ---------------------------------------------------------------------------
// inferBbFilePath
// ---------------------------------------------------------------------------

describe('inferBbFilePath', () => {
  it('returns derivedFrom[0] when provided', () => {
    expect(inferBbFilePath('plan:foo', ['src/foo.ts'])).toBe('src/foo.ts');
  });

  it('returns undefined for general keys without derivedFrom', () => {
    expect(inferBbFilePath('impl-decisions')).toBeUndefined();
  });

  it('resolves basename against awareness keys', () => {
    const awarenessKeys = ['src/utils/hashresolver.ts', 'src/stores/contextstore.ts'];
    expect(inferBbFilePath('repair:hashResolver.ts', undefined, awarenessKeys))
      .toBe('src/utils/hashresolver.ts');
  });

  it('returns undefined when basename does not match awareness', () => {
    const awarenessKeys = ['src/foo.ts'];
    expect(inferBbFilePath('repair:unknown.ts', undefined, awarenessKeys)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setBlackboardEntry — new fields
// ---------------------------------------------------------------------------

describe('setBlackboardEntry freshness metadata', () => {
  beforeEach(() => resetStore());

  it('sets kind and state on new entries', () => {
    useContextStore.getState().setBlackboardEntry('repair:foo.ts', '1');
    const entry = getEntry('repair:foo.ts');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('repair');
    expect(entry!.state).toBe('active');
    expect(entry!.updatedAt).toBeGreaterThan(0);
  });

  it('sets filePath from explicit opts', () => {
    useContextStore.getState().setBlackboardEntry('plan:current', 'do stuff', {
      filePath: 'src/main.ts',
    });
    const entry = getEntry('plan:current');
    expect(entry!.filePath).toBe('src/main.ts');
  });

  it('sets filePath from derivedFrom', () => {
    useContextStore.getState().setBlackboardEntry('bugs:dep', 'stale import', {
      derivedFrom: ['src/dep.ts'],
    });
    const entry = getEntry('bugs:dep');
    expect(entry!.filePath).toMatch(/dep\.ts/);
  });

  it('captures snapshotHash from explicit opts', () => {
    useContextStore.getState().setBlackboardEntry('repair:bar.ts', '2', {
      filePath: 'src/bar.ts',
      snapshotHash: 'abc123',
    });
    const entry = getEntry('repair:bar.ts');
    expect(entry!.snapshotHash).toBe('abc123');
  });

  it('defaults general kind for unrecognized prefixes', () => {
    useContextStore.getState().setBlackboardEntry('impl-decisions', 'use XYZ pattern');
    const entry = getEntry('impl-decisions');
    expect(entry!.kind).toBe('general');
    expect(entry!.filePath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// supersedeBlackboardForPath
// ---------------------------------------------------------------------------

describe('supersedeBlackboardForPath', () => {
  beforeEach(() => resetStore());

  it('supersedes active file-bound entries when revision changes', () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('repair:foo.ts', '3', {
      filePath: 'src/foo.ts',
      snapshotHash: 'old_hash',
    });
    store.setBlackboardEntry('plan:foo.ts', 'fix the bug', {
      filePath: 'src/foo.ts',
      snapshotHash: 'old_hash',
    });

    const count = store.supersedeBlackboardForPath('src/foo.ts', 'new_hash');
    expect(count).toBe(2);

    const repair = getEntry('repair:foo.ts');
    expect(repair!.state).toBe('superseded');
    expect(repair!.supersededBy).toBe('new_hash');
    expect(repair!.supersededAt).toBeGreaterThan(0);

    const plan = getEntry('plan:foo.ts');
    expect(plan!.state).toBe('superseded');
  });

  it('does not supersede entries with matching revision', () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('repair:foo.ts', '1', {
      filePath: 'src/foo.ts',
      snapshotHash: 'same_hash',
    });

    const count = store.supersedeBlackboardForPath('src/foo.ts', 'same_hash');
    expect(count).toBe(0);
    expect(getEntry('repair:foo.ts')!.state).toBe('active');
  });

  it('does not supersede general/non-file-bound entries', () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('impl-decisions', 'use zustand');

    const count = store.supersedeBlackboardForPath('src/foo.ts', 'new_hash');
    expect(count).toBe(0);
    expect(getEntry('impl-decisions')!.state).toBe('active');
  });

  it('does not supersede entries bound to a different file', () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('repair:bar.ts', '1', {
      filePath: 'src/bar.ts',
      snapshotHash: 'old',
    });

    const count = store.supersedeBlackboardForPath('src/foo.ts', 'new_hash');
    expect(count).toBe(0);
    expect(getEntry('repair:bar.ts')!.state).toBe('active');
  });

  it('does not supersede already-superseded entries', () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('repair:foo.ts', '1', {
      filePath: 'src/foo.ts',
      snapshotHash: 'v1',
    });
    store.supersedeBlackboardForPath('src/foo.ts', 'v2');
    expect(getEntry('repair:foo.ts')!.state).toBe('superseded');

    const count = store.supersedeBlackboardForPath('src/foo.ts', 'v3');
    expect(count).toBe(0);
  });

  it('does not supersede edit: kind entries (ephemeral steering)', () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('edit:foo.ts', 'h:abc123 40L', {
      filePath: 'src/foo.ts',
      snapshotHash: 'old',
    });

    const count = store.supersedeBlackboardForPath('src/foo.ts', 'new_hash');
    expect(count).toBe(0);
    expect(getEntry('edit:foo.ts')!.state).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// reconcileSourceRevision BB sweep integration
// ---------------------------------------------------------------------------

describe('reconcileSourceRevision BB sweep', () => {
  beforeEach(() => resetStore());

  it('supersedes file-bound BB entries during reconciliation', () => {
    const store = useContextStore.getState();

    store.addChunk('file content', 'file' as any, 'src/hashResolver.ts', undefined, undefined, undefined, {
      backendHash: 'chunk_hash',
      sourceRevision: 'rev_old',
    });

    store.setBlackboardEntry('repair:hashResolver.ts', '5', {
      filePath: 'src/hashresolver.ts',
      snapshotHash: 'rev_old',
    });
    store.setBlackboardEntry('bugs:hashResolver.ts', 'stale import', {
      filePath: 'src/hashresolver.ts',
      snapshotHash: 'rev_old',
    });

    const stats = store.reconcileSourceRevision('src/hashResolver.ts', 'rev_new');
    expect(stats.bbSuperseded).toBe(2);

    expect(getEntry('repair:hashResolver.ts')!.state).toBe('superseded');
    expect(getEntry('repair:hashResolver.ts')!.supersededBy).toBe('rev_new');
    expect(getEntry('bugs:hashResolver.ts')!.state).toBe('superseded');
  });

  it('preserves general BB entries during reconciliation', () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('impl-decisions', 'use zustand for state');

    store.addChunk('file content', 'file' as any, 'src/foo.ts', undefined, undefined, undefined, {
      backendHash: 'hash1',
      sourceRevision: 'rev_old',
    });

    store.reconcileSourceRevision('src/foo.ts', 'rev_new');
    expect(getEntry('impl-decisions')!.state).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// listBlackboardEntries — state in output
// ---------------------------------------------------------------------------

describe('listBlackboardEntries state field', () => {
  beforeEach(() => resetStore());

  it('includes state in listing', () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('plan:foo', 'do the thing', {
      filePath: 'src/foo.ts',
      snapshotHash: 'v1',
    });
    store.supersedeBlackboardForPath('src/foo.ts', 'v2');

    store.setBlackboardEntry('impl-decisions', 'active note');

    const list = store.listBlackboardEntries();
    const planEntry = list.find(e => e.key === 'plan:foo');
    const activeEntry = list.find(e => e.key === 'impl-decisions');

    expect(planEntry!.state).toBe('superseded');
    expect(planEntry!.supersededBy).toBe('v2');
    expect(activeEntry!.state).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// getBlackboardEntryWithMeta — new fields
// ---------------------------------------------------------------------------

describe('getBlackboardEntryWithMeta', () => {
  beforeEach(() => resetStore());

  it('returns all freshness metadata', () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('repair:foo.ts', '2', {
      filePath: 'src/foo.ts',
      snapshotHash: 'hash_abc',
    });

    const meta = store.getBlackboardEntryWithMeta('repair:foo.ts');
    expect(meta).toBeDefined();
    expect(meta!.kind).toBe('repair');
    expect(meta!.state).toBe('active');
    expect(meta!.filePath).toMatch(/foo\.ts/);
    expect(meta!.snapshotHash).toBe('hash_abc');
  });

  it('returns superseded metadata after supersession', () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('bugs:bar.ts', 'wrong import', {
      filePath: 'src/bar.ts',
      snapshotHash: 'v1',
    });
    store.supersedeBlackboardForPath('src/bar.ts', 'v2');

    const meta = store.getBlackboardEntryWithMeta('bugs:bar.ts');
    expect(meta!.state).toBe('superseded');
    expect(meta!.supersededBy).toBe('v2');
    expect(meta!.supersededAt).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BB Kind Extensions (summary, fixplan)
// ---------------------------------------------------------------------------

describe('BB Kind Extensions', () => {
  it('parseBbKey("summary:test") returns kind=summary', () => {
    const result = parseBbKey('summary:test');
    expect(result).toEqual({ kind: 'summary', basename: 'test' });
  });

  it('parseBbKey("fixplan:query.ts") returns kind=fixplan', () => {
    const result = parseBbKey('fixplan:query.ts');
    expect(result).toEqual({ kind: 'fixplan', basename: 'query.ts' });
  });
});

// ---------------------------------------------------------------------------
// Identity Validation in setBlackboardEntry
// ---------------------------------------------------------------------------

describe('setBlackboardEntry identity validation', () => {
  beforeEach(() => resetStore());

  it('filters out bogus derivedFrom paths like "results.0.file_path"', () => {
    useContextStore.getState().setBlackboardEntry('plan:test', 'content', {
      derivedFrom: ['results.0.file_path'],
    });
    const entry = getEntry('plan:test');
    expect(entry).toBeDefined();
    expect(entry!.filePath).toBeUndefined();
    expect(entry!.derivedFrom).toBeUndefined();
  });

  it('preserves valid derivedFrom paths', () => {
    useContextStore.getState().setBlackboardEntry('plan:foo', 'content', {
      derivedFrom: ['src/foo.ts'],
    });
    const entry = getEntry('plan:foo');
    expect(entry).toBeDefined();
    expect(entry!.derivedFrom).toEqual(['src/foo.ts']);
  });
});
