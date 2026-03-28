import { describe, expect, it } from 'vitest';
import { BATCH_TOOL_REF } from './toolRef';
import { ALL_OPERATIONS, OPERATION_FAMILIES, FAMILY_NAMES } from '../services/batch/families';
import { getHandler } from '../services/batch/opMap';

describe('BATCH_TOOL_REF drift detection', () => {
  it('contains every operation from families.ts in the Operation Families section', () => {
    const familiesMatch = BATCH_TOOL_REF.match(/### Operation Families\n([\s\S]*?)(?=\n###)/);
    expect(familiesMatch).toBeTruthy();
    const familiesBlock = familiesMatch![1];

    const missing = ALL_OPERATIONS.filter(op => !familiesBlock.includes(op));
    if (missing.length > 0) {
      throw new Error(
        `Operations missing from BATCH_TOOL_REF "Operation Families":\n  ${missing.join('\n  ')}\n` +
        'These are defined in families.ts but not appearing in the generated output.',
      );
    }
  });

  it('gives every non-intent operation a handler in opMap', () => {
    for (const op of ALL_OPERATIONS) {
      if (op.startsWith('intent.')) continue;
      expect(getHandler(op), `missing handler for ${op}`).toBeDefined();
    }
  });

  it('covers all 9 families', () => {
    expect(FAMILY_NAMES.length).toBe(9);
  });

  it('has no empty families', () => {
    for (const family of FAMILY_NAMES) {
      expect(OPERATION_FAMILIES[family].ops.length).toBeGreaterThan(0);
    }
  });
});
