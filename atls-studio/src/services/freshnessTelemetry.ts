/**
 * Lightweight counters for file-tree / freshness paths (tests and diagnostics).
 * Not sent remotely unless wired later.
 */

/**
 * One bucket per (op, normalized-error-prefix). Collapsed batch failures record here
 * so repeated-misuse patterns survive the per-batch dedupe that hides them from the
 * archived shell path. See recordBatchFailure / getBatchFailureSummary.
 */
export interface BatchFailureBucket {
  op: string;
  /** First 120 chars of the first observed error message (trimmed) — dedupe key body. */
  errorSnippet: string;
  /** Running count across this session for this (op, errorSnippet) pair. */
  count: number;
  /** Ring-buffered step IDs (most recent first, max 3) — evidence for the pattern. */
  exampleStepIds: string[];
}

/** How many chars of the error message define the dedupe class. */
const BATCH_FAILURE_SNIPPET_LEN = 120;

/** Ring-buffer depth for per-bucket step IDs. */
const BATCH_FAILURE_EXAMPLE_CAP = 3;

export const freshnessTelemetry = {
  fileTreeChangedWithPaths: 0,
  /** file_tree_changed fired without resolvable paths — bounded invalidation path */
  fileTreeChangedCoarseNoPaths: 0,
  /** Chunks/snippets marked suspect when paths were known */
  engramsMarkedSuspectFromPaths: 0,
  /** Coarse event: awareness cleared without marking every engram suspect */
  coarseAwarenessOnlyInvalidations: 0,

  suspectSkippedDirKeys: 0,
  suspectMarkedUnresolvable: 0,
  suspectBulkMarkedCoarse: 0,
  clearSuspectFullClears: 0,

  bbEntriesSuperseded: 0,
  stagedSnippetsMarkedStale: 0,
  taskDirectivesSuperseded: 0,
  cognitiveRulesExpired: 0,
  retentionEntriesDistilled: 0,
  sessionRestoreReconcileCount: 0,

  /**
   * Per-class batch failure buckets. Keyed by `${op}::${errorSnippet}`.
   * Bounded by unique classes observed; typical sessions see <20 distinct keys.
   * Cleared on reset() (session boundary).
   */
  batchFailuresByClass: new Map<string, BatchFailureBucket>(),

  reset(): void {
    this.fileTreeChangedWithPaths = 0;
    this.fileTreeChangedCoarseNoPaths = 0;
    this.engramsMarkedSuspectFromPaths = 0;
    this.coarseAwarenessOnlyInvalidations = 0;
    this.suspectSkippedDirKeys = 0;
    this.suspectMarkedUnresolvable = 0;
    this.suspectBulkMarkedCoarse = 0;
    this.clearSuspectFullClears = 0;
    this.bbEntriesSuperseded = 0;
    this.stagedSnippetsMarkedStale = 0;
    this.taskDirectivesSuperseded = 0;
    this.cognitiveRulesExpired = 0;
    this.retentionEntriesDistilled = 0;
    this.sessionRestoreReconcileCount = 0;
    this.batchFailuresByClass.clear();
  },
};

export function incBbEntriesSuperseded(n = 1): void { freshnessTelemetry.bbEntriesSuperseded += n; }
export function incStagedSnippetsMarkedStale(n = 1): void { freshnessTelemetry.stagedSnippetsMarkedStale += n; }
export function incTaskDirectivesSuperseded(n = 1): void { freshnessTelemetry.taskDirectivesSuperseded += n; }
export function incCognitiveRulesExpired(n = 1): void { freshnessTelemetry.cognitiveRulesExpired += n; }
export function incRetentionEntriesDistilled(n = 1): void { freshnessTelemetry.retentionEntriesDistilled += n; }
export function incSessionRestoreReconcileCount(n = 1): void { freshnessTelemetry.sessionRestoreReconcileCount += n; }

/**
 * Normalize an error message into a dedupe snippet. Strips trailing whitespace and
 * truncates to BATCH_FAILURE_SNIPPET_LEN. Does NOT fuzzy-normalize or pattern-match —
 * strict byte-prefix dedupe only so subtly different errors stay distinct.
 */
export function normalizeBatchFailureSnippet(message: string): string {
  return message.trim().slice(0, BATCH_FAILURE_SNIPPET_LEN);
}

