import { afterEach, describe, expect, it } from 'vitest';
import {
  BATCH_FAILURE_THRESHOLD,
  freshnessTelemetry,
  getBatchFailureSummary,
  getFreshnessMetrics,
  incBbEntriesSuperseded,
  incCognitiveRulesExpired,
  incRetentionEntriesDistilled,
  incSessionRestoreReconcileCount,
  incStagedSnippetsMarkedStale,
  incTaskDirectivesSuperseded,
  normalizeBatchFailureSnippet,
  recordBatchFailure,
} from './freshnessTelemetry';
import { useContextStore } from '../stores/contextStore';

describe('freshnessTelemetry', () => {
  afterEach(() => {
    freshnessTelemetry.reset();
  });

  it('resets with resetSession', () => {
    freshnessTelemetry.fileTreeChangedWithPaths = 3;
    freshnessTelemetry.fileTreeChangedCoarseNoPaths = 2;
    useContextStore.getState().resetSession();
    expect(freshnessTelemetry.fileTreeChangedWithPaths).toBe(0);
    expect(freshnessTelemetry.fileTreeChangedCoarseNoPaths).toBe(0);
  });

  it('reset() clears all counters', () => {
    freshnessTelemetry.fileTreeChangedWithPaths = 1;
    freshnessTelemetry.engramsMarkedSuspectFromPaths = 2;
    freshnessTelemetry.suspectBulkMarkedCoarse = 3;
    freshnessTelemetry.bbEntriesSuperseded = 4;
    freshnessTelemetry.sessionRestoreReconcileCount = 5;
    freshnessTelemetry.reset();
    const m = getFreshnessMetrics();
    expect(m.fileTreeChangedWithPaths).toBe(0);
    expect(m.engramsMarkedSuspectFromPaths).toBe(0);
    expect(m.suspectBulkMarkedCoarse).toBe(0);
    expect(m.bbEntriesSuperseded).toBe(0);
    expect(m.sessionRestoreReconcileCount).toBe(0);
  });

  it('inc* helpers and getFreshnessMetrics reflect increments', () => {
    incBbEntriesSuperseded(2);
    incStagedSnippetsMarkedStale();
    incTaskDirectivesSuperseded(3);
    incCognitiveRulesExpired();
    incRetentionEntriesDistilled(4);
    incSessionRestoreReconcileCount();
    const m = getFreshnessMetrics();
    expect(m.bbEntriesSuperseded).toBe(2);
    expect(m.stagedSnippetsMarkedStale).toBe(1);
    expect(m.taskDirectivesSuperseded).toBe(3);
    expect(m.cognitiveRulesExpired).toBe(1);
    expect(m.retentionEntriesDistilled).toBe(4);
    expect(m.sessionRestoreReconcileCount).toBe(1);
  });

  it('getFreshnessMetrics returns a snapshot of every field', () => {
    const keys = Object.keys(getFreshnessMetrics()).sort();
    expect(keys).toEqual([
      'batchFailureClasses',
      'batchFailureTotal',
      'bbEntriesSuperseded',
      'clearSuspectFullClears',
      'coarseAwarenessOnlyInvalidations',
      'cognitiveRulesExpired',
      'engramsMarkedSuspectFromPaths',
      'fileTreeChangedCoarseNoPaths',
      'fileTreeChangedWithPaths',
      'manifestEvicted',
      'manifestForwarded',
      'retentionEntriesDistilled',
      'sessionRestoreReconcileCount',
      'stagedSnippetsMarkedStale',
      'suspectBulkMarkedCoarse',
      'suspectMarkedUnresolvable',
      'suspectSkippedDirKeys',
      'taskDirectivesSuperseded',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rule D — batch-failure telemetry
// ---------------------------------------------------------------------------

describe('recordBatchFailure', () => {
  afterEach(() => {
    freshnessTelemetry.reset();
  });

  it('records a single-step failure', () => {
    const count = recordBatchFailure('read.lines', 'missing lines param', ['r1']);
    expect(count).toBe(1);
    const summary = getBatchFailureSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      op: 'read.lines',
      count: 1,
      errorSnippet: 'missing lines param',
    });
    expect(summary[0].exampleStepIds).toEqual(['r1']);
  });

  it('accumulates across multiple calls with same class', () => {
    recordBatchFailure('read.lines', 'missing lines', ['r1']);
    recordBatchFailure('read.lines', 'missing lines', ['r2']);
    const count = recordBatchFailure('read.lines', 'missing lines', ['r3']);
    expect(count).toBe(3);
    expect(getBatchFailureSummary()).toHaveLength(1);
  });

  it('batches multiple step IDs from one call into count + ring buffer', () => {
    const count = recordBatchFailure('read.lines', 'missing lines', ['r1', 'r2', 'r3', 'r4']);
    expect(count).toBe(4);
    const [entry] = getBatchFailureSummary();
    expect(entry.exampleStepIds.length).toBeLessThanOrEqual(3);
    // Most recent first (unshifted)
    expect(entry.exampleStepIds[0]).toBe('r4');
  });

  it('separates distinct (op, message) classes', () => {
    recordBatchFailure('read.lines', 'missing lines', ['r1']);
    recordBatchFailure('read.lines', 'other error', ['r2']);
    recordBatchFailure('read.file', 'missing lines', ['r3']);
    const summary = getBatchFailureSummary();
    expect(summary).toHaveLength(3);
  });

  it('sorts summary by count desc', () => {
    recordBatchFailure('a.b', 'low', ['s1']);
    recordBatchFailure('c.d', 'high', ['s1', 's2', 's3']);
    recordBatchFailure('e.f', 'mid', ['s1', 's2']);
    const summary = getBatchFailureSummary();
    expect(summary.map(e => e.op)).toEqual(['c.d', 'e.f', 'a.b']);
  });

  it('truncates errorSnippet to 120 chars (strict byte prefix)', () => {
    const longMsg = 'x'.repeat(500);
    recordBatchFailure('read.lines', longMsg, ['r1']);
    const [entry] = getBatchFailureSummary();
    expect(entry.errorSnippet.length).toBe(120);
  });

  it('normalizes trailing whitespace before snippet truncation', () => {
    expect(normalizeBatchFailureSnippet('  hello world  \n\n')).toBe('hello world');
  });

  it('ignores empty op / message / stepIds', () => {
    expect(recordBatchFailure('', 'msg', ['r1'])).toBe(0);
    expect(recordBatchFailure('op', '', ['r1'])).toBe(0);
    expect(recordBatchFailure('op', 'msg', [])).toBe(0);
    expect(getBatchFailureSummary()).toHaveLength(0);
  });

  it('reset() clears batchFailuresByClass', () => {
    recordBatchFailure('read.lines', 'err', ['r1', 'r2']);
    expect(getBatchFailureSummary()).toHaveLength(1);
    freshnessTelemetry.reset();
    expect(getBatchFailureSummary()).toHaveLength(0);
  });

  it('BATCH_FAILURE_THRESHOLD is a positive integer', () => {
    expect(Number.isInteger(BATCH_FAILURE_THRESHOLD)).toBe(true);
    expect(BATCH_FAILURE_THRESHOLD).toBeGreaterThan(0);
  });

  it('metrics snapshot reports aggregate counters', () => {
    recordBatchFailure('a.b', 'low', ['s1']);
    recordBatchFailure('c.d', 'high', ['s1', 's2', 's3']);
    const m = getFreshnessMetrics();
    expect(m.batchFailureClasses).toBe(2);
    expect(m.batchFailureTotal).toBe(4);
  });
});
