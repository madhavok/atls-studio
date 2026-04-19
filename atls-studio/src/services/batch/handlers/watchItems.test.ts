/**
 * Measurement gates for watch-items from the ATLS toolkit audit:
 *   1. `verify.*` tail + header budget (universal; works for build/typecheck/test/lint)
 *   2. `annotate.note` routing to FileView hashes (architectural correctness;
 *      covered in contextStore.fileView.test.ts)
 *
 * Delegate transparency was originally in scope but the per-round trace
 * digest turned out to add noise without signal (tool envelope names like
 * "batch" repeat every round). Refs + findings appendix already convey
 * what the sub-agent did; the digest was removed — see delegate.test.ts.
 *
 * See docs/output-compression.md and the toolkit-audit plan for the pillar
 * budgets these gates enforce.
 */
import { describe, it, expect } from 'vitest';
import { formatVerifyTail } from './verify';
import { countTokensSync } from '../../../utils/tokenCounter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simulate the backend `raw_tail` field (last ~20 lines of combined
 * stdout+stderr). The Rust side caps at 20 lines / 2KB; we mimic that.
 */
function makeLintRawTail(numIssues: number): string {
  const lines: string[] = [];
  // Rustc/clippy prints ~7 lines per diagnostic; we only see the tail portion.
  // Simulate the last ~20 lines which usually contains the last 2-3 warnings
  // plus the "warning: N warnings emitted" summary line.
  for (let i = Math.max(0, numIssues - 2); i < numIssues; i++) {
    lines.push(`warning: unused import: \`std::collections::HashMap\``);
    lines.push(`    --> atls-core/src/util_${i}.rs:5:5`);
    lines.push(`     |`);
    lines.push(`  5  | use std::collections::HashMap;`);
    lines.push(`     |     ^^^^^^^^^^^^^^^^^^^^^^^^^`);
    lines.push(``);
  }
  lines.push(`warning: \`atls-core\` (lib) generated ${numIssues} warnings`);
  return lines.slice(-20).join('\n');
}

// ---------------------------------------------------------------------------
// 1. verify.* tail + header budget
// ---------------------------------------------------------------------------

describe('formatVerifyTail — universal verify output primitive', () => {
  it('stays under ~900 token budget on a 50-issue lint run (gate: vl 26.6k → <900)', () => {
    const raw = {
      type: 'lint',
      success: false,
      issue_count: 50,
      exit_code: 101,
      raw_tail: makeLintRawTail(50),
    };
    const result = formatVerifyTail(raw, 'lint', false);
    const tokens = countTokensSync(result);
    // Plan target: ~500-700 tokens per run. Gate: <=900 (50% headroom).
    expect(tokens).toBeLessThanOrEqual(900);
    // Status header sanity: has verify.lint + failure + issue count + exit code
    expect(result.startsWith('verify.lint: failed (50 issues, exit 101)')).toBe(true);
  });

  it('emits only the status header when raw_tail is absent (passing build)', () => {
    const raw = { type: 'build', success: true };
    const result = formatVerifyTail(raw, 'build', true);
    expect(result).toBe('verify.build: passed');
    expect(countTokensSync(result)).toBeLessThan(10);
  });

  it('includes issue count only when provided (avoids "(undefined issues)")', () => {
    const raw = { type: 'typecheck', success: true, exit_code: 0 };
    const result = formatVerifyTail(raw, 'typecheck', true);
    expect(result).toBe('verify.typecheck: passed (exit 0)');
  });

  it('handles pytest-shaped tail (no parsing assumptions)', () => {
    const raw = {
      type: 'test',
      success: false,
      exit_code: 1,
      raw_tail: [
        '=========================== short test summary info ===========================',
        'FAILED tests/test_foo.py::test_bar - AssertionError: expected 42, got 43',
        'FAILED tests/test_baz.py::test_qux - TypeError: cannot unpack',
        '======================== 2 failed, 18 passed in 0.85s =========================',
      ].join('\n'),
    };
    const result = formatVerifyTail(raw, 'test', false);
    expect(result).toContain('verify.test: failed (exit 1)');
    expect(result).toContain('2 failed, 18 passed');
  });

  it('trims trailing newlines from raw_tail to avoid blank lines in context', () => {
    const raw = {
      type: 'lint',
      success: true,
      raw_tail: 'all good\n\n\n',
    };
    const result = formatVerifyTail(raw, 'lint', true);
    expect(result).toBe('verify.lint: passed\nall good');
  });
});

// ---------------------------------------------------------------------------
// Measurement reporter (non-gating — records actual numbers for the record)
// ---------------------------------------------------------------------------

describe('measurement gates — actuals', () => {
  it('reports actual token counts for watch-item outputs', () => {
    const lintRaw = {
      type: 'lint',
      success: false,
      issue_count: 50,
      exit_code: 101,
      raw_tail: makeLintRawTail(50),
    };
    const lintResult = formatVerifyTail(lintRaw, 'lint', false);
    const lintTokens = countTokensSync(lintResult);

    const passBuild = formatVerifyTail({ type: 'build', success: true, exit_code: 0 }, 'build', true);
    const passBuildTokens = countTokensSync(passBuild);

    console.log(`[watch-item measurements]`);
    console.log(`  vl (50 issues, with raw_tail): ${lintTokens} tk (target: 500-700; gate: <=900)`);
    console.log(`  vb (pass, no raw_tail):        ${passBuildTokens} tk (target: <10)`);

    expect(lintTokens).toBeGreaterThan(100);
  });
});
