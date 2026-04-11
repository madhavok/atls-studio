import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useContextStore } from '../stores/contextStore';
import type { PreflightResult } from './freshnessPreflight';
import { runFreshnessPreflight } from './freshnessPreflight';
import { atlsBatchQuery, getAtlsBatchQueryTimeoutMs, resolveSearchRefs } from './toolHelpers';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('./freshnessPreflight', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./freshnessPreflight')>();
  return { ...mod, runFreshnessPreflight: vi.fn() };
});

const invokeMock = vi.mocked(invoke);
const runFreshnessPreflightMock = vi.mocked(runFreshnessPreflight);

function preflightOk(overrides: Partial<PreflightResult> = {}): PreflightResult {
  return {
    params: {},
    warnings: [],
    blocked: false,
    confidence: 'high',
    strategy: 'fresh',
    decisions: [],
    ...overrides,
  };
}

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

describe('atlsBatchQuery', () => {
  beforeAll(() => {
    if (!('localStorage' in globalThis)) {
      const store = new Map<string, string>();
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          clear: () => store.clear(),
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => store.set(k, v),
          removeItem: (k: string) => void store.delete(k),
          get length() {
            return store.size;
          },
          key: (i: number) => Array.from(store.keys())[i] ?? null,
        } satisfies Storage,
      });
    }
  });

  beforeEach(() => {
    globalThis.localStorage.clear();
    invokeMock.mockReset();
    runFreshnessPreflightMock.mockReset();
    useContextStore.getState().resetSession();
    useContextStore.setState({ hashStack: [], editHashStack: [] });
    runFreshnessPreflightMock.mockResolvedValue(preflightOk());
  });

  it('invokes atls_batch_query with preflight params and strips stale_policy', async () => {
    runFreshnessPreflightMock.mockResolvedValue(
      preflightOk({
        params: { file_paths: ['a.ts'], stale_policy: 'refresh_first', other: 1 },
      }),
    );
    invokeMock.mockResolvedValue({ ok: true });

    await atlsBatchQuery('context', { unused: true });

    const batchCalls = invokeMock.mock.calls.filter((c) => c[0] === 'atls_batch_query');
    expect(batchCalls.length).toBe(1);
    const args = batchCalls[0]![1] as Record<string, unknown>;
    expect(args.operation).toBe('context');
    expect(args.params).toEqual({ file_paths: ['a.ts'], other: 1 });
    expect(args.params).not.toHaveProperty('stale_policy');
  });

  it('throws preflight error when blocked', async () => {
    runFreshnessPreflightMock.mockResolvedValue(
      preflightOk({ blocked: true, error: 'File changed externally', confidence: 'none', strategy: 'blocked' }),
    );

    await expect(atlsBatchQuery('read_lines', {})).rejects.toThrow('File changed externally');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('throws when automation requires review (low-confidence rebind)', async () => {
    runFreshnessPreflightMock.mockResolvedValue(
      preflightOk({ confidence: 'low', strategy: 'line_relocation' }),
    );

    await expect(atlsBatchQuery('read_lines', {})).rejects.toThrow(
      /Low-confidence line_relocation rebind detected/,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('refresh_first retry on find_issues: refreshRoundEnd then second preflight', async () => {
    const refreshSpy = vi
      .spyOn(useContextStore.getState(), 'refreshRoundEnd')
      .mockResolvedValue({
        total: 0,
        updated: 0,
        invalidated: 0,
        preserved: 0,
        pathsProcessed: 0,
      });
    runFreshnessPreflightMock
      .mockResolvedValueOnce(
        preflightOk({ blocked: true, confidence: 'none', strategy: 'blocked' }),
      )
      .mockResolvedValueOnce(preflightOk());
    invokeMock.mockResolvedValue({ hits: [] });

    await atlsBatchQuery('find_issues', {
      stale_policy: 'refresh_first',
      file_paths: ['src/x.ts'],
    });

    expect(refreshSpy).toHaveBeenCalledWith({ paths: ['src/x.ts'] });
    expect(runFreshnessPreflightMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls.some((c) => c[0] === 'atls_batch_query')).toBe(true);

    refreshSpy.mockRestore();
  });
});
