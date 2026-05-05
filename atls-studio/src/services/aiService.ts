/** Valid native tool names for typo suggestions. */
const VALID_NATIVE_TOOLS = [
  'batch',
  'task_complete',
] as const;

/** Levenshtein distance for typo correction. */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row: number[] = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 0; j < b.length; j++) {
    let prev = row[0];
    row[0] = j + 1;
    for (let i = 0; i < a.length; i++) {
      const temp = row[i + 1];
      row[i + 1] = a[i] === b[j]
        ? prev
        : 1 + Math.min(prev, row[i], row[i + 1]);
      prev = temp;
    }
  }
  return row[a.length];
}

/** Return nearest valid tool name for typo hints. */
function findNearestValidTool(name: string): string | undefined {
  const lower = name.toLowerCase().trim();
  if (!lower) return undefined;
  let best: string | undefined;
  let bestDist = Infinity;
  for (const t of VALID_NATIVE_TOOLS) {
    const d = levenshtein(lower, t.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= 4 ? best : undefined; // suggest if within 4 edits
}

/**
 * AI Service - Multi-provider AI integration for ATLS Studio
 * 
 * Providers:
 * - Anthropic (Claude)
 * - OpenAI (GPT-4, GPT-4o)
 * - Google AI (Gemini)
 * - Google Vertex AI
 * 
 * All API calls are routed through Tauri backend to bypass CORS.
 */

export { fetchModels, type AIProvider } from './modelFetcher';
export { getGeminiCacheSnapshot, restoreGeminiCacheSnapshot, type GeminiCacheSnapshot } from './geminiCache';

// Prompt/workflow discipline:
// - Keep prompts context-rich but token-efficient: sig for planning, exact line windows only for immediate action.
// - Prefer BB-backed status/plan refs over stale narrative summaries.
// - Batch related work, then verify at meaningful milestones.
// - Use supported tool conditions only; avoid suggesting all_steps_ok until implemented.
import {
  manageGeminiRollingCache,
  cleanupGeminiCache,
  resetHppHydrationCache,
  geminiUncachedMessagesStartIndex,
} from './geminiCache';
import {
  resolveSearchRefs,
  setProjectPathGetter,
  getProjectPath,
  invokeWithTimeout,
  createHashLookup,
  atlsBatchQuery,
  buildSharedExportRemovalWarning,
  buildWorkspaceVerifyHint,
  resolveToolParams,
} from './toolHelpers';
import {
  expandFilePathRefs as expandCanonicalFilePathRefs,
  expandSetRefsInHashes as expandCanonicalSetRefsInHashes,
} from './uhppExpansion';
import { invoke } from '@tauri-apps/api/core';
import { getEffectiveContextWindow, getExtendedContextResolutionFromSettings } from '../utils/modelCapabilities';
import type {
  AgentPendingAction,
  AgentPendingActionSource,
  AgentPendingActionState,
  AgentToolSummary,
  ContextUsage,
  Message,
  MessagePart,
  MessageToolCall,
  WorkspaceEntry,
  StreamChunk,
} from '../stores/appStore';
import { useAppStore, getMessageParts } from '../stores/appStore';
import { useContextStore, setCacheHitRateAccessor, setWorkspacesAccessor, setPromptMetricsAccessor, setRoundRefreshRevisionResolver, setRetentionMetricsAccessor, setRetentionResetAccessor, setFileViewCounterBumper, drainRefCollisionCount } from '../stores/contextStore';
import { useRetentionStore } from '../stores/retentionStore';

// Cross-store accessor wiring — breaks circular deps at runtime.
// Called at module load AND re-applied in ensureAiServiceWiring() as a guardrail.
function initCrossStoreAccessors(): void {
  setCacheHitRateAccessor(() => useAppStore.getState().cacheMetrics.sessionHitRate);
  setWorkspacesAccessor(() => (useAppStore.getState().projectProfile?.workspaces as Array<{ name: string; path: string }>) ?? []);
  setPromptMetricsAccessor(() => useAppStore.getState().promptMetrics);
  setFileViewCounterBumper((key, delta) => useAppStore.getState().incFileViewCounter(key, delta));
  setProjectPathGetter(() => useAppStore.getState().projectPath);
  setRecencyResolver((offset: number) => useContextStore.getState().resolveRecencyRef(offset));
  setEditRecencyResolver((offset: number) => useContextStore.getState().resolveEditRecencyRef(offset));
  setReadRecencyResolver((offset: number) => useContextStore.getState().resolveReadRecencyRef(offset));
  setStageRecencyResolver((offset: number) => useContextStore.getState().resolveStageRecencyRef(offset));
  setRoundRefreshHook(async () => {
    await useContextStore.getState().refreshRoundEnd();
  });
  setRetentionMetricsAccessor(() => useRetentionStore.getState().getMetrics());
  setRetentionResetAccessor(() => useRetentionStore.getState().reset());
}

function ensureAiServiceWiring(): void {
  initCrossStoreAccessors();
}

// Eagerly wire at module load so accessors are available immediately
initCrossStoreAccessors();
import { useCostStore, calculateCost, calculateCostBreakdown, type AIProvider as CostProvider } from '../stores/costStore';
import { useRefactorStore } from '../stores/refactorStore';
import { formatChunkRef, hashContentSync, isCompressedRef, sliceContentByLines, extractSearchSummary, extractSymbolSummary, extractDepsSummary, SHORT_HASH_LEN, type DigestSymbol } from '../utils/contextHash';
import { resolveHashRefsWithMeta, setRecencyResolver, setEditRecencyResolver, setReadRecencyResolver, setStageRecencyResolver, type HashLookup, type SetRefLookup } from '../utils/hashResolver';
import { toTOON, formatResult, expandBatchQ } from '../utils/toon';
import { getProviderFromModelId } from '../utils/pricingProvider';
import { countTokensSync, countTokens as countTokensAsync } from '../utils/tokenCounter';
import { BATCH_TOOL_REF, DESIGNER_TOOL_REF, SUBAGENT_TOOL_REF, NATIVE_TOOL_TOKENS_ESTIMATE } from '../prompts/toolRef';
import { CONTEXT_CONTROL, CONTEXT_CONTROL_DESIGNER } from '../prompts/cognitiveCore';
import { EDIT_DISCIPLINE } from '../prompts/editDiscipline';
import { OUTPUT_STYLE } from '../prompts/outputStyle';
import { HASH_PROTOCOL_CORE } from '../prompts/hashProtocol';
import { getModePrompt } from '../prompts/modePrompts';
import { getShellGuide } from '../prompts/shellGuide';
import { GEMINI_REINFORCEMENT, GEMINI_RECENCY_BOOST } from '../prompts/providerOverrides';
import { advanceTurn, dematerialize, getAllRefs, getRef, shouldMaterialize, getTurn, setRoundRefreshHook, getArchivedRefs as getArchivedHppRefs } from './hashProtocol';
import { formatHashManifest, pruneStaleEntries, getForwardMap, getEvictionMap } from './hashManifest';
import { estimateFileViewTokens } from './fileViewTokens';
import { INTERNALS_TAB_ID } from '../constants/atlsInternals';
import { SWARM_ORCHESTRATION_TAB_ID } from '../constants/swarmOrchestrationTab';
import { useRoundHistoryStore, type VerificationConfidence } from '../stores/roundHistoryStore';
import {
  executeUnifiedBatch,
  normalizeBatchPolicyForExecution,
  type HandlerContext,
  type UnifiedBatchRequest,
  type UnifiedBatchResult,
  type OnBatchStepComplete,
} from './batch';
import { resetMainAgentTerminal } from '../stores/terminalStore';
import { hashBp3Prefix, computeLogicalBp3Hit, computeLogicalStaticHit, type Bp3Snapshot } from './logicalCacheMetrics';
import type { ExpandedFilePath } from './batch/types';
import { formatBatchResult } from './batch/resultFormatter';
import { coerceBatchSteps } from './batch/coerceBatchSteps';
import { truncateToolResult } from './toolResultLimits';
import './batch/intents/index';
import { resolveIntents, buildIntentContext, isPressured } from './batch/intents';
import type { Step } from './batch/types';

/** Model may send `file_paths` / `queries` as a string or array; never use `[0]` on a string (first char). */
function firstStringOrArrayHead(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length > 0) return String(v[0]);
  return undefined;
}

/**
 * Align batch progress UI with the executor: `resolveIntents` expands intent.* into
 * primitives (e.g. intent.search_replace → search + N edits + verify). `onBatchStepProgress`
 * fires once per primitive; if we only showed one row per intent, the first row would
 * flip to "completed" after the first sub-step while verify.build still ran — looks like
 * a frozen chat.
 */
function expandBatchStepsForUiDisplay(steps: Record<string, unknown>[]): Step[] {
  const store = useContextStore.getState as unknown as HandlerContext['store'];
  const intentCtx = buildIntentContext(store, new Map());
  const { expanded, lookahead } = resolveIntents(steps as unknown as Step[], intentCtx);
  const withLookahead =
    lookahead.length > 0 && !isPressured(store) ? [...expanded, ...lookahead] : expanded;
  return withLookahead.length > 0 ? withLookahead : (steps as unknown as Step[]);
}

/**
 * Finalize UI status for batch step rows using the executor's authoritative
 * step outcomes. Previous logic parsed displayText line-by-index, which marked
 * N-1 rows "completed" when a single `__batch_validation__` line came back.
 *
 * Rules:
 * - Row id matches an outcome id → status mirrors outcome.ok.
 * - Row has no matching outcome → "failed" (step never ran: validation aborted,
 *   intent expansion dropped it, or executor stopped early).
 */
export function finalizeBatchAgentProgress(
  summaries: AgentToolSummary[],
  outcomes: Array<{ id: string; ok: boolean }> | undefined,
  _batchOk: boolean | undefined,
): AgentToolSummary[] {
  const outcomeById = new Map<string, boolean>();
  for (const o of outcomes ?? []) outcomeById.set(o.id, o.ok);
  return summaries.map((row) => {
    const okVal = row.stepId ? outcomeById.get(row.stepId) : undefined;
    const status: AgentToolSummary['status'] =
      okVal === undefined ? 'failed' : okVal ? 'completed' : 'failed';
    return { ...row, status };
  });
}
import {
  BLACKBOARD_BUDGET_TOKENS,
  STAGED_BUDGET_TOKENS,
  CONVERSATION_HISTORY_BUDGET_TOKENS,
  WORKSPACE_CONTEXT_BUDGET_TOKENS,
  WM_BUDGET_TOKENS,
  PHASE_ROUND_BUDGET,
  TOTAL_ROUND_SOFT_BUDGET,
  TOTAL_ROUND_ESCALATION,
  createPromptLayerBudgets,
  getStagedTokens,
  getEstimatedTotalPromptTokens,
  getStaticSystemTokens,
  type PromptPressureBuckets,
  type PromptReliefAction,
} from './promptMemory';
import { compressToolLoopHistory, compactRetentionOps, deflateToolResults, stubBatchToolUseInputs, estimateHistoryTokens, estimateHistoryTokensAsync } from './historyCompressor';
import { createGuardrailCallbacks, runBeforeRoundMiddlewares, setPromptBudgetEstimates } from './chatMiddleware';
import { createTauriChatStream } from './chatTransport';

// ============================================================================
// Gemini Context Cache Lifecycle Manager
// ============================================================================

/**
 * Resolve a path relative to the project root
 * Handles both absolute and relative paths
 */

// Tool invocation timeout (120s - matches backend default for verify/detect)

/**
 * Invoke Tauri command with timeout protection
 * Returns error message instead of hanging indefinitely
 */

/** Create hash lookup: backend registry (raw) → context store → chat DB */

/** Invoke atls_batch_query after resolving h: refs in params (context store + chat DB) */

// ============================================================================
// Types
// ============================================================================

import { fetchModels, type AIProvider } from './modelFetcher';
import { parseHashRef } from '../utils/hashRefParsers';
import { executeWithConcurrency } from './aiConcurrency';
import { classifyVerifyResult } from './batch/handlers/verify';
import { canSteerExecution } from './universalFreshness';
import {
  resetRoundFingerprint, getRoundFingerprint,
  recordToolSignature, recordTargetFiles, recordBbDelta,
  recordBatchSpinSemantics,
  recordAssistantTextHash, recordSteeringInjected,
  recordHashRefsConsumed, recordHashRefsEvicted,
  extractTargetFilesFromStepResults, extractBbDeltaFromStepResults,
  extractSteeringBlocks, extractHashRefs,
  recordReadDiversity,
} from './spinDiagnostics';
import { evaluateSpin, resetSpinCircuitBreaker, type CircuitBreakerTier } from './spinCircuitBreaker';
import type { SpinMode } from './spinDetector';
import { evaluateAssess, resetAssessContext } from './assessContext';
import { drainAutoPinMetrics, resetAutoPinTelemetry } from './autoPinTelemetry';
import { collectFileViewChunkHashes } from './fileViewRender';

/** Content block types for multimodal messages */
export type TextContentBlock = { type: 'text'; text: string };
export type ImageContentBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type ContentBlock = TextContentBlock | ImageContentBlock;

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  /** Plain text or array of content blocks (multimodal) */
  content: string | ContentBlock[];
  /** Structured parts from prior turns (tool_use + tool_result pairing). Passed through to messageToApiContent. */
  parts?: Array<{ type: string; content?: string; toolCall?: { id: string; name: string; args?: Record<string, unknown>; result?: string; thoughtSignature?: string } }>;
  /** @deprecated Legacy segments — use parts */
  segments?: Array<{ type: string; content?: string; toolCall?: { id: string; name: string; args?: Record<string, unknown>; result?: string; thoughtSignature?: string } }>;
}

interface ToolExecutionMeta {
  pendingAction?: AgentPendingActionState;
  completionBlocker?: string | null;
  syntheticChildren?: ToolCallEvent[];
  /** Present only for `batch`: per-step id → ok map for UI progress finalization. */
  batchOk?: boolean;
  batchStepOutcomes?: Array<{ id: string; ok: boolean }>;
}

interface ToolExecutionResult {
  displayText: string;
  meta?: ToolExecutionMeta;
}

const PENDING_ACTION_PRIORITY: Record<Exclude<AgentPendingAction, 'none'>, number> = {
  paused_on_error: 4,
  confirmation_required: 3,
  blocked: 2,
  state_changed: 1,
};

function excerptText(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function deriveVerificationConfidence(artifact: { confidence?: string; reused?: boolean; stale?: boolean; obsolete?: boolean }): VerificationConfidence {
  if (artifact.obsolete || artifact.confidence === 'obsolete') return 'obsolete';
  if (artifact.confidence === 'stale-suspect' || artifact.stale) return 'stale-suspect';
  if (artifact.confidence === 'cached' || artifact.reused) return 'cached';
  return 'fresh';
}

function deriveVerificationLabel(artifact: { classification?: string; summary?: string; confidence?: string; reused?: boolean; obsolete?: boolean; stale?: boolean }): string {
  const classification = artifact.classification ?? 'verify';
  const confidence = deriveVerificationConfidence(artifact);
  const summary = typeof artifact.summary === 'string' ? excerptText(artifact.summary, 120) : '';
  return summary ? `${classification} • ${confidence} • ${summary}` : `${classification} • ${confidence}`;
}


/**
 * Extract file paths from terminal error output. Returns normalized forward-slash
 * paths that can be intersected with verify artifact `filesObserved`.
 */
function extractFilePathsFromErrors(text: string): string[] {
  const FILE_PATH_RE = /(?:^|\s|['"`(])([a-zA-Z]:[\\/]|\.{0,2}[\\/]|src[\\/]|lib[\\/]|app[\\/]|packages[\\/])([^\s:'"`)]+\.(?:ts|tsx|js|jsx|rs|py|css|html|json|toml|yaml|yml))/gm;
  const LINE_PREFIXED_RE = /^\s*(?:-->|error\[?\w*\]?:?\s+).*?([a-zA-Z]:[/\\][^\s:]+|(?:\.{0,2}[/\\])?(?:src|lib|app|packages)[/\\][^\s:]+)/gm;
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const re of [FILE_PATH_RE, LINE_PREFIXED_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = (m[2] ? m[1] + m[2] : m[1]).replace(/\\/g, '/').replace(/['"`)]+$/, '');
      const norm = raw.toLowerCase();
      if (!seen.has(norm)) {
        seen.add(norm);
        paths.push(raw);
      }
    }
  }
  return paths;
}

/**
 * Detect if user message contains terminal output (build errors, test failures)
 * that contradicts cached passing verify artifacts.
 *
 * Returns extracted file paths on match (empty array = detected but no files extracted).
 * Returns null when no contradiction detected.
 *
 * Requires structural evidence: either a fenced code block / indented block containing
 * multiple error indicators, or a single strong header signal. Plain prose mentioning
 * "error" or "failed" alone does not trigger.
 */
function detectContradictingTerminalOutput(text: string): { files: string[] } | null {
  if (!text || text.length < 20) return null;
  const hasPassingVerify = (() => {
    for (const artifact of useContextStore.getState().verifyArtifacts.values()) {
      if (artifact.ok && !artifact.stale) return true;
    }
    return false;
  })();
  if (!hasPassingVerify) return null;

  const terminalBlock = extractTerminalBlock(text);
  const probe = terminalBlock ?? text;

  const errorSignals = [
    /error\s*(?:ts|rs|cs)?\d{2,}/i,
    /\berror\[E\d+\]/,
    /^error:/m,
    /\bfailed\b.*\b(?:build|compile|test)/i,
    /\b(?:build|compile|test)\b.*\bfailed\b/i,
    /exit\s*code\s*[1-9]\d*/i,
    /\bFAIL\b.*\.(?:ts|tsx|js|jsx|rs|py)/,
    /npm\s+ERR!/,
    /cargo\s+(?:build|test).*error/i,
    /\bpanic(?:ked)?\b.*\bat\b/i,
  ];
  let matches = 0;
  for (const pattern of errorSignals) {
    if (pattern.test(probe)) matches++;
    if (matches >= 2) {
      return { files: extractFilePathsFromErrors(probe) };
    }
  }
  if (/^(?:FAILED|BUILD FAILED|Tests? FAILED)/mi.test(probe)) {
    return { files: extractFilePathsFromErrors(probe) };
  }

  return null;
}

/**
 * Try to isolate a terminal/code block from user text. Returns the block content
 * if a fenced block (```) or consistently-indented block (4+ spaces / tab) is found,
 * otherwise null — meaning we fall back to the full text but with higher signal
 * confidence since only structured pastes get through.
 */
function extractTerminalBlock(text: string): string | null {
  const fenced = text.match(/```[\s\S]*?\n([\s\S]*?)```/);
  if (fenced) return fenced[1];
  const lines = text.split('\n');
  const indented = lines.filter(l => /^(?:\t|    )/.test(l));
  if (indented.length >= 3) return indented.join('\n');
  return null;
}

function getLatestUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const text = msg.content
        .map(block => ('text' in block ? block.text ?? '' : ''))
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

function createPendingActionState(
  kind: Exclude<AgentPendingAction, 'none'>,
  source: AgentPendingActionSource,
  summary: string,
  extra: Partial<Omit<AgentPendingActionState, 'kind' | 'source' | 'summary'>> = {},
): AgentPendingActionState {
  return {
    kind,
    source,
    summary: excerptText(summary, 220),
    ...extra,
  };
}

function mergePendingAction(
  current: AgentPendingActionState,
  next: AgentPendingActionState | null | undefined,
): AgentPendingActionState {
  if (!next) return current;
  if (current.kind === 'none') return next;
  const currentPriority = PENDING_ACTION_PRIORITY[current.kind as Exclude<AgentPendingAction, 'none'>] ?? 0;
  const nextPriority = PENDING_ACTION_PRIORITY[next.kind as Exclude<AgentPendingAction, 'none'>] ?? 0;
  if (nextPriority > currentPriority) return next;
  if (nextPriority === currentPriority && next.summary.length > current.summary.length) return next;
  return current;
}

function buildPendingActionBlock(): string {
  const pendingAction = useAppStore.getState().agentProgress.pendingAction;
  if (!pendingAction || pendingAction.kind === 'none') return '';

  const heading = pendingAction.kind === 'state_changed'
    ? '## STATE CHANGED'
    : pendingAction.kind === 'blocked'
      ? '## BLOCKED'
      : '## ACTION REQUIRED';
  return [
    heading,
    `Source: ${pendingAction.source}`,
    `Reason: ${pendingAction.summary}`,
    'Instruction: Do not end the run until you re-evaluate the latest evidence and either continue with the new state or ask for confirmation.',
  ].join('\n');
}

function getPendingActionStopReason(pendingAction: AgentPendingActionState): string {
  switch (pendingAction.kind) {
    case 'confirmation_required':
      return `Awaiting confirmation: ${pendingAction.summary}`;
    case 'paused_on_error':
      return `Paused: ${pendingAction.summary}`;
    case 'state_changed':
      return `State changed: ${pendingAction.summary}`;
    case 'blocked':
      return `Blocked: ${pendingAction.summary}`;
    default:
      return '';
  }
}

function canAutoContinuePendingAction(pendingAction: AgentPendingActionState): boolean {
  return pendingAction.kind === 'state_changed' || pendingAction.kind === 'blocked';
}

function analyzeBatchPendingAction(result: UnifiedBatchResult): AgentPendingActionState | null {
  const interruption = result.interruption;
  if (!interruption) return null;
  return createPendingActionState(
    interruption.kind,
    'tool',
    interruption.summary,
    {
      toolName: interruption.tool_name ?? 'batch',
      stepId: interruption.step_id,
      stepIndex: interruption.step_index,
    },
  );
}

export function deriveMutationCompletionBlocker(result: UnifiedBatchResult): string | null | undefined {
  const verifyByStepId = new Map(
    result.step_results
      .filter((step) => step.use.startsWith('verify.'))
      .map((step) => [step.id, step] as const),
  );
  const verifyResults = result.verify ?? [];
  const interruptedVerifyStepId = result.interruption?.tool_name?.startsWith('verify.') ? result.interruption.step_id : undefined;

  // Tool errors get a distinct retryable message — they are not code failures
  const toolErrorBuild = verifyResults.find((entry) => {
    if (entry.passed) return false;
    const stepResult = verifyByStepId.get(entry.step_id);
    if (stepResult?.use !== 'verify.build') return false;
    return entry.classification === 'tool-error' || stepResult?.classification === 'tool-error';
  });
  if (toolErrorBuild) {
    return 'verify.build hit a tool error (not a code failure). Check working directory and toolchain, then retry.';
  }

  const failedBuild = verifyResults.find((entry) => {
    if (entry.passed) return false;
    if (entry.classification === 'pass-with-warnings') return false;
    const stepResult = verifyByStepId.get(entry.step_id);
    if (stepResult?.use !== 'verify.build') return false;
    if (interruptedVerifyStepId && entry.step_id === interruptedVerifyStepId) return false;
    return true;
  });
  if (failedBuild) return failedBuild.summary || 'verify.build failed.';

  const failedVerify = verifyResults.find((entry) => {
    if (entry.passed) return false;
    if (entry.classification === 'pass-with-warnings') return false;
    if (entry.classification === 'tool-error') return false;
    if (interruptedVerifyStepId && entry.step_id === interruptedVerifyStepId) return false;
    return true;
  });
  if (failedVerify) return failedVerify.summary || 'Verification failed.';

  // pass-with-warnings counts as success
  const passedBuild = verifyResults.some((entry) => {
    const stepResult = verifyByStepId.get(entry.step_id);
    return (entry.passed || entry.classification === 'pass-with-warnings') && stepResult?.use === 'verify.build';
  });
  if (passedBuild) {
    // Freshness gate: check if any verify artifacts have been invalidated since the build passed
    const changedFiles = result.step_results
      .filter(s => s.ok && s.use.startsWith('change.'))
      .flatMap(s => {
        if (!s.artifacts) return [];
        const drafts = (s.artifacts.drafts ?? s.artifacts.results ?? s.artifacts.batch) as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(drafts)) return [];
        return drafts.map(d => (d.f ?? d.file ?? d.path ?? d.file_path) as string).filter(Boolean);
      });
    const check = useContextStore.getState().assertFreshForClaim('verified', changedFiles);
    if (!check.ok) {
      return `Verify artifact stale: ${check.reason}. Re-verify required.`;
    }
    return null;
  }

  const mutated = result.step_results.some((step) => step.ok && step.use.startsWith('change.'));
  if (mutated) {
    if (result.interruption?.tool_name === 'verify.build') return undefined;
    return 'Final verification is still required before task completion.';
  }
  return undefined;
}

/**
 * Merge per-tool completion blockers collected during a parallel execution round.
 * Any non-null blocker wins — prevents task_complete from racing with batch verify gates.
 */
export function mergeCompletionBlockers(
  entries: ReadonlyArray<{ toolName: string; blocker: string | null | undefined }>,
): string | null {
  for (const entry of entries) {
    if (entry.blocker != null) return entry.blocker;
  }
  return null;
}

/** Markers for extended-thinking text bridged into plain `text` blocks (all providers). */
const PRIOR_THOUGHT_START = '<<PRIOR_THOUGHT>>';
const PRIOR_THOUGHT_END = '<</PRIOR_THOUGHT>>';

function formatPriorThoughtForApi(body: string): string {
  const t = body.trim();
  if (!t) return '';
  return `${PRIOR_THOUGHT_START}\n${t}\n${PRIOR_THOUGHT_END}`;
}

/** Merge streamed reasoning + visible text for one assistant turn (tool loop history). */
function mergeRoundAssistantVisibleText(reasoning: string, text: string): string {
  const th = formatPriorThoughtForApi(reasoning);
  const te = text.trim();
  if (th && te) return `${th}\n\n${te}`;
  return th || te;
}

/**
 * Convert a stored Message (with segments/parts) to API content format for Gemini/OpenAI/Anthropic.
 * Assistant messages with tool calls are expanded to model content + optional tool_result user message.
 * Uses getMessageParts() so legacy `toolCalls`-only messages (no parts/segments) still emit tool_use + tool_result.
 */
function messageToApiContent(msg: { role: string; content: unknown; parts?: Array<{ type: string; content?: string; toolCall?: { id: string; name: string; args?: Record<string, unknown>; result?: string; thoughtSignature?: string } }>; segments?: Array<{ type: string; content?: string; toolCall?: { id: string; name: string; args?: Record<string, unknown>; result?: string; thoughtSignature?: string } }>; toolCalls?: MessageToolCall[] }): {
  modelContent: string | Array<{ type: string; id?: string; text?: string; name?: string; input?: Record<string, unknown>; thoughtSignature?: string }>;
  toolResults?: Array<{ type: 'tool_result'; tool_use_id: string; content: string; name?: string }>;
} {
  const strOrArr = msg.content as string | Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  if (msg.role !== 'assistant') {
    return { modelContent: strOrArr };
  }
  const parts = getMessageParts(msg as Message);
  if (parts.length === 0) {
    // Raw API-shaped content (array blocks) without parts — still normalize tool_use + synthetic tool_result
    if (Array.isArray(msg.content)) {
      const modelBlocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; thoughtSignature?: string }> = [];
      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; name?: string }> = [];
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; thoughtSignature?: string };
        if (b.type === 'text') {
          modelBlocks.push({ type: 'text', text: b.text ?? '' });
        } else if (b.type === 'tool_use' && b.id) {
          modelBlocks.push({
            type: 'tool_use',
            id: b.id,
            name: b.name,
            input: b.input ?? {},
            thoughtSignature: b.thoughtSignature,
          } as { type: string; id?: string; name?: string; input?: Record<string, unknown>; thoughtSignature?: string });
          toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: '[cancelled]' });
        }
      }
      if (modelBlocks.some((x) => (x as { type?: string }).type === 'tool_use')) {
        return {
          modelContent: modelBlocks,
          toolResults: toolResults.length > 0 ? toolResults : undefined,
        };
      }
    }
    return { modelContent: strOrArr };
  }
  const modelBlocks: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown>; thoughtSignature?: string }> = [];
  const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; name?: string }> = [];
  for (const p of parts) {
    if (p.type === 'text' && p.content) {
      modelBlocks.push({ type: 'text', text: p.content });
    } else if (p.type === 'reasoning' && p.content?.trim()) {
      modelBlocks.push({ type: 'text', text: formatPriorThoughtForApi(p.content) });
    } else if (p.type === 'tool' && p.toolCall) {
      const tc = p.toolCall;
      modelBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.args ?? {},
        thoughtSignature: tc.thoughtSignature,
      } as { type: string; id?: string; name?: string; input?: Record<string, unknown>; thoughtSignature?: string });
      // Anthropic requires a tool_result for every tool_use in the prior turn. Missing results
      // (interrupted stream, persistence gap, or new user message before completion) must not
      // leave orphaned tool_use blocks — use a placeholder so normalizeConversationHistory can pair.
      let resultContent: string;
      if (tc.result !== undefined && tc.result !== null) {
        if (typeof tc.result === 'string') {
          resultContent = tc.result;
        } else if (typeof tc.result === 'object' && tc.result !== null) {
          try {
            resultContent = formatResult(tc.result);
          } catch {
            resultContent = String(tc.result);
          }
          console.warn('[aiService] Tool result is non-string — serialized to TOON for API payload', { id: tc.id, name: tc.name });
        } else {
          resultContent = String(tc.result);
        }
      } else {
        resultContent = '[cancelled]';
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: resultContent,
      });
    }
  }
  if (modelBlocks.length === 0 && !msg.content) {
    return { modelContent: '' };
  }
  if (modelBlocks.length === 0) {
    return { modelContent: strOrArr, toolResults: toolResults.length > 0 ? toolResults : undefined };
  }
  return {
    modelContent: modelBlocks,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
  };
}

