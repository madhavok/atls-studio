import { afterEach, describe, expect, it } from 'vitest';
import {
  freshnessTelemetry,
  getFreshnessMetrics,
  incBbEntriesSuperseded,
  incCognitiveRulesExpired,
  incRetentionEntriesDistilled,
  incSessionRestoreReconcileCount,
  incStagedSnippetsMarkedStale,
  incTaskDirectivesSuperseded,
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
