import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearFreshnessJournal,
  getFreshnessJournal,
  recordFreshnessJournal,
  restoreJournal,
  serializeJournal,
} from './freshnessJournal';

describe('freshnessJournal', () => {
  beforeEach(() => {
    clearFreshnessJournal();
  });

  it('records and retrieves by normalized path', () => {
    recordFreshnessJournal({
      source: 'Src/Foo.ts',
      currentRevision: 'r2',
      previousRevision: 'r1',
      recordedAt: 1,
    });
    const e = getFreshnessJournal('src/foo.ts');
    expect(e?.currentRevision).toBe('r2');
    expect(e?.previousRevision).toBe('r1');
  });

  it('clear() removes all entries', () => {
    recordFreshnessJournal({ source: 'a.ts', currentRevision: '1', recordedAt: 1 });
    clearFreshnessJournal();
    expect(getFreshnessJournal('a.ts')).toBeUndefined();
  });

  it('clear(path) removes one entry', () => {
    recordFreshnessJournal({ source: 'a.ts', currentRevision: '1', recordedAt: 1 });
    recordFreshnessJournal({ source: 'b.ts', currentRevision: '2', recordedAt: 2 });
    clearFreshnessJournal('b.ts');
    expect(getFreshnessJournal('a.ts')).toBeDefined();
    expect(getFreshnessJournal('b.ts')).toBeUndefined();
  });

  it('evicts oldest entry when exceeding MAX_JOURNAL_ENTRIES (128)', () => {
    for (let i = 0; i < 129; i++) {
      recordFreshnessJournal({
        source: `src/file-${i}.ts`,
        currentRevision: `rev-${i}`,
        recordedAt: i,
      });
    }
    expect(getFreshnessJournal('src/file-0.ts')).toBeUndefined();
    expect(getFreshnessJournal('src/file-1.ts')?.currentRevision).toBe('rev-1');
    expect(getFreshnessJournal('src/file-128.ts')?.currentRevision).toBe('rev-128');
    expect(serializeJournal().length).toBe(128);
  });

  it('serializeJournal + restoreJournal round-trips', () => {
    recordFreshnessJournal({ source: 'x/A.ts', currentRevision: 'r-a', previousRevision: 'r0', lineDelta: -2, recordedAt: 10 });
    recordFreshnessJournal({ source: 'y/B.ts', currentRevision: 'r-b', recordedAt: 20 });
    const snap = serializeJournal();
    clearFreshnessJournal();
    expect(getFreshnessJournal('x/a.ts')).toBeUndefined();
    restoreJournal(snap);
    const a = getFreshnessJournal('x/A.ts');
    expect(a?.currentRevision).toBe('r-a');
    expect(a?.previousRevision).toBe('r0');
    expect(a?.lineDelta).toBe(-2);
    expect(getFreshnessJournal('y/b.ts')?.currentRevision).toBe('r-b');
  });
});
