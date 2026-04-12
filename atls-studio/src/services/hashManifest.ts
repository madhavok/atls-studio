/**
 * Hash Manifest — per-round reconciliation layer.
 *
 * Provides a single structured block that indexes every hash the model
 * might encounter: active engrams, dematerialized refs, archived refs,
 * forwarded hashes, and evicted hashes. Replaces scattered inline signals
 * ([P], [STALE], ## DEMATERIALIZED, ## ARCHIVED, Pinned: one-liner) with
 * one authoritative lookup table in the dynamic tail.
 *
 * Mutation events (forwards, evictions) are recorded imperatively from
 * contextStore paths. Active/demat/arch rows are derived from live store
 * and HPP state at render time.
 */

import type { ChunkRef } from './hashProtocol';
import type { FreshnessCause } from './batch/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForwardEntry {
  oldShortHash: string;
  newShortHash: string;
  source: string;
  cause: string;
  turn: number;
}

export interface EvictionEntry {
  shortHash: string;
  source: string;
  cause: string;
  turn: number;
}

export type ManifestVisibility = 'active' | 'demat' | 'arch';

export interface ManifestRow {
  shortHash: string;
  pinFlag: string;
  visibility: ManifestVisibility;
  type: string;
  source: string;
  tokens: string;
  freshness: string;
}

export interface ManifestMetrics {
  active: number;
  demat: number;
  archived: number;
  forwarded: number;
  suspect: number;
  evicted: number;
}

// ---------------------------------------------------------------------------
// State — module-level maps for mutation events
// ---------------------------------------------------------------------------

const forwardMap = new Map<string, ForwardEntry>();
const evictionMap = new Map<string, EvictionEntry>();

// ---------------------------------------------------------------------------
// Recording API
// ---------------------------------------------------------------------------

export function recordForwarding(
  oldShortHash: string,
  newShortHash: string,
  source: string,
  cause: string,
  turn: number,
): void {
  forwardMap.set(oldShortHash, { oldShortHash, newShortHash, source, cause, turn });
}

export function recordEviction(
  shortHash: string,
  source: string,
  cause: string,
  turn: number,
): void {
  if (forwardMap.has(shortHash)) return;
  evictionMap.set(shortHash, { shortHash, source, cause, turn });
}

export function clearForward(oldShortHash: string): void {
  forwardMap.delete(oldShortHash);
}

export function clearEviction(shortHash: string): void {
  evictionMap.delete(shortHash);
}

/**
 * Prune forward/eviction entries older than `maxAge` turns with no
 * reference in `recentHashes`. Called at the start of each render pass.
 */
export function pruneStaleEntries(currentTurn: number, maxAgeTurns: number, recentHashes?: Set<string>): void {
  for (const [key, entry] of forwardMap) {
    if (currentTurn - entry.turn > maxAgeTurns && (!recentHashes || !recentHashes.has(key))) {
      forwardMap.delete(key);
    }
  }
  for (const [key, entry] of evictionMap) {
    if (currentTurn - entry.turn > maxAgeTurns && (!recentHashes || !recentHashes.has(key))) {
      evictionMap.delete(key);
    }
  }
}

/** Look up a forwarding target. Returns the new shortHash or undefined. */
export function resolveForward(shortHash: string): string | undefined {
  return forwardMap.get(shortHash)?.newShortHash;
}

/** Check if a shortHash has a forward entry. */
export function hasForward(shortHash: string): boolean {
  return forwardMap.has(shortHash);
}

export function getForwardMap(): ReadonlyMap<string, ForwardEntry> {
  return forwardMap;
}

export function getEvictionMap(): ReadonlyMap<string, EvictionEntry> {
  return evictionMap;
}

