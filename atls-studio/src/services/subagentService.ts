/**
 * SubAgent Service
 *
 * Dispatches lightweight subagents (e.g. retriever) on cheap models to search/read
 * code and pin relevant content. Returns raw code blocks to the calling model.
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
import { estimateTokens } from '../utils/contextHash';
import { RETRIEVER_SUBAGENT_PROMPT_V2, DESIGN_SUBAGENT_PROMPT_V2 } from '../prompts/subagentPrompts';
import { coerceBatchSteps } from './batch/coerceBatchSteps';

// Re-export for consumers
export type { AIProvider };

// ============================================================================
// Types
// ============================================================================

export interface SubAgentParams {
  type: 'retriever' | 'design';
  query: string;
  focus_files?: string[];
  max_tokens?: number;
}

export interface SubAgentResult {
  content: string;
  pinCount: number;
  pinTokens: number;
  costCents: number;
  rounds: number;
  toolCalls: number;
  invocationId: string;
}

export interface SubAgentUsage {
  invocationId: string;
  type: 'retriever' | 'design';
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

/** Progress updates streamed to the UI during subagent execution */
export interface SubAgentProgress {
  status: 'searching' | 'reading' | 'pinning' | 'complete' | 'error';
  message: string;
  toolName?: string;
  filePath?: string;
  pinCount?: number;
  pinTokens?: number;
}

export type SubAgentProgressCallback = (progress: SubAgentProgress) => void;

const RETRIEVER_MAX_ROUNDS = 12;
const DESIGN_MAX_ROUNDS = 12;

const RETRIEVER_ALLOWED_TOOLS = new Set(['batch']);
const DESIGN_ALLOWED_TOOLS = new Set(['batch']);
const RETRIEVER_ALLOWED_OPS = new Set([
  'search.code',
  'search.symbol',
  'read.context',
  'session.pin',
  'session.stage',
  'intent.understand',
  'intent.investigate',
  'intent.survey',
]);

const DESIGN_ALLOWED_OPS = new Set([
  ...RETRIEVER_ALLOWED_OPS,
  'session.bb.write',
  'intent.diagnose',
  'intent.test',
]);

// ============================================================================
// Budget Calculation
// ============================================================================

function computePinBudget(
  contextUsage: ContextUsage,
  maxTokensOverride?: number,
): number {
  if (maxTokensOverride && maxTokensOverride > 0) {
    return maxTokensOverride;
  }
  const remaining = Math.max(0, contextUsage.maxTokens - contextUsage.totalTokens);
  // Reserve 60% for the main model's reasoning + output
  return Math.floor(remaining * 0.4);
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
  baseUrl?: string,
  projectId?: string,
  region?: string,
): Promise<{
  fullResponse: string;
  pendingToolCalls: PendingToolCall[];
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}> {
  let fullResponse = '';
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
    maxTokens: 4096,
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
  return { fullResponse, pendingToolCalls, stopReason, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

// ============================================================================
// Tool Execution (with allowlist enforcement)
// ============================================================================

async function executeRetrieverToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!RETRIEVER_ALLOWED_TOOLS.has(name)) {
    return `Error: Tool '${name}' is not allowed for retriever subagent. Allowed: ${[...RETRIEVER_ALLOWED_TOOLS].join(', ')}`;
  }

  args.steps = coerceBatchSteps(args.steps);
  const steps = args.steps as Array<Record<string, unknown>>;
  if (steps.length === 0) {
    return 'Error: retriever subagent requires batch steps';
  }
  const disallowed = steps.filter(step => !RETRIEVER_ALLOWED_OPS.has(String(step.use)));
  if (disallowed.length > 0) {
    return `Error: batch ops not allowed for retriever: ${disallowed.map(step => step.use).join(', ')}`;
  }

  const { executeToolCall } = await import('./aiService');
  return executeToolCall(name, args);
}

