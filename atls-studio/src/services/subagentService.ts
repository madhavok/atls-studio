/**
 * SubAgent Service — Engram-First Architecture
 *
 * Dispatches subagents (retriever, design, coder, tester) that operate as
 * first-class HPP citizens. Each round sends a rebuilt snapshot from store
 * state (engram refs + BB + last batch outcome) instead of growing chat
 * transcripts. Budget-based stopping replaces hard round caps.
 */

import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { safeListen } from '../utils/tauri';
import type { ContextUsage, StreamChunk, AIProvider } from '../stores/appStore';
import { useAppStore } from '../stores/appStore';
import { useContextStore } from '../stores/contextStore';
import { canSteerExecution } from './universalFreshness';
import { useCostStore, calculateCost, calculateCostBreakdown } from '../stores/costStore';
import { useRoundHistoryStore, type RoundSnapshot } from '../stores/roundHistoryStore';
import { countTokensSync } from '../utils/tokenCounter';
import { buildSubagentPrompt, type SubagentRole } from '../prompts/subagentPrompts';
import { coerceBatchSteps } from './batch/coerceBatchSteps';
import { formatBatchToolUseStubSummary } from './historyCompressor';
import { expandBatchQ } from '../utils/toon';
import { dematerialize, getRef, type ScopedHppView } from './hashProtocol';
import {
  SUBAGENT_MAX_ROUNDS,
  SUBAGENT_MAX_ROUNDS_BY_ROLE,
  SUBAGENT_TOKEN_BUDGET_DEFAULT,
  SUBAGENT_TOKEN_BUDGET_BY_ROLE,
  SUBAGENT_MAX_OUTPUT_TOKENS_BY_ROLE,
  SUBAGENT_PIN_BUDGET_CAP,
  SUBAGENT_STAGED_PATHS_CAP,
} from './promptMemory';
import { resolveModelSettings, type ResolvedModelSettings } from '../utils/modelSettings';
import { formatEntryManifestSection } from './aiService';
import { isExtendedContextEnabled, modelSupportsExtendedContext } from '../utils/modelCapabilities';
export type { AIProvider };

const PRIOR_THOUGHT_START = '<<PRIOR_THOUGHT>>';
const PRIOR_THOUGHT_END = '<</PRIOR_THOUGHT>>';

function mergeReasoningAndText(reasoning: string, text: string): string {
  const r = reasoning.trim();
  const t = text.trim();
  const wrapped = r ? `${PRIOR_THOUGHT_START}\n${r}\n${PRIOR_THOUGHT_END}` : '';
  if (wrapped && t) return `${wrapped}\n\n${t}`;
  return wrapped || t;
}

// ============================================================================
// Types
// ============================================================================

export type SubagentType = 'retriever' | 'design' | 'coder' | 'tester';

export interface SubAgentParams {
  type: SubagentType;
  query: string;
  focus_files?: string[];
  /** Pre-resolved focus file context (signatures/summaries) from the parent's store. */
  focus_file_context?: string;
  max_tokens?: number;
  token_budget?: number;
  /** File ownership claims from parent swarm worker — enforced on change ops. */
  fileClaims?: string[];
}

export interface SubAgentRef {
  hash: string;
  shortHash: string;
  source: string;
  lines?: string;
  tokens: number;
  digest?: string;
  pinned: boolean;
  pinnedShape?: string;
  type: string;
}

export interface SubAgentToolTraceEntry {
  toolName: string;
  message: string;
  round: number;
  ts: number;
  done: boolean;
}

export interface SubAgentResult {
  refs: SubAgentRef[];
  bbKeys: string[];
  summary: string;
  finalText?: string;
  pinCount: number;
  pinTokens: number;
  costCents: number;
  rounds: number;
  toolCalls: number;
  invocationId: string;
  /** Bounded chronological trace of tool activity for UI display. */
  toolTrace: SubAgentToolTraceEntry[];
}

export interface SubAgentUsage {
  invocationId: string;
  type: SubagentType;
  provider: AIProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costCents: number;
  rounds: number;
  toolCalls: number;
  pinTokens: number;
  timestamp: Date;
}

export interface SubAgentProgress {
  status: 'searching' | 'reading' | 'pinning' | 'implementing' | 'testing' | 'complete' | 'error';
  message: string;
  toolName?: string;
  filePath?: string;
  round?: number;
  done?: boolean;
  pinCount?: number;
  pinTokens?: number;
}

export type SubAgentProgressCallback = (progress: SubAgentProgress) => void;

// ============================================================================
// Role Configuration — Allowlists & BB Keys
// ============================================================================

const RETRIEVER_ALLOWED_OPS = new Set([
  'search.code', 'search.symbol', 'search.usage', 'search.similar',
  'read.context', 'read.shaped', 'read.lines',
  'session.pin', 'session.stage', 'session.bb.write', 'session.bb.read',
  'intent.understand', 'intent.investigate', 'intent.survey',
]);

const DESIGN_ALLOWED_OPS = new Set([
  ...RETRIEVER_ALLOWED_OPS,
  'intent.diagnose', 'intent.test',
  'analyze.deps', 'analyze.structure', 'analyze.impact',
]);

const CODER_ALLOWED_OPS = new Set([
  'search.code', 'search.symbol',
  'read.context', 'read.shaped', 'read.lines',
  'change.edit', 'change.create', 'change.delete', 'change.refactor',
  'verify.build', 'verify.lint', 'verify.typecheck',
  'session.pin', 'session.stage', 'session.bb.write', 'session.bb.read',
  'system.exec',
  'intent.edit', 'intent.edit_multi', 'intent.understand', 'intent.investigate',
]);

const TESTER_ALLOWED_OPS = new Set([
  'search.code',
  'read.context', 'read.shaped', 'read.lines',
  'change.edit', 'change.create',
  'verify.test', 'verify.build',
  'session.pin', 'session.stage', 'session.bb.write', 'session.bb.read',
  'system.exec',
  'intent.test', 'intent.understand', 'intent.investigate',
]);

export const ROLE_ALLOWED_OPS: Record<SubagentType, Set<string>> = {
  retriever: RETRIEVER_ALLOWED_OPS,
  design: DESIGN_ALLOWED_OPS,
  coder: CODER_ALLOWED_OPS,
  tester: TESTER_ALLOWED_OPS,
};

const ROLE_BB_KEYS: Record<SubagentType, string> = {
  retriever: 'retriever:findings',
  design: 'design:research',
  coder: 'coder:report',
  tester: 'tester:results',
};

const ROLE_NEEDS_TERMINAL = new Set<SubagentType>(['coder', 'tester']);