type ApiMessage = { role: string; content: unknown };

function toolResultIdFromBlock(block: Record<string, unknown>): string | undefined {
  const snake = block.tool_use_id;
  const camel = (block as { toolUseId?: unknown }).toolUseId;
  if (typeof snake === 'string') return snake;
  if (typeof camel === 'string') return camel;
  return undefined;
}

/** True when this block is a user-side tool_result for Anthropic ordering. */
function isAnthropicToolResultBlock(block: Record<string, unknown>): boolean {
  const tid = toolResultIdFromBlock(block);
  if (!tid) return false;
  const t = block.type;
  if (t === 'tool_result') return true;
  // Serialized paths may omit type while preserving tool_use_id
  if (t === undefined || t === null) return true;
  return false;
}

function normalizeAnthropicToolResultBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  const tid = toolResultIdFromBlock(block);
  if (!tid) return null;
  const t = block.type;
  if (t !== 'tool_result' && t !== undefined && t !== null) return null;
  const normalized: Record<string, unknown> = { ...block, type: 'tool_result', tool_use_id: tid };
  delete (normalized as { toolUseId?: unknown }).toolUseId;
  return normalized;
}

function normalizeAnthropicUserContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    return normalizeAnthropicToolResultBlock(block as Record<string, unknown>) ?? block;
  });
}

function hasToolResultBlocks(content: unknown): boolean {
  return Array.isArray(content)
    && content.some(
      (block) => typeof block === 'object'
        && block !== null
        && (
          isAnthropicToolResultBlock(block as Record<string, unknown>)
          || (block as { type?: string }).type === 'tool_result'
        ),
    );
}

function collectToolUseIdsFromBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if ((block as { type?: string }).type === 'tool_use') {
      const id = (block as { id?: string }).id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

function collectToolResultIdsFromBlocks(content: unknown): Set<string> {
  const s = new Set<string>();
  if (!Array.isArray(content)) return s;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (isAnthropicToolResultBlock(b)) {
      const tid = toolResultIdFromBlock(b);
      if (tid) s.add(tid);
    }
  }
  return s;
}

/**
 * Anthropic requires the user message after tool_use to lead with tool_result blocks,
 * in the same order as tool_use blocks in the assistant turn. Text or other blocks
 * must come after all tool_results.
 */
function reorderUserContentAfterAssistantToolUses(assistantContent: unknown, userContent: unknown): unknown {
  if (!Array.isArray(userContent)) return userContent;
  const order = collectToolUseIdsFromBlocks(assistantContent);
  if (order.length === 0) return userContent;

  const trById = new Map<string, Record<string, unknown>>();
  const nonTr: unknown[] = [];
  for (const block of userContent) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (!isAnthropicToolResultBlock(b)) {
      nonTr.push(block);
      continue;
    }
    const tid = toolResultIdFromBlock(b);
    if (tid) trById.set(tid, b);
    else nonTr.push(block);
  }

  const orderedTr: unknown[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const block = trById.get(id);
    if (block) {
      orderedTr.push(block);
      seen.add(id);
    }
  }
  for (const [id, block] of trById) {
    if (!seen.has(id)) orderedTr.push(block);
  }
  return [...orderedTr, ...nonTr];
}

function forceAnthropicToolResultCoverage(assistantContent: unknown, userContent: unknown): unknown {
  const order = collectToolUseIdsFromBlocks(assistantContent);
  if (order.length === 0) return normalizeAnthropicUserContent(userContent);

  const normalized = normalizeAnthropicUserContent(userContent);
  const covered = collectToolResultIdsFromBlocks(normalized);
  const missing = order.filter((id) => !covered.has(id));
  const withCoverage = missing.length > 0 ? prependCancelledToolResults(normalized, missing) : normalized;
  const reordered = reorderUserContentAfterAssistantToolUses(assistantContent, withCoverage);
  const afterIds = collectToolResultIdsFromBlocks(reordered);
  if (order.every((id) => afterIds.has(id))) {
    return reordered;
  }

  const canonicalized = normalizeAnthropicUserContent(withCoverage);
  if (!Array.isArray(canonicalized)) {
    return order.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '[cancelled]' }));
  }

  const toolResultsById = new Map<string, Record<string, unknown>>();
  const nonTr: unknown[] = [];
  for (const block of canonicalized) {
    if (!block || typeof block !== 'object') {
      nonTr.push(block);
      continue;
    }
    const normalizedBlock = normalizeAnthropicToolResultBlock(block as Record<string, unknown>);
    if (normalizedBlock) {
      const tid = toolResultIdFromBlock(normalizedBlock);
      if (tid && !toolResultsById.has(tid)) toolResultsById.set(tid, normalizedBlock);
      continue;
    }
    nonTr.push(block);
  }

  return [
    ...order.map((id) => toolResultsById.get(id) ?? { type: 'tool_result', tool_use_id: id, content: '[cancelled]' }),
    ...nonTr,
  ];
}

/** Move all tool_result blocks before any text (WM/CTX may have been appended as trailing text blocks). */
function partitionUserContentBlocksToolResultsFirst(
  blocks: Array<{ type: string; text?: string; name?: string; content?: string; tool_use_id?: string }>,
): Array<{ type: string; text?: string; name?: string; content?: string; tool_use_id?: string }> {
  const tr = blocks.filter((b) => isAnthropicToolResultBlock(b as unknown as Record<string, unknown>));
  const rest = blocks.filter((b) => !isAnthropicToolResultBlock(b as unknown as Record<string, unknown>));
  return [...tr, ...rest];
}

function prependCancelledToolResults(content: unknown, missingIds: string[]): unknown {
  const blocks = missingIds.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: '[cancelled]' }));
  if (typeof content === 'string') {
    return [...blocks, { type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return [...blocks, ...content];
  }
  return [...blocks, { type: 'text', text: String(content ?? '') }];
}

/**
 * Provider-agnostic tool pairing repair. All providers require:
 * - Every assistant tool_use has a matching user tool_result (orphans get [cancelled])
 * - No orphaned tool_result without a preceding tool_use
 * - Alternating user/assistant roles (consecutive same-role merged)
 * - tool_result blocks ordered first in user message after tool_use
 *
 * When provider is 'anthropic', also strips non-standard fields (thoughtSignature)
 * from tool_use blocks since the Anthropic API rejects them.
 */
function repairToolPairing(messages: ApiMessage[], provider?: string): ApiMessage[] {
  const isAnthropic = provider === 'anthropic';
  const out: ApiMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Forward repair: assistant with tool_use must have following user with tool_result
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Anthropic: strip thoughtSignature + reorder text before tool_use.
      // Other providers: keep fields but still ensure pairing.
      const stripped = isAnthropic
        ? msg.content.map((block: Record<string, unknown>) => {
            if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_use') {
              const { thoughtSignature: _, ...rest } = block as Record<string, unknown>;
              return rest;
            }
            return block;
          })
        : (msg.content as Record<string, unknown>[]);
      const nonToolUse = stripped.filter((b: Record<string, unknown>) => (b as { type?: string }).type !== 'tool_use');
      const toolUse = stripped.filter((b: Record<string, unknown>) => (b as { type?: string }).type === 'tool_use');
      const cleanedContent = isAnthropic && toolUse.length > 0 && nonToolUse.length > 0
        ? [...nonToolUse, ...toolUse]
        : stripped;
      const cleanedMsg = { ...msg, content: cleanedContent };

      const toolUseIds = collectToolUseIdsFromBlocks(cleanedContent);
      if (toolUseIds.length > 0) {
        const next = messages[i + 1];
        const covered = next?.role === 'user' ? collectToolResultIdsFromBlocks(next.content) : new Set<string>();
        const missing = toolUseIds.filter((id) => !covered.has(id));
        out.push(cleanedMsg);
        if (missing.length > 0) {
          if (next?.role === 'user') {
            out.push({ role: 'user', content: forceAnthropicToolResultCoverage(cleanedContent, next.content) });
            i++;
          } else {
            out.push({
              role: 'user',
              content: missing.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '[cancelled]' })),
            });
          }
        } else if (next?.role === 'user') {
          out.push({ role: 'user', content: normalizeAnthropicUserContent(next.content) });
          i++;
        }
        continue;
      }
      out.push(cleanedMsg);
      continue;
    }

    // Backward repair: user with tool_result must be preceded by assistant with matching tool_use
    if (msg.role === 'user' && hasToolResultBlocks(msg.content) && Array.isArray(msg.content)) {
      const prev = out[out.length - 1];
      const prevToolUseIds = prev?.role === 'assistant'
        ? new Set(collectToolUseIdsFromBlocks(prev.content))
        : new Set<string>();

      if (prevToolUseIds.size === 0) {
        const filtered = (msg.content as Array<Record<string, unknown>>).filter(
          (block) => !(
            block && typeof block === 'object'
            && (
              isAnthropicToolResultBlock(block)
              || (block as { type?: string }).type === 'tool_result'
            )
          ),
        );
        if (filtered.length > 0) {
          out.push({ role: 'user', content: filtered });
        } else {
          console.warn('[aiService] Dropped orphaned tool_result user message at index', i);
        }
        continue;
      }
    }

    out.push(msg);
  }

  // Final safety net: repair any remaining mispairing the main loop missed
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const ids = collectToolUseIdsFromBlocks(m.content);
      if (ids.length > 0) {
        const next = out[i + 1];
        const covered = next?.role === 'user' ? collectToolResultIdsFromBlocks(next.content) : new Set<string>();
        const uncovered = ids.filter((id) => !covered.has(id));
        if (uncovered.length > 0) {
          console.error('[aiService] PAIRING BUG after repair — inserting synthetic tool_results for:', uncovered, 'at msg index', i);
          if (next?.role === 'user') {
            out[i + 1] = { role: 'user', content: forceAnthropicToolResultCoverage(m.content, next.content) };
          } else {
            out.splice(i + 1, 0, {
              role: 'user',
              content: uncovered.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '[cancelled]' })),
            });
          }
        }
      }
    }
  }

  // Merge consecutive same-role messages (required by Anthropic/Gemini, good hygiene for OpenAI).
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i].role === out[i - 1].role) {
      const prev = out[i - 1];
      const curr = out[i];
      const prevBlocks = Array.isArray(prev.content) ? prev.content as unknown[] : typeof prev.content === 'string' ? [{ type: 'text', text: prev.content }] : [{ type: 'text', text: String(prev.content ?? '') }];
      const currBlocks = Array.isArray(curr.content) ? curr.content as unknown[] : typeof curr.content === 'string' ? [{ type: 'text', text: curr.content }] : [{ type: 'text', text: String(curr.content ?? '') }];
      out[i - 1] = { role: prev.role, content: [...prevBlocks, ...currBlocks] };
      out.splice(i, 1);
    }
  }

  // User message after tool_use must start with tool_result blocks in tool_use order.
  for (let i = 0; i < out.length - 1; i++) {
    const a = out[i];
    const b = out[i + 1];
    if (a.role !== 'assistant' || b.role !== 'user') continue;
    if (!Array.isArray(a.content)) continue;
    const needIds = collectToolUseIdsFromBlocks(a.content);
    if (needIds.length === 0) continue;
    const reordered = forceAnthropicToolResultCoverage(a.content, b.content);
    const afterIds = collectToolResultIdsFromBlocks(reordered);
    const ok = needIds.every((id) => afterIds.has(id));
    if (!ok) {
      console.error('[aiService] tool_result finalization failed — forcing cancelled placeholders', {
        needIds,
        had: [...collectToolResultIdsFromBlocks(b.content)],
        after: [...afterIds],
      });
    }
    out[i + 1] = { role: 'user', content: reordered };
  }

  return out;
}

export function prepareAnthropicMessagesForApi(messages: Array<{ role: string; content: unknown }>): Array<{ role: string; content: unknown }> {
  return repairToolPairing(messages.map((msg) => ({ role: msg.role, content: msg.content })), 'anthropic');
}

function normalizeConversationHistory(messages: ChatMessage[]): ApiMessage[] {
  const normalized: ApiMessage[] = [];
  let pendingToolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; name?: string }> | null = null;

  for (const msg of messages) {
    if (pendingToolResults?.length && msg.role !== 'user') {
      normalized.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = null;
    }

    if (msg.role === 'assistant') {
      const { modelContent, toolResults } = messageToApiContent(msg);
      const hasToolUse = Array.isArray(modelContent) && modelContent.some((block: any) => block.type === 'tool_use');
      normalized.push({ role: 'assistant', content: modelContent });
      if (hasToolUse) {
        const merged = [...(toolResults ?? [])];
        if (Array.isArray(modelContent)) {
          const seen = new Set(merged.map((r) => r.tool_use_id));
          for (const block of modelContent) {
            if ((block as { type?: string }).type !== 'tool_use') continue;
            const id = (block as { id?: string }).id;
            if (id && !seen.has(id)) {
              merged.push({ type: 'tool_result', tool_use_id: id, content: '[cancelled]' });
              seen.add(id);
            }
          }
        }
        if (merged.length > 0) {
          pendingToolResults = merged;
        }
      }
      continue;
    }

    if (msg.role === 'user' && pendingToolResults?.length) {
      const parts: Array<{ type: string; text?: string; name?: string; content?: string; tool_use_id?: string }> = [...pendingToolResults];
      pendingToolResults = null;
      if (typeof msg.content === 'string') {
        parts.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (typeof block === 'object' && block && 'type' in block) {
            parts.push(block as any);
          } else if (typeof block === 'object' && block && 'text' in block) {
            parts.push({ type: 'text', text: (block as { text?: string }).text ?? '' });
          }
        }
      }
      normalized.push({ role: 'user', content: parts });
      continue;
    }

    normalized.push({ role: msg.role, content: msg.content });
  }

  if (pendingToolResults?.length) {
    normalized.push({ role: 'user', content: pendingToolResults });
  }

  return normalized;
}

/**
 * Prepare user content for the current round.
 * State/context injection has been removed — this only handles recency suffix
 * and tool_result block ordering.
 */
function injectCurrentRoundUserContent(
  content: unknown,
  recencySuffix: string,
): unknown {
  const userContentBlocks: Array<{ type: string; text?: string; name?: string; content?: string; tool_use_id?: string }> = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block && 'type' in block) {
        userContentBlocks.push(block as any);
      } else if (typeof block === 'object' && block && 'text' in block) {
        userContentBlocks.push({ type: 'text', text: (block as { text?: string }).text ?? '' });
      }
    }
    if (recencySuffix) {
      const lastTextIdx = userContentBlocks.map((block, index) => (block.type === 'text' ? index : -1)).filter(index => index >= 0).pop();
      if (lastTextIdx != null && lastTextIdx >= 0) {
        const target = userContentBlocks[lastTextIdx] as { text?: string };
        target.text = (target.text || '') + recencySuffix;
      } else if (userContentBlocks.length > 0) {
        userContentBlocks.push({ type: 'text', text: recencySuffix });
      }
    }
    return partitionUserContentBlocksToolResultsFirst(userContentBlocks);
  }

  if (typeof content === 'string') {
    return `${content}${recencySuffix}`;
  }

  if (content == null && recencySuffix) {
    return recencySuffix;
  }

  return content;
}

/**
 * Build the full state block: dynamic context + staged snippets + working memory.
 * This is assembled fresh each round and NEVER persisted into conversationHistory.
 */
function buildStateBlock(
  dynamicContextBlock: string,
  mode: ChatMode,
): string {
  useContextStore.getState().markStagedSnippetsUsed();
  const stagedBlock = useContextStore.getState().getStagedBlock();
  let stateContent = dynamicContextBlock;
  if (mode !== 'ask' && stagedBlock) {
    stateContent = stateContent
      ? `${stagedBlock}\n\n${stateContent}`
      : stagedBlock;
  }
  const workingMemory = buildWorkingMemoryBlock();
  const parts: string[] = [];
  if (stateContent) parts.push(stateContent);
  if (workingMemory) parts.push(workingMemory);
  return parts.join('\n\n');
}

/**
 * Assemble the final message array for the provider.
 * State is kept separate from durable history — never merged into transcript turns.
 * State is injected into the LAST user message of the assembled payload (after BP3),
 * so it lives in the uncached tail and does not break prefix caching.
 * For Gemini: state goes via the dynamicContext parameter to the Rust backend.
 */
