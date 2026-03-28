/**
 * Unified Batch Execution — public API.
 */

export { executeUnifiedBatch, type BatchStepProgress, type OnBatchStepComplete } from './executor';
export { MAX_BATCH_POLICY_STEPS, normalizeBatchPolicyForExecution } from './policy';
export { getHandler, isReadonlyOp, isMutatingOp } from './opMap';
export { formatBatchResult, stepOutputToResult } from './resultFormatter';

export type {
  UnifiedBatchRequest,
  UnifiedBatchResult,
  Step,
  StepOutput,
  StepResult,
  OperationKind,
  RefExpr,
  ExecutionPolicy,
  HandlerContext,
  OpHandler,
  ConditionExpr,
  OutputSpec,
} from './types';
