/**
 * Hard HPP state machine tests — exercises multi-turn lifecycle, eviction,
 * re-materialization, set-ref queries, and edge cases.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTurn, advanceTurn, resetProtocol, materialize, dematerialize,
  evict, getRef, getAllRefs, getActiveRefs, getRefsBySource,
  getRefsByType, getLatestRefs, queryRefs, shouldMaterialize,
  formatRefLine, sortRefs,
} from './hashProtocol';

describe('HPP hard tests', () => {
  beforeEach(() => resetProtocol());

  // ── Full lifecycle: materialize → referenced → evicted → re-materialize ──

  it('full visibility lifecycle', async () => {
    const ref1 = materialize('aabbccdd11223344', 'file', 'src/auth.ts', 500, 80, 'fn login:1-30');
    expect(ref1.visibility).toBe('materialized');
    expect(shouldMaterialize(ref1)).toBe(true);

    await advanceTurn();
    expect(ref1.visibility).toBe('referenced');
    expect(shouldMaterialize(ref1)).toBe(false);

    evict('aabbccdd11223344');
    expect(ref1.visibility).toBe('evicted');
    expect(getActiveRefs()).toHaveLength(0);

    const ref2 = materialize('aabbccdd11223344', 'file', 'src/auth.ts', 600, 85, 'fn login:1-35');
    expect(ref2.visibility).toBe('materialized');
    expect(ref2.tokens).toBe(600);
    expect(ref2.totalLines).toBe(85);
    expect(getActiveRefs()).toHaveLength(1);
  });

  // ── Multiple chunks across turns ──

  it('10 chunks across 5 turns with mixed operations', async () => {
    const hashes = Array.from({ length: 10 }, (_, i) =>
      `${(i + 10).toString(16).padStart(8, '0')}${(i + 20).toString(16).padStart(8, '0')}`
    );

    // Turn 0: materialize first 3
    for (let i = 0; i < 3; i++) {
      materialize(hashes[i], 'file', `src/file${i}.ts`, 100 + i, 10 + i, '');
    }
    expect(getAllRefs()).toHaveLength(3);

    // Turn 1: advance, materialize 3 more, dematerialize one
    await advanceTurn();
    for (let i = 3; i < 6; i++) {
      materialize(hashes[i], 'file', `src/file${i}.ts`, 100 + i, 10 + i, '');
    }
    dematerialize(hashes[0]);
    expect(getActiveRefs().filter(r => r.visibility === 'materialized')).toHaveLength(3);

    // Turn 2: evict two, re-materialize one
    await advanceTurn();
    evict(hashes[1]);
    evict(hashes[2]);
    materialize(hashes[0], 'file', 'src/file0.ts', 200, 20, 'updated');
    // 3-5 are referenced (3 refs), 0 is re-materialized (1 ref) = 4 active
    // (0 was already dematerialized/referenced, not a new ref)
    expect(getActiveRefs()).toHaveLength(4);
    expect(getAllRefs()).toHaveLength(6);

    // Turn 3: materialize remaining 4
    await advanceTurn();
    for (let i = 6; i < 10; i++) {
      materialize(hashes[i], 'file', `src/file${i}.ts`, 100 + i, 10 + i, '');
    }
    expect(getAllRefs()).toHaveLength(10);
    expect(getActiveRefs()).toHaveLength(8); // 2 evicted

    // Turn 4: check latest refs
    await advanceTurn();
    const latest = getLatestRefs(3);
    expect(latest).toHaveLength(3);
    expect(latest[0].seenAtTurn).toBeGreaterThanOrEqual(latest[1].seenAtTurn);
  });

  // ── queryRefs covers all selector kinds ──

  it('queryRefs by file pattern', () => {
    materialize('aa111111', 'file', 'src/components/Button.tsx', 100, 50, '');
    materialize('bb222222', 'file', 'src/components/Modal.tsx', 100, 50, '');
    materialize('cc333333', 'file', 'src/utils/hash.ts', 100, 50, '');

    const result = queryRefs({ kind: 'file', pattern: 'src/components/*' });
    expect(result).toHaveLength(2);
  });

  it('queryRefs by type', () => {
    materialize('aa111111', 'file', 'src/a.ts', 100, 50, '');
    materialize('bb222222', 'result', undefined, 50, 10, '');
    materialize('cc333333', 'file', 'src/b.ts', 100, 50, '');

    expect(queryRefs({ kind: 'type', chunkType: 'file' })).toHaveLength(2);
    expect(queryRefs({ kind: 'type', chunkType: 'result' })).toHaveLength(1);
  });

  it('queryRefs all vs evicted', () => {
    materialize('aa111111', 'file', 'src/a.ts', 100, 50, '');
    materialize('bb222222', 'file', 'src/b.ts', 100, 50, '');
    evict('aa111111');

    expect(queryRefs({ kind: 'all' })).toHaveLength(1);
    expect(getAllRefs()).toHaveLength(2);
  });

  it('queryRefs edited returns result type only', () => {
    materialize('aa111111', 'file', 'src/a.ts', 100, 50, '');
    materialize('bb222222', 'result', undefined, 50, 10, '');
    expect(queryRefs({ kind: 'edited' })).toHaveLength(1);
    expect(queryRefs({ kind: 'edited' })[0].type).toBe('result');
  });

  // ── getRef prefix matching ──

  it('getRef matches by prefix', () => {
    materialize('aabbccdd11223344', 'file', 'src/x.ts', 100, 50, '');
    expect(getRef('aabbcc')).toBeDefined(); // shortHash (6-char)
    expect(getRef('aabbccdd')).toBeDefined(); // full hash prefix
    // getRef does prefix matching via hash.startsWith, so 4-char prefix still matches
    expect(getRef('aabb')).toBeDefined();
  });

  // ── formatRefLine with and without digest ──

  it('formatRefLine with digest includes newline', () => {
    const ref1 = materialize('aabbccdd11223344', 'file', 'src/auth.ts', 2400, 89, 'fn authenticate:15-32 | cls AuthService:34-89');
    const line = formatRefLine(ref1);
    expect(line).toBe('h:aabbcc src/auth.ts 2400tk 89L\nfn authenticate:15-32 | cls AuthService:34-89');
  });

  it('formatRefLine without digest is one line', () => {
    const ref1 = materialize('aabbccdd11223344', 'file', 'src/simple.ts', 100, 20, '');
    const line = formatRefLine(ref1);
    expect(line).toBe('h:aabbcc src/simple.ts 100tk 20L');
    expect(line.includes('\n')).toBe(false);
  });

  // ── sortRefs: file types first, then by recency ──

  it('sortRefs complex ordering', async () => {
    const r1 = materialize('aa111111', 'file', 'src/a.ts', 100, 50, '');
    await advanceTurn();
    const r2 = materialize('bb222222', 'result', undefined, 50, 10, '');
    await advanceTurn();
    const r3 = materialize('cc333333', 'file', 'src/c.ts', 100, 50, '');
    const r4 = materialize('dd444444', 'result', undefined, 50, 10, '');

    const sorted = [r1, r2, r3, r4].sort(sortRefs);
    // Files first (r3 newer than r1), then results (r4 newer than r2)
    expect(sorted[0].hash).toBe('cc333333');
    expect(sorted[1].hash).toBe('aa111111');
    expect(sorted[2].hash).toBe('dd444444');
    expect(sorted[3].hash).toBe('bb222222');
  });

  // ── Edge: many refs with same source ──

  it('multiple versions of same file', async () => {
    materialize('aaaa1111', 'file', 'src/api.ts', 100, 50, 'v1');
    await advanceTurn();
    materialize('bbbb2222', 'file', 'src/api.ts', 120, 55, 'v2');

    const bySource = getRefsBySource('src/api.ts');
    expect(bySource).toHaveLength(2);
  });

  // ── Edge: dematerialize a non-existent hash is silent ──

  it('dematerialize unknown hash is no-op', () => {
    dematerialize('nonexistent1234');
    expect(getAllRefs()).toHaveLength(0);
  });

  it('evict unknown hash is no-op', () => {
    evict('nonexistent1234');
    expect(getAllRefs()).toHaveLength(0);
  });
});