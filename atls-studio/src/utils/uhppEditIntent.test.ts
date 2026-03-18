import { describe, it, expect } from 'vitest';
import {
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
import type {
  EditIntent,
  TransformPlan,
  BindingResult,
} from './uhppCanonical';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

describe('generateIntentId', () => {
  it('produces unique IDs', () => {
    const a = generateIntentId();
    const b = generateIntentId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^intent-/);
  });
});

describe('generatePlanId', () => {
  it('produces IDs with plan prefix', () => {
    expect(generatePlanId()).toMatch(/^plan-/);
  });
});

// ---------------------------------------------------------------------------
// getEditOperationMeta
// ---------------------------------------------------------------------------

describe('getEditOperationMeta', () => {
  it('returns meta for extract', () => {
    const meta = getEditOperationMeta('extract');
    expect(meta).toBeDefined();
    expect(meta!.required_params).toContain('destination_file');
    expect(meta!.required_params).toContain('symbol_names');
    expect(meta!.supports_dry_run).toBe(true);
  });

  it('returns meta for rename', () => {
    const meta = getEditOperationMeta('rename');
    expect(meta!.required_params).toContain('new_name');
    expect(meta!.required_verification).toContain('typecheck');
  });

  it('returns meta for all 11 operations', () => {
    const ops = [
      'extract', 'rename', 'move', 'split', 'merge', 'inline',
      'wrap', 'patch', 'adapt_interface', 'propagate_callsites', 'update_imports',
    ] as const;
    for (const op of ops) {
      expect(getEditOperationMeta(op)).toBeDefined();
    }
  });

  it('returns undefined for unknown operation', () => {
    expect(getEditOperationMeta('nonexistent' as any)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createEditIntent
// ---------------------------------------------------------------------------

describe('createEditIntent', () => {
  it('creates valid intent for extract', () => {
    const { intent, warnings } = createEditIntent({
      operation: 'extract',
      target_refs: ['src/big.ts'],
      params: {
        destination_file: 'src/helpers.ts',
        symbol_names: ['parseConfig', 'validateInput'],
      },
    });
    expect(intent.operation).toBe('extract');
    expect(intent.target_refs).toEqual(['src/big.ts']);
    expect(intent.intent_id).toMatch(/^intent-/);
    expect(intent.dry_run).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it('warns on missing required params', () => {
    const { warnings } = createEditIntent({
      operation: 'extract',
      target_refs: ['src/big.ts'],
      params: {},
    });
    expect(warnings.some(w => w.includes('destination_file'))).toBe(true);
    expect(warnings.some(w => w.includes('symbol_names'))).toBe(true);
  });

  it('warns on no target refs', () => {
    const { warnings } = createEditIntent({
      operation: 'patch',
      target_refs: [],
      params: { patch_content: 'fix' },
    });
    expect(warnings).toContain('no_target_refs');
  });

  it('respects dry_run flag', () => {
    const { intent } = createEditIntent({
      operation: 'rename',
      target_refs: ['src/x.ts'],
      params: { new_name: 'betterName' },
      dry_run: true,
    });
    expect(intent.dry_run).toBe(true);
  });

  it('warns on unknown operation', () => {
    const { warnings } = createEditIntent({
      operation: 'teleport' as any,
      target_refs: ['src/x.ts'],
      params: {},
    });
    expect(warnings.some(w => w.includes('unknown_operation'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generatePreConditions
// ---------------------------------------------------------------------------

describe('generatePreConditions', () => {
  const makeIntent = (op: string, refs: string[], params = {}): EditIntent => ({
    intent_id: 'test-intent',
    operation: op as any,
    target_refs: refs,
    params,
    dry_run: false,
  });

  it('adds file_exists for all target refs', () => {
    const conditions = generatePreConditions(makeIntent('patch', ['src/a.ts', 'src/b.ts']));
    const fileExists = conditions.filter(c => c.kind === 'file_exists');
    expect(fileExists).toHaveLength(2);
  });

  it('adds file_not_exists for extract destination', () => {
    const conditions = generatePreConditions(
      makeIntent('extract', ['src/big.ts'], { destination_file: 'src/new.ts' }),
    );
    expect(conditions.some(c => c.kind === 'file_not_exists' && c.target_ref === 'src/new.ts')).toBe(true);
  });

  it('adds symbol_exists for symbol-based operations', () => {
    const conditions = generatePreConditions(
      makeIntent('rename', ['src/x.ts'], { symbol_names: ['myFunc'] }),
    );
    expect(conditions.some(c => c.kind === 'symbol_exists' && c.target_ref === 'myFunc')).toBe(true);
  });

  it('adds hash_matches from binding result', () => {
    const binding: BindingResult = {
      step_id: 's1',
      requested_operation: 'change.edit',
      operation_family: 'mutate',
      resolved_targets: [{
        ref: 'src/x.ts',
        target_kind: 'file',
        confidence: 'high',
        confidence_score: 0.95,
        match_reason: 'fresh',
        content_hash: 'abc123',
      }],
      confidence: 'high',
      ambiguity_status: 'unambiguous',
      required_hydration: 'edit_ready_digest',
      required_verification: ['freshness'],
      warnings: [],
    };
    const conditions = generatePreConditions(
      makeIntent('patch', ['src/x.ts']),
      binding,
    );
    expect(conditions.some(c => c.kind === 'hash_matches')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generatePostConditions
// ---------------------------------------------------------------------------

describe('generatePostConditions', () => {
  it('adds file_exists for destination after extract', () => {
    const intent: EditIntent = {
      intent_id: 'test',
      operation: 'extract',
      target_refs: ['src/big.ts'],
      params: { destination_file: 'src/helpers.ts' },
      dry_run: false,
    };
    const meta = getEditOperationMeta('extract');
    const conditions = generatePostConditions(intent, meta);
    expect(conditions.some(c => c.kind === 'file_exists' && c.target_ref === 'src/helpers.ts')).toBe(true);
  });

  it('adds no_type_errors for typecheck-requiring ops', () => {
    const intent: EditIntent = {
      intent_id: 'test',
      operation: 'rename',
      target_refs: ['src/x.ts'],
      params: { new_name: 'better' },
      dry_run: false,
    };
    const meta = getEditOperationMeta('rename');
    const conditions = generatePostConditions(intent, meta);
    expect(conditions.some(c => c.kind === 'no_type_errors')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// planTransform
// ---------------------------------------------------------------------------

describe('planTransform', () => {
  it('creates a plan for extract', () => {
    const { intent } = createEditIntent({
      operation: 'extract',
      target_refs: ['src/god-object.ts'],
      params: {
        destination_file: 'src/helpers.ts',
        symbol_names: ['parseConfig'],
      },
    });
    const plan = planTransform(intent);
    expect(plan.plan_id).toMatch(/^plan-/);
    expect(plan.intent_id).toBe(intent.intent_id);
    expect(plan.operation).toBe('extract');
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(plan.steps.some(s => s.action === 'create_file')).toBe(true);
    expect(plan.steps.some(s => s.action === 'remove_lines')).toBe(true);
    expect(plan.steps.some(s => s.action === 'import_update')).toBe(true);
    expect(plan.pre_conditions.length).toBeGreaterThan(0);
    expect(plan.requires_verification).toContain('freshness');
  });

  it('creates a plan for rename', () => {
    const { intent } = createEditIntent({
      operation: 'rename',
      target_refs: ['src/utils.ts'],
      params: { new_name: 'betterName', symbol_names: ['oldName'] },
    });
    const plan = planTransform(intent);
    expect(plan.steps.some(s => s.action === 'rename_symbol')).toBe(true);
    expect(plan.requires_verification).toContain('typecheck');
  });

  it('creates a plan for wrap', () => {
    const { intent } = createEditIntent({
      operation: 'wrap',
      target_refs: ['src/component.tsx'],
      params: { wrapper_template: 'React.memo($$)' },
    });
    const plan = planTransform(intent);
    expect(plan.steps.some(s => s.action === 'replace_lines')).toBe(true);
  });

  it('creates plan for move with destination', () => {
    const { intent } = createEditIntent({
      operation: 'move',
      target_refs: ['src/old.ts'],
      params: { destination_file: 'src/new-home.ts' },
    });
    const plan = planTransform(intent);
    expect(plan.estimated_affected_files).toBe(2);
    expect(plan.steps.some(s => s.action === 'move_content')).toBe(true);
  });

  it('includes binding hash conditions', () => {
    const { intent } = createEditIntent({
      operation: 'patch',
      target_refs: ['src/x.ts'],
      params: { patch_content: 'fix' },
    });
    const binding: BindingResult = {
      step_id: 's1',
      requested_operation: 'change.edit',
      operation_family: 'mutate',
      resolved_targets: [{
        ref: 'src/x.ts',
        target_kind: 'file',
        confidence: 'high',
        confidence_score: 0.95,
        match_reason: 'fresh',
        content_hash: 'deadbeef',
      }],
      confidence: 'high',
      ambiguity_status: 'unambiguous',
      required_hydration: 'edit_ready_digest',
      required_verification: [],
      warnings: [],
    };
    const plan = planTransform(intent, binding);
    expect(plan.pre_conditions.some(c => c.kind === 'hash_matches')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderOperations
// ---------------------------------------------------------------------------

describe('renderOperations', () => {
  it('renders extract plan into backend operations', () => {
    const { intent } = createEditIntent({
      operation: 'extract',
      target_refs: ['src/big.ts'],
      params: {
        destination_file: 'src/helpers.ts',
        symbol_names: ['parseConfig'],
      },
    });
    const plan = planTransform(intent);
    const ops = renderOperations(plan);
    expect(ops.length).toBeGreaterThanOrEqual(2);
    expect(ops.some(o => o.create === true)).toBe(true);
    expect(ops.some(o => o.file === 'src/big.ts' && o.remove_lines)).toBe(true);
  });

  it('renders rename plan', () => {
    const { intent } = createEditIntent({
      operation: 'rename',
      target_refs: ['src/utils.ts'],
      params: { new_name: 'betterName', symbol_names: ['oldName'] },
    });
    const plan = planTransform(intent);
    const ops = renderOperations(plan);
    expect(ops.some(o => o.new_name === 'betterName')).toBe(true);
  });

  it('renders delete_file action', () => {
    const plan: TransformPlan = {
      plan_id: 'test',
      intent_id: 'test',
      operation: 'patch',
      target_refs: ['src/dead.ts'],
      steps: [{
        step_index: 0,
        action: 'delete_file',
        target_file: 'src/dead.ts',
        params: {},
        description: 'Delete unused file',
        reversible: true,
      }],
      pre_conditions: [],
      post_conditions: [],
      estimated_affected_files: 1,
      requires_verification: [],
    };
    const ops = renderOperations(plan);
    expect(ops[0]!.delete).toBe(true);
    expect(ops[0]!.file).toBe('src/dead.ts');
  });
});

// ---------------------------------------------------------------------------
// validatePlan
// ---------------------------------------------------------------------------

describe('validatePlan', () => {
  it('accepts a valid plan', () => {
    const { intent } = createEditIntent({
      operation: 'extract',
      target_refs: ['src/big.ts'],
      params: {
        destination_file: 'src/helpers.ts',
        symbol_names: ['parseConfig'],
      },
    });
    const plan = planTransform(intent);
    const result = validatePlan(plan);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('errors on empty steps', () => {
    const plan: TransformPlan = {
      plan_id: 'test',
      intent_id: 'test',
      operation: 'patch',
      target_refs: ['src/x.ts'],
      steps: [],
      pre_conditions: [],
      post_conditions: [],
      estimated_affected_files: 1,
      requires_verification: [],
    };
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('plan has no steps');
  });

  it('errors on duplicate step indices', () => {
    const plan: TransformPlan = {
      plan_id: 'test',
      intent_id: 'test',
      operation: 'patch',
      target_refs: ['src/x.ts'],
      steps: [
        { step_index: 0, action: 'replace_lines', target_file: 'a.ts', params: {}, description: 'a', reversible: true },
        { step_index: 0, action: 'replace_lines', target_file: 'b.ts', params: {}, description: 'b', reversible: true },
      ],
      pre_conditions: [],
      post_conditions: [],
      estimated_affected_files: 1,
      requires_verification: [],
    };
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('duplicate step_index'))).toBe(true);
  });

  it('warns on empty target refs', () => {
    const plan: TransformPlan = {
      plan_id: 'test',
      intent_id: 'test',
      operation: 'patch',
      target_refs: [],
      steps: [
        { step_index: 0, action: 'replace_lines', target_file: 'a.ts', params: {}, description: 'a', reversible: true },
      ],
      pre_conditions: [],
      post_conditions: [],
      estimated_affected_files: 0,
      requires_verification: [],
    };
    const result = validatePlan(plan);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain('plan has no target refs');
  });

  it('errors on step missing target_file', () => {
    const plan: TransformPlan = {
      plan_id: 'test',
      intent_id: 'test',
      operation: 'patch',
      target_refs: ['src/x.ts'],
      steps: [
        { step_index: 0, action: 'replace_lines', target_file: '', params: {}, description: 'a', reversible: true },
      ],
      pre_conditions: [],
      post_conditions: [],
      estimated_affected_files: 1,
      requires_verification: [],
    };
    const result = validatePlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('missing target_file'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dryRunResult
// ---------------------------------------------------------------------------

describe('dryRunResult', () => {
  it('produces dry_run status', () => {
    const { intent } = createEditIntent({
      operation: 'extract',
      target_refs: ['src/big.ts'],
      params: {
        destination_file: 'src/helpers.ts',
        symbol_names: ['parseConfig'],
      },
      dry_run: true,
    });
    const plan = planTransform(intent);
    const result = dryRunResult(intent, plan);
    expect(result.status).toBe('dry_run');
    expect(result.intent_id).toBe(intent.intent_id);
    expect(result.plan.plan_id).toBe(plan.plan_id);
    expect(result.change_set).toBeUndefined();
    expect(result.verification).toBeUndefined();
  });
});
