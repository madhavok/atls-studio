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

export { streamChatForSwarm, type SwarmStreamCallbacks, type SwarmStreamOptions } from './swarmChat';
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
import { useAppStore } from '../stores/appStore';
import { useContextStore, setCacheHitRateAccessor, setWorkspacesAccessor, setPromptMetricsAccessor, setRoundRefreshRevisionResolver, setRetentionMetricsAccessor, setRetentionResetAccessor } from '../stores/contextStore';
import { useRetentionStore } from '../stores/retentionStore';

// Cross-store accessor wiring — breaks circular deps at runtime.
// Called at module load AND re-applied in ensureAiServiceWiring() as a guardrail.
function initCrossStoreAccessors(): void {
  setCacheHitRateAccessor(() => useAppStore.getState().cacheMetrics.sessionHitRate);
  setWorkspacesAccessor(() => (useAppStore.getState().projectProfile?.workspaces as Array<{ name: string; path: string }>) ?? []);
  setPromptMetricsAccessor(() => useAppStore.getState().promptMetrics);
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
import { useCostStore, calculateCost, type AIProvider as CostProvider } from '../stores/costStore';
import { useRefactorStore } from '../stores/refactorStore';
import { formatChunkRef, hashContentSync, isCompressedRef, sliceContentByLines, extractSearchSummary, extractSymbolSummary, extractDepsSummary, SHORT_HASH_LEN, type DigestSymbol } from '../utils/contextHash';
import { resolveHashRefsWithMeta, setRecencyResolver, setEditRecencyResolver, setReadRecencyResolver, setStageRecencyResolver, type HashLookup, type SetRefLookup } from '../utils/hashResolver';
import { toTOON, formatResult, expandBatchQ } from '../utils/toon';
import { countTokensSync, countTokens as countTokensAsync } from '../utils/tokenCounter';
import { BATCH_TOOL_REF, DESIGNER_TOOL_REF, SUBAGENT_TOOL_REF, NATIVE_TOOL_TOKENS_ESTIMATE } from '../prompts/toolRef';
import { CONTEXT_CONTROL_V4, CONTEXT_CONTROL_DESIGNER } from '../prompts/cognitiveCore';
import { EDIT_DISCIPLINE } from '../prompts/editDiscipline';
import { HASH_PROTOCOL_CORE } from '../prompts/hashProtocol';
import { getModePrompt } from '../prompts/modePrompts';
import { getShellGuide } from '../prompts/shellGuide';
import { GEMINI_REINFORCEMENT, GEMINI_RECENCY_BOOST } from '../prompts/providerOverrides';
import { advanceTurn, resetProtocol, dematerialize, getAllRefs, getRef, shouldMaterialize, getTurn, setRoundRefreshHook } from './hashProtocol';
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
import {
  BLACKBOARD_BUDGET_TOKENS,
  STAGED_BUDGET_TOKENS,
  CONVERSATION_HISTORY_BUDGET_TOKENS,
  ROLLING_SUMMARY_MAX_TOKENS,
  WORKSPACE_CONTEXT_BUDGET_TOKENS,
  WM_BUDGET_TOKENS,
  PHASE_ROUND_BUDGET,
  TOTAL_RESEARCH_ROUND_BUDGET,
  RESEARCH_FORCE_STOP_MARGIN,
  createPromptLayerBudgets,
  getStagedTokens,
  getEstimatedTotalPromptTokens,
  getStaticSystemTokens,
  type PromptAssemblyState,
  type PromptPressureBuckets,
  type PromptReliefAction,
} from './promptMemory';
import { compressToolLoopHistory, deflateToolResults, estimateHistoryTokens, estimateHistoryTokensAsync } from './historyCompressor';
import { formatSummaryMessage, isRollingSummaryEmpty, trimSummaryToTokenBudget } from './historyDistiller';
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
import { canSteerExecution } from './universalFreshness';

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

const VERIFY_STALE_RE = /\bverify\b.*\bstale\b|\bstale\b.*\bre-verify\b/i;

function buildCompletionGateNudge(blocker: string | null): string {
  if (blocker && VERIFY_STALE_RE.test(blocker)) {
    return (
      'Verification artifacts are stale. You MUST re-run verification before finishing. ' +
      'Call batch with a verify.build step (and verify.test if applicable) on the affected files, then provide your summary.'
    );
  }
  return 'You paused before finishing. Continue any remaining implementation first. When the work is actually complete, run final verification and then provide a brief summary.';
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
 * Convert a stored Message (with segments/parts) to API content format for Gemini/OpenAI/Anthropic.
 * Assistant messages with tool calls are expanded to model content + optional tool_result user message.
 * Input: Message or ChatMessage (role, content, optional parts/segments).
 */
function messageToApiContent(msg: { role: string; content: unknown; parts?: Array<{ type: string; content?: string; toolCall?: { id: string; name: string; args?: Record<string, unknown>; result?: string; thoughtSignature?: string } }>; segments?: Array<{ type: string; content?: string; toolCall?: { id: string; name: string; args?: Record<string, unknown>; result?: string; thoughtSignature?: string } }> }): {
  modelContent: string | Array<{ type: string; id?: string; text?: string; name?: string; input?: Record<string, unknown>; thoughtSignature?: string }>;
  toolResults?: Array<{ type: 'tool_result'; tool_use_id: string; content: string; name?: string }>;
} {
  const strOrArr = msg.content as string | Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  if (msg.role !== 'assistant') {
    return { modelContent: strOrArr };
  }
  const parts = (msg.parts ?? msg.segments) as MessagePart[] | undefined;
  if (!parts || parts.length === 0) {
    return { modelContent: strOrArr };
  }
  const modelBlocks: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown>; thoughtSignature?: string }> = [];
  const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; name?: string }> = [];
  for (const p of parts) {
    if (p.type === 'text' && p.content) {
      modelBlocks.push({ type: 'text', text: p.content });
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

function hasToolResultBlocks(content: unknown): boolean {
  return Array.isArray(content)
    && content.some(
      (block) => typeof block === 'object'
        && block !== null
        && 'type' in block
        && (block as { type?: string }).type === 'tool_result',
    );
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

function injectCurrentRoundUserContent(
  content: unknown,
  fullPrefix: string,
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
    if (userContentBlocks.length === 0 && fullPrefix) {
      userContentBlocks.push({ type: 'text', text: fullPrefix + recencySuffix });
    } else {
      if (fullPrefix) userContentBlocks.push({ type: 'text', text: `\n\n${fullPrefix}` });
      if (recencySuffix) {
        const lastTextIdx = userContentBlocks.map((block, index) => (block.type === 'text' ? index : -1)).filter(index => index >= 0).pop();
        if (lastTextIdx != null && lastTextIdx >= 0) {
          const target = userContentBlocks[lastTextIdx] as { text?: string };
          target.text = (target.text || '') + recencySuffix;
        } else {
          userContentBlocks.push({ type: 'text', text: recencySuffix });
        }
      }
    }
    return userContentBlocks;
  }

  if (typeof content === 'string') {
    return `${fullPrefix ? `${content}\n\n${fullPrefix}` : content}${recencySuffix}`;
  }

  if (content == null) {
    return `${fullPrefix}${recencySuffix}`;
  }

  return content;
}

function assembleProviderMessages(
  durableHistory: ApiMessage[],
  provider: AIProvider,
  mode: ChatMode,
  dynamicContextBlock: string,
): { messages: ApiMessage[]; geminiDynamicContext: string; assembly: PromptAssemblyState } {
  // Assembled provider messages are ephemeral output; durable state lives in
  // structured turn history, staged lifecycle state, working-memory state,
  // and round telemetry.
  const layeredMessages: ApiMessage[] = [];
  const isGemini = provider === 'google' || provider === 'vertex';
  let geminiDynamicContext = '';
  const lastUserIndex = durableHistory.reduceRight((acc, msg, index) => acc === -1 && msg.role === 'user' ? index : acc, -1);

  for (let i = 0; i < durableHistory.length; i++) {
    const msg = durableHistory[i];
    if (i === lastUserIndex) {
      // BP3: append-only conversation history cache. The marker goes on the
      // last prior turn — no BB/dormant suffix, just the boundary. History
      // compression is deferred to round 0, so within a tool loop the prefix
      // is byte-identical and Anthropic serves cache reads (0.1x).
      if (i > 0 && !isGemini) {
        const prevMsg = layeredMessages[layeredMessages.length - 1];
        if (prevMsg) _appendBoundaryMarker(prevMsg);
      }

      useContextStore.getState().markStagedSnippetsUsed();
      const stagedBlock = useContextStore.getState().getStagedBlock();
      if (mode !== 'ask' && stagedBlock) {
        dynamicContextBlock = dynamicContextBlock
          ? `${stagedBlock}\n\n${dynamicContextBlock}`
          : stagedBlock;
      }

      const workingMemory = buildWorkingMemoryBlock();
      const dynamicCtx = dynamicContextBlock ? `${dynamicContextBlock}\n\n` : '';
      const wmPrefix = workingMemory ? `${workingMemory}\n\n` : '';
      const recencySuffix = isGemini ? `\n${GEMINI_RECENCY_BOOST}` : '';
      const fullPrefix = isGemini ? '' : `${dynamicCtx}${wmPrefix}`;
      if (isGemini) {
        geminiDynamicContext = `${dynamicCtx}${wmPrefix}`.trimEnd();
      }

      layeredMessages.push({
        role: 'user',
        content: injectCurrentRoundUserContent(msg.content, fullPrefix, recencySuffix),
      });
      continue;
    }

    layeredMessages.push({ role: msg.role, content: msg.content });
  }

  return {
    messages: layeredMessages,
    geminiDynamicContext,
    assembly: {
      staticPrefix: '',
      historyWindow: durableHistory.slice(0, Math.max(0, lastUserIndex)),
      stagedAnchors: useContextStore.getState().getStagedBlock(),
      workingMemoryBlock: buildWorkingMemoryBlock(),
      workspaceContextBlock: dynamicContextBlock,
      currentRoundMessages: layeredMessages,
      cacheStrategy: isGemini ? 'rolling_cache' : 'prefix_stable',
    },
  };
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
    console.log('[aiService] Chat stopped by user');
    console.log('[aiService] Chat stopped by user');
  }
}

/**
 * Check if chat is currently running
 */
export function isChatRunning(): boolean {
  return currentAbortController !== null;
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
  // Message Architecture (2 cache breakpoints)
  // =========================================================================
  // BP-static: system prompt + tool definitions (5m TTL, single breakpoint)
  // BP3: append-only conversation history (ephemeral, grows each round)
  //  → Dynamic user message: BB + dormant + staged + WM + ctx + query (uncached)
  // =========================================================================

  const conversationHistory = normalizeConversationHistory(messages);
  const rs = useContextStore.getState().rollingSummary;
  if (!isRollingSummaryEmpty(rs)) {
    const trimmed = trimSummaryToTokenBudget(rs, ROLLING_SUMMARY_MAX_TOKENS);
    if (!isRollingSummaryEmpty(trimmed)) {
      conversationHistory.unshift(formatSummaryMessage(trimmed));
    }
  }
  const priorTurnBoundary = 0;

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
  let forceStopInjected = false;
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
  
  try {
    for (let round = 0; round < maxRounds; round++) {
      _roundHadMutations = false;

      // HPP: advance turn counter so previously-materialized chunks become referenced
      if (round > 0) {
        await advanceTurn();
        // Auto-compact dormant engrams so store tokens match prompt tokens
        useContextStore.getState().compactDormantChunks();
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
      });
      const reliefAction = roundContext.reliefAction;

      const dynamicContextBlock = buildDynamicContextBlock(
        dynamicContextInput?.workspaceContext,
        dynamicContextInput?.projectTree,
        round === 0 ? dynamicContextInput?.isFirstTurn : false,
      );
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
      let { geminiDynamicContext } = assembledRound;
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

      // Track usage - use latest values (Anthropic sends final totals at end)
      let roundInputTokens = 0;
      let roundOutputTokens = 0;
      let roundCacheReadTokens = 0;
      let roundCacheWriteTokens = 0;
      let stopReason: string | null = null;
      let toolCallCounter = 0;

      const tauriMessages = assembledRound.messages.map(m => ({ role: m.role, content: m.content }));
      const cacheMessages = assembledRound.messages.map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content as string | ContentBlock[],
      }));

      const invokeFn = async () => {
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
          });
        } else if (config.provider === 'vertex') {
          const { cacheName: vertexCache, cachedMessageCount: vertexCachedCount } = await manageGeminiRollingCache('vertex', config.apiKey, config.model, config.systemPrompt || '', cacheMessages, config.projectId, config.region);
          const vertexUncachedStart = vertexCache ? Math.min(vertexCachedCount, tauriMessages.length) : 0;
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
          });
        } else {
          const { cacheName: googleCache, cachedMessageCount: googleCachedCount } = await manageGeminiRollingCache('google', config.apiKey, config.model, config.systemPrompt || '', cacheMessages);
          const googleUncachedStart = googleCache ? Math.min(googleCachedCount, tauriMessages.length) : 0;
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

            // Anthropic: inTokens = uncached only; cache tokens are separate line items.
            // OpenAI/Google: inTokens = total prompt tokens including cached subset.
            const cacheWrite = chunk.cache_creation_input_tokens ?? 0;
            const cacheRead = chunk.cache_read_input_tokens ?? 0;
            if (cacheWrite > 0) roundCacheWriteTokens = cacheWrite;
            if (cacheRead > 0) roundCacheReadTokens = cacheRead;
            if (cacheWrite > 0 || cacheRead > 0) {
              useAppStore.getState().addCacheMetrics({ cacheWrite, cacheRead, uncached: inTokens });
            }

            const openaiCached = chunk.openai_cached_tokens ?? 0;
            if (openaiCached > 0) {
              roundCacheReadTokens = openaiCached;
              useAppStore.getState().addCacheMetrics({ cacheWrite: 0, cacheRead: openaiCached, uncached: inTokens - openaiCached, lastRequestCachedTokens: openaiCached });
            }

            const geminiCached = chunk.cached_content_tokens ?? 0;
            if (geminiCached > 0) {
              roundCacheReadTokens = geminiCached;
              useAppStore.getState().addCacheMetrics({ cacheWrite: 0, cacheRead: geminiCached, uncached: inTokens - geminiCached, lastRequestCachedTokens: geminiCached });
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
            break;
          case 'status':
            safeCallbacks.onStatus?.(chunk.message);
            break;
          case 'error':
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

      // Capture per-round snapshot for Internals charts
      {
        const ctxState = useContextStore.getState();
        const appState = useAppStore.getState();
        const bm = ctxState.batchMetrics;
        const wmTokens = ctxState.getPromptTokens();
        const wmStoreTokens = ctxState.getStoreTokens();
        const bbTokens = ctxState.getBlackboardTokenCount();
        const stagedTokens = ctxState.getStagedTokenCount();
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
        // Model's actual context window (includes extended 1M when enabled)
        const modelCtx = appState.availableModels.find(m => m.id === config.model);
        const extendedResolution = getExtendedContextResolutionFromSettings(appState.settings);
        const maxTk = modelCtx
          ? (getEffectiveContextWindow(modelCtx.id, modelCtx.provider, modelCtx.contextWindow, extendedResolution)
            ?? appState.contextUsage.maxTokens
            ?? (config.provider === 'google' || config.provider === 'vertex' ? 1000000 : 200000))
          : (appState.contextUsage.maxTokens || (config.provider === 'google' || config.provider === 'vertex' ? 1000000 : 200000));
        // BB is in the dynamic block (uncached). History is the only BP3 content.
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
        // Hypothetical non-batched: each manage op re-sends full input context
        const inputShare = (roundInputTokens + roundOutputTokens) > 0
          ? roundInputTokens / (roundInputTokens + roundOutputTokens)
          : 0;
        const hypothetical = bm.manageOps > 1
          ? bm.manageOps * (roundCostCents * inputShare) + (roundCostCents * (1 - inputShare))
          : roundCostCents;
        const verifyArtifacts = Array.from(useContextStore.getState().verifyArtifacts.values());
        const latestVerifyArtifact = verifyArtifacts.length > 0 ? verifyArtifacts[verifyArtifacts.length - 1] : undefined;
        const rsSnap = useContextStore.getState().rollingSummary;
        const trimmedRs = trimSummaryToTokenBudget(rsSnap, ROLLING_SUMMARY_MAX_TOKENS);
        const rollingSummaryTokens = isRollingSummaryEmpty(trimmedRs)
          ? 0
          : countTokensSync(formatSummaryMessage(trimmedRs).content);
        useRoundHistoryStore.getState().pushSnapshot({
          round: round + 1,
          timestamp: Date.now(),
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
          compressionSavings: appState.promptMetrics.compressionSavings,
          rollingSavings: appState.promptMetrics.rollingSavings ?? 0,
          rolledRounds: appState.promptMetrics.rolledRounds ?? 0,
          rollingSummaryTokens,
          freedTokens: ctxState.freedTokens,
          cumulativeSaved: appState.promptMetrics.cumulativeInputSaved,
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
          isResearchRound: !_roundHadMutations,
          totalResearchRounds,
          newCoverage: ctxState.roundNewCoverage,
          coveragePlateau: ctxState.coveragePlateauStreak >= 2,
          substantiveBbWrites: bm.hadSubstantiveBbWrite ? 1 : 0,
        });
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

            if (trimmedText.startsWith('[{')) {
              contentBlocks = JSON.parse(trimmedText);
            } else {
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

              assistantTextContent = textParts.join('\n');

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
      
      // No tool calls - AI decided to stop
      if (!needsToolResults || pendingToolCalls.size === 0) {
        console.log(`[aiService] End turn without tools - stopReason: ${stopReason}, textLength: ${assistantTextContent.length}`);
        const agentProgressState = useAppStore.getState().agentProgress;
        const currentPendingAction = agentProgressState.pendingAction;
        const completionOnlyBlocked = currentPendingAction.kind === 'none'
          && runtimeCompletionBlocker != null
          && !agentProgressState.canTaskComplete;
        const hasBlockingPendingAction = currentPendingAction.kind !== 'none'
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
              if (assistantTextContent) {
                conversationHistory.push({ role: 'assistant', content: assistantTextContent });
              }
              conversationHistory.push({
                role: 'user',
                content: buildCompletionGateNudge(runtimeCompletionBlocker),
              });
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

            if (assistantTextContent) {
              conversationHistory.push({ role: 'assistant', content: assistantTextContent });
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
              if (assistantTextContent) {
                conversationHistory.push({ role: 'assistant', content: assistantTextContent });
              }
              conversationHistory.push({
                role: 'user',
                content: buildCompletionGateNudge(runtimeCompletionBlocker),
              });
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
      if (assistantTextContent) {
        assistantContent.push({ type: 'text', text: assistantTextContent });
      }
      
      // Build tool calls array for parallel execution
      const toolCallEntries = Array.from(pendingToolCalls.entries()).map(([, tc]) => ({
        id: tc.id,
        name: tc.name,
        args: tc.inputJson ? JSON.parse(tc.inputJson) : {},
        thoughtSignature: tc.thoughtSignature,
      }));
      
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

      const toolTasks = toolCallEntries.map((tc) => async () => {
        // Skip execution if already aborted
        if (abortSignal.aborted) {
          return { type: 'tool_result', tool_use_id: tc.id, name: tc.name, content: '[cancelled]' };
        }
        // Guard: reject empty tool names before execution
        if (!tc.name?.trim()) {
          const errMsg = 'Invalid or empty tool name. Use batch({version:"1.0",steps:[...]}) with a valid step list.';
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
          detail = (firstParams.file_paths as string[])?.[0]
            || String(firstParams.file_path || '')
            || String(firstParams.cmd || '')
            || (firstParams.queries as string[])?.[0]
            || String(firstParams.action || '')
            || (firstParams.symbol_names as string[])?.[0]
            || String(firstParams.query || '')
            || displayName;
        } else {
          detail = (params.file_paths as string[] | undefined)?.[0] || tc.name;
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
          const steps = coerceBatchSteps((tc.args as Record<string, unknown>).steps);
          batchStepSummaries = steps.map((step, index) => {
            const withParams = (step.with as Record<string, unknown> | undefined) || {};
            const stepName = String(step.use || `step_${index + 1}`);
            const stepDetail = (withParams.file_paths as string[] | undefined)?.[0]
              || String(withParams.file_path || '')
              || String(withParams.cmd || '')
              || (withParams.queries as string[] | undefined)?.[0]
              || String(withParams.action || '')
              || (withParams.symbol_names as string[] | undefined)?.[0]
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
          });
          result = execution.displayText;

          // Final agentProgress update for batch (mark all remaining as completed/failed)
          if (tc.name === 'batch' && batchStepSummaries) {
            const stepResults = (execution.displayText.match(/^[^\n]+/gm) || []).map(line => line.trim());
            const completedBatchSteps = batchStepSummaries.map((summary, index) => ({
              ...summary,
              status: stepResults[index]?.includes('ERROR') || stepResults[index]?.includes('BLOCKED') ? 'failed' as const : 'completed' as const,
            }));
            const current = useAppStore.getState().agentProgress.recentTools.filter(t => t.parentId !== tc.id);
            useAppStore.getState().setAgentProgress({ recentTools: [...current, ...completedBatchSteps] });
          }

          if (execution.meta?.pendingAction) {
            roundPendingAction = mergePendingAction(roundPendingAction, execution.meta.pendingAction);
          }
          if (execution.meta && 'completionBlocker' in execution.meta) {
            const prev = runtimeCompletionBlocker;
            runtimeCompletionBlocker = execution.meta.completionBlocker ?? null;
            useAppStore.getState().setAgentProgress({ canTaskComplete: runtimeCompletionBlocker == null });
            if (runtimeCompletionBlocker !== prev) {
              console.log(`[aiService][telemetry] completionBlocker changed: ${prev ?? '(none)'} → ${runtimeCompletionBlocker ?? '(none)'} (round=${round}, tool=${tc.name})`);
            }
          }
          if (tc.name === 'task_complete') {
            runtimeCompletionBlocker = null;
            useAppStore.getState().setAgentProgress({ canTaskComplete: true });
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
      
      // Refresh entry manifest + project tree so next round/chat sees current state
      if (_roundHadMutations) {
        _roundHadMutations = false;
        resetProjectTreeCache();
        invoke<ProjectProfile>('atls_get_project_profile')
          .then(profile => useAppStore.setState({ projectProfile: profile }))
          .catch(() => {});
      }

      // Eager deflation: replace tool_result content with hash-pointer refs
      // when the content already lives in the context store as an engram.
      // This makes the engram the single source of truth and avoids sending
      // duplicate content in both history and working memory.
      deflateToolResults(toolResults, conversationHistory);

      // Add messages to conversation for next round
      conversationHistory.push({ role: 'assistant', content: assistantContent });
      conversationHistory.push({ role: 'user', content: toolResults });

      // Hard stop: model had one round after FORCE STOP and still didn't call task_complete
      if (forceStopInjected && !taskCompleteCalled) {
        console.log('[aiService] Research budget hard stop — model did not call task_complete after FORCE STOP');
        useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'research_budget' });
        break;
      }

      // task_complete was called — stop the loop after recording tool results
      // Layer 3B: Verify gate — if mutations happened, require at least one verify.* before completing
      if (taskCompleteCalled) {
        const forceStopActive = totalResearchRounds >= TOTAL_RESEARCH_ROUND_BUDGET + RESEARCH_FORCE_STOP_MARGIN;
        if (anyRoundHadMutations && !_hadVerification && !forceStopActive
            && (mode === 'agent' || mode === 'refactor')) {
          console.log('[aiService] Verify gate: mutations detected but no verify.* ran — injecting warning');
          taskCompleteCalled = false;
          conversationHistory.push({
            role: 'user',
            content: '<<SYSTEM: You made code changes but did not verify them. Run verify.build before calling task_complete.>>',
          });
        } else {
          console.log('[aiService] task_complete called — stopping tool loop');
          useAppStore.getState().clearAgentPendingAction();
          useAppStore.getState().setAgentProgress({ status: 'stopped', stoppedReason: 'completed' });
          useAppStore.getState().setAgentCanContinue(false);
          break;
        }
      }

      // --- Structured behavior enforcement ---

      // Finalize round coverage tracking for convergence detection
      useContextStore.getState().finishRoundCoverage(_roundHadMutations);

      if (_roundHadMutations) {
        anyRoundHadMutations = true;
        hadProgressSinceLastAdvance = true;
      }

      // Track consecutive read-only rounds (no mutations). After 2, inject warning.
      if (!_roundHadMutations) {
        consecutiveReadOnlyRounds++;
        totalResearchRounds++;
      } else {
        consecutiveReadOnlyRounds = 0;
      }
      if (consecutiveReadOnlyRounds >= 2 && mode !== 'ask' && mode !== 'retriever') {
        conversationHistory.push({
          role: 'user',
          content: '<<SYSTEM: 2 consecutive read-only rounds without edits. You must now: ' +
            '(1) make an edit/create, (2) write structured findings to session.bb.write, or (3) declare a specific blocker. ' +
            'Further reads of already-seen files will be blocked.>>',
        });
        consecutiveReadOnlyRounds = 0;
        console.log(`[aiService] Spin guard: injected read-only round warning at round ${round + 1}`);
      }

      // Layer 2A: Coverage-based convergence detection
      const ctxConvergence = useContextStore.getState();
      if (ctxConvergence.coveragePlateauStreak >= 2 && !_roundHadMutations
          && mode !== 'ask' && mode !== 'retriever') {
        conversationHistory.push({
          role: 'user',
          content: '<<SYSTEM: No new files or symbols examined in the last 2 rounds. You are re-examining ' +
            'known content. Write findings on what you have and either act or call task_complete.>>',
        });
        console.log(`[aiService] Coverage plateau detected at round ${round + 1} (streak: ${ctxConvergence.coveragePlateauStreak})`);
      }

      // Layer 2C: session.advance abuse detection
      const taskPlanAdv = useContextStore.getState().taskPlan;
      if (taskPlanAdv?.activeSubtaskId) {
        if (taskPlanAdv.activeSubtaskId !== lastActiveSubtaskId) {
          const prevId = lastActiveSubtaskId;
          if (prevId) {
            const count = (advanceCountBySubtask.get(prevId) ?? 0) + 1;
            advanceCountBySubtask.set(prevId, count);
            if (count > 1 && !hadProgressSinceLastAdvance) {
              conversationHistory.push({
                role: 'user',
                content: `<<SYSTEM: session.advance called ${count}x for "${prevId}" without intervening edits or structured findings. ` +
                  'Advancing phases does not create progress. You must act or complete.>>',
              });
              console.log(`[aiService] Advance abuse: "${prevId}" advanced ${count}x without progress`);
            }
          }
          roundsInCurrentPhase = 0;
          lastActiveSubtaskId = taskPlanAdv.activeSubtaskId;
          hadProgressSinceLastAdvance = false;
        }
        roundsInCurrentPhase++;
        if (roundsInCurrentPhase >= PHASE_ROUND_BUDGET) {
          conversationHistory.push({
            role: 'user',
            content: `<<SYSTEM: You have spent ${roundsInCurrentPhase} rounds in the "${taskPlanAdv.activeSubtaskId}" phase. ` +
              'Commit your findings with session.advance(summary:"...") and move to the next phase. ' +
              'If blocked, declare the blocker in BB and advance anyway.>>',
          });
          console.log(`[aiService] Phase budget exceeded: ${roundsInCurrentPhase} rounds in "${taskPlanAdv.activeSubtaskId}"`);
        }
      }

      // Nudge toward task plan if the model has done a read-only round without planning
      if (round === 1 && !useContextStore.getState().taskPlan && !_roundHadMutations
          && mode !== 'ask' && mode !== 'retriever' && mode !== 'designer') {
        conversationHistory.push({
          role: 'user',
          content: 'You completed a research round without a task plan. For multi-step work, create one now:\n' +
            'batch({version:"1.0",steps:[{id:"plan",use:"session.plan",with:{goal:"...",subtasks:["analyze","implement","verify"]}}]})\n' +
            'session.advance commits findings (dehydrates context) and moves to the next phase.',
        });
        console.log('[aiService] Task plan nudge injected after read-only round 1');
      }

      // Layer 3A: Total research round budget — absolute ceiling
      if (totalResearchRounds >= TOTAL_RESEARCH_ROUND_BUDGET + RESEARCH_FORCE_STOP_MARGIN
          && mode !== 'ask' && mode !== 'retriever') {
        console.log(`[aiService] FORCE STOP: ${totalResearchRounds} research rounds without mutations — forcing task_complete`);
        forceStopInjected = true;
        conversationHistory.push({
          role: 'user',
          content: `<<SYSTEM: FORCE STOP — ${totalResearchRounds} rounds without any code changes. ` +
            'Call task_complete NOW with an honest summary of what you examined and found. ' +
            'This session will not continue.>>',
        });
      } else if (totalResearchRounds >= TOTAL_RESEARCH_ROUND_BUDGET
          && mode !== 'ask' && mode !== 'retriever') {
        conversationHistory.push({
          role: 'user',
          content: `<<SYSTEM: You have spent ${totalResearchRounds} rounds reading without making any changes. ` +
            'This is excessive. You MUST now: (1) make an edit based on what you know, (2) call ' +
            'task_complete with an honest summary of findings, or (3) declare a specific blocker. ' +
            'The next round without a mutation or task_complete will force-stop the session.>>',
        });
        console.log(`[aiService] Research budget warning: ${totalResearchRounds} total research rounds`);
      }

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
        const count = compressToolLoopHistory(conversationHistory, round, priorTurnBoundary, { emergency: true });
        if (count > 0) {
          console.log(`[aiService] SAFETY: auto-compressed ${count} history entries (${triggerSource}: history=${(estimatedHistoryTokens / 1000).toFixed(1)}k, provider=${(roundInputTokens / 1000).toFixed(1)}k, threshold=${(safetyThreshold / 1000).toFixed(1)}k${round > 0 ? ', mid-loop emergency' : ''})`);
        }
      }
    }
  } catch (error) {
    console.error('[aiService] Stream error:', error);
    if (!abortSignal.aborted) {
      safeCallbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  } finally {
    const shouldNotifyDone = _activeSession === session;

    if (shouldNotifyDone) {
      callbacks.onDone();
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

function createHandlerContext(options?: { isSwarmAgent?: boolean; swarmTerminalId?: string }): HandlerContext {
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

function buildBatchSyntheticToolCalls(result: UnifiedBatchResult, batchArgs: Record<string, unknown>): ToolCallEvent[] {
  return result.step_results.map((step, index) => ({
    id: `batch:${typeof batchArgs.id === 'string' ? batchArgs.id : 'batch'}:${step.id}:${index}`,
    name: step.use,
    args: {
      batch_id: typeof batchArgs.id === 'string' ? batchArgs.id : undefined,
      step_id: step.id,
      step_use: step.use,
      refs: step.refs,
    },
    status: step.ok ? 'completed' : 'failed',
    result: step.summary ?? step.error ?? '',
  }));
}

async function executeToolCallDetailed(
  toolName: string,
  args: Record<string, unknown>,
  options?: { swarmTerminalId?: string; fileClaims?: string[]; onBatchStepProgress?: OnBatchStepComplete },
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

        const ctx = createHandlerContext({ swarmTerminalId: options?.swarmTerminalId });
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
        if (result.step_results.some(step => step.ok && step.use.startsWith('verify.'))) {
          _hadVerification = true;
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
        return {
          displayText,
          meta: {
            ...(pendingAction ? { pendingAction } : {}),
            ...(syntheticChildren.length > 0 ? { syntheticChildren } : {}),
            completionBlocker,
          },
        };
      }

      case 'task_complete': {
        // Swarm agents still call task_complete via executeToolCall.
        // In main chat mode this is a no-op passthrough — the model just stops naturally.
        const summary = args.summary as string || 'Task completed';
        const rawFilesChanged = Array.isArray(args.files_changed)
          ? args.files_changed
          : Array.isArray(args.filesChanged)
            ? args.filesChanged
            : [];
        const filesChanged = rawFilesChanged.filter((f): f is string => typeof f === 'string');
        const filesList = filesChanged.length > 0 ? `\nFiles: ${filesChanged.join(', ')}` : '';
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

const TOOL_RESULT_CHAR_LIMIT = 400000;

function truncateToolResult(result: string): string {
  if (result.length <= TOOL_RESULT_CHAR_LIMIT) return result;
  return result.substring(0, TOOL_RESULT_CHAR_LIMIT) + '\n[truncated]';
}

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
 * @param minimal - When true, only includes volatile per-turn state (file, line, branch).
 *   Full profile is sent on first message; subsequent rounds use minimal to save ~200 tokens.
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
  
  // Per-turn editor state (always included)
  if (context.activeFile) {
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
      if (t && !isCompressedRef(t) && !t.startsWith('[Rolling Summary]')) {
        textChunks.unshift(t);
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: string };
        if (b.type === 'text' && b.text) {
          const t = b.text.trim();
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
 */
function buildDynamicContextBlock(
  workspaceContext?: WorkspaceContext,
  projectTree?: string,
  isFirstTurn?: boolean,
): string {
  const parts: string[] = [];

  // -------------------------------------------------------------------------
  // ORIENTATION — model reads these first to know where it is
  // -------------------------------------------------------------------------

  const taskLine = useContextStore.getState().getTaskLine();
  const contextStatsLine = useContextStore.getState().getStatsLine();
  const cm = useAppStore.getState().cacheMetrics;
  const cacheTag = cm.sessionRequests > 0 ? ` | cache:${(cm.sessionHitRate * 100).toFixed(0)}%` : '';
  const header = taskLine
    ? `${taskLine}\n${contextStatsLine}${cacheTag}`
    : `${contextStatsLine}${cacheTag}`;
  parts.push(header);

  const reasoningRecap = _extractRecentReasoning();
  if (reasoningRecap) parts.push(reasoningRecap);

  const bbBlock = _buildBlackboardBlock();
  if (bbBlock) parts.push(bbBlock);

  const pendingActionBlock = buildPendingActionBlock();
  if (pendingActionBlock) {
    parts.push(pendingActionBlock);
  }

  // -------------------------------------------------------------------------
  // STEERING — edit awareness, repair escalation, context pressure
  // -------------------------------------------------------------------------

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
  if (damagedEdits.length > 0) {
    parts.push(`<<DAMAGED EDIT: ${damagedEdits.join('; ')}. Content is live in context. Fix the error.>>`);
  }
  if (healthyEdits.length > 0) {
    parts.push(`<<RECENT EDITS: ${healthyEdits.join(', ')}. ATLS tracks live file state — do not re-read, re-search, or re-stage these files unless verifying a specific change. Use h:refs from edit results directly.>>`);
  }

  const escalatedRepairs = bbEntries
    .filter(e => e.key.startsWith('repair:') && e.state === 'active' && parseInt(e.preview, 10) >= 2)
    .map(e => `${e.key.slice(7)} (${e.preview} attempts)`);
  if (escalatedRepairs.length > 0) {
    parts.push(`<<ESCALATED REPAIR: ${escalatedRepairs.join(', ')}. Multiple failed repairs. Full scope in context. Review holistically before editing.>>`);
  }

  try {
    const ctxChunks = useContextStore.getState().chunks;
    if (ctxChunks?.size > 0) {
      const now = Date.now();
      const activeCutoff = now - 3 * 60_000;
      let activeTkSum = 0, staleTkSum = 0;
      for (const c of ctxChunks.values()) {
        if (c.type === 'msg:user' || c.type === 'msg:asst') continue;
        const fresh = !c.compacted && (c.lastAccessed ?? 0) >= activeCutoff
          && canSteerExecution({ freshness: c.freshness });
        if (fresh) activeTkSum += c.tokens ?? 0;
        else if (!c.compacted) staleTkSum += c.tokens ?? 0;
      }
      if (staleTkSum > activeTkSum && staleTkSum > 2000) {
        parts.push('<<CONTEXT PRESSURE: stale engrams exceed active — distill findings to BB, then drop stale engrams.>>');
      }
    }
  } catch {
    // Fail-safe: skip pressure hint if store/chunks unavailable
  }

  const ctxState = useContextStore.getState();
  const bm = ctxState.batchMetrics;
  let bbStreak = ctxState.batchReadNoBbStreak;
  if (bm.hadSubstantiveBbWrite) {
    bbStreak = 0;
  } else if (bm.hadReads && !bm.hadSubstantiveBbWrite) {
    bbStreak = bbStreak + 1;
  } else {
    bbStreak = 0;
  }
  useContextStore.setState({ batchReadNoBbStreak: bbStreak });

  if (bm.hadReads && !bm.hadSubstantiveBbWrite) {
    if (bbStreak >= 2) {
      parts.push(
        `<<STOP: You have read files for ${bbStreak} consecutive rounds without persisting structured findings. Write conclusions (clear/bug/inconclusive) to session.bb.write or act on what you have. Progress notes do not count.>>`,
      );
    } else {
      parts.push(
        '<<FINDINGS: batch read files with no structured BB finding — write conclusions (clear/bug/inconclusive) to session.bb.write before they go dormant.>>',
      );
    }
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

  const dormantBlock = buildDormantBlock();
  if (dormantBlock) parts.push(dormantBlock);

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
  useAppStore.getState().resetLogicalCache();
}

let _prevStaticKey: string | null = null;
let _prevBp3Snapshot: Bp3Snapshot | null = null;

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
  entryManifestDepth?: 'off' | 'paths' | 'sigs' | 'paths_sigs',
): string {
  // Inject refactor config early for cache key (refactor mode only)
  const refactorPart = mode === 'refactor' ? useRefactorStore.getState().getConfigForPrompt() : '';
  // P0 #1: Check cache — key includes refactor config for invalidation when thresholds change
  const manifestFingerprint = JSON.stringify(entryManifest ?? '').length;
  const cacheKey = `${mode}|${shellContext?.os ?? ''}|${shellContext?.shell ?? ''}|${shellContext?.cwd ?? ''}|${atlsReady ?? false}|${provider ?? ''}|${refactorPart}|${entryManifestDepth ?? 'off'}|${manifestFingerprint}`;
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

  // Build shell-specific guidance (for agent mode with terminal access)
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
batch({version:"1.0",steps:[{id:"exec",use:"system.exec",with:{cmd:"..."}}]}) → write cmd to temp .ps1 and run in agent shell`;

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
    : 'Full agent mode: Can read, analyze, and modify code.';

  // Inject refactor config thresholds when in refactor mode (reuse refactorPart from cache key)
  const refactorConfig = mode === 'refactor' ? `\n${refactorPart}\n` : '';

  // Shared edit/verify discipline (non-designer, ATLS ready)
  const editDisciplineSection = (atlsReady && mode !== 'designer') ? `\n${EDIT_DISCIPLINE}` : '';

  // Designer uses slim context control + inline response hint; others use full COGNITIVE_CORE_V1.
  const contextControl = mode === 'designer'
    ? `\n${CONTEXT_CONTROL_DESIGNER}\n## Output: 1 sentence between tool calls. End with a concise final summary.`
    : `\n${CONTEXT_CONTROL_V4}`;
  const hppSection = (atlsReady && mode !== 'designer') ? `\n${HASH_PROTOCOL_CORE}` : '';
  const providerReinforcement = (provider === 'google' || provider === 'vertex')
    ? `\n${GEMINI_REINFORCEMENT}`
    : '';

  // Entry manifest (frozen at session start, cached in BP1)
  let entryManifestSection = '';
  if (entryManifestDepth && entryManifestDepth !== 'off' && entryManifest?.length) {
    const pathList = entryManifest.map(e => `${e.path} (${e.method}, ${e.lines}L)`).join(' | ');
    const sigLines = entryManifest
      .filter(e => e.sig && e.tokens > 0)
      .map(e => e.sig);
    if (entryManifestDepth === 'paths') {
      entryManifestSection = `\n\n## Entry Points\n${pathList}`;
    } else if (entryManifestDepth === 'sigs') {
      if (sigLines.length > 0) {
        entryManifestSection = `\n\n## Entry Points\n${sigLines.join('\n')}`;
      }
    } else {
      // paths_sigs
      const body =
        sigLines.length > 0 ? `${pathList}\n\n${sigLines.join('\n')}` : pathList;
      entryManifestSection = `\n\n## Entry Points\n${body}`;
    }
  }

  const metricsSnapshot = {
    modePromptTokens: countTokensSync(modePrompt + refactorConfig),
    toolRefTokens: countTokensSync(toolRef),
    shellGuideTokens: countTokensSync(shellGuide),
    nativeToolTokens: NATIVE_TOOL_TOKENS_ESTIMATE,
    contextControlTokens: countTokensSync(editDisciplineSection + contextControl + hppSection + providerReinforcement),
    entryManifestTokens: countTokensSync(entryManifestSection),
  };
  useAppStore.getState().setPromptMetrics(metricsSnapshot);

  const result = `${modePrompt}${projectLine}${shellGuide}

${toolRef}${entryManifestSection}

${modeRules}${refactorConfig}${editDisciplineSection}${contextControl}${hppSection}${providerReinforcement}`;

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
 */
function _buildBlackboardBlock(): string {
  const ctxState = useContextStore.getState();
  if (ctxState.blackboardEntries.size === 0) return '';
  const bbLines: string[] = ['## BLACKBOARD'];
  ctxState.blackboardEntries.forEach((entry, key) => {
    if (key.startsWith('edit:')) return;
    if (!canSteerExecution({ state: entry.state })) return;
    bbLines.push(`${key}: ${entry.content}`);
  });
  if (bbLines.length <= 1) return '';
  return bbLines.join('\n');
}

const MAX_DORMANT_LINES = 40;

/**
 * Build the dormant engram digest block for the dynamic (uncached) user message.
 * Moved out of BP3 — dormant set mutates on compaction/eviction.
 */
export function buildDormantBlock(): string {
  const ctxState = useContextStore.getState();
  const dormantLines: string[] = [];
  ctxState.chunks.forEach(c => {
    if (c.compacted && c.type !== 'msg:user' && c.type !== 'msg:asst') {
      const ref = getRef(c.hash);
      if (!ref || shouldMaterialize(ref)) return;
      const src = c.source ? c.source.split(/[/\\]/).pop() || c.source : c.shortHash;
      let line = `h:${c.shortHash} ${src} ${c.tokens}tk`;
      const finding = c.annotations?.[0]?.content || c.summary || '';
      if (finding) {
        line += ` — ${finding.length > 80 ? finding.slice(0, 77) + '...' : finding}`;
      }
      if (c.suspectSince != null || (c.freshness && c.freshness !== 'fresh')) {
        line += ' [suspect]';
      }
      dormantLines.push(line);
    }
  });
  if (dormantLines.length === 0) return '';
  if (dormantLines.length > MAX_DORMANT_LINES) {
    const overflow = dormantLines.length - MAX_DORMANT_LINES;
    dormantLines.length = MAX_DORMANT_LINES;
    dormantLines.push(`... and ${overflow} more dormant engrams (use session.drop to clean)`);
  }
  return '## DORMANT ENGRAMS\n' + dormantLines.join('\n');
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

// ============================================================================
// Swarm-Specific Chat Streaming (re-exported from swarmChat.ts at top of file)
// ============================================================================

/**
 * Get provider from model ID
 */
export function getProviderFromModel(modelId: string): AIProvider {
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4')) return 'openai';
  if (modelId.startsWith('gemini-')) return 'google';
  if (modelId.startsWith('claude-')) return 'anthropic';
  return 'anthropic';
}