async function executeDesignToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!DESIGN_ALLOWED_TOOLS.has(name)) {
    return `Error: Tool '${name}' is not allowed for design subagent. Allowed: ${[...DESIGN_ALLOWED_TOOLS].join(', ')}`;
  }

  args.steps = coerceBatchSteps(args.steps);
  const steps = args.steps as Array<Record<string, unknown>>;
  if (steps.length === 0) {
    return 'Error: design subagent requires batch steps';
  }
  const disallowed = steps.filter(step => !DESIGN_ALLOWED_OPS.has(String(step.use)));
  if (disallowed.length > 0) {
    return `Error: batch ops not allowed for design: ${disallowed.map(step => step.use).join(', ')}`;
  }

  const { executeToolCall } = await import('./aiService');
  return executeToolCall(name, args);
}

// ============================================================================
// Content Extraction
// ============================================================================

interface PinnedBlock {
  path: string;
  lines: string;
  content: string;
  tokens: number;
}

function extractPinnedContent(preExistingHashes: Set<string>, preExistingSources?: Set<string>): PinnedBlock[] {
  const ctx = useContextStore.getState();
  const blocks: PinnedBlock[] = [];

  // Priority 1: staged snippets (most precise — specific line ranges)
  for (const snippet of ctx.stagedSnippets.values()) {
    if (snippet.content) {
      if (!canSteerExecution({ stageState: snippet.stageState, freshness: snippet.freshness })) continue;
      if (preExistingSources && snippet.source && preExistingSources.has(snippet.source)) continue;
      blocks.push({
        path: snippet.source || 'unknown',
        lines: snippet.lines || '',
        content: snippet.content,
        tokens: estimateTokens(snippet.content),
      });
    }
  }

  // Priority 2: pinned chunks in working memory
  for (const chunk of ctx.chunks.values()) {
    if (chunk.pinned && chunk.content) {
      if (chunk.suspectSince != null || chunk.freshness === 'suspect' || chunk.freshness === 'changed') continue;
      if (preExistingSources && chunk.source && preExistingSources.has(chunk.source)) continue;
      const alreadyStaged = blocks.some(b => b.path === chunk.source);
      if (!alreadyStaged) {
        blocks.push({
          path: chunk.source || 'unknown',
          lines: '',
          content: chunk.content,
          tokens: estimateTokens(chunk.content),
        });
      }
    }
  }

  // Fallback: if model didn't pin/stage, grab chunks added during subagent execution
  // (context reads and search results that the subagent loaded)
  if (blocks.length === 0) {
    for (const [hash, chunk] of ctx.chunks.entries()) {
      if (!preExistingHashes.has(hash) && chunk.content && chunk.type !== 'msg:user' && chunk.type !== 'msg:asst') {
        blocks.push({
          path: chunk.source || 'unknown',
          lines: '',
          content: chunk.content,
          tokens: estimateTokens(chunk.content),
        });
      }
    }
    if (blocks.length > 0) {
      console.log(`[subagent] Fallback: extracted ${blocks.length} new chunks (model didn't pin/stage explicitly)`);
    }
  }

  return blocks;
}