/** BB key prefixes visible to each subagent role (avoids leaking unrelated entries). */
const ROLE_BB_PREFIXES: Record<SubagentType, string[]> = {
  retriever: ['retriever:', 'investigate:', 'survey:', 'tree:', 'deps:'],
  design:    ['design:', 'retriever:', 'investigate:', 'survey:', 'tree:', 'deps:', 'diagnose:', 'test_context:'],
  coder:     ['coder:', 'design:', 'retriever:', 'investigate:', 'deps:', 'extract_plan:'],
  tester:    ['tester:', 'coder:', 'design:', 'test_context:', 'investigate:'],
};

// ============================================================================
// Budget Calculation
// ============================================================================

function computePinBudget(
  contextUsage: ContextUsage,
  maxTokensOverride?: number,
): number {
  if (maxTokensOverride && maxTokensOverride > 0) {
    return Math.min(maxTokensOverride, SUBAGENT_PIN_BUDGET_CAP);
  }
  const remaining = Math.max(0, contextUsage.maxTokens - contextUsage.totalTokens);
  return Math.min(Math.floor(remaining * 0.4), SUBAGENT_PIN_BUDGET_CAP);
}

// ============================================================================
// Streaming Round
// ============================================================================

interface PendingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface SubagentUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Usage token fields from the `usage` stream variant (Pick on StreamChunk union is invalid in TS). */
type StreamUsageChunkFields = Pick<
  Extract<StreamChunk, { type: 'usage' }>,
  'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'cached_content_tokens'
>;

/**
 * Merge streaming `usage` chunks into per-round totals.
 * Anthropic sends preliminary usage on message_start; message_delta usage is cumulative. Partial
 * deltas often include only output_tokens (input_tokens: 0) — we must not overwrite prompt tokens
 * with 0. The final message_delta may repeat full input_tokens after server tools (web_search, etc.);
 * those values must win for billing.
 */
