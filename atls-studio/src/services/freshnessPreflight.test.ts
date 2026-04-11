import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from '../stores/contextStore';
import { classifyRefFreshness, getFreshnessHintForRefs, getPreflightAutomationDecision, runFreshnessPreflight } from './freshnessPreflight';
import { clearFreshnessJournal, getFreshnessJournal, recordFreshnessJournal } from './freshnessJournal';

function resetStore() {
  useContextStore.getState().resetSession();
  useContextStore.setState({ hashStack: [], editHashStack: [] });
  clearFreshnessJournal();
}

describe('runFreshnessPreflight', () => {
  beforeEach(() => resetStore());

  it('blocks when an archived latest ref for the target file is externally stale', async () => {
    const store = useContextStore.getState();
    const archivedHash = store.addChunk(
      'export const archived = 1;',
      'smart',
      'src/demo.ts',
      undefined,
      undefined,
      'rev-1',
      { sourceRevision: 'rev-1', viewKind: 'latest' },
    );

    useContextStore.setState((state) => {
      const archivedEntry = Array.from(state.chunks.entries()).find(([, chunk]) => chunk.shortHash === archivedHash);
      if (!archivedEntry) return {};
      const [archivedKey, archivedChunk] = archivedEntry;
      const chunks = new Map(state.chunks);
      const archivedChunks = new Map(state.archivedChunks);
      chunks.delete(archivedKey);
      archivedChunks.set(archivedKey, {
        ...archivedChunk,
        suspectSince: Date.now(),
        freshness: 'suspect',
        freshnessCause: 'external_file_change',
      });
      return { chunks, archivedChunks };
    });

    const result = await runFreshnessPreflight('draft', {
      edits: [{ file: 'src/demo.ts', old: 'before', new: 'after' }],
    });

    expect(result.blocked).toBe(true);
    expect(result.error).toMatch(/src\/demo\.ts/);
  });

  it('ignores stale archived refs from sibling files', async () => {
    const store = useContextStore.getState();
    const archivedHash = store.addChunk(
      'export const archived = 1;',
      'smart',
      'src/demo.tsx',
      undefined,
      undefined,
      'rev-1',
      { sourceRevision: 'rev-1', viewKind: 'latest' },
    );

    useContextStore.setState((state) => {
      const archivedEntry = Array.from(state.chunks.entries()).find(([, chunk]) => chunk.shortHash === archivedHash);
      if (!archivedEntry) return {};
      const [archivedKey, archivedChunk] = archivedEntry;
      const chunks = new Map(state.chunks);
      const archivedChunks = new Map(state.archivedChunks);
      chunks.delete(archivedKey);
      archivedChunks.set(archivedKey, {
        ...archivedChunk,
        suspectSince: Date.now(),
        freshness: 'suspect',
        freshnessCause: 'external_file_change',
      });
      return { chunks, archivedChunks };
    });

    const result = await runFreshnessPreflight('draft', {
      edits: [{ file: 'src/demo.ts', old: 'before', new: 'after' }],
    });

    expect(result.blocked).toBe(false);
  });

  it('uses the edit journal to shift same-lineage latest snippets with high confidence', async () => {
    const store = useContextStore.getState();
    store.stageSnippet('stage:demo', 'const two = 2;', 'src/demo.ts', '2-2', 'rev-old', undefined, 'latest');
    useContextStore.setState((state) => ({
      stagedSnippets: new Map([...state.stagedSnippets].map(([key, snippet]) => [
        key,
        key === 'stage:demo'
          ? {
            ...snippet,
            suspectSince: Date.now(),
            freshness: 'shifted',
            freshnessCause: 'same_file_prior_edit' as const,
            observedRevision: 'rev-new',
          }
          : snippet,
      ])),
    }));
    recordFreshnessJournal({
      source: 'src/demo.ts',
      previousRevision: 'rev-old',
      currentRevision: 'rev-new',
      lineDelta: 2,
      recordedAt: Date.now(),
    });

    const result = await runFreshnessPreflight('draft', {
      file: 'src/demo.ts',
      lines: '2-2',
    });

    expect(result.blocked).toBe(false);
    expect(result.confidence).toBe('high');
    expect(result.strategy).toBe('edit_journal');
    expect(result.decisions[0]?.linesAfter).toBe('4-4');
    expect(result.decisions[0]?.factors).toContain('journal_line_delta');
  });

  it('falls back to snippet fingerprint rebinding when line math is insufficient', async () => {
    const store = useContextStore.getState();
    store.stageSnippet('stage:fingerprint', 'const moved = 2;', 'src/demo.ts', '2-2', 'rev-old', undefined, 'latest');
    useContextStore.setState((state) => ({
      stagedSnippets: new Map([...state.stagedSnippets].map(([key, snippet]) => [
        key,
        key === 'stage:fingerprint'
          ? {
            ...snippet,
            suspectSince: Date.now(),
            freshness: 'shifted',
            freshnessCause: 'same_file_prior_edit' as const,
            observedRevision: 'rev-new',
          }
          : snippet,
      ])),
    }));

    const result = await runFreshnessPreflight(
      'draft',
      { file: 'src/demo.ts', lines: '2-2' },
      { contentByPath: new Map([['src/demo.ts', 'const start = 1;\nconst inserted = true;\nconst moved = 2;\n']]) },
    );

    expect(result.blocked).toBe(false);
    expect(result.confidence).toBe('medium');
    expect(result.strategy).toBe('fingerprint_match');
    expect(result.decisions[0]?.linesAfter).toBe('3-3');
    expect(result.decisions[0]?.factors).toContain('fingerprint_unique');
  });

  it('rebinds staged symbol-shaped refs by symbol identity before fingerprint fallback', async () => {
    const store = useContextStore.getState();
    store.stageSnippet('stage:symbol', 'function target() {\n  return 2;\n}', 'src/demo.ts', '2-4', 'rev-old', 'fn(target)', 'latest');
    useContextStore.setState((state) => ({
      stagedSnippets: new Map([...state.stagedSnippets].map(([key, snippet]) => [
        key,
        key === 'stage:symbol'
          ? {
            ...snippet,
            suspectSince: Date.now(),
            freshness: 'shifted',
            freshnessCause: 'same_file_prior_edit' as const,
            observedRevision: 'rev-new',
          }
          : snippet,
      ])),
    }));

    const result = await runFreshnessPreflight(
      'draft',
      { file: 'src/demo.ts', lines: '2-4' },
      { contentByPath: new Map([['src/demo.ts', 'const prelude = true;\nfunction target() {\n  return 2;\n}\n']]) },
    );

    expect(result.blocked).toBe(false);
    expect(result.confidence).toBe('medium');
    expect(result.strategy).toBe('symbol_identity');
    expect(result.decisions[0]?.linesAfter).toBe('2-4');
    expect(result.decisions[0]?.factors).toContain('symbol_identity');
  });

  it('blocks when same-lineage stale refs lose identity after content reread', async () => {
    const store = useContextStore.getState();
    store.stageSnippet('stage:lost', 'const original = 1;', 'src/demo.ts', '2-2', 'rev-old', undefined, 'latest');
    useContextStore.setState((state) => ({
      stagedSnippets: new Map([...state.stagedSnippets].map(([key, snippet]) => [
        key,
        key === 'stage:lost'
          ? {
            ...snippet,
            suspectSince: Date.now(),
            freshness: 'shifted',
            freshnessCause: 'same_file_prior_edit' as const,
            observedRevision: 'rev-new',
          }
          : snippet,
      ])),
    }));

    const result = await runFreshnessPreflight(
      'draft',
      { file: 'src/demo.ts', lines: '2-2' },
      { contentByPath: new Map([['src/demo.ts', 'const different = 2;\nconst elseBlock = true;\n']]) },
    );

    expect(result.blocked).toBe(true);
    expect(result.strategy).toBe('blocked');
    expect(result.confidence).toBe('none');
    expect(result.error).toMatch(/Identity lost/);
    expect(result.decisions[0]?.factors).toContain('identity_lost');
  });

  it('maps medium-confidence structural rebinds to proceed_with_note', () => {
    expect(getPreflightAutomationDecision({
      blocked: false,
      confidence: 'medium',
      strategy: 'symbol_identity',
    })).toEqual({
      action: 'proceed_with_note',
      reason: 'medium_confidence_rebind',
    });
  });

  it('allows context/read_lines preflight to proceed when refs are suspect (healing read path)', async () => {
    const store = useContextStore.getState();
    store.addChunk('export const x = 1;', 'smart', 'src/root.ts', undefined, undefined, 'rev-a', {
      sourceRevision: 'rev-a',
      viewKind: 'latest',
    });
    useContextStore.setState((state) => ({
      chunks: new Map(
        [...state.chunks].map(([key, chunk]) =>
          chunk.source === 'src/root.ts'
            ? [key, { ...chunk, suspectSince: Date.now(), freshnessCause: 'external_file_change' as const }]
            : [key, chunk],
        ),
      ),
    }));

    const result = await runFreshnessPreflight(
      'context',
      { file_paths: ['src/root.ts'], type: 'smart' },
      {
        // Empty inner context — no revision to reconcile; suspect stays, healing path must still allow read
        atlsBatchQuery: async () => ({ results: [] }),
      },
    );

    expect(result.blocked).toBe(false);
    expect(result.warnings.some((w) => w.includes('suspect'))).toBe(true);
  });

  it('still blocks draft when suspect refs match target files', async () => {
    const store = useContextStore.getState();
    store.addChunk('export const x = 1;', 'smart', 'src/root.ts', undefined, undefined, 'rev-a', {
      sourceRevision: 'rev-a',
      viewKind: 'latest',
    });
    useContextStore.setState((state) => ({
      chunks: new Map(
        [...state.chunks].map(([key, chunk]) =>
          chunk.source === 'src/root.ts'
            ? [key, { ...chunk, suspectSince: Date.now(), freshnessCause: 'external_file_change' as const }]
            : [key, chunk],
        ),
      ),
    }));

    const result = await runFreshnessPreflight(
      'draft',
      { edits: [{ file: 'src/root.ts', old: 'a', new: 'b' }] },
      {
        atlsBatchQuery: async () => ({ results: [] }),
      },
    );

    expect(result.blocked).toBe(true);
  });

  it('preflight sees post-refresh state not stale pre-refresh state', async () => {
    const store = useContextStore.getState();
    store.addChunk('export const stale = 1;', 'smart', 'src/demo.ts', undefined, undefined, 'rev-old', { sourceRevision: 'rev-old', viewKind: 'latest' });
    useContextStore.setState((state) => ({
      chunks: new Map([...state.chunks].map(([key, chunk]) => [
        key,
        chunk.source === 'src/demo.ts'
          ? { ...chunk, suspectSince: Date.now(), freshnessCause: 'external_file_change' as const }
          : chunk,
      ])),
    }));
    const getRevisionForPath = vi.fn().mockResolvedValue('rev-fresh');
    await store.refreshRoundEnd({ paths: ['src/demo.ts'], getRevisionForPath });
    const chunkAfterRefresh = Array.from(useContextStore.getState().chunks.values()).find(c => c.source === 'src/demo.ts');
    expect(chunkAfterRefresh?.suspectSince).toBeUndefined();
    expect(chunkAfterRefresh?.sourceRevision).toBe('rev-fresh');
    const result = await runFreshnessPreflight('draft', {
      edits: [{ file: 'src/demo.ts', old: 'before', new: 'after' }],
    }, {
      atlsBatchQuery: async (op: string, p: Record<string, unknown>) => {
        if (op === 'context' && Array.isArray(p.file_paths)) {
          const path = (p.file_paths as string[])[0];
          return { results: [{ file: path, content: 'x', content_hash: 'rev-fresh' }] };
        }
        return { results: [] };
      },
    });
    expect(result.blocked).toBe(false);
  });

  it('maps low-confidence rebinds to review_required', () => {
    expect(getPreflightAutomationDecision({
      blocked: false,
      confidence: 'low',
      strategy: 'line_relocation',
    })).toEqual({
      action: 'review_required',
      reason: 'low_confidence_rebind',
    });
  });

  it('does not apply stale journal lineDelta after clearFreshnessJournal (rollback scenario)', async () => {
    recordFreshnessJournal({
      source: 'src/foo.rs',
      previousRevision: 'rev-A',
      currentRevision: 'rev-B',
      lineDelta: 3,
      recordedAt: Date.now(),
    });
    expect(getFreshnessJournal('src/foo.rs')?.lineDelta).toBe(3);

    clearFreshnessJournal('src/foo.rs');
    expect(getFreshnessJournal('src/foo.rs')).toBeUndefined();

    const store = useContextStore.getState();
    store.addChunk('fn main() {}', 'raw', 'src/foo.rs', undefined, undefined, undefined, {
      sourceRevision: 'rev-B',
      viewKind: 'latest',
    });
    useContextStore.setState((state) => ({
      chunks: new Map([...state.chunks].map(([key, chunk]) => [
        key,
        chunk.source === 'src/foo.rs'
          ? { ...chunk, freshnessCause: 'same_file_prior_edit' as const, observedRevision: 'rev-A' }
          : chunk,
      ])),
    }));

    const result = await runFreshnessPreflight('draft', {
      file: 'src/foo.rs',
      line_edits: [{ line: 10, action: 'insert_before', content: '// fresh' }],
    }, {
      atlsBatchQuery: async (op: string, p: Record<string, unknown>) => {
        if (op === 'context' && Array.isArray(p.file_paths)) {
          return { results: [{ file: 'src/foo.rs', content: 'fn main() {}\n', content_hash: 'rev-A' }] };
        }
        return { results: [] };
      },
    });

    expect(result.blocked).toBe(false);
    const journalDecision = result.decisions.find(d => d.factors?.includes('journal_line_delta'));
    expect(journalDecision).toBeUndefined();
  });
});

