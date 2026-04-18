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
import { formatChunkRef, hashContentSync, isCompressedRef, SHORT_HASH_LEN } from '../utils/contextHash';
import { countTokensSync, countTokensBatch } from '../utils/tokenCounter';
import { serializeForTokenEstimate, serializeMessageContentForTokens } from '../utils/toon';
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

/** Results smaller than this are kept inline (tokens).
 *  Low threshold: the model gets one round to see full results, then they deflate. */
export const COMPRESSION_THRESHOLD_TOKENS = 100;

/** Per-op overrides — ops whose output is needed immediately get higher limits.
 *  Derived from families: all system.* and verify.* ops get a higher threshold. */
import { OPERATION_FAMILIES } from './batch/families';

const HIGHER_THRESHOLD_FAMILIES = ['system', 'verify'] as const;
const HIGHER_THRESHOLD = 200;

export const TOOL_COMPRESSION_OVERRIDES: Record<string, number> = Object.fromEntries(
  HIGHER_THRESHOLD_FAMILIES.flatMap(f =>
    OPERATION_FAMILIES[f].ops.map(e => [e.op, HIGHER_THRESHOLD]),
  ),
);

export const HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS = 100;

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

  // Verify tool pairing integrity after splicing — if an assistant with
  // tool_use blocks lost its paired user message, re-insert a synthetic one
  // so downstream repairAnthropicToolPairing doesn't see orphaned tool_use.
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const toolUseIds = (msg.content as Array<{ type?: string; id?: string }>)
      .filter(b => b.type === 'tool_use' && b.id)
      .map(b => b.id!);
    if (toolUseIds.length === 0) continue;
    const next = history[i + 1];
    if (next?.role !== 'user' || !Array.isArray(next.content)) {
      history.splice(i + 1, 0, {
        role: 'user',
        content: toolUseIds.map(id => ({ type: 'tool_result', tool_use_id: id, content: '[compressed — round evicted]' })),
      });
    }
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
    if (isCompressedRef(msg.content) && msg.content.includes('[Rolling Summary]')) {
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
  const genericStub = input._stubbed;
  if (typeof genericStub === 'string' && genericStub.length > 0) {
    return `${name}:${genericStub.slice(0, 140)}`;
  }
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
  // G21: use a getter so chunk lookups always see post-addChunk state
  const getCtx = () => useContextStore.getState();
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
    const tokens = countTokensSync(content);
    const existingByDesc = findExistingChunkBySource(getCtx(), description);
    if (existingByDesc) {
      dematerialize(existingByDesc.hash);
      return formatChunkRef(existingByDesc.shortHash, tokens, undefined, description, existingByDesc.digest);
    }
    const chunkType = role === 'assistant' ? 'msg:asst' : 'msg:user';
    const hash = getCtx().addChunk(content, chunkType, description, undefined, `history: ${description}`);
    const shortHash = hash.slice(0, SHORT_HASH_LEN);
    const chunk = getCtx().chunks.get(hash);
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
        if (isCompressedRef(tr.content)) continue;

        // Preserve inline history for pinned content so the model retains
        // full conversational context around its most important engrams.
        const pinnedCheckHash = hashContentSync(tr.content);
        const pinnedChunk = getCtx().chunks.get(pinnedCheckHash);
        if (pinnedChunk?.pinned) continue;

        const tokens = countTokensSync(tr.content);
        const description = buildCompressionDescription(tr.tool_use_id, history);
        const toolName = description.split(':')[0] || '';

        // Protocol-aware threshold: if the model already has this content
        // registered as a ref, compress more aggressively
        const existingRef = getRef(hashContentSync(tr.content));
        let baseThreshold = TOOL_COMPRESSION_OVERRIDES[toolName] ?? COMPRESSION_THRESHOLD_TOKENS;
        if (toolName === 'batch' && toolResultTextLooksLikeChangePreview(tr.content)) {
          baseThreshold = Math.max(baseThreshold, CHANGE_PREVIEW_RESULT_THRESHOLD_FLOOR);
        }
        const threshold = existingRef ? Math.floor(baseThreshold * 0.6) : baseThreshold;

        if (tokens <= threshold) continue;

        // Dedupe: reuse an existing chunk for this content if one exists.
        // Phase 1: exact content-hash match (covers same-serialization cases).
        // Phase 2: source-string match across all chunk types (covers batch
        //   handlers that store as 'smart'/'raw' with a different source string).
        const contentHash = hashContentSync(tr.content);
        const byHash = getCtx().chunks.get(contentHash);
        const existing = byHash
          ? { hash: byHash.hash, shortHash: byHash.shortHash, digest: byHash.digest }
          : findExistingChunkBySource(getCtx(), description);
        let hash: string;
        let shortHash: string;
        let chunkDigest: string | undefined;
        if (existing) {
          hash = existing.hash;
          shortHash = existing.shortHash;
          chunkDigest = existing.digest;
        } else {
          hash = getCtx().addChunk(tr.content, 'result', description, undefined, `result: ${description}`);
          shortHash = hash.slice(0, SHORT_HASH_LEN);
          chunkDigest = getCtx().chunks.get(hash)?.digest;
        }
        const ref = formatChunkRef(shortHash, tokens, undefined, description, chunkDigest);
        totalSavedTokens += tokens - countTokensSync(ref);
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

        const inputStr = serializeForTokenEstimate(block.input);
        const inputTokens = countTokensSync(inputStr);
        if (inputTokens <= COMPRESSION_THRESHOLD_TOKENS) continue;

        const description = extractToolDescription(block.name || 'tool_use', block.input);
        const hash = getCtx().addChunk(inputStr, 'call', description, undefined, `call: ${description}`);
        const shortHash = hash.slice(0, SHORT_HASH_LEN);
        const chunk = getCtx().chunks.get(hash);
        const ref = formatChunkRef(shortHash, inputTokens, undefined, description, chunk?.digest);
        totalSavedTokens += inputTokens - countTokensSync(ref);
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
        if (!raw || isCompressedRef(raw)) continue;
        const isStopped = raw.includes('[Stopped]');
        const tokens = countTokensSync(raw);
        if (!isStopped && tokens <= HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS) continue;
        const description = `history:assistant:${raw.slice(0, 60).replace(/\s+/g, ' ').trim()}`;
        const ref = recordReplacement(raw, 'assistant', description);
        totalSavedTokens += tokens - countTokensSync(ref);
        if (typeof tb.text === 'string') tb.text = ref;
        else if (typeof tb.content === 'string') tb.content = ref;
        compressedCount++;
      }
    }

    if (typeof msg.content === 'string') {
      if (isRollingSummaryMessage(msg)) continue;
      const isStopped = msg.role === 'assistant' && msg.content.includes('[Stopped]');
      const tokens = countTokensSync(msg.content);
      if (!isStopped && tokens <= HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS) continue;
      const description = `history:${msg.role}:${msg.content.slice(0, 60).replace(/\s+/g, ' ').trim()}`;
      const ref = recordReplacement(msg.content, msg.role, description);
      totalSavedTokens += tokens - countTokensSync(ref);
      msg.content = ref;
      compressedCount++;
    }
  }

  let estimatedHistoryTk = estimateHistoryTokens(history.slice(startIdx));
  if (estimatedHistoryTk > CONVERSATION_HISTORY_BUDGET_TOKENS) {
    for (let i = startIdx; i < history.length && estimatedHistoryTk > CONVERSATION_HISTORY_BUDGET_TOKENS; i++) {
      const msg = history[i];
      const msgRound = messageRounds.get(i) ?? -1;
      if (msgRound >= skipThreshold) continue;
      if (typeof msg.content !== 'string' || isCompressedRef(msg.content)) continue;
      if (isRollingSummaryMessage(msg)) continue;
      const tokens = countTokensSync(msg.content);
      if (tokens <= 0) continue;
      const description = `history:${msg.role}:budget-relief`;
      const ref = recordReplacement(msg.content, msg.role, description);
      totalSavedTokens += tokens - countTokensSync(ref);
      msg.content = ref;
      compressedCount++;
      estimatedHistoryTk = estimateHistoryTokens(history.slice(startIdx));
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

// ---------------------------------------------------------------------------
// Batch tool_use input stubbing — replaces full step arrays with compact
// summaries since the results (which get deflated separately) are the
// canonical record. Runs eagerly alongside deflateToolResults.
// ---------------------------------------------------------------------------

/** Minimum tokens in a batch input before it's worth stubbing. */
const BATCH_INPUT_STUB_THRESHOLD = 80;

/** Extra headroom before compressing batch tool_result text that looks like a change preview (dry_run). */
const CHANGE_PREVIEW_RESULT_THRESHOLD_FLOOR = 280;

function toolResultTextLooksLikeChangePreview(content: string): boolean {
  if (content.length < 24) return false;
  const dry = /"dry_run"\s*:\s*(true|1)\b|"dry_run"\s*:\s*true|dry_run:\s*1\b/i.test(content);
  const preview = /status:\s*preview|"status"\s*:\s*"preview"/i.test(content)
    || (content.includes('_next') && /dry_run:\s*false/i.test(content));
  if (!dry && !preview) return false;
  return /\bchange\.\w+/.test(content) || content.includes('split_module');
}

/**
 * True if any change.* step was a dry-run / preview (not written to disk).
 * Kept in stub text so history compression does not erase "was preview" after steps are stripped.
 */
function batchHasChangePreviewStep(steps: Array<Record<string, unknown>>): boolean {
  for (const step of steps) {
    const use = String(step.use || '');
    if (!use.startsWith('change.')) continue;
    const w = (step.with || {}) as Record<string, unknown>;
    if (w.dry_run === true || w.dry_run === 1) return true;
  }
  return false;
}

/**
 * Compact summary for stubbed batch `steps` (main agent + subagent).
 * Appends `| change:preview(dry_run)` when any change.* step has with.dry_run so
 * compression labels keep preview intent after `_stubbed` replaces steps.
 */
export function formatBatchToolUseStubSummary(steps: Array<Record<string, unknown>>): string {
  const counts = new Map<string, number>();
  for (const step of steps) {
    const op = String(step.use || 'unknown');
    const family = op.split('.')[0];
    counts.set(family, (counts.get(family) || 0) + 1);
  }
  const parts = [...counts.entries()].map(([f, n]) => `${f}×${n}`);
  let s = `${steps.length} steps: ${parts.join(', ')}`;
  if (batchHasChangePreviewStep(steps)) {
    s += ' | change:preview(dry_run)';
  }
  return s;
}

/**
 * Stub batch tool_use inputs in the most recent assistant message.
 * Replaces full `steps` arrays with a compact summary string.
 * Call immediately after pushing the assistant message to history,
 * before deflateToolResults processes the paired tool_result blocks.
 *
 * @returns number of tool_use inputs stubbed
 */
export function stubBatchToolUseInputs(
  history: Array<{ role: string; content: unknown }>,
): number {
  let stubbed = 0;
  let lastAssistant: { role: string; content: unknown } | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') { lastAssistant = history[i]; break; }
  }
  if (!lastAssistant || !Array.isArray(lastAssistant.content)) return 0;

  const blocks = lastAssistant.content as Array<{
    type: string; name?: string; id?: string; input?: Record<string, unknown>;
  }>;

  for (const block of blocks) {
    if (block.type !== 'tool_use' || !block.input) continue;
    if ((block.input as any)._stubbed) continue;

    const steps = block.input.steps;
    if (!Array.isArray(steps) || steps.length === 0) continue;

    const inputStr = serializeForTokenEstimate(block.input);
    const inputTokens = countTokensSync(inputStr);
    if (inputTokens < BATCH_INPUT_STUB_THRESHOLD) continue;

    const stub = formatBatchToolUseStubSummary(steps as Array<Record<string, unknown>>);
    block.input = {
      _stubbed: stub,
      version: block.input.version ?? '1.0',
    } as any;
    stubbed++;
  }

  return stubbed;
}

// ---------------------------------------------------------------------------
// Retention-op compaction — strips specific hash args and verbose success text
// from pin/unpin/drop/unload/compact/bb.delete calls so they don't leave a
// ghost-ref trail in history after the round ends. The current hash manifest
// is the authoritative source of pin/drop state; the tool_use args and the
// per-step "unpinned 3 chunks" lines are narrative evidence only.
// ---------------------------------------------------------------------------

/** Ops whose effect is fully captured in the current hash manifest / BB.
 *  Their specific refs and success metrics are redundant after the round ends. */
const RETENTION_OPS: ReadonlySet<string> = new Set([
  'session.pin',
  'session.unpin',
  'session.drop',
  'session.unload',
  'session.compact',
  'session.bb.delete',
]);

/** Count of refs the retention step was acting on — used for the count-only stub. */
function countRetentionArgs(withParams: Record<string, unknown> | undefined): number {
  if (!withParams) return 0;
  const hashes = withParams.hashes;
  if (Array.isArray(hashes)) return hashes.length;
  if (typeof hashes === 'string' && hashes.length > 0) return 1;
  const keys = withParams.keys;
  if (Array.isArray(keys)) return keys.length;
  if (typeof keys === 'string' && keys.length > 0) return 1;
  return 0;
}

/** Per-step batch result line: `[OK|FAIL] <id> (<op>): <tail>` */
const BATCH_RESULT_LINE_RE = /^\[(OK|FAIL)\]\s+(\S+)\s+\((\S+)\):\s+(.+)$/;

/**
 * Compact retention-op calls in the last tool-loop round:
 *  - tool_use (batch): replace retention steps' args with count-only stubs (`{n:3}`)
 *    and drop any `step.in` dataflow reference (also a ghost-ref vector).
 *  - tool_result (batch): collapse OK per-step lines for retention ops to `ok`,
 *    stripping "unpinned N chunks (Xms)" / "dropped: [h:…]" tails.
 *
 * Failures (`[FAIL]` lines) are preserved verbatim — the error text carries
 * debuggable signal. Non-retention ops are untouched — their tool_result is
 * the payload (handled by `deflateToolResults`).
 *
 * Runs at turn-finalize before the turn joins the cacheable BP3 prefix, so
 * subsequent rounds see the compacted form and the prefix stays byte-stable
 * (no retroactive rewrite of cached history).
 *
 * Idempotent: second run sees `_compacted` on steps and `: ok$` lines and
 * short-circuits.
 *
 * @returns counts of compacted steps and result lines for telemetry
 */
export function compactRetentionOps(
  history: Array<{ role: string; content: unknown }>,
  toolResults: ToolResultBlock[],
): { stepsCompacted: number; resultLinesCompacted: number } {
  const stats = { stepsCompacted: 0, resultLinesCompacted: 0 };

  // --- 1. Compact tool_use step args in the last assistant message ---
  let lastAssistant: { role: string; content: unknown } | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') { lastAssistant = history[i]; break; }
  }
  if (lastAssistant && Array.isArray(lastAssistant.content)) {
    const blocks = lastAssistant.content as Array<{
      type: string; id?: string; input?: Record<string, unknown>;
    }>;
    for (const block of blocks) {
      if (block.type !== 'tool_use' || !block.input) continue;
      const steps = block.input.steps;
      if (!Array.isArray(steps)) continue; // e.g. stubBatchToolUseInputs already replaced with `_stubbed`
      for (const rawStep of steps as Array<Record<string, unknown>>) {
        if (rawStep._compacted === true) continue;
        const use = typeof rawStep.use === 'string' ? rawStep.use : '';
        if (!RETENTION_OPS.has(use)) continue;
        const n = countRetentionArgs(rawStep.with as Record<string, unknown> | undefined);
        // Skip scope-based ops with no refs to redact (e.g. session.drop {scope:'archived', max:25}).
        // They carry no ghost-ref surface; stripping wouldn't help and would lose structural info.
        if (n === 0 && rawStep.in === undefined) continue;
        rawStep.with = { n };
        if (rawStep.in !== undefined) delete rawStep.in;
        rawStep._compacted = true;
        stats.stepsCompacted++;
      }
    }
  }

  // --- 2. Compact tool_result per-step OK lines for retention ops ---
  for (const tr of toolResults) {
    if (!tr.content || typeof tr.content !== 'string') continue;
    const lines = tr.content.split('\n');
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const m = BATCH_RESULT_LINE_RE.exec(lines[i]);
      if (!m) continue;
      const [, status, id, op, tail] = m;
      if (status !== 'OK') continue;          // FAIL text is diagnostic — preserve
      if (!RETENTION_OPS.has(op)) continue;   // deflateToolResults owns these
      if (tail === 'ok') continue;            // already compacted
      lines[i] = `[OK] ${id} (${op}): ok`;
      changed = true;
      stats.resultLinesCompacted++;
    }
    if (changed) tr.content = lines.join('\n');
  }

  return stats;
}

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
  let deflated = 0;
  // Minimum size to create a new engram — only trivially short results stay inline.
  const MIN_DEFLATE_TOKENS = 30;

  for (const tr of toolResults) {
    if (!tr.content || typeof tr.content !== 'string') continue;
    if (isCompressedRef(tr.content)) continue;

    // Fresh store each iteration — addChunk updates Zustand; a snapshot from
    // the start of this function would leave chunks stale for .get after insert.
    const store = useContextStore.getState();

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
    // No paired tool_use in history → do not match by vague label (would alias many results).
    if (description === 'tool_result') {
      const tokens = countTokensSync(tr.content);
      if (tokens >= MIN_DEFLATE_TOKENS) {
        store.addChunk(tr.content, 'result', `result:${tr.tool_use_id}`, undefined, `result: ${tr.tool_use_id}`);
        const newChunk = useContextStore.getState().chunks.get(contentHash);
        if (newChunk) {
          dematerialize(contentHash);
          tr.content = formatChunkRef(newChunk.shortHash, newChunk.tokens, undefined, `result:${tr.tool_use_id}`, newChunk.digest);
          deflated++;
        }
      }
      continue;
    }
    const existing = findExistingChunkBySource(store, description);
    if (existing) {
      const tokens = countTokensSync(tr.content);
      const ref = formatChunkRef(existing.shortHash, tokens, undefined, description, existing.digest);
      tr.content = ref;
      deflated++;
      continue;
    }

    // No existing engram — create one if content is large enough.
    // This closes the receipt gap: every tool result above threshold
    // becomes an engram at insertion time, so history always gets a
    // lightweight ref instead of inline content.
    const tokens = countTokensSync(tr.content);
    if (tokens >= MIN_DEFLATE_TOKENS) {
      store.addChunk(tr.content, 'result', description, undefined, `result: ${description}`);
      chunk = useContextStore.getState().chunks.get(contentHash);
      if (chunk) {
        dematerialize(contentHash);
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
    if (typeof msg.content === 'string') return sum + countTokensSync(msg.content);
    if (Array.isArray(msg.content)) {
      return sum + countTokensSync(serializeMessageContentForTokens(msg.content));
    }
    return sum;
  }, 0);
}

