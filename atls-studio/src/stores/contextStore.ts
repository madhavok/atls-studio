/**
 * Context Store
 * 
 * Hash-addressable context memory for AI self-management.
 * Every chunk is tracked with a hash for selective load/unload.
 * 
 * Architecture:
 * - Working Memory: Ephemeral, task-scoped chunks (files, search results, tool outputs)
 * - Blackboard: Persistent session knowledge (plans, findings, decisions)
 * - TaskPlan: Goal + subtasks with auto-lifecycle for context
 */

import { create } from 'zustand';
import { 
  type ChunkType, 
  hashContentSync, 
  formatChunkTag,
  formatChunkRef,
  generateDigest,
  generateEditReadyDigest,
  SHORT_HASH_LEN,
  type DigestSymbol,
} from '../utils/contextHash';
import { countTokensSync, countTokens } from '../utils/tokenCounter';
import {
  formatWorkingMemory,
  formatTaggedContext,
  formatStatsLine,
  formatTaskLine,
} from '../services/contextFormatter';
import {
  STAGED_ANCHOR_BUDGET_TOKENS,
  STAGED_BUDGET_TOKENS,
  STAGED_TOTAL_HARD_CAP_TOKENS,
  MAX_PERSISTENT_STAGE_ENTRIES,
  type PromptReliefAction,
  type StageAdmissionClass,
  type StageEvictionReason,
  type StagePersistencePolicy,
  classifyStageSnippet,
} from '../services/promptMemory';
import type { HashLookupResult, SetRefLookup, SetSelector } from '../utils/hashResolver';
import { resetProtocol, evict as hppEvict, setPinned as hppSetPinned, archive as hppArchive, materialize as hppMaterialize, dematerialize as hppDematerialize, getRef as hppGetRef, shouldMaterialize as hppShouldMaterialize, getTurn as hppGetTurn } from '../services/hashProtocol';
import { useRoundHistoryStore } from './roundHistoryStore';
import { formatAge } from '../utils/formatHelpers';
import { canonicalizeSnapshotHash } from '../services/batch/snapshotTracker';
import { emptyRollingSummary, type RollingSummary } from '../services/historyDistiller';
import { freshnessTelemetry, incSessionRestoreReconcileCount, incCognitiveRulesExpired, setManifestMetricsAccessor } from '../services/freshnessTelemetry';
import { recordForwarding as manifestRecordForwarding, recordEviction as manifestRecordEviction, resolveForward as manifestResolveForward, getManifestMetrics } from '../services/hashManifest';

setManifestMetricsAccessor(getManifestMetrics);

// Minimum chars required for prefix-based hash resolution (reduces collision risk)
/** Match SHORT_HASH_LEN (6) so h:abcdef-style refs resolve (annotate.link, synapses). */
const MIN_PREFIX_LEN = 6;

