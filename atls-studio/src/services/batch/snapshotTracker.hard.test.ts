import { describe, expect, it } from 'vitest';
import { mergeRanges, SnapshotTracker } from './snapshotTracker';

describe('mergeRanges (line edit gate geometry)', () => {
  it('merges overlapping ranges', () => {
    expect(mergeRanges([
      { start: 1, end: 5 },
      { start: 3, end: 8 },
    ])).toEqual([{ start: 1, end: 8 }]);
  });

  it('merges adjacent ranges (end+1 touch)', () => {
    expect(mergeRanges([
      { start: 1, end: 5 },
      { start: 6, end: 10 },
    ])).toEqual([{ start: 1, end: 10 }]);
  });

  it('preserves a gap between ranges (line 4 uncovered between 1–3 and 5–7)', () => {
    const m = mergeRanges([
      { start: 1, end: 3 },
      { start: 5, end: 7 },
    ]);
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ start: 1, end: 3 });
    expect(m[1]).toEqual({ start: 5, end: 7 });
  });

  it('sorts unsorted input before merge', () => {
    expect(mergeRanges([
      { start: 20, end: 25 },
      { start: 1, end: 5 },
      { start: 10, end: 15 },
    ])).toEqual([
      { start: 1, end: 5 },
      { start: 10, end: 15 },
      { start: 20, end: 25 },
    ]);
  });
});

describe('SnapshotTracker hasReadCoverage / canonical gate', () => {
  it('hasReadCoverage is false when only hash recorded without regions', () => {
    const t = new SnapshotTracker();
    t.record('src/a.ts', 'abc123', 'lines');
    expect(t.hasReadCoverage('src/a.ts', 1, 5)).toBe(false);
  });

  it('hasReadCoverage is true when a single readRegion envelopes the edit span', () => {
    const t = new SnapshotTracker();
    t.record('src/a.ts', 'abc123', 'lines', { readRegion: { start: 1, end: 20 } });
    expect(t.hasReadCoverage('src/a.ts', 5, 7)).toBe(true);
  });

  it('hasReadCoverage is false when edit straddles a gap between merged regions', () => {
    const t = new SnapshotTracker();
    t.record('src/a.ts', 'h1', 'lines', { readRegion: { start: 1, end: 3 } });
    t.record('src/a.ts', 'h1', 'lines', { readRegion: { start: 5, end: 7 } });
    expect(t.hasReadCoverage('src/a.ts', 2, 6)).toBe(false);
  });

  it('accumulating adjacent read.lines calls merge into one span covering former gap', () => {
    const t = new SnapshotTracker();
    t.record('src/a.ts', 'h1', 'lines', { readRegion: { start: 1, end: 3 } });
    t.record('src/a.ts', 'h1', 'lines', { readRegion: { start: 4, end: 7 } });
    expect(t.getIdentity('src/a.ts')?.readRegions).toEqual([{ start: 1, end: 7 }]);
    expect(t.hasReadCoverage('src/a.ts', 2, 6)).toBe(true);
  });

  it('hasCanonicalRead is true after canonical record', () => {
    const t = new SnapshotTracker();
    t.record('src/b.ts', 'zzz', 'canonical');
    expect(t.hasCanonicalRead('src/b.ts')).toBe(true);
    expect(t.hasReadCoverage('src/b.ts', 999, 1000)).toBe(false);
  });

  it('does not downgrade canonical when adding line regions', () => {
    const t = new SnapshotTracker();
    t.record('src/c.ts', 'full', 'canonical');
    t.record('src/c.ts', 'full', 'lines', { readRegion: { start: 1, end: 5 } });
    expect(t.hasCanonicalRead('src/c.ts')).toBe(true);
    expect(t.getIdentity('src/c.ts')?.readRegions).toEqual([{ start: 1, end: 5 }]);
  });

  it('invalidateAndRerecord clears readRegions (subsequent targeted coverage must be re-read)', () => {
    const t = new SnapshotTracker();
    t.record('src/d.ts', 'old', 'lines', { readRegion: { start: 1, end: 10 } });
    expect(t.hasReadCoverage('src/d.ts', 2, 4)).toBe(true);
    t.invalidateAndRerecord('src/d.ts', 'newhash');
    expect(t.getIdentity('src/d.ts')?.readRegions).toBeUndefined();
    expect(t.hasCanonicalRead('src/d.ts')).toBe(true);
    expect(t.hasReadCoverage('src/d.ts', 2, 4)).toBe(false);
  });

  it('normalizes Windows paths for lookup', () => {
    const t = new SnapshotTracker();
    t.record('src/File.TS', 'h', 'lines', { readRegion: { start: 1, end: 3 } });
    expect(t.hasReadCoverage('SRC/file.ts', 2, 2)).toBe(true);
  });

  it('mergeRanges collapses duplicate identical ranges', () => {
    expect(mergeRanges([
      { start: 5, end: 10 },
      { start: 5, end: 10 },
    ])).toEqual([{ start: 5, end: 10 }]);
  });

  it('mergeRanges handles many shuffled fragments into minimal cover list', () => {
    const parts = [
      { start: 100, end: 110 },
      { start: 1, end: 5 },
      { start: 3, end: 8 },
      { start: 50, end: 52 },
      { start: 9, end: 12 },
    ];
    const m = mergeRanges(parts);
    expect(m).toEqual([
      { start: 1, end: 12 },
      { start: 50, end: 52 },
      { start: 100, end: 110 },
    ]);
  });

  it('point-range read (1,1) covers only that line', () => {
    const t = new SnapshotTracker();
    t.record('src/pt.ts', 'h', 'lines', { readRegion: { start: 1, end: 1 } });
    expect(t.hasReadCoverage('src/pt.ts', 1, 1)).toBe(true);
    expect(t.hasReadCoverage('src/pt.ts', 1, 2)).toBe(false);
  });
});