describe('getFreshnessHintForRefs', () => {
  const warn = 'WARNING: some refs may be stale (file changed externally); re-read before editing';

  it('returns undefined for empty refs', () => {
    expect(getFreshnessHintForRefs({ chunks: new Map(), archivedChunks: new Map() }, [])).toBeUndefined();
  });

  it('strips h: prefix when matching short hash', () => {
    const chunks = new Map([
      ['k', { shortHash: 'a1b2c3d4', hash: 'a1b2c3d4full', suspectSince: 1, freshnessCause: 'external_file_change' as const }],
    ]);
    expect(getFreshnessHintForRefs({ chunks, archivedChunks: new Map() }, ['h:a1b2c3d4'])).toBe(warn);
  });

  it('matches chunk by hash prefix when short differs', () => {
    const chunks = new Map([
      ['k', { shortHash: 'xxxxxxxx', hash: 'deadbeef99', suspectSince: 1, freshnessCause: 'watcher_event' as const }],
    ]);
    expect(getFreshnessHintForRefs({ chunks, archivedChunks: new Map() }, ['deadbeef'])).toBe(warn);
  });

  it('warns for suspect archived chunk with unknown cause', () => {
    const archivedChunks = new Map([
      ['k', { shortHash: 'beeff00d', hash: 'beeff00d', suspectSince: 1, freshnessCause: undefined }],
    ]);
    expect(getFreshnessHintForRefs({ chunks: new Map(), archivedChunks }, ['beeff00d'])).toBe(warn);
  });

  it('does not warn when suspectSince is set but cause is rebaseable (same_file_prior_edit)', () => {
    const chunks = new Map([
      ['k', { shortHash: 'cafebabe', hash: 'cafebabe', suspectSince: 1, freshnessCause: 'same_file_prior_edit' as const }],
    ]);
    expect(getFreshnessHintForRefs({ chunks, archivedChunks: new Map() }, ['cafebabe'])).toBeUndefined();
  });

  it('does not warn for session_restore suspect cause (not treated as external stale in hint)', () => {
    const chunks = new Map([
      ['k', { shortHash: 'abad1dea', hash: 'abad1dea', suspectSince: 1, freshnessCause: 'session_restore' as const }],
    ]);
    expect(getFreshnessHintForRefs({ chunks, archivedChunks: new Map() }, ['abad1dea'])).toBeUndefined();
  });
});

