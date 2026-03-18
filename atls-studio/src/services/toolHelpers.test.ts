import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useContextStore } from '../stores/contextStore';
import { resolveSearchRefs } from './toolHelpers';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

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
