import { describe, expect, it } from 'vitest';
import type { StepResult } from './batch/types';
import {
  extractReadDiversityFromStepResults,
  formatActualRangeLabel,
  getRoundFingerprint,
  recordReadDiversity,
  resetRoundFingerprint,
} from './spinDiagnostics';

function step(partial: Partial<StepResult> & Pick<StepResult, 'id' | 'use' | 'ok'>): StepResult {
  return {
    duration_ms: 0,
    ...partial,
  } as StepResult;
}

describe('formatActualRangeLabel', () => {
  it('serializes ranges like the batch executor', () => {
    expect(formatActualRangeLabel([[10, 20], [30, null]])).toBe('10-20,30');
    expect(formatActualRangeLabel([])).toBeUndefined();
    expect(formatActualRangeLabel(undefined)).toBeUndefined();
  });
});

describe('extractReadDiversityFromStepResults', () => {
  it('counts only successful read.* steps', () => {
    const steps: StepResult[] = [
      step({ id: 'a', use: 'read.lines', ok: true, artifacts: { file: 'src/a.ts', actual_range: [[1, 5]] } }),
      step({ id: 'b', use: 'read.lines', ok: false, artifacts: { file: 'src/b.ts' } }),
      step({ id: 'c', use: 'search.code', ok: true, artifacts: { file: 'src/c.ts' } }),
    ];
    expect(extractReadDiversityFromStepResults(steps)).toEqual({
      readFileStepCount: 1,
      uniqueReadPaths: 1,
      uniqueReadSpans: 1,
    });
  });

  it('dedupes same path, different ranges as distinct spans', () => {
    const steps: StepResult[] = [
      step({ id: 'a', use: 'read.lines', ok: true, artifacts: { file: 'src/x.ts', actual_range: [[1, 5]] } }),
      step({ id: 'b', use: 'read.lines', ok: true, artifacts: { file: 'src/x.ts', actual_range: [[20, 30]] } }),
    ];
    expect(extractReadDiversityFromStepResults(steps)).toEqual({
      readFileStepCount: 2,
      uniqueReadPaths: 1,
      uniqueReadSpans: 2,
    });
  });

  it('uses * when actual_range is absent (whole-file style)', () => {
    const steps: StepResult[] = [
      step({ id: 'a', use: 'read.file', ok: true, artifacts: { file: 'Src/Z.ts' } }),
    ];
    const r = extractReadDiversityFromStepResults(steps);
    expect(r.readFileStepCount).toBe(1);
    expect(r.uniqueReadPaths).toBe(1);
    expect(r.uniqueReadSpans).toBe(1);
  });

  it('collects multiple files from results[]', () => {
    const steps: StepResult[] = [
      step({
        id: 'a',
        use: 'read.shaped',
        ok: true,
        artifacts: {
          results: [
            { file: 'a.ts', actual_range: [[1, 2]] },
            { file: 'b.ts' },
          ],
        },
      }),
    ];
    expect(extractReadDiversityFromStepResults(steps)).toEqual({
      readFileStepCount: 1,
      uniqueReadPaths: 2,
      uniqueReadSpans: 2,
    });
  });

  it('increments read count but adds no spans when artifacts missing', () => {
    const steps: StepResult[] = [step({ id: 'a', use: 'read.lines', ok: true })];
    expect(extractReadDiversityFromStepResults(steps)).toEqual({
      readFileStepCount: 1,
      uniqueReadPaths: 0,
      uniqueReadSpans: 0,
    });
  });
});

describe('recordReadDiversity', () => {
  it('accumulates across multiple calls (round with two batch tools)', () => {
    resetRoundFingerprint();
    recordReadDiversity([
      step({ id: 'a', use: 'read.lines', ok: true, artifacts: { file: 'x.ts', actual_range: [[1, 1]] } }),
    ]);
    recordReadDiversity([
      step({ id: 'b', use: 'read.lines', ok: true, artifacts: { file: 'x.ts', actual_range: [[2, 2]] } }),
    ]);
    const fp = getRoundFingerprint();
    expect(fp.readFileStepCount).toBe(2);
    expect(fp.uniqueReadPaths).toBe(1);
    expect(fp.uniqueReadSpans).toBe(2);
  });
});
