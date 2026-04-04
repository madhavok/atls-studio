/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadProjectHistory,
  normalizeProjectHistory,
  saveProjectHistory,
  type ProjectHistoryEntry,
} from './projectHistory';

describe('projectHistory', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('normalizeProjectHistory sorts by lastOpened desc and caps at 5', () => {
    const a: ProjectHistoryEntry = {
      path: '/a',
      name: 'a',
      lastOpened: new Date('2020-01-01'),
    };
    const b: ProjectHistoryEntry = {
      path: '/b',
      name: 'b',
      lastOpened: new Date('2021-01-01'),
    };
    const c: ProjectHistoryEntry = {
      path: '/c',
      name: 'c',
      lastOpened: new Date('2019-01-01'),
    };
    const out = normalizeProjectHistory([a, b, c]);
    expect(out.map((e) => e.path)).toEqual(['/b', '/a', '/c']);
  });

  it('saveProjectHistory round-trips through loadProjectHistory', () => {
    const entries: ProjectHistoryEntry[] = [
      { path: '/p1', name: 'one', lastOpened: new Date('2022-06-01T12:00:00Z') },
    ];
    saveProjectHistory(entries);
    const loaded = loadProjectHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.path).toBe('/p1');
    expect(loaded[0]?.name).toBe('one');
    expect(loaded[0]?.lastOpened.getTime()).toBe(new Date('2022-06-01T12:00:00Z').getTime());
  });

  it('loadProjectHistory returns empty for unsupported schema object', () => {
    localStorage.setItem(
      'atls-project-history',
      JSON.stringify({ schemaVersion: 999, entries: [] }),
    );
    expect(loadProjectHistory()).toEqual([]);
  });
});