function assembleProviderMessages(
  durableHistory: ApiMessage[],
  provider: AIProvider,
  mode: ChatMode,
  dynamicContextBlock: string,
): { messages: ApiMessage[]; geminiDynamicContext: string } {
  const layeredMessages: ApiMessage[] = [];
  const isGemini = provider === 'google' || provider === 'vertex';
  let geminiDynamicContext = '';

  const stateBlock = buildStateBlock(dynamicContextBlock, mode);

  let lastUserIndex = -1;
  for (let i = durableHistory.length - 1; i >= 0; i--) {
    if (durableHistory[i].role === 'user') { lastUserIndex = i; break; }
  }

  for (let i = 0; i < durableHistory.length; i++) {
    const msg = durableHistory[i];
    if (i === lastUserIndex) {
      // BP3: append-only conversation history cache. The marker goes on the
      // last prior turn — no BB/dormant suffix, just the boundary. History
      // compression is deferred to round 0, so within a tool loop the prefix
      // is byte-identical and Anthropic serves cache reads (0.1x).
      if (i > 0 && !isGemini) {
        const prevMsg = layeredMessages[layeredMessages.length - 1];
        if (prevMsg) {
          const prevHasToolUse = Array.isArray(prevMsg.content) && (prevMsg.content as Array<{type?: string}>).some(b => b.type === 'tool_use');
          if (prevHasToolUse) {
            const earlierMsg = layeredMessages.length >= 2 ? layeredMessages[layeredMessages.length - 2] : undefined;
            if (earlierMsg) _appendBoundaryMarker(earlierMsg);
          } else {
            _appendBoundaryMarker(prevMsg);
          }
        }
      }

      const recencySuffix = isGemini ? `\n${GEMINI_RECENCY_BOOST}` : '';

      if (isGemini) {
        geminiDynamicContext = stateBlock;
      }

      // Non-Gemini: inject state into the last user message of the ASSEMBLED
      // payload (not conversationHistory). State lives AFTER BP3 in the
      // uncached tail so it never breaks prefix caching.
      const cleanContent = injectCurrentRoundUserContent(msg.content, recencySuffix);
      const contentWithState = (!isGemini && stateBlock)
        ? prependStateToContent(stateBlock, cleanContent)
        : cleanContent;

      layeredMessages.push({
        role: 'user',
        content: contentWithState,
      });
      continue;
    }

    layeredMessages.push({
      role: msg.role,
      content: Array.isArray(msg.content)
        ? (msg.content as unknown[]).map(b => ({ ...(b as Record<string, unknown>) }))
        : msg.content,
    });
  }

  return { messages: layeredMessages, geminiDynamicContext };
}

/**
 * Prepend state block to user content for the assembled payload.
 * For array content: inserts state as a text block after tool_result blocks
 * (which must come first for Anthropic) but before other text.
 * For string content: prepends state before user text.
 */
function prependStateToContent(stateBlock: string, content: unknown): unknown {
  if (Array.isArray(content)) {
    const blocks = content as Array<{ type: string; text?: string; tool_use_id?: string; content?: string }>;
    const toolResults = blocks.filter(b => b.type === 'tool_result');
    const rest = blocks.filter(b => b.type !== 'tool_result');
    return [...toolResults, { type: 'text', text: stateBlock }, ...rest];
  }
  if (typeof content === 'string') {
    return `${stateBlock}\n\n${content}`;
  }
  if (content == null) {
    return stateBlock;
  }
  return content;
}

/** Mirrors the Rust ResolvedHashContent struct for invoke('resolve_hash_ref') results. */
interface ResolvedHashContent {
  source: string | null;
  content: string;
  total_lines: number;
  lang: string | null;
  shape_applied: string | null;
  highlight_ranges: [number, number | null][] | null;
  target_range?: [number, number | null][] | null;
  actual_range?: [number, number | null][] | null;
  context_lines?: number | null;
  is_diff: boolean;
}

/**
 * Tool call event for streaming callbacks (doesn't need startTime - store adds it)
 */
export interface ToolCallEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  thoughtSignature?: string;
  syntheticChildren?: ToolCallEvent[];
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onToolCall: (toolCall: ToolCallEvent) => void;
  onToolResult: (id: string, result: string) => void;
  onUsageUpdate: (usage: ContextUsage) => void;
  onError: (error: Error) => void;
  onDone: () => void;
  onClear?: () => void;
  /** Subagent progress from delegate.* batch steps */
  onSubagentProgress?: (stepId: string, progress: import('./batch/types').SubAgentProgressEvent) => void;
  // Typed stream protocol callbacks
  onTextStart?: (id: string) => void;
  onTextEnd?: (id: string) => void;
  onReasoningStart?: (id: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onReasoningEnd?: (id: string) => void;
  onToolInputStart?: (toolCallId: string, toolName: string) => void;
  onToolInputDelta?: (toolCallId: string, delta: string) => void;
  onToolInputAvailable?: (toolCallId: string, toolName: string, input: Record<string, unknown>, thoughtSignature?: string) => void;
  onStepStart?: () => void;
  onStepEnd?: () => void;
  onStreamError?: (errorText: string) => void;
  onStatus?: (message: string) => void;
}

export interface AIConfig {
  provider: AIProvider;
  model: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  systemPrompt?: string;
  projectId?: string;
  region?: string;
  baseUrl?: string;
  /** Anthropic beta headers (e.g. ["context-1m-2025-08-07"] for 1M context) */
  anthropicBeta?: string[];
  /** OpenAI GPT-5 family: sent as `text.verbosity` on Responses API; Chat Completions unchanged */
  outputVerbosity?: 'low' | 'medium' | 'high';
  /**
   * Reasoning effort string.
   * - OpenAI: `reasoning.effort` (Responses) or `reasoning_effort` (Chat Completions)
   * - Anthropic adaptive-thinking models (Opus 4.7, Opus 4.6, Sonnet 4.6, Mythos):
   *   sent as `output_config.effort` together with `thinking.type: "adaptive"`
   */
  reasoningEffort?: string;
  /**
   * Anthropic (legacy models: Sonnet 4.5, Opus 4.5, Haiku 4.5, 3.7, ...) thinking
   * budget_tokens; or Gemini `thinkingConfig.thinkingBudget`.
   * null = disabled. Ignored on Anthropic adaptive-thinking models — use
   * `reasoningEffort` instead.
   */
  thinkingBudget?: number | null;
}

/**
 * Project profile for AI context (matches backend)
 */
export interface EntryManifestEntry {
  path: string;
  sig: string;
  tokens: number;
  lines: number;
  importance: number;
  method: 'naming' | 'graph' | 'both';
  tier: 'full' | 'summary';
}

export type EntryManifestDepth = 'off' | 'paths' | 'sigs' | 'paths_sigs';

/**
 * ## Entry Points block for BP1 (main chat) or subagent system prompt.
 * Returns empty string when depth is off or there is nothing to show.
 */
export function formatEntryManifestSection(
  entryManifest: EntryManifestEntry[] | undefined,
  entryManifestDepth: EntryManifestDepth | undefined,
): string {
  if (!entryManifestDepth || entryManifestDepth === 'off' || !entryManifest?.length) {
    return '';
  }
  const pathList = entryManifest.map(e => `${e.path} (${e.method}, ${e.lines}L)`).join(' | ');
  const sigLines = entryManifest
    .filter(e => e.sig && e.tokens > 0)
    .map(e => e.sig);
  if (entryManifestDepth === 'paths') {
    return `\n\n## Entry Points\n${pathList}`;
  }
  if (entryManifestDepth === 'sigs') {
    if (sigLines.length > 0) {
      return `\n\n## Entry Points\n${sigLines.join('\n')}`;
    }
    return '';
  }
  const body =
    sigLines.length > 0 ? `${pathList}\n\n${sigLines.join('\n')}` : pathList;
  return `\n\n## Entry Points\n${body}`;
}

export interface ProjectProfile {
  proj: string;
  stats: { files: number; loc: number; langs: Record<string, number> };
  stack: string[];
  arch: { mods: string[]; entry: string[] };
  health: { issues: { h: number; m: number; l: number }; hotspots: string[]; cats: Record<string, number> };
  patterns: string[];
  deps: { prod: string[]; dev: string[] };
  workspaces: WorkspaceEntry[];
  entryManifest?: EntryManifestEntry[];
}

/**
 * Workspace context for AI - provides situational awareness
 */
export interface WorkspaceContext {
  /** Full project profile from ATLS */
  profile: ProjectProfile | null;
  /** Currently focused file path */
  activeFile: string | null;
  /** Cursor line in active file */
  cursorLine?: number;
  /** Selected text in editor (if any) */
  selectedText?: string;
  /** Open file tabs */
  openFiles?: string[];
  /** Git branch */
  gitBranch?: string;
  /** Operating system */
  os?: 'windows' | 'linux' | 'macos';
  /** Default shell */
  shell?: string;
  /** Project root / working directory */
  cwd?: string;
  /** Whether ATLS tools are available */
  atlsReady?: boolean;
  /** Active focus profile (included when AI context toggle is on) */
  focusProfile?: { name: string; matrix: Record<string, string[]> };
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: AIProvider;
  contextWindow?: number;
  description?: string;
}

// ============================================================================
// Provider Configuration (for reference)
// ============================================================================
// Anthropic: https://api.anthropic.com/v1/messages
// OpenAI: Chat Completions (gpt-4*) + Responses API (o1/o3/o4/gpt-5*)
// Google: https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent
// Vertex: https://{region}-aiplatform.googleapis.com/v1/projects/{projectId}/locations/{region}/publishers/google/models/{model}:streamGenerateContent

// NOTE: No default models - all models are fetched dynamically from provider APIs
// Pricing is maintained in costStore.ts using prefix matching

// ============================================================================
// Models Fetching
// ============================================================================

/**
 * Fetch available models from a provider
 */

// Tauri-based model fetching (bypasses CORS)





// ============================================================================

/**
 * Tool call tracking for streaming
 */
interface PendingToolCall {
  id: string;
  name: string;
  /** JSON-serialized tool input for stream/UI replay — storage shape, not TOON. */
  inputJson: string;
  thoughtSignature?: string;
}

/**
 * ChatSessionContext — encapsulates per-session mutable state that was previously
 * scattered across module-level globals. Readers access the current session via
 * _activeSession; writers create a new session at chat start.
 */
interface ChatSessionContext {
  abortController: AbortController;
  activeStreamIds: Set<string>;
  isSwarmAgent: boolean;
  toolLoopState: ToolLoopState | null;
  sessionId: number;
}

// Current active session — replaced atomically at chat start
let _activeSession: ChatSessionContext | null = null;

// Legacy accessors — derived from _activeSession; kept for compatibility
let currentAbortController: AbortController | null = null;
let _isSwarmAgentContext = false;

type ToolLoopState = {
  conversationHistory: Array<{ role: string; content: unknown }>;
  round: number;
  priorTurnBoundary: number;
};
let _toolLoopState: ToolLoopState | null = null;
let _roundHadMutations = false;
let _hadVerification = false;
let _nextSessionId = 0;

function setToolLoopState(
  conversationHistory: Array<{ role: string; content: unknown }>,
  round: number,
  priorTurnBoundary: number
): void {
  const state = { conversationHistory, round, priorTurnBoundary };
  _toolLoopState = state;
  if (_activeSession) _activeSession.toolLoopState = state;
}

function createChatSession(isSwarm: boolean): ChatSessionContext {
  // Abort prior session so we never have overlapping sessions; prevents stale
  // finally-block from clearing state belonging to this new session
  const prior = _activeSession;
  if (prior) {
    prior.abortController.abort();
    prior.activeStreamIds.clear();
    invoke('cancel_all_chat_streams').catch((err) => {
      console.warn('[aiService] cancel_all_chat_streams failed:', err);
    });
    _activeSession = null;
    currentAbortController = null;
  }
  resetMainAgentTerminal();
  invalidateHistoryCache();
  // Spin circuit-breaker state is per-session: reset so a fresh chat doesn't
  // inherit the previous session's escalation streak.
  resetSpinCircuitBreaker();
  // ASSESS steering: clear sidecar + dedupe so a new chat starts clean.
  resetAssessContext();
  // Auto-pin telemetry: drain the round-scoped counters so a new session
  // doesn't inherit stale auto-pin metrics from the prior chat.
  resetAutoPinTelemetry();

  const controller = new AbortController();
  const session: ChatSessionContext = {
    abortController: controller,
    activeStreamIds: new Set(),
    isSwarmAgent: isSwarm,
    toolLoopState: null,
    sessionId: ++_nextSessionId,
  };
  _activeSession = session;
  currentAbortController = controller;
  _isSwarmAgentContext = isSwarm;
  return session;
}

/** Get the active session's abort signal. Safe for guards. */
export function getActiveSession(): ChatSessionContext | null {
  return _activeSession;
}

// Rate limiting constants
const TOOL_LOOP_DELAY_MS = 150; // Delay between API calls in tool loop to reduce idle churn while keeping provider pacing
const MAX_CONCURRENT_TOOLS = 3; // Max parallel tool executions — keeps machine load manageable

/**
 * Sleep helper for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Heuristics to detect whether an end_turn response looks "done" vs. needing continuation.
 * Returns true when the model appears to have finished its work intentionally.
 */
function looksLikeNaturalStop(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Asking the user a question — stop and wait for their reply
  if (/\?\s*$/.test(trimmed)) return true;

  // Conversational closure phrases (case-insensitive, near end of text)
  const tail = trimmed.slice(-300).toLowerCase();
  const closurePhrases = [
    'let me know', 'anything else', 'if you need', 'happy to help',
    'feel free to', 'hope that helps', 'does that', 'is there anything',
    'ready when you are', 'shall i', 'want me to',
  ];
  if (closurePhrases.some(p => tail.includes(p))) return true;

  return false;
}

function looksLikeStructuredToolPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return false;
  return trimmed.includes('"type":"tool_use"')
    || trimmed.includes('"type": "tool_use"')
    || trimmed.includes('"type":"tool_result"')
    || trimmed.includes('"type": "tool_result"')
    || trimmed.includes('"type":\n"tool_use"')
    || trimmed.includes('"type":\n"tool_result"');
}

/**
 * Check whether the active task plan has all subtasks marked done.
 */
/**
 * Execute promises with concurrency limit (abort-aware).
 * Skips remaining tasks once the abort signal fires.
 */
/**
 * Stop the current chat generation.
 * Aborts the frontend controller AND kills ALL backend HTTP streams.
 */
export function stopChat(): void {
  const session = getActiveSession();
  if (session) {
    session.abortController.abort();
    session.activeStreamIds.clear();
    _activeSession = null;
    currentAbortController = null;
    invoke('cancel_all_chat_streams').catch((err) => {
      console.warn('[aiService] cancel_all_chat_streams failed:', err);
    });
    // Ensure UI exits generating state synchronously
    useAppStore.getState().setIsGenerating(false);
    const prog = useAppStore.getState().agentProgress;
    if (prog.status !== 'stopped' && prog.status !== 'idle') {
      useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'aborted' });
    }
    console.log('[aiService] Chat stopped by user');
  }
}

/**
 * Check if chat is currently running
 */
export function isChatRunning(): boolean {
  return currentAbortController !== null;
}

const WIRE_LOG_DELTA_MAX = 160;
const WIRE_LOG_TOOL_INPUT_MAX = 2400;

