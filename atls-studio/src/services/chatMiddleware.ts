/**
 * Chat Middleware — composable pipeline for streamChatViaTauri concerns.
 *
 * Extracts isolated, testable logic from the monolithic tool loop:
 * - guardrail: session validity, abort propagation
 * - historyCompression: compress tool loop history when over budget
 * - promptBudget: BP2/BP3 estimates, staged snippet pruning
 *
 * Pattern inspired by Vercel AI SDK Language Model Middleware.
 */

import { useContextStore } from '../stores/contextStore';
import { useAppStore } from '../stores/appStore';
import { countTokensBatch, countToolDefTokens } from '../utils/tokenCounter';
import { serializeMessageContentForTokens } from '../utils/toon';
import { estimateHistoryTokensAsync, compressToolLoopHistory } from './historyCompressor';
import {
  CONVERSATION_HISTORY_BUDGET_TOKENS,
  COMPACT_HISTORY_TURN_THRESHOLD,
  COMPACT_HISTORY_TOKEN_THRESHOLD,
  PROTECTED_RECENT_ROUNDS,
  reconcileBudgets,
  type PromptReliefAction,
  type ReconciledBudgets,
} from './promptMemory';
import type { StreamCallbacks, AIConfig, ChatMode } from './aiService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoundContext {
  conversationHistory: Array<{ role: string; content: unknown }>;
  round: number;
  priorTurnBoundary: number;
  config: AIConfig;
  mode: ChatMode;
  reliefAction: PromptReliefAction;
  abortSignal: AbortSignal;
  isSessionValid: () => boolean;
  /** When true, conversationHistory was reused from end-of-turn cache — skip round 0 compression. */
  historyReusedFromCache?: boolean;
  /**
   * Reconciled per-round budgets + planned pressure actions, populated by the
   * budget reconciler before the middleware chain runs. Middlewares can
   * consult this to see cross-layer pressure without recomputing thresholds.
   * Optional for tests and call sites that pre-date the reconciler.
   */
  budgets?: ReconciledBudgets;
}

/** Middleware that runs before each tool loop round. Can mutate context. */
export type BeforeRoundMiddleware = (ctx: RoundContext) => Promise<RoundContext> | RoundContext;

/** G25: accumulate multiple relief actions instead of last-writer-wins */
function appendReliefAction(current: PromptReliefAction, next: PromptReliefAction): PromptReliefAction {
  if (current === 'none' || current === next) return next;
  return `${current}+${next}` as PromptReliefAction;
}

// ---------------------------------------------------------------------------
// Guardrail: Session validity + abort propagation
// ---------------------------------------------------------------------------

/** Wrap callbacks with session validity checks. Prevents stale updates after stop. */
export function createGuardrailCallbacks(
  raw: StreamCallbacks,
  isSessionValid: () => boolean,
): StreamCallbacks {
  const guard = <T extends unknown[]>(fn: (...args: T) => void) =>
    (...args: T) => { if (isSessionValid()) fn(...args); };

  return {
    onToken: guard(raw.onToken),
    onToolCall: guard(raw.onToolCall),
    onToolResult: guard(raw.onToolResult),
    onUsageUpdate: guard(raw.onUsageUpdate),
    onDone: guard(raw.onDone),
    onError: guard(raw.onError),
    onClear: raw.onClear ? guard(raw.onClear) : undefined,
    onTextStart: raw.onTextStart ? guard(raw.onTextStart) : undefined,
    onTextEnd: raw.onTextEnd ? guard(raw.onTextEnd) : undefined,
    onReasoningStart: raw.onReasoningStart ? guard(raw.onReasoningStart) : undefined,
    onReasoningDelta: raw.onReasoningDelta ? guard(raw.onReasoningDelta) : undefined,
    onReasoningEnd: raw.onReasoningEnd ? guard(raw.onReasoningEnd) : undefined,
    onToolInputStart: raw.onToolInputStart ? guard(raw.onToolInputStart) : undefined,
    onToolInputDelta: raw.onToolInputDelta ? guard(raw.onToolInputDelta) : undefined,
    onToolInputAvailable: raw.onToolInputAvailable ? guard(raw.onToolInputAvailable) : undefined,
    onStepStart: raw.onStepStart ? guard(raw.onStepStart) : undefined,
    onStepEnd: raw.onStepEnd ? guard(raw.onStepEnd) : undefined,
    onStreamError: raw.onStreamError ? guard(raw.onStreamError) : undefined,
    onStatus: raw.onStatus ? guard(raw.onStatus) : undefined,
  };
}

