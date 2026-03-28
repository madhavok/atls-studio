/**
 * History Compressor — compresses tool loop conversation history in-place.
 *
 * Large tool results and tool_use inputs are replaced with hash-pointer
 * references ([-> h:XXXX, Ntk | description]) to keep the conversation
 * lean across multi-round tool loops.
 *
 * Integrates with the Hash Pointer Protocol: compressed chunks are registered
 * as "referenced" in the protocol state machine so subsequent turns show
 * only the compact digest line in working memory.
 *
 * Extracted from aiService.ts to keep that file focused on orchestration.
 */

import { useContextStore } from '../stores/contextStore';
import { useAppStore } from '../stores/appStore';
import { formatChunkRef, estimateTokens, hashContentSync, SHORT_HASH_LEN } from '../utils/contextHash';
import { dematerialize, getRef } from './hashProtocol';
import {
  CONVERSATION_HISTORY_BUDGET_TOKENS,
  PROTECTED_RECENT_ROUNDS,
  ROLLING_WINDOW_ROUNDS,
  ROLLING_SUMMARY_MAX_TOKENS,
} from './promptMemory';
import {
  distillRound,
  emptyRollingSummary,
  formatSummaryMessage,
  isRollingSummaryEmpty,
  isRollingSummaryMessage,
  trimSummaryToTokenBudget,
  updateRollingSummary,
  type RollingSummary,
} from './historyDistiller';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Results smaller than this are kept inline (tokens) */
export const COMPRESSION_THRESHOLD_TOKENS = 1200;

/** Per-op overrides — ops whose output is needed immediately get higher limits.
 *  Derived from families: all system.* and verify.* ops get a higher threshold. */
import { OPERATION_FAMILIES } from './batch/families';

const HIGHER_THRESHOLD_FAMILIES = ['system', 'verify'] as const;
const HIGHER_THRESHOLD = 800;

export const TOOL_COMPRESSION_OVERRIDES: Record<string, number> = Object.fromEntries(
  HIGHER_THRESHOLD_FAMILIES.flatMap(f =>
    OPERATION_FAMILIES[f].ops.map(e => [e.op, HIGHER_THRESHOLD]),
  ),
);

export const HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS = 1000;

// ---------------------------------------------------------------------------
// Assistant round map (tool-loop rounds; rolling summary excluded)
// ---------------------------------------------------------------------------

const SYNTHETIC_AUTO_CONTINUE_PATTERNS = [
  'Your response was truncated',
  'You paused before finishing',
  'You are not ready to finish yet',
  'Continue working.',
];

/** True when a user message is a system-injected auto-continue prompt, not real user input. */
export function isSyntheticAutoContinue(msg: { role: string; content: unknown }): boolean {
  if (msg.role !== 'user') return false;
  const text = typeof msg.content === 'string' ? msg.content : '';
  return SYNTHETIC_AUTO_CONTINUE_PATTERNS.some(p => text.startsWith(p));
}

/**
 * Map message index -> assistant round index. Skips the API-only rolling summary message.
 */
export function buildAssistantRoundMap(
  history: Array<{ role: string; content: unknown }>,
  startIdx: number,
): Map<number, number> {
  let roundIndex = 0;
  const messageRounds = new Map<number, number>();
  for (let i = startIdx; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === 'assistant') {
      if (isRollingSummaryMessage(msg)) continue;
      messageRounds.set(i, roundIndex);
      if (i + 1 < history.length && history[i + 1].role === 'user') {
        messageRounds.set(i + 1, roundIndex);
      }
      roundIndex++;
    }
  }
  return messageRounds;
}

/**
 * Count substantive (non-synthetic) rounds in the history.
 * Auto-continue rounds triggered by the system are not counted toward
 * the rolling window threshold so they don't push real work out.
 */
