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

  reset(): void {
    this.fileTreeChangedWithPaths = 0;
    this.fileTreeChangedCoarseNoPaths = 0;
    this.engramsMarkedSuspectFromPaths = 0;
    this.coarseAwarenessOnlyInvalidations = 0;
  },
};
