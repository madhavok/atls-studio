import { describe, expect, it } from 'vitest';
import { BATCH_TOOL_REF, BATCH_TOOL_REF_V2 } from './toolRef';
import { ALL_OPERATIONS, OPERATION_FAMILIES, FAMILY_NAMES } from '../services/batch/families';
import { getHandler } from '../services/batch/opMap';
import { SHORT_TO_OP, OP_TO_SHORT } from '../services/batch/opShorthand';

describe('BATCH_TOOL_REF drift detection', () => {
  it.each([
    ['v1', BATCH_TOOL_REF],
    ['v2', BATCH_TOOL_REF_V2],
  ])('contains every operation in the %s Operation Families section', (_label, toolRef) => {
    const familiesMatch = toolRef.match(/### Operation Families\n([\s\S]*?)(?=\n###)/);
    expect(familiesMatch).toBeTruthy();
    const familiesBlock = familiesMatch![1];

    const missing = ALL_OPERATIONS.filter(op => {
      const short = OP_TO_SHORT[op];
      return short ? !familiesBlock.includes(short) : !familiesBlock.includes(op);
    });
    if (missing.length > 0) {
      throw new Error(
        `Operations missing from BATCH_TOOL_REF "Operation Families":\n  ${missing.join('\n  ')}\n` +
        'These are defined in families.ts but their shorthands are not in the generated output.',
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

  it.each([
    ['v1', BATCH_TOOL_REF],
    ['v2', BATCH_TOOL_REF_V2],
  ])('contains the shorthand legend with all short codes in %s', (_label, toolRef) => {
    expect(toolRef).toContain('### Short codes');
    expect(toolRef).toContain('sc=search.code');
    expect(toolRef).toContain('ps=file_paths');
  });
});

describe('BATCH_TOOL_REF param-shape accuracy', () => {
  const commonParams = BATCH_TOOL_REF.match(/### Common Params[\s\S]*?(?=\n### Examples)/)?.[0] ?? '';

  it('documents analyze.calls (ac) with sn as primary param', () => {
    const callsLine = commonParams.split('\n').find(l => l.startsWith('ac '));
    expect(callsLine, 'ac (analyze.calls) must have its own param line').toBeTruthy();
    expect(callsLine).toContain('sn:');
  });

  it('documents analyze.extract_plan (ax) with singular file_path', () => {
    const extractLine = commonParams.split('\n').find(l => l.startsWith('ax '));
    expect(extractLine, 'ax (analyze.extract_plan) must have its own param line').toBeTruthy();
    expect(extractLine).toContain('f:');
    expect(extractLine).toContain('strategy');
  });

  it('does not group ac with ps-primary analyze ops', () => {
    const groupedAnalyzeLine = commonParams.split('\n').find(l =>
      l.startsWith('ad|') && l.includes('ps:'),
    );
    if (groupedAnalyzeLine) {
      expect(groupedAnalyzeLine).not.toMatch(/\bac\b/);
    }
  });

  it('documents read.file (rf) with its own param line', () => {
    const readFileLine = commonParams.split('\n').find(l => l.startsWith('rf '));
    expect(readFileLine, 'rf (read.file) must have its own param line').toBeTruthy();
    expect(readFileLine).toContain('ps:');
  });
});

describe('opShorthand consistency with BATCH_TOOL_REF', () => {
  it('every shorthand in SHORT_TO_OP maps to a valid OperationKind', () => {
    const allOps = new Set(ALL_OPERATIONS);
    for (const op of Object.values(SHORT_TO_OP)) {
      expect(allOps.has(op), `SHORT_TO_OP value ${op} not in ALL_OPERATIONS`).toBe(true);
    }
  });

  it('OP_TO_SHORT has exactly one entry per OperationKind', () => {
    for (const op of ALL_OPERATIONS) {
      expect(OP_TO_SHORT[op]).toBeDefined();
    }
  });
});