export function countSubstantiveRounds(
  history: Array<{ role: string; content: unknown }>,
  messageRounds: Map<number, number>,
): number {
  const syntheticRoundIndices = new Set<number>();
  for (const [idx, roundIdx] of messageRounds) {
    if (isSyntheticAutoContinue(history[idx])) {
      syntheticRoundIndices.add(roundIdx);
    }
  }
  let maxR = -1;
  for (const r of messageRounds.values()) maxR = Math.max(maxR, r);
  return (maxR + 1) - syntheticRoundIndices.size;
}

function getLeadingOrphanUserIndices(
  history: Array<{ role: string; content: unknown }>,
  messageRounds: Map<number, number>,
  summaryAt: number,
): number[] {
  const orphans: number[] = [];
  if (!history[summaryAt] || !isRollingSummaryMessage(history[summaryAt])) return orphans;
  let i = summaryAt + 1;
  while (i < history.length && history[i].role === 'user' && !messageRounds.has(i)) {
    orphans.push(i);
    i++;
  }
  return orphans;
}

function syncRollingSummaryMessage(
  history: Array<{ role: string; content: unknown }>,
  summary: RollingSummary,
  insertAt: number,
): void {
  const trimmed = trimSummaryToTokenBudget(summary, ROLLING_SUMMARY_MAX_TOKENS);
  const ctx = useContextStore.getState();
  if (isRollingSummaryEmpty(trimmed)) {
    if (history[insertAt] && isRollingSummaryMessage(history[insertAt])) {
      history.splice(insertAt, 1);
    }
    ctx.setRollingSummary(emptyRollingSummary());
    return;
  }
  ctx.setRollingSummary(trimmed);
  const msg = formatSummaryMessage(trimmed);
  if (history[insertAt] && isRollingSummaryMessage(history[insertAt])) {
    history[insertAt] = msg;
  } else {
    history.splice(insertAt, 0, msg);
  }
}

/**
 * Remove oldest rounds into rolling summary; update context store + summary row at insertAt.
 */
function applyRollingHistoryWindow(
  history: Array<{ role: string; content: unknown }>,
  startIdx: number,
): void {
  const ctx = useContextStore.getState();
  const messageRounds = buildAssistantRoundMap(history, startIdx);
  let maxR = -1;
  for (const r of messageRounds.values()) maxR = Math.max(maxR, r);
  const totalRounds = maxR + 1;

  const summaryAt = startIdx;
  const orphans = getLeadingOrphanUserIndices(history, messageRounds, summaryAt);

  // Use substantive (non-synthetic) round count for the window threshold so
  // auto-continue rounds don't push real work out of the verbatim window.
  const substantiveRounds = countSubstantiveRounds(history, messageRounds);
  if (substantiveRounds <= ROLLING_WINDOW_ROUNDS) {
    syncRollingSummaryMessage(history, ctx.rollingSummary, summaryAt);
    removeOrphanedCompressedSummaries(history, startIdx);
    return;
  }

  let rolling: RollingSummary = {
    ...ctx.rollingSummary,
    decisions: [...ctx.rollingSummary.decisions],
    filesChanged: [...ctx.rollingSummary.filesChanged],
    userPreferences: [...ctx.rollingSummary.userPreferences],
    workDone: [...ctx.rollingSummary.workDone],
    findings: [...(ctx.rollingSummary.findings ?? [])],
    errors: [...ctx.rollingSummary.errors],
    currentGoal: ctx.rollingSummary.currentGoal || '',
    nextSteps: [...(ctx.rollingSummary.nextSteps ?? [])],
    blockers: [...(ctx.rollingSummary.blockers ?? [])],
  };

  // Evict oldest rounds to bring total back to ROLLING_WINDOW_ROUNDS.
  // The threshold check uses substantive count (excluding synthetic auto-continues)
  // but eviction uses totalRounds so the window stays bounded.
  const excess = totalRounds - ROLLING_WINDOW_ROUNDS;
  let tokensSaved = 0;

  for (let r = 0; r < excess; r++) {
    const roundIndices = [...messageRounds.entries()]
      .filter(([, rr]) => rr === r)
      .map(([i]) => i)
      .sort((a, b) => a - b);
    const extra = r === 0 ? orphans : [];
    const allIdx = [...new Set([...roundIndices, ...extra])].sort((a, b) => a - b);
    if (allIdx.length === 0) continue;
    const slice = allIdx.map((i) => history[i]);
    tokensSaved += estimateHistoryTokens(slice);
    rolling = updateRollingSummary(rolling, distillRound(slice));
  }

  const removeSet = new Set<number>();
  for (const [idx, rr] of messageRounds) {
    if (rr < excess) removeSet.add(idx);
  }
  if (excess > 0) {
    for (const o of orphans) removeSet.add(o);
  }

  for (const idx of [...removeSet].sort((a, b) => b - a)) {
    history.splice(idx, 1);
  }

  if (tokensSaved > 0) {
    useAppStore.getState().addRollingSavings(tokensSaved, excess);
  }
  syncRollingSummaryMessage(history, rolling, summaryAt);
  removeOrphanedCompressedSummaries(history, startIdx);
}

