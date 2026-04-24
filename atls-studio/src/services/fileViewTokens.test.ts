import { describe, expect, it, beforeEach } from 'vitest';
import type { FileView } from './fileViewStore';
import {
  clearFileViewTokenCache,
  estimateFileViewTokens,
  summarizeFileViewTokens,
} from './fileViewTokens';

function v(partial: Partial<FileView> & Pick<FileView, 'filePath'>): FileView {
  return {
    filePath: partial.filePath,
    sourceRevision: partial.sourceRevision ?? 'rev1',
    observedRevision: partial.observedRevision ?? 'rev1',
    totalLines: partial.totalLines ?? 3,
    skeletonRows: partial.skeletonRows ?? ['1|a', '2|b', '3|c'],
    sigLevel: partial.sigLevel ?? 'sig',
    filledRegions: partial.filledRegions ?? [],
    hash: partial.hash ?? 'h:deadbeef00',
    shortHash: partial.shortHash ?? 'deadbeef00',
    lastAccessed: partial.lastAccessed ?? Date.now(),
    pinned: partial.pinned ?? true,
    ...partial,
  };
}

describe('fileViewTokens', () => {
  beforeEach(() => {
    clearFileViewTokenCache();
  });

  it('estimates with fullBody dominating skeleton and fills', () => {
    const view = v({
      filePath: '/src/a.ts',
      fullBody: 'entire file content',
      filledRegions: [{ start: 1, end: 2, content: 'x', tokens: 99, chunkHashes: ['c'], origin: 'read' }],
      skeletonRows: ['1|gone'],
    });
    const est = estimateFileViewTokens(view, 0);
    expect(est.fullBodyTokens).toBeGreaterThan(0);
    expect(est.skeletonTokens).toBe(0);
    expect(est.filledTokens).toBe(0);
    expect(est.total).toBe(est.fullBodyTokens + est.chromeTokens);
  });

  it('sums skeleton and fills when no fullBody', () => {
    const view = v({
      filePath: '/b.ts',
      skeletonRows: ['  1|x'],
      filledRegions: [
        { start: 1, end: 1, content: '1|x', tokens: 2, chunkHashes: ['h1'], origin: 'read' },
      ],
    });
    const est = estimateFileViewTokens(view, 0);
    expect(est.filledTokens).toBe(2);
    expect(est.total).toBe(est.skeletonTokens + est.filledTokens + est.chromeTokens);
  });

  it('prices refetch markers in the current round', () => {
    const view = v({
      filePath: '/c.ts',
      skeletonRows: ['1|a'],
      filledRegions: [
        {
          start: 1,
          end: 1,
          content: '1|a',
          tokens: 1,
          chunkHashes: ['c'],
          origin: 'refetch',
          refetchedAtRound: 3,
        },
      ],
    });
    const r0 = estimateFileViewTokens(view, 0);
    const r3 = estimateFileViewTokens(view, 3);
    expect(r3.total).toBeGreaterThanOrEqual(r0.total);
  });

  it('uses cache when structure unchanged', () => {
    const view = v({ filePath: '/d.ts' });
    const a = estimateFileViewTokens(view, 0);
    const b = estimateFileViewTokens({ ...view }, 0);
    expect(a).toEqual(b);
  });

  it('summarize only counts pinned views with content', () => {
    const pinned = v({
      filePath: '/e.ts',
      pinned: true,
      skeletonRows: ['1|z'],
    });
    const dormant = v({
      filePath: '/f.ts',
      pinned: false,
      skeletonRows: ['1|z'],
    });
    const empty = v({
      filePath: '/g.ts',
      pinned: true,
      skeletonRows: [],
      filledRegions: [],
    });
    const s = summarizeFileViewTokens([dormant, empty, pinned], 0);
    expect(s.viewCount).toBe(1);
    expect(s.totalRenderedTokens).toBeGreaterThan(0);
  });
});
