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
    // P2.4: truncated reflects whether the sliding window is saturated.
    expect(r.truncated).toBe(false);
    expect(r.includedRounds).toBe(2);
  });

  it('computeMainChatRoundCostStats: empty snapshots', () => {
    const r = computeMainChatRoundCostStats([]);
    expect(r).toMatchObject({
      mainRoundCount: 0,
      mainRoundsCostSum: 0,
      avgMainRoundCost: 0,
      avgInputCost: 0,
      avgOutputCost: 0,
      includedRounds: 0,
      truncated: false,
    });
  });

  // P2.4: surface sliding-window truncation so consumers don't silently
  // treat a 200-round average as a session total once older rounds roll off.
  it('computeMainChatRoundCostStats: truncated=true once the input reaches MAX_SNAPSHOTS', () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ ...makeSnapshot(i + 1), costCents: 5 }));
    const r = computeMainChatRoundCostStats(full);
    expect(r.truncated).toBe(true);
    expect(r.includedRounds).toBe(200);
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

  it('stores provider field on snapshot', () => {
    useRoundHistoryStore.getState().pushSnapshot({
      ...makeSnapshot(1),
      provider: 'openai',
    });
    expect(useRoundHistoryStore.getState().snapshots[0]?.provider).toBe('openai');
  });

  describe('display token split: Anthropic vs OpenAI/Google/Vertex', () => {
    function buildUncachedInput(s: RoundSnapshot): number {
      const isAnthropicRound = s.provider === 'anthropic';
      return isAnthropicRound ? s.inputTokens : Math.max(0, s.inputTokens - s.cacheReadTokens);
    }

    it('Anthropic: inputTokens is uncached-only, stacks without subtraction', () => {
      const snap: RoundSnapshot = {
        ...makeSnapshot(1),
        provider: 'anthropic',
        inputTokens: 5000,
        cacheReadTokens: 8000,
      };
      expect(buildUncachedInput(snap)).toBe(5000);
    });

    it('OpenAI: inputTokens includes cached subset, subtract to get uncached', () => {
      const snap: RoundSnapshot = {
        ...makeSnapshot(1),
        provider: 'openai',
        inputTokens: 10000,
        cacheReadTokens: 8000,
      };
      expect(buildUncachedInput(snap)).toBe(2000);
    });

    it('Google: same as OpenAI — subtract cached from total', () => {
      const snap: RoundSnapshot = {
        ...makeSnapshot(1),
        provider: 'google',
        inputTokens: 10000,
        cacheReadTokens: 7500,
      };
      expect(buildUncachedInput(snap)).toBe(2500);
    });

    it('no cache reads: uncached equals full input regardless of provider', () => {
      for (const provider of ['anthropic', 'openai', 'google', 'vertex'] as const) {
        const snap: RoundSnapshot = {
          ...makeSnapshot(1),
          provider,
          inputTokens: 15000,
          cacheReadTokens: 0,
        };
        expect(buildUncachedInput(snap)).toBe(15000);
      }
    });

    it('provider undefined: defaults to non-Anthropic (subtracts cache)', () => {
      const snap: RoundSnapshot = {
        ...makeSnapshot(1),
        inputTokens: 10000,
        cacheReadTokens: 6000,
      };
      expect(buildUncachedInput(snap)).toBe(4000);
    });
  });

  describe('batch efficiency: main-only vs full-session cost bases', () => {
    it('totalActual from main snapshots excludes subagent cost', () => {
      const main1: RoundSnapshot = { ...makeSnapshot(1), actualCost: 50, hypotheticalNonBatchedCost: 80 };
      const main2: RoundSnapshot = { ...makeSnapshot(2), actualCost: 30, hypotheticalNonBatchedCost: 60 };
      const sub: RoundSnapshot = { ...makeSnapshot(3), actualCost: 200, hypotheticalNonBatchedCost: 200, isSubagentRound: true };

      const mainOnly = [main1, main2, sub].filter(isMainChatRound);
      let totalActual = 0, totalHypothetical = 0;
      for (const s of mainOnly) {
        totalActual += s.actualCost;
        totalHypothetical += s.hypotheticalNonBatchedCost;
      }

      expect(totalActual).toBe(80);
      expect(totalHypothetical).toBe(140);
      expect(totalHypothetical - totalActual).toBe(60);
    });

    it('savings percentage uses main-only hypothetical and actual', () => {
      const main: RoundSnapshot = { ...makeSnapshot(1), actualCost: 25, hypotheticalNonBatchedCost: 100 };
      const mainOnly = [main].filter(isMainChatRound);
      let actual = 0, hypothetical = 0;
      for (const s of mainOnly) {
        actual += s.actualCost;
        hypothetical += s.hypotheticalNonBatchedCost;
      }
      const pct = hypothetical > 0 ? ((hypothetical - actual) / hypothetical) * 100 : 0;
      expect(pct).toBe(75);
    });
  });
});