function truncateForWireLog(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

/** Compact stream chunk for debug log (avoid multi-megabyte lines from deltas). */
function streamChunkToLogPayload(chunk: StreamChunk): Record<string, unknown> {
  switch (chunk.type) {
    case 'text_delta':
      return { type: chunk.type, id: chunk.id, delta: truncateForWireLog(chunk.delta, WIRE_LOG_DELTA_MAX), deltaLen: chunk.delta.length };
    case 'reasoning_delta':
      return { type: chunk.type, id: chunk.id, delta: truncateForWireLog(chunk.delta, WIRE_LOG_DELTA_MAX), deltaLen: chunk.delta.length };
    case 'tool_input_delta':
      return {
        type: chunk.type,
        tool_call_id: chunk.tool_call_id,
        preview: truncateForWireLog(chunk.input_text_delta, 200),
        len: chunk.input_text_delta.length,
      };
    case 'tool_input_available': {
      const raw = JSON.stringify(chunk.input);
      return {
        type: chunk.type,
        tool_call_id: chunk.tool_call_id,
        tool_name: chunk.tool_name,
        input: truncateForWireLog(raw, WIRE_LOG_TOOL_INPUT_MAX),
        inputLen: raw.length,
      };
    }
    case 'usage':
      return {
        type: chunk.type,
        input_tokens: chunk.input_tokens,
        output_tokens: chunk.output_tokens,
        cache_creation_input_tokens: chunk.cache_creation_input_tokens,
        cache_read_input_tokens: chunk.cache_read_input_tokens,
        openai_cached_tokens: chunk.openai_cached_tokens,
        cached_content_tokens: chunk.cached_content_tokens,
      };
    case 'stop_reason':
      return { type: chunk.type, reason: chunk.reason };
    case 'status':
      return { type: chunk.type, message: chunk.message };
    case 'error':
      return { type: chunk.type, error_text: truncateForWireLog(chunk.error_text, 500) };
    case 'text_start':
    case 'text_end':
    case 'reasoning_start':
    case 'reasoning_end':
      return { type: chunk.type, id: chunk.id };
    case 'tool_input_start':
      return { type: chunk.type, tool_call_id: chunk.tool_call_id, tool_name: chunk.tool_name };
    case 'start_step':
    case 'finish_step':
    case 'done':
      return { type: chunk.type };
    default: {
      const u = chunk as { type?: string };
      return { type: u.type ?? 'unknown' };
    }
  }
}

function appendStreamWireLogLine(round: number, streamId: string, chunk: StreamChunk): void {
  // Omit per-token tool JSON streaming — it can emit hundreds of lines per call and evicts the ring buffer.
  // tool_input_start (name + id) and tool_input_available (truncated full args) stay in the log.
  if (chunk.type === 'tool_input_delta') return;
  const payload = streamChunkToLogPayload(chunk);
  const line = `${new Date().toISOString()}\tR${round}\t${streamId.slice(0, 8)}\t${JSON.stringify(payload)}`;
  useAppStore.getState().pushStreamWireLogLine(line);
}

/**
 * Stream chat via Tauri backend - handles all providers
 * Implements full tool loop: AI → tools → AI → tools → ... → done
 */
async function streamChatViaTauri(
  config: AIConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  mode: ChatMode = 'agent',
  dynamicContextInput?: { workspaceContext?: WorkspaceContext; projectTree?: string; isFirstTurn?: boolean },
): Promise<void> {
  // Guarantee cross-store accessors are wired before any tool/context resolution
  ensureAiServiceWiring();

  // Round-refresh resolver: fetch current content hashes for context sources so advanceTurn hook can reconcile
  setRoundRefreshRevisionResolver(async (path: string) => {
    const sessionId = typeof localStorage !== 'undefined' ? localStorage.getItem('current_session_id') : null;
    const syncLookup = createHashLookup(sessionId);
    const setLookup = useContextStore.getState().createSetRefLookup();
    const result = await invokeWithTimeout(
      'atls_batch_query',
      { operation: 'context', params: { type: 'full', file_paths: [path] }, sessionId, hashLookup: syncLookup, setLookup },
      15000,
    );
    const entries = (result as Record<string, unknown>)?.results;
    const first = Array.isArray(entries) ? entries[0] : undefined;
    const hash = first && typeof first === 'object' ? (first as Record<string, unknown>).content_hash ?? (first as Record<string, unknown>).hash : undefined;
    return typeof hash === 'string' ? hash : null;
  });

  // Determine if tools are enabled based on mode
  // Ask: no tools (pure conversation)
  // All other modes (including retriever): tools enabled
  const toolsEnabled = areToolsEnabledForProvider(config.provider, mode);
  
  // Reset continuation state when starting new chat
  useAppStore.getState().setAgentCanContinue(false);

  // Create scoped session context (replaces legacy module globals atomically)
  const session = createChatSession(false);
  const abortSignal = session.abortController.signal;

  const sessionId = useAppStore.getState().incrementChatSession();
  session.sessionId = sessionId;

  // Check that our session is still active (false after stopChat or when a new chat replaced us)
  const isSessionValid = () => {
    const active = getActiveSession();
    return active !== null && active.sessionId === sessionId;
  };
  
  const safeCallbacks = createGuardrailCallbacks(callbacks, isSessionValid);
  
  if (!config.apiKey) {
    safeCallbacks.onError(new Error(`${config.provider} API key not configured.`));
    safeCallbacks.onDone();
    return;
  }

  // =========================================================================
  // Message Architecture (state vs chat separation)
  // =========================================================================
  // BP-static: system prompt + tool definitions (5m TTL, single breakpoint)
  // BP3: append-only conversation history (ephemeral, grows each round)
  //   → cached prefix: everything before BP3 marker is byte-stable
  // State block: non-durable, assembled fresh each round (AFTER BP3, uncached)
  //   Contains: task/plan, BB, staged, WM, steering, workspace context
  //   Injected into last user message of assembled payload, not into history
  // =========================================================================

  // Reuse the compressed history from end of previous turn when possible.
  // This keeps the message prefix byte-identical to what Anthropic cached,
  // avoiding a full cache WRITE on the first round of a new user turn.
  let conversationHistory: Array<{ role: string; content: unknown }>;
  let historyReusedFromCache = false;

  if (_endOfTurnHistory && messages.length > _endOfTurnUiMessageCount) {
    const newMessages = messages.slice(_endOfTurnUiMessageCount);
    const newNormalized = normalizeConversationHistory(newMessages);
    // Deep-clone the snapshot so in-place mutations this turn (stub, compact,
    // deflate, rolling-window splice) cannot corrupt `_endOfTurnHistory`'s
    // shared object references. Otherwise a mid-turn failure would leave the
    // cached snapshot with partial mutations on the next turn.
    conversationHistory = [...structuredClone(_endOfTurnHistory), ...newNormalized];
    historyReusedFromCache = true;
  } else {
    conversationHistory = normalizeConversationHistory(messages);
    // Rolling-summary injection removed: durable cross-round state lives in
    // BB, the hash manifest, FileViews, and `ru` rules. The verbatim window
    // (`applyRollingHistoryWindow`) still bounds total history size.
  }
  // Pin the frozen prefix: when reusing the end-of-turn snapshot, treat
  // everything up to the snapshot boundary as immutable. All compression
  // passes (middleware hygiene, emergency, end-of-turn) scope to this index.
  // Fresh history path uses 0 — no prior turn to protect.
  const priorTurnBoundary = historyReusedFromCache ? _endOfTurnBoundary : 0;

  await setPromptBudgetEstimates(config, conversationHistory);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const maxToolRounds = 50; // Ceiling when unlimited (0 in settings)
  
  // Get maxIterations from settings (0 = unlimited, uses maxToolRounds ceiling)
  const settingsMaxIterations = useAppStore.getState().settings.maxIterations;
  const maxRounds = settingsMaxIterations === 0 ? maxToolRounds : settingsMaxIterations;
  const maxAutoContinues = maxRounds;
  let autoContinueCount = 0;
  let runtimeCompletionBlocker: string | null = null;
  let totalToolsCompleted = 0;
  let taskCompleteCalled = false;
  let totalToolsQueued = 0;
  let lastReliefAction: PromptReliefAction = 'none';
  let consecutiveReadOnlyRounds = 0;
  let roundsInCurrentPhase = 0;
  let lastActiveSubtaskId: string | null = null;
  let totalResearchRounds = 0;
  let anyRoundHadMutations = false;
  _hadVerification = false;
  const advanceCountBySubtask = new Map<string, number>();
  let hadProgressSinceLastAdvance = false;
  
  // Initialize agent progress tracking
  const store = useAppStore.getState();
  const initialPendingAction = store.agentProgress.pendingAction;
  store.resetAgentProgress();
  if (initialPendingAction.kind !== 'none') {
    store.setAgentPendingAction(initialPendingAction);
  }
  store.setAgentProgress({ 
    status: 'thinking', 
    maxRounds, 
    maxAutoContinues,
    currentTask: (() => {
      const c = messages[messages.length - 1]?.content;
      if (typeof c === 'string') return c.substring(0, 100);
      if (Array.isArray(c)) {
        const textBlock = c.find((b): b is TextContentBlock => 'text' in b);
        return textBlock?.text?.substring(0, 100) || '';
      }
      return '';
    })(),
  });
  
  // User-message boundary = next autonomous round: advance HPP turn so
  // unpinned refs materialized by the prior stream dematerialize to
  // `referenced` before round 0's WM/state block is built. Mirrors the
  // per-round `round > 0` preamble below so "user sent text" behaves like
  // "model continued" for context-statefulness purposes. Safe on the very
  // first stream (turn 0 -> 1, refs map empty, maintenance is no-op).
  try {
    await advanceTurn();
    const ctxStoreAtBoundary = useContextStore.getState();
    ctxStoreAtBoundary.compactDormantChunks();
    ctxStoreAtBoundary.evictStaleDormantChunks();
    ctxStoreAtBoundary.clearStaleReconcileStats();
    ctxStoreAtBoundary.pruneHashStacks();
  } catch (e) {
    console.warn('[aiService] Stream-start HPP advance failed:', e);
  }

  try {
    for (let round = 0; round < maxRounds; round++) {
      _roundHadMutations = false;
      resetRoundFingerprint();

      // HPP: advance turn counter so previously-materialized chunks become referenced
      if (round > 0) {
        await advanceTurn();
        // Auto-compact dormant engrams so store tokens match prompt tokens
        useContextStore.getState().compactDormantChunks();
        // Evict stale dormant engrams that exceed count or turn-age limits
        useContextStore.getState().evictStaleDormantChunks();
        // Round-start freshness: clear stale reconcile stats and prune hash stacks
        useContextStore.getState().clearStaleReconcileStats();
        useContextStore.getState().pruneHashStacks();
        // Tick transition bridge after first round — model had a chance to see and act on it
        if (round === 1) useContextStore.getState().tickTransitionBridge();
      } else {
        useContextStore.getState().resetBatchMetrics();
      }
      
      setToolLoopState(conversationHistory, round, priorTurnBoundary);

      const roundContext = await runBeforeRoundMiddlewares({
        conversationHistory,
        round,
        priorTurnBoundary,
        config,
        mode,
        reliefAction: 'none',
        abortSignal,
        isSessionValid,
        historyReusedFromCache,
      });
      const reliefAction = roundContext.reliefAction;

      // -----------------------------------------------------------------
      // SPIN CIRCUIT BREAKER — auto-escalating intervention (GAP 1)
      // -----------------------------------------------------------------
      // Runs independently of the (optional) haltEnabled gate so nudge/strong
      // tiers always fire. Halt only triggers when the feature flag is on
      // AND we're in a non-ask/non-retriever mode with enough round history.
      //
      // Scope: the FSM filters to main rounds internally; subagent spin state
      // is isolated in `subagentService.ts`. These toggles therefore only
      // affect the main chat — do not re-audit for subagent leakage.
      let cbEvaluation: ReturnType<typeof evaluateSpin> | undefined;
      if (mode !== 'ask' && mode !== 'retriever' && round >= 2) {
        const snapshots = useRoundHistoryStore.getState().snapshots;
        if (snapshots.length >= 3) {
          const spinToggles = useAppStore.getState().settings.messageToggles.spin;
          if (spinToggles.enabled) {
            const mutedModes = new Set<SpinMode>(
              (Object.entries(spinToggles.modes) as Array<[SpinMode, boolean]>)
                .filter(([, on]) => !on)
                .map(([m]) => m),
            );
            const mutedTiers = new Set<CircuitBreakerTier>(
              (Object.entries(spinToggles.tiers) as Array<[CircuitBreakerTier, boolean]>)
                .filter(([, on]) => !on)
                .map(([t]) => t),
            );
            cbEvaluation = evaluateSpin(snapshots, {
              steeringEnabled: true,
              mutedModes,
              mutedTiers,
              haltEnabled: spinToggles.tiers.halt === true,
            });
          }
        }
      }

      // -----------------------------------------------------------------
      // ASSESS — pinned-working-memory hygiene (resource-based steering)
      // -----------------------------------------------------------------
      // Fires at user-turn boundary (round === 0) when pinned content warrants
      // review, and mid-loop only if CTX is high or a new edit-forwarded pin
      // appeared. Single-fire per (candidate set, CTX bucket). Skipped for
      // read-only / retriever modes that don't accumulate pinned edits.
      let assessEvaluation: ReturnType<typeof evaluateAssess> | undefined;
      if (mode !== 'ask' && mode !== 'retriever') {
        const ctxState = useContextStore.getState();
        const fvCovered = ctxState.fileViews.size > 0
          ? collectFileViewChunkHashes(ctxState.fileViews.values())
          : new Set<string>();
        const ctxUsed = ctxState.getUsedTokens();
        const ctxMax = ctxState.maxTokens;
        assessEvaluation = evaluateAssess({
          fileViews: ctxState.fileViews,
          chunks: ctxState.chunks,
          fileViewCoveredChunkHashes: fvCovered,
          ctxUsedTokens: ctxUsed,
          ctxMaxTokens: ctxMax,
          round,
          turnId: session.sessionId,
        });
        if (assessEvaluation.fired) {
          console.debug(
            `[assess] fired round=${round} ctxPct=${assessEvaluation.ctxPct.toFixed(0)} `
            + `candidates=${assessEvaluation.candidates.length} `
            + `topTokens=${assessEvaluation.candidates[0]?.tokens ?? 0}`,
          );
        }
      }

      // Publish tool-loop counters so buildDynamicContextBlock can emit
      // conditional steering sections in the non-durable state preamble.
      useAppStore.getState().setToolLoopSteering({
        round,
        mode,
        consecutiveReadOnlyRounds,
        roundsInCurrentPhase,
        anyRoundHadMutations,
        hadVerification: _hadVerification,
        hadProgressSinceLastAdvance,
        activeSubtaskId: lastActiveSubtaskId,
        completionBlocked: runtimeCompletionBlocker != null,
        completionBlocker: runtimeCompletionBlocker,
        spinCircuitBreaker: cbEvaluation && cbEvaluation.tier !== 'none' && cbEvaluation.message
          ? {
              tier: cbEvaluation.tier as 'nudge' | 'strong' | 'halt',
              mode: cbEvaluation.diagnosis.mode,
              confidence: cbEvaluation.diagnosis.confidence,
              message: cbEvaluation.message,
              consecutiveSameMode: cbEvaluation.consecutiveSameMode,
            }
          : null,
        assessContext: assessEvaluation && assessEvaluation.fired && assessEvaluation.message
          ? {
              message: assessEvaluation.message,
              firedKey: assessEvaluation.firedKey,
              candidateCount: assessEvaluation.candidates.length,
              ctxPct: assessEvaluation.ctxPct,
            }
          : null,
      });

      // Hard halt: abort the session so the outer tool loop exits cleanly.
      // The next `abortSignal.aborted` check terminates the round and the
      // UI receives the same done/abort flow as a user-initiated stop.
      if (cbEvaluation?.shouldHalt && !abortSignal.aborted) {
        console.warn(
          `[spin-circuit-breaker] HALT — mode=${cbEvaluation.diagnosis.mode} `
          + `confidence=${cbEvaluation.diagnosis.confidence.toFixed(2)} `
          + `consecutive=${cbEvaluation.consecutiveSameMode}`,
        );
        session.abortController.abort();
      }

      const dynamicContextBlock = buildDynamicContextBlock(
        dynamicContextInput?.workspaceContext,
        dynamicContextInput?.projectTree,
        round === 0 ? dynamicContextInput?.isFirstTurn : false,
      );
      recordSteeringInjected(extractSteeringBlocks(dynamicContextBlock));
      const roundLastUserIndex = conversationHistory.reduceRight((acc, msg, index) => acc === -1 && msg.role === 'user' ? index : acc, -1);
      useAppStore.getState().setPromptMetrics({
        bp3PriorTurnsTokens: estimateHistoryTokens(conversationHistory.slice(0, Math.max(0, roundLastUserIndex))),
        workspaceContextTokens: countTokensSync(dynamicContextBlock),
      });
      const assembledRound = assembleProviderMessages(
        conversationHistory,
        config.provider,
        mode,
        dynamicContextBlock,
      );
      const { geminiDynamicContext } = assembledRound;
      lastReliefAction = reliefAction;

      if (config.provider === 'anthropic') {
        const currStaticKey = _cachedStaticPrompt?.key ?? '';
        const currBp3: Bp3Snapshot = {
          hash: hashBp3Prefix(conversationHistory, roundLastUserIndex),
          length: roundLastUserIndex,
        };
        const staticResult = computeLogicalStaticHit(_prevStaticKey, currStaticKey);
        const subPrefixHash = _prevBp3Snapshot && currBp3.length > _prevBp3Snapshot.length
          ? hashBp3Prefix(conversationHistory, roundLastUserIndex, _prevBp3Snapshot.length)
          : undefined;
        const bp3Result = computeLogicalBp3Hit(_prevBp3Snapshot, currBp3, subPrefixHash);
        const store = useAppStore.getState();
        store.updateLogicalCache({
          staticHit: staticResult.hit,
          bp3Hit: bp3Result.hit,
          staticReason: staticResult.reason,
          bp3Reason: bp3Result.reason,
          sessionStaticHits: store.logicalCache.sessionStaticHits + (staticResult.hit ? 1 : 0),
          sessionStaticMisses: store.logicalCache.sessionStaticMisses + (staticResult.hit ? 0 : 1),
          sessionBp3Hits: store.logicalCache.sessionBp3Hits + (bp3Result.hit ? 1 : 0),
          sessionBp3Misses: store.logicalCache.sessionBp3Misses + (bp3Result.hit ? 0 : 1),
        });
        _prevStaticKey = currStaticKey;
        _prevBp3Snapshot = currBp3;
      }

      if (!isSessionValid() || abortSignal.aborted) {
        if (isSessionValid()) useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'aborted' });
        if (abortSignal.aborted) console.log('[aiService] Chat aborted before round', round + 1);
        break;
      }
      useAppStore.getState().setAgentProgress({ round: round + 1, status: 'thinking' });
      
      if (round > 0) {
        console.log(`[aiService] Rate limit delay: ${TOOL_LOOP_DELAY_MS}ms before round ${round + 1}`);
        await sleep(TOOL_LOOP_DELAY_MS);
        if (abortSignal.aborted || !isSessionValid()) {
          if (abortSignal.aborted) console.log('[aiService] Chat aborted during rate limit delay');
          break;
        }
      }
      
      const streamId = crypto.randomUUID();
      session.activeStreamIds.add(streamId);
      const pendingToolCalls: Map<number, PendingToolCall> = new Map();
      let needsToolResults = false;
      let assistantTextContent = '';
      let assistantReasoningContent = '';

      // Track usage - use latest values (Anthropic sends final totals at end)
      let roundInputTokens = 0;
      let roundOutputTokens = 0;
      let roundCacheReadTokens = 0;
      let roundCacheWriteTokens = 0;
      let stopReason: string | null = null;
      let streamErrorOccurred = false;
      let toolCallCounter = 0;

      const tauriMessagesRaw = assembledRound.messages.map(m => ({ role: m.role, content: m.content }));
      const tauriMessages = repairToolPairing(tauriMessagesRaw, config.provider);
      const cacheMessages = assembledRound.messages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content as string | ContentBlock[],
      }));

      useAppStore.getState().setLastPromptSnapshot({
        systemPrompt: config.systemPrompt || '',
        messages: tauriMessages,
        model: config.model,
        provider: config.provider,
        round,
        timestamp: Date.now(),
      });

      const invokeFn = async () => {
        // Clear transient stream banners (e.g. output-cap notice, prior rate-limit line) before a new request.
        safeCallbacks.onStatus?.('');
        if (config.provider === 'anthropic') {
          await invoke('stream_chat_anthropic', {
            apiKey: config.apiKey,
            model: config.model,
            messages: tauriMessages,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            systemPrompt: config.systemPrompt || '',
            streamId,
            enableTools: toolsEnabled,
            anthropicBeta: config.anthropicBeta ?? null,
            thinkingBudget: config.thinkingBudget ?? null,
            effort: config.reasoningEffort ?? null,
          });
        } else if (config.provider === 'openai') {
          await invoke('stream_chat_openai', {
            apiKey: config.apiKey,
            model: config.model,
            messages: tauriMessages,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            systemPrompt: config.systemPrompt || '',
            streamId,
            enableTools: toolsEnabled,
            reasoningEffort: config.reasoningEffort ?? null,
            verbosity: config.outputVerbosity ?? null,
          });
        } else if (config.provider === 'openrouter') {
          await invoke('stream_chat_openrouter', {
            apiKey: config.apiKey,
            model: config.model,
            messages: tauriMessages,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            systemPrompt: config.systemPrompt || '',
            streamId,
            enableTools: toolsEnabled,
            reasoningEffort: config.reasoningEffort ?? null,
          });
        } else if (config.provider === 'lmstudio') {
          await invoke('stream_chat_lmstudio', {
            baseUrl: config.baseUrl || config.apiKey,
            model: config.model,
            messages: tauriMessages,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            systemPrompt: config.systemPrompt || '',
            streamId,
            enableTools: toolsEnabled,
            reasoningEffort: config.reasoningEffort ?? null,
          });
        } else if (config.provider === 'vertex') {
          const { cacheName: vertexCache, cachedMessageCount: vertexCachedCount } = await manageGeminiRollingCache('vertex', config.apiKey, config.model, config.systemPrompt || '', cacheMessages, config.projectId, config.region);
          const vertexUncachedStart = vertexCache
            ? geminiUncachedMessagesStartIndex(vertexCachedCount, tauriMessages.length)
            : 0;
          const vertexMessages = vertexCache ? tauriMessages.slice(vertexUncachedStart) : tauriMessages;
          await invoke('stream_chat_vertex', {
            accessToken: config.apiKey,
            projectId: config.projectId || '',
            region: config.region || null,
            model: config.model,
            messages: vertexMessages,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            systemPrompt: config.systemPrompt || '',
            streamId,
            enableTools: toolsEnabled,
            cachedContent: vertexCache,
            dynamicContext: geminiDynamicContext || null,
            thinkingBudget: config.thinkingBudget ?? null,
          });
        } else {
          const { cacheName: googleCache, cachedMessageCount: googleCachedCount } = await manageGeminiRollingCache('google', config.apiKey, config.model, config.systemPrompt || '', cacheMessages);
          const googleUncachedStart = googleCache
            ? geminiUncachedMessagesStartIndex(googleCachedCount, tauriMessages.length)
            : 0;
          const googleMessages = googleCache ? tauriMessages.slice(googleUncachedStart) : tauriMessages;
          await invoke('stream_chat_google', {
            apiKey: config.apiKey,
            model: config.model,
            messages: googleMessages,
            maxTokens: config.maxTokens,
            temperature: config.temperature,
            systemPrompt: config.systemPrompt || '',
            streamId,
            enableTools: toolsEnabled,
            cachedContent: googleCache,
            dynamicContext: geminiDynamicContext || null,
            thinkingBudget: config.thinkingBudget ?? null,
          });
        }
      };

      const roundStreamStartMs = performance.now();
      let roundFirstTokenAtMs: number | undefined;
      let roundStreamEndMs = roundStreamStartMs;

      const stream = await createTauriChatStream({ streamId, invoke: invokeFn, abortSignal });
      const reader = stream.getReader();

      try {
        while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          if (!chunk) continue;
          appendStreamWireLogLine(round, streamId, chunk);
          switch (chunk.type) {
          case 'text_start':
            safeCallbacks.onTextStart?.(chunk.id);
            break;
          case 'text_delta':
            if (roundFirstTokenAtMs === undefined) roundFirstTokenAtMs = performance.now();
            safeCallbacks.onToken(chunk.delta);
            assistantTextContent += chunk.delta;
            break;
          case 'text_end':
            safeCallbacks.onTextEnd?.(chunk.id);
            break;
          case 'reasoning_start':
            safeCallbacks.onReasoningStart?.(chunk.id);
            break;
          case 'reasoning_delta':
            assistantReasoningContent += chunk.delta;
            safeCallbacks.onReasoningDelta?.(chunk.delta);
            break;
          case 'reasoning_end':
            safeCallbacks.onReasoningEnd?.(chunk.id);
            break;
          case 'tool_input_start': {
            safeCallbacks.onToolInputStart?.(chunk.tool_call_id, chunk.tool_name);
            safeCallbacks.onToolCall({
              id: chunk.tool_call_id,
              name: chunk.tool_name,
              args: {},
              status: 'pending',
            });
            break;
          }
          case 'tool_input_delta':
            safeCallbacks.onToolInputDelta?.(chunk.tool_call_id, chunk.input_text_delta);
            break;
          case 'tool_input_available': {
            const idx = toolCallCounter++;
            const expandedInput = chunk.tool_name === 'batch'
              ? expandBatchQ(chunk.input as Record<string, unknown>)
              : chunk.input;
            pendingToolCalls.set(idx, {
              id: chunk.tool_call_id,
              name: chunk.tool_name,
              inputJson: JSON.stringify(expandedInput),
              thoughtSignature: chunk.thought_signature,
            });
            safeCallbacks.onToolInputAvailable?.(chunk.tool_call_id, chunk.tool_name, expandedInput, chunk.thought_signature);
            safeCallbacks.onToolCall({
              id: chunk.tool_call_id,
              name: chunk.tool_name,
              args: expandedInput,
              status: 'running',
              thoughtSignature: chunk.thought_signature,
            });
            needsToolResults = true;
            break;
          }
          case 'start_step':
            safeCallbacks.onStepStart?.();
            break;
          case 'finish_step':
            safeCallbacks.onStepEnd?.();
            break;
          case 'usage': {
            const inTokens = chunk.input_tokens ?? 0;
            const outTokens = chunk.output_tokens ?? 0;
            if (inTokens > 0) roundInputTokens = inTokens;
            if (outTokens > 0) roundOutputTokens = outTokens;

            // Provider cache accounting — each path calls addCacheMetrics exactly once.
            // Anthropic: inTokens = uncached only; cache tokens are separate line items.
            // OpenAI/Google: inTokens = total prompt tokens including cached subset.
            const cacheWrite = chunk.cache_creation_input_tokens ?? 0;
            const cacheRead = chunk.cache_read_input_tokens ?? 0;
            if (cacheWrite > 0) roundCacheWriteTokens = cacheWrite;
            if (cacheRead > 0) roundCacheReadTokens = cacheRead;

            const openaiCached = chunk.openai_cached_tokens ?? 0;
            const geminiCached = chunk.cached_content_tokens ?? 0;

            if (openaiCached > 0) {
              roundCacheReadTokens = openaiCached;
              if (inTokens > 0) {
                useAppStore.getState().addCacheMetrics({ cacheWrite: 0, cacheRead: openaiCached, uncached: inTokens - openaiCached, lastRequestCachedTokens: openaiCached });
              }
            } else if (geminiCached > 0) {
              roundCacheReadTokens = geminiCached;
              if (inTokens > 0) {
                useAppStore.getState().addCacheMetrics({ cacheWrite: 0, cacheRead: geminiCached, uncached: inTokens - geminiCached, lastRequestCachedTokens: geminiCached });
              }
            } else if (inTokens > 0 || cacheWrite > 0 || cacheRead > 0) {
              useAppStore.getState().addCacheMetrics({ cacheWrite, cacheRead, uncached: inTokens });
            }

            const displayIn = totalInputTokens + roundInputTokens;
            const displayOut = totalOutputTokens + roundOutputTokens;
            const modelInfo = useAppStore.getState().availableModels.find(m => m.id === config.model);
            const st = useAppStore.getState().settings;
            const extendedResolution = getExtendedContextResolutionFromSettings(st);
            const maxTokens = modelInfo
              ? (getEffectiveContextWindow(modelInfo.id, modelInfo.provider, modelInfo.contextWindow, extendedResolution)
                ?? (config.provider === 'google' || config.provider === 'vertex' ? 1000000 : 200000))
              : (config.provider === 'google' || config.provider === 'vertex' ? 1000000 : 200000);
            safeCallbacks.onUsageUpdate({
              inputTokens: displayIn,
              outputTokens: displayOut,
              totalTokens: displayIn + displayOut,
              maxTokens,
              percentage: Math.min(100, ((displayIn + displayOut) / maxTokens) * 100),
            });
            break;
          }
          case 'stop_reason':
            stopReason = chunk.reason;
            if (chunk.reason === 'max_tokens') {
              safeCallbacks.onStatus?.('Output token limit reached — continuing…');
            }
            break;
          case 'status':
            safeCallbacks.onStatus?.(chunk.message);
            break;
          case 'error':
            streamErrorOccurred = true;
            safeCallbacks.onStreamError?.(chunk.error_text);
            safeCallbacks.onError(new Error(chunk.error_text));
            break;
          case 'done':
            break;
        }
        }
      } catch (streamErr) {
        if (!abortSignal.aborted && streamErr != null) {
          const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
          console.error('[aiService] Stream/invoke error:', errMsg);
          safeCallbacks.onError(streamErr instanceof Error ? streamErr : new Error(errMsg));
        }
      } finally {
        roundStreamEndMs = performance.now();
        reader.releaseLock();
      }

      session.activeStreamIds.delete(streamId);
      
      if (abortSignal.aborted || !isSessionValid()) {
        if (abortSignal.aborted) console.log('[aiService] Aborted during streaming round', round + 1);
        if (isSessionValid()) useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'aborted' });
        break;
      }

      // G36: abort tool loop when stream error occurred and no tool calls were parsed
      if (streamErrorOccurred && !needsToolResults) {
        console.warn('[aiService] Stream error with no tool calls — breaking tool loop');
        break;
      }

      totalInputTokens += roundInputTokens;
      totalOutputTokens += roundOutputTokens;

      if (!isSessionValid()) break;

      useAppStore.getState().recordRound();

      // Record cost for this round (cache-aware for Anthropic)
      let roundCostCents = 0;
      if (roundInputTokens === 0 && roundOutputTokens === 0) {
        console.warn('[aiService] Round completed with zero usage — cost/ATLS internals may show $0 (provider may not have emitted Usage chunk)');
      }
      if (roundInputTokens > 0 || roundOutputTokens > 0) {
        roundCostCents = calculateCost(
          config.provider as CostProvider,
          config.model,
          roundInputTokens,
          roundOutputTokens,
          roundCacheReadTokens,
          roundCacheWriteTokens,
        );
        useCostStore.getState().recordUsage({
          provider: config.provider as CostProvider,
          model: config.model,
          inputTokens: roundInputTokens,
          outputTokens: roundOutputTokens,
          cacheReadTokens: roundCacheReadTokens,
          cacheWriteTokens: roundCacheWriteTokens,
          costCents: roundCostCents,
          timestamp: new Date(),
        });
        console.log(`[aiService] Recorded cost: ${roundCostCents}¢ for ${roundInputTokens}in/${roundOutputTokens}out (cache r:${roundCacheReadTokens} w:${roundCacheWriteTokens}) (${config.provider}/${config.model})`);
        // Token accuracy telemetry: compare provider-reported input with our estimate
        const estimatedInput = estimateHistoryTokens(conversationHistory) + countTokensSync(dynamicContextBlock);
        if (roundInputTokens > 0 && estimatedInput > 0) {
          const accuracyRatio = estimatedInput / roundInputTokens;
          console.log(`[tokenizer] accuracy: estimated=${estimatedInput} provider=${roundInputTokens} ratio=${accuracyRatio.toFixed(3)} (1.0=perfect, <1=undercount, >1=overcount)`);
        }
      }

      // Recovery: extract tool_use blocks from text when backend missed them
      // This happens when the API returns JSON content blocks as text tokens
      if (!needsToolResults && looksLikeStructuredToolPayload(assistantTextContent)) {
        const hasToolUse = assistantTextContent.includes('"type":"tool_use"');
        const hasToolResult = assistantTextContent.includes('"type":"tool_result"');

        if (hasToolUse || hasToolResult) {
          console.log(`[aiService] Recovering content blocks from text (tool_use:${hasToolUse}, tool_result:${hasToolResult})`);
          const savedTextContent = assistantTextContent;
          const savedPendingSize = pendingToolCalls.size;
          const savedNeedsToolResults = needsToolResults;
          try {
            const trimmedText = assistantTextContent.trim();
            let contentBlocks: Array<Record<string, unknown>> = [];
            let preJsonProse = '';

            if (trimmedText.startsWith('[{')) {
              contentBlocks = JSON.parse(trimmedText);
            } else {
              const jsonStart = trimmedText.indexOf('[{');
              if (jsonStart > 0) {
                preJsonProse = trimmedText.slice(0, jsonStart).trim();
              }
              const jsonMatch = trimmedText.match(/\[(\{[^]*)\]/);
              if (jsonMatch) {
                contentBlocks = JSON.parse(jsonMatch[0]);
              }
            }

            if (Array.isArray(contentBlocks)) {
              const textParts = contentBlocks
                .filter((b) => b.type === 'text' && b.text)
                .map((b) => String(b.text));

              const toolBlocks = contentBlocks.filter((b) => b.type === 'tool_use' && b.name);

              assistantTextContent = [preJsonProse, ...textParts].filter(Boolean).join('\n');

              if (toolBlocks.length > 0) {
                let idx = pendingToolCalls.size;
                for (const block of toolBlocks) {
                  const id = (block.id as string) || crypto.randomUUID();
                  const name = block.name as string;
                  const rawInput = block.input as Record<string, unknown> || {};
                  const input = name === 'batch' ? expandBatchQ(rawInput) : rawInput;

                  pendingToolCalls.set(idx, { id, name, inputJson: JSON.stringify(input) });
                  safeCallbacks.onToolCall({ id, name, args: input, status: 'running' });
                  needsToolResults = true;
                  idx++;
                }
                console.log(`[aiService] Recovered ${toolBlocks.length} tool_use blocks from text`);
              }
            }
          } catch (e) {
            assistantTextContent = savedTextContent;
            needsToolResults = savedNeedsToolResults;
            for (let k = pendingToolCalls.size - 1; k >= savedPendingSize; k--) {
              pendingToolCalls.delete(k);
            }
            console.warn('[aiService] Failed to parse content blocks from text, reverting:', e);
          }
        }
      }

      recordAssistantTextHash(assistantTextContent);

      /** Per-round ATLS Internals snapshot. `isResearchRound` must reflect post-tool mutations when tools ran (see call sites). */
      const captureInternalsSnapshot = async (isResearchRound: boolean): Promise<void> => {
        const ctxState = useContextStore.getState();
        const appState = useAppStore.getState();
        const bm = ctxState.batchMetrics;
        const wmTokens = ctxState.getPromptTokens();
        const wmStoreTokens = ctxState.getStoreTokens();
        const bbTokens = ctxState.getBlackboardTokenCount();
        // Emitted staged tokens = what the model actually sees in `## STAGED`
        // (pointer stubs for entries covered by active engrams). This drives
        // reconcileBudgets via middleware, CTX lines, and internals displays.
        const stagedTokens = ctxState.getStagedEmittedTokens();
        let archivedTokens = 0;
        ctxState.archivedChunks.forEach(c => archivedTokens += c.tokens);
        const overheadTokens = appState.promptMetrics.totalOverheadTokens;
        const staticSystemTokens = getStaticSystemTokens(appState.promptMetrics);
        const conversationHistoryTokens = await estimateHistoryTokensAsync(conversationHistory);
        let historyBreakdownLabel: string | undefined;
        if (conversationHistoryTokens > 5000) {
          const { analyzeHistoryBreakdown, formatHistoryBreakdown } = await import('./historyCompressor');
          const breakdown = analyzeHistoryBreakdown(conversationHistory, priorTurnBoundary ?? 0, round);
          historyBreakdownLabel = formatHistoryBreakdown(breakdown) || undefined;
        }
        const stagedTokensBucket = getStagedTokens(appState.promptMetrics, stagedTokens);
        const workspaceContextTokens = countTokensSync(dynamicContextBlock);
        const modelCtx = appState.availableModels.find(m => m.id === config.model);
        const extendedResolution = getExtendedContextResolutionFromSettings(appState.settings);
        const maxTk = modelCtx
          ? (getEffectiveContextWindow(modelCtx.id, modelCtx.provider, modelCtx.contextWindow, extendedResolution)
            ?? appState.contextUsage.maxTokens
            ?? (config.provider === 'google' || config.provider === 'vertex' ? 1000000 : 200000))
          : (appState.contextUsage.maxTokens || (config.provider === 'google' || config.provider === 'vertex' ? 1000000 : 200000));
        const bp3Tokens = conversationHistoryTokens;
        const estimatedBucketsBase: Omit<PromptPressureBuckets, 'estimatedTotalPromptTokens'> = {
          staticSystemTokens,
          conversationHistoryTokens: bp3Tokens,
          stagedTokens: stagedTokensBucket,
          wmTokens,
          workspaceContextTokens,
          blackboardTokens: 0,
          providerInputTokens: roundInputTokens,
          cacheStablePrefixTokens: staticSystemTokens + bp3Tokens + stagedTokensBucket,
          cacheChurnTokens: workspaceContextTokens + wmTokens,
        };
        const estimatedTotalPromptTokens = getEstimatedTotalPromptTokens(estimatedBucketsBase);
        const freeTk = Math.max(0, maxTk - estimatedTotalPromptTokens);
        const inputShare = (roundInputTokens + roundOutputTokens) > 0
          ? roundInputTokens / (roundInputTokens + roundOutputTokens)
          : 0;
        const hypothetical = bm.manageOps > 1
          ? bm.manageOps * (roundCostCents * inputShare) + (roundCostCents * (1 - inputShare))
          : roundCostCents;
        const verifyArtifacts = Array.from(useContextStore.getState().verifyArtifacts.values());
        const latestVerifyArtifact = verifyArtifacts.length > 0 ? verifyArtifacts[verifyArtifacts.length - 1] : undefined;
        // Rolling-summary distillation removed — this field stays zero-valued
        // on snapshots for forwards-compatibility with the RoundSnapshot shape.
        const rollingSummaryTokens = 0;
        const costBreakdown = calculateCostBreakdown(config.provider as CostProvider, config.model, roundInputTokens, roundOutputTokens, roundCacheReadTokens, roundCacheWriteTokens);
        // Billing-grade cache savings = what we'd have paid with zero cache
        // tokens minus what we actually paid. Anthropic: uncached input alone
        // would have been `input_tokens + cacheReads + cacheWrites` at full
        // rate; OpenAI / Gemini: inputTokens already contains the cached
        // subset, so "no cache" is the same token total at full input rate.
        let cacheSavingsCents = 0;
        if (roundCacheReadTokens > 0 || roundCacheWriteTokens > 0) {
          const provider = config.provider as CostProvider;
          const noCacheInput = provider === 'anthropic'
            ? roundInputTokens + roundCacheReadTokens + roundCacheWriteTokens
            : roundInputTokens;
          const noCache = calculateCostBreakdown(provider, config.model, noCacheInput, roundOutputTokens, 0, 0);
          cacheSavingsCents = Math.max(0, noCache.totalCostCents - costBreakdown.totalCostCents);
        }
        // FileView render vs chunk cost for this round — non-gating.
        let fvRendered = 0;
        let fvCovered = 0;
        let fvCount = 0;
        if (ctxState.fileViews.size > 0) {
          const { summarizeFileViewTokens } = await import('./fileViewTokens');
          const { collectFileViewChunkHashes } = await import('./fileViewRender');
          const summary = summarizeFileViewTokens(ctxState.fileViews.values(), round + 1);
          fvRendered = summary.totalRenderedTokens;
          fvCount = summary.viewCount;
          const covered = collectFileViewChunkHashes(ctxState.fileViews.values());
          for (const [, c] of ctxState.chunks) {
            if (covered.has(c.hash)) fvCovered += c.tokens;
          }
        }
        useAppStore.getState().setPromptMetrics({
          fileViewCount: fvCount,
          fileViewRenderedTokens: fvRendered,
          fileViewCoveredChunkTokens: fvCovered,
        });
        useRoundHistoryStore.getState().pushSnapshot({
          round: round + 1,
          timestamp: Date.now(),
          provider: config.provider,
          wmTokens,
          wmStoreTokens,
          bbTokens,
          stagedTokens,
          archivedTokens,
          overheadTokens,
          freeTokens: freeTk,
          maxTokens: maxTk,
          staticSystemTokens,
          conversationHistoryTokens,
          stagedBucketTokens: stagedTokensBucket,
          workspaceContextTokens,
          providerInputTokens: roundInputTokens,
          estimatedTotalPromptTokens,
          cacheStablePrefixTokens: estimatedBucketsBase.cacheStablePrefixTokens,
          cacheChurnTokens: estimatedBucketsBase.cacheChurnTokens,
          reliefAction: lastReliefAction,
          legacyHistoryTelemetryKnownWrong: false,
          inputTokens: roundInputTokens,
          outputTokens: roundOutputTokens,
          cacheReadTokens: roundCacheReadTokens,
          cacheWriteTokens: roundCacheWriteTokens,
          costCents: roundCostCents,
          inputCostCents: costBreakdown.inputCostCents,
          outputCostCents: costBreakdown.outputCostCents,
          cacheSavingsCents,
          compressionSavings: appState.promptMetrics.compressionSavings,
          rollingSavings: appState.promptMetrics.rollingSavings ?? 0,
          rolledRounds: appState.promptMetrics.rolledRounds ?? 0,
          rollingSummaryTokens,
          freedTokens: ctxState.freedTokens,
          cumulativeSaved: appState.promptMetrics.cumulativeInputSaved,
          fileViewRenderedTokens: fvRendered,
          fileViewCoveredChunkTokens: fvCovered,
          fileViewCount: fvCount,
          toolCalls: bm.toolCalls,
          manageOps: bm.manageOps,
          hypotheticalNonBatchedCost: hypothetical,
          actualCost: roundCostCents,
          historyBreakdownLabel,
          verificationConfidence: latestVerifyArtifact ? deriveVerificationConfidence(latestVerifyArtifact) : undefined,
          verificationLabel: latestVerifyArtifact ? deriveVerificationLabel(latestVerifyArtifact) : undefined,
          verificationReused: latestVerifyArtifact?.confidence === 'cached' || latestVerifyArtifact?.source === 'cache',
          verificationObsolete: latestVerifyArtifact?.confidence === 'obsolete' || latestVerifyArtifact?.stale === true,
          timeToFirstTokenMs: roundFirstTokenAtMs !== undefined
            ? roundFirstTokenAtMs - roundStreamStartMs
            : undefined,
          roundLatencyMs: roundStreamEndMs - roundStreamStartMs,
          isResearchRound,
          totalResearchRounds,
          newCoverage: ctxState.roundNewCoverage,
          coveragePlateau: ctxState.coveragePlateauStreak >= 2,
          substantiveBbWrites: bm.hadSubstantiveBbWrite ? 1 : 0,
          turnId: sessionId,
          assessFired: assessEvaluation?.fired === true,
          assessFiredKey: assessEvaluation?.fired ? assessEvaluation.firedKey : undefined,
          assessCandidateCount: assessEvaluation?.candidates.length,
          // Drain auto-pin telemetry once per round so each snapshot carries
          // only this round's counts. Empty (0/0) when the flag is off or no
          // reads/unpins happened this round.
          ...(() => {
            const m = drainAutoPinMetrics();
            return {
              autoPinsCreated: m.created,
              autoPinsReleasedUnused: m.releasedUnused,
            };
          })(),
          // Unified hash namespace: ambient collision counter — how many ref
          // lookups this round matched both a view and a chunk (views won).
          // Non-zero values inform the SHORT_HASH_LEN=6→8 decision.
          refCollisions: drainRefCollisionCount(),
          ...getRoundFingerprint(),
        });
      };
      
      // No tool calls - AI decided to stop
      if (!needsToolResults || pendingToolCalls.size === 0) {
        await captureInternalsSnapshot(true);
        console.log(`[aiService] End turn without tools - stopReason: ${stopReason}, textLength: ${assistantTextContent.length}`);
        const agentProgressState = useAppStore.getState().agentProgress;
        const currentPendingAction = agentProgressState.pendingAction;
        const completionOnlyBlocked = currentPendingAction.kind === 'none'
          && runtimeCompletionBlocker != null
          && !agentProgressState.canTaskComplete;
        // state_changed = new user message this run; informational for prompts, not a stop gate.
        // Tool rounds clear it after execution; text-only rounds must not stop here or follow-ups never complete.
        const hasBlockingPendingAction =
          (currentPendingAction.kind !== 'none' && currentPendingAction.kind !== 'state_changed')
          || completionOnlyBlocked;

        // Detect st:done marker as implicit completion
        const hasDoneMarker = /«?st:\s*done»?/i.test(assistantTextContent);
        if (hasDoneMarker) {
          if (completionOnlyBlocked) {
            if (autoContinueCount < maxAutoContinues) {
              autoContinueCount++;
              console.log(`[aiService][telemetry] auto-continue: trigger=st_done_completion_gate, round=${round}, count=${autoContinueCount}/${maxAutoContinues}, blocker=${runtimeCompletionBlocker}`);
              useAppStore.getState().setAgentProgress({
                status: 'auto_continuing',
                autoContinueCount,
              });
              {
                const merged = mergeRoundAssistantVisibleText(assistantReasoningContent, assistantTextContent);
                if (merged) {
                  conversationHistory.push({ role: 'assistant', content: merged });
                }
              }
              // Steering now emitted via state block; just push a minimal continue prompt
              conversationHistory.push({ role: 'user', content: 'Continue.' });
              continue;
            }
            useAppStore.getState().setAgentProgress({
              status: 'stopped',
              stoppedReason: runtimeCompletionBlocker ?? 'Final verification is still required before completion.',
            });
            useAppStore.getState().setAgentCanContinue(true);
            break;
          }
          if (hasBlockingPendingAction) {
            useAppStore.getState().setAgentProgress({
              status: 'stopped',
              stoppedReason: runtimeCompletionBlocker ?? getPendingActionStopReason(currentPendingAction),
            });
            useAppStore.getState().setAgentCanContinue(canAutoContinuePendingAction(currentPendingAction));
            break;
          }
          console.log('[aiService] Detected st:done marker - treating as implicit completion');
          useAppStore.getState().clearAgentPendingAction();
          useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'completed' });
          useAppStore.getState().setAgentCanContinue(false);
          break;
        }

        // In ask mode, never auto-continue
        if (mode === 'ask') {
          useAppStore.getState().clearAgentPendingAction();
          useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'completed' });
          useAppStore.getState().setAgentCanContinue(false);
          break;
        }

        // Retriever mode: completion is bb_write + reply
        if (mode === 'retriever') {
          useAppStore.getState().clearAgentPendingAction();
          useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'completed' });
          useAppStore.getState().setAgentCanContinue(false);
          break;
        }

        // --- Continuation logic based on stop_reason ---

        if (stopReason === 'max_tokens') {
          // Model was cut off mid-output — always auto-continue
          if (autoContinueCount < maxAutoContinues) {
            autoContinueCount++;
            console.log(`[aiService][telemetry] auto-continue: trigger=max_tokens, round=${round}, count=${autoContinueCount}/${maxAutoContinues}, blocker=${runtimeCompletionBlocker}`);

            useAppStore.getState().setAgentProgress({
              status: 'auto_continuing',
              autoContinueCount,
            });

            {
              const merged = mergeRoundAssistantVisibleText(assistantReasoningContent, assistantTextContent);
              if (merged) {
                conversationHistory.push({ role: 'assistant', content: merged });
              }
            }
            conversationHistory.push({
              role: 'user',
              content: 'Your response was truncated. Continue from where you left off.',
            });
            continue;
          }
        } else if (
          stopReason === 'end_turn'
          || stopReason === null
          || (stopReason !== 'max_tokens' && stopReason !== 'end_turn' && stopReason !== null)
        ) {
          // Natural stop (end_turn, null, or provider quirks e.g. tool_use with no parsed tools).
          // Model chose to stop — check for blocking conditions, then accept
          if (stopReason != null && stopReason !== 'end_turn' && stopReason !== 'max_tokens') {
            console.log(`[aiService] No-tools round with stop_reason=${stopReason} — using same completion path as end_turn`);
          }
          if (completionOnlyBlocked) {
            if (autoContinueCount < maxAutoContinues) {
              autoContinueCount++;
              console.log(`[aiService][telemetry] auto-continue: trigger=end_turn_completion_gate, round=${round}, count=${autoContinueCount}/${maxAutoContinues}, blocker=${runtimeCompletionBlocker}`);
              useAppStore.getState().setAgentProgress({
                status: 'auto_continuing',
                autoContinueCount,
              });
              {
                const merged = mergeRoundAssistantVisibleText(assistantReasoningContent, assistantTextContent);
                if (merged) {
                  conversationHistory.push({ role: 'assistant', content: merged });
                }
              }
              conversationHistory.push({ role: 'user', content: 'Continue.' });
              continue;
            }
            useAppStore.getState().setAgentProgress({
              status: 'stopped',
              stoppedReason: runtimeCompletionBlocker ?? 'Final verification is still required before completion.',
            });
            useAppStore.getState().setAgentCanContinue(true);
            break;
          }
          if (hasBlockingPendingAction) {
            useAppStore.getState().setAgentProgress({
              status: 'stopped',
              stoppedReason: runtimeCompletionBlocker ?? getPendingActionStopReason(currentPendingAction),
            });
            useAppStore.getState().setAgentCanContinue(canAutoContinuePendingAction(currentPendingAction));
            break;
          }
          // Natural end_turn — accept as completion
          console.log('[aiService] Model ended turn naturally — accepting as completion');
          useAppStore.getState().clearAgentPendingAction();
          useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'completed' });
          useAppStore.getState().setAgentCanContinue(false);
          break;
        }

        // Exhausted auto-continues — stop and enable manual continue
        console.log('[aiService] Continuation logic exhausted, enabling manual continue');
        if (stopReason === 'max_tokens') {
          safeCallbacks.onStatus?.(
            'Output token limit reached — auto-continue exhausted. Raise Max Tokens or Max Iterations, or use Continue.',
          );
        }
        useAppStore.getState().setAgentProgress({
          status: 'stopped',
          stoppedReason: `Auto-continue limit (${maxAutoContinues}) reached`,
        });
        useAppStore.getState().setAgentCanContinue(true);
        break;
      }

      // Execute tools and prepare for next round
      console.log(`[aiService] Tool round ${round + 1}: ${pendingToolCalls.size} tools`);
      totalToolsQueued += pendingToolCalls.size;
      
      useAppStore.getState().setAgentProgress({ 
        status: 'executing', 
        toolsTotal: totalToolsQueued,
      });
      
      // Build assistant message with tool_use blocks
      const assistantContent: unknown[] = [];
      const mergedRoundText = mergeRoundAssistantVisibleText(assistantReasoningContent, assistantTextContent);
      if (mergedRoundText) {
        assistantContent.push({ type: 'text', text: mergedRoundText });
      }
      
      // Build tool calls array for parallel execution
      const toolCallEntries = Array.from(pendingToolCalls.entries()).map(([, tc]) => ({
        id: tc.id,
        name: tc.name,
        args: tc.inputJson ? JSON.parse(tc.inputJson) : {},
        thoughtSignature: tc.thoughtSignature,
      }));

      // Spin diagnostics: extract hash refs from tool call params
      {
        const paramRefs: string[] = [];
        for (const tc of toolCallEntries) {
          if (tc.args) paramRefs.push(...extractHashRefs(JSON.stringify(tc.args)));
        }
        if (paramRefs.length > 0) recordHashRefsConsumed(paramRefs);
      }

      // Add all tool_use blocks to assistant content first
      for (const tc of toolCallEntries) {
        assistantContent.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.args,
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        });
        // Mark all as running
        safeCallbacks.onToolCall({ id: tc.id, name: tc.name, args: tc.args, status: 'running' });
      }
      
      // Execute tools with concurrency limit
      console.log(`[aiService] Executing ${toolCallEntries.length} tools (max ${MAX_CONCURRENT_TOOLS} concurrent)...`);
      let roundPendingAction = useAppStore.getState().agentProgress.pendingAction;
      const startedWithStateChanged = roundPendingAction.kind === 'state_changed';
      let roundObservedNonCompletionTool = false;
      const roundCompletionBlockers: Array<{ toolName: string; blocker: string | null | undefined }> = [];

      const toolTasks = toolCallEntries.map((tc) => async () => {
        // Skip execution if already aborted
        if (abortSignal.aborted) {
          return { type: 'tool_result', tool_use_id: tc.id, name: tc.name, content: '[cancelled]' };
        }
        // Guard: reject empty tool names before execution
        if (!tc.name?.trim()) {
          const errMsg = 'Invalid or empty tool name. Use batch with q: one step per line (see BATCH_TOOL_REF), or structured steps.';
          safeCallbacks.onToolResult(tc.id, errMsg);
          safeCallbacks.onToolCall({ id: tc.id, name: tc.name || '', args: tc.args, status: 'failed', result: errMsg });
          return { type: 'tool_result', tool_use_id: tc.id, name: tc.name || '', content: errMsg };
        }
        if (tc.name === 'batch') {
          const batchArgs = tc.args as Record<string, unknown>;
          batchArgs.steps = coerceBatchSteps(batchArgs.steps);
        }
        // Track tool in agent progress.
        const params = tc.args as Record<string, unknown>;
        let displayName = tc.name;
        let detail: string;

        if (tc.name === 'batch') {
          const steps = coerceBatchSteps(params.steps);
          const firstStep = steps[0] || {};
          displayName = String(firstStep.use || 'batch');
          const firstParams = (firstStep.with as Record<string, unknown>) || {};
          detail = firstStringOrArrayHead(firstParams.file_paths)
            || String(firstParams.file_path || '')
            || String(firstParams.cmd || '')
            || firstStringOrArrayHead(firstParams.queries)
            || String(firstParams.action || '')
            || firstStringOrArrayHead(firstParams.symbol_names)
            || String(firstParams.query || '')
            || displayName;
        } else {
          detail = firstStringOrArrayHead(params.file_paths) || tc.name;
        }
        
        const toolSummary = { id: tc.id, name: displayName, detail, status: 'running' as const, round: round + 1 };
        const currentProgress = useAppStore.getState().agentProgress;
        useAppStore.getState().setAgentProgress({
          recentTools: [...currentProgress.recentTools, toolSummary],
        });
        
        roundObservedNonCompletionTool = true;
        
        // Check for session.plan inside batch - update current task display.
        if (tc.name === 'batch') {
          const steps = coerceBatchSteps(params.steps);
          const planStep = steps.find(step => step.use === 'session.plan');
          const withParams = (planStep?.with as Record<string, unknown> | undefined) || {};
          if (withParams.goal) {
            useAppStore.getState().setAgentProgress({ currentTask: String(withParams.goal) });
          }
        }
        
        const exportRemovalWarning = buildSharedExportRemovalWarning(
          String((tc.args as Record<string, unknown>).file_path || ''),
          tc.args,
        );
        if (exportRemovalWarning) {
          const result = `[blocked shared export change] ${exportRemovalWarning}`;
          totalToolsCompleted++;
          const progressState = useAppStore.getState().agentProgress;
          useAppStore.getState().setAgentProgress({
            toolsCompleted: totalToolsCompleted,
            recentTools: progressState.recentTools.map((t) =>
              t.id === tc.id ? { ...t, status: 'failed' } : t
            ),
          });
          safeCallbacks.onToolResult(tc.id, result);
          safeCallbacks.onToolCall({ id: tc.id, name: tc.name, args: tc.args, status: 'failed', result });
          return {
            type: 'tool_result',
            tool_use_id: tc.id,
            name: tc.name,
            content: result,
            is_error: true,
          };
        }

        let result: string;
        let toolStatus: 'completed' | 'failed' = 'completed';

        // Pre-register batch step summaries so UI shows pending spinners immediately
        let batchStepSummaries: AgentToolSummary[] | undefined;
        const partialResultLines: string[] = [];

        if (tc.name === 'batch') {
          const rawSteps = coerceBatchSteps((tc.args as Record<string, unknown>).steps);
          const steps = expandBatchStepsForUiDisplay(rawSteps);
          batchStepSummaries = steps.map((step, index) => {
            const withParams = (step.with as Record<string, unknown> | undefined) || {};
            const stepName = String(step.use || `step_${index + 1}`);
            const stepDetail = firstStringOrArrayHead(withParams.file_paths)
              || String(withParams.file_path || '')
              || String(withParams.cmd || '')
              || firstStringOrArrayHead(withParams.queries)
              || String(withParams.action || '')
              || firstStringOrArrayHead(withParams.symbol_names)
              || String(withParams.query || '')
              || stepName;
            return {
              id: `${tc.id}::${String(step.id || index + 1)}`,
              parentId: tc.id,
              name: stepName,
              detail: stepDetail,
              round: round + 1,
              stepId: String(step.id || index + 1),
              stepIndex: index,
              totalSteps: steps.length,
              status: 'pending' as const,
            };
          });
          const current = useAppStore.getState().agentProgress.recentTools.filter(t => t.parentId !== tc.id);
          useAppStore.getState().setAgentProgress({ recentTools: [...current, ...batchStepSummaries] });
        }

        try {
          const onBatchStepProgress: OnBatchStepComplete | undefined = tc.name === 'batch'
            ? (progress) => {
                partialResultLines.push(progress.summaryLine);
                const partialResult = partialResultLines.join('\n');

                // Update agentProgress: mark this step done, next step running
                if (batchStepSummaries) {
                  const updated = batchStepSummaries.map((s, idx) => {
                    if (idx < partialResultLines.length) {
                      const line = partialResultLines[idx];
                      const failed = line?.includes('ERROR') || line?.includes('BLOCKED');
                      return { ...s, status: (failed ? 'failed' : 'completed') as AgentToolSummary['status'] };
                    }
                    if (idx === partialResultLines.length) {
                      return { ...s, status: 'running' as const };
                    }
                    return s;
                  });
                  const current = useAppStore.getState().agentProgress.recentTools.filter(t => t.parentId !== tc.id);
                  useAppStore.getState().setAgentProgress({ recentTools: [...current, ...updated] });
                }

                // Push partial result to streaming UI so each step appears as it completes
                safeCallbacks.onToolCall({
                  id: tc.id, name: tc.name, args: tc.args, status: 'running', result: partialResult,
                });
              }
            : undefined;

          const execution = await executeToolCallDetailed(tc.name, tc.args, {
            onBatchStepProgress,
            onSubagentProgress: safeCallbacks.onSubagentProgress,
          });
          result = execution.displayText;

          // Final agentProgress update for batch: use authoritative per-step outcomes
          // from the executor, not a line-index walk over displayText. Validation
          // failures produce a single summary line but N planned UI rows, so indexing
          // the text used to mark rows 1..N-1 "completed" falsely.
          if (tc.name === 'batch' && batchStepSummaries) {
            const completedBatchSteps = finalizeBatchAgentProgress(
              batchStepSummaries,
              execution.meta?.batchStepOutcomes,
              execution.meta?.batchOk,
            );
            const current = useAppStore.getState().agentProgress.recentTools.filter(t => t.parentId !== tc.id);
            useAppStore.getState().setAgentProgress({ recentTools: [...current, ...completedBatchSteps] });
          }

          if (execution.meta?.pendingAction) {
            roundPendingAction = mergePendingAction(roundPendingAction, execution.meta.pendingAction);
          }
          if (execution.meta && 'completionBlocker' in execution.meta) {
            roundCompletionBlockers.push({ toolName: tc.name, blocker: execution.meta.completionBlocker ?? null });
          }
          if (tc.name === 'task_complete') {
            taskCompleteCalled = true;
          }
          safeCallbacks.onToolResult(tc.id, result);
          safeCallbacks.onToolCall({
            id: tc.id, name: tc.name, args: tc.args, status: 'completed', result,
            ...(execution.meta?.syntheticChildren?.length ? { syntheticChildren: execution.meta.syntheticChildren } : {}),
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const verifyHint = /^verify\./.test(tc.name)
            ? buildWorkspaceVerifyHint(errorMessage)
            : null;
          result = verifyHint ? `Error: ${errorMessage}\n${verifyHint}` : `Error: ${errorMessage}`;
          toolStatus = 'failed';
          safeCallbacks.onToolResult(tc.id, result);
          safeCallbacks.onToolCall({ id: tc.id, name: tc.name, args: tc.args, status: 'failed', result });
        }
        
        // Update tool status in progress
        totalToolsCompleted++;
        const progressState = useAppStore.getState().agentProgress;
        useAppStore.getState().setAgentProgress({
          toolsCompleted: totalToolsCompleted,
          recentTools: progressState.recentTools.map((t) => 
            t.id === tc.id ? { ...t, status: toolStatus } : t
          ),
        });
        
        // Per-tool result size limits (chars) — prevents token budget blowouts
        const truncatedResult = truncateToolResult(result);
        
        console.log(`[aiService] Tool ${tc.name}: ${truncatedResult.length} chars`);
        
        return {
          type: 'tool_result',
          tool_use_id: tc.id,
          name: tc.name,
          content: truncatedResult,
        };
      });
      
      const toolResults = await executeWithConcurrency(toolTasks, MAX_CONCURRENT_TOOLS, abortSignal);

      // If aborted during tool execution, exit immediately
      if (abortSignal.aborted) {
        console.log('[aiService] Aborted during tool execution');
        useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'aborted' });
        break;
      }

      // Tools for this round are finished — switch off "Executing tools" immediately.
      // Otherwise status stays `executing` until the next model round starts (line ~1785), which
      // can be a long gap while we snapshot internals, token-count history via IPC, append
      // deflated tool results, and run compression heuristics — looks like a hung tool loop.
      useAppStore.getState().setAgentProgress({ status: 'thinking' });

      // Deterministic blocker merge: any non-null blocker wins over task_complete's implicit clear
      if (roundCompletionBlockers.length > 0) {
        const prev: string | null = runtimeCompletionBlocker;
        runtimeCompletionBlocker = mergeCompletionBlockers(roundCompletionBlockers);
        useAppStore.getState().setAgentProgress({ canTaskComplete: runtimeCompletionBlocker == null });
        if (runtimeCompletionBlocker !== prev) {
          console.log(`[aiService][telemetry] completionBlocker merged: ${prev ?? '(none)'} → ${runtimeCompletionBlocker ?? '(none)'} (round=${round}, sources=${roundCompletionBlockers.map(b => b.toolName).join(',')})`);
        }
      }

      if (roundObservedNonCompletionTool && startedWithStateChanged && roundPendingAction.kind === 'state_changed') {
        roundPendingAction = { kind: 'none', source: 'system', summary: '' };
      }

      if (roundPendingAction.kind !== 'none') {
        useAppStore.getState().setAgentPendingAction(roundPendingAction);
        useAppStore.getState().setAgentProgress({
          status: 'stopped',
          stoppedReason: getPendingActionStopReason(roundPendingAction),
        });
        useAppStore.getState().setAgentCanContinue(canAutoContinuePendingAction(roundPendingAction));
        console.log('[aiService] Pending action blocks completion - exiting loop');
        break;
      }

      useAppStore.getState().clearAgentPendingAction();
      useAppStore.getState().setAgentProgress({ canTaskComplete: runtimeCompletionBlocker == null });

      const hadMutationsThisRound = _roundHadMutations;
      await captureInternalsSnapshot(!hadMutationsThisRound);

      // Refresh entry manifest + project tree so next round/chat sees current state
      if (hadMutationsThisRound) {
        _roundHadMutations = false;
        resetProjectTreeCache();
        invoke<ProjectProfile>('atls_get_project_profile')
          .then(profile => useAppStore.setState({ projectProfile: profile }))
          .catch(() => {});
      }

      // Assistant must be in history before deflate so buildCompressionDescription
      // can pair tool_use_id with the batch/read.* input (otherwise every result
      // falls back to description "tool_result" and source-match reuses one stale engram).
      conversationHistory.push({ role: 'assistant', content: assistantContent });

      // Stub batch tool_use inputs: replace full step arrays with compact
      // summaries ("7 steps: search×3, read×2, pin×2") since the results
      // are the canonical record. Must run AFTER push so the assistant
      // message is in history, but BEFORE deflate uses buildCompressionDescription
      // which only needs tool name/first-step, not full args.
      stubBatchToolUseInputs(conversationHistory);

      // Retention-op compaction: strip specific hash args from pin/unpin/drop/
      // unload/compact/bb.delete steps that survived the 80-token stub threshold,
      // and collapse their OK per-step result lines to `ok`. Kills ghost-ref
      // leakage from tool_use/tool_result into the model's next-round view
      // without touching reasoning, text, or non-retention ops.
      // Runs pre-BP3 so the compacted form is what lands in the cacheable prefix.
      compactRetentionOps(conversationHistory, toolResults);

      // Eager deflation: replace tool_result content with hash-pointer refs
      // when the content already lives in the context store as an engram.
      // This makes the engram the single source of truth and avoids sending
      // duplicate content in both history and working memory.
      deflateToolResults(toolResults, conversationHistory);

      conversationHistory.push({ role: 'user', content: toolResults });

      // task_complete was called — auto-verify if needed, then stop.
      if (taskCompleteCalled) {
        if (anyRoundHadMutations && !_hadVerification
            && (mode === 'agent' || mode === 'refactor')) {
          try {
            console.log('[aiService] Auto-verify: running verify.build after task_complete');
            const verifyResult = await atlsBatchQuery('verify', { type: 'build' });
            const { passed } = classifyVerifyResult(verifyResult);
            _hadVerification = true;
            if (!passed) {
              const r = verifyResult as Record<string, unknown>;
              const errors = typeof r.output === 'string' ? r.output : (typeof r.summary === 'string' ? r.summary : 'verify.build failed');
              console.log('[aiService] Auto-verify failed — injecting errors, model continues');
              taskCompleteCalled = false;
              conversationHistory.push({
                role: 'user',
                content: `Auto-verify failed after task_complete:\n${errors}\nFix these build errors.`,
              });
              continue;
            }
            console.log('[aiService] Auto-verify passed');
          } catch (e) {
            console.log('[aiService] Auto-verify tool error — not blocking completion:', e);
          }
        }
        console.log('[aiService] task_complete called — stopping tool loop');
        useAppStore.getState().clearAgentPendingAction();
        useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'completed' });
        useAppStore.getState().setAgentCanContinue(false);
        break;
      }

      // --- Structured behavior enforcement ---

      // Finalize round coverage tracking for convergence detection
      useContextStore.getState().finishRoundCoverage(hadMutationsThisRound);

      if (hadMutationsThisRound) {
        anyRoundHadMutations = true;
        hadProgressSinceLastAdvance = true;
      }

      // Track consecutive read-only rounds (telemetry + spin diagnosis; no force-stop).
      if (!hadMutationsThisRound) {
        consecutiveReadOnlyRounds++;
        totalResearchRounds++;
      } else {
        consecutiveReadOnlyRounds = 0;
      }

      // Layer 2C: session.advance abuse detection + phase budget (logging)
      const taskPlanAdv = useContextStore.getState().taskPlan;
      if (taskPlanAdv?.activeSubtaskId) {
        if (taskPlanAdv.activeSubtaskId !== lastActiveSubtaskId) {
          const prevId = lastActiveSubtaskId;
          if (prevId) {
            const count = (advanceCountBySubtask.get(prevId) ?? 0) + 1;
            advanceCountBySubtask.set(prevId, count);
            if (count > 1 && !hadProgressSinceLastAdvance) {
              console.log(`[aiService] Advance abuse: "${prevId}" advanced ${count}x without progress (via state block)`);
            }
          }
          roundsInCurrentPhase = 0;
          lastActiveSubtaskId = taskPlanAdv.activeSubtaskId;
          hadProgressSinceLastAdvance = false;
        }
        roundsInCurrentPhase++;
        if (roundsInCurrentPhase >= PHASE_ROUND_BUDGET) {
          console.log(`[aiService] Phase budget exceeded: ${roundsInCurrentPhase} rounds in "${taskPlanAdv.activeSubtaskId}" (via state block)`);
        }
      }

      // Plan nudge (logging)
      if (round === 1 && !useContextStore.getState().taskPlan && !hadMutationsThisRound
          && mode !== 'ask' && mode !== 'retriever' && mode !== 'designer') {
        console.log('[aiService] Task plan nudge active (via state block)');
      }

      // Layer 2D: Total-round convergence guard (logging; not separate preamble lines)
      if (mode !== 'ask' && mode !== 'retriever' && mode !== 'designer') {
        if (round + 1 >= TOTAL_ROUND_ESCALATION) {
          console.log(`[aiService] Convergence escalation at round ${round + 1} (via state block)`);
        } else if (round + 1 >= TOTAL_ROUND_SOFT_BUDGET) {
          console.log(`[aiService] Convergence nudge at round ${round + 1} (via state block)`);
        }
      }

      // Signal UI to save current-round text before next round streams new tokens
      safeCallbacks.onClear?.();

      // Safety compression deferred to round 0 to keep history append-only
      // within a tool loop (preserves prefix cache stability). Only compress
      // mid-loop at a much higher threshold to prevent context overflow.
      const estimatedHistoryTokens = estimateHistoryTokens(conversationHistory);
      const safetyThreshold = round === 0
        ? CONVERSATION_HISTORY_BUDGET_TOKENS
        : CONVERSATION_HISTORY_BUDGET_TOKENS * 3;
      // Also check provider-reported input tokens — heuristic estimates can
      // undercount vs actual tokenizer, letting context grow unchecked.
      const providerExceedsThreshold = roundInputTokens > 0
        && roundInputTokens > safetyThreshold * 4;
      if (estimatedHistoryTokens > safetyThreshold || providerExceedsThreshold) {
        const triggerSource = providerExceedsThreshold && estimatedHistoryTokens <= safetyThreshold
          ? 'provider-reported' : 'heuristic';
        const preCompressionHashes = new Set(useContextStore.getState().chunks.keys());
        const count = compressToolLoopHistory(conversationHistory, round, priorTurnBoundary, { emergency: true });
        if (count > 0) {
          console.log(`[aiService] SAFETY: auto-compressed ${count} history entries (${triggerSource}: history=${(estimatedHistoryTokens / 1000).toFixed(1)}k, provider=${(roundInputTokens / 1000).toFixed(1)}k, threshold=${(safetyThreshold / 1000).toFixed(1)}k${round > 0 ? ', mid-loop emergency' : ''})`);
          const postHashes = useContextStore.getState().chunks;
          const evicted: string[] = [];
          for (const h of preCompressionHashes) {
            const chunk = postHashes.get(h);
            if (!chunk || chunk.compacted) evicted.push(`h:${h.slice(0, 6)}`);
          }
          if (evicted.length > 0) {
            recordHashRefsEvicted(evicted);
          }
        }
      }
    }

    // Loop exhausted all rounds without an inner break — ensure progress is terminal
    const loopExitProg = useAppStore.getState().agentProgress;
    if (loopExitProg.status !== 'stopped' && loopExitProg.status !== 'idle') {
      console.log(`[aiService] Tool loop exhausted ${maxRounds} rounds — forcing stopped state`);
      useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'max_rounds' });
      useAppStore.getState().setAgentCanContinue(true);
    }
  } catch (error) {
    console.error('[aiService] Stream error:', error);
    if (!abortSignal.aborted) {
      useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'error', canTaskComplete: true });
      safeCallbacks.onError(error instanceof Error ? error : new Error(String(error)));
    } else {
      // Abort path: catch block didn't set stopped — fix stale progress
      const abortProg = useAppStore.getState().agentProgress;
      if (abortProg.status !== 'stopped' && abortProg.status !== 'idle') {
        useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'aborted' });
      }
    }
  } finally {
    const shouldNotifyDone = _activeSession === session;

    if (shouldNotifyDone) {
      callbacks.onDone();
    }

    // End-of-turn compression: compress history NOW so the prefix is cached
    // by Anthropic with the compressed bytes. On the next user turn we reuse
    // this compressed history instead of rebuilding from UI messages (which
    // would produce uncompressed content → different bytes → cache miss).
    if (shouldNotifyDone && conversationHistory.length > 0) {
      try {
        compressToolLoopHistory(conversationHistory, undefined, priorTurnBoundary);
        _endOfTurnHistory = structuredClone(conversationHistory);
        _endOfTurnUiMessageCount = useAppStore.getState().messages.length;
        // Advance the frozen prefix to cover everything finalized this turn.
        // Next turn's compressToolLoopHistory uses this as `startIdx` so it
        // only ever mutates messages appended AFTER this point.
        _endOfTurnBoundary = conversationHistory.length;
      } catch (e) {
        console.warn('[aiService] End-of-turn history cache failed:', e);
        invalidateHistoryCache();
      }
    }

    // Prune low-value context chunks on natural completion
    const finalStatus = useAppStore.getState().agentProgress.stoppedReason;
    if (shouldNotifyDone && finalStatus === 'completed') {
      const pruned = useContextStore.getState().pruneObsoleteTaskArtifacts();
      if (pruned.compacted > 0 || pruned.dropped > 0) {
        console.log(`[aiService] Post-completion prune: compacted=${pruned.compacted} dropped=${pruned.dropped} freed=${pruned.freedTokens}tk`);
      }
    }

    // Only clear global state if this session is still active (prevents race where
    // a newer session started and this stale session would overwrite its state)
    if (shouldNotifyDone) {
      _activeSession = null;
      currentAbortController = null;
      setRoundRefreshRevisionResolver(null);
    }
    session.activeStreamIds.clear();
    if (_activeSession === session || _activeSession === null) {
      _toolLoopState = null;
      useAppStore.getState().setToolLoopSteering(null);
    }
  }
}