export function foldSubagentUsageMetrics(
  prev: SubagentUsageMetrics,
  chunk: StreamUsageChunkFields,
): SubagentUsageMetrics {
  const inT = chunk.input_tokens ?? 0;
  const outT = chunk.output_tokens ?? 0;
  let { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = prev;
  if (inT > 0) inputTokens = inT;
  if (outT > 0) outputTokens = outT;
  const cr = chunk.cache_read_input_tokens ?? chunk.cached_content_tokens ?? 0;
  const cw = chunk.cache_creation_input_tokens ?? 0;
  if (cr > 0) cacheReadTokens = cr;
  if (cw > 0) cacheWriteTokens = cw;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

type SubagentStreamOptions = ResolvedModelSettings & {
  anthropicBeta?: string[] | null;
};

async function runSubagentRound(
  provider: AIProvider,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt: string,
  streamId: string,
  maxOutputTokens: number,
  streamOpts: SubagentStreamOptions,
  baseUrl?: string,
  projectId?: string,
  region?: string,
): Promise<{
  fullResponse: string;
  reasoningContent: string;
  pendingToolCalls: PendingToolCall[];
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}> {
  let fullResponse = '';
  let reasoningContent = '';
  const pendingToolCalls: PendingToolCall[] = [];
  let stopReason: string | null = null;
  let streamError: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  let resolveDone: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const unlisten: UnlistenFn = await safeListen<StreamChunk>(
    `chat-chunk-${streamId}`,
    (event) => {
      const chunk = event.payload;
      switch (chunk.type) {
        case 'text_delta':
          fullResponse += chunk.delta;
          break;
        case 'reasoning_delta':
          reasoningContent += chunk.delta;
          break;
        case 'tool_input_available':
          pendingToolCalls.push({
            id: chunk.tool_call_id,
            name: chunk.tool_name,
            args: chunk.input,
          });
          break;
        case 'usage': {
          const next = foldSubagentUsageMetrics(
            { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
            chunk,
          );
          inputTokens = next.inputTokens;
          outputTokens = next.outputTokens;
          cacheReadTokens = next.cacheReadTokens;
          cacheWriteTokens = next.cacheWriteTokens;
          break;
        }
        case 'stop_reason':
          stopReason = chunk.reason;
          break;
        case 'done':
          unlisten();
          resolveDone!();
          break;
        case 'error':
          streamError = (chunk as Record<string, unknown>).message as string
            || (chunk as Record<string, unknown>).error as string
            || 'Unknown streaming error';
          console.error(`[subagent] Stream error (${streamId}):`, streamError);
          unlisten();
          resolveDone!();
          break;
        default:
          break;
      }
    },
  );

  const commonParams = {
    model,
    messages,
    maxTokens: maxOutputTokens,
    temperature: 0.3,
    systemPrompt,
    streamId,
    enableTools: true,
  };

  console.log(`[subagent] Invoking ${provider}/${model} (stream=${streamId})`);

  if (provider === 'anthropic') {
    await invoke('stream_chat_anthropic', {
      ...commonParams,
      apiKey,
      anthropicBeta: streamOpts.anthropicBeta ?? null,
      thinkingBudget: streamOpts.thinkingBudget ?? null,
      effort: streamOpts.reasoningEffort ?? null,
    });
  } else if (provider === 'openai') {
    await invoke('stream_chat_openai', {
      ...commonParams,
      apiKey,
      reasoningEffort: streamOpts.reasoningEffort ?? null,
      verbosity: streamOpts.outputVerbosity ?? null,
    });
  } else if (provider === 'vertex') {
    await invoke('stream_chat_vertex', {
      ...commonParams,
      accessToken: apiKey,
      projectId: projectId || '',
      region: region || null,
      cachedContent: null,
      dynamicContext: null,
      thinkingBudget: streamOpts.thinkingBudget ?? null,
    });
  } else if (provider === 'google') {
    await invoke('stream_chat_google', {
      ...commonParams,
      apiKey,
      cachedContent: null,
      dynamicContext: null,
      thinkingBudget: streamOpts.thinkingBudget ?? null,
    });
  } else if (provider === 'lmstudio') {
    await invoke('stream_chat_lmstudio', {
      ...commonParams,
      baseUrl: baseUrl || 'http://localhost:1234',
      reasoningEffort: streamOpts.reasoningEffort ?? null,
    });
  } else {
    throw new Error(`Subagent streaming not supported for provider: ${provider}`);
  }

  const SUBAGENT_ROUND_TIMEOUT_MS = 5 * 60 * 1000;
  const timeoutPromise = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), SUBAGENT_ROUND_TIMEOUT_MS),
  );
  const raceResult = await Promise.race([donePromise.then(() => 'done' as const), timeoutPromise]);
  if (raceResult === 'timeout') {
    unlisten();
    streamError = `Subagent round timed out after ${SUBAGENT_ROUND_TIMEOUT_MS / 1000}s`;
    console.error(`[subagent] ${streamError}`);
  }

  if (streamError) {
    throw new Error(`Subagent stream failed (${provider}/${model}): ${streamError}`);
  }

  console.log(`[subagent] Round complete (${streamId}): ${pendingToolCalls.length} tool calls, stop=${stopReason}, in=${inputTokens} out=${outputTokens}`);
  return { fullResponse, reasoningContent, pendingToolCalls, stopReason, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

// ============================================================================
// Tool Execution (with role-based allowlist enforcement)
// ============================================================================

export const SUBAGENT_MAX_FILE_PATHS = 15;

const BARE_DIR_PATTERN = /^\.?\/?$|^\.\.?\/?$/;

let _cachedExecuteToolCall: ((name: string, args: Record<string, unknown>, options?: Record<string, unknown>) => Promise<string>) | null = null;
async function getExecuteToolCall() {
  if (!_cachedExecuteToolCall) {
    const mod = await import('./aiService');
    _cachedExecuteToolCall = mod.executeToolCall;
  }
  return _cachedExecuteToolCall;
}

function sanitizeSubagentSteps(
  steps: Array<Record<string, unknown>>,
  role: SubagentType,
): string | null {
  for (const step of steps) {
    const w = step.with as Record<string, unknown> | undefined;
    if (!w) continue;

    const filePaths = w.file_paths;
    if (Array.isArray(filePaths)) {
      // Reject bare directory paths (".", "./", "..", "../")
      const bare = filePaths.filter(p => typeof p === 'string' && BARE_DIR_PATTERN.test(p.trim()));
      if (bare.length > 0) {
        return `Error: ${role} subagent cannot read bare directories (${bare.join(', ')}). Provide specific file paths.`;
      }

      // Cap file_paths to prevent bulk ingestion
      if (filePaths.length > SUBAGENT_MAX_FILE_PATHS) {
        console.warn(`[subagent:${role}] Capping file_paths from ${filePaths.length} to ${SUBAGENT_MAX_FILE_PATHS} in ${step.use}`);
        w.file_paths = filePaths.slice(0, SUBAGENT_MAX_FILE_PATHS);
      }
    }

    // Tree reads are allowed for survey but cap depth for subagents
    if (step.use === 'read.context' && w.type === 'tree') {
      const depth = typeof w.depth === 'number' ? w.depth : 3;
      if (depth > 2) w.depth = 2;
    }
  }
  return null;
}

async function executeSubagentToolCall(
  role: SubagentType,
  name: string,
  args: Record<string, unknown>,
  options?: { swarmTerminalId?: string; fileClaims?: string[] },
): Promise<string> {
  const allowed = ROLE_ALLOWED_OPS[role];
  if (!allowed) {
    return `Error: Unknown subagent role '${role}'`;
  }

  if (name !== 'batch') {
    return `Error: Tool '${name}' is not allowed for ${role} subagent. Use batch() only.`;
  }

  const expanded = expandBatchQ(args);
  if (expanded !== args) { Object.keys(args).forEach(k => delete args[k]); Object.assign(args, expanded); }

  args.steps = coerceBatchSteps(args.steps);
  const steps = args.steps as Array<Record<string, unknown>>;
  if (steps.length === 0) {
    return `Error: ${role} subagent requires batch steps`;
  }

  const disallowed = steps.filter(step => !allowed.has(String(step.use)));
  if (disallowed.length > 0) {
    return `Error: batch ops not allowed for ${role}: ${disallowed.map(step => step.use).join(', ')}. Allowed: ${[...allowed].join(', ')}`;
  }

  const sanitizeErr = sanitizeSubagentSteps(steps, role);
  if (sanitizeErr) return sanitizeErr;

  const executeToolCall = await getExecuteToolCall();
  return executeToolCall(name, args, options);
}

// ============================================================================
// Snapshot Builder — engram-first per-round context
// ============================================================================

function buildSubagentSnapshot(
  role: SubagentType,
  query: string,
  focusFiles: string[] | undefined,
  round: number,
  totalInputTokens: number,
  totalOutputTokens: number,
  tokenBudget: number,
  pinBudget: number,
  preExistingHashes: Set<string>,
  preExistingSources: Set<string>,
  lastBatchOutcome: string | null,
  lastErrors: string[],
): string {
  const ctx = useContextStore.getState();
  const sections: string[] = [];

  sections.push(query);
  if (focusFiles?.length) {
    sections.push(`Focus files: ${focusFiles.join(', ')}`);
  }

  const metrics = buildSnapshotMetrics(preExistingHashes, preExistingSources);

  const tokensUsed = totalInputTokens + totalOutputTokens;
  sections.push(
    `\n## SUBAGENT WORKING STATE (round ${round})`,
    `Token budget: ${(tokensUsed / 1000).toFixed(1)}k of ${(tokenBudget / 1000).toFixed(0)}k used | Pin budget: ${(metrics.pinTokens / 1000).toFixed(1)}k of ${(pinBudget / 1000).toFixed(0)}k tokens`,
  );

  // Subagent engram surface: keep the list tight. Prior runs added a full
  // enumeration with descriptions; a compact one-line-per-ref summary is
  // enough handoff signal (FileView already renders content when pinned).
  if (metrics.engramLines.length > 0) {
    const lines = metrics.engramLines;
    const COMPACT_CAP = 12;
    sections.push('\n## ENGRAMS CREATED');
    if (lines.length <= COMPACT_CAP) {
      sections.push(lines.join('\n'));
    } else {
      sections.push(lines.slice(0, COMPACT_CAP).join('\n') + `\n... +${lines.length - COMPACT_CAP} more (see HASH MANIFEST)`);
    }
  }

  const bbAllowedPrefixes = ROLE_BB_PREFIXES[role];
  const bbLines: string[] = [];
  ctx.blackboardEntries.forEach((entry, key) => {
    if (key.startsWith('edit:') || key.startsWith('__')) return;
    if (!bbAllowedPrefixes.some(p => key.startsWith(p))) return;
    bbLines.push(`${key}: ${entry.content.length > 500 ? entry.content.slice(0, 500) + '...' : entry.content}`);
  });
  if (bbLines.length > 0) {
    sections.push('\n## BLACKBOARD');
    sections.push(bbLines.join('\n'));
  }

  if (lastBatchOutcome) {
    sections.push('\n## LAST BATCH OUTCOME');
    sections.push(lastBatchOutcome);
  }

  if (lastErrors.length > 0) {
    sections.push('\n## ERRORS / WARNINGS');
    sections.push(lastErrors.join('\n'));
  }

  // Subagents see their staged paths in the manifest already; keep this
  // summary terse. Do-not-re-read rule stays, via one-line reference.
  const stagedPaths = Array.from(ctx.stagedSnippets.values())
    .filter(s => s.source && canSteerExecution({ stageState: s.stageState, freshness: s.freshness }))
    .map(s => s.source!)
    .filter(src => src && !metrics.newStagedSources.has(src));
  if (stagedPaths.length > 0) {
    const shown = stagedPaths.slice(0, SUBAGENT_STAGED_PATHS_CAP);
    const overflow = stagedPaths.length - shown.length;
    sections.push(`\n## ALREADY STAGED: ${shown.join(', ')}${overflow > 0 ? ` +${overflow} more` : ''} (use existing refs)`);
  }

  sections.push('\nContinue your task.');

  return sections.join('\n');
}

interface SnapshotMetrics {
  engramLines: string[];
  pinTokens: number;
  newStagedSources: Set<string>;
}

function buildSnapshotMetrics(
  preExistingHashes: Set<string>,
  preExistingSources: Set<string>,
): SnapshotMetrics {
  const ctx = useContextStore.getState();
  const engramLines: string[] = [];
  let pinTokens = 0;
  const newStagedSources = new Set<string>();

  for (const snippet of ctx.stagedSnippets.values()) {
    if (!snippet.content || !snippet.source) continue;
    if (!canSteerExecution({ stageState: snippet.stageState, freshness: snippet.freshness })) continue;
    if (preExistingSources.has(snippet.source)) continue;
    const tk = countTokensSync(snippet.content);
    pinTokens += tk;
    newStagedSources.add(snippet.source);
    const lineInfo = snippet.lines ? `:${snippet.lines}` : '';
    engramLines.push(`h:staged (${snippet.source}${lineInfo}, ${(tk / 1000).toFixed(1)}k tk) [staged]`);
  }

  for (const [hash, chunk] of ctx.chunks.entries()) {
    if (preExistingHashes.has(hash)) continue;
    if (chunk.suspectSince != null || chunk.freshness === 'suspect') continue;
    if (chunk.pinned && chunk.content) {
      pinTokens += chunk.tokens;
    }
    if (chunk.type === 'msg:user' || chunk.type === 'msg:asst') continue;
    if (!chunk.content) continue;
    const src = chunk.source || chunk.type;
    const pinnedTag = chunk.pinned ? ' [pinned]' : '';
    engramLines.push(`h:${chunk.shortHash} (${src}, ${(chunk.tokens / 1000).toFixed(1)}k tk)${pinnedTag}`);
  }

  return { engramLines, pinTokens, newStagedSources };
}

// ============================================================================
// Ref Extraction — returns SubAgentRef[] with hashes
// ============================================================================

const EXCLUDED_PATH_PATTERNS = [
  /[/\\]patterns[/\\].*\.json$/i,
  /[/\\]schemas[/\\].*\.json$/i,
  /Cargo\.lock$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
];

function isExcludedPath(path: string): boolean {
  return EXCLUDED_PATH_PATTERNS.some(re => re.test(path));
}

function extractSubagentRefs(
  preExistingHashes: Set<string>,
  preExistingSources: Set<string>,
): SubAgentRef[] {
  const ctx = useContextStore.getState();
  const refs: SubAgentRef[] = [];

  // Priority 1: staged snippets (most precise)
  const stagedSources = new Set<string>();
  for (const [key, snippet] of ctx.stagedSnippets.entries()) {
    if (!snippet.content) continue;
    if (!canSteerExecution({ stageState: snippet.stageState, freshness: snippet.freshness })) continue;
    if (preExistingSources.has(snippet.source || '')) continue;
    if (snippet.source && isExcludedPath(snippet.source)) continue;
    if (snippet.source) stagedSources.add(snippet.source);
    refs.push({
      hash: key,
      shortHash: key.slice(0, 8),
      source: snippet.source || 'unknown',
      lines: snippet.lines,
      tokens: countTokensSync(snippet.content),
      digest: undefined,
      pinned: false,
      type: 'staged',
    });
  }

  // Priority 2: pinned chunks
  for (const [hash, chunk] of ctx.chunks.entries()) {
    if (preExistingHashes.has(hash)) continue;
    if (!chunk.pinned || !chunk.content) continue;
    if (chunk.suspectSince != null || chunk.freshness === 'suspect' || chunk.freshness === 'changed') continue;
    if (chunk.source && preExistingSources.has(chunk.source)) continue;
    if (chunk.source && isExcludedPath(chunk.source)) continue;
    if (chunk.source && stagedSources.has(chunk.source)) continue;
    refs.push({
      hash: chunk.hash,
      shortHash: chunk.shortHash,
      source: chunk.source || 'unknown',
      lines: undefined,
      tokens: chunk.tokens,
      digest: chunk.digest,
      pinned: true,
      pinnedShape: chunk.pinnedShape,
      type: chunk.type,
    });
  }

  // Priority 3: new non-chat chunks (fallback if model didn't pin/stage)
  if (refs.length === 0) {
    for (const [hash, chunk] of ctx.chunks.entries()) {
      if (preExistingHashes.has(hash)) continue;
      if (!chunk.content || chunk.type === 'msg:user' || chunk.type === 'msg:asst') continue;
      if (chunk.source && isExcludedPath(chunk.source)) continue;
      refs.push({
        hash: chunk.hash,
        shortHash: chunk.shortHash,
        source: chunk.source || 'unknown',
        lines: undefined,
        tokens: chunk.tokens,
        digest: chunk.digest,
        pinned: !!chunk.pinned,
        type: chunk.type,
      });
    }
    if (refs.length > 0) {
      console.log(`[subagent] Fallback: extracted ${refs.length} new chunks (model didn't pin/stage explicitly)`);
    }
  }

  return refs;
}

// ============================================================================
// Post-Subagent Cleanup — prevent parent context inflation
// ============================================================================

/**
 * Dematerialize chunks created by the subagent so they appear as dormant
 * (digest-only) in the parent model's next prompt. Without this, subagent reads
 * stay materialized (seenAtTurn === globalTurn) and formatWorkingMemory emits
 * full file bodies, inflating the parent's context by megabytes.
 *
 * Pinned chunks are left materialized — the parent needs them, and HPP's
 * shouldMaterialize already exempts pinned refs.
 *
 * When a {@link ScopedHppView} is supplied, its `touchedHashes()` is merged
 * with the heuristic discovery pass as the authoritative set of refs the
 * subagent touched. This closes the "nested tool-call refs leak into the
 * global refs Map" window: the heuristic pass can miss hashes the subagent
 * only resolved via `getRef`, whereas the scoped view records every resolve
 * and materialize it brokered.
 */
export function dematerializeSubagentChunks(
  preExistingHashes: Set<string>,
  preExistingSources: Set<string>,
  scopedView?: ScopedHppView,
): void {
  const ctx = useContextStore.getState();
  const toDematerialize = new Set<string>();

  for (const [hash, chunk] of ctx.chunks.entries()) {
    if (preExistingHashes.has(hash)) continue;
    if (chunk.pinned) continue;
    if (preExistingSources.has(chunk.source || '')) continue;
    const ref = getRef(hash);
    if (ref && ref.visibility === 'materialized') {
      toDematerialize.add(hash);
    }
  }

  if (scopedView) {
    for (const hash of scopedView.touchedHashes()) {
      if (preExistingHashes.has(hash)) continue;
      const chunk = ctx.chunks.get(hash);
      if (chunk?.pinned) continue;
      if (chunk?.source && preExistingSources.has(chunk.source)) continue;
      const ref = getRef(hash);
      if (ref && ref.visibility === 'materialized') {
        toDematerialize.add(hash);
      }
    }
  }

  for (const hash of toDematerialize) {
    dematerialize(hash);
  }

  if (toDematerialize.size > 0) {
    ctx.compactDormantChunks();
    console.log(`[subagent] Dematerialized ${toDematerialize.size} chunks, compacted dormant`);
  }
}

/**
 * Drop staged snippets created during the subagent run, **except** those
 * included in the returned refs. session.stage resolves full file bodies
 * into stagedSnippets; bulk intent.survey can stage hundreds of files and
 * blow the prompt. But staged refs that were selected for handoff must
 * survive so the parent can dereference them.
 */
function unstageSubagentAdded(preExistingStagedKeys: Set<string>, preserveKeys?: Set<string>): void {
  const ctx = useContextStore.getState();
  const keys = Array.from(ctx.stagedSnippets.keys())
    .filter(k => !preExistingStagedKeys.has(k) && !preserveKeys?.has(k));
  if (keys.length === 0) return;
  let freed = 0;
  for (const key of keys) {
    freed += ctx.unstageSnippet(key).freed;
  }
  const preserved = preserveKeys ? preserveKeys.size : 0;
  console.log(`[subagent] Unstaged ${keys.length} subagent-added snippets (preserved ${preserved} ref'd), freed ~${(freed / 1000).toFixed(1)}k tokens`);
}

// ============================================================================
// Stopping Conditions
// ============================================================================

interface StopCheck {
  shouldStop: boolean;
  reason?: string;
}

function checkStopConditions(
  role: SubagentType,
  round: number,
  totalInputTokens: number,
  totalOutputTokens: number,
  tokenBudget: number,
  pinBudget: number,
  preExistingHashes: Set<string>,
  preExistingSources: Set<string>,
  lastBatchResult: string | null,
  noToolCalls: boolean,
): StopCheck {
  // Role-specific round cap (falls back to safety ceiling)
  const maxRounds = SUBAGENT_MAX_ROUNDS_BY_ROLE[role] ?? SUBAGENT_MAX_ROUNDS;
  if (round >= maxRounds) {
    return { shouldStop: true, reason: `max rounds reached (${maxRounds} for ${role})` };
  }

  // Token budget exhaustion
  const tokensUsed = totalInputTokens + totalOutputTokens;
  if (tokensUsed > tokenBudget) {
    return { shouldStop: true, reason: `token budget exhausted (${(tokensUsed / 1000).toFixed(0)}k / ${(tokenBudget / 1000).toFixed(0)}k)` };
  }

  // Empty round (model said done with no tool calls)
  if (noToolCalls) {
    return { shouldStop: true, reason: 'model completed (no tool calls)' };
  }

  // Pin budget saturation for retriever/design
  if (role === 'retriever' || role === 'design') {
    const currentPinTokens = buildSnapshotMetrics(preExistingHashes, preExistingSources).pinTokens;
    if (currentPinTokens > pinBudget * 0.9) {
      return { shouldStop: true, reason: `pin budget saturated (${(currentPinTokens / 1000).toFixed(1)}k / ${(pinBudget / 1000).toFixed(0)}k)` };
    }
  }

  // task_complete for coder/tester
  if ((role === 'coder' || role === 'tester') && lastBatchResult?.includes('task_complete')) {
    return { shouldStop: true, reason: 'task_complete called' };
  }

  return { shouldStop: false };
}

// ============================================================================
// Message Rebuilder — provider-safe snapshot format
// ============================================================================

function buildProviderMessages(
  role: SubagentType,
  query: string,
  focusFiles: string[] | undefined,
  focusFileContext: string | undefined,
  round: number,
  totalInputTokens: number,
  totalOutputTokens: number,
  tokenBudget: number,
  pinBudget: number,
  preExistingHashes: Set<string>,
  preExistingSources: Set<string>,
  lastBatchOutcome: string | null,
  lastErrors: string[],
  lastAssistantContent: unknown[] | null,
  lastToolResults: Array<{ type: string; tool_use_id: string; name: string; content: string }> | null,
): Array<{ role: string; content: unknown }> {
  const messages: Array<{ role: string; content: unknown }> = [];

  if (round === 0) {
    let content = query;
    if (focusFileContext) {
      content += `\n\n## FOCUS FILES\n${focusFileContext}`;
    } else if (focusFiles?.length) {
      content += `\nFocus files: ${focusFiles.join(', ')}`;
    }
    messages.push({ role: 'user', content });
  } else if (lastAssistantContent && lastToolResults) {
    const snapshot = buildSubagentSnapshot(
      role, query, focusFiles, round,
      totalInputTokens, totalOutputTokens, tokenBudget, pinBudget,
      preExistingHashes, preExistingSources,
      lastBatchOutcome, lastErrors,
    );

    messages.push({ role: 'user', content: snapshot });
    messages.push({ role: 'assistant', content: lastAssistantContent });
    messages.push({ role: 'user', content: lastToolResults });
  } else {
    const snapshot = buildSubagentSnapshot(
      role, query, focusFiles, round,
      totalInputTokens, totalOutputTokens, tokenBudget, pinBudget,
      preExistingHashes, preExistingSources,
      lastBatchOutcome, lastErrors,
    );
    messages.push({ role: 'user', content: snapshot });
  }

  return messages;
}

// ============================================================================
// Unified Subagent Executor
// ============================================================================

export async function executeSubagent(
  params: SubAgentParams,
  onProgress?: SubAgentProgressCallback,
): Promise<SubAgentResult> {
  const role = params.type;
  const invocationId = `subagent-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const appState = useAppStore.getState();
  const settings = appState.settings;

  // Resolve model config
  const subagentProvider = (settings.subagentProvider || settings.selectedProvider) as AIProvider;
  const rawModel = settings.subagentModel;
  const subagentModel = (rawModel && rawModel !== 'none')
    ? rawModel
    : getDefaultSubagentModel(subagentProvider);

  console.log(`[subagent:${role}] Resolved: provider=${subagentProvider}, model=${subagentModel} (raw=${rawModel})`);

  const apiKey = getApiKeyForProvider(subagentProvider, settings as unknown as Record<string, unknown>);
  if (!apiKey) {
    throw new Error(`No API key configured for subagent provider: ${subagentProvider}. Configure it in Settings.`);
  }

  const baseUrl = subagentProvider === 'lmstudio' ? settings.lmstudioBaseUrl : undefined;
  const vertexProjectId = subagentProvider === 'vertex' ? (settings.vertexProjectId as string) : undefined;
  const vertexRegion = subagentProvider === 'vertex' ? (settings.vertexRegion as string) : undefined;

  // Budgets — role-specific defaults, overridable per call
  const contextUsage = appState.contextUsage;
  const pinBudget = computePinBudget(contextUsage, params.max_tokens);
  const tokenBudget = params.token_budget
    ?? SUBAGENT_TOKEN_BUDGET_BY_ROLE[role]
    ?? SUBAGENT_TOKEN_BUDGET_DEFAULT;

  // Snapshot pre-existing state for dedup
  const ctxSnapshot = useContextStore.getState();
  const preExistingStagedKeys = new Set(ctxSnapshot.stagedSnippets.keys());
  const preExistingSources = new Set(
    Array.from(ctxSnapshot.stagedSnippets.values())
      .filter(s => canSteerExecution({ stageState: s.stageState, freshness: s.freshness }))
      .map(s => s.source).filter(Boolean) as string[]
  );
  const preExistingHashes = new Set(ctxSnapshot.chunks.keys());

  // Build system prompt — use pre-resolved focus context when available
  const bbKey = ROLE_BB_KEYS[role];
  const emDepth =
    settings.subagentEntryManifestDepth
    ?? settings.entryManifestDepth
    ?? 'paths';
  const systemPrompt =
    buildSubagentPrompt(role as SubagentRole, {
      pinBudget,
      focusFiles: params.focus_files?.join(', ') || 'none',
      focusFileContext: params.focus_file_context,
      alreadyStaged: 'See ## ALREADY STAGED in working state',
      bbKey,
    })
    + formatEntryManifestSection(appState.projectProfile?.entryManifest, emDepth);

  // Terminal for coder/tester
  let terminalId: string | undefined;
  if (ROLE_NEEDS_TERMINAL.has(role)) {
    try {
      const { getTerminalStore } = await import('../stores/terminalStore');
      const terminalStore = getTerminalStore();
      terminalId = await terminalStore.createTerminal(appState.projectPath || undefined, {
        background: true,
        name: `Subagent: ${role}-${invocationId.slice(-7)}`,
        isAgent: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log(`[subagent:${role}] Created terminal: ${terminalId}`);
    } catch (termError) {
      console.warn(`[subagent:${role}] Could not create terminal:`, termError);
    }
  }

  const streamId = `subagent-${invocationId}`;
  const maxOutputTokens = SUBAGENT_MAX_OUTPUT_TOKENS_BY_ROLE[role] ?? 4096;

  const subSpeed = settings.subagentOutputSpeed ?? settings.modelOutputSpeed;
  const subThinking = settings.subagentThinking ?? settings.modelThinking;
  const subAnthropicBeta =
    subagentProvider === 'anthropic'
    && isExtendedContextEnabled(
      subagentModel,
      'anthropic',
      settings.extendedContextByModelId ?? {},
      settings.extendedContext,
    )
    && modelSupportsExtendedContext(subagentModel, 'anthropic')
      ? ['context-1m-2025-08-07']
      : undefined;
  const streamOpts: SubagentStreamOptions = {
    ...resolveModelSettings(subSpeed, subThinking, subagentModel, subagentProvider, maxOutputTokens),
    anthropicBeta: subAnthropicBeta ?? null,
  };

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalToolCalls = 0;
  let totalRounds = 0;
  let totalCostCents = 0;
  const TOOL_TRACE_CAP = 80;
  const toolTrace: SubAgentToolTraceEntry[] = [];

  let lastAssistantContent: unknown[] | null = null;
  let lastAssistantText: string | null = null;
  let lastToolResults: Array<{ type: string; tool_use_id: string; name: string; content: string }> | null = null;
  let lastBatchOutcome: string | null = null;
  let lastErrors: string[] = [];

  const roleStatusMap: Record<SubagentType, SubAgentProgress['status']> = {
    retriever: 'searching',
    design: 'searching',
    coder: 'implementing',
    tester: 'testing',
  };
  onProgress?.({ status: roleStatusMap[role], message: `${role}: ${params.query}`, round: 0 });

  // Isolate spin state: save parent's counters, reset for this invocation,
  // and restore on exit so parent/subagent don't poison each other.
  const savedSpinState = { ...useContextStore.getState().fileReadSpinByPath };
  const savedSpinRanges = { ...useContextStore.getState().fileReadSpinRanges };
  useContextStore.getState().resetFileReadSpin();

  try {
    const loopCap = SUBAGENT_MAX_ROUNDS_BY_ROLE[role] ?? SUBAGENT_MAX_ROUNDS;
    for (let round = 0; round < loopCap; round++) {
      totalRounds++;

      const apiMessages = buildProviderMessages(
        role, params.query, params.focus_files, params.focus_file_context,
        round, totalInputTokens, totalOutputTokens, tokenBudget, pinBudget,
        preExistingHashes, preExistingSources,
        lastBatchOutcome, lastErrors,
        lastAssistantContent, lastToolResults,
      );

      const result = await runSubagentRound(
        subagentProvider,
        apiKey,
        subagentModel,
        apiMessages,
        systemPrompt,
        `${streamId}-r${round}`,
        maxOutputTokens,
        streamOpts,
        baseUrl,
        vertexProjectId,
        vertexRegion,
      );

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      totalCacheRead += result.cacheReadTokens;
      totalCacheWrite += result.cacheWriteTokens;

      const costBreakdown = calculateCostBreakdown(
        subagentProvider,
        subagentModel,
        result.inputTokens,
        result.outputTokens,
        result.cacheReadTokens,
        result.cacheWriteTokens,
      );
      const roundCost = costBreakdown.totalCostCents;
      totalCostCents += roundCost;

      useCostStore.getState().recordUsage({
        provider: subagentProvider,
        model: subagentModel,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        costCents: roundCost,
        timestamp: new Date(),
      });

      // Round snapshot for telemetry
      const snapshot: RoundSnapshot = {
        round: totalRounds,
        timestamp: Date.now(),
        provider: subagentProvider,
        wmTokens: 0, bbTokens: 0, stagedTokens: 0, archivedTokens: 0,
        overheadTokens: 0, freeTokens: 0, maxTokens: 0,
        staticSystemTokens: 0, conversationHistoryTokens: 0,
        stagedBucketTokens: 0, workspaceContextTokens: 0,
        providerInputTokens: result.inputTokens,
        estimatedTotalPromptTokens: 0,
        cacheStablePrefixTokens: 0, cacheChurnTokens: 0,
        reliefAction: 'none',
        legacyHistoryTelemetryKnownWrong: false,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        costCents: roundCost,
        inputCostCents: costBreakdown.inputCostCents,
        outputCostCents: costBreakdown.outputCostCents,
        compressionSavings: 0, rollingSavings: 0, rolledRounds: 0,
        rollingSummaryTokens: 0, freedTokens: 0, cumulativeSaved: 0,
        toolCalls: totalToolCalls,
        manageOps: 0,
        hypotheticalNonBatchedCost: 0,
        actualCost: roundCost,
        isSubagentRound: true,
        subagentType: role,
        subagentModel,
        subagentProvider,
        subagentInvocationId: invocationId,
      };
      useRoundHistoryStore.getState().pushSnapshot(snapshot);

      // Check for empty round (no tools) — capture text before breaking
      if (result.pendingToolCalls.length === 0) {
        if (result.fullResponse.trim()) lastAssistantText = result.fullResponse.trim();
        const stop = checkStopConditions(
          role, round, totalInputTokens, totalOutputTokens,
          tokenBudget, pinBudget, preExistingHashes, preExistingSources,
          lastBatchOutcome, true,
        );
        console.log(`[subagent:${role}] No tool calls, stopping: ${stop.reason || 'model completed'}`);
        break;
      }

      // Execute tool calls with role-based allowlist
      const toolResults: Array<{ type: string; tool_use_id: string; name: string; content: string }> = [];
      for (const tc of result.pendingToolCalls) {
        totalToolCalls++;

        const batchArgs = tc.args as Record<string, unknown>;
        const rawSteps = (Array.isArray(batchArgs.steps) ? batchArgs.steps : []) as Array<Record<string, unknown>>;
        const firstStep = rawSteps[0] || {};
        const toolName = String(firstStep.use || tc.name);
        const toolParams = (firstStep.with as Record<string, unknown>) || {};

        // Role-aware progress (round is the loop variable in scope)
        let progressMsg = toolName;
        if (toolName.startsWith('search.')) {
          progressMsg = `Searching: ${(toolParams.queries as string[])?.join(', ') || toolParams.query || '...'}`;
          onProgress?.({ status: 'searching', message: progressMsg, toolName, round });
        } else if (toolName.startsWith('read.')) {
          const paths = (toolParams.file_paths as string[]) || [];
          progressMsg = `Reading: ${paths[0] || '...'}`;
          onProgress?.({ status: 'reading', message: progressMsg, toolName, round, filePath: paths[0] });
        } else if (toolName === 'session.pin' || toolName === 'session.stage' || toolName === 'session.bb.write') {
          progressMsg = 'Pinning findings...';
          onProgress?.({ status: 'pinning', message: progressMsg, toolName, round });
        } else if (toolName.startsWith('change.')) {
          progressMsg = `Editing: ${(toolParams.file as string) || '...'}`;
          onProgress?.({ status: 'implementing', message: progressMsg, toolName, round });
        } else if (toolName.startsWith('verify.')) {
          progressMsg = `Verifying: ${toolName}`;
          onProgress?.({ status: 'testing', message: progressMsg, toolName, round });
        }

        if (toolTrace.length < TOOL_TRACE_CAP) {
          toolTrace.push({ toolName, message: progressMsg, round, ts: Date.now(), done: false });
        }

        try {
          const toolResult = await executeSubagentToolCall(
            role, tc.name, tc.args,
            {
              ...(terminalId ? { swarmTerminalId: terminalId } : {}),
              ...(params.fileClaims?.length ? { fileClaims: params.fileClaims } : {}),
            },
          );
          console.log(`[subagent:${role}] Tool ${toolName} result: ${toolResult.length} chars`);
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, name: tc.name, content: toolResult });
          if (toolTrace.length < TOOL_TRACE_CAP) {
            toolTrace.push({ toolName, message: `Done: ${toolName}`, round, ts: Date.now(), done: true });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[subagent:${role}] Tool ${toolName} error:`, msg);
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, name: tc.name, content: `Error: ${msg}` });
          lastErrors.push(`${toolName}: ${msg}`);
          if (toolTrace.length < TOOL_TRACE_CAP) {
            toolTrace.push({ toolName, message: `Error: ${msg.slice(0, 100)}`, round, ts: Date.now(), done: true });
          }
        }
      }

      // Save last exchange for next round's snapshot rebuild
      const assistantContent: unknown[] = [];
      const mergedText = mergeReasoningAndText(result.reasoningContent, result.fullResponse);
      if (mergedText) {
        assistantContent.push({ type: 'text', text: mergedText });
      }
      for (const tc of result.pendingToolCalls) {
        assistantContent.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.args,
        });
      }

      // Stub batch tool_use inputs in the assistant content so the next round
      // doesn't carry full step arrays (the results are the canonical record).
      // Shape matches stubBatchToolUseInputs in historyCompressor.ts: drop
      // `version` so the stub doesn't look like a legal batch envelope the
      // model could echo back; `_compressed: true` is the sentinel the runtime
      // guard rejects if it ever reaches executeUnifiedBatch.
      for (const block of assistantContent) {
        const b = block as { type?: string; input?: Record<string, unknown> };
        if (b.type === 'tool_use' && b.input && Array.isArray(b.input.steps)) {
          const steps = b.input.steps as Array<Record<string, unknown>>;
          b.input = {
            _stubbed: formatBatchToolUseStubSummary(steps),
            _compressed: true,
          } as any;
        }
      }

      lastAssistantContent = assistantContent;
      if (result.fullResponse.trim()) lastAssistantText = result.fullResponse.trim();
      lastToolResults = toolResults;
      lastBatchOutcome = toolResults.map(tr => tr.content).join('\n').slice(0, 2000);
      lastErrors = toolResults
        .filter(tr => tr.content.startsWith('Error:'))
        .map(tr => tr.content.slice(0, 200));

      // Compress tool results for next round: if total exceeds threshold,
      // truncate each result to keep the subagent's context lean. The
      // subagent has already pinned/staged what it needs from this round.
      const SUBAGENT_TOOL_RESULT_COMPRESS_THRESHOLD = 4000;
      const SUBAGENT_TOOL_RESULT_TRUNCATE_LEN = 500;
      const totalResultTokens = lastToolResults.reduce(
        (sum, tr) => sum + countTokensSync(tr.content), 0,
      );
      if (totalResultTokens > SUBAGENT_TOOL_RESULT_COMPRESS_THRESHOLD) {
        for (const tr of lastToolResults) {
          if (tr.content.length > SUBAGENT_TOOL_RESULT_TRUNCATE_LEN) {
            tr.content = tr.content.slice(0, SUBAGENT_TOOL_RESULT_TRUNCATE_LEN) + '... [truncated — pinned content is in engrams]';
          }
        }
      }

      // Enforce BB write discipline: if round > 0 and no BB write occurred,
      // inject a warning so the subagent knows it's violating the contract.
      if (round > 0) {
        const hadBbWrite = toolResults.some(tr =>
          tr.content.includes('session.bb.write') || tr.content.includes('bb_write:'),
        );
        if (!hadBbWrite) {
          const bbKey = ROLE_BB_KEYS[role];
          lastErrors.push(`WARNING: No BB write this round. You MUST write findings to bw key:"${bbKey}" every round. Partial findings are better than none.`);
        }
      }

      // Check stop conditions
      const stop = checkStopConditions(
        role, round, totalInputTokens, totalOutputTokens,
        tokenBudget, pinBudget, preExistingHashes, preExistingSources,
        lastBatchOutcome, false,
      );
      if (stop.shouldStop) {
        console.log(`[subagent:${role}] Stopping: ${stop.reason}`);
        break;
      }
    }
  } catch (error) {
    onProgress?.({
      status: 'error',
      message: `${role} subagent error: ${error instanceof Error ? error.message : String(error)}`,
      round: totalRounds,
      done: true,
    });
    throw error;
  } finally {
    // Restore parent's spin state so subagent reads don't leak back
    useContextStore.setState({ fileReadSpinByPath: savedSpinState, fileReadSpinRanges: savedSpinRanges });

    // G37: dematerialize/unstage in finally so cleanup happens even on error
    try {
      dematerializeSubagentChunks(preExistingHashes, preExistingSources);
      const stagedRefKeysForCleanup = new Set(
        extractSubagentRefs(preExistingHashes, preExistingSources)
          .filter(r => r.type === 'staged').map(r => r.hash),
      );
      unstageSubagentAdded(preExistingStagedKeys, stagedRefKeysForCleanup);
    } catch (cleanupErr) {
      console.warn(`[subagent:${role}] Cleanup error (dematerialize/unstage):`, cleanupErr);
    }

    // Clean up terminal
    if (terminalId) {
      try {
        const { getTerminalStore } = await import('../stores/terminalStore');
        getTerminalStore().closeTerminal(terminalId);
        console.log(`[subagent:${role}] Closed terminal: ${terminalId}`);
      } catch { /* best effort */ }
    }
  }

  // Extract engram refs (dematerialization already happened in finally, but
  // extraction reads pinned state which is preserved)
  const refs = extractSubagentRefs(preExistingHashes, preExistingSources);
  const pinCount = refs.filter(r => r.pinned || r.type === 'staged').length;
  const pinTokens = refs.reduce((sum, r) => sum + r.tokens, 0);

  console.log(`[subagent:${role}] Extraction: ${refs.length} refs, ${pinCount} pinned, ${(pinTokens / 1000).toFixed(1)}k tokens`);

  // Collect all BB keys written by this subagent (scan role prefixes, not just canonical key)
  const bbKeys: string[] = [];
  const rolePrefixes = ROLE_BB_PREFIXES[role] ?? [];
  const bbEntries = useContextStore.getState().blackboardEntries;
  if (bbEntries) {
    for (const key of bbEntries.keys()) {
      if (rolePrefixes.some(p => key.startsWith(p))) {
        bbKeys.push(key);
      }
    }
  }

  const summary = `${role}: ${refs.length} refs (${(pinTokens / 1000).toFixed(1)}k tk), ${totalRounds} rounds, ${totalToolCalls} tool calls`;

  onProgress?.({
    status: 'complete',
    message: summary,
    round: totalRounds,
    done: true,
    pinCount,
    pinTokens,
  });

  // Record usage
  const subAgentUsage: SubAgentUsage = {
    invocationId,
    type: role,
    provider: subagentProvider,
    model: subagentModel,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheRead,
    cacheWriteTokens: totalCacheWrite,
    costCents: totalCostCents,
    rounds: totalRounds,
    toolCalls: totalToolCalls,
    pinTokens,
    timestamp: new Date(),
  };
  useCostStore.getState().recordSubAgentUsage(subAgentUsage);

  return {
    refs,
    bbKeys,
    summary,
    finalText: lastAssistantText ?? undefined,
    pinCount,
    pinTokens,
    costCents: totalCostCents,
    rounds: totalRounds,
    toolCalls: totalToolCalls,
    invocationId,
    toolTrace,
  };
}

