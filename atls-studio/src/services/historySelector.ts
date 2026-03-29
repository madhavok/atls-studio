/**
 * History Selector — token-budget-aware message selection for API calls.
 *
 * Replaces the blunt `messages.slice(-20)` with a strategy that:
 * 1. Always preserves the original task message (first user message)
 * 2. Always preserves the most recent messages
 * 3. Fills remaining budget from the middle, preferring user + assistant text
 *    over tool-heavy rounds
 * 4. Preserves tool_use / tool_result adjacency (assistant+user pairs)
 *
 * The rolling summary (prepended by aiService) covers anything excluded.
 */

import { countTokensSync } from '../utils/tokenCounter';
import { serializeMessageContentForTokens } from '../utils/toon';
import { CONVERSATION_HISTORY_BUDGET_TOKENS } from './promptMemory';

interface HasRoleAndContent {
  role: string;
  content: unknown;
}

const FALLBACK_HARD_CAP = 40;
const MIN_RECENT_MESSAGES = 10;

function estimateMessageTokens(msg: HasRoleAndContent): number {
  const c = msg.content;
  if (typeof c === 'string') return countTokensSync(c);
  if (Array.isArray(c)) {
    return countTokensSync(serializeMessageContentForTokens(c)) || 20;
  }
  return 20;
}

function hasToolUseBlocks(content: unknown): boolean {
  return Array.isArray(content) && content.some(
    (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_use',
  );
}

function hasToolResultBlocks(content: unknown): boolean {
  return Array.isArray(content) && content.some(
    (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result',
  );
}

/**
 * Ensure the selected result preserves tool_use/tool_result adjacency.
 * When an assistant message with tool_use is at a boundary, pull in its
 * paired user message (and vice versa) from the original array.
 */
function repairToolPairsInSelection<T extends HasRoleAndContent>(
  selected: T[],
  original: T[],
): T[] {
  if (selected.length === 0) return selected;

  const originalIndex = new Map<T, number>();
  for (let i = 0; i < original.length; i++) originalIndex.set(original[i], i);

  const inResult = new Set<T>(selected);
  const toInsert: Array<{ after: T; msg: T }> = [];
  const toPrepend: Array<{ before: T; msg: T }> = [];

  for (const msg of selected) {
    const oi = originalIndex.get(msg);
    if (oi === undefined) continue;

    if (msg.role === 'assistant' && hasToolUseBlocks(msg.content)) {
      const next = original[oi + 1];
      if (next && next.role === 'user' && !inResult.has(next)) {
        toInsert.push({ after: msg, msg: next });
        inResult.add(next);
      }
    }

    if (msg.role === 'user' && hasToolResultBlocks(msg.content)) {
      const prev = original[oi - 1];
      if (prev && prev.role === 'assistant' && hasToolUseBlocks(prev.content) && !inResult.has(prev)) {
        toPrepend.push({ before: msg, msg: prev });
        inResult.add(prev);
      }
    }
  }

  if (toInsert.length === 0 && toPrepend.length === 0) return selected;

  const insertAfter = new Map<T, T[]>();
  for (const { after, msg } of toInsert) {
    const list = insertAfter.get(after) || [];
    list.push(msg);
    insertAfter.set(after, list);
  }
  const insertBefore = new Map<T, T[]>();
  for (const { before, msg } of toPrepend) {
    const list = insertBefore.get(before) || [];
    list.push(msg);
    insertBefore.set(before, list);
  }

  const repaired: T[] = [];
  for (const msg of selected) {
    const pre = insertBefore.get(msg);
    if (pre) repaired.push(...pre);
    repaired.push(msg);
    const post = insertAfter.get(msg);
    if (post) repaired.push(...post);
  }
  return repaired;
}

/**
 * Select messages for the API call, respecting a token budget while
 * always keeping the first user message and the most recent tail.
 */
export function selectRecentHistory<T extends HasRoleAndContent>(
  messages: T[],
  tokenBudget: number = CONVERSATION_HISTORY_BUDGET_TOKENS,
): T[] {
  if (messages.length === 0) return [];
  if (messages.length <= MIN_RECENT_MESSAGES) return [...messages];

  const firstUserIdx = messages.findIndex(m => m.role === 'user');
  const hasFirstUser = firstUserIdx >= 0 && firstUserIdx < messages.length - MIN_RECENT_MESSAGES;

  const recentStart = Math.max(0, messages.length - MIN_RECENT_MESSAGES);
  const recent = messages.slice(recentStart);
  let usedTokens = 0;
  for (const m of recent) usedTokens += estimateMessageTokens(m);

  const pinned: T[] = [];
  if (hasFirstUser) {
    const firstUser = messages[firstUserIdx];
    const firstTokens = estimateMessageTokens(firstUser);
    pinned.push(firstUser);
    usedTokens += firstTokens;
  }

  const middleStart = hasFirstUser ? firstUserIdx + 1 : 0;
  const middleEnd = recentStart;

  if (middleStart >= middleEnd) {
    const base = hasFirstUser ? [messages[firstUserIdx], ...recent] : [...recent];
    return repairToolPairsInSelection(base, messages);
  }

  const remaining = tokenBudget - usedTokens;
  const middleMessages = messages.slice(middleStart, middleEnd);

  // Scan backwards from the most recent middle messages, filling budget
  const included: T[] = [];
  let middleBudget = remaining;
  for (let i = middleMessages.length - 1; i >= 0 && included.length < FALLBACK_HARD_CAP; i--) {
    const msg = middleMessages[i];
    const tokens = estimateMessageTokens(msg);
    if (middleBudget - tokens < 0 && included.length > 0) break;
    included.unshift(msg);
    middleBudget -= tokens;
  }

  let result = [...pinned, ...included, ...recent];
  result = repairToolPairsInSelection(result, messages);
  if (result.length > FALLBACK_HARD_CAP) {
    const tail = result.slice(result.length - FALLBACK_HARD_CAP);
    if (hasFirstUser && tail[0] !== pinned[0]) {
      tail[0] = pinned[0];
    }
    return repairToolPairsInSelection(tail, messages);
  }
  return result;
}