// ============================================================================
// Manage Batch Tool
// ============================================================================

// Recall limits
const RECALL_MAX_CHARS = 50000;
const RECALL_BATCH_MAX_CHARS = 100000;

/**
 * Collect human-readable details for chunks about to be operated on.
 * Must be called BEFORE the operation (drop/compact) removes them from the store.
 */
function collectChunkDetails(
  hashes: string[],
  store: () => { chunks: Map<string, { hash: string; shortHash: string; source?: string; tokens: number }> },
): string {
  if (hashes.length === 0 || hashes.includes('*') || hashes.includes('all')) return '';
  const chunks = store().chunks;
  const details: string[] = [];
  for (const h of hashes) {
    const normalized = h.startsWith('h:') ? h.slice(2) : h;
    for (const [, chunk] of chunks) {
      if (chunk.hash === normalized || chunk.shortHash === normalized || chunk.hash.startsWith(normalized) || normalized.startsWith(chunk.hash)) {
        const name = chunk.source ? (chunk.source.split(/[/\\]/).pop() || chunk.source) : chunk.shortHash;
        details.push(`h:${chunk.shortHash} ${name}`);
        break;
      }
    }
  }
  return details.join(', ');
}

async function expandFilePathRefs(
  rawPaths: string[],
  hashLookup: HashLookup,
  setLookup: SetRefLookup,
): Promise<{ items: ExpandedFilePath[]; notes: string[] }> {
  const state = useAppStore.getState();
  return expandCanonicalFilePathRefs(rawPaths, hashLookup, setLookup, {
    sessionId: state.currentSessionId ?? null,
    projectPath: state.projectPath ?? null,
    resolveHashRef: async (rawRef, sessionId) => {
      try {
        return await invoke<{ source?: string | null; content: string }>('resolve_hash_ref', {
          rawRef,
          sessionId,
        });
      } catch {
        return null;
      }
    },
    expandFileGlob: async (projectRoot, pattern) => invoke<string[]>('expand_file_glob', {
      projectRoot,
      pattern,
    }),
  });
}