function normalizePathForLink(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** Match annotate.link `to`/`from` file paths or basenames to chunk.source. */
function pathMatchesLinkRef(pathNorm: string, chunkSource: string): boolean {
  const s = normalizePathForLink(chunkSource);
  const bn = s.split('/').pop() ?? '';
  // Avoid false-positive when basename is empty (source ends with /)
  return bn.length > 0 && (s === pathNorm || s.endsWith('/' + pathNorm) || bn === pathNorm || pathNorm.endsWith('/' + bn));
}

// Lazy accessor for appStore cache metrics (avoids circular import)
let _getCacheHitRate: () => number = () => 0;
export function setCacheHitRateAccessor(fn: () => number): void { _getCacheHitRate = fn; }

let _getWorkspaces: () => Array<{ name: string; path: string }> = () => [];
export function setWorkspacesAccessor(fn: () => Array<{ name: string; path: string }>): void {
  _getWorkspaces = fn;
}

type PromptMetricsAccessor = {
  modePromptTokens: number;
  toolRefTokens: number;
  shellGuideTokens: number;
  nativeToolTokens?: number;
  primerTokens?: number;
  contextControlTokens: number;
  workspaceContextTokens: number;
  bp3PriorTurnsTokens?: number;
  roundCount?: number;
};

let _getPromptMetrics: () => PromptMetricsAccessor = () => ({
  modePromptTokens: 0,
  toolRefTokens: 0,
  shellGuideTokens: 0,
  nativeToolTokens: 0,
  primerTokens: 0,
  contextControlTokens: 0,
  workspaceContextTokens: 0,
  bp3PriorTurnsTokens: 0,
  roundCount: 0,
});
export function setPromptMetricsAccessor(fn: () => PromptMetricsAccessor): void { _getPromptMetrics = fn; }

// Round-refresh revision resolver — used by refreshRoundEnd when no getRevisionForPath passed (e.g. from advanceTurn hook).
let _roundRefreshRevisionResolver: ((path: string) => Promise<string | null>) | null = null;
export function setRoundRefreshRevisionResolver(fn: ((path: string) => Promise<string | null>) | null): void {
  _roundRefreshRevisionResolver = fn;
}

// Session-independent bulk revision resolver — resolves all paths in a single IPC call via get_current_revisions.
// Available at app boot (not session-scoped). Used as fallback when _roundRefreshRevisionResolver is null.
let _bulkRevisionResolver: ((paths: string[]) => Promise<Map<string, string | null>>) | null = null;
export function setBulkRevisionResolver(fn: ((paths: string[]) => Promise<Map<string, string | null>>) | null): void {
  _bulkRevisionResolver = fn;
}
export function getBulkRevisionResolver(): ((paths: string[]) => Promise<Map<string, string | null>>) | null {
  return _bulkRevisionResolver;
}


/**
 * Check if two source paths refer to the same file. Handles mismatches
 * between absolute and relative paths, backslash vs forward slash, and
 * drive-letter prefixes by normalizing both and checking suffix containment.
 * Batch sources (comma-separated paths) only match exactly — never via
 * substring, so "a.ts, b.ts" does not match "a.ts" on re-read.
 */
function sourcePathsMatch(a: string, b: string): boolean {
  const aNorm = normalizePathForLink(a);
  const bNorm = normalizePathForLink(b);
  if (aNorm === bNorm) return true;
  // Batch sources (comma-separated) should only match exactly — skip suffix check
  if (aNorm.includes(',') || bNorm.includes(',')) return false;
  // Check if one is a suffix of the other (handles relative vs absolute)
  return aNorm.endsWith('/' + bNorm) || bNorm.endsWith('/' + aNorm);
}

const SUBSTANTIVE_BB_CONCLUSION_PATTERN = /\b(confirmed|clear|bug|correct|incorrect|fixed|no bug|inconclusive|finding)\b/i;
const PROGRESS_ONLY_KEY_PREFIXES = ['status:', 'findings:progress', 'findings:reading', 'findings:blocker'];

function isSubstantiveBbWrite(key?: string, content?: string): boolean {
  if (!content || content.length <= 80) return false;
  if (key && PROGRESS_ONLY_KEY_PREFIXES.some(p => key.startsWith(p))) {
    return SUBSTANTIVE_BB_CONCLUSION_PATTERN.test(content);
  }
  if (key && (key.startsWith('finding:') || key.startsWith('bug:') || key.startsWith('review:'))) return true;
  return SUBSTANTIVE_BB_CONCLUSION_PATTERN.test(content);
}

// Max tokens for archived chunks — LRU-evicted when exceeded
export const ARCHIVE_MAX_TOKENS = 50000;

// Stale dormant engrams above this threshold are archived on eviction;
// those at or below (e.g. batch call stubs at ~7tk) are dropped outright.
const DORMANT_ARCHIVE_THRESHOLD = 1000;

// Maximum dormant (compacted+unpinned) chunks before LRU eviction kicks in.
// Search results, batch stubs, tree reads etc. don't have file-backed sources
// so reconcileSourceRevision never evicts them — this count-based limit does.
const MAX_DORMANT_CHUNKS = 30;

// Engram annotation — a note attached without mutating content
export interface EngramAnnotation {
  id: string;
  content: string;
  createdAt: number;
  tokens: number;
}

// Synapse — a typed connection between two engrams
export interface Synapse {
  targetHash: string;
  relation: 'caused_by' | 'depends_on' | 'related_to' | 'supersedes' | 'refines';
  createdAt: number;
}

export type EngramViewKind = 'latest' | 'snapshot' | 'derived';

export interface MemoryEvent {
  id: string;
  at: number;
  action: 'read' | 'write' | 'compact' | 'archive' | 'drop' | 'evict' | 'invalidate' | 'reconcile' | 'retry' | 'block' | 'auto-unpin';
  reason: string;
  refs?: string[];
  source?: string;
  oldRevision?: string;
  newRevision?: string;
  freedTokens?: number;
  pressurePct?: number;
  confidence?: RebaseConfidence;
  strategy?: RebaseStrategy;
  factors?: RebaseEvidence[];
}

export interface ReconcileStats {
  source: string;
  revision: string;
  total: number;
  updated: number;
  invalidated: number;
  preserved: number;
  at: number;
  bbSuperseded?: number;
}

export interface RefreshRoundStats {
  total: number;
  updated: number;
  invalidated: number;
  preserved: number;
  pathsProcessed: number;
}

export interface MemoryTelemetrySummary {
  eventCount: number;
  blockCount: number;
  retryCount: number;
  rebindCount: number;
  lowConfidenceCount: number;
  mediumConfidenceCount: number;
  strategyCounts: Partial<Record<RebaseStrategy, number>>;
  readsReused: number;
  resultsCollapsed: number;
  outcomeTransitions: number;
}

import type {
  RebaseConfidence,
  RebaseEvidence,
  RebaseStrategy,
  RebindOutcome,
} from '../services/freshnessJournal';
// Freshness taxonomy types — import for use, re-export for consumers
import type { FreshnessState, FreshnessCause, EngramOrigin, VerifyArtifact, TaskCompleteRecord } from '../services/batch/types';
export type { FreshnessState, FreshnessCause, EngramOrigin, VerifyArtifact, TaskCompleteRecord };
import { canSteerExecution, validateSourceIdentity } from '../services/universalFreshness';
export { canSteerExecution };

// Tracks paths we recently wrote (for same_file_prior_edit cause at reconcile)
const RECENT_ADVANCE_TTL_MS = 10_000;
const recentRevisionAdvances = new Map<string, { cause: FreshnessCause; sessionId?: string; at: number }>();
function recordRevisionAdvanceModule(path: string, cause: FreshnessCause, sessionId?: string): void {
  const norm = path.replace(/\\/g, '/').toLowerCase();
  recentRevisionAdvances.set(norm, { cause, sessionId, at: Date.now() });
  // Prune old entries (collect keys first to avoid mutating Map during iteration)
  const cutoff = Date.now() - RECENT_ADVANCE_TTL_MS;
  const expired: string[] = [];
  for (const [k, v] of recentRevisionAdvances) {
    if (v.at < cutoff) expired.push(k);
  }
  for (const k of expired) recentRevisionAdvances.delete(k);
}
function consumeRevisionAdvanceCause(path: string): FreshnessCause | undefined {
  const norm = path.replace(/\\/g, '/').toLowerCase();
  const entry = recentRevisionAdvances.get(norm);
  if (!entry || entry.at < Date.now() - RECENT_ADVANCE_TTL_MS) return undefined;
  recentRevisionAdvances.delete(norm);
  return entry.cause;
}

// Context chunk (Engram) - a living unit of knowledge in the Cognitive Core
export interface ContextChunk {
  hash: string;        // Full hash (or sync hash)
  shortHash: string;   // First SHORT_HASH_LEN (6) chars for display; see contextHash.ts
  type: ChunkType;     // Granular content type
  source?: string;     // Tool name, file path, command
  sourceRevision?: string; // Source file revision when this engram was created
  viewKind?: EngramViewKind; // latest source view, derived transform, or preserved snapshot
  content: string;     // Full content (or edit-ready digest if compacted)
  tokens: number;      // Estimated token count
  digest?: string;     // Compact summary (symbols/key lines) for recall decisions
  editDigest?: string; // Line-anchored digest for edit targeting (fn name:15-32 | ...)
  summary?: string;    // ~10-token one-liner from structured backend response metadata
  compacted?: boolean; // Content replaced with edit digest; original in archive
  compactTier?: 'pointer' | 'sig'; // pointer = ~7tk stub; sig = ~50-200tk signature
  ttl?: number; // Turns remaining before auto-drop if unpinned; pinned chunks ignore
  suspectSince?: number; // Timestamp when freshness became uncertain after refresh/drift
  suspectKind?: 'content' | 'structural' | 'unknown';
  createdAt: Date;     // For age tracking
  lastAccessed: number; // Timestamp for recency sorting in working memory
  pinned?: boolean;    // Protected from bulk unload
  /** Shape from session.pin (e.g. sig); kept on the chunk so HPP can apply it once the ref exists. */
  pinnedShape?: string;
  subtaskId?: string;  // Which subtask this chunk belongs to (legacy, single)
  subtaskIds?: string[];        // Bound to multiple subtasks (survives until ALL are done)
  boundDuringPlanning?: boolean; // Pre-bound during research/planning phase
  fullHash?: string;            // Back-reference to h:FULL in registry (for shaped chunks)
  referenceCount?: number;      // How many times the model cited this hash
  readCount?: number;           // How many times this file was read into the store
  editCount?: number;           // How many edits targeted this hash
  annotations?: EngramAnnotation[]; // Notes attached to this engram
  synapses?: Synapse[];             // Typed connections to other engrams
  // Freshness taxonomy
  freshness?: FreshnessState;
  freshnessCause?: FreshnessCause;
  baseRevision?: string;
  observedRevision?: string;
  changedSincePinned?: boolean;
  editSessionId?: string;
  origin?: EngramOrigin;
  shapeRecipe?: { lines?: string; shape?: string; sourceRevision?: string; editSessionId?: string };
  lastRebind?: RebindOutcome;
  createdAtRev?: number;
  readSpan?: ReadSpan;
  /** Optional per-file revisions when `source` is comma-joined; avoids full evict if only unrelated paths drifted. */
  compositeSourceRevisions?: Record<string, string>;
  /** Files this chunk semantically depends on (call graphs, analyses, summaries).
   *  1-hop invalidation: when a derivedFromSource changes, this chunk becomes suspect. */
  derivedFromSources?: string[];
  /**
   * Optional marker indicating this full-file engram has been replaced by
   * narrower views (line-range slices or shaped sub-engrams). Populated when
   * follow-up `read_lines` / `read_shaped` slices cover the same source so
   * the hash manifest can hint the old hash is no longer the canonical view.
   *
   * Rendering-only metadata; see {@link HashManifest.formatHashManifest}.
   * Persisted as part of the chunk — old snapshots without this field
   * deserialize with `supersededBy === undefined` (no migration required).
   */
  supersededBy?: {
    /** Short hashes of the replacement slices (up to a small cap). */
    hashes: string[];
    /** Free-form note, e.g. "slices" or "sig+fold". */
    note: string;
  };
}

export interface ReadSpan {
  filePath: string;
  startLine?: number;
  endLine?: number;
  shape?: string;
  sourceRevision: string;
  contextType?: string;
}

export interface AwarenessCacheEntry {
  filePath: string;
  snapshotHash: string;
  level: number; // AwarenessLevel enum value (0=NONE, 1=SHAPED, 2=TARGETED, 3=CANONICAL)
  readRegions: Array<{ start: number; end: number }>;
  shapeHash?: string;
  recordedAt: number;
}

const AWARENESS_CACHE_MAX = 200;

// Pre-bound context entry for a subtask (populated during research/planning)
export interface ContextBinding {
  hash: string;       // h:SHAPED hash in working memory / staged
  source: string;     // File path
  shape: string;      // Shape modifier used (e.g. "sig", "fold")
  tokens: number;     // Shaped token count
  fullHash: string;   // h:FULL in registry for edits
}

// Subtask within a task plan
export interface SubTask {
  id: string;
  title: string;
  status: 'pending' | 'active' | 'done' | 'blocked';
  summary?: string;
  contextManifest?: ContextBinding[]; // Pre-bound context for this subtask
}

// Task directive for AI orientation and context lifecycle
export interface TaskDirective {
  id: string;
  goal: string;
  subtasks: SubTask[];
  activeSubtaskId: string | null;
  status: 'active' | 'blocked' | 'done' | 'superseded' | 'cancelled';
  createdAt: number;
  supersedes?: string;
  retryCount: number;
  evidenceRefs: string[];
  stopReason?: string;
}

// Backward-compatible alias
export type TaskPlan = TaskDirective;

// Legacy type alias for backward compatibility
export type TaskState = TaskPlan;

// Memory search hit — returned by searchMemory full-text grep
export interface MemorySearchHit {
  line: string;
  lineNumber: number;
}

export interface MemorySearchResult {
  region: 'active' | 'archived' | 'dormant' | 'bb' | 'staged' | 'dropped';
  ref: string;
  source?: string;
  type?: string;
  tokens?: number;
  hits: MemorySearchHit[];
}

// Blackboard artifact classification
export type BbArtifactKind = 'plan' | 'bug' | 'repair' | 'status' | 'err' | 'fix' | 'edit' | 'general' | 'summary' | 'fixplan';
export type BbArtifactState = 'active' | 'superseded' | 'historical';

// Blackboard entry - persistent session knowledge
export interface BlackboardEntry {
  content: string;
  createdAt: Date;
  tokens: number;
  derivedFrom?: string[];
  derivedRevisions?: string[];
  kind: BbArtifactKind;
  state: BbArtifactState;
  filePath?: string;
  snapshotHash?: string;
  supersededAt?: number;
  supersededBy?: string;
  updatedAt: number;
}

// BB key prefix -> kind mapping
const BB_KIND_PREFIXES: ReadonlyArray<[string, BbArtifactKind]> = [
  ['plan:', 'plan'],
  ['bugs:', 'bug'],
  ['bug:', 'bug'],
  ['repair:', 'repair'],
  ['status:', 'status'],
  ['err:', 'err'],
  ['fix:', 'fix'],
  ['edit:', 'edit'],
  ['summary:', 'summary'],
  ['fixplan:', 'fixplan'],
];

const BB_SHADOWABLE_KINDS: ReadonlySet<BbArtifactKind> = new Set(['plan', 'bug', 'repair', 'status', 'err', 'fix', 'summary', 'fixplan']);

export function parseBbKey(key: string): { kind: BbArtifactKind; basename?: string } {
  for (const [prefix, kind] of BB_KIND_PREFIXES) {
    if (key.startsWith(prefix)) {
      const rest = key.slice(prefix.length);
      return { kind, basename: rest || undefined };
    }
  }
  return { kind: 'general' };
}

/**
 * Resolve a BB key's file binding. Uses explicit filePath first, then derivedFrom,
 * then attempts basename resolution against the awareness cache.
 */
export function inferBbFilePath(
  key: string,
  derivedFrom?: string[],
  awarenessKeys?: Iterable<string>,
): string | undefined {
  let candidate: string | undefined;
  if (derivedFrom?.length) {
    candidate = derivedFrom[0];
  } else {
    const { basename } = parseBbKey(key);
    if (!basename) return undefined;
    if (basename.includes('/') || basename.includes('\\')) {
      candidate = basename;
    } else if (awarenessKeys) {
      for (const aPath of awarenessKeys) {
        const segments = aPath.split('/');
        const aBase = segments[segments.length - 1];
        if (aBase.toLowerCase() === basename.toLowerCase()) { candidate = aPath; break; }
      }
    }
  }
  return validateSourceIdentity(candidate);
}

// Cognitive rule — self-imposed behavioral constraint written by the model
export interface CognitiveRule {
  content: string;
  createdAt: Date;
  tokens: number;
  scope: 'session';
  filePath?: string;
  createdAtRev?: number;
}

// Max tokens for cognitive rules collectively
const RULES_MAX_TOKENS = 10000;

// Manifest entry for permanently dropped chunks — metadata only, no content
export interface ManifestEntry {
  hash: string;
  shortHash: string;
  type: ChunkType;
  source?: string;
  tokens: number;
  digest?: string;
  droppedAt: number;
  subtaskId?: string;
}

const DROPPED_MANIFEST_MAX = 50;

/** Enforce LRU cap on dropped manifest. Evict oldest entries by droppedAt. */
function capDroppedManifest(manifest: Map<string, ManifestEntry>): Map<string, ManifestEntry> {
  if (manifest.size <= DROPPED_MANIFEST_MAX) return manifest;
  const sorted = Array.from(manifest.entries())
    .sort(([, a], [, b]) => (a.droppedAt || 0) - (b.droppedAt || 0));
  const toRemove = sorted.length - DROPPED_MANIFEST_MAX;
  const capped = new Map(manifest);
  for (let i = 0; i < toRemove; i++) {
    capped.delete(sorted[i][0]);
  }
  return capped;
}

// Summary for context_stats() tool response
export interface ChunkSummary {
  h: string;           // Short hash
  tk: number;          // Tokens
  type: ChunkType;     // Content type
  src?: string;        // Source
  age: string;         // Formatted age
  pinned?: boolean;    // Whether chunk is pinned
  compacted?: boolean; // Whether chunk is compacted
}

// Staged snippet — cached at staged for Anthropic, stable prefix for OpenAI
export interface StagedSnippet {
  content: string;
  source: string;
  lines?: string;
  tokens: number;
  /** Content hash of source file at stage time (for provenance invalidation). */
  sourceRevision?: string;
  /** Whether the staged payload is the latest source view or a derived projection. */
  viewKind?: EngramViewKind;
  /** Structured shape spec (e.g. JSON) for replay-safe auto-refresh. */
  shapeSpec?: string;
  /** Timestamp when staged content may no longer reflect current file state. */
  suspectSince?: number;
  suspectKind?: 'content' | 'structural' | 'unknown';
  admissionClass?: StageAdmissionClass;
  persistencePolicy?: StagePersistencePolicy;
  lastUsedRound?: number;
  lastUsedAt?: number;
  evictionReason?: StageEvictionReason;
  demotedFrom?: StageAdmissionClass;
  /** Freshness taxonomy — explicit cause for stale handling */
  freshness?: FreshnessState;
  freshnessCause?: FreshnessCause;
  baseRevision?: string;
  observedRevision?: string;
  changedSincePinned?: boolean;
  editSessionId?: string;
  origin?: EngramOrigin;
  /** Shape recipe for replay on eviction — lines, shapeSpec, sourceRevision, editSessionId */
  shapeRecipe?: { lines?: string; shape?: string; sourceRevision?: string; editSessionId?: string };
  lastRebind?: RebindOutcome;
  /** Universal freshness stage state — explicit lifecycle for execution gating */
  stageState?: 'current' | 'stale' | 'superseded';
}

// Staged token budgets are split across two modules — not a single soft/hard pair:
// - STAGE_SOFT_CEILING (here): admission-time guidance only; `formatStatsLine` / context stats warn when staged total exceeds this (`contextFormatter.ts`). Staging still succeeds.
// - STAGED_TOTAL_HARD_CAP_TOKENS + STAGED_BUDGET_TOKENS: see `promptMemory.ts` — hard cap enforced in `pruneStagedSnippetsToBudget` at round/relief boundaries; `STAGED_BUDGET_TOKENS` is the prompt-layer planning budget.
export const STAGE_SOFT_CEILING = 25000;
const MAX_MEMORY_EVENTS = 100;

/**
 * Prompt-visible cost for a staged entry whose body is omitted because an
 * active engram already covers the same source. The emitted lines are just
 * the header (`[hash] source:view (Ntk)`) and the "content omitted" marker —
 * roughly 20 tokens — so we charge that against prompt budgets instead of the
 * full `snippet.tokens`. Keeps header totals, CTX lines, and `reconcileBudgets`
 * aligned with what the model actually sees.
 */
export const STAGED_OMITTED_POINTER_TOKENS = 20;

function shouldAutoCompactChunk(chunk: ContextChunk): boolean {
  if (chunk.compacted) return false;
  if (chunk.pinned) return false;
  if (CHAT_TYPES.has(chunk.type)) return false;
  return chunk.type === 'issues'
    || chunk.type === 'symbol'
    || chunk.type === 'deps'
    || chunk.type === 'search'
    || chunk.type === 'analysis';
}

const AUTO_DROP_COMPACTED_STUB_MAX_TOK = 50;

function shouldAutoDropChunk(chunk: ContextChunk): boolean {
  if (chunk.pinned) return false;
  if (CHAT_TYPES.has(chunk.type)) return false;
  if (chunk.type === 'result' || chunk.type === 'call') return true;
  // Auto-drop compacted low-value stubs (search, symbol lookups, dep graphs, batch analysis)
  if (
    chunk.compacted
    && chunk.tokens <= AUTO_DROP_COMPACTED_STUB_MAX_TOK
    && (chunk.type === 'search'
      || chunk.type === 'symbol'
      || chunk.type === 'deps'
      || chunk.type === 'analysis')
  ) {
    return true;
  }
  return false;
}

const TOOL_CHUNK_TYPES: ReadonlySet<string> = new Set(['call', 'result', 'search']);

function pickCompactContent(chunk: ContextChunk, fallback: string): string {
  if (TOOL_CHUNK_TYPES.has(chunk.type)) {
    return chunk.summary || fallback;
  }
  return chunk.editDigest || chunk.digest || chunk.summary || fallback;
}

function pruneLowValueChunks(
  chunks: Map<string, ContextChunk>,
  archivedChunks: Map<string, ContextChunk>,
  options: { skipIfUnderPressure?: boolean; usedTokens?: number; maxTokens?: number } = {},
): {
  chunks: Map<string, ContextChunk>;
  archivedChunks: Map<string, ContextChunk>;
  compacted: string[];
  dropped: string[];
  freedTokens: number;
} {
  if (options.skipIfUnderPressure) {
    const used = options.usedTokens ?? 0;
    const max = options.maxTokens ?? 200000;
    if (used < max * 0.7) {
      return { chunks, archivedChunks, compacted: [], dropped: [], freedTokens: 0 };
    }
  }

  let nextChunks: Map<string, ContextChunk> | null = null;
  let nextArchived: Map<string, ContextChunk> | null = null;
  const compacted: string[] = [];
  const dropped: string[] = [];
  let freedTokens = 0;

  for (const [key, chunk] of chunks) {
    if (shouldAutoDropChunk(chunk)) {
      if (!nextChunks) nextChunks = new Map(chunks);
      if (!nextArchived) nextArchived = new Map(archivedChunks);
      nextChunks.delete(key);
      nextArchived.set(key, chunk);
      dropped.push(chunk.hash);
      freedTokens += chunk.tokens;
      continue;
    }
    if (!chunk.compacted && shouldAutoCompactChunk(chunk)) {
      if (!nextChunks) nextChunks = new Map(chunks);
      if (!nextArchived) nextArchived = new Map(archivedChunks);
      const compactContent = pickCompactContent(chunk, `[compacted] h:${chunk.shortHash}`);
      const compactTokens = countTokensSync(compactContent);
      freedTokens += Math.max(0, chunk.tokens - compactTokens);
      nextArchived.set(key, chunk);
      nextChunks.set(key, {
        ...chunk,
        content: compactContent,
        tokens: compactTokens,
        compacted: true,
        compactTier: chunk.editDigest ? 'sig' : 'pointer',
        lastAccessed: Date.now(),
      });
      compacted.push(chunk.hash);
    }
  }

  return { chunks: nextChunks ?? chunks, archivedChunks: nextArchived ?? archivedChunks, compacted, dropped, freedTokens };
}
let _memoryEventCounter = 0;

function getStagePriority(key: string, snippet: StagedSnippet): number {
  if (snippet.persistencePolicy === 'doNotPersist') return 1;
  if (snippet.admissionClass === 'transientPayload') return 2;
  if (snippet.admissionClass === 'transientAnchor') return 3;
  return 4;
}

function getStageRecency(snippet: StagedSnippet): number {
  return snippet.lastUsedAt ?? 0;
}

/**
 * Returns the set of staged sources that are also covered by an active
 * (materialized, non-compacted) engram — those entries will render as a
 * pointer rather than full content in `getStagedBlock`.
 */
function computeActiveEngramSources(state: ContextStoreState): Set<string> {
  const stagedSources = new Set<string>();
  for (const [, snippet] of state.stagedSnippets) {
    if (snippet.source) stagedSources.add(snippet.source.replace(/\\/g, '/').toLowerCase());
  }
  const activeEngramSources = new Set<string>();
  if (stagedSources.size === 0) return activeEngramSources;
  for (const [, chunk] of state.chunks) {
    if (chunk.compacted || !chunk.source) continue;
    const chunkSourceNorm = chunk.source.replace(/\\/g, '/').toLowerCase();
    if (!stagedSources.has(chunkSourceNorm)) continue;
    const ref = hppGetRef(chunk.hash);
    if (!ref || hppShouldMaterialize(ref)) {
      activeEngramSources.add(chunk.source);
    }
  }
  return activeEngramSources;
}

function emittedTokensForSnippet(snippet: StagedSnippet, activeEngramSources: Set<string>): number {
  if (snippet.source != null && activeEngramSources.has(snippet.source)) {
    return STAGED_OMITTED_POINTER_TOKENS;
  }
  return snippet.tokens;
}

function getPersistentAnchorMetrics(staged: Map<string, StagedSnippet>): { tokens: number; count: number } {
  let tokens = 0;
  let count = 0;
  for (const snippet of staged.values()) {
    if (snippet.admissionClass === 'persistentAnchor') {
      tokens += snippet.tokens;
      count++;
    }
  }
  return { tokens, count };
}

function pruneStagedSnippetsToBudget(
  staged: Map<string, StagedSnippet>,
  reason: StageEvictionReason,
): {
  staged: Map<string, StagedSnippet>;
  freed: number;
  removed: Array<{ key: string; snippet: StagedSnippet }>;
  reliefAction: PromptReliefAction;
} {
  const next = new Map(staged);
  const removed: Array<{ key: string; snippet: StagedSnippet }> = [];
  let freed = 0;

  // Compute running total once instead of re-iterating the Map each check.
  let runningTotal = 0;
  next.forEach((snippet) => { runningTotal += snippet.tokens; });

  // Sort candidates once; iterate in eviction order instead of re-sorting per removal.
  const sortedCandidates = Array.from(next.entries())
    .sort(([keyA, snippetA], [keyB, snippetB]) => {
      const priorityDelta = getStagePriority(keyA, snippetA) - getStagePriority(keyB, snippetB);
      if (priorityDelta !== 0) return priorityDelta;
      const suspectA = snippetA.suspectSince ?? 0;
      const suspectB = snippetB.suspectSince ?? 0;
      if (suspectA !== suspectB) return suspectB - suspectA;
      return getStageRecency(snippetA) - getStageRecency(snippetB);
    });

  const nonPersistentCandidates = sortedCandidates.filter(
    ([, s]) => s.admissionClass !== 'persistentAnchor',
  );

  let anchorMetrics = getPersistentAnchorMetrics(next);
  const anchorOnlyCandidates = sortedCandidates.filter(
    ([, s]) => s.admissionClass === 'persistentAnchor',
  );
  let anchorCandIdx = 0;
  const takeAnchor = (): boolean => {
    while (anchorCandIdx < anchorOnlyCandidates.length) {
      const [key, snippet] = anchorOnlyCandidates[anchorCandIdx++];
      if (!next.has(key)) continue; // already removed
      next.delete(key);
      removed.push({ key, snippet });
      freed += snippet.tokens;
      runningTotal -= snippet.tokens;
      anchorMetrics.tokens -= snippet.tokens;
      anchorMetrics.count--;
      return true;
    }
    return false;
  };

  // 1) Anchor-specific caps first so persistent anchors are not consumed by the global total-cap pass.
  // Anchor token/entry caps apply only to `persistentAnchor` (entry:/edit: keys); `transientAnchor` is bounded mainly by STAGED_TOTAL_HARD_CAP_TOKENS.
  while (anchorMetrics.tokens > STAGED_ANCHOR_BUDGET_TOKENS && takeAnchor()) {
    // takeAnchor updates anchorMetrics inline.
  }
  while (anchorMetrics.count > MAX_PERSISTENT_STAGE_ENTRIES && takeAnchor()) {
    // takeAnchor updates anchorMetrics inline.
  }

  let nonPersistentIdx = 0;
  const takeOneNonPersistent = (): boolean => {
    while (nonPersistentIdx < nonPersistentCandidates.length) {
      const [key, snippet] = nonPersistentCandidates[nonPersistentIdx++];
      if (!next.has(key)) continue;
      next.delete(key);
      removed.push({ key, snippet });
      freed += snippet.tokens;
      runningTotal -= snippet.tokens;
      return true;
    }
    return false;
  };

  const takeOneAnchorOverflow = (): boolean => {
    while (anchorCandIdx < anchorOnlyCandidates.length) {
      const [key, snippet] = anchorOnlyCandidates[anchorCandIdx++];
      if (!next.has(key)) continue;
      next.delete(key);
      removed.push({ key, snippet });
      freed += snippet.tokens;
      runningTotal -= snippet.tokens;
      anchorMetrics.tokens -= snippet.tokens;
      anchorMetrics.count--;
      return true;
    }
    return false;
  };

  // 2) Global total cap: evict non–persistent-anchor entries first.
  while (runningTotal > STAGED_TOTAL_HARD_CAP_TOKENS && takeOneNonPersistent()) {
    // Drain transients / non-persistent until under cap or exhausted.
  }
  // 3) If still over cap, evict persistent anchors only (Step 2 already drained non-anchors).
  while (runningTotal > STAGED_TOTAL_HARD_CAP_TOKENS && takeOneAnchorOverflow()) {
    // Same anchor ordering as sortedCandidates; anchorCandIdx continues after takeAnchor.
  }

  return {
    staged: next,
    freed,
    removed,
    reliefAction: removed.length > 0 ? 'evict_staged' : 'none',
  };
}

function getEstimatedPromptPressureTokens(
  state: ContextStoreState,
  nextChunkTokens = 0,
): number {
  // Prefer the latest round snapshot's full estimate when available — it uses
  // the real async tokenizer on the complete conversation history, matching
  // what the Internals panel shows.  Fall back to the component sum only
  // before the first round snapshot exists.
  if (nextChunkTokens === 0) {
    const latestSnap = useRoundHistoryStore.getState().snapshots.slice(-1)[0];
    if (latestSnap?.estimatedTotalPromptTokens > 0) {
      return latestSnap.estimatedTotalPromptTokens;
    }
  }
  const promptMetrics = _getPromptMetrics();
  const staticSystemTokens = promptMetrics.modePromptTokens
    + promptMetrics.toolRefTokens
    + promptMetrics.shellGuideTokens
    + (promptMetrics.nativeToolTokens ?? 0)
    + promptMetrics.contextControlTokens;
  const bp3Tokens = (promptMetrics.bp3PriorTurnsTokens ?? 0);
  // Use emitted (prompt-visible) staged tokens here — pressure math compares
  // against the actual prompt, which only contains pointer stubs for entries
  // covered by an active engram. `getStagedTokenCount` remains the logical
  // admission quota used by `pruneStagedSnippetsToBudget`.
  const stagedTokens = state.getStagedEmittedTokens();
  return staticSystemTokens
    + bp3Tokens
    + stagedTokens
    + state.getUsedTokens()
    + nextChunkTokens
    + (promptMetrics.workspaceContextTokens ?? 0);
}

// Transition bridge — auto-surfaces archived context after subtask advance
export interface TransitionBridge {
  completedSubtaskId: string;
  summary: string;
  archivedRefs: Array<{ shortHash: string; source?: string; tokens: number }>;
  turnsRemaining: number; // Decremented each streamChat call; removed at 0
  activatedSubtaskId?: string;
  restoredRefs?: Array<{ shortHash: string; source?: string; tokens: number; from: 'staged' | 'archive' }>;
  droppedRefs?: Array<{ shortHash: string; source?: string; guidance: string }>;
}

// Full stats for UI and tools
export interface ContextStats {
  usedTokens: number;      // Currently loaded
  maxTokens: number;       // Model's context window
  freedTokens: number;     // Cumulative freed this session
  chunkCount: number;      // Active chunk count
  chunks: ChunkSummary[];  // Detailed breakdown
  bbTokens: number;        // Blackboard token usage
  bbCount: number;         // Blackboard entry count
  memoryTelemetry: MemoryTelemetrySummary;
}

// Store interface
interface ContextStoreState {
  // State
  chunks: Map<string, ContextChunk>;
  archivedChunks: Map<string, ContextChunk>; // Chunks archived on task_advance (recallable, outside token budget)
  maxTokens: number;
  freedTokens: number;
  lastFreed: number;        // For UI animation
  lastFreedAt: number;      // Timestamp for animation reset
  taskPlan: TaskPlan | null; // Current task plan
  blackboardEntries: Map<string, BlackboardEntry>; // Persistent session knowledge
  droppedManifest: Map<string, ManifestEntry>; // Permanently dropped — metadata only
  stagedSnippets: Map<string, StagedSnippet>;  // Staged cached editor viewport
  stageVersion: number;                        // Incremented on any stage/unstage change
  transitionBridge: TransitionBridge | null;   // Auto-surface after subtask advance (1-2 turns)
  batchMetrics: { toolCalls: number; manageOps: number; hadReads: boolean; hadBbWrite: boolean; hadSubstantiveBbWrite: boolean };
  /** Consecutive agent-loop rounds with batch reads but no BB write (for escalating nudge). */
  batchReadNoBbStreak: number;
  /** Unique file paths touched across all rounds (for coverage-based convergence detection). */
  cumulativeCoveragePaths: Set<string>;
  /** New file paths touched in the current round. */
  roundNewCoverage: number;
  /** Consecutive rounds with zero new coverage and no mutations. */
  coveragePlateauStreak: number;
  /** File paths touched in the current round (accumulated per-step, reset on finishRoundCoverage). */
  _roundCoveragePaths: Set<string>;
  /** Normalized "path|rangeKey" -> read count since last write/BB (circuit breaker). */
  fileReadSpinByPath: Record<string, number>;
  /** Normalized path -> set of rangeKeys seen since last write/BB (for nudge). */
  fileReadSpinRanges: Record<string, string[]>;
  /** Distilled facts for API-only rolling summary (not in chat UI messages) */
  rollingSummary: RollingSummary;
  setRollingSummary: (summary: RollingSummary) => void;
  memoryEvents: MemoryEvent[];
  _roundStartEventIndex: number;

  // Freshness gates — workspace revision tracking
  workspaceRev: number;
  changedFilesSinceRev: Map<number, Set<string>>;
  verifyArtifacts: Map<string, VerifyArtifact>;
  taskCompleteRecord: TaskCompleteRecord | null;
  reconcileStats: ReconcileStats | null;

  // Cross-batch awareness cache — persists read awareness keyed on (filePath, snapshotHash)
  awarenessCache: Map<string, AwarenessCacheEntry>;
  hashStack: string[]; // Ordered stack of recently-produced hashes (newest first, bounded to 50)
  editHashStack: string[]; // Edit-only recency stack for h:$last_edit (undo context)
  readHashStack: string[]; // File-read-only recency stack for h:$last_read
  stageHashStack: string[]; // Stage-only recency stack for h:$last_stage

  // Legacy alias
  task: TaskPlan | null;
  
  // Actions
  addChunk: (content: string, type: ChunkType, source?: string, symbols?: DigestSymbol[], summary?: string, backendHash?: string, opts?: { subtaskIds?: string[]; boundDuringPlanning?: boolean; fullHash?: string; sourceRevision?: string; viewKind?: EngramViewKind; editSessionId?: string; origin?: EngramOrigin; readSpan?: ReadSpan; ttl?: number; compositeSourceRevisions?: Record<string, string>; derivedFromSources?: string[] }) => string;
  findReusableRead: (span: ReadSpan) => string | null;
  touchChunk: (hash: string) => void;
  compactChunks: (hashes: string[], opts?: { confirmWildcard?: boolean; tier?: 'pointer' | 'sig'; sigContentByRef?: Map<string, string> }) => { compacted: number; freedTokens: number };
  unloadChunks: (hashes: string[], opts?: { confirmWildcard?: boolean }) => { freed: number; count: number; pinnedKept: number };
  dropChunks: (hashes: string[], opts?: { confirmWildcard?: boolean }) => { dropped: number; freedTokens: number };
  pinChunks: (hashes: string[], shape?: string) => { count: number; alreadyPinned: number; skippedFullFile: number };
  unpinChunks: (hashes: string[]) => number;
  findPinnedFileEngram: (filePath: string) => string | null;
  registerEditHash: (hash: string, source: string, editSessionId?: string) => { registered: boolean; reason?: string };
  invalidateStaleHashes: (shortHashes: string[]) => number;
  /** Invalidate derived shapes (staged, chunks, bindings) where source matches path and sourceRevision !== currentRevision. */
  invalidateDerivedForPath: (path: string, currentRevision: string) => number;
  /**
   * After tool delete_files: remove chunks, archive, staged snippets, awareness, and supersede BB for those paths
   * so recreated files do not reuse stale hashes or snapshot metadata.
   */
  evictChunksForDeletedPaths: (paths: string[]) => { chunks: number; staged: number };
  reconcileSourceRevision: (path: string, currentRevision: string, cause?: FreshnessCause) => ReconcileStats;
  /** Post-session-restore: reconcile all file-backed engrams against disk, evict deleted paths. Non-blocking. */
  reconcileRestoredSession: () => Promise<{ updated: number; invalidated: number; evicted: number }>;
  /**
   * When bulk revision IPC is unavailable: mark WM/archive/staged suspect and clear awareness
   * so SnapshotTracker and execution gates do not trust stale hashes.
   */
  applyRestoredSessionBlanketSuspect: () => void;
  /** Sweep active/staged/archived chunks, reconcile to current revisions, return stats. Shared by file-watch, preflight, round-end. */
  refreshRoundEnd: (options?: { paths?: string[]; getRevisionForPath?: (path: string) => Promise<string | null>; bulkGetRevisions?: (paths: string[]) => Promise<Map<string, string | null>> }) => Promise<RefreshRoundStats>;
  markEngramsSuspect: (sourcePaths?: string[], cause?: FreshnessCause, suspectKind?: 'content' | 'structural' | 'unknown') => number;
  clearSuspect: (hashRefOrSource: string) => number;
  recordRevisionAdvance: (path: string, newRevision: string, cause: FreshnessCause, editSessionId?: string) => void;
  recordRebindOutcomes: (outcomes: Array<{ ref: string; source?: string } & RebindOutcome>) => void;
  recordMemoryEvent: (event: Omit<MemoryEvent, 'id' | 'at'> & { at?: number }) => void;

  // Task plan actions
  setTaskPlan: (plan: TaskPlan | null) => void;
  advanceSubtask: (subtaskId: string, summary?: string) => { unloaded: number; freedTokens: number; manifest: string };
  getActiveSubtaskId: () => string | null;
  
  // Legacy task setter (redirects to taskPlan)
  setTask: (task: Partial<TaskPlan> | null) => void;
  
  // Blackboard actions
  setBlackboardEntry: (key: string, content: string, opts?: { derivedFrom?: string[]; filePath?: string; snapshotHash?: string }) => { tokens: number; warning?: string };
  getBlackboardEntry: (key: string) => string | null;
  getBlackboardEntryWithMeta: (key: string) => { content: string; derivedFrom?: string[]; derivedRevisions?: string[]; kind: BbArtifactKind; state: BbArtifactState; filePath?: string; snapshotHash?: string; supersededAt?: number; supersededBy?: string } | null;
  removeBlackboardEntry: (key: string) => boolean;
  listBlackboardEntries: () => Array<{ key: string; preview: string; tokens: number; state: BbArtifactState; filePath?: string; supersededBy?: string }>;
  getBlackboardTokenCount: () => number;
  supersedeBlackboardForPath: (path: string, newRevision: string) => number;

  // Cognitive rules — self-imposed behavioral constraints
  cognitiveRules: Map<string, CognitiveRule>;
  setRule: (key: string, content: string) => { tokens: number; warning?: string };
  removeRule: (key: string) => boolean;
  listRules: () => Array<{ key: string; content: string; tokens: number }>;
  getRulesTokenCount: () => number;

  // Engram mutation — annotations, synapses, edit, split, merge
  addAnnotation: (hashRef: string, note: string) => { ok: boolean; id?: string; error?: string };
  addSynapse: (fromRef: string, toRef: string, relation: Synapse['relation']) => { ok: boolean; error?: string };
  /** Normalize annotate.link endpoints: h: refs stay; bare paths map to h:fullHash when a chunk matches. */
  resolveLinkRefToHash: (raw: string) => string;
  retypeChunk: (hashRef: string, newType: ChunkType) => { ok: boolean; error?: string };
  editEngram: (hashRef: string, fields: { content?: string; digest?: string; summary?: string; type?: ChunkType }) => { ok: boolean; newHash?: string; metadataOnly?: boolean; error?: string };
  splitEngram: (hashRef: string, atLine: number) => { ok: boolean; hashes?: [string, string]; error?: string };
  mergeEngrams: (hashRefs: string[], summary?: string) => { ok: boolean; newHash?: string; error?: string };
  
  // Stage actions (staged cached editor viewport)
  stageSnippet: (key: string, content: string, source: string, lines?: string, sourceRevision?: string, shapeSpec?: string, viewKind?: EngramViewKind) => { ok: boolean; tokens: number; error?: string };
  unstageSnippet: (key: string) => { freed: number };
  getStagedBlock: () => string;
  getStagedTokenCount: () => number;
  /**
   * Tokens actually emitted by `getStagedBlock` into the prompt. Entries whose
   * body is omitted because an active engram already covers the source are
   * charged a small fixed pointer cost (see `STAGED_OMITTED_POINTER_TOKENS`)
   * rather than their full `snippet.tokens`. Use this for prompt-budget math
   * and header totals so they match what the model actually sees. Use
   * `getStagedTokenCount` for logical admission/eviction quotas.
   */
  getStagedEmittedTokens: () => number;
  markStagedSnippetsUsed: () => void;
  pruneStagedSnippets: (reason?: StageEvictionReason) => { freed: number; removed: number; reliefAction: PromptReliefAction };
  /** Return staged snippets matching a source path, with fields needed for post-edit content refresh. */
  getStagedSnippetsForRefresh: (sourcePath: string) => Array<{ key: string; source: string; lines?: string; shapeSpec?: string; content: string; sourceRevision?: string; viewKind?: EngramViewKind }>;
  /** Update staged/chunk sourceRevision for a path after an edit completes with a new hash. */
  forwardStagedHash: (sourcePath: string, newRevision: string) => number;
  /** Synchronously rebase staged snippet line numbers after an edit shifts lines. */
  rebaseStagedLineNumbers: (sourcePath: string, lineDelta: number) => number;

  // Freshness gates — workspace revision tracking & artifact management
  bumpWorkspaceRev: (changedPaths?: string[]) => number;
  getCurrentRev: () => number;
  addVerifyArtifact: (artifact: VerifyArtifact) => void;
  invalidateArtifactsForPaths: (paths: string[]) => { verifyStale: number; taskCompleteStale: boolean };
  setTaskCompleteRecord: (record: TaskCompleteRecord) => void;
  getTaskCompleteRecord: () => TaskCompleteRecord | null;
  pruneObsoleteTaskArtifacts: () => { compacted: number; dropped: number; freedTokens: number; };
  assertFreshForClaim: (claim: 'verified' | 'complete', files: string[]) => { ok: boolean; reason?: string };
  downgradeVerifyToStale: (files?: string[]) => number;

  // Cross-batch awareness cache
  getAwareness: (filePath: string) => AwarenessCacheEntry | undefined;
  setAwareness: (entry: AwarenessCacheEntry) => void;
  invalidateAwareness: (filePath: string) => void;
  invalidateAwarenessForPaths: (paths: string[]) => void;
  /** Clear readSpan on chunks matching given paths so findReusableRead won't block re-reads (e.g. after rollback). */
  clearReadSpansForPaths: (paths: string[]) => void;
  /** Clear cross-batch awareness cache without marking engrams suspect (e.g. coarse file_tree_changed). */
  invalidateAllAwarenessCache: () => void;
  getAwarenessCache: () => Map<string, AwarenessCacheEntry>;

  /** Mirrors services/freshnessTelemetry.ts for reactive Internals UI */
  freshnessMirror: {
    fileTreeChangedWithPaths: number;
    fileTreeChangedCoarseNoPaths: number;
    engramsMarkedSuspectFromPaths: number;
    coarseAwarenessOnlyInvalidations: number;
    suspectSkippedDirKeys: number;
    suspectMarkedUnresolvable: number;
    suspectBulkMarkedCoarse: number;
    clearSuspectFullClears: number;
  };
  syncFreshnessMirror: () => void;

  // Cache affinity tracking
  trackReference: (hash: string) => void;
  trackEdit: (hash: string) => void;

  // Round-start cleanup
  clearStaleReconcileStats: () => void;
  pruneHashStacks: () => void;

  // Transition bridge (auto-expires after N turns)
  tickTransitionBridge: () => void;

  // Chunk content retrieval (for recall)
  getChunkForHashRef: (hashRef: string) => { content: string; source?: string; chunkType?: string } | null;
  getChunkContent: (hashRef: string) => string | null;

  // Formatting
  getTaggedContext: () => string;
  getWorkingMemoryFormatted: () => string;
  getStats: () => ContextStats;
  getStatsLine: () => string;
  getTaskLine: () => string;
  setMaxTokens: (max: number) => void;
  resetSession: () => void;
  clearLastFreed: () => void;
  
  // Computed
  getUsedTokens: () => number;
  getStoreTokens: () => number;
  getPromptTokens: () => number;
  compactDormantChunks: () => { compacted: number; freedTokens: number };
  evictStaleDormantChunks: () => { evicted: number; archived: number; dropped: number; freedTokens: number };
  getChunkCount: () => number;
  getPinnedCount: () => number;
  getAllChunks: () => ContextChunk[];

  // Batch compliance tracking
  recordToolCall: () => void;
  recordManageOps: (count: number) => void;
  resetBatchMetrics: () => void;
  getBatchMetrics: () => {
    toolCalls: number;
    manageOps: number;
    hadReads: boolean;
    hadBbWrite: boolean;
    hadSubstantiveBbWrite: boolean;
  };
  recordFileReadSpin: (entries: Array<{ path: string; range?: string }>) => string | null;
  resetFileReadSpin: (scopedPaths?: string[]) => void;
  getPriorReadRanges: (filePath: string) => string[];
  recordCoveragePath: (filePath: string) => void;
  finishRoundCoverage: (hadMutations: boolean) => void;

  // Full-memory grep — searches across all regions (active, archive, dormant, BB, staged, dropped)
  searchMemory: (
    query: string,
    opts?: { regions?: Array<'active' | 'archived' | 'dormant' | 'bb' | 'staged' | 'dropped'>; caseSensitive?: boolean; maxResults?: number }
  ) => MemorySearchResult[];

  // HPP v3 Set-Ref Queries
  queryBySetSelector: (
    selector: SetSelector,
    scope?: 'active' | 'reachable' | 'all'
  ) => { hashes: string[]; entries: HashLookupResult[]; error?: string };
  createSetRefLookup: (scope?: 'active' | 'reachable') => SetRefLookup;

  // HPP v4 Recency Refs (h:59becb / h:59becb-N)
  pushHash: (hash: string) => void;
  resolveRecencyRef: (offset: number) => string | null;

  // HPP v4 Edit recency (h:791290bef81646f4) — tracks edit-store order for undo
  pushEditHash: (hash: string) => void;
  resolveEditRecencyRef: (offset: number) => string | null;

  // HPP v4 Typed recency stacks
  pushReadHash: (hash: string) => void;
  resolveReadRecencyRef: (offset: number) => string | null;
  pushStageHash: (hash: string) => void;
  resolveStageRecencyRef: (offset: number) => string | null;

  activateManifest: (subtaskId: string) => {
    restored: number;
    refs: Array<{ shortHash: string; source?: string; tokens: number; from: 'staged' | 'archive' }>;
    droppedRefs?: Array<{ shortHash: string; source?: string; guidance: string }>;
  };
}

/** Compare two source paths for equivalence (slash-normalized, case-insensitive on Windows). */
function normalizeSourcePath(source: string): string {
  return source.replace(/\\/g, '/').toLowerCase();
}

/** Normalize bulk revision map keys once — keeps bulk index aligned with `paths` from {@link normalizeSourcePath}. */
function buildNormalizedRevisionIndex(
  revisionMap: Map<string, string | null>,
): { index: Map<string, string>; explicitNull: Set<string> } {
  const index = new Map<string, string>();
  const explicitNull = new Set<string>();
  for (const [k, v] of revisionMap) {
    const nk = normalizeSourcePath(k);
    if (v != null) index.set(nk, v);
    else explicitNull.add(nk);
  }
  return { index, explicitNull };
}

function sourcesMatch(a: string, b: string): boolean {
  return normalizeSourcePath(a) === normalizeSourcePath(b);
}

/** Single path or comma-joined paths (legacy composite reads) — used for freshness and delete eviction. */
function sourceTouchesPath(source: string | undefined, path: string): boolean {
  if (!source) return false;
  const pathNorm = normalizeSourcePath(path);
  if (normalizeSourcePath(source) === pathNorm) return true;
  for (const seg of source.split(',')) {
    const t = seg.trim();
    if (!t) continue;
    if (normalizeSourcePath(t) === pathNorm) return true;
  }
  return false;
}

function isExactSourcePathMatch(source: string | undefined, path: string): boolean {
  return !!source && normalizeSourcePath(source) === normalizeSourcePath(path);
}

function compositeRevisionForPath(revMap: Record<string, string> | undefined, path: string): string | undefined {
  if (!revMap) return undefined;
  const pathNorm = normalizeSourcePath(path);
  for (const [k, v] of Object.entries(revMap)) {
    if (normalizeSourcePath(k) === pathNorm) return v;
  }
  return undefined;
}

function isFileBackedType(type: string): boolean {
  return type === 'file' || type === 'smart' || type === 'raw' || type === 'result';
}

/** When restoring a session, only sync sourceRevision to disk if body still hashes to that revision. */
function sessionRestoreBodyMatchesDisk(chunk: ContextChunk, currentRevision: string): boolean {
  if (chunk.compacted) return false;
  if (chunk.type === 'result') return false;
  if (!isFileBackedType(chunk.type)) return false;
  if (!chunk.content) return false;
  const h = hashContentSync(chunk.content);
  return canonicalizeSnapshotHash(h) === canonicalizeSnapshotHash(currentRevision);
}

function stagedRestoreBodyMatchesDisk(snippet: StagedSnippet, currentRevision: string): boolean {
  if (!snippet.content) return false;
  const h = hashContentSync(snippet.content);
  return canonicalizeSnapshotHash(h) === canonicalizeSnapshotHash(currentRevision);
}

/** Mutated by reconcileSourceRevision row helpers (single stats + evict list). */
interface ReconcileSourceRevisionBatch {
  stats: ReconcileStats;
  evictedHashes: string[];
  dormantEvicted: number;
}

/** `working` = chunk lives in the active chunks map; `archived` = chunk is in archivedChunks only. */
function reconcileChunkForSourceRevision(
  surface: 'working' | 'archived',
  path: string,
  currentRevision: string,
  key: string,
  chunk: ContextChunk,
  newChunks: Map<string, ContextChunk>,
  newArchived: Map<string, ContextChunk>,
  effectiveCause: FreshnessCause,
  isSessionRestore: boolean,
  isSameFilePriorEdit: boolean,
  batch: ReconcileSourceRevisionBatch,
): void {
  // 1-hop transitive invalidation: if this chunk depends on the changed path
  // (but isn't directly sourced from it), mark it suspect so stale analysis
  // results don't persist silently after their input files change.
  if (!sourceTouchesPath(chunk.source, path) && chunk.derivedFromSources?.length) {
    const pathNorm = normalizeSourcePath(path);
    const isDerived = chunk.derivedFromSources.some(d => normalizeSourcePath(d) === pathNorm);
    if (isDerived && chunk.freshness !== 'suspect') {
      batch.stats.total++;
      const suspect: ContextChunk = {
        ...chunk,
        observedRevision: currentRevision,
        freshness: 'suspect',
        freshnessCause: effectiveCause,
        suspectSince: chunk.suspectSince ?? Date.now(),
        suspectKind: 'content',
      };
      if (surface === 'working') newChunks.set(key, suspect);
      else newArchived.set(key, suspect);
      batch.stats.updated++;
      return;
    }
  }
  if (!sourceTouchesPath(chunk.source, path)) return;
  batch.stats.total++;
  if (!isExactSourcePathMatch(chunk.source, path)) {
    if (chunk.viewKind === 'snapshot') {
      batch.stats.preserved++;
      return;
    }
    const held = compositeRevisionForPath(chunk.compositeSourceRevisions, path);
    if (held != null && canonicalizeSnapshotHash(held) === canonicalizeSnapshotHash(currentRevision)) {
      batch.stats.preserved++;
      return;
    }
    if (surface === 'working') {
      newChunks.delete(key);
      if (chunk.tokens > DORMANT_ARCHIVE_THRESHOLD) {
        newArchived.set(key, { ...chunk });
      }
    } else {
      newArchived.delete(key);
    }
    batch.stats.invalidated++;
    batch.evictedHashes.push(chunk.hash);
    return;
  }
  if (chunk.viewKind === 'snapshot') {
    batch.stats.preserved++;
    return;
  }
  if (chunk.viewKind === 'derived' && chunk.sourceRevision && chunk.sourceRevision !== currentRevision) {
    if (surface === 'working') {
      newChunks.delete(key);
      if (chunk.tokens > DORMANT_ARCHIVE_THRESHOLD) {
        newArchived.set(key, { ...chunk });
      }
    } else if (chunk.tokens > DORMANT_ARCHIVE_THRESHOLD) {
      newArchived.set(key, {
        ...chunk,
        observedRevision: currentRevision,
        freshness: 'suspect',
        freshnessCause: effectiveCause,
        suspectSince: chunk.suspectSince ?? Date.now(),
      });
    } else {
      newArchived.delete(key);
    }
    batch.stats.invalidated++;
    if (surface === 'working' || chunk.tokens <= DORMANT_ARCHIVE_THRESHOLD) {
      batch.evictedHashes.push(chunk.hash);
    }
    return;
  }
  if (chunk.compacted && !chunk.pinned && chunk.sourceRevision && chunk.sourceRevision !== currentRevision) {
    if (surface === 'working') {
      newChunks.delete(key);
      if (chunk.tokens > DORMANT_ARCHIVE_THRESHOLD) {
        newArchived.set(key, { ...chunk });
      } else {
        newArchived.delete(key);
      }
    } else if (chunk.tokens <= DORMANT_ARCHIVE_THRESHOLD) {
      newArchived.delete(key);
    }
    batch.stats.invalidated++;
    batch.dormantEvicted++;
    batch.evictedHashes.push(chunk.hash);
    return;
  }
  if (
    chunk.compacted &&
    chunk.pinned &&
    chunk.sourceRevision &&
    chunk.sourceRevision !== currentRevision
  ) {
    const stuck: ContextChunk = {
      ...chunk,
      observedRevision: currentRevision,
      freshness: 'suspect',
      freshnessCause: effectiveCause,
      suspectSince: chunk.suspectSince ?? Date.now(),
    };
    if (surface === 'working') newChunks.set(key, stuck);
    else newArchived.set(key, stuck);
    batch.stats.updated++;
    return;
  }
  if (
    isSessionRestore &&
    chunk.sourceRevision &&
    chunk.sourceRevision !== currentRevision &&
    !sessionRestoreBodyMatchesDisk(chunk, currentRevision)
  ) {
    const stuck: ContextChunk = {
      ...chunk,
      observedRevision: currentRevision,
      freshness: 'suspect',
      freshnessCause: 'session_restore',
      suspectSince: chunk.suspectSince ?? Date.now(),
    };
    if (surface === 'working') newChunks.set(key, stuck);
    else newArchived.set(key, stuck);
    batch.stats.updated++;
    return;
  }
  const nextChunk = { ...chunk, sourceRevision: currentRevision, observedRevision: currentRevision };
  delete nextChunk.suspectSince;
  const alreadyFreshFromEdit = isSameFilePriorEdit
    && chunk.origin === 'edit-refresh'
    && chunk.sourceRevision === currentRevision;
  if (isSameFilePriorEdit && !alreadyFreshFromEdit) {
    nextChunk.freshness = 'shifted';
    nextChunk.freshnessCause = effectiveCause;
  } else if (chunk.freshnessCause !== 'ttl_expired') {
    delete nextChunk.freshness;
    delete nextChunk.freshnessCause;
  }
  if (nextChunk.viewKind == null && isFileBackedType(nextChunk.type)) nextChunk.viewKind = 'latest';
  if (surface === 'working') newChunks.set(key, nextChunk);
  else newArchived.set(key, nextChunk);
  batch.stats.updated++;
}

function reconcileWorkingChunkForSourceRevision(
  path: string,
  currentRevision: string,
  key: string,
  chunk: ContextChunk,
  newChunks: Map<string, ContextChunk>,
  newArchived: Map<string, ContextChunk>,
  effectiveCause: FreshnessCause,
  isSessionRestore: boolean,
  isSameFilePriorEdit: boolean,
  batch: ReconcileSourceRevisionBatch,
): void {
  reconcileChunkForSourceRevision(
    'working',
    path,
    currentRevision,
    key,
    chunk,
    newChunks,
    newArchived,
    effectiveCause,
    isSessionRestore,
    isSameFilePriorEdit,
    batch,
  );
}

function reconcileArchivedChunkForSourceRevision(
  path: string,
  currentRevision: string,
  key: string,
  chunk: ContextChunk,
  newArchived: Map<string, ContextChunk>,
  effectiveCause: FreshnessCause,
  isSessionRestore: boolean,
  isSameFilePriorEdit: boolean,
  batch: ReconcileSourceRevisionBatch,
): void {
  const dummyChunks = new Map<string, ContextChunk>();
  reconcileChunkForSourceRevision(
    'archived',
    path,
    currentRevision,
    key,
    chunk,
    dummyChunks,
    newArchived,
    effectiveCause,
    isSessionRestore,
    isSameFilePriorEdit,
    batch,
  );
}

function reconcileStagedSnippetForSourceRevision(
  path: string,
  currentRevision: string,
  key: string,
  snippet: StagedSnippet,
  newStaged: Map<string, StagedSnippet>,
  effectiveCause: FreshnessCause,
  isSessionRestore: boolean,
  isSameFilePriorEdit: boolean,
  batch: ReconcileSourceRevisionBatch,
): void {
  if (!sourceTouchesPath(snippet.source, path)) return;
  batch.stats.total++;
  if (!isExactSourcePathMatch(snippet.source, path)) {
    if (snippet.viewKind === 'snapshot') {
      batch.stats.preserved++;
      return;
    }
    newStaged.delete(key);
    batch.stats.invalidated++;
    return;
  }
  if (snippet.viewKind === 'snapshot') {
    batch.stats.preserved++;
    return;
  }
  if (snippet.viewKind === 'derived' && snippet.sourceRevision && snippet.sourceRevision !== currentRevision) {
    newStaged.delete(key);
    batch.stats.invalidated++;
    return;
  }
  if (
    isSessionRestore &&
    snippet.sourceRevision &&
    snippet.sourceRevision !== currentRevision &&
    !stagedRestoreBodyMatchesDisk(snippet, currentRevision)
  ) {
    const stuck: StagedSnippet = {
      ...snippet,
      observedRevision: currentRevision,
      freshness: 'suspect',
      freshnessCause: 'session_restore',
      suspectSince: snippet.suspectSince ?? Date.now(),
      stageState: 'stale',
    };
    newStaged.set(key, stuck);
    batch.stats.updated++;
    return;
  }
  const nextSnippet = { ...snippet, sourceRevision: currentRevision, observedRevision: currentRevision };
  delete nextSnippet.suspectSince;
  const alreadyFreshFromEdit = isSameFilePriorEdit
    && snippet.origin === 'edit-refresh'
    && snippet.sourceRevision === currentRevision;
  if (isSameFilePriorEdit && !alreadyFreshFromEdit) {
    nextSnippet.freshness = 'shifted';
    nextSnippet.freshnessCause = effectiveCause;
    nextSnippet.stageState = 'stale';
  } else {
    delete nextSnippet.freshness;
    delete nextSnippet.freshnessCause;
    nextSnippet.stageState = 'current';
  }
  if (nextSnippet.viewKind == null) nextSnippet.viewKind = 'latest';
  newStaged.set(key, nextSnippet);
  batch.stats.updated++;
}

function defaultViewKindForChunk(type: string, opts?: { viewKind?: EngramViewKind }): EngramViewKind | undefined {
  if (opts?.viewKind) return opts.viewKind;
  if (type === 'result') return 'derived';
  if (isFileBackedType(type)) return 'latest';
  return undefined;
}

function defaultViewKindForStage(lines?: string, shapeSpec?: string, viewKind?: EngramViewKind): EngramViewKind {
  if (viewKind) return viewKind;
  return lines || shapeSpec ? 'derived' : 'latest';
}

function makeMemoryEvent(event: Omit<MemoryEvent, 'id' | 'at'> & { at?: number }): MemoryEvent {
  const at = event.at ?? Date.now();
  _memoryEventCounter = (_memoryEventCounter + 1) % Number.MAX_SAFE_INTEGER;
  return {
    id: `mem_${at.toString(36)}_${_memoryEventCounter.toString(36)}`,
    at,
    action: event.action,
    reason: event.reason,
    ...(event.refs?.length ? { refs: event.refs } : {}),
    ...(event.source ? { source: event.source } : {}),
    ...(event.oldRevision ? { oldRevision: event.oldRevision } : {}),
    ...(event.newRevision ? { newRevision: event.newRevision } : {}),
    ...(event.freedTokens != null ? { freedTokens: event.freedTokens } : {}),
    ...(event.pressurePct != null ? { pressurePct: event.pressurePct } : {}),
    ...(event.confidence ? { confidence: event.confidence } : {}),
    ...(event.strategy ? { strategy: event.strategy } : {}),
    ...(event.factors?.length ? { factors: event.factors } : {}),
  };
}

function appendMemoryEvent(events: MemoryEvent[], event: Omit<MemoryEvent, 'id' | 'at'> & { at?: number }): MemoryEvent[] {
  const nextEvent = makeMemoryEvent(event);
  if (events.length < MAX_MEMORY_EVENTS) {
    const next = events.slice();
    next.push(nextEvent);
    return next;
  }
  // Bounded: drop oldest, avoid full copy via slice(1) + push
  const next = events.slice(1);
  next.push(nextEvent);
  return next;
}

let _getRetentionMetrics: () => { readsReused: number; resultsCollapsed: number; transitionsRecorded: number } = () => ({ readsReused: 0, resultsCollapsed: 0, transitionsRecorded: 0 });
export function setRetentionMetricsAccessor(fn: () => { readsReused: number; resultsCollapsed: number; transitionsRecorded: number }): void { _getRetentionMetrics = fn; }

let _resetRetention: () => void = () => {};
export function setRetentionResetAccessor(fn: () => void): void { _resetRetention = fn; }

function summarizeMemoryTelemetry(events: MemoryEvent[]): MemoryTelemetrySummary {
  const retentionMetrics = _getRetentionMetrics();

  const summary: MemoryTelemetrySummary = {
    eventCount: events.length,
    blockCount: 0,
    retryCount: 0,
    rebindCount: 0,
    lowConfidenceCount: 0,
    mediumConfidenceCount: 0,
    strategyCounts: {},
    readsReused: retentionMetrics.readsReused,
    resultsCollapsed: retentionMetrics.resultsCollapsed,
    outcomeTransitions: retentionMetrics.transitionsRecorded,
  };

  for (const event of events) {
    if (event.action === 'block') summary.blockCount++;
    if (event.action === 'retry') summary.retryCount++;
    if (event.strategy && event.strategy !== 'fresh') {
      summary.rebindCount++;
      summary.strategyCounts[event.strategy] = (summary.strategyCounts[event.strategy] ?? 0) + 1;
    }
    if (event.confidence === 'low') summary.lowConfidenceCount++;
    if (event.confidence === 'medium') summary.mediumConfidenceCount++;
  }

  return summary;
}

function sourceMatchesTargets(source: string | undefined, targets?: string[]): boolean {
  if (!source) return false;
  if (!targets || targets.length === 0) return true;
  const normalizedSource = normalizeSourcePath(source);
  return targets.some((target) => normalizedSource === normalizeSourcePath(target));
}

/**
 * Extract base hash from a ref (strips h: prefix and shape suffix).
 * h:XXXX:15-50 → XXXX, h:XXXX:fn(name) → XXXX, h:XXXX → XXXX
 */
function refToBaseHash(ref: string): string {
  const rest = ref.startsWith('h:') ? ref.slice(2) : ref;
  return rest.includes(':') ? rest.split(':')[0]! : rest;
}

/**
 * Find a chunk by hash reference (full hash, shortHash, prefix, or shaped ref).
 * Accepts h: prefix and shaped refs (e.g. "h:c16fb6b8:15-50") — normalizes to base hash for lookup.
 * Prefix matching requires MIN_PREFIX_LEN chars to reduce collision risk.
 * Returns [mapKey, chunk] tuple or null if not found.
 * @param strict — when true, disables prefix matching (exact key/shortHash only)
 *
 * Namespace: h:bb:X is reserved for blackboard; never resolved here.
 */
// Reverse index: shortHash → full map keys (multiple chunks may share a 6-char prefix). Rebuilt lazily.
let _shortHashIndex: Map<string, string[]> | null = null;
let _shortHashIndexChunksRef: Map<string, unknown> | null = null;

function getShortHashIndex(chunks: Map<string, { hash: string; shortHash: string }>): Map<string, string[]> {
  // Cache is valid if it was built from the same Map reference (identity check)
  // AND the size hasn't changed. Zustand creates new Map refs on mutation,
  // so identity + size is a reliable invalidation signal.
  if (_shortHashIndex && _shortHashIndexChunksRef === chunks && _shortHashIndex.size > 0) {
    return _shortHashIndex;
  }
  _shortHashIndex = new Map();
  _shortHashIndexChunksRef = chunks as Map<string, unknown>;
  for (const [key, chunk] of chunks) {
    const sh = chunk.shortHash;
    const arr = _shortHashIndex.get(sh);
    if (arr) arr.push(key);
    else _shortHashIndex.set(sh, [key]);
  }
  return _shortHashIndex;
}

function invalidateShortHashIndex(): void {
  _shortHashIndex = null;
  _shortHashIndexChunksRef = null;
}

// Reverse index: shortHash → staged map key (same pattern as getShortHashIndex).
let _stagedShortHashIndex: Map<string, string[]> | null = null;
let _stagedShortHashIndexRef: Map<string, StagedSnippet> | null = null;

function getStagedShortHashIndex(staged: Map<string, StagedSnippet>): Map<string, string[]> {
  if (
    _stagedShortHashIndex
    && _stagedShortHashIndexRef === staged
    && _stagedShortHashIndex.size > 0
  ) {
    return _stagedShortHashIndex;
  }
  _stagedShortHashIndex = new Map();
  _stagedShortHashIndexRef = staged;
  for (const [key] of staged) {
    const keyBase = refToBaseHash(key.startsWith('h:') ? key : `h:${key}`);
    const short = keyBase.slice(0, SHORT_HASH_LEN);
    const arr = _stagedShortHashIndex.get(short);
    if (arr) arr.push(key);
    else _stagedShortHashIndex.set(short, [key]);
  }
  return _stagedShortHashIndex;
}

function findChunkByRef<T extends { hash: string; shortHash: string }>(
  chunks: Map<string, T>,
  ref: string,
  opts?: { strict?: boolean }
): [string, T] | null {
  if (ref.startsWith('h:bb:') || ref.startsWith('bb:')) return null;
  const normalized = refToBaseHash(ref);

  // 1. Exact map key lookup (fastest path)
  const direct = chunks.get(normalized);
  if (direct) return [normalized, direct];

  // 2. O(1) shortHash lookup when exactly one chunk has this 6-char prefix
  if (normalized.length === SHORT_HASH_LEN) {
    const shortIdx = getShortHashIndex(chunks as Map<string, { hash: string; shortHash: string }>);
    const keysAt = shortIdx.get(normalized);
    if (keysAt?.length === 1) {
      const fullKey = keysAt[0];
      const chunk = chunks.get(fullKey);
      if (chunk) return [fullKey, chunk];
    }
    if (keysAt && keysAt.length > 1) {
      return null;
    }
  }

  // 3. Prefix match — unique match only (no arbitrary tie-break on collision)
  if (!opts?.strict && normalized.length >= MIN_PREFIX_LEN) {
    const matches: [string, T][] = [];
    for (const [key, chunk] of chunks) {
      if (key.startsWith(normalized) || chunk.hash.startsWith(normalized)) {
        matches.push([key, chunk]);
      }
    }
    if (matches.length === 1) return matches[0];
    return null;
  }

  return null;
}

/**
 * Search stagedSnippets by hash ref (short hash key, prefix, or shaped ref).
 * Prefix matching requires MIN_PREFIX_LEN chars. Returns [stageKey, snippet] or null.
 */
function findStagedByRef(staged: Map<string, StagedSnippet>, ref: string): [string, StagedSnippet] | null {
  const normalized = ref.startsWith('h:') ? ref.slice(2) : ref;
  const baseHash = refToBaseHash(ref);
  for (const candidate of [ref, normalized, baseHash, `h:${baseHash}`]) {
    const snippet = staged.get(candidate);
    if (snippet) return [candidate, snippet];
  }
  if (baseHash.length >= SHORT_HASH_LEN) {
    const shortIdx = getStagedShortHashIndex(staged);
    const pref = baseHash.slice(0, SHORT_HASH_LEN);
    const keysAt = shortIdx.get(pref);
    if (keysAt?.length === 1) {
      const indexedKey = keysAt[0];
      const snippet = staged.get(indexedKey);
      if (snippet) return [indexedKey, snippet];
    }
    if (keysAt && keysAt.length > 1 && baseHash.length === SHORT_HASH_LEN) {
      return null;
    }
  }
  const matches: [string, StagedSnippet][] = [];
  for (const [key, snippet] of staged) {
    const keyBase = refToBaseHash(key.startsWith('h:') ? key : `h:${key}`);
    if (keyBase === baseHash) return [key, snippet];
    if (baseHash.length >= MIN_PREFIX_LEN && keyBase.startsWith(baseHash)) {
      matches.push([key, snippet]);
    }
  }
  if (matches.length === 1) return matches[0];
  return null;
}

/**
 * Promote a StagedSnippet to a full ContextChunk in the chunks map.
 * If already promoted (same content hash exists), returns the existing
 * chunk to preserve enrichments (annotations, synapses) from prior mutations.
 */
function promoteStagedToChunk(
  stageKey: string,
  snippet: StagedSnippet,
  chunksMap: Map<string, ContextChunk>,
): [string, ContextChunk] {
  const hash = hashContentSync(snippet.content);
  const existing = chunksMap.get(hash);
  if (existing) return [hash, existing];
  const chunk: ContextChunk = {
    hash,
    shortHash: hash.slice(0, SHORT_HASH_LEN),
    type: 'smart',
    content: snippet.content,
    tokens: snippet.tokens,
    source: snippet.source,
    sourceRevision: snippet.sourceRevision,
    viewKind: snippet.viewKind,
    suspectSince: snippet.suspectSince,
    freshness: snippet.freshness,
    freshnessCause: snippet.freshnessCause,
    observedRevision: snippet.observedRevision,
    origin: snippet.origin,
    createdAt: new Date(),
    lastAccessed: Date.now(),
    lastRebind: snippet.lastRebind,
  };
  chunksMap.set(hash, chunk);
  return [hash, chunk];
}

/**
 * Unified engram lookup: chunks → archivedChunks → stagedSnippets.
 * When found in archive or staged, promotes into chunksMap so callers
 * can mutate the returned chunk via the same map reference.
 *
 * Promotion is as-is: callers should run invalidateStaleHashes /
 * invalidateDerivedForPath before ref use when source may have changed.
 * Chunks without sourceRevision are not evicted by path invalidation.
 */
function findOrPromoteEngram(
  ref: string,
  chunksMap: Map<string, ContextChunk>,
  archivedChunks: Map<string, ContextChunk>,
  stagedSnippets: Map<string, StagedSnippet>,
): [string, ContextChunk] | null {
  const found = findChunkByRef(chunksMap, ref);
  if (found) return found;

  // Transparent forward-map resolution: if ref matches a forwarded hash, retry with the new hash
  const bareRef = ref.startsWith('h:') ? ref.slice(2) : ref;
  const forwarded = manifestResolveForward(bareRef.slice(0, SHORT_HASH_LEN));
  if (forwarded) {
    const resolved = findChunkByRef(chunksMap, forwarded);
    if (resolved) return resolved;
  }

  const archived = findChunkByRef(archivedChunks, ref);
  if (archived) {
    const [, arc] = archived;
    const promoted: ContextChunk = { ...arc, lastAccessed: Date.now() };
    if (promoted.source && isFileBackedType(promoted.type) && promoted.sourceRevision) {
      const awareness = useContextStore.getState().getAwareness(promoted.source);
      if (awareness && awareness.snapshotHash !== promoted.sourceRevision) {
        promoted.suspectSince = Date.now();
        promoted.freshness = 'suspect' as FreshnessState;
        promoted.freshnessCause = 'unknown' as FreshnessCause;
      }
    }
    chunksMap.set(promoted.hash, promoted);
    hppMaterialize(promoted.hash, promoted.type, promoted.source, promoted.tokens, (promoted.content.match(/\n/g) || []).length + 1, promoted.editDigest || promoted.digest || '', promoted.shortHash);
    return [promoted.hash, chunksMap.get(promoted.hash)!];
  }

  const staged = findStagedByRef(stagedSnippets, ref);
  if (staged) {
    return promoteStagedToChunk(staged[0], staged[1], chunksMap);
  }

  return null;
}

/** Check droppedManifest for an evicted engram by ref (hash or shortHash). */
function findInDroppedManifest(ref: string, manifest: Map<string, ManifestEntry>): ManifestEntry | null {
  const normalized = refToBaseHash(ref);
  const direct = manifest.get(normalized);
  if (direct) return direct;
  for (const entry of manifest.values()) {
    if (entry.shortHash === normalized) return entry;
  }
  return null;
}

// Adaptive chat protection: scale protected count based on context pressure
const CHAT_PROTECTION_FLOOR = 6;    // always protected regardless of pressure
const CHAT_PROTECTION_CEILING = 20; // max protected when pressure is low

export function getAdaptiveChatProtectionCount(usedTokens: number, maxTokens: number): number {
  if (maxTokens <= 0) return CHAT_PROTECTION_FLOOR;
  const pressure = usedTokens / maxTokens;
  if (pressure >= 0.70) return CHAT_PROTECTION_FLOOR;
  if (pressure <= 0.40) return CHAT_PROTECTION_CEILING;
  const t = (pressure - 0.40) / 0.30;
  return Math.round(CHAT_PROTECTION_CEILING - t * (CHAT_PROTECTION_CEILING - CHAT_PROTECTION_FLOOR));
}

// Monotonic counter for hash collision disambiguation (safe across same-ms adds)
let _collisionCounter = 0;

// Re-entrancy guard: prevents concurrent addChunk calls from both running auto-management
let _autoManageInProgress = false;

// When a caller skips eviction due to guard, set this so we re-run after current eviction finishes
let _autoManagePending = false;

// ---------------------------------------------------------------------------
// BB Templates — seeded on session init, exempt from BB budget
// ---------------------------------------------------------------------------

const BB_TEMPLATES: ReadonlyArray<readonly [string, string]> = [
  ['tpl:analysis', `## Analysis: {title}
**Summary:** {summary}
### Findings
- {severity} | {h:ref} | {description}
### Recommendations
- {recommendation}`],
  ['tpl:refactor', `## Refactor: {symbol}
**From:** {h:source_ref}
**Blast radius:** {files_touched} files, {ref_count} references
### Proposed Changes
1. {change} → {h:ref}
### Risk Assessment
- {risk}`],
  ['tpl:task', `## Task: {subtask_name}
**Changed:** {files_list}
**Decisions:** {decisions}
**Open:** {questions}`],
  ['tpl:diff', `## Change: {title}
**Diff:** {h:OLD..h:NEW}
**Rationale:** {why}
**Side effects:** {effects}`],
  ['tpl:issue', `## Issue: {error_summary}
**Location:** {h:ref}
**Root cause:** {cause}
**Fix:** {h:fix_ref}`],
  ['tpl:scope', `## Scope: {session_goal}
### Decisions
- {decision}: {rationale}
### Open
- {question}
### Done
- {completed_item}`],
  ['tpl:status', `## Status: {phase}
**Progress:** {progress}
**Current:** {current_action}
**Next:** {next_step}`],
  ['tpl:complete', `## Task Complete
**Summary:** {summary}
**Files Changed:** {files_list}`],
] as const;

/**
 * Value-weighted archive eviction score. Lower score = evicted first.
 * Combines recency, edit involvement, reference density, and token cost
 * so high-signal chunks survive longer than stale bulk results.
 */
function archiveEvictionWeight(chunk: ContextChunk, now: number): number {
  // Recency base: 0-1 range over a 30-minute window
  const recencyMs = Math.max(0, now - chunk.lastAccessed);
  const recency = Math.max(0, 1 - recencyMs / (30 * 60 * 1000));

  let bonus = 0;
  if (chunk.origin === 'edit' || chunk.origin === 'edit-refresh') bonus += 2.0;
  if ((chunk.editCount ?? 0) > 0) bonus += 1.5;
  if (chunk.type === 'issues' || chunk.type === 'exec:out') bonus += 1.0;
  if (chunk.pinned) bonus += 1.0;
  const refs = (chunk.referenceCount ?? 0) + (chunk.readCount ?? 0);
  if (refs > 0) bonus += Math.min(1.5, refs * 0.3);

  // Cost-normalize: prefer keeping small high-value chunks over large low-value ones
  const tokens = Math.max(1, chunk.tokens);
  return (recency + bonus) / tokens;
}

/**
 * Evict archived chunks by value weight until total archived tokens <= ARCHIVE_MAX_TOKENS.
 * Returns the (potentially trimmed) archive map. Call after any operation that adds to archive.
 */
function evictArchiveIfNeeded(archive: Map<string, ContextChunk>): Map<string, ContextChunk> {
  const snapshot = Array.from(archive.entries());
  let totalTokens = 0;
  for (const [, c] of snapshot) totalTokens += c.tokens;
  if (totalTokens <= ARCHIVE_MAX_TOKENS) return archive;

  const now = Date.now();
  const sorted = snapshot.sort(([, a], [, b]) => archiveEvictionWeight(a, now) - archiveEvictionWeight(b, now));
  const out = new Map(archive);

  for (const [key, chunk] of sorted) {
    if (totalTokens <= ARCHIVE_MAX_TOKENS) break;
    totalTokens -= chunk.tokens;
    out.delete(key);
    hppEvict(chunk.hash);
  }
  return out;
}

/** Pass 2 auto-manage gate: chunk-layer pressure vs maxTokens, adjusted for staged tokens freed in Pass 1. */
export function autoManagePass2ChunkPressureExceedsGate(
  currentUsed: number,
  incomingTokens: number,
  stagedReliefFreed: number,
  maxTokens: number,
): boolean {
  return currentUsed + incomingTokens - stagedReliefFreed > maxTokens * 0.90;
}

const CHAT_TYPES = new Set(['msg:user', 'msg:asst']);

/** Collect + sort chat chunks once (expensive part). Reuse across multiple adaptive-count slices. */
function getSortedChatEntries(chunks: Map<string, ContextChunk>): Array<[string, ContextChunk]> {
  const out: Array<[string, ContextChunk]> = [];
  for (const entry of chunks.entries()) {
    if (CHAT_TYPES.has(entry[1].type)) out.push(entry);
  }
  out.sort(([, a], [, b]) => b.createdAt.getTime() - a.createdAt.getTime());
  return out;
}

/** Build protected hash set from a pre-sorted chat list (cheap — just a slice). */
function buildProtectedChatHashes(
  sortedChat: Array<[string, ContextChunk]>,
  usedTokens: number,
  maxTokens: number,
): { hashes: Set<string>; protectedCount: number } {
  const count = getAdaptiveChatProtectionCount(usedTokens, maxTokens);
  const hashes = new Set<string>();
  const protectedCount = Math.min(count, sortedChat.length);
  for (let i = 0; i < protectedCount; i++) {
    const [key, chunk] = sortedChat[i];
    hashes.add(key);
    hashes.add(chunk.hash);
    hashes.add(chunk.shortHash);
  }
  return { hashes, protectedCount };
}

/** Convenience wrapper preserving the original API for callers outside addChunk. */
function getProtectedChatHashes(
  chunks: Map<string, ContextChunk>,
  usedTokens: number,
  maxTokens: number,
): { hashes: Set<string>; protectedCount: number } {
  return buildProtectedChatHashes(getSortedChatEntries(chunks), usedTokens, maxTokens);
}

/**
 * Build tiered eviction candidate list: tier1 (completed-subtask non-chat) →
 * tier2 (other non-chat) → tier3 (unprotected chat), each sorted by lastAccessed asc.
 */
function buildTieredEvictionCandidates(
  entries: Iterable<[string, ContextChunk]>,
  protectedChat: Set<string>,
  completedSubtaskIds: Set<string>,
  undoProtectedHashes: Set<string>,
): Array<[string, ContextChunk]> {
  const isProtected = (h: string, c: ContextChunk) =>
    c.pinned
    || undoProtectedHashes.has(h) || undoProtectedHashes.has(c.shortHash)
    || protectedChat.has(h) || protectedChat.has(c.hash) || protectedChat.has(c.shortHash);

  const isCompletedSubtask = (c: ContextChunk) => {
    const ids = c.subtaskIds?.length ? c.subtaskIds : c.subtaskId ? [c.subtaskId] : [];
    return ids.length > 0 && ids.every(id => completedSubtaskIds.has(id));
  };

  const isChatChunk = (c: ContextChunk) => CHAT_TYPES.has(c.type);
  const byAccess = ([, a]: [string, ContextChunk], [, b]: [string, ContextChunk]) => a.lastAccessed - b.lastAccessed;

  const tier1: Array<[string, ContextChunk]> = [];
  const tier2: Array<[string, ContextChunk]> = [];
  const tier3: Array<[string, ContextChunk]> = [];

  for (const entry of entries) {
    const [h, c] = entry;
    if (isProtected(h, c)) continue;
    // Completed subtask: evict tool/output chunks first; include chat so scrollback does not crowd WM.
    if (isCompletedSubtask(c)) tier1.push(entry);
    else if (!isChatChunk(c)) tier2.push(entry);
    else tier3.push(entry);
  }

  tier1.sort(byAccess);
  tier2.sort(byAccess);
  tier3.sort(byAccess);

  return [...tier1, ...tier2, ...tier3];
}

export const useContextStore = create<ContextStoreState>()(
  (set, get) => ({
  chunks: new Map(),
  archivedChunks: new Map(),
  maxTokens: 200000,  // Default to Claude's context
  freedTokens: 0,
  lastFreed: 0,
  lastFreedAt: 0,
  taskPlan: null,
  task: null, // Legacy alias — kept in sync with taskPlan by setTask/setTaskPlan
  blackboardEntries: new Map(),
  cognitiveRules: new Map(),
  droppedManifest: new Map(),
  stagedSnippets: new Map(),
  stageVersion: 0,
  transitionBridge: null,
  batchMetrics: { toolCalls: 0, manageOps: 0, hadReads: false, hadBbWrite: false, hadSubstantiveBbWrite: false },
  batchReadNoBbStreak: 0,
  cumulativeCoveragePaths: new Set<string>(),
  roundNewCoverage: 0,
  coveragePlateauStreak: 0,
  _roundCoveragePaths: new Set<string>(),
  fileReadSpinByPath: {},
  fileReadSpinRanges: {},
  rollingSummary: emptyRollingSummary(),
  setRollingSummary: (summary) => set({ rollingSummary: summary }),
  memoryEvents: [],
  _roundStartEventIndex: 0,
  reconcileStats: null,
  hashStack: [] as string[],
  editHashStack: [] as string[],
  readHashStack: [] as string[],
  stageHashStack: [] as string[],

  // Freshness gates
  workspaceRev: 0,
  changedFilesSinceRev: new Map(),
  verifyArtifacts: new Map(),
  taskCompleteRecord: null,
  awarenessCache: new Map(),
  freshnessMirror: {
    fileTreeChangedWithPaths: 0,
    fileTreeChangedCoarseNoPaths: 0,
    engramsMarkedSuspectFromPaths: 0,
    coarseAwarenessOnlyInvalidations: 0,
    suspectSkippedDirKeys: 0,
    suspectMarkedUnresolvable: 0,
    suspectBulkMarkedCoarse: 0,
    clearSuspectFullClears: 0,
  },
  syncFreshnessMirror: () => set({
    freshnessMirror: {
      fileTreeChangedWithPaths: freshnessTelemetry.fileTreeChangedWithPaths,
      fileTreeChangedCoarseNoPaths: freshnessTelemetry.fileTreeChangedCoarseNoPaths,
      engramsMarkedSuspectFromPaths: freshnessTelemetry.engramsMarkedSuspectFromPaths,
      coarseAwarenessOnlyInvalidations: freshnessTelemetry.coarseAwarenessOnlyInvalidations,
      suspectSkippedDirKeys: freshnessTelemetry.suspectSkippedDirKeys,
      suspectMarkedUnresolvable: freshnessTelemetry.suspectMarkedUnresolvable,
      suspectBulkMarkedCoarse: freshnessTelemetry.suspectBulkMarkedCoarse,
      clearSuspectFullClears: freshnessTelemetry.clearSuspectFullClears,
    },
  }),

  /**
   * Add a new chunk to the context.
   * Uses full 16-char hash as Map key for collision resistance.
   * Tags chunk with current activeSubtaskId.
   * Returns the shortHash for display/reference.
   */
  addChunk: (content: string, type: ChunkType, source?: string, symbols?: DigestSymbol[], summary?: string, backendHash?: string, opts?: { subtaskIds?: string[]; boundDuringPlanning?: boolean; fullHash?: string; sourceRevision?: string; viewKind?: EngramViewKind; editSessionId?: string; origin?: EngramOrigin; readSpan?: ReadSpan; ttl?: number; compositeSourceRevisions?: Record<string, string>; derivedFromSources?: string[] }) => {
    const hash = backendHash || hashContentSync(content);
    const shortHash = hash.slice(0, SHORT_HASH_LEN);
    const tokens = countTokensSync(content);
    const now = Date.now();
    const activeSubtaskId = get().taskPlan?.activeSubtaskId || undefined;
    const digest = generateDigest(content, type, symbols) || undefined;
    const isFileType = type === 'file' || type === 'smart' || type === 'raw';
    const editDigest = isFileType
      ? generateEditReadyDigest(content, type, symbols) || undefined
      : undefined;
    const autoCompactedHashes: string[] = [];
    const autoEvictedHashes: string[] = [];
    
    // Resolve subtask binding: explicit subtaskIds > legacy activeSubtaskId
    const resolvedSubtaskIds = opts?.subtaskIds?.length
      ? opts.subtaskIds
      : activeSubtaskId ? [activeSubtaskId] : undefined;
    
    const chunk: ContextChunk = {
      hash,
      shortHash,
      type,
      source,
      sourceRevision: opts?.sourceRevision,
      baseRevision: opts?.sourceRevision,
      observedRevision: opts?.sourceRevision,
      viewKind: defaultViewKindForChunk(type, opts),
      content,
      tokens,
      digest,
      editDigest,
      summary,
      createdAt: new Date(),
      lastAccessed: now,
      createdAtRev: get().workspaceRev,
      subtaskId: resolvedSubtaskIds?.[0],
      subtaskIds: resolvedSubtaskIds,
      boundDuringPlanning: opts?.boundDuringPlanning,
      fullHash: opts?.fullHash,
      editSessionId: opts?.editSessionId,
      origin: opts?.origin ?? 'read',
      freshness: 'fresh',
      readSpan: opts?.readSpan,
      ...(opts?.compositeSourceRevisions ? { compositeSourceRevisions: { ...opts.compositeSourceRevisions } } : {}),
      ...(opts?.derivedFromSources?.length ? { derivedFromSources: [...opts.derivedFromSources] } : {}),
      ttl: opts?.ttl ?? (type === 'result' ? 3 : type === 'search' ? 5 : undefined),
    };

    let collisionReturnShort: string | undefined;
    let tokenMapKeyForReconcile = hash;
    let tokenExpectedHashForReconcile = hash;
    set(state => {
      const newChunks = new Map(state.chunks);
      let newArchive: Map<string, ContextChunk> | undefined;
      
      // Check for hash collision with different content across all collections
      const existingActive = newChunks.get(hash);
      const existingArchived = state.archivedChunks.get(hash);
      const existingStaged = state.stagedSnippets.get(hash);
      const collisionContent =
        (existingActive && existingActive.content !== content) ? existingActive.content :
        (existingArchived && existingArchived.content !== content) ? existingArchived.content :
        (existingStaged && existingStaged.content !== content) ? existingStaged.content :
        undefined;
      if (collisionContent !== undefined) {
        const suffix = (++_collisionCounter).toString(36);
        const disambiguated = hash + '_' + suffix;
        const disambiguatedShort = hashContentSync(disambiguated).slice(0, SHORT_HASH_LEN);
        collisionReturnShort = disambiguatedShort;
        tokenMapKeyForReconcile = disambiguated;
        tokenExpectedHashForReconcile = disambiguated;
        newChunks.set(disambiguated, { ...chunk, hash: disambiguated, shortHash: disambiguatedShort });
        return { chunks: newChunks };
      }

      // Hash forwarding: auto-compress previous version of the same file.
      // When a file-sourced chunk is re-read/re-edited, the old chunk is
      // immediately compressed to its digest. One full-content chunk per path.
      // Already-compacted stubs for the same source are evicted when a new
      // full "latest" read supersedes them.
      const incomingViewKind = chunk.viewKind ?? defaultViewKindForChunk(type);
      const incomingIsLatest = incomingViewKind === 'latest' || incomingViewKind == null;
      if (source && isFileBackedType(type) && incomingIsLatest) {
        for (const [key, c] of newChunks) {
          if (key === hash) continue;
          if (!c.source || !sourcesMatch(c.source, source) || !isFileBackedType(c.type)) continue;
          if (c.viewKind === 'snapshot' || c.viewKind === 'derived') continue;

          if (c.compacted) {
            if (!c.pinned) {
              newChunks.delete(key);
              if (!newArchive) newArchive = new Map(state.archivedChunks);
              newArchive.set(key, { ...c });
              autoEvictedHashes.push(c.hash);
            }
            chunk.readCount = Math.max(chunk.readCount ?? 0, (c.readCount || 0) + 1);
          } else {
            const compactContent = pickCompactContent(c, `[forwarded] h:${c.shortHash} → h:${shortHash}`);
            const digestTokens = countTokensSync(compactContent);
            newChunks.set(key, {
              ...c,
              content: compactContent,
              tokens: digestTokens,
              compacted: true,
              pinned: false,
              pinnedShape: undefined,
              suspectSince: undefined,
              freshness: undefined,
              freshnessCause: undefined,
              suspectKind: undefined,
            });
            autoCompactedHashes.push(c.hash);
            manifestRecordForwarding(c.shortHash, shortHash, source || '', 'hash_forward', hppGetTurn());
            // Transfer pin (single owner: latest read), annotations, synapses, and readCount to the new chunk
            if (c.pinned) {
              chunk.pinned = true;
              if (c.pinnedShape) chunk.pinnedShape = c.pinnedShape;
            }
            if (c.annotations?.length) {
              chunk.annotations = [...(chunk.annotations || []), ...c.annotations];
            }
            if (c.synapses?.length) {
              chunk.synapses = [...(chunk.synapses || []), ...c.synapses];
            }
            chunk.readCount = (c.readCount || 0) + 1;
          }
        }
      }

      // Manifest cleanup deferred until chunk is actually inserted (see below)
      let newManifest: Map<string, ManifestEntry> | undefined;

      // Auto-management: emergency eviction at 90%+ only. Model manages retention at 70% via stats-line warning.
      // Compact-first (~95% reduction), then evict. 3-tier: completed-subtask -> non-chat -> unprotected-chat.
      let currentUsed = 0;
      for (const c of newChunks.values()) currentUsed += c.tokens;

      let totalFreed = 0;
      let nextStagedSnippets = state.stagedSnippets;
      let stageVersionBump = 0;
      let stagedReliefFreed = 0;
      let stagedReliefRefs: string[] = [];
      let estimatedPromptPressure = getEstimatedPromptPressureTokens(state, tokens);
      const wouldExceed90 = estimatedPromptPressure > state.maxTokens * 0.90;

      if (_autoManageInProgress && wouldExceed90) {
        _autoManagePending = true;
      } else if (wouldExceed90) {
        _autoManageInProgress = true;
        let sortedChat: Array<[string, ContextChunk]> | undefined;
        try {
          const stagedRelief = pruneStagedSnippetsToBudget(state.stagedSnippets, 'overBudget');
          if (stagedRelief.removed.length > 0) {
            nextStagedSnippets = stagedRelief.staged;
            stageVersionBump = 1;
            stagedReliefFreed = stagedRelief.freed;
            stagedReliefRefs = stagedRelief.removed.map(({ key }) => key);
            estimatedPromptPressure -= stagedRelief.freed;
          }

          sortedChat = getSortedChatEntries(newChunks);
          const { hashes: protectedChat } = buildProtectedChatHashes(sortedChat, currentUsed, state.maxTokens);
          const completedSubtaskIds = new Set(
            (state.taskPlan?.subtasks || [])
              .filter(s => s.status === 'done')
              .map(s => s.id)
          );
          const undoProtectedHashes = new Set(state.editHashStack);

          const candidates = buildTieredEvictionCandidates(
            newChunks.entries(), protectedChat, completedSubtaskIds, undoProtectedHashes,
          );

          // Phase 1: Compact uncompacted chunks (preserves in archive, ~95% savings)
          for (const [key, c] of candidates) {
            if (currentUsed + tokens - totalFreed <= state.maxTokens * 0.50) break;
            if (c.compacted) continue;

            if (!newArchive) newArchive = new Map(state.archivedChunks);
            newArchive.set(key, { ...c });

            let compactContent: string;
            let editDigest: string | undefined;
            if (TOOL_CHUNK_TYPES.has(c.type)) {
              compactContent = c.summary || `[compacted] h:${c.shortHash}`;
            } else {
              editDigest = c.editDigest || c.digest || '';
              if (c.source) {
                const basename = c.source.split('/').pop() ?? c.source;
                const errEntry = state.blackboardEntries.get(`err:${basename}`);
                if (errEntry && editDigest) {
                  editDigest = editDigest + ` [ERR ${errEntry.content.slice(0, 60)}]`;
                }
              }
              compactContent = editDigest || c.summary || `[compacted] h:${c.shortHash}`;
            }
            const digestTokens = countTokensSync(compactContent);
            totalFreed += c.tokens - digestTokens;

            newChunks.set(key, {
              ...c,
              content: compactContent,
              tokens: digestTokens,
              compacted: true,
              editDigest: editDigest || undefined,
            });
            autoCompactedHashes.push(c.hash);
          }

          // Phase 2: Evict only if compaction wasn't sufficient
          for (const [key] of candidates) {
            if (currentUsed + tokens - totalFreed <= state.maxTokens * 0.50) break;
            const current = newChunks.get(key);
            if (!current) continue;
            totalFreed += current.tokens;
            autoEvictedHashes.push(current.hash);
            newChunks.delete(key);
          }
        } finally {
          _autoManageInProgress = false;
        }
        if (_autoManagePending) {
          _autoManagePending = false;
          const pass1Freed = totalFreed;
          totalFreed = 0;
          currentUsed = 0;
          for (const c of newChunks.values()) currentUsed += c.tokens;
          // Pass 2 gate uses chunk-layer sums; subtract Pass 1 staged relief so we do not over-compact.
          if (autoManagePass2ChunkPressureExceedsGate(currentUsed, tokens, stagedReliefFreed, state.maxTokens)) {
            _autoManageInProgress = true;
            try {
              const sortedChatPass2 =
                sortedChat?.filter(([k]) => newChunks.has(k)) ?? getSortedChatEntries(newChunks);
              const { hashes: protectedChat2 } = buildProtectedChatHashes(sortedChatPass2, currentUsed, state.maxTokens);
              const completedSubtaskIds2 = new Set(
                (state.taskPlan?.subtasks || []).filter(s => s.status === 'done').map(s => s.id)
              );
              const undoProtectedHashes2 = new Set(state.editHashStack);
              const candidates2 = buildTieredEvictionCandidates(
                newChunks.entries(), protectedChat2, completedSubtaskIds2, undoProtectedHashes2,
              );
              for (const [key] of candidates2) {
                if (currentUsed + tokens - totalFreed <= state.maxTokens * 0.50) break;
                // BUG10 FIX: Re-read from newChunks to get latest state after Phase 1 compaction.
                const c2 = newChunks.get(key);
                if (!c2 || c2.compacted) continue;
                if (!newArchive) newArchive = new Map(state.archivedChunks);
                newArchive.set(key, { ...c2 });
                let editDigest2 = c2.editDigest || c2.digest || '';
                if (c2.source) {
                  const basename = c2.source.split('/').pop() ?? c2.source;
                  const errEntry = state.blackboardEntries.get(`err:${basename}`);
                  if (errEntry && editDigest2) editDigest2 += ` [ERR ${errEntry.content.slice(0, 60)}]`;
                }
                const compactContent2 = editDigest2 || c2.summary || `[compacted] h:${c2.shortHash}`;
                const digestTokens2 = countTokensSync(compactContent2);
                totalFreed += c2.tokens - digestTokens2;
                newChunks.set(key, { ...c2, content: compactContent2, tokens: digestTokens2, compacted: true, editDigest: editDigest2 || undefined });
                autoCompactedHashes.push(c2.hash);
              }
              for (const [key] of candidates2) {
                if (currentUsed + tokens - totalFreed <= state.maxTokens * 0.50) break;
                const cur = newChunks.get(key);
                if (!cur) continue;
                totalFreed += cur.tokens;
                autoEvictedHashes.push(cur.hash);
                newChunks.delete(key);
              }
            } finally {
              _autoManageInProgress = false;
            }
          }
          totalFreed += pass1Freed;
        }
      }

      newChunks.set(hash, chunk);

      // Atomically clean manifest only after chunk is inserted
      if (state.droppedManifest.has(hash)) {
        newManifest = new Map(state.droppedManifest);
        newManifest.delete(hash);
      }
      const manifestUpdate = newManifest ? { droppedManifest: capDroppedManifest(newManifest) } : {};
      if (totalFreed > 0) {
        if (newArchive) newArchive = evictArchiveIfNeeded(newArchive);
        return {
          chunks: newChunks,
          ...(newArchive ? { archivedChunks: newArchive } : {}),
          stagedSnippets: nextStagedSnippets,
          ...(stageVersionBump > 0 ? { stageVersion: state.stageVersion + stageVersionBump } : {}),
          ...manifestUpdate,
          freedTokens: state.freedTokens + totalFreed,
          lastFreed: totalFreed,
          lastFreedAt: Date.now(),
          memoryEvents: appendMemoryEvent(state.memoryEvents, {
            action: 'compact',
            reason: 'auto_manage',
            refs: [...Array.from(newChunks.values()).filter(c => c.compacted).slice(-3).map(c => `h:${c.shortHash}`), ...stagedReliefRefs],
            freedTokens: totalFreed + stagedReliefFreed,
            pressurePct: (estimatedPromptPressure / state.maxTokens) * 100,
          }),
        };
      }
      return {
        chunks: newChunks,
        stagedSnippets: nextStagedSnippets,
        ...(stageVersionBump > 0 ? { stageVersion: state.stageVersion + stageVersionBump } : {}),
        ...(stagedReliefRefs.length > 0 ? {
          memoryEvents: appendMemoryEvent(state.memoryEvents, {
            action: 'evict',
            reason: 'staged_auto_manage',
            refs: stagedReliefRefs,
            freedTokens: stagedReliefFreed,
            pressurePct: (estimatedPromptPressure / state.maxTokens) * 100,
          }),
        } : {}),
        ...manifestUpdate,
      };
    });

    void countTokens(content)
      .then(realTokens => {
        if (typeof realTokens !== 'number' || !Number.isFinite(realTokens) || realTokens < 0) return;
        const t = Math.floor(realTokens);
        set(s => {
          const nc = new Map(s.chunks);
          const cur = nc.get(tokenMapKeyForReconcile);
          if (!cur || cur.hash !== tokenExpectedHashForReconcile) return {};
          if (cur.tokens === t) return {};
          nc.set(tokenMapKeyForReconcile, { ...cur, tokens: t });
          return { chunks: nc };
        });
      })
      .catch(() => {});

    const returnShort = collisionReturnShort ?? shortHash;

    // Push to recency stacks (file-relevant types only — keeps h:$last aligned with h:$last_read)
    const FILE_TYPES_FOR_RECENCY = new Set(['file', 'smart', 'raw', 'tree', 'search', 'symbol', 'deps']);
    if (FILE_TYPES_FOR_RECENCY.has(type)) {
      get().pushHash(returnShort);
      get().pushReadHash(returnShort);
    }
    for (const compactedHash of autoCompactedHashes) hppDematerialize(compactedHash);
    for (const evictedHash of autoEvictedHashes) hppEvict(evictedHash);
    
    return returnShort;
  },

  findReusableRead: (span: ReadSpan): string | null => {
    const state = get();
    const normPath = normalizeSourcePath(span.filePath);
    let matchHash: string | null = null;
    let matchShortHash: string | null = null;
    for (const [, chunk] of state.chunks) {
      if (chunk.compacted) continue;
      const rs = chunk.readSpan;
      if (!rs) continue;
      if (normalizeSourcePath(rs.filePath) !== normPath) continue;
      if (rs.sourceRevision !== span.sourceRevision) continue;
      if ((rs.shape ?? '') !== (span.shape ?? '')) continue;
      if ((rs.contextType ?? '') !== (span.contextType ?? '')) continue;
      // Align with HPP + formatter: reuse only when the model would see full body this turn
      const ref = hppGetRef(chunk.hash);
      if (!ref || !hppShouldMaterialize(ref)) continue;
      // Full-file span: both undefined means match
      if (span.startLine == null && rs.startLine == null) {
        matchHash = chunk.hash;
        matchShortHash = chunk.shortHash;
        break;
      }
      // Requested range must be contained within existing range
      if (span.startLine != null && rs.startLine != null && rs.endLine != null) {
        const reqStart = span.startLine;
        const reqEnd = span.endLine ?? span.startLine;
        if (reqStart >= rs.startLine && reqEnd <= rs.endLine) {
          matchHash = chunk.hash;
          matchShortHash = chunk.shortHash;
          break;
        }
      }
    }
    if (matchHash) {
      set(s => {
        const nc = new Map(s.chunks);
        const c = nc.get(matchHash!);
        if (c) nc.set(matchHash!, { ...c, lastAccessed: Date.now(), readCount: (c.readCount || 0) + 1 });
        return { chunks: nc };
      });
    }
    return matchShortHash;
  },
  
  /**
   * Update lastAccessed timestamp for a chunk.
   */
  touchChunk: (hashRef: string) => {
    set(state => {
      const newChunks = new Map(state.chunks);
      const found = findChunkByRef(newChunks, hashRef);
      
      if (found) {
        newChunks.set(found[0], { ...found[1], lastAccessed: Date.now() });
      }
      
      return { chunks: newChunks };
    });
  },
  
  /**
   * Compact chunks: replace full content with edit-ready digest.
   * Chunk stays visible in working memory with [C] marker.
   * Original content preserved in archive for recall/h: resolution.
   * Frees ~95% of the chunk's token cost while retaining edit targeting info.
   */
  compactChunks: (hashes: string[], opts?: { confirmWildcard?: boolean; tier?: 'pointer' | 'sig'; sigContentByRef?: Map<string, string> }) => {
    let compactedCount = 0;
    let freedTokens = 0;
    const hasWildcard = hashes.includes('*') || hashes.includes('all');
    const effectiveHashes = hasWildcard && !opts?.confirmWildcard
      ? hashes.filter(h => h !== '*' && h !== 'all')
      : hashes;

    set(state => {
      const newChunks = new Map(state.chunks);
      const newArchive = new Map(state.archivedChunks);
      let usedTokens = 0;
      for (const c of newChunks.values()) usedTokens += c.tokens;
      const { hashes: protectedChat } = getProtectedChatHashes(newChunks, usedTokens, state.maxTokens);

      const targets = effectiveHashes.includes('*') || effectiveHashes.includes('all')
        ? [...newChunks.entries()].filter(([_, c]) => !c.pinned && !c.compacted)
        : effectiveHashes.map(h => findChunkByRef(newChunks, h)).filter(Boolean) as [string, ContextChunk][];

      for (const [key, chunk] of targets) {
        if (chunk.compacted || chunk.pinned) continue;
        if (protectedChat.has(chunk.hash)) continue;

        // Preserve original in archive for recall and h: resolution
        newArchive.set(key, { ...chunk });

        const tier = opts?.tier ?? 'pointer';
        let compactContent: string;
        if (TOOL_CHUNK_TYPES.has(chunk.type)) {
          compactContent = chunk.summary || `[compacted] h:${chunk.shortHash}`;
        } else if (tier === 'sig' && opts?.sigContentByRef) {
          const sigContent = opts.sigContentByRef.get(`h:${chunk.shortHash}`) ?? opts.sigContentByRef.get(chunk.shortHash);
          compactContent = sigContent ?? (chunk.editDigest || chunk.digest || chunk.summary || `[compacted] h:${chunk.shortHash}`);
        } else {
          let editDigest = chunk.editDigest || chunk.digest || '';
          if (chunk.source) {
            const basename = chunk.source.split('/').pop() ?? chunk.source;
            const errEntry = state.blackboardEntries.get(`err:${basename}`);
            if (errEntry && editDigest) {
              const errAnnotation = ` [ERR ${errEntry.content.slice(0, 60)}]`;
              editDigest = editDigest + errAnnotation;
            }
          }
          compactContent = editDigest || chunk.summary || `[compacted] h:${chunk.shortHash}`;
        }
        const digestTokens = countTokensSync(compactContent);

        const tokensSaved = chunk.tokens - digestTokens;
        freedTokens += tokensSaved;
        compactedCount++;

        // Replace content with digest, mark compacted
        newChunks.set(key, {
          ...chunk,
          content: compactContent,
          tokens: digestTokens,
          compacted: true,
          compactTier: tier === 'sig' ? 'sig' : undefined,
          editDigest: tier === 'pointer' ? (chunk.editDigest || chunk.digest || undefined) : undefined,
          lastAccessed: Date.now(),
        });

        // HPP: content replaced with digest — dematerialize so model knows it's ref-only
        hppDematerialize(chunk.hash);
      }

      const trimmedArchive = evictArchiveIfNeeded(newArchive);
      return {
        chunks: newChunks,
        archivedChunks: trimmedArchive,
        freedTokens: state.freedTokens + freedTokens,
        lastFreed: freedTokens,
        lastFreedAt: Date.now(),
        ...(compactedCount > 0 ? {
          memoryEvents: appendMemoryEvent(state.memoryEvents, {
            action: 'compact',
            reason: 'manual',
            refs: targets.slice(0, 10).map(([, chunk]) => `h:${chunk.shortHash}`),
            freedTokens,
          }),
        } : {}),
      };
    });

    return { compacted: compactedCount, freedTokens };
  },

  /**
   * Unload chunks by hash reference.
   * Supports "*" to clear all non-pinned chunks.
   */
  unloadChunks: (hashes: string[], opts?: { confirmWildcard?: boolean }) => {
    let freed = 0;
    let count = 0;
    let pinnedKept = 0;
    const unloadedHashes: string[] = [];
    const hasWildcard = hashes.includes('*') || hashes.includes('all');
    const effectiveHashes = hasWildcard && !opts?.confirmWildcard
      ? hashes.filter(h => h !== '*' && h !== 'all')
      : hashes;
    
    set(state => {
      const newChunks = new Map(state.chunks);
      const newArchive = new Map(state.archivedChunks);
      
      if (effectiveHashes.includes('*') || effectiveHashes.includes('all')) {
        let usedTokens = 0;
        for (const c of newChunks.values()) usedTokens += c.tokens;
        const { hashes: protectedChat } = getProtectedChatHashes(newChunks, usedTokens, state.maxTokens);

        const toDelete: string[] = [];
        for (const [key, chunk] of newChunks) {
          if (chunk.pinned || protectedChat.has(chunk.hash)) {
            pinnedKept++;
          } else {
            freed += chunk.tokens;
            count++;
            const existing = newArchive.get(key);
            if (!existing || existing.compacted) {
              newArchive.set(key, chunk);
            }
            toDelete.push(key);
            unloadedHashes.push(chunk.hash);
          }
        }
        for (const key of toDelete) newChunks.delete(key);
        const trimmedArchiveWildcard = evictArchiveIfNeeded(newArchive);
        return {
          chunks: newChunks,
          archivedChunks: trimmedArchiveWildcard,
          freedTokens: state.freedTokens + freed,
          lastFreed: freed,
          lastFreedAt: Date.now(),
          ...(count > 0 ? {
            memoryEvents: appendMemoryEvent(state.memoryEvents, {
              action: 'archive',
              reason: 'manual_unload',
              refs: unloadedHashes.slice(0, 10).map(h => `h:${h.slice(0, SHORT_HASH_LEN)}`),
              freedTokens: freed,
            }),
          } : {}),
        };
      }
      
      for (const h of effectiveHashes) {
        const found = findChunkByRef(newChunks, h);
        if (found) {
          const [key, chunk] = found;
          freed += chunk.tokens;
          count++;
          const existing = newArchive.get(key);
          if (!existing || existing.compacted) {
            newArchive.set(key, chunk);
          }
          newChunks.delete(key);
          unloadedHashes.push(chunk.hash);
        }
      }
      
      const trimmedArchiveUnload = evictArchiveIfNeeded(newArchive);
      return {
        chunks: newChunks,
        archivedChunks: trimmedArchiveUnload,
        freedTokens: state.freedTokens + freed,
        lastFreed: freed,
        lastFreedAt: Date.now(),
        ...(count > 0 ? {
          memoryEvents: appendMemoryEvent(state.memoryEvents, {
            action: 'archive',
            reason: 'manual_unload',
            refs: unloadedHashes.slice(0, 10).map(h => `h:${h.slice(0, SHORT_HASH_LEN)}`),
            freedTokens: freed,
          }),
        } : {}),
      };
    });
    
    // HPP: moved to archive, not evicted — still reachable by hash
    for (const h of unloadedHashes) {
      hppArchive(h);
    }
    
    return { freed, count, pinnedKept };
  },
  
  /**
   * Permanently drop chunks — removes content from both working memory and archive,
   * keeping only a lightweight manifest entry for episodic memory.
   * Supports "*" to drop all non-pinned from both maps.
   */
  dropChunks: (hashes: string[], opts?: { confirmWildcard?: boolean }) => {
    let dropped = 0;
    let freedTokens = 0;
    const droppedHashes: string[] = [];
    const hasWildcard = hashes.includes('*') || hashes.includes('all');
    const effectiveHashes = hasWildcard && !opts?.confirmWildcard
      ? hashes.filter(h => h !== '*' && h !== 'all')
      : hashes;
    
    set(state => {
      const newChunks = new Map(state.chunks);
      const newArchived = new Map(state.archivedChunks);
      const newManifest = new Map(state.droppedManifest);
      const now = Date.now();
      let usedTokens = 0;
      for (const c of newChunks.values()) usedTokens += c.tokens;
      const { hashes: protectedChat } = getProtectedChatHashes(newChunks, usedTokens, state.maxTokens);
      
      const createManifest = (chunk: ContextChunk): ManifestEntry => ({
        hash: chunk.hash,
        shortHash: chunk.shortHash,
        type: chunk.type,
        source: chunk.source,
        tokens: chunk.tokens,
        digest: chunk.digest,
        droppedAt: now,
        subtaskId: chunk.subtaskId,
      });
      
      if (effectiveHashes.includes('*') || effectiveHashes.includes('all')) {
        // Drop all non-pinned from working memory (protect recent chat turns)
        for (const [key, chunk] of newChunks) {
          if (!chunk.pinned && !protectedChat.has(chunk.hash)) {
            newManifest.set(key, createManifest(chunk));
            freedTokens += chunk.tokens;
            dropped++;
            droppedHashes.push(chunk.hash);
            newChunks.delete(key);
          }
        }
        // Drop all from archive
        for (const [key, chunk] of newArchived) {
          newManifest.set(key, createManifest(chunk));
          dropped++;
          droppedHashes.push(chunk.hash);
          newArchived.delete(key);
        }
      } else {
        for (const h of effectiveHashes) {
          // Check working memory first
          const inWorking = findChunkByRef(newChunks, h);
          if (inWorking) {
            const [key, chunk] = inWorking;
            if (protectedChat.has(chunk.hash)) continue;
            newManifest.set(key, createManifest(chunk));
            freedTokens += chunk.tokens;
            dropped++;
            droppedHashes.push(chunk.hash);
            newChunks.delete(key);
            continue;
          }
          // Check archive
          const inArchive = findChunkByRef(newArchived, h);
          if (inArchive) {
            const [key, chunk] = inArchive;
            newManifest.set(key, createManifest(chunk));
            freedTokens += chunk.tokens;
            dropped++;
            droppedHashes.push(chunk.hash);
            newArchived.delete(key);
          }
        }
      }
      
      return {
        chunks: newChunks,
        archivedChunks: newArchived,
        droppedManifest: capDroppedManifest(newManifest),
        freedTokens: state.freedTokens + freedTokens,
        lastFreed: freedTokens,
        lastFreedAt: Date.now(),
        ...(dropped > 0 ? {
          memoryEvents: appendMemoryEvent(state.memoryEvents, {
            action: 'drop',
            reason: 'manual',
            freedTokens,
          }),
        } : {}),
      };
    });

    // HPP: mark dropped hashes as evicted in the protocol state machine
    for (const h of droppedHashes) {
      hppEvict(h);
    }

    // G9: GC orphaned derivedFrom refs on BB entries pointing to dropped hashes
    if (droppedHashes.length > 0) {
      const droppedShort = new Set(droppedHashes.map(h => h.slice(0, SHORT_HASH_LEN)));
      set(state => {
        const newBb = new Map(state.blackboardEntries);
        let bbChanged = false;
        for (const [key, entry] of state.blackboardEntries) {
          if (!entry.derivedFrom?.length) continue;
          const filtered = entry.derivedFrom.filter((d) => {
            const dBare = d.startsWith('h:') ? d.slice(2) : d;
            return !droppedShort.has(dBare.slice(0, SHORT_HASH_LEN));
          });
          if (filtered.length !== entry.derivedFrom.length) {
            const filteredRevs = entry.derivedRevisions?.slice(0, filtered.length);
            newBb.set(key, { ...entry, derivedFrom: filtered.length > 0 ? filtered : undefined, derivedRevisions: filteredRevs });
            bbChanged = true;
          }
        }
        return bbChanged ? { blackboardEntries: newBb } : {};
      });
    }

    return { dropped, freedTokens };
  },
  
  /**
   * Pin chunks to protect from bulk unload.
   * Also recalls archived chunks and promotes staged snippets when pinned.
   */
  pinChunks: (hashes: string[], shape?: string) => {
    let count = 0;
    let alreadyPinned = 0;
    let skippedFullFile = 0;
    
    const isFullFileRead = (chunk: ContextChunk): boolean =>
      !chunk.compacted
      && (chunk.viewKind === 'latest' || chunk.viewKind == null)
      && isFileBackedType(chunk.type)
      && chunk.type !== 'result';

    set(state => {
      const newChunks = new Map(state.chunks);
      const newArchived = new Map(state.archivedChunks);
      
      for (const h of hashes) {
        const found = findChunkByRef(newChunks, h);
        if (found && isFullFileRead(found[1])) {
          skippedFullFile++;
          continue;
        }
        if (found && !found[1].pinned) {
          newChunks.set(found[0], {
            ...found[1],
            pinned: true,
            ...(shape !== undefined ? { pinnedShape: shape } : {}),
          });
          hppSetPinned(found[0], true, shape);
          count++;
        } else if (found && found[1].pinned) {
          if (shape !== undefined) {
            newChunks.set(found[0], { ...found[1], pinnedShape: shape });
            hppSetPinned(found[0], true, shape);
          }
          alreadyPinned++;
        } else if (!found) {
          const archived = findChunkByRef(newArchived, h);
          if (archived) {
            newArchived.delete(archived[0]);
            const recalled = {
              ...archived[1],
              pinned: true,
              ...(shape !== undefined ? { pinnedShape: shape } : {}),
              lastAccessed: Date.now(),
            } as typeof archived[1];
            if (recalled.source && isFileBackedType(recalled.type) && recalled.sourceRevision) {
              const awareness = get().getAwareness(recalled.source);
              if (awareness && awareness.snapshotHash !== recalled.sourceRevision) {
                recalled.suspectSince = Date.now();
                recalled.freshness = 'suspect' as FreshnessState;
                recalled.freshnessCause = 'unknown' as FreshnessCause;
              }
            }
            newChunks.set(archived[0], recalled);
            hppMaterialize(recalled.hash, recalled.type, recalled.source, recalled.tokens, (recalled.content.match(/\n/g) || []).length + 1, recalled.editDigest || recalled.digest || '', recalled.shortHash);
            hppSetPinned(archived[0], true, shape);
            count++;
          } else {
            const staged = findStagedByRef(state.stagedSnippets, h);
            if (staged) {
              const [, promoted] = promoteStagedToChunk(staged[0], staged[1], newChunks);
              newChunks.set(promoted.hash, {
                ...promoted,
                pinned: true,
                ...(shape !== undefined ? { pinnedShape: shape } : {}),
              });
              hppSetPinned(promoted.hash, true, shape);
              count++;
            }
          }
        }
      }
      
      return { chunks: newChunks, archivedChunks: newArchived };
    });
    
    return { count, alreadyPinned, skippedFullFile };
  },
  
  /**
   * Unpin chunks to allow bulk unload.
   * Supports "*" / "all" to unpin every pinned chunk in working memory.
   */
  unpinChunks: (hashes: string[]) => {
    let count = 0;
    const hasWildcard = hashes.includes('*') || hashes.includes('all');
    
    set(state => {
      const newChunks = new Map(state.chunks);
      
      if (hasWildcard) {
        for (const [key, chunk] of newChunks) {
          if (chunk.pinned) {
            newChunks.set(key, { ...chunk, pinned: false, pinnedShape: undefined });
            hppSetPinned(key, false);
            count++;
          }
        }
      } else {
        for (const h of hashes) {
          const found = findChunkByRef(newChunks, h);
          if (found && found[1].pinned) {
            newChunks.set(found[0], { ...found[1], pinned: false, pinnedShape: undefined });
            hppSetPinned(found[0], false);
            count++;
          }
        }
      }
      
      return { chunks: newChunks };
    });
    
    return count;
  },
  
  findPinnedFileEngram: (filePath: string): string | null => {
    const FULL_FILE_TYPES = new Set(['file', 'smart', 'full']);
    for (const [key, chunk] of get().chunks) {
      if (!chunk.pinned) continue;
      if (!FULL_FILE_TYPES.has(chunk.type)) continue;
      if (chunk.source && sourcesMatch(chunk.source, filePath)) return key;
    }
    return null;
  },

  /**
   * Register an edit-result hash as a lightweight stub for hash chaining.
   * Maps h:NEW → source path so subsequent edits can resolve the reference
   * without re-reading the file (backend handles content_hash validation).
   * Returns { registered, reason? } so callers know if registration succeeded.
   */
  registerEditHash: (hash: string, source: string, editSessionId?: string): { registered: boolean; reason?: string } => {
    const fullHash = hash.startsWith('h:') ? hash.slice(2) : hash;
    const shortHash = fullHash.slice(0, SHORT_HASH_LEN);
    let alreadyExisted = false;
    set(state => {
      const newChunks = new Map(state.chunks);
      if (newChunks.has(fullHash)) {
        alreadyExisted = true;
        return {};
      }
      newChunks.set(fullHash, {
        hash: fullHash,
        shortHash,
        type: 'result' as ChunkType,
        source,
        viewKind: 'derived',
        content: `[edit result] h:${shortHash} → ${source}`,
        tokens: 5,
        ttl: 3,
        origin: 'edit' as EngramOrigin,
        editSessionId,
        createdAt: new Date(),
        lastAccessed: Date.now(),
      });
      return { chunks: newChunks };
    });
    if (!alreadyExisted) {
      get().pushHash(shortHash);
      get().pushEditHash(shortHash); // For undo:"h:$last_edit" (edit-store order)
    }
    return { registered: true, ...(alreadyExisted ? { reason: 'already_registered' as const } : {}) };
  },

  /**
   * Evict chunks whose shortHash matches any of the given stale hashes.
   * Called after refactor.execute() to prevent "file changed on disk" errors
   * when the AI tries to stage() old hash refs.
   */
  invalidateStaleHashes: (shortHashes: string[]) => {
    if (shortHashes.length === 0) return 0;
    const normalized = shortHashes.map(h => h.startsWith('h:') ? h.slice(2) : h).map(h => h.slice(0, SHORT_HASH_LEN));
    let evicted = 0;
    const evictedHashes: string[] = [];
    set(state => {
      const newChunks = new Map(state.chunks);
      const newArchived = new Map(state.archivedChunks);
      const newStaged = new Map(state.stagedSnippets);
      for (const target of normalized) {
        for (const [key, chunk] of newChunks) {
          if (chunk.shortHash === target) {
            newChunks.delete(key);
            evicted++;
            evictedHashes.push(chunk.hash);
          }
        }
        for (const [key, chunk] of newArchived) {
          if (chunk.shortHash === target) {
            newArchived.delete(key);
            evicted++;
            evictedHashes.push(chunk.hash);
          }
        }
        for (const [key] of newStaged) {
          const keyBase = refToBaseHash(key.startsWith('h:') ? key : `h:${key}`);
          if (keyBase.slice(0, SHORT_HASH_LEN) === target) {
            newStaged.delete(key);
            evicted++;
          }
        }
      }
      if (evicted === 0) return {};
      return { chunks: newChunks, archivedChunks: newArchived, stagedSnippets: newStaged, stageVersion: state.stageVersion + 1 };
    });
    for (const hash of evictedHashes) hppEvict(hash);
    for (const target of normalized) {
      manifestRecordEviction(target, '', 'stale_hash', hppGetTurn());
    }
    return evicted;
  },

  /**
   * Invalidate derived shapes (staged snippets, chunks) where source matches path
   * and sourceRevision !== currentRevision. Uses immediate eviction (no stale tracking).
   */
  invalidateDerivedForPath: (path: string, currentRevision: string) => {
    const pathNorm = normalizeSourcePath(path);
    let evicted = 0;
    const evictedHashes: string[] = [];
    set(state => {
      let newStaged: Map<string, StagedSnippet> | null = null;
      for (const [key, s] of state.stagedSnippets) {
        if (s.viewKind === 'snapshot') continue;
        // Optimized: normalize source once, skip non-matching sources early
        if (!s.source) continue;
        const sourceNorm = normalizeSourcePath(s.source);
        if (sourceNorm !== pathNorm) continue;
        if (s.sourceRevision != null && s.sourceRevision !== currentRevision && s.viewKind === 'derived') {
          if (!newStaged) newStaged = new Map(state.stagedSnippets);
          newStaged.delete(key);
          evicted++;
        }
      }
      let newChunks: Map<string, ContextChunk> | null = null;
      let newArchived: Map<string, ContextChunk> | null = null;
      for (const [key, c] of state.chunks) {
        if (!c.source) continue;
        const sourceNorm = normalizeSourcePath(c.source);
        if (sourceNorm !== pathNorm) continue;
        if (c.sourceRevision != null && c.sourceRevision !== currentRevision) {
          if (!newChunks) newChunks = new Map(state.chunks);
          if (!newArchived) newArchived = new Map(state.archivedChunks);
          newChunks.delete(key);
          newArchived.set(key, c);
          evictedHashes.push(c.hash);
          evicted++;
        }
      }
      if (!newStaged && !newChunks) return {};
      return {
        ...(newStaged ? { stagedSnippets: newStaged, stageVersion: state.stageVersion + 1 } : {}),
        ...(newChunks ? { chunks: newChunks } : {}),
        ...(newArchived ? { archivedChunks: newArchived } : {}),
      };
    });
    return evicted;
  },

  evictChunksForDeletedPaths: (paths: string[]) => {
    if (paths.length === 0) return { chunks: 0, staged: 0 };
    const pathSet = new Set(paths.map(p => normalizeSourcePath(p)));
    const matchesPath = (source?: string): boolean => {
      if (!source) return false;
      const sourceNorm = normalizeSourcePath(source);
      if (pathSet.has(sourceNorm)) return true;
      // Handle comma-joined composite sources
      if (source.includes(',')) {
        for (const seg of source.split(',')) {
          const t = seg.trim();
          if (t && pathSet.has(normalizeSourcePath(t))) return true;
        }
      }
      return false;
    };

    const evictedHashes: string[] = [];
    let chunkCount = 0;
    let stagedCount = 0;

    set(state => {
      const newChunks = new Map(state.chunks);
      const newArchived = new Map(state.archivedChunks);
      const newStaged = new Map(state.stagedSnippets);

      const chunkKeysToRemove: string[] = [];
      for (const [key, chunk] of newChunks) {
        if (matchesPath(chunk.source)) chunkKeysToRemove.push(key);
      }
      for (const key of chunkKeysToRemove) {
        const chunk = newChunks.get(key);
        if (!chunk) continue;
        newChunks.delete(key);
        evictedHashes.push(chunk.hash);
        chunkCount++;
      }

      const archivedKeysToRemove: string[] = [];
      for (const [key, chunk] of newArchived) {
        if (matchesPath(chunk.source)) archivedKeysToRemove.push(key);
      }
      for (const key of archivedKeysToRemove) {
        const chunk = newArchived.get(key);
        if (!chunk) continue;
        newArchived.delete(key);
        evictedHashes.push(chunk.hash);
        chunkCount++;
      }

      const stagedKeysToRemove: string[] = [];
      for (const [key, snippet] of newStaged) {
        if (matchesPath(snippet.source)) stagedKeysToRemove.push(key);
      }
      for (const key of stagedKeysToRemove) {
        newStaged.delete(key);
        stagedCount++;
      }

      if (chunkCount === 0 && stagedCount === 0) return {};

      return {
        chunks: newChunks,
        archivedChunks: newArchived,
        stagedSnippets: newStaged,
        stageVersion: state.stageVersion + 1,
        memoryEvents: appendMemoryEvent(state.memoryEvents, {
          action: 'evict',
          reason: 'deleted_paths',
          refs: paths.slice(0, 12).map(p => p.replace(/\\/g, '/')),
        }),
      };
    });

    for (const h of evictedHashes) hppEvict(h);

    get().invalidateAwarenessForPaths(paths);
    for (const p of paths) {
      get().supersedeBlackboardForPath(p, '');
    }

    return { chunks: chunkCount, staged: stagedCount };
  },

  applyRestoredSessionBlanketSuspect: () => {
    const now = Date.now();
    set(state => {
      const chunks = new Map(state.chunks);
      for (const [h, c] of chunks) {
        chunks.set(h, { ...c, freshness: 'suspect', freshnessCause: 'session_restore', suspectSince: now });
      }
      const archivedChunks = new Map(state.archivedChunks);
      for (const [h, c] of archivedChunks) {
        if (c.viewKind === 'snapshot') continue;
        if (!isFileBackedType(c.type)) continue;
        archivedChunks.set(h, { ...c, freshness: 'suspect', freshnessCause: 'session_restore', suspectSince: now });
      }
      const stagedSnippets = new Map(state.stagedSnippets);
      for (const [k, s] of stagedSnippets) {
        stagedSnippets.set(k, { ...s, stageState: 'stale', suspectSince: now });
      }
      return { chunks, archivedChunks, stagedSnippets };
    });
    get().invalidateAllAwarenessCache();
  },

  reconcileRestoredSession: async () => {
    const state = get();
    const pathSet = new Set<string>();
    const addSource = (source?: string) => {
      if (source && typeof source === 'string') pathSet.add(normalizeSourcePath(source));
    };
    for (const [, c] of state.chunks) {
      if (c.viewKind === 'snapshot') continue;
      if (isFileBackedType(c.type)) addSource(c.source);
    }
    for (const [, c] of state.archivedChunks) {
      if (c.viewKind === 'snapshot') continue;
      if (isFileBackedType(c.type)) addSource(c.source);
    }
    for (const [, s] of state.stagedSnippets) {
      if (s.viewKind === 'snapshot') continue;
      addSource(s.source);
    }

    const paths = [...pathSet];
    if (paths.length === 0) return { updated: 0, invalidated: 0, evicted: 0 };

    if (!_bulkRevisionResolver) {
      get().applyRestoredSessionBlanketSuspect();
      incSessionRestoreReconcileCount(1);
      console.warn('[contextStore] reconcileRestoredSession: no bulk revision resolver — blanket suspect + awareness cleared');
      return { updated: 0, invalidated: 0, evicted: 0 };
    }

    let revisionMap: Map<string, string | null>;
    try {
      revisionMap = await _bulkRevisionResolver(paths);
    } catch (e) {
      console.warn('[contextStore] reconcileRestoredSession: bulk revision lookup failed:', e);
      get().applyRestoredSessionBlanketSuspect();
      incSessionRestoreReconcileCount(1);
      return { updated: 0, invalidated: 0, evicted: 0 };
    }

    let updated = 0;
    let invalidated = 0;
    let evicted = 0;
    const deletedPaths: string[] = [];

    const { index: normalizedRevIndex } = buildNormalizedRevisionIndex(revisionMap);

    for (const path of paths) {
      const rev = normalizedRevIndex.get(path) ?? null;
      if (rev == null) {
        deletedPaths.push(path);
        continue;
      }
      const stats = get().reconcileSourceRevision(path, rev, 'session_restore');
      updated += stats.updated;
      invalidated += stats.invalidated;
    }

    if (deletedPaths.length > 0) {
      const { chunks: evictedChunks } = get().evictChunksForDeletedPaths(deletedPaths);
      evicted += evictedChunks;
    }

    if (updated + invalidated + evicted > 0) {
      get().recordMemoryEvent({
        action: 'reconcile',
        reason: 'session_restore_reconciliation',
        refs: [
          `updated:${updated}`,
          `invalidated:${invalidated}`,
          `evicted:${evicted}`,
          `paths:${paths.length}`,
        ],
      });
    }

    return { updated, invalidated, evicted };
  },

  reconcileSourceRevision: (path: string, currentRevision: string, cause?: FreshnessCause) => {
    const effectiveCause = cause ?? consumeRevisionAdvanceCause(path) ?? 'external_file_change';
    const isSessionRestore = effectiveCause === 'session_restore';
    const isSameFilePriorEdit = effectiveCause === 'same_file_prior_edit';
    let stats: ReconcileStats = {
      source: path,
      revision: currentRevision,
      total: 0,
      updated: 0,
      invalidated: 0,
      preserved: 0,
      at: Date.now(),
    };
    const evictedHashes: string[] = [];
    set(state => {
      const newChunks = new Map(state.chunks);
      const newArchived = new Map(state.archivedChunks);
      const newStaged = new Map(state.stagedSnippets);
      const batch: ReconcileSourceRevisionBatch = { stats, evictedHashes, dormantEvicted: 0 };

      for (const [key, chunk] of state.chunks) {
        reconcileWorkingChunkForSourceRevision(
          path,
          currentRevision,
          key,
          chunk,
          newChunks,
          newArchived,
          effectiveCause,
          isSessionRestore,
          isSameFilePriorEdit,
          batch,
        );
      }
      for (const [key, chunk] of state.archivedChunks) {
        reconcileArchivedChunkForSourceRevision(
          path,
          currentRevision,
          key,
          chunk,
          newArchived,
          effectiveCause,
          isSessionRestore,
          isSameFilePriorEdit,
          batch,
        );
      }
      for (const [key, snippet] of state.stagedSnippets) {
        reconcileStagedSnippetForSourceRevision(
          path,
          currentRevision,
          key,
          snippet,
          newStaged,
          effectiveCause,
          isSessionRestore,
          isSameFilePriorEdit,
          batch,
        );
      }

      if (stats.total === 0) {
        return {
          reconcileStats: stats,
          memoryEvents: appendMemoryEvent(state.memoryEvents, {
            action: 'reconcile',
            reason: 'source_reread_no_matches',
            source: path,
            newRevision: currentRevision,
          }),
        };
      }

      return {
        chunks: newChunks,
        archivedChunks: evictArchiveIfNeeded(newArchived),
        stagedSnippets: newStaged,
        stageVersion: stats.invalidated > 0 ? state.stageVersion + 1 : state.stageVersion,
        reconcileStats: stats,
        memoryEvents: appendMemoryEvent(state.memoryEvents, {
          action: 'reconcile',
          reason: 'source_reread',
          source: path,
          newRevision: currentRevision,
          refs: [
            ...(stats.updated > 0 ? [`updated:${stats.updated}`] : []),
            ...(stats.invalidated > 0 ? [`invalidated:${stats.invalidated}`] : []),
            ...(batch.dormantEvicted > 0 ? [`dormant_evicted:${batch.dormantEvicted}`] : []),
            ...(stats.preserved > 0 ? [`preserved:${stats.preserved}`] : []),
          ],
        }),
      };
    });
    for (const hash of evictedHashes) hppEvict(hash);
    // Conditionally invalidate awareness: only when the revision actually changed.
    // If the hash matches, the cached readRegions/shapeHash are still valid.
    const awarenessKey = path.replace(/\\/g, '/').toLowerCase();
    const awarenessEntry = get().awarenessCache.get(awarenessKey);
    if (!awarenessEntry || canonicalizeSnapshotHash(currentRevision) !== awarenessEntry.snapshotHash) {
      get().invalidateAwareness(path);
    }

    const bbSuperseded = get().supersedeBlackboardForPath(path, currentRevision);
    if (bbSuperseded > 0) {
      stats.bbSuperseded = bbSuperseded;
    }

    return stats;
  },

  refreshRoundEnd: async (options) => {
    // TTL: decrement unpinned chunks; on expiry move to archive with ttl_expired (recallable), not droppedManifest.
    const chunksWithTtl = Array.from(get().chunks.entries()).filter(([, c]) => c.ttl != null && !c.pinned);
    const ttlArchiveHashes: string[] = [];
    if (chunksWithTtl.length > 0) {
      set(s => {
        const newChunks = new Map(s.chunks);
        let newArchived = s.archivedChunks;
        let archivedCopied = false;
        let ttlMutated = false;
        for (const [key, chunk] of chunksWithTtl) {
          const remaining = (chunk.ttl ?? 0) - 1;
          if (remaining <= 0) {
            ttlMutated = true;
            newChunks.delete(key);
            if (!archivedCopied) {
              newArchived = new Map(s.archivedChunks);
              archivedCopied = true;
            }
            const now = Date.now();
            newArchived.set(key, {
              ...chunk,
              ttl: undefined,
              freshness: 'suspect',
              freshnessCause: 'ttl_expired',
              suspectSince: chunk.suspectSince ?? now,
              lastAccessed: now,
            });
            ttlArchiveHashes.push(chunk.hash);
          } else {
            ttlMutated = true;
            newChunks.set(key, { ...chunk, ttl: remaining });
          }
        }
        if (!ttlMutated) return {};
        return {
          chunks: newChunks,
          ...(archivedCopied ? { archivedChunks: newArchived } : {}),
        };
      });
      for (const h of ttlArchiveHashes) hppArchive(h);
    }

    const state = get();
    const pathSet = new Set<string>();

    if (options?.paths && options.paths.length > 0) {
      for (const p of options.paths) if (p && typeof p === 'string') pathSet.add(normalizeSourcePath(p));
    } else {
      const norm = normalizeSourcePath;
      const addSource = (source?: string) => {
        if (source && typeof source === 'string') pathSet.add(norm(source));
      };
      for (const [, c] of state.chunks) {
        if (c.viewKind === 'snapshot') continue;
        if ((c.viewKind === 'latest' || c.viewKind == null) && isFileBackedType(c.type)) addSource(c.source);
      }
      for (const [, c] of state.archivedChunks) {
        if (c.viewKind === 'snapshot') continue;
        if ((c.viewKind === 'latest' || c.viewKind == null) && isFileBackedType(c.type)) addSource(c.source);
      }
      for (const [, s] of state.stagedSnippets) {
        if (s.viewKind === 'snapshot') continue;
        if (s.viewKind === 'latest' || s.viewKind == null) addSource(s.source);
      }
    }

    const paths = [...pathSet];
    if (paths.length === 0) {
      return { total: 0, updated: 0, invalidated: 0, preserved: 0, pathsProcessed: 0 };
    }

    const bulkResolver = options?.bulkGetRevisions ?? _bulkRevisionResolver;
    const perPathResolver = options?.getRevisionForPath ?? _roundRefreshRevisionResolver;

    let revisionMap: Map<string, string | null> | null = null;
    if (bulkResolver) {
      revisionMap = await bulkResolver(paths);
    }

    if (!revisionMap && !perPathResolver) {
      return { total: 0, updated: 0, invalidated: 0, preserved: 0, pathsProcessed: 0 };
    }

    let total = 0;
    let updated = 0;
    let invalidated = 0;
    let preserved = 0;
    const unresolvablePaths: string[] = [];
    const revByPath = new Map<string, string | null>();

    if (!revisionMap) {
      if (perPathResolver) {
        const resolved = await Promise.all(paths.map(async (p) => [p, await perPathResolver(p)] as const));
        for (const [p, r] of resolved) revByPath.set(p, r);
      }
    } else {
      const { index: normalizedRevIndex, explicitNull: bulkExplicitNull } = buildNormalizedRevisionIndex(revisionMap);
      const pendingFallback: string[] = [];
      for (const path of paths) {
        const fromBulk = normalizedRevIndex.get(path);
        if (fromBulk != null) {
          revByPath.set(path, fromBulk);
        } else if (bulkExplicitNull.has(path)) {
          revByPath.set(path, null);
        } else if (perPathResolver) {
          pendingFallback.push(path);
        } else {
          revByPath.set(path, null);
        }
      }
      if (pendingFallback.length > 0 && perPathResolver) {
        const parallel = await Promise.all(
          pendingFallback.map(async (p) => [p, await perPathResolver(p)] as const),
        );
        for (const [p, r] of parallel) revByPath.set(p, r);
      }
    }

    const invalidatedPaths: string[] = [];
    for (const path of paths) {
      const rev = revByPath.get(path) ?? null;
      if (rev == null) {
        unresolvablePaths.push(path);
        continue;
      }
      const stats = get().reconcileSourceRevision(path, rev);
      total += stats.total;
      updated += stats.updated;
      invalidated += stats.invalidated;
      preserved += stats.preserved;
      if (stats.invalidated > 0) invalidatedPaths.push(path);
    }

    // Re-validate paths that had invalidations — a file may have changed between the
    // bulk revision fetch and our reconciliation pass. Re-resolving narrows the TOCTOU
    // window; any residual race is caught by the next round's refresh.
    if (invalidatedPaths.length > 0 && perPathResolver) {
      const reResolved = await Promise.all(
        invalidatedPaths.map(async (p) => [p, await perPathResolver(p)] as const),
      );
      for (const [rePath, reRev] of reResolved) {
        if (reRev == null) continue;
        const priorRev = revByPath.get(rePath);
        if (priorRev != null && reRev !== priorRev) {
          const stats = get().reconcileSourceRevision(rePath, reRev);
          total += stats.total;
          updated += stats.updated;
          invalidated += stats.invalidated;
          preserved += stats.preserved;
        }
      }
    }

    if (unresolvablePaths.length > 0) {
      const isLikelyDirectory = (p: string) => {
        const norm = p.replace(/\\/g, '/');
        if (norm.endsWith('/')) return true;
        const basename = norm.split('/').pop() ?? '';
        return !basename.includes('.');
      };
      const dirPaths = unresolvablePaths.filter(isLikelyDirectory);
      const filePaths = unresolvablePaths.filter(p => !isLikelyDirectory(p));

      if (filePaths.length > 0) {
        get().markEngramsSuspect(filePaths, 'external_file_change');
        freshnessTelemetry.suspectMarkedUnresolvable += filePaths.length;
      }
      if (dirPaths.length > 0) {
        freshnessTelemetry.suspectSkippedDirKeys += dirPaths.length;
      }
      get().recordMemoryEvent({
        action: 'reconcile',
        reason: 'refresh_unresolved_paths',
        source: unresolvablePaths.slice(0, 3).join(', ') + (unresolvablePaths.length > 3 ? ` +${unresolvablePaths.length - 3}` : ''),
        refs: [
          `unresolved:${unresolvablePaths.length}`,
          ...(dirPaths.length > 0 ? [`dir_skipped:${dirPaths.length}`] : []),
          ...(filePaths.length > 0 ? [`file_marked:${filePaths.length}`] : []),
        ],
      });
    }

    return { total, updated, invalidated, preserved, pathsProcessed: paths.length };
  },

  recordRevisionAdvance: (path: string, _newRevision: string, cause: FreshnessCause, editSessionId?: string) => {
    recordRevisionAdvanceModule(path, cause, editSessionId);
  },

  recordRebindOutcomes: (outcomes) => {
    if (!Array.isArray(outcomes) || outcomes.length === 0) return;
    set((state) => {
      const newChunks = new Map(state.chunks);
      const newArchived = new Map(state.archivedChunks);
      const newStaged = new Map(state.stagedSnippets);
      let changed = false;

      for (const outcome of outcomes) {
        if (!outcome || typeof outcome !== 'object') continue;
        const storedOutcome: RebindOutcome = {
          classification: outcome.classification,
          strategy: outcome.strategy,
          confidence: outcome.confidence,
          factors: [...outcome.factors],
          linesBefore: outcome.linesBefore,
          linesAfter: outcome.linesAfter,
          sourceRevision: outcome.sourceRevision,
          observedRevision: outcome.observedRevision,
          at: outcome.at,
        };

        const directChunk = findChunkByRef(newChunks, outcome.ref) ?? findChunkByRef(newArchived, outcome.ref);
        if (directChunk) {
          const [key, chunk] = directChunk;
          const updated = { ...chunk, lastRebind: storedOutcome };
          if (newChunks.has(key)) newChunks.set(key, updated);
          else newArchived.set(key, updated);
          changed = true;
        }

        const directStaged = findStagedByRef(newStaged, outcome.ref);
        if (directStaged) {
          const [key, snippet] = directStaged;
          newStaged.set(key, { ...snippet, lastRebind: storedOutcome });
          changed = true;
          continue;
        }

        const sourceNorm = typeof outcome.source === 'string' ? normalizeSourcePath(outcome.source) : undefined;
        if (!sourceNorm) continue;
        for (const [key, snippet] of newStaged) {
          if (normalizeSourcePath(snippet.source) !== sourceNorm) continue;
          if (outcome.linesBefore && snippet.lines && snippet.lines !== outcome.linesBefore) continue;
          newStaged.set(key, { ...snippet, lastRebind: storedOutcome });
          changed = true;
        }
      }

      if (!changed) return {};
      return {
        chunks: newChunks,
        archivedChunks: newArchived,
        stagedSnippets: newStaged,
        stageVersion: state.stageVersion + 1,
      };
    });
  },

  markEngramsSuspect: (sourcePaths?: string[], cause: FreshnessCause = 'unknown', suspectKind?: 'content' | 'structural' | 'unknown') => {
    const targets = sourcePaths?.map(path => path.replace(/\\/g, '/'));
    const effectiveCause = sourcePaths && sourcePaths.length > 0 ? cause : 'unknown';
    const effectiveSuspectKind = suspectKind ?? 'unknown';
    const now = Date.now();
    const result = { marked: 0 };
    set(state => {
      const newChunks = new Map(state.chunks);
      const newArchived = new Map(state.archivedChunks);
      const newStaged = new Map(state.stagedSnippets);

      // G12: helper — only overwrite cause when it's a severity upgrade (rebaseable → suspect-class, not the reverse)
      const REBASEABLE_CAUSES = new Set(['same_file_prior_edit', 'hash_forward']);
      const shouldUpdateCause = (existing: string | undefined) => {
        if (!existing || existing === effectiveCause) return false;
        // Don't downgrade: if existing is rebaseable and new is not, keep existing
        if (REBASEABLE_CAUSES.has(existing) && !REBASEABLE_CAUSES.has(effectiveCause)) return false;
        return true;
      };

      for (const [key, chunk] of state.chunks) {
        const chunkViewKind = chunk.viewKind ?? defaultViewKindForChunk(chunk.type);
        if (!isFileBackedType(chunk.type) || chunkViewKind !== 'latest' || !sourceMatchesTargets(chunk.source, targets)) continue;
        if (chunk.suspectSince != null) {
          if (!shouldUpdateCause(chunk.freshnessCause)) continue;
          newChunks.set(key, { ...chunk, freshnessCause: effectiveCause, suspectKind: effectiveSuspectKind });
        } else {
          newChunks.set(key, { ...chunk, suspectSince: now, freshness: 'suspect', freshnessCause: effectiveCause, suspectKind: effectiveSuspectKind });
        }
        result.marked++;
      }
      for (const [key, snippet] of state.stagedSnippets) {
        if (snippet.viewKind === 'snapshot') continue;
        if (snippet.viewKind != null && snippet.viewKind !== 'latest') continue;
        if (!sourceMatchesTargets(snippet.source, targets)) continue;
        if (snippet.suspectSince != null) {
          if (!shouldUpdateCause(snippet.freshnessCause)) continue;
          newStaged.set(key, { ...snippet, freshnessCause: effectiveCause, suspectKind: effectiveSuspectKind });
        } else {
          newStaged.set(key, { ...snippet, suspectSince: now, freshness: 'suspect', freshnessCause: effectiveCause, suspectKind: effectiveSuspectKind });
        }
        result.marked++;
      }
      for (const [key, chunk] of state.archivedChunks) {
        const chunkViewKind = chunk.viewKind ?? defaultViewKindForChunk(chunk.type);
        if (!isFileBackedType(chunk.type) || chunkViewKind !== 'latest' || !sourceMatchesTargets(chunk.source, targets)) continue;
        if (chunk.suspectSince != null) {
          if (!shouldUpdateCause(chunk.freshnessCause)) continue;
          newArchived.set(key, { ...chunk, freshnessCause: effectiveCause, suspectKind: effectiveSuspectKind });
        } else {
          newArchived.set(key, { ...chunk, suspectSince: now, freshness: 'suspect', freshnessCause: effectiveCause, suspectKind: effectiveSuspectKind });
        }
        result.marked++;
      }

      if (result.marked === 0) return {};
      return { chunks: newChunks, archivedChunks: newArchived, stagedSnippets: newStaged, stageVersion: state.stageVersion + 1 };
    });
    if (result.marked > 0 && sourcePaths && sourcePaths.length > 0) {
      get().invalidateAwarenessForPaths(sourcePaths);
      freshnessTelemetry.engramsMarkedSuspectFromPaths += result.marked;
      get().syncFreshnessMirror();
    } else if (result.marked > 0) {
      set({ awarenessCache: new Map() });
    }
    return result.marked;
  },

  clearSuspect: (hashRefOrSource: string) => {
    const target = hashRefOrSource.replace(/\\/g, '/');
    const result = { cleared: 0 };
    set(state => {
      const newChunks = new Map(state.chunks);
      const newArchived = new Map(state.archivedChunks);
      const newStaged = new Map(state.stagedSnippets);

      const chunkMatch = findChunkByRef(state.chunks, hashRefOrSource, { strict: true })
        ?? findChunkByRef(state.archivedChunks, hashRefOrSource, { strict: true });
      const stagedMatch = findStagedByRef(state.stagedSnippets, hashRefOrSource);
      const matchedSource = chunkMatch?.[1].source ?? stagedMatch?.[1].source;

      const shouldClear = (source?: string) => {
        if (!source) return false;
        if (matchedSource) return sourcesMatch(source, matchedSource);
        return sourceMatchesTargets(source, [target]);
      };

      for (const [key, chunk] of state.chunks) {
        if (chunk.suspectSince == null || !shouldClear(chunk.source)) continue;
        const nextChunk = { ...chunk };
        delete nextChunk.suspectSince;
        delete nextChunk.freshness;
        delete nextChunk.freshnessCause;
        delete nextChunk.suspectKind;
        newChunks.set(key, nextChunk);
        result.cleared++;
      }
      for (const [key, chunk] of state.archivedChunks) {
        if (chunk.suspectSince == null || !shouldClear(chunk.source)) continue;
        const nextChunk = { ...chunk };
        delete nextChunk.suspectSince;
        delete nextChunk.freshness;
        delete nextChunk.freshnessCause;
        delete nextChunk.suspectKind;
        newArchived.set(key, nextChunk);
        result.cleared++;
      }
      for (const [key, snippet] of state.stagedSnippets) {
        if (snippet.suspectSince == null || !shouldClear(snippet.source)) continue;
        const nextSnippet = { ...snippet };
        delete nextSnippet.suspectSince;
        delete nextSnippet.freshness;
        delete nextSnippet.freshnessCause;
        delete nextSnippet.suspectKind;
        newStaged.set(key, nextSnippet);
        result.cleared++;
      }

      if (result.cleared === 0) return {};
      freshnessTelemetry.clearSuspectFullClears++;
      return { chunks: newChunks, archivedChunks: newArchived, stagedSnippets: newStaged, stageVersion: state.stageVersion + 1 };
    });
    return result.cleared;
  },

  pruneObsoleteTaskArtifacts: () => {
    const result: { compacted: string[]; dropped: string[]; freedTokens: number } = { compacted: [], dropped: [], freedTokens: 0 };
    set(state => {
      const pruned = pruneLowValueChunks(state.chunks, state.archivedChunks);
      result.compacted = pruned.compacted;
      result.dropped = pruned.dropped;
      result.freedTokens = pruned.freedTokens;
      if (pruned.compacted.length === 0 && pruned.dropped.length === 0) return {};
      return {
        chunks: pruned.chunks,
        archivedChunks: pruned.archivedChunks,
        droppedManifest: new Map(state.droppedManifest),
        freedTokens: state.freedTokens + result.freedTokens,
        lastFreed: result.freedTokens,
        lastFreedAt: Date.now(),
        memoryEvents: appendMemoryEvent(state.memoryEvents, {
          action: pruned.dropped.length > 0 ? 'drop' : 'compact',
          reason: 'auto_prune_low_value',
          refs: [...pruned.compacted.slice(0, 5).map(h => `h:${h.slice(0, SHORT_HASH_LEN)}`), ...pruned.dropped.slice(0, 5).map(h => `h:${h.slice(0, SHORT_HASH_LEN)}`)],
          freedTokens: result.freedTokens,
        }),
      };
    });
    for (const hash of result.compacted) hppDematerialize(hash);
    for (const hash of result.dropped) hppArchive(hash);
    return { compacted: result.compacted.length, dropped: result.dropped.length, freedTokens: result.freedTokens };
  },
  recordMemoryEvent: (event) => {
    set(state => ({ memoryEvents: appendMemoryEvent(state.memoryEvents, event) }));
  },

  /**
   * Set or replace the full task plan.
   * Normalizes: if subtasks exist but no active, sets first subtask active.
   */
  setTaskPlan: (plan: TaskPlan | null) => {
    if (!plan) {
      set({ taskPlan: null, task: null });
      return;
    }

    const oldPlan = get().taskPlan;

    const now = Date.now();
    const directive: TaskDirective = {
      id: plan.id ?? now.toString(36),
      goal: plan.goal,
      subtasks: plan.subtasks ?? [],
      activeSubtaskId: plan.activeSubtaskId,
      status: plan.status ?? 'active',
      createdAt: plan.createdAt ?? now,
      retryCount: plan.retryCount ?? 0,
      evidenceRefs: plan.evidenceRefs ?? [],
      supersedes: plan.supersedes,
      stopReason: plan.stopReason,
    };

    if (oldPlan && oldPlan.status === 'active' && oldPlan.id !== directive.id) {
      const superseded: TaskDirective = { ...oldPlan, status: 'superseded' };
      directive.supersedes = directive.supersedes ?? oldPlan.id;
      set({ taskPlan: superseded, task: superseded });
    }

    const subtasks = directive.subtasks;
    let activeSubtaskId = directive.activeSubtaskId;
    const hasActive = subtasks.some(s => s.status === 'active');
    if (subtasks.length > 0 && (!activeSubtaskId || !hasActive)) {
      const first = subtasks[0]!;
      activeSubtaskId = first.id;
      const normalized = subtasks.map((s, i) => ({
        ...s,
        status: (i === 0 ? 'active' : (s.status === 'done' ? 'done' : 'pending')) as 'pending' | 'active' | 'done' | 'blocked',
      }));
      set({ taskPlan: { ...directive, subtasks: normalized, activeSubtaskId }, task: { ...directive, subtasks: normalized, activeSubtaskId } });
    } else {
      set({ taskPlan: directive, task: directive });
    }
  },
  
  /**
   * Advance to a subtask: mark current as done, activate target,
   * auto-unload completed subtask's unpinned chunks,
   * write summary to blackboard.
   */
  advanceSubtask: (subtaskId: string, summary?: string) => {
    let unloaded = 0;
    let freedTokens = 0;
    let manifest = '';
    const archivedHashes: string[] = [];
    
    set(state => {
      if (!state.taskPlan) return {};
      
      const subtasks = state.taskPlan.subtasks.map(s => ({ ...s }));
      const currentActive = subtasks.find(s => s.status === 'active');
      const target = subtasks.find(s => s.id === subtaskId);
      
      if (!target) return {};
      if (target.status === 'done') return {};
      
      // Mark current active as done
      if (currentActive) {
        currentActive.status = 'done';
        currentActive.summary = summary || currentActive.summary;
      }
      
      // Activate target
      target.status = 'active';
      
      // Archive chunks from completed subtask (not pinned) instead of deleting.
      // Multi-bind aware: only archive when ALL bound subtasks are done.
      const newChunks = new Map(state.chunks);
      const newArchive = new Map(state.archivedChunks);
      const manifestLines: string[] = [];
      const completedId = currentActive?.id;
      
      // Build set of all done subtask IDs (including the one we just completed)
      const doneIds = new Set(
        subtasks.filter(s => s.status === 'done').map(s => s.id)
      );
      
      if (completedId) {
        // Build a halo of source paths from pinned chunks — chunks sharing
        // these sources are kept live even if subtask-bound, so the model
        // doesn't lose content it explicitly chose to retain.
        const pinnedSourceHalo = new Set<string>();
        for (const [, c] of newChunks) {
          if (c.pinned && c.source) {
            pinnedSourceHalo.add(c.source.replace(/\\/g, '/').toLowerCase());
          }
        }

        for (const [key, chunk] of newChunks) {
          if (chunk.pinned) continue;
          
          // Resolve effective binding list (prefer subtaskIds[], fall back to subtaskId)
          const bindings = chunk.subtaskIds?.length
            ? chunk.subtaskIds
            : chunk.subtaskId ? [chunk.subtaskId] : [];
          
          // Never archive unbound chunks based on subtask completion
          if (bindings.length === 0) continue;
          
          // Skip chunks not bound to the completed subtask at all
          if (!bindings.includes(completedId)) continue;
          
          // Only archive if ALL bound subtasks are done
          const allBoundDone = bindings.every(id => doneIds.has(id));
          if (!allBoundDone) continue;

          // Pinned source halo: if a pinned chunk shares the same source
          // path, keep this chunk live to avoid losing context the model
          // deliberately kept via pin.
          if (chunk.source) {
            const normSource = chunk.source.replace(/\\/g, '/').toLowerCase();
            if (pinnedSourceHalo.has(normSource)) continue;
          }
          
          freedTokens += chunk.tokens;
          unloaded++;
          const existing = newArchive.get(key);
          if (!existing || existing.compacted) {
            newArchive.set(key, chunk);
          }
          newChunks.delete(key);
          archivedHashes.push(chunk.hash);
          manifestLines.push(formatChunkRef(chunk.shortHash, chunk.tokens, chunk.source, undefined, chunk.digest));
        }
      }
      manifest = manifestLines.join('\n');
      
      // Write composite blackboard entry: model summary + auto-manifest
      const newBb = new Map(state.blackboardEntries);
      if (completedId && summary) {
        const manifestSection = manifestLines.length > 0
          ? `\n---\nArchived context (recall by hash):\n${manifest}`
          : '';
        const compositeContent = summary + manifestSection;
        newBb.set(`subtask:${completedId}`, {
          content: compositeContent,
          createdAt: new Date(),
          tokens: countTokensSync(compositeContent),
          kind: 'status' as const,
          state: 'active' as const,
          updatedAt: Date.now(),
        });
      }
      
      // Build transition bridge so model isn't caught off guard
      let bridge: TransitionBridge | null = null;
      if (completedId && unloaded > 0) {
        bridge = {
          completedSubtaskId: completedId,
          summary: summary || '',
          archivedRefs: manifestLines.map(line => {
            const match = line.match(/h:(\w+)\s+(\d+)tk\s*(.*)/);
            return match
              ? { shortHash: match[1], tokens: parseInt(match[2], 10) || 0, source: match[3]?.trim() }
              : { shortHash: '?', tokens: 0, source: line };
          }),
          turnsRemaining: 2,
        };
      }
      
      const updatedPlan = {
        ...state.taskPlan,
        subtasks,
        activeSubtaskId: subtaskId,
      };
      const trimmedArchiveSubtask = evictArchiveIfNeeded(newArchive);
      return {
        taskPlan: updatedPlan,
        task: updatedPlan,
        chunks: newChunks,
        archivedChunks: trimmedArchiveSubtask,
        freedTokens: state.freedTokens + freedTokens,
        lastFreed: freedTokens,
        lastFreedAt: Date.now(),
        blackboardEntries: newBb,
        transitionBridge: bridge,
      };
    });
    
    // HPP: mark archived chunks so protocol tracks them as out-of-WM but reachable
    for (const h of archivedHashes) {
      hppArchive(h);
    }

    const manifestResult = get().activateManifest(subtaskId);
    if (manifestResult.restored > 0 || manifestResult.droppedRefs?.length) {
      set(state => {
        if (!state.transitionBridge) return {};
        return {
          transitionBridge: {
            ...state.transitionBridge,
            activatedSubtaskId: subtaskId,
            restoredRefs: manifestResult.refs,
            ...(manifestResult.droppedRefs?.length ? { droppedRefs: manifestResult.droppedRefs } : {}),
          },
        };
      });
    }
    
    return { unloaded, freedTokens, manifest };
  },
  
  /**
   * Get the current active subtask ID.
   */
  getActiveSubtaskId: () => {
    return get().taskPlan?.activeSubtaskId || null;
  },
  
  /**
   * Legacy setter — maps to taskPlan for backward compat.
   */
  setTask: (task: Partial<TaskPlan> | null) => {
    if (task === null) {
      set({ taskPlan: null, task: null });
      return;
    }
    
    set(state => {
      let subtasks = task.subtasks ?? state.taskPlan?.subtasks ?? [];
      let activeSubtaskId = task.activeSubtaskId !== undefined ? task.activeSubtaskId : (state.taskPlan?.activeSubtaskId ?? null);
      const hasActive = subtasks.some(s => s.status === 'active');
      if (subtasks.length > 0 && (!activeSubtaskId || !hasActive)) {
        activeSubtaskId = subtasks[0]!.id;
        subtasks = subtasks.map((s, i) => ({
          ...s,
          status: (i === 0 ? 'active' : (s.status === 'done' ? 'done' : 'pending')) as 'pending' | 'active' | 'done' | 'blocked',
        }));
      }
      const newPlan: TaskDirective = {
        id: state.taskPlan?.id || Date.now().toString(36),
        goal: task.goal || state.taskPlan?.goal || 'Working',
        subtasks,
        activeSubtaskId,
        status: state.taskPlan?.status || 'active',
        createdAt: state.taskPlan?.createdAt || Date.now(),
        retryCount: state.taskPlan?.retryCount || 0,
        evidenceRefs: state.taskPlan?.evidenceRefs || [],
        supersedes: state.taskPlan?.supersedes,
        stopReason: state.taskPlan?.stopReason,
      };
      return { taskPlan: newPlan, task: newPlan };
    });
  },
  
  /**
   * Set a blackboard entry. Returns token count.
   */
  setBlackboardEntry: (key: string, content: string, opts?: { derivedFrom?: string[]; filePath?: string; snapshotHash?: string }) => {
    if (!content || content.trim() === '') {
      const state = get();
      const newBb = new Map(state.blackboardEntries);
      newBb.delete(key);
      set({ blackboardEntries: newBb });
      return { tokens: 0 };
    }
    
    const tokens = countTokensSync(content);

    const rawDerivedFrom = opts?.derivedFrom;
    const derivedFrom = rawDerivedFrom?.map(p => validateSourceIdentity(p)).filter((p): p is string => !!p);
    let derivedRevisions: string[] | undefined;
    if (derivedFrom?.length) {
      derivedRevisions = derivedFrom.map(path => {
        const awareness = get().getAwareness(path);
        return awareness?.snapshotHash ?? '';
      });
    }

    const { kind } = parseBbKey(key);
    const resolvedFilePath = validateSourceIdentity(
      opts?.filePath ?? inferBbFilePath(key, derivedFrom, get().awarenessCache.keys()),
    );
    const resolvedSnapshot = opts?.snapshotHash
      ?? (resolvedFilePath ? get().getAwareness(resolvedFilePath)?.snapshotHash : undefined)
      ?? derivedRevisions?.[0]
      ?? undefined;
    
    set(state => {
      const newBb = new Map(state.blackboardEntries);
      const entry: BlackboardEntry = {
        content,
        createdAt: new Date(),
        tokens,
        kind,
        state: 'active',
        updatedAt: Date.now(),
      };
      if (derivedFrom?.length) entry.derivedFrom = derivedFrom;
      if (derivedRevisions?.length) entry.derivedRevisions = derivedRevisions;
      if (resolvedFilePath) entry.filePath = normalizeSourcePath(resolvedFilePath);
      if (resolvedSnapshot) entry.snapshotHash = resolvedSnapshot;
      newBb.set(key, entry);
      
      return { blackboardEntries: newBb };
    });
    
    return { tokens };
  },
  
  /**
   * Get a blackboard entry by key.
   */
  getBlackboardEntry: (key: string) => {
    const entry = get().blackboardEntries.get(key);
    return entry?.content || null;
  },

  getBlackboardEntryWithMeta: (key: string) => {
    const entry = get().blackboardEntries.get(key);
    if (!entry) return null;
    return {
      content: entry.content,
      derivedFrom: entry.derivedFrom,
      derivedRevisions: entry.derivedRevisions,
      kind: entry.kind,
      state: entry.state,
      filePath: entry.filePath,
      snapshotHash: entry.snapshotHash,
      supersededAt: entry.supersededAt,
      supersededBy: entry.supersededBy,
    };
  },
  
  /**
   * Remove a blackboard entry. Returns true if removed.
   */
  removeBlackboardEntry: (key: string) => {
    const state = get();
    if (!state.blackboardEntries.has(key)) return false;
    const newBb = new Map(state.blackboardEntries);
    newBb.delete(key);
    set({ blackboardEntries: newBb });
    return true;
  },
  
  /**
   * List all blackboard entries with preview.
   */
  listBlackboardEntries: () => {
    const entries: Array<{ key: string; preview: string; tokens: number; state: BbArtifactState; filePath?: string; supersededBy?: string }> = [];
    get().blackboardEntries.forEach((entry, key) => {
      const firstLine = entry.content.split('\n')[0].slice(0, 80);
      entries.push({
        key,
        preview: firstLine,
        tokens: entry.tokens,
        state: entry.state,
        filePath: entry.filePath,
        supersededBy: entry.supersededBy,
      });
    });
    return entries;
  },
  
  /**
   * Get total blackboard token count.
   */
  getBlackboardTokenCount: () => {
    let total = 0;
    get().blackboardEntries.forEach((e, k) => {
      if (!k.startsWith('tpl:')) total += e.tokens;
    });
    return total;
  },

  /**
   * Mark all active, file-bound, shadowable BB entries for a path as superseded.
   * Called during reconciliation and post-edit. Returns count of entries superseded.
   */
  supersedeBlackboardForPath: (path: string, newRevision: string) => {
    const pathNorm = normalizeSourcePath(path);
    let count = 0;
    const supersededKeys: Array<{ key: string; content: string; filePath?: string }> = [];
    set(state => {
      const newBb = new Map(state.blackboardEntries);
      let changed = false;
      for (const [key, entry] of state.blackboardEntries) {
        if (entry.state !== 'active') continue;
        // G7: supersede file-bound `general` entries too, not just BB_SHADOWABLE_KINDS
        const isShadowable = BB_SHADOWABLE_KINDS.has(entry.kind)
          || (entry.kind === 'general' && (entry.filePath || entry.derivedFrom?.length));
        if (!isShadowable) continue;

        const filePathMatch = entry.filePath && normalizeSourcePath(entry.filePath) === pathNorm;
        const derivedMatch = !entry.filePath && entry.derivedFrom?.some((d, i) => {
          if (normalizeSourcePath(d) !== pathNorm) return false;
          const storedRev = entry.derivedRevisions?.[i];
          return !storedRev || storedRev !== newRevision;
        });
        if (!filePathMatch && !derivedMatch) continue;

        if (entry.snapshotHash && entry.snapshotHash === newRevision) continue;
        newBb.set(key, {
          ...entry,
          state: 'superseded',
          supersededAt: Date.now(),
          supersededBy: newRevision,
        });
        supersededKeys.push({ key, content: entry.content, filePath: entry.filePath });
        changed = true;
        count++;
      }
      return changed ? { blackboardEntries: newBb } : {};
    });
    // G1: persist supersede state to DB so it survives session reload
    if (supersededKeys.length > 0) {
      const sessionId = typeof localStorage !== 'undefined'
        ? localStorage.getItem('current_session_id') : null;
      if (sessionId) {
        import('../services/chatDb').then(({ chatDb }) => {
          if (!chatDb.isInitialized()) return;
          for (const { key, content, filePath } of supersededKeys) {
            chatDb.setBlackboardNote(sessionId, key, content, 'superseded', filePath ?? undefined)
              .catch(e => console.warn('[bb] Failed to persist supersede state:', e));
          }
        }).catch(() => {});
      }
    }
    return count;
  },

  // =========================================================================
  // Cognitive Rules — self-imposed behavioral constraints
  // =========================================================================

  setRule: (key: string, content: string) => {
    if (!content || content.trim() === '') {
      const state = get();
      const newRules = new Map(state.cognitiveRules);
      newRules.delete(key);
      set({ cognitiveRules: newRules });
      return { tokens: 0 };
    }

    const tokens = countTokensSync(content);
    let warning: string | undefined;

    set(state => {
      const newRules = new Map(state.cognitiveRules);
      newRules.set(key, { content, createdAt: new Date(), tokens, scope: 'session', createdAtRev: get().getCurrentRev() });

      let totalRulesTokens = 0;
      for (const entry of newRules.values()) totalRulesTokens += entry.tokens;
      if (totalRulesTokens > RULES_MAX_TOKENS * 0.9) {
        warning = `cognitive rules ${(totalRulesTokens / 1000).toFixed(1)}k/${(RULES_MAX_TOKENS / 1000).toFixed(0)}k approaching limit`;
      }

      return { cognitiveRules: newRules };
    });

    return { tokens, warning };
  },

  removeRule: (key: string) => {
    const state = get();
    if (!state.cognitiveRules.has(key)) return false;
    const newRules = new Map(state.cognitiveRules);
    newRules.delete(key);
    set({ cognitiveRules: newRules });
    incCognitiveRulesExpired();
    return true;
  },

  listRules: () => {
    const entries: Array<{ key: string; content: string; tokens: number }> = [];
    get().cognitiveRules.forEach((entry, key) => {
      entries.push({ key, content: entry.content, tokens: entry.tokens });
    });
    return entries;
  },

  getRulesTokenCount: () => {
    let total = 0;
    get().cognitiveRules.forEach(e => total += e.tokens);
    return total;
  },

  // =========================================================================
  // Engram Mutation — annotations, synapses, retype, edit
  // =========================================================================

  addAnnotation: (hashRef: string, note: string) => {
    const state = get();
    const newChunks = new Map(state.chunks);
    const found = findOrPromoteEngram(hashRef, newChunks, state.archivedChunks, state.stagedSnippets);
    if (!found) return { ok: false, error: `engram not found: ${hashRef}` };
    const [key, chunk] = found;
    const id = `ann_${Date.now().toString(36)}`;
    const tokens = countTokensSync(note);
    const annotation: EngramAnnotation = { id, content: note, createdAt: Date.now(), tokens };
    newChunks.set(key, {
      ...chunk,
      annotations: [...(chunk.annotations || []), annotation],
    });
    set({ chunks: newChunks });
    return { ok: true, id };
  },

  addSynapse: (fromRef: string, toRef: string, relation: Synapse['relation']) => {
    const state = get();
    const newChunks = new Map(state.chunks);
    const fromFound = findOrPromoteEngram(fromRef, newChunks, state.archivedChunks, state.stagedSnippets);
    const toFound = findOrPromoteEngram(toRef, newChunks, state.archivedChunks, state.stagedSnippets);
    if (!fromFound) {
      const inManifest = findInDroppedManifest(fromRef, state.droppedManifest);
      if (inManifest) {
        return { ok: false, error: `source engram evicted (was ${inManifest.source ?? 'unknown source'}). Use session.recall to re-materialize h:${inManifest.shortHash} before linking.` };
      }
      return { ok: false, error: `source engram not found: ${fromRef}` };
    }
    if (!toFound) {
      const inManifest = findInDroppedManifest(toRef, state.droppedManifest);
      if (inManifest) {
        return { ok: false, error: `target engram evicted (was ${inManifest.source ?? 'unknown source'}). Use session.recall to re-materialize h:${inManifest.shortHash} before linking.` };
      }
      return { ok: false, error: `target engram not found: ${toRef}` };
    }
    const [fromKey, fromChunk] = fromFound;
    const [toKey, toChunk] = toFound;
    const now = Date.now();

    const forwardSynapse: Synapse = { targetHash: toChunk.hash, relation, createdAt: now };
    newChunks.set(fromKey, {
      ...fromChunk,
      synapses: [...(fromChunk.synapses || []), forwardSynapse],
    });

    const reverseRelation: Record<Synapse['relation'], Synapse['relation']> = {
      caused_by: 'related_to',
      depends_on: 'related_to',
      related_to: 'related_to',
      supersedes: 'related_to',
      refines: 'related_to',
    };
    const reverseSynapse: Synapse = { targetHash: fromChunk.hash, relation: reverseRelation[relation], createdAt: now };
    const latestTo = newChunks.get(toKey) || toChunk;
    newChunks.set(toKey, {
      ...latestTo,
      synapses: [...(latestTo.synapses || []), reverseSynapse],
    });

    set({ chunks: newChunks });
    return { ok: true };
  },

  resolveLinkRefToHash: (raw: string) => {
    const t = raw.trim();
    if (!t) return t;
    if (t.startsWith('h:bb:') || t.startsWith('bb:')) return t;
    const state = get();
    if (t.startsWith('h:')) {
      const inChunks = findChunkByRef(state.chunks, t);
      if (inChunks) return `h:${inChunks[1].hash}`;
      const inArch = findChunkByRef(state.archivedChunks, t);
      if (inArch) return `h:${inArch[1].hash}`;
      const staged = findStagedByRef(state.stagedSnippets, t);
      if (staged) return `h:${hashContentSync(staged[1].content)}`;
      return t;
    }
    const pathNorm = normalizePathForLink(t);
    for (const c of state.chunks.values()) {
      if (c.source && pathMatchesLinkRef(pathNorm, c.source)) return `h:${c.hash}`;
    }
    for (const c of state.archivedChunks.values()) {
      if (c.source && pathMatchesLinkRef(pathNorm, c.source)) return `h:${c.hash}`;
    }
    return t;
  },

  retypeChunk: (hashRef: string, newType: ChunkType) => {
    const state = get();
    const newChunks = new Map(state.chunks);
    const found = findOrPromoteEngram(hashRef, newChunks, state.archivedChunks, state.stagedSnippets);
    if (!found) return { ok: false, error: `engram not found: ${hashRef}` };
    const [key, chunk] = found;
    newChunks.set(key, { ...chunk, type: newType, lastAccessed: Date.now() });
    set({ chunks: newChunks });
    return { ok: true };
  },

  editEngram: (hashRef: string, fields: { content?: string; digest?: string; summary?: string; type?: ChunkType }) => {
    const state = get();
    const newChunks = new Map(state.chunks);
    const found = findOrPromoteEngram(hashRef, newChunks, state.archivedChunks, state.stagedSnippets);
    if (!found) return { ok: false, error: `engram not found: ${hashRef}` };
    const [, oldChunk] = found;

    const contentChanged = fields.content !== undefined && fields.content !== oldChunk.content;
    const newContent = fields.content ?? oldChunk.content;
    const newType = fields.type ?? oldChunk.type;

    // Metadata-only change: update in-place, no new hash
    if (!contentChanged) {
      newChunks.set(oldChunk.hash, {
        ...oldChunk,
        type: newType,
        digest: fields.digest ?? oldChunk.digest,
        summary: fields.summary ?? oldChunk.summary,
        lastAccessed: Date.now(),
      });
      set({ chunks: newChunks });
      return { ok: true, newHash: oldChunk.shortHash, metadataOnly: true };
    }

    const newHash = hashContentSync(newContent);
    const newShortHash = newHash.slice(0, SHORT_HASH_LEN);
    const newTokens = countTokensSync(newContent);

    const newChunk: ContextChunk = {
      ...oldChunk,
      hash: newHash,
      shortHash: newShortHash,
      type: newType,
      content: newContent,
      tokens: newTokens,
      digest: fields.digest ?? oldChunk.digest,
      summary: fields.summary ?? oldChunk.summary,
      createdAt: new Date(),
      lastAccessed: Date.now(),
      compacted: false,
    };
    delete newChunk.suspectSince;
    newChunk.freshness = 'fresh' as FreshnessState;
    delete newChunk.freshnessCause;

    // Compress old engram (hash forwarding)
    const compactContent = oldChunk.editDigest || oldChunk.digest || oldChunk.summary || `[forwarded] h:${oldChunk.shortHash} → h:${newShortHash}`;
    newChunks.set(oldChunk.hash, {
      ...oldChunk,
      content: compactContent,
      tokens: countTokensSync(compactContent),
      compacted: true,
    });

    newChunks.set(newHash, newChunk);
    set({ chunks: newChunks });
    state.pushHash(newHash);
    manifestRecordForwarding(oldChunk.shortHash, newShortHash, oldChunk.source || '', 'edit_engram', hppGetTurn());

    return { ok: true, newHash: newShortHash };
  },

  splitEngram: (hashRef: string, atLine: number) => {
    const state = get();
    const newChunks = new Map(state.chunks);
    const found = findOrPromoteEngram(hashRef, newChunks, state.archivedChunks, state.stagedSnippets);
    if (!found) return { ok: false, error: `engram not found: ${hashRef}` };
    const [, oldChunk] = found;

    // Compacted chunks store a one-line digest; split needs full text from archive (same as getChunkForHashRef).
    let splitContent: string;
    if (oldChunk.compacted) {
      const archived =
        findChunkByRef(state.archivedChunks, hashRef) ??
        findChunkByRef(state.archivedChunks, oldChunk.hash) ??
        findChunkByRef(state.archivedChunks, oldChunk.shortHash);
      if (archived) {
        splitContent = archived[1].content;
      } else if (findInDroppedManifest(hashRef, state.droppedManifest)) {
        return {
          ok: false,
          error: 'split: full content was dropped for this engram; re-read the source file before split',
        };
      } else {
        return {
          ok: false,
          error: 'split: full content unavailable for compacted engram; re-read or session.recall before split',
        };
      }
    } else {
      splitContent = oldChunk.content;
    }

    const lines = splitContent.split('\n');
    const maxAt = lines.length - 1;
    if (lines.length < 2 || atLine < 1 || atLine > maxAt) {
      return {
        ok: false,
        error:
          maxAt < 1
            ? `split line ${atLine} out of range — content has only one line (nothing to split)`
            : `split line ${atLine} out of range (1-${maxAt})`,
      };
    }

    const contentA = lines.slice(0, atLine).join('\n');
    const contentB = lines.slice(atLine).join('\n');
    const hashA = hashContentSync(contentA);
    const hashB = hashContentSync(contentB);

    const baseProps = {
      type: oldChunk.type,
      source: oldChunk.source,
      createdAt: new Date(),
      lastAccessed: Date.now(),
      subtaskId: oldChunk.subtaskId,
      subtaskIds: oldChunk.subtaskIds,
      pinned: oldChunk.pinned,
    };

    const chunkA: ContextChunk = {
      ...baseProps,
      hash: hashA,
      shortHash: hashA.slice(0, SHORT_HASH_LEN),
      content: contentA,
      tokens: countTokensSync(contentA),
      digest: generateDigest(contentA, oldChunk.type) || undefined,
      editDigest: generateEditReadyDigest(contentA, oldChunk.type) || undefined,
      annotations: oldChunk.annotations?.filter(a => {
        const lineRef = a.content.match(/L(\d+)/);
        if (!lineRef) return true;
        const n = parseInt(lineRef[1], 10);
        return !isNaN(n) && n < atLine;
      }),
      synapses: oldChunk.synapses ? [...oldChunk.synapses] : undefined,
    };

    const chunkB: ContextChunk = {
      ...baseProps,
      hash: hashB,
      shortHash: hashB.slice(0, SHORT_HASH_LEN),
      content: contentB,
      tokens: countTokensSync(contentB),
      digest: generateDigest(contentB, oldChunk.type) || undefined,
      editDigest: generateEditReadyDigest(contentB, oldChunk.type) || undefined,
      annotations: oldChunk.annotations?.filter(a => {
        const lineRef = a.content.match(/L(\d+)/);
        if (!lineRef) return true;
        const n = parseInt(lineRef[1], 10);
        return !isNaN(n) && n >= atLine;
      }).map(a => ({
        ...a,
        content: a.content.replace(/L(\d+)/g, (_m: string, num: string) => {
          const n = parseInt(num, 10);
          return `L${n - atLine + 1}`;
        }),
      })),
      synapses: oldChunk.synapses ? [...oldChunk.synapses] : undefined,
    };
    const compactContent = oldChunk.editDigest || oldChunk.digest || `[split → h:${chunkA.shortHash} + h:${chunkB.shortHash}]`;
    newChunks.set(oldChunk.hash, {
      ...oldChunk,
      content: compactContent,
      tokens: countTokensSync(compactContent),
      compacted: true,
    });
    newChunks.set(hashA, chunkA);
    newChunks.set(hashB, chunkB);
    set({ chunks: newChunks });
    state.pushHash(hashA);
    state.pushHash(hashB);

    return { ok: true, hashes: [chunkA.shortHash, chunkB.shortHash] };
  },

  mergeEngrams: (hashRefs: string[], summary?: string) => {
    if (!hashRefs || hashRefs.length < 2) {
      return { ok: false, error: 'mergeEngrams requires at least 2 hash refs' };
    }
    const state = get();
    const newChunks = new Map(state.chunks);
    const resolved: Array<[string, ContextChunk]> = [];
    for (const ref of hashRefs) {
      const found = findOrPromoteEngram(ref, newChunks, state.archivedChunks, state.stagedSnippets);
      if (!found) return { ok: false, error: `engram not found: ${ref}` };
      resolved.push(found);
    }

    const distinctSources = new Set(
      resolved.map(([, c]) => (c.source && c.source.trim() ? normalizeSourcePath(c.source) : '')).filter(Boolean),
    );
    if (distinctSources.size > 1) {
      return { ok: false, error: 'mergeEngrams: all refs must share the same file source' };
    }

    const mergedContent = resolved.map(([, c]) => c.content).join('\n\n');
    const mergedHash = hashContentSync(mergedContent);
    const firstChunk = resolved[0][1];

    const allAnnotations: EngramAnnotation[] = [];
    const allSynapses: Synapse[] = [];
    for (const [, c] of resolved) {
      if (c.annotations) allAnnotations.push(...c.annotations);
      if (c.synapses) allSynapses.push(...c.synapses);
    }

    const sourceChunks = resolved.map(([, c]) => c);
    const mergedChunk: ContextChunk = {
      hash: mergedHash,
      shortHash: mergedHash.slice(0, SHORT_HASH_LEN),
      type: firstChunk.type,
      source: firstChunk.source,
      content: mergedContent,
      tokens: countTokensSync(mergedContent),
      digest: summary || generateDigest(mergedContent, firstChunk.type) || undefined,
      editDigest: generateEditReadyDigest(mergedContent, firstChunk.type) || undefined,
      summary,
      createdAt: new Date(),
      lastAccessed: Date.now(),
      subtaskId: firstChunk.subtaskId,
      subtaskIds: firstChunk.subtaskIds,
      pinned: resolved.some(([, c]) => c.pinned),
      annotations: allAnnotations.length > 0 ? allAnnotations : undefined,
      synapses: allSynapses.length > 0 ? allSynapses : undefined,
      freshness: sourceChunks.some(c => c.freshness === 'suspect' || c.freshness === 'changed') ? 'suspect' as FreshnessState : 'fresh' as FreshnessState,
      suspectSince: sourceChunks.reduce<number | undefined>(
        (earliest, c) => c.suspectSince != null
          ? (earliest != null ? Math.min(earliest, c.suspectSince) : c.suspectSince)
          : earliest,
        undefined,
      ),
      freshnessCause: sourceChunks.find(c => c.suspectSince != null)?.freshnessCause,
      suspectKind: sourceChunks.find(c => c.suspectSince != null)?.suspectKind,
      sourceRevision: sourceChunks[0]?.sourceRevision,
    };
    for (const [, c] of resolved) {
      const compactContent = c.editDigest || c.digest || `[merged → h:${mergedChunk.shortHash}]`;
      newChunks.set(c.hash, {
        ...c,
        content: compactContent,
        tokens: countTokensSync(compactContent),
        compacted: true,
      });
    }
    newChunks.set(mergedHash, mergedChunk);
    set({ chunks: newChunks });
    state.pushHash(mergedHash);

    return { ok: true, newHash: mergedChunk.shortHash };
  },

  // =========================================================================
  // Stage (staged cached editor viewport)
  // =========================================================================

  stageSnippet: (key: string, content: string, source: string, lines?: string, sourceRevision?: string, shapeSpec?: string, viewKind?: EngramViewKind) => {
    const tokens = countTokensSync(content);
    const newStaged = new Map(get().stagedSnippets);
    const now = Date.now();
    const currentTurn = useRoundHistoryStore.getState().snapshots.length;
    const current = newStaged.get(key);
    const lifecycle = classifyStageSnippet(key, tokens);
    const sessionId = typeof localStorage !== 'undefined' ? localStorage.getItem('current_session_id') : null;
    newStaged.set(key, {
      content,
      source,
      lines,
      tokens,
      sourceRevision,
      shapeSpec,
      viewKind: defaultViewKindForStage(lines, shapeSpec, viewKind),
      admissionClass: lifecycle.admissionClass,
      persistencePolicy: lifecycle.persistencePolicy,
      demotedFrom: lifecycle.demotedFrom,
      lastUsedAt: current?.lastUsedAt ?? now,
      lastUsedRound: current?.lastUsedRound ?? currentTurn,
      shapeRecipe: (lines || shapeSpec) ? { lines, shape: shapeSpec, sourceRevision, editSessionId: sessionId ?? undefined } : undefined,
    });
    const pruned = pruneStagedSnippetsToBudget(newStaged, 'overBudget');
    set(state => ({
      stagedSnippets: pruned.staged,
      stageVersion: state.stageVersion + 1,
      memoryEvents: pruned.removed.length > 0
        ? appendMemoryEvent(state.memoryEvents, {
          action: 'evict',
          reason: 'staged over budget',
          refs: pruned.removed.map(({ key: removedKey }) => removedKey),
          freedTokens: pruned.freed,
        })
        : state.memoryEvents,
    }));
    if (/^[0-9a-fA-F]{6,16}$/.test(key)) {
      get().pushHash(key);
      get().pushStageHash(key);
    }
    return { ok: true, tokens };
  },

  unstageSnippet: (key: string) => {
    const state = get();
    if (key === '*') {
      let freed = 0;
      state.stagedSnippets.forEach(s => freed += s.tokens);
      if (freed === 0) return { freed: 0 };
      set({ stagedSnippets: new Map(), stageVersion: state.stageVersion + 1 });
      return { freed };
    }
    const existing = state.stagedSnippets.get(key);
    if (!existing) return { freed: 0 };
    const newStaged = new Map(state.stagedSnippets);
    newStaged.delete(key);
    set({ stagedSnippets: newStaged, stageVersion: state.stageVersion + 1 });
    return { freed: existing.tokens };
  },

  getStagedBlock: () => {
    const state = get();
    if (state.stagedSnippets.size === 0) return '';
    const activeEngramSources = computeActiveEngramSources(state);

    let emittedTokens = 0;
    state.stagedSnippets.forEach(snippet => {
      emittedTokens += emittedTokensForSnippet(snippet, activeEngramSources);
    });

    const lines: string[] = [];
    lines.push(`## STAGED (cached @ 10% cost, ${(emittedTokens / 1000).toFixed(1)}k tokens)`);

    state.stagedSnippets.forEach((snippet, key) => {
      const shortHash = key.slice(0, SHORT_HASH_LEN);
      const stalePrefix = (snippet.stageState === 'stale' || snippet.suspectSince != null) ? '[STALE] ' : '';
      const omitted = snippet.source != null && activeEngramSources.has(snippet.source);
      const displayTokens = omitted ? STAGED_OMITTED_POINTER_TOKENS : snippet.tokens;
      lines.push(`${stalePrefix}[${shortHash}] ${snippet.source ?? 'unknown'}${snippet.viewKind ? ':' + snippet.viewKind : ''} (${displayTokens}tk)`);
      if (omitted) {
        lines.push(`  (active engram exists — content omitted from staged block)`);
      } else {
        lines.push(snippet.content);
      }
      lines.push('');
    });
    return lines.join('\n');
  },

  getStagedTokenCount: () => {
    let total = 0;
    get().stagedSnippets.forEach(s => total += s.tokens);
    return total;
  },

  getStagedEmittedTokens: () => {
    const state = get();
    if (state.stagedSnippets.size === 0) return 0;
    const activeEngramSources = computeActiveEngramSources(state);
    let total = 0;
    state.stagedSnippets.forEach(snippet => {
      total += emittedTokensForSnippet(snippet, activeEngramSources);
    });
    return total;
  },

  getStagedEntries: () => {
    const result = new Map<string, { source: string; tokens: number }>();
    get().stagedSnippets.forEach((s, key) => result.set(key, { source: s.source, tokens: s.tokens }));
    return result;
  },

  markStagedSnippetsUsed: () => {
    const now = Date.now();
    const currentRound = useRoundHistoryStore.getState().snapshots.length;
    set(state => {
      if (state.stagedSnippets.size === 0) return {};
      const stagedSnippets = new Map<string, StagedSnippet>();
      state.stagedSnippets.forEach((snippet, key) => {
        stagedSnippets.set(key, {
          ...snippet,
          lastUsedAt: now,
          lastUsedRound: currentRound,
        });
      });
      return { stagedSnippets };
    });
  },

  getStagedSnippetsForRefresh: (sourcePath: string) => {
    const pathNorm = sourcePath.replace(/\\/g, '/').toLowerCase();
    const results: Array<{ key: string; source: string; lines?: string; shapeSpec?: string; content: string; sourceRevision?: string; viewKind?: EngramViewKind }> = [];
    get().stagedSnippets.forEach((snippet, key) => {
      if (snippet.viewKind === 'snapshot') return;
      const sNorm = snippet.source?.replace(/\\/g, '/').toLowerCase();
      if (sNorm && sNorm === pathNorm) {
        results.push({
          key,
          source: snippet.source,
          lines: snippet.lines,
          shapeSpec: snippet.shapeSpec,
          content: snippet.content,
          sourceRevision: snippet.sourceRevision,
          viewKind: snippet.viewKind,
        });
      }
    });
    return results;
  },

  forwardStagedHash: (sourcePath: string, newRevision: string) => {
    const pathNorm = sourcePath.replace(/\\/g, '/').toLowerCase();
    let updated = 0;
    set(state => {
      let changed = false;
      const nextStaged = new Map<string, StagedSnippet>();
      state.stagedSnippets.forEach((snippet, key) => {
        const sNorm = snippet.source?.replace(/\\/g, '/').toLowerCase();
        if (sNorm && sNorm === pathNorm && snippet.sourceRevision && snippet.sourceRevision !== newRevision) {
          // G2: clear suspect fields — revision is now authoritative
          nextStaged.set(key, {
            ...snippet,
            sourceRevision: newRevision,
            observedRevision: newRevision,
            suspectSince: undefined,
            freshness: undefined,
            freshnessCause: undefined,
            suspectKind: undefined,
          });
          updated++;
          changed = true;
        } else {
          nextStaged.set(key, snippet);
        }
      });
      const nextChunks = new Map(state.chunks);
      state.chunks.forEach((chunk, hash) => {
        const cNorm = chunk.source?.replace(/\\/g, '/').toLowerCase();
        if (cNorm && cNorm === pathNorm && chunk.sourceRevision && chunk.sourceRevision !== newRevision) {
          // G2: clear suspect fields — revision is now authoritative
          nextChunks.set(hash, {
            ...chunk,
            sourceRevision: newRevision,
            observedRevision: newRevision,
            suspectSince: undefined,
            freshness: undefined,
            freshnessCause: undefined,
            suspectKind: undefined,
          });
          updated++;
          changed = true;
        }
      });
      if (!changed) return {};
      return { stagedSnippets: nextStaged, chunks: nextChunks };
    });
    return updated;
  },

  rebaseStagedLineNumbers: (sourcePath: string, lineDelta: number) => {
    if (lineDelta === 0) return 0;
    let rebased = 0;
    set(state => {
      let changed = false;
      const nextStaged = new Map<string, StagedSnippet>();
      state.stagedSnippets.forEach((snippet, key) => {
        const src = snippet.source;
        if (src && sourcePathsMatch(sourcePath, src) && snippet.lines) {
          const newLines = snippet.lines.split(',').map(part => {
            const t = part.trim();
            const dash = t.indexOf('-');
            if (dash >= 0) {
              const sParsed = parseInt(t.slice(0, dash), 10);
              const eParsed = parseInt(t.slice(dash + 1), 10);
              if (isNaN(sParsed) || isNaN(eParsed)) return t; // preserve malformed ranges
              const s = Math.max(1, sParsed + lineDelta);
              const e = Math.max(s, eParsed + lineDelta);
              return `${s}-${e}`;
            }
            const n = parseInt(t, 10);
            if (isNaN(n)) return t; // preserve malformed single lines
            return String(Math.max(1, n + lineDelta));
          }).join(',');
          nextStaged.set(key, { ...snippet, lines: newLines });
          rebased++;
          changed = true;
        } else {
          nextStaged.set(key, snippet);
        }
      });
      if (!changed) return {};
      return { stagedSnippets: nextStaged };
    });
    return rebased;
  },

  pruneStagedSnippets: (reason = 'overBudget') => {
    const { stagedSnippets } = get();
    const pruned = pruneStagedSnippetsToBudget(stagedSnippets, reason);
    if (pruned.removed.length === 0) {
      return { freed: 0, removed: 0, reliefAction: 'none' as const };
    }
    set(state => ({
      stagedSnippets: pruned.staged,
      stageVersion: state.stageVersion + 1,
      memoryEvents: appendMemoryEvent(state.memoryEvents, {
        action: 'evict',
        reason: reason === 'manual' ? 'staged manual relief' : 'staged automatic relief',
        refs: pruned.removed.map(({ key: removedKey }) => removedKey),
        freedTokens: pruned.freed,
      }),
    }));
    return { freed: pruned.freed, removed: pruned.removed.length, reliefAction: pruned.reliefAction };
  },

  // =========================================================================
  // Freshness Gates — workspace revision tracking & artifact management
  // =========================================================================

  bumpWorkspaceRev: (changedPaths?: string[]) => {
    const state = get();
    const nextRev = state.workspaceRev + 1;
    const newMap = new Map(state.changedFilesSinceRev);
    if (changedPaths && changedPaths.length > 0) {
      newMap.set(nextRev, new Set(changedPaths.map(p => p.replace(/\\/g, '/').toLowerCase())));
    }
    // Cap at last 50 revs to prevent unbounded growth
    if (newMap.size > 50) {
      const sortedKeys = [...newMap.keys()].sort((a, b) => a - b);
      const toDelete = sortedKeys.slice(0, newMap.size - 50);
      for (const k of toDelete) newMap.delete(k);
    }
    set({ workspaceRev: nextRev, changedFilesSinceRev: newMap });
    import('./retentionStore').then(m => {
      m.useRetentionStore.getState().evictSearchFamily();
    }).catch(() => { /* retention store may not be initialized yet */ });
    return nextRev;
  },

  getCurrentRev: () => get().workspaceRev,

  addVerifyArtifact: (artifact: VerifyArtifact) => {
    set(state => {
      const newArtifacts = new Map(state.verifyArtifacts);
      newArtifacts.set(artifact.id, artifact);
      // Cap at 20 artifacts — evict oldest by createdAtRev
      if (newArtifacts.size > 20) {
        let oldestKey: string | null = null;
        let oldestRev = Infinity;
        for (const [k, v] of newArtifacts) {
          if (v.createdAtRev < oldestRev) {
            oldestRev = v.createdAtRev;
            oldestKey = k;
          }
        }
        if (oldestKey) newArtifacts.delete(oldestKey);
      }
      return { verifyArtifacts: newArtifacts };
    });
  },

  invalidateArtifactsForPaths: (paths: string[]) => {
    const normPaths = new Set(paths.map(p => p.replace(/\\/g, '/').toLowerCase()));
    let verifyStale = 0;
    let taskCompleteStale = false;
    set(state => {
      const newArtifacts = new Map(state.verifyArtifacts);
      for (const [id, artifact] of newArtifacts) {
        if (artifact.stale) continue;
        const intersects = artifact.filesObserved.some(f =>
          normPaths.has(f.replace(/\\/g, '/').toLowerCase())
        );
        if (intersects) {
          newArtifacts.set(id, { ...artifact, stale: true, staleReason: 'external_change_after_verification' });
          verifyStale++;
        }
      }
      let newRecord = state.taskCompleteRecord;
      let newBb = state.blackboardEntries;
      if (newRecord && newRecord.status === 'valid') {
        const tcIntersects = newRecord.filesChanged.length === 0
          || newRecord.filesChanged.some(f => normPaths.has(f.replace(/\\/g, '/').toLowerCase()));
        if (tcIntersects) {
          newRecord = { ...newRecord, status: 'stale', reason: 'external_change_after_completion' };
          taskCompleteStale = true;
          // Annotate the blackboard entry so the model sees the invalidation
          if (state.blackboardEntries.has('task_complete')) {
            newBb = new Map(state.blackboardEntries);
            const existing = newBb.get('task_complete')!;
            newBb.set('task_complete', {
              ...existing,
              content: `[STALE — files changed externally since completion] ${existing.content}`,
            });
          }
        }
      }
      return {
        verifyArtifacts: newArtifacts,
        taskCompleteRecord: newRecord,
        blackboardEntries: newBb,
      };
    });
    return { verifyStale, taskCompleteStale };
  },

  setTaskCompleteRecord: (record: TaskCompleteRecord) => {
    let compacted: string[] = [];
    let dropped: string[] = [];
    set(state => {
      const pruned = pruneLowValueChunks(state.chunks, state.archivedChunks);
      compacted = pruned.compacted;
      dropped = pruned.dropped;
      return {
        taskCompleteRecord: record,
        chunks: pruned.chunks,
        archivedChunks: pruned.archivedChunks,
        freedTokens: state.freedTokens + pruned.freedTokens,
        lastFreed: pruned.freedTokens,
        lastFreedAt: pruned.freedTokens > 0 ? Date.now() : state.lastFreedAt,
        ...(pruned.compacted.length > 0 || pruned.dropped.length > 0 ? {
          memoryEvents: appendMemoryEvent(state.memoryEvents, {
            action: pruned.dropped.length > 0 ? 'drop' : 'compact',
            reason: 'task_complete_prune',
            refs: [...pruned.compacted.slice(0, 5).map(h => `h:${h.slice(0, SHORT_HASH_LEN)}`), ...pruned.dropped.slice(0, 5).map(h => `h:${h.slice(0, SHORT_HASH_LEN)}`)],
            freedTokens: pruned.freedTokens,
          }),
        } : {}),
      };
    });
    for (const hash of compacted) hppDematerialize(hash);
    for (const hash of dropped) hppArchive(hash);
  },

  getTaskCompleteRecord: () => get().taskCompleteRecord,

  assertFreshForClaim: (claim: 'verified' | 'complete', files: string[]) => {
    const state = get();
    const normFiles = new Set(files.map(f => f.replace(/\\/g, '/').toLowerCase()));

    // Check stale reads
    for (const chunk of state.chunks.values()) {
      if (!chunk.source) continue;
      const srcNorm = chunk.source.replace(/\\/g, '/').toLowerCase();
      if (!normFiles.has(srcNorm)) continue;
      if (chunk.suspectSince != null) {
        return { ok: false, reason: `Stale read for ${chunk.source} — re-read required before ${claim}` };
      }
    }

    // Check stale verify artifacts
    if (claim === 'verified' || claim === 'complete') {
      for (const artifact of state.verifyArtifacts.values()) {
        if (!artifact.ok) continue;
        if (artifact.stale) {
          const intersects = files.length === 0 || artifact.filesObserved.some(f =>
            normFiles.has(f.replace(/\\/g, '/').toLowerCase())
          );
          if (intersects) {
            return { ok: false, reason: `Verify artifact ${artifact.stepId} stale — re-verify required` };
          }
        }
      }
    }

    // Check task complete record
    if (claim === 'complete' && state.taskCompleteRecord) {
      if (state.taskCompleteRecord.status === 'stale') {
        return { ok: false, reason: `Prior task_complete invalidated: ${state.taskCompleteRecord.reason ?? 'external change'}` };
      }
    }

    return { ok: true };
  },

  downgradeVerifyToStale: (files?: string[]) => {
    const normFiles = files ? new Set(files.map(f => f.replace(/\\/g, '/').toLowerCase())) : null;
    let downgraded = 0;
    set(state => {
      const newArtifacts = new Map(state.verifyArtifacts);
      for (const [id, artifact] of newArtifacts) {
        if (artifact.stale || !artifact.ok) continue;
        if (normFiles) {
          const intersects = artifact.filesObserved.some(f =>
            normFiles.has(f.replace(/\\/g, '/').toLowerCase())
          );
          if (!intersects) continue;
        }
        newArtifacts.set(id, { ...artifact, stale: true, staleReason: 'contradicted_by_user_evidence' });
        downgraded++;
      }
      return { verifyArtifacts: newArtifacts };
    });
    return downgraded;
  },

  getAwareness: (filePath: string): AwarenessCacheEntry | undefined => {
    const key = filePath.replace(/\\/g, '/').toLowerCase();
    const entry = get().awarenessCache.get(key);
    if (!entry) return undefined;
    // Optimized: filter by normalized path early instead of calling
    // sourceMatchesTargets (which re-normalizes) on every chunk.
    const state = get();
    const matchesPath = (source: string | undefined): boolean => {
      if (!source) return false;
      if (normalizeSourcePath(source) === key) return true;
      if (source.includes(',')) {
        for (const seg of source.split(',')) {
          const t = seg.trim();
          if (t && normalizeSourcePath(t) === key) return true;
        }
      }
      return false;
    };
    for (const [, chunk] of state.chunks) {
      if (!chunk.sourceRevision || !matchesPath(chunk.source)) continue;
      if (chunk.sourceRevision !== entry.snapshotHash) return undefined;
    }
    for (const [, snippet] of state.stagedSnippets) {
      if (!snippet.sourceRevision || !matchesPath(snippet.source)) continue;
      if (snippet.sourceRevision !== entry.snapshotHash) return undefined;
    }
    for (const [, archived] of state.archivedChunks) {
      if (!archived.sourceRevision || !matchesPath(archived.source)) continue;
      if (archived.sourceRevision !== entry.snapshotHash) return undefined;
    }
    return entry;
  },

  setAwareness: (entry: AwarenessCacheEntry): void => {
    if (!validateSourceIdentity(entry.filePath)) return;
    set(state => {
      const key = entry.filePath.replace(/\\/g, '/').toLowerCase();
      const newCache = new Map(state.awarenessCache);
      newCache.set(key, entry);
      // LRU eviction when over limit
      if (newCache.size > AWARENESS_CACHE_MAX) {
        let oldestKey: string | undefined;
        let oldestAt = Infinity;
        for (const [k, v] of newCache) {
          if (v.recordedAt < oldestAt) { oldestAt = v.recordedAt; oldestKey = k; }
        }
        if (oldestKey) newCache.delete(oldestKey);
      }
      return { awarenessCache: newCache };
    });
  },

  invalidateAwareness: (filePath: string): void => {
    const key = filePath.replace(/\\/g, '/').toLowerCase();
    set(state => {
      if (!state.awarenessCache.has(key)) return {};
      const newCache = new Map(state.awarenessCache);
      newCache.delete(key);
      return { awarenessCache: newCache };
    });
  },

  invalidateAwarenessForPaths: (paths: string[]): void => {
    if (paths.length === 0) return;
    const keys = new Set(paths.map(p => p.replace(/\\/g, '/').toLowerCase()));
    set(state => {
      let changed = false;
      const newCache = new Map(state.awarenessCache);
      for (const k of keys) {
        if (newCache.has(k)) { newCache.delete(k); changed = true; }
      }
      return changed ? { awarenessCache: newCache } : {};
    });
  },

  clearReadSpansForPaths: (paths: string[]): void => {
    if (paths.length === 0) return;
    const keys = new Set(paths.map(p => p.replace(/\\/g, '/').toLowerCase()));
    set(state => {
      let changed = false;
      const newChunks = new Map(state.chunks);
      for (const [hash, chunk] of newChunks) {
        if (!chunk.readSpan) continue;
        const rsKey = chunk.readSpan.filePath.replace(/\\/g, '/').toLowerCase();
        if (keys.has(rsKey)) {
          newChunks.set(hash, { ...chunk, readSpan: undefined });
          changed = true;
        }
      }
      return changed ? { chunks: newChunks } : {};
    });
  },

  invalidateAllAwarenessCache: (): void => {
    set({ awarenessCache: new Map() });
  },

  getAwarenessCache: (): Map<string, AwarenessCacheEntry> => {
    return get().awarenessCache;
  },

  trackReference: (hash: string) => {
    set(state => {
      const chunk = findChunkByRef(state.chunks, hash);
      if (!chunk) return {};
      const [key, c] = chunk;
      const newChunks = new Map(state.chunks);
      newChunks.set(key, { ...c, referenceCount: (c.referenceCount || 0) + 1, lastAccessed: Date.now() });
      return { chunks: newChunks };
    });
  },

  trackEdit: (hash: string) => {
    set(state => {
      const chunk = findChunkByRef(state.chunks, hash);
      if (!chunk) return {};
      const [key, c] = chunk;
      const newChunks = new Map(state.chunks);
      newChunks.set(key, { ...c, editCount: (c.editCount || 0) + 1, lastAccessed: Date.now() });
      return { chunks: newChunks };
    });
  },

  clearStaleReconcileStats: () => {
    const state = get();
    const updates: Record<string, unknown> = {};
    if (state.reconcileStats) updates.reconcileStats = null;
    updates._roundStartEventIndex = state.memoryEvents.length;
    set(updates);
  },

  pruneHashStacks: () => {
    const state = get();
    const activeHashes = new Set<string>();
    for (const chunk of state.chunks.values()) {
      if (!chunk.compacted) {
        const ref = hppGetRef(chunk.hash);
        if (!ref || hppShouldMaterialize(ref)) {
          activeHashes.add(chunk.hash);
          activeHashes.add(chunk.shortHash);
        }
      }
    }
    if (activeHashes.size === 0) return;
    const prune = (stack: string[]) => stack.filter(h => activeHashes.has(h));
    const newHash = prune(state.hashStack);
    const newEdit = prune(state.editHashStack);
    const newRead = prune(state.readHashStack);
    const newStage = prune(state.stageHashStack);
    if (newHash.length !== state.hashStack.length
      || newEdit.length !== state.editHashStack.length
      || newRead.length !== state.readHashStack.length
      || newStage.length !== state.stageHashStack.length) {
      set({
        hashStack: newHash,
        editHashStack: newEdit,
        readHashStack: newRead,
        stageHashStack: newStage,
      });
    }
  },

  tickTransitionBridge: () => {
    const bridge = get().transitionBridge;
    if (!bridge) return;
    const next = bridge.turnsRemaining - 1;
    if (next <= 0) {
      set({ transitionBridge: null });
    } else {
      set({ transitionBridge: { ...bridge, turnsRemaining: next } });
    }
  },

  /**
   * Retrieve chunk content and source by hash reference (for h: resolution).
   * Checks working memory, archive, then staged snippets.
   */
  getChunkForHashRef: (hashRef: string): { content: string; source?: string; chunkType?: string } | null => {
    // h:bb:* resolves from blackboard store
    const bbPrefix = hashRef.startsWith('h:bb:') ? hashRef.slice(5)
      : hashRef.startsWith('bb:') ? hashRef.slice(3)
      : null;
    if (bbPrefix !== null) {
      const entry = get().blackboardEntries.get(bbPrefix);
      if (entry) {
        if (entry.state !== 'active') return { content: '[SUPERSEDED]', source: `bb:${bbPrefix}`, chunkType: 'blackboard' };
        return { content: entry.content, source: `bb:${bbPrefix}`, chunkType: 'blackboard' };
      }
      return null;
    }

    const state = get();
    const found = findChunkByRef(state.chunks, hashRef);
    const suspectPrefix = (c: { freshness?: string }) =>
      (c.freshness === 'suspect' || c.freshness === 'changed') ? '[SUSPECT] ' : '';
    if (found) {
      const prefix = suspectPrefix(found[1]);
      if (found[1].compacted) {
        const archived = findChunkByRef(state.archivedChunks, hashRef);
        if (archived) return { content: prefix + archived[1].content, source: archived[1].source, chunkType: archived[1].type };
      }
      return { content: prefix + found[1].content, source: found[1].source, chunkType: found[1].type };
    }
    const archived = findChunkByRef(state.archivedChunks, hashRef);
    if (archived) {
      const prefix = suspectPrefix(archived[1]);
      return { content: prefix + archived[1].content, source: archived[1].source, chunkType: archived[1].type };
    }
    const staged = findStagedByRef(state.stagedSnippets, hashRef);
    if (staged) return { content: staged[1].content, source: staged[1].source, chunkType: 'staged' };
    return null;
  },

  /**
   * Retrieve full content of a chunk by hash reference (for recall).
   * Falls back to archivedChunks so hashes remain valid after task_advance.
   */
  getChunkContent: (hashRef: string) => {
    const state = get();
    const found = findChunkByRef(state.chunks, hashRef);
    if (found) {
      if (found[1].compacted) {
        const archived = findChunkByRef(state.archivedChunks, hashRef);
        if (archived) return archived[1].content;
        // compacted but no archive — fall through to droppedManifest
      } else {
        return found[1].content;
      }
    }
    const archived = findChunkByRef(state.archivedChunks, hashRef);
    if (archived) return archived[1].content;
    // Content permanently dropped — return actionable guidance
    const manifest = findChunkByRef(state.droppedManifest, hashRef);
    if (manifest) {
      const [, entry] = manifest;
      return `DROPPED [${entry.shortHash}, was ${entry.tokens}tk ${entry.type}${entry.source ? ` ${entry.source}` : ''}] — use {do:"read", file_paths:["${entry.source || '?'}"]} to reload`;
    }
    return null;
  },
  
  /**
   * Build tagged context string for API (delegates to contextFormatter)
   */
  getTaggedContext: () => {
    return formatTaggedContext(get().chunks);
  },
  
  /**
   * Build working memory block for Layer 3 injection.
   * Delegates to contextFormatter which integrates the Hash Pointer Protocol:
   * previously-seen chunks appear as compact h:ref digest lines.
   */
  getWorkingMemoryFormatted: () => {
    const state = get();
    const cacheHitRate = _getCacheHitRate();
    const usedTokens = state.getUsedTokens();
    const latestRound = useRoundHistoryStore.getState().snapshots.slice(-1)[0];
    const historyTokens = latestRound?.conversationHistoryTokens ?? 0;
    const historyBreakdown = latestRound?.historyBreakdownLabel ?? null;
    return formatWorkingMemory({
      chunks: state.chunks,
      blackboardEntries: state.blackboardEntries,
      cognitiveRules: state.cognitiveRules,
      droppedManifest: state.droppedManifest,
      stagedSnippets: state.stagedSnippets,
      taskPlan: state.taskPlan,
      maxTokens: state.maxTokens,
      freedTokens: state.freedTokens,
      usedTokens,
      pinnedCount: state.getPinnedCount(),
      bbTokens: state.getBlackboardTokenCount(),
      cacheHitRate,
      historyTokens,
      historyBreakdown,
      transitionBridge: state.transitionBridge,
      batchMetrics: state.batchMetrics,
      memoryEvents: state.memoryEvents,
      memoryTelemetry: summarizeMemoryTelemetry(state.memoryEvents.slice(state._roundStartEventIndex)),
      reconcileStats: state.reconcileStats,
    });
  },
  
  /**
   * Get stats line with dynamic hints (delegates to contextFormatter).
   */
  getStatsLine: () => {
    const state = get();
    const usedTokens = getEstimatedPromptPressureTokens(state);
    const latestRound = useRoundHistoryStore.getState().snapshots.slice(-1)[0];
    const roundCount = _getPromptMetrics().roundCount ?? 0;
    return formatStatsLine(
      usedTokens, state.maxTokens, state.chunks.size,
      state.getPinnedCount(), state.getBlackboardTokenCount(), state.freedTokens,
      undefined, state.batchMetrics, state.getStagedEmittedTokens(), latestRound?.conversationHistoryTokens, latestRound?.historyBreakdownLabel,
      state.chunks,
      roundCount,
    );
  },
  
  /**
   * Get task line showing plan progress (delegates to contextFormatter).
   */
  getTaskLine: () => {
    const taskMeta = get().getBlackboardEntryWithMeta('current-task-state');
    const planMeta = get().getBlackboardEntryWithMeta('current-plan-state');

    const authoritativeLines: string[] = [];

    if (taskMeta && taskMeta.state === 'active') {
      const taskMatch = taskMeta.content.match(/(?:^|\n)TASK:\s*(.+)/);
      if (taskMatch?.[1]) authoritativeLines.push(`<<TASK: ${taskMatch[1].trim()}>>`);
    }
    if (planMeta && planMeta.state === 'active') {
      const planMatch = planMeta.content.match(/(?:^|\n)PLAN:\s*(.+)/);
      if (planMatch?.[1]) authoritativeLines.push(`<<PLAN: ${planMatch[1].trim()}>>`);
    }

    if (authoritativeLines.length > 0) return authoritativeLines.join('\n');

    const taskPlan = get().taskPlan;
    if (taskPlan && (taskPlan.status === 'superseded' || taskPlan.status === 'cancelled')) {
      return '';
    }
    return formatTaskLine(taskPlan);
  },
  
  /**
   * Get full stats for context_stats() tool and UI
   */
  getStats: () => {
    const state = get();
    const chunks = Array.from(state.chunks.values()).map(c => ({
      h: c.shortHash,
      tk: c.tokens,
      type: c.type,
      src: c.source,
      age: formatAge(c.createdAt),
      pinned: !!c.pinned,
      compacted: !!c.compacted,
    }));
    
    return {
      usedTokens: state.getUsedTokens(),
      maxTokens: state.maxTokens,
      freedTokens: state.freedTokens,
      chunkCount: state.chunks.size,
      chunks,
      bbTokens: state.getBlackboardTokenCount(),
      bbCount: state.blackboardEntries.size,
      memoryTelemetry: summarizeMemoryTelemetry(state.memoryEvents),
    };
  },
  
  setMaxTokens: (max: number) => {
    set({ maxTokens: max });
  },
  
  /**
   * Reset for new session — clears everything including blackboard and HPP state.
   */
  resetSession: () => {
    resetProtocol();
    useRoundHistoryStore.getState().reset();
    _resetRetention();
    const seededBb = new Map<string, BlackboardEntry>();
    for (const [key, content] of BB_TEMPLATES) {
      seededBb.set(key, { content, createdAt: new Date(), tokens: countTokensSync(content), kind: 'general' as const, state: 'active' as const, updatedAt: Date.now() });
    }
    set({
      chunks: new Map(),
      archivedChunks: new Map(),
      droppedManifest: new Map(),
      stagedSnippets: new Map(),
      stageVersion: 0,
      transitionBridge: null,
      freedTokens: 0,
      lastFreed: 0,
      lastFreedAt: 0,
      taskPlan: null,
      task: null,
      blackboardEntries: seededBb,
      cognitiveRules: new Map(),
      memoryEvents: [],
      _roundStartEventIndex: 0,
      reconcileStats: null,
      hashStack: [],
      editHashStack: [],
      readHashStack: [],
      stageHashStack: [],
      workspaceRev: 0,
      changedFilesSinceRev: new Map(),
      verifyArtifacts: new Map(),
      taskCompleteRecord: null,
      awarenessCache: new Map(),
      rollingSummary: emptyRollingSummary(),
      batchMetrics: { toolCalls: 0, manageOps: 0, hadReads: false, hadBbWrite: false, hadSubstantiveBbWrite: false },
      batchReadNoBbStreak: 0,
      cumulativeCoveragePaths: new Set<string>(),
      _roundCoveragePaths: new Set<string>(),
      roundNewCoverage: 0,
      coveragePlateauStreak: 0,
      fileReadSpinByPath: {},
      fileReadSpinRanges: {},
      freshnessMirror: {
        fileTreeChangedWithPaths: 0,
        fileTreeChangedCoarseNoPaths: 0,
        engramsMarkedSuspectFromPaths: 0,
        coarseAwarenessOnlyInvalidations: 0,
        suspectSkippedDirKeys: 0,
        suspectMarkedUnresolvable: 0,
        suspectBulkMarkedCoarse: 0,
        clearSuspectFullClears: 0,
      },
    });
    freshnessTelemetry.reset();
  },
  
  clearLastFreed: () => {
    set({ lastFreed: 0 });
  },
  
  getStoreTokens: () => {
    let total = 0;
    get().chunks.forEach(c => total += c.tokens);
    return total;
  },

  getPromptTokens: () => {
    const DORMANT_BASE_TOKENS = 15;
    const DORMANT_FINDING_TOKENS = 20;
    let total = 0;
    const state = get();
    for (const [, c] of state.chunks) {
      if (CHAT_TYPES.has(c.type)) continue;
      // Optimized: check compacted first (cheap boolean) before calling hppGetRef (Map lookup)
      if (c.compacted) {
        const hasFinding = (c.annotations?.length ?? 0) > 0 || !!c.summary;
        total += DORMANT_BASE_TOKENS + (hasFinding ? DORMANT_FINDING_TOKENS : 0);
      } else {
        const ref = hppGetRef(c.hash);
        const isDormant = ref != null && !hppShouldMaterialize(ref);
        if (isDormant) {
          const hasFinding = (c.annotations?.length ?? 0) > 0 || !!c.summary;
          total += DORMANT_BASE_TOKENS + (hasFinding ? DORMANT_FINDING_TOKENS : 0);
        } else {
          total += c.tokens;
        }
      }
    }
    return total;
  },

  getUsedTokens: () => {
    return get().getPromptTokens();
  },

  compactDormantChunks: () => {
    let compactedCount = 0;
    let freedTokens = 0;

    set(state => {
      const newChunks = new Map(state.chunks);
      const newArchive = new Map(state.archivedChunks);

      for (const [key, chunk] of state.chunks) {
        if (chunk.compacted || chunk.pinned) continue;
        const ref = hppGetRef(chunk.hash);
        if (!ref || hppShouldMaterialize(ref)) continue;

        newArchive.set(key, { ...chunk });

        const compactContent = pickCompactContent(chunk, `[compacted] h:${chunk.shortHash}`);
        const compactTokens = countTokensSync(compactContent);
        const saved = Math.max(0, chunk.tokens - compactTokens);
        freedTokens += saved;
        compactedCount++;

        newChunks.set(key, {
          ...chunk,
          content: compactContent,
          tokens: compactTokens,
          compacted: true,
          lastAccessed: chunk.lastAccessed ?? Date.now(),
        });
      }

      if (compactedCount === 0) return {};

      return {
        chunks: newChunks,
        archivedChunks: newArchive,
        freedTokens: state.freedTokens + freedTokens,
        lastFreed: freedTokens,
        lastFreedAt: Date.now(),
        memoryEvents: appendMemoryEvent(state.memoryEvents, {
          action: 'compact',
          reason: 'dormant_auto_compact',
          freedTokens,
        }),
      };
    });

    return { compacted: compactedCount, freedTokens };
  },

  evictStaleDormantChunks: () => {
    let evicted = 0;
    let archived = 0;
    let dropped = 0;
    let freedTokens = 0;
    const evictedHashes: string[] = [];
    const DORMANT_TURN_AGE_LIMIT = 3;

    set(state => {
      const currentTurn = hppGetTurn();
      const dormantEntries: Array<[string, ContextChunk]> = [];
      for (const [key, chunk] of state.chunks) {
        if (chunk.pinned || CHAT_TYPES.has(chunk.type)) continue;
        if (chunk.compacted) {
          dormantEntries.push([key, chunk]);
        } else {
          const ref = hppGetRef(chunk.hash);
          if (ref && !hppShouldMaterialize(ref)) dormantEntries.push([key, chunk]);
        }
      }

      if (dormantEntries.length === 0) return {};

      dormantEntries.sort(([, a], [, b]) => (a.lastAccessed || 0) - (b.lastAccessed || 0));

      const newChunks = new Map(state.chunks);
      const newArchive = new Map(state.archivedChunks);

      for (const [key, chunk] of dormantEntries) {
        const ref = hppGetRef(chunk.hash);
        const seenAt = ref?.seenAtTurn ?? 0;
        const isTurnStale = currentTurn > 0 && (currentTurn - seenAt) >= DORMANT_TURN_AGE_LIMIT;
        const isOverCount = (dormantEntries.length - evicted) > MAX_DORMANT_CHUNKS;

        if (!isTurnStale && !isOverCount) continue;

        newChunks.delete(key);
        freedTokens += chunk.tokens;
        evicted++;

        if (chunk.tokens > DORMANT_ARCHIVE_THRESHOLD) {
          newArchive.set(key, { ...chunk });
          archived++;
        } else {
          newArchive.delete(key);
          dropped++;
        }
        evictedHashes.push(chunk.hash);
      }

      if (evicted === 0) return {};

      const trimmedArchiveDormant = evictArchiveIfNeeded(newArchive);

      return {
        chunks: newChunks,
        archivedChunks: trimmedArchiveDormant,
        freedTokens: state.freedTokens + freedTokens,
        lastFreed: freedTokens,
        lastFreedAt: Date.now(),
        memoryEvents: appendMemoryEvent(state.memoryEvents, {
          action: 'evict',
          reason: 'dormant_auto_clear',
          refs: evictedHashes.slice(0, 10).map(h => `h:${h.slice(0, SHORT_HASH_LEN)}`),
          freedTokens,
        }),
      };
    });

    for (const hash of evictedHashes) hppEvict(hash);

    return { evicted, archived, dropped, freedTokens };
  },

  getChunkCount: () => {
    return get().chunks.size;
  },
  
  getPinnedCount: () => {
    let count = 0;
    get().chunks.forEach(c => { if (c.pinned) count++; });
    return count;
  },
  
  getAllChunks: () => {
    return Array.from(get().chunks.values());
  },

  // -----------------------------------------------------------------------
  // Batch compliance tracking
  // -----------------------------------------------------------------------

  recordToolCall: () => {
    set(state => ({ batchMetrics: { ...state.batchMetrics, toolCalls: state.batchMetrics.toolCalls + 1 } }));
  },
  recordManageOps: (count: number) => {
    set(state => ({ batchMetrics: { ...state.batchMetrics, manageOps: state.batchMetrics.manageOps + count } }));
  },
  recordBatchRead: () => {
    set(state => ({ batchMetrics: { ...state.batchMetrics, hadReads: true } }));
  },
  recordBatchBbWrite: (key?: string, content?: string) => {
    const substantive = isSubstantiveBbWrite(key, content);
    set(state => ({
      batchMetrics: {
        ...state.batchMetrics,
        hadBbWrite: true,
        hadSubstantiveBbWrite: state.batchMetrics.hadSubstantiveBbWrite || substantive,
      },
    }));
  },
  resetBatchMetrics: () => {
    const state = get();
    if (state.batchMetrics.toolCalls === 0 && state.batchMetrics.manageOps === 0) return;
    set({ batchMetrics: { toolCalls: 0, manageOps: 0, hadReads: false, hadBbWrite: false, hadSubstantiveBbWrite: false } });
  },
  recordCoveragePath: (filePath: string) => {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    set(state => {
      const paths = new Set(state._roundCoveragePaths);
      paths.add(normalized);
      return { _roundCoveragePaths: paths };
    });
  },
  /** Called once at end of each agent round to commit coverage and compute plateau. */
  finishRoundCoverage: (hadMutations: boolean) => {
    const state = get();
    let newCount = 0;
    for (const p of state._roundCoveragePaths) {
      if (!state.cumulativeCoveragePaths.has(p)) newCount++;
    }
    const merged = new Set(state.cumulativeCoveragePaths);
    for (const p of state._roundCoveragePaths) merged.add(p);
    const plateau = (newCount === 0 && !hadMutations)
      ? state.coveragePlateauStreak + 1
      : 0;
    set({
      cumulativeCoveragePaths: merged,
      roundNewCoverage: newCount,
      coveragePlateauStreak: plateau,
      _roundCoveragePaths: new Set<string>(),
    });
  },
  getBatchMetrics: () => get().batchMetrics,

  recordFileReadSpin: (entries: Array<{ path: string; range?: string }>) => {
    if (entries.length === 0) return null;
    const EXACT_SPIN_LIMIT = 3;
    const RANGE_NUDGE_LIMIT = 5;
    let breaker: string | null = null;
    set(state => {
      const nextSpin = { ...state.fileReadSpinByPath };
      const nextRanges = { ...state.fileReadSpinRanges };
      for (const { path: p, range } of entries) {
        const pathKey = p.replace(/\\/g, '/').toLowerCase();
        const rangeKey = range ?? '*';
        const compositeKey = `${pathKey}|${rangeKey}`;

        nextSpin[compositeKey] = (nextSpin[compositeKey] ?? 0) + 1;

        if (!nextRanges[pathKey]) nextRanges[pathKey] = [];
        if (!nextRanges[pathKey].includes(rangeKey)) {
          nextRanges[pathKey] = [...nextRanges[pathKey], rangeKey];
        }

        if (nextSpin[compositeKey] >= EXACT_SPIN_LIMIT) {
          breaker = `<<WARN: "${p}" range ${rangeKey} has been read ${nextSpin[compositeKey]} times without a write or BB entry. Use the content you already have (h:ref from prior read). Do NOT re-read the same range.>>`;
        } else if (nextRanges[pathKey].length >= RANGE_NUDGE_LIMIT && !breaker) {
          const priorRanges = nextRanges[pathKey].filter(r => r !== rangeKey).join(', ');
          breaker = `<<NUDGE: "${p}" has been read at ${nextRanges[pathKey].length} different ranges (${nextRanges[pathKey].join(', ')}). Prior reads: ${priorRanges}. Search or use h:refs to find the right span before reading more.>>`;
        }
      }
      return { fileReadSpinByPath: nextSpin, fileReadSpinRanges: nextRanges };
    });
    return breaker;
  },
  resetFileReadSpin: (scopedPaths?: string[]) => {
    if (!scopedPaths || scopedPaths.length === 0) {
      set({ fileReadSpinByPath: {}, fileReadSpinRanges: {} });
      return;
    }
    set(state => {
      const nextSpin = { ...state.fileReadSpinByPath };
      const nextRanges = { ...state.fileReadSpinRanges };
      for (const p of scopedPaths) {
        const pathKey = p.replace(/\\/g, '/').toLowerCase();
        delete nextRanges[pathKey];
        for (const key of Object.keys(nextSpin)) {
          if (key.startsWith(pathKey + '|')) delete nextSpin[key];
        }
      }
      return { fileReadSpinByPath: nextSpin, fileReadSpinRanges: nextRanges };
    });
  },
  getPriorReadRanges: (filePath: string): string[] => {
    const pathKey = filePath.replace(/\\/g, '/').toLowerCase();
    return get().fileReadSpinRanges[pathKey] ?? [];
  },

  // -----------------------------------------------------------------------
  // Full-memory grep — search across all regions
  // -----------------------------------------------------------------------

  searchMemory: (query, opts) => {
    const state = get();
    const caseSensitive = opts?.caseSensitive ?? false;
    const maxResults = Math.min(opts?.maxResults ?? 50, 200);
    const allRegions = new Set<string>(opts?.regions ?? ['active', 'archived', 'dormant', 'bb', 'staged', 'dropped']);

    const needle = caseSensitive ? query : query.toLowerCase();
    const results: MemorySearchResult[] = [];

    function grepContent(text: string, maxHits: number): MemorySearchHit[] {
      const hits: MemorySearchHit[] = [];
      // Lowercase full text once instead of per-line allocation.
      const searchText = caseSensitive ? text : text.toLowerCase();
      let lineStart = 0;
      let lineNumber = 1;
      while (lineStart <= searchText.length && hits.length < maxHits) {
        let lineEnd = searchText.indexOf('\n', lineStart);
        if (lineEnd === -1) lineEnd = searchText.length;
        const haystack = searchText.slice(lineStart, lineEnd);
        if (haystack.includes(needle)) {
          // Use original text for display (preserves original casing).
          const rawLine = text.slice(lineStart, lineEnd);
          hits.push({ line: rawLine.slice(0, 200), lineNumber });
        }
        lineStart = lineEnd + 1;
        lineNumber++;
      }
      return hits;
    }

    const hitsPerEntry = 5;
    const seen = new Set<string>();

    if (allRegions.has('active')) {
      for (const [key, chunk] of state.chunks) {
        if (results.length >= maxResults) break;
        if (chunk.compacted) continue;
        seen.add(key);
        const hits = grepContent(chunk.content, hitsPerEntry);
        if (hits.length > 0) {
          results.push({ region: 'active', ref: `h:${chunk.shortHash}`, source: chunk.source, type: chunk.type, tokens: chunk.tokens, hits });
        }
      }
    }

    if (allRegions.has('dormant')) {
      for (const [key, chunk] of state.chunks) {
        if (results.length >= maxResults) break;
        if (!chunk.compacted) continue;
        seen.add(key);
        const text = chunk.digest || chunk.editDigest || chunk.content;
        const hits = grepContent(text, hitsPerEntry);
        if (hits.length > 0) {
          results.push({ region: 'dormant', ref: `h:${chunk.shortHash}`, source: chunk.source, type: chunk.type, tokens: chunk.tokens, hits });
        }
      }
    }

    if (allRegions.has('archived')) {
      for (const [key, chunk] of state.archivedChunks) {
        if (results.length >= maxResults) break;
        if (seen.has(key)) continue;
        seen.add(key);
        const hits = grepContent(chunk.content, hitsPerEntry);
        if (hits.length > 0) {
          results.push({ region: 'archived', ref: `h:${chunk.shortHash}`, source: chunk.source, type: chunk.type, tokens: chunk.tokens, hits });
        }
      }
    }

    if (allRegions.has('bb')) {
      for (const [key, entry] of state.blackboardEntries) {
        if (results.length >= maxResults) break;
        const hits = grepContent(entry.content, hitsPerEntry);
        if (hits.length > 0) {
          results.push({ region: 'bb', ref: `h:bb:${key}`, source: key, tokens: entry.tokens, hits });
        }
      }
    }

    if (allRegions.has('staged')) {
      for (const [key, snippet] of state.stagedSnippets) {
        if (results.length >= maxResults) break;
        if (seen.has(key)) continue;
        const hits = grepContent(snippet.content, hitsPerEntry);
        if (hits.length > 0) {
          results.push({ region: 'staged', ref: key.startsWith('h:') ? key : `h:${key.slice(0, SHORT_HASH_LEN)}`, source: snippet.source, tokens: snippet.tokens, hits });
        }
      }
    }

    if (allRegions.has('dropped')) {
      for (const [, entry] of state.droppedManifest) {
        if (results.length >= maxResults) break;
        const manifest = entry as { shortHash: string; source?: string; type?: string; digest?: string };
        if (manifest.digest) {
          const hits = grepContent(manifest.digest, hitsPerEntry);
          if (hits.length > 0) {
            results.push({ region: 'dropped', ref: `h:${manifest.shortHash}`, source: manifest.source, type: manifest.type, hits });
          }
        }
      }
    }

    return results;
  },

  // -----------------------------------------------------------------------
  // HPP v3 Set-Ref Queries
  // -----------------------------------------------------------------------

  queryBySetSelector: (selector, scope: 'active' | 'reachable' | 'all' = 'active') => {
    const state = get();

    // Build the candidate pool based on scope, deduplicating by hash key.
    // Active chunks take priority over archived; archived over staged.
    const seen = new Set<string>();
    const pool: ContextChunk[] = [];
    for (const [key, chunk] of state.chunks) {
      seen.add(key);
      pool.push(chunk);
    }
    if (scope === 'reachable' || scope === 'all') {
      for (const [key, chunk] of state.archivedChunks) {
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push(chunk);
      }
      for (const [key, snippet] of state.stagedSnippets) {
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push({
          hash: key, shortHash: key.slice(0, SHORT_HASH_LEN), type: 'smart',
          content: snippet.content, tokens: snippet.tokens, source: snippet.source,
          createdAt: new Date(), lastAccessed: Date.now(),
        });
      }
    }

    let matched: ContextChunk[];

    switch (selector.kind) {
      case 'subtask':
        matched = pool.filter(c => {
          const ids = c.subtaskIds?.length ? c.subtaskIds : c.subtaskId ? [c.subtaskId] : [];
          return ids.includes(selector.id);
        });
        break;
      case 'file': {
        const pattern = selector.pattern;
        const hasPathSep = pattern.includes('/') || pattern.includes('\\');
        if (pattern.includes('*')) {
          const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
          const re = new RegExp('^' + escaped + '$', 'i');
          matched = pool.filter(c => {
            if (!c.source) return false;
            if (hasPathSep) return re.test(c.source);
            const basename = c.source.split(/[/\\]/).pop() || c.source;
            return re.test(basename) || re.test(c.source);
          });
        } else {
          const lower = pattern.toLowerCase();
          matched = pool.filter(c => {
            if (!c.source) return false;
            const basename = (c.source.split(/[/\\]/).pop() || c.source).toLowerCase();
            return basename.includes(lower) || c.source.toLowerCase().includes(lower);
          });
        }
        break;
      }
      case 'type':
        matched = pool.filter(c => c.type === selector.chunkType);
        break;
      case 'edited':
        matched = pool.filter(c => c.origin === 'edit' || c.editSessionId != null);
        break;
      case 'latest':
        matched = [...pool]
          .sort((a, b) => b.lastAccessed - a.lastAccessed)
          .slice(0, selector.count);
        break;
      case 'pinned':
        matched = pool.filter(c => c.pinned);
        break;
      case 'all':
        matched = pool;
        break;
      case 'stale': {
        const now = Date.now();
        const staleCutoff = now - 5 * 60_000;
        matched = pool.filter(c => !c.compacted && !c.pinned && c.lastAccessed < staleCutoff);
        break;
      }
      case 'dormant':
        matched = pool.filter(c => !!c.compacted);
        break;
      case 'dematerialized':
        matched = pool.filter(c => {
          const r = hppGetRef(c.hash);
          return r?.visibility === 'referenced';
        });
        break;
      case 'workspace': {
        const wsName = selector.name.toLowerCase();
        const workspaces = _getWorkspaces();
        const ws = workspaces.find((w: { name: string; path: string }) => w.name.toLowerCase() === wsName);
        if (ws && ws.path !== '.') {
          const wsPath = ws.path.replace(/\\/g, '/').toLowerCase();
          matched = pool.filter(c => {
            if (!c.source) return false;
            const normalized = c.source.replace(/\\/g, '/').toLowerCase();
            const wsPrefix = wsPath.endsWith('/') ? wsPath : `${wsPath}/`;
            return normalized === wsPath || normalized.startsWith(wsPrefix);
          });
        } else if (ws) {
          matched = pool;
        } else {
          matched = [];
        }
        break;
      }
      case 'search':
        console.warn('[HPP] search selector reached sync queryBySetSelector — should be pre-resolved');
        return {
          hashes: [],
          entries: [],
          error: 'search selector requires async pre-resolution via resolveSearchRefs',
        };
      default:
        matched = [];
    }

    return {
      hashes: matched.map(c => c.hash),
      entries: matched.map(c => ({ content: c.content, source: c.source })),
    };
  },

  createSetRefLookup: (scope: 'active' | 'reachable' = 'reachable') => {
    const queryFn = get().queryBySetSelector;
    return (selector) => queryFn(selector, scope);
  },

  // -----------------------------------------------------------------------
  // HPP v4 Recency Refs
  // -----------------------------------------------------------------------

  pushHash: (hash: string) => {
    set(state => {
      const stack = [hash, ...state.hashStack.filter(h => h !== hash)];
      return { hashStack: stack.slice(0, 50) };
    });
  },

  resolveRecencyRef: (offset: number) => {
    const stack = get().hashStack;
    return offset < stack.length ? stack[offset] : null;
  },

  pushEditHash: (hash: string) => {
    set(state => {
      const stack = [hash, ...state.editHashStack.filter(h => h !== hash)];
      return { editHashStack: stack.slice(0, 50) };
    });
  },

  resolveEditRecencyRef: (offset: number) => {
    const stack = get().editHashStack;
    return offset < stack.length ? stack[offset] : null;
  },

  // HPP v4 Typed recency stacks
  pushReadHash: (hash: string) => {
    set(state => {
      const stack = [hash, ...state.readHashStack.filter(h => h !== hash)];
      return { readHashStack: stack.slice(0, 50) };
    });
  },

  resolveReadRecencyRef: (offset: number) => {
    const stack = get().readHashStack;
    return offset < stack.length ? stack[offset] : null;
  },

  pushStageHash: (hash: string) => {
    set(state => {
      const stack = [hash, ...state.stageHashStack.filter(h => h !== hash)];
      return { stageHashStack: stack.slice(0, 50) };
    });
  },

  resolveStageRecencyRef: (offset: number) => {
    const stack = get().stageHashStack;
    return offset < stack.length ? stack[offset] : null;
  },

  // -----------------------------------------------------------------------
  // Context Manifest — restore pre-bound context on subtask activation
  // -----------------------------------------------------------------------

  activateManifest: (subtaskId: string) => {
    const state = get();
    const plan = state.taskPlan;
    const subtask = plan?.subtasks.find(s => s.id === subtaskId);
    if (!subtask?.contextManifest?.length) return { restored: 0, refs: [] };

    let restored = 0;
    const restoredRefs: Array<{ shortHash: string; source?: string; tokens: number; from: 'staged' | 'archive' }> = [];
    const droppedRefs: Array<{ shortHash: string; source?: string; guidance: string }> = [];

    set(currentState => {
      const newChunks = new Map(currentState.chunks);
      const newArchive = new Map(currentState.archivedChunks);

      for (const binding of subtask.contextManifest!) {
        const shortRef = binding.hash;

        if (findChunkByRef(newChunks, shortRef)) continue;

        const staged = findStagedByRef(currentState.stagedSnippets, shortRef);
        if (staged) {
          const [, promoted] = promoteStagedToChunk(staged[0], staged[1], newChunks);
          if (promoted.subtaskIds) {
            if (!promoted.subtaskIds.includes(subtaskId)) promoted.subtaskIds.push(subtaskId);
          } else {
            promoted.subtaskIds = [subtaskId];
            promoted.subtaskId = subtaskId;
          }
          restored++;
          restoredRefs.push({ shortHash: promoted.shortHash, source: binding.source, tokens: promoted.tokens, from: 'staged' });
          hppMaterialize(promoted.hash, promoted.type, promoted.source, promoted.tokens, (promoted.content.match(/\n/g) || []).length + 1, promoted.editDigest || promoted.digest || '', promoted.shortHash);
          continue;
        }

        const archived = findChunkByRef(newArchive, shortRef);
        if (archived) {
          const [key, arc] = archived;
          const recalled = { ...arc, lastAccessed: Date.now() };
          if (recalled.sourceRevision && recalled.source) {
            const awareness = get().getAwareness(recalled.source);
            if (awareness && awareness.snapshotHash !== recalled.sourceRevision) {
              recalled.suspectSince = Date.now();
              recalled.freshness = 'suspect' as FreshnessState;
              recalled.freshnessCause = 'unknown' as FreshnessCause;
            }
          }
          if (recalled.subtaskIds) {
            if (!recalled.subtaskIds.includes(subtaskId)) recalled.subtaskIds.push(subtaskId);
          } else {
            recalled.subtaskIds = [subtaskId];
            recalled.subtaskId = subtaskId;
          }
          newChunks.set(key, recalled);
          newArchive.delete(key);
          restored++;
          restoredRefs.push({ shortHash: arc.shortHash, source: arc.source, tokens: arc.tokens, from: 'archive' });
          hppMaterialize(arc.hash, arc.type, arc.source, arc.tokens, (arc.content.match(/\n/g) || []).length + 1, arc.editDigest || arc.digest || '', arc.shortHash);
          continue;
        }

        const inDropped = findChunkByRef(currentState.droppedManifest, shortRef);
        if (inDropped) {
          const [, entry] = inDropped;
          const guidance = `DROPPED [${entry.shortHash}] — use {do:"read", file_paths:["${entry.source || '?'}"]} to reload`;
          droppedRefs.push({ shortHash: entry.shortHash, source: entry.source, guidance });
        }
      }

      return { chunks: newChunks, archivedChunks: newArchive };
    });

    return { restored, refs: restoredRefs, ...(droppedRefs.length > 0 ? { droppedRefs } : {}) };
  },
}));

// Export type for external use
export type { ChunkType };