//! UHPP Canonical Data Model — Phase 1
//!
//! Seven canonical types that form the foundation of the UHPP architecture.
//! These structs mirror the TypeScript interfaces in `uhppCanonical.ts`.
//!
//! See: docs/UHPP_END_STATE_SPEC.md, docs/UHPP_PHASE1_CANONICAL_UNITS.md

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Shared foundational types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppProvenance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppDiagnostic {
    pub file: String,
    pub line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
    pub message: String,
    pub severity: DiagnosticSeverity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
    Hint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppSpan {
    pub start_line: u32,
    pub end_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UhppSelector {
    Span { span: UhppSpan },
    Symbol { symbol_kind: String, name: String },
    Pattern { pattern: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StabilityMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_changed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_frequency: Option<ChangeFrequency>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_verified_revision: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeFrequency {
    Stable,
    Moderate,
    Volatile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExpansionPolicy {
    Minimal,
    Local,
    Transitive,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyConstraint {
    Readonly,
    ConfirmRequired,
    GeneratedFile,
    LockedByOther,
}

// ---------------------------------------------------------------------------
// 1. Artifact
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppArtifact {
    pub artifact_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_origin: Option<String>,
    pub content_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_kind: Option<ArtifactDomainKind>,
    pub revision_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<UhppProvenance>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactDomainKind {
    Code,
    Config,
    Documentation,
    PromptTemplate,
    BlackboardEntry,
    DiagnosticResult,
    WorkflowDefinition,
    SearchResult,
    GeneratedReport,
}

// ---------------------------------------------------------------------------
// 2. Slice
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppSlice {
    pub slice_id: String,
    pub parent_artifact_id: String,
    pub selector: UhppSelector,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit_ready_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape_metadata: Option<SliceShapeMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stability: Option<StabilityMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceShapeMetadata {
    pub shape_ops: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit_session_id: Option<String>,
}

// ---------------------------------------------------------------------------
// 3. SymbolUnit
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppSymbolUnit {
    pub symbol_id: String,
    pub symbol_kind: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defining_slice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relationships: Option<UhppSymbolRelationships>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppSymbolRelationships {
    pub inbound: Vec<UhppSymbolRelation>,
    pub outbound: Vec<UhppSymbolRelation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppSymbolRelation {
    pub target_symbol_id: String,
    pub relation_kind: SymbolRelationKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolRelationKind {
    Calls,
    CalledBy,
    Imports,
    ImportedBy,
    Extends,
    ExtendedBy,
    Implements,
    ImplementedBy,
    References,
    ReferencedBy,
}

// ---------------------------------------------------------------------------
// 4. Neighborhood
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppNeighborhood {
    pub neighborhood_id: String,
    pub anchor_target: String,
    pub included_refs: Vec<UhppNeighborRef>,
    pub expansion_policy: ExpansionPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppNeighborRef {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub ref_kind: NeighborRefKind,
    pub rationale: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NeighborRefKind {
    Artifact,
    Slice,
    Symbol,
}

// ---------------------------------------------------------------------------
// 5. EditTarget
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppEditTarget {
    pub target_ref: String,
    pub target_kind: EditTargetKind,
    pub current_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eligible_operations: Option<Vec<EditOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safety_constraints: Option<Vec<SafetyConstraint>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditTargetKind {
    File,
    ExactSpan,
    Symbol,
    Slice,
    DisplayOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditOperation {
    Extract,
    Rename,
    Move,
    Split,
    Merge,
    Inline,
    Wrap,
    Patch,
    AdaptInterface,
    PropagateCallsites,
    UpdateImports,
}

// ---------------------------------------------------------------------------
// 6. ChangeSet
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppChangeSet {
    pub change_id: String,
    pub operation_type: String,
    pub target_refs: Vec<String>,
    pub rendered_edits: Vec<UhppFileEdit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_downstream_updates: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_requirements: Option<Vec<VerificationLevel>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<UhppProvenance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppFileEdit {
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_hash: Option<String>,
    pub edit_kind: FileEditKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileEditKind {
    Create,
    Modify,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerificationLevel {
    Freshness,
    Structural,
    Relationship,
    Parser,
    Typecheck,
    Test,
}

// ---------------------------------------------------------------------------
// 7. VerificationResult
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UhppVerificationResult {
    pub verification_id: String,
    pub checks_run: Vec<VerificationLevel>,
    pub status: VerificationStatus,
    pub diagnostics: Vec<UhppDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mismatch_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refreshed_refs: Option<std::collections::HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_refs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<UhppProvenance>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VerificationStatus {
    Pass,
    PassWithWarnings,
    Fail,
    ToolError,
    NeedsReview,
}

// ---------------------------------------------------------------------------
// Phase 2: Dual-Form Representation Types
// ---------------------------------------------------------------------------

/// The 9 hydration modes — from cheapest (id-only) to most expensive (full).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HydrationMode {
    IdOnly,
    Digest,
    EditReadyDigest,
    ExactSpan,
    SemanticSlice,
    NeighborhoodPack,
    Full,
    DiffView,
    VerificationSummary,
}

/// The 8 hash classes required by the spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HashClass {
    Content,
    Normalized,
    Slice,
    Digest,
    EditReadyDigest,
    Neighborhood,
    Change,
    Verification,
}

/// Result returned by the hydrate() API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HydrationResult {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub mode: HydrationMode,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    pub token_estimate: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
}

/// Estimated cost of a hydration mode for a given artifact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HydrationCost {
    pub mode: HydrationMode,
    pub estimated_tokens: u32,
    pub requires_backend: bool,
    pub cacheable: bool,
}

/// Multi-class hash record for a canonical unit.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HashIdentity {
    pub content_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit_ready_digest_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slice_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub neighborhood_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_hash: Option<String>,
}

/// Normalization level for producing normalized hashes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizationLevel {
    LineEndings,
    TrailingWhitespace,
    CommentsStripped,
    Structural,
}

// ---------------------------------------------------------------------------
// Phase 3: Intent Binding Types
// ---------------------------------------------------------------------------

/// Confidence level for a binding decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BindingConfidence {
    High,
    Medium,
    Low,
    None,
}

/// Ambiguity status — whether a binding resolved uniquely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AmbiguityStatus {
    Unambiguous,
    MultipleCandidates,
    Unresolved,
    Partial,
}

/// Semantic operation family — coarser than OperationKind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationFamily {
    Discover,
    Understand,
    Mutate,
    Verify,
    Session,
    Annotate,
    Delegate,
    System,
}

/// A resolved candidate target with confidence and context metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateTarget {
    #[serde(rename = "ref")]
    pub ref_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    pub target_kind: EditTargetKind,
    pub confidence: BindingConfidence,
    pub confidence_score: f64,
    pub match_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_id: Option<String>,
}

/// Binding result — structured output of the intent-binding pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindingResult {
    pub step_id: String,
    pub requested_operation: String,
    pub operation_family: OperationFamily,
    pub resolved_targets: Vec<CandidateTarget>,
    pub confidence: BindingConfidence,
    pub ambiguity_status: AmbiguityStatus,
    pub required_hydration: HydrationMode,
    pub required_verification: Vec<VerificationLevel>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<UhppProvenance>,
}

/// Operation profile — declares what a given OperationKind needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationProfile {
    pub family: OperationFamily,
    pub requires_target: bool,
    pub min_hydration: HydrationMode,
    pub default_verification: Vec<VerificationLevel>,
    pub eligible_target_kinds: Vec<EditTargetKind>,
}

// ---------------------------------------------------------------------------
// Phase 4: Intent-Driven Edits Types
// ---------------------------------------------------------------------------

/// A single step within a transform plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformStep {
    pub step_index: u32,
    pub action: TransformAction,
    pub target_file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub params: serde_json::Value,
    pub description: String,
    pub reversible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransformAction {
    CreateFile,
    RemoveLines,
    InsertLines,
    ReplaceLines,
    MoveContent,
    ImportUpdate,
    RenameSymbol,
    DeleteFile,
}

/// Pre/post condition for plan validation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformCondition {
    pub kind: TransformConditionKind,
    pub target_ref: String,
    pub description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransformConditionKind {
    FileExists,
    FileNotExists,
    SymbolExists,
    HashMatches,
    NoLintErrors,
    NoTypeErrors,
}

/// A structured transform plan — sequenced operations with identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformPlan {
    pub plan_id: String,
    pub intent_id: String,
    pub operation: EditOperation,
    pub target_refs: Vec<String>,
    pub steps: Vec<TransformStep>,
    pub pre_conditions: Vec<TransformCondition>,
    pub post_conditions: Vec<TransformCondition>,
    pub estimated_affected_files: u32,
    pub requires_verification: Vec<VerificationLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<UhppProvenance>,
}

/// Typed edit intent — structured request before expansion to a plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditIntent {
    pub intent_id: String,
    pub operation: EditOperation,
    pub target_refs: Vec<String>,
    pub params: EditIntentParams,
    pub dry_run: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<UhppProvenance>,
}

/// Per-operation parameter bag — only relevant fields are populated.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EditIntentParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insert_position: Option<InsertPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrapper_template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface_changes: Option<Vec<InterfaceChange>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InsertPosition {
    Before,
    After,
    Start,
    End,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterfaceChange {
    pub kind: InterfaceChangeKind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_annotation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InterfaceChangeKind {
    AddParam,
    RemoveParam,
    ChangeType,
    AddField,
    RemoveField,
}

/// Result of executing an edit intent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditIntentResult {
    pub intent_id: String,
    pub plan: TransformPlan,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_set: Option<UhppChangeSet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification: Option<UhppVerificationResult>,
    pub status: EditIntentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditIntentStatus {
    Planned,
    Executed,
    Verified,
    Failed,
    RolledBack,
    DryRun,
}

// ---------------------------------------------------------------------------
// Phase 5: Reconciliation and Verification Types
// ---------------------------------------------------------------------------

/// Causal attribution for why a verification failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCategory {
    HostMissingToolchain,
    DependencyIssue,
    WrongWorkspaceRoot,
    RefactorInduced,
    BaselineProjectFailure,
    StaleReference,
    ImportResolution,
    TypeMismatch,
    TestRegression,
    Unknown,
}

/// Risk level for a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FailureRisk {
    Critical,
    High,
    Medium,
    Low,
}

/// Result of a single verification check within a layered pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationCheckResult {
    pub level: VerificationLevel,
    pub status: VerificationStatus,
    pub diagnostics: Vec<UhppDiagnostic>,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_circuited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_category: Option<FailureCategory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_risk: Option<FailureRisk>,
}

/// A single ref that was refreshed after mutation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshEntry {
    pub file: String,
    pub old_hash: String,
    pub new_hash: String,
    pub stale_refs_invalidated: Vec<String>,
}

/// Aggregate result of post-edit reference refresh.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefRefreshResult {
    pub entries: Vec<RefreshEntry>,
    pub total_stale: u32,
    pub total_refreshed: u32,
    pub unresolvable_refs: Vec<String>,
}

/// Import validity state after reconciliation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportStatus {
    Valid,
    Broken,
    Unused,
    Missing,
}