/**
 * Expand set refs (h:@selector) in a hashes array to individual hashes.
 * Returns the expanded array and a human-readable expansion note for the model.
 */
function expandSetRefsInHashes(
  hashes: string[],
  setLookup: SetRefLookup,
): { expanded: string[]; notes: string[] } {
  return expandCanonicalSetRefsInHashes(hashes, setLookup);
}

// ============================================================================
// Unified Batch — HandlerContext factory
// ============================================================================

/** Compute abs path for a workspace (projectPath + ws.path). */
function getWorkspaceAbsPath(ws: WorkspaceEntry, projectPath: string): string {
  if (ws.abs_path) return ws.abs_path;
  if (ws.path === '.') return projectPath;
  const sep = projectPath.includes('\\') ? '\\' : '/';
  const base = projectPath.replace(/[/\\]+$/, '');
  return `${base}${sep}${ws.path.replace(/\//g, sep)}`;
}

/** Resolve workspace rel_path by name or from active workspace. Returns null for root or no match. */
function getWorkspaceRelPath(name?: string): string | null {
  const state = useAppStore.getState();
  const workspaces = state.projectProfile?.workspaces ?? [];
  const projectPath = state.projectPath ?? '';
  const activeRoot = state.activeRoot;

  if (workspaces.length === 0) return null;

  if (name != null && name !== '') {
    const norm = name.replace(/\\/g, '/').trim();
    const ws = workspaces.find(
      (w) => w.name === name || w.path === name || w.path.replace(/\\/g, '/') === norm
    );
    if (!ws || ws.path === '.') return null;
    return ws.path;
  }

  if (!activeRoot || activeRoot === projectPath) return null;
  const arNorm = activeRoot.replace(/\\/g, '/');
  const ppNorm = projectPath.replace(/\\/g, '/');

  const ws = workspaces.find((w) => {
    if (w.path === '.') return ppNorm === arNorm;
    const abs = getWorkspaceAbsPath(w, projectPath).replace(/\\/g, '/');
    return abs === arNorm;
  });
  if (!ws || ws.path === '.') return null;
  return ws.path;
}

