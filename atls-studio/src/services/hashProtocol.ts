import type { SetSelector } from '../utils/uhppTypes';
import type { ChunkType } from '../utils/contextHash';
import type { FreshnessCause, FreshnessState } from './batch/types';
import { SHORT_HASH_LEN } from '../utils/contextHash';
import { getActiveRefs } from './hashProtocolQuery';
export { getActiveRefs } from './hashProtocolQuery';
export { setPinned, setRoundRefreshHook, getRoundRefreshHook } from './hashProtocolState';
import { getRoundRefreshHook } from './hashProtocolState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChunkVisibility = 'materialized' | 'referenced' | 'archived' | 'evicted';

export interface ChunkRef {
  hash: string;
  shortHash: string;
  type: ChunkType;
  source?: string;
  totalLines: number;
  tokens: number;
  editDigest: string;
  visibility: ChunkVisibility;
  seenAtTurn: number;
  pinned?: boolean;
  pinnedShape?: string;
  // Lineage and freshness (synced from ChunkEntry when materializing)
  sourceRevision?: string;
  parentHash?: string;
  editSessionId?: string;
  origin?: 'read' | 'edit' | 'stage' | 'derived';
  freshness?: FreshnessState;
  freshnessCause?: FreshnessCause;
}

// Compact single-line format emitted for referenced chunks
export interface RefLine {
  hash: string;
  shortHash: string;
  source: string;
  tokens: number;
  totalLines: number;
  editDigest: string;
}

// ---------------------------------------------------------------------------
// Protocol State
// ---------------------------------------------------------------------------

let currentTurn = 0;
const refs = new Map<string, ChunkRef>();
let lastTurnDelta = { dematerialized: 0, newMaterialized: 0 };

export function getTurn(): number {
  return currentTurn;
}

export function getTurnDelta(): { dematerialized: number; newMaterialized: number } {
  return lastTurnDelta;
}

export async function advanceTurn(): Promise<number> {
  currentTurn++;
  let dematerialized = 0;
  for (const ref of refs.values()) {
    if (ref.visibility === 'materialized' && ref.seenAtTurn < currentTurn && !ref.pinned) {
      ref.visibility = 'referenced';
      dematerialized++;
    }
  }
  lastTurnDelta = { dematerialized, newMaterialized: 0 };
  const hook = getRoundRefreshHook();
  if (hook) {
    try {
      const result = hook();
      if (result instanceof Promise) {
        await result;
      }
    } catch (err) {
      console.error('[hashProtocol] Round-refresh hook failed:', err);
    }
  }
  return currentTurn;
}

export function resetProtocol(): void {
  currentTurn = 0;
  refs.clear();
  lastTurnDelta = { dematerialized: 0, newMaterialized: 0 };
}

/**
 * Set pin state on a ChunkRef. Synced from contextStore when model pins/unpins.
 * Pinned refs are exempt from advanceTurn dematerialization.
 */
// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a chunk as materialized (the model is about to see full content).
 * If already referenced, promotes back to materialized for this turn.
 */
export function materialize(
  hash: string,
  type: ChunkType,
  source: string | undefined,
  tokens: number,
  totalLines: number,
  editDigest: string,
): ChunkRef {
  const shortHash = hash.slice(0, SHORT_HASH_LEN);
  const existing = refs.get(hash);

  if (existing) {
    existing.visibility = 'materialized';
    existing.seenAtTurn = currentTurn;
    existing.tokens = tokens;
    existing.totalLines = totalLines;
    existing.editDigest = editDigest || existing.editDigest;
    existing.source = source ?? existing.source;
    return existing;
  }

  const ref: ChunkRef = {
    hash,
    shortHash,
    type,
    source,
    totalLines,
    tokens,
    editDigest: editDigest || '',
    visibility: 'materialized',
    seenAtTurn: currentTurn,
  };
  refs.set(hash, ref);
  lastTurnDelta = { ...lastTurnDelta, newMaterialized: lastTurnDelta.newMaterialized + 1 };
  return ref;
}

/**
 * Mark a chunk as referenced (digest-only) without waiting for endTurn.
 * Used when compression replaces content with a hash ref mid-turn.
 */
