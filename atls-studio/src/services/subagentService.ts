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
import { useCostStore, calculateCost } from '../stores/costStore';
import { useRoundHistoryStore, type RoundSnapshot } from '../stores/roundHistoryStore';
import { countTokensSync } from '../utils/tokenCounter';
import { buildSubagentPrompt, type SubagentRole } from '../prompts/subagentPrompts';
import { coerceBatchSteps } from './batch/coerceBatchSteps';
import { expandBatchQ } from '../utils/toon';
import { dematerialize, getRef } from './hashProtocol';
import {
  SUBAGENT_MAX_ROUNDS,
  SUBAGENT_TOKEN_BUDGET_DEFAULT,
  SUBAGENT_TOKEN_BUDGET_BY_ROLE,
  SUBAGENT_MAX_OUTPUT_TOKENS_BY_ROLE,
  SUBAGENT_PIN_BUDGET_CAP,
  SUBAGENT_STAGED_PATHS_CAP,
} from './promptMemory';

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
  max_tokens?: number;
  token_budget?: number;
}

export interface SubAgentRef {
  hash: string;
  shortHash: string;
  source: string;
  lines?: string;
  tokens: number;
  digest?: string;
  pinned: boolean;
  type: string;
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

async function runSubagentRound(
  provider: AIProvider,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt: string,
  streamId: string,
  maxOutputTokens: number,
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
        case 'usage':
          inputTokens = chunk.input_tokens ?? 0;
          outputTokens = chunk.output_tokens ?? 0;
          cacheReadTokens = chunk.cache_read_input_tokens ?? chunk.cached_content_tokens ?? 0;
          cacheWriteTokens = chunk.cache_creation_input_tokens ?? 0;
          break;
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
    await invoke('stream_chat_anthropic', { ...commonParams, apiKey });
  } else if (provider === 'openai') {
    await invoke('stream_chat_openai', { ...commonParams, apiKey });
  } else if (provider === 'vertex') {
    await invoke('stream_chat_vertex', {
      ...commonParams,
      accessToken: apiKey,
      projectId: projectId || '',
      region: region || null,
      cachedContent: null,
      dynamicContext: null,
    });
  } else if (provider === 'google') {
    await invoke('stream_chat_google', { ...commonParams, apiKey, cachedContent: null, dynamicContext: null });
  } else if (provider === 'lmstudio') {
    await invoke('stream_chat_lmstudio', { ...commonParams, baseUrl: baseUrl || 'http://localhost:1234' });
  } else {
    throw new Error(`Subagent streaming not supported for provider: ${provider}`);
  }

  await donePromise;

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
  options?: { swarmTerminalId?: string },
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

