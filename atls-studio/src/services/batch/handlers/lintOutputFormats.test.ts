/**
 * Measurement test — compares candidate lint output formats to find the
 * best token-per-signal ratio for `verify.lint`. The live audit showed our
 * current `raw_tail` approach (subprocess stdout tail) returns ~833 tokens
 * for 50 clippy warnings, because `cargo clippy --message-format=json`
 * emits NDJSON: each line is a serialized compiler-message, so tailing
 * the last 20 lines captures the last ~1-2 full diagnostics at ~400tk each.
 *
 * Since the Rust backend already parses every supported linter into a
 * uniform `{issues: [...]}` array (clippy NDJSON, ESLint JSON, flake8
 * keyed object, golangci-lint Issues[]), we can render it ourselves — no
 * per-linter parsing downstream needed. This test measures the options.
 *
 * The winner should feed future verify.ts changes.
 */
import { describe, it, expect } from 'vitest';
import { countTokensSync } from '../../../utils/tokenCounter';
import { formatResult } from '../../../utils/toon';
import { formatVerifyTail } from './verify';

// ---------------------------------------------------------------------------
// Fixtures — realistic shapes from the Rust backend
// ---------------------------------------------------------------------------

/**
 * Simulate a parsed clippy issue (the `compiler-message.message` object that
 * the backend stores in `issues[]`). Includes `rendered` field which is the
 * pretty-printed diagnostic cargo would emit to a human terminal.
 */
function makeClippyIssue(idx: number) {
  const file = `atls-core/src/util_${idx}.rs`;
  const line = 5 + idx;
  return {
    level: 'warning',
    message: 'unused import: `std::collections::HashMap`',
    code: { code: 'unused_imports', explanation: null },
    spans: [
      {
        file_name: file,
        byte_start: 1000 + idx * 20,
        byte_end: 1025 + idx * 20,
        line_start: line,
        line_end: line,
        column_start: 5,
        column_end: 30,
        is_primary: true,
        text: [{ text: 'use std::collections::HashMap;', highlight_start: 5, highlight_end: 30 }],
        label: null,
        suggested_replacement: null,
        suggestion_applicability: null,
        expansion: null,
      },
    ],
    children: [
      {
        message: '`#[warn(unused_imports)]` on by default',
        code: null,
        level: 'note',
        spans: [],
        children: [],
        rendered: null,
      },
    ],
    rendered:
      `warning: unused import: \`std::collections::HashMap\`\n` +
      `    --> ${file}:${line}:5\n` +
      `     |\n` +
      `  ${line}  | use std::collections::HashMap;\n` +
      `     |     ^^^^^^^^^^^^^^^^^^^^^^^^^\n` +
      `     |\n` +
      `     = note: \`#[warn(unused_imports)]\` on by default\n`,
  };
}

/** ESLint-shape issue: array-of-file-results, each file has messages[]. */
function makeEslintFileResult(fileIdx: number) {
  return {
    filePath: `/abs/path/src/module${fileIdx}.ts`,
    messages: [
      {
        ruleId: 'no-unused-vars',
        severity: 1,
        message: "'foo' is defined but never used.",
        line: 10 + fileIdx,
        column: 7,
        nodeType: 'Identifier',
        messageId: 'unusedVar',
        endLine: 10 + fileIdx,
        endColumn: 10,
      },
    ],
    errorCount: 0,
    fatalErrorCount: 0,
    warningCount: 1,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
    source: null,
    usedDeprecatedRules: [],
  };
}

/** flake8-shape issue: per-file entry with {code, line_number, ...}. */
function makeFlake8Issue(idx: number) {
  return {
    code: 'F401',
    filename: `src/mod_${idx}.py`,
    line_number: 3,
    column_number: 1,
    text: "'os' imported but unused",
    physical_line: 'import os',
  };
}

// ---------------------------------------------------------------------------
// Candidate formatters
// ---------------------------------------------------------------------------

/** A. Current Rust approach: tail of raw NDJSON stdout (20 lines / 2KB). */
function tailRawNdjson(issues: unknown[]): string {
  const ndjsonLines = issues.map(msg =>
    JSON.stringify({ reason: 'compiler-message', package_id: 'atls-core 0.1.0 (path+…)', manifest_path: 'Cargo.toml', target: { name: 'atls-core' }, message: msg }),
  );
  const combined = ndjsonLines.join('\n');
  const lines = combined.split('\n');
  const from = Math.max(0, lines.length - 20);
  const tailed = lines.slice(from).join('\n');
  if (tailed.length > 2048) {
    return '…' + tailed.slice(tailed.length - 2048);
  }
  return tailed;
}