/**
 * Remove stale compressed rolling summaries — old summaries that were replaced
 * then compressed into `[-> h:... | ...[Rolling Summary]...]` pointers.
 * These are invisible to `isRollingSummaryMessage` and accumulate indefinitely.
 */
function removeOrphanedCompressedSummaries(
  history: Array<{ role: string; content: unknown }>,
  startIdx: number,
): number {
  let removed = 0;
  for (let i = history.length - 1; i >= startIdx; i--) {
    const msg = history[i];
    if (isRollingSummaryMessage(msg)) continue;
    if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue;
    if (msg.content.startsWith('[->') && msg.content.includes('[Rolling Summary]')) {
      history.splice(i, 1);
      removed++;
    }
  }
  if (removed > 0) useAppStore.getState().addOrphanRemovals(removed);
  return removed;
}

/**
 * Build a descriptive label for a compressed tool result.
 * Walks backwards through history to find the paired tool_use block.
 */
export function buildCompressionDescription(
  toolUseId: string,
  history: Array<{ role: string; content: unknown }>,
): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const blocks = msg.content as Array<{
      type: string; id?: string; name?: string; input?: Record<string, unknown>;
    }>;
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.id === toolUseId) {
        return extractToolDescription(block.name || 'unknown', block.input || {});
      }
    }
  }
  return 'tool_result';
}

/** Extract a human-readable description from a tool call for compression labels. */
export function extractToolDescription(
  name: string,
  input: Record<string, unknown>,
): string {
  if (name === 'batch') {
    const steps = input.steps as Array<{ use?: string; with?: Record<string, unknown> }> | undefined;
    if (Array.isArray(steps) && steps.length > 0) {
      const first = steps[0];
      const stepName = first.use || 'batch';
      const w = first.with || {};
      const stepArg =
        (w.file_paths as string[])?.[0] ||
        (w.file_path as string) ||
        String(w.cmd || '') ||
        (w.queries as string[])?.[0] ||
        String(w.action || '') ||
        (w.symbol_names as string[])?.[0] ||
        String(w.query || '') ||
        '';
      const suffix = steps.length > 1 ? ` +${steps.length - 1}` : '';
      return stepArg ? `${stepName}:${String(stepArg).slice(0, 60)}${suffix}` : `${stepName}${suffix}`;
    }
  }
  const params = input as Record<string, unknown>;
  const primaryArg =
    (params.path as string) ||
    (params.file_paths as string[])?.[0] ||
    (params.cmd as string) ||
    (params.queries as string[])?.[0] ||
    (params.query as string) ||
    '';
  return primaryArg ? `${name}:${String(primaryArg).slice(0, 60)}` : name;
}

// ---------------------------------------------------------------------------
// Compressor
// ---------------------------------------------------------------------------

