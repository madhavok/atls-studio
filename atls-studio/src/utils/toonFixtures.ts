/**
 * Shared fixtures for TOON tests — realistic backend / handler shapes.
 * Used by token-cost tests and semantic-retention tests.
 */

export function makeGitDiffResult(hunkLineCount: number) {
  const lines: string[] = [];
  for (let i = 0; i < hunkLineCount; i++) {
    const prefix = i % 3 === 0 ? '-' : i % 3 === 1 ? '+' : ' ';
    lines.push(`${prefix}    const value${i} = computeSomething(arg${i}, options);`);
  }
  return {
    action: 'diff',
    staged: false,
    summary: '2 files changed, 275 insertions(+), 73 deletions(-)',
    files: [
      {
        file: 'src-tauri/src/batch_query/mod.rs',
        hunks: [
          { old_start: 310, new_start: 310, lines: lines.slice(0, Math.floor(hunkLineCount / 2)) },
          { old_start: 512, new_start: 565, lines: lines.slice(Math.floor(hunkLineCount / 2)) },
        ],
      },
      {
        file: 'src/stores/appStore.ts',
        hunks: [{ old_start: 55, new_start: 55, lines: lines.slice(0, 12) }],
      },
    ],
    _next:
      'Review changes, then: batch({version:"1.0",steps:[{id:"g1",use:"system.git",with:{action:"stage",files:[...]}}]}) or batch({version:"1.0",steps:[{id:"g1",use:"system.git",with:{action:"commit",message:"..."}}]})',
  };
}

export function makeGitStatusResult() {
  return {
    action: 'status',
    branch: 'main',
    ahead: 0,
    behind: 0,
    staged: [],
    modified: ['src-tauri/src/lib.rs', 'src/stores/appStore.ts'],
    untracked: [],
    deleted: [],
    clean: false,
    _next: 'Stage files: batch({version:"1.0",steps:[{id:"g1",use:"system.git",with:{action:"stage",files:[...]}}]})',
  };
}

export function makeLineEditResult() {
  return {
    file: 'src/services/batch/handlers/system.ts',
    h: 'h:a3f1b2',
    old_h: 'h:50b982',
    content_hash: 'a3f1b2c4d5e6f7890123456789abcdef',
    status: 'applied',
    edits_applied: 3,
    lints: {
      total: 2,
      by_severity: { error: 1, warning: 1 },
      top_issues: [
        {
          file: 'src/services/batch/handlers/system.ts',
          line: 153,
          severity: 'error',
          message: "Type 'string' is not assignable to type 'number'",
        },
        {
          file: 'src/services/batch/handlers/system.ts',
          line: 170,
          severity: 'warning',
          message: "Unused variable 'result'",
        },
      ],
    },
    has_errors: true,
    index: { indexed: 1, duration_ms: 45 },
    _next: 'Fix 1 error in system.ts:153. Run verify(type:typecheck) to validate',
  };
}

export function makeCreateFilesResult() {
  return {
    dry_run: false,
    created: ['src/utils/newHelper.ts', 'src/utils/newHelper.test.ts'],
    edited: [],
    errors: [],
    lints: { total: 0, by_severity: {}, top_issues: [] },
    index: { indexed: 2, duration_ms: 30 },
    summary: { created_count: 2, edited_count: 0, error_count: 0, lints: 0 },
    _next:
      'All operations completed. Run batch({version:"1.0",steps:[{id:"v1",use:"verify.typecheck"}]}) to validate',
  };
}

export function makeGitCommitResult() {
  return {
    action: 'commit',
    success: true,
    commit: 'main abc1234',
    message: 'fix: convert model-facing handlers from JSON to TOON serialization',
    output:
      '[main abc1234] fix: convert model-facing handlers from JSON to TOON serialization\n 6 files changed, 42 insertions(+), 18 deletions(-)\n',
    _next: 'Push to remote: batch({version:"1.0",steps:[{id:"g1",use:"system.git",with:{action:"push"}}]})',
  };
}

export function makeRefactorResult() {
  return {
    results: [
      { file: 'src/services/batch/handlers/system.ts', symbol: 'handleSystemGit', status: 'applied' },
      { file: 'src/services/batch/handlers/system.ts', symbol: 'handleSystemWorkspaces', status: 'applied' },
      { file: 'src/services/batch/handlers/system.ts', symbol: 'handleSystemHelp', status: 'applied' },
    ],
    lints: { total: 0, by_severity: {}, top_issues: [] },
    index: { indexed: 1, duration_ms: 55 },
    summary: { files_modified: 1, lints: 0 },
  };
}

/** Code-search shaped backend JSON (see batch handlers). */
export function makeCodeSearchBackendResult() {
  return {
    queries: ['foo', 'bar'],
    results: [
      { file: 'src/a.ts', line: 10, snippet: 'const foo = 1;' },
      { file: 'src/b.ts', line: 22, snippet: 'export function bar() {}' },
    ],
    total_matches: 2,
  };
}

/** Structured search.memory-style payload. */
export function makeMemorySearchStructured() {
  return {
    tool: 'search.memory',
    query: 'token',
    region_summary: 'active:2',
    total_hits: 2,
    entries: [
      {
        region: 'active' as const,
        ref: 'h:deadbeef',
        source: 'read.context',
        type: 'context',
        tokens: 120,
        hits: [
          { lineNumber: 1, line: 'line with token' },
          { lineNumber: 5, line: 'another token hit' },
        ],
      },
    ],
  };
}
