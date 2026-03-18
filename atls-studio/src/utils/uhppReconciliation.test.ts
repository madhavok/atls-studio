/**
 * UHPP Phase 5: Reconciliation and Verification Pipeline — Tests.
 */
import { describe, it, expect } from 'vitest';
import {
  sortByVerificationCost,
  normalizeToolDiagnostic,
  normalizeDiagnostics,
  extractDiagnosticsFromResponse,
  classifyFailure,
  shouldShortCircuit,
  shouldNeedReview,
  computeAggregateStatus,
  generateMismatchSummary,
  reconcileRelationships,
  refreshRefs,
  createVerificationPipeline,
  assembleVerificationPipelineResult,
  toCanonicalVerificationResult,
  generateVerificationId,
} from './uhppReconciliation';
import type {
  VerificationLevel,
  VerificationCheckResult,
  VerificationPipelineConfig,
} from './uhppCanonical';

// ---------------------------------------------------------------------------
// sortByVerificationCost
// ---------------------------------------------------------------------------

describe('sortByVerificationCost', () => {
  it('sorts levels in spec cost order', () => {
    const input: VerificationLevel[] = ['test', 'freshness', 'typecheck', 'structural'];
    const sorted = sortByVerificationCost(input);
    expect(sorted).toEqual(['freshness', 'structural', 'typecheck', 'test']);
  });

  it('preserves all levels', () => {
    const all: VerificationLevel[] = ['test', 'parser', 'relationship', 'typecheck', 'structural', 'freshness'];
    const sorted = sortByVerificationCost(all);
    expect(sorted).toHaveLength(6);
    expect(sorted[0]).toBe('freshness');
    expect(sorted[sorted.length - 1]).toBe('test');
  });

  it('handles single level', () => {
    expect(sortByVerificationCost(['typecheck'])).toEqual(['typecheck']);
  });

  it('does not mutate input', () => {
    const input: VerificationLevel[] = ['test', 'freshness'];
    sortByVerificationCost(input);
    expect(input).toEqual(['test', 'freshness']);
  });
});

// ---------------------------------------------------------------------------
// normalizeToolDiagnostic
// ---------------------------------------------------------------------------