/**
 * Find any existing chunk whose source matches the description (any type).
 * Used by eager deflation to match engrams created by batch handlers that
 * may use types like 'smart', 'raw', 'file' rather than 'result'.
 */
function looksLikeFilePath(s: string): boolean {
  return /^[\w./-]/.test(s) && (s.includes('/') || s.includes('\\')) && /\.\w+/.test(s);
}

function findExistingChunkBySource(
  store: ReturnType<typeof useContextStore.getState>,
  description: string,
): { hash: string; shortHash: string; digest?: string } | null {
  const descNorm = description.toLowerCase();
  let best: { hash: string; shortHash: string; digest?: string; compacted: boolean; lastAccessed: number } | null = null;
  for (const [, chunk] of store.chunks) {
    if (!chunk.source || chunk.source.toLowerCase() !== descNorm) continue;

    // Revision guard: skip stale engrams whose source file has changed
    if (chunk.sourceRevision && chunk.source && looksLikeFilePath(chunk.source)) {
      const awareness = store.getAwareness(chunk.source);
      if (awareness?.snapshotHash && awareness.snapshotHash !== chunk.sourceRevision) {
        continue;
      }
    }

    if (!best
        || (!chunk.compacted && best.compacted)
        || (chunk.compacted === best.compacted && chunk.lastAccessed > best.lastAccessed)) {
      best = { hash: chunk.hash, shortHash: chunk.shortHash, digest: chunk.digest, compacted: !!chunk.compacted, lastAccessed: chunk.lastAccessed };
    }
  }
  return best ? { hash: best.hash, shortHash: best.shortHash, digest: best.digest } : null;
}

/**
 * Compress tool loop conversation history IN-PLACE.
 *
 * - Replaces large tool_result content with hash-pointer references
 * - Replaces large tool_use input objects with compressed references
 * - Skips recent rounds (currentRound - 1 and current) to preserve immediate context
 * - NEVER mutates messages before priorTurnBoundary (protects BP3 cache prefix)
 * - Registers compressed chunks in the HPP state machine as "referenced"
 *
 * @returns Number of results compressed
 */
