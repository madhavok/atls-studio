/**
 * Unified Batch Execution Schema — Type Definitions
 *
 * One execution grammar, one step shape, one ref grammar.
 * All operations (discover, understand, change, verify, session, delegate)
 * compose as typed steps within a single batch run.
 */

import type { SetRefLookup, HashLookup } from '../../utils/hashResolver';
import type { RebaseConfidence, RebaseEvidence, RebaseStrategy, RebindOutcome } from '../freshnessJournal';

// ---------------------------------------------------------------------------
// Operation Kind — dotted names grouped by semantic family
// ---------------------------------------------------------------------------

export type DiscoverOp =
  | 'search.code'
  | 'search.symbol'
  | 'search.usage'
  | 'search.similar'
  | 'search.issues'
  | 'search.patterns';

export type UnderstandOp =
  | 'read.context'
  | 'read.shaped'
  | 'read.lines'
  | 'read.file'
  | 'analyze.deps'
  | 'analyze.calls'
  | 'analyze.structure'
  | 'analyze.impact'
  | 'analyze.blast_radius'
  | 'analyze.extract_plan';

export type ChangeOp =
  | 'change.edit'
  | 'change.create'
  | 'change.delete'
  | 'change.refactor'
  | 'change.rollback'
  | 'change.split_module';

export type VerifyOp =
  | 'verify.build'
  | 'verify.test'
  | 'verify.lint'
  | 'verify.typecheck';

export type SessionOp =
  | 'session.plan'
  | 'session.advance'
  | 'session.status'
  | 'session.pin'
  | 'session.unpin'
  | 'session.stage'
  | 'session.unstage'
  | 'session.compact'
  | 'session.unload'
  | 'session.drop'
  | 'session.recall'
  | 'session.stats'
  | 'session.debug'
  | 'session.compact_history'
  | 'session.bb.write'
  | 'session.bb.read'
  | 'session.bb.delete'
  | 'session.bb.list'
  | 'session.rule'
  | 'session.emit'
  | 'session.shape'
  | 'session.load';

export type AnnotationOp =
  | 'annotate.engram'
  | 'annotate.note'
  | 'annotate.link'
  | 'annotate.retype'
  | 'annotate.split'
  | 'annotate.merge'
  | 'annotate.design';

export type DelegateOp =
  | 'delegate.retrieve'
  | 'delegate.design';

export type SystemOp =
  | 'system.exec'
  | 'system.git'
  | 'system.help'
  | 'system.workspaces';

export type IntentOp =
  | 'intent.understand'
  | 'intent.edit'
  | 'intent.edit_multi'
  | 'intent.investigate'
  | 'intent.diagnose'
  | 'intent.survey'
  | 'intent.refactor'
  | 'intent.create'
  | 'intent.test'
  | 'intent.search_replace'
  | 'intent.extract';

export type OperationKind =
  | DiscoverOp
  | UnderstandOp
  | ChangeOp
  | VerifyOp
  | SessionOp
  | AnnotationOp
  | DelegateOp
  | SystemOp
  | IntentOp;

// ---------------------------------------------------------------------------
// Step output kind — classifies the artifact each step produces
// ---------------------------------------------------------------------------

export type StepOutputKind =
  | 'file_refs'
  | 'symbol_refs'
  | 'search_results'
  | 'analysis'
  | 'edit_result'
  | 'verify_result'
  | 'session'
  | 'bb_ref'
  | 'raw';

// ---------------------------------------------------------------------------
// Verify Classification — structured verification outcome
// ---------------------------------------------------------------------------

export type VerifyClassification = 'pass' | 'pass-with-warnings' | 'fail' | 'tool-error';
export type VerifyConfidence = 'fresh' | 'cached' | 'stale-suspect' | 'obsolete';

export interface VerifyDisplayMeta {
  confidence?: VerifyConfidence;
  reused?: boolean;
  obsolete?: boolean;
}

// ---------------------------------------------------------------------------
// Ref Expressions — universal addressing for step inputs
// ---------------------------------------------------------------------------

