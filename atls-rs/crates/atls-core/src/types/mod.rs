pub mod pattern;
pub mod issue;
pub mod symbol;
pub mod fix;
pub mod file;
pub mod uhpp;

pub use file::{FileInfo, FileRelationType, Language};
pub use issue::{Issue, IssueSeverity, ParsedIssue};
pub use pattern::{Pattern, PatternCategory, PatternSeverity, StructuralHints};
pub use symbol::{
    ParsedSymbol, Symbol, SymbolKind, SymbolMetadata, SymbolRelationType, SymbolVisibility,
};
pub use uhpp::{
    // Phase 1: Canonical units
    UhppArtifact, UhppSlice, UhppSymbolUnit, UhppNeighborhood,
    UhppEditTarget, UhppChangeSet, UhppVerificationResult,
    UhppProvenance, UhppDiagnostic, UhppSpan, UhppSelector,
    VerificationStatus, VerificationLevel, EditOperation, EditTargetKind,
    // Phase 2: Dual-form representation
    HydrationMode, HashClass, HydrationResult, HydrationCost,
    HashIdentity, NormalizationLevel, DigestSymbol,
    generate_digest, generate_edit_ready_digest,
    // Phase 3: Intent binding
    BindingConfidence, AmbiguityStatus, OperationFamily,
    CandidateTarget, BindingResult, OperationProfile,
    // Phase 4: Intent-driven edits
    TransformStep, TransformAction, TransformCondition, TransformConditionKind,
    TransformPlan, EditIntent, EditIntentParams, EditIntentResult, EditIntentStatus,
    InsertPosition, InterfaceChange, InterfaceChangeKind,
    // Phase 5: Reconciliation and verification
    FailureCategory, FailureRisk, VerificationCheckResult,
    RefreshEntry, RefRefreshResult,
    ImportStatus, ImportReconciliation, ExportReconciliation, ReconciliationResult,
    VerificationPipelineConfig, VerificationPipelineResult,
    // Phase 6: Shorthand maturation
    ShorthandOpKind, ShorthandOp, ShorthandError, ShorthandParseResult,
    BatchStepDescriptor, ShorthandCompileResult,
    HashAlgorithm, HashStratification, BlackboardArtifact,
};
