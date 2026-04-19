/**
 * Measurement gates for the three watch-items from the ATLS toolkit audit:
 *   1. `verify.*` tail + header budget (universal; works for build/typecheck/test/lint)
 *   2. `delegate.retrieve` round-digest overhead + cap enforcement
 *   3. `annotate.note` routing to FileView hashes (architectural correctness)
 *
 * See docs/output-compression.md and the toolkit-audit plan for the pillar
 * budgets these gates enforce.
 */
import { describe, it, expect } from 'vitest';
import { formatVerifyTail } from './verify';
import { buildRoundDigest } from './delegate';
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
// 2. delegate.retrieve round-digest
// ---------------------------------------------------------------------------

describe('buildRoundDigest — delegate transparency', () => {
  const mkTrace = (rounds: number, actionsPerRound: number) => {
    const out: Array<{ toolName: string; message: string; round: number; ts: number; done: boolean }> = [];
    let ts = 1_000_000;
    for (let r = 0; r < rounds; r++) {
      for (let a = 0; a < actionsPerRound; a++) {
        out.push({
          toolName: 'search.code',
          message: `Searching: query-${r}-${a}`,
          round: r,
          ts: ts++,
          done: false,
        });
        out.push({ toolName: 'search.code', message: `Done: search.code`, round: r, ts: ts++, done: true });
      }
    }
    return out;
  };

  it('produces a compact per-round digest under 300 tokens (gate)', () => {
    const trace = mkTrace(5, 3);
    const digest = buildRoundDigest(trace);
    expect(countTokensSync(digest)).toBeLessThanOrEqual(300);
    expect(digest).toContain('R1:');
    expect(digest).toContain('R5:');
    expect(digest).toContain('query-0-0');
  });

  it('skips "Done:" entries; only start entries land in the digest', () => {
    const trace = mkTrace(2, 1);
    const digest = buildRoundDigest(trace);
    expect(digest).not.toContain('Done:');
  });

  it('returns empty string on empty or missing trace (zero overhead)', () => {
    expect(buildRoundDigest(undefined)).toBe('');
    expect(buildRoundDigest([])).toBe('');
  });

  it('caps actions per round (does not explode on chatty rounds)', () => {
    const trace = mkTrace(1, 10);
    const digest = buildRoundDigest(trace);
    // DELEGATE_TRACE_ACTIONS_PER_ROUND = 3, so only 3 actions surface.
    const matches = digest.match(/query-0-/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(3);
  });

  it('truncates with "…" tail when over the 300-token cap', () => {
    const trace = mkTrace(50, 3); // very chatty run
    const digest = buildRoundDigest(trace);
    expect(countTokensSync(digest)).toBeLessThanOrEqual(300);
    expect(digest).toMatch(/…/);
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

    const trace5x3: Array<{ toolName: string; message: string; round: number; ts: number; done: boolean }> = [];
    for (let r = 0; r < 5; r++) {
      for (let a = 0; a < 3; a++) {
        trace5x3.push({
          toolName: 'search.code',
          message: `Searching: eviction-query-${r}-${a}`,
          round: r,
          ts: 1000 + r * 10 + a,
          done: false,
        });
        trace5x3.push({ toolName: 'search.code', message: 'Done: search.code', round: r, ts: 1001 + r * 10 + a, done: true });
      }
    }
    const digest = buildRoundDigest(trace5x3);
    const digestTokens = countTokensSync(digest);

    // Emit to console for log inspection (test-level visibility, not assertion).
    console.log(`[watch-item measurements]`);
    console.log(`  vl (50 issues, with raw_tail): ${lintTokens} tk (target: 500-700; gate: <=900)`);
    console.log(`  vb (pass, no raw_tail):        ${passBuildTokens} tk (target: <10)`);
    console.log(`  dr digest (5 rounds × 3 act):  ${digestTokens} tk (target: <=300)`);

    // Soft sanity bounds — the hard gates are in the dedicated describe blocks.
    expect(lintTokens).toBeGreaterThan(100);
    expect(digestTokens).toBeGreaterThan(0);
  });
});