export type RefExpr =
  | { ref: string }
  | { from_step: string; path?: string }
  | { bind: string }
  | { value: unknown };

// ---------------------------------------------------------------------------
// Condition Expressions — conditional step execution
// ---------------------------------------------------------------------------

export type ConditionExpr =
  | { step_ok: string }
  | { step_has_refs: string }
  | { ref_exists: string }
  | { all_steps_ok: string[] }
  | { not: ConditionExpr };

// ---------------------------------------------------------------------------
// Execution Policy
// ---------------------------------------------------------------------------

export interface ExecutionPolicy {
  mode?: 'readonly' | 'mutable' | 'safe-mutable';
  verify_after_change?: boolean;
  auto_stage_refs?: boolean;
  auto_pin_outputs?: 'none' | 'sig' | 'full';
  rollback_on_failure?: boolean;
  max_steps?: number;
  stop_on_verify_failure?: boolean;
  /** When "strict", flags edits that add extends/implements/mixin/#include/using. */
  refactor_validation_mode?: 'strict';
  /** When true, the executor invalidates and re-records snapshot hashes for
   *  files modified by change steps, ensuring subsequent steps see the
   *  post-mutation hash. Default: true. */
  auto_reread_after_mutation?: boolean;
}

// ---------------------------------------------------------------------------
// Output Spec — how results should be summarized
// ---------------------------------------------------------------------------

export interface OutputSpec {
  format?: 'full' | 'summary' | 'refs_only';
  include_step_details?: boolean;
}

// ---------------------------------------------------------------------------
// Unified Batch Request — the top-level envelope
// ---------------------------------------------------------------------------

export interface UnifiedBatchRequest {
  version: '1.0';
  goal?: string;
  workspace?: string;
  refs?: RefRegistryHint[];
  policy?: ExecutionPolicy;
  steps: Step[];
  output?: OutputSpec;
}

export interface RefRegistryHint {
  name: string;
  ref: string;
}

export interface Step {
  id: string;
  use: OperationKind;
  with?: Record<string, unknown>;
  in?: Record<string, RefExpr>;
  out?: string | string[];
  if?: ConditionExpr;
  on_error?: 'stop' | 'continue' | 'rollback';
}

// ---------------------------------------------------------------------------
// Step Output — typed artifact produced by each step
// ---------------------------------------------------------------------------

export interface StepOutput {
  kind: StepOutputKind;
  ok: boolean;
  refs: string[];
  content?: unknown;
  tokens?: number;
  summary: string;
  error?: string;
  classification?: VerifyClassification;
  _threshold_hint?: string;
  _hash_warnings?: string[];
}

// ---------------------------------------------------------------------------
// Unified Batch Result — the top-level response
// ---------------------------------------------------------------------------

export interface StepResult {
  id: string;
  use: OperationKind;
  ok: boolean;
  refs?: string[];
  artifacts?: Record<string, unknown>;
  summary?: string;
  error?: string;
  classification?: VerifyClassification;
  duration_ms: number;
  tokens_delta?: number;
  verification_confidence?: 'fresh' | 'cached' | 'stale-suspect' | 'obsolete';
  verification_reused?: boolean;
  verification_obsolete?: boolean;
  verification_stale?: boolean;
  _threshold_hint?: string;
  _hash_warnings?: string[];
}

export type BatchPendingActionKind = 'confirmation_required' | 'paused_on_error' | 'blocked';

export type InterruptionReason = 'auto_rebased' | 'suspect_external_change';

export interface BatchInterruption {
  kind: BatchPendingActionKind;
  step_id: string;
  step_index: number;
  summary: string;
  tool_name?: string;
  /** Distinguishes safe rebase (warning) from unsafe external change (hard stop) */
  interruption_reason?: InterruptionReason;
}

