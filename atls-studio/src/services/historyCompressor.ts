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
import { CONVERSATION_HISTORY_BUDGET_TOKENS, PROTECTED_RECENT_ROUNDS } from './promptMemory';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Results smaller than this are kept inline (tokens) */
export const COMPRESSION_THRESHOLD_TOKENS = 500;

/** Per-tool overrides — tools whose output is needed immediately get higher limits */
export const TOOL_COMPRESSION_OVERRIDES: Record<string, number> = {
  exec: 800,
  verify: 800,
  git: 800,
};

export const HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS = 350;

// ---------------------------------------------------------------------------
// Description Extraction
// ---------------------------------------------------------------------------

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
function findExistingChunkBySource(
  store: ReturnType<typeof useContextStore.getState>,
  description: string,
): { hash: string; shortHash: string; digest?: string } | null {
  const descNorm = description.toLowerCase();
  for (const [, chunk] of store.chunks) {
    if (chunk.source && chunk.source.toLowerCase() === descNorm) {
      return { hash: chunk.hash, shortHash: chunk.shortHash, digest: chunk.digest };
    }
  }
  return null;
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
): number {
  const contextStore = useContextStore.getState();
  let compressedCount = 0;
  let totalSavedTokens = 0;
  const startIdx = priorTurnBoundary ?? 0;

  // Assign round numbers to assistant/user pairs in the tool loop
  let roundIndex = 0;
  const messageRounds = new Map<number, number>();
  for (let i = startIdx; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === 'assistant') {
      messageRounds.set(i, roundIndex);
      if (i + 1 < history.length && history[i + 1].role === 'user') {
        messageRounds.set(i + 1, roundIndex);
      }
      roundIndex++;
    }
  }

  const skipThreshold = currentRound !== undefined ? Math.max(0, currentRound - PROTECTED_RECENT_ROUNDS) : Infinity;

  const recordReplacement = (content: string, role: string, description: string): string => {
    const chunkType = role === 'assistant' ? 'msg:asst' : 'msg:user';
    const tokens = estimateTokens(content);
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
    }

    if (typeof msg.content === 'string') {
      const tokens = estimateTokens(msg.content);
      if (tokens <= HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS) continue;
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
 * Unlike `compressToolLoopHistory`, this runs eagerly (no threshold / round
 * gating) and never creates new chunks — it only references existing ones.
 *
 * @returns number of tool_result entries deflated
 */
export function deflateToolResults(
  toolResults: ToolResultBlock[],
  history: Array<{ role: string; content: unknown }>,
): number {
  const store = useContextStore.getState();
  let deflated = 0;

  for (const tr of toolResults) {
    if (!tr.content || typeof tr.content !== 'string') continue;
    if (tr.content.startsWith('[->')) continue;

    // Try content-hash match first (exact content already in store)
    const contentHash = hashContentSync(tr.content);
    const chunk = store.chunks.get(contentHash);
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
}

/**
 * Analyze history token distribution by category.
 * Returns a breakdown showing where tokens are spent and how much is compressible.
 */
export function analyzeHistoryBreakdown(
  history: Array<{ role: string; content: unknown }>,
  startIdx = 0,
): HistoryBreakdown {
  const breakdown: HistoryBreakdown = {
    total: 0, compressed: 0, toolResults: 0, toolUse: 0,
    assistantText: 0, userText: 0, compressibleCount: 0, compressibleTokens: 0,
  };

  for (let i = startIdx; i < history.length; i++) {
    const msg = history[i];

    if (typeof msg.content === 'string') {
      const tokens = estimateTokens(msg.content);
      breakdown.total += tokens;
      if (msg.content.startsWith('[->')) {
        breakdown.compressed += tokens;
      } else if (msg.role === 'assistant') {
        breakdown.assistantText += tokens;
        if (tokens > HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS) {
          breakdown.compressibleCount++;
          breakdown.compressibleTokens += tokens;
        }
      } else {
        breakdown.userText += tokens;
        if (tokens > HISTORY_TEXT_REPLACEMENT_THRESHOLD_TOKENS) {
          breakdown.compressibleCount++;
          breakdown.compressibleTokens += tokens;
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
            }
          }
        } else {
          // text blocks in assistant messages, etc.
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block);
          const tokens = estimateTokens(text);
          breakdown.total += tokens;
          breakdown.assistantText += tokens;
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
  return parts.join(' ');
}
