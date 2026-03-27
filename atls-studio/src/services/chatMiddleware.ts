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

import { invoke } from '@tauri-apps/api/core';
import { useContextStore } from '../stores/contextStore';
import { useAppStore } from '../stores/appStore';
import { estimateTokens } from '../utils/contextHash';
import { estimateHistoryTokens, compressToolLoopHistory } from './historyCompressor';
import {
  CONVERSATION_HISTORY_BUDGET_TOKENS,
  COMPACT_HISTORY_TURN_THRESHOLD,
  COMPACT_HISTORY_TOKEN_THRESHOLD,
  PROTECTED_RECENT_ROUNDS,
  type PromptReliefAction,
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
}

/** Middleware that runs before each tool loop round. Can mutate context. */
export type BeforeRoundMiddleware = (ctx: RoundContext) => Promise<RoundContext> | RoundContext;

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
export const historyCompressionMiddleware: BeforeRoundMiddleware = (ctx) => {
  // Within a tool loop, skip compression to keep history append-only for
  // prefix cache stability. Compression is deferred to the next user turn.
  if (ctx.round > 0) return ctx;

  const historyTokensBefore = estimateHistoryTokens(ctx.conversationHistory);
  if (historyTokensBefore <= CONVERSATION_HISTORY_BUDGET_TOKENS) {
    return ctx;
  }
  const compressed = compressToolLoopHistory(
    ctx.conversationHistory,
    undefined,
    ctx.priorTurnBoundary,
  );
  if (compressed > 0) {
    ctx.reliefAction = 'compact_history';
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
    ctx.reliefAction = stagedRelief.reliefAction;
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
    const bp2ToolDefTokens = await invoke<number>('estimate_tool_def_tokens', {
      provider: config.provider,
    });
    const lastUserIndex = conversationHistory.reduceRight(
      (acc, m, i) => (acc === -1 && m.role === 'user' ? i : acc),
      -1,
    );
    let bp3PriorTurnsTokens = 0;
    for (let j = 0; j < lastUserIndex; j++) {
      const m = conversationHistory[j];
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as Array<{ text?: string; content?: string; input?: unknown }>)
                .map((b) =>
                  b.text ??
                  (typeof b.content === 'string' ? b.content : JSON.stringify(b.input ?? '')),
                )
                .filter(Boolean)
                .join('\n')
            : JSON.stringify(m.content ?? '');
      bp3PriorTurnsTokens += estimateTokens(text);
    }
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
export const contextHygieneMiddleware: BeforeRoundMiddleware = (ctx) => {
  const roundCount = useAppStore.getState().promptMetrics.roundCount;
  if (roundCount < COMPACT_HISTORY_TURN_THRESHOLD) return ctx;

  const historyTokens = estimateHistoryTokens(ctx.conversationHistory);
  if (historyTokens <= COMPACT_HISTORY_TOKEN_THRESHOLD) return ctx;

  const compressed = compressToolLoopHistory(
    ctx.conversationHistory,
    undefined,
    ctx.priorTurnBoundary,
  );
  if (compressed > 0) {
    ctx.reliefAction = 'compact_history';
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

/** Run before-round middlewares in sequence. Mutates ctx. */
export async function runBeforeRoundMiddlewares(
  ctx: RoundContext,
  middlewares: BeforeRoundMiddleware[] = DEFAULT_BEFORE_ROUND_MIDDLEWARES,
): Promise<RoundContext> {
  let result = ctx;
  for (const mw of middlewares) {
    result = await mw(result);
    if (result.abortSignal?.aborted) break;
  }
  return result;
}