export function resetManifestState(): void {
  forwardMap.clear();
  evictionMap.clear();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

interface ChunkLike {
  shortHash: string;
  type: string;
  source?: string;
  tokens: number;
  pinned?: boolean;
  pinnedShape?: string;
  compacted?: boolean;
  freshness?: string;
  freshnessCause?: string;
  suspectSince?: number;
}

interface FormatInput {
  activeChunks: ChunkLike[];
  dematRefs: ChunkRef[];
  archivedRefs: ChunkRef[];
  turn: number;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens}`;
}

function pinFlag(chunk: { pinned?: boolean; pinnedShape?: string }): string {
  if (!chunk.pinned) return '     ';
  if (chunk.pinnedShape) return `P:${chunk.pinnedShape.slice(0, 3).padEnd(3)}`;
  return 'P    ';
}

function pinFlagRef(ref: ChunkRef): string {
  if (!ref.pinned) return '     ';
  if (ref.pinnedShape) return `P:${ref.pinnedShape.slice(0, 3).padEnd(3)}`;
  return 'P    ';
}

function freshnessLabel(chunk: ChunkLike): string {
  if (chunk.suspectSince != null || chunk.freshness === 'suspect') {
    const cause = chunk.freshnessCause || 'unknown';
    return `suspect (${cause})`;
  }
  if (chunk.freshness === 'changed') return 'changed';
  return 'fresh';
}

function freshnessLabelRef(ref: ChunkRef): string {
  if (ref.freshness === 'suspect') {
    const cause = ref.freshnessCause || 'unknown';
    return `suspect (${cause})`;
  }
  if (ref.freshness === 'changed') return 'changed';
  return 'fresh';
}

function truncSource(source: string, maxLen: number): string {
  if (source.length <= maxLen) return source;
  const parts = source.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return source.slice(0, maxLen);
  return '...' + parts.slice(-2).join('/').slice(0, maxLen - 3);
}

/**
 * Render the full ## HASH MANIFEST block.
 *
 * Active/demat/arch rows are derived from live state passed in.
 * Forward/evict rows come from the module-level maps.
 */
export function formatHashManifest(input: FormatInput): string {
  const { activeChunks, dematRefs, archivedRefs, turn } = input;

  const suspectCount = activeChunks.filter(c => c.suspectSince != null || c.freshness === 'suspect').length
    + dematRefs.filter(r => r.freshness === 'suspect').length;

  const header = `## HASH MANIFEST (turn ${turn} | ${activeChunks.length} active, ${dematRefs.length} demat, ${archivedRefs.length} arch, ${forwardMap.size} fwd, ${suspectCount} suspect)`;

  if (activeChunks.length === 0 && dematRefs.length === 0 && archivedRefs.length === 0 && forwardMap.size === 0 && evictionMap.size === 0) {
    return `${header}\nall fresh`;
  }

  const lines: string[] = [header];
  const SRC_MAX = 38;

  for (const chunk of activeChunks) {
    const src = truncSource(chunk.source || chunk.type, SRC_MAX);
    const typ = chunk.type.padEnd(6);
    const pin = pinFlag(chunk);
    const tk = formatTokens(chunk.tokens).padStart(5);
    const fr = freshnessLabel(chunk);
    lines.push(`h:${chunk.shortHash} ${pin} ${typ} ${src.padEnd(SRC_MAX)} ${tk}  ${fr}`);
  }

  for (const ref of dematRefs) {
    const src = truncSource(ref.source || ref.type, SRC_MAX);
    const pin = pinFlagRef(ref);
    const tk = formatTokens(ref.tokens).padStart(5);
    const fr = freshnessLabelRef(ref);
    lines.push(`h:${ref.shortHash} ${pin} demat  ${src.padEnd(SRC_MAX)} ${tk}  ${fr}`);
  }

  for (const ref of archivedRefs) {
    const src = truncSource(ref.source || ref.type, SRC_MAX);
    const tk = formatTokens(ref.tokens).padStart(5);
    lines.push(`h:${ref.shortHash}       arch   ${src.padEnd(SRC_MAX)} ${tk}  rec to restore`);
  }

  for (const entry of forwardMap.values()) {
    const src = truncSource(entry.source, SRC_MAX);
    lines.push(`h:${entry.oldShortHash} -> h:${entry.newShortHash}  ${src.padEnd(SRC_MAX)}  (${entry.cause} t${entry.turn})`);
  }

  for (const entry of evictionMap.values()) {
    const src = truncSource(entry.source, SRC_MAX);
    lines.push(`h:${entry.shortHash}       evict  ${src.padEnd(SRC_MAX)}        (${entry.cause} t${entry.turn})`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function getManifestMetrics(input?: FormatInput): ManifestMetrics {
  const active = input?.activeChunks.length ?? 0;
  const demat = input?.dematRefs.length ?? 0;
  const archived = input?.archivedRefs.length ?? 0;
  const suspect = input
    ? input.activeChunks.filter(c => c.suspectSince != null || c.freshness === 'suspect').length
      + input.dematRefs.filter(r => r.freshness === 'suspect').length
    : 0;

  return {
    active,
    demat,
    archived,
    forwarded: forwardMap.size,
    suspect,
    evicted: evictionMap.size,
  };
}
