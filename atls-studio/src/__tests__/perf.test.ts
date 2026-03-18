/**
 * Performance / stress tests for HPP resolution.
 * - Large set ops: resolveHashRefsWithMeta with many chunks
 * - Validates completion within timeout (no formal benchmark)
 */
import { describe, it, expect } from 'vitest';
import {
  resolveHashRefsWithMeta,
  resolveCompositeSetRef,
  parseSetRef,
  type CompositeSetRef,
  type HashLookup,
  type SetRefLookup,
  type SetSelector,
  type SetRefResult,
} from '../utils/hashResolver';

// Build mock returning N entries (sourced from files)
function createLargeSetLookup(n: number): SetRefLookup {
  return (selector: SetSelector): SetRefResult => {
    if (selector.kind === 'all') {
      const hashes = Array.from({ length: n }, (_, i) =>
        (i + 1).toString(16).padStart(8, '0')
      );
      const entries = hashes.map((h, i) => ({
        content: `// file ${i}`,
        source: `src/file${i}.ts`,
      }));
      return { hashes, entries };
    }
    return { hashes: [], entries: [] };
  };
}

describe('perf: large set operations', () => {
  it('resolveHashRefsWithMeta with 1000 chunks completes within 5s', async () => {
    const n = 1000;
    const mockLookup: HashLookup = async (hash) => {
      const idx = parseInt(hash.slice(0, 8), 16);
      if (idx >= 1 && idx <= n) {
        return {
          content: `// file ${idx}`,
          source: `src/file${idx}.ts`,
        };
      }
      return null;
    };

    const setLookup = createLargeSetLookup(n);
    const input = { file_paths: ['h:@all'] };

    const start = performance.now();
    const { params } = await resolveHashRefsWithMeta(
      input,
      mockLookup,
      undefined,
      setLookup
    );
    const elapsed = performance.now() - start;

    const fp = (params as Record<string, string[]>).file_paths;
    expect(fp).toHaveLength(n);
    expect(elapsed).toBeLessThan(5000);
  });

  it('resolveCompositeSetRef union of two large sets is bounded', () => {
    const n = 500;
    const mockSetLookup: SetRefLookup = (selector): SetRefResult => {
      if (selector.kind === 'edited' || selector.kind === 'pinned') {
        const hashes = Array.from({ length: n }, (_, i) =>
          (i + 1).toString(16).padStart(8, '0')
        );
        const entries = hashes.map((h, i) => ({
          content: `// file ${i}`,
          source: `src/file${i}.ts`,
        }));
        return { hashes, entries };
      }
      return { hashes: [], entries: [] };
    };

    const r = parseSetRef('h:@edited+h:@pinned');
    expect(r).not.toBeNull();

    const composite = r as CompositeSetRef;
    const { values } = resolveCompositeSetRef(
      composite,
      'h:@edited+h:@pinned',
      undefined,
      mockSetLookup
    );

    // Union dedupes; both return same 500 paths → 500 unique
    expect(values.length).toBeGreaterThan(0);
    expect(values.length).toBeLessThanOrEqual(n * 2);
  });
});
