import type { PromptMetrics } from '../stores/appStore';

export const PROTECTED_RECENT_ROUNDS = 6;

/** Verbatim tool-loop rounds kept before older rounds roll into summary */
export const ROLLING_WINDOW_ROUNDS = 20;

/** Max tokens for the formatted rolling summary message */
export const ROLLING_SUMMARY_MAX_TOKENS = 1500;

export const CONVERSATION_HISTORY_BUDGET_TOKENS = 20000;
export const STAGED_BUDGET_TOKENS = 4000;
/** Hard cap on total tokens across all staged snippets — prevents unbounded growth when batch stages hundreds of refs. */
export const STAGED_TOTAL_HARD_CAP_TOKENS = 65536;
export const STAGED_ANCHOR_BUDGET_TOKENS = 1200;
export const WM_BUDGET_TOKENS = 32000;
export const WORKSPACE_CONTEXT_BUDGET_TOKENS = 6000;
export const BLACKBOARD_BUDGET_TOKENS = 4000;

export const TOTAL_SOFT_PRESSURE_PCT = 0.70;
export const TOTAL_HARD_PRESSURE_PCT = 0.85;

export const HYGIENE_CHECK_INTERVAL_ROUNDS = 15;
export const COMPACT_HISTORY_TURN_THRESHOLD = 20;
export const COMPACT_HISTORY_TOKEN_THRESHOLD = 15000;

/** Safety ceiling for subagent rounds — budget-based stopping is the real limiter. */
export const SUBAGENT_MAX_ROUNDS = 100;
/** Total input+output tokens across all subagent rounds before forced stop. */
export const SUBAGENT_TOKEN_BUDGET_DEFAULT = 200_000;
/** Role-specific token budgets — read-only roles stop sooner to cap API spend. */
export const SUBAGENT_TOKEN_BUDGET_BY_ROLE: Record<string, number> = {
  retriever: 80_000,
  design: 100_000,
  coder: 200_000,
  tester: 150_000,
};
/** Role-specific maxTokens for model output per round — read-only roles need less. */
export const SUBAGENT_MAX_OUTPUT_TOKENS_BY_ROLE: Record<string, number> = {
  retriever: 2048,
  design: 2048,
  coder: 8192,
  tester: 4096,
};
/** Hard cap on pin budget instruction to prevent unbounded pinning behavior. */
export const SUBAGENT_PIN_BUDGET_CAP = 64_000;
/** Max paths listed in the "ALREADY STAGED" section of subagent system prompts. */
export const SUBAGENT_STAGED_PATHS_CAP = 60;

/** intent.survey: shallow tree by default (same cost model as tree context — listing, not full files). */
export const INTENT_SURVEY_DEFAULT_DEPTH = 2;
/** intent.survey: hard ceiling on tree depth from model params. */
export const INTENT_SURVEY_MAX_DEPTH = 3;
/**
 * intent.investigate: cap distinct paths from search → read.shaped(sig) (same token model as sig — not full smart read).
 */
export const INTENT_INVESTIGATE_MAX_FILES = 20;
/**
 * intent.survey: cap files from tree listing → read.shaped(sig) (tree text is cheap; sig batch was unbounded).
 */
export const INTENT_SURVEY_MAX_SHAPED_FILES = 40;

export const MAX_PERSISTENT_STAGE_ENTRY_TOKENS = 300;
export const MAX_PERSISTENT_STAGE_ENTRIES = 12;
export const MAX_TRANSIENT_STAGE_ENTRY_TOKENS = 1200;

export type StageAdmissionClass = 'persistentAnchor' | 'transientAnchor' | 'transientPayload';
export type StagePersistencePolicy = 'persist' | 'doNotPersist' | 'persistAsDemoted';
export type StageEvictionReason = 'stale' | 'duplicated' | 'overBudget' | 'demoted' | 'manual' | 'migration';

export type PromptReliefAction =
  | 'none'
  | 'compact_history'
  | 'evict_staged'
  | 'compact_wm'
  | 'evict_wm';

export interface PromptLayerBudgets {
  contextWindowTokens: number;
  staticSystemBudgetTokens: number;
  conversationHistoryBudgetTokens: number;
  stagedBudgetTokens: number;
  stagedAnchorBudgetTokens: number;
  wmBudgetTokens: number;
  workspaceContextBudgetTokens: number;
  blackboardBudgetTokens: number;
  totalSoftPressureTokens: number;
  totalHardPressureTokens: number;
}

export interface PromptPressureBuckets {
  staticSystemTokens: number;
  conversationHistoryTokens: number;
  stagedTokens: number;
  wmTokens: number;
  workspaceContextTokens: number;
  blackboardTokens: number;
  providerInputTokens: number;
  estimatedTotalPromptTokens: number;
  cacheStablePrefixTokens: number;
  cacheChurnTokens: number;
}

export interface PromptAssemblyState {
  staticPrefix: string;
  historyWindow: Array<{ role: string; content: unknown }>;
  stagedAnchors: string;
  workingMemoryBlock: string;
  workspaceContextBlock: string;
  currentRoundMessages: Array<{ role: string; content: unknown }>;
  cacheStrategy: 'prefix_stable' | 'rolling_cache' | 'none';
}

export function createPromptLayerBudgets(
  contextWindowTokens: number,
  staticSystemBudgetTokens: number,
): PromptLayerBudgets {
  return {
    contextWindowTokens,
    staticSystemBudgetTokens,
    conversationHistoryBudgetTokens: CONVERSATION_HISTORY_BUDGET_TOKENS,
    stagedBudgetTokens: STAGED_BUDGET_TOKENS,
    stagedAnchorBudgetTokens: STAGED_ANCHOR_BUDGET_TOKENS,
    wmBudgetTokens: WM_BUDGET_TOKENS,
    workspaceContextBudgetTokens: WORKSPACE_CONTEXT_BUDGET_TOKENS,
    blackboardBudgetTokens: BLACKBOARD_BUDGET_TOKENS,
    totalSoftPressureTokens: Math.floor(contextWindowTokens * TOTAL_SOFT_PRESSURE_PCT),
    totalHardPressureTokens: Math.floor(contextWindowTokens * TOTAL_HARD_PRESSURE_PCT),
  };
}

export function getStaticSystemTokens(promptMetrics: PromptMetrics): number {
  return (promptMetrics.modePromptTokens ?? 0)
    + (promptMetrics.toolRefTokens ?? 0)
    + (promptMetrics.shellGuideTokens ?? 0)
    + (promptMetrics.nativeToolTokens ?? 0)
    + (promptMetrics.contextControlTokens ?? 0);
}

export function getStagedTokens(_promptMetrics: PromptMetrics, stagedTokens: number): number {
  return stagedTokens;
}

export function getEstimatedTotalPromptTokens(
  buckets: Omit<PromptPressureBuckets, 'estimatedTotalPromptTokens'>,
): number {
  return buckets.staticSystemTokens
    + buckets.conversationHistoryTokens
    + buckets.stagedTokens
    + buckets.wmTokens
    + buckets.workspaceContextTokens
    + buckets.blackboardTokens;
}

export function getPromptPressureTokens(
  buckets: Pick<
    PromptPressureBuckets,
    | 'staticSystemTokens'
    | 'conversationHistoryTokens'
    | 'stagedTokens'
    | 'wmTokens'
    | 'workspaceContextTokens'
    | 'blackboardTokens'
  >,
): number {
  return buckets.staticSystemTokens
    + buckets.conversationHistoryTokens
    + buckets.stagedTokens
    + buckets.wmTokens
    + buckets.workspaceContextTokens
    + buckets.blackboardTokens;
}

export function classifyStageSnippet(
  key: string,
  tokens: number,
): {
  admissionClass: StageAdmissionClass;
  persistencePolicy: StagePersistencePolicy;
  demotedFrom?: StageAdmissionClass;
} {
  if (key.startsWith('entry:')) {
    if (tokens <= MAX_PERSISTENT_STAGE_ENTRY_TOKENS) {
      return { admissionClass: 'persistentAnchor', persistencePolicy: 'persist' };
    }
    if (tokens <= MAX_TRANSIENT_STAGE_ENTRY_TOKENS) {
      return {
        admissionClass: 'transientAnchor',
        persistencePolicy: 'persistAsDemoted',
        demotedFrom: 'persistentAnchor',
      };
    }
    return {
      admissionClass: 'transientPayload',
      persistencePolicy: 'doNotPersist',
      demotedFrom: 'persistentAnchor',
    };
  }

  if (tokens <= MAX_PERSISTENT_STAGE_ENTRY_TOKENS) {
    return { admissionClass: 'transientAnchor', persistencePolicy: 'persist' };
  }
  if (tokens <= MAX_TRANSIENT_STAGE_ENTRY_TOKENS) {
    return { admissionClass: 'transientAnchor', persistencePolicy: 'persistAsDemoted' };
  }
  return { admissionClass: 'transientPayload', persistencePolicy: 'doNotPersist' };
}