/// A single import reconciliation finding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportReconciliation {
    pub file: String,
    pub import_path: String,
    pub status: ImportStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_fix: Option<String>,
}

/// Export surface reconciliation finding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportReconciliation {
    pub file: String,
    pub symbol_name: String,
    pub still_defined: bool,
    pub still_referenced: bool,
}

/// Aggregate result of relationship reconciliation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconciliationResult {
    pub imports: Vec<ImportReconciliation>,
    pub exports: Vec<ExportReconciliation>,
    pub stale_hash_refs: Vec<String>,
    pub broken_count: u32,
    pub warnings: Vec<String>,
}

/// Configuration for a layered verification pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationPipelineConfig {
    pub levels: Vec<VerificationLevel>,
    pub short_circuit_on_fail: bool,
    pub skip_expensive_after_fail: bool,
    pub target_refs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_set_id: Option<String>,
}

/// Full result of a layered verification pipeline execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationPipelineResult {
    pub verification_id: String,
    pub config: VerificationPipelineConfig,
    pub check_results: Vec<VerificationCheckResult>,
    pub aggregate_status: VerificationStatus,
    pub total_duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_refresh: Option<RefRefreshResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconciliation: Option<ReconciliationResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mismatch_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<UhppProvenance>,
}

// ---------------------------------------------------------------------------
// Phase 6: Shorthand Maturation Types
// ---------------------------------------------------------------------------

/// The 10 shorthand operation kinds from the spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShorthandOpKind {
    Target,
    Hydrate,
    Neighbors,
    Diff,
    Extract,
    Rewrite,
    Verify,
    Stage,
    Pin,
    Drop,
}

/// Discriminated union of all shorthand operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShorthandOp {
    Target {
        #[serde(rename = "ref")]
        ref_id: String,
    },
    Hydrate {
        mode: HydrationMode,
        #[serde(rename = "ref")]
        ref_id: String,
    },
    Neighbors {
        #[serde(rename = "ref")]
        ref_id: String,
        scope: ExpansionPolicy,
    },
    Diff {
        old_ref: String,
        new_ref: String,
    },
    Extract {
        from_ref: String,
        into_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        symbol_names: Option<Vec<String>>,
    },
    Rewrite {
        #[serde(rename = "ref")]
        ref_id: String,
        intent: String,
    },
    Verify {
        level: VerificationLevel,
        refs: Vec<String>,
    },
    Stage {
        refs: Vec<String>,
    },
    Pin {
        refs: Vec<String>,
    },
    Drop {
        refs: Vec<String>,
    },
}

/// Structured error from parsing a malformed shorthand expression.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShorthandError {
    pub message: String,
    pub position: u32,
    pub expected: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

/// Result of parsing a shorthand expression.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShorthandParseResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op: Option<ShorthandOp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ShorthandError>,
    pub raw_input: String,
}

/// A batch step descriptor — compilation target for shorthand.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchStepDescriptor {
    pub step_kind: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Result of compiling a shorthand op into executable batch steps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShorthandCompileResult {
    pub op: ShorthandOp,
    pub batch_steps: Vec<BatchStepDescriptor>,
    pub warnings: Vec<String>,
}

/// Hash algorithms used in the system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HashAlgorithm {
    #[serde(rename = "fnv1a_32")]
    Fnv1a32,
    #[serde(rename = "sha256")]
    Sha256,
}

/// Hash stratification — which algorithm for each purpose.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashStratification {
    pub runtime_identity: HashAlgorithm,
    pub persistence_identity: HashAlgorithm,
    pub verification_identity: HashAlgorithm,
}

/// Blackboard entry promoted to a hashable, addressable artifact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlackboardArtifact {
    pub key: String,
    pub content_hash: String,
    pub content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance: Option<UhppProvenance>,
}

// ---------------------------------------------------------------------------
// Digest generation (ported from contextHash.ts)
// ---------------------------------------------------------------------------

/// Symbol info used for digest generation (mirrors TS `DigestSymbol`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DigestSymbol {
    pub name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
}

const DIGEST_MAX_SYMBOLS: usize = 20;
const DIGEST_MAX_LINES: usize = 3;

/// Abbreviate symbol kind for compact display.
fn abbreviate_kind(kind: &str) -> String {
    let lower = kind.to_lowercase();
    match lower.as_str() {
        "function" | "method" => "fn".into(),
        "constructor" => "ctor".into(),
        "class" => "cls".into(),
        "struct" => "struct".into(),
        "interface" => "iface".into(),
        "enum" => "enum".into(),
        "type" => "type".into(),
        "trait" => "trait".into(),
        "variable" => "var".into(),
        "constant" => "const".into(),
        "property" => "prop".into(),
        "module" | "namespace" => "mod".into(),
        "impl" => "impl".into(),
        "macro" => "mac".into(),
        "decorator" => "dec".into(),
        "protocol" => "proto".into(),
        _ => {
            if lower.len() <= 4 { lower } else { lower[..4].to_string() }
        }
    }
}

/// Format ATLS symbols into a compact pipe-separated digest.
fn format_symbol_digest(symbols: &[DigestSymbol]) -> String {
    let items = &symbols[..symbols.len().min(DIGEST_MAX_SYMBOLS)];
    let parts: Vec<String> = items.iter().map(|s| {
        let kind = abbreviate_kind(&s.kind);
        format!("{} {}", kind, s.name)
    }).collect();
    let line = parts.join(" | ");
    let overflow = if symbols.len() > DIGEST_MAX_SYMBOLS {
        format!(" (+{} more)", symbols.len() - DIGEST_MAX_SYMBOLS)
    } else {
        String::new()
    };
    format!("  {}{}", line, overflow)
}

/// Format symbols with line ranges: "fn name:15-32 | cls Name:34-89"
fn format_symbol_digest_with_lines(symbols: &[DigestSymbol]) -> String {
    let items = &symbols[..symbols.len().min(DIGEST_MAX_SYMBOLS)];
    let parts: Vec<String> = items.iter().map(|s| {
        let abbrev = abbreviate_kind(&s.kind);
        match (s.start_line, s.end_line) {
            (Some(start), Some(end)) => format!("{} {}:{}-{}", abbrev, s.name, start, end),
            (Some(start), None) => format!("{} {}:{}", abbrev, s.name, start),
            _ => format!("{} {}", abbrev, s.name),
        }
    }).collect();
    let line = parts.join(" | ");
    let overflow = if symbols.len() > DIGEST_MAX_SYMBOLS {
        format!(" (+{} more)", symbols.len() - DIGEST_MAX_SYMBOLS)
    } else {
        String::new()
    };
    format!("  {}{}", line, overflow)
}

/// Regex-based code digest: extract fn/class/struct names from raw code.
fn extract_code_digest(content: &str) -> String {
    use regex::Regex;
    let re = Regex::new(
        r"(?m)^\s*(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|function|def|func|class|struct|interface|trait|enum|type|impl)\s+(\w+)"
    ).unwrap();
    let names: Vec<&str> = re.captures_iter(content)
        .take(DIGEST_MAX_SYMBOLS)
        .filter_map(|c| c.get(1).map(|m| m.as_str()))
        .collect();
    if names.is_empty() { return String::new(); }
    format!("  {}", names.join(" | "))
}

