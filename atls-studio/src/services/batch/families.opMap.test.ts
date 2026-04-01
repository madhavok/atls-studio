import { describe, it, expect } from 'vitest';
import { ALL_OPERATIONS, OPERATION_FAMILIES, FAMILY_NAMES } from './families';
import { getHandler } from './opMap';
import type { OperationKind } from './types';

describe('families and opMap invariants', () => {
  it('lists every operation exactly once across families', () => {
    const set = new Set(ALL_OPERATIONS);
    expect(set.size).toBe(ALL_OPERATIONS.length);
  });

  it('every non-intent operation has a concrete handler', () => {
    const concrete = ALL_OPERATIONS.filter((o): o is OperationKind => !o.startsWith('intent.'));
    for (const op of concrete) {
      expect(getHandler(op), `missing handler for ${op}`).toBeDefined();
    }
  });

  it('intent family is listed only under intent', () => {
    const intentOps = OPERATION_FAMILIES.intent.ops.map(e => e.op);
    for (const name of FAMILY_NAMES) {
      if (name === 'intent') continue;
      for (const e of OPERATION_FAMILIES[name].ops) {
        expect(e.op.startsWith('intent.')).toBe(false);
      }
    }
    expect(intentOps.every(o => o.startsWith('intent.'))).toBe(true);
  });
});
