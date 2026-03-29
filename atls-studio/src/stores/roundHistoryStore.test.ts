import { beforeEach, describe, expect, it } from 'vitest';
import {
  useRoundHistoryStore,
  isMainChatRound,
  computeMainChatRoundCostStats,
  type RoundSnapshot,
} from './roundHistoryStore';

function makeSnapshot(round: number): RoundSnapshot {
  return {
    round,
    timestamp: round,
    wmTokens: 0,
    bbTokens: 0,
    stagedTokens: 0,
    archivedTokens: 0,
    overheadTokens: 0,
    freeTokens: 0,
    maxTokens: 100,
    staticSystemTokens: 0,
    conversationHistoryTokens: 0,
    stagedBucketTokens: 0,
    workspaceContextTokens: 0,
    providerInputTokens: 0,
    estimatedTotalPromptTokens: 0,
    cacheStablePrefixTokens: 0,
    cacheChurnTokens: 0,
    reliefAction: 'none',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costCents: 0,
    compressionSavings: 0,
    rollingSavings: 0,
    rolledRounds: 0,
    rollingSummaryTokens: 0,
    freedTokens: 0,
    cumulativeSaved: 0,
    toolCalls: 0,
    manageOps: 0,
    hypotheticalNonBatchedCost: 0,
    actualCost: 0,
  };
}

describe('roundHistoryStore', () => {
  beforeEach(() => {
    useRoundHistoryStore.getState().reset();
  });

  it('keeps only the newest 200 snapshots', () => {
    for (let round = 1; round <= 205; round++) {
      useRoundHistoryStore.getState().pushSnapshot(makeSnapshot(round));
    }

    const snapshots = useRoundHistoryStore.getState().snapshots;
    expect(snapshots).toHaveLength(200);
    expect(snapshots[0]?.round).toBe(6);
    expect(snapshots[snapshots.length - 1]?.round).toBe(205);
  });

  it('retains optional compatibility telemetry fields on stored snapshots', () => {
    useRoundHistoryStore.getState().pushSnapshot({
      ...makeSnapshot(1),
      legacyHistoryTelemetryKnownWrong: true,
      isSubagentRound: true,
      subagentType: 'retriever',
      subagentModel: 'test-model',
      subagentProvider: 'test-provider',
      subagentInvocationId: 'invoke-1',
    });

    const snapshot = useRoundHistoryStore.getState().snapshots[0];
    expect(snapshot).toMatchObject({
      legacyHistoryTelemetryKnownWrong: true,
      isSubagentRound: true,
      subagentType: 'retriever',
      subagentModel: 'test-model',
      subagentProvider: 'test-provider',
      subagentInvocationId: 'invoke-1',
    });
  });

  it('isMainChatRound excludes subagent and swarm snapshots', () => {
    expect(isMainChatRound(makeSnapshot(1))).toBe(true);
    expect(isMainChatRound({ ...makeSnapshot(1), isSubagentRound: true })).toBe(false);
    expect(isMainChatRound({ ...makeSnapshot(1), isSwarmRound: true })).toBe(false);
    expect(isMainChatRound({ ...makeSnapshot(1), isSubagentRound: true, isSwarmRound: true })).toBe(false);
  });

  it('computeMainChatRoundCostStats: aggregates main rounds only; avg × n equals sum for whole cents', () => {
    const a = { ...makeSnapshot(1), costCents: 10 };
    const b = { ...makeSnapshot(2), costCents: 20 };
    const sub = { ...makeSnapshot(3), costCents: 1000, isSubagentRound: true as const };
    const r = computeMainChatRoundCostStats([a, b, sub]);
    expect(r.mainRoundCount).toBe(2);
    expect(r.mainRoundsCostSum).toBe(30);
    expect(r.avgMainRoundCost).toBe(15);
    expect(r.avgMainRoundCost * r.mainRoundCount).toBe(r.mainRoundsCostSum);
  });

  it('computeMainChatRoundCostStats: empty snapshots', () => {
    expect(computeMainChatRoundCostStats([])).toEqual({
      mainRoundCount: 0,
      mainRoundsCostSum: 0,
      avgMainRoundCost: 0,
    });
  });

  it('stores optional latency telemetry on snapshots', () => {
    useRoundHistoryStore.getState().pushSnapshot({
      ...makeSnapshot(3),
      timeToFirstTokenMs: 120,
      roundLatencyMs: 4500,
    });
    expect(useRoundHistoryStore.getState().snapshots[0]).toMatchObject({
      round: 3,
      timeToFirstTokenMs: 120,
      roundLatencyMs: 4500,
    });
  });

  it('preserves false compatibility flags instead of dropping them', () => {
    useRoundHistoryStore.getState().pushSnapshot({
      ...makeSnapshot(2),
      legacyHistoryTelemetryKnownWrong: false,
      isSubagentRound: false,
    });

    const snapshot = useRoundHistoryStore.getState().snapshots[0];
    expect(snapshot).toHaveProperty('legacyHistoryTelemetryKnownWrong', false);
    expect(snapshot).toHaveProperty('isSubagentRound', false);
  });
});