function formatPinnedBlocks(blocks: PinnedBlock[], budget: number): { formatted: string; pinCount: number; pinTokens: number } {
  const parts: string[] = [];
  let totalTokens = 0;
  let pinCount = 0;

  for (const block of blocks) {
    if (totalTokens + block.tokens > budget && pinCount > 0) {
      break; // Budget exceeded, stop adding blocks (keep at least one)
    }
    const header = block.lines
      ? `--- ${block.path}:${block.lines} ---`
      : `--- ${block.path} ---`;
    parts.push(`${header}\n${block.content}\n--- end ---`);
    totalTokens += block.tokens;
    pinCount++;
  }

  return {
    formatted: parts.join('\n\n'),
    pinCount,
    pinTokens: totalTokens,
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function executeRetriever(
  params: SubAgentParams,
  onProgress?: SubAgentProgressCallback,
): Promise<SubAgentResult> {
  const invocationId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const appState = useAppStore.getState();
  const settings = appState.settings;

  // Resolve subagent model config (|| not ?? — empty string means "auto")
  const subagentProvider = (settings.subagentProvider || settings.selectedProvider) as AIProvider;
  const rawModel = settings.subagentModel;
  const subagentModel = (rawModel && rawModel !== 'none')
    ? rawModel
    : getDefaultSubagentModel(subagentProvider);

  console.log(`[subagent] Resolved: provider=${subagentProvider}, model=${subagentModel} (raw=${rawModel})`);

  // Resolve API key for the subagent's provider
  const apiKey = getApiKeyForProvider(subagentProvider, settings as unknown as Record<string, unknown>);
  if (!apiKey) {
    throw new Error(`No API key configured for subagent provider: ${subagentProvider}. Configure it in Settings.`);
  }

  const baseUrl = subagentProvider === 'lmstudio' ? settings.lmstudioBaseUrl : undefined;
  const vertexProjectId = subagentProvider === 'vertex' ? (settings.vertexProjectId as string) : undefined;
  const vertexRegion = subagentProvider === 'vertex' ? (settings.vertexRegion as string) : undefined;

  // Compute pin budget
  const contextUsage = appState.contextUsage;
  const pinBudget = computePinBudget(contextUsage, params.max_tokens);

  // Snapshot staged sources before subagent runs for dedup
  const ctxSnapshot = useContextStore.getState();
  const preExistingSources = new Set(
    Array.from(ctxSnapshot.stagedSnippets.values())
      .filter(s => canSteerExecution({ stageState: s.stageState, freshness: s.freshness }))
      .map(s => s.source).filter(Boolean) as string[]
  );
  const alreadyStagedStr = preExistingSources.size > 0
    ? Array.from(preExistingSources).join(', ')
    : 'none';

  // Build system prompt with budget info
  const systemPrompt = RETRIEVER_SUBAGENT_PROMPT_V2
    .replace('{{PIN_BUDGET}}', String(pinBudget))
    .replace('{{FOCUS_FILES}}', params.focus_files?.join(', ') || 'none')
    .replace('{{ALREADY_STAGED}}', alreadyStagedStr);

  // Build initial message
  const messages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: params.query },
  ];

  const streamId = `subagent-${invocationId}`;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalToolCalls = 0;
  let totalRounds = 0;
  let totalCostCents = 0;

  onProgress?.({ status: 'searching', message: `Searching: ${params.query}` });

  // Snapshot chunk hashes before subagent runs so we can identify new content
  const preExistingHashes = new Set(useContextStore.getState().chunks.keys());

  try {
    let apiMessages = [...messages];

    for (let round = 0; round < RETRIEVER_MAX_ROUNDS; round++) {
      totalRounds++;

      const result = await runSubagentRound(
        subagentProvider,
        apiKey,
        subagentModel,
        apiMessages,
        systemPrompt,
        `${streamId}-r${round}`,
        baseUrl,
        vertexProjectId,
        vertexRegion,
      );

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      totalCacheRead += result.cacheReadTokens;
      totalCacheWrite += result.cacheWriteTokens;

      // Record per-round cost
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

      // Push round snapshot tagged as subagent
      const snapshot: RoundSnapshot = {
        round: totalRounds,
        timestamp: Date.now(),
        wmTokens: 0,
        bbTokens: 0,
        stagedTokens: 0,
        archivedTokens: 0,
        overheadTokens: 0,
        freeTokens: 0,
        maxTokens: 0,
        staticSystemTokens: 0,
        conversationHistoryTokens: 0,
        stagedBucketTokens: 0,
        workspaceContextTokens: 0,
        providerInputTokens: result.inputTokens,
        estimatedTotalPromptTokens: 0,
        cacheStablePrefixTokens: 0,
        cacheChurnTokens: 0,
        reliefAction: 'none',
        legacyHistoryTelemetryKnownWrong: false,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        costCents: roundCost,
        compressionSavings: 0,
        rollingSavings: 0,
        rolledRounds: 0,
        rollingSummaryTokens: 0,
        freedTokens: 0,
        cumulativeSaved: 0,
        toolCalls: totalToolCalls,
        manageOps: 0,
        hypotheticalNonBatchedCost: 0,
        actualCost: totalCostCents,
        isSubagentRound: true,
        subagentType: 'retriever',
        subagentModel,
        subagentProvider,
        subagentInvocationId: invocationId,
      };
      useRoundHistoryStore.getState().pushSnapshot(snapshot);

      // No tool calls — retriever is done
      if (result.pendingToolCalls.length === 0) {
        break;
      }

      // Execute tool calls with allowlist enforcement
      const toolResults: Array<{ tool_use_id: string; name: string; content: string }> = [];
      for (const tc of result.pendingToolCalls) {
        totalToolCalls++;

        const batchArgs = tc.args as Record<string, unknown>;
        batchArgs.steps = coerceBatchSteps(batchArgs.steps);
        const steps = batchArgs.steps as Array<Record<string, unknown>>;
        const firstStep = steps[0] || {};
        const toolName = String(firstStep.use || tc.name);
        const toolParams = (firstStep.with as Record<string, unknown>) || {};

        if (toolName === 'search.code' || toolName === 'search.symbol') {
          onProgress?.({
            status: 'searching',
            message: `Searching: ${(toolParams.queries as string[])?.join(', ') || toolParams.query || '...'}`,
            toolName,
          });
        } else if (toolName === 'read.context') {
          const paths = (toolParams.file_paths as string[]) || [];
          onProgress?.({
            status: 'reading',
            message: `Reading: ${paths[0] || '...'}`,
            toolName,
            filePath: paths[0],
          });
        } else if (toolName === 'session.pin' || toolName === 'session.stage') {
          onProgress?.({ status: 'pinning', message: 'Pinning relevant code...', toolName });
        }

        try {
          const toolResult = await executeRetrieverToolCall(tc.name, tc.args);
          console.log(`[subagent] Tool ${toolName} result: ${toolResult.length} chars`);
          toolResults.push({ tool_use_id: tc.id, name: tc.name, content: toolResult });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[subagent] Tool ${toolName} error:`, msg);
          toolResults.push({ tool_use_id: tc.id, name: tc.name, content: `Error: ${msg}` });
        }
      }

      // Build follow-up messages for next round
      const assistantContent: unknown[] = [];
      if (result.fullResponse) {
        assistantContent.push({ type: 'text', text: result.fullResponse });
      }
      for (const tc of result.pendingToolCalls) {
        assistantContent.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.args,
        });
      }

      apiMessages = [
        ...apiMessages,
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: toolResults.map(tr => ({ type: 'tool_result', ...tr })) },
      ];

      // If stop reason was end_turn, done
      if (result.stopReason === 'end_turn' && result.pendingToolCalls.length === 0) {
        break;
      }
    }
  } catch (error) {
    onProgress?.({
      status: 'error',
      message: `Retriever error: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  }

  // Extract pinned content and format for the main model (dedup against pre-existing staged sources)
  const pinnedBlocks = extractPinnedContent(preExistingHashes, preExistingSources);
  console.log(`[subagent] Extraction: ${pinnedBlocks.length} blocks, budget=${pinBudget}, deduped ${preExistingSources.size} pre-staged sources`);
  if (pinnedBlocks.length > 0) {
    console.log(`[subagent] Blocks:`, pinnedBlocks.map(b => `${b.path}:${b.lines} (${b.tokens}tk)`));
  }
  const { formatted, pinCount, pinTokens } = formatPinnedBlocks(pinnedBlocks, pinBudget);

  onProgress?.({
    status: 'complete',
    message: `Found ${pinCount} relevant code blocks`,
    pinCount,
    pinTokens,
  });

  // Record aggregate subagent usage for UI breakdown
  const subAgentUsage: SubAgentUsage = {
    invocationId,
    type: 'retriever',
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
    content: formatted || 'No relevant code found for the query.',
    pinCount,
    pinTokens,
    costCents: totalCostCents,
    rounds: totalRounds,
    toolCalls: totalToolCalls,
    invocationId,
  };
}

// ============================================================================
// Design Subagent
// ============================================================================

export async function executeDesign(
  params: Omit<SubAgentParams, 'type'> & { type: 'design' },
  onProgress?: SubAgentProgressCallback,
): Promise<SubAgentResult> {
  const invocationId = `subagent-design-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const appState = useAppStore.getState();
  const settings = appState.settings;

  const subagentProvider = (settings.subagentProvider || settings.selectedProvider) as AIProvider;
  const rawModel = settings.subagentModel;
  const subagentModel = (rawModel && rawModel !== 'none')
    ? rawModel
    : getDefaultSubagentModel(subagentProvider);

  const apiKey = getApiKeyForProvider(subagentProvider, settings as unknown as Record<string, unknown>);
  if (!apiKey) {
    throw new Error(`No API key configured for subagent provider: ${subagentProvider}. Configure it in Settings.`);
  }

  const baseUrl = subagentProvider === 'lmstudio' ? settings.lmstudioBaseUrl : undefined;
  const designVertexProjectId = subagentProvider === 'vertex' ? (settings.vertexProjectId as string) : undefined;
  const designVertexRegion = subagentProvider === 'vertex' ? (settings.vertexRegion as string) : undefined;
  const contextUsage = appState.contextUsage;
  const pinBudget = computePinBudget(contextUsage, params.max_tokens);

  // Snapshot staged sources before subagent runs for dedup
  const designCtxSnapshot = useContextStore.getState();
  const designPreExistingSources = new Set(
    Array.from(designCtxSnapshot.stagedSnippets.values())
      .map(s => s.source).filter(Boolean) as string[]
  );
  const designAlreadyStagedStr = designPreExistingSources.size > 0
    ? Array.from(designPreExistingSources).join(', ')
    : 'none';

  const systemPrompt = DESIGN_SUBAGENT_PROMPT_V2
    .replace('{{PIN_BUDGET}}', String(pinBudget))
    .replace('{{FOCUS_FILES}}', params.focus_files?.join(', ') || 'none')
    .replace('{{ALREADY_STAGED}}', designAlreadyStagedStr);

  const messages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: params.query },
  ];

  const streamId = `subagent-${invocationId}`;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalToolCalls = 0;
  let totalRounds = 0;
  let totalCostCents = 0;

  onProgress?.({ status: 'searching', message: `Design research: ${params.query}` });

  const preExistingHashes = new Set(useContextStore.getState().chunks.keys());

  try {
    let apiMessages = [...messages];

    for (let round = 0; round < DESIGN_MAX_ROUNDS; round++) {
      totalRounds++;

      const result = await runSubagentRound(
        subagentProvider,
        apiKey,
        subagentModel,
        apiMessages,
        systemPrompt,
        `${streamId}-r${round}`,
        baseUrl,
        designVertexProjectId,
        designVertexRegion,
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

      const snapshot: RoundSnapshot = {
        round: totalRounds,
        timestamp: Date.now(),
        wmTokens: 0,
        bbTokens: 0,
        stagedTokens: 0,
        archivedTokens: 0,
        overheadTokens: 0,
        freeTokens: 0,
        maxTokens: 0,
        staticSystemTokens: 0,
        conversationHistoryTokens: 0,
        stagedBucketTokens: 0,
        workspaceContextTokens: 0,
        providerInputTokens: result.inputTokens,
        estimatedTotalPromptTokens: 0,
        cacheStablePrefixTokens: 0,
        cacheChurnTokens: 0,
        reliefAction: 'none',
        legacyHistoryTelemetryKnownWrong: false,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        costCents: roundCost,
        compressionSavings: 0,
        rollingSavings: 0,
        rolledRounds: 0,
        rollingSummaryTokens: 0,
        freedTokens: 0,
        cumulativeSaved: 0,
        toolCalls: totalToolCalls,
        manageOps: 0,
        hypotheticalNonBatchedCost: 0,
        actualCost: totalCostCents,
        isSubagentRound: true,
        subagentType: 'design',
        subagentModel,
        subagentProvider,
        subagentInvocationId: invocationId,
      };
      useRoundHistoryStore.getState().pushSnapshot(snapshot);

      if (result.pendingToolCalls.length === 0) {
        break;
      }

      const toolResults: Array<{ tool_use_id: string; name: string; content: string }> = [];
      for (const tc of result.pendingToolCalls) {
        totalToolCalls++;

        const batchArgs = tc.args as Record<string, unknown>;
        batchArgs.steps = coerceBatchSteps(batchArgs.steps);
        const steps = batchArgs.steps as Array<Record<string, unknown>>;
        const firstStep = steps[0] || {};
        const toolName = String(firstStep.use || tc.name);
        const toolParams = (firstStep.with as Record<string, unknown>) || {};

        if (toolName === 'search.code' || toolName === 'search.symbol') {
          onProgress?.({
            status: 'searching',
            message: `Searching: ${(toolParams.queries as string[])?.join(', ') || toolParams.query || '...'}`,
            toolName,
          });
        } else if (toolName === 'read.context') {
          const paths = (toolParams.file_paths as string[]) || [];
          onProgress?.({
            status: 'reading',
            message: `Reading: ${paths[0] || '...'}`,
            toolName,
            filePath: paths[0],
          });
        } else if (toolName === 'session.pin' || toolName === 'session.stage' || toolName === 'session.bb.write') {
          onProgress?.({ status: 'pinning', message: 'Pinning findings...', toolName });
        }

        try {
          const toolResult = await executeDesignToolCall(tc.name, tc.args);
          console.log(`[subagent] Design tool ${toolName} result: ${toolResult.length} chars`);
          toolResults.push({ tool_use_id: tc.id, name: tc.name, content: toolResult });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[subagent] Design tool ${toolName} error:`, msg);
          toolResults.push({ tool_use_id: tc.id, name: tc.name, content: `Error: ${msg}` });
        }
      }

      const assistantContent: unknown[] = [];
      if (result.fullResponse) {
        assistantContent.push({ type: 'text', text: result.fullResponse });
      }
      for (const tc of result.pendingToolCalls) {
        assistantContent.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.args,
        });
      }

      apiMessages = [
        ...apiMessages,
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: toolResults.map(tr => ({ type: 'tool_result', ...tr })) },
      ];

      if (result.stopReason === 'end_turn' && result.pendingToolCalls.length === 0) {
        break;
      }
    }
  } catch (error) {
    onProgress?.({
      status: 'error',
      message: `Design subagent error: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  }

  const pinnedBlocks = extractPinnedContent(preExistingHashes, designPreExistingSources);
  const { formatted, pinCount, pinTokens } = formatPinnedBlocks(pinnedBlocks, pinBudget);

  const bbDesign = useContextStore.getState().getBlackboardEntry('design:research');
  const designSummary = bbDesign
    ? `## Design Research (h:bb:design:research)\n${bbDesign}\n\n`
    : '';
  const content = designSummary + (formatted || 'No relevant code found for the planning query.');

  onProgress?.({
    status: 'complete',
    message: `Design research complete: ${pinCount} blocks`,
    pinCount,
    pinTokens,
  });

  const subAgentUsage: SubAgentUsage = {
    invocationId,
    type: 'design',
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
    content,
    pinCount,
    pinTokens,
    costCents: totalCostCents,
    rounds: totalRounds,
    toolCalls: totalToolCalls,
    invocationId,
  };
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
