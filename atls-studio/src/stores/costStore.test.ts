import { beforeEach, describe, expect, it } from 'vitest';
import { calculateCost, type SubAgentUsage } from './costStore';
import type { RoundSnapshot } from './roundHistoryStore';

const COST_DATA_KEY = 'atls-cost-data';
const COST_SETTINGS_KEY = 'atls-cost-settings';

function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
}

Object.defineProperty(globalThis, 'localStorage', {
  value: createLocalStorageMock(),
  configurable: true,
});

const { useCostStore } = await import('./costStore');
const { useRoundHistoryStore } = await import('./roundHistoryStore');

function makeSnapshot(): RoundSnapshot {
  return {
    round: 1,
    timestamp: Date.now(),
    wmTokens: 1,
    bbTokens: 1,
    stagedTokens: 1,
    archivedTokens: 1,
    overheadTokens: 1,
    freeTokens: 1,
    maxTokens: 100,
    staticSystemTokens: 1,
    conversationHistoryTokens: 1,
    stagedBucketTokens: 1,
    workspaceContextTokens: 1,
    providerInputTokens: 1,
    estimatedTotalPromptTokens: 1,
    cacheStablePrefixTokens: 0,
    cacheChurnTokens: 0,
    reliefAction: 'none',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costCents: 1,
    compressionSavings: 0,
    rollingSavings: 0,
    rolledRounds: 0,
    rollingSummaryTokens: 0,
    freedTokens: 0,
    cumulativeSaved: 0,
    toolCalls: 0,
    manageOps: 0,
    hypotheticalNonBatchedCost: 0,
    actualCost: 1,
  };
}

describe('calculateCost', () => {
  it('returns 0 for non-finite or negative token counts', () => {
    expect(calculateCost('openai', 'gpt-4o', Number.NaN, 10)).toBe(0);
    expect(calculateCost('openai', 'gpt-4o', 10, Number.POSITIVE_INFINITY)).toBe(0);
    expect(calculateCost('openai', 'gpt-4o', -1, 10)).toBe(0);
    expect(calculateCost('openai', 'gpt-4o', 10, -1)).toBe(0);
  });

  it('prices Claude Opus 4.7 at $5/MTok input (not legacy claude-opus-4 $15)', () => {
    const oneM = 1_000_000;
    expect(calculateCost('anthropic', 'claude-opus-4-7', oneM, 0)).toBe(500);
    expect(calculateCost('anthropic', 'claude-opus-4-7-20260115', oneM, 0)).toBe(500);
    expect(calculateCost('anthropic', 'claude-opus-4', oneM, 0)).toBe(1500);
  });
});

const sampleSubAgentUsage = (): SubAgentUsage => ({
  invocationId: 'inv-1',
  type: 'retriever',
  provider: 'openai',
  model: 'gpt-4o',
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costCents: 3,
  rounds: 2,
  toolCalls: 1,
  pinTokens: 10,
  timestamp: new Date(),
});

describe('restorePersistedChatTotals', () => {
  beforeEach(() => {
    useCostStore.getState().resetChat();
    useCostStore.setState({ sessionInputTokens: 0, sessionOutputTokens: 0, sessionCostCents: 0, sessionApiCalls: 0 });
  });

  it('merges partial payloads without zeroing omitted subagent fields', () => {
    useCostStore.setState({
      chatCostCents: 10,
      chatApiCalls: 2,
      chatSubAgentCostCents: 4,
      subAgentUsages: [sampleSubAgentUsage()],
    });
    useCostStore.getState().restorePersistedChatTotals({ chatCostCents: 5 });
    const s = useCostStore.getState();
    expect(s.chatCostCents).toBe(5);
    expect(s.chatSubAgentCostCents).toBe(4);
    expect(s.chatApiCalls).toBe(2);
    expect(s.subAgentUsages).toHaveLength(1);
  });

  it('applies explicit zeros for subagent when provided', () => {
    useCostStore.setState({
      chatCostCents: 10,
      chatSubAgentCostCents: 4,
      subAgentUsages: [sampleSubAgentUsage()],
    });
    useCostStore.getState().restorePersistedChatTotals({
      chatCostCents: 8,
      chatSubAgentCostCents: 0,
      subAgentUsages: [],
    });
    const s = useCostStore.getState();
    expect(s.chatCostCents).toBe(8);
    expect(s.chatSubAgentCostCents).toBe(0);
    expect(s.subAgentUsages).toEqual([]);
  });
});

describe('costStore clearAllData', () => {
  beforeEach(() => {
    localStorage.clear();
    useRoundHistoryStore.getState().reset();
    useCostStore.setState({
      chatCostCents: 0,
      chatApiCalls: 0,
      subAgentUsages: [],
      chatSubAgentCostCents: 0,
      sessionInputTokens: 0,
      sessionOutputTokens: 0,
      sessionCostCents: 0,
      sessionApiCalls: 0,
      outputTokensSaved: 0,
      outputDedupsApplied: 0,
      refDensityHistory: [],
      setRefReplacements: 0,
      setRefTokensSaved: 0,
      dailyUsage: [],
      dailyLimitCents: null,
      monthlyLimitCents: null,
    });
  });

  it('clears persisted keys, in-memory counters, and round history', () => {
    localStorage.setItem(COST_DATA_KEY, JSON.stringify([{ date: '2026-03-10', provider: 'openai', model: 'gpt', inputTokens: 1, outputTokens: 1, costCents: 1, apiCalls: 1 }]));
    localStorage.setItem(COST_SETTINGS_KEY, JSON.stringify({ dailyLimitCents: 10, monthlyLimitCents: 20 }));

    useCostStore.setState({
      chatCostCents: 9,
      chatApiCalls: 3,
      subAgentUsages: [{
        invocationId: 'sub-1',
        type: 'retriever',
        provider: 'openai',
        model: 'gpt',
        inputTokens: 5,
        outputTokens: 6,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costCents: 7,
        rounds: 1,
        toolCalls: 2,
        pinTokens: 3,
        timestamp: new Date(),
      }],
      chatSubAgentCostCents: 7,
      sessionInputTokens: 100,
      sessionOutputTokens: 200,
      sessionCostCents: 30,
      sessionApiCalls: 4,
      outputTokensSaved: 12,
      outputDedupsApplied: 2,
      refDensityHistory: [0.1, 0.2],
      setRefReplacements: 5,
      setRefTokensSaved: 18,
      dailyUsage: [{ date: '2026-03-10', provider: 'openai', model: 'gpt', inputTokens: 1, outputTokens: 1, costCents: 1, apiCalls: 1 }],
      dailyLimitCents: 10,
      monthlyLimitCents: 20,
    });
    useRoundHistoryStore.getState().pushSnapshot(makeSnapshot());

    useCostStore.getState().clearAllData();

    expect(localStorage.getItem(COST_DATA_KEY)).toBeNull();
    expect(localStorage.getItem(COST_SETTINGS_KEY)).toBeNull();
    expect(useRoundHistoryStore.getState().snapshots).toEqual([]);
    expect(useCostStore.getState()).toMatchObject({
      chatCostCents: 0,
      chatApiCalls: 0,
      subAgentUsages: [],
      chatSubAgentCostCents: 0,
      sessionInputTokens: 0,
      sessionOutputTokens: 0,
      sessionCostCents: 0,
      sessionApiCalls: 0,
      outputTokensSaved: 0,
      outputDedupsApplied: 0,
      refDensityHistory: [],
      setRefReplacements: 0,
      setRefTokensSaved: 0,
      dailyUsage: [],
      dailyLimitCents: null,
      monthlyLimitCents: null,
    });
  });
});
