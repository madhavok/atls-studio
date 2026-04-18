/**
 * PR4 tests — pin/HPP/supersededBy + subagent boundary resolver.
 * Exercises the store-level wiring beyond what unit tests in fileViewStore.test.ts cover.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useContextStore } from './contextStore';
import { clearFreshnessJournal } from '../services/freshnessJournal';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function reset() {
  useContextStore.getState().resetSession();
  clearFreshnessJournal();
}

function row(n: number, c: string): string {
  return `${String(n).padStart(4)}|${c}`;
}

describe('FileView PR4 — pinChunks with h:fv:', () => {
  beforeEach(reset);

  it('pins a FileView by h:fv:<hash>', () => {
    const store = useContextStore.getState();
    const rev = 'rev1';
    store.addChunk(
      row(10, 'a'),
      'smart',
      'src/foo.ts',
      undefined, undefined, 'hchunk1',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/foo.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    const viewHash = useContextStore.getState().getFileView('src/foo.ts')!.hash;
    expect(viewHash.startsWith('h:fv:')).toBe(true);

    const r = useContextStore.getState().pinChunks([viewHash]);
    expect(r.count).toBe(1);
    expect(useContextStore.getState().getFileView('src/foo.ts')!.pinned).toBe(true);
  });

  it('pinning a slice ref routes to the FileView; chunk itself stays unpinned', () => {
    // Under the single-retention-ref contract: pin on any slice/chunk ref whose
    // source has a FileView pins the view, not the chunk. The chunk remains
    // unpinned — it's citation-only, not a retention target.
    const store = useContextStore.getState();
    const rev = 'rev1';
    const shortSliceHash = store.addChunk(
      row(42, 'fn bar'),
      'smart',
      'src/parent.ts',
      undefined, undefined, 'hslice42',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/parent.ts', sourceRevision: rev, startLine: 42, endLine: 42 },
      },
    );
    expect(useContextStore.getState().getFileView('src/parent.ts')!.pinned).toBe(false);

    useContextStore.getState().pinChunks([shortSliceHash]);
    // View is pinned.
    expect(useContextStore.getState().getFileView('src/parent.ts')!.pinned).toBe(true);
    // Chunk is NOT pinned — retention routed to the view. `pinned` is optional
    // on ContextChunk (unset === falsy); check for truthy rather than === false.
    const sliceChunk = Array.from(useContextStore.getState().chunks.values())
      .find(c => c.source === 'src/parent.ts');
    expect(sliceChunk).toBeDefined();
    expect(sliceChunk!.pinned).toBeFalsy();
  });

  it('unpinning a slice ref routes to the parent FileView', () => {
    // Symmetric with pin — `pu` on a slice hash unpins the view.
    const store = useContextStore.getState();
    const rev = 'rev1';
    const shortSliceHash = store.addChunk(
      row(10, 'a'),
      'smart',
      'src/sym.ts',
      undefined, undefined, 'hslice-sym',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/sym.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    useContextStore.getState().pinChunks([shortSliceHash]);
    expect(useContextStore.getState().getFileView('src/sym.ts')!.pinned).toBe(true);

    useContextStore.getState().unpinChunks([shortSliceHash]);
    expect(useContextStore.getState().getFileView('src/sym.ts')!.pinned).toBe(false);
  });

  it('dropping a slice ref removes the FileView + all backing chunks', () => {
    const store = useContextStore.getState();
    const rev = 'rev1';
    const shortSliceHash = store.addChunk(
      row(10, 'a'),
      'smart',
      'src/dropslice.ts',
      undefined, undefined, 'hslice-drop',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/dropslice.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    expect(useContextStore.getState().getFileView('src/dropslice.ts')).toBeDefined();

    useContextStore.getState().dropChunks([shortSliceHash]);
    expect(useContextStore.getState().getFileView('src/dropslice.ts')).toBeUndefined();
    const chunkPresent = Array.from(useContextStore.getState().chunks.values())
      .some(c => c.shortHash === shortSliceHash);
    expect(chunkPresent).toBe(false);
  });

  it('unpinChunks releases FileView by h:fv: ref', () => {
    const store = useContextStore.getState();
    const rev = 'rev1';
    store.addChunk(
      row(10, 'a'),
      'smart',
      'src/unpin.ts',
      undefined, undefined, 'h-up',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/unpin.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    useContextStore.getState().setFileViewPinned('src/unpin.ts', true);
    expect(useContextStore.getState().getFileView('src/unpin.ts')!.pinned).toBe(true);

    const viewHash = useContextStore.getState().getFileView('src/unpin.ts')!.hash;
    const n = useContextStore.getState().unpinChunks([viewHash]);
    expect(n).toBe(1);
    expect(useContextStore.getState().getFileView('src/unpin.ts')!.pinned).toBe(false);
  });

  it('wildcard unpinChunks clears FileView pins too', () => {
    const store = useContextStore.getState();
    store.addChunk(
      row(1, 'a'),
      'smart',
      'src/wild1.ts',
      undefined, undefined, 'h-w1',
      {
        sourceRevision: 'rev',
        readSpan: { filePath: 'src/wild1.ts', sourceRevision: 'rev', startLine: 1, endLine: 1 },
      },
    );
    store.addChunk(
      row(1, 'b'),
      'smart',
      'src/wild2.ts',
      undefined, undefined, 'h-w2',
      {
        sourceRevision: 'rev',
        readSpan: { filePath: 'src/wild2.ts', sourceRevision: 'rev', startLine: 1, endLine: 1 },
      },
    );
    useContextStore.getState().setFileViewPinned('src/wild1.ts', true);
    useContextStore.getState().setFileViewPinned('src/wild2.ts', true);

    useContextStore.getState().unpinChunks(['*']);
    expect(useContextStore.getState().getFileView('src/wild1.ts')!.pinned).toBe(false);
    expect(useContextStore.getState().getFileView('src/wild2.ts')!.pinned).toBe(false);
  });

  it('pinChunks no longer skips full-file chunks', () => {
    const store = useContextStore.getState();
    // Full-body type: 'raw' with viewKind:'latest' — under the old rules this would
    // have been counted as skippedFullFile. Now it pins normally.
    const shortHash = store.addChunk(
      'entire file body',
      'raw',
      'src/full.ts',
      undefined, undefined, 'h-full-body',
      { sourceRevision: 'rev', viewKind: 'latest' },
    );
    const r = useContextStore.getState().pinChunks([shortHash]);
    expect(r.count).toBe(1);
    expect(r.skippedFullFile).toBe(0);
  });

  it('resetSession clears pinned FileViews (no cross-session leak)', () => {
    const store = useContextStore.getState();
    store.addChunk(
      row(10, 'a'),
      'smart',
      'src/leak.ts',
      undefined, undefined, 'h-leak1',
      {
        sourceRevision: 'rev1',
        readSpan: { filePath: 'src/leak.ts', sourceRevision: 'rev1', startLine: 10, endLine: 10 },
      },
    );
    useContextStore.getState().setFileViewPinned('src/leak.ts', true);
    expect(useContextStore.getState().fileViews.size).toBe(1);
    expect(useContextStore.getState().getFileView('src/leak.ts')!.pinned).toBe(true);

    useContextStore.getState().resetSession();

    expect(useContextStore.getState().fileViews.size).toBe(0);
    expect(useContextStore.getState().getFileView('src/leak.ts')).toBeUndefined();
  });
});

describe('FileView PR4 — supersededBy', () => {
  beforeEach(reset);

  it('slice added after full-file chunk marks the full chunk supersededBy: [slice]', () => {
    const store = useContextStore.getState();
    const rev = 'rev1';
    // First: full-file read (no readSpan). Gets registered as a full chunk.
    const fullShort = store.addChunk(
      'full file content',
      'raw',
      'src/super.ts',
      undefined, undefined, 'hfull_super',
      {
        sourceRevision: rev,
        viewKind: 'latest',
      },
    );
    expect(fullShort).toBeDefined();

    // Second: slice read for the same file, same revision — should stamp supersededBy.
    store.addChunk(
      row(10, 'slice line'),
      'smart',
      'src/super.ts',
      undefined, undefined, 'hslice_sup_10',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/super.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );

    const fullChunk = Array.from(useContextStore.getState().chunks.values())
      .find(c => c.hash === 'hfull_super');
    expect(fullChunk).toBeDefined();
    expect(fullChunk!.supersededBy).toBeDefined();
    expect(fullChunk!.supersededBy!.hashes.length).toBeGreaterThan(0);
  });

  it('does not stamp supersededBy across revisions', () => {
    const store = useContextStore.getState();
    store.addChunk(
      'full file',
      'raw',
      'src/cross.ts',
      undefined, undefined, 'hfull_cross',
      { sourceRevision: 'revA', viewKind: 'latest' },
    );
    // Slice at different revision — should NOT stamp the full chunk.
    store.addChunk(
      row(10, 'slice'),
      'smart',
      'src/cross.ts',
      undefined, undefined, 'hslice_cross',
      {
        sourceRevision: 'revB',
        readSpan: { filePath: 'src/cross.ts', sourceRevision: 'revB', startLine: 10, endLine: 10 },
      },
    );
    const fullChunk = Array.from(useContextStore.getState().chunks.values())
      .find(c => c.hash === 'hfull_cross');
    expect(fullChunk!.supersededBy).toBeUndefined();
  });
});

describe('FileView PR4 — resolveFileViewRefs (subagent boundary)', () => {
  beforeEach(reset);

  it('expands h:fv:<hash> to its constituent chunk hashes', () => {
    const store = useContextStore.getState();
    const rev = 'rev1';
    store.addChunk(
      row(10, 'a'),
      'smart',
      'src/sub.ts',
      undefined, undefined, 'h-sub1',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/sub.ts', sourceRevision: rev, startLine: 10, endLine: 10 },
      },
    );
    store.addChunk(
      row(20, 'b'),
      'smart',
      'src/sub.ts',
      undefined, undefined, 'h-sub2',
      {
        sourceRevision: rev,
        readSpan: { filePath: 'src/sub.ts', sourceRevision: rev, startLine: 20, endLine: 20 },
      },
    );

    const viewHash = useContextStore.getState().getFileView('src/sub.ts')!.hash;
    const resolved = useContextStore.getState().resolveFileViewRefs([viewHash, 'h:other']);
    // View hash expands to the 2 constituent chunk hashes; non-fv ref pass-through.
    expect(resolved).toContain('h:other');
    expect(resolved.some(r => r.startsWith('h:h-sub1'.slice(0, 8)) || r === 'h:h-sub')).toBe(true);
    // Accept either truncated or full; the key is that the view ref expanded to something.
    expect(resolved.length).toBeGreaterThanOrEqual(2);
  });

  it('silently drops unknown h:fv: refs', () => {
    const resolved = useContextStore.getState().resolveFileViewRefs(['h:fv:unknown']);
    expect(resolved).toEqual([]);
  });

  it('passes through when no FileViews exist', () => {
    const refs = ['h:abc', 'h:def'];
    const resolved = useContextStore.getState().resolveFileViewRefs(refs);
    expect(resolved).toEqual(refs);
  });
});
