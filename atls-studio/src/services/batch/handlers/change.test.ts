/**
 * Unit tests for change.edit normalization.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useContextStore } from '../../../stores/contextStore';
import { handleCreate, handleDelete, handleEdit, normalizeEditParams, validateAnchorReplaceContent } from './change';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

function resetContextStore() {
  useContextStore.getState().resetSession();
  useContextStore.setState({ hashStack: [], editHashStack: [] });
}

describe('normalizeEditParams', () => {
  it('promotes edits: [{ file, line_edits }] to top-level { file, line_edits } and strips edits', () => {
    const edits = [{ line: 1, action: 'insert_before', content: 'x' }];
    const input = { edits: [{ file: 'a.ts', line_edits: edits }] };
    const out = normalizeEditParams(input);
    expect(out.file).toBe('a.ts');
    expect(out.line_edits).toEqual(edits);
    expect(out.edits).toBeUndefined();
  });

  it('promotes edits: [{ file_path, line_edits }] (anchor-style) to top-level', () => {
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
    expect(out.snapshot_hash).toBe('fresh-hash-1');
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
    expect(out.snapshot_hash).toBe('aabb1122');
  });

  it('prefers snapshot_hash as the canonical public freshness field', () => {
    const out = normalizeEditParams({
      file: 'src/demo.ts',
      snapshot_hash: 'h:feedbeef:sig',
      line_edits: [{ line: 1, action: 'delete' }],
    });

    expect(out.snapshot_hash).toBe('feedbeef');
    expect(out.content_hash).toBe('feedbeef');
  });

  it('inherits top-level file target metadata into a single text edit entry', () => {
    const out = normalizeEditParams({
      file_path: 'h:aabb1122:10-20',
      content_hash: 'fresh-hash-1',
      edits: [{ old: 'before', new: 'after' }],
    });

    expect(out.edits).toEqual([{
      file: 'h:aabb1122:10-20',
      old: 'before',
      new: 'after',
      snapshot_hash: 'fresh-hash-1',
      content_hash: 'fresh-hash-1',
      edit_target_ref: 'h:aabb1122:10-20',
      edit_target_kind: 'exact_span',
      edit_target_range: [[10, 20]],
      edit_target_hash: 'h:aabb1122',
    }]);
  });
});

describe('validateAnchorReplaceContent', () => {
  it('accepts balanced multiline anchor replace for .rs', () => {
    expect(() =>
      validateAnchorReplaceContent('x.rs', [
        { anchor: 'fn', action: 'replace', content: 'fn foo() {\n  bar()\n}' },
      ])
    ).not.toThrow();
  });

  it('rejects unbalanced multiline anchor replace (depth !== 0)', () => {
    expect(() =>
      validateAnchorReplaceContent('x.rs', [
        { anchor: 'fn', action: 'replace', content: 'fn foo() {\n  bar()' },
      ])
    ).toThrow(/unbalanced braces/);
  });

  it('includes Rust-specific hint when rejecting .rs', () => {
    try {
      validateAnchorReplaceContent('src/lib.rs', [
        { anchor: 'fn', action: 'replace', content: 'fn bad() {\n  x' },
      ]);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('For Rust:');
    }
  });

  it('rejects multiline content with extra closing brace', () => {
    expect(() =>
      validateAnchorReplaceContent('a.ts', [
        { symbol: 'bar', action: 'replace', content: 'x\n}\n}' },
      ])
    ).toThrow(/unbalanced braces/);
  });

  it('skips non-replace or line-based edits', () => {
    expect(() =>
      validateAnchorReplaceContent('x.rs', [
        { line: 1, action: 'replace', content: '{\n  x' },
        { anchor: 'y', action: 'insert_before', content: 'a\nb\nc' },
      ])
    ).not.toThrow();
  });

  it('skips single-line anchor replace', () => {
    expect(() =>
      validateAnchorReplaceContent('x.rs', [{ anchor: 'fn', action: 'replace', content: 'single' }])
    ).not.toThrow();
  });

  it('skips non-brace-language files', () => {
    expect(() =>
      validateAnchorReplaceContent('script.py', [
        { anchor: 'def', action: 'replace', content: 'def foo():\n  pass\n  # no close' },
      ])
    ).not.toThrow();
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

  it('rejects missing action', async () => {
    const out = await handleEdit(
      {
        file: 'a.ts',
        line_edits: [{ line: 1, content: 'x' }],
      } as Record<string, unknown>,
      mockCtx
    );
    expect(out.ok).toBe(false);
    expect(out.summary ?? (out as { error?: string }).error).toMatch(/requires action/);
    expect((out.content as { error_class?: string })?.error_class).toBe('invalid_line_edit');
  });

  it('rejects overlapping explicit line edits before dispatch', async () => {
    const out = await handleEdit(
      {
        file: 'a.ts',
        line_edits: [
          { line: 3, action: 'replace', count: 2, content: 'alpha' },
          { line: 4, action: 'delete', count: 1 },
        ],
      },
      mockCtx
    );
    expect(out.ok).toBe(false);
    expect(out.summary ?? (out as { error?: string }).error).toMatch(/overlap/i);
    expect((out.content as { error_class?: string })?.error_class).toBe('overlapping_line_edits');
    expect((out.content as { repro_pack?: { target_files?: string[] } })?.repro_pack?.target_files).toEqual(['a.ts']);
  });

  it('coalesces adjacent explicit replace edits before dispatch', async () => {
    const atlsBatchQuery = vi.fn().mockResolvedValue({ h: 'h:after1234', old_h: 'h:before1234' });
    const ctx = {
      atlsBatchQuery,
      store: () => ({ getStats: () => ({}), getPinnedCount: () => 0, recordMemoryEvent: () => {}, recordRebindOutcomes: () => {} }),
    } as unknown as Parameters<typeof handleEdit>[1];

    await handleEdit(
      {
        file: 'a.ts',
        snapshot_hash: 'feedface',
        line_edits: [
          { line: 3, action: 'replace', count: 1, content: 'alpha' },
          { line: 4, action: 'replace', count: 1, content: 'beta' },
        ],
      },
      ctx,
    );

    const [, payload] = atlsBatchQuery.mock.calls.at(-1)! as [string, Record<string, unknown>];
    expect(payload.snapshot_hash).toBe('feedface');
    expect(payload.content_hash).toBe('feedface');
    expect(payload.line_edits).toEqual([
      { line: 3, action: 'replace', count: 2, content: 'alpha\nbeta' },
    ]);
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
      edits: [{ file: 'src/demo.ts', old: 'before', new: 'after', content_hash: 'fresh-hash-1', snapshot_hash: 'fresh-hash-1', content_hash_refreshed: true }],
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
      file_path: 'src/demo.ts',
      content_hash: 'fresh-hash-1',
      snapshot_hash: 'fresh-hash-1',
      content_hash_refreshed: true,
      edit_target_ref: 'h:aabb1122:10-11',
      edit_target_kind: 'exact_span',
      edit_target_range: [[10, 11]],
      edit_target_hash: 'fresh-hash-1',
      edits: [{
        file: 'src/demo.ts',
        old: 'before',
        new: 'after',
        content_hash: 'fresh-hash-1',
        snapshot_hash: 'fresh-hash-1',
        content_hash_refreshed: true,
        edit_target_ref: 'h:aabb1122:10-11',
        edit_target_kind: 'exact_span',
        edit_target_range: [[10, 11]],
        edit_target_hash: 'fresh-hash-1',
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
      snapshot_hash: 'fresh-hash-1',
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
      edits: [{ file: 'src/demo.ts', old: 'before', new: 'after', content_hash: 'fresh-hash-2', snapshot_hash: 'fresh-hash-2', content_hash_refreshed: true }],
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
      edits: [{
        file: 'src/demo.ts',
        old: 'before',
        new: 'after',
        content_hash: 'fresh-hash-2',
        snapshot_hash: 'fresh-hash-2',
        content_hash_refreshed: true,
        edit_target_ref: 'h:aabb1122:10-12',
        edit_target_kind: 'exact_span',
        edit_target_range: [[10, 12]],
        edit_target_hash: 'fresh-hash-2',
      }],
      retry_on_failure: true,
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
      edits: [{
        file: 'src/demo.ts',
        old: 'before',
        new: 'after',
        content_hash: 'fresh-hash-1',
        snapshot_hash: 'fresh-hash-1',
        content_hash_refreshed: true,
        edit_target_ref: 'h:aabb1122:10-12',
        edit_target_kind: 'exact_span',
        edit_target_range: [[10, 12]],
        edit_target_hash: 'fresh-hash-1',
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
      edits: [{ file: 'SRC\\DEMO.ts', old: 'before', new: 'after', content_hash: 'fresh-hash-1', snapshot_hash: 'fresh-hash-1', content_hash_refreshed: true }],
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

  it('uses exact-span target hash and strips read_lines numbering for draft old text', async () => {
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
      edits: [{
        file: 'src/demo.ts',
        old: 'before\nafter',
        new: 'replaced',
        content_hash: 'fresh-hash-1',
        snapshot_hash: 'fresh-hash-1',
        content_hash_refreshed: true,
        edit_target_ref: 'h:aabb1122:10-11',
        edit_target_kind: 'exact_span',
        edit_target_range: [[10, 11]],
        edit_target_hash: 'fresh-hash-1',
      }],
      stale_policy: 'follow_latest',
    });
  });

  it('canonicalizes edits[].file_path exact-span refs to file before draft dispatch', async () => {
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
      edits: [{
        file: 'src/demo.ts',
        old: 'before\nafter',
        new: 'replaced',
        content_hash: 'fresh-hash-1',
        snapshot_hash: 'fresh-hash-1',
        content_hash_refreshed: true,
        edit_target_ref: 'h:aabb1122:10-11',
        edit_target_kind: 'exact_span',
        edit_target_range: [[10, 11]],
        edit_target_hash: 'fresh-hash-1',
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
