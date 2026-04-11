import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useContextStore } from '../stores/contextStore';
import { getAtlsBatchQueryTimeoutMs, resolveSearchRefs } from './toolHelpers';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe('getAtlsBatchQueryTimeoutMs', () => {
  it('uses 300s floor for refactor (non-rollback)', () => {
    expect(getAtlsBatchQueryTimeoutMs('refactor', { action: 'execute' }, 120_000)).toBe(300_000);
    expect(getAtlsBatchQueryTimeoutMs('change.refactor', {}, 50_000)).toBe(300_000);
  });

  it('uses 90s for refactor rollback (not the 300s refactor bucket)', () => {
    expect(getAtlsBatchQueryTimeoutMs('refactor', { action: 'rollback' }, 120_000)).toBe(90_000);
  });

  it('passes through default timeout for other operations', () => {
    expect(getAtlsBatchQueryTimeoutMs('context', { type: 'full' }, 120_000)).toBe(120_000);
  });
});

describe('resolveSearchRefs', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useContextStore.getState().resetSession();
    useContextStore.setState({ hashStack: [], editHashStack: [] });
  });

  it('resolves bare search refs through the canonical parser', async () => {
    invokeMock.mockResolvedValueOnce([
      { hash: 'abc12345', source: 'src/a.ts', line: 1, symbol: 'a', kind: 'fn', relevance: 1 },
    ]);

    const resolved = await resolveSearchRefs({ ref: 'h:@search(auth flow,limit=5,tier=high)' }, 1);

    expect(invokeMock).toHaveBeenCalledWith('resolve_search_selector', {
      query: 'auth flow',
      limit: 5,
      tier: 'high',
    });
    expect(resolved).toEqual({ ref: 'h:abc12345' });
  });

  it('preserves modifiers when replacing multi-match search refs', async () => {
    invokeMock.mockResolvedValueOnce([
      { hash: 'abc12345', source: 'src/a.ts', line: 1, symbol: 'a', kind: 'fn', relevance: 1 },
      { hash: 'def67890', source: 'src/b.ts', line: 2, symbol: 'b', kind: 'fn', relevance: 0.9 },
    ]);

    const resolved = await resolveSearchRefs({ refs: ['h:@search(target):sig'] }, 2);

    expect(resolved).toEqual({ refs: [['h:abc12345:sig', 'h:def67890:sig']] });
  });

  it('resolves inline search refs inside larger strings without regex matching', async () => {
    invokeMock.mockResolvedValueOnce([
      { hash: 'abc12345', source: 'src/a.ts', line: 1, symbol: 'a', kind: 'fn', relevance: 1 },
    ]);

    const resolved = await resolveSearchRefs(
      { message: 'Use h:@search(auth flow,limit=2):sig, then continue.' },
      3,
    );

    expect(resolved).toEqual({ message: 'Use h:abc12345:sig, then continue.' });
  });
});

/** Strings passed as the first argument to Tauri `atls_batch_query` from TS batch handlers. */
const FRONTEND_ATLS_BATCH_QUERY_OPS = [
  'help',
  'context',
  'read_lines',
  'code_search',
  'find_symbol',
  'symbol_usage',
  'find_issues',
  'detect_patterns',
  'call_hierarchy',
  'symbol_dep_graph',
  'change_impact',
  'impact_analysis',
  'extract_plan',
  'verify',
  'git',
  'workspaces',
  'create_files',
  'delete_files',
  'refactor',
  'split_module',
  'find_similar_code',
  'find_similar_functions',
  'find_conceptual_matches',
  'find_pattern_implementations',
] as const;

describe('atls_batch_query operation crosswalk', () => {
  it('lists each frontend dispatch operation string once (keep aligned with batch_query/mod.rs match arms)', () => {
    expect(new Set(FRONTEND_ATLS_BATCH_QUERY_OPS).size).toBe(FRONTEND_ATLS_BATCH_QUERY_OPS.length);
  });
});
