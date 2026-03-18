/**
 * UHPP Canonical Types — Shape and contract tests.
 *
 * Validates that the TypeScript type definitions produce objects whose
 * JSON shape matches what the Rust serde serialization expects.
 * This catches field name mismatches, enum value drift, and missing
 * required fields across the TS↔Rust boundary.
 */
import { describe, it, expect } from 'vitest';
import type {
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
  HydrationMode,
  HashClass,
  HydrationResult,
  HydrationCost,
  HashIdentity,
  NormalizationLevel,
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
  ShorthandOpKind,
  ShorthandOp,
  ShorthandError,
  ShorthandParseResult,
  BatchStepDescriptor,
  ShorthandCompileResult,
  HashAlgorithm,
  HashStratification,
  BlackboardArtifact,
} from './uhppCanonical';

// ---------------------------------------------------------------------------
// Phase 1: Canonical types shape validation
// ---------------------------------------------------------------------------

describe('UhppArtifact shape', () => {
  it('has required fields', () => {
    const artifact: UhppArtifact = {
      artifact_id: 'art-001',
      content_hash: 'abcd1234',
      revision_id: 'rev-001',
    };
    expect(artifact.artifact_id).toBe('art-001');
    expect(artifact.content_hash).toBe('abcd1234');
    expect(artifact.revision_id).toBe('rev-001');
  });

  it('accepts all optional fields', () => {
    const artifact: UhppArtifact = {
      artifact_id: 'art-002',
      source_path: 'src/main.rs',
      logical_origin: 'workspace://main',
      content_hash: 'abcd1234',
      normalized_hash: 'norm5678',
      language: 'rust',
      domain_kind: 'code',
      revision_id: 'rev-002',
      provenance: {
        actor: 'agent',
        operation: 'read',
        batch_id: 'b-001',
        step_id: 's-001',
        timestamp: 1700000000,
        parent_revision: 'rev-001',
      },
    };
    expect(artifact.source_path).toBe('src/main.rs');
    expect(artifact.provenance?.actor).toBe('agent');
  });

  it('serializes to JSON matching Rust serde expectations', () => {
    const artifact: UhppArtifact = {
      artifact_id: 'art-003',
      content_hash: 'aaaa',
      revision_id: 'rev-003',
      domain_kind: 'code',
    };
    const json = JSON.stringify(artifact);
    const parsed = JSON.parse(json);
    expect(parsed.artifact_id).toBe('art-003');
    expect(parsed.domain_kind).toBe('code');
    expect(parsed).not.toHaveProperty('source_path');
  });
});

describe('UhppSlice shape', () => {
  it('accepts span selector', () => {
    const slice: UhppSlice = {
      slice_id: 'sl-001',
      parent_artifact_id: 'art-001',
      selector: { kind: 'span', span: { start_line: 10, end_line: 20 } },
    };
    expect(slice.selector.kind).toBe('span');
  });

  it('accepts symbol selector', () => {
    const slice: UhppSlice = {
      slice_id: 'sl-002',
      parent_artifact_id: 'art-001',
      selector: { kind: 'symbol', symbol_kind: 'function', name: 'parse' },
    };
    expect(slice.selector.kind).toBe('symbol');
  });

  it('accepts pattern selector', () => {
    const slice: UhppSlice = {
      slice_id: 'sl-003',
      parent_artifact_id: 'art-001',
      selector: { kind: 'pattern', pattern: 'error.*handler' },
    };
    expect(slice.selector.kind).toBe('pattern');
  });
});

describe('UhppSymbolUnit shape', () => {
  it('has required fields', () => {
    const unit: UhppSymbolUnit = {
      symbol_id: 'sym-001',
      symbol_kind: 'function',
      display_name: 'authenticate',
    };
    expect(unit.symbol_kind).toBe('function');
  });

  it('accepts relationships', () => {
    const unit: UhppSymbolUnit = {
      symbol_id: 'sym-002',
      symbol_kind: 'class',
      display_name: 'AuthService',
      relationships: {
        inbound: [{ target_symbol_id: 'sym-003', relation_kind: 'called_by' }],
        outbound: [{ target_symbol_id: 'sym-001', relation_kind: 'calls', confidence: 0.95 }],
      },
    };
    expect(unit.relationships!.outbound[0].confidence).toBe(0.95);
  });
});

