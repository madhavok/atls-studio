/**
 * History Selector — token-budget-aware message selection for API calls.
 *
 * Replaces the blunt `messages.slice(-20)` with a strategy that:
 * 1. Always preserves the original task message (first user message)
 * 2. Always preserves the most recent messages
 * 3. Fills remaining budget from the middle, preferring user + assistant text
 *    over tool-heavy rounds
 *
 * The rolling summary (prepended by aiService) covers anything excluded.
 */

import { countTokensSync } from '../utils/tokenCounter';
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
    let total = 0;
    for (const block of c) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const text = (b.text ?? b.content ?? '') as string;
      if (typeof text === 'string') total += countTokensSync(text);
      else if (b.input) total += countTokensSync(JSON.stringify(b.input));
    }
    return total || 20;
  }
  return 20;
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
    return hasFirstUser ? [messages[firstUserIdx], ...recent] : [...recent];
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

  const result = [...pinned, ...included, ...recent];
  if (result.length > FALLBACK_HARD_CAP) return result.slice(result.length - FALLBACK_HARD_CAP);
  return result;
}