/** B. Tail of the `rendered` fields joined — what `--message-format=human` emits. */
function tailRendered(issues: Array<{ rendered: string }>): string {
  const combined = issues.map(i => i.rendered).join('');
  const lines = combined.split('\n').filter(l => l.length > 0 || true); // keep blanks
  const from = Math.max(0, lines.length - 20);
  const tailed = lines.slice(from).join('\n');
  if (tailed.length > 2048) {
    return '…' + tailed.slice(tailed.length - 2048);
  }
  return tailed;
}

/**
 * C. Structured-to-compact: one line per issue, uniform shape across linters.
 * Works on any parsed `issues[]` with a primary span — clippy, ESLint, flake8,
 * golangci-lint, pyright, etc. all provide file+line+code+message.
 */
interface UniformIssue { file: string; line: number; col?: number; code?: string; level?: string; msg: string }

function compactStructured(issues: UniformIssue[], maxLines = 20): string {
  const shown = issues.slice(0, maxLines);
  const hidden = issues.length - shown.length;
  const header = hidden > 0
    ? `verify.lint: ${issues.length} issues (${shown.length} shown)`
    : `verify.lint: ${issues.length} issues`;
  const body = shown.map(i => {
    const loc = i.col !== undefined ? `${i.file}:${i.line}:${i.col}` : `${i.file}:${i.line}`;
    const lvl = i.level === 'error' ? 'E' : 'W';
    const code = i.code ? ` ${i.code}` : '';
    return `  ${loc} ${lvl}${code}: ${i.msg}`;
  });
  return [header, ...body].join('\n');
}

/** Project a clippy issue to the uniform shape. */
function projectClippy(msg: { level: string; message: string; code: { code: string } | null; spans: Array<{ file_name: string; line_start: number; column_start: number; is_primary: boolean }> }): UniformIssue {
  const primary = msg.spans.find(s => s.is_primary) ?? msg.spans[0];
  return {
    file: primary?.file_name ?? '?',
    line: primary?.line_start ?? 0,
    col: primary?.column_start,
    code: msg.code?.code,
    level: msg.level,
    msg: msg.message,
  };
}

function projectEslint(file: { filePath: string; messages: Array<{ ruleId: string; line: number; column: number; message: string; severity: number }> }): UniformIssue[] {
  return file.messages.map(m => ({
    file: file.filePath,
    line: m.line,
    col: m.column,
    code: m.ruleId,
    level: m.severity === 2 ? 'error' : 'warning',
    msg: m.message,
  }));
}

function projectFlake8(i: { code: string; filename: string; line_number: number; column_number: number; text: string }): UniformIssue {
  return {
    file: i.filename,
    line: i.line_number,
    col: i.column_number,
    code: i.code,
    level: 'warning',
    msg: i.text,
  };
}

// ---------------------------------------------------------------------------
// Comparison reporter
// ---------------------------------------------------------------------------

function measure(label: string, text: string, through?: (s: string) => string): { label: string; tokens: number; chars: number; compressed?: number } {
  const tokens = countTokensSync(text);
  const chars = text.length;
  const compressed = through ? countTokensSync(through(text)) : undefined;
  return { label, tokens, chars, compressed };
}

