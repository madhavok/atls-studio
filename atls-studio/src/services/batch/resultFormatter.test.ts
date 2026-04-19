import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatBatchResult, stepOutputToResult } from './resultFormatter';
import type { StepOutput, StepResult, UnifiedBatchResult } from './types';
import { useContextStore } from '../../stores/contextStore';
import { freshnessTelemetry, getBatchFailureSummary } from '../freshnessTelemetry';
import { countTokensSync } from '../../utils/tokenCounter';

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

describe('resultFormatter step message invariants', () => {
  it('stepOutputToResult synthesizes summary when summary and error are empty', () => {
    const output: StepOutput = {
      kind: 'raw',
      ok: true,
      refs: ['h:abc'],
      summary: '',
    };
    const step = stepOutputToResult('s1', 'session.stats', output, 0);
    expect(step.summary).toBe('OK (1 ref)');
    expect(step.error).toBeUndefined();
  });

  it('stepOutputToResult synthesizes error on failure with no message', () => {
    const output: StepOutput = {
      kind: 'raw',
      ok: false,
      refs: [],
      summary: '',
    };
    const step = stepOutputToResult('s1', 'session.stats', output, 0);
    expect(step.error).toBe('Step failed (no message)');
  });

  it('formatBatchResult never omits a step line when summary and error are absent', () => {
    const result: UnifiedBatchResult = {
      ok: true,
      duration_ms: 1,
      step_results: [
        {
          id: 'x',
          use: 'session.stats',
          ok: true,
          duration_ms: 1,
          refs: ['h:abc123'],
        },
      ],
    };
    const out = formatBatchResult(result);
    expect(out).toContain('x (session.stats):');
    expect(out).toContain('[completed');
  });
});

// ---------------------------------------------------------------------------
// Rule A — failed-step dedupe
// ---------------------------------------------------------------------------

