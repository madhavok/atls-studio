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
  /**
   * Optional: when the full-file engram pointed to by `shortHash` has been
   * replaced by narrower slices (line ranges / shaped sub-engrams), this
   * carries a human-readable marker plus the short hashes of the replacement
   * engrams. Absent (undefined) when the row is still the canonical view.
   *
   * Persisted consumers should treat this as a forward-compatible optional
   * field — older snapshots deserialize with `supersededBy === undefined`
   * and rendering degrades gracefully.
   */
  supersededBy?: {
    hashes: string[];
    note: string;
  };
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

/**
 * Unrecoverable ref entries — surfaced as `[UNRECOVERABLE: <cause>]` rows in
 * the manifest until the model re-reads the source or explicitly drops the
 * ref. Covers two cases today:
 *   - Pinned FileView path went missing on disk (session persistence pass)
 *   - Forward chain walk terminated unresolvable (cycle or max_depth)
 *
 * Replaces silent eviction so the model always sees an action marker when
 * the runtime cannot serve content it previously provided.
 */
export type UnrecoverableCause =
  | { kind: 'path_missing'; path: string }
  | { kind: 'forward_chain_cycle'; lastShortHash: string }
  | { kind: 'forward_chain_max_depth'; lastShortHash: string };

export interface UnrecoverableEntry {
  shortHash: string;
  source: string;
  cause: UnrecoverableCause;
  turn: number;
}

const unrecoverableMap = new Map<string, UnrecoverableEntry>();

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

/** Look up a single-hop forwarding target. Returns the new shortHash or undefined. */
export function resolveForward(shortHash: string): string | undefined {
  return forwardMap.get(shortHash)?.newShortHash;
}

/** Maximum forward-chain depth. Guards against pathological chains and cycles. */
const MAX_FORWARD_CHAIN_DEPTH = 16;

export type ForwardChainResult =
  | { kind: 'same'; shortHash: string }
  | { kind: 'resolved'; shortHash: string; hops: number }
  | { kind: 'terminated'; reason: 'cycle' | 'max_depth'; lastShortHash: string; hops: number };

/**
 * Walk the forward chain from `shortHash` to its terminal newShortHash,
 * detecting cycles and capping at `MAX_FORWARD_CHAIN_DEPTH` hops.
 *
 * Single-hop entries still return `kind:'resolved'` with `hops: 1`. Chains
 * that self-reference or exceed the depth cap return `kind:'terminated'` so
 * callers can surface an `[UNRECOVERABLE]` marker instead of spinning.
 * Refs with no forward entry return `kind:'same'` unchanged.
 */
