/**
 * UHPP Phase 5: Reconciliation and Verification Pipeline
 *
 * Implements layered, cost-aware verification with short-circuiting,
 * canonical diagnostic normalization, failure classification,
 * and post-edit reference reconciliation.
 *
 * See: docs/UHPP_PHASE5_RECONCILIATION.md
 */

import type {
  UhppDiagnostic,
  DiagnosticSeverity,
  UhppProvenance,
  VerificationLevel,
  VerificationStatus,
  UhppChangeSet,
  FailureCategory,
  FailureRisk,
  VerificationCheckResult,
  RefreshEntry,
  RefRefreshResult,
  ImportStatus,
  ImportReconciliation,
  ExportReconciliation,
  ReconciliationResult,
  VerificationPipelineConfig,
  VerificationPipelineResult,
  UhppVerificationResult,
} from './uhppCanonical';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let verifyCounter = 0;

export function generateVerificationId(): string {
  return `vp-${Date.now().toString(36)}-${(++verifyCounter).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Verification level cost ordering
// ---------------------------------------------------------------------------

const LEVEL_COST_ORDER: readonly VerificationLevel[] = [
  'freshness',
  'structural',
  'relationship',
  'parser',
  'typecheck',
  'test',
];

const EXPENSIVE_LEVELS: ReadonlySet<VerificationLevel> = new Set([
  'typecheck',
  'test',
]);

/**
 * Sort verification levels by cost (cheap first, expensive last).
 * Spec order: freshness → structural → relationship → parser → typecheck → test
 */
export function sortByVerificationCost(levels: VerificationLevel[]): VerificationLevel[] {
  const order = new Map(LEVEL_COST_ORDER.map((l, i) => [l, i]));
  return [...levels].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
}

// ---------------------------------------------------------------------------
// Diagnostic normalization — adapt raw tool output to UhppDiagnostic[]
// ---------------------------------------------------------------------------

export interface RawToolDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  end_line?: number;
  endColumn?: number;
  end_column?: number;
  message?: string;
  severity?: string;
  code?: string;
  source?: string;
  ruleId?: string;
  error?: string;
  test?: string;
}

function normalizeSeverity(raw: string | undefined): DiagnosticSeverity {
  if (!raw) return 'error';
  const lower = raw.toLowerCase();
  if (lower === 'warning' || lower === 'warn' || lower === '1') return 'warning';
  if (lower === 'info' || lower === 'information' || lower === 'note') return 'info';
  if (lower === 'hint' || lower === 'suggestion') return 'hint';
  return 'error';
}

/**
 * Normalize a single raw tool diagnostic into canonical UhppDiagnostic.
 * Handles both ESLint-style, TSC-style, and Rust-style diagnostic shapes.
 */
export function normalizeToolDiagnostic(
  raw: RawToolDiagnostic,
  defaultFile: string = '<unknown>',
  defaultSource?: string,
): UhppDiagnostic {
  return {
    file: raw.file ?? defaultFile,
    line: raw.line ?? 0,
    column: raw.column,
    end_line: raw.endLine ?? raw.end_line,
    end_column: raw.endColumn ?? raw.end_column,
    message: raw.message ?? raw.error ?? `Test failure: ${raw.test ?? 'unknown'}`,
    severity: normalizeSeverity(raw.severity),
    code: raw.code ?? raw.ruleId,
    source: raw.source ?? defaultSource,
  };
}

/**
 * Normalize an array of raw diagnostics from any verification tool.
 */
export function normalizeDiagnostics(
  raws: RawToolDiagnostic[],
  defaultFile: string = '<unknown>',
  defaultSource?: string,
): UhppDiagnostic[] {
  return raws.map(r => normalizeToolDiagnostic(r, defaultFile, defaultSource));
}

/**
 * Extract diagnostics from a raw verify backend response.
 * Handles the different shapes: `errors` array, `failures` array, raw `output`.
 */
export function extractDiagnosticsFromResponse(
  raw: Record<string, unknown>,
  verifyType: string,
): UhppDiagnostic[] {
  const diagnostics: UhppDiagnostic[] = [];

  if (Array.isArray(raw.errors)) {
    diagnostics.push(
      ...normalizeDiagnostics(raw.errors as RawToolDiagnostic[], '<unknown>', verifyType),
    );
  }

  if (Array.isArray(raw.failures)) {
    for (const f of raw.failures as RawToolDiagnostic[]) {
      diagnostics.push(normalizeToolDiagnostic(f, '<unknown>', verifyType));
    }
  }

  if (diagnostics.length === 0 && typeof raw.output === 'string' && raw.output.length > 0) {
    const status = raw.status as string | undefined;
    if (status === 'fail' || status === 'tool-error') {
      diagnostics.push({
        file: '<output>',
        line: 0,
        message: (raw.output as string).slice(0, 500),
        severity: 'error',
        source: verifyType,
      });
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

const CATEGORY_PATTERNS: ReadonlyArray<[RegExp, FailureCategory]> = [
  [/command not found|not recognized|not installed|No such file/i, 'host_missing_toolchain'],
  [/ENOENT|module not found|cannot find module|Cannot resolve/i, 'dependency_issue'],
  [/wrong workspace|not a project|no package\.json|no Cargo\.toml/i, 'wrong_workspace_root'],
  [/import.*not found|cannot resolve.*import|unresolved import/i, 'import_resolution'],
  [/type.*not assignable|Type.*mismatch|expected.*got/i, 'type_mismatch'],
  [/test.*fail|assertion.*fail|expect.*received/i, 'test_regression'],
];

/**
 * Classify a failure using diagnostics and optional context from prior edits.
 */
export function classifyFailure(
  diagnostics: UhppDiagnostic[],
  hasRecentEdits: boolean = false,
): { category: FailureCategory; risk: FailureRisk } {
  if (diagnostics.length === 0) {
    return { category: 'unknown', risk: 'low' };
  }

  const combined = diagnostics.map(d => d.message).join('\n');

  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(combined)) {
      const risk = categorizeRisk(category, hasRecentEdits);
      return { category, risk };
    }
  }

  if (hasRecentEdits) {
    return { category: 'refactor_induced', risk: 'high' };
  }

  return { category: 'baseline_project_failure', risk: 'medium' };
}

function categorizeRisk(category: FailureCategory, hasRecentEdits: boolean): FailureRisk {
  switch (category) {
    case 'host_missing_toolchain':
    case 'wrong_workspace_root':
      return 'low';
    case 'dependency_issue':
      return hasRecentEdits ? 'high' : 'medium';
    case 'type_mismatch':
    case 'import_resolution':
      return hasRecentEdits ? 'high' : 'medium';
    case 'test_regression':
      return hasRecentEdits ? 'critical' : 'high';
    case 'refactor_induced':
      return 'high';
    default:
      return 'medium';
  }
}

// ---------------------------------------------------------------------------
// Short-circuit logic
// ---------------------------------------------------------------------------

/**
 * Decide if the pipeline should short-circuit (skip remaining levels).
 */
export function shouldShortCircuit(
  config: VerificationPipelineConfig,
  lastResult: VerificationCheckResult,
  remainingLevels: VerificationLevel[],
): boolean {
  if (lastResult.status === 'pass' || lastResult.status === 'pass-with-warnings') {
    return false;
  }

  if (config.short_circuit_on_fail) {
    return true;
  }

  if (config.skip_expensive_after_fail && remainingLevels.some(l => EXPENSIVE_LEVELS.has(l))) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Needs-review detection
// ---------------------------------------------------------------------------

/**
 * Determine if verification should emit `needs-review` status.
 */
export function shouldNeedReview(
  checkResults: VerificationCheckResult[],
  changeSet?: UhppChangeSet,
): boolean {
  for (const cr of checkResults) {
    if (cr.failure_risk === 'critical' || cr.failure_risk === 'high') {
      return true;
    }
  }

  if (changeSet?.verification_requirements?.includes('test')) {
    const hasTestCheck = checkResults.some(cr => cr.level === 'test');
    if (!hasTestCheck) return true;
  }

  const hasWarnings = checkResults.some(
    cr => cr.status === 'pass-with-warnings',
  );
  const hasPublicApiChange = changeSet?.expected_downstream_updates &&
    changeSet.expected_downstream_updates.length > 2;
  if (hasWarnings && hasPublicApiChange) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Aggregate status computation
// ---------------------------------------------------------------------------

/**
 * Compute aggregate verification status from individual check results.
 */
export function computeAggregateStatus(
  checkResults: VerificationCheckResult[],
  needsReview: boolean,
): VerificationStatus {
  if (needsReview) return 'needs-review';

  const statuses = new Set(checkResults.map(cr => cr.status));

  if (statuses.has('tool-error')) return 'tool-error';
  if (statuses.has('fail')) return 'fail';
  if (statuses.has('pass-with-warnings')) return 'pass-with-warnings';
  if (statuses.has('needs-review')) return 'needs-review';

  return 'pass';
}

// ---------------------------------------------------------------------------
// Mismatch summary generation
// ---------------------------------------------------------------------------

/**
 * Generate a concise mismatch summary from failing diagnostics.
 */
export function generateMismatchSummary(checkResults: VerificationCheckResult[]): string | undefined {
  const failingDiags: UhppDiagnostic[] = [];
  for (const cr of checkResults) {
    if (cr.status === 'fail' || cr.status === 'tool-error') {
      failingDiags.push(...cr.diagnostics);
    }
  }

  if (failingDiags.length === 0) return undefined;

  const lines = failingDiags.slice(0, 5).map(d => {
    const loc = d.line > 0 ? `${d.file}:${d.line}` : d.file;
    return `${loc}: ${d.message.slice(0, 120)}`;
  });

  if (failingDiags.length > 5) {
    lines.push(`... and ${failingDiags.length - 5} more`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reference reconciliation (stubs for integration)
// ---------------------------------------------------------------------------

export interface ReconciliationInput {
  changed_files: string[];
  hash_refs: string[];
  known_imports?: Array<{ file: string; import_path: string }>;
  known_exports?: Array<{ file: string; symbol_name: string }>;
}

/**
 * Reconcile imports, exports, and hash refs after edits.
 * This is a structural check — not a full typecheck. It validates:
 * - Import paths still resolve
 * - Exported symbols are still defined
 * - Hash refs are not stale
 */
export function reconcileRelationships(input: ReconciliationInput): ReconciliationResult {
  const imports: ImportReconciliation[] = [];
  const exports: ExportReconciliation[] = [];
  const staleHashRefs: string[] = [];
  const warnings: string[] = [];

  if (input.known_imports) {
    for (const imp of input.known_imports) {
      const importBase = imp.import_path.replace(/^\.\//, '').replace(/\.[^.]+$/, '');
      const isChanged = input.changed_files.some(f => {
        const fileBase = f.replace(/\.[^.]+$/, '');
        return fileBase.endsWith(importBase) || importBase.endsWith(fileBase);
      });
      const status: ImportStatus = isChanged ? 'broken' : 'valid';
      imports.push({
        file: imp.file,
        import_path: imp.import_path,
        status,
        suggested_fix: isChanged ? `Verify import path "${imp.import_path}" after edit` : undefined,
      });
      if (isChanged) {
        warnings.push(`Import "${imp.import_path}" in ${imp.file} may be broken after edit`);
      }
    }
  }

  if (input.known_exports) {
    for (const exp of input.known_exports) {
      const fileChanged = input.changed_files.includes(exp.file);
      exports.push({
        file: exp.file,
        symbol_name: exp.symbol_name,
        still_defined: !fileChanged,
        still_referenced: true,
      });
      if (fileChanged) {
        warnings.push(`Export "${exp.symbol_name}" in ${exp.file} may have been removed or renamed`);
      }
    }
  }

  for (const ref of input.hash_refs) {
    staleHashRefs.push(ref);
  }

  const brokenCount =
    imports.filter(i => i.status === 'broken').length +
    exports.filter(e => !e.still_defined).length +
    staleHashRefs.length;

  return {
    imports,
    exports,
    stale_hash_refs: staleHashRefs,
    broken_count: brokenCount,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Reference refresh
// ---------------------------------------------------------------------------

export interface RefreshInput {
  edits: Array<{ file: string; old_hash: string; new_hash: string }>;
  known_refs: string[];
}

/**
 * Produce a ref refresh result from file edits — tracks which refs
 * are invalidated by which file change.
 */
export function refreshRefs(input: RefreshInput): RefRefreshResult {
  const entries: RefreshEntry[] = [];
  const unresolvable: string[] = [];
  let totalStale = 0;

  for (const edit of input.edits) {
    const invalidated = input.known_refs.filter(ref => ref.includes(edit.old_hash));
    totalStale += invalidated.length;
    entries.push({
      file: edit.file,
      old_hash: edit.old_hash,
      new_hash: edit.new_hash,
      stale_refs_invalidated: invalidated,
    });
  }

  const allInvalidated = new Set(entries.flatMap(e => e.stale_refs_invalidated));
  for (const ref of input.known_refs) {
    if (!allInvalidated.has(ref) && !input.edits.some(e => ref.includes(e.new_hash))) {
      unresolvable.push(ref);
    }
  }

  return {
    entries,
    total_stale: totalStale,
    total_refreshed: entries.length,
    unresolvable_refs: unresolvable,
  };
}

// ---------------------------------------------------------------------------
// Pipeline construction and execution
// ---------------------------------------------------------------------------

/**
 * Create a cost-ordered verification pipeline config from requirements.
 */
export function createVerificationPipeline(
  requirements: VerificationLevel[],
  targetRefs: string[],
  options?: {
    short_circuit_on_fail?: boolean;
    skip_expensive_after_fail?: boolean;
    change_set_id?: string;
  },
): VerificationPipelineConfig {
  return {
    levels: sortByVerificationCost(requirements),
    short_circuit_on_fail: options?.short_circuit_on_fail ?? true,
    skip_expensive_after_fail: options?.skip_expensive_after_fail ?? true,
    target_refs: targetRefs,
    change_set_id: options?.change_set_id,
  };
}

/**
 * Assemble the final VerificationPipelineResult from check results
 * and optional reconciliation/refresh data.
 */
export function assembleVerificationPipelineResult(
  config: VerificationPipelineConfig,
  checkResults: VerificationCheckResult[],
  options?: {
    changeSet?: UhppChangeSet;
    refRefresh?: RefRefreshResult;
    reconciliation?: ReconciliationResult;
    provenance?: UhppProvenance;
  },
): VerificationPipelineResult {
  const needsReview = shouldNeedReview(checkResults, options?.changeSet);
  const aggregateStatus = computeAggregateStatus(checkResults, needsReview);
  const totalDuration = checkResults.reduce((sum, cr) => sum + cr.duration_ms, 0);
  const mismatchSummary = generateMismatchSummary(checkResults);

  return {
    verification_id: generateVerificationId(),
    config,
    check_results: checkResults,
    aggregate_status: aggregateStatus,
    total_duration_ms: totalDuration,
    ref_refresh: options?.refRefresh,
    reconciliation: options?.reconciliation,
    mismatch_summary: mismatchSummary,
    provenance: options?.provenance,
  };
}

/**
 * Convert a VerificationPipelineResult into a canonical UhppVerificationResult.
 */
export function toCanonicalVerificationResult(
  pipeline: VerificationPipelineResult,
): UhppVerificationResult {
  const allDiagnostics = pipeline.check_results.flatMap(cr => cr.diagnostics);

  const refreshedRefs: Record<string, string> | undefined =
    pipeline.ref_refresh && pipeline.ref_refresh.entries.length > 0
      ? Object.fromEntries(
          pipeline.ref_refresh.entries.map(e => [e.old_hash, e.new_hash]),
        )
      : undefined;

  return {
    verification_id: pipeline.verification_id,
    checks_run: pipeline.config.levels,
    status: pipeline.aggregate_status,
    diagnostics: allDiagnostics,
    mismatch_summary: pipeline.mismatch_summary,
    refreshed_refs: refreshedRefs,
    target_refs: pipeline.config.target_refs,
    provenance: pipeline.provenance,
  };
}