// Legacy entry points — delegate to unified executor
export async function executeRetriever(
  params: Omit<SubAgentParams, 'type'> & { type?: 'retriever' },
  onProgress?: SubAgentProgressCallback,
): Promise<SubAgentResult> {
  return executeSubagent({ ...params, type: 'retriever' }, onProgress);
}

export async function executeDesign(
  params: Omit<SubAgentParams, 'type'> & { type?: 'design' },
  onProgress?: SubAgentProgressCallback,
): Promise<SubAgentResult> {
  return executeSubagent({ ...params, type: 'design' }, onProgress);
}

export async function executeCoder(
  params: Omit<SubAgentParams, 'type'> & { type?: 'coder' },
  onProgress?: SubAgentProgressCallback,
): Promise<SubAgentResult> {
  return executeSubagent({ ...params, type: 'coder' }, onProgress);
}

export async function executeTester(
  params: Omit<SubAgentParams, 'type'> & { type?: 'tester' },
  onProgress?: SubAgentProgressCallback,
): Promise<SubAgentResult> {
  return executeSubagent({ ...params, type: 'tester' }, onProgress);
}

// ============================================================================
// Helpers
// ============================================================================

function getApiKeyForProvider(provider: AIProvider, settings: Record<string, unknown>): string | undefined {
  switch (provider) {
    case 'anthropic': return settings.anthropicApiKey as string || undefined;
    case 'openai': return settings.openaiApiKey as string || undefined;
    case 'google': return settings.googleApiKey as string || undefined;
    case 'vertex': return settings.vertexAccessToken as string || undefined;
    case 'lmstudio': return settings.lmstudioBaseUrl as string || 'http://localhost:1234';
    default: return undefined;
  }
}

/** Default cheap model per provider */
export function getDefaultSubagentModel(provider: AIProvider): string {
  switch (provider) {
    case 'anthropic': return 'claude-haiku-4-5';
    case 'openai': return 'gpt-4o-mini';
    case 'google': return 'gemini-2.0-flash';
    case 'vertex': return 'gemini-2.0-flash';
    case 'lmstudio': return 'default';
    default: return 'claude-haiku-4-5';
  }
}
