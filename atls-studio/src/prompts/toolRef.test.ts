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

describe('BATCH_TOOL_REF param-shape accuracy', () => {
  const commonParams = BATCH_TOOL_REF.match(/### Common Params[\s\S]*?(?=\n### Examples)/)?.[0] ?? '';

  it('documents analyze.calls with symbol_names as primary param (not grouped with file_paths ops)', () => {
    const callsLine = commonParams.split('\n').find(l => l.startsWith('analyze.calls'));
    expect(callsLine, 'analyze.calls must have its own param line in Common Params').toBeTruthy();
    expect(callsLine).toContain('symbol_names');
    expect(callsLine).not.toContain('file_paths');
  });

  it('documents analyze.extract_plan with singular file_path', () => {
    const extractLine = commonParams.split('\n').find(l => l.startsWith('analyze.extract_plan'));
    expect(extractLine, 'analyze.extract_plan must have its own param line in Common Params').toBeTruthy();
    expect(extractLine).toContain('file_path:');
    expect(extractLine).toContain('strategy');
  });

  it('does not group analyze.calls with file_paths-primary analyze ops', () => {
    const groupedAnalyzeLine = commonParams.split('\n').find(l =>
      l.startsWith('analyze.') && l.includes('|') && l.includes('file_paths'),
    );
    if (groupedAnalyzeLine) {
      expect(groupedAnalyzeLine).not.toContain('calls');
    }
  });

  it('documents read.file with its own param line', () => {
    const readFileLine = commonParams.split('\n').find(l => l.startsWith('read.file'));
    expect(readFileLine, 'read.file must have its own param line in Common Params').toBeTruthy();
    expect(readFileLine).toContain('file_paths');
  });
});
