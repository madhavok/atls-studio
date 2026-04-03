/**
 * Unit tests for change.edit normalization.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useContextStore } from '../../../stores/contextStore';
import {
  estimateLineDeltaForSource,
  handleCreate,
  handleDelete,
  handleEdit,
  handleRollback,
  normalizeEditParams,
} from './change';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('../../../services/freshnessJournal', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../services/freshnessJournal')>();
  return {
    ...orig,
    clearFreshnessJournal: vi.fn(orig.clearFreshnessJournal),
  };
});

const invokeMock = vi.mocked(invoke);

function resetContextStore() {
  useContextStore.getState().resetSession();
  useContextStore.setState({ hashStack: [], editHashStack: [] });
}

describe('estimateLineDeltaForSource', () => {
  it('computes delta from line_edits when file_path matches (change.edit uses file_path)', () => {
    const params = {
      file_path: 'atls-studio/src/main.tsx',
      line_edits: [{ action: 'insert_after', content: '// a\n// b', line: 5 }],
    };
    expect(estimateLineDeltaForSource(params, 'atls-studio/src/main.tsx')).toBe(2);
  });

  it('still works when file matches', () => {
    const params = {
      file: 'src/a.ts',
      line_edits: [{ action: 'insert_before', content: 'x', line: 1 }],
    };
    expect(estimateLineDeltaForSource(params, 'src/a.ts')).toBe(1);
  });

  it('returns 0 when target path does not match', () => {
    const params = {
      file_path: 'a.ts',
      line_edits: [{ action: 'insert_before', content: 'x', line: 1 }],
    };
    expect(estimateLineDeltaForSource(params, 'b.ts')).toBe(0);
  });

  it('counts prepend as pure insertion', () => {
    const params = {
      file_path: 'src/a.ts',
      line_edits: [{ action: 'prepend', content: '// header\n// license', line: 1 }],
    };
    expect(estimateLineDeltaForSource(params, 'src/a.ts')).toBe(2);
  });

  it('counts append as pure insertion', () => {
    const params = {
      file_path: 'src/a.ts',
      line_edits: [{ action: 'append', content: '// footer', line: 1 }],
    };
    expect(estimateLineDeltaForSource(params, 'src/a.ts')).toBe(1);
  });

  it('treats default (empty) action as replace', () => {
    const params = {
      file_path: 'src/a.ts',
      line_edits: [{ content: 'replaced', line: 5, end_line: 7 }],
    };
    // span=3 lines replaced by 1 line of content → delta = 1 - 3 = -2
    expect(estimateLineDeltaForSource(params, 'src/a.ts')).toBe(-2);
  });

  it('returns 0 for move (net-zero relocation)', () => {
    const params = {
      file_path: 'src/a.ts',
      line_edits: [{ action: 'move', line: 10, end_line: 12, destination: 20 }],
    };
    expect(estimateLineDeltaForSource(params, 'src/a.ts')).toBe(0);
  });
});

describe('normalizeEditParams', () => {
  it('promotes edits: [{ file, line_edits }] to top-level { file, line_edits } and strips edits', () => {
    const edits = [{ line: 1, action: 'insert_before', content: 'x' }];
    const input = { edits: [{ file: 'a.ts', line_edits: edits }] };
    const out = normalizeEditParams(input);
    expect(out.file).toBe('a.ts');
    expect(out.line_edits).toEqual(edits);
    expect(out.edits).toBeUndefined();
  });

  it('promotes edits: [{ file_path, line_edits }] (symbol-style) to top-level', () => {
    const edits = [{ symbol: 'foo', position: 'before', action: 'insert_before', content: '// added' }];
    const input = { edits: [{ file_path: 'src/bar.ts', line_edits: edits }] };
    const out = normalizeEditParams(input);
    expect(out.file).toBe('src/bar.ts');
    expect(out.line_edits).toEqual(edits);
    expect(out.edits).toBeUndefined();
  });

  it('sets mode batch_edits for multi-file edits: [{ file, line_edits }, ...]', () => {
    const input = {
      edits: [
        { file: 'a.ts', line_edits: [{ line: 1, action: 'insert_before', content: 'x' }] },
        { file: 'b.ts', line_edits: [{ line: 2, action: 'replace', content: 'y' }] },
      ],
    };
    const out = normalizeEditParams(input);
    expect(out.mode).toBe('batch_edits');
    expect(out.edits).toEqual(input.edits);
  });

  it('promotes edits[0].file when line_edits present but file missing', () => {
    const lineEdits = [{ line: 1, action: 'insert_before', content: 'z' }];
    const input = { line_edits: lineEdits, edits: [{ file: 'x.ts', line_edits: lineEdits }] };
    const out = normalizeEditParams(input);
    expect(out.file).toBe('x.ts');
    expect(out.line_edits).toEqual(lineEdits);
  });

  it('splits plain path file with trailing :L-M into path and edit_target_range', () => {
    const out = normalizeEditParams({
      file: '.gitignore:1-1',
      line_edits: [{ content: '# ATLS test' }],
    });
    expect(out.file).toBe('.gitignore');
    expect(out.edit_target_range).toEqual([[1, 1]]);
  });

  it('splits plain path file with trailing single :L into path and one-line edit_target_range', () => {
    const out = normalizeEditParams({
      file: '.gitignore:1',
      line_edits: [{ content: '# ATLS test' }],
    });
    expect(out.file).toBe('.gitignore');
    expect(out.edit_target_range).toEqual([[1, 1]]);
  });

  it('returns params unchanged when no promotion needed', () => {
    const input = { file: 'a.ts', line_edits: [{ line: 1, action: 'delete' }] };
    const out = normalizeEditParams(input);
    expect(out).toEqual(input);
  });

  it('does not promote when edits have old/new (text replace)', () => {
    const input = { edits: [{ file: 'a.ts', old: 'x', new: 'y' }] };
    const out = normalizeEditParams(input);
    expect(out.mode).toBeUndefined();
    expect(out.file).toBeUndefined();
  });

  it('preserves per-edit content hash and exact-span metadata when promoting single line edit entry', () => {
    const edits = [{ line: 1, action: 'insert_before', content: 'x' }];
    const input = {
      edits: [{ file: 'h:aabb1122:10-20', line_edits: edits, content_hash: 'fresh-hash-1' }],
    };
    const out = normalizeEditParams(input);

    expect(out.file).toBe('h:aabb1122:10-20');
    expect(out.line_edits).toEqual(edits);
    expect(out.content_hash).toBe('fresh-hash-1');
    expect(out.edit_target_kind).toBe('exact_span');
    expect(out.edit_target_ref).toBe('h:aabb1122:10-20');
    expect(out.edit_target_range).toEqual([[10, 20]]);
  });

  it('canonicalizes shaped content hashes down to the base file hash', () => {
    const edits = [{ line: 1, action: 'insert_before', content: 'x' }];
    const input = {
      edits: [{ file: 'h:aabb1122:10-20', line_edits: edits, content_hash: 'h:aabb1122:10-20' }],
    };
    const out = normalizeEditParams(input);

    // canonicalizeContentHash now strips h: prefix and modifiers via canonicalizeSnapshotHash
    expect(out.content_hash).toBe('aabb1122');
  });

  it('prefers content_hash as the canonical public freshness field', () => {
    const out = normalizeEditParams({
      file: 'src/demo.ts',
      content_hash: 'h:feedbeef:sig',
      line_edits: [{ line: 1, action: 'delete' }],
    });

    expect(out.content_hash).toBe('feedbeef');
  });

  it('promotes top-level exact-span text edit to line_edits via auto-promotion', () => {
    const out = normalizeEditParams({
      file_path: 'h:aabb1122:10-20',
      content_hash: 'fresh-hash-1',
      edits: [{ old: 'before', new: 'after' }],
    });

    expect(out.line_edits).toEqual([{
      line: 10,
      end_line: 20,
      action: 'replace',
      content: 'after',
    }]);
    expect(out.file).toBe('h:aabb1122:10-20');
    expect(out.content_hash).toBe('fresh-hash-1');
    expect(out.edit_target_kind).toBe('exact_span');
    expect(out.edit_target_range).toEqual([[10, 20]]);
    expect(out.edits).toBeUndefined();
  });

  it('promotes legacy old/new edit to line_edits when edit_target_range is available', () => {
    const out = normalizeEditParams({
      edits: [{
        file: 'h:aabb1122:10-20',
        old: 'before',
        new: 'after',
        edit_target_range: [[10, 20]],
      }],
    });

    expect(out.line_edits).toEqual([{
      line: 10,
      end_line: 20,
      action: 'replace',
      content: 'after',
    }]);
    expect(out.file).toBe('h:aabb1122:10-20');
    expect(out.edits).toBeUndefined();
  });

  it('promotes legacy old/new edit to line_edits when start_line/end_line present', () => {
    const out = normalizeEditParams({
      file: 'src/api.ts',
      content_hash: 'feedbeef',
      edits: [{
        old: 'const x = 1;',
        new: 'const x = 2;',
        start_line: 5,
        end_line: 5,
      }],
    });

    expect(out.line_edits).toEqual([{
      line: 5,
      end_line: 5,
      action: 'replace',
      content: 'const x = 2;',
    }]);
    expect(out.file).toBe('src/api.ts');
    expect(out.content_hash).toBe('feedbeef');
    expect(out.edits).toBeUndefined();
  });

  it('does not promote legacy old/new when no line range info is available', () => {
    const out = normalizeEditParams({
      edits: [{ file: 'a.ts', old: 'x', new: 'y' }],
    });

    expect(out.line_edits).toBeUndefined();
    expect(out.edits).toBeDefined();
  });
});

describe('line_edits validation', () => {
  const mockCtx = {
    atlsBatchQuery: async () => ({}),
    store: () => ({ getStats: () => ({}), getPinnedCount: () => 0 }),
  } as unknown as Parameters<typeof handleEdit>[1];

  it('rejects invalid action', async () => {
    const out = await handleEdit(
      {
        file: 'a.ts',
        line_edits: [{ line: 1, action: 'unknown_action', content: 'x' }],
      },
      mockCtx
    );
    expect(out.ok).toBe(false);
    expect(out.summary ?? (out as { error?: string }).error).toMatch(/invalid action/);
    expect((out.content as { error_class?: string })?.error_class).toBe('invalid_line_edit');
    expect((out.content as { repro_pack?: { error_class?: string } })?.repro_pack?.error_class).toBe('invalid_line_edit');
  });

  it('defaults missing action to replace', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ h: 'h:result1234', old_h: 'h:before1234' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];
    const out = await handleEdit(
      {
        file: 'a.ts',
        content_hash: 'abc',
        line_edits: [{ line: 1, content: 'x' }],
      } as Record<string, unknown>,
      ctx,
    );
    expect(out.ok).toBe(true);
    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    const le = payload.line_edits as Array<Record<string, unknown>>;
    expect(le[0].action).toBe('replace');
  });

  it('accepts line as end or negative index', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({});
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];
    const out = await handleEdit(
      {
        file: 'a.ts',
        content_hash: 'abc',
        line_edits: [
          { line: 'end', action: 'insert_after', content: '// x' },
          { line: -1, action: 'replace', content: 'y' },
        ],
      },
      ctx,
    );
    expect(out.ok).toBe(true);
  });

  it('passes sequential line edits through without overlap rejection', async () => {
    // Sequential semantics: replace L3-L4 (end_line=4), then delete L4 is valid
    // (the delete targets the post-replace state, not the original).
    const atlsBatchQuery = vi.fn().mockResolvedValue({ h: 'h:after1234', old_h: 'h:before1234' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file: 'a.ts',
        content_hash: 'feedface',
        line_edits: [
          { line: 3, action: 'replace', end_line: 4, content: 'alpha' },
          { line: 4, action: 'delete' },
        ],
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    expect((payload.line_edits as unknown[]).length).toBe(2);
  });

  it('preserves sequential edit order without coalescing', async () => {
    // Sequential semantics: edits pass through in array order without merging.
    const atlsBatchQuery = vi.fn().mockResolvedValue({ h: 'h:after1234', old_h: 'h:before1234' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    await handleEdit(
      {
        file: 'a.ts',
        content_hash: 'feedface',
        line_edits: [
          { line: 3, action: 'replace', content: 'alpha' },
          { line: 4, action: 'replace', content: 'beta' },
        ],
      },
      ctx,
    );

    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    expect(payload.content_hash).toBe('feedface');
    expect((payload.line_edits as unknown[]).length).toBe(2);
  });

  it('rejects move without destination', async () => {
    const out = await handleEdit(
      {
        file: 'a.ts',
        line_edits: [{ line: 2, action: 'move' }],
      },
      mockCtx,
    );
    expect(out.ok).toBe(false);
    expect(out.summary ?? (out as { error?: string }).error).toMatch(/move requires destination/);
    expect((out.content as { error_class?: string })?.error_class).toBe('invalid_line_edit');
  });

  it('rejects move with invalid destination', async () => {
    const out = await handleEdit(
      {
        file: 'a.ts',
        line_edits: [{ line: 2, action: 'move', destination: 0 }],
      },
      mockCtx,
    );
    expect(out.ok).toBe(false);
    expect(out.summary ?? (out as { error?: string }).error).toMatch(/move requires destination/);
  });

  it('rejects move when reindent is non-boolean', async () => {
    const out = await handleEdit(
      {
        file: 'a.ts',
        line_edits: [{ line: 2, action: 'move', destination: 5, reindent: 'yes' as unknown as boolean }],
      },
      mockCtx,
    );
    expect(out.ok).toBe(false);
    expect(out.summary ?? (out as { error?: string }).error).toMatch(/reindent must be boolean/);
  });

  it('dispatches move line_edits to batch query', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ h: 'h:after1234', old_h: 'h:before1234' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    await handleEdit(
      {
        file: 'a.ts',
        content_hash: 'feedface',
        line_edits: [
          { line: 3, action: 'move', end_line: 4, destination: 10, reindent: true },
        ],
      },
      ctx,
    );

    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    expect(payload.line_edits).toEqual([
      { line: 3, action: 'move', end_line: 4, destination: 10, reindent: true },
    ]);
  });

  it('injects line/end_line from edit_target_range when line_edits omit them', async () => {
    invokeMock.mockResolvedValueOnce([
      { source: 'src/demo.ts', content: 'export const demo = 1;\n', tokens: 4 },
    ]);
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({ results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }] })
      .mockResolvedValueOnce({ h: 'h:result1234', old_h: 'h:fresh-hash-1' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];
    const out = await handleEdit(
      {
        file_path: 'h:aabb1122:15-50',
        line_edits: [{ content: 'replacement code' }],
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    const le = payload.line_edits as Array<Record<string, unknown>>;
    expect(le[0].line).toBe(15);
    expect(le[0].end_line).toBe(50);
    expect(le[0].action).toBe('replace');
    expect(le[0].content).toBe('replacement code');
  });

  it('injects content_hash from hash ref when not explicitly provided', async () => {
    invokeMock.mockResolvedValueOnce([
      { source: 'src/demo.ts', content: 'export const demo = 1;\n', tokens: 4 },
    ]);
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({ results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }] })
      .mockResolvedValueOnce({ h: 'h:result1234', old_h: 'h:fresh-hash-1' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];
    const out = await handleEdit(
      {
        file_path: 'h:feedbeef:10-20',
        line_edits: [{ content: 'new code' }],
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    expect(payload.content_hash).toBeDefined();
    expect(payload.edit_target_kind).toBe('exact_span');
  });

  it('does not override explicit line/end_line with edit_target_range', async () => {
    invokeMock.mockResolvedValueOnce([
      { source: 'src/demo.ts', content: 'export const demo = 1;\n', tokens: 4 },
    ]);
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({ results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }] })
      .mockResolvedValueOnce({ h: 'h:result1234', old_h: 'h:fresh-hash-1' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];
    const out = await handleEdit(
      {
        file_path: 'h:aabb1122:15-50',
        line_edits: [{ line: 20, end_line: 25, content: 'partial replacement' }],
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    const le = payload.line_edits as Array<Record<string, unknown>>;
    expect(le[0].line).toBe(20);
    expect(le[0].end_line).toBe(25);
  });
});

describe('freshness safety', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetContextStore();
  });

  it('persists blocked rebind outcomes on staged snippets', async () => {
    const store = useContextStore.getState();
    store.stageSnippet('stage:lost', 'const original = 1;', 'src/demo.ts', '2-2', 'rev-old', undefined, 'latest');
    useContextStore.setState((state) => ({
      stagedSnippets: new Map([...state.stagedSnippets].map(([key, snippet]) => [
        key,
        key === 'stage:lost'
          ? {
            ...snippet,
            suspectSince: Date.now(),
            freshness: 'shifted' as const,
            freshnessCause: 'same_file_prior_edit' as const,
            observedRevision: 'rev-new',
          }
          : snippet,
      ])),
    }));

    const atlsBatchQuery = vi.fn().mockResolvedValueOnce({
      results: [{ file: 'src/demo.ts', content: 'const different = 2;\nconst elseBlock = true;\n' }],
    });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file: 'src/demo.ts',
        lines: '2-2',
        edits: [{ file: 'src/demo.ts', old: 'before', new: 'after' }],
      },
      ctx,
    );

    expect(out.ok).toBe(false);
    expect((out.content as { error_class?: string })?.error_class).toBe('identity_lost');
    expect((out.content as { repro_pack?: { error_class?: string } })?.repro_pack?.error_class).toBe('identity_lost');
    expect(useContextStore.getState().stagedSnippets.get('stage:lost')?.lastRebind).toMatchObject({
      strategy: 'blocked',
      confidence: 'none',
    });
    expect(useContextStore.getState().stagedSnippets.get('stage:lost')?.lastRebind?.factors).toContain('identity_lost');
  });

  it('refreshes current file hashes before draft edits', async () => {
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-2', old_h: 'fresh-hash-1', f: 'src/demo.ts' }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        edits: [{ file: 'src/demo.ts', old: 'before', new: 'after' }],
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(1, 'context', { type: 'full', file_paths: ['src/demo.ts'] });
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(2, 'draft', expect.objectContaining({
      edits: [{ file: 'src/demo.ts', old: 'before', new: 'after', content_hash: 'fresh-hash-1', content_hash_refreshed: true }],
      stale_policy: 'follow_latest',
    }));
  });

  it('routes change.create through create_files semantics', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({
      created: ['src/new.ts'],
      skipped: [],
      errors: [],
    });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0 }),
    } as unknown as Parameters<typeof handleCreate>[1];

    const out = await handleCreate(
      {
        creates: [{ path: 'src/new.ts', content: 'export const value = 1;\n' }],
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenCalledWith('create_files', {
      files: [{ path: 'src/new.ts', content: 'export const value = 1;\n', overwrite: false }],
      overwrite: false,
    });
  });

  it('hydrates a top-level file_path text edit into a draftable single edit', async () => {
    invokeMock.mockResolvedValueOnce([
      { source: 'src/demo.ts', content: 'export const demo = 1;\n', tokens: 4 },
    ]);
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-2', old_h: 'fresh-hash-1', f: 'src/demo.ts' }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file_path: 'h:aabb1122:10-11',
        content_hash: 'stale-hash-0',
        edits: [{ old: 'before', new: 'after' }],
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(2, 'draft', {
      content_hash: 'fresh-hash-1',
      content_hash_refreshed: true,
      edit_target_ref: 'h:aabb1122:10-11',
      edit_target_kind: 'exact_span',
      edit_target_range: [[10, 11]],
      edit_target_hash: 'fresh-hash-1',
      file: 'src/demo.ts',
      line_edits: [{
        line: 10,
        end_line: 11,
        action: 'replace',
        content: 'after',
      }],
      stale_policy: 'follow_latest',
    });
  });

  it('resolves hash-only file targets before freshness refresh', async () => {
    invokeMock.mockResolvedValueOnce([
      { source: 'src/demo.ts', content: 'export const demo = 1;\n', tokens: 4 },
    ]);
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-2', old_h: 'fresh-hash-1', f: 'src/demo.ts' }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file_path: 'h:aabb1122',
        line_edits: [{ line: 1, action: 'insert_before', content: '// fresh' }],
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('batch_resolve_hash_refs', { refs: ['h:aabb1122'] });
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(1, 'context', { type: 'full', file_paths: ['src/demo.ts'] });
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(2, 'draft', {
      file: 'src/demo.ts',
      line_edits: [{ line: 1, action: 'insert_before', content: '// fresh' }],
      content_hash: 'fresh-hash-1',
      content_hash_refreshed: true,
      edit_target_ref: 'h:aabb1122',
      edit_target_kind: 'file',
      edit_target_hash: 'fresh-hash-1',
      stale_policy: 'follow_latest',
    });
  });

  it('does not block exact-file freshness for sibling paths', async () => {
    const store = useContextStore.getState();
    const siblingHash = store.addChunk('export const sibling = 1;\n', 'file', 'src/foo.tsx');
    useContextStore.setState((state) => ({
      chunks: new Map([...state.chunks].map(([key, chunk]) => [
        key,
        chunk.shortHash === siblingHash ? { ...chunk, suspectSince: Date.now() } : chunk,
      ])),
    }));
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ batch: [{ h: 'next-hash', old_h: 'old-hash', f: 'src/foo.ts' }] });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        edits: [{ file: 'src/foo.ts', old: 'before', new: 'after' }],
        require_fresh_read: true,
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(2, 'draft', {
      edits: [{ file: 'src/foo.ts', old: 'before', new: 'after' }],
      require_fresh_read: true,
      stale_policy: 'follow_latest',
    });
  });

  it('retries stale text edits once after pre-refresh', async () => {
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        error: 'hash mismatch',
        error_class: 'stale_hash',
      })
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-2' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-3', old_h: 'fresh-hash-2', f: 'src/demo.ts' }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        edits: [{ file: 'src/demo.ts', old: 'before', new: 'after' }],
        retry_on_failure: true,
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(4, 'draft', {
      edits: [{ file: 'src/demo.ts', old: 'before', new: 'after', content_hash: 'fresh-hash-2', content_hash_refreshed: true }],
      retry_on_failure: true,
      stale_policy: 'follow_latest',
    });
  });

  it('does not block mutating edits on freshness policy alone when pre-refresh/retry can recover', async () => {
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-2', old_h: 'fresh-hash-1', f: 'src/demo.ts' }],
        edit_warnings: [],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    useContextStore.setState((state) => ({
      ...state,
      promptMemory: {
        ...state.promptMemory,
        chunks: [{
          id: 'stale-demo',
          hash: 'h:stale01',
          filePath: 'src/demo.ts',
          type: 'smart',
          content: 'const demo = 1;',
          summary: 'const demo = 1;',
          addedAt: Date.now() - 60_000,
          lastAccessedAt: Date.now() - 60_000,
          metadata: { sourceRevision: 'rev-old', viewKind: 'latest' },
        }],
      },
    }));

    const out = await handleEdit(
      {
        file: 'src/demo.ts',
        line_edits: [{ line: 1, action: 'insert_before', content: '// fresh' }],
        require_fresh_read: true,
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenCalledWith('draft', expect.objectContaining({
      file: 'src/demo.ts',
      stale_policy: 'follow_latest',
      line_edits: [{ line: 1, action: 'insert_before', content: '// fresh' }],
    }));
  });
  it('preserves stale_hash_followed_latest warnings after pre-refresh line_edits', async () => {
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-2', old_h: 'fresh-hash-1', f: 'src/demo.ts' }],
        edit_warnings: [{
          file: 'src/demo.ts',
          warning: 'stale_hash_followed_latest',
          error_class: 'stale_hash',
          expected_hash: 'stale-hash-0',
          actual_hash: 'fresh-hash-1',
          applied_against_latest: true,
        }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file: 'src/demo.ts',
        content_hash: 'stale-hash-0',
        line_edits: [{ line: 1, action: 'insert_before', content: '// fresh' }],
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    const warnings = (out.content as { edit_warnings?: unknown[] }).edit_warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as Record<string, unknown>).warning).toBe('stale_hash_followed_latest');
  });

  it('retries exact-span range_drifted failures once after refresh', async () => {
    invokeMock.mockResolvedValueOnce([
      { source: 'src/demo.ts', content: 'export const demo = 1;\n', tokens: 4 },
    ]);
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        error: 'all_edits_failed',
        error_class: 'range_drifted',
        edit_warnings: [{
          file: 'src/demo.ts',
          warning: 'range_drifted',
          error_class: 'range_drifted',
        }],
      })
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-2' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-3', old_h: 'fresh-hash-2', f: 'src/demo.ts' }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        edits: [{
          file: 'h:aabb1122:10-12',
          old: 'before',
          new: 'after',
        }],
        retry_on_failure: true,
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(4, 'draft', {
      content_hash: 'fresh-hash-2',
      content_hash_refreshed: true,
      edit_target_ref: 'h:aabb1122:10-12',
      edit_target_kind: 'exact_span',
      edit_target_range: [[10, 12]],
      edit_target_hash: 'fresh-hash-2',
      file: 'src/demo.ts',
      line_edits: [{
        line: 10,
        end_line: 12,
        action: 'replace',
        content: 'after',
      }],
      stale_policy: 'follow_latest',
    });
  });

  it('retries exact-span span_out_of_range failures once after refresh', async () => {
    invokeMock.mockResolvedValueOnce([
      { source: 'src/demo.ts', content: 'export const demo = 1;\n', tokens: 4 },
    ]);
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        error: 'all_edits_failed',
        error_class: 'span_out_of_range',
        edit_warnings: [{
          file: 'src/demo.ts',
          warning: 'span_out_of_range',
          error_class: 'span_out_of_range',
          start_line: 10,
          end_line: 12,
          line_count: 5,
        }],
      })
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-2' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-3', old_h: 'fresh-hash-2', f: 'src/demo.ts' }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        edits: [{
          file: 'h:aabb1122:10-12',
          old: 'before',
          new: 'after',
        }],
        retry_on_failure: true,
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenCalledTimes(4);
  });

  it('refreshes exact-span edit_target_hash alongside content_hash before draft edits', async () => {
    invokeMock.mockResolvedValueOnce([
      { source: 'src/demo.ts', content: 'export const demo = 1;\n', tokens: 4 },
    ]);
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-2', old_h: 'fresh-hash-1', f: 'src/demo.ts' }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        edits: [{
          file: 'h:aabb1122:10-12',
          old: 'before',
          new: 'after',
          content_hash: 'h:aabb1122',
        }],
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(2, 'draft', {
      content_hash: 'fresh-hash-1',
      content_hash_refreshed: true,
      edit_target_ref: 'h:aabb1122:10-12',
      edit_target_kind: 'exact_span',
      edit_target_range: [[10, 12]],
      edit_target_hash: 'fresh-hash-1',
      file: 'src/demo.ts',
      line_edits: [{
        line: 10,
        end_line: 12,
        action: 'replace',
        content: 'after',
      }],
      stale_policy: 'follow_latest',
    });
  });

  it('fails cleanly when hash target cannot resolve to a file-backed source', async () => {
    invokeMock.mockResolvedValueOnce([null]);
    const atlsBatchQuery = vi.fn().mockResolvedValueOnce({
      error: 'hash mismatch',
      error_class: 'stale_hash',
    });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file_path: 'h:deadbeef',
        line_edits: [{ line: 1, action: 'insert_before', content: '// fresh' }],
        retry_on_failure: true,
      },
      ctx,
    );

    expect(out.ok).toBe(false);
    expect(atlsBatchQuery).toHaveBeenCalledTimes(1);
    expect(out.summary).toMatch(/stale_hash/i);
  });

  it('normalizes refreshed file keys before reattaching content hashes', async () => {
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-2', old_h: 'fresh-hash-1', f: 'SRC\\DEMO.ts' }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        edits: [{ file: 'SRC\\DEMO.ts', old: 'before', new: 'after' }],
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(2, 'draft', {
      edits: [{ file: 'SRC\\DEMO.ts', old: 'before', new: 'after', content_hash: 'fresh-hash-1', content_hash_refreshed: true }],
      stale_policy: 'follow_latest',
    });
  });

  it('returns structured rebind metadata on successful medium-confidence edits', async () => {
    const store = useContextStore.getState();
    store.stageSnippet('stage:symbol', 'function target() {\n  return 2;\n}', 'src/demo.ts', '2-4', 'rev-old', 'fn(target)', 'latest');
    useContextStore.setState((state) => ({
      stagedSnippets: new Map([...state.stagedSnippets].map(([key, snippet]) => [
        key,
        key === 'stage:symbol'
          ? {
            ...snippet,
            suspectSince: Date.now(),
            freshness: 'shifted' as const,
            freshnessCause: 'same_file_prior_edit' as const,
            observedRevision: 'rev-new',
          }
          : snippet,
      ])),
    }));

    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content: 'const prelude = true;\nfunction target() {\n  return 2;\n}\n' }],
      })
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-2', old_h: 'fresh-hash-1', f: 'src/demo.ts' }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file: 'src/demo.ts',
        lines: '2-4',
        edits: [{ file: 'src/demo.ts', old: 'before', new: 'after' }],
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect((out.content as { rebind?: { action?: string; strategy?: string; confidence?: string } })?.rebind).toMatchObject({
      action: 'proceed_with_note',
      strategy: 'symbol_identity',
      confidence: 'medium',
    });
    expect((out.content as { rebind?: { repro_pack?: { operation?: string } } })?.rebind?.repro_pack?.operation).toBe('draft');
  });

  it('rejects display-only shaped refs before draft dispatch', async () => {
    const atlsBatchQuery = vi.fn();
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file_path: 'h:aabb1122:sig',
        line_edits: [{ line: 1, action: 'insert_before', content: '// fresh' }],
      },
      ctx,
    );

    expect(out.ok).toBe(false);
    expect(out.summary).toMatch(/edit_target_not_edit_safe/i);
    expect(atlsBatchQuery).not.toHaveBeenCalled();
  });

  it('promotes exact-span text edit with display-prefixed old text to line_edits', async () => {
    invokeMock.mockResolvedValueOnce([
      { source: 'src/demo.ts', content: 'export const demo = 1;\n', tokens: 4 },
    ]);
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-2', old_h: 'fresh-hash-1', f: 'src/demo.ts' }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        edits: [{
          file: 'h:aabb1122:10-11',
          old: '  10|before\n  11|after',
          new: 'replaced',
        }],
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(2, 'draft', {
      content_hash: 'fresh-hash-1',
      content_hash_refreshed: true,
      edit_target_ref: 'h:aabb1122:10-11',
      edit_target_kind: 'exact_span',
      edit_target_range: [[10, 11]],
      edit_target_hash: 'fresh-hash-1',
      file: 'src/demo.ts',
      line_edits: [{
        line: 10,
        end_line: 11,
        action: 'replace',
        content: 'replaced',
      }],
      stale_policy: 'follow_latest',
    });
  });

  it('promotes edits[].file_path exact-span refs to line_edits before draft dispatch', async () => {
    invokeMock.mockResolvedValueOnce([
      { source: 'src/demo.ts', content: 'export const demo = 1;\n', tokens: 4 },
    ]);
    const atlsBatchQuery = vi
      .fn()
      .mockResolvedValueOnce({
        results: [{ file: 'src/demo.ts', content_hash: 'fresh-hash-1' }],
      })
      .mockResolvedValueOnce({
        batch: [{ h: 'fresh-hash-2', old_h: 'fresh-hash-1', f: 'src/demo.ts' }],
      });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        edits: [{
          file_path: 'h:aabb1122:10-11',
          old: '  10|before\n  11|after',
          new: 'replaced',
        }],
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenNthCalledWith(2, 'draft', {
      content_hash: 'fresh-hash-1',
      content_hash_refreshed: true,
      edit_target_ref: 'h:aabb1122:10-11',
      edit_target_kind: 'exact_span',
      edit_target_range: [[10, 11]],
      edit_target_hash: 'fresh-hash-1',
      file: 'src/demo.ts',
      line_edits: [{
        line: 10,
        end_line: 11,
        action: 'replace',
        content: 'replaced',
      }],
      stale_policy: 'follow_latest',
    });
  });
});

describe('handleDelete routing and confirm', () => {
  beforeEach(() => {
    resetContextStore();
    invokeMock.mockReset();
  });

  it('routes to delete_files with confirm:true by default', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ deleted: ['a.ts'], status: 'ok' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0 }),
    } as unknown as Parameters<typeof handleDelete>[1];

    const out = await handleDelete({ file_paths: ['a.ts'] }, ctx);
    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenCalledWith('delete_files', expect.objectContaining({
      file_paths: ['a.ts'],
      confirm: true,
    }));
  });

  it('does not set confirm:true when dry_run is explicitly true', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ deleted: ['a.ts'], dry_run: true, status: 'preview' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0 }),
    } as unknown as Parameters<typeof handleDelete>[1];

    const out = await handleDelete({ file_paths: ['a.ts'], dry_run: true }, ctx);
    expect(out.ok).toBe(true);
    expect(atlsBatchQuery).toHaveBeenCalledWith('delete_files', expect.objectContaining({
      file_paths: ['a.ts'],
      confirm: false,
      dry_run: true,
    }));
  });

  it('strips mode key so it does not leak to backend', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ deleted: ['a.ts'], status: 'ok' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0 }),
    } as unknown as Parameters<typeof handleDelete>[1];

    await handleDelete({ file_paths: ['a.ts'], mode: 'delete_files' }, ctx);
    const passedParams = atlsBatchQuery.mock.calls[0][1];
    expect(passedParams).not.toHaveProperty('mode');
  });
});

describe('resolveEditOperation with deletes', () => {
  beforeEach(() => {
    resetContextStore();
    invokeMock.mockReset();
  });

  it('injects confirm:true when deletes array is present', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ deleted: ['b.ts'], status: 'ok' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0 }),
    } as unknown as Parameters<typeof handleEdit>[1];

    await handleEdit({ deletes: ['b.ts'] }, ctx);
    expect(atlsBatchQuery).toHaveBeenCalledWith('delete_files', expect.objectContaining({
      file_paths: ['b.ts'],
      confirm: true,
    }));
  });

  it('respects explicit dry_run:true on edit+deletes path', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ deleted: ['b.ts'], dry_run: true, status: 'preview' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0 }),
    } as unknown as Parameters<typeof handleEdit>[1];

    await handleEdit({ deletes: ['b.ts'], dry_run: true }, ctx);
    expect(atlsBatchQuery).toHaveBeenCalledWith('delete_files', expect.objectContaining({
      file_paths: ['b.ts'],
      confirm: false,
    }));
  });
});

// ---------------------------------------------------------------------------
// handleRollback freshness invalidation
// ---------------------------------------------------------------------------

const { clearFreshnessJournal } = await import('../../../services/freshnessJournal');
const clearFreshnessJournalMock = vi.mocked(clearFreshnessJournal);

describe('handleRollback freshness invalidation', () => {

  beforeEach(() => {
    resetContextStore();
    invokeMock.mockReset();
    clearFreshnessJournalMock.mockClear();
  });

  function makeRollbackCtx(atlsBatchQuery: ReturnType<typeof vi.fn>) {
    const store = useContextStore.getState();
    return {
      atlsBatchQuery,
      store: () => store,
    } as unknown as Parameters<typeof handleRollback>[1];
  }

  it('clears freshness journal for restored file path', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({
      status: 'ok', restored: [{ file: 'src/lib.rs', hash: 'aaa111' }],
    });
    const ctx = makeRollbackCtx(atlsBatchQuery);

    await handleRollback({ restore: [{ file: 'src/lib.rs', hash: 'aaa111' }] }, ctx);

    expect(clearFreshnessJournalMock).toHaveBeenCalledWith('src/lib.rs');
  });

  it('calls reconcileSourceRevision with restored hash', async () => {
    const store = useContextStore.getState();
    const spy = vi.spyOn(store, 'reconcileSourceRevision');
    const atlsBatchQuery = vi.fn().mockResolvedValue({ status: 'ok' });
    const ctx = makeRollbackCtx(atlsBatchQuery);

    await handleRollback({ restore: [{ file: 'src/lib.rs', hash: 'h:aaa111' }] }, ctx);

    expect(spy).toHaveBeenCalledWith('src/lib.rs', 'aaa111');
    spy.mockRestore();
  });

  it('calls clearReadSpansForPaths with restored file paths', async () => {
    const store = useContextStore.getState();
    const spy = vi.spyOn(store, 'clearReadSpansForPaths');
    const atlsBatchQuery = vi.fn().mockResolvedValue({ status: 'ok' });
    const ctx = makeRollbackCtx(atlsBatchQuery);

    await handleRollback({ restore: [{ file: 'src/lib.rs', hash: 'aaa' }] }, ctx);

    expect(spy).toHaveBeenCalledWith(['src/lib.rs']);
    spy.mockRestore();
  });

  it('calls invalidateAwarenessForPaths with restored file paths', async () => {
    const store = useContextStore.getState();
    const spy = vi.spyOn(store, 'invalidateAwarenessForPaths');
    const atlsBatchQuery = vi.fn().mockResolvedValue({ status: 'ok' });
    const ctx = makeRollbackCtx(atlsBatchQuery);

    await handleRollback({ restore: [{ file: 'src/lib.rs', hash: 'aaa' }] }, ctx);

    expect(spy).toHaveBeenCalledWith(['src/lib.rs']);
    spy.mockRestore();
  });

  it('calls bumpWorkspaceRev with restored file paths', async () => {
    const store = useContextStore.getState();
    const spy = vi.spyOn(store, 'bumpWorkspaceRev');
    const atlsBatchQuery = vi.fn().mockResolvedValue({ status: 'ok' });
    const ctx = makeRollbackCtx(atlsBatchQuery);

    await handleRollback({ restore: [{ file: 'src/lib.rs', hash: 'aaa' }] }, ctx);

    expect(spy).toHaveBeenCalledWith(['src/lib.rs']);
    spy.mockRestore();
  });

  it('still clears BB edit lessons after rollback', async () => {
    const store = useContextStore.getState();
    store.setBlackboardEntry('edit:lib.rs', 'stale edit lesson');
    store.setBlackboardEntry('err:lib.rs', 'stale error');
    const atlsBatchQuery = vi.fn().mockResolvedValue({ status: 'ok' });
    const ctx = makeRollbackCtx(atlsBatchQuery);

    await handleRollback({ restore: [{ file: 'src/lib.rs', hash: 'aaa' }] }, ctx);

    expect(store.getBlackboardEntry('edit:lib.rs')).toBeNull();
    expect(store.getBlackboardEntry('err:lib.rs')).toBeNull();
  });

  it('invalidates all files in a multi-file rollback', async () => {
    const store = useContextStore.getState();
    const clearSpansSpy = vi.spyOn(store, 'clearReadSpansForPaths');
    const awarenessSpy = vi.spyOn(store, 'invalidateAwarenessForPaths');
    const reconcileSpy = vi.spyOn(store, 'reconcileSourceRevision');
    const atlsBatchQuery = vi.fn().mockResolvedValue({ status: 'ok' });
    const ctx = makeRollbackCtx(atlsBatchQuery);

    await handleRollback({
      restore: [
        { file: 'src/lib.rs', hash: 'aaa111' },
        { file: 'src/pty.rs', hash: 'bbb222' },
      ],
    }, ctx);

    expect(clearFreshnessJournalMock).toHaveBeenCalledWith('src/lib.rs');
    expect(clearFreshnessJournalMock).toHaveBeenCalledWith('src/pty.rs');
    expect(reconcileSpy).toHaveBeenCalledWith('src/lib.rs', 'aaa111');
    expect(reconcileSpy).toHaveBeenCalledWith('src/pty.rs', 'bbb222');
    expect(clearSpansSpy).toHaveBeenCalledWith(['src/lib.rs', 'src/pty.rs']);
    expect(awarenessSpy).toHaveBeenCalledWith(['src/lib.rs', 'src/pty.rs']);

    clearSpansSpy.mockRestore();
    awarenessSpy.mockRestore();
    reconcileSpy.mockRestore();
  });
});

/**
 * Nightmare / hallucination cases: sloppy model output we can sometimes autocorrect
 * (count→end_line, replace_span_lines, string line digits) vs hard failures (floats, NaN).
 */