export interface UnifiedBatchResult {
  ok: boolean;
  summary: string;
  step_results: StepResult[];
  outputs?: Record<string, unknown>;
  final_refs?: string[];
  bb_refs?: string[];
  verify?: Array<{ step_id: string; passed: boolean; summary: string; classification?: VerifyClassification }>;
  interruption?: BatchInterruption;
  intent_metrics?: IntentMetrics[];
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Handler Context — dependencies injected into every op handler
// ---------------------------------------------------------------------------

export interface HandlerContext {
  store: () => ContextStoreApi;
  setLookup: SetRefLookup;
  hashLookup: HashLookup;
  atlsBatchQuery: (operation: string, params: Record<string, unknown>) => Promise<unknown>;
  sessionId: string | null;
  isSwarmAgent: boolean;
  swarmTerminalId?: string;
  getProjectPath: () => string | null;
  /** Resolve workspace rel_path: by name (params.workspace) or from active workspace. Returns null for root or when no match. */
  getWorkspaceRelPath?: (name?: string) => string | null;
  resolveSearchRefs: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  expandSetRefsInHashes: (
    hashes: string[],
  ) => { expanded: string[]; notes: string[] };
  expandFilePathRefs: (
    rawPaths: string[],
  ) => Promise<{ items: ExpandedFilePath[]; notes: string[] }>;
  /** Access to tool loop state for compact_history */
  toolLoopState?: ToolLoopState | null;
}

export type ExpandedFilePath =
  | { kind: 'path'; path: string }
  | { kind: 'content'; content: string; source: string };

/**
 * Minimal projection of contextStore.getState() that handlers need.
 * Avoids importing the full store type to prevent circular deps.
 */
export interface ContextStoreApi {
  // Task plan
  taskPlan: TaskPlanState | null;
  setTaskPlan: (plan: TaskPlanState) => void;
  advanceSubtask: (id: string, summary: string) => { unloaded: number; freedTokens: number };

  // Chunks
  chunks: Map<string, ChunkEntry>;
  archivedChunks: Map<string, ChunkEntry>;
  droppedManifest: Map<string, unknown>;
  addChunk: (content: string, type: string, source?: string, symbols?: unknown[], summary?: string, backendHash?: string, opts?: Record<string, unknown>) => string;
  findReusableRead: (span: { filePath: string; startLine?: number; endLine?: number; shape?: string; sourceRevision: string }) => string | null;
  getChunkContent: (hash: string) => string | null;
  getChunkForHashRef: (hashRef: string) => { content: string; source?: string; chunkType?: string } | null;
  touchChunk: (hash: string) => void;

  // Lifecycle
  unloadChunks: (hashes: string[], opts?: { confirmWildcard?: boolean }) => { freed: number; count: number; pinnedKept: number };
  compactChunks: (hashes: string[], opts?: { confirmWildcard?: boolean; tier?: 'pointer' | 'sig'; sigContentByRef?: Map<string, string> }) => { compacted: number; freedTokens: number };
  dropChunks: (hashes: string[], opts?: { confirmWildcard?: boolean }) => { dropped: number; freedTokens: number };
  pinChunks: (hashes: string[], shape?: string) => number;
  unpinChunks: (hashes: string[]) => number;
  invalidateStaleHashes: (hashes: string[]) => void;
  markEngramsSuspect: (sourcePaths?: string[], cause?: FreshnessCause, suspectKind?: 'content' | 'structural' | 'unknown') => number;
  clearSuspect: (hashRefOrSource: string) => number;
  reconcileSourceRevision: (path: string, currentRevision: string, cause?: FreshnessCause) => { source: string; revision: string; total: number; updated: number; invalidated: number; preserved: number; at: number };
  recordRevisionAdvance: (path: string, newRevision: string, cause: FreshnessCause, editSessionId?: string) => void;
  recordRebindOutcomes: (outcomes: Array<{ ref: string; source?: string } & RebindOutcome>) => void;
  recordMemoryEvent: (event: { action: string; reason: string; refs?: string[]; source?: string; oldRevision?: string; newRevision?: string; freedTokens?: number; pressurePct?: number; confidence?: RebaseConfidence; strategy?: RebaseStrategy; factors?: RebaseEvidence[]; at?: number }) => void;

