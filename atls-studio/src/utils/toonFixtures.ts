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
      'Review changes, then pass q:\ng1 system.git action:stage files:...\nor\ng2 system.git action:commit message:"..."',
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
    _next: 'Stage files: q: g1 system.git action:stage files:...',
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
    _next: 'Fix 1 error in system.ts:153. Run q: v1 verify.typecheck to validate',
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
      'All operations completed. Run q: v1 verify.typecheck to validate',
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
    _next: 'Push to remote: q: g1 system.git action:push',
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

// ============================================================================
// Compression-targeted fixtures
//
// These shapes exercise the column-ditto + substring-dictionary encoder at
// the `formatResult` seam. They are deterministic (seeded with the row index)
// so token-savings assertions are stable across CI runs.
// ============================================================================

/**
 * Large code-search result — `rowCount` rows concentrated across a small
 * number of files. Exercises columnar dedup (`file` column) and substring
 * repetition (common import-like prefixes in snippets). Deterministic.
 */
export function makeLargeCodeSearchResult(rowCount: number) {
  const files = [
    'src/services/batch/handlers/query.ts',
    'src/services/batch/handlers/change.ts',
    'src/services/batch/handlers/context.ts',
  ];
  const snippetPrefixes = [
    'export async function handleSearch',
    'const resultStr = formatResult(result, FORMAT_RESULT_MAX_SEARCH);',
    'return ok(formatResult(result), refs, result);',
  ];
  const results = Array.from({ length: rowCount }, (_, i) => ({
    file: files[i % files.length],
    line: 10 + (i * 7) % 500,
    snippet: `${snippetPrefixes[i % snippetPrefixes.length]} // hit ${i}`,
  }));
  return {
    queries: ['handleSearch', 'formatResult'],
    results,
    total_matches: rowCount,
  };
}

/**
 * Repetitive issues result — many entries with a small severity/rule
 * vocabulary. Exercises dictionary coding of repeated short column values.
 */
export function makeRepetitiveIssuesResult(issueCount: number) {
  const severities = ['error', 'warning', 'info'];
  const rules = [
    'no-unused-vars',
    'prefer-const',
    'ts2322',
    'ts2355',
    'ts7006',
  ];
  const files = [
    'src/services/batch/handlers/query.ts',
    'src/services/batch/handlers/change.ts',
    'src/services/batch/handlers/system.ts',
    'src/utils/toon.ts',
  ];
  const issues = Array.from({ length: issueCount }, (_, i) => ({
    file: files[i % files.length],
    line: 20 + (i * 13) % 800,
    severity: severities[i % severities.length],
    rule: rules[i % rules.length],
    message: `Issue ${i}: ${rules[i % rules.length]} fired at this location`,
  }));
  return {
    total: issueCount,
    by_severity: {
      error: issues.filter((x) => x.severity === 'error').length,
      warning: issues.filter((x) => x.severity === 'warning').length,
      info: issues.filter((x) => x.severity === 'info').length,
    },
    issues,
  };
}

/**
 * Tree listing — deep directory structure with shared path prefixes.
 * Exercises substring-prefix dictionary coding. `depth` controls nesting;
 * `breadth` is files per directory.
 */
export function makeTreeListingResult(depth: number, breadth: number) {
  const segments = ['services', 'batch', 'handlers', 'utils', 'components', 'stores'];
  const entries: Array<{ path: string; size: number; kind: 'file' | 'dir' }> = [];
  for (let d = 0; d < depth; d++) {
    const dirPath = 'src/' + segments.slice(0, d + 1).join('/');
    entries.push({ path: dirPath, size: 0, kind: 'dir' });
    for (let b = 0; b < breadth; b++) {
      entries.push({
        path: `${dirPath}/file${b}.ts`,
        size: 1024 + (d * 100 + b * 17) % 4096,
        kind: 'file',
      });
    }
  }
  return {
    root: 'src',
    total: entries.length,
    entries,
  };
}

/**
 * Grouped code-search result — rows sorted so several columns stay constant
 * within each group (file, severity, kind, source). Exercises the ditto pass
 * in a way the round-robin fixtures do not (those cycle column values and
 * never leave two adjacent rows agreeing on a key). Shape mirrors real
 * grouped backend output from FTS / issue detectors where results arrive
 * clustered by rule + severity + source.
 *
 * `groupCount` groups of `groupSize` rows each. Total rows = groupCount * groupSize.
 */
export function makeGroupedSearchResult(groupSize: number, groupCount: number) {
  const files = [
    'src/services/batch/handlers/query.ts',
    'src/services/batch/handlers/change.ts',
    'src/services/batch/handlers/context.ts',
    'src/services/batch/handlers/system.ts',
  ];
  const severities = ['error', 'warning', 'info'];
  const kinds = ['type_error', 'style', 'lint', 'logic'];
  const sources = ['tsc', 'eslint', 'detector'];
  const snippetPrefixes = [
    'export async function handleSearch',
    'const resultStr = formatResult(result, FORMAT_RESULT_MAX_SEARCH);',
    'return ok(formatResult(result), refs, result);',
  ];

  const results: Array<{
    file: string;
    line: number;
    severity: string;
    kind: string;
    source: string;
    snippet: string;
  }> = [];

  for (let g = 0; g < groupCount; g++) {
    const file = files[g % files.length];
    const severity = severities[g % severities.length];
    const kind = kinds[g % kinds.length];
    const source = sources[g % sources.length];
    for (let r = 0; r < groupSize; r++) {
      const absolute = g * groupSize + r;
      results.push({
        file,
        line: 10 + (absolute * 7) % 500,
        severity,
        kind,
        source,
        snippet: `${snippetPrefixes[absolute % snippetPrefixes.length]} // hit ${absolute}`,
      });
    }
  }

  return {
    queries: ['handleSearch', 'formatResult'],
    results,
    total_matches: results.length,
  };
}

/**
 * Low-redundancy negative control — random-looking rows with no shared
 * column values or substrings. The encoder MUST return null on this input
 * (nothing to compress); used to validate auto-disable gating.
 */
export function makeLowRedundancyResult(rowCount: number) {
  const results: Array<{ id: string; label: string; payload: string }> = [];
  let seed = 0x9e3779b1;
  const next = () => {
    seed = Math.imul(seed ^ (seed >>> 16), 0x85ebca6b) >>> 0;
    seed = Math.imul(seed ^ (seed >>> 13), 0xc2b2ae35) >>> 0;
    seed = (seed ^ (seed >>> 16)) >>> 0;
    return seed;
  };
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const rand = (len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) s += chars[next() % chars.length];
    return s;
  };
  for (let i = 0; i < rowCount; i++) {
    results.push({
      id: rand(10),
      label: rand(14),
      payload: rand(24),
    });
  }
  return { kind: 'low_redundancy_control', count: rowCount, results };
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
