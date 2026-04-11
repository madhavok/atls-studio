// TODO: UHPP Phase 4 — not wired to runtime chat path. Only imported by uhppTypes.ts barrel + tests.
/**
 * UHPP Phase 4: Intent-Driven Edit Pipeline
 *
 * Converts typed EditIntents into structured TransformPlans, renders
 * them as backend-compatible operations, and validates pre/post conditions.
 *
 * This is a wrapper layer on top of the existing refactor execute pipeline —
 * the intent layer resolves targets, plans transforms, and renders operations,
 * then hands them to the existing `draft` / refactor execute infrastructure.
 */

import type {
  EditOperation,
  EditIntent,
  EditIntentParams,
  EditIntentResult,
  EditIntentStatus,
  TransformPlan,
  TransformStep,
  TransformAction,
  TransformCondition,
  TransformConditionKind,
  VerificationLevel,
  UhppProvenance,
  BindingResult,
  InterfaceChange,
} from './uhppCanonical';

// ---------------------------------------------------------------------------
// Intent ID generation
// ---------------------------------------------------------------------------

let _intentSeq = 0;

export function generateIntentId(): string {
  _intentSeq += 1;
  return `intent-${Date.now().toString(36)}-${_intentSeq}`;
}

export function generatePlanId(): string {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Per-operation metadata
// ---------------------------------------------------------------------------

export interface EditOperationMeta {
  operation: EditOperation;
  required_params: (keyof EditIntentParams)[];
  required_verification: VerificationLevel[];
  supports_dry_run: boolean;
  typical_actions: TransformAction[];
}

const OPERATION_META: ReadonlyMap<EditOperation, EditOperationMeta> = new Map([
  ['extract', {
    operation: 'extract' as EditOperation,
    required_params: ['destination_file', 'symbol_names'],
    required_verification: ['freshness', 'structural'],
    supports_dry_run: true,
    typical_actions: ['create_file', 'remove_lines', 'import_update'],
  }],
  ['rename', {
    operation: 'rename' as EditOperation,
    required_params: ['new_name'],
    required_verification: ['freshness', 'typecheck'],
    supports_dry_run: true,
    typical_actions: ['rename_symbol', 'import_update'],
  }],
  ['move', {
    operation: 'move' as EditOperation,
    required_params: ['destination_file'],
    required_verification: ['freshness', 'structural'],
    supports_dry_run: true,
    typical_actions: ['create_file', 'remove_lines', 'import_update'],
  }],
  ['split', {
    operation: 'split' as EditOperation,
    required_params: ['destination_file'],
    required_verification: ['freshness', 'structural'],
    supports_dry_run: true,
    typical_actions: ['create_file', 'remove_lines', 'import_update'],
  }],
  ['merge', {
    operation: 'merge' as EditOperation,
    required_params: [],
    required_verification: ['freshness', 'structural'],
    supports_dry_run: true,
    typical_actions: ['insert_lines', 'remove_lines', 'import_update'],
  }],
  ['inline', {
    operation: 'inline' as EditOperation,
    required_params: ['symbol_names'],
    required_verification: ['freshness', 'typecheck'],
    supports_dry_run: true,
    typical_actions: ['replace_lines', 'remove_lines', 'import_update'],
  }],
  ['wrap', {
    operation: 'wrap' as EditOperation,
    required_params: ['wrapper_template'],
    required_verification: ['freshness'],
    supports_dry_run: true,
    typical_actions: ['replace_lines'],
  }],
  ['patch', {
    operation: 'patch' as EditOperation,
    required_params: ['patch_content'],
    required_verification: ['freshness'],
    supports_dry_run: false,
    typical_actions: ['replace_lines', 'insert_lines'],
  }],
  ['adapt_interface', {
    operation: 'adapt_interface' as EditOperation,
    required_params: ['interface_changes'],
    required_verification: ['freshness', 'typecheck'],
    supports_dry_run: true,
    typical_actions: ['replace_lines', 'import_update'],
  }],
  ['propagate_callsites', {
    operation: 'propagate_callsites' as EditOperation,
    required_params: [],
    required_verification: ['freshness', 'typecheck'],
    supports_dry_run: true,
    typical_actions: ['replace_lines'],
  }],
  ['update_imports', {
    operation: 'update_imports' as EditOperation,
    required_params: [],
    required_verification: ['freshness'],
    supports_dry_run: true,
    typical_actions: ['import_update'],
  }],
]);

export function getEditOperationMeta(op: EditOperation): EditOperationMeta | undefined {
  return OPERATION_META.get(op);
}

// ---------------------------------------------------------------------------
// Intent creation
// ---------------------------------------------------------------------------

export interface CreateIntentInput {
  operation: EditOperation;
  target_refs: string[];
  params: EditIntentParams;
  dry_run?: boolean;
  provenance?: UhppProvenance;
}

/**
 * Build a typed EditIntent from loose inputs.
 * Validates required params for the operation.
 */
export function createEditIntent(input: CreateIntentInput): { intent: EditIntent; warnings: string[] } {
  const warnings: string[] = [];
  const meta = OPERATION_META.get(input.operation);

  if (!meta) {
    warnings.push(`unknown_operation: ${input.operation}`);
  } else {
    for (const param of meta.required_params) {
      const val = input.params[param];
      if (val === undefined || val === null || (Array.isArray(val) && val.length === 0)) {
        warnings.push(`missing_param: ${param} required for ${input.operation}`);
      }
    }
  }

  if (input.target_refs.length === 0) {
    warnings.push('no_target_refs');
  }

  return {
    intent: {
      intent_id: generateIntentId(),
      operation: input.operation,
      target_refs: input.target_refs,
      params: input.params,
      dry_run: input.dry_run ?? false,
      provenance: input.provenance,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Transform planning
// ---------------------------------------------------------------------------

/**
 * Generate pre-conditions for a transform plan based on the operation.
 */
export function generatePreConditions(
  intent: EditIntent,
  binding?: BindingResult,
): TransformCondition[] {
  const conditions: TransformCondition[] = [];

  for (const ref of intent.target_refs) {
    conditions.push({
      kind: 'file_exists' as TransformConditionKind,
      target_ref: ref,
      description: `Target ${ref} must exist before ${intent.operation}`,
    });
  }

  if (['extract', 'move', 'split'].includes(intent.operation) && intent.params.destination_file) {
    conditions.push({
      kind: 'file_not_exists' as TransformConditionKind,
      target_ref: intent.params.destination_file,
      description: `Destination ${intent.params.destination_file} should not already exist`,
    });
  }

  if (['rename', 'inline', 'extract'].includes(intent.operation) && intent.params.symbol_names?.length) {
    for (const sym of intent.params.symbol_names) {
      conditions.push({
        kind: 'symbol_exists' as TransformConditionKind,
        target_ref: sym,
        description: `Symbol ${sym} must be resolvable`,
      });
    }
  }

  if (binding) {
    for (const t of binding.resolved_targets) {
      if (t.content_hash) {
        conditions.push({
          kind: 'hash_matches' as TransformConditionKind,
          target_ref: t.ref,
          description: `Content hash ${t.content_hash} must still be current`,
        });
      }
    }
  }

  return conditions;
}

/**
 * Generate post-conditions based on the operation type.
 */
export function generatePostConditions(
  intent: EditIntent,
  meta: EditOperationMeta | undefined,
): TransformCondition[] {
  const conditions: TransformCondition[] = [];

  if (['extract', 'move', 'split'].includes(intent.operation) && intent.params.destination_file) {
    conditions.push({
      kind: 'file_exists' as TransformConditionKind,
      target_ref: intent.params.destination_file,
      description: `Destination file was created`,
    });
  }

  if (meta?.required_verification.includes('typecheck')) {
    for (const ref of intent.target_refs) {
      conditions.push({
        kind: 'no_type_errors' as TransformConditionKind,
        target_ref: ref,
        description: `No type errors in ${ref} after ${intent.operation}`,
      });
    }
  }

  return conditions;
}

/**
 * Build a TransformPlan from an EditIntent and optional BindingResult.
 *
 * This produces the plan structure; actual step content depends on
 * backend analysis (symbol deps, import graph). Steps are populated
 * as scaffolding that the backend fills during execution.
 */
export function planTransform(
  intent: EditIntent,
  binding?: BindingResult,
): TransformPlan {
  const meta = OPERATION_META.get(intent.operation);
  const preConditions = generatePreConditions(intent, binding);
  const postConditions = generatePostConditions(intent, meta);

  const steps = generateStepScaffold(intent);
  const affectedFiles = new Set<string>(intent.target_refs);
  if (intent.params.destination_file) affectedFiles.add(intent.params.destination_file);

  return {
    plan_id: generatePlanId(),
    intent_id: intent.intent_id,
    operation: intent.operation,
    target_refs: intent.target_refs,
    steps,
    pre_conditions: preConditions,
    post_conditions: postConditions,
    estimated_affected_files: affectedFiles.size,
    requires_verification: meta?.required_verification ?? ['freshness'],
    provenance: intent.provenance,
  };
}

/**
 * Generate scaffold steps for the intent — these are the expected
 * transform actions without concrete line numbers (which the backend
 * resolves at execution time).
 */
function generateStepScaffold(intent: EditIntent): TransformStep[] {
  const steps: TransformStep[] = [];
  let idx = 0;

  switch (intent.operation) {
    case 'extract': {
      if (intent.params.destination_file) {
        steps.push({
          step_index: idx++,
          action: 'create_file',
          target_file: intent.params.destination_file,
          source_ref: intent.target_refs[0],
          params: { symbol_names: intent.params.symbol_names },
          description: `Create ${intent.params.destination_file} with extracted symbols`,
          reversible: true,
        });
      }
      for (const ref of intent.target_refs) {
        steps.push({
          step_index: idx++,
          action: 'remove_lines',
          target_file: ref,
          params: { symbol_names: intent.params.symbol_names },
          description: `Remove extracted symbols from ${ref}`,
          reversible: true,
        });
        steps.push({
          step_index: idx++,
          action: 'import_update',
          target_file: ref,
          params: { destination: intent.params.destination_file },
          description: `Update imports in ${ref} to reference new location`,
          reversible: true,
        });
      }
      break;
    }
    case 'rename': {
      for (const ref of intent.target_refs) {
        steps.push({
          step_index: idx++,
          action: 'rename_symbol',
          target_file: ref,
          params: { new_name: intent.params.new_name, symbol_names: intent.params.symbol_names },
          description: `Rename symbol to ${intent.params.new_name} in ${ref}`,
          reversible: true,
        });
      }
      break;
    }
    case 'move': {
      if (intent.params.destination_file) {
        steps.push({
          step_index: idx++,
          action: 'move_content',
          target_file: intent.params.destination_file,
          source_ref: intent.target_refs[0],
          params: { symbol_names: intent.params.symbol_names },
          description: `Move content to ${intent.params.destination_file}`,
          reversible: true,
        });
        for (const ref of intent.target_refs) {
          steps.push({
            step_index: idx++,
            action: 'import_update',
            target_file: ref,
            params: { destination: intent.params.destination_file },
            description: `Update imports in ${ref}`,
            reversible: true,
          });
        }
      }
      break;
    }
    case 'wrap': {
      for (const ref of intent.target_refs) {
        steps.push({
          step_index: idx++,
          action: 'replace_lines',
          target_file: ref,
          params: { wrapper_template: intent.params.wrapper_template },
          description: `Wrap content in ${ref} with template`,
          reversible: true,
        });
      }
      break;
    }
    case 'patch': {
      for (const ref of intent.target_refs) {
        steps.push({
          step_index: idx++,
          action: 'replace_lines',
          target_file: ref,
          params: { patch_content: intent.params.patch_content },
          description: `Apply patch to ${ref}`,
          reversible: true,
        });
      }
      break;
    }
    case 'inline': {
      for (const ref of intent.target_refs) {
        steps.push({
          step_index: idx++,
          action: 'replace_lines',
          target_file: ref,
          params: { symbol_names: intent.params.symbol_names },
          description: `Inline symbols in ${ref}`,
          reversible: true,
        });
      }
      break;
    }
    case 'update_imports': {
      for (const ref of intent.target_refs) {
        steps.push({
          step_index: idx++,
          action: 'import_update',
          target_file: ref,
          params: {},
          description: `Update imports in ${ref}`,
          reversible: true,
        });
      }
      break;
    }
    default: {
      for (const ref of intent.target_refs) {
        steps.push({
          step_index: idx++,
          action: 'replace_lines',
          target_file: ref,
          params: {},
          description: `Apply ${intent.operation} to ${ref}`,
          reversible: true,
        });
      }
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Render to backend operations
// ---------------------------------------------------------------------------

/**
 * Render a TransformPlan into the backend refactor execute operations array.
 * This bridges the typed intent model to the existing batch_query.rs format.
 */
export function renderOperations(plan: TransformPlan): Record<string, unknown>[] {
  return plan.steps.map(step => {
    const op: Record<string, unknown> = {};

    switch (step.action) {
      case 'create_file':
        op.create = true;
        op.file = step.target_file;
        if (step.source_ref) op.source = step.source_ref;
        if (step.params.symbol_names) op.extract = step.params.symbol_names;
        break;

      case 'remove_lines':
        op.file = step.target_file;
        op.remove_lines = step.params.remove_lines ??
          (step.params.symbol_names as string[] | undefined)?.map(
            (s: string) => `fn(${s})`
          );
        break;

      case 'insert_lines':
        op.file = step.target_file;
        op.insert = step.params;
        break;

      case 'replace_lines':
        op.file = step.target_file;
        op.replace = step.params;
        break;

      case 'move_content':
        op.from = step.source_ref;
        op.to = step.target_file;
        op.extract = step.params.symbol_names;
        break;

      case 'import_update':
        op.file = step.target_file;
        op.import_updates = step.params.import_updates ?? [];
        break;

      case 'rename_symbol':
        op.file = step.target_file;
        op.old_name = (step.params.symbol_names as string[] | undefined)?.[0];
        op.new_name = step.params.new_name;
        break;

      case 'delete_file':
        op.file = step.target_file;
        op.delete = true;
        break;
    }

    return op;
  });
}

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a transform plan for structural correctness.
 * Does not check runtime conditions (file existence, hash freshness).
 */
export function validatePlan(plan: TransformPlan): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (plan.steps.length === 0) {
    errors.push('plan has no steps');
  }

  if (plan.target_refs.length === 0) {
    warnings.push('plan has no target refs');
  }

  const seenIndices = new Set<number>();
  for (const step of plan.steps) {
    if (seenIndices.has(step.step_index)) {
      errors.push(`duplicate step_index: ${step.step_index}`);
    }
    seenIndices.add(step.step_index);

    if (!step.target_file) {
      errors.push(`step ${step.step_index}: missing target_file`);
    }
    if (!step.description) {
      warnings.push(`step ${step.step_index}: missing description`);
    }
  }

  const sorted = [...plan.steps].sort((a, b) => a.step_index - b.step_index);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.step_index !== i) {
      warnings.push(`step indices are not contiguous (gap at ${i})`);
      break;
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Create a dry-run EditIntentResult from a plan without executing.
 */
export function dryRunResult(intent: EditIntent, plan: TransformPlan): EditIntentResult {
  return {
    intent_id: intent.intent_id,
    plan,
    status: 'dry_run' as EditIntentStatus,
  };
}