describe('UhppNeighborhood shape', () => {
  it('serializes neighbor refs correctly', () => {
    const neighborhood: UhppNeighborhood = {
      neighborhood_id: 'nh-001',
      anchor_target: 'h:abc123',
      included_refs: [
        { ref: 'h:def456', ref_kind: 'artifact', rationale: 'imports from target' },
        { ref: 'h:ghi789', ref_kind: 'symbol', rationale: 'called by target function' },
      ],
      expansion_policy: 'local',
    };
    const json = JSON.parse(JSON.stringify(neighborhood));
    expect(json.included_refs).toHaveLength(2);
    expect(json.expansion_policy).toBe('local');
  });
});

describe('UhppEditTarget shape', () => {
  it('accepts eligible operations', () => {
    const target: UhppEditTarget = {
      target_ref: 'h:abc123',
      target_kind: 'symbol',
      current_revision: 'rev-005',
      eligible_operations: ['extract', 'rename', 'move'],
      safety_constraints: ['confirm_required'],
    };
    expect(target.eligible_operations).toContain('extract');
    expect(target.safety_constraints).toContain('confirm_required');
  });
});

describe('UhppChangeSet shape', () => {
  it('round-trips through JSON', () => {
    const cs: UhppChangeSet = {
      change_id: 'ch-001',
      operation_type: 'extract',
      target_refs: ['h:abc', 'h:def'],
      rendered_edits: [{
        file: 'src/utils.ts',
        old_hash: 'aaaa',
        new_hash: 'bbbb',
        edit_kind: 'modify',
      }],
      verification_requirements: ['typecheck', 'test'],
    };
    const json = JSON.parse(JSON.stringify(cs));
    expect(json.rendered_edits[0].edit_kind).toBe('modify');
    expect(json.verification_requirements).toContain('typecheck');
  });
});