describe('resultFormatter Rule A — failed-step dedupe', () => {
  beforeEach(() => {
    freshnessTelemetry.reset();
    useContextStore.getState().resetSession();
  });

  afterEach(() => {
    freshnessTelemetry.reset();
  });

  function mkFail(id: string, use: string, message: string): StepResult {
    return {
      id,
      use: use as StepResult['use'],
      ok: false,
      duration_ms: 1,
      classification: 'fail',
      summary: message,
      error: message,
    };
  }

  it('collapses 3 identical read.lines failures to one exemplar + dedupe tail', () => {
    const msg = 'read_lines: requires lines (e.g. "15-50") or ref (h:XXXX:15-50) or (start_line + end_line).';
    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 3,
      step_results: [
        mkFail('r1', 'read.lines', msg),
        mkFail('r2', 'read.lines', msg),
        mkFail('r3', 'read.lines', msg),
      ],
    };

    const out = formatBatchResult(result);

    // Exemplar present exactly once
    const occurrences = out.split(msg).length - 1;
    expect(occurrences).toBe(1);

    // Dedupe tail lists the suppressed step IDs
    expect(out).toContain('[FAIL] +2 identical (r2, r3)');
    expect(out).toContain('same class: read.lines');

    // Footer still present
    expect(out).toContain('[ATLS] 3 steps:');
    expect(out).toContain('3 fail');
  });

  it('does not collapse failures with different messages', () => {
    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 3,
      step_results: [
        mkFail('r1', 'read.lines', 'missing param A'),
        mkFail('r2', 'read.lines', 'missing param B'),
      ],
    };

    const out = formatBatchResult(result);
    expect(out).toContain('missing param A');
    expect(out).toContain('missing param B');
    expect(out).not.toContain('+1 identical');
  });

  it('does not collapse failures with same message across different ops', () => {
    const msg = 'requires lines';
    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 2,
      step_results: [
        mkFail('r1', 'read.lines', msg),
        mkFail('r2', 'read.file', msg),
      ],
    };

    const out = formatBatchResult(result);
    const firstCount = out.split(msg).length - 1;
    expect(firstCount).toBe(2);
    expect(out).not.toContain('identical');
  });

  it('preserves mixed pass/fail ordering with dedupe tail attached to first fail', () => {
    const msg = 'same failure';
    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 4,
      step_results: [
        { id: 'p1', use: 'search.code', ok: true, duration_ms: 1, summary: 'ok pass' },
        mkFail('r1', 'read.lines', msg),
        { id: 'p2', use: 'search.code', ok: true, duration_ms: 1, summary: 'another pass' },
        mkFail('r2', 'read.lines', msg),
      ],
    };

    const out = formatBatchResult(result);
    const lines = out.split('\n');

    const r1Idx = lines.findIndex(l => l.startsWith('[FAIL] r1'));
    const tailIdx = lines.findIndex(l => l.startsWith('[FAIL] +1 identical'));
    const p2Idx = lines.findIndex(l => l.includes('p2 (search.code)'));

    expect(r1Idx).toBeGreaterThan(-1);
    expect(tailIdx).toBe(r1Idx + 1);
    expect(p2Idx).toBeGreaterThan(tailIdx);
    expect(lines.some(l => l.startsWith('[FAIL] r2'))).toBe(false);
  });

  it('records collapsed failures in freshnessTelemetry with full count', () => {
    const msg = 'read_lines: requires lines (e.g. "15-50")';
    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 3,
      step_results: [
        mkFail('r1', 'read.lines', msg),
        mkFail('r2', 'read.lines', msg),
        mkFail('r3', 'read.lines', msg),
      ],
    };

    formatBatchResult(result);
    const summary = getBatchFailureSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].op).toBe('read.lines');
    expect(summary[0].count).toBe(3);
    expect(summary[0].exampleStepIds).toContain('r1');
    expect(summary[0].exampleStepIds.length).toBeLessThanOrEqual(3);
  });

  it('writes BB entry when failure class crosses threshold', () => {
    const msg = 'identical error to force threshold cross';
    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 3,
      step_results: [
        mkFail('r1', 'read.lines', msg),
        mkFail('r2', 'read.lines', msg),
        mkFail('r3', 'read.lines', msg),
      ],
    };
    formatBatchResult(result);

    const store = useContextStore.getState();
    const entry = store.blackboardEntries.get('telemetry:failed-ops:session');
    expect(entry).toBeDefined();
    expect(entry!.content).toContain('read.lines');
    expect(entry!.content).toContain('x3');
  });

  it('does not write BB entry when below threshold', () => {
    const msg = 'only-twice error';
    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 2,
      step_results: [
        mkFail('r1', 'read.lines', msg),
        mkFail('r2', 'read.lines', msg),
      ],
    };
    formatBatchResult(result);

    const store = useContextStore.getState();
    const entry = store.blackboardEntries.get('telemetry:failed-ops:session');
    expect(entry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rule B — FileView-merge pointer
// ---------------------------------------------------------------------------

describe('resultFormatter Rule B — FileView-merge pointer', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  /**
   * Set up a pinned FileView for a path. Does NOT pre-fill filledRegions —
   * this mirrors real runtime: the rl handler auto-pins the view, but the
   * content merge into filledRegions happens asynchronously after the
   * formatter has already run. Rule B must work under this timing.
   */
  function setupPinnedViewNoFill(filePath: string): string {
    const store = useContextStore.getState();
    const revision = 'rev-' + filePath;
    const ref = store.ensureFileView(filePath, revision);
    store.setFileViewPinned(filePath, true);
    return ref;
  }

  it('emits merge pointer when view is pinned (fill is async — do not gate on filledRegions)', () => {
    const filePath = 'atls-studio/src/foo.ts';
    const ref = setupPinnedViewNoFill(filePath);

    const result: UnifiedBatchResult = {
      ok: true,
      duration_ms: 1,
      step_results: [
        {
          id: 'r1',
          use: 'read.lines',
          ok: true,
          duration_ms: 1,
          summary: 'read_lines: ... (full body, many tokens)\n ... body ...',
          tokens_delta: 500,
          artifacts: {
            file: filePath,
            hash: ref,
            actual_range: [[15, 25]],
          },
        },
      ],
    };

    const out = formatBatchResult(result);
    expect(out).toContain('merged into');
    expect(out).toContain(ref);
    expect(out).toContain('see ## FILE VIEWS');
    expect(out).not.toContain('full body, many tokens');
  });

  it('keeps full body when view is not pinned', () => {
    const filePath = 'atls-studio/src/foo.ts';
    const store = useContextStore.getState();
    const revision = 'rev-' + filePath;
    const ref = store.ensureFileView(filePath, revision);
    store.setFileViewPinned(filePath, false);

    const summary = 'read_lines: ... content body ...';
    const result: UnifiedBatchResult = {
      ok: true,
      duration_ms: 1,
      step_results: [
        {
          id: 'r1',
          use: 'read.lines',
          ok: true,
          duration_ms: 1,
          summary,
          artifacts: { file: filePath, hash: ref, actual_range: [[15, 25]] },
        },
      ],
    };

    const out = formatBatchResult(result);
    expect(out).not.toContain('merged into');
    expect(out).toContain('content body');
  });

  it('keeps full body when no FileView exists for the path (engram:* reads)', () => {
    const result: UnifiedBatchResult = {
      ok: true,
      duration_ms: 1,
      step_results: [
        {
          id: 'r1',
          use: 'read.lines',
          ok: true,
          duration_ms: 1,
          summary: 'read_lines: engram body preserved',
          artifacts: { file: 'engram:h:abc123', hash: 'h:abc123', actual_range: [[1, 10]] },
        },
      ],
    };

    const out = formatBatchResult(result);
    expect(out).not.toContain('merged into');
    expect(out).toContain('engram body preserved');
  });

  it('keeps body for failed read.lines (Rule B only applies to ok=true)', () => {
    const filePath = 'atls-studio/src/foo.ts';
    const ref = setupPinnedViewNoFill(filePath);

    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 1,
      step_results: [
        {
          id: 'r1',
          use: 'read.lines',
          ok: false,
          duration_ms: 1,
          summary: 'read_lines: ERROR something',
          error: 'read_lines: ERROR something',
          artifacts: { file: filePath, hash: ref, actual_range: [[15, 25]] },
        },
      ],
    };

    const out = formatBatchResult(result);
    expect(out).not.toContain('merged into');
    expect(out).toContain('ERROR something');
  });

  it('reduces token count substantially on merged pointer replacement', () => {
    const filePath = 'atls-studio/src/foo.ts';
    const ref = setupPinnedViewNoFill(filePath);

    // Fake a real-world read.lines body with many numbered lines
    const fatBody = Array.from({ length: 200 }, (_, i) => `${i + 1}| line content body number ${i + 1}`).join('\n');
    const fatSummary = `read_lines: ${filePath}:15-25 -> ${ref} (500tk, ctx:3 actual:15-25)\n${fatBody}`;

    const resultFat: UnifiedBatchResult = {
      ok: true, duration_ms: 1,
      step_results: [{
        id: 'r1', use: 'read.lines', ok: true, duration_ms: 1,
        summary: fatSummary, tokens_delta: 500,
        artifacts: { file: filePath, hash: ref, actual_range: [[15, 25]] },
      }],
    };

    const beforeTk = countTokensSync(fatSummary);
    const out = formatBatchResult(resultFat);
    const afterTk = countTokensSync(out);

    // Output should be dramatically smaller than the raw summary
    expect(afterTk).toBeLessThan(beforeTk / 4);
    expect(out).toContain('merged into');
  });
});
