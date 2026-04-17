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

/** Keys classified as persistent anchors (`classifyStageSnippet`). New conventions must register a prefix here. */
export const PERSISTENT_ANCHOR_KEY_PREFIXES: readonly string[] = ['entry:', 'edit:'];

export function isPersistentAnchorKey(key: string): boolean {
  return PERSISTENT_ANCHOR_KEY_PREFIXES.some(p => key.startsWith(p));
}

export type StageAdmissionClass = 'persistentAnchor' | 'transientAnchor' | 'transientPayload';
export type StagePersistencePolicy = 'persist' | 'doNotPersist' | 'persistAsDemoted';
export type StageEvictionReason = 'stale' | 'duplicated' | 'overBudget' | 'demoted' | 'manual' | 'migration';

export type PromptReliefAction =
  | 'none'
  | 'compact_history'
  | 'evict_staged'
  | 'compact_wm'
  | 'evict_wm';

/**
 * Planned pressure-relief action, derived from cross-layer budget reconciliation.
 * Distinct from {@link PromptReliefAction} (which records what the middleware
 * chain actually did) so the planner and the recorder can evolve independently.
 */
export type PlannedPressureAction =
  | 'compact_history'
  | 'prune_staged'
  | 'prune_workspace'
  | 'prune_bb'
  | 'compact_wm';

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

// ---------------------------------------------------------------------------
// Unified budget reconciler (GAP 3)
// ---------------------------------------------------------------------------

export interface ReconcileBudgetsInput {
  /** Full model context window in tokens. */
  contextWindowTokens: number;
  /** System prompt + tool refs + shell guide + context control tokens. */
  staticSystemTokens: number;
  /** BP2 tool definition tokens (from provider or native tool spec). */
  toolDefTokens: number;
  currentHistoryTokens: number;
  currentStagedTokens: number;
  currentWorkspaceContextTokens: number;
  currentBlackboardTokens: number;
  currentWmTokens: number;
}

export interface ReconciledBudgets extends PromptLayerBudgets {
  /** contextWindow - staticSystem - toolDefs: the space for dynamic layers. */
  availableTokens: number;
  /**
   * Cross-layer pressure plan: layers whose current usage exceeds their
   *   reconciled allocation, ordered by absolute overage (most-over first).
   * Emitted so the middleware chain can act on the highest-pressure layers
   * without each middleware recomputing its own threshold.
   */
  plannedPressureActions: PlannedPressureAction[];
  /** Per-layer overage (current - allocation) — negative when under budget. */
  layerOverages: Record<PlannedPressureAction, number>;
}

/**
 * Produce a single coordinated allocation across the five dynamic prompt
 * layers (history, staged, WM, workspace context, blackboard) given the
 * actual context window and static/tool-def consumption.
 *
 * Step 1: `availableTokens = contextWindow - staticSystem - toolDefs`.
 * Step 2: Start from the five default constants.
 * Step 3: If the sum of defaults exceeds `available * TOTAL_SOFT_PRESSURE_PCT`,
 *         scale every default down proportionally to fit that soft envelope.
 *         If it still exceeds `available * TOTAL_HARD_PRESSURE_PCT` (which
 *         cannot happen via scaling alone unless `available <= 0`), clamp the
 *         per-layer budgets to zero and mark every layer for relief.
 * Step 4: For each layer whose current tokens exceed the reconciled
 *         allocation, emit a {@link PlannedPressureAction}. Actions are sorted
 *         by absolute overage (most-over first) so the middleware chain drives
 *         the worst layer first even when several are under pressure at once.
 *
 * Pure function: no store reads, no side-effects, deterministic for the same
 * input. Safe to call on every round.
 */