  // Stage
  stageSnippet: (key: string, content: string, source: string, lines?: string, fullHash?: string, shape?: string, viewKind?: 'latest' | 'snapshot' | 'derived') => { ok: boolean; error?: string; tokens: number };
  unstageSnippet: (key: string) => { freed: number };
  getStagedTokenCount: () => number;
  getStagedEntries: () => ReadonlyMap<string, { source: string; tokens: number }>;
  getStagedSnippetsForRefresh: (sourcePath: string) => Array<{ key: string; source: string; lines?: string; shapeSpec?: string; content: string; sourceRevision?: string; viewKind?: 'latest' | 'snapshot' | 'derived' }>;
  forwardStagedHash: (sourcePath: string, newRevision: string) => number;

  // Blackboard
  setBlackboardEntry: (key: string, content: string, opts?: { derivedFrom?: string[] }) => { tokens: number; warning?: string };
  getBlackboardEntry: (key: string) => string | null;
  getBlackboardEntryWithMeta: (key: string) => { content: string; derivedFrom?: string[]; derivedRevisions?: string[] } | null;
  removeBlackboardEntry: (key: string) => boolean;
  listBlackboardEntries: () => Array<{ key: string; preview: string; tokens: number }>;

  // Rules
  setRule: (key: string, content: string) => { tokens: number; warning?: string };
  removeRule: (key: string) => boolean;
  listRules: () => Array<{ key: string; content: string; tokens: number }>;

  // Engram ops
  editEngram: (hash: string, fields: Record<string, unknown>) => { ok: boolean; newHash?: string; metadataOnly?: boolean; error?: string };
  addAnnotation: (hash: string, note: string) => { ok: boolean; id?: string; error?: string };
  addSynapse: (from: string, to: string, relation: string) => { ok: boolean; error?: string };
  resolveLinkRefToHash: (raw: string) => string;
  retypeChunk: (hash: string, type: string) => { ok: boolean; error?: string };
  splitEngram: (hash: string, at: number) => { ok: boolean; hashes?: string[]; error?: string };
  mergeEngrams: (hashes: string[], summary?: string) => { ok: boolean; newHash?: string; error?: string };

  // Stats
  getStats: () => ContextStats;
  getUsedTokens: () => number;
  maxTokens: number;
  getPinnedCount: () => number;

  // Recency
  resolveRecencyRef: (offset: number) => string | null;
  resolveEditRecencyRef: (offset: number) => string | null;

  // Compliance
  recordToolCall: () => void;
  recordManageOps: (count: number) => void;

  // Hash registration
  registerEditHash: (hash: string, source: string) => { registered: boolean; reason?: string };
  pushHash: (hash: string) => void;
  createSetRefLookup: () => SetRefLookup;

  // Freshness gates
  bumpWorkspaceRev: (changedPaths?: string[]) => number;
  getCurrentRev: () => number;
  addVerifyArtifact: (artifact: VerifyArtifact) => void;
  invalidateArtifactsForPaths: (paths: string[]) => { verifyStale: number; taskCompleteStale: boolean };
  assertFreshForClaim: (claim: 'verified' | 'complete', files: string[]) => { ok: boolean; reason?: string };
  downgradeVerifyToStale: (files?: string[]) => number;

