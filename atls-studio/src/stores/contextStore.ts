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
  estimateTokens, 
  formatChunkTag,
  formatChunkRef,
  generateDigest,
  generateEditReadyDigest,
  SHORT_HASH_LEN,
  type DigestSymbol,
} from '../utils/contextHash';
import {
  formatWorkingMemory,
  formatTaggedContext,
  formatStatsLine,
  formatTaskLine,
} from '../services/contextFormatter';
import {
  STAGED_ANCHOR_BUDGET_TOKENS,
  STAGED_BUDGET_TOKENS,
  MAX_PERSISTENT_STAGE_ENTRIES,
  type PromptReliefAction,
  type StageAdmissionClass,
  type StageEvictionReason,
  type StagePersistencePolicy,
  classifyStageSnippet,
} from '../services/promptMemory';
import type { HashLookupResult, SetRefLookup, SetSelector } from '../utils/hashResolver';
import { resetProtocol, evict as hppEvict, setPinned as hppSetPinned, archive as hppArchive, materialize as hppMaterialize, dematerialize as hppDematerialize, getRef as hppGetRef, shouldMaterialize as hppShouldMaterialize } from '../services/hashProtocol';
import { useRoundHistoryStore } from './roundHistoryStore';
import { formatAge } from '../utils/formatHelpers';
import { commonPrefixLen } from './contextHelpers';
import { canonicalizeSnapshotHash } from '../services/batch/snapshotTracker';
import { emptyRollingSummary, type RollingSummary } from '../services/historyDistiller';

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

// Max tokens for archived chunks — LRU-evicted when exceeded
// Max tokens for archived chunks — LRU-evicted when exceeded
const ARCHIVE_MAX_TOKENS = 50000;

// Stale dormant engrams above this threshold are archived on eviction;
// those at or below (e.g. batch call stubs at ~7tk) are dropped outright.
const DORMANT_ARCHIVE_THRESHOLD = 1000;

// Maximum dormant (compacted+unpinned) chunks before LRU eviction kicks in.
// Search results, batch stubs, tree reads etc. don't have file-backed sources
// so reconcileSourceRevision never evicts them — this count-based limit does.
const MAX_DORMANT_CHUNKS = 1000;

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
  action: 'read' | 'write' | 'compact' | 'archive' | 'drop' | 'evict' | 'invalidate' | 'reconcile' | 'retry' | 'block';
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

// Tracks paths we recently wrote (for same_file_prior_edit cause at reconcile)
const RECENT_ADVANCE_TTL_MS = 10_000;
const recentRevisionAdvances = new Map<string, { cause: FreshnessCause; sessionId?: string; at: number }>();
function recordRevisionAdvanceModule(path: string, cause: FreshnessCause, sessionId?: string): void {
  const norm = path.replace(/\\/g, '/').toLowerCase();
  recentRevisionAdvances.set(norm, { cause, sessionId, at: Date.now() });
  // Prune old entries
  const cutoff = Date.now() - RECENT_ADVANCE_TTL_MS;
  for (const [k, v] of recentRevisionAdvances) {
    if (v.at < cutoff) recentRevisionAdvances.delete(k);
  }
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
  shortHash: string;   // First 8 chars for display
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
  subtaskId?: string;  // Which subtask this chunk belongs to (legacy, single)
  subtaskIds?: string[];        // Bound to multiple subtasks (survives until ALL are done)
  boundDuringPlanning?: boolean; // Pre-bound during research/planning phase
  fullHash?: string;            // Back-reference to h:FULL in registry (for shaped chunks)
  referenceCount?: number;      // How many times the model cited this hash
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
}

