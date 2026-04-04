import { describe, expect, it } from 'vitest';

import { formatBatchResult, stepOutputToResult } from './resultFormatter';
import type { StepOutput, UnifiedBatchResult } from './types';

describe('resultFormatter verification confidence', () => {
  it('formats cached verification results with a confidence label', () => {
    const result: UnifiedBatchResult = {
      ok: true,
      duration_ms: 12,
      step_results: [
        {
          id: 'verify',
          use: 'verify.build',
          ok: true,
          duration_ms: 12,
          summary: 'build passed',
          artifacts: {
            summary: { source: 'cache' },
          },
          verification_confidence: 'cached',
        },
      ],
    };

    expect(formatBatchResult(result)).toContain('(cached)');
  });

  it('stores fresh verification confidence on step results', () => {
    const output: StepOutput = {
      kind: 'verify_result',
      ok: true,
      refs: [],
      summary: 'tests passed',
      content: { summary: { source: 'command' } },
    };

    expect(stepOutputToResult('verify', 'verify.test', output, 33).verification_confidence).toBe('fresh');
  });

  it('stores stale-suspect verification confidence on step results', () => {
    const output: StepOutput = {
      kind: 'verify_result',
      ok: true,
      refs: [],
      summary: 'build reused',
      content: { suspect_external_change: true },
    };

    expect(stepOutputToResult('verify', 'verify.build', output, 21).verification_confidence).toBe('stale-suspect');
  });

  it('formats stale-suspect verification results with a confidence label', () => {
    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 15,
      step_results: [
        {
          id: 'verify',
          use: 'verify.build',
          ok: true,
          duration_ms: 15,
          summary: 'build reused',
          artifacts: {
            suspect_external_change: true,
          },
          verification_confidence: 'stale-suspect',
        },
      ],
    };

    expect(formatBatchResult(result)).toContain('(stale-suspect)');
  });
});

describe('resultFormatter truncation anchors', () => {
  const longSummary = 'x'.repeat(2500);

  it('does not truncate read.lines steps regardless of summary length', () => {
    const readSummary = 'x'.repeat(5000);
    const result: UnifiedBatchResult = {
      ok: true,
      duration_ms: 1,
      step_results: [
        {
          id: 'r1',
          use: 'read.lines',
          ok: true,
          duration_ms: 1,
          summary: readSummary,
          artifacts: {
            file: 'src/components/index.tsx',
            actual_range: [[628, 682]],
          },
        },
      ],
    };

    const out = formatBatchResult(result);
    expect(out).not.toContain('chars omitted');
    expect(out).toContain(readSummary);
  });

  it('does not truncate read.context steps', () => {
    const readSummary = 'x'.repeat(5000);
    const result: UnifiedBatchResult = {
      ok: true,
      duration_ms: 1,
      step_results: [
        {
          id: 'r1',
          use: 'read.context',
          ok: true,
          duration_ms: 1,
          summary: readSummary,
        },
      ],
    };

    const out = formatBatchResult(result);
    expect(out).not.toContain('chars omitted');
    expect(out).toContain(readSummary);
  });

  it('appends file:range anchor when non-read summary is middle-truncated', () => {
    const result: UnifiedBatchResult = {
      ok: true,
      duration_ms: 1,
      step_results: [
        {
          id: 's1',
          use: 'search.code',
          ok: true,
          duration_ms: 1,
          summary: longSummary,
          artifacts: {
            file: 'src/components/index.tsx',
            actual_range: [[628, 682]],
          },
        },
      ],
    };

    const out = formatBatchResult(result);
    expect(out).toContain('chars omitted —');
    expect(out).toContain('index.tsx:628-682');
  });

  it('appends h: ref + line span from first hash ref when artifacts absent', () => {
    const result: UnifiedBatchResult = {
      ok: true,
      duration_ms: 1,
      step_results: [
        {
          id: 's1',
          use: 'search.code',
          ok: true,
          duration_ms: 1,
          summary: longSummary,
          refs: ['h:abcdef012345:628-682'],
        },
      ],
    };

    const out = formatBatchResult(result);
    expect(out).toContain('chars omitted —');
    expect(out).toContain('h:abcdef:628-682');
  });
});