export function reconcileBudgets(input: ReconcileBudgetsInput): ReconciledBudgets {
  const {
    contextWindowTokens,
    staticSystemTokens,
    toolDefTokens,
    currentHistoryTokens,
    currentStagedTokens,
    currentWorkspaceContextTokens,
    currentBlackboardTokens,
    currentWmTokens,
  } = input;

  const availableTokens = Math.max(0, contextWindowTokens - staticSystemTokens - toolDefTokens);

  // Start from defaults.
  const defaults = {
    history: CONVERSATION_HISTORY_BUDGET_TOKENS,
    staged: STAGED_BUDGET_TOKENS,
    wm: WM_BUDGET_TOKENS,
    workspace: WORKSPACE_CONTEXT_BUDGET_TOKENS,
    blackboard: BLACKBOARD_BUDGET_TOKENS,
  };
  const defaultsSum = defaults.history + defaults.staged + defaults.wm + defaults.workspace + defaults.blackboard;

  const softEnvelope = Math.floor(availableTokens * TOTAL_SOFT_PRESSURE_PCT);
  const hardEnvelope = Math.floor(availableTokens * TOTAL_HARD_PRESSURE_PCT);

  // Scale proportionally when defaults overflow the soft envelope.
  const scale = defaultsSum > softEnvelope && defaultsSum > 0
    ? softEnvelope / defaultsSum
    : 1;

  const scaled = {
    history: Math.max(0, Math.floor(defaults.history * scale)),
    staged: Math.max(0, Math.floor(defaults.staged * scale)),
    wm: Math.max(0, Math.floor(defaults.wm * scale)),
    workspace: Math.max(0, Math.floor(defaults.workspace * scale)),
    blackboard: Math.max(0, Math.floor(defaults.blackboard * scale)),
  };
  const stagedAnchor = Math.max(0, Math.floor(STAGED_ANCHOR_BUDGET_TOKENS * scale));

  const layerOverages: Record<PlannedPressureAction, number> = {
    compact_history: currentHistoryTokens - scaled.history,
    prune_staged: currentStagedTokens - scaled.staged,
    prune_workspace: currentWorkspaceContextTokens - scaled.workspace,
    prune_bb: currentBlackboardTokens - scaled.blackboard,
    compact_wm: currentWmTokens - scaled.wm,
  };

  const layerAllocations: Record<PlannedPressureAction, number> = {
    compact_history: scaled.history,
    prune_staged: scaled.staged,
    prune_workspace: scaled.workspace,
    prune_bb: scaled.blackboard,
    compact_wm: scaled.wm,
  };

  const plannedPressureActions: PlannedPressureAction[] = (
    Object.entries(layerOverages) as Array<[PlannedPressureAction, number]>
  )
    .filter(([, over]) => over > 0)
    .sort(([actionA, overA], [actionB, overB]) => {
      const ratioA = overA / Math.max(1, layerAllocations[actionA]);
      const ratioB = overB / Math.max(1, layerAllocations[actionB]);
      return ratioB - ratioA;
    })
    .map(([action]) => action);

  return {
    contextWindowTokens,
    staticSystemBudgetTokens: staticSystemTokens,
    conversationHistoryBudgetTokens: scaled.history,
    stagedBudgetTokens: scaled.staged,
    stagedAnchorBudgetTokens: stagedAnchor,
    wmBudgetTokens: scaled.wm,
    workspaceContextBudgetTokens: scaled.workspace,
    blackboardBudgetTokens: scaled.blackboard,
    totalSoftPressureTokens: softEnvelope,
    totalHardPressureTokens: hardEnvelope,
    availableTokens,
    plannedPressureActions,
    layerOverages,
  };
}

export function getStaticSystemTokens(promptMetrics: PromptMetrics): number {
  const toolDefTokens = promptMetrics.bp2ToolDefTokens;
  return (promptMetrics.modePromptTokens ?? 0)
    + (promptMetrics.toolRefTokens ?? 0)
    + (promptMetrics.shellGuideTokens ?? 0)
    + (toolDefTokens && toolDefTokens > 0 ? toolDefTokens : (promptMetrics.nativeToolTokens ?? 0))
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
  if (isPersistentAnchorKey(key)) {
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

  // Non-anchor keys: single threshold (the two original size bands were identical —
  // placeholder for finer-grained admission that was never differentiated).
  if (tokens <= MAX_TRANSIENT_STAGE_ENTRY_TOKENS) {
    return { admissionClass: 'transientAnchor', persistencePolicy: 'persistAsDemoted' };
  }
  return { admissionClass: 'transientPayload', persistencePolicy: 'doNotPersist' };
}