  if (metrics.engramLines.length > 0) {
    sections.push('\n## ENGRAMS CREATED');
    sections.push(metrics.engramLines.join('\n'));
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

  // Only show pre-existing staged paths (new ones are already in ENGRAMS CREATED)
  const stagedPaths = Array.from(ctx.stagedSnippets.values())
    .filter(s => s.source && canSteerExecution({ stageState: s.stageState, freshness: s.freshness }))
    .map(s => s.source!)
    .filter(src => src && !metrics.newStagedSources.has(src));
  if (stagedPaths.length > 0) {
    const shown = stagedPaths.slice(0, SUBAGENT_STAGED_PATHS_CAP);
    const overflow = stagedPaths.length - shown.length;
    sections.push('\n## ALREADY STAGED (do not re-read)');
    sections.push(shown.join(', ') + (overflow > 0 ? ` ... and ${overflow} more` : ''));
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
 */
function dematerializeSubagentChunks(
  preExistingHashes: Set<string>,
  preExistingSources: Set<string>,
): void {
  const ctx = useContextStore.getState();
  const toDematerialize: string[] = [];

  for (const [hash, chunk] of ctx.chunks.entries()) {
    if (preExistingHashes.has(hash)) continue;
    if (chunk.pinned) continue;
    if (preExistingSources.has(chunk.source || '')) continue;
    const ref = getRef(hash);
    if (ref && ref.visibility === 'materialized') {
      toDematerialize.push(hash);
    }
  }

  for (const hash of toDematerialize) {
    dematerialize(hash);
  }

  if (toDematerialize.length > 0) {
    ctx.compactDormantChunks();
    console.log(`[subagent] Dematerialized ${toDematerialize.length} chunks, compacted dormant`);
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
  hasSpinBreaker?: boolean,
  consecutiveReadOnlyRounds?: number,
): StopCheck {
  // Safety ceiling
  if (round >= SUBAGENT_MAX_ROUNDS) {
    return { shouldStop: true, reason: 'max rounds reached' };
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

  // Read spin detected — batch executor flagged repeated reads of the same files
  if (hasSpinBreaker) {
    return { shouldStop: true, reason: 'read spin detected — subagent reading same files repeatedly without acting' };
  }

  // Consecutive idle rounds — subagent is not making progress.
  // Only pure read/search rounds with no pins, stages, BB writes, verify,
  // or exec count as idle. The limit is generous because legitimate research
  // involves many search-then-read cycles before the first actionable step.
  if (consecutiveReadOnlyRounds != null) {
    const limit = (role === 'retriever' || role === 'design') ? 8 : 10;
    if (consecutiveReadOnlyRounds >= limit) {
      return { shouldStop: true, reason: `${consecutiveReadOnlyRounds} consecutive idle rounds without progress` };
    }
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
    messages.push({ role: 'user', content: query + (focusFiles?.length ? `\nFocus files: ${focusFiles.join(', ')}` : '') });
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

  // Build system prompt
  const bbKey = ROLE_BB_KEYS[role];
  const systemPrompt = buildSubagentPrompt(role as SubagentRole, {
    pinBudget,
    focusFiles: params.focus_files?.join(', ') || 'none',
    alreadyStaged: 'See ## ALREADY STAGED in working state',
    bbKey,
  });

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
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalToolCalls = 0;
  let totalRounds = 0;
  let totalCostCents = 0;

  let lastAssistantContent: unknown[] | null = null;
  let lastAssistantText: string | null = null;
  let lastToolResults: Array<{ type: string; tool_use_id: string; name: string; content: string }> | null = null;
  let lastBatchOutcome: string | null = null;
  let lastErrors: string[] = [];
  let consecutiveReadOnlyRounds = 0;

  const roleStatusMap: Record<SubagentType, SubAgentProgress['status']> = {
    retriever: 'searching',
    design: 'searching',
    coder: 'implementing',
    tester: 'testing',
  };
  onProgress?.({ status: roleStatusMap[role], message: `${role}: ${params.query}` });

  // Isolate spin state: save parent's counters, reset for this invocation,
  // and restore on exit so parent/subagent don't poison each other.
  const savedSpinState = { ...useContextStore.getState().fileReadSpinByPath };
  const savedSpinRanges = { ...useContextStore.getState().fileReadSpinRanges };
  useContextStore.getState().resetFileReadSpin();

  try {
    for (let round = 0; round < SUBAGENT_MAX_ROUNDS; round++) {
      totalRounds++;

      const apiMessages = buildProviderMessages(
        role, params.query, params.focus_files, round,
        totalInputTokens, totalOutputTokens, tokenBudget, pinBudget,
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
        baseUrl,
        vertexProjectId,
        vertexRegion,
      );

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      totalCacheRead += result.cacheReadTokens;
      totalCacheWrite += result.cacheWriteTokens;

      const roundCost = calculateCost(
        subagentProvider,
        subagentModel,
        result.inputTokens,
        result.outputTokens,
        result.cacheReadTokens,
        result.cacheWriteTokens,
      );
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
        compressionSavings: 0, rollingSavings: 0, rolledRounds: 0,
        rollingSummaryTokens: 0, freedTokens: 0, cumulativeSaved: 0,
        toolCalls: totalToolCalls,
        manageOps: 0,
        hypotheticalNonBatchedCost: 0,
        actualCost: totalCostCents,
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
          lastBatchOutcome, true, false, consecutiveReadOnlyRounds,
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

        // Role-aware progress
        if (toolName.startsWith('search.')) {
          onProgress?.({
            status: 'searching',
            message: `Searching: ${(toolParams.queries as string[])?.join(', ') || toolParams.query || '...'}`,
            toolName,
          });
        } else if (toolName.startsWith('read.')) {
          const paths = (toolParams.file_paths as string[]) || [];
          onProgress?.({
            status: 'reading',
            message: `Reading: ${paths[0] || '...'}`,
            toolName,
            filePath: paths[0],
          });
        } else if (toolName === 'session.pin' || toolName === 'session.stage' || toolName === 'session.bb.write') {
          onProgress?.({ status: 'pinning', message: 'Pinning findings...', toolName });
        } else if (toolName.startsWith('change.')) {
          onProgress?.({ status: 'implementing', message: `Editing: ${(toolParams.file as string) || '...'}`, toolName });
        } else if (toolName.startsWith('verify.')) {
          onProgress?.({ status: 'testing', message: `Verifying: ${toolName}`, toolName });
        }

        try {
          const toolResult = await executeSubagentToolCall(
            role, tc.name, tc.args,
            terminalId ? { swarmTerminalId: terminalId } : undefined,
          );
          console.log(`[subagent:${role}] Tool ${toolName} result: ${toolResult.length} chars`);
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, name: tc.name, content: toolResult });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[subagent:${role}] Tool ${toolName} error:`, msg);
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, name: tc.name, content: `Error: ${msg}` });
          lastErrors.push(`${toolName}: ${msg}`);
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

      lastAssistantContent = assistantContent;
      if (result.fullResponse.trim()) lastAssistantText = result.fullResponse.trim();
      lastToolResults = toolResults;
      lastBatchOutcome = toolResults.map(tr => tr.content).join('\n').slice(0, 2000);
      lastErrors = toolResults
        .filter(tr => tr.content.startsWith('Error:'))
        .map(tr => tr.content.slice(0, 200));

      // Track consecutive idle rounds for spin detection.
      // Any substantive work (edits, pins, stages, BB writes, verify, exec)
      // resets the counter — not just change.* mutations.
      const batchText = lastBatchOutcome ?? '';
      const hadProgress = toolResults.some(tr => {
        const c = tr.content;
        if (c.includes('ERROR') || c.includes('BLOCKED')) return false;
        return c.includes('change.') || c.includes('session.pin') || c.includes('session.stage')
          || c.includes('session.bb.write') || c.includes('verify.') || c.includes('system.exec');
      }) || (batchText.includes('[OK]') && (
        batchText.includes('session.pin') || batchText.includes('session.bb.write')
        || batchText.includes('verify.') || batchText.includes('system.exec')
      ));
      if (hadProgress) {
        consecutiveReadOnlyRounds = 0;
      } else {
        consecutiveReadOnlyRounds++;
      }

      const hasSpinBreaker = lastBatchOutcome?.includes('<<STOP:') ?? false;

      // Check stop conditions
      const stop = checkStopConditions(
        role, round, totalInputTokens, totalOutputTokens,
        tokenBudget, pinBudget, preExistingHashes, preExistingSources,
        lastBatchOutcome, false, hasSpinBreaker, consecutiveReadOnlyRounds,
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
    });
    throw error;
  } finally {
    // Restore parent's spin state so subagent reads don't leak back
    useContextStore.setState({ fileReadSpinByPath: savedSpinState, fileReadSpinRanges: savedSpinRanges });

    // Clean up terminal
    if (terminalId) {
      try {
        const { getTerminalStore } = await import('../stores/terminalStore');
        getTerminalStore().closeTerminal(terminalId);
        console.log(`[subagent:${role}] Closed terminal: ${terminalId}`);
      } catch { /* best effort */ }
    }
  }

  // Extract engram refs BEFORE dematerializing (needs full chunk data)
  const refs = extractSubagentRefs(preExistingHashes, preExistingSources);
  const pinCount = refs.filter(r => r.pinned || r.type === 'staged').length;
  const pinTokens = refs.reduce((sum, r) => sum + r.tokens, 0);

  console.log(`[subagent:${role}] Extraction: ${refs.length} refs, ${pinCount} pinned, ${(pinTokens / 1000).toFixed(1)}k tokens`);

  // Dematerialize subagent-created chunks so the parent model doesn't see full
  // file bodies in its next prompt. Without this, every chunk the subagent read
  // stays materialized (seenAtTurn === global turn) and gets emitted as full
  // content in formatWorkingMemory, inflating the parent's context by megabytes.
  // Pinned chunks are left alone — HPP exempts them from shouldMaterialize checks
  // and the parent will see them as compact ref lines.
  dematerializeSubagentChunks(preExistingHashes, preExistingSources);
  const stagedRefKeys = new Set(refs.filter(r => r.type === 'staged').map(r => r.hash));
  unstageSubagentAdded(preExistingStagedKeys, stagedRefKeys);

  // Collect BB keys written by this subagent
  const bbKeys: string[] = [];
  const roleBbKey = ROLE_BB_KEYS[role];
  if (useContextStore.getState().getBlackboardEntry(roleBbKey)) {
    bbKeys.push(roleBbKey);
  }

  const summary = `${role}: ${refs.length} refs (${(pinTokens / 1000).toFixed(1)}k tk), ${totalRounds} rounds, ${totalToolCalls} tool calls`;

  onProgress?.({
    status: 'complete',
    message: summary,
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