export function compressToolLoopHistory(
  history: Array<{ role: string; content: unknown }>,
  currentRound?: number,
  priorTurnBoundary?: number,
  opts?: { emergency?: boolean },
): number {
  const contextStore = useContextStore.getState();
  let compressedCount = 0;
  let totalSavedTokens = 0;
  const startIdx = priorTurnBoundary ?? 0;

  applyRollingHistoryWindow(history, startIdx);

  const messageRounds = buildAssistantRoundMap(history, startIdx);

  const protectedCount = opts?.emergency ? 0 : PROTECTED_RECENT_ROUNDS;
  let maxSurvivingRound = -1;
  for (const r of messageRounds.values()) maxSurvivingRound = Math.max(maxSurvivingRound, r);
  const numRounds = maxSurvivingRound + 1;

  // Round guard: skip compressing messages in assistant rounds >= skipThreshold.
  // - emergency: compress every round (subject to token thresholds).
  // - explicit currentRound (tests, emergency path): align with analyzeHistoryBreakdown
  //   — protect the last `protectedCount` rounds relative to that counter.
  // - undefined currentRound (e.g. middleware): derive from history length only — protect
  //   the last `protectedCount` rounds in the slice; if the slice has ≤ that many rounds,
  //   all rounds are protected (skipThreshold 0).
  const skipThreshold = (() => {
    if (opts?.emergency) return Infinity;
    if (currentRound !== undefined) {
      return Math.max(0, currentRound - protectedCount);
    }
    return numRounds > protectedCount
      ? Math.max(0, numRounds - protectedCount)
      : 0;
  })();

  const recordReplacement = (content: string, role: string, description: string): string => {
    const tokens = estimateTokens(content);
    const existingByDesc = findExistingChunkBySource(contextStore, description);
    if (existingByDesc) {
      dematerialize(existingByDesc.hash);
      return formatChunkRef(existingByDesc.shortHash, tokens, undefined, description, existingByDesc.digest);
    }
    const chunkType = role === 'assistant' ? 'msg:asst' : 'msg:user';
    const hash = contextStore.addChunk(content, chunkType, description, undefined, `history: ${description}`);
    const shortHash = hash.slice(0, SHORT_HASH_LEN);
    const chunk = contextStore.chunks.get(hash);
    dematerialize(hash);
    return formatChunkRef(shortHash, tokens, undefined, description, chunk?.digest);
  };

  for (let i = startIdx; i < history.length; i++) {
    const msg = history[i];
    const msgRound = messageRounds.get(i) ?? -1;
    if (msgRound >= skipThreshold) continue;

    // Compress user messages containing tool_result arrays
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const toolResults = msg.content as Array<{
        type: string; tool_use_id: string; content: string;
      }>;
      if (toolResults.length === 0 || toolResults[0]?.type !== 'tool_result') continue;

      for (const tr of toolResults) {
        if (!tr.content || typeof tr.content !== 'string') continue;
        if (tr.content.startsWith('[->')) continue;

        const tokens = estimateTokens(tr.content);
        const description = buildCompressionDescription(tr.tool_use_id, history);
        const toolName = description.split(':')[0] || '';

        // Protocol-aware threshold: if the model already has this content
        // registered as a ref, compress more aggressively
        const existingRef = getRef(hashContentSync(tr.content));
        const baseThreshold = TOOL_COMPRESSION_OVERRIDES[toolName] ?? COMPRESSION_THRESHOLD_TOKENS;
        const threshold = existingRef ? Math.floor(baseThreshold * 0.6) : baseThreshold;

        if (tokens <= threshold) continue;

        // Dedupe: reuse an existing chunk for this content if one exists.
        // Phase 1: exact content-hash match (covers same-serialization cases).
        // Phase 2: source-string match across all chunk types (covers batch
        //   handlers that store as 'smart'/'raw' with a different source string).
        const contentHash = hashContentSync(tr.content);
        const byHash = contextStore.chunks.get(contentHash);
        const existing = byHash
          ? { hash: byHash.hash, shortHash: byHash.shortHash, digest: byHash.digest }
          : findExistingChunkBySource(contextStore, description);
        let hash: string;
        let shortHash: string;
        let chunkDigest: string | undefined;
        if (existing) {
          hash = existing.hash;
          shortHash = existing.shortHash;
          chunkDigest = existing.digest;
        } else {
          hash = contextStore.addChunk(tr.content, 'result', description, undefined, `result: ${description}`);
          shortHash = hash.slice(0, SHORT_HASH_LEN);
          chunkDigest = contextStore.chunks.get(hash)?.digest;
        }
        const ref = formatChunkRef(shortHash, tokens, undefined, description, chunkDigest);
        totalSavedTokens += tokens - estimateTokens(ref);
        tr.content = ref;
        compressedCount++;

        dematerialize(hash);
      }
    }

    // Compress assistant messages with large tool_use input fields
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<{
        type: string; name?: string; id?: string; input?: Record<string, unknown>;
      }>;
      for (const block of blocks) {
        if (block.type !== 'tool_use' || !block.input) continue;

        const inputStr = JSON.stringify(block.input);
        const inputTokens = estimateTokens(inputStr);
        if (inputTokens <= COMPRESSION_THRESHOLD_TOKENS) continue;

        const description = extractToolDescription(block.name || 'tool_use', block.input);
        const hash = contextStore.addChunk(inputStr, 'call', description, undefined, `call: ${description}`);
        const shortHash = hash.slice(0, SHORT_HASH_LEN);
        const chunk = contextStore.chunks.get(hash);
        const ref = formatChunkRef(shortHash, inputTokens, undefined, description, chunk?.digest);
        totalSavedTokens += inputTokens - estimateTokens(ref);
        block.input = { _compressed: ref } as any;
        compressedCount++;

        dematerialize(hash);
      }

      // Large assistant narrative in array-shaped messages (e.g. text + tool_use).
      for (const block of blocks) {
        if (block.type !== 'text') continue;
        const tb = block as { type: string; text?: string; content?: string };
        const raw =
          typeof tb.text === 'string'
            ? tb.text
            : typeof tb.content === 'string'
              ? tb.content
              : '';
        if (!raw || raw.startsWith('[->')) continue;
        const isStopped = raw.includes('[Stopped]');
        const tokens = estimateTokens(raw);
        if (!isStopped && tokens <= HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS) continue;
        const description = `history:assistant:${raw.slice(0, 60).replace(/\s+/g, ' ').trim()}`;
        const ref = recordReplacement(raw, 'assistant', description);
        totalSavedTokens += tokens - estimateTokens(ref);
        if (typeof tb.text === 'string') tb.text = ref;
        else if (typeof tb.content === 'string') tb.content = ref;
        compressedCount++;
      }
    }

    if (typeof msg.content === 'string') {
      if (isRollingSummaryMessage(msg)) continue;
      const isStopped = msg.role === 'assistant' && msg.content.includes('[Stopped]');
      const tokens = estimateTokens(msg.content);
      if (!isStopped && tokens <= HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS) continue;
      const description = `history:${msg.role}:${msg.content.slice(0, 60).replace(/\s+/g, ' ').trim()}`;
      const ref = recordReplacement(msg.content, msg.role, description);
      totalSavedTokens += tokens - estimateTokens(ref);
      msg.content = ref;
      compressedCount++;
    }
  }

  let estimatedHistoryTokens = estimateHistoryTokens(history.slice(startIdx));
  if (estimatedHistoryTokens > CONVERSATION_HISTORY_BUDGET_TOKENS) {
    for (let i = startIdx; i < history.length && estimatedHistoryTokens > CONVERSATION_HISTORY_BUDGET_TOKENS; i++) {
      const msg = history[i];
      const msgRound = messageRounds.get(i) ?? -1;
      if (msgRound >= skipThreshold) continue;
      if (typeof msg.content !== 'string' || msg.content.startsWith('[->')) continue;
      if (isRollingSummaryMessage(msg)) continue;
      const tokens = estimateTokens(msg.content);
      if (tokens <= 0) continue;
      const description = `history:${msg.role}:budget-relief`;
      const ref = recordReplacement(msg.content, msg.role, description);
      totalSavedTokens += tokens - estimateTokens(ref);
      msg.content = ref;
      compressedCount++;
      estimatedHistoryTokens = estimateHistoryTokens(history.slice(startIdx));
    }
  }

  if (compressedCount > 0 && totalSavedTokens > 0) {
    useAppStore.getState().addCompressionSavings(totalSavedTokens, compressedCount);
  }

  return compressedCount;
}