export interface ReadSpan {
  filePath: string;
  startLine?: number;
  endLine?: number;
  shape?: string;
  sourceRevision: string;
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

// Task plan for AI orientation and context lifecycle
export interface TaskPlan {
  goal: string;
  subtasks: SubTask[];
  activeSubtaskId: string | null;
}

// Legacy type alias for backward compatibility
export type TaskState = TaskPlan;

// Blackboard entry - persistent session knowledge
export interface BlackboardEntry {
  content: string;
  createdAt: Date;
  tokens: number;
  derivedFrom?: string[];
  derivedRevisions?: string[];
}

// Cognitive rule — self-imposed behavioral constraint written by the model
export interface CognitiveRule {
  content: string;
  createdAt: Date;
  tokens: number;
  scope: 'session';
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
}

// Soft ceiling for staged snippets (tokens) — stats line warns above this
// so the model can self-manage. No hard rejection; staging always succeeds.
export const STAGE_SOFT_CEILING = 25000;
const MAX_MEMORY_EVENTS = 100;

function shouldAutoCompactChunk(chunk: ContextChunk): boolean {
  if (chunk.pinned) return false;
  if (CHAT_TYPES.has(chunk.type)) return false;
  if (chunk.type === 'result' && chunk.tokens <= 12) return false;
  return chunk.type === 'issues'
    || chunk.type === 'result'
    || chunk.type === 'call'
    || chunk.type === 'symbol'
    || chunk.type === 'deps'
}

function shouldAutoDropChunk(chunk: ContextChunk): boolean {
  if (chunk.pinned) return false;
  if (CHAT_TYPES.has(chunk.type)) return false;
  return chunk.type === 'result' || chunk.type === 'call';
}

function pruneLowValueChunks(
  chunks: Map<string, ContextChunk>,
  archivedChunks: Map<string, ContextChunk>,
): {
  chunks: Map<string, ContextChunk>;
  archivedChunks: Map<string, ContextChunk>;
  compacted: string[];
  dropped: string[];
  freedTokens: number;
} {
  const nextChunks = new Map(chunks);
  const nextArchived = new Map(archivedChunks);
  const compacted: string[] = [];
  const dropped: string[] = [];
  let freedTokens = 0;

  for (const [key, chunk] of chunks) {
    if (shouldAutoDropChunk(chunk)) {
      nextChunks.delete(key);
      // Preserve in archive for potential recall — only remove from active chunks
      if (!nextArchived.has(key)) {
        nextArchived.set(key, { ...chunk });
      }
      dropped.push(chunk.hash);
      freedTokens += chunk.tokens;
      continue;
    }

    if (!chunk.compacted && shouldAutoCompactChunk(chunk)) {
      nextArchived.set(key, { ...chunk });
      const compactContent = chunk.editDigest || chunk.digest || chunk.summary || `[compacted] h:${chunk.shortHash}`;
      const compactTokens = estimateTokens(compactContent);
      nextChunks.set(key, {
        ...chunk,
        content: compactContent,
        tokens: compactTokens,
        compacted: true,
        lastAccessed: Date.now(),
      });
      compacted.push(chunk.hash);
      freedTokens += Math.max(0, chunk.tokens - compactTokens);
    }
  }

  return { chunks: nextChunks, archivedChunks: nextArchived, compacted, dropped, freedTokens };
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

function getPersistentAnchorTokens(staged: Map<string, StagedSnippet>): number {
  let total = 0;
  for (const snippet of staged.values()) {
    if (snippet.admissionClass === 'persistentAnchor') total += snippet.tokens;
  }
  return total;
}

function getPersistentAnchorCount(staged: Map<string, StagedSnippet>): number {
  let count = 0;
  for (const snippet of staged.values()) {
    if (snippet.admissionClass === 'persistentAnchor') count++;
  }
  return count;
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

  const totalTokens = () => {
    let total = 0;
    next.forEach((snippet) => { total += snippet.tokens; });
    return total;
  };

  const takeLowestValue = (): boolean => {
    const candidates = Array.from(next.entries())
      .sort(([keyA, snippetA], [keyB, snippetB]) => {
        const priorityDelta = getStagePriority(keyA, snippetA) - getStagePriority(keyB, snippetB);
        if (priorityDelta !== 0) return priorityDelta;
        const suspectA = snippetA.suspectSince ?? 0;
        const suspectB = snippetB.suspectSince ?? 0;
        if (suspectA !== suspectB) return suspectB - suspectA;
        return getStageRecency(snippetA) - getStageRecency(snippetB);
      });
    const victim = candidates[0];
    if (!victim) return false;
    next.delete(victim[0]);
    removed.push({ key: victim[0], snippet: { ...victim[1], evictionReason: reason } });
    freed += victim[1].tokens;
    return true;
  };

  // Staged total budget removed — staged content is naturally bounded by entry count
  // and the STAGE_SOFT_CEILING (25k). Only anchor-specific limits remain.

  while (getPersistentAnchorTokens(next) > STAGED_ANCHOR_BUDGET_TOKENS && takeLowestValue()) {
    // Persistent anchors must remain tiny.
  }

  while (getPersistentAnchorCount(next) > MAX_PERSISTENT_STAGE_ENTRIES && takeLowestValue()) {
    // Keep durable staged anchor count bounded.
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
  const promptMetrics = _getPromptMetrics();
  const staticSystemTokens = promptMetrics.modePromptTokens
    + promptMetrics.toolRefTokens
    + promptMetrics.shellGuideTokens
    + (promptMetrics.nativeToolTokens ?? 0)
    + promptMetrics.contextControlTokens;
  // BB is in the dynamic block (uncached). History is the only BP3 content.
  const bp3Tokens = (promptMetrics.bp3PriorTurnsTokens ?? 0);
  const stagedTokens = state.getStagedTokenCount();
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
  batchMetrics: { toolCalls: number; manageOps: number }; // Per-turn batch compliance
  /** Distilled facts for API-only rolling summary (not in chat UI messages) */
  rollingSummary: RollingSummary;
  setRollingSummary: (summary: RollingSummary) => void;
  memoryEvents: MemoryEvent[];

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
  addChunk: (content: string, type: ChunkType, source?: string, symbols?: DigestSymbol[], summary?: string, backendHash?: string, opts?: { subtaskIds?: string[]; boundDuringPlanning?: boolean; fullHash?: string; sourceRevision?: string; viewKind?: EngramViewKind; editSessionId?: string; origin?: EngramOrigin; readSpan?: ReadSpan; ttl?: number }) => string;
  findReusableRead: (span: ReadSpan) => string | null;
  touchChunk: (hash: string) => void;
  compactChunks: (hashes: string[], opts?: { confirmWildcard?: boolean; tier?: 'pointer' | 'sig'; sigContentByRef?: Map<string, string> }) => { compacted: number; freedTokens: number };
  unloadChunks: (hashes: string[], opts?: { confirmWildcard?: boolean }) => { freed: number; count: number; pinnedKept: number };
  dropChunks: (hashes: string[], opts?: { confirmWildcard?: boolean }) => { dropped: number; freedTokens: number };
  pinChunks: (hashes: string[], shape?: string) => number;
  unpinChunks: (hashes: string[]) => number;
  registerEditHash: (hash: string, source: string, editSessionId?: string) => { registered: boolean; reason?: string };
  invalidateStaleHashes: (shortHashes: string[]) => number;
  /** Invalidate derived shapes (staged, chunks, bindings) where source matches path and sourceRevision !== currentRevision. */
  invalidateDerivedForPath: (path: string, currentRevision: string) => number;
  reconcileSourceRevision: (path: string, currentRevision: string, cause?: FreshnessCause) => ReconcileStats;
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
  setBlackboardEntry: (key: string, content: string, opts?: { derivedFrom?: string[] }) => { tokens: number; warning?: string };
  getBlackboardEntry: (key: string) => string | null;
  getBlackboardEntryWithMeta: (key: string) => { content: string; derivedFrom?: string[]; derivedRevisions?: string[] } | null;
  removeBlackboardEntry: (key: string) => boolean;
  listBlackboardEntries: () => Array<{ key: string; preview: string; tokens: number }>;
  getBlackboardTokenCount: () => number;

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
  getAwarenessCache: () => Map<string, AwarenessCacheEntry>;

  // Cache affinity tracking
  trackReference: (hash: string) => void;
  trackEdit: (hash: string) => void;

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
  getBatchMetrics: () => { toolCalls: number; manageOps: number };

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

function sourcesMatch(a: string, b: string): boolean {
  return normalizeSourcePath(a) === normalizeSourcePath(b);
}

function isFileBackedType(type: string): boolean {
  return type === 'file' || type === 'smart' || type === 'raw' || type === 'result';
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
  if (events.length < MAX_MEMORY_EVENTS) return [...events, nextEvent];
  return [...events.slice(1), nextEvent];
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

  // 2. Exact shortHash match (deterministic, O(n))
  for (const [key, chunk] of chunks) {
    if (chunk.shortHash === normalized) return [key, chunk];
  }

  // 3. Prefix match — requires MIN_PREFIX_LEN to reduce short-prefix collisions
  if (!opts?.strict && normalized.length >= MIN_PREFIX_LEN) {
    let best: [string, T] | null = null;
    let bestLen = 0;
    for (const [key, chunk] of chunks) {
      if (key.startsWith(normalized) || chunk.hash.startsWith(normalized)) {
        const overlap = Math.max(
          commonPrefixLen(key, normalized),
          commonPrefixLen(chunk.hash, normalized),
        );
        if (overlap > bestLen) {
          bestLen = overlap;
          best = [key, chunk];
        }
      }
    }
    return best;
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
  let best: [string, StagedSnippet] | null = null;
  let bestLen = 0;
  for (const [key, snippet] of staged) {
    const keyBase = refToBaseHash(key.startsWith('h:') ? key : `h:${key}`);
    if (keyBase === baseHash) return [key, snippet];
    if (baseHash.length >= MIN_PREFIX_LEN && keyBase.startsWith(baseHash)) {
      const overlap = commonPrefixLen(keyBase, baseHash);
      if (overlap > bestLen) {
        bestLen = overlap;
        best = [key, snippet];
      }
    }
  }
  return best;
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

  const archived = findChunkByRef(archivedChunks, ref);
  if (archived) {
    const [, arc] = archived;
    chunksMap.set(arc.hash, { ...arc, lastAccessed: Date.now() });
    // HPP: re-materialize — chunk is back in working memory
    hppMaterialize(arc.hash, arc.type, arc.source, arc.tokens, (arc.content.match(/\n/g) || []).length + 1, arc.editDigest || arc.digest || '');
    return [arc.hash, chunksMap.get(arc.hash)!];
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
 * Evict oldest archived chunks (by createdAt) until total archived tokens <= ARCHIVE_MAX_TOKENS.
 * Returns the (potentially trimmed) archive map. Call after any operation that adds to archive.
 */
function evictArchiveIfNeeded(archive: Map<string, ContextChunk>): Map<string, ContextChunk> {
  // BUG1 FIX: Snapshot entries before eviction to avoid TOCTOU race on lastAccessed.
  // We sort a frozen snapshot so concurrent accesses between sort and delete don't
  // cause the most-recently-used chunk to be incorrectly evicted.
  const snapshot = Array.from(archive.entries());
  let totalTokens = 0;
  for (const [, c] of snapshot) totalTokens += c.tokens;
  if (totalTokens <= ARCHIVE_MAX_TOKENS) return archive;

  const sorted = snapshot.sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);

  for (const [key, chunk] of sorted) {
    if (totalTokens <= ARCHIVE_MAX_TOKENS) break;
    totalTokens -= chunk.tokens;
    archive.delete(key);
    hppEvict(chunk.hash);
  }
  return archive;
}

const CHAT_TYPES = new Set(['msg:user', 'msg:asst']);

/**
 * Identify the most recent N chat chunk hashes that are protected from compact/drop.
 * N is adaptive: scales from FLOOR (high pressure) to CEILING (low pressure).
 * Returns { hashes, protectedCount } so callers can surface the current protection level.
 */
function getProtectedChatHashes(
  chunks: Map<string, ContextChunk>,
  usedTokens: number,
  maxTokens: number,
): { hashes: Set<string>; protectedCount: number } {
  const count = getAdaptiveChatProtectionCount(usedTokens, maxTokens);
  const chatChunks = Array.from(chunks.entries())
    .filter(([, c]) => CHAT_TYPES.has(c.type))
    .sort(([, a], [, b]) => b.createdAt.getTime() - a.createdAt.getTime());
  const hashes = new Set<string>();
  const protectedCount = Math.min(count, chatChunks.length);
  for (let i = 0; i < protectedCount; i++) {
    const [key, chunk] = chatChunks[i];
    hashes.add(key);
    hashes.add(chunk.hash);
    hashes.add(chunk.shortHash);
  }
  return { hashes, protectedCount };
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
  batchMetrics: { toolCalls: 0, manageOps: 0 },
  rollingSummary: emptyRollingSummary(),
  setRollingSummary: (summary) => set({ rollingSummary: summary }),
  memoryEvents: [],
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

  /**
   * Add a new chunk to the context.
   * Uses full 16-char hash as Map key for collision resistance.
   * Tags chunk with current activeSubtaskId.
   * Returns the shortHash for display/reference.
   */
  addChunk: (content: string, type: ChunkType, source?: string, symbols?: DigestSymbol[], summary?: string, backendHash?: string, opts?: { subtaskIds?: string[]; boundDuringPlanning?: boolean; fullHash?: string; sourceRevision?: string; viewKind?: EngramViewKind; editSessionId?: string; origin?: EngramOrigin; readSpan?: ReadSpan; ttl?: number }) => {
    const hash = backendHash || hashContentSync(content);
    const shortHash = hash.slice(0, SHORT_HASH_LEN);
    const tokens = estimateTokens(content);
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
      ttl: opts?.ttl ?? (type === 'result' ? 3 : undefined),
    };
    
    set(state => {
      const newChunks = new Map(state.chunks);
      
      // Check for hash collision with different content (rare but possible)
      const existing = newChunks.get(hash);
      if (existing && existing.content !== content) {
        const suffix = (++_collisionCounter).toString(36);
        const disambiguated = hash + '_' + suffix;
        const disambiguatedShort = (hash.slice(0, SHORT_HASH_LEN - suffix.length - 1) + '_' + suffix).slice(0, SHORT_HASH_LEN);
        newChunks.set(disambiguated, { ...chunk, hash: disambiguated, shortHash: disambiguatedShort });
        return { chunks: newChunks };
      }

      // Hash forwarding: auto-compress previous version of the same file.
      // When a file-sourced chunk is re-read/re-edited, the old chunk is
      // immediately compressed to its digest. One full-content chunk per path.
      if (source && isFileBackedType(type)) {
        for (const [key, c] of newChunks) {
          if (key === hash) continue;
          if (c.source && sourcesMatch(c.source, source) && isFileBackedType(c.type) && !c.compacted) {
            const compactContent = c.editDigest || c.digest || c.summary || `[forwarded] h:${c.shortHash} → h:${shortHash}`;
            const digestTokens = estimateTokens(compactContent);
            newChunks.set(key, {
              ...c,
              content: compactContent,
              tokens: digestTokens,
              compacted: true,
            });
            // Transfer pin state, annotations, and synapses to the new chunk
            if (c.pinned) {
              chunk.pinned = true;
            }
            if (c.annotations?.length) {
              chunk.annotations = [...(chunk.annotations || []), ...c.annotations];
            }
            if (c.synapses?.length) {
              chunk.synapses = [...(chunk.synapses || []), ...c.synapses];
            }
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
      let newArchive: Map<string, ContextChunk> | undefined;
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

        const stagedRelief = pruneStagedSnippetsToBudget(state.stagedSnippets, 'overBudget');
        if (stagedRelief.removed.length > 0) {
          nextStagedSnippets = stagedRelief.staged;
          stageVersionBump = 1;
          stagedReliefFreed = stagedRelief.freed;
          stagedReliefRefs = stagedRelief.removed.map(({ key }) => key);
          estimatedPromptPressure -= stagedRelief.freed;
        }

          const { hashes: protectedChat } = getProtectedChatHashes(newChunks, currentUsed, state.maxTokens);
          const completedSubtaskIds = new Set(
            (state.taskPlan?.subtasks || [])
              .filter(s => s.status === 'done')
              .map(s => s.id)
          );

          const isCompletedSubtaskChunk = (c: ContextChunk) => {
            const ids = c.subtaskIds?.length ? c.subtaskIds : c.subtaskId ? [c.subtaskId] : [];
            return ids.length > 0 && ids.every(id => completedSubtaskIds.has(id));
          };

          const undoProtectedHashes = new Set(state.editHashStack);
          const isProtected = (h: string, c: ContextChunk) =>
            c.pinned
            || undoProtectedHashes.has(h) || undoProtectedHashes.has(c.shortHash)
            || protectedChat.has(h) || protectedChat.has(c.hash) || protectedChat.has(c.shortHash);

          const isChatChunk = (c: ContextChunk) => CHAT_TYPES.has(c.type);

          // Tier 1: completed-subtask non-chat (cheapest to lose)
          const tier1 = Array.from(newChunks.entries())
            .filter(([h, c]) => !isProtected(h, c) && isCompletedSubtaskChunk(c) && !isChatChunk(c))
            .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);

          // Tier 2: other non-chat, non-pinned chunks
          const tier2 = Array.from(newChunks.entries())
            .filter(([h, c]) => !isProtected(h, c) && !isCompletedSubtaskChunk(c) && !isChatChunk(c))
            .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);

          // Tier 3: unprotected chat (last resort)
          // Normal pressure: model manages chat via compact_history/drop per prompt
          const tier3 = Array.from(newChunks.entries())
            .filter(([h, c]) => !isProtected(h, c) && isChatChunk(c))
            .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);

          const candidates = [...tier1, ...tier2, ...tier3];

          // Phase 1: Compact uncompacted chunks (preserves in archive, ~95% savings)
          for (const [key, c] of candidates) {
            if (currentUsed + tokens - totalFreed <= state.maxTokens * 0.50) break;
            if (c.compacted) continue;

            if (!newArchive) newArchive = new Map(state.archivedChunks);
            newArchive.set(key, { ...c });

            let editDigest = c.editDigest || c.digest || '';
            if (c.source) {
              const basename = c.source.split('/').pop() ?? c.source;
              const errEntry = state.blackboardEntries.get(`err:${basename}`);
              if (errEntry && editDigest) {
                editDigest = editDigest + ` [ERR ${errEntry.content.slice(0, 60)}]`;
              }
            }
            const compactContent = editDigest || c.summary || `[compacted] h:${c.shortHash}`;
            const digestTokens = estimateTokens(compactContent);
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

          _autoManageInProgress = false;
          if (_autoManagePending) {
            _autoManagePending = false;
            currentUsed = 0;
            for (const c of newChunks.values()) currentUsed += c.tokens;
            if (currentUsed + tokens > state.maxTokens * 0.90) {
              _autoManageInProgress = true;
              try {
              const { hashes: protectedChat2 } = getProtectedChatHashes(newChunks, currentUsed, state.maxTokens);
              const completedSubtaskIds2 = new Set(
                (state.taskPlan?.subtasks || []).filter(s => s.status === 'done').map(s => s.id)
              );
              const isCompletedSubtaskChunk2 = (c: ContextChunk) => {
                const ids = c.subtaskIds?.length ? c.subtaskIds : c.subtaskId ? [c.subtaskId] : [];
                return ids.length > 0 && ids.every(id => completedSubtaskIds2.has(id));
              };
              const undoProtectedHashes2 = new Set(state.editHashStack);
              const isProtected2 = (h: string, c: ContextChunk) =>
                c.pinned ||
                undoProtectedHashes2.has(h) || undoProtectedHashes2.has(c.shortHash) ||
                protectedChat2.has(h) || protectedChat2.has(c.hash) || protectedChat2.has(c.shortHash);
              const isChatChunk2 = (c: ContextChunk) => CHAT_TYPES.has(c.type);
              const tier1b = Array.from(newChunks.entries())
                .filter(([h, c]) => !isProtected2(h, c) && isCompletedSubtaskChunk2(c) && !isChatChunk2(c))
                .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);
              const tier2b = Array.from(newChunks.entries())
                .filter(([h, c]) => !isProtected2(h, c) && !isCompletedSubtaskChunk2(c) && !isChatChunk2(c))
                .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);
              const tier3b = Array.from(newChunks.entries())
                .filter(([h, c]) => !isProtected2(h, c) && isChatChunk2(c))
                .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);
              const candidates2 = [...tier1b, ...tier2b, ...tier3b];
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
                const digestTokens2 = estimateTokens(compactContent2);
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
          }
      }

      newChunks.set(hash, chunk);

      // Atomically clean manifest only after chunk is inserted
      if (state.droppedManifest.has(hash)) {
        newManifest = new Map(state.droppedManifest);
        newManifest.delete(hash);
      }
      const manifestUpdate = newManifest ? { droppedManifest: newManifest } : {};
      if (totalFreed > 0) {
        if (newArchive) evictArchiveIfNeeded(newArchive);
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

    // Push to recency stacks (file-relevant types only — keeps h:$last aligned with h:$last_read)
    const FILE_TYPES_FOR_RECENCY = new Set(['file', 'smart', 'raw', 'tree', 'search', 'symbol', 'deps']);
    if (FILE_TYPES_FOR_RECENCY.has(type)) {
      get().pushHash(shortHash);
      get().pushReadHash(shortHash);
    }
    for (const compactedHash of autoCompactedHashes) hppDematerialize(compactedHash);
    for (const evictedHash of autoEvictedHashes) hppEvict(evictedHash);
    
    return shortHash;
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
    // Update lastAccessed outside the iteration loop to avoid mid-iteration re-renders
    if (matchHash) {
      set(s => {
        const nc = new Map(s.chunks);
        const c = nc.get(matchHash!);
        if (c) nc.set(matchHash!, { ...c, lastAccessed: Date.now() });
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
        if (tier === 'sig' && opts?.sigContentByRef) {
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
        const digestTokens = estimateTokens(compactContent);

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

      evictArchiveIfNeeded(newArchive);
      return {
        chunks: newChunks,
        archivedChunks: newArchive,
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
        evictArchiveIfNeeded(newArchive);
        return {
          chunks: newChunks,
          archivedChunks: newArchive,
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
      
      evictArchiveIfNeeded(newArchive);
      return {
        chunks: newChunks,
        archivedChunks: newArchive,
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
        droppedManifest: newManifest,
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
    
    return { dropped, freedTokens };
  },
  
  /**
   * Pin chunks to protect from bulk unload.
   * Also recalls archived chunks and promotes staged snippets when pinned.
   */
  pinChunks: (hashes: string[], shape?: string) => {
    let count = 0;
    
    set(state => {
      const newChunks = new Map(state.chunks);
      const newArchived = new Map(state.archivedChunks);
      
      for (const h of hashes) {
        const found = findChunkByRef(newChunks, h);
        if (found && !found[1].pinned) {
          newChunks.set(found[0], { ...found[1], pinned: true });
          hppSetPinned(found[0], true, shape);
          count++;
        } else if (!found) {
          const archived = findChunkByRef(newArchived, h);
          if (archived) {
            newArchived.delete(archived[0]);
            const recalled = { ...archived[1], pinned: true, lastAccessed: Date.now() } as typeof archived[1];
            // Freshness check: if file-backed and sourceRevision is stale, mark suspect
            if (recalled.source && isFileBackedType(recalled.type) && recalled.sourceRevision) {
              const awareness = get().getAwareness(recalled.source);
              if (awareness && awareness.snapshotHash !== recalled.sourceRevision) {
                recalled.suspectSince = Date.now();
                recalled.freshness = 'suspect' as FreshnessState;
                recalled.freshnessCause = 'unknown' as FreshnessCause;
              }
            }
            newChunks.set(archived[0], recalled);
            // HPP: transition from archived → materialized, then pin
            hppMaterialize(recalled.hash, recalled.type, recalled.source, recalled.tokens, (recalled.content.match(/\n/g) || []).length + 1, recalled.editDigest || recalled.digest || '');
            hppSetPinned(archived[0], true, shape);
            count++;
          } else {
            const staged = findStagedByRef(state.stagedSnippets, h);
            if (staged) {
              const [, promoted] = promoteStagedToChunk(staged[0], staged[1], newChunks);
              newChunks.set(promoted.hash, { ...promoted, pinned: true });
              hppSetPinned(promoted.hash, true, shape);
              count++;
            }
          }
        }
      }
      
      return { chunks: newChunks, archivedChunks: newArchived };
    });
    
    return count;
  },
  
  /**
   * Unpin chunks to allow bulk unload.
   */
  unpinChunks: (hashes: string[]) => {
    let count = 0;
    
    set(state => {
      const newChunks = new Map(state.chunks);
      
      for (const h of hashes) {
        const found = findChunkByRef(newChunks, h);
        if (found && found[1].pinned) {
          newChunks.set(found[0], { ...found[1], pinned: false });
          hppSetPinned(found[0], false);
          count++;
        }
      }
      
      return { chunks: newChunks };
    });
    
    return count;
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
    return evicted;
  },

  /**
   * Invalidate derived shapes (staged snippets, chunks) where source matches path
   * and sourceRevision !== currentRevision. Uses immediate eviction (no stale tracking).
   */
  invalidateDerivedForPath: (path: string, currentRevision: string) => {
    const norm = normalizeSourcePath;
    const pathNorm = norm(path);
    let evicted = 0;
    const evictedHashes: string[] = [];
    set(state => {
      const newStaged = new Map(state.stagedSnippets);
      for (const [key, s] of state.stagedSnippets) {
        if (s.viewKind === 'snapshot') continue;
        if (s.source && norm(s.source) === pathNorm && s.sourceRevision != null && s.sourceRevision !== currentRevision && s.viewKind === 'derived') {
          newStaged.delete(key);
          evicted++;
        }
      }
      const newChunks = new Map(state.chunks);
      const newArchived = new Map(state.archivedChunks);
      for (const [key, c] of state.chunks) {
        if (c.viewKind === 'snapshot') continue;
        if (c.source && norm(c.source) === pathNorm && c.sourceRevision != null && c.sourceRevision !== currentRevision && c.viewKind === 'derived') {
          newChunks.delete(key);
          evicted++;
          evictedHashes.push(c.hash);
        }
      }
      for (const [key, c] of state.archivedChunks) {
        if (c.viewKind === 'snapshot') continue;
        if (c.source && norm(c.source) === pathNorm && c.sourceRevision != null && c.sourceRevision !== currentRevision && c.viewKind === 'derived') {
          newArchived.delete(key);
          evicted++;
          evictedHashes.push(c.hash);
        }
      }
      if (evicted === 0) return {};
      return {
        stagedSnippets: newStaged,
        chunks: newChunks,
        archivedChunks: newArchived,
        memoryEvents: appendMemoryEvent(state.memoryEvents, {
          action: 'invalidate',
          reason: 'derived_revision_mismatch',
          source: path,
          newRevision: currentRevision,
          freedTokens: 0,
        }),
      };
    });
    for (const hash of evictedHashes) hppEvict(hash);
    return evicted;
  },

  reconcileSourceRevision: (path: string, currentRevision: string, cause?: FreshnessCause) => {
    const pathNorm = normalizeSourcePath(path);
    const effectiveCause = cause ?? consumeRevisionAdvanceCause(path) ?? 'external_file_change';
    const isSameFilePriorEdit = effectiveCause === 'same_file_prior_edit';
    let dormantEvicted = 0;
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

      const matchesSource = (source?: string) => !!source && normalizeSourcePath(source) === pathNorm;

      for (const [key, chunk] of state.chunks) {
        if (!matchesSource(chunk.source)) continue;
        stats.total++;
        if (chunk.viewKind === 'snapshot') {
          stats.preserved++;
          continue;
        }
        if (chunk.viewKind === 'derived' && chunk.sourceRevision && chunk.sourceRevision !== currentRevision) {
          newChunks.delete(key);
          stats.invalidated++;
          evictedHashes.push(chunk.hash);
          continue;
        }
        if (chunk.compacted && !chunk.pinned && chunk.sourceRevision && chunk.sourceRevision !== currentRevision) {
          newChunks.delete(key);
          if (chunk.tokens > DORMANT_ARCHIVE_THRESHOLD) {
            newArchived.set(key, { ...chunk });
          } else {
            newArchived.delete(key);
          }
          stats.invalidated++;
          dormantEvicted++;
          evictedHashes.push(chunk.hash);
          continue;
        }
        const nextChunk = { ...chunk, sourceRevision: currentRevision, observedRevision: currentRevision };
        delete nextChunk.suspectSince;
        if (isSameFilePriorEdit) {
          nextChunk.freshness = 'shifted';
          nextChunk.freshnessCause = effectiveCause;
        } else {
          delete nextChunk.freshness;
          delete nextChunk.freshnessCause;
        }
        if (nextChunk.viewKind == null && isFileBackedType(nextChunk.type)) nextChunk.viewKind = 'latest';
        newChunks.set(key, nextChunk);
        stats.updated++;
      }

      for (const [key, chunk] of state.archivedChunks) {
        if (!matchesSource(chunk.source)) continue;
        stats.total++;
        if (chunk.viewKind === 'snapshot') {
          stats.preserved++;
          continue;
        }
        if (chunk.viewKind === 'derived' && chunk.sourceRevision && chunk.sourceRevision !== currentRevision) {
          newArchived.delete(key);
          stats.invalidated++;
          evictedHashes.push(chunk.hash);
          continue;
        }
        if (chunk.compacted && !chunk.pinned && chunk.sourceRevision && chunk.sourceRevision !== currentRevision) {
          if (chunk.tokens <= DORMANT_ARCHIVE_THRESHOLD) {
            newArchived.delete(key);
          }
          stats.invalidated++;
          dormantEvicted++;
          evictedHashes.push(chunk.hash);
          continue;
        }
        const nextChunk = { ...chunk, sourceRevision: currentRevision, observedRevision: currentRevision };
        delete nextChunk.suspectSince;
        if (isSameFilePriorEdit) {
          nextChunk.freshness = 'shifted';
          nextChunk.freshnessCause = effectiveCause;
        } else {
          delete nextChunk.freshness;
          delete nextChunk.freshnessCause;
        }
        if (nextChunk.viewKind == null && isFileBackedType(nextChunk.type)) nextChunk.viewKind = 'latest';
        newArchived.set(key, nextChunk);
        stats.updated++;
      }

      for (const [key, snippet] of state.stagedSnippets) {
        if (!matchesSource(snippet.source)) continue;
        stats.total++;
        if (snippet.viewKind === 'snapshot') {
          stats.preserved++;
          continue;
        }
        if (snippet.viewKind === 'derived' && snippet.sourceRevision && snippet.sourceRevision !== currentRevision) {
          newStaged.delete(key);
          stats.invalidated++;
          continue;
        }
        const nextSnippet = { ...snippet, sourceRevision: currentRevision, observedRevision: currentRevision };
        delete nextSnippet.suspectSince;
        if (isSameFilePriorEdit) {
          nextSnippet.freshness = 'shifted';
          nextSnippet.freshnessCause = effectiveCause;
        } else {
          delete nextSnippet.freshness;
          delete nextSnippet.freshnessCause;
        }
        if (nextSnippet.viewKind == null) nextSnippet.viewKind = 'latest';
        newStaged.set(key, nextSnippet);
        stats.updated++;
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
        archivedChunks: newArchived,
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
            ...(dormantEvicted > 0 ? [`dormant_evicted:${dormantEvicted}`] : []),
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
    return stats;
  },

  refreshRoundEnd: async (options) => {
    // TTL: decrement and drop expired unpinned chunks (called after advanceTurn)
    const chunksWithTtl = Array.from(get().chunks.entries()).filter(([, c]) => c.ttl != null && !c.pinned);
    if (chunksWithTtl.length > 0) {
      set(s => {
        const newChunks = new Map(s.chunks);
        let newDropped = s.droppedManifest;
        for (const [key, chunk] of chunksWithTtl) {
          const remaining = (chunk.ttl ?? 0) - 1;
          if (remaining <= 0) {
            newChunks.delete(key);
            newDropped = new Map(newDropped);
            newDropped.set(chunk.hash, {
              hash: chunk.hash,
              shortHash: chunk.shortHash,
              type: chunk.type,
              source: chunk.source,
              tokens: chunk.tokens,
              digest: chunk.digest,
              droppedAt: Date.now(),
              subtaskId: chunk.subtaskId,
            });
          } else {
            newChunks.set(key, { ...chunk, ttl: remaining });
          }
        }
        return newChunks.size !== s.chunks.size ? { chunks: newChunks, droppedManifest: newDropped } : {};
      });
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
    for (const path of paths) {
      const rev = revisionMap ? (revisionMap.get(path) ?? null) : await perPathResolver!(path);
      if (rev == null) {
        unresolvablePaths.push(path);
        continue;
      }
      const stats = get().reconcileSourceRevision(path, rev);
      total += stats.total;
      updated += stats.updated;
      invalidated += stats.invalidated;
      preserved += stats.preserved;
    }

    // Engrams whose source path couldn't be resolved (not in hash registry) — mark suspect
    if (unresolvablePaths.length > 0) {
      get().markEngramsSuspect(unresolvablePaths, 'unknown', 'unknown');
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

      for (const [key, chunk] of state.chunks) {
        const chunkViewKind = chunk.viewKind ?? defaultViewKindForChunk(chunk.type);
        if (!isFileBackedType(chunk.type) || chunkViewKind !== 'latest' || !sourceMatchesTargets(chunk.source, targets) || chunk.suspectSince != null) continue;
        newChunks.set(key, { ...chunk, suspectSince: now, freshness: 'suspect', freshnessCause: effectiveCause, suspectKind: effectiveSuspectKind });
        result.marked++;
      }
      for (const [key, snippet] of state.stagedSnippets) {
        if (snippet.viewKind === 'snapshot') continue;
        if (snippet.viewKind != null && snippet.viewKind !== 'latest') continue;
        if (!sourceMatchesTargets(snippet.source, targets) || snippet.suspectSince != null) continue;
        newStaged.set(key, { ...snippet, suspectSince: now, freshness: 'suspect', freshnessCause: effectiveCause, suspectKind: effectiveSuspectKind });
        result.marked++;
      }
      for (const [key, chunk] of state.archivedChunks) {
        const chunkViewKind = chunk.viewKind ?? defaultViewKindForChunk(chunk.type);
        if (!isFileBackedType(chunk.type) || chunkViewKind !== 'latest' || !sourceMatchesTargets(chunk.source, targets) || chunk.suspectSince != null) continue;
        newArchived.set(key, { ...chunk, suspectSince: now, freshness: 'suspect', freshnessCause: effectiveCause, suspectKind: effectiveSuspectKind });
        result.marked++;
      }

      if (result.marked === 0) return {};
      return { chunks: newChunks, archivedChunks: newArchived, stagedSnippets: newStaged, stageVersion: state.stageVersion + 1 };
    });
    if (result.marked > 0 && sourcePaths && sourcePaths.length > 0) {
      get().invalidateAwarenessForPaths(sourcePaths);
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
        newChunks.set(key, nextChunk);
        result.cleared++;
      }
      for (const [key, chunk] of state.archivedChunks) {
        if (chunk.suspectSince == null || !shouldClear(chunk.source)) continue;
        const nextChunk = { ...chunk };
        delete nextChunk.suspectSince;
        newArchived.set(key, nextChunk);
        result.cleared++;
      }
      for (const [key, snippet] of state.stagedSnippets) {
        if (snippet.suspectSince == null || !shouldClear(snippet.source)) continue;
        const nextSnippet = { ...snippet };
        delete nextSnippet.suspectSince;
        newStaged.set(key, nextSnippet);
        result.cleared++;
      }

      if (result.cleared === 0) return {};
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
    for (const hash of result.dropped) hppEvict(hash);
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
    const subtasks = plan.subtasks ?? [];
    let activeSubtaskId = plan.activeSubtaskId;
    const hasActive = subtasks.some(s => s.status === 'active');
    if (subtasks.length > 0 && (!activeSubtaskId || !hasActive)) {
      const first = subtasks[0]!;
      activeSubtaskId = first.id;
      const normalized = subtasks.map((s, i) => ({
        ...s,
        status: (i === 0 ? 'active' : (s.status === 'done' ? 'done' : 'pending')) as 'pending' | 'active' | 'done' | 'blocked',
      }));
      set({ taskPlan: { ...plan, subtasks: normalized, activeSubtaskId }, task: { ...plan, subtasks: normalized, activeSubtaskId } });
    } else {
      set({ taskPlan: plan, task: plan });
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
          tokens: estimateTokens(compositeContent),
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
      evictArchiveIfNeeded(newArchive);
      return {
        taskPlan: updatedPlan,
        task: updatedPlan,
        chunks: newChunks,
        archivedChunks: newArchive,
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
      const newPlan = {
        goal: task.goal || state.taskPlan?.goal || 'Working',
        subtasks,
        activeSubtaskId,
      };
      return { taskPlan: newPlan, task: newPlan };
    });
  },
  
  /**
   * Set a blackboard entry. Returns token count.
   */
  setBlackboardEntry: (key: string, content: string, opts?: { derivedFrom?: string[] }) => {
    if (!content || content.trim() === '') {
      const state = get();
      const newBb = new Map(state.blackboardEntries);
      newBb.delete(key);
      set({ blackboardEntries: newBb });
      return { tokens: 0 };
    }
    
    const tokens = estimateTokens(content);

    const derivedFrom = opts?.derivedFrom;
    let derivedRevisions: string[] | undefined;
    if (derivedFrom?.length) {
      derivedRevisions = derivedFrom.map(path => {
        const awareness = get().getAwareness(path);
        return awareness?.snapshotHash ?? '';
      });
    }
    
    set(state => {
      const newBb = new Map(state.blackboardEntries);
      const entry: BlackboardEntry = { content, createdAt: new Date(), tokens };
      if (derivedFrom?.length) entry.derivedFrom = derivedFrom;
      if (derivedRevisions?.length) entry.derivedRevisions = derivedRevisions;
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
    const entries: Array<{ key: string; preview: string; tokens: number }> = [];
    get().blackboardEntries.forEach((entry, key) => {
      const firstLine = entry.content.split('\n')[0].slice(0, 80);
      entries.push({ key, preview: firstLine, tokens: entry.tokens });
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

    const tokens = estimateTokens(content);
    let warning: string | undefined;

    set(state => {
      const newRules = new Map(state.cognitiveRules);
      newRules.set(key, { content, createdAt: new Date(), tokens, scope: 'session' });

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
    const tokens = estimateTokens(note);
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
    newChunks.set(key, { ...chunk, type: newType });
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
    const newTokens = estimateTokens(newContent);

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

    // Compress old engram (hash forwarding)
    const compactContent = oldChunk.editDigest || oldChunk.digest || oldChunk.summary || `[forwarded] h:${oldChunk.shortHash} → h:${newShortHash}`;
    newChunks.set(oldChunk.hash, {
      ...oldChunk,
      content: compactContent,
      tokens: estimateTokens(compactContent),
      compacted: true,
    });

    newChunks.set(newHash, newChunk);
    set({ chunks: newChunks });
    state.pushHash(newHash);

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
      tokens: estimateTokens(contentA),
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
      tokens: estimateTokens(contentB),
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
      tokens: estimateTokens(compactContent),
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

    const mergedContent = resolved.map(([, c]) => c.content).join('\n\n');
    const mergedHash = hashContentSync(mergedContent);
    const firstChunk = resolved[0][1];

    const allAnnotations: EngramAnnotation[] = [];
    const allSynapses: Synapse[] = [];
    for (const [, c] of resolved) {
      if (c.annotations) allAnnotations.push(...c.annotations);
      if (c.synapses) allSynapses.push(...c.synapses);
    }

    const mergedChunk: ContextChunk = {
      hash: mergedHash,
      shortHash: mergedHash.slice(0, SHORT_HASH_LEN),
      type: firstChunk.type,
      source: firstChunk.source,
      content: mergedContent,
      tokens: estimateTokens(mergedContent),
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
    };
    for (const [, c] of resolved) {
      const compactContent = c.editDigest || c.digest || `[merged → h:${mergedChunk.shortHash}]`;
      newChunks.set(c.hash, {
        ...c,
        content: compactContent,
        tokens: estimateTokens(compactContent),
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
    const tokens = estimateTokens(content);
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
    let totalTokens = 0;
    state.stagedSnippets.forEach(s => totalTokens += s.tokens);
    const lines: string[] = [];
    lines.push(`## STAGED (cached @ 10% cost, ${(totalTokens / 1000).toFixed(1)}k tokens)`);

    // Build a set of sources that have active (materialized, non-compacted) engrams
    // to avoid emitting full content twice when the same file is both staged and active.
    const activeEngramSources = new Set<string>();
    for (const [, chunk] of state.chunks) {
      if (chunk.compacted || !chunk.source) continue;
      const ref = hppGetRef(chunk.hash);
      if (!ref || hppShouldMaterialize(ref)) {
        activeEngramSources.add(normalizeSourcePath(chunk.source));
      }
    }

    state.stagedSnippets.forEach((snippet, key) => {
      const lineRange = snippet.lines ? `:${snippet.lines}` : '';
      lines.push(`[${key}] ${snippet.source}${lineRange} (${snippet.tokens}tk)`);
      const normSource = normalizeSourcePath(snippet.source);
      if (activeEngramSources.has(normSource)) {
        lines.push(`[content in active engram — see ## ACTIVE ENGRAMS]`);
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
          nextStaged.set(key, { ...snippet, sourceRevision: newRevision, observedRevision: newRevision });
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
          nextChunks.set(hash, { ...chunk, sourceRevision: newRevision, observedRevision: newRevision });
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
              const s = Math.max(1, parseInt(t.slice(0, dash), 10) + lineDelta);
              const e = Math.max(s, parseInt(t.slice(dash + 1), 10) + lineDelta);
              return `${s}-${e}`;
            }
            const n = Math.max(1, parseInt(t, 10) + lineDelta);
            return String(n);
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
    for (const hash of dropped) hppEvict(hash);
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
    // Validate: entry's snapshotHash must match current known sourceRevision.
    // Check chunks, staged snippets, and archived chunks for a newer revision.
    const state = get();
    const hasNewerRevision = (source: string | undefined, sourceRevision: string | undefined): boolean => {
      if (!source || !sourceRevision) return false;
      if (!sourceMatchesTargets(source, [filePath])) return false;
      return sourceRevision !== entry.snapshotHash;
    };
    for (const [, chunk] of state.chunks) {
      if (hasNewerRevision(chunk.source, chunk.sourceRevision)) return undefined;
    }
    for (const [, snippet] of state.stagedSnippets) {
      if (hasNewerRevision(snippet.source, snippet.sourceRevision)) return undefined;
    }
    for (const [, chunk] of state.archivedChunks) {
      if (hasNewerRevision(chunk.source, chunk.sourceRevision)) return undefined;
    }
    return entry;
  },

  setAwareness: (entry: AwarenessCacheEntry): void => {
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
      if (entry) return { content: entry.content, source: `bb:${bbPrefix}`, chunkType: 'blackboard' };
      return null;
    }

    const state = get();
    const found = findChunkByRef(state.chunks, hashRef);
    if (found) {
      if (found[1].compacted) {
        const archived = findChunkByRef(state.archivedChunks, hashRef);
        if (archived) return { content: archived[1].content, source: archived[1].source, chunkType: archived[1].type };
      }
      return { content: found[1].content, source: found[1].source, chunkType: found[1].type };
    }
    const archived = findChunkByRef(state.archivedChunks, hashRef);
    if (archived) return { content: archived[1].content, source: archived[1].source, chunkType: archived[1].type };
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
      memoryTelemetry: summarizeMemoryTelemetry(state.memoryEvents),
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
      undefined, state.batchMetrics, state.getStagedTokenCount(), latestRound?.conversationHistoryTokens, latestRound?.historyBreakdownLabel,
      state.chunks,
      roundCount,
    );
  },
  
  /**
   * Get task line showing plan progress (delegates to contextFormatter).
   */
  getTaskLine: () => {
    const currentTaskState = get().blackboardEntries.get('current-task-state')?.content;
    const currentPlanState = get().blackboardEntries.get('current-plan-state')?.content;
    const authoritativeLines: string[] = [];
    const taskMatch = currentTaskState?.match(/(?:^|\n)TASK:\s*(.+)/);
    if (taskMatch?.[1]) authoritativeLines.push(`<<TASK: ${taskMatch[1].trim()}>>`);
    const planMatch = currentPlanState?.match(/(?:^|\n)PLAN:\s*(.+)/);
    if (planMatch?.[1]) authoritativeLines.push(`<<PLAN: ${planMatch[1].trim()}>>`);
    if (authoritativeLines.length > 0) return authoritativeLines.join('\n');
    return formatTaskLine(get().taskPlan);
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
      seededBb.set(key, { content, createdAt: new Date(), tokens: estimateTokens(content) });
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
    });
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
    const DORMANT_DIGEST_LINE_TOKENS = 15;
    let total = 0;
    get().chunks.forEach(c => {
      // Transcript lives in BP3 (conversation history); counting msg:user/msg:asst
      // here double-counts the same tokens against WM pressure and Internals totals.
      if (CHAT_TYPES.has(c.type)) return;
      if (c.compacted) {
        total += DORMANT_DIGEST_LINE_TOKENS;
      } else {
        const ref = hppGetRef(c.hash);
        if (ref && !hppShouldMaterialize(ref)) {
          total += DORMANT_DIGEST_LINE_TOKENS;
        } else {
          total += c.tokens;
        }
      }
    });
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

        const compactContent = chunk.editDigest || chunk.digest || chunk.summary || `[compacted] h:${chunk.shortHash}`;
        const compactTokens = estimateTokens(compactContent);
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

    set(state => {
      // Count compacted+unpinned chunks (dormant candidates)
      const dormantEntries: Array<[string, ContextChunk]> = [];
      for (const [key, chunk] of state.chunks) {
        if (chunk.compacted && !chunk.pinned) dormantEntries.push([key, chunk]);
      }

      if (dormantEntries.length <= MAX_DORMANT_CHUNKS) return {};

      // Sort by lastAccessed ascending (oldest first = evict first)
      dormantEntries.sort(([, a], [, b]) => (a.lastAccessed || 0) - (b.lastAccessed || 0));

      const toEvict = dormantEntries.length - MAX_DORMANT_CHUNKS;
      const newChunks = new Map(state.chunks);
      const newArchive = new Map(state.archivedChunks);

      for (let i = 0; i < toEvict; i++) {
        const [key, chunk] = dormantEntries[i];
        newChunks.delete(key);
        freedTokens += chunk.tokens;
        evicted++;

        if (chunk.tokens > DORMANT_ARCHIVE_THRESHOLD) {
          // Preserve in archive for recall by hash
          newArchive.set(key, { ...chunk });
          archived++;
        } else {
          // Drop stubs entirely (batch call stubs at ~7tk)
          newArchive.delete(key);
          dropped++;
        }
        evictedHashes.push(chunk.hash);
      }

      evictArchiveIfNeeded(newArchive);

      return {
        chunks: newChunks,
        archivedChunks: newArchive,
        freedTokens: state.freedTokens + freedTokens,
        lastFreed: freedTokens,
        lastFreedAt: Date.now(),
        memoryEvents: appendMemoryEvent(state.memoryEvents, {
          action: 'evict',
          reason: 'dormant_count_limit',
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
  resetBatchMetrics: () => {
    const state = get();
    if (state.batchMetrics.toolCalls === 0 && state.batchMetrics.manageOps === 0) return;
    set({ batchMetrics: { toolCalls: 0, manageOps: 0 } });
  },
  getBatchMetrics: () => get().batchMetrics,

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
          hppMaterialize(promoted.hash, promoted.type, promoted.source, promoted.tokens, (promoted.content.match(/\n/g) || []).length + 1, promoted.editDigest || promoted.digest || '');
          continue;
        }

        const archived = findChunkByRef(newArchive, shortRef);
        if (archived) {
          const [key, arc] = archived;
          const recalled = { ...arc, lastAccessed: Date.now() };
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
          hppMaterialize(arc.hash, arc.type, arc.source, arc.tokens, (arc.content.match(/\n/g) || []).length + 1, arc.editDigest || arc.digest || '');
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