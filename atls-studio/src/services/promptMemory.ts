import type { PromptMetrics } from '../stores/appStore';

/** Only the current round's tool results stay fully materialized in history.
 *  All prior rounds deflate to hash pointers — the model pins what it needs. */
export const PROTECTED_RECENT_ROUNDS = 1;

/** Verbatim tool-loop rounds kept before older rounds roll into summary */
export const ROLLING_WINDOW_ROUNDS = 20;

/** Max tokens for the formatted rolling summary message.
 *  Calibrated against real BPE tokenizer (heuristic undercounted text by ~10%). */
export const ROLLING_SUMMARY_MAX_TOKENS = 1650;

/** Calibrated against real BPE tokenizer counts.
 *  History is a mix of code (~1.0x), JSON (~1.26x), and hash refs (~0.77x).
 *  Heuristic systematically undercounted hash-heavy content by ~15%.
 *  Thresholds raised to maintain same behavioral compression triggers. */
export const CONVERSATION_HISTORY_BUDGET_TOKENS = 24000;
/** Planned staged footprint in prompt budget math (not the same as admission warnings or hard prune). */
export const STAGED_BUDGET_TOKENS = 4500;
/**
 * Hard cap on total tokens across all staged snippets — enforced at prune time by
 * `pruneStagedSnippetsToBudget` in `contextStore.ts` (e.g. round end / pressure relief), not at `stage()`.
 * For the separate 25k stats-warning ceiling, see `STAGE_SOFT_CEILING` in `contextStore.ts`.
 */
export const STAGED_TOTAL_HARD_CAP_TOKENS = 65536;
export const STAGED_ANCHOR_BUDGET_TOKENS = 1400;
export const WM_BUDGET_TOKENS = 38000;
export const WORKSPACE_CONTEXT_BUDGET_TOKENS = 7000;
export const BLACKBOARD_BUDGET_TOKENS = 4800;

export const TOTAL_SOFT_PRESSURE_PCT = 0.70;
export const TOTAL_HARD_PRESSURE_PCT = 0.85;

export const HYGIENE_CHECK_INTERVAL_ROUNDS = 15;
export const COMPACT_HISTORY_TURN_THRESHOLD = 20;
export const COMPACT_HISTORY_TOKEN_THRESHOLD = 18000;

/** Max rounds in a single task phase before nudging session.advance. */
export const PHASE_ROUND_BUDGET = 5;

/** Soft total-round budget: nudge toward consolidation regardless of mutation status. */
export const TOTAL_ROUND_SOFT_BUDGET = 6;
/** Escalation threshold: stronger nudge to close out the session. */
export const TOTAL_ROUND_ESCALATION = 8;

/** Absolute ceiling on read-only rounds before force-stop (Layer 3 safety net). */
export const TOTAL_RESEARCH_ROUND_BUDGET = 25;
/** Additional rounds after budget warning before auto task_complete. */
export const RESEARCH_FORCE_STOP_MARGIN = 5;

/** Safety ceiling for subagent rounds — budget-based stopping is the real limiter. */
export const SUBAGENT_MAX_ROUNDS = 100;
/** Role-specific round caps — tight to prevent wasteful spinning.
 *  Audit showed all 4 roles fail identically regardless of budget —
 *  the issue is prompt architecture, not round count. Keep caps low
 *  until subagents demonstrate they can use rounds productively. */
export const SUBAGENT_MAX_ROUNDS_BY_ROLE: Record<string, number> = {
  retriever: 5,
  design: 8,
  coder: 15,
  tester: 12,
};
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

/**
 * Staged-snippet bucket size. Takes `promptMetrics` for signature parity with sibling bucket getters
 * (e.g. getStaticSystemTokens); staged total is passed explicitly as `stagedTokens`.
 */
export function getStagedTokens(_promptMetrics: PromptMetrics, stagedTokens: number): number {
  return stagedTokens;
}

/** Sum of user-visible prompt pressure buckets (single source of truth for totals). */
export function sumPromptPressureBuckets(
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

export function getEstimatedTotalPromptTokens(
  buckets: Omit<PromptPressureBuckets, 'estimatedTotalPromptTokens'>,
): number {
  return sumPromptPressureBuckets(buckets);
}

export function classifyStageSnippet(
  key: string,
  tokens: number,
): {
  admissionClass: StageAdmissionClass;
  persistencePolicy: StagePersistencePolicy;
  demotedFrom?: StageAdmissionClass;
} {
  if (key.startsWith('entry:') || key.startsWith('edit:')) {
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