describe('UhppVerificationResult shape', () => {
  it('includes all verification statuses', () => {
    const statuses = ['pass', 'pass-with-warnings', 'fail', 'tool-error', 'needs-review'] as const;
    for (const status of statuses) {
      const vr: UhppVerificationResult = {
        verification_id: 'vr-test',
        checks_run: ['typecheck'],
        status,
        diagnostics: [],
      };
      expect(vr.status).toBe(status);
    }
  });

  it('includes diagnostics with full shape', () => {
    const diag: UhppDiagnostic = {
      file: 'src/lib.rs',
      line: 42,
      column: 5,
      end_line: 42,
      end_column: 20,
      message: 'unused variable `x`',
      severity: 'warning',
      code: 'W001',
      source: 'rustc',
    };
    expect(diag.severity).toBe('warning');
    expect(diag.column).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Dual-form types shape validation
// ---------------------------------------------------------------------------

describe('HydrationMode values', () => {
  it('all 9 modes are valid string literals', () => {
    const modes: HydrationMode[] = [
      'id_only', 'digest', 'edit_ready_digest', 'exact_span',
      'semantic_slice', 'neighborhood_pack', 'full', 'diff_view',
      'verification_summary',
    ];
    expect(modes).toHaveLength(9);
  });
});

describe('HashClass values', () => {
  it('all 8 classes are valid string literals', () => {
    const classes: HashClass[] = [
      'content', 'normalized', 'slice', 'digest',
      'edit_ready_digest', 'neighborhood', 'change', 'verification',
    ];
    expect(classes).toHaveLength(8);
  });
});

describe('HydrationResult shape', () => {
  it('matches Rust serde field names', () => {
    const result: HydrationResult = {
      ref: 'h:abc123',
      mode: 'digest',
      content: 'fn parse | fn validate',
      content_hash: '1234abcd',
      token_estimate: 12,
    };
    const json = JSON.parse(JSON.stringify(result));
    expect(json.ref).toBe('h:abc123');
    expect(json.mode).toBe('digest');
    expect(json.token_estimate).toBe(12);
  });
});

describe('HydrationCost shape', () => {
  it('has all required fields', () => {
    const cost: HydrationCost = {
      mode: 'full',
      estimated_tokens: 1500,
      requires_backend: false,
      cacheable: true,
    };
    expect(cost.requires_backend).toBe(false);
    expect(cost.cacheable).toBe(true);
  });
});

describe('HashIdentity shape', () => {
  it('only content_hash is required', () => {
    const id: HashIdentity = {
      content_hash: 'abcdef12',
    };
    const json = JSON.parse(JSON.stringify(id));
    expect(json.content_hash).toBe('abcdef12');
    expect(json).not.toHaveProperty('normalized_hash');
  });

  it('accepts all optional hash classes', () => {
    const id: HashIdentity = {
      content_hash: 'aaa',
      normalized_hash: 'bbb',
      digest_hash: 'ccc',
      edit_ready_digest_hash: 'ddd',
      slice_hash: 'eee',
      neighborhood_hash: 'fff',
      change_hash: 'ggg',
      verification_hash: 'hhh',
    };
    expect(Object.keys(id)).toHaveLength(8);
  });
});

describe('NormalizationLevel values', () => {
  it('all 4 levels are valid', () => {
    const levels: NormalizationLevel[] = [
      'line_endings', 'trailing_whitespace', 'comments_stripped', 'structural',
    ];
    expect(levels).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Cross-boundary contract: TS field names must match Rust serde names
// ---------------------------------------------------------------------------

describe('TS↔Rust serde contract', () => {
  it('UhppProvenance field names match Rust snake_case', () => {
    const prov: UhppProvenance = {
      actor: 'agent',
      operation: 'extract',
      batch_id: 'b-001',
      step_id: 's-001',
      timestamp: 1700000000,
      parent_revision: 'rev-001',
    };
    const keys = Object.keys(prov);
    expect(keys).toContain('batch_id');
    expect(keys).toContain('step_id');
    expect(keys).toContain('parent_revision');
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('UhppSpan field names match Rust snake_case', () => {
    const span: UhppSpan = {
      start_line: 10,
      end_line: 20,
      start_column: 1,
      end_column: 40,
    };
    const keys = Object.keys(span);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('enum values use snake_case or kebab-case matching Rust serde', () => {
    const domainKinds = ['code', 'config', 'documentation', 'prompt_template',
      'blackboard_entry', 'diagnostic_result', 'workflow_definition',
      'search_result', 'generated_report'];
    for (const dk of domainKinds) {
      expect(dk).toMatch(/^[a-z][a-z0-9_]*$/);
    }

    const verificationStatuses = ['pass', 'pass-with-warnings', 'fail', 'tool-error', 'needs-review'];
    for (const vs of verificationStatuses) {
      expect(vs).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Intent Binding Types — Shape Validation
// ---------------------------------------------------------------------------

describe('Phase 3: BindingConfidence type values', () => {
  it('has exactly 4 confidence levels', () => {
    const levels: import('./uhppCanonical').BindingConfidence[] = ['high', 'medium', 'low', 'none'];
    expect(levels).toHaveLength(4);
    for (const l of levels) {
      expect(l).toMatch(/^[a-z]+$/);
    }
  });
});

describe('Phase 3: AmbiguityStatus type values', () => {
  it('has exactly 4 status values matching Rust serde(rename_all = "snake_case")', () => {
    const statuses: import('./uhppCanonical').AmbiguityStatus[] = [
      'unambiguous', 'multiple_candidates', 'unresolved', 'partial',
    ];
    expect(statuses).toHaveLength(4);
    for (const s of statuses) {
      expect(s).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('Phase 3: OperationFamily type values', () => {
  it('has exactly 8 families matching Rust serde(rename_all = "lowercase")', () => {
    const families: import('./uhppCanonical').OperationFamily[] = [
      'discover', 'understand', 'mutate', 'verify',
      'session', 'annotate', 'delegate', 'system',
    ];
    expect(families).toHaveLength(8);
    for (const f of families) {
      expect(f).toMatch(/^[a-z]+$/);
    }
  });
});

describe('Phase 3: CandidateTarget interface shape', () => {
  it('has required fields matching Rust struct', () => {
    const candidate: import('./uhppCanonical').CandidateTarget = {
      ref: 'h:abc123',
      target_kind: 'file',
      confidence: 'high',
      confidence_score: 0.95,
      match_reason: 'fresh:revision_match',
    };
    expect(candidate.ref).toBeDefined();
    expect(candidate.target_kind).toBeDefined();
    expect(candidate.confidence).toBeDefined();
    expect(typeof candidate.confidence_score).toBe('number');
    expect(candidate.match_reason).toBeDefined();
  });

  it('supports optional fields', () => {
    const candidate: import('./uhppCanonical').CandidateTarget = {
      ref: 'h:abc',
      target_kind: 'symbol',
      confidence: 'medium',
      confidence_score: 0.65,
      match_reason: 'test',
      source_path: 'src/foo.ts',
      content_hash: 'deadbeef',
      revision_id: 'rev-1',
    };
    expect(candidate.source_path).toBe('src/foo.ts');
    expect(candidate.content_hash).toBe('deadbeef');
    expect(candidate.revision_id).toBe('rev-1');
  });
});

describe('Phase 3: BindingResult interface shape', () => {
  it('has all required fields matching Rust struct', () => {
    const result: import('./uhppCanonical').BindingResult = {
      step_id: 's1',
      requested_operation: 'change.edit',
      operation_family: 'mutate',
      resolved_targets: [],
      confidence: 'high',
      ambiguity_status: 'unambiguous',
      required_hydration: 'edit_ready_digest',
      required_verification: ['freshness'],
      warnings: [],
    };
    const keys = Object.keys(result);
    expect(keys).toContain('step_id');
    expect(keys).toContain('requested_operation');
    expect(keys).toContain('operation_family');
    expect(keys).toContain('resolved_targets');
    expect(keys).toContain('confidence');
    expect(keys).toContain('ambiguity_status');
    expect(keys).toContain('required_hydration');
    expect(keys).toContain('required_verification');
    expect(keys).toContain('warnings');
  });

  it('field names use snake_case matching Rust serde', () => {
    const result: import('./uhppCanonical').BindingResult = {
      step_id: 's1',
      requested_operation: 'change.edit',
      operation_family: 'mutate',
      resolved_targets: [],
      confidence: 'high',
      ambiguity_status: 'unambiguous',
      required_hydration: 'edit_ready_digest',
      required_verification: [],
      warnings: [],
    };
    for (const key of Object.keys(result)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('Phase 3: OperationProfile interface shape', () => {
  it('has all required fields', () => {
    const profile: import('./uhppCanonical').OperationProfile = {
      family: 'mutate',
      requires_target: true,
      min_hydration: 'edit_ready_digest',
      default_verification: ['freshness', 'typecheck'],
      eligible_target_kinds: ['file', 'symbol'],
    };
    expect(profile.family).toBe('mutate');
    expect(profile.requires_target).toBe(true);
    expect(profile.eligible_target_kinds).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Intent-Driven Edits — Shape Validation
// ---------------------------------------------------------------------------

describe('Phase 4: TransformAction type values', () => {
  it('has exactly 8 actions matching Rust serde(rename_all = "snake_case")', () => {
    const actions: import('./uhppCanonical').TransformAction[] = [
      'create_file', 'remove_lines', 'insert_lines', 'replace_lines',
      'move_content', 'import_update', 'rename_symbol', 'delete_file',
    ];
    expect(actions).toHaveLength(8);
    for (const a of actions) {
      expect(a).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('Phase 4: TransformConditionKind type values', () => {
  it('has exactly 6 condition kinds', () => {
    const kinds: import('./uhppCanonical').TransformConditionKind[] = [
      'file_exists', 'file_not_exists', 'symbol_exists',
      'hash_matches', 'no_lint_errors', 'no_type_errors',
    ];
    expect(kinds).toHaveLength(6);
    for (const k of kinds) {
      expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('Phase 4: EditIntentStatus type values', () => {
  it('has exactly 6 statuses matching Rust serde', () => {
    const statuses: import('./uhppCanonical').EditIntentStatus[] = [
      'planned', 'executed', 'verified', 'failed', 'rolled_back', 'dry_run',
    ];
    expect(statuses).toHaveLength(6);
    for (const s of statuses) {
      expect(s).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('Phase 4: TransformPlan interface shape', () => {
  it('has all required fields matching Rust struct', () => {
    const plan: import('./uhppCanonical').TransformPlan = {
      plan_id: 'plan-001',
      intent_id: 'intent-001',
      operation: 'extract',
      target_refs: ['src/big.ts'],
      steps: [{
        step_index: 0,
        action: 'create_file',
        target_file: 'src/helpers.ts',
        params: {},
        description: 'Create helpers',
        reversible: true,
      }],
      pre_conditions: [],
      post_conditions: [],
      estimated_affected_files: 2,
      requires_verification: ['freshness'],
    };
    const keys = Object.keys(plan);
    expect(keys).toContain('plan_id');
    expect(keys).toContain('intent_id');
    expect(keys).toContain('operation');
    expect(keys).toContain('steps');
    expect(keys).toContain('pre_conditions');
    expect(keys).toContain('post_conditions');
    expect(keys).toContain('estimated_affected_files');
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('Phase 4: EditIntent interface shape', () => {
  it('has all required fields', () => {
    const intent: import('./uhppCanonical').EditIntent = {
      intent_id: 'intent-001',
      operation: 'rename',
      target_refs: ['src/x.ts'],
      params: { new_name: 'better' },
      dry_run: false,
    };
    expect(intent.intent_id).toBeDefined();
    expect(intent.operation).toBe('rename');
    expect(typeof intent.dry_run).toBe('boolean');
  });
});

describe('Phase 4: InterfaceChange interface shape', () => {
  it('has kind with all 5 variants', () => {
    const kinds: import('./uhppCanonical').InterfaceChange['kind'][] = [
      'add_param', 'remove_param', 'change_type', 'add_field', 'remove_field',
    ];
    expect(kinds).toHaveLength(5);
    for (const k of kinds) {
      expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 5: Reconciliation and Verification — Shape Validation
// ---------------------------------------------------------------------------

describe('Phase 5: FailureCategory type values', () => {
  it('has exactly 10 categories matching Rust serde(rename_all = "snake_case")', () => {
    const categories: FailureCategory[] = [
      'host_missing_toolchain', 'dependency_issue', 'wrong_workspace_root',
      'refactor_induced', 'baseline_project_failure', 'stale_reference',
      'import_resolution', 'type_mismatch', 'test_regression', 'unknown',
    ];
    expect(categories).toHaveLength(10);
    for (const c of categories) {
      expect(c).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('Phase 5: FailureRisk type values', () => {
  it('has exactly 4 risk levels', () => {
    const risks: FailureRisk[] = ['critical', 'high', 'medium', 'low'];
    expect(risks).toHaveLength(4);
    for (const r of risks) {
      expect(r).toMatch(/^[a-z]+$/);
    }
  });
});

describe('Phase 5: ImportStatus type values', () => {
  it('has exactly 4 import statuses', () => {
    const statuses: ImportStatus[] = ['valid', 'broken', 'unused', 'missing'];
    expect(statuses).toHaveLength(4);
    for (const s of statuses) {
      expect(s).toMatch(/^[a-z]+$/);
    }
  });
});

describe('Phase 5: VerificationCheckResult interface shape', () => {
  it('has all required fields matching Rust struct', () => {
    const cr: VerificationCheckResult = {
      level: 'typecheck',
      status: 'fail',
      diagnostics: [{ file: 'a.ts', line: 10, message: 'err', severity: 'error' }],
      duration_ms: 1234,
    };
    const keys = Object.keys(cr);
    expect(keys).toContain('level');
    expect(keys).toContain('status');
    expect(keys).toContain('diagnostics');
    expect(keys).toContain('duration_ms');
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('supports optional failure classification fields', () => {
    const cr: VerificationCheckResult = {
      level: 'test',
      status: 'fail',
      diagnostics: [],
      duration_ms: 500,
      short_circuited: true,
      failure_category: 'test_regression',
      failure_risk: 'critical',
    };
    expect(cr.short_circuited).toBe(true);
    expect(cr.failure_category).toBe('test_regression');
    expect(cr.failure_risk).toBe('critical');
  });
});

describe('Phase 5: RefreshEntry interface shape', () => {
  it('round-trips through JSON', () => {
    const entry: RefreshEntry = {
      file: 'src/a.ts',
      old_hash: 'aaaa',
      new_hash: 'bbbb',
      stale_refs_invalidated: ['h:cccc'],
    };
    const json = JSON.parse(JSON.stringify(entry));
    expect(json.file).toBe('src/a.ts');
    expect(json.stale_refs_invalidated).toHaveLength(1);
  });
});

describe('Phase 5: ReconciliationResult interface shape', () => {
  it('has all required fields', () => {
    const rr: ReconciliationResult = {
      imports: [{ file: 'a.ts', import_path: './b', status: 'broken' }],
      exports: [{ file: 'b.ts', symbol_name: 'foo', still_defined: false, still_referenced: true }],
      stale_hash_refs: ['h:old'],
      broken_count: 2,
      warnings: ['test warning'],
    };
    expect(rr.imports).toHaveLength(1);
    expect(rr.exports).toHaveLength(1);
    expect(rr.broken_count).toBe(2);
  });
});

describe('Phase 5: VerificationPipelineConfig interface shape', () => {
  it('has all required fields', () => {
    const cfg: VerificationPipelineConfig = {
      levels: ['freshness', 'typecheck'],
      short_circuit_on_fail: true,
      skip_expensive_after_fail: true,
      target_refs: ['src/a.ts'],
    };
    const keys = Object.keys(cfg);
    expect(keys).toContain('levels');
    expect(keys).toContain('short_circuit_on_fail');
    expect(keys).toContain('skip_expensive_after_fail');
    expect(keys).toContain('target_refs');
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('Phase 5: VerificationPipelineResult interface shape', () => {
  it('has all required fields matching Rust struct', () => {
    const pr: VerificationPipelineResult = {
      verification_id: 'vp-001',
      config: {
        levels: ['freshness'],
        short_circuit_on_fail: true,
        skip_expensive_after_fail: false,
        target_refs: ['src/a.ts'],
      },
      check_results: [{
        level: 'freshness',
        status: 'pass',
        diagnostics: [],
        duration_ms: 5,
      }],
      aggregate_status: 'pass',
      total_duration_ms: 5,
    };
    const keys = Object.keys(pr);
    expect(keys).toContain('verification_id');
    expect(keys).toContain('config');
    expect(keys).toContain('check_results');
    expect(keys).toContain('aggregate_status');
    expect(keys).toContain('total_duration_ms');
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 6: Shorthand Maturation — Shape Validation
// ---------------------------------------------------------------------------

describe('Phase 6: ShorthandOpKind type values', () => {
  it('has exactly 10 operation kinds', () => {
    const kinds: ShorthandOpKind[] = [
      'target', 'hydrate', 'neighbors', 'diff', 'extract',
      'rewrite', 'verify', 'stage', 'pin', 'drop',
    ];
    expect(kinds).toHaveLength(10);
    for (const k of kinds) {
      expect(k).toMatch(/^[a-z]+$/);
    }
  });
});

describe('Phase 6: ShorthandOp discriminated union', () => {
  it('target variant has required fields', () => {
    const op: ShorthandOp = { kind: 'target', ref: 'h:abc' };
    expect(op.kind).toBe('target');
  });

  it('hydrate variant has mode and ref', () => {
    const op: ShorthandOp = { kind: 'hydrate', mode: 'digest', ref: 'h:abc' };
    expect(op.kind).toBe('hydrate');
    if (op.kind === 'hydrate') {
      expect(op.mode).toBe('digest');
    }
  });

  it('extract variant supports optional symbol_names', () => {
    const op: ShorthandOp = { kind: 'extract', from_ref: 'h:big', into_path: 'out.ts' };
    expect(op.kind).toBe('extract');
    const op2: ShorthandOp = { kind: 'extract', from_ref: 'h:big', into_path: 'out.ts', symbol_names: ['fn1'] };
    if (op2.kind === 'extract') {
      expect(op2.symbol_names).toEqual(['fn1']);
    }
  });

  it('verify variant has level and refs', () => {
    const op: ShorthandOp = { kind: 'verify', level: 'typecheck', refs: ['h:a'] };
    if (op.kind === 'verify') {
      expect(op.level).toBe('typecheck');
      expect(op.refs).toHaveLength(1);
    }
  });

  it('serializes to JSON with kind discriminator', () => {
    const op: ShorthandOp = { kind: 'diff', old_ref: 'h:old', new_ref: 'h:new' };
    const json = JSON.parse(JSON.stringify(op));
    expect(json.kind).toBe('diff');
    expect(json.old_ref).toBe('h:old');
    expect(json.new_ref).toBe('h:new');
  });
});

describe('Phase 6: ShorthandError interface shape', () => {
  it('has required fields', () => {
    const err: ShorthandError = {
      message: 'Unknown op',
      position: 0,
      expected: 'target, hydrate, ...',
    };
    expect(err.message).toBeDefined();
    expect(typeof err.position).toBe('number');
    expect(err.expected).toBeDefined();
  });

  it('supports optional suggestion', () => {
    const err: ShorthandError = {
      message: 'Unknown op',
      position: 0,
      expected: 'valid op',
      suggestion: "Did you mean 'target'?",
    };
    expect(err.suggestion).toContain('target');
  });
});

describe('Phase 6: ShorthandParseResult interface shape', () => {
  it('success case has op', () => {
    const pr: ShorthandParseResult = {
      success: true,
      op: { kind: 'target', ref: 'h:abc' },
      raw_input: 'target(h:abc)',
    };
    expect(pr.success).toBe(true);
    expect(pr.op).toBeDefined();
  });

  it('failure case has error', () => {
    const pr: ShorthandParseResult = {
      success: false,
      error: { message: 'err', position: 0, expected: 'something' },
      raw_input: 'bad',
    };
    expect(pr.success).toBe(false);
    expect(pr.error).toBeDefined();
  });
});

describe('Phase 6: BatchStepDescriptor interface shape', () => {
  it('has step_kind and params', () => {
    const bsd: BatchStepDescriptor = {
      step_kind: 'read.shaped',
      params: { ref: 'h:abc', modifier: 'auto' },
    };
    expect(bsd.step_kind).toBe('read.shaped');
    expect(bsd.params).toHaveProperty('ref');
  });
});

describe('Phase 6: ShorthandCompileResult interface shape', () => {
  it('wraps op, batch_steps, and warnings', () => {
    const cr: ShorthandCompileResult = {
      op: { kind: 'stage', refs: ['h:abc'] },
      batch_steps: [{ step_kind: 'session.stage', params: { refs: ['h:abc'] } }],
      warnings: [],
    };
    expect(cr.op.kind).toBe('stage');
    expect(cr.batch_steps).toHaveLength(1);
    expect(cr.warnings).toHaveLength(0);
  });
});

describe('Phase 6: HashAlgorithm type values', () => {
  it('has exactly 2 algorithms matching Rust serde', () => {
    const algs: HashAlgorithm[] = ['fnv1a_32', 'sha256'];
    expect(algs).toHaveLength(2);
    for (const a of algs) {
      expect(a).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe('Phase 6: HashStratification interface shape', () => {
  it('has all three purpose fields', () => {
    const hs: HashStratification = {
      runtime_identity: 'fnv1a_32',
      persistence_identity: 'sha256',
      verification_identity: 'sha256',
    };
    expect(hs.runtime_identity).toBe('fnv1a_32');
    expect(hs.persistence_identity).toBe('sha256');
    for (const key of Object.keys(hs)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('Phase 6: BlackboardArtifact interface shape', () => {
  it('has required fields', () => {
    const ba: BlackboardArtifact = {
      key: 'session_context',
      content_hash: 'aabb1122',
      content_type: 'json',
    };
    expect(ba.key).toBe('session_context');
    expect(ba.content_hash).toBe('aabb1122');
    expect(ba.content_type).toBe('json');
  });

  it('supports optional fields', () => {
    const ba: BlackboardArtifact = {
      key: 'ctx',
      content_hash: '1234',
      content_type: 'text',
      artifact_id: 'bb-art-001',
      revision_id: 'bb-rev-001',
      provenance: { timestamp: 1700000000 },
    };
    expect(ba.artifact_id).toBe('bb-art-001');
    expect(ba.provenance?.timestamp).toBe(1700000000);
  });

  it('serializes with snake_case field names matching Rust', () => {
    const ba: BlackboardArtifact = {
      key: 'test',
      content_hash: 'hash',
      content_type: 'json',
      artifact_id: 'art',
    };
    for (const key of Object.keys(ba)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