// ---------------------------------------------------------------------------
// History Compression Middleware
// ---------------------------------------------------------------------------

/**
 * Compress conversation history when over budget. Mutates conversationHistory in place.
 *
 * Phase 2 cache optimization: compression only runs on round 0 (start of a new
 * user turn). Within a tool loop (round > 0), history is append-only so the
 * Anthropic prefix cache stays valid — each round extends the prefix, and the
 * old portion gets cache reads (0.1x) instead of full rewrites (1.25x).
 */
export const historyCompressionMiddleware: BeforeRoundMiddleware = async (ctx) => {
  // Within a tool loop, skip compression to keep history append-only for
  // prefix cache stability. Compression is deferred to end-of-turn.
  if (ctx.round > 0) return ctx;

  // When history was reused from end-of-turn cache, compression already ran.
  // Skip to preserve the byte-identical prefix for provider cache hits.
  if (ctx.historyReusedFromCache) return ctx;

  // Use real tokenizer for the gate decision (warms LRU cache for sync calls inside compressor)
  const historyTokensBefore = await estimateHistoryTokensAsync(ctx.conversationHistory);
  if (historyTokensBefore <= CONVERSATION_HISTORY_BUDGET_TOKENS) {
    return ctx;
  }
  try {
    const compressed = compressToolLoopHistory(
      ctx.conversationHistory,
      undefined,
      ctx.priorTurnBoundary,
    );
    if (compressed > 0) {
      ctx.reliefAction = appendReliefAction(ctx.reliefAction, 'compact_history');
    }
  } catch (e) {
    // G32: catch compression failures so the round can still proceed
    console.warn('[middleware] historyCompression failed:', e);
  }
  return ctx;
};

// ---------------------------------------------------------------------------
// Prompt Budget Middleware
// ---------------------------------------------------------------------------

/** Staged snippet pruning when over budget. Updates reliefAction. */
export const promptBudgetMiddleware: BeforeRoundMiddleware = (ctx) => {
  const stagedRelief = useContextStore.getState().pruneStagedSnippets('overBudget');
  if (stagedRelief.removed > 0) {
    ctx.reliefAction = appendReliefAction(ctx.reliefAction, stagedRelief.reliefAction);
  }
  return ctx;
};

// ---------------------------------------------------------------------------
// BP2/BP3 Estimates (run once at start, not per-round)
// ---------------------------------------------------------------------------

/** Set BP2 and BP3 token estimates in prompt metrics. Call before first round. */
export async function setPromptBudgetEstimates(
  config: AIConfig,
  conversationHistory: Array<{ role: string; content: unknown }>,
): Promise<void> {
  try {
    const bp2ToolDefTokens = await countToolDefTokens();
    const lastUserIndex = conversationHistory.reduceRight(
      (acc, m, i) => (acc === -1 && m.role === 'user' ? i : acc),
      -1,
    );
    const priorContents: string[] = [];
    for (let j = 0; j < lastUserIndex; j++) {
      const m = conversationHistory[j];
      const text =
        typeof m.content === 'string'
          ? m.content
          : serializeMessageContentForTokens(m.content ?? '');
      priorContents.push(text);
    }
    const counts = await countTokensBatch(priorContents);
    const bp3PriorTurnsTokens = counts.reduce((a, b) => a + b, 0);
    useAppStore.getState().setPromptMetrics({ bp2ToolDefTokens, bp3PriorTurnsTokens });
  } catch {
    /* ignore — CacheCompositionSection shows 0 when unavailable */
  }
}

