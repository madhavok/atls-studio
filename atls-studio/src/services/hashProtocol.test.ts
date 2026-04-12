/**
 * HPP — Hash Pointer Protocol materialization state machine tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTurn,
  getTurnDelta,
  advanceTurn,
  resetProtocol,
  materialize,
  dematerialize,
  evict,
  getRef,
  getAllRefs,
  getActiveRefs,
  getRefsBySource,
  getRefsByType,
  getLatestRefs,
  shouldMaterialize,
  formatRefLine,
  sortRefs,
  setRoundRefreshHook,
  createScopedView,
  getRefBurdenCounts,
} from './hashProtocol';

describe('hashProtocol', () => {
  beforeEach(() => {
    resetProtocol();
  });

  describe('turn management', () => {
    it('starts at turn 0', () => {
      expect(getTurn()).toBe(0);
    });

    it('advanceTurn increments and returns turn', async () => {
      expect(await advanceTurn()).toBe(1);
      expect(getTurn()).toBe(1);
      expect(await advanceTurn()).toBe(2);
      expect(getTurn()).toBe(2);
    });

    it('advanceTurn invokes registered round-refresh hook', async () => {
      const calls: number[] = [];
      setRoundRefreshHook(() => { calls.push(getTurn()); });
      materialize('aa111111', 'file', 'src/a.ts', 10, 5, '');
      const turn = await advanceTurn();
      expect(turn).toBe(1);
      expect(calls).toEqual([1]);
      setRoundRefreshHook(null);
    });

    it('advanceTurn awaits async hook before returning', async () => {
      let resolved = false;
      setRoundRefreshHook(() => new Promise<void>(r => setTimeout(() => { resolved = true; r(); }, 10)));
      const turn = await advanceTurn();
      expect(turn).toBe(1);
      expect(resolved).toBe(true);
      setRoundRefreshHook(null);
    });

    it('advanceTurn getTurnDelta newMaterialized sums pre-hook count and hook materializations', async () => {
      resetProtocol();
      materialize('aa111111', 'file', 'src/a.ts', 10, 5, '');
      materialize('bb222222', 'file', 'src/b.ts', 8, 3, '');
      expect(getTurnDelta().newMaterialized).toBe(2);
      setRoundRefreshHook(() => {
        materialize('cc333333', 'file', 'src/c.ts', 4, 2, '');
      });
      await advanceTurn();
      expect(getTurnDelta().newMaterialized).toBe(3);
      setRoundRefreshHook(null);
    });

    it('round-refresh hook reconciles stale chunks so they do not survive as suspect', async () => {
      const { useContextStore } = await import('../stores/contextStore');
      const { setRoundRefreshRevisionResolver } = await import('../stores/contextStore');
      const store = useContextStore.getState();
      store.resetSession();
      const hash = store.addChunk('export const x = 1;', 'smart', 'src/refresh.ts', undefined, undefined, 'rev-old', { sourceRevision: 'rev-old', viewKind: 'latest' });
      useContextStore.setState(s => ({
        chunks: new Map([...s.chunks].map(([k, c]) => [k, c.shortHash === hash ? { ...c, suspectSince: Date.now(), freshnessCause: 'external_file_change' as const } : c])),
      }));
      setRoundRefreshRevisionResolver(async () => 'rev-fresh');
      setRoundRefreshHook(async () => { await useContextStore.getState().refreshRoundEnd(); });
      await advanceTurn();
      const chunk = Array.from(useContextStore.getState().chunks.values()).find(c => c.shortHash === hash);
      expect(chunk?.suspectSince).toBeUndefined();
      expect(chunk?.sourceRevision).toBe('rev-fresh');
      setRoundRefreshHook(null);
      setRoundRefreshRevisionResolver(null);
    });

    it('resetProtocol clears turn and refs', async () => {
      await advanceTurn();
      await advanceTurn();
      materialize('aabbccdd11223344', 'file', 'src/foo.ts', 100, 25, '');
      resetProtocol();
      expect(getTurn()).toBe(0);
      expect(getAllRefs()).toHaveLength(0);
      expect(getRefBurdenCounts()).toEqual({ active: 0, evicted: 0, total: 0 });
    });

    it('getRefBurdenCounts matches visibility split and invariant', () => {
      materialize('aa111111', 'file', 'a.ts', 1, 1, '');
      materialize('bb222222', 'file', 'b.ts', 1, 1, '');
      evict('aa111111');
      let manualEv = 0;
      let manualAct = 0;
      for (const r of getAllRefs()) {
        if (r.visibility === 'evicted') manualEv++;
        else manualAct++;
      }
      const b = getRefBurdenCounts();
      expect(b.active).toBe(manualAct);
      expect(b.evicted).toBe(manualEv);
      expect(b.total).toBe(b.active + b.evicted);
    });

    it('rematerializing evicted ref updates burden counts', () => {
      materialize('cc333333', 'file', 'c.ts', 1, 1, '');
      evict('cc333333');
      expect(getRefBurdenCounts()).toMatchObject({ active: 0, evicted: 1, total: 1 });
      materialize('cc333333', 'file', 'c.ts', 2, 2, 'x');
      expect(getRefBurdenCounts()).toMatchObject({ active: 1, evicted: 0, total: 1 });
    });

    it('double evict does not corrupt burden counts', () => {
      materialize('dd444444', 'file', 'd.ts', 1, 1, '');
      evict('dd444444');
      evict('dd444444');
      expect(getRefBurdenCounts()).toMatchObject({ active: 0, evicted: 1, total: 1 });
    });

    it('advanceTurn removes stale evicted rows and updates counts', async () => {
      materialize('ee555555', 'file', 'e.ts', 1, 1, '');
      evict('ee555555');
      expect(getRefBurdenCounts().total).toBe(1);
      await advanceTurn();
      await advanceTurn();
      expect(getRef('ee555555')).toBeUndefined();
      expect(getRefBurdenCounts()).toEqual({ active: 0, evicted: 0, total: 0 });
    });

    it('pruneEvictedRefsIfBurden trims evicted rows when ratio is high', async () => {
      for (let i = 0; i < 26; i++) {
        const h = `ff${i.toString().padStart(6, '0')}`;
        materialize(h, 'file', `${i}.ts`, 1, 1, '');
      }
      for (let i = 0; i < 16; i++) {
        const h = `ff${i.toString().padStart(6, '0')}`;
        evict(h);
      }
      expect(getRefBurdenCounts()).toMatchObject({ active: 10, evicted: 16, total: 26 });
      await advanceTurn();
      const after = getRefBurdenCounts();
      expect(after.total).toBeLessThan(26);
      expect(after.active).toBe(10);
      expect(after.evicted).toBeLessThan(16);
    });
  });

  describe('materialize', () => {
    it('registers new chunk as materialized', () => {
      const ref = materialize('aabbccdd11223344', 'file', 'src/foo.ts', 100, 25, 'fn bar:1-5');
      expect(ref.hash).toBe('aabbccdd11223344');
      expect(ref.shortHash).toBe('aabbcc');
      expect(ref.type).toBe('file');
      expect(ref.source).toBe('src/foo.ts');
      expect(ref.tokens).toBe(100);
      expect(ref.totalLines).toBe(25);
      expect(ref.editDigest).toBe('fn bar:1-5');
      expect(ref.visibility).toBe('materialized');
      expect(ref.seenAtTurn).toBe(0);
    });

    it('updates existing ref and promotes to materialized', async () => {
      materialize('aabbccdd11223344', 'file', 'src/foo.ts', 100, 25, '');
      await advanceTurn();
      const ref = materialize('aabbccdd11223344', 'file', 'src/foo.ts', 120, 30, 'updated');
      expect(ref.visibility).toBe('materialized');
      expect(ref.seenAtTurn).toBe(1);
      expect(ref.tokens).toBe(120);
      expect(getAllRefs()).toHaveLength(1);
    });
  });

  describe('dematerialize', () => {
    it('marks materialized chunk as referenced', () => {
      materialize('aabbccdd11223344', 'file', 'src/foo.ts', 100, 25, '');
      dematerialize('aabbccdd11223344');
      const ref = getRef('aabbccdd11223344');
      expect(ref?.visibility).toBe('referenced');
    });
  });

  describe('evict', () => {
    it('marks chunk as evicted', () => {
      materialize('aabbccdd11223344', 'file', 'src/foo.ts', 100, 25, '');
      evict('aabbccdd11223344');
      const ref = getRef('aabbccdd11223344');
      expect(ref?.visibility).toBe('evicted');
    });
  });

  describe('getRef', () => {
    it('looks up by full hash', () => {
      materialize('aabbccdd11223344', 'file', 'src/foo.ts', 100, 25, '');
      const ref = getRef('aabbccdd11223344');
      expect(ref).toBeDefined();
      expect(ref?.hash).toBe('aabbccdd11223344');
    });

    it('looks up by short hash', () => {
      materialize('aabbccdd11223344', 'file', 'src/foo.ts', 100, 25, '');
      const ref = getRef('aabbccdd');
      expect(ref).toBeDefined();
    });

    it('strips h: prefix', () => {
      materialize('aabbccdd11223344', 'file', 'src/foo.ts', 100, 25, '');
      const ref = getRef('h:aabbccdd11223344');
      expect(ref).toBeDefined();
    });

    it('returns undefined for unknown hash', () => {
      expect(getRef('deadbeef')).toBeUndefined();
    });

    it('indexes displayShortHash when map key is disambiguated (not16-hex content hash)', () => {
      const mapKey = 'aabbccdddddddd_z9';
      const displayShort = 'f3e2a1';
      materialize(mapKey, 'file', 'src/k.ts', 10, 2, '', displayShort);
      expect(getRef(displayShort)?.hash).toBe(mapKey);
      expect(getRef(mapKey)?.shortHash).toBe(displayShort);
      expect(getRef('aabbcc')).toBeUndefined();
    });

    it('migrates short-hash bucket when displayShortHash changes on same ref', () => {
      const mapKey = 'disamb_key_zz';
      materialize(mapKey, 'file', 'a.ts', 1, 1, '', '111111');
      expect(getRef('111111')?.hash).toBe(mapKey);
      materialize(mapKey, 'file', 'a.ts', 2, 1, '', '222222');
      expect(getRef('111111')).toBeUndefined();
      expect(getRef('222222')?.hash).toBe(mapKey);
    });
  });

  describe('getRefsBySource', () => {
    it('filters by source path', () => {
      materialize('aa111111', 'file', 'src/foo.ts', 10, 5, '');
      materialize('bb222222', 'file', 'src/bar.ts', 10, 5, '');
      materialize('cc333333', 'file', 'src/foo.ts', 10, 5, '');
      const refs = getRefsBySource('src/foo.ts');
      expect(refs).toHaveLength(2);
    });

    it('supports glob pattern', () => {
      materialize('aa111111', 'file', 'src/foo.ts', 10, 5, '');
      materialize('bb222222', 'file', 'src/bar.ts', 10, 5, '');
      const refs = getRefsBySource('src/*.ts');
      expect(refs).toHaveLength(2);
    });

    it('treats exact source filters as exact matches', () => {
      resetProtocol();
      materialize('aa111111', 'file', 'src/foo.ts', 10, 5, '');
      materialize('bb222222', 'file', 'src/foo.tsx', 10, 5, '');
      const refs = getRefsBySource('src/foo.ts');
      expect(refs).toHaveLength(1);
      expect(refs[0]?.source).toBe('src/foo.ts');
    });

    it('treats plain source filters as exact path matches, not substrings', () => {
      materialize('aa111111', 'file', 'src/foo.ts', 10, 5, '');
      materialize('bb222222', 'file', 'src/foo.tsx', 10, 5, '');
      const refs = getRefsBySource('src/foo.ts');
      expect(refs).toHaveLength(1);
      expect(refs[0]?.source).toBe('src/foo.ts');
    });
  });

  describe('getLatestRefs', () => {
    it('returns N most recent by seenAtTurn', async () => {
      materialize('aa111111', 'file', 'src/a.ts', 10, 5, '');
      await advanceTurn();
      materialize('bb222222', 'file', 'src/b.ts', 10, 5, '');
      await advanceTurn();
      materialize('cc333333', 'file', 'src/c.ts', 10, 5, '');
      const latest = getLatestRefs(2);
      expect(latest).toHaveLength(2);
      expect(latest[0].hash).toBe('cc333333');
      expect(latest[1].hash).toBe('bb222222');
    });

    it('returns empty for non-positive or non-finite counts', () => {
      materialize('aa111111', 'file', 'src/a.ts', 10, 5, '');
      expect(getLatestRefs(0)).toEqual([]);
      expect(getLatestRefs(-1)).toEqual([]);
      expect(getLatestRefs(Number.NaN)).toEqual([]);
    });

    it('floors fractional counts', async () => {
      materialize('aa111111', 'file', 'src/a.ts', 10, 5, '');
      await advanceTurn();
      materialize('bb222222', 'file', 'src/b.ts', 10, 5, '');
      const latest = getLatestRefs(1.9);
      expect(latest).toHaveLength(1);
      expect(latest[0].hash).toBe('bb222222');
    });

    it('returns empty for infinite counts', () => {
      materialize('aa111111', 'file', 'src/a.ts', 10, 5, '');
      expect(getLatestRefs(Number.POSITIVE_INFINITY)).toEqual([]);
    });
  });

  describe('shouldMaterialize', () => {
    it('returns true for materialized chunk seen this turn', () => {
      const ref = materialize('aabbccdd11223344', 'file', 'src/foo.ts', 100, 25, '');
      expect(shouldMaterialize(ref)).toBe(true);
    });

    it('returns false after advanceTurn', async () => {
      const ref = materialize('aabbccdd11223344', 'file', 'src/foo.ts', 100, 25, '');
      await advanceTurn();
      expect(shouldMaterialize(ref)).toBe(false);
    });
  });

  describe('formatRefLine', () => {
    it('formats compact reference line', () => {
      const ref = materialize('aabbccdd11223344', 'file', 'src/foo.ts', 100, 25, 'fn bar:1-5');
      const line = formatRefLine(ref);
      expect(line).toContain('h:aabbcc');
      expect(line).toContain('src/foo.ts');
      expect(line).toContain('100tk');
      expect(line).toContain('25L');
    });
  });

  describe('sortRefs', () => {
    it('sorts file types before artifacts', () => {
      const fileRef = materialize('aa111111', 'file', 'src/foo.ts', 10, 5, '');
      const resultRef = materialize('bb222222', 'result', undefined, 10, 5, '');
      expect(sortRefs(fileRef, resultRef)).toBeLessThan(0);
    });
  });

  describe('createScopedView', () => {
    it('starts with local turn 0', () => {
      const view = createScopedView();
      expect(view.getTurn()).toBe(0);
    });

    it('advanceTurn increments local counter only', async () => {
      const globalTurnBefore = getTurn();
      const view = createScopedView();
      view.advanceTurn();
      view.advanceTurn();

      expect(view.getTurn()).toBe(2);
      expect(getTurn()).toBe(globalTurnBefore);
    });

    it('does not dematerialize global refs on local advanceTurn', async () => {
      const ref = materialize('scoped11', 'file', 'src/a.ts', 100, 10, '');
      expect(shouldMaterialize(ref)).toBe(true);

      const view = createScopedView();
      view.advanceTurn();
      view.advanceTurn();

      expect(shouldMaterialize(ref)).toBe(true);
      expect(ref.visibility).toBe('materialized');
    });

    it('reads refs from shared global Map', () => {
      materialize('shared11', 'file', 'src/b.ts', 200, 20, 'fn bar');
      const view = createScopedView();
      const ref = view.getRef('shared11');
      expect(ref).toBeDefined();
      expect(ref!.source).toBe('src/b.ts');
    });

    it('getActiveRefs returns global active refs', () => {
      materialize('active11', 'file', 'src/c.ts', 50, 5, '');
      evict('active11');
      materialize('active22', 'file', 'src/d.ts', 60, 6, '');

      const view = createScopedView();
      const active = view.getActiveRefs();
      expect(active.some(r => r.hash === 'active22')).toBe(true);
      expect(active.some(r => r.hash === 'active11')).toBe(false);
    });

    it('multiple scoped views are independent', () => {
      const v1 = createScopedView();
      const v2 = createScopedView();

      v1.advanceTurn();
      v1.advanceTurn();
      v1.advanceTurn();

      expect(v1.getTurn()).toBe(3);
      expect(v2.getTurn()).toBe(0);
    });
  });
});