// ---------------------------------------------------------------------------
// Eager Deflation — replace tool_result content with pointers when the
// content already lives in the context store as an engram. Called immediately
// after batch execution so the engram is the single source of truth and
// history only carries a lightweight ref.
// ---------------------------------------------------------------------------

type ToolResultBlock = { type: string; tool_use_id: string; content: string; name?: string };

/**
 * Deflate tool_result entries in-place: if the content (or a chunk matching
 * the tool description) already exists in the context store, replace the
 * inline content with a hash-pointer ref.
 *
 * When no existing engram matches and the content exceeds the minimum
 * threshold, a new engram is created so the receipt is always written at
 * insertion time — history never carries large inline tool results.
 *
 * @returns number of tool_result entries deflated
 */
export function deflateToolResults(
  toolResults: ToolResultBlock[],
  history: Array<{ role: string; content: unknown }>,
): number {
  const store = useContextStore.getState();
  let deflated = 0;
  // Minimum size to create a new engram — tiny results ("ok", short errors)
  // are cheaper inline than as engram overhead.
  const MIN_DEFLATE_TOKENS = 60;

  for (const tr of toolResults) {
    if (!tr.content || typeof tr.content !== 'string') continue;
    if (tr.content.startsWith('[->')) continue;

    // Try content-hash match first (exact content already in store)
    const contentHash = hashContentSync(tr.content);
    let chunk = store.chunks.get(contentHash);
    if (chunk) {
      const ref = formatChunkRef(chunk.shortHash, chunk.tokens, undefined, chunk.source, chunk.digest);
      tr.content = ref;
      deflated++;
      continue;
    }

    // Fallback: match by tool description against any chunk type (handles
    // cases where the batch handler stored content under a backend-provided
    // hash or as a non-result chunk type like 'smart' or 'raw')
    const description = buildCompressionDescription(tr.tool_use_id, history);
    const existing = findExistingChunkBySource(store, description);
    if (existing) {
      const tokens = estimateTokens(tr.content);
      const ref = formatChunkRef(existing.shortHash, tokens, undefined, description, existing.digest);
      tr.content = ref;
      deflated++;
      continue;
    }

    // No existing engram — create one if content is large enough.
    // This closes the receipt gap: every tool result above threshold
    // becomes an engram at insertion time, so history always gets a
    // lightweight ref instead of inline content.
    const tokens = estimateTokens(tr.content);
    if (tokens >= MIN_DEFLATE_TOKENS) {
      const hash = store.addChunk(tr.content, 'result', description, undefined, `result: ${description}`);
      chunk = store.chunks.get(hash);
      if (chunk) {
        dematerialize(hash);
        const ref = formatChunkRef(chunk.shortHash, chunk.tokens, undefined, description, chunk.digest);
        tr.content = ref;
        deflated++;
      }
    }
  }

  if (deflated > 0) {
    useAppStore.getState().addCompressionSavings(0, deflated);
  }

  return deflated;
}
export function estimateHistoryTokens(history: Array<{ role: string; content: unknown }>): number {
  return history.reduce((sum, msg) => {
    if (typeof msg.content === 'string') return sum + estimateTokens(msg.content);
    if (Array.isArray(msg.content)) return sum + estimateTokens(JSON.stringify(msg.content));
    return sum;
  }, 0);
}

