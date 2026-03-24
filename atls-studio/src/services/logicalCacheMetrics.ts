/**
 * Logical cache hit/miss metrics — derives expected Anthropic cache behavior
 * from our own prompt assembly rules (edit = miss; append-only = hit).
 *
 * These are pure functions with no side effects. The wiring lives in aiService.ts.
 */

import { hashContentSync } from '../utils/contextHash';

export interface Bp3Snapshot {
  hash: string;
  length: number;
}

export interface LogicalHitResult {
  hit: boolean;
  reason: string;
}

/**
 * Hash the BP3 prefix — all messages before the last user message.
 * When `subPrefixLength` is provided, hashes only `history[0..subPrefixLength)`
 * for the append-detection fast path.
 */
export function hashBp3Prefix(
  history: Array<{ role: string; content: unknown }>,
  lastUserIndex: number,
  subPrefixLength?: number,
): string {
  const end = subPrefixLength ?? lastUserIndex;
  if (end <= 0) return hashContentSync('');
  return hashContentSync(JSON.stringify(history.slice(0, end)));
}

/**
 * Determine if the BP3 (conversation history) cache breakpoint is a logical hit.
 *
 * Hit: previous prefix is a byte-identical prefix of the current one (append-only).
 * Miss: first request, prefix shrunk, or any earlier message was edited/compressed.
 *
 * Caller must supply the sub-prefix hash (hash of curr[0..prev.length)) when
 * curr.length > prev.length — use `hashBp3Prefix(history, lastUserIndex, prev.length)`.
 */
export function computeLogicalBp3Hit(
  prev: Bp3Snapshot | null,
  curr: Bp3Snapshot,
  subPrefixHash?: string,
): LogicalHitResult {
  if (!prev) return { hit: false, reason: 'first request' };
  if (curr.length < prev.length) return { hit: false, reason: 'prefix shrunk' };
  if (curr.length === prev.length) {
    return curr.hash === prev.hash
      ? { hit: true, reason: 'identical' }
      : { hit: false, reason: 'prefix edited' };
  }
  // curr.length > prev.length — append case
  const prefixHash = subPrefixHash ?? curr.hash;
  return prefixHash === prev.hash
    ? { hit: true, reason: 'append-only' }
    : { hit: false, reason: 'prefix edited' };
}

/**
 * Determine if the BP-static (system + tools) cache breakpoint is a logical hit.
 */
export function computeLogicalStaticHit(
  prevKey: string | null,
  currKey: string,
): LogicalHitResult {
  if (prevKey === null) return { hit: false, reason: 'first request' };
  return prevKey === currKey
    ? { hit: true, reason: 'unchanged' }
    : { hit: false, reason: 'static config changed' };
}