export function dematerialize(hash: string): void {
  const ref = getRef(hash);
  if (ref && ref.visibility === 'materialized') {
    ref.visibility = 'referenced';
  }
}

/**
 * Mark a chunk as archived (moved out of working memory but still recallable).
 * Archived refs are excluded from working memory formatting but remain
 * reachable for set-ref queries and direct hash resolution.
 */
export function archive(hash: string): void {
  const ref = getRef(hash);
  if (ref && ref.visibility !== 'evicted') {
    ref.visibility = 'archived';
  }
}

/**
 * Mark a chunk as evicted (no longer in working memory at all).
 */
export function evict(hash: string): void {
  const ref = getRef(hash);
  if (ref) {
    ref.visibility = 'evicted';
  }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export function getRef(hash: string): ChunkRef | undefined {
  const normalized = hash.startsWith('h:') ? hash.slice(2) : hash;
  const direct = refs.get(normalized);
  if (direct) return direct;
  // Short hash or prefix lookup — collect all matches and reject ambiguous prefixes
  let match: ChunkRef | undefined;
  let matchCount = 0;
  for (const [, ref] of refs) {
    if (ref.shortHash === normalized) {
      return ref; // Exact short-hash match is unambiguous
    }
    if (ref.hash.startsWith(normalized)) {
      match = ref;
      matchCount++;
    }
  }
  if (matchCount === 1) return match;
  return undefined;
}

export function getAllRefs(): ChunkRef[] {
  return Array.from(refs.values());
}

/** Refs currently in working memory: materialized + referenced only. */
export function getWorkingRefs(): ChunkRef[] {
  return Array.from(refs.values()).filter(r =>
    r.visibility === 'materialized' || r.visibility === 'referenced'
  );
}

/** Refs that have been archived (out of WM but recallable). */
export function getArchivedRefs(): ChunkRef[] {
  return Array.from(refs.values()).filter(r => r.visibility === 'archived');
}

// ---------------------------------------------------------------------------
// HPP v3 Set-Ref Index Queries
// ---------------------------------------------------------------------------

/** Get all active (non-evicted) refs matching a source path glob pattern. */
export function getRefsBySource(pattern: string): ChunkRef[] {
  const active = getActiveRefs();
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`, 'i');
    return active.filter(r => r.source && re.test(r.source));
  }
  const normalized = pattern.replace(/\\/g, '/').toLowerCase();
  return active.filter(r => r.source && r.source.replace(/\\/g, '/').toLowerCase() === normalized);
}

/** Get all active refs of a specific ChunkType. */
export function getRefsByType(chunkType: string): ChunkRef[] {
  return getActiveRefs().filter(r => r.type === chunkType);
}

/** Get the N most recently seen refs, sorted by seenAtTurn desc. */
export function getLatestRefs(count: number = 1): ChunkRef[] {
  if (!Number.isFinite(count) || count < 1) return [];
  const normalizedCount = Math.floor(count);
  return [...getActiveRefs()]
    .sort((a, b) => b.seenAtTurn - a.seenAtTurn)
    .slice(0, normalizedCount);
}

/** Stale/dormant classification constants (mirrors contextFormatter.ts) */
const TURNS_TO_MS = 60_000;
const STALE_TURNS = 5;

/**
 * Get refs classified as "stale" — not accessed within STALE_TURNS and not compacted.
 * Falls back to seenAtTurn-based heuristic since ChunkRef lacks lastAccessed.
 */
function getStaleRefs(): ChunkRef[] {
  const staleCutoff = currentTurn - STALE_TURNS;
  return getActiveRefs().filter(r => !r.pinned && r.seenAtTurn <= staleCutoff);
}

/**
 * Get refs classified as "dormant" — compacted/archived chunks still in memory.
 * In HPP terms these are referenced or archived visibility.
 */
function getDormantRefs(): ChunkRef[] {
  return getAllRefs().filter(r => r.visibility === 'referenced' || r.visibility === 'archived');
}

/**
 * Resolve a SetSelector against the HPP visibility refs.
 *
 * NOTE: Production set-ref resolution flows through contextStore.createSetRefLookup()
 * → queryBySetSelector(), which has full ContextChunk metadata. This function is a
 * secondary path for HPP-only queries and returns [] for selectors that require
 * external state (head/tag/commit/workspace/search).
 */
export function queryRefs(selector: SetSelector): ChunkRef[] {
  switch (selector.kind) {
    case 'file':
      return getRefsBySource(selector.pattern);
    case 'type':
      return getRefsByType(selector.chunkType);
    case 'latest':
      return getLatestRefs(selector.count);
    case 'all':
      return getActiveRefs();
    case 'edited':
      return getActiveRefs().filter(r => r.type === 'result');
    case 'pinned':
      return getActiveRefs().filter(r => !!r.pinned);
    case 'stale':
      return getStaleRefs();
    case 'dormant':
      return getDormantRefs();
    case 'head':
    case 'tag':
    case 'commit':
    case 'workspace':
    case 'search':
    case 'subtask':
      return [];
  }
}

// ---------------------------------------------------------------------------
// Formatting — what the model sees
// ---------------------------------------------------------------------------

const FILE_TYPES: ReadonlySet<string> = new Set([
  'file', 'smart', 'raw', 'tree', 'search', 'symbol', 'deps', 'issues',
]);

/**
 * Format a chunk for the current turn.
 *
 * - materialized + seenAtTurn === currentTurn → full content (caller appends)
 * - referenced or seen in prior turn → compact digest line
 */
export function shouldMaterialize(ref: ChunkRef): boolean {
  if (ref.visibility === 'archived' || ref.visibility === 'evicted') return false;
  if (ref.visibility !== 'materialized') return false;
  return ref.seenAtTurn === currentTurn || !!ref.pinned;
}

/**
 * Build the compact one-line reference the model sees for already-seen content.
 *
 * Format:
 *   h:abc12345 src/auth.ts 2400tk 89L
 *     fn authenticate:15-32 | cls AuthService:34-89
 */
export function formatRefLine(ref: ChunkRef): string {
  const src = ref.source || ref.type;
  const header = `h:${ref.shortHash} ${src} ${ref.tokens}tk ${ref.totalLines}L`;
  if (ref.editDigest) {
    return `${header}\n${ref.editDigest}`;
  }
  return header;
}

/** Compact manifest line for archived refs shown outside working memory. */
export function formatArchivedRefLine(ref: ChunkRef): string {
  const src = ref.source || ref.type;
  return `h:${ref.shortHash} [archived] ${src} ${ref.tokens}tk — recall to restore`;
}

/**
 * Sort refs for working memory display:
 * pinned first (handled by caller), then file types before artifacts, then by recency.
 */
export function sortRefs(a: ChunkRef, b: ChunkRef): number {
  const aFile = FILE_TYPES.has(a.type);
  const bFile = FILE_TYPES.has(b.type);
  if (aFile !== bFile) return aFile ? -1 : 1;
  return b.seenAtTurn - a.seenAtTurn;
}

// ---------------------------------------------------------------------------
// Scoped HPP View — isolated turn counter for subagents
// ---------------------------------------------------------------------------

export interface ScopedHppView {
  getTurn(): number;
  advanceTurn(): number;
  getRef(hash: string): ChunkRef | undefined;
  shouldMaterialize(ref: ChunkRef): boolean;
  getActiveRefs(): ChunkRef[];
}

/**
 * Create an isolated HPP view for subagent use. Reads from the shared global
 * refs Map but tracks a local turn counter that does not mutate global state.
 * advanceTurn() only increments the local counter — no dematerialization,
 * no round-refresh hooks, no global side effects.
 */
export function createScopedView(): ScopedHppView {
  let localTurn = 0;

  return {
    getTurn: () => localTurn,

    advanceTurn: () => ++localTurn,

    getRef: (hash: string) => getRef(hash),

    shouldMaterialize: (ref: ChunkRef) => {
      if (ref.visibility === 'archived' || ref.visibility === 'evicted') return false;
      if (ref.visibility !== 'materialized') return false;
      return ref.seenAtTurn >= (currentTurn - localTurn) || !!ref.pinned;
    },

    getActiveRefs: () => getActiveRefs(),
  };
}