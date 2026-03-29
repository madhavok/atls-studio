/**
 * Token efficiency vs context-rich output: every fixture asserts both
 * (1) TOON uses fewer estimated tokens than JSON and
 * (2) critical substrings remain for model understanding.
 *
 * Out of scope: full semantic equivalence to JSON (TOON is not round-trippable
 * to arbitrary objects); provider-exact tokenizer for every case.
 */
import { describe, expect, it } from 'vitest';

import { estimateTokens } from './contextHash';
import {
  formatResult,
  toTOON,
  FORMAT_RESULT_MAX_DEFAULT,
} from './toon';
import {
  makeCodeSearchBackendResult,
  makeGitDiffResult,
  makeLineEditResult,
  makeMemorySearchStructured,
  makeRefactorResult,
} from './toonFixtures';
import {
  expectToonUnderstandable,
  logObjectJsonVsFormatResult,
} from './toonDeltaTestHelpers';

describe('TOON semantic retention + token efficiency', () => {
  it('S1: git diff retains paths, summary, _next and beats JSON on tokens', () => {
    const data = makeGitDiffResult(30);
    const out = formatResult(data);
    const { jsonTok, altTok } = logObjectJsonVsFormatResult('S1 git diff semantic', data);

    expect(altTok).toBeLessThan(jsonTok);
    expectToonUnderstandable(out, [
      'src-tauri/src/batch_query/mod.rs',
      'src/stores/appStore.ts',
      '2 files changed, 275 insertions(+), 73 deletions(-)',
      'Review changes, then:',
      'system.git',
    ]);
  });

  it('S2: line_edits retains lint lines, messages, _next and beats JSON on tokens', () => {
    const data = makeLineEditResult();
    const out = formatResult(data);
    const { jsonTok, altTok } = logObjectJsonVsFormatResult('S2 line_edits semantic', data);

    expect(altTok).toBeLessThan(jsonTok);
    expectToonUnderstandable(out, [
      '153',
      '170',
      "Type 'string' is not assignable to type 'number'",
      "Unused variable 'result'",
      'error',
      'warning',
      'Fix 1 error in system.ts:153',
      'verify(type:typecheck)',
    ]);
  });

  it('S3: refactor multi-symbol retains each symbol and shared file path after compaction', () => {
    const data = makeRefactorResult();
    const out = formatResult(data);
    const { jsonTok, altTok } = logObjectJsonVsFormatResult('S3 refactor semantic', data);

    expect(altTok).toBeLessThan(jsonTok);
    expectToonUnderstandable(out, [
      'src/services/batch/handlers/system.ts',
      'handleSystemGit',
      'handleSystemWorkspaces',
      'handleSystemHelp',
      'applied',
    ]);
  });

  it('S4: code_search-shaped result retains each file and snippet text', () => {
    const data = makeCodeSearchBackendResult();
    const out = formatResult(data);
    const { jsonTok, altTok } = logObjectJsonVsFormatResult('S4 code_search semantic', data);

    expect(altTok).toBeLessThan(jsonTok);
    expectToonUnderstandable(out, [
      'src/a.ts',
      'src/b.ts',
      'const foo = 1;',
      'export function bar() {}',
      'total_matches:2',
    ]);
  });

  it('S5: search.memory structured payload retains region, ref, line hits', () => {
    const data = makeMemorySearchStructured();
    const out = formatResult(data);
    const { jsonTok, altTok } = logObjectJsonVsFormatResult('S5 memory structured semantic', data);

    expect(altTok).toBeLessThan(jsonTok);
    expect(out).toContain('search.memory');
    expectToonUnderstandable(out, [
      'active',
      'h:deadbeef',
      'read.context',
      'lineNumber:1',
      'lineNumber:5',
      'line with token',
      'another token hit',
    ]);
  });

  it('S6: truncation keeps marker and parseable prefix with stable key', () => {
    const huge = { blob: 'z'.repeat(FORMAT_RESULT_MAX_DEFAULT + 500) };
    const out = formatResult(huge);
    expect(out.length).toBeLessThanOrEqual(FORMAT_RESULT_MAX_DEFAULT + 80);
    expect(out).toContain('[truncated - narrow query]');
    expect(out.slice(0, 500)).toContain('blob:');
    const jsonTok = estimateTokens(JSON.stringify(huge));
    const altTok = estimateTokens(out);
    expect(altTok).toBeLessThan(jsonTok);
  });

  it('toTOON omits null, undefined, and empty string — other fields still carry signal', () => {
    const rich = { label: 'ok', empty_note: '', skipped: null, count: 3 };
    const s = toTOON(rich);
    expect(s).not.toContain('empty_note');
    expect(s).not.toContain('skipped');
    expect(s).toContain('label:ok');
    expect(s).toContain('count:3');
    expect(estimateTokens(s)).toBeLessThan(estimateTokens(JSON.stringify(rich)));
  });
});