/**
 * Async variant using real provider-specific tokenizer via Tauri IPC.
 * Results are cached in the LRU so subsequent sync calls via countTokensSync hit warm cache.
 */
export async function estimateHistoryTokensAsync(history: Array<{ role: string; content: unknown }>): Promise<number> {
  const contents: string[] = [];
  const indices: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (typeof msg.content === 'string') {
      contents.push(msg.content);
      indices.push(i);
    } else if (Array.isArray(msg.content)) {
      contents.push(serializeMessageContentForTokens(msg.content));
      indices.push(i);
    }
  }
  if (contents.length === 0) return 0;
  const counts = await countTokensBatch(contents);
  return counts.reduce((a, b) => a + b, 0);
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
      const tokens = countTokensSync(msg.content);
      breakdown.total += tokens;
      if (msg.role === 'assistant' && isRollingSummaryMessage(msg)) {
        breakdown.rolled += tokens;
        continue;
      }
      if (isCompressedRef(msg.content)) {
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
          const content = typeof block.content === 'string' ? block.content : serializeForTokenEstimate(block.content);
          const tokens = countTokensSync(content);
          breakdown.total += tokens;
          if (isCompressedRef(content)) {
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
          const inputStr = serializeForTokenEstimate(block.input);
          const tokens = countTokensSync(inputStr);
          breakdown.total += tokens;
          if (inputStr.includes('_compressed')) {
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
          const tb = block as { type: string; text?: string; content?: string };
          const text = typeof tb.text === 'string' ? tb.text
            : typeof tb.content === 'string' ? tb.content
            : serializeForTokenEstimate(block);
          const tokens = countTokensSync(text);
          breakdown.total += tokens;
          if (isCompressedRef(text)) {
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