// ---------------------------------------------------------------------------
// History Breakdown Analysis
// ---------------------------------------------------------------------------

export interface HistoryBreakdown {
  total: number;
  /** Already-compressed hash refs ([-> h:XXXX, ...]) */
  compressed: number;
  /** Rolling summary assistant message ([Rolling Summary] ...) */
  rolled: number;
  /** tool_result blocks not yet compressed */
  toolResults: number;
  /** tool_use input blocks not yet compressed */
  toolUse: number;
  /** Assistant text messages (not tool blocks) */
  assistantText: number;
  /** User text messages (not tool_result blocks) */
  userText: number;
  /** Number of messages that are compressible (above threshold) */
  compressibleCount: number;
  /** Tokens in compressible messages */
  compressibleTokens: number;
  /** Tokens in compressible messages that sit inside the protected window (not actionable) */
  protectedTokens: number;
}

/**
 * Analyze history token distribution by category.
 * Returns a breakdown showing where tokens are spent and how much is compressible.
 * When `currentRound` is provided, also computes how many compressible tokens are
 * inside the protected window (not actionable by normal compression).
 */
export function analyzeHistoryBreakdown(
  history: Array<{ role: string; content: unknown }>,
  startIdx = 0,
  currentRound?: number,
): HistoryBreakdown {
  const breakdown: HistoryBreakdown = {
    total: 0, compressed: 0, rolled: 0, toolResults: 0, toolUse: 0,
    assistantText: 0, userText: 0, compressibleCount: 0, compressibleTokens: 0,
    protectedTokens: 0,
  };

  const messageRounds = currentRound !== undefined ? buildAssistantRoundMap(history, startIdx) : undefined;
  const skipThreshold = currentRound !== undefined ? Math.max(0, currentRound - PROTECTED_RECENT_ROUNDS) : -1;

  for (let i = startIdx; i < history.length; i++) {
    const msg = history[i];
    const isProtected = messageRounds ? (messageRounds.get(i) ?? -1) >= skipThreshold : false;

    if (typeof msg.content === 'string') {
      const tokens = estimateTokens(msg.content);
      breakdown.total += tokens;
      if (msg.role === 'assistant' && isRollingSummaryMessage(msg)) {
        breakdown.rolled += tokens;
        continue;
      }
      if (msg.content.startsWith('[->')) {
        breakdown.compressed += tokens;
      } else if (msg.role === 'assistant') {
        breakdown.assistantText += tokens;
        if (tokens > HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS) {
          breakdown.compressibleCount++;
          breakdown.compressibleTokens += tokens;
          if (isProtected) breakdown.protectedTokens += tokens;
        }
      } else {
        breakdown.userText += tokens;
        if (tokens > HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS) {
          breakdown.compressibleCount++;
          breakdown.compressibleTokens += tokens;
          if (isProtected) breakdown.protectedTokens += tokens;
        }
      }
      continue;
    }

    if (Array.isArray(msg.content)) {
      const blocks = msg.content as Array<{ type: string; content?: string; input?: Record<string, unknown> }>;
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          const tokens = estimateTokens(content);
          breakdown.total += tokens;
          if (content.startsWith('[->')) {
            breakdown.compressed += tokens;
          } else {
            breakdown.toolResults += tokens;
            if (tokens > COMPRESSION_THRESHOLD_TOKENS) {
              breakdown.compressibleCount++;
              breakdown.compressibleTokens += tokens;
              if (isProtected) breakdown.protectedTokens += tokens;
            }
          }
        } else if (block.type === 'tool_use' && block.input) {
          const inputStr = JSON.stringify(block.input);
          const tokens = estimateTokens(inputStr);
          breakdown.total += tokens;
          if (inputStr.includes('"_compressed"')) {
            breakdown.compressed += tokens;
          } else {
            breakdown.toolUse += tokens;
            if (tokens > COMPRESSION_THRESHOLD_TOKENS) {
              breakdown.compressibleCount++;
              breakdown.compressibleTokens += tokens;
              if (isProtected) breakdown.protectedTokens += tokens;
            }
          }
        } else {
          // text blocks in assistant messages — check both .text and .content (Anthropic uses .text)
          const tb = block as { type: string; text?: string; content?: string };
          const text = typeof tb.text === 'string' ? tb.text
            : typeof tb.content === 'string' ? tb.content
            : JSON.stringify(block);
          const tokens = estimateTokens(text);
          breakdown.total += tokens;
          if (text.startsWith('[->')) {
            breakdown.compressed += tokens;
          } else {
            breakdown.assistantText += tokens;
          }
        }
      }
    }
  }

  return breakdown;
}

/**
 * Format a breakdown into a compact string for the model's CTX line.
 * Only includes non-zero categories.
 */
export function formatHistoryBreakdown(b: HistoryBreakdown): string {
  const parts: string[] = [];
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
  if (b.assistantText > 0) parts.push(`chat:${k(b.assistantText)}`);
  if (b.userText > 0) parts.push(`user:${k(b.userText)}`);
  if (b.toolResults > 0) parts.push(`results:${k(b.toolResults)}`);
  if (b.toolUse > 0) parts.push(`calls:${k(b.toolUse)}`);
  if (b.compressed > 0) parts.push(`refs:${k(b.compressed)}`);
  if (b.rolled > 0) parts.push(`rolled:${k(b.rolled)}`);
  if (b.protectedTokens > 0) parts.push(`protected:${k(b.protectedTokens)}`);
  return parts.join(' ');
}