describe('line_edits hallucination / nightmare scenarios', () => {
  beforeEach(() => {
    resetContextStore();
  });

  it('autocorrects legacy count into end_line when model hallucinates span (count>1)', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ h: 'h:after', old_h: 'h:before' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file: 'src/nightmare.ts',
        content_hash: 'abc',
        line_edits: [{ line: 10, action: 'replace', content: 'BLOCK', count: 4 }],
      } as Record<string, unknown>,
      ctx,
    );

    expect(out.ok).toBe(true);
    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    const le = payload.line_edits as Array<Record<string, unknown>>;
    expect(le[0].end_line).toBe(13);
    expect(le[0].count).toBeUndefined();
  });

  it('autocorrects replace_span_lines at step level into end_line for single replace', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ h: 'h:after', old_h: 'h:before' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file: 'src/span.ts',
        content_hash: 'abc',
        replace_span_lines: 20,
        line_edits: [{ line: 5, action: 'replace', content: 'WALL' }],
      } as Record<string, unknown>,
      ctx,
    );

    expect(out.ok).toBe(true);
    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    const le = payload.line_edits as Array<Record<string, unknown>>;
    expect(le[0].end_line).toBe(24);
  });

  it('accepts stringified line digits (JSON) as valid line anchor', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ h: 'h:after', old_h: 'h:before' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file: 'src/strline.ts',
        content_hash: 'abc',
        line_edits: [{ line: '  42  ', action: 'replace', content: 'ok' }],
      } as Record<string, unknown>,
      ctx,
    );

    expect(out.ok).toBe(true);
    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    expect((payload.line_edits as Array<Record<string, unknown>>)[0].line).toBe('  42  ');
  });

  it('rejects float line hallucination (3.14)', async () => {
    const out = await handleEdit(
      {
        file: 'src/float.ts',
        content_hash: 'abc',
        line_edits: [{ line: 3.14, action: 'replace', content: 'x' }],
      },
      {
        atlsBatchQuery: async () => ({}),
        store: () => ({ getStats: () => ({}), getPinnedCount: () => 0 }),
      } as unknown as Parameters<typeof handleEdit>[1],
    );
    expect(out.ok).toBe(false);
    expect(out.summary ?? (out as { error?: string }).error).toMatch(/integer|line/i);
  });

  it('rejects NaN line', async () => {
    const out = await handleEdit(
      {
        file: 'src/nan.ts',
        content_hash: 'abc',
        line_edits: [{ line: Number.NaN, action: 'replace', content: 'x' }],
      },
      {
        atlsBatchQuery: async () => ({}),
        store: () => ({ getStats: () => ({}), getPinnedCount: () => 0 }),
      } as unknown as Parameters<typeof handleEdit>[1],
    );
    expect(out.ok).toBe(false);
  });

  it('rejects move with hallucinated float destination', async () => {
    const out = await handleEdit(
      {
        file: 'src/mv.ts',
        content_hash: 'abc',
        line_edits: [{ line: 2, action: 'move', destination: 3.5 as unknown as number }],
      },
      {
        atlsBatchQuery: async () => ({}),
        store: () => ({ getStats: () => ({}), getPinnedCount: () => 0 }),
      } as unknown as Parameters<typeof handleEdit>[1],
    );
    expect(out.ok).toBe(false);
    expect((out.content as { error_class?: string })?.error_class).toBe('invalid_line_edit');
  });

  it('model swaps line and end_line (reversed span) — still passes TS; Rust clamps replace', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ h: 'h:after', old_h: 'h:before' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    const out = await handleEdit(
      {
        file: 'src/inverted.ts',
        content_hash: 'abc',
        line_edits: [{ line: 20, end_line: 5, action: 'replace', content: '?' }],
      },
      ctx,
    );

    expect(out.ok).toBe(true);
    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    const le = payload.line_edits as Array<Record<string, unknown>>;
    expect(le[0].line).toBe(20);
    expect(le[0].end_line).toBe(5);
  });
});
