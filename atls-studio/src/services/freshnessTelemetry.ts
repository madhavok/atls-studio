/**
 * Lightweight counters for file-tree / freshness paths (tests and diagnostics).
 * Not sent remotely unless wired later.
 */

export const freshnessTelemetry = {
  fileTreeChangedWithPaths: 0,
  /** file_tree_changed fired without resolvable paths — bounded invalidation path */
  fileTreeChangedCoarseNoPaths: 0,
  /** Chunks/snippets marked suspect when paths were known */
  engramsMarkedSuspectFromPaths: 0,
  /** Coarse event: awareness cleared without marking every engram suspect */
  coarseAwarenessOnlyInvalidations: 0,

  bbEntriesSuperseded: 0,
  stagedSnippetsMarkedStale: 0,
  taskDirectivesSuperseded: 0,
  cognitiveRulesExpired: 0,
  retentionEntriesDistilled: 0,
  sessionRestoreReconcileCount: 0,

  reset(): void {
    this.fileTreeChangedWithPaths = 0;
    this.fileTreeChangedCoarseNoPaths = 0;
    this.engramsMarkedSuspectFromPaths = 0;
    this.coarseAwarenessOnlyInvalidations = 0;
    this.bbEntriesSuperseded = 0;
    this.stagedSnippetsMarkedStale = 0;
    this.taskDirectivesSuperseded = 0;
    this.cognitiveRulesExpired = 0;
    this.retentionEntriesDistilled = 0;
    this.sessionRestoreReconcileCount = 0;
  },
};

export function incBbEntriesSuperseded(n = 1): void { freshnessTelemetry.bbEntriesSuperseded += n; }
export function incStagedSnippetsMarkedStale(n = 1): void { freshnessTelemetry.stagedSnippetsMarkedStale += n; }
export function incTaskDirectivesSuperseded(n = 1): void { freshnessTelemetry.taskDirectivesSuperseded += n; }
export function incCognitiveRulesExpired(n = 1): void { freshnessTelemetry.cognitiveRulesExpired += n; }
export function incRetentionEntriesDistilled(n = 1): void { freshnessTelemetry.retentionEntriesDistilled += n; }
export function incSessionRestoreReconcileCount(n = 1): void { freshnessTelemetry.sessionRestoreReconcileCount += n; }

export function getFreshnessMetrics(): Record<string, number> {
  return {
    fileTreeChangedWithPaths: freshnessTelemetry.fileTreeChangedWithPaths,
    fileTreeChangedCoarseNoPaths: freshnessTelemetry.fileTreeChangedCoarseNoPaths,
    engramsMarkedSuspectFromPaths: freshnessTelemetry.engramsMarkedSuspectFromPaths,
    coarseAwarenessOnlyInvalidations: freshnessTelemetry.coarseAwarenessOnlyInvalidations,
    bbEntriesSuperseded: freshnessTelemetry.bbEntriesSuperseded,
    stagedSnippetsMarkedStale: freshnessTelemetry.stagedSnippetsMarkedStale,
    taskDirectivesSuperseded: freshnessTelemetry.taskDirectivesSuperseded,
    cognitiveRulesExpired: freshnessTelemetry.cognitiveRulesExpired,
    retentionEntriesDistilled: freshnessTelemetry.retentionEntriesDistilled,
    sessionRestoreReconcileCount: freshnessTelemetry.sessionRestoreReconcileCount,
  };
}