describe('classifyRefFreshness', () => {
  const targets = new Set(['src/a.ts']);

  it('is fresh when source is missing', () => {
    expect(classifyRefFreshness(undefined, 'r1', 'r1', undefined, undefined, targets)).toBe('fresh');
  });

  it('is fresh when source file is not in target set', () => {
    expect(classifyRefFreshness('other/b.ts', 'r1', 'r2', undefined, 'external_file_change', targets)).toBe('fresh');
  });

  it('with suspectSince and rebaseable cause returns rebaseable', () => {
    expect(classifyRefFreshness('src/a.ts', 'r1', 'r1', 1, 'hash_forward', targets)).toBe('rebaseable');
  });

  it('with suspectSince and suspect cause returns suspect', () => {
    expect(classifyRefFreshness('src/a.ts', 'r1', 'r1', 1, 'external_file_change', targets)).toBe('suspect');
  });

  it('with suspectSince and non-rebaseable neutral cause returns suspect', () => {
    expect(classifyRefFreshness('src/a.ts', 'r1', 'r1', 1, 'session_restore', targets)).toBe('suspect');
  });

  it('revision mismatch with rebaseable cause returns rebaseable', () => {
    expect(classifyRefFreshness('src/a.ts', 'r1', 'r2', undefined, 'same_file_prior_edit', targets)).toBe('rebaseable');
  });

  it('revision mismatch with suspect cause returns suspect', () => {
    expect(classifyRefFreshness('src/a.ts', 'r1', 'r2', undefined, 'unknown', targets)).toBe('suspect');
  });

  it('revision mismatch with session_restore returns suspect', () => {
    expect(classifyRefFreshness('src/a.ts', 'r1', 'r2', undefined, 'session_restore', targets)).toBe('suspect');
  });

  it('is fresh when revisions align and not suspect', () => {
    expect(classifyRefFreshness('src/a.ts', 'r1', 'r1', undefined, undefined, targets)).toBe('fresh');
  });
});
