/**
 * Operation Map — routes OperationKind dotted names to handler functions.
 *
 * This is the canonical operation registry for unified batch execution.
 */

import type { OperationKind, OpHandler } from './types';

// Handlers — lazy-imported to avoid pulling all deps on module load
import {
  handleTaskPlan, handleTaskAdvance, handleTaskStatus,
  handleUnload, handleCompact, handleStage, handleUnstage,
  handleDrop, handlePin, handleUnpin, handleRecall,
  handleStats, handleCompactHistory, handleSessionDebug,
  handleSessionDiagnose,
} from './handlers/session';

import {
  handleBbWrite, handleBbRead, handleBbDelete, handleBbList,
} from './handlers/blackboard';

import {
  handleRule, handleEngramEdit, handleAnnotate, handleLink,
  handleRetype, handleSplit, handleMerge, handleDesignWrite,
} from './handlers/annotation';

import {
  handleLoad, handleRead, handleReadLines, handleReadShaped,
  handleShape, handleEmit,
} from './handlers/context';

import {
  handleSearchCode, handleSearchSymbol, handleSearchUsage,
  handleSearchSimilar, handleSearchIssues, handleSearchPatterns,
  handleSearchMemory,
  handleAnalyzeDeps, handleAnalyzeCalls, handleAnalyzeStructure,
  handleAnalyzeGraph,
  handleAnalyzeImpact, handleAnalyzeBlastRadius, handleAnalyzeExtractPlan,
} from './handlers/query';

import {
  handleEdit, handleCreate, handleDelete, handleRefactor, handleRollback,
  handleSplitModule,
} from './handlers/change';

import {
  handleVerifyBuild, handleVerifyTest, handleVerifyLint, handleVerifyTypecheck,
} from './handlers/verify';

import {
  handleDelegateRetrieve, handleDelegateDesign, handleDelegateCode, handleDelegateTest,
} from './handlers/delegate';

import {
  handleSystemExec, handleSystemGit, handleSystemHelp, handleSystemWorkspaces,
} from './handlers/system';

// ---------------------------------------------------------------------------
// Canonical OperationKind → handler mapping
// ---------------------------------------------------------------------------

const OP_MAP: ReadonlyMap<OperationKind, OpHandler> = new Map<OperationKind, OpHandler>([
  // discover
  ['search.code', handleSearchCode],
  ['search.symbol', handleSearchSymbol],
  ['search.usage', handleSearchUsage],
  ['search.similar', handleSearchSimilar],
  ['search.issues', handleSearchIssues],
  ['search.patterns', handleSearchPatterns],
  ['search.memory', handleSearchMemory],

  // understand
  ['read.context', handleRead],
  ['read.shaped', handleReadShaped],
  ['read.lines', handleReadLines],
  ['read.file', handleLoad],
  ['analyze.deps', handleAnalyzeDeps],
  ['analyze.calls', handleAnalyzeCalls],
  ['analyze.structure', handleAnalyzeStructure],
  ['analyze.impact', handleAnalyzeImpact],
  ['analyze.blast_radius', handleAnalyzeBlastRadius],
  ['analyze.extract_plan', handleAnalyzeExtractPlan],
  ['analyze.graph', handleAnalyzeGraph],

  // change
  ['change.edit', handleEdit],
  ['change.create', handleCreate],
  ['change.delete', handleDelete],
  ['change.refactor', handleRefactor],
  ['change.rollback', handleRollback],
  ['change.split_module', handleSplitModule],

  // verify
  ['verify.build', handleVerifyBuild],
  ['verify.test', handleVerifyTest],
  ['verify.lint', handleVerifyLint],
  ['verify.typecheck', handleVerifyTypecheck],

  // session — task lifecycle
  ['session.plan', handleTaskPlan],
  ['session.advance', handleTaskAdvance],
  ['session.status', handleTaskStatus],
  ['session.pin', handlePin],
  ['session.unpin', handleUnpin],
  ['session.stage', handleStage],
  ['session.unstage', handleUnstage],
  ['session.compact', handleCompact],
  ['session.unload', handleUnload],
  ['session.drop', handleDrop],
  ['session.recall', handleRecall],
  ['session.stats', handleStats],
  ['session.debug', handleSessionDebug],
  ['session.diagnose', handleSessionDiagnose],
  ['session.compact_history', handleCompactHistory],

  // session — blackboard
  ['session.bb.write', handleBbWrite],
  ['session.bb.read', handleBbRead],
  ['session.bb.delete', handleBbDelete],
  ['session.bb.list', handleBbList],

  // session — rules & misc
  ['session.rule', handleRule],
  ['session.emit', handleEmit],
  ['session.shape', handleShape],
  ['session.load', handleLoad],

  // annotations
  ['annotate.engram', handleEngramEdit],
  ['annotate.note', handleAnnotate],
  ['annotate.link', handleLink],
  ['annotate.retype', handleRetype],
  ['annotate.split', handleSplit],
  ['annotate.merge', handleMerge],
  ['annotate.design', handleDesignWrite],

  // delegate
  ['delegate.retrieve', handleDelegateRetrieve],
  ['delegate.design', handleDelegateDesign],
  ['delegate.code', handleDelegateCode],
  ['delegate.test', handleDelegateTest],

  // system
  ['system.exec', handleSystemExec],
  ['system.git', handleSystemGit],
  ['system.help', handleSystemHelp],
  ['system.workspaces', handleSystemWorkspaces],
]);

export function getHandler(op: OperationKind): OpHandler | undefined {
  return OP_MAP.get(op);
}

// ---------------------------------------------------------------------------
// Operation family classification
// ---------------------------------------------------------------------------

export function isReadonlyOp(op: OperationKind): boolean {
  return op.startsWith('search.') || op.startsWith('read.') || op.startsWith('analyze.')
    || op.startsWith('verify.')     || op === 'session.stats' || op === 'session.debug' || op === 'session.diagnose'
    || op === 'session.bb.read' || op === 'session.bb.list' || op === 'session.status'
    || op === 'session.recall'
    || op === 'system.git'
    || op === 'system.help'
    || op === 'system.workspaces'
    || op.startsWith('intent.');
}

export function isIntentOp(op: OperationKind): boolean {
  return op.startsWith('intent.');
}

export function isMutatingOp(op: OperationKind): boolean {
  return op.startsWith('change.') || op === 'system.exec';
}

export function isSessionOp(op: OperationKind): boolean {
  return op.startsWith('session.') || op.startsWith('annotate.');
}
