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
