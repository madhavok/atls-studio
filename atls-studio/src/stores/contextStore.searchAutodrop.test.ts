/**
 * Search-ref auto-drop (Section F of manifest-and-context-hygiene).
 *
 * When the model directly reads a file that was the sole hit for a prior
 * `search.code` call, the search chunk is redundant — its summary is
 * derivable from the read content and keeping it compounds dormant noise.
 * `dropSupersededSearches(path)` handles the drop, with guards for
 * multi-hit searches, pinned chunks, and BB-cited chunks.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useContextStore } from './contextStore';

function resetStore() {
  useContextStore.getState().resetSession();
}

/**
 * Seed a search chunk with `searchPaths` set — mirrors what the `search.code`
 * handler writes when a batch step completes.
 */
function seedSearchChunk(queries: string, uniquePaths: string[]): string {
  return useContextStore.getState().addChunk(
    `mock search body for ${queries}`,
    'search',
    queries,
    undefined,
    undefined,
    undefined,
    { searchPaths: uniquePaths },
  );
}

describe('dropSupersededSearches', () => {
  beforeEach(resetStore);

  it('drops a single-hit search whose sole path matches the read path', () => {
    const shortHash = seedSearchChunk('authenticate', ['src/auth.ts']);
    // Precondition: chunk exists.
    const beforeCount = Array.from(useContextStore.getState().chunks.values())
      .filter(c => c.shortHash === shortHash).length;
    expect(beforeCount).toBe(1);

    const dropped = useContextStore.getState().dropSupersededSearches('src/auth.ts');
    expect(dropped).toBe(1);

    const afterCount = Array.from(useContextStore.getState().chunks.values())
      .filter(c => c.shortHash === shortHash).length;
    expect(afterCount).toBe(0);
  });

  it('does NOT drop a multi-hit search when only one path is read', () => {
    // Conservative rule: multi-hit searches stay until all paths are covered.
    // The model may still want the broader hit set visible.
    seedSearchChunk('authenticate', ['src/auth.ts', 'src/session.ts', 'src/login.ts']);
    const dropped = useContextStore.getState().dropSupersededSearches('src/auth.ts');
    expect(dropped).toBe(0);
  });

  it('does NOT drop a pinned search chunk even if sole-hit matches', () => {
    const shortHash = seedSearchChunk('authenticate', ['src/auth.ts']);
    useContextStore.getState().pinChunks([`h:${shortHash}`]);
    const dropped = useContextStore.getState().dropSupersededSearches('src/auth.ts');
    expect(dropped).toBe(0);
  });

  it('does NOT drop a search chunk cited by an active BB finding', () => {
    // Regression guard: the chunk is referenced in BB, so its summary is
    // still load-bearing even after the file has been read.
    const shortHash = seedSearchChunk('authenticate', ['src/auth.ts']);
    useContextStore.getState().setBlackboardEntry(
      'finding:auth',
      `Token parsing bug: see h:${shortHash} for context`,
    );
    const dropped = useContextStore.getState().dropSupersededSearches('src/auth.ts');
    expect(dropped).toBe(0);
  });

  it('handles Windows-style path separators by normalizing on both sides', () => {
    seedSearchChunk('authenticate', ['src\\auth.ts']);
    const dropped = useContextStore.getState().dropSupersededSearches('src/auth.ts');
    expect(dropped).toBe(1);
  });

  it('is a no-op when no matching search chunk exists', () => {
    seedSearchChunk('unrelated', ['src/other.ts']);
    const dropped = useContextStore.getState().dropSupersededSearches('src/auth.ts');
    expect(dropped).toBe(0);
  });

  it('drops multiple single-hit searches for the same path in one call', () => {
    const s1 = seedSearchChunk('tokenParse', ['src/auth.ts']);
    const s2 = seedSearchChunk('verifyJwt', ['src/auth.ts']);
    const dropped = useContextStore.getState().dropSupersededSearches('src/auth.ts');
    expect(dropped).toBe(2);
    const remaining = Array.from(useContextStore.getState().chunks.values())
      .filter(c => c.shortHash === s1 || c.shortHash === s2);
    expect(remaining).toHaveLength(0);
  });

  it('ignores search chunks without searchPaths metadata (legacy)', () => {
    // Legacy search chunks created before the auto-drop opt-in carry no
    // `searchPaths` — they must not be dropped.
    useContextStore.getState().addChunk('legacy search body', 'search', 'legacy-query');
    const dropped = useContextStore.getState().dropSupersededSearches('src/auth.ts');
    expect(dropped).toBe(0);
  });
});