export function resolveForwardChain(shortHash: string): ForwardChainResult {
  const first = forwardMap.get(shortHash);
  if (!first) return { kind: 'same', shortHash };

  const visited = new Set<string>([shortHash]);
  let current = first.newShortHash;
  let hops = 1;

  while (hops < MAX_FORWARD_CHAIN_DEPTH) {
    if (visited.has(current)) {
      return { kind: 'terminated', reason: 'cycle', lastShortHash: current, hops };
    }
    const next = forwardMap.get(current);
    if (!next) return { kind: 'resolved', shortHash: current, hops };
    visited.add(current);
    current = next.newShortHash;
    hops++;
  }

  return { kind: 'terminated', reason: 'max_depth', lastShortHash: current, hops };
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

/**
 * Record an unrecoverable ref so the manifest surfaces an `[UNRECOVERABLE]`
 * action marker until the model re-reads the source or drops the ref.
 *
 * Idempotent: re-recording the same shortHash with a newer turn refreshes
 * the entry (useful when a chain repeatedly terminates after new forwards).
 */
export function recordUnrecoverable(
  shortHash: string,
  source: string,
  cause: UnrecoverableCause,
  turn: number,
): void {
  unrecoverableMap.set(shortHash, { shortHash, source, cause, turn });
}

export function clearUnrecoverable(shortHash: string): void {
  unrecoverableMap.delete(shortHash);
}

export function getUnrecoverable(shortHash: string): UnrecoverableEntry | undefined {
  return unrecoverableMap.get(shortHash);
}

export function getUnrecoverableMap(): ReadonlyMap<string, UnrecoverableEntry> {
  return unrecoverableMap;
}

export function resetManifestState(): void {
  forwardMap.clear();
  evictionMap.clear();
  unrecoverableMap.clear();
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
  /** When set, this full-file engram has been replaced by narrower slices
   *  (see `ContextChunk.supersededBy`); rendered as a trailing marker. */
  supersededBy?: {
    hashes: string[];
    note: string;
  };
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

/** Fixed width for manifest type column (aligns with pin column layout). */
const MANIFEST_TYPE_WIDTH = 6;

/**
 * Map internal chunk type to manifest column label. `fileview` → `fv` (FileView retention rows).
 */
export function formatManifestType(type: string): string {
  if (type === 'fileview') return 'fv'.padEnd(MANIFEST_TYPE_WIDTH);
  return type.slice(0, MANIFEST_TYPE_WIDTH).padEnd(MANIFEST_TYPE_WIDTH);
}

// P2.2: 6-char pinned-shape column. At 3 chars, `imports` and `exports`
// collided on the same `imp`/`exp` → `im ` / `ex ` stub (first 3 chars
// after trim), making the manifest useless to distinguish shaped pins
// for concept/pattern/imports/exports. 6 chars is wide enough for every
// current shape keyword (`imports`, `exports`, `nocomment`, …) without
// blowing out the monospace manifest width. Total column: 8 chars
// (`P:xxxxxx`) so pinned and unpinned rows align.
const PIN_SHAPE_WIDTH = 6;
const PIN_COLUMN_WIDTH = 2 + PIN_SHAPE_WIDTH;

function pinFlag(chunk: { pinned?: boolean; pinnedShape?: string }): string {
  if (!chunk.pinned) return ' '.repeat(PIN_COLUMN_WIDTH);
  if (chunk.pinnedShape) return `P:${chunk.pinnedShape.slice(0, PIN_SHAPE_WIDTH).padEnd(PIN_SHAPE_WIDTH)}`;
  return 'P'.padEnd(PIN_COLUMN_WIDTH);
}

function pinFlagRef(ref: ChunkRef): string {
  if (!ref.pinned) return ' '.repeat(PIN_COLUMN_WIDTH);
  if (ref.pinnedShape) return `P:${ref.pinnedShape.slice(0, PIN_SHAPE_WIDTH).padEnd(PIN_SHAPE_WIDTH)}`;
  return 'P'.padEnd(PIN_COLUMN_WIDTH);
}

// `freshnessLabel` / `freshnessLabelRef` / `formatSupersededMarker` were
// deleted in the ref-language unification pass. Freshness state is
// runtime-internal (auto-refetch handles pinned divergence; unpinned drops
// silently); superseded markers were a parallel forward-chain surface
// resolved internally by the unlimited-hop walker in `resolveForwardChain`.
// Types retained on `ChunkLike` / `ChunkRef` for diagnostic telemetry.

function truncSource(source: string, maxLen: number): string {
  if (source.length <= maxLen) return source;
  const parts = source.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return source.slice(0, maxLen);
  return '...' + parts.slice(-2).join('/').slice(0, maxLen - 3);
}

/**
 * Format an `[UNRECOVERABLE: ...]` action marker for a ref the runtime can
 * no longer serve. Joins the `[REMOVED]` / `[changed: pending refetch]`
 * action-marker family — the model's one re-read signal.
 */
function formatUnrecoverableMarker(cause: UnrecoverableCause): string {
  switch (cause.kind) {
    case 'path_missing':
      return `[UNRECOVERABLE: path ${cause.path} missing — re-read or drop]`;
    case 'forward_chain_cycle':
      return `[UNRECOVERABLE: forward chain cycled at h:${cause.lastShortHash} — re-read source to refresh]`;
    case 'forward_chain_max_depth':
      return `[UNRECOVERABLE: forward chain terminated at h:${cause.lastShortHash} — re-read source to refresh]`;
  }
}

/**
 * Render the full ## HASH MANIFEST block.
 *
 * Active/demat/arch rows are derived from live state passed in.
 * Forward/evict rows come from the module-level maps.
 */
export function formatHashManifest(input: FormatInput): string {
  const { activeChunks, dematRefs, archivedRefs, turn } = input;

  const pinnedCount = activeChunks.filter(c => c.pinned).length
    + dematRefs.filter(r => r.pinned).length;

  // Header collapses to turn + pinned count. Internal HPP categories
  // (demat/arch/fwd/suspect) were previously exposed; they're bookkeeping
  // the model cannot act on. Pinned count remains — it's a work decision.
  const header = pinnedCount > 0
    ? `## HASH MANIFEST (turn ${turn} | ${pinnedCount} pinned)`
    : `## HASH MANIFEST (turn ${turn})`;

  if (activeChunks.length === 0 && dematRefs.length === 0 && archivedRefs.length === 0 && unrecoverableMap.size === 0) {
    return header;
  }

  const lines: string[] = [header];
  const SRC_MAX = 38;

  // Active + dematerialized rows render with a unified `active/dormant`
  // visibility column. Internal demat vs arch distinction stays in the
  // store for diagnostics but doesn't surface to the model.
  for (const chunk of activeChunks) {
    const src = truncSource(chunk.source || chunk.type, SRC_MAX);
    const typ = formatManifestType(chunk.type);
    const pin = pinFlag(chunk);
    const tk = formatTokens(chunk.tokens).padStart(5);
    lines.push(`h:${chunk.shortHash} ${pin} ${typ} ${src.padEnd(SRC_MAX)} ${tk}  active`);
  }

  for (const ref of dematRefs) {
    const src = truncSource(ref.source || ref.type, SRC_MAX);
    const pin = pinFlagRef(ref);
    const typ = 'dorm'.padEnd(MANIFEST_TYPE_WIDTH);
    const tk = formatTokens(ref.tokens).padStart(5);
    lines.push(`h:${ref.shortHash} ${pin} ${typ} ${src.padEnd(SRC_MAX)} ${tk}  dormant`);
  }

  for (const ref of archivedRefs) {
    const src = truncSource(ref.source || ref.type, SRC_MAX);
    const tk = formatTokens(ref.tokens).padStart(5);
    lines.push(`h:${ref.shortHash}       dorm   ${src.padEnd(SRC_MAX)} ${tk}  dormant | rec to restore`);
  }

  // Forward-chain rows and eviction rows are now internal-only. The
  // unlimited-hop walker in `resolveForwardChain` handles old refs
  // transparently; `[UNRECOVERABLE: forward chain terminated]` surfaces
  // only when the chain dead-ends. Superseded-by markers on full-file
  // rows are likewise hidden — auto-forward resolves them.

  // Unrecoverable rows — one per ref the runtime can no longer serve. Carry
  // the `[UNRECOVERABLE: ...]` action marker so the model has an explicit
  // re-read prompt for the case, not silent loss.
  for (const entry of unrecoverableMap.values()) {
    const src = truncSource(entry.source, SRC_MAX);
    const marker = formatUnrecoverableMarker(entry.cause);
    lines.push(`h:${entry.shortHash}       unrec  ${src.padEnd(SRC_MAX)}        ${marker}`);
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