describe('normalizeToolDiagnostic', () => {
  it('normalizes ESLint-style diagnostic', () => {
    const diag = normalizeToolDiagnostic({
      file: 'src/app.ts',
      line: 10,
      column: 5,
      message: 'no-unused-vars',
      severity: 'warn',
      ruleId: 'no-unused-vars',
    }, '<unknown>', 'eslint');
    expect(diag.file).toBe('src/app.ts');
    expect(diag.severity).toBe('warning');
    expect(diag.code).toBe('no-unused-vars');
    expect(diag.source).toBe('eslint');
  });

  it('normalizes TSC-style diagnostic', () => {
    const diag = normalizeToolDiagnostic({
      file: 'src/main.ts',
      line: 42,
      column: 3,
      message: "Type 'string' is not assignable",
      severity: 'error',
      code: 'TS2322',
    });
    expect(diag.severity).toBe('error');
    expect(diag.code).toBe('TS2322');
  });

  it('uses defaults for missing fields', () => {
    const diag = normalizeToolDiagnostic({});
    expect(diag.file).toBe('<unknown>');
    expect(diag.line).toBe(0);
    expect(diag.severity).toBe('error');
  });

  it('handles test failure shape', () => {
    const diag = normalizeToolDiagnostic({
      test: 'should authenticate user',
      error: 'Expected true, got false',
    }, 'test-suite.ts', 'vitest');
    expect(diag.message).toBe('Expected true, got false');
    expect(diag.source).toBe('vitest');
  });

  it('normalizes severity variants', () => {
    expect(normalizeToolDiagnostic({ severity: 'Warning' }).severity).toBe('warning');
    expect(normalizeToolDiagnostic({ severity: '1' }).severity).toBe('warning');
    expect(normalizeToolDiagnostic({ severity: 'information' }).severity).toBe('info');
    expect(normalizeToolDiagnostic({ severity: 'note' }).severity).toBe('info');
    expect(normalizeToolDiagnostic({ severity: 'suggestion' }).severity).toBe('hint');
    expect(normalizeToolDiagnostic({ severity: 'hint' }).severity).toBe('hint');
    expect(normalizeToolDiagnostic({ severity: 'critical' }).severity).toBe('error');
  });

  it('handles endLine / end_line variants', () => {
    const d1 = normalizeToolDiagnostic({ endLine: 15 });
    expect(d1.end_line).toBe(15);
    const d2 = normalizeToolDiagnostic({ end_line: 20 });
    expect(d2.end_line).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// normalizeDiagnostics
// ---------------------------------------------------------------------------

describe('normalizeDiagnostics', () => {
  it('normalizes array of diagnostics', () => {
    const result = normalizeDiagnostics([
      { file: 'a.ts', line: 1, message: 'err1' },
      { file: 'b.ts', line: 2, message: 'err2' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].file).toBe('a.ts');
    expect(result[1].file).toBe('b.ts');
  });

  it('returns empty array for empty input', () => {
    expect(normalizeDiagnostics([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractDiagnosticsFromResponse
// ---------------------------------------------------------------------------

describe('extractDiagnosticsFromResponse', () => {
  it('extracts from errors array', () => {
    const raw = {
      errors: [
        { file: 'a.ts', line: 5, message: 'type error', severity: 'error' },
      ],
    };
    const diags = extractDiagnosticsFromResponse(raw, 'typecheck');
    expect(diags).toHaveLength(1);
    expect(diags[0].source).toBe('typecheck');
  });

  it('extracts from failures array', () => {
    const raw = {
      failures: [
        { test: 'auth test', error: 'Expected true' },
      ],
    };
    const diags = extractDiagnosticsFromResponse(raw, 'test');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe('Expected true');
  });

  it('falls back to output on fail status', () => {
    const raw = {
      status: 'fail',
      output: 'Build failed with 3 errors',
    };
    const diags = extractDiagnosticsFromResponse(raw, 'build');
    expect(diags).toHaveLength(1);
    expect(diags[0].file).toBe('<output>');
  });

  it('does not extract output on pass status', () => {
    const raw = {
      status: 'pass',
      output: 'All tests passed',
    };
    const diags = extractDiagnosticsFromResponse(raw, 'test');
    expect(diags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

describe('classifyFailure', () => {
  it('classifies missing toolchain', () => {
    const result = classifyFailure([
      { file: '', line: 0, message: 'command not found: tsc', severity: 'error' },
    ]);
    expect(result.category).toBe('host_missing_toolchain');
    expect(result.risk).toBe('low');
  });

  it('classifies dependency issue', () => {
    const result = classifyFailure([
      { file: 'src/app.ts', line: 1, message: "Cannot find module 'lodash'", severity: 'error' },
    ]);
    expect(result.category).toBe('dependency_issue');
  });

  it('classifies type mismatch', () => {
    const result = classifyFailure([
      { file: 'src/foo.ts', line: 10, message: "Type 'string' is not assignable to type 'number'", severity: 'error' },
    ]);
    expect(result.category).toBe('type_mismatch');
  });

  it('classifies test regression', () => {
    const result = classifyFailure([
      { file: 'test.ts', line: 5, message: 'test auth should pass: assertion failed', severity: 'error' },
    ]);
    expect(result.category).toBe('test_regression');
  });

  it('classifies import resolution', () => {
    const result = classifyFailure([
      { file: 'src/x.ts', line: 1, message: "import './removed' not found", severity: 'error' },
    ]);
    expect(result.category).toBe('import_resolution');
  });

  it('attributes to refactor if recent edits and no pattern match', () => {
    const result = classifyFailure([
      { file: 'src/x.ts', line: 1, message: 'weird custom error', severity: 'error' },
    ], true);
    expect(result.category).toBe('refactor_induced');
    expect(result.risk).toBe('high');
  });

  it('falls back to baseline_project_failure', () => {
    const result = classifyFailure([
      { file: 'src/x.ts', line: 1, message: 'weird custom error', severity: 'error' },
    ], false);
    expect(result.category).toBe('baseline_project_failure');
    expect(result.risk).toBe('medium');
  });

  it('returns unknown for empty diagnostics', () => {
    const result = classifyFailure([]);
    expect(result.category).toBe('unknown');
    expect(result.risk).toBe('low');
  });

  it('risk is higher when recent edits exist', () => {
    const noEdits = classifyFailure([
      { file: 'a.ts', line: 1, message: "Cannot find module 'x'", severity: 'error' },
    ], false);
    const withEdits = classifyFailure([
      { file: 'a.ts', line: 1, message: "Cannot find module 'x'", severity: 'error' },
    ], true);
    expect(withEdits.risk).not.toBe(noEdits.risk);
  });
});

// ---------------------------------------------------------------------------
// shouldShortCircuit
// ---------------------------------------------------------------------------

describe('shouldShortCircuit', () => {
  const baseConfig: VerificationPipelineConfig = {
    levels: ['freshness', 'typecheck', 'test'],
    short_circuit_on_fail: true,
    skip_expensive_after_fail: true,
    target_refs: ['src/a.ts'],
  };

  const passResult: VerificationCheckResult = {
    level: 'freshness',
    status: 'pass',
    diagnostics: [],
    duration_ms: 5,
  };

  const failResult: VerificationCheckResult = {
    level: 'structural',
    status: 'fail',
    diagnostics: [{ file: 'a.ts', line: 1, message: 'err', severity: 'error' }],
    duration_ms: 10,
  };

  it('does not short-circuit on pass', () => {
    expect(shouldShortCircuit(baseConfig, passResult, ['typecheck'])).toBe(false);
  });

  it('short-circuits on fail when configured', () => {
    expect(shouldShortCircuit(baseConfig, failResult, ['typecheck'])).toBe(true);
  });

  it('does not short-circuit on fail when disabled', () => {
    const noSC = { ...baseConfig, short_circuit_on_fail: false, skip_expensive_after_fail: false };
    expect(shouldShortCircuit(noSC, failResult, ['relationship'])).toBe(false);
  });

  it('skips expensive after fail even without full short-circuit', () => {
    const skipExpensive = { ...baseConfig, short_circuit_on_fail: false, skip_expensive_after_fail: true };
    expect(shouldShortCircuit(skipExpensive, failResult, ['typecheck', 'test'])).toBe(true);
    expect(shouldShortCircuit(skipExpensive, failResult, ['relationship'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldNeedReview
// ---------------------------------------------------------------------------

describe('shouldNeedReview', () => {
  it('returns true for critical risk', () => {
    const checks: VerificationCheckResult[] = [{
      level: 'test',
      status: 'fail',
      diagnostics: [],
      duration_ms: 100,
      failure_risk: 'critical',
    }];
    expect(shouldNeedReview(checks)).toBe(true);
  });

  it('returns true for high risk', () => {
    const checks: VerificationCheckResult[] = [{
      level: 'typecheck',
      status: 'fail',
      diagnostics: [],
      duration_ms: 100,
      failure_risk: 'high',
    }];
    expect(shouldNeedReview(checks)).toBe(true);
  });

  it('returns true when test verification required but not run', () => {
    const checks: VerificationCheckResult[] = [{
      level: 'typecheck',
      status: 'pass',
      diagnostics: [],
      duration_ms: 100,
    }];
    const changeSet = {
      change_id: 'ch-1',
      operation_type: 'extract',
      target_refs: [],
      rendered_edits: [],
      verification_requirements: ['test' as const],
    };
    expect(shouldNeedReview(checks, changeSet)).toBe(true);
  });

  it('returns false for clean pass with no risk', () => {
    const checks: VerificationCheckResult[] = [{
      level: 'freshness',
      status: 'pass',
      diagnostics: [],
      duration_ms: 5,
    }];
    expect(shouldNeedReview(checks)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeAggregateStatus
// ---------------------------------------------------------------------------

describe('computeAggregateStatus', () => {
  it('returns pass when all pass', () => {
    const checks: VerificationCheckResult[] = [
      { level: 'freshness', status: 'pass', diagnostics: [], duration_ms: 5 },
      { level: 'typecheck', status: 'pass', diagnostics: [], duration_ms: 100 },
    ];
    expect(computeAggregateStatus(checks, false)).toBe('pass');
  });

  it('returns fail when any fail', () => {
    const checks: VerificationCheckResult[] = [
      { level: 'freshness', status: 'pass', diagnostics: [], duration_ms: 5 },
      { level: 'typecheck', status: 'fail', diagnostics: [], duration_ms: 100 },
    ];
    expect(computeAggregateStatus(checks, false)).toBe('fail');
  });

  it('returns tool-error when present', () => {
    const checks: VerificationCheckResult[] = [
      { level: 'freshness', status: 'tool-error', diagnostics: [], duration_ms: 5 },
    ];
    expect(computeAggregateStatus(checks, false)).toBe('tool-error');
  });

  it('returns pass-with-warnings', () => {
    const checks: VerificationCheckResult[] = [
      { level: 'freshness', status: 'pass', diagnostics: [], duration_ms: 5 },
      { level: 'structural', status: 'pass-with-warnings', diagnostics: [], duration_ms: 10 },
    ];
    expect(computeAggregateStatus(checks, false)).toBe('pass-with-warnings');
  });

  it('returns needs-review when flagged', () => {
    const checks: VerificationCheckResult[] = [
      { level: 'freshness', status: 'pass', diagnostics: [], duration_ms: 5 },
    ];
    expect(computeAggregateStatus(checks, true)).toBe('needs-review');
  });
});

// ---------------------------------------------------------------------------
// generateMismatchSummary
// ---------------------------------------------------------------------------

describe('generateMismatchSummary', () => {
  it('returns undefined when no failures', () => {
    const checks: VerificationCheckResult[] = [
      { level: 'freshness', status: 'pass', diagnostics: [], duration_ms: 5 },
    ];
    expect(generateMismatchSummary(checks)).toBeUndefined();
  });

  it('summarizes failing diagnostics', () => {
    const checks: VerificationCheckResult[] = [{
      level: 'typecheck',
      status: 'fail',
      diagnostics: [
        { file: 'src/a.ts', line: 10, message: 'Type error', severity: 'error' },
        { file: 'src/b.ts', line: 20, message: 'Another error', severity: 'error' },
      ],
      duration_ms: 100,
    }];
    const summary = generateMismatchSummary(checks)!;
    expect(summary).toContain('src/a.ts:10');
    expect(summary).toContain('Type error');
    expect(summary).toContain('src/b.ts:20');
  });

  it('truncates at 5 diagnostics', () => {
    const diags = Array.from({ length: 8 }, (_, i) => ({
      file: `file${i}.ts`,
      line: i + 1,
      message: `Error ${i}`,
      severity: 'error' as const,
    }));
    const checks: VerificationCheckResult[] = [{
      level: 'typecheck',
      status: 'fail',
      diagnostics: diags,
      duration_ms: 100,
    }];
    const summary = generateMismatchSummary(checks)!;
    expect(summary).toContain('... and 3 more');
  });
});

// ---------------------------------------------------------------------------
// reconcileRelationships
// ---------------------------------------------------------------------------

describe('reconcileRelationships', () => {
  it('marks imports as broken when file was changed', () => {
    const result = reconcileRelationships({
      changed_files: ['src/utils.ts'],
      hash_refs: [],
      known_imports: [
        { file: 'src/app.ts', import_path: './utils' },
        { file: 'src/other.ts', import_path: './unrelated' },
      ],
    });
    expect(result.imports).toHaveLength(2);
    expect(result.imports[0].status).toBe('broken');
    expect(result.imports[1].status).toBe('valid');
    expect(result.broken_count).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('marks exports as possibly removed', () => {
    const result = reconcileRelationships({
      changed_files: ['src/utils.ts'],
      hash_refs: [],
      known_exports: [
        { file: 'src/utils.ts', symbol_name: 'parseConfig' },
        { file: 'src/other.ts', symbol_name: 'helper' },
      ],
    });
    expect(result.exports[0].still_defined).toBe(false);
    expect(result.exports[1].still_defined).toBe(true);
  });

  it('collects stale hash refs', () => {
    const result = reconcileRelationships({
      changed_files: [],
      hash_refs: ['h:abc', 'h:def'],
    });
    expect(result.stale_hash_refs).toEqual(['h:abc', 'h:def']);
    expect(result.broken_count).toBe(2);
  });

  it('returns clean result when nothing changed', () => {
    const result = reconcileRelationships({
      changed_files: [],
      hash_refs: [],
    });
    expect(result.broken_count).toBe(0);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// refreshRefs
// ---------------------------------------------------------------------------

describe('refreshRefs', () => {
  it('tracks invalidated refs', () => {
    const result = refreshRefs({
      edits: [
        { file: 'src/a.ts', old_hash: 'aaa', new_hash: 'bbb' },
      ],
      known_refs: ['h:aaa-ref1', 'h:ccc-ref2'],
    });
    expect(result.total_stale).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].stale_refs_invalidated).toContain('h:aaa-ref1');
  });

  it('identifies unresolvable refs', () => {
    const result = refreshRefs({
      edits: [
        { file: 'src/a.ts', old_hash: 'aaa', new_hash: 'bbb' },
      ],
      known_refs: ['h:zzz-unknown'],
    });
    expect(result.unresolvable_refs).toContain('h:zzz-unknown');
  });

  it('handles empty inputs', () => {
    const result = refreshRefs({ edits: [], known_refs: [] });
    expect(result.total_stale).toBe(0);
    expect(result.total_refreshed).toBe(0);
    expect(result.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createVerificationPipeline
// ---------------------------------------------------------------------------

describe('createVerificationPipeline', () => {
  it('sorts levels by cost', () => {
    const config = createVerificationPipeline(
      ['test', 'freshness', 'typecheck'],
      ['src/a.ts'],
    );
    expect(config.levels).toEqual(['freshness', 'typecheck', 'test']);
  });

  it('defaults to short-circuit and skip-expensive', () => {
    const config = createVerificationPipeline(['freshness'], ['src/a.ts']);
    expect(config.short_circuit_on_fail).toBe(true);
    expect(config.skip_expensive_after_fail).toBe(true);
  });

  it('accepts overrides', () => {
    const config = createVerificationPipeline(['freshness'], ['src/a.ts'], {
      short_circuit_on_fail: false,
      change_set_id: 'ch-x',
    });
    expect(config.short_circuit_on_fail).toBe(false);
    expect(config.change_set_id).toBe('ch-x');
  });
});

// ---------------------------------------------------------------------------
// assembleVerificationPipelineResult
// ---------------------------------------------------------------------------

describe('assembleVerificationPipelineResult', () => {
  it('assembles pass result', () => {
    const config = createVerificationPipeline(['freshness'], ['src/a.ts']);
    const checks: VerificationCheckResult[] = [
      { level: 'freshness', status: 'pass', diagnostics: [], duration_ms: 5 },
    ];
    const result = assembleVerificationPipelineResult(config, checks);
    expect(result.aggregate_status).toBe('pass');
    expect(result.total_duration_ms).toBe(5);
    expect(result.mismatch_summary).toBeUndefined();
    expect(result.verification_id).toMatch(/^vp-/);
  });

  it('assembles fail result with mismatch summary', () => {
    const config = createVerificationPipeline(['freshness', 'typecheck'], ['src/a.ts']);
    const checks: VerificationCheckResult[] = [
      { level: 'freshness', status: 'pass', diagnostics: [], duration_ms: 5 },
      {
        level: 'typecheck', status: 'fail',
        diagnostics: [{ file: 'src/a.ts', line: 10, message: 'type error', severity: 'error' }],
        duration_ms: 2000,
      },
    ];
    const result = assembleVerificationPipelineResult(config, checks);
    expect(result.aggregate_status).toBe('fail');
    expect(result.total_duration_ms).toBe(2005);
    expect(result.mismatch_summary).toContain('src/a.ts:10');
  });

  it('includes ref refresh and reconciliation', () => {
    const config = createVerificationPipeline(['freshness'], ['src/a.ts']);
    const checks: VerificationCheckResult[] = [
      { level: 'freshness', status: 'pass', diagnostics: [], duration_ms: 5 },
    ];
    const result = assembleVerificationPipelineResult(config, checks, {
      refRefresh: { entries: [], total_stale: 0, total_refreshed: 0, unresolvable_refs: [] },
      reconciliation: { imports: [], exports: [], stale_hash_refs: [], broken_count: 0, warnings: [] },
    });
    expect(result.ref_refresh).toBeDefined();
    expect(result.reconciliation).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// toCanonicalVerificationResult
// ---------------------------------------------------------------------------

describe('toCanonicalVerificationResult', () => {
  it('converts pipeline result to canonical shape', () => {
    const config = createVerificationPipeline(['freshness', 'typecheck'], ['src/a.ts']);
    const pipeline = assembleVerificationPipelineResult(config, [
      { level: 'freshness', status: 'pass', diagnostics: [], duration_ms: 5 },
      {
        level: 'typecheck', status: 'fail',
        diagnostics: [{ file: 'src/a.ts', line: 10, message: 'type error', severity: 'error' }],
        duration_ms: 2000,
      },
    ]);
    const canonical = toCanonicalVerificationResult(pipeline);
    expect(canonical.verification_id).toBe(pipeline.verification_id);
    expect(canonical.checks_run).toEqual(['freshness', 'typecheck']);
    expect(canonical.status).toBe('fail');
    expect(canonical.diagnostics).toHaveLength(1);
    expect(canonical.target_refs).toEqual(['src/a.ts']);
  });

  it('includes refreshed_refs when ref_refresh present', () => {
    const config = createVerificationPipeline(['freshness'], ['src/a.ts']);
    const pipeline = assembleVerificationPipelineResult(config, [
      { level: 'freshness', status: 'pass', diagnostics: [], duration_ms: 5 },
    ], {
      refRefresh: {
        entries: [{ file: 'src/a.ts', old_hash: 'old1', new_hash: 'new1', stale_refs_invalidated: [] }],
        total_stale: 1,
        total_refreshed: 1,
        unresolvable_refs: [],
      },
    });
    const canonical = toCanonicalVerificationResult(pipeline);
    expect(canonical.refreshed_refs).toEqual({ old1: 'new1' });
  });

  it('omits refreshed_refs when no entries', () => {
    const config = createVerificationPipeline(['freshness'], ['src/a.ts']);
    const pipeline = assembleVerificationPipelineResult(config, [
      { level: 'freshness', status: 'pass', diagnostics: [], duration_ms: 5 },
    ]);
    const canonical = toCanonicalVerificationResult(pipeline);
    expect(canonical.refreshed_refs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateVerificationId
// ---------------------------------------------------------------------------

describe('generateVerificationId', () => {
  it('generates unique IDs', () => {
    const id1 = generateVerificationId();
    const id2 = generateVerificationId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^vp-/);
  });
});