// ---------------------------------------------------------------------------
// Context Hygiene Middleware
// ---------------------------------------------------------------------------

/**
 * Turn-based compaction: at COMPACT_HISTORY_TURN_THRESHOLD rounds, force
 * history compression even mid-loop when history exceeds the hygiene token
 * threshold. This supplements the round-0-only historyCompressionMiddleware.
 */
export const contextHygieneMiddleware: BeforeRoundMiddleware = async (ctx) => {
  const roundCount = useAppStore.getState().promptMetrics.roundCount;
  if (roundCount < COMPACT_HISTORY_TURN_THRESHOLD) return ctx;

  const historyTokens = await estimateHistoryTokensAsync(ctx.conversationHistory);
  if (historyTokens <= COMPACT_HISTORY_TOKEN_THRESHOLD) return ctx;

  try {
    const compressed = compressToolLoopHistory(
      ctx.conversationHistory,
      undefined,
      ctx.priorTurnBoundary,
    );
    if (compressed > 0) {
      ctx.reliefAction = appendReliefAction(ctx.reliefAction, 'compact_history');
    }
  } catch (e) {
    // G32: catch compression failures so the round can still proceed
    console.warn('[middleware] contextHygiene compression failed:', e);
  }
  return ctx;
};

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const DEFAULT_BEFORE_ROUND_MIDDLEWARES: BeforeRoundMiddleware[] = [
  historyCompressionMiddleware,
  contextHygieneMiddleware,
  promptBudgetMiddleware,
];

/**
 * Populate `ctx.budgets` with a reconciled, cross-layer allocation. Reads
 * live bucket sizes from app + context store so the planner sees the round's
 * actual pressure. Safe to skip (returns ctx unchanged) when the app store
 * does not yet expose PromptMetrics — e.g. in unit tests that mock the store.
 */
export function reconcileRoundBudgets(ctx: RoundContext): RoundContext {
  try {
    const appState = useAppStore.getState() as unknown as {
      promptMetrics?: {
        bp2ToolDefTokens?: number;
        staticSystemTokens?: number;
        conversationHistoryTokens?: number;
        stagedTokens?: number;
        workspaceContextTokens?: number;
        blackboardTokens?: number;
        wmTokens?: number;
      };
      settings?: { contextWindowTokens?: number };
    };
    const metrics = appState.promptMetrics ?? {};
    const contextWindowTokens = appState.settings?.contextWindowTokens ?? 0;
    if (contextWindowTokens <= 0) return ctx;

    ctx.budgets = reconcileBudgets({
      contextWindowTokens,
      staticSystemTokens: metrics.staticSystemTokens ?? 0,
      toolDefTokens: metrics.bp2ToolDefTokens ?? 0,
      currentHistoryTokens: metrics.conversationHistoryTokens ?? 0,
      currentStagedTokens: metrics.stagedTokens ?? 0,
      currentWorkspaceContextTokens: metrics.workspaceContextTokens ?? 0,
      currentBlackboardTokens: metrics.blackboardTokens ?? 0,
      currentWmTokens: metrics.wmTokens ?? 0,
    });
  } catch (e) {
    // G32: reconciliation is advisory; swallow so the round still proceeds.
    console.warn('[middleware] reconcileRoundBudgets failed:', e);
  }
  return ctx;
}

/** Run before-round middlewares in sequence. Mutates ctx. */
export async function runBeforeRoundMiddlewares(
  ctx: RoundContext,
  middlewares: BeforeRoundMiddleware[] = DEFAULT_BEFORE_ROUND_MIDDLEWARES,
): Promise<RoundContext> {
  let result = reconcileRoundBudgets(ctx);
  for (const mw of middlewares) {
    result = await mw(result);
    if (result.abortSignal?.aborted) break;
  }
  return result;
}