  // Cross-batch awareness cache
  getAwareness: (filePath: string) => { filePath: string; snapshotHash: string; level: number; readRegions: Array<{ start: number; end: number }>; shapeHash?: string; recordedAt: number } | undefined;
  setAwareness: (entry: { filePath: string; snapshotHash: string; level: number; readRegions: Array<{ start: number; end: number }>; shapeHash?: string; recordedAt: number }) => void;
  invalidateAwareness: (filePath: string) => void;
  invalidateAwarenessForPaths: (paths: string[]) => void;
  getAwarenessCache: () => Map<string, { filePath: string; snapshotHash: string; level: number; readRegions: Array<{ start: number; end: number }>; shapeHash?: string; recordedAt: number }>;
}

// ---------------------------------------------------------------------------
// Intent Engine — backward-looking context for pure resolver functions
// ---------------------------------------------------------------------------

export interface IntentContext {
  /** Staged snippet keys -> source + token count */
  staged: ReadonlyMap<string, { source?: string; tokens: number }>;
  /** Set of hashes for pinned chunks */
  pinned: ReadonlySet<string>;
  /** Normalized source paths of pinned chunks */
  pinnedSources: ReadonlySet<string>;
  /** BB keys -> token count + derivation metadata */
  bbKeys: ReadonlyMap<string, { tokens: number; derivedFrom?: string[] }>;
  /** Awareness cache: normalized file path -> snapshot + level + regions */
  awareness: ReadonlyMap<string, {
    snapshotHash: string;
    level: number;
    readRegions: Array<{ start: number; end: number }>;
  }>;
  /** Prior step outputs from current batch (for multi-intent batches) */
  priorOutputs: ReadonlyMap<string, StepOutput>;
}

export interface IntentResult {
  steps: Step[];
  prepareNext?: Step[];
}

export type IntentResolver = (
  params: Record<string, unknown>,
  context: IntentContext,
) => IntentResult;

export interface IntentMetrics {
  intentName: string;
  totalPossibleSteps: number;
  emittedSteps: number;
  skippedSteps: number;
  lookaheadSteps: number;
}

export interface TaskPlanState {
  goal: string;
  subtasks: Array<{
    id: string;
    title: string;
    status: 'pending' | 'active' | 'done' | 'blocked';
    contextManifest?: Array<{ hash: string; source: string; shape?: string; tokens: number; fullHash?: string }>;
  }>;
  activeSubtaskId: string | null;
}

// Freshness taxonomy — explicit causes for stale ref handling
export type FreshnessState = 'fresh' | 'forwarded' | 'shifted' | 'changed' | 'suspect';
export type FreshnessCause =
  | 'hash_forward'
  | 'same_file_prior_edit'
  | 'external_file_change'
  | 'watcher_event'
  | 'unknown';
export type EngramOrigin = 'read' | 'edit' | 'edit-refresh' | 'stage' | 'derived';

export interface ChunkEntry {
  hash: string;
  shortHash: string;
  source?: string;
  sourceRevision?: string;
  viewKind?: 'latest' | 'snapshot' | 'derived';
  content: string;
  tokens: number;
  type: string;
  pinned?: boolean;
  compacted?: boolean;
  suspectSince?: number;
  lastAccessed: number;
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
}

export interface ContextStats {
  usedTokens: number;
  maxTokens: number;
  freedTokens: number;
  chunkCount: number;
  bbCount: number;
  bbTokens: number;
  chunks: Array<{ h: string; tk: number; type: string; src?: string; pinned?: boolean }>;
  memoryTelemetry: {
    eventCount: number;
    blockCount: number;
    retryCount: number;
    rebindCount: number;
    lowConfidenceCount: number;
    mediumConfidenceCount: number;
    strategyCounts: Partial<Record<RebaseStrategy, number>>;
  };
}

export interface ToolLoopState {
  conversationHistory: Array<{ role: string; content: unknown }>;
  round: number;
  priorTurnBoundary: number;
}

// ---------------------------------------------------------------------------
// Freshness Gates — workspace revision tracking & artifact invalidation
// ---------------------------------------------------------------------------

export interface VerifyArtifact {
  id: string;
  createdAtRev: number;
  filesObserved: string[];
  ok: boolean;
  warnings: number;
  errors: number;
  stepId: string;
  confidence?: 'fresh' | 'cached' | 'stale-suspect' | 'obsolete';
  source?: 'command' | 'cache';
  stale: boolean;
  staleReason?: string;
  /** Snapshot hashes of observed files at verify time — used for cache invalidation. */
  fileFingerprint?: Record<string, string>;
}

export interface TaskCompleteRecord {
  summary: string;
  filesChanged: string[];
  createdAtRev: number;
  status: 'valid' | 'stale';
  reason?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Op Handler — the universal handler signature
// ---------------------------------------------------------------------------

export type OpHandler = (
  params: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<StepOutput>;

// ---------------------------------------------------------------------------
// Per-Operation Param Interfaces — canonical param shapes after normalization
//
// These define the *canonical* param names each operation expects.
// The normalizer (paramNorm.ts) resolves aliases before handlers see params.
// Handlers cast `params` to the relevant interface for compile-time safety.
// ---------------------------------------------------------------------------

/** Common base: operations that target files. */
export interface FileTargetParams { file_paths: string[]; }

/** Common base: operations that target symbols. */
export interface SymbolTargetParams { symbol_names: string[]; }

// -- discover ---------------------------------------------------------------

export interface SearchCodeParams {
  queries: string[];
  file_paths?: string[];
  limit?: number;
  compact?: boolean;
  grouped?: boolean;
  tiered?: boolean;
  context_lines?: number;
}

export interface SearchSymbolParams {
  symbol_names: string[];
  limit?: number;
}

export interface SearchUsageParams extends SymbolTargetParams {
  filter?: string;
  limit?: number;
}

export interface SearchSimilarParams {
  type?: 'code' | 'function' | 'concept' | 'pattern';
  query?: string | string[];
  pattern?: string;
  threshold?: number;
  limit?: number;
  function_names?: string[];
  concepts?: string[];
  patterns?: string[];
}

export interface SearchIssuesParams {
  file_paths?: string[];
  severity_filter?: 'high' | 'medium' | 'low' | 'all';
  category?: string;
  limit?: number;
}

export interface SearchPatternsParams {
  file_paths?: string[];
  patterns?: string[];
}

// -- understand -------------------------------------------------------------

export interface ReadContextParams {
  file_paths: string[];
  type?: 'smart' | 'full' | 'module' | 'component' | 'test' | 'tree';
  history?: boolean;
  depth?: number;
  glob?: string;
  line_range?: [number, number];
  max_lines?: number;
}

export interface ReadShapedParams {
  file_paths: string[];
  shape?: string;
}

export interface ReadLinesParams {
  hash?: string;
  lines?: string;
  ref?: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  context_lines?: number;
}

export interface AnalyzeDepsParams extends FileTargetParams {
  mode?: 'graph' | 'related' | 'impact';
  filter?: string;
  limit?: number;
}

export interface AnalyzeCallsParams extends SymbolTargetParams {
  depth?: number;
  filter?: string;
  limit?: number;
}

export interface AnalyzeStructureParams extends FileTargetParams {
  kinds?: string[];
  hub_threshold?: number;
  exclude_hubs?: boolean;
}

export interface AnalyzeImpactParams extends FileTargetParams {
  symbol_names?: string[];
}

export interface AnalyzeBlastRadiusParams {
  file_paths?: string[];
  symbol_names?: string[];
  action?: string;
}

export interface AnalyzeExtractPlanParams {
  file_path?: string;
  file_paths?: string[];
  strategy?: 'by_cluster' | 'by_prefix' | 'by_kind';
  min_lines?: number;
  min_complexity?: number;
}

// -- change -----------------------------------------------------------------

export interface LineEdit {
  line?: number;
  anchor?: string;
  action: 'replace' | 'insert_before' | 'insert_after' | 'delete' | 'move';
  count?: number;
  content?: string;
  destination?: number;
  reindent?: boolean;
}

export interface LegacyEdit {
  file: string;
  old: string;
  new: string;
}

export interface CreateEntry {
  path: string;
  content: string;
}

export interface ChangeEditParams {
  file_path?: string;
  line_edits?: LineEdit[];
  edits?: LegacyEdit[];
  creates?: CreateEntry[];
  deletes?: string[];
  revise?: string;
  undo?: string;
  snapshot_hash?: string;
  mode?: string;
}

export interface ChangeCreateParams {
  creates: CreateEntry[];
}

export interface ChangeDeleteParams {
  file_paths: string[];
}

export interface ChangeRefactorParams {
  action: 'inventory' | 'rename' | 'move' | 'extract' | 'impact_analysis' | 'execute' | 'rollback';
  file_paths?: string[];
  symbol_names?: string[];
  [key: string]: unknown;
}

export interface ChangeRollbackParams {
  restore?: Array<{ file: string; hash: string }>;
  delete?: string[];
}

export interface ChangeSplitModuleParams {
  source_file: string;
  target_dir: string;
  plan: Array<{ module: string; symbols: string[] }>;
  dry_run?: boolean;
  mod_style?: string;
}

// -- verify -----------------------------------------------------------------

export interface VerifyParams {
  type?: 'build' | 'test' | 'lint' | 'typecheck';
  target_dir?: string;
  workspace?: string;
  runner?: string;
}

// -- session ----------------------------------------------------------------

export interface SessionPlanParams {
  goal: string;
  subtasks?: Array<string | { id: string; title: string }>;
}

export interface SessionAdvanceParams {
  subtask?: string;
  summary: string;
}

export interface SessionPinParams {
  hashes: string[];
  shape?: string;
}

export interface SessionUnpinParams {
  hashes: string[];
}

export interface SessionStageParams {
  hash?: string;
  hashes?: string[];
  lines?: string;
  content?: string;
  label?: string;
  context_lines?: number;
}

export interface SessionUnstageParams {
  keys: string[];
}

export interface SessionCompactParams {
  hashes: string[];
  tier?: 'pointer' | 'sig';
}

export interface SessionUnloadParams {
  hashes: string[];
}

export interface SessionDropParams {
  hashes: string[];
}

export interface SessionRecallParams {
  hashes: string[];
}

// -- blackboard -------------------------------------------------------------

export interface BbWriteParams {
  key: string;
  content: string;
  derived_from?: string[];
}

export interface BbReadParams {
  keys: string[];
}

export interface BbDeleteParams {
  keys: string[];
}

// -- annotation -------------------------------------------------------------

export interface AnnotateEngramParams {
  hash: string;
  fields: Record<string, unknown>;
}

export interface AnnotateNoteParams {
  hash: string;
  note: string;
}

export interface AnnotateLinkParams {
  from: string;
  to: string;
  relation?: string;
}

export interface AnnotateRetypeParams {
  hash: string;
  type: string;
}

export interface AnnotateSplitParams {
  hash: string;
  at: number;
}

export interface AnnotateMergeParams {
  hashes: string[];
  summary?: string;
}

export interface AnnotateDesignParams {
  content: string;
  append?: boolean;
}

// -- delegate ---------------------------------------------------------------

export interface DelegateRetrieveParams {
  query: string;
  focus_files?: string[];
  max_tokens?: number;
}

export interface DelegateDesignParams {
  query: string;
  focus_files?: string[];
  max_tokens?: number;
}

// -- system -----------------------------------------------------------------

export interface SystemExecParams {
  cmd: string;
  terminal_id?: string;
}

export interface SystemGitParams {
  action: 'status' | 'diff' | 'stage' | 'unstage' | 'commit' | 'push' | 'log' | 'reset' | 'restore';
  workspace?: string;
  files?: string[];
  all?: boolean;
  message?: string;
}

export interface SystemHelpParams {
  topic?: string;
}

export interface SystemWorkspacesParams {
  action: 'list' | 'search' | 'add' | 'remove' | 'set_active' | 'rescan';
}

// -- session misc -----------------------------------------------------------

export interface SessionRuleParams {
  action?: 'set' | 'delete' | 'list';
  key: string;
  content?: string;
}

export interface SessionEmitParams {
  content: string;
  type?: string;
}

export interface SessionShapeParams {
  file_paths: string[];
}
