// TODO: UHPP Phase 3 — not wired to runtime chat path. Only imported by uhppTypes.ts barrel + tests.
/**
 * UHPP Phase 3: Intent Binding Pipeline
 *
 * Converts raw step inputs (operation + params) into a structured BindingResult
 * that captures: resolved targets, confidence, ambiguity, required hydration,
 * and required verification.
 *
 * Designed to sit between step parsing and handler dispatch in the executor,
 * and to wrap the existing freshness preflight as a binding data source.
 */

import type {
  BindingConfidence,
  AmbiguityStatus,
  OperationFamily,
  CandidateTarget,
  BindingResult,
  OperationProfile,
  HydrationMode,
  EditTargetKind,
  VerificationLevel,
  UhppProvenance,
} from './uhppCanonical';

import type { OperationKind } from '../services/batch/types';

// ---------------------------------------------------------------------------
// Operation profiles — static registry of per-operation metadata
// ---------------------------------------------------------------------------

const DEFAULT_TARGET_KINDS: EditTargetKind[] = ['file', 'exact_span', 'symbol', 'slice'];

const PROFILES: ReadonlyMap<string, OperationProfile> = new Map<string, OperationProfile>([
  // discover
  ['search.code',      { family: 'discover',   requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['search.symbol',    { family: 'discover',   requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['search.usage',     { family: 'discover',   requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['search.similar',   { family: 'discover',   requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['search.issues',    { family: 'discover',   requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['search.patterns',  { family: 'discover',   requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],

  // understand
  ['read.context',     { family: 'understand', requires_target: true,  min_hydration: 'digest',             default_verification: [],               eligible_target_kinds: ['file', 'slice'] }],
  ['read.shaped',      { family: 'understand', requires_target: true,  min_hydration: 'digest',             default_verification: [],               eligible_target_kinds: ['file', 'slice'] }],
  ['read.lines',       { family: 'understand', requires_target: true,  min_hydration: 'exact_span',         default_verification: [],               eligible_target_kinds: ['file', 'exact_span'] }],
  ['read.file',        { family: 'understand', requires_target: true,  min_hydration: 'full',               default_verification: [],               eligible_target_kinds: ['file'] }],
  ['analyze.deps',     { family: 'understand', requires_target: true,  min_hydration: 'digest',             default_verification: [],               eligible_target_kinds: ['file'] }],
  ['analyze.calls',    { family: 'understand', requires_target: true,  min_hydration: 'digest',             default_verification: [],               eligible_target_kinds: ['symbol'] }],
  ['analyze.structure', { family: 'understand', requires_target: true, min_hydration: 'digest',             default_verification: [],               eligible_target_kinds: ['file'] }],
  ['analyze.impact',   { family: 'understand', requires_target: true,  min_hydration: 'digest',             default_verification: [],               eligible_target_kinds: DEFAULT_TARGET_KINDS }],
  ['analyze.blast_radius', { family: 'understand', requires_target: true, min_hydration: 'digest',          default_verification: [],               eligible_target_kinds: DEFAULT_TARGET_KINDS }],
  ['analyze.extract_plan', { family: 'understand', requires_target: true, min_hydration: 'edit_ready_digest', default_verification: [],             eligible_target_kinds: ['file', 'symbol', 'slice'] }],

  // mutate
  ['change.edit',      { family: 'mutate',    requires_target: true,  min_hydration: 'edit_ready_digest',  default_verification: ['freshness'],     eligible_target_kinds: DEFAULT_TARGET_KINDS }],
  ['change.create',    { family: 'mutate',    requires_target: false, min_hydration: 'id_only',            default_verification: ['freshness'],     eligible_target_kinds: [] }],
  ['change.delete',    { family: 'mutate',    requires_target: true,  min_hydration: 'id_only',            default_verification: ['freshness'],     eligible_target_kinds: ['file'] }],
  ['change.refactor',  { family: 'mutate',    requires_target: true,  min_hydration: 'edit_ready_digest',  default_verification: ['freshness', 'structural', 'typecheck'], eligible_target_kinds: DEFAULT_TARGET_KINDS }],
  ['change.rollback',  { family: 'mutate',    requires_target: true,  min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: ['file'] }],

  // verify
  ['verify.build',     { family: 'verify',    requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['verify.test',      { family: 'verify',    requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['verify.lint',      { family: 'verify',    requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['verify.typecheck', { family: 'verify',    requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],

  // session (representative subset — session ops generally don't need binding)
  ['session.plan',     { family: 'session',   requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['session.recall',   { family: 'session',   requires_target: false, min_hydration: 'digest',             default_verification: [],               eligible_target_kinds: [] }],

  // delegate
  ['delegate.retrieve', { family: 'delegate', requires_target: false, min_hydration: 'digest',             default_verification: [],               eligible_target_kinds: [] }],
  ['delegate.design',   { family: 'delegate', requires_target: false, min_hydration: 'digest',             default_verification: [],               eligible_target_kinds: [] }],

  // system
  ['system.exec',      { family: 'system',    requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['system.git',       { family: 'system',    requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['system.help',      { family: 'system',    requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
  ['system.workspaces', { family: 'system',   requires_target: false, min_hydration: 'id_only',            default_verification: [],               eligible_target_kinds: [] }],
]);

/**
 * Get the operation profile for a known OperationKind.
 * Falls back to a minimal discover profile for unknown ops.
 */
export function getOperationProfile(op: string): OperationProfile {
  return PROFILES.get(op) ?? {
    family: 'discover' as OperationFamily,
    requires_target: false,
    min_hydration: 'id_only' as HydrationMode,
    default_verification: [],
    eligible_target_kinds: [],
  };
}

// ---------------------------------------------------------------------------
// Operation classification
// ---------------------------------------------------------------------------

/**
 * Classify an OperationKind into its semantic family.
 * Operates on the dotted name prefix when no profile is registered.
 */
export function classifyOperation(op: string): OperationFamily {
  const profile = PROFILES.get(op);
  if (profile) return profile.family;

  const prefix = op.split('.')[0];
  const FAMILY_MAP: Record<string, OperationFamily> = {
    search: 'discover',
    read: 'understand',
    analyze: 'understand',
    change: 'mutate',
    verify: 'verify',
    session: 'session',
    annotate: 'annotate',
    delegate: 'delegate',
    system: 'system',
  };
  return FAMILY_MAP[prefix ?? ''] ?? 'system';
}

// ---------------------------------------------------------------------------
// Target extraction helpers
// ---------------------------------------------------------------------------

/** Extract raw target references from step params. */
export function extractTargetRefs(params: Record<string, unknown>): string[] {
  const targets: string[] = [];

  const addStr = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0) targets.push(v);
  };

  addStr(params.file);
  addStr(params.file_path);
  addStr(params.target);
  addStr(params.target_ref);

  if (Array.isArray(params.file_paths)) params.file_paths.forEach(addStr);
  if (Array.isArray(params.targets)) params.targets.forEach(addStr);
  if (Array.isArray(params.target_refs)) params.target_refs.forEach(addStr);
  if (Array.isArray(params.hashes)) params.hashes.forEach(addStr);

  if (Array.isArray(params.edits)) {
    for (const edit of params.edits) {
      if (edit && typeof edit === 'object') {
        const e = edit as Record<string, unknown>;
        addStr(e.file);
        addStr(e.file_path);
      }
    }
  }

  if (Array.isArray(params.creates)) {
    for (const c of params.creates) {
      if (c && typeof c === 'object') {
        addStr((c as Record<string, unknown>).file);
      }
    }
  }

  return [...new Set(targets)];
}

/**
 * Determine EditTargetKind from a raw ref string.
 * `h:` refs are hash-addressed, literal paths are file targets.
 */
export function inferTargetKind(ref: string): EditTargetKind {
  if (ref.startsWith('h:')) return 'symbol';
  if (ref.includes(':') && /\d/.test(ref)) return 'exact_span';
  return 'file';
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

/** Numeric confidence thresholds. */
const CONFIDENCE_THRESHOLDS = { high: 0.8, medium: 0.5, low: 0.2 } as const;

/** Convert a numeric score [0,1] to a BindingConfidence level. */
export function scoreToConfidence(score: number): BindingConfidence {
  if (score >= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (score >= CONFIDENCE_THRESHOLDS.medium) return 'medium';
  if (score >= CONFIDENCE_THRESHOLDS.low) return 'low';
  return 'none';
}

/** Aggregate multiple confidence levels into a single result (min). */
export function aggregateConfidence(levels: BindingConfidence[]): BindingConfidence {
  if (levels.length === 0) return 'high';
  const order: BindingConfidence[] = ['none', 'low', 'medium', 'high'];
  let lowest = order.indexOf('high');
  for (const l of levels) {
    const idx = order.indexOf(l);
    if (idx < lowest) lowest = idx;
  }
  return order[lowest]!;
}

// ---------------------------------------------------------------------------
// Ambiguity detection
// ---------------------------------------------------------------------------

/** Determine ambiguity from resolved candidates. */
export function detectAmbiguity(candidates: CandidateTarget[]): AmbiguityStatus {
  if (candidates.length === 0) return 'unresolved';
  if (candidates.length === 1) return 'unambiguous';

  const highConf = candidates.filter(c => c.confidence === 'high');
  if (highConf.length === 1) return 'unambiguous';
  if (highConf.length > 1) return 'multiple_candidates';

  return 'partial';
}

// ---------------------------------------------------------------------------
// Candidate ranking
// ---------------------------------------------------------------------------

/** Sort candidates by confidence_score descending. */
export function rankCandidates(candidates: CandidateTarget[]): CandidateTarget[] {
  return [...candidates].sort((a, b) => b.confidence_score - a.confidence_score);
}

// ---------------------------------------------------------------------------
// Binding from freshness preflight
// ---------------------------------------------------------------------------

export interface PreflightBindingInput {
  confidence: 'high' | 'medium' | 'low' | 'none';
  strategy: string;
  blocked: boolean;
  warnings: string[];
  decisions: Array<{
    ref: string;
    source?: string;
    classification: 'fresh' | 'rebaseable' | 'suspect';
    confidence: 'high' | 'medium' | 'low' | 'none';
    factors: string[];
  }>;
}

/**
 * Convert an existing PreflightResult into CandidateTargets.
 * Maps the freshness classification + confidence into the binding model.
 */
export function candidatesFromPreflight(
  preflight: PreflightBindingInput,
  targetRefs: string[],
): CandidateTarget[] {
  if (preflight.decisions.length === 0) {
    return targetRefs.map(ref => ({
      ref,
      target_kind: inferTargetKind(ref),
      confidence: preflight.confidence as BindingConfidence,
      confidence_score: confidenceToScore(preflight.confidence),
      match_reason: preflight.blocked ? 'blocked_by_preflight' : `preflight_${preflight.strategy}`,
    }));
  }

  return preflight.decisions.map(d => ({
    ref: d.ref,
    source_path: d.source,
    target_kind: inferTargetKind(d.ref),
    confidence: d.confidence as BindingConfidence,
    confidence_score: confidenceToScore(d.confidence),
    match_reason: `${d.classification}:${d.factors.join(',')}`,
  }));
}

function confidenceToScore(level: string): number {
  switch (level) {
    case 'high': return 0.95;
    case 'medium': return 0.65;
    case 'low': return 0.3;
    default: return 0.0;
  }
}

// ---------------------------------------------------------------------------
// Full binding pipeline
// ---------------------------------------------------------------------------

export interface BindingPipelineInput {
  step_id: string;
  operation: OperationKind;
  params: Record<string, unknown>;
  preflight?: PreflightBindingInput | null;
  provenance?: UhppProvenance;
}

/**
 * Produce a BindingResult for a batch step.
 *
 * This is the main entry point for Phase 3 intent binding. It:
 * 1. Classifies the operation
 * 2. Extracts target refs from params
 * 3. Resolves candidates (from preflight if available, or raw refs)
 * 4. Ranks candidates
 * 5. Detects ambiguity
 * 6. Produces the structured result
 */
export function produceBindingResult(input: BindingPipelineInput): BindingResult {
  const profile = getOperationProfile(input.operation);
  const family = profile.family;

  const targetRefs = extractTargetRefs(input.params);

  let candidates: CandidateTarget[];
  if (input.preflight) {
    candidates = candidatesFromPreflight(input.preflight, targetRefs);
  } else {
    candidates = targetRefs.map(ref => ({
      ref,
      target_kind: inferTargetKind(ref),
      confidence: 'high' as BindingConfidence,
      confidence_score: 1.0,
      match_reason: 'literal_ref',
    }));
  }

  const ranked = rankCandidates(candidates);
  const ambiguity = detectAmbiguity(ranked);
  const targetConfidences = ranked.map(c => c.confidence);
  const overallConfidence = aggregateConfidence(targetConfidences);

  const warnings: string[] = [];
  if (input.preflight?.warnings) warnings.push(...input.preflight.warnings);
  if (input.preflight?.blocked) warnings.push('preflight_blocked');

  if (profile.requires_target && ranked.length === 0) {
    warnings.push('no_targets_resolved');
  }

  if (ambiguity === 'multiple_candidates') {
    warnings.push(`ambiguous: ${ranked.length} candidates`);
  }

  for (const c of ranked) {
    if (profile.eligible_target_kinds.length > 0 && !profile.eligible_target_kinds.includes(c.target_kind)) {
      warnings.push(`target_kind_mismatch: ${c.ref} is ${c.target_kind}, expected one of [${profile.eligible_target_kinds.join(',')}]`);
    }
  }

  return {
    step_id: input.step_id,
    requested_operation: input.operation,
    operation_family: family,
    resolved_targets: ranked,
    confidence: overallConfidence,
    ambiguity_status: ambiguity,
    required_hydration: profile.min_hydration,
    required_verification: profile.default_verification,
    warnings,
    provenance: input.provenance,
  };
}

/**
 * Quick check: does this operation benefit from the full binding pipeline?
 * Simple reads with literal paths and no h: refs can bypass binding.
 */
export function needsBinding(op: string, params: Record<string, unknown>): boolean {
  const profile = getOperationProfile(op);
  if (!profile.requires_target) return false;

  const targets = extractTargetRefs(params);
  if (targets.length === 0) return false;

  const hasHashRefs = targets.some(t => t.startsWith('h:'));
  if (hasHashRefs) return true;

  if (profile.family === 'mutate') return true;

  return false;
}
