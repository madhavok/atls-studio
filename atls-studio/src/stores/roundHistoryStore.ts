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
  // Provider (for cache token semantics: Anthropic = non-overlapping, OpenAI/Google/Vertex = overlapping)
  provider?: string;
  // Cost
  costCents: number;
  inputCostCents?: number;
  outputCostCents?: number;
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
  /** True when this round had no mutations (read-only research). */
  isResearchRound?: boolean;
  /** Cumulative read-only rounds across the session. */
  totalResearchRounds?: number;
  /** New file paths touched this round (0 = coverage plateau). */
  newCoverage?: number;
  /** True when coverage has plateaued for 2+ consecutive rounds. */
  coveragePlateau?: boolean;
  /** BB writes this round that met the substantive quality threshold. */
  substantiveBbWrites?: number;

  // --- Spin diagnostic fingerprint ---
  /** Ordered tool names invoked this round (e.g. ["search.code","read.file","session.pin"]). */
  toolSignature?: string[];
  /** File paths touched by tool calls this round. */
  targetFiles?: string[];
  /** BB keys written or updated this round (empty = no convergence output). */
  bbDelta?: string[];
  /** Net pin/unpin: positive = net pins added, negative = net unpins. */
  wmDelta?: number;
  /** Hash refs the model referenced in tool params this round. */
  hashRefsConsumed?: string[];
  /** Hash refs evicted by compression middleware this round. */
  hashRefsEvicted?: string[];
  /** Short FNV hash of the assistant's visible text this round (detects literal repetition). */
  assistantTextHash?: string;
  /** Which <<SYSTEM:...>> steering blocks were injected this round. */
  steeringInjected?: string[];
  /** True when at least one ok change.* step applied (not dry-run preview). */
  hadRealChangeThisRound?: boolean;
  /** True when ok change.* steps were all dry-run previews (no disk mutation). */
  changeDryRunPreviewRound?: boolean;
  /** Tool output mentioned VOLATILE / pin to keep for this round. */
  volatileRefsSuggested?: boolean;
  /** Batch included a successful session.pin step. */
  hadSessionPinStep?: boolean;
  /** Successful `read.*` steps this round (from batch fingerprints). */
  readFileStepCount?: number;
  /** Distinct paths read this round. */
  uniqueReadPaths?: number;
  /** Distinct path|line-range read spans this round. */
  uniqueReadSpans?: number;
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

/** Cost aggregates for main-chat rounds only (same basis as Cost & I/O chart). */
export function computeMainChatRoundCostStats(snapshots: RoundSnapshot[]): {
  mainRoundCount: number;
  mainRoundsCostSum: number;
  avgMainRoundCost: number;
  avgInputCost: number;
  avgOutputCost: number;
} {
  const main = snapshots.filter(isMainChatRound);
  let sum = 0, inputSum = 0, outputSum = 0;
  for (const s of main) {
    sum += s.costCents;
    inputSum += s.inputCostCents ?? 0;
    outputSum += s.outputCostCents ?? 0;
  }
  const n = main.length;
  const mainRoundsCostSum = Math.round(sum * 100) / 100;
  const avgMainRoundCost = n > 0 ? Math.round((sum / n) * 100) / 100 : 0;
  const avgInputCost = n > 0 ? Math.round((inputSum / n) * 100) / 100 : 0;
  const avgOutputCost = n > 0 ? Math.round((outputSum / n) * 100) / 100 : 0;
  return { mainRoundCount: n, mainRoundsCostSum, avgMainRoundCost, avgInputCost, avgOutputCost };
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