function createHandlerContext(options?: { isSwarmAgent?: boolean; swarmTerminalId?: string; onSubagentProgress?: (stepId: string, progress: import('./batch/types').SubAgentProgressEvent) => void }): HandlerContext {
  // Cast through unknown: ContextStoreState is a superset of ContextStoreApi
  // but TS can't verify structural compatibility with the minimal projection.
  const store = useContextStore.getState as unknown as HandlerContext['store'];
  const setLookup = store().createSetRefLookup();
  const sessionId = useAppStore.getState().currentSessionId;
  const syncLookup = createHashLookup(sessionId);
  const hashLookup: import('../utils/hashResolver').HashLookup = async (hash: string) => {
    const r = syncLookup(hash.startsWith('h:') ? hash.slice(2) : hash);
    if (!r?.content) return null;
    return { content: r.content, source: r.source };
  };

  return {
    store,
    setLookup,
    hashLookup,
    atlsBatchQuery: (op: string, params: Record<string, unknown>) => atlsBatchQuery(op, params) as Promise<unknown>,
    sessionId,
    isSwarmAgent: options?.isSwarmAgent ?? (!!options?.swarmTerminalId || _isSwarmAgentContext),
    swarmTerminalId: options?.swarmTerminalId,
    getProjectPath: () => getProjectPath(),
    getWorkspaceRelPath: (name?: string) => getWorkspaceRelPath(name),
    resolveSearchRefs: (params: Record<string, unknown>) => resolveSearchRefs(params, getTurn()),
    expandSetRefsInHashes: (hashes: string[]) => expandSetRefsInHashes(hashes, setLookup),
    expandFilePathRefs: (rawPaths: string[]) => expandFilePathRefs(rawPaths, hashLookup, setLookup),
    get toolLoopState() { return _activeSession?.toolLoopState ?? _toolLoopState; },
    onSubagentProgress: options?.onSubagentProgress,
  };
}

// ============================================================================
// Tool Execution
// ============================================================================

function normalizeToolParams(args: Record<string, unknown>): void {
  if (args.steps !== undefined) {
    args.steps = coerceBatchSteps(args.steps);
  }
}

function batchStepWithParams(stepRecord: unknown): Record<string, unknown> {
  if (!stepRecord || typeof stepRecord !== 'object' || Array.isArray(stepRecord)) return {};
  const rec = stepRecord as Record<string, unknown>;
  const w = rec.with;
  return w && typeof w === 'object' && !Array.isArray(w) ? (w as Record<string, unknown>) : {};
}

/** @internal Exported for testing. */
export function buildBatchSyntheticToolCalls(result: UnifiedBatchResult, batchArgs: Record<string, unknown>): ToolCallEvent[] {
  const rawSteps = Array.isArray(batchArgs.steps) ? batchArgs.steps as Array<Record<string, unknown>> : [];
  return result.step_results.map((step, index) => {
    const rawStep = rawSteps.find(s => String(s?.id ?? '') === step.id) ?? rawSteps[index];
    const withParams = batchStepWithParams(rawStep);
    const art = step.artifacts as Record<string, unknown> | undefined;
    const toolTrace = Array.isArray(art?.toolTrace) ? art.toolTrace as unknown[] : undefined;
    return {
      id: `batch:${typeof batchArgs.id === 'string' ? batchArgs.id : 'batch'}:${step.id}:${index}`,
      name: step.use,
      args: {
        ...withParams,
        batch_id: typeof batchArgs.id === 'string' ? batchArgs.id : undefined,
        step_id: step.id,
        step_use: step.use,
        refs: step.refs,
        ...(toolTrace?.length ? { toolTrace } : {}),
      },
      status: step.ok ? 'completed' : 'failed',
      result: step.summary ?? step.error ?? '',
    };
  });
}

async function executeToolCallDetailed(
  toolName: string,
  args: Record<string, unknown>,
  options?: { swarmTerminalId?: string; fileClaims?: string[]; onBatchStepProgress?: OnBatchStepComplete; onSubagentProgress?: (stepId: string, progress: import('./batch/types').SubAgentProgressEvent) => void },
): Promise<ToolExecutionResult> {
  console.log(`[aiService] Tool: ${toolName}`, args);
  
  try {
    args = { ...args };

    if (!toolName || typeof toolName !== 'string' || toolName.trim().length < 2) {
      const nearest = findNearestValidTool(toolName);
      const hint = nearest ? ` Did you mean: ${nearest}?` : '';
      return { displayText: `Invalid or empty tool name "${toolName}".${hint} Valid tools: batch` };
    }

    normalizeToolParams(args);
    useContextStore.getState().recordToolCall();

    switch (toolName) {
      case 'batch': {
        const expanded = expandBatchQ(args);
        if (expanded !== args) Object.keys(args).forEach(k => delete args[k]);
        Object.assign(args, expanded);

        const resolved = await resolveToolParams(args);
        Object.assign(args, resolved);

        const ctx = createHandlerContext({ swarmTerminalId: options?.swarmTerminalId, onSubagentProgress: options?.onSubagentProgress });
        if (options?.fileClaims?.length) ctx.fileClaims = options.fileClaims;
        const request = args as unknown as UnifiedBatchRequest;
        if (!request.version) (request as unknown as Record<string, unknown>).version = '1.0';
        if (!request.steps) return { displayText: 'batch: ERROR missing steps array' };

        request.policy = normalizeBatchPolicyForExecution(
          useAppStore.getState().chatMode === 'ask',
          request.policy,
        );

        const result = await executeUnifiedBatch(request, ctx, options?.onBatchStepProgress);
        if (result.step_results.some(step => step.ok && step.use.startsWith('change.'))) {
          _roundHadMutations = true;
        }
        // Coder subagent applies edits in its own loop; parent batch has no change.* steps.
        if (result.step_results.some(step => step.ok && step.use === 'delegate.code')) {
          _roundHadMutations = true;
        }
        // Retriever subagent and substantive BB writes are real progress, not idle research.
        if (result.step_results.some(step => step.ok && step.use === 'delegate.retrieve')) {
          _roundHadMutations = true;
        }
        if (result.step_results.some(step => step.ok && step.use === 'session.bb.write')) {
          _roundHadMutations = true;
        }
        if (result.step_results.some(step => step.ok && step.use.startsWith('verify.'))) {
          _hadVerification = true;
        }

        // Spin diagnostics: accumulate round fingerprint from batch results
        recordToolSignature(result.step_results.map(s => s.use));
        recordBatchSpinSemantics(result.step_results);
        recordTargetFiles(extractTargetFilesFromStepResults(result.step_results));
        recordReadDiversity(result.step_results);
        recordBbDelta(extractBbDeltaFromStepResults(result.step_results, args));
        {
          const batchHashRefs = result.step_results
            .flatMap(s => [...(s.refs ?? []), ...(s.summary ? extractHashRefs(s.summary) : [])]);
          if (batchHashRefs.length > 0) recordHashRefsConsumed(batchHashRefs);
        }

        const lastEditRef = result.step_results
          .filter(s => s.use.startsWith('change.') && s.ok && s.refs?.length)
          .pop()?.refs?.[0];
        if (lastEditRef) {
          const hash = lastEditRef.startsWith('h:') ? lastEditRef.slice(2) : lastEditRef;
          const store = useContextStore.getState();
          store.pushHash(hash);
          store.pushEditHash(hash);
        }

        const displayText = formatBatchResult(result);
        const pendingAction = analyzeBatchPendingAction(result);
        const completionBlocker = deriveMutationCompletionBlocker(result);
        const syntheticChildren = buildBatchSyntheticToolCalls(result, args);
        const batchStepOutcomes = result.step_results.map((s) => ({ id: s.id, ok: s.ok }));
        return {
          displayText,
          meta: {
            ...(pendingAction ? { pendingAction } : {}),
            ...(syntheticChildren.length > 0 ? { syntheticChildren } : {}),
            completionBlocker,
            batchOk: result.ok,
            batchStepOutcomes,
          },
        };
      }

      case 'task_complete': {
        const summary = args.summary as string || 'Task completed';
        const rawFilesChanged = Array.isArray(args.files_changed)
          ? args.files_changed
          : Array.isArray(args.filesChanged)
            ? args.filesChanged
            : [];
        const filesChanged = rawFilesChanged.filter((f): f is string => typeof f === 'string');
        const filesList = filesChanged.length > 0 ? `\nFiles: ${filesChanged.join(', ')}` : '';

        // Auto-advance any remaining subtasks so plan state is clean on exit
        const plan = useContextStore.getState().taskPlan;
        if (plan) {
          for (const st of plan.subtasks) {
            if (st.status !== 'done') {
              useContextStore.getState().advanceSubtask(st.id, summary);
            }
          }
        }

        return { displayText: `✓ Task complete: ${summary}${filesList}` };
      }

      default: {
        const nearest = findNearestValidTool(toolName);
        const hint = nearest ? ` Did you mean: ${nearest}?` : '';
        return { displayText: `Unsupported tool: ${toolName}.${hint} Use batch() for execution.` };
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(`[executeToolCall] ${toolName} failed:`, msg, '\nArgs keys:', Object.keys(args), '\nStack:', stack);
    return { displayText: `Error: ${msg}` };
  }
}

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  options?: { swarmTerminalId?: string; fileClaims?: string[] },
): Promise<string> {
  const result = await executeToolCallDetailed(toolName, args, {
    swarmTerminalId: options?.swarmTerminalId,
    fileClaims: options?.fileClaims,
  });
  return result.displayText;
}

// ============================================================================
// Helpers
// ============================================================================

// toTOON and formatResult imported from '../utils/toon'

/**
 * Build token-efficient workspace representation.
 * <=15 workspaces: list individually [{n,p,t},...].
 * >15: summary with default type, exceptions, groups, and active workspace.
 */
function buildWorkspaceTOON(workspaces: WorkspaceEntry[], activeFile?: string | null): unknown {
  // Resolve active workspace from file path prefix
  const findActive = () => {
    if (!activeFile) return undefined;
    const norm = activeFile.replace(/\\/g, '/').toLowerCase();
    let best: WorkspaceEntry | undefined;
    for (const ws of workspaces) {
      const wsPath = ws.path.replace(/\\/g, '/').toLowerCase();
      if (wsPath === '.') continue; // root matches everything, skip
      const wsPrefix = wsPath.endsWith('/') ? wsPath : `${wsPath}/`;
      if ((norm === wsPath || norm.startsWith(wsPrefix)) && (!best || ws.path.length > best.path.length)) {
        best = ws;
      }
    }
    return best;
  };
  const active = findActive();

  if (workspaces.length <= 15) {
    // Compact list: each workspace as {n,p,t}
    const list = workspaces.map(ws => {
      const entry: Record<string, unknown> = {
        n: ws.name,
        p: ws.path,
        t: ws.types.join(','),
      };
      if (ws.group) entry.g = ws.group;
      return entry;
    });
    if (active) {
      return { list, active: active.name };
    }
    return list;
  }

  // Large monorepo: summary + exceptions + groups + active
  const typeCounts: Record<string, number> = {};
  const groupCounts: Record<string, number> = {};
  for (const ws of workspaces) {
    for (const t of ws.types) {
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    const g = ws.group || '(root)';
    groupCounts[g] = (groupCounts[g] || 0) + 1;
  }

  // Find dominant type
  let defaultType = '';
  let defaultCount = 0;
  for (const [t, c] of Object.entries(typeCounts)) {
    if (c > defaultCount) {
      defaultType = t;
      defaultCount = c;
    }
  }

  // Exceptions: workspaces whose types don't include the dominant type
  const exceptions: Record<string, string[]> = {};
  for (const ws of workspaces) {
    if (!ws.types.includes(defaultType)) {
      const key = ws.types.join(',') || 'unknown';
      if (!exceptions[key]) exceptions[key] = [];
      exceptions[key].push(ws.name);
    }
  }

  const summary: Record<string, unknown> = {
    n: workspaces.length,
    default: defaultType,
    types: typeCounts,
    groups: groupCounts,
  };
  if (Object.keys(exceptions).length > 0) {
    summary.except = exceptions;
  }
  if (active) {
    summary.active = { n: active.name, p: active.path, t: active.types.join(',') };
  }
  return summary;
}

/**
 * Build workspace context in TOON format.
 * @param minimal - When true, only volatile per-turn state (file, line, branch).
 *   Entry points are not duplicated here: `entryManifestDepth` controls ## Entry Points in BP1 only.
 *   Full profile is sent on the first tool round; later rounds use minimal to save ~200 tokens.
 */
function buildContextTOON(context: WorkspaceContext, minimal = false): string {
  const ctx: Record<string, unknown> = {};
  
  if (!minimal) {
    // Full profile (refreshed after mutations)
    if (context.profile) {
      const p = context.profile;
      ctx.proj = p.proj;
      ctx.stats = { f: p.stats.files, loc: p.stats.loc, langs: p.stats.langs };
      if (p.stack.length > 0) ctx.stack = p.stack;
      if (p.arch.mods.length > 0) ctx.mods = p.arch.mods;
      ctx.health = p.health.issues;
      if (p.health.hotspots.length > 0) ctx.hotspots = p.health.hotspots;
      if (p.deps.prod.length > 0) ctx.deps = p.deps.prod.slice(0, 6);

      // Workspace context: threshold-compressed representation
      if (p.workspaces && p.workspaces.length > 0) {
        ctx.ws = buildWorkspaceTOON(p.workspaces, context.activeFile);
      }
    }
  }

  // Per-turn editor state (always included).
  // `activeFile === INTERNALS_TAB_ID` means the ATLS Internals dev panel
  // is focused — NOT a real repo path. Surfacing it to the model as
  // `file:__atls_internals__` is leaked editor state that looks like a
  // workspace file and mis-cues tool targeting.
  if (context.activeFile && context.activeFile !== INTERNALS_TAB_ID && context.activeFile !== SWARM_ORCHESTRATION_TAB_ID) {
    ctx.file = context.activeFile;
    if (context.cursorLine) ctx.ln = context.cursorLine;
  }
  if (context.openFiles && context.openFiles.length > 1) {
    ctx.tabs = context.openFiles.length;
  }
  if (context.gitBranch) {
    ctx.br = context.gitBranch;
  }
  
  // Focus profile (tells AI what categories/severities the user cares about)
  if (!minimal && context.focusProfile) {
    ctx.focus = {
      profile: context.focusProfile.name,
      matrix: context.focusProfile.matrix,
    };
  }
  
  return toTOON(ctx);
}

export { BATCH_TOOL_REF } from '../prompts/toolRef';
// ============================================================================
// Symbol Extraction (for chunk digests)
// ============================================================================

/**
 * Extract symbol info from an ATLS context result for digest generation.
 * Handles both single-file and multi-file responses from atls_batch_query.
 */
function extractSymbolsFromContextResult(result: unknown): DigestSymbol[] | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const symbols: DigestSymbol[] = [];

  const extractFromObj = (obj: Record<string, unknown>) => {
    // SmartContextResult has { context: { symbols: [...] } } or { symbols: [...] }
    const ctx = (obj.context ?? obj) as Record<string, unknown>;
    const syms = ctx.symbols;
    if (!Array.isArray(syms)) return;
    for (const s of syms) {
      if (s && typeof s === 'object' && 'name' in s && 'kind' in s) {
        symbols.push({ name: String(s.name), kind: String(s.kind), signature: s.signature as string | null });
      }
    }
  };

  if (Array.isArray(result)) {
    for (const item of result) {
      if (item && typeof item === 'object') extractFromObj(item as Record<string, unknown>);
    }
  } else {
    extractFromObj(result as Record<string, unknown>);
  }

  return symbols.length > 0 ? symbols : undefined;
}

// ============================================================================
// Working Memory Block Builder
// ============================================================================

/**
 * Build the working memory block for Layer 3 injection.
 * 
 * Returns formatted chunk data (task plan, blackboard, loaded files).
 * Context control instructions live in the static system prompt for caching.
 */
function buildWorkingMemoryBlock(): string {
  return useContextStore.getState().getWorkingMemoryFormatted();
}

const REASONING_RECAP_MAX_CHARS = 1500;

/**
 * Extract a condensed reasoning recap from the model's most recent assistant
 * messages in the tool loop history. Gives the model continuity even after
 * history compression has replaced older content with hash pointers.
 */
function _extractRecentReasoning(): string {
  const history = _toolLoopState?.conversationHistory;
  if (!history || history.length < 2) return '';

  const textChunks: string[] = [];
  let scanned = 0;
  for (let i = history.length - 1; i >= 0 && scanned < 5; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;
    scanned++;
    if (typeof msg.content === 'string') {
      const t = msg.content.trim();
      if (t && !isCompressedRef(t)) {
        textChunks.unshift(t);
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: string; thinking?: string };
        if (b.type === 'text' && b.text) {
          const t = b.text.trim();
          if (t && !isCompressedRef(t)) textChunks.unshift(t);
        } else if ((b.type === 'reasoning' || b.type === 'thinking') && (b.text || b.thinking)) {
          const t = (b.text ?? b.thinking ?? '').trim();
          if (t && !isCompressedRef(t)) textChunks.unshift(t);
        }
      }
    }
  }

  if (textChunks.length === 0) return '';

  let combined = textChunks.join('\n').trim();
  if (combined.length > REASONING_RECAP_MAX_CHARS) {
    combined = combined.slice(combined.length - REASONING_RECAP_MAX_CHARS);
    const firstNewline = combined.indexOf('\n');
    if (firstNewline > 0 && firstNewline < 80) combined = combined.slice(firstNewline + 1);
    combined = '...' + combined;
  }

  return `<<RECENT REASONING (your last output):\n${combined}\n>>`;
}

/**
 * Build the dynamic context block for injection into the last user message.
 *
 * This content was previously in the system prompt's dynamic suffix but
 * is now in the messages array so the system prompt stays 100% static
 * for provider prefix caching (BP1).
 *
 * Exported for focused regression tests (e.g. the HASH MANIFEST filter
 * that suppresses file-backed chunks covered by pinned FileViews).
 */