/// Regex-based code digest with line numbers.
fn extract_code_digest_with_lines(content: &str) -> String {
    use regex::Regex;
    let re = Regex::new(
        r"(?m)^\s*(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|function|def|func|class|struct|interface|trait|enum|type|impl)\s+(\w+)"
    ).unwrap();
    let entries: Vec<String> = re.captures_iter(content)
        .take(DIGEST_MAX_SYMBOLS)
        .filter_map(|c| {
            let m = c.get(1)?;
            let name = m.as_str();
            let byte_offset = c.get(0)?.start();
            let line_num = content[..byte_offset].matches('\n').count() + 1;
            Some(format!("{}:{}", name, line_num))
        })
        .collect();
    if entries.is_empty() { return String::new(); }
    format!("  {}", entries.join(" | "))
}

/// Extract first N non-empty, non-comment lines as a generic digest.
fn extract_key_lines(content: &str) -> String {
    let lines: Vec<&str> = content.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with("//") && !l.starts_with('#'))
        .take(DIGEST_MAX_LINES)
        .collect();
    if lines.is_empty() { return String::new(); }
    lines.iter()
        .map(|l| {
            let truncated = if l.len() > 100 { &l[..100] } else { l };
            format!("  {}", truncated)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Generate a compact digest for content, optionally using symbol data.
///
/// Mirrors TypeScript `generateDigest()` from `contextHash.ts`.
pub fn generate_digest(content: &str, content_type: &str, symbols: Option<&[DigestSymbol]>) -> String {
    if let Some(syms) = symbols {
        if !syms.is_empty() {
            return format_symbol_digest(syms);
        }
    }
    match content_type {
        "file" | "smart" | "raw" => extract_code_digest(content),
        "search" | "exec:out" | "issues" | "deps" | "symbol" | "result" => {
            extract_key_lines(content)
        }
        _ => String::new(),
    }
}

/// Generate an edit-ready digest with line-range anchors per symbol.
///
/// Mirrors TypeScript `generateEditReadyDigest()` from `contextHash.ts`.
pub fn generate_edit_ready_digest(
    content: &str,
    content_type: &str,
    symbols: Option<&[DigestSymbol]>,
) -> String {
    if let Some(syms) = symbols {
        if !syms.is_empty() {
            return format_symbol_digest_with_lines(syms);
        }
    }
    if matches!(content_type, "file" | "smart" | "raw") {
        return extract_code_digest_with_lines(content);
    }
    generate_digest(content, content_type, symbols)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── abbreviate_kind ──

    #[test]
    fn abbreviate_known_kinds() {
        assert_eq!(abbreviate_kind("function"), "fn");
        assert_eq!(abbreviate_kind("method"), "fn");
        assert_eq!(abbreviate_kind("constructor"), "ctor");
        assert_eq!(abbreviate_kind("class"), "cls");
        assert_eq!(abbreviate_kind("interface"), "iface");
        assert_eq!(abbreviate_kind("module"), "mod");
        assert_eq!(abbreviate_kind("namespace"), "mod");
        assert_eq!(abbreviate_kind("constant"), "const");
        assert_eq!(abbreviate_kind("property"), "prop");
        assert_eq!(abbreviate_kind("decorator"), "dec");
        assert_eq!(abbreviate_kind("protocol"), "proto");
    }

    #[test]
    fn abbreviate_case_insensitive() {
        assert_eq!(abbreviate_kind("Function"), "fn");
        assert_eq!(abbreviate_kind("CLASS"), "cls");
        assert_eq!(abbreviate_kind("TRAIT"), "trait");
    }

    #[test]
    fn abbreviate_unknown_short() {
        assert_eq!(abbreviate_kind("foo"), "foo");
        assert_eq!(abbreviate_kind("ab"), "ab");
    }

    #[test]
    fn abbreviate_unknown_long_truncates() {
        assert_eq!(abbreviate_kind("something"), "some");
        assert_eq!(abbreviate_kind("widget"), "widg");
    }

    // ── generate_digest ──

    #[test]
    fn digest_with_symbols() {
        let symbols = vec![
            DigestSymbol { name: "parse".into(), kind: "function".into(), signature: None, start_line: None, end_line: None },
            DigestSymbol { name: "Config".into(), kind: "struct".into(), signature: None, start_line: None, end_line: None },
        ];
        let result = generate_digest("", "file", Some(&symbols));
        assert!(result.contains("fn parse"));
        assert!(result.contains("struct Config"));
        assert!(result.contains(" | "));
    }

    #[test]
    fn digest_regex_fallback_for_code() {
        let code = "fn hello() {}\nstruct World {}\nclass Foo {}\n";
        let result = generate_digest(code, "file", None);
        assert!(result.contains("hello"));
        assert!(result.contains("World"));
        assert!(result.contains("Foo"));
    }

    #[test]
    fn digest_empty_for_unknown_type() {
        let result = generate_digest("anything", "unknown_type", None);
        assert!(result.is_empty());
    }

    #[test]
    fn digest_key_lines_for_search() {
        let content = "// comment line\nresult: found 3 matches\nerror in auth.ts\n";
        let result = generate_digest(content, "search", None);
        assert!(result.contains("result: found 3 matches"));
        assert!(!result.contains("// comment line"));
    }

    #[test]
    fn digest_empty_symbols_falls_through() {
        let code = "fn fallback() {}\n";
        let result = generate_digest(code, "file", Some(&[]));
        assert!(result.contains("fallback"));
    }

    #[test]
    fn digest_overflow_indicator() {
        let symbols: Vec<DigestSymbol> = (0..25).map(|i| DigestSymbol {
            name: format!("sym{}", i), kind: "function".into(),
            signature: None, start_line: None, end_line: None,
        }).collect();
        let result = generate_digest("", "file", Some(&symbols));
        assert!(result.contains("(+5 more)"));
    }

    // ── generate_edit_ready_digest ──

    #[test]
    fn edit_ready_digest_with_line_ranges() {
        let symbols = vec![
            DigestSymbol { name: "authenticate".into(), kind: "function".into(), signature: None, start_line: Some(15), end_line: Some(32) },
            DigestSymbol { name: "AuthService".into(), kind: "class".into(), signature: None, start_line: Some(34), end_line: Some(89) },
        ];
        let result = generate_edit_ready_digest("", "file", Some(&symbols));
        assert!(result.contains("fn authenticate:15-32"));
        assert!(result.contains("cls AuthService:34-89"));
    }

    #[test]
    fn edit_ready_digest_partial_line_info() {
        let symbols = vec![
            DigestSymbol { name: "setup".into(), kind: "function".into(), signature: None, start_line: Some(10), end_line: None },
            DigestSymbol { name: "Bare".into(), kind: "class".into(), signature: None, start_line: None, end_line: None },
        ];
        let result = generate_edit_ready_digest("", "file", Some(&symbols));
        assert!(result.contains("fn setup:10"));
        assert!(result.contains("cls Bare"));
        assert!(!result.contains("cls Bare:"));
    }

    #[test]
    fn edit_ready_digest_regex_with_line_numbers() {
        let code = "pub fn alpha() {}\nstruct Beta {}\n";
        let result = generate_edit_ready_digest(code, "file", None);
        assert!(result.contains("alpha:1"), "expected alpha:1 in '{}'", result);
        assert!(result.contains("Beta:2"), "expected Beta:2 in '{}'", result);
    }

    // ── Serde round-trip for Phase 1 canonical types ──

    #[test]
    fn serde_artifact_round_trip() {
        let artifact = UhppArtifact {
            artifact_id: "art-001".into(),
            source_path: Some("src/main.rs".into()),
            logical_origin: None,
            content_hash: "abcd1234abcd1234".into(),
            normalized_hash: None,
            language: Some("rust".into()),
            domain_kind: Some(ArtifactDomainKind::Code),
            revision_id: "rev-001".into(),
            provenance: None,
        };
        let json = serde_json::to_string(&artifact).unwrap();
        let deser: UhppArtifact = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.artifact_id, "art-001");
        assert_eq!(deser.content_hash, "abcd1234abcd1234");
        assert!(json.contains("\"domain_kind\":\"code\""));
    }

    #[test]
    fn serde_artifact_skips_none_fields() {
        let artifact = UhppArtifact {
            artifact_id: "art-002".into(),
            source_path: None,
            logical_origin: None,
            content_hash: "abcd".into(),
            normalized_hash: None,
            language: None,
            domain_kind: None,
            revision_id: "rev-002".into(),
            provenance: None,
        };
        let json = serde_json::to_string(&artifact).unwrap();
        assert!(!json.contains("source_path"));
        assert!(!json.contains("normalized_hash"));
        assert!(!json.contains("domain_kind"));
    }

    #[test]
    fn serde_slice_round_trip() {
        let slice = UhppSlice {
            slice_id: "sl-001".into(),
            parent_artifact_id: "art-001".into(),
            selector: UhppSelector::Symbol { symbol_kind: "function".into(), name: "parse".into() },
            digest: Some("fn parse | fn validate".into()),
            edit_ready_digest: Some("fn parse:10-25 | fn validate:27-40".into()),
            shape_metadata: None,
            stability: None,
        };
        let json = serde_json::to_string(&slice).unwrap();
        let deser: UhppSlice = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.slice_id, "sl-001");
        assert!(matches!(deser.selector, UhppSelector::Symbol { .. }));
    }

    #[test]
    fn serde_selector_variants() {
        let span = UhppSelector::Span { span: UhppSpan { start_line: 10, end_line: 20, start_column: None, end_column: None } };
        let json = serde_json::to_string(&span).unwrap();
        assert!(json.contains("\"kind\":\"span\""));

        let sym = UhppSelector::Symbol { symbol_kind: "fn".into(), name: "foo".into() };
        let json = serde_json::to_string(&sym).unwrap();
        assert!(json.contains("\"kind\":\"symbol\""));

        let pat = UhppSelector::Pattern { pattern: "error.*handler".into() };
        let json = serde_json::to_string(&pat).unwrap();
        assert!(json.contains("\"kind\":\"pattern\""));
    }

    #[test]
    fn serde_edit_target_round_trip() {
        let target = UhppEditTarget {
            target_ref: "h:abc123".into(),
            target_kind: EditTargetKind::Symbol,
            current_revision: "rev-005".into(),
            eligible_operations: Some(vec![EditOperation::Extract, EditOperation::Rename]),
            safety_constraints: Some(vec![SafetyConstraint::ConfirmRequired]),
        };
        let json = serde_json::to_string(&target).unwrap();
        assert!(json.contains("\"target_kind\":\"symbol\""));
        assert!(json.contains("\"extract\""));
        assert!(json.contains("\"rename\""));
        assert!(json.contains("\"confirm_required\""));
        let deser: UhppEditTarget = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.eligible_operations.as_ref().unwrap().len(), 2);
    }

    #[test]
    fn serde_verification_result_round_trip() {
        let vr = UhppVerificationResult {
            verification_id: "vr-001".into(),
            checks_run: vec![VerificationLevel::Typecheck, VerificationLevel::Test],
            status: VerificationStatus::PassWithWarnings,
            diagnostics: vec![UhppDiagnostic {
                file: "src/lib.rs".into(),
                line: 42,
                column: Some(5),
                end_line: None,
                end_column: None,
                message: "unused variable".into(),
                severity: DiagnosticSeverity::Warning,
                code: Some("W001".into()),
                source: Some("rustc".into()),
            }],
            mismatch_summary: None,
            refreshed_refs: None,
            target_refs: Some(vec!["h:abc123".into()]),
            provenance: None,
        };
        let json = serde_json::to_string(&vr).unwrap();
        assert!(json.contains("\"pass-with-warnings\""));
        assert!(json.contains("\"typecheck\""));
        let deser: UhppVerificationResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.diagnostics.len(), 1);
        assert_eq!(deser.diagnostics[0].line, 42);
    }

    #[test]
    fn serde_change_set_round_trip() {
        let cs = UhppChangeSet {
            change_id: "ch-001".into(),
            operation_type: "extract".into(),
            target_refs: vec!["h:abc".into(), "h:def".into()],
            rendered_edits: vec![UhppFileEdit {
                file: "src/utils.ts".into(),
                old_hash: Some("aaaa".into()),
                new_hash: Some("bbbb".into()),
                edit_kind: FileEditKind::Modify,
            }],
            expected_downstream_updates: Some(vec!["h:ghi".into()]),
            verification_requirements: Some(vec![VerificationLevel::Typecheck]),
            provenance: Some(UhppProvenance {
                actor: Some("agent".into()),
                operation: Some("extract".into()),
                batch_id: Some("batch-001".into()),
                step_id: Some("s3".into()),
                timestamp: 1700000000,
                parent_revision: None,
            }),
        };
        let json = serde_json::to_string(&cs).unwrap();
        let deser: UhppChangeSet = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.change_id, "ch-001");
        assert_eq!(deser.rendered_edits[0].edit_kind, FileEditKind::Modify);
        assert!(deser.provenance.is_some());
    }

    #[test]
    fn serde_neighborhood_round_trip() {
        let n = UhppNeighborhood {
            neighborhood_id: "nh-001".into(),
            anchor_target: "h:abc123".into(),
            included_refs: vec![
                UhppNeighborRef {
                    ref_id: "h:def456".into(),
                    ref_kind: NeighborRefKind::Artifact,
                    rationale: "imports from target".into(),
                },
            ],
            expansion_policy: ExpansionPolicy::Local,
        };
        let json = serde_json::to_string(&n).unwrap();
        assert!(json.contains("\"expansion_policy\":\"local\""));
        let deser: UhppNeighborhood = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.included_refs.len(), 1);
    }

    // ── Serde round-trip for Phase 2 types ──

    #[test]
    fn serde_hydration_mode_all_variants() {
        let modes = vec![
            HydrationMode::IdOnly, HydrationMode::Digest, HydrationMode::EditReadyDigest,
            HydrationMode::ExactSpan, HydrationMode::SemanticSlice, HydrationMode::NeighborhoodPack,
            HydrationMode::Full, HydrationMode::DiffView, HydrationMode::VerificationSummary,
        ];
        for mode in &modes {
            let json = serde_json::to_string(mode).unwrap();
            let deser: HydrationMode = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, mode);
        }
    }

    #[test]
    fn serde_hydration_mode_snake_case() {
        assert_eq!(serde_json::to_string(&HydrationMode::IdOnly).unwrap(), "\"id_only\"");
        assert_eq!(serde_json::to_string(&HydrationMode::EditReadyDigest).unwrap(), "\"edit_ready_digest\"");
        assert_eq!(serde_json::to_string(&HydrationMode::SemanticSlice).unwrap(), "\"semantic_slice\"");
        assert_eq!(serde_json::to_string(&HydrationMode::NeighborhoodPack).unwrap(), "\"neighborhood_pack\"");
        assert_eq!(serde_json::to_string(&HydrationMode::DiffView).unwrap(), "\"diff_view\"");
        assert_eq!(serde_json::to_string(&HydrationMode::VerificationSummary).unwrap(), "\"verification_summary\"");
    }

    #[test]
    fn serde_hash_class_all_variants() {
        let classes = vec![
            HashClass::Content, HashClass::Normalized, HashClass::Slice,
            HashClass::Digest, HashClass::EditReadyDigest, HashClass::Neighborhood,
            HashClass::Change, HashClass::Verification,
        ];
        for cls in &classes {
            let json = serde_json::to_string(cls).unwrap();
            let deser: HashClass = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, cls);
        }
    }

    #[test]
    fn serde_hydration_result_round_trip() {
        let hr = HydrationResult {
            ref_id: "h:abcdef".into(),
            mode: HydrationMode::Digest,
            content: "fn parse | fn validate".into(),
            content_hash: Some("1234abcd".into()),
            token_estimate: 12,
            truncated: None,
            source_revision: Some("rev-003".into()),
        };
        let json = serde_json::to_string(&hr).unwrap();
        assert!(json.contains("\"ref\":\"h:abcdef\""));
        assert!(json.contains("\"mode\":\"digest\""));
        let deser: HydrationResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.ref_id, "h:abcdef");
        assert_eq!(deser.token_estimate, 12);
    }

    #[test]
    fn serde_hash_identity_default_and_sparse() {
        let id = HashIdentity {
            content_hash: "abcdef12".into(),
            ..Default::default()
        };
        let json = serde_json::to_string(&id).unwrap();
        assert!(json.contains("\"content_hash\":\"abcdef12\""));
        assert!(!json.contains("normalized_hash"));
        assert!(!json.contains("digest_hash"));

        let id2 = HashIdentity {
            content_hash: "aaa".into(),
            digest_hash: Some("bbb".into()),
            ..Default::default()
        };
        let json2 = serde_json::to_string(&id2).unwrap();
        assert!(json2.contains("\"digest_hash\":\"bbb\""));
        assert!(!json2.contains("normalized_hash"));
    }

    #[test]
    fn serde_hydration_cost_round_trip() {
        let cost = HydrationCost {
            mode: HydrationMode::Full,
            estimated_tokens: 1500,
            requires_backend: false,
            cacheable: true,
        };
        let json = serde_json::to_string(&cost).unwrap();
        let deser: HydrationCost = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.mode, HydrationMode::Full);
        assert_eq!(deser.estimated_tokens, 1500);
        assert!(deser.cacheable);
    }

    #[test]
    fn serde_digest_symbol_round_trip() {
        let ds = DigestSymbol {
            name: "authenticate".into(),
            kind: "function".into(),
            signature: Some("pub fn authenticate(token: &str) -> Result<User>".into()),
            start_line: Some(15),
            end_line: Some(42),
        };
        let json = serde_json::to_string(&ds).unwrap();
        let deser: DigestSymbol = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.name, "authenticate");
        assert_eq!(deser.start_line, Some(15));
    }

    #[test]
    fn serde_normalization_level() {
        assert_eq!(serde_json::to_string(&NormalizationLevel::LineEndings).unwrap(), "\"line_endings\"");
        assert_eq!(serde_json::to_string(&NormalizationLevel::CommentsStripped).unwrap(), "\"comments_stripped\"");
        let deser: NormalizationLevel = serde_json::from_str("\"trailing_whitespace\"").unwrap();
        assert_eq!(deser, NormalizationLevel::TrailingWhitespace);
    }

    // ── Phase 3: Intent Binding serde round-trips ──

    #[test]
    fn serde_binding_confidence_all_variants() {
        let variants = vec![
            (BindingConfidence::High, "\"high\""),
            (BindingConfidence::Medium, "\"medium\""),
            (BindingConfidence::Low, "\"low\""),
            (BindingConfidence::None, "\"none\""),
        ];
        for (val, expected) in &variants {
            let json = serde_json::to_string(val).unwrap();
            assert_eq!(&json, *expected);
            let deser: BindingConfidence = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, val);
        }
    }

    #[test]
    fn serde_ambiguity_status_all_variants() {
        let variants = vec![
            (AmbiguityStatus::Unambiguous, "\"unambiguous\""),
            (AmbiguityStatus::MultipleCandidates, "\"multiple_candidates\""),
            (AmbiguityStatus::Unresolved, "\"unresolved\""),
            (AmbiguityStatus::Partial, "\"partial\""),
        ];
        for (val, expected) in &variants {
            let json = serde_json::to_string(val).unwrap();
            assert_eq!(&json, *expected);
            let deser: AmbiguityStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, val);
        }
    }

    #[test]
    fn serde_operation_family_all_variants() {
        let variants = vec![
            OperationFamily::Discover, OperationFamily::Understand,
            OperationFamily::Mutate, OperationFamily::Verify,
            OperationFamily::Session, OperationFamily::Annotate,
            OperationFamily::Delegate, OperationFamily::System,
        ];
        for fam in &variants {
            let json = serde_json::to_string(fam).unwrap();
            let deser: OperationFamily = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, fam);
        }
        assert_eq!(serde_json::to_string(&OperationFamily::Discover).unwrap(), "\"discover\"");
        assert_eq!(serde_json::to_string(&OperationFamily::Mutate).unwrap(), "\"mutate\"");
    }

    #[test]
    fn serde_candidate_target_round_trip() {
        let ct = CandidateTarget {
            ref_id: "h:abc123".into(),
            source_path: Some("src/lib.rs".into()),
            target_kind: EditTargetKind::Symbol,
            confidence: BindingConfidence::High,
            confidence_score: 0.95,
            match_reason: "fresh:revision_match".into(),
            content_hash: Some("deadbeef".into()),
            revision_id: Some("rev-010".into()),
        };
        let json = serde_json::to_string(&ct).unwrap();
        assert!(json.contains("\"ref\":\"h:abc123\""));
        assert!(json.contains("\"confidence\":\"high\""));
        assert!(json.contains("\"confidence_score\":0.95"));
        let deser: CandidateTarget = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.ref_id, "h:abc123");
        assert_eq!(deser.target_kind, EditTargetKind::Symbol);
        assert_eq!(deser.confidence_score, 0.95);
    }

    #[test]
    fn serde_candidate_target_sparse() {
        let ct = CandidateTarget {
            ref_id: "src/main.ts".into(),
            source_path: None,
            target_kind: EditTargetKind::File,
            confidence: BindingConfidence::Medium,
            confidence_score: 0.65,
            match_reason: "literal_ref".into(),
            content_hash: None,
            revision_id: None,
        };
        let json = serde_json::to_string(&ct).unwrap();
        assert!(!json.contains("source_path"));
        assert!(!json.contains("content_hash"));
        assert!(!json.contains("revision_id"));
    }

    #[test]
    fn serde_binding_result_round_trip() {
        let br = BindingResult {
            step_id: "s1".into(),
            requested_operation: "change.edit".into(),
            operation_family: OperationFamily::Mutate,
            resolved_targets: vec![CandidateTarget {
                ref_id: "src/foo.ts".into(),
                source_path: Some("src/foo.ts".into()),
                target_kind: EditTargetKind::File,
                confidence: BindingConfidence::High,
                confidence_score: 0.95,
                match_reason: "literal_ref".into(),
                content_hash: None,
                revision_id: None,
            }],
            confidence: BindingConfidence::High,
            ambiguity_status: AmbiguityStatus::Unambiguous,
            required_hydration: HydrationMode::EditReadyDigest,
            required_verification: vec![VerificationLevel::Freshness],
            warnings: vec![],
            provenance: None,
        };
        let json = serde_json::to_string(&br).unwrap();
        assert!(json.contains("\"operation_family\":\"mutate\""));
        assert!(json.contains("\"ambiguity_status\":\"unambiguous\""));
        assert!(json.contains("\"required_hydration\":\"edit_ready_digest\""));
        let deser: BindingResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.step_id, "s1");
        assert_eq!(deser.resolved_targets.len(), 1);
        assert_eq!(deser.confidence, BindingConfidence::High);
    }

    #[test]
    fn serde_binding_result_with_warnings_and_provenance() {
        let br = BindingResult {
            step_id: "s2".into(),
            requested_operation: "change.refactor".into(),
            operation_family: OperationFamily::Mutate,
            resolved_targets: vec![],
            confidence: BindingConfidence::Low,
            ambiguity_status: AmbiguityStatus::Unresolved,
            required_hydration: HydrationMode::EditReadyDigest,
            required_verification: vec![VerificationLevel::Freshness, VerificationLevel::Structural, VerificationLevel::Typecheck],
            warnings: vec!["no_targets_resolved".into(), "preflight_blocked".into()],
            provenance: Some(UhppProvenance {
                actor: Some("agent".into()),
                operation: Some("bind".into()),
                batch_id: Some("b-001".into()),
                step_id: Some("s2".into()),
                timestamp: 1700000000,
                parent_revision: None,
            }),
        };
        let json = serde_json::to_string(&br).unwrap();
        let deser: BindingResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.warnings.len(), 2);
        assert!(deser.provenance.is_some());
        assert_eq!(deser.required_verification.len(), 3);
    }

    #[test]
    fn serde_operation_profile_round_trip() {
        let op = OperationProfile {
            family: OperationFamily::Mutate,
            requires_target: true,
            min_hydration: HydrationMode::EditReadyDigest,
            default_verification: vec![VerificationLevel::Freshness, VerificationLevel::Typecheck],
            eligible_target_kinds: vec![EditTargetKind::File, EditTargetKind::Symbol],
        };
        let json = serde_json::to_string(&op).unwrap();
        let deser: OperationProfile = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.family, OperationFamily::Mutate);
        assert!(deser.requires_target);
        assert_eq!(deser.eligible_target_kinds.len(), 2);
    }

    #[test]
    fn serde_binding_result_ts_compatibility() {
        let ts_json = r#"{
            "step_id": "s1",
            "requested_operation": "change.edit",
            "operation_family": "mutate",
            "resolved_targets": [{
                "ref": "src/foo.ts",
                "target_kind": "file",
                "confidence": "high",
                "confidence_score": 0.95,
                "match_reason": "literal_ref"
            }],
            "confidence": "high",
            "ambiguity_status": "unambiguous",
            "required_hydration": "edit_ready_digest",
            "required_verification": ["freshness"],
            "warnings": []
        }"#;
        let deser: BindingResult = serde_json::from_str(ts_json).unwrap();
        assert_eq!(deser.step_id, "s1");
        assert_eq!(deser.operation_family, OperationFamily::Mutate);
        assert_eq!(deser.resolved_targets[0].ref_id, "src/foo.ts");
    }

    // ── Phase 4: Intent-Driven Edits serde round-trips ──

    #[test]
    fn serde_transform_action_all_variants() {
        let variants = vec![
            (TransformAction::CreateFile, "\"create_file\""),
            (TransformAction::RemoveLines, "\"remove_lines\""),
            (TransformAction::InsertLines, "\"insert_lines\""),
            (TransformAction::ReplaceLines, "\"replace_lines\""),
            (TransformAction::MoveContent, "\"move_content\""),
            (TransformAction::ImportUpdate, "\"import_update\""),
            (TransformAction::RenameSymbol, "\"rename_symbol\""),
            (TransformAction::DeleteFile, "\"delete_file\""),
        ];
        for (val, expected) in &variants {
            let json = serde_json::to_string(val).unwrap();
            assert_eq!(&json, *expected);
            let deser: TransformAction = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, val);
        }
    }

    #[test]
    fn serde_transform_condition_kind_all_variants() {
        let variants = vec![
            (TransformConditionKind::FileExists, "\"file_exists\""),
            (TransformConditionKind::FileNotExists, "\"file_not_exists\""),
            (TransformConditionKind::SymbolExists, "\"symbol_exists\""),
            (TransformConditionKind::HashMatches, "\"hash_matches\""),
            (TransformConditionKind::NoLintErrors, "\"no_lint_errors\""),
            (TransformConditionKind::NoTypeErrors, "\"no_type_errors\""),
        ];
        for (val, expected) in &variants {
            let json = serde_json::to_string(val).unwrap();
            assert_eq!(&json, *expected);
        }
    }

    #[test]
    fn serde_transform_step_round_trip() {
        let step = TransformStep {
            step_index: 0,
            action: TransformAction::CreateFile,
            target_file: "src/helpers.ts".into(),
            source_ref: Some("src/big.ts".into()),
            params: serde_json::json!({"symbol_names": ["parseConfig"]}),
            description: "Create helpers.ts with extracted symbols".into(),
            reversible: true,
        };
        let json = serde_json::to_string(&step).unwrap();
        let deser: TransformStep = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.step_index, 0);
        assert_eq!(deser.action, TransformAction::CreateFile);
        assert_eq!(deser.target_file, "src/helpers.ts");
        assert!(deser.reversible);
    }

    #[test]
    fn serde_transform_plan_round_trip() {
        let plan = TransformPlan {
            plan_id: "plan-001".into(),
            intent_id: "intent-001".into(),
            operation: EditOperation::Extract,
            target_refs: vec!["src/big.ts".into()],
            steps: vec![TransformStep {
                step_index: 0,
                action: TransformAction::CreateFile,
                target_file: "src/helpers.ts".into(),
                source_ref: Some("src/big.ts".into()),
                params: serde_json::json!({}),
                description: "Create helpers".into(),
                reversible: true,
            }],
            pre_conditions: vec![TransformCondition {
                kind: TransformConditionKind::FileExists,
                target_ref: "src/big.ts".into(),
                description: "Source must exist".into(),
            }],
            post_conditions: vec![TransformCondition {
                kind: TransformConditionKind::FileExists,
                target_ref: "src/helpers.ts".into(),
                description: "Destination was created".into(),
            }],
            estimated_affected_files: 2,
            requires_verification: vec![VerificationLevel::Freshness, VerificationLevel::Structural],
            provenance: None,
        };
        let json = serde_json::to_string(&plan).unwrap();
        assert!(json.contains("\"operation\":\"extract\""));
        assert!(json.contains("\"estimated_affected_files\":2"));
        let deser: TransformPlan = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.plan_id, "plan-001");
        assert_eq!(deser.steps.len(), 1);
        assert_eq!(deser.pre_conditions.len(), 1);
        assert_eq!(deser.post_conditions.len(), 1);
    }

    #[test]
    fn serde_edit_intent_round_trip() {
        let intent = EditIntent {
            intent_id: "intent-002".into(),
            operation: EditOperation::Rename,
            target_refs: vec!["src/utils.ts".into()],
            params: EditIntentParams {
                new_name: Some("betterName".into()),
                symbol_names: Some(vec!["oldName".into()]),
                ..Default::default()
            },
            dry_run: true,
            provenance: None,
        };
        let json = serde_json::to_string(&intent).unwrap();
        assert!(json.contains("\"operation\":\"rename\""));
        assert!(json.contains("\"dry_run\":true"));
        let deser: EditIntent = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.intent_id, "intent-002");
        assert_eq!(deser.params.new_name, Some("betterName".into()));
        assert!(deser.dry_run);
    }

    #[test]
    fn serde_edit_intent_params_sparse() {
        let params = EditIntentParams {
            destination_file: Some("dst.ts".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&params).unwrap();
        assert!(json.contains("\"destination_file\":\"dst.ts\""));
        assert!(!json.contains("new_name"));
        assert!(!json.contains("symbol_names"));
        assert!(!json.contains("wrapper_template"));
    }

    #[test]
    fn serde_interface_change_round_trip() {
        let change = InterfaceChange {
            kind: InterfaceChangeKind::AddParam,
            name: "timeout".into(),
            type_annotation: Some("number".into()),
            default_value: Some("5000".into()),
        };
        let json = serde_json::to_string(&change).unwrap();
        assert!(json.contains("\"kind\":\"add_param\""));
        let deser: InterfaceChange = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.name, "timeout");
        assert_eq!(deser.kind, InterfaceChangeKind::AddParam);
    }

    #[test]
    fn serde_edit_intent_status_all_variants() {
        let variants = vec![
            (EditIntentStatus::Planned, "\"planned\""),
            (EditIntentStatus::Executed, "\"executed\""),
            (EditIntentStatus::Verified, "\"verified\""),
            (EditIntentStatus::Failed, "\"failed\""),
            (EditIntentStatus::RolledBack, "\"rolled_back\""),
            (EditIntentStatus::DryRun, "\"dry_run\""),
        ];
        for (val, expected) in &variants {
            let json = serde_json::to_string(val).unwrap();
            assert_eq!(&json, *expected);
            let deser: EditIntentStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, val);
        }
    }

    #[test]
    fn serde_insert_position_all_variants() {
        let variants = vec![
            (InsertPosition::Before, "\"before\""),
            (InsertPosition::After, "\"after\""),
            (InsertPosition::Start, "\"start\""),
            (InsertPosition::End, "\"end\""),
        ];
        for (val, expected) in &variants {
            let json = serde_json::to_string(val).unwrap();
            assert_eq!(&json, *expected);
        }
    }

    #[test]
    fn serde_edit_intent_result_round_trip() {
        let result = EditIntentResult {
            intent_id: "intent-003".into(),
            plan: TransformPlan {
                plan_id: "plan-003".into(),
                intent_id: "intent-003".into(),
                operation: EditOperation::Patch,
                target_refs: vec!["src/x.ts".into()],
                steps: vec![],
                pre_conditions: vec![],
                post_conditions: vec![],
                estimated_affected_files: 1,
                requires_verification: vec![VerificationLevel::Freshness],
                provenance: None,
            },
            change_set: None,
            verification: None,
            status: EditIntentStatus::DryRun,
            error: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"status\":\"dry_run\""));
        let deser: EditIntentResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.intent_id, "intent-003");
        assert_eq!(deser.plan.operation, EditOperation::Patch);
    }

    #[test]
    fn serde_transform_plan_ts_compatibility() {
        let ts_json = r#"{
            "plan_id": "plan-ts",
            "intent_id": "intent-ts",
            "operation": "extract",
            "target_refs": ["src/big.ts"],
            "steps": [{
                "step_index": 0,
                "action": "create_file",
                "target_file": "src/helpers.ts",
                "source_ref": "src/big.ts",
                "params": {"symbol_names": ["parseConfig"]},
                "description": "Create helpers",
                "reversible": true
            }],
            "pre_conditions": [{
                "kind": "file_exists",
                "target_ref": "src/big.ts",
                "description": "Source exists"
            }],
            "post_conditions": [],
            "estimated_affected_files": 2,
            "requires_verification": ["freshness", "structural"]
        }"#;
        let deser: TransformPlan = serde_json::from_str(ts_json).unwrap();
        assert_eq!(deser.plan_id, "plan-ts");
        assert_eq!(deser.steps[0].action, TransformAction::CreateFile);
        assert_eq!(deser.requires_verification.len(), 2);
    }

    // ── Phase 5: Reconciliation and Verification serde round-trips ──

    #[test]
    fn serde_failure_category_all_variants() {
        let variants = vec![
            (FailureCategory::HostMissingToolchain, "\"host_missing_toolchain\""),
            (FailureCategory::DependencyIssue, "\"dependency_issue\""),
            (FailureCategory::WrongWorkspaceRoot, "\"wrong_workspace_root\""),
            (FailureCategory::RefactorInduced, "\"refactor_induced\""),
            (FailureCategory::BaselineProjectFailure, "\"baseline_project_failure\""),
            (FailureCategory::StaleReference, "\"stale_reference\""),
            (FailureCategory::ImportResolution, "\"import_resolution\""),
            (FailureCategory::TypeMismatch, "\"type_mismatch\""),
            (FailureCategory::TestRegression, "\"test_regression\""),
            (FailureCategory::Unknown, "\"unknown\""),
        ];
        for (val, expected) in &variants {
            let json = serde_json::to_string(val).unwrap();
            assert_eq!(&json, *expected);
            let deser: FailureCategory = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, val);
        }
    }

    #[test]
    fn serde_failure_risk_all_variants() {
        let variants = vec![
            (FailureRisk::Critical, "\"critical\""),
            (FailureRisk::High, "\"high\""),
            (FailureRisk::Medium, "\"medium\""),
            (FailureRisk::Low, "\"low\""),
        ];
        for (val, expected) in &variants {
            let json = serde_json::to_string(val).unwrap();
            assert_eq!(&json, *expected);
            let deser: FailureRisk = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, val);
        }
    }

    #[test]
    fn serde_verification_check_result_round_trip() {
        let cr = VerificationCheckResult {
            level: VerificationLevel::Typecheck,
            status: VerificationStatus::Fail,
            diagnostics: vec![UhppDiagnostic {
                file: "src/main.ts".into(),
                line: 10,
                column: Some(5),
                end_line: None,
                end_column: None,
                message: "Type 'string' is not assignable to type 'number'".into(),
                severity: DiagnosticSeverity::Error,
                code: Some("TS2322".into()),
                source: Some("tsc".into()),
            }],
            duration_ms: 1234,
            short_circuited: None,
            failure_category: Some(FailureCategory::TypeMismatch),
            failure_risk: Some(FailureRisk::High),
        };
        let json = serde_json::to_string(&cr).unwrap();
        assert!(json.contains("\"level\":\"typecheck\""));
        assert!(json.contains("\"failure_category\":\"type_mismatch\""));
        assert!(json.contains("\"failure_risk\":\"high\""));
        let deser: VerificationCheckResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.diagnostics.len(), 1);
        assert_eq!(deser.duration_ms, 1234);
    }

    #[test]
    fn serde_verification_check_result_sparse() {
        let cr = VerificationCheckResult {
            level: VerificationLevel::Freshness,
            status: VerificationStatus::Pass,
            diagnostics: vec![],
            duration_ms: 5,
            short_circuited: None,
            failure_category: None,
            failure_risk: None,
        };
        let json = serde_json::to_string(&cr).unwrap();
        assert!(!json.contains("short_circuited"));
        assert!(!json.contains("failure_category"));
        assert!(!json.contains("failure_risk"));
    }

    #[test]
    fn serde_refresh_entry_round_trip() {
        let entry = RefreshEntry {
            file: "src/utils.ts".into(),
            old_hash: "aaaa".into(),
            new_hash: "bbbb".into(),
            stale_refs_invalidated: vec!["h:cccc".into(), "h:dddd".into()],
        };
        let json = serde_json::to_string(&entry).unwrap();
        let deser: RefreshEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.file, "src/utils.ts");
        assert_eq!(deser.stale_refs_invalidated.len(), 2);
    }

    #[test]
    fn serde_ref_refresh_result_round_trip() {
        let rr = RefRefreshResult {
            entries: vec![RefreshEntry {
                file: "src/a.ts".into(),
                old_hash: "old1".into(),
                new_hash: "new1".into(),
                stale_refs_invalidated: vec!["h:stale1".into()],
            }],
            total_stale: 3,
            total_refreshed: 1,
            unresolvable_refs: vec!["h:gone".into()],
        };
        let json = serde_json::to_string(&rr).unwrap();
        let deser: RefRefreshResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.total_stale, 3);
        assert_eq!(deser.total_refreshed, 1);
        assert_eq!(deser.unresolvable_refs.len(), 1);
    }

    #[test]
    fn serde_import_status_all_variants() {
        let variants = vec![
            (ImportStatus::Valid, "\"valid\""),
            (ImportStatus::Broken, "\"broken\""),
            (ImportStatus::Unused, "\"unused\""),
            (ImportStatus::Missing, "\"missing\""),
        ];
        for (val, expected) in &variants {
            let json = serde_json::to_string(val).unwrap();
            assert_eq!(&json, *expected);
            let deser: ImportStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, val);
        }
    }

    #[test]
    fn serde_reconciliation_result_round_trip() {
        let rr = ReconciliationResult {
            imports: vec![ImportReconciliation {
                file: "src/app.ts".into(),
                import_path: "./utils".into(),
                status: ImportStatus::Broken,
                suggested_fix: Some("Update to ./helpers".into()),
            }],
            exports: vec![ExportReconciliation {
                file: "src/utils.ts".into(),
                symbol_name: "parseConfig".into(),
                still_defined: false,
                still_referenced: true,
            }],
            stale_hash_refs: vec!["h:old1".into()],
            broken_count: 2,
            warnings: vec!["export parseConfig removed but still referenced".into()],
        };
        let json = serde_json::to_string(&rr).unwrap();
        let deser: ReconciliationResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.imports.len(), 1);
        assert_eq!(deser.imports[0].status, ImportStatus::Broken);
        assert_eq!(deser.exports.len(), 1);
        assert!(!deser.exports[0].still_defined);
        assert_eq!(deser.broken_count, 2);
    }

    #[test]
    fn serde_verification_pipeline_config_round_trip() {
        let cfg = VerificationPipelineConfig {
            levels: vec![
                VerificationLevel::Freshness,
                VerificationLevel::Structural,
                VerificationLevel::Typecheck,
            ],
            short_circuit_on_fail: true,
            skip_expensive_after_fail: true,
            target_refs: vec!["src/main.ts".into()],
            change_set_id: Some("ch-001".into()),
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"short_circuit_on_fail\":true"));
        let deser: VerificationPipelineConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.levels.len(), 3);
        assert_eq!(deser.change_set_id, Some("ch-001".into()));
    }

    #[test]
    fn serde_verification_pipeline_result_round_trip() {
        let pr = VerificationPipelineResult {
            verification_id: "vp-001".into(),
            config: VerificationPipelineConfig {
                levels: vec![VerificationLevel::Freshness, VerificationLevel::Typecheck],
                short_circuit_on_fail: true,
                skip_expensive_after_fail: false,
                target_refs: vec!["src/a.ts".into()],
                change_set_id: None,
            },
            check_results: vec![
                VerificationCheckResult {
                    level: VerificationLevel::Freshness,
                    status: VerificationStatus::Pass,
                    diagnostics: vec![],
                    duration_ms: 3,
                    short_circuited: None,
                    failure_category: None,
                    failure_risk: None,
                },
                VerificationCheckResult {
                    level: VerificationLevel::Typecheck,
                    status: VerificationStatus::Fail,
                    diagnostics: vec![UhppDiagnostic {
                        file: "src/a.ts".into(),
                        line: 5,
                        column: None,
                        end_line: None,
                        end_column: None,
                        message: "type error".into(),
                        severity: DiagnosticSeverity::Error,
                        code: None,
                        source: None,
                    }],
                    duration_ms: 2500,
                    short_circuited: None,
                    failure_category: Some(FailureCategory::TypeMismatch),
                    failure_risk: Some(FailureRisk::High),
                },
            ],
            aggregate_status: VerificationStatus::Fail,
            total_duration_ms: 2503,
            ref_refresh: None,
            reconciliation: None,
            mismatch_summary: Some("Expected string, got number at src/a.ts:5".into()),
            provenance: None,
        };
        let json = serde_json::to_string(&pr).unwrap();
        assert!(json.contains("\"aggregate_status\":\"fail\""));
        assert!(json.contains("\"total_duration_ms\":2503"));
        let deser: VerificationPipelineResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.verification_id, "vp-001");
        assert_eq!(deser.check_results.len(), 2);
        assert!(deser.mismatch_summary.is_some());
    }

    #[test]
    fn serde_verification_pipeline_result_ts_compatibility() {
        let ts_json = r#"{
            "verification_id": "vp-ts",
            "config": {
                "levels": ["freshness", "structural", "typecheck"],
                "short_circuit_on_fail": true,
                "skip_expensive_after_fail": false,
                "target_refs": ["src/main.ts"]
            },
            "check_results": [{
                "level": "freshness",
                "status": "pass",
                "diagnostics": [],
                "duration_ms": 5
            }],
            "aggregate_status": "pass",
            "total_duration_ms": 5
        }"#;
        let deser: VerificationPipelineResult = serde_json::from_str(ts_json).unwrap();
        assert_eq!(deser.verification_id, "vp-ts");
        assert_eq!(deser.config.levels.len(), 3);
        assert_eq!(deser.check_results[0].status, VerificationStatus::Pass);
    }

    // ── Phase 6: Shorthand Maturation serde round-trips ──

    #[test]
    fn serde_shorthand_op_kind_all_variants() {
        let variants = vec![
            (ShorthandOpKind::Target, "\"target\""),
            (ShorthandOpKind::Hydrate, "\"hydrate\""),
            (ShorthandOpKind::Neighbors, "\"neighbors\""),
            (ShorthandOpKind::Diff, "\"diff\""),
            (ShorthandOpKind::Extract, "\"extract\""),
            (ShorthandOpKind::Rewrite, "\"rewrite\""),
            (ShorthandOpKind::Verify, "\"verify\""),
            (ShorthandOpKind::Stage, "\"stage\""),
            (ShorthandOpKind::Pin, "\"pin\""),
            (ShorthandOpKind::Drop, "\"drop\""),
        ];
        for (val, expected) in &variants {
            let json = serde_json::to_string(val).unwrap();
            assert_eq!(&json, *expected);
            let deser: ShorthandOpKind = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, val);
        }
    }

    #[test]
    fn serde_shorthand_op_target_round_trip() {
        let op = ShorthandOp::Target { ref_id: "h:abc123".into() };
        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"kind\":\"target\""));
        assert!(json.contains("\"ref\":\"h:abc123\""));
        let deser: ShorthandOp = serde_json::from_str(&json).unwrap();
        match deser {
            ShorthandOp::Target { ref_id } => assert_eq!(ref_id, "h:abc123"),
            _ => panic!("expected Target variant"),
        }
    }

    #[test]
    fn serde_shorthand_op_hydrate_round_trip() {
        let op = ShorthandOp::Hydrate {
            mode: HydrationMode::Digest,
            ref_id: "h:def456".into(),
        };
        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"kind\":\"hydrate\""));
        assert!(json.contains("\"mode\":\"digest\""));
        let deser: ShorthandOp = serde_json::from_str(&json).unwrap();
        match deser {
            ShorthandOp::Hydrate { mode, ref_id } => {
                assert_eq!(mode, HydrationMode::Digest);
                assert_eq!(ref_id, "h:def456");
            }
            _ => panic!("expected Hydrate variant"),
        }
    }

    #[test]
    fn serde_shorthand_op_neighbors_round_trip() {
        let op = ShorthandOp::Neighbors {
            ref_id: "h:abc".into(),
            scope: ExpansionPolicy::Local,
        };
        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"kind\":\"neighbors\""));
        assert!(json.contains("\"scope\":\"local\""));
        let deser: ShorthandOp = serde_json::from_str(&json).unwrap();
        match deser {
            ShorthandOp::Neighbors { ref_id, scope } => {
                assert_eq!(ref_id, "h:abc");
                assert_eq!(scope, ExpansionPolicy::Local);
            }
            _ => panic!("expected Neighbors variant"),
        }
    }

    #[test]
    fn serde_shorthand_op_diff_round_trip() {
        let op = ShorthandOp::Diff {
            old_ref: "h:old1".into(),
            new_ref: "h:new1".into(),
        };
        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"kind\":\"diff\""));
        let deser: ShorthandOp = serde_json::from_str(&json).unwrap();
        match deser {
            ShorthandOp::Diff { old_ref, new_ref } => {
                assert_eq!(old_ref, "h:old1");
                assert_eq!(new_ref, "h:new1");
            }
            _ => panic!("expected Diff variant"),
        }
    }

    #[test]
    fn serde_shorthand_op_extract_round_trip() {
        let op = ShorthandOp::Extract {
            from_ref: "h:big".into(),
            into_path: "src/helpers.ts".into(),
            symbol_names: Some(vec!["parseConfig".into(), "validateInput".into()]),
        };
        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"kind\":\"extract\""));
        assert!(json.contains("\"into_path\":\"src/helpers.ts\""));
        let deser: ShorthandOp = serde_json::from_str(&json).unwrap();
        match deser {
            ShorthandOp::Extract { from_ref, into_path, symbol_names } => {
                assert_eq!(from_ref, "h:big");
                assert_eq!(into_path, "src/helpers.ts");
                assert_eq!(symbol_names.unwrap().len(), 2);
            }
            _ => panic!("expected Extract variant"),
        }
    }

    #[test]
    fn serde_shorthand_op_extract_sparse() {
        let op = ShorthandOp::Extract {
            from_ref: "h:x".into(),
            into_path: "out.ts".into(),
            symbol_names: None,
        };
        let json = serde_json::to_string(&op).unwrap();
        assert!(!json.contains("symbol_names"));
    }

    #[test]
    fn serde_shorthand_op_rewrite_round_trip() {
        let op = ShorthandOp::Rewrite {
            ref_id: "h:target".into(),
            intent: "convert class to functional component".into(),
        };
        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"kind\":\"rewrite\""));
        let deser: ShorthandOp = serde_json::from_str(&json).unwrap();
        match deser {
            ShorthandOp::Rewrite { ref_id, intent } => {
                assert_eq!(ref_id, "h:target");
                assert!(intent.contains("functional component"));
            }
            _ => panic!("expected Rewrite variant"),
        }
    }

    #[test]
    fn serde_shorthand_op_verify_round_trip() {
        let op = ShorthandOp::Verify {
            level: VerificationLevel::Typecheck,
            refs: vec!["h:a".into(), "h:b".into()],
        };
        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"kind\":\"verify\""));
        assert!(json.contains("\"level\":\"typecheck\""));
        let deser: ShorthandOp = serde_json::from_str(&json).unwrap();
        match deser {
            ShorthandOp::Verify { level, refs } => {
                assert_eq!(level, VerificationLevel::Typecheck);
                assert_eq!(refs.len(), 2);
            }
            _ => panic!("expected Verify variant"),
        }
    }

    #[test]
    fn serde_shorthand_op_session_variants() {
        let ops = vec![
            ShorthandOp::Stage { refs: vec!["h:a".into()] },
            ShorthandOp::Pin { refs: vec!["h:b".into()] },
            ShorthandOp::Drop { refs: vec!["h:c".into(), "h:d".into()] },
        ];
        for op in &ops {
            let json = serde_json::to_string(op).unwrap();
            let deser: ShorthandOp = serde_json::from_str(&json).unwrap();
            let json2 = serde_json::to_string(&deser).unwrap();
            assert_eq!(json, json2);
        }
    }

    #[test]
    fn serde_shorthand_parse_result_success() {
        let pr = ShorthandParseResult {
            success: true,
            op: Some(ShorthandOp::Target { ref_id: "h:abc".into() }),
            error: None,
            raw_input: "target(h:abc)".into(),
        };
        let json = serde_json::to_string(&pr).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(!json.contains("\"error\""));
        let deser: ShorthandParseResult = serde_json::from_str(&json).unwrap();
        assert!(deser.success);
        assert!(deser.op.is_some());
    }

    #[test]
    fn serde_shorthand_parse_result_failure() {
        let pr = ShorthandParseResult {
            success: false,
            op: None,
            error: Some(ShorthandError {
                message: "unknown operation 'foo'".into(),
                position: 0,
                expected: "one of: target, hydrate, neighbors, diff, extract, rewrite, verify, stage, pin, drop".into(),
                suggestion: Some("Did you mean 'stage'?".into()),
            }),
            raw_input: "foo(h:abc)".into(),
        };
        let json = serde_json::to_string(&pr).unwrap();
        assert!(json.contains("\"success\":false"));
        assert!(json.contains("\"suggestion\""));
        let deser: ShorthandParseResult = serde_json::from_str(&json).unwrap();
        assert!(!deser.success);
        assert!(deser.error.is_some());
        assert_eq!(deser.error.unwrap().position, 0);
    }

    #[test]
    fn serde_batch_step_descriptor_round_trip() {
        let bsd = BatchStepDescriptor {
            step_kind: "read.shaped".into(),
            params: serde_json::json!({"ref": "h:abc", "modifier": "auto"}),
        };
        let json = serde_json::to_string(&bsd).unwrap();
        assert!(json.contains("\"step_kind\":\"read.shaped\""));
        let deser: BatchStepDescriptor = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.step_kind, "read.shaped");
    }

    #[test]
    fn serde_shorthand_compile_result_round_trip() {
        let cr = ShorthandCompileResult {
            op: ShorthandOp::Stage { refs: vec!["h:abc".into()] },
            batch_steps: vec![BatchStepDescriptor {
                step_kind: "session.stage".into(),
                params: serde_json::json!({"refs": ["h:abc"]}),
            }],
            warnings: vec![],
        };
        let json = serde_json::to_string(&cr).unwrap();
        let deser: ShorthandCompileResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.batch_steps.len(), 1);
        assert_eq!(deser.batch_steps[0].step_kind, "session.stage");
    }

    #[test]
    fn serde_hash_algorithm_all_variants() {
        let variants = vec![
            (HashAlgorithm::Fnv1a32, "\"fnv1a_32\""),
            (HashAlgorithm::Sha256, "\"sha256\""),
        ];
        for (val, expected) in &variants {
            let json = serde_json::to_string(val).unwrap();
            assert_eq!(&json, *expected);
            let deser: HashAlgorithm = serde_json::from_str(&json).unwrap();
            assert_eq!(&deser, val);
        }
    }

    #[test]
    fn serde_hash_stratification_round_trip() {
        let hs = HashStratification {
            runtime_identity: HashAlgorithm::Fnv1a32,
            persistence_identity: HashAlgorithm::Sha256,
            verification_identity: HashAlgorithm::Sha256,
        };
        let json = serde_json::to_string(&hs).unwrap();
        assert!(json.contains("\"runtime_identity\":\"fnv1a_32\""));
        assert!(json.contains("\"persistence_identity\":\"sha256\""));
        let deser: HashStratification = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.runtime_identity, HashAlgorithm::Fnv1a32);
        assert_eq!(deser.verification_identity, HashAlgorithm::Sha256);
    }

    #[test]
    fn serde_blackboard_artifact_round_trip() {
        let ba = BlackboardArtifact {
            key: "session_context".into(),
            content_hash: "aabb1122".into(),
            content_type: "json".into(),
            artifact_id: Some("bb-art-001".into()),
            revision_id: Some("bb-rev-001".into()),
            provenance: None,
        };
        let json = serde_json::to_string(&ba).unwrap();
        assert!(json.contains("\"key\":\"session_context\""));
        assert!(json.contains("\"content_type\":\"json\""));
        let deser: BlackboardArtifact = serde_json::from_str(&json).unwrap();
        assert_eq!(deser.key, "session_context");
        assert_eq!(deser.artifact_id, Some("bb-art-001".into()));
    }

    #[test]
    fn serde_blackboard_artifact_sparse() {
        let ba = BlackboardArtifact {
            key: "temp".into(),
            content_hash: "1234".into(),
            content_type: "text".into(),
            artifact_id: None,
            revision_id: None,
            provenance: None,
        };
        let json = serde_json::to_string(&ba).unwrap();
        assert!(!json.contains("artifact_id"));
        assert!(!json.contains("revision_id"));
        assert!(!json.contains("provenance"));
    }

    #[test]
    fn serde_shorthand_op_ts_compatibility() {
        let ts_json = r#"{
            "kind": "verify",
            "level": "typecheck",
            "refs": ["h:abc", "h:def"]
        }"#;
        let deser: ShorthandOp = serde_json::from_str(ts_json).unwrap();
        match deser {
            ShorthandOp::Verify { level, refs } => {
                assert_eq!(level, VerificationLevel::Typecheck);
                assert_eq!(refs.len(), 2);
            }
            _ => panic!("expected Verify variant"),
        }

        let ts_json2 = r#"{
            "kind": "extract",
            "from_ref": "h:big",
            "into_path": "src/helpers.ts",
            "symbol_names": ["parseConfig"]
        }"#;
        let deser2: ShorthandOp = serde_json::from_str(ts_json2).unwrap();
        match deser2 {
            ShorthandOp::Extract { from_ref, into_path, symbol_names } => {
                assert_eq!(from_ref, "h:big");
                assert_eq!(into_path, "src/helpers.ts");
                assert_eq!(symbol_names.unwrap(), vec!["parseConfig"]);
            }
            _ => panic!("expected Extract variant"),
        }
    }
}
