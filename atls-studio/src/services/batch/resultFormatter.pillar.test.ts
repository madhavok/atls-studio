/**
 * ATLS Pillar gate — token-measurement tests for Rule A (failed-batch dedupe),
 * Rule B (FileView-merge pointer), and Rule C (skip-archive). Each fixture is
 * lifted from the real transcript that motivated the reduce-batch-shell-cruft
 * plan. Regressions here mean the compression guarantees have slipped.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { formatBatchResult } from './resultFormatter';
import type { StepResult, UnifiedBatchResult } from './types';
import { isContentArchiveWorthy } from '../historyCompressor';
import { useContextStore } from '../../stores/contextStore';
import { freshnessTelemetry } from '../freshnessTelemetry';
import { countTokensSync } from '../../utils/tokenCounter';

beforeEach(() => {
  freshnessTelemetry.reset();
  useContextStore.getState().resetSession();
});

describe('pillar gate — N-identical failure dedupe', () => {
  const msg = 'read_lines: requires lines (e.g. "15-50") or ref (h:XXXX:15-50) or (start_line + end_line).';
  const mkFail = (id: string): StepResult => ({
    id,
    use: 'read.lines' as StepResult['use'],
    ok: false,
    duration_ms: 40,
    classification: 'fail',
    summary: msg,
    error: msg,
  });

  function buildBefore(ids: string[]): string {
    return [
      ...ids.map(id => `[FAIL] ${id} (read.lines): ${msg} (40ms)`),
      `[ATLS] ${ids.length} steps: ${ids.length} fail (${ids.length * 40}ms) | ok`,
    ].join('\n');
  }

  it('N=3 identical failures: collapses to one exemplar + tail (~50% reduction)', () => {
    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 120,
      step_results: [mkFail('r1'), mkFail('r2'), mkFail('r3')],
    };

    const beforeTk = countTokensSync(buildBefore(['r1', 'r2', 'r3']));
    const afterTk = countTokensSync(formatBatchResult(result));

    // N=3 physics: (full + tail + footer) / (3*full + footer). ~55% is the
    // ceiling for short messages; longer messages push this lower. We assert
    // the honest floor and leave room for tokenizer variance.
    expect(afterTk / beforeTk).toBeLessThanOrEqual(0.6);
  });

  it('N=6 identical failures: savings scale (~30% of before)', () => {
    // Higher N means the amortized cost per suppressed step drops toward zero.
    // Same absolute fixture with more repetitions → dramatically better ratio.
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 240,
      step_results: ids.map(mkFail),
    };

    const beforeTk = countTokensSync(buildBefore(ids));
    const afterTk = countTokensSync(formatBatchResult(result));

    // N=6: collapsed output is one full line + one tail + footer ≈ 1/3 of before.
    expect(afterTk / beforeTk).toBeLessThanOrEqual(0.35);
  });

  it('collapsed failure batch is not archive-worthy (Rule C catches downstream)', () => {
    const result: UnifiedBatchResult = {
      ok: false,
      duration_ms: 120,
      step_results: [mkFail('r1'), mkFail('r2'), mkFail('r3')],
    };
    const afterText = formatBatchResult(result);
    expect(isContentArchiveWorthy(afterText, 'batch')).toBe(false);
  });
});

describe('pillar gate — pure retention batch (pi/pu/dro)', () => {
  it('retention-op batch (after compactRetentionOps) is not archive-worthy', () => {
    // After compactRetentionOps strips OK retention lines, the surviving content
    // is just the footer — status lines of OK retention ops are gone entirely.
    const content = '[ATLS] 2 steps: 2 pass (59ms) | ok';
    expect(isContentArchiveWorthy(content, 'batch')).toBe(false);
  });

  it('even pre-compaction retention-only batch is not archive-worthy', () => {
    // The OK lines themselves match BATCH_RESULT_LINE_RE so content is
    // classified non-worthy regardless of whether compactRetentionOps ran.
    const content = [
      '[OK] c1 (session.drop): drop: 5 chunks permanently dropped (9.6k freed, manifest entries kept) (7ms)',
      '[OK] c2 (session.unpin): unpin: 1 chunk unpinned (49ms)',
      '[ATLS] 2 steps: 2 pass (59ms) | ok',
    ].join('\n');
    expect(isContentArchiveWorthy(content, 'batch')).toBe(false);
  });
});

describe('pillar gate — 3-slice successful read merged into pinned FileView', () => {
  it('reduces read.lines body emit to pointer line (>= 75% reduction)', () => {
    const filePath = 'atls-studio/docs/architecture.md';
    const store = useContextStore.getState();
    const revision = 'rev-fixture';
    const ref = store.ensureFileView(filePath, revision);
    // Mirror real runtime: view is auto-pinned by the rl handler. Body merge
    // into filledRegions happens asynchronously AFTER the formatter runs, so
    // we only pin — do not pre-fill. Rule B relies on `view.pinned` as the
    // signal that the view will own the content by next round.
    const regions: Array<[number, number]> = [[243, 444], [564, 726], [909, 984]];
    store.setFileViewPinned(filePath, true);

    const mkOk = (id: string, range: [number, number], approxTk: number): StepResult => {
      const body = Array.from({ length: range[1] - range[0] + 1 },
        (_, i) => `${range[0] + i}| dense docs body line ${range[0] + i} with words and tokens`).join('\n');
      const header = `read_lines: ${filePath}:${range[0]}-${range[1]} -> ${ref} (slice h:slice${id}:${range[0]}-${range[1]}) (${approxTk}tk, ctx:3 actual:${range[0]}-${range[1]})`;
      const fullSummary = `${header}\n${body}`;
      return {
        id,
        use: 'read.lines' as StepResult['use'],
        ok: true,
        duration_ms: 90,
        summary: fullSummary,
        tokens_delta: approxTk,
        artifacts: {
          file: filePath,
          hash: ref,
          actual_range: [range],
        },
      };
    };

    const result: UnifiedBatchResult = {
      ok: true,
      duration_ms: 247,
      step_results: [
        mkOk('r1', [243, 444], 4305),
        mkOk('r2', [564, 726], 4000),
        mkOk('r3', [909, 984], 1208),
      ],
    };

    // Reconstruct the "before" text (raw body included) for comparison.
    const beforeText = result.step_results.map(s =>
      `[OK] ${s.id} (${s.use}): ${s.summary} (${s.duration_ms}ms)`
    ).join('\n') + '\n[ATLS] 3 steps: 3 pass (247ms) | ok';

    const afterText = formatBatchResult(result);
    const beforeTk = countTokensSync(beforeText);
    const afterTk = countTokensSync(afterText);

    // Rule B target: >= 75% token reduction on 3-slice merged-read fixture.
    expect(afterTk).toBeLessThanOrEqual(beforeTk * 0.25);

    expect((afterText.match(/see ## FILE VIEWS/g) || []).length).toBe(3);

    // And the batch result is not archive-worthy — Rule C skips the engram.
    expect(isContentArchiveWorthy(afterText, 'batch')).toBe(false);
  });
});
