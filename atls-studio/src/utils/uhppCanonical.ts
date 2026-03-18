/**
 * UHPP Canonical Data Model — Phase 1
 *
 * Seven canonical types that form the foundation of the UHPP architecture.
 * These types coexist with existing structures (ContextChunk, ParsedSymbol, StepOutput)
 * and are designed for incremental adoption — existing code can progressively wrap
 * or extend into these types without breaking changes.
 *
 * See: docs/UHPP_END_STATE_SPEC.md, docs/UHPP_PHASE1_CANONICAL_UNITS.md
 */

// ---------------------------------------------------------------------------
// Shared Foundational Types
// ---------------------------------------------------------------------------

/** Structured provenance for any canonical unit. */
export interface UhppProvenance {
  actor?: string;
  operation?: string;
  batch_id?: string;
  step_id?: string;
  timestamp: number;
  parent_revision?: string;
}

/** Canonical diagnostic — uniform schema across all verification tools. */
export interface UhppDiagnostic {
  file: string;
  line: number;
  column?: number;
  end_line?: number;
  end_column?: number;
  message: string;
  severity: DiagnosticSeverity;
  code?: string;
  source?: string;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

/** Text span within an artifact. */
export interface UhppSpan {
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
}

/** Logical selector — addresses content by meaning rather than line numbers. */
export type UhppSelector =
  | { kind: 'span'; span: UhppSpan }
  | { kind: 'symbol'; symbol_kind: string; name: string }
  | { kind: 'pattern'; pattern: string };

/** Stability metadata for tracking how volatile a slice is. */
export interface StabilityMetadata {
  last_changed?: number;
  change_frequency?: 'stable' | 'moderate' | 'volatile';
  last_verified_revision?: string;
}

export type ExpansionPolicy = 'minimal' | 'local' | 'transitive' | 'full';

export type SafetyConstraint =
  | 'readonly'
  | 'confirm_required'
  | 'generated_file'
  | 'locked_by_other';

// ---------------------------------------------------------------------------
// 1. Artifact — top-level source object
// ---------------------------------------------------------------------------

/**
 * A top-level addressable source object.
 *
 * Maps to: ContextChunk (TS), FileInfo (Rust), ArchivedChunk (Rust).
 * Key difference from ContextChunk: artifact_id is stable across revisions
 * (content changes produce a new revision_id, not a new artifact_id).
 */
export interface UhppArtifact {
  artifact_id: string;
  source_path?: string;
  logical_origin?: string;
  content_hash: string;
  normalized_hash?: string;
  language?: string;
  domain_kind?: ArtifactDomainKind;
  revision_id: string;
  provenance?: UhppProvenance;
}

export type ArtifactDomainKind =
  | 'code'
  | 'config'
  | 'documentation'
  | 'prompt_template'
  | 'blackboard_entry'
  | 'diagnostic_result'
  | 'workflow_definition'
  | 'search_result'
  | 'generated_report';

// ---------------------------------------------------------------------------
// 2. Slice — bounded semantic unit derived from an artifact
// ---------------------------------------------------------------------------

/**
 * A bounded, meaningful unit extracted from an artifact.
 *
 * Maps to: DigestSymbol (TS, partial), ShapedLines modifier (Rust, partial).
 * Slices are the primary unit for shaped reads, digest generation, and
 * model-sized context windows.
 */
export interface UhppSlice {
  slice_id: string;
  parent_artifact_id: string;
  selector: UhppSelector;
  digest?: string;
  edit_ready_digest?: string;
  shape_metadata?: SliceShapeMetadata;
  stability?: StabilityMetadata;
}

export interface SliceShapeMetadata {
  shape_ops: string[];
  source_revision?: string;
  edit_session_id?: string;
}

// ---------------------------------------------------------------------------
// 3. SymbolUnit — named semantic unit
// ---------------------------------------------------------------------------

/**
 * A named semantic unit within an artifact.
 *
 * Maps to: ParsedSymbol / Symbol (Rust), SymbolInfo (Rust), SymbolContext (Rust).
 * Key additions over ParsedSymbol: defining_slice link and structured relationships.
 */
export interface UhppSymbolUnit {
  symbol_id: string;
  symbol_kind: string;
  display_name: string;
  defining_slice?: string;
  signature?: string;
  relationships?: UhppSymbolRelationships;
}

export interface UhppSymbolRelationships {
  inbound: UhppSymbolRelation[];
  outbound: UhppSymbolRelation[];
}

export interface UhppSymbolRelation {
  target_symbol_id: string;
  relation_kind: SymbolRelationKind;
  confidence?: number;
}

export type SymbolRelationKind =
  | 'calls'
  | 'called_by'
  | 'imports'
  | 'imported_by'
  | 'extends'
  | 'extended_by'
  | 'implements'
  | 'implemented_by'
  | 'references'
  | 'referenced_by';

// ---------------------------------------------------------------------------
// 4. Neighborhood — rehydratable context pack around a target
// ---------------------------------------------------------------------------

/**
 * A computed context pack centered on a target ref.
 *
 * Maps to: SmartContextResult (Rust), FileGraph (Rust), ChangeImpact (Rust).
 * Unlike those ad hoc results, Neighborhood has an identity and records
 * why each ref was included, enabling cost-aware context assembly.
 */
export interface UhppNeighborhood {
  neighborhood_id: string;
  anchor_target: string;
  included_refs: UhppNeighborRef[];
  expansion_policy: ExpansionPolicy;
}

export interface UhppNeighborRef {
  ref: string;
  ref_kind: NeighborRefKind;
  rationale: string;
}

export type NeighborRefKind = 'artifact' | 'slice' | 'symbol';

// ---------------------------------------------------------------------------
// 5. EditTarget — resolved mutation target
// ---------------------------------------------------------------------------

/**
 * A resolved target for a mutation operation.
 *
 * Maps to: loose edit_target_* params in change.ts / batch_query.rs.
 * Key additions: eligible_operations (what can be done) and
 * safety_constraints (what must be checked before mutation).
 */
export interface UhppEditTarget {
  target_ref: string;
  target_kind: EditTargetKind;
  current_revision: string;
  eligible_operations?: EditOperation[];
  safety_constraints?: SafetyConstraint[];
}

export type EditTargetKind =
  | 'file'
  | 'exact_span'
  | 'symbol'
  | 'slice'
  | 'display_only';

export type EditOperation =
  | 'extract'
  | 'rename'
  | 'move'
  | 'split'
  | 'merge'
  | 'inline'
  | 'wrap'
  | 'patch'
  | 'adapt_interface'
  | 'propagate_callsites'
  | 'update_imports';

// ---------------------------------------------------------------------------
// 6. ChangeSet — structured result of an intended operation
// ---------------------------------------------------------------------------

/**
 * A structured change result with identity and impact metadata.
 *
 * Maps to: StepOutput (kind: 'edit_result'), draft results in batch_query.rs.
 * Key additions: change_id (identity), expected_downstream_updates (impact),
 * and verification_requirements (what checks this change needs).
 */
export interface UhppChangeSet {
  change_id: string;
  operation_type: string;
  target_refs: string[];
  rendered_edits: UhppFileEdit[];
  expected_downstream_updates?: string[];
  verification_requirements?: VerificationLevel[];
  provenance?: UhppProvenance;
}

export interface UhppFileEdit {
  file: string;
  old_hash?: string;
  new_hash?: string;
  edit_kind: FileEditKind;
}

export type FileEditKind = 'create' | 'modify' | 'delete';

export type VerificationLevel =
  | 'freshness'
  | 'structural'
  | 'relationship'
  | 'parser'
  | 'typecheck'
  | 'test';

// ---------------------------------------------------------------------------
// 7. VerificationResult — structured post-change outcome
// ---------------------------------------------------------------------------

/**
 * A structured verification outcome with canonical diagnostics.
 *
 * Maps to: StepOutput (kind: 'verify_result'), classifyVerifyResult().
 * Key additions: verification_id (identity), canonical diagnostics schema,
 * mismatch_summary, refreshed_refs, and needs-review status.
 */
export interface UhppVerificationResult {
  verification_id: string;
  checks_run: VerificationLevel[];
  status: VerificationStatus;
  diagnostics: UhppDiagnostic[];
  mismatch_summary?: string;
  refreshed_refs?: Record<string, string>;
  target_refs?: string[];
  provenance?: UhppProvenance;
}

export type VerificationStatus =
  | 'pass'
  | 'pass-with-warnings'
  | 'fail'
  | 'tool-error'
  | 'needs-review';

// ---------------------------------------------------------------------------
// Phase 2: Dual-Form Representation Types
// ---------------------------------------------------------------------------

/** The 9 hydration modes — from cheapest (id-only) to most expensive (full). */
export type HydrationMode =
  | 'id_only'
  | 'digest'
  | 'edit_ready_digest'
  | 'exact_span'
  | 'semantic_slice'
  | 'neighborhood_pack'
  | 'full'
  | 'diff_view'
  | 'verification_summary';

/** The 8 hash classes required by the spec. */
export type HashClass =
  | 'content'
  | 'normalized'
  | 'slice'
  | 'digest'
  | 'edit_ready_digest'
  | 'neighborhood'
  | 'change'
  | 'verification';

/** Result returned by the hydrate() API. */
export interface HydrationResult {
  ref: string;
  mode: HydrationMode;
  content: string;
  content_hash?: string;
  token_estimate: number;
  truncated?: boolean;
  source_revision?: string;
}

/**
 * Estimated cost of a hydration mode for a given artifact.
 * Used by the runtime to select the cheapest sufficient form.
 */
export interface HydrationCost {
  mode: HydrationMode;
  estimated_tokens: number;
  requires_backend: boolean;
  cacheable: boolean;
}

/**
 * Hash identity envelope — multi-class hash record for a canonical unit.
 * Only populated classes are present; others are computed lazily.
 */
export interface HashIdentity {
  content_hash: string;
  normalized_hash?: string;
  digest_hash?: string;
  edit_ready_digest_hash?: string;
  slice_hash?: string;
  neighborhood_hash?: string;
  change_hash?: string;
  verification_hash?: string;
}

/** Normalization level for producing normalized hashes. */
export type NormalizationLevel =
  | 'line_endings'
  | 'trailing_whitespace'
  | 'comments_stripped'
  | 'structural';

// ---------------------------------------------------------------------------
// Phase 3: Intent Binding Types
// ---------------------------------------------------------------------------

/** Confidence level for a binding decision. */
export type BindingConfidence = 'high' | 'medium' | 'low' | 'none';

/** Ambiguity status — whether a binding resolved uniquely. */
export type AmbiguityStatus =
  | 'unambiguous'
  | 'multiple_candidates'
  | 'unresolved'
  | 'partial';

/** Semantic operation family — coarser than OperationKind. */
export type OperationFamily =
  | 'discover'
  | 'understand'
  | 'mutate'
  | 'verify'
  | 'session'
  | 'annotate'
  | 'delegate'
  | 'system';

/**
 * A resolved candidate target with confidence and context metadata.
 * Produced during the target-resolution step of the binding pipeline.
 */
export interface CandidateTarget {
  ref: string;
  source_path?: string;
  target_kind: EditTargetKind;
  confidence: BindingConfidence;
  confidence_score: number;
  match_reason: string;
  content_hash?: string;
  revision_id?: string;
}

/**
 * Binding result — the structured output of the intent-binding pipeline.
 * Produced between step parsing and handler dispatch; recorded for
 * audit, debugging, and model feedback.
 */
export interface BindingResult {
  step_id: string;
  requested_operation: string;
  operation_family: OperationFamily;
  resolved_targets: CandidateTarget[];
  confidence: BindingConfidence;
  ambiguity_status: AmbiguityStatus;
  required_hydration: HydrationMode;
  required_verification: VerificationLevel[];
  warnings: string[];
  provenance?: UhppProvenance;
}

/**
 * Operation profile — declares what a given OperationKind needs
 * in terms of hydration level, verification, and target constraints.
 */
export interface OperationProfile {
  family: OperationFamily;
  requires_target: boolean;
  min_hydration: HydrationMode;
  default_verification: VerificationLevel[];
  eligible_target_kinds: EditTargetKind[];
}

// ---------------------------------------------------------------------------
// Phase 4: Intent-Driven Edits Types
// ---------------------------------------------------------------------------

/**
 * A single step within a transform plan — mirrors the backend refactor
 * execute operations array but with typed fields.
 */
export interface TransformStep {
  step_index: number;
  action: TransformAction;
  target_file: string;
  source_ref?: string;
  params: Record<string, unknown>;
  description: string;
  reversible: boolean;
}

export type TransformAction =
  | 'create_file'
  | 'remove_lines'
  | 'insert_lines'
  | 'replace_lines'
  | 'move_content'
  | 'import_update'
  | 'rename_symbol'
  | 'delete_file';

/** Pre/post conditions for plan validation. */
export interface TransformCondition {
  kind: TransformConditionKind;
  target_ref: string;
  description: string;
}

export type TransformConditionKind =
  | 'file_exists'
  | 'file_not_exists'
  | 'symbol_exists'
  | 'hash_matches'
  | 'no_lint_errors'
  | 'no_type_errors';

/**
 * A structured transform plan — sequenced operations with identity,
 * pre/post conditions, and rollback support.
 */
export interface TransformPlan {
  plan_id: string;
  intent_id: string;
  operation: EditOperation;
  target_refs: string[];
  steps: TransformStep[];
  pre_conditions: TransformCondition[];
  post_conditions: TransformCondition[];
  estimated_affected_files: number;
  requires_verification: VerificationLevel[];
  provenance?: UhppProvenance;
}

/**
 * Typed intent — the model's structured request before it's
 * expanded into a concrete transform plan.
 */
export interface EditIntent {
  intent_id: string;
  operation: EditOperation;
  target_refs: string[];
  params: EditIntentParams;
  dry_run: boolean;
  provenance?: UhppProvenance;
}

/**
 * Per-operation parameter unions. Only the fields relevant
 * to the declared operation are populated.
 */
export interface EditIntentParams {
  destination_file?: string;
  new_name?: string;
  symbol_names?: string[];
  insert_position?: 'before' | 'after' | 'start' | 'end';
  wrapper_template?: string;
  patch_content?: string;
  interface_changes?: InterfaceChange[];
}

export interface InterfaceChange {
  kind: 'add_param' | 'remove_param' | 'change_type' | 'add_field' | 'remove_field';
  name: string;
  type_annotation?: string;
  default_value?: string;
}

/**
 * Result of executing an edit intent — wraps the ChangeSet
 * with plan and verification metadata.
 */
export interface EditIntentResult {
  intent_id: string;
  plan: TransformPlan;
  change_set?: UhppChangeSet;
  verification?: UhppVerificationResult;
  status: EditIntentStatus;
  error?: string;
}

export type EditIntentStatus =
  | 'planned'
  | 'executed'
  | 'verified'
  | 'failed'
  | 'rolled_back'
  | 'dry_run';

// ---------------------------------------------------------------------------
// Phase 5: Reconciliation and Verification Types
// ---------------------------------------------------------------------------

/**
 * Failure classification — causal attribution for why a verification failed.
 * Extends beyond the existing backend `classify_verify_failure` with
 * risk-aware categories.
 */
export type FailureCategory =
  | 'host_missing_toolchain'
  | 'dependency_issue'
  | 'wrong_workspace_root'
  | 'refactor_induced'
  | 'baseline_project_failure'
  | 'stale_reference'
  | 'import_resolution'
  | 'type_mismatch'
  | 'test_regression'
  | 'unknown';

/**
 * Risk level for a failure — controls whether needs-review is emitted.
 */
export type FailureRisk = 'critical' | 'high' | 'medium' | 'low';

/**
 * Result of a single verification check within a layered pipeline.
 * Each check corresponds to one VerificationLevel.
 */
export interface VerificationCheckResult {
  level: VerificationLevel;
  status: VerificationStatus;
  diagnostics: UhppDiagnostic[];
  duration_ms: number;
  short_circuited?: boolean;
  failure_category?: FailureCategory;
  failure_risk?: FailureRisk;
}

/**
 * A single ref that was refreshed after mutation.
 * Maps old_hash → new_hash with the file that changed.
 */
export interface RefreshEntry {
  file: string;
  old_hash: string;
  new_hash: string;
  stale_refs_invalidated: string[];
}

/**
 * Aggregate result of post-edit reference refresh.
 */
export interface RefRefreshResult {
  entries: RefreshEntry[];
  total_stale: number;
  total_refreshed: number;
  unresolvable_refs: string[];
}

/**
 * Import validity state after reconciliation.
 */
export type ImportStatus = 'valid' | 'broken' | 'unused' | 'missing';

/**
 * A single import reconciliation finding.
 */
export interface ImportReconciliation {
  file: string;
  import_path: string;
  status: ImportStatus;
  suggested_fix?: string;
}

/**
 * Export surface reconciliation finding.
 */
export interface ExportReconciliation {
  file: string;
  symbol_name: string;
  still_defined: boolean;
  still_referenced: boolean;
}

/**
 * Aggregate result of relationship reconciliation.
 */
export interface ReconciliationResult {
  imports: ImportReconciliation[];
  exports: ExportReconciliation[];
  stale_hash_refs: string[];
  broken_count: number;
  warnings: string[];
}

/**
 * Configuration for a layered verification pipeline.
 * Levels are executed in cost order with optional short-circuiting.
 */
export interface VerificationPipelineConfig {
  levels: VerificationLevel[];
  short_circuit_on_fail: boolean;
  skip_expensive_after_fail: boolean;
  target_refs: string[];
  change_set_id?: string;
}

/**
 * Full result of a layered verification pipeline execution.
 * Wraps the individual check results with aggregate metadata.
 */
export interface VerificationPipelineResult {
  verification_id: string;
  config: VerificationPipelineConfig;
  check_results: VerificationCheckResult[];
  aggregate_status: VerificationStatus;
  total_duration_ms: number;
  ref_refresh?: RefRefreshResult;
  reconciliation?: ReconciliationResult;
  mismatch_summary?: string;
  provenance?: UhppProvenance;
}

// ---------------------------------------------------------------------------
// Phase 6: Shorthand Maturation Types
// ---------------------------------------------------------------------------

/** The 10 shorthand operation kinds from the spec. */
export type ShorthandOpKind =
  | 'target'
  | 'hydrate'
  | 'neighbors'
  | 'diff'
  | 'extract'
  | 'rewrite'
  | 'verify'
  | 'stage'
  | 'pin'
  | 'drop';

/** Resolve a ref to its current target. */
export interface ShorthandTarget {
  kind: 'target';
  ref: string;
}

/** Hydrate a ref at a specific mode. */
export interface ShorthandHydrate {
  kind: 'hydrate';
  mode: HydrationMode;
  ref: string;
}

/** Expand neighborhood context around a ref. */
export interface ShorthandNeighbors {
  kind: 'neighbors';
  ref: string;
  scope: ExpansionPolicy;
}

/** View a diff between two refs. */
export interface ShorthandDiff {
  kind: 'diff';
  old_ref: string;
  new_ref: string;
}

/** Extract content from a ref into a new file. */
export interface ShorthandExtract {
  kind: 'extract';
  from_ref: string;
  into_path: string;
  symbol_names?: string[];
}

/** Rewrite a ref with a stated intent. */
export interface ShorthandRewrite {
  kind: 'rewrite';
  ref: string;
  intent: string;
}

/** Verify refs at a specified level. */
export interface ShorthandVerify {
  kind: 'verify';
  level: VerificationLevel;
  refs: string[];
}

/** Stage refs into context. */
export interface ShorthandStage {
  kind: 'stage';
  refs: string[];
}

/** Pin refs to prevent eviction. */
export interface ShorthandPin {
  kind: 'pin';
  refs: string[];
}

/** Drop refs from context. */
export interface ShorthandDrop {
  kind: 'drop';
  refs: string[];
}

/** Discriminated union of all shorthand operations. */
export type ShorthandOp =
  | ShorthandTarget
  | ShorthandHydrate
  | ShorthandNeighbors
  | ShorthandDiff
  | ShorthandExtract
  | ShorthandRewrite
  | ShorthandVerify
  | ShorthandStage
  | ShorthandPin
  | ShorthandDrop;

/** Structured error from parsing a malformed shorthand expression. */
export interface ShorthandError {
  message: string;
  position: number;
  expected: string;
  suggestion?: string;
}

/** Result of parsing a shorthand expression. */
export interface ShorthandParseResult {
  success: boolean;
  op?: ShorthandOp;
  error?: ShorthandError;
  raw_input: string;
}

/**
 * A batch step descriptor — the compilation target for shorthand.
 * Each shorthand compiles to 1+ batch steps that the existing runtime
 * already knows how to execute.
 */
export interface BatchStepDescriptor {
  step_kind: string;
  params: Record<string, unknown>;
}

/** Result of compiling a shorthand op into executable batch steps. */
export interface ShorthandCompileResult {
  op: ShorthandOp;
  batch_steps: BatchStepDescriptor[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Phase 6: Hash Algorithm Stratification
// ---------------------------------------------------------------------------

/** Hash algorithms used in the system. */
export type HashAlgorithm = 'fnv1a_32' | 'sha256';

/**
 * Hash stratification — declares which algorithm to use for each purpose.
 * FNV1a for fast runtime identity; SHA-256 for durable persistence and verification.
 */
export interface HashStratification {
  runtime_identity: HashAlgorithm;
  persistence_identity: HashAlgorithm;
  verification_identity: HashAlgorithm;
}

// ---------------------------------------------------------------------------
// Phase 6: Non-Code Artifact Support
// ---------------------------------------------------------------------------

/**
 * A blackboard entry promoted to a hashable, addressable artifact.
 * Extends the existing `bb:key` addressing with content hashing
 * so blackboard entries participate in the `h:` reference system.
 */
export interface BlackboardArtifact {
  key: string;
  content_hash: string;
  content_type: string;
  artifact_id?: string;
  revision_id?: string;
  provenance?: UhppProvenance;
}