export function buildDynamicContextBlock(
  workspaceContext?: WorkspaceContext,
  projectTree?: string,
  isFirstTurn?: boolean,
): string {
  const parts: string[] = [];

  // -------------------------------------------------------------------------
  // HASH MANIFEST — authoritative index of every hash the model may encounter
  // -------------------------------------------------------------------------
  {
    const currentTurn = getTurn();
    pruneStaleEntries(currentTurn, 5);
    const ctxState = useContextStore.getState();
    const allRefs = getAllRefs();

    // File-backed chunks whose source matches a pinned FileView are
    // represented by the view itself — they must NOT show up as separate
    // manifest rows. If we leave them in, the model sees the fresh pinned
    // `fv` row AND one-or-more `dorm`/active rows for the same file path
    // (e.g. after `vb` compacts the post-edit file chunk) and interprets
    // the extra rows as staleness, triggering a redundant re-read.
    //
    // Policy matches `contextFormatter.ts` for `## ACTIVE ENGRAMS`: suppress
    // file-backed `viewKind: 'latest'` chunks whose normalized source path
    // matches a PINNED view. Unpinned views don't render, so their chunks
    // still show normally.
    const pinnedViewPaths = new Set<string>();
    for (const v of ctxState.fileViews.values()) {
      if (v.pinned) pinnedViewPaths.add(v.filePath.replace(/\\/g, '/').toLowerCase());
    }
    const FILE_BACKED = new Set(['file', 'smart', 'raw', 'tree']);
    const isCoveredByPinnedView = (source: string | undefined, type: string, viewKind: string | undefined): boolean => {
      if (!source || !FILE_BACKED.has(type)) return false;
      if (viewKind && viewKind !== 'latest') return false;
      return pinnedViewPaths.has(source.replace(/\\/g, '/').toLowerCase());
    };

    // Self-referential batch receipts: `call` chunks created by
    // `compressToolLoopHistory` (tool_use input compression) and `result`
    // chunks created by `deflateToolResults` are labeled with the batch
    // envelope (`batch`, `batch:...`, `result:toolu_...`). Their content is
    // either a stub summary or batch-shell scaffolding — both derivable
    // from the running transcript. Suppress from the manifest so the model
    // doesn't see its own past tool calls rematerialized as engrams. The
    // hashes stay resolvable by HPP (manifest is display only); retention
    // ops (session.unload/drop/compact) still work by h:ref.
    const isBatchEnvelopeRow = (source: string | undefined, type: string): boolean => {
      if (!source) return false;
      if (type === 'call') return /^batch\b/.test(source);
      if (type === 'result') return /^batch\b/.test(source) || /^result:toolu_/.test(source);
      return false;
    };

    const activeChunks: Array<{ shortHash: string; type: string; source?: string; tokens: number; pinned?: boolean; pinnedShape?: string; compacted?: boolean; freshness?: string; freshnessCause?: string; suspectSince?: number; supersededBy?: { hashes: string[]; note: string } }> = [];
    const dematRefs: typeof allRefs = [];
    for (const ref of allRefs) {
      if (ref.visibility === 'materialized') {
        const chunk = ctxState.chunks.get(ref.hash);
        if (!chunk || chunk.type === 'msg:user' || chunk.type === 'msg:asst') continue;
        if (isCoveredByPinnedView(chunk.source, chunk.type, chunk.viewKind)) continue;
        if (isBatchEnvelopeRow(chunk.source, chunk.type)) continue;
        activeChunks.push({
          shortHash: chunk.shortHash, type: chunk.type, source: chunk.source,
          tokens: chunk.tokens, pinned: chunk.pinned, pinnedShape: chunk.pinnedShape,
          compacted: chunk.compacted, freshness: chunk.freshness as string | undefined,
          freshnessCause: chunk.freshnessCause as string | undefined, suspectSince: chunk.suspectSince,
          supersededBy: chunk.supersededBy,
        });
      } else if (ref.visibility === 'referenced') {
        // Dematerialized refs carry the same risk: a post-edit file chunk
        // that got compacted + dematerialized (e.g. by `vb`) would show up
        // as `dormant | rec to restore` next to the pinned view for the
        // same path. Filter by source + type the same way.
        if (isCoveredByPinnedView(ref.source, ref.type, undefined)) continue;
        if (isBatchEnvelopeRow(ref.source, ref.type)) continue;
        dematRefs.push(ref);
      }
    }
    // Include FileViews as `fileview` manifest rows keyed by view.shortHash
    // (the retention ref). FileViews live in ctxState.fileViews, not
    // ctxState.chunks, so the loop above misses them — leaving pinned views
    // visible in WM but absent from the HASH MANIFEST. Without this, pu/pc/dro
    // targets (which resolve on view.shortHash) appear "stale" to the model.
    const seenActiveShort = new Set(activeChunks.map(c => c.shortHash));
    for (const view of ctxState.fileViews.values()) {
      if (seenActiveShort.has(view.shortHash)) continue;
      seenActiveShort.add(view.shortHash);
      const est = estimateFileViewTokens(view, currentTurn);
      activeChunks.push({
        shortHash: view.shortHash,
        type: 'fileview',
        source: view.filePath,
        tokens: est.total,
        pinned: view.pinned,
        pinnedShape: view.pinnedShape,
        compacted: false,
        freshness: view.freshness === 'suspect' ? 'suspect' : 'fresh',
        freshnessCause: view.freshnessCause as string | undefined,
        suspectSince: undefined,
        supersededBy: undefined,
      });
    }
    // Archived refs also filter — a compacted/evicted file chunk for a
    // pinned view's path should not render as `rec to restore` when the
    // view already carries the content.
    const archivedRefs = getArchivedHppRefs()
      .filter(r => !isCoveredByPinnedView(r.source, r.type, undefined))
      .filter(r => !isBatchEnvelopeRow(r.source, r.type));
    const manifestBlock = formatHashManifest({ activeChunks, dematRefs, archivedRefs, turn: currentTurn });
    parts.push(manifestBlock);
  }

  // -------------------------------------------------------------------------
  // ORIENTATION — model reads these first to know where it is
  // -------------------------------------------------------------------------

  const taskLine = useContextStore.getState().getTaskLine();
  const contextStatsLine = useContextStore.getState().getStatsLine();
  const cm = useAppStore.getState().cacheMetrics;
  // `cache:N%` = session-wide prefix-cache read share. Counterintuitive behavior
  // to document once: dropping volatile dynamic refs (dro/pc/ASSESS cleanup)
  // usually RAISES this number, because the stable prefix (BP1 system prompt +
  // BP3 frozen history) grows relative to the mutating dynamic tail. A rising
  // cache% after eviction is a sign the runtime is doing its job, not a bug.
  const cacheTag = cm.sessionRequests > 0 ? ` | cache:${(cm.sessionHitRate * 100).toFixed(0)}%` : '';
  const header = taskLine
    ? `${taskLine}\n${contextStatsLine}${cacheTag}`
    : `${contextStatsLine}${cacheTag}`;
  parts.push(header);

  const bbBlock = _buildBlackboardBlock();
  if (bbBlock) parts.push(bbBlock);

  const pendingActionBlock = buildPendingActionBlock();
  if (pendingActionBlock) {
    parts.push(pendingActionBlock);
  }

  // -------------------------------------------------------------------------
  // STEERING — edit awareness, repair escalation, context pressure
  // -------------------------------------------------------------------------
  // Each `<<...>>` injection below is gated by a user-facing toggle in
  // `settings.messageToggles` (see Spin Trace Interventions panel). Toggles
  // are read once per call so a rapid UI flip cannot tear within one round.

  const mt = useAppStore.getState().settings.messageToggles;

  const bbEntriesRaw = useContextStore.getState().listBlackboardEntries();
  const bbEntries = bbEntriesRaw.filter(e => canSteerExecution({ state: e.state }));
  const errBasenames = new Set(
    bbEntries.filter(e => e.key.startsWith('err:')).map(e => e.key.slice(4)),
  );
  const damagedEdits: string[] = [];
  const healthyEdits: string[] = [];
  for (const e of bbEntries) {
    if (!e.key.startsWith('edit:')) continue;
    const basename = e.key.slice(5);
    if (errBasenames.has(basename)) {
      const errEntry = bbEntries.find(b => b.key === `err:${basename}`);
      const errPreview = errEntry?.preview ?? 'verify.build FAILED';
      damagedEdits.push(`${basename} (${e.preview}) -- ${errPreview}`);
    } else {
      healthyEdits.push(`${basename} (${e.preview})`);
    }
  }
  if (mt.edits.damaged && damagedEdits.length > 0) {
    parts.push(`<<DAMAGED EDIT: ${damagedEdits.join('; ')}. Fix the error.>>`);
  }
  if (mt.edits.recent && healthyEdits.length > 0) {
    parts.push(`<<RECENT EDITS: ${healthyEdits.join(', ')}. Use edit-result h:refs directly; do not re-read.>>`);
  }

  if (mt.edits.escalatedRepair) {
    const escalatedRepairs = bbEntries
      .filter(e => e.key.startsWith('repair:') && e.state === 'active' && parseInt(e.preview, 10) >= 2)
      .map(e => `${e.key.slice(7)} (${e.preview} attempts)`);
    if (escalatedRepairs.length > 0) {
      parts.push(`<<ESCALATED REPAIR: ${escalatedRepairs.join(', ')}. Multiple failed repairs. Full scope in context. Review holistically before editing.>>`);
    }
  }

  // -------------------------------------------------------------------------
  // TOOL-LOOP STEERING — only hard safety nets and correctness guards
  // -------------------------------------------------------------------------
  const tls = useAppStore.getState().toolLoopSteering;
  if (tls && tls.mode !== 'ask' && tls.mode !== 'retriever') {
    if (tls.completionBlocked && tls.completionBlocker) {
      const isVerifyStale = /verify\b.*stale|stale.*verif/i.test(tls.completionBlocker);
      if (isVerifyStale && mt.completion.verifyStale) {
        parts.push('<<SYSTEM: Verification artifacts are stale. Re-run verification before finishing.>>');
      }
      // Generic "continue implementation" nudge deleted: the model just
      // received a tool result; no value added by narrating "continue".
    }
  }

  // -------------------------------------------------------------------------
  // SPIN CIRCUIT BREAKER — auto-escalating intervention (GAP 1)
  // Consumes the tier + message already computed in the tool loop before
  // this block was built, so diagnosis runs once per round (not twice) and
  // escalation state stays consistent between the loop's abort decision and
  // the prompt injection. The `mt.spin.enabled` master switch already
  // causes the loop to skip `evaluateSpin`, so `tls.spinCircuitBreaker`
  // will be null in that case — this belt-and-suspenders guard stays cheap.
  // -------------------------------------------------------------------------
  if (mt.spin.enabled && tls?.spinCircuitBreaker && tls.spinCircuitBreaker.message) {
    parts.push(tls.spinCircuitBreaker.message);
  }

  // -------------------------------------------------------------------------
  // ASSESS — pinned-WM hygiene nudge. Emitted right after spin (corrective
  // first, hygiene second). Both can fire in the same round.
  // -------------------------------------------------------------------------
  if (mt.assess && tls?.assessContext?.message) {
    parts.push(tls.assessContext.message);
  }

  // -------------------------------------------------------------------------
  // BULK CONTEXT — workspace state, project tree, dormant engrams
  // -------------------------------------------------------------------------

  if (projectTree && isFirstTurn) {
    parts.push(`## PROJECT STRUCTURE\n${projectTree}`);
  }

  const contextToon = workspaceContext ? buildContextTOON(workspaceContext, !isFirstTurn) : '';
  if (contextToon) {
    parts.push(`Ctx:${contextToon}`);
  }

  if (workspaceContext?.selectedText) {
    const text = workspaceContext.selectedText.length > 500
      ? workspaceContext.selectedText.substring(0, 500) + '...'
      : workspaceContext.selectedText;
    parts.push(`Sel:\n\`\`\`\n${text}\n\`\`\``);
  }

  return parts.length > 0 ? parts.join('\n') : '';
}

// ============================================================================
// Mode-Specific Prompts
// ============================================================================

export type ChatMode = 'ask' | 'designer' | 'agent' | 'reviewer' | 'retriever' | 'custom' | 'swarm' | 'refactor' | 'planner';

export function areToolsEnabledForProvider(_provider: AIProvider, mode: ChatMode): boolean {
  // Ask = simple Q&A without batch/task tools (matches UI); other modes are fully agentic.
  return mode !== 'ask';
}


// ============================================================================
// Static System Prompt (Layer 1 - Cacheable)
// ============================================================================

// P0 #1: System prompt section caching — avoid rebuilding static prompt every streamChat call.
// The prompt only changes when mode, shell, atlsReady, or provider changes.
let _cachedStaticPrompt: {
  key: string;
  prompt: string;
  metrics: Partial<import('../stores/appStore').PromptMetrics>;
} | null = null;

/** Reset static system prompt cache (call on settings/mode change or newChat) */
export function resetStaticPromptCache(): void {
  _cachedStaticPrompt = null;
  _prevStaticKey = null;
  _prevBp3Snapshot = null;
  invalidateHistoryCache();
  useAppStore.getState().resetLogicalCache();
}

let _prevStaticKey: string | null = null;
let _prevBp3Snapshot: Bp3Snapshot | null = null;

// ---------------------------------------------------------------------------
// End-of-turn history cache — preserves compressed prefix across user turns
// so Anthropic's prefix cache sees byte-identical content (cache READ instead
// of cache WRITE on the first round of a new turn).
//
// Stateful-machine invariant: when `_endOfTurnHistory` is reused on a new
// turn, `_endOfTurnBoundary` pins the frozen prefix length. Every compression
// pass in the next turn (emergency, hygiene, end-of-turn) scopes its mutation
// range to `history[boundary..]`, so prior-turn content is never re-evicted,
// re-stubbed, or re-deflated.
// ---------------------------------------------------------------------------
let _endOfTurnHistory: Array<{ role: string; content: unknown }> | null = null;
let _endOfTurnUiMessageCount = 0;
let _endOfTurnBoundary = 0;

function invalidateHistoryCache(): void {
  _endOfTurnHistory = null;
  _endOfTurnUiMessageCount = 0;
  _endOfTurnBoundary = 0;
}

// Cached project tree for static prompt injection — stable across rounds for prompt caching
let _cachedProjectTree: { root: string; text: string } | null = null;

async function _getProjectTree(projectRoot: string, atlsReady?: boolean): Promise<string> {
  if (!atlsReady) return '';
  if (_cachedProjectTree && _cachedProjectTree.root === projectRoot) {
    return _cachedProjectTree.text;
  }
  try {
    const result = await invokeWithTimeout<{ results: Array<{ tree?: string; files?: number; dirs?: number }> }>(
      'atls_batch_query',
      { operation: 'context', params: { type: 'tree', file_paths: ['.'], depth: 2 } },
      5000,
    );
    const treeData = result?.results?.[0];
    if (treeData?.tree) {
      const MAX_TREE_CHARS = 2000;
      const tree = treeData.tree.length > MAX_TREE_CHARS
        ? treeData.tree.slice(0, MAX_TREE_CHARS) + '\n... (tree truncated, use search.code to explore)'
        : treeData.tree;
      _cachedProjectTree = { root: projectRoot, text: tree };
      return tree;
    }
  } catch {
    // Tree is nice-to-have; don't block prompt building
  }
  return '';
}

/** Reset tree cache (call when project changes) */
export function resetProjectTreeCache() {
  _cachedProjectTree = null;
}

/**
 * Build static system prompt for Layer 1 caching
 * 
 * This includes components that don't change within a session:
 * - Mode-specific base prompt
 * - Shell guidance (OS/shell specific)
 * - Tool reference
 *
 * Dynamic content (tree, task state, selection) is in the last user message
 * so this prompt stays byte-stable for provider prefix caching (BP1).
 */
function _buildStaticSystemPrompt(
  mode: ChatMode,
  shellContext?: { os?: string; shell?: string; cwd?: string },
  atlsReady?: boolean,
  provider?: string,
  entryManifest?: EntryManifestEntry[],
  entryManifestDepth?: EntryManifestDepth,
): string {
  // Inject refactor config early for cache key (refactor mode only)
  const refactorPart = mode === 'refactor' ? useRefactorStore.getState().getConfigForPrompt() : '';
  // P0 #1: Check cache — key includes refactor config for invalidation when thresholds change
  const manifestFingerprint = hashContentSync(JSON.stringify(entryManifest ?? [])).slice(0, 8);
  const subagentFlag = !!(useAppStore.getState().settings.subagentModel && useAppStore.getState().settings.subagentProvider);
  const cacheKey = `${mode}|${shellContext?.os ?? ''}|${shellContext?.shell ?? ''}|${shellContext?.cwd ?? ''}|${atlsReady ?? false}|${provider ?? ''}|${refactorPart}|${entryManifestDepth ?? 'off'}|${manifestFingerprint}|${subagentFlag}`;
  if (_cachedStaticPrompt && _cachedStaticPrompt.key === cacheKey) {
    useAppStore.getState().setPromptMetrics(_cachedStaticPrompt.metrics);
    return _cachedStaticPrompt.prompt;
  }

  // Get mode-specific base prompt
  const modePrompt = getModePrompt(mode);
  
  // Retriever mode: prompt only, no tools/shell/patterns
  if (mode === 'retriever') {
    useAppStore.getState().setPromptMetrics({
      modePromptTokens: countTokensSync(modePrompt),
      toolRefTokens: 0, shellGuideTokens: 0,
      nativeToolTokens: 0,
    });
    return modePrompt;
  }
  
  // Project root — stable within a session (tree is dynamic, injected in messages)
  const projectLine = shellContext?.cwd ? `\nPROJECT: ${shellContext.cwd}` : '';

  // Build shell-specific guidance (for agent modes with terminal access)
  const shellGuide = (mode === 'agent' && shellContext?.os && shellContext?.shell)
    ? getShellGuide(shellContext.shell)
    : '';

  // Only include batch tool docs if initialized
  const settings = useAppStore.getState().settings;
  const subagentEnabled = atlsReady && settings.subagentModel !== 'none'
    && (settings.subagentModel || settings.subagentProvider);

  let toolRef = atlsReady 
    ? (mode === 'designer' ? DESIGNER_TOOL_REF : BATCH_TOOL_REF)
    : `## Terminal Only (ATLS not initialized - open a project first)
q: exec system.exec cmd:"..." → write cmd to temp .ps1 and run in agent shell`;

  // Append subagent tool ref when subagent enabled
  if (subagentEnabled) {
    toolRef += SUBAGENT_TOOL_REF;
  }

  // Mode-specific rules
  const modeRules = mode === 'designer'
    ? 'Read-only: Output plans via annotate.design. Do not edit files.'
    : mode === 'reviewer'
    ? 'Review mode: Find and report issues. Suggest fixes but do not apply them.'
    : mode === 'refactor'
    ? 'Refactoring mode: Systematic code extraction and restructuring. Follow the 4-phase workflow.'
    : 'Full agent mode. Pinned context = working memory. Runtime manages lifecycle and freshness.';

  // Inject refactor config thresholds when in refactor mode (reuse refactorPart from cache key)
  const refactorConfig = mode === 'refactor' ? `\n${refactorPart}\n` : '';

  // Shared edit/verify discipline (non-designer, ATLS ready)
  const editDisciplineSection = (atlsReady && mode !== 'designer')
    ? `\n${EDIT_DISCIPLINE}`
    : '';

  // Output style — density/structure rules for explanatory text. Same gate as edit discipline.
  const outputStyleSection = (atlsReady && mode !== 'designer')
    ? `\n${OUTPUT_STYLE}`
    : '';

  // Designer: read-only context hints. All other non-retriever tool modes share COGNITIVE_CORE + EDIT_DISCIPLINE + OUTPUT_STYLE.
  const contextControl = mode === 'designer'
    ? `\n${CONTEXT_CONTROL_DESIGNER}\n## Output: 1 sentence between tool calls. End with a concise final summary.`
    : `\n${CONTEXT_CONTROL}`;
  const hppSection = (atlsReady && mode !== 'designer') ? `\n${HASH_PROTOCOL_CORE}` : '';
  const providerReinforcement = (provider === 'google' || provider === 'vertex')
    ? `\n${GEMINI_REINFORCEMENT}`
    : '';

  // Entry manifest (frozen at session start, cached in BP1)
  const entryManifestSection = formatEntryManifestSection(entryManifest, entryManifestDepth);

  const metricsSnapshot = {
    modePromptTokens: countTokensSync(modePrompt + refactorConfig),
    toolRefTokens: countTokensSync(toolRef),
    shellGuideTokens: countTokensSync(shellGuide),
    nativeToolTokens: NATIVE_TOOL_TOKENS_ESTIMATE,
    contextControlTokens: countTokensSync(editDisciplineSection + outputStyleSection + contextControl + hppSection + providerReinforcement),
    entryManifestTokens: countTokensSync(entryManifestSection),
  };
  useAppStore.getState().setPromptMetrics(metricsSnapshot);

  const result = `${modePrompt}${projectLine}${shellGuide}

${toolRef}${entryManifestSection}

${modeRules}${refactorConfig}${editDisciplineSection}${outputStyleSection}${contextControl}${hppSection}${providerReinforcement}`;

  _cachedStaticPrompt = { key: cacheKey, prompt: result, metrics: metricsSnapshot };
  return result;
}


// ---------------------------------------------------------------------------
// BP3: Append-only conversation history cache marker
// ---------------------------------------------------------------------------
// History compression is deferred to round 0 (between user turns), so within
// a tool loop the message prefix is byte-identical across rounds. The marker
// on the last prior turn tells the Rust backend to add cache_control, giving
// cache reads (0.1x) on the growing conversation prefix. Mutable content (BB,
// dormant, staged) lives in the dynamic block — never inside the cached prefix.
// ---------------------------------------------------------------------------

const PRIOR_TURN_BOUNDARY = '<<PRIOR_TURN_BOUNDARY>>';

/**
 * Append the prior-turn boundary marker to a message's last text content block.
 * The Rust backend strips this marker and adds cache_control for Anthropic (BP3).
 */
function _appendBoundaryMarker(msg: {role: string; content: unknown}): void {
  if (Array.isArray(msg.content)) {
    const blocks = msg.content as Array<{type: string; text?: string; content?: string}>;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block.type === 'text' && typeof block.text === 'string') {
        block.text += PRIOR_TURN_BOUNDARY;
        return;
      }
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        block.content += PRIOR_TURN_BOUNDARY;
        return;
      }
    }
  } else if (typeof msg.content === 'string') {
    msg.content = msg.content + PRIOR_TURN_BOUNDARY;
  }
}

/**
 * Build the blackboard block for the dynamic (uncached) user message.
 * Moved out of BP3 — BB entries mutate nearly every round.
 *
 * Template bodies (`tpl:*`) are omitted: the static system prompt in
 * `cognitiveCore.ts` already names all eight templates and documents
 * `h:bb:tpl:NAME` resolution. Re-emitting ~0.3k of template markup each
 * round is redundant — the runtime telling the model twice.
 */
function _buildBlackboardBlock(): string {
  const ctxState = useContextStore.getState();
  if (ctxState.blackboardEntries.size === 0) return '';
  const bbLines: string[] = ['## BLACKBOARD'];
  ctxState.blackboardEntries.forEach((entry, key) => {
    if (key.startsWith('edit:')) return;
    if (key.startsWith('tpl:')) return;
    if (!canSteerExecution({ state: entry.state })) return;
    bbLines.push(`${key}: ${entry.content}`);
  });
  if (bbLines.length <= 1) return '';
  return bbLines.join('\n');
}

/**
 * Main entry point for streaming chat.
 * 
 * Cache architecture (Anthropic prefix caching):
 *   BP-static: system prompt + tool definitions (single breakpoint, 5m TTL)
 *   BP3: append-only conversation history (grows each round, cache reads)
 *   Dynamic: BB + dormant + staged + WM + ctx + query (uncached, 1.0x)
 * 
 * Mutable content lives in the dynamic block to avoid prefix invalidation.
 * History compression is deferred to round 0 (between user turns).
 */
export async function streamChat(
  config: AIConfig,
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  workspaceContext?: WorkspaceContext,
  mode: ChatMode = 'agent'
): Promise<void> {
  let systemPrompt = config.systemPrompt;
  let dynamicContextBlock = '';
  let projectTree = '';
  const isFirstTurn = messages.filter(m => m.role === 'user').length <= 1;
  const latestUserText = getLatestUserText(messages);
  if (isFirstTurn) {
    useAppStore.getState().clearAgentPendingAction();
  } else if (latestUserText) {
    useAppStore.getState().setAgentPendingAction(
      createPendingActionState('state_changed', 'user', `New user instruction: ${excerptText(latestUserText)}`),
    );
    // Freshness gate: detect terminal output contradicting cached verify
    const contradiction = detectContradictingTerminalOutput(latestUserText);
    if (contradiction) {
      const scopeFiles = contradiction.files.length > 0 ? contradiction.files : undefined;
      const downgraded = useContextStore.getState().downgradeVerifyToStale(scopeFiles);
      if (downgraded > 0) {
        console.log(
          `[aiService] User evidence contradicts ${downgraded} verify artifact(s) — marked stale` +
          (scopeFiles ? ` (scoped to ${scopeFiles.length} file(s): ${scopeFiles.slice(0, 3).join(', ')}${scopeFiles.length > 3 ? '…' : ''})` : ' (unscoped — no file paths extracted)'),
        );
      }
    }
  }
  if (!systemPrompt) {
    const shellContext = workspaceContext
      ? { os: workspaceContext.os, shell: workspaceContext.shell, cwd: workspaceContext.cwd }
      : undefined;
    
    // Project tree for dynamic injection (changes when files are created/deleted)
    projectTree = shellContext?.cwd
      ? await _getProjectTree(shellContext.cwd, workspaceContext?.atlsReady)
      : '';

    // System prompt is fully static — no dynamic content, enables BP1 caching
    const emDepth = useAppStore.getState().settings.entryManifestDepth ?? 'paths';
    systemPrompt = _buildStaticSystemPrompt(
      mode,
      shellContext,
      workspaceContext?.atlsReady,
      config.provider,
      workspaceContext?.profile?.entryManifest,
      emDepth,
    );
    
    // Dynamic context goes into the last user message (not system prompt)
    dynamicContextBlock = buildDynamicContextBlock(workspaceContext, projectTree, isFirstTurn);

    // Entry manifest is now in BP1 static system prompt (no staging needed)

    const wsCtxTokens = countTokensSync(dynamicContextBlock);
    if (wsCtxTokens > 0) {
      useAppStore.getState().setPromptMetrics({ workspaceContextTokens: wsCtxTokens });
    }
  }
  
  const configWithContext = { ...config, systemPrompt };
  return streamChatViaTauri(configWithContext, messages, callbacks, mode, {
    workspaceContext,
    projectTree,
    isFirstTurn,
  });
}

/**
 * Get provider from model ID
 */
export function getProviderFromModel(modelId: string): AIProvider {
  return getProviderFromModelId(modelId);
}
