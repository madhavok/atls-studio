import { create } from 'zustand';
import type { PromptReliefAction } from '../services/promptMemory';

export type VerificationConfidence = 'fresh' | 'cached' | 'stale-suspect' | 'obsolete';

export interface RoundSnapshot {
  round: number;
  timestamp: number;
  // Context composition (tokens)
  wmTokens: number;
  wmStoreTokens?: number;
  bbTokens: number;
  stagedTokens: number;
  archivedTokens: number;
  overheadTokens: number;
  freeTokens: number;
  maxTokens: number;
  staticSystemTokens: number;
  conversationHistoryTokens: number;
  stagedBucketTokens: number;
  workspaceContextTokens: number;
  providerInputTokens: number;
  estimatedTotalPromptTokens: number;
  cacheStablePrefixTokens: number;
  cacheChurnTokens: number;
  reliefAction: PromptReliefAction;
  legacyHistoryTelemetryKnownWrong?: boolean;

  verificationConfidence?: VerificationConfidence;
  verificationLabel?: string;
  verificationReused?: boolean;
  verificationObsolete?: boolean;
  // I/O
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Cost
  costCents: number;
  // Savings
  compressionSavings: number;
  /** Tokens removed by rolling window (not hash compression) */
  rollingSavings: number;
  /** Rounds distilled into rolling summary */
  rolledRounds: number;
  /** Token size of formatted rolling summary message */
  rollingSummaryTokens: number;
  freedTokens: number;
  cumulativeSaved: number;
  // Batch efficiency
  toolCalls: number;
  manageOps: number;
  hypotheticalNonBatchedCost: number;
  actualCost: number;
  // SubAgent tracking (optional — present when this round belongs to a subagent invocation)
  isSubagentRound?: boolean;
  /** Swarm worker / planner / synthesis stream (not main chat agent loop) */
  isSwarmRound?: boolean;
  subagentType?: 'retriever' | 'design' | 'coder' | 'tester';
  subagentModel?: string;
  subagentProvider?: string;
  subagentInvocationId?: string;
  /** Compact breakdown of history token distribution (e.g. "chat:2.1k results:5.3k refs:1.2k") */
  historyBreakdownLabel?: string;
  /** Wall-clock ms from stream start to first assistant text token */
  timeToFirstTokenMs?: number;
  /** Wall-clock ms for full round (stream start to stream completion) */
  roundLatencyMs?: number;
}

interface RoundHistoryState {
  snapshots: RoundSnapshot[];
  pushSnapshot: (snapshot: RoundSnapshot) => void;
  reset: () => void;
}

export const MAX_SNAPSHOTS = 200;

/** Primary chat agent rounds only (excludes subagent and swarm worker snapshots). */
export function isMainChatRound(s: RoundSnapshot): boolean {
  return !s.isSubagentRound && !s.isSwarmRound;
}

export const useRoundHistoryStore = create<RoundHistoryState>((set) => ({
  snapshots: [],

  pushSnapshot: (snapshot) =>
    set((state) => {
      const next = [...state.snapshots, snapshot];
      if (next.length > MAX_SNAPSHOTS) {
        return { snapshots: next.slice(next.length - MAX_SNAPSHOTS) };
      }
      return { snapshots: next };
    }),

  reset: () => set({ snapshots: [] }),
}));