describe('lint output format comparison (measurement, not a gate)', () => {
  const CLIPPY_50 = Array.from({ length: 50 }, (_, i) => makeClippyIssue(i));

  it('reports tokens for each candidate format on a 50-issue clippy payload', () => {
    // A. Raw NDJSON tail (current Rust raw_tail approach, CLIPPY-ONLY)
    const A = tailRawNdjson(CLIPPY_50);

    // B. Rendered-fields tail (what --message-format=human would show)
    const B = tailRendered(CLIPPY_50);

    // C. Structured-to-compact (uniform across linters)
    const uniform = CLIPPY_50.map(projectClippy);
    const C20 = compactStructured(uniform, 20);
    const C8 = compactStructured(uniform, 8);

    // D. Each through the existing TOON compressor (formatResult on
    // the structured payload). For A/B these are plain strings already,
    // so we pass a wrapping object so the compressor has something to chew on.
    const wrapString = (s: string) => ({ output: s });
    const wrapIssues = (items: UniformIssue[]) => ({ type: 'lint', issue_count: items.length, issues: items.slice(0, 20) });

    const D_A = formatResult(wrapString(A));
    const D_B = formatResult(wrapString(B));
    const D_structured20 = formatResult(wrapIssues(uniform));
    const D_structured8 = formatResult(wrapIssues(uniform.slice(0, 8)));

    const results = [
      measure('A. Raw NDJSON tail (20L/2KB)         [shipping, clippy-only]', A),
      measure('B. Rendered-fields tail (20L)        [human format]', B),
      measure('C. Compact structured (20 issues)    [uniform]', C20),
      measure('C. Compact structured (8 issues)     [uniform]', C8),
      measure('D. A through formatResult (TOON)', D_A),
      measure('D. B through formatResult (TOON)', D_B),
      measure('D. Structured[20] → formatResult', D_structured20),
      measure('D. Structured[8]  → formatResult', D_structured8),
    ];

    console.log('\n[lint format comparison — 50 clippy warnings]');
    console.log('='.repeat(78));
    for (const r of results) {
      const line = `${r.label.padEnd(52)} ${String(r.tokens).padStart(5)} tk  ${String(r.chars).padStart(5)} ch`;
      console.log(line);
    }
    console.log('='.repeat(78));
    console.log(`audit baseline (live 50-issue run): ~833 tk`);
    console.log(`plan target:                         500-700 tk`);
  });

  it('verifies the structured approach works uniformly for ESLint and flake8', () => {
    // ESLint payload: 20 files × 1 message each → 20 issues
    const eslintFiles = Array.from({ length: 20 }, (_, i) => makeEslintFileResult(i));
    const eslintUniform = eslintFiles.flatMap(projectEslint);
    const eslintCompact = compactStructured(eslintUniform, 20);

    // flake8 payload: 20 issues
    const flakeIssues = Array.from({ length: 20 }, (_, i) => makeFlake8Issue(i));
    const flakeUniform = flakeIssues.map(projectFlake8);
    const flakeCompact = compactStructured(flakeUniform, 20);

    console.log('\n[structured uniformity — other linters]');
    console.log('='.repeat(78));
    console.log(`ESLint (20 issues, compact):   ${countTokensSync(eslintCompact).toString().padStart(5)} tk  (${eslintCompact.length} ch)`);
    console.log(`flake8 (20 issues, compact):   ${countTokensSync(flakeCompact).toString().padStart(5)} tk  (${flakeCompact.length} ch)`);
    console.log('='.repeat(78));
    console.log('sample ESLint line:', eslintCompact.split('\n').slice(1, 2)[0]);
    console.log('sample flake8 line:', flakeCompact.split('\n').slice(1, 2)[0]);
  });

  it('reports what the audit would have seen with current shipping code', () => {
    // This replicates what the live audit produced at 833 tokens —
    // stdout is a stream of compiler-message NDJSON, most messages are large.
    const A = tailRawNdjson(CLIPPY_50);
    console.log(`\n[current Rust raw_tail behavior]`);
    console.log(`  50 clippy warnings → raw_tail field = ${countTokensSync(A)} tk`);
    console.log(`  (this is why the live run hit ~833 tk)`);
  });

  it('BEFORE vs AFTER — formatVerifyTail on the same 50-clippy payload', () => {
    // Simulate the Rust-side contract: `issues[]` contains parsed message
    // objects (with `rendered` fields), and `raw_tail` is the raw NDJSON
    // stdout tail. That's what actually ships today.
    const rawWithBoth = {
      type: 'lint',
      success: false,
      issue_count: 50,
      exit_code: 101,
      issues: CLIPPY_50,
      raw_tail: tailRawNdjson(CLIPPY_50),
    };
    // And what the OLD formatter would do (before this change) — fallback
    // to `raw_tail` only, no rendered-field preference.
    const rawRawTailOnly = {
      type: 'lint',
      success: false,
      issue_count: 50,
      exit_code: 101,
      raw_tail: tailRawNdjson(CLIPPY_50),
    };

    const afterTk = countTokensSync(formatVerifyTail(rawWithBoth, 'lint', false));
    const beforeTk = countTokensSync(formatVerifyTail(rawRawTailOnly, 'lint', false));

    console.log(`\n[paired A/B — formatVerifyTail]`);
    console.log('='.repeat(78));
    console.log(`  BEFORE (raw_tail only, NDJSON) : ${String(beforeTk).padStart(5)} tk   (matches audit ~833)`);
    console.log(`  AFTER  (issues[].rendered)    : ${String(afterTk).padStart(5)} tk`);
    console.log(`  reduction: ${((beforeTk - afterTk) / beforeTk * 100).toFixed(1)}%`);
    console.log('='.repeat(78));

    // Hard gate: AFTER should be significantly smaller than BEFORE.
    expect(afterTk).toBeLessThan(beforeTk * 0.5);
    // And sanity: AFTER should land in the ~200 tk range for 50 issues.
    expect(afterTk).toBeLessThan(300);
  });

  it('respects agent-supplied `tail_lines` param (PowerShell -Last N / unix tail -n N)', () => {
    const rawWithIssues = {
      type: 'lint',
      success: false,
      issue_count: 50,
      exit_code: 101,
      issues: CLIPPY_50,
    };

    const default20 = formatVerifyTail(rawWithIssues, 'lint', false, {});
    const with50 = formatVerifyTail(rawWithIssues, 'lint', false, { tail_lines: 50 });
    const with100 = formatVerifyTail(rawWithIssues, 'lint', false, { tail_lines: 100 });
    const withMax = formatVerifyTail(rawWithIssues, 'lint', false, { tail_lines: 5000 }); // clamped to 200

    const tk20 = countTokensSync(default20);
    const tk50 = countTokensSync(with50);
    const tk100 = countTokensSync(with100);
    const tkMax = countTokensSync(withMax);

    console.log('\n[tail_lines knob — clippy 50 issues]');
    console.log('='.repeat(78));
    console.log(`  default (tail_lines:20):  ${String(tk20).padStart(5)} tk`);
    console.log(`  tail_lines:50:            ${String(tk50).padStart(5)} tk`);
    console.log(`  tail_lines:100:           ${String(tk100).padStart(5)} tk`);
    console.log(`  tail_lines:5000 (→200):   ${String(tkMax).padStart(5)} tk`);
    console.log('='.repeat(78));

    // Monotonically grows with the knob (more lines requested → more tokens).
    expect(tk50).toBeGreaterThan(tk20);
    expect(tk100).toBeGreaterThan(tk50);
    // Out-of-range values clamp to the cap; the cap prevents unbounded growth.
    expect(tkMax).toBeGreaterThanOrEqual(tk100);
    // The cap (200 lines × 256 bytes/line = ~51KB) keeps even a large
    // request bounded well under the 80KB FORMAT_RESULT default limit.
    // Explicit opt-in: if the agent asks for 200 lines it gets 200 lines.
    expect(tkMax).toBeLessThan(2500);
  });

  it('invalid tail_lines values fall back to default (not an error)', () => {
    const raw = {
      type: 'lint',
      success: true,
      issue_count: 0,
      exit_code: 0,
      issues: CLIPPY_50.slice(0, 5),
    };
    const baseline = formatVerifyTail(raw, 'lint', true, {});

    // All of these should produce the same output as the default.
    const asString = formatVerifyTail(raw, 'lint', true, { tail_lines: 'many' as unknown as number });
    const asNegative = formatVerifyTail(raw, 'lint', true, { tail_lines: -5 });
    const asZero = formatVerifyTail(raw, 'lint', true, { tail_lines: 0 });
    const asNaN = formatVerifyTail(raw, 'lint', true, { tail_lines: NaN });

    // Negative/zero clamp to 1 (still valid, tiny output). String/NaN → default 20.
    expect(asString.length).toBe(baseline.length);
    expect(asNaN.length).toBe(baseline.length);
    // Zero and -5 clamp to 1 line, which is a smaller output than default 20.
    expect(asZero.length).toBeLessThan(baseline.length);
    expect(asNegative.length).toBeLessThan(baseline.length);
  });

  it('falls back to raw_tail when issues[] lacks rendered (non-clippy linters)', () => {
    // ESLint / flake8 / etc: no `rendered` field in issues — we should
    // use `raw_tail` which for these is already clean human-readable text.
    const raw = {
      type: 'lint',
      success: false,
      issue_count: 2,
      exit_code: 1,
      issues: [
        { ruleId: 'no-unused-vars', line: 10, message: "'foo' is defined but never used." },
        { ruleId: 'no-unused-vars', line: 15, message: "'bar' is defined but never used." },
      ],
      raw_tail: [
        '/abs/src/foo.ts',
        '  10:7  warning  \'foo\' is defined but never used  no-unused-vars',
        '  15:7  warning  \'bar\' is defined but never used  no-unused-vars',
        '',
        '✖ 2 problems (0 errors, 2 warnings)',
      ].join('\n'),
    };
    const out = formatVerifyTail(raw, 'lint', false);
    expect(out).toContain('verify.lint: failed (2 issues, exit 1)');
    expect(out).toContain('no-unused-vars');
    expect(out).toContain('2 problems');
    const tk = countTokensSync(out);
    console.log(`\n[ESLint-shaped fallback — raw_tail path]`);
    console.log(`  2 issues: ${tk} tk`);
    expect(tk).toBeLessThan(150);
  });
});