/**
 * Record a batch step failure against its (op, error) class. Counts all failures
 * (even the single-instance ones) so session-wide misuse patterns surface even when
 * batch-level dedupe collapses them in the tool_result text.
 *
 * @param op — operation name, e.g. `read.lines`
 * @param message — raw error/summary text from the failed step
 * @param stepIds — step IDs contributing to this record (batch-grouped)
 * @returns post-increment bucket count for the class
 */
export function recordBatchFailure(op: string, message: string, stepIds: string[]): number {
  if (!op || !message || stepIds.length === 0) return 0;
  const snippet = normalizeBatchFailureSnippet(message);
  const key = `${op}::${snippet}`;
  let entry = freshnessTelemetry.batchFailuresByClass.get(key);
  if (!entry) {
    entry = { op, errorSnippet: snippet, count: 0, exampleStepIds: [] };
    freshnessTelemetry.batchFailuresByClass.set(key, entry);
  }
  entry.count += stepIds.length;
  for (const id of stepIds) {
    entry.exampleStepIds.unshift(id);
  }
  if (entry.exampleStepIds.length > BATCH_FAILURE_EXAMPLE_CAP) {
    entry.exampleStepIds.length = BATCH_FAILURE_EXAMPLE_CAP;
  }
  return entry.count;
}

/**
 * Snapshot of all recorded failure classes for this session, sorted by count desc.
 * Consumers: session.debug surface, BB threshold writer, diagnostics block.
 */
export function getBatchFailureSummary(): BatchFailureBucket[] {
  return Array.from(freshnessTelemetry.batchFailuresByClass.values())
    .sort((a, b) => b.count - a.count);
}

/** Minimum occurrences of a single (op, error) class before it crosses into "repeated misuse". */
export const BATCH_FAILURE_THRESHOLD = 3;

/** BB key used for persisting repeated-misuse records within a session. */
export const BATCH_FAILURE_BB_KEY = 'telemetry:failed-ops:session';

let _getManifestMetrics: (() => { forwarded: number; evicted: number }) | null = null;

export function setManifestMetricsAccessor(fn: () => { forwarded: number; evicted: number }): void {
  _getManifestMetrics = fn;
}

export function getFreshnessMetrics(): Record<string, number> {
  const mm = _getManifestMetrics?.() ?? { forwarded: 0, evicted: 0 };
  let batchFailureTotal = 0;
  let batchFailureClasses = 0;
  for (const entry of freshnessTelemetry.batchFailuresByClass.values()) {
    batchFailureTotal += entry.count;
    batchFailureClasses++;
  }
  return {
    fileTreeChangedWithPaths: freshnessTelemetry.fileTreeChangedWithPaths,
    fileTreeChangedCoarseNoPaths: freshnessTelemetry.fileTreeChangedCoarseNoPaths,
    engramsMarkedSuspectFromPaths: freshnessTelemetry.engramsMarkedSuspectFromPaths,
    coarseAwarenessOnlyInvalidations: freshnessTelemetry.coarseAwarenessOnlyInvalidations,
    suspectSkippedDirKeys: freshnessTelemetry.suspectSkippedDirKeys,
    suspectMarkedUnresolvable: freshnessTelemetry.suspectMarkedUnresolvable,
    suspectBulkMarkedCoarse: freshnessTelemetry.suspectBulkMarkedCoarse,
    clearSuspectFullClears: freshnessTelemetry.clearSuspectFullClears,
    bbEntriesSuperseded: freshnessTelemetry.bbEntriesSuperseded,
    stagedSnippetsMarkedStale: freshnessTelemetry.stagedSnippetsMarkedStale,
    taskDirectivesSuperseded: freshnessTelemetry.taskDirectivesSuperseded,
    cognitiveRulesExpired: freshnessTelemetry.cognitiveRulesExpired,
    retentionEntriesDistilled: freshnessTelemetry.retentionEntriesDistilled,
    sessionRestoreReconcileCount: freshnessTelemetry.sessionRestoreReconcileCount,
    batchFailureTotal,
    batchFailureClasses,
    manifestForwarded: mm.forwarded,
    manifestEvicted: mm.evicted,
  };
}
