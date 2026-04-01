import { describe, it, expect, beforeEach } from 'vitest';
import { clearFreshnessJournal, getFreshnessJournal, recordFreshnessJournal } from './freshnessJournal';

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
});
