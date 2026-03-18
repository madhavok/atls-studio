// Re-export canonical UHPP data model types for unified access
export type {
  // Phase 1: Canonical units
  UhppArtifact,
  UhppSlice,
  UhppSymbolUnit,
  UhppNeighborhood,
  UhppEditTarget,
  UhppChangeSet,
  UhppVerificationResult,
  UhppProvenance,
  UhppDiagnostic,
  UhppSpan,
  UhppSelector,
  UhppFileEdit,
  UhppNeighborRef,
  UhppSymbolRelation,
  UhppSymbolRelationships,
  StabilityMetadata,
  SliceShapeMetadata,
  VerificationStatus,
  VerificationLevel,
  EditOperation,
  EditTargetKind,
  ArtifactDomainKind,
  SafetyConstraint,
  ExpansionPolicy,
  DiagnosticSeverity,
  SymbolRelationKind,
  NeighborRefKind,
  FileEditKind,
  // Phase 2: Dual-form representation
  HydrationMode,
  HashClass,
  HydrationResult,
  HydrationCost,
  HashIdentity,
  NormalizationLevel,
  // Phase 3: Intent binding
  BindingConfidence,
  AmbiguityStatus,
  OperationFamily,
  CandidateTarget,
  BindingResult,
  OperationProfile,
  // Phase 4: Intent-driven edits
  TransformStep,
  TransformAction,
  TransformCondition,
  TransformConditionKind,
  TransformPlan,
  EditIntent,
  EditIntentParams,
  EditIntentResult,
  EditIntentStatus,
  InterfaceChange,
  // Phase 5: Reconciliation and verification
  FailureCategory,
  FailureRisk,
  VerificationCheckResult,
  RefreshEntry,
  RefRefreshResult,
  ImportStatus,
  ImportReconciliation,
  ExportReconciliation,
  ReconciliationResult,
  VerificationPipelineConfig,
  VerificationPipelineResult,
  // Phase 6: Shorthand maturation
  ShorthandOpKind,
  ShorthandTarget,
  ShorthandHydrate,
  ShorthandNeighbors,
  ShorthandDiff,
  ShorthandExtract,
  ShorthandRewrite,
  ShorthandVerify,
  ShorthandStage,
  ShorthandPin,
  ShorthandDrop,
  ShorthandOp,
  ShorthandError,
  ShorthandParseResult,
  BatchStepDescriptor,
  ShorthandCompileResult,
  HashAlgorithm,
  HashStratification,
  BlackboardArtifact,
} from './uhppCanonical';

// Re-export Phase 2 hydration API
export {
  hydrate,
  estimateHydrationCosts,
  cheapestSufficientMode,
  isFrontendResolvable,
} from './uhppHydration';
export type { HydrateOptions } from './uhppHydration';

// Re-export Phase 3 binding pipeline
export {
  getOperationProfile,
  classifyOperation,
  extractTargetRefs,
  inferTargetKind,
  scoreToConfidence,
  aggregateConfidence,
  detectAmbiguity,
  rankCandidates,
  candidatesFromPreflight,
  produceBindingResult,
  needsBinding,
} from './uhppBinding';
export type { PreflightBindingInput, BindingPipelineInput } from './uhppBinding';

// Re-export Phase 4 edit intent pipeline
export {
  generateIntentId,
  generatePlanId,
  getEditOperationMeta,
  createEditIntent,
  generatePreConditions,
  generatePostConditions,
  planTransform,
  renderOperations,
  validatePlan,
  dryRunResult,
} from './uhppEditIntent';
export type { EditOperationMeta, CreateIntentInput, ValidationResult } from './uhppEditIntent';

// Re-export Phase 5 reconciliation and verification pipeline
export {
  generateVerificationId,
  sortByVerificationCost,
  normalizeToolDiagnostic,
  normalizeDiagnostics,
  extractDiagnosticsFromResponse,
  classifyFailure,
  shouldShortCircuit,
  shouldNeedReview,
  computeAggregateStatus,
  generateMismatchSummary,
  reconcileRelationships,
  refreshRefs,
  createVerificationPipeline,
  assembleVerificationPipelineResult,
  toCanonicalVerificationResult,
} from './uhppReconciliation';
export type { RawToolDiagnostic, ReconciliationInput, RefreshInput } from './uhppReconciliation';

// Re-export Phase 6 shorthand parser, compiler, and helpers
export {
  parseShorthand,
  compileShorthand,
  parseAndCompile,
  isValidShorthand,
  getShorthandKind,
  generateShorthandReference,
  listShorthandOps,
  getHashAlgorithm,
  DEFAULT_HASH_STRATIFICATION,
} from './uhppShorthand';

export type ShapeOp =
  | 'sig' | 'fold' | 'dedent' | 'nocomment' | 'imports' | 'exports'
  | { head: number } | { tail: number }
  | { grep: string } | { exclude: [number, number | null][] }
  | { highlight: [number, number | null][] }
  | { concept: string } | { pattern: string } | { if: string };

export type HashModifierV2 =
  | 'auto' | 'source' | 'content' | 'tokens' | 'meta' | 'lang'
  | { lines: [number, number | null][] }
  | { shape: ShapeOp }
  | { lines: [number, number | null][]; shape: ShapeOp }
  | { symbol: { kind?: string; name: string; shape?: ShapeOp } };

export interface ParsedHashRef {
  hash: string;
  modifier: HashModifierV2;
}

export interface ParsedDiffRef {
  oldHash: string;
  newHash: string;
}

export type SetSelector =
  | { kind: 'subtask'; id: string }
  | { kind: 'file'; pattern: string }
  | { kind: 'type'; chunkType: string }
  | { kind: 'edited' }
  | { kind: 'latest'; count: number }
  | { kind: 'pinned' }
  | { kind: 'all' }
  | { kind: 'stale' }
  | { kind: 'dormant' }
  | { kind: 'head'; path: string; offset?: number }
  | { kind: 'tag'; name: string; path: string }
  | { kind: 'commit'; sha: string; path: string }
  | { kind: 'workspace'; name: string }
  | { kind: 'search'; query: string; limit?: number; tier?: 'high' | 'medium' };

export interface ParsedSetRef {
  selector: SetSelector;
  modifier: HashModifierV2;
}

export type ParsedSetExpression = ParsedSetRef | CompositeSetRef;

export interface ParsedBlackboardRef {
  key: string;
  modifier?: HashModifierV2;
}

export interface ParsedRecencyRef {
  value: '$last' | `$last-${number}`;
}

export type ParsedUhppRef =
  | { kind: 'hash'; value: ParsedHashRef }
  | { kind: 'diff'; value: ParsedDiffRef }
  | { kind: 'set'; value: ParsedSetExpression }
  | { kind: 'blackboard'; value: ParsedBlackboardRef }
  | { kind: 'recency'; value: ParsedRecencyRef };

export interface CompositeSetRef {
  left: SetSelector;
  op: '+' | '&' | '-';
  right: SetSelector;
  modifier: HashModifierV2;
}

export interface SetRefResult<TEntry = unknown> {
  hashes: string[];
  entries: TEntry[];
  error?: string;
}

export interface SetRefExpansion {
  ref: string;
  matchedCount: number;
  hashes: string[];
  sources: string[];
}
