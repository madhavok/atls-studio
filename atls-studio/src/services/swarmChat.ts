/**
 * Swarm-specific chat streaming
 * Extracted from aiService.ts for better separation of concerns
 */

import { invoke } from '@tauri-apps/api/core';
import { safeListen } from '../utils/tauri';
import type { ContextUsage, StreamChunk } from '../stores/appStore';
import { useAppStore } from '../stores/appStore';
import { useContextStore } from '../stores/contextStore';
import { useCostStore, calculateCost, type AIProvider as CostProvider } from '../stores/costStore';
import { getEffectiveContextWindow } from '../utils/modelCapabilities';
import { resolveHashRefsWithMeta, type HashLookup } from '../utils/hashResolver';
import { rateLimiter } from './rateLimiter';
import type { AIProvider, AIConfig, ToolCallEvent } from './aiService';
import { executeToolCall } from './aiService';

export interface SwarmStreamCallbacks {
  onToken: (token: string) => void;
  onToolCall: (toolCall: ToolCallEvent) => void;
  onToolResult: (id: string, result: string) => void;
  onUsageUpdate?: (usage: ContextUsage) => void;
  onError: (error: Error) => void;
  onDone: () => void;
  onSwarmThought?: (thought: string) => void;
  onSwarmDecision?: (decision: string) => void;
}

export interface SwarmStreamOptions {
  isSwarmAgent?: boolean;
  mode?: string;
  enableTools?: boolean;
  maxIterations?: number;
  maxAutoContinues?: number;
  swarmTerminalId?: string;
  agentRole?: string;
  taskId?: string;
  fileClaims?: string[];
}

interface PendingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function looksLikeNaturalStop(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const lastChar = trimmed[trimmed.length - 1];
  if (['.', '!', '?', ':', ')', ']', '}', '"', "'", '`'].includes(lastChar)) {
    return true;
  }

  const sentenceEndPattern = /[.!?]\s*$/;
  if (sentenceEndPattern.test(trimmed)) {
    return true;
  }

  return false;

}

function createHashLookup(sessionId: string | null): HashLookup {
  return async (hash: string): Promise<{ content: string; source?: string } | null> => {
    const ctx = useContextStore.getState();
    const fromStore = ctx.getChunkForHashRef(hash);

    if (!fromStore || fromStore.chunkType === 'smart') {
      try {
        const resolved = await invoke<{ content: string; source?: string }>('resolve_hash_ref', {
          rawRef: `h:${hash}:content`,
          sessionId: sessionId ?? null,
        });
        if (resolved?.content) {
          return { content: resolved.content, source: resolved.source ?? fromStore?.source };
        }
      } catch {
        // Backend doesn't have it — fall through to frontend content
      }
    }

    if (fromStore) return fromStore;
    if (!sessionId) return null;
    try {
      const { chatDb } = await import('./chatDb');
      if (!chatDb.isInitialized()) return null;
      return await chatDb.getContentByHash(sessionId, hash);
    } catch {
      return null;
    }
  };
}

/** Run one streaming round; returns when done. Mirrors agent-mode metrics: costStore, context bar, cache, rate limiter. */
async function runStreamRound(
  provider: AIProvider,
  config: AIConfig,
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt: string,
  callbacks: SwarmStreamCallbacks,
  streamId: string,
  enableTools: boolean,
  sessionTotals: { input: number; output: number },
): Promise<{
  fullResponse: string;
  pendingToolCalls: PendingToolCall[];
  stopReason: string | null;
  roundInputTokens: number;
  roundOutputTokens: number;
  roundCacheReadTokens: number;
  roundCacheWriteTokens: number;
  roundCostCents: number;
}> {
  let fullResponse = '';
  const pendingToolCalls: PendingToolCall[] = [];
  let stopReason: string | null = null;

  let roundInputTokens = 0;
  let roundOutputTokens = 0;
  let roundCacheReadTokens = 0;
  let roundCacheWriteTokens = 0;

  let resolveDone: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const unlisten = await safeListen<StreamChunk>(`chat-chunk-${streamId}`, (event) => {
    const chunk = event.payload;
    switch (chunk.type) {
      case 'text_delta':
        fullResponse += chunk.delta;
        callbacks.onToken(chunk.delta);
        break;
      case 'tool_input_available':
        pendingToolCalls.push({
          id: chunk.tool_call_id,
          name: chunk.tool_name,
          args: chunk.input,
        });
        callbacks.onToolCall({
          id: chunk.tool_call_id,
          name: chunk.tool_name,
          args: chunk.input,
          status: 'running',
        });
        break;
      case 'usage': {
        const inTokens = chunk.input_tokens ?? 0;
        const outTokens = chunk.output_tokens ?? 0;
        if (inTokens > 0) roundInputTokens = inTokens;
        if (outTokens > 0) roundOutputTokens = outTokens;

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
          useAppStore.getState().addCacheMetrics({
            cacheWrite: 0,
            cacheRead: openaiCached,
            uncached: inTokens - openaiCached,
            lastRequestCachedTokens: openaiCached,
          });
        }

        const geminiCached = chunk.cached_content_tokens ?? 0;
        if (geminiCached > 0) {
          roundCacheReadTokens = geminiCached;
          useAppStore.getState().addCacheMetrics({
            cacheWrite: 0,
            cacheRead: geminiCached,
            uncached: inTokens - geminiCached,
            lastRequestCachedTokens: geminiCached,
          });
        }

        const displayIn = sessionTotals.input + roundInputTokens;
        const displayOut = sessionTotals.output + roundOutputTokens;
        const modelInfo = useAppStore.getState().availableModels.find(m => m.id === config.model);
        const extendedContext = useAppStore.getState().settings.extendedContext ?? {};
        const maxTokens = modelInfo
          ? (getEffectiveContextWindow(modelInfo.id, modelInfo.provider, modelInfo.contextWindow, extendedContext)
            ?? (provider === 'google' || provider === 'vertex' ? 1000000 : 200000))
          : (provider === 'google' || provider === 'vertex' ? 1000000 : 200000);

        const usage: ContextUsage = {
          inputTokens: displayIn,
          outputTokens: displayOut,
          totalTokens: displayIn + displayOut,
          maxTokens,
          percentage: Math.min(100, ((displayIn + displayOut) / maxTokens) * 100),
        };
        useAppStore.getState().setContextUsage(usage);
        callbacks.onUsageUpdate?.(usage);
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
        callbacks.onError(new Error(chunk.error_text));
        unlisten();
        resolveDone!();
        break;
      default:
        break;
    }
  });

  try {
    if (provider === 'anthropic') {
      await invoke('stream_chat_anthropic', {
        apiKey: config.apiKey,
        model: config.model,
        messages,
        maxTokens: config.maxTokens ?? 4096,
        temperature: config.temperature ?? 0.7,
        systemPrompt,
        streamId,
        enableTools,
      });
    } else if (provider === 'openai') {
      await invoke('stream_chat_openai', {
        apiKey: config.apiKey,
        model: config.model,
        messages,
        maxTokens: config.maxTokens ?? 4096,
        temperature: config.temperature ?? 0.7,
        systemPrompt,
        streamId,
      });
    } else if (provider === 'lmstudio') {
      await invoke('stream_chat_lmstudio', {
        baseUrl: config.baseUrl ?? config.apiKey,
        model: config.model,
        messages,
        maxTokens: config.maxTokens ?? 4096,
        temperature: config.temperature ?? 0.7,
        systemPrompt,
        streamId,
        enableTools,
      });
    } else {
      throw new Error(`Swarm streaming not supported for provider: ${provider}`);
    }
  } catch (invokeError: unknown) {
    // Tauri invoke rejects with bare strings — normalize to Error
    const msg = invokeError instanceof Error ? invokeError.message
      : typeof invokeError === 'string' ? invokeError
      : JSON.stringify(invokeError) || 'Stream invocation failed';
    throw new Error(msg);
  }

  await donePromise;

  useAppStore.getState().recordRound();

  let roundCostCents = 0;
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
    rateLimiter.recordSuccess(provider, roundInputTokens, roundOutputTokens);
  } else {
    console.warn('[swarmChat] Round completed with zero usage — cost may show $0');
  }

  return {
    fullResponse,
    pendingToolCalls,
    stopReason,
    roundInputTokens,
    roundOutputTokens,
    roundCacheReadTokens,
    roundCacheWriteTokens,
    roundCostCents,
  };
}


export async function streamChatForSwarm(
  messages: ChatMessage[],
  config: AIConfig,
  systemPrompt: string,
  _projectPath: string,
  callbacks: SwarmStreamCallbacks,
  _options: SwarmStreamOptions
): Promise<{
  taskCompleted: boolean;
  taskStatus: 'completed' | 'awaiting_input' | 'incomplete';
  result: string;
  taskCompleteSummary?: string;
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionCostCents: number;
}> {
  const { provider } = config;
  const sessionId = useAppStore.getState().currentSessionId;
  const lookup = createHashLookup(sessionId);
  const setLookup = useContextStore.getState().createSetRefLookup();

  const maxIterations = _options.maxIterations ?? 2;
  const maxAutoContinues = _options.maxAutoContinues ?? 0;

  let fullResponse = '';
  let explicitTaskCompleteCalled = false;
  let blockingToolResultSeen = false;
  let latestTaskCompleteSummary: string | undefined;
  let autoContinueCount = 0;

  let sessionTotalInput = 0;
  let sessionTotalOutput = 0;
  let sessionCostCents = 0;

  const apiMessages: Array<{ role: string; content: unknown }> = [];
  for (const msg of messages) {
    const { params } = await resolveHashRefsWithMeta(
      { content: msg.content },
      lookup,
      undefined,
      setLookup
    );
    const resolved = params as { content: unknown };
    apiMessages.push({ role: msg.role, content: resolved.content });
  }

  const streamId = `swarm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const enableTools = _options.enableTools ?? false;

  const accumulateRound = (r: Awaited<ReturnType<typeof runStreamRound>>) => {
    sessionTotalInput += r.roundInputTokens;
    sessionTotalOutput += r.roundOutputTokens;
    sessionCostCents += r.roundCostCents;
  };

  try {
    for (let round = 0; round < maxIterations; round++) {
      const roundResult = await runStreamRound(
        provider,
        config,
        apiMessages,
        systemPrompt,
        callbacks,
        `${streamId}-r${round}`,
        enableTools,
        { input: sessionTotalInput, output: sessionTotalOutput },
      );
      accumulateRound(roundResult);
      fullResponse = roundResult.fullResponse;

      // No tool calls -- check if we should auto-continue or stop
      if (roundResult.pendingToolCalls.length === 0) {
        if (
          !explicitTaskCompleteCalled &&
          !blockingToolResultSeen &&
          autoContinueCount < maxAutoContinues &&
          roundResult.stopReason === 'end_turn' &&
          looksLikeNaturalStop(fullResponse)
        ) {
          autoContinueCount++;
          apiMessages.push(
            { role: 'assistant', content: fullResponse },
            { role: 'user', content: 'Continue. You have not called task_complete yet. Finish the remaining work or call task_complete with your summary.' },
          );
          continue;
        }
        break;
      }

      // Execute tool calls for this round
      const toolResults: Array<{ tool_use_id: string; content: string }> = [];
      for (const toolCall of roundResult.pendingToolCalls) {
        if (toolCall.name === 'task_complete') {
          explicitTaskCompleteCalled = true;
          const summary = typeof toolCall.args?.summary === 'string'
            ? toolCall.args.summary.trim()
            : '';
          latestTaskCompleteSummary = summary || latestTaskCompleteSummary;
        }
        try {
          const result = await executeToolCall(
            toolCall.name,
            toolCall.args ?? {},
            { swarmTerminalId: _options.swarmTerminalId },
          );
          if (/BATCH INTERRUPTED|awaiting confirmation|paused/i.test(result)) {
            blockingToolResultSeen = true;
          }
          toolResults.push({ tool_use_id: toolCall.id, content: result });
          callbacks.onToolResult(toolCall.id, result);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          toolResults.push({ tool_use_id: toolCall.id, content: `Error: ${errorMsg}` });
          callbacks.onToolResult(toolCall.id, errorMsg);
        }
      }

      // If task_complete was called or a blocking result was seen, run one
      // final round so the model can acknowledge, then stop.
      if (explicitTaskCompleteCalled || blockingToolResultSeen) {
        // Build assistant content block with text + tool_use entries
        const assistantContent: unknown[] = [];
        if (fullResponse) {
          assistantContent.push({ type: 'text', text: fullResponse });
        }
        for (const tc of roundResult.pendingToolCalls) {
          assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
        }
        apiMessages.push(
          { role: 'assistant', content: assistantContent },
          { role: 'user', content: toolResults.map(tr => ({ type: 'tool_result', tool_use_id: tr.tool_use_id, content: tr.content })) },
        );

        const finalRound = await runStreamRound(
          provider,
          config,
          apiMessages,
          systemPrompt,
          callbacks,
          `${streamId}-r${round + 1}`,
          enableTools,
          { input: sessionTotalInput, output: sessionTotalOutput },
        );
        accumulateRound(finalRound);
        fullResponse = finalRound.fullResponse;
        break;
      }

      // Append this round's exchange to the conversation for the next round
      const assistantContent: unknown[] = [];
      if (fullResponse) {
        assistantContent.push({ type: 'text', text: fullResponse });
      }
      for (const tc of roundResult.pendingToolCalls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      apiMessages.push(
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: toolResults.map(tr => ({ type: 'tool_result', tool_use_id: tr.tool_use_id, content: tr.content })) },
      );
    }
  } finally {
    callbacks.onDone();
  }

  const taskCompleted = explicitTaskCompleteCalled && !blockingToolResultSeen;
  const taskStatus = taskCompleted
    ? 'completed'
    : (blockingToolResultSeen ? 'awaiting_input' : 'incomplete');

  const resultText = fullResponse.trim() || latestTaskCompleteSummary || '';
  return {
    taskCompleted,
    taskStatus,
    result: resultText,
    taskCompleteSummary: latestTaskCompleteSummary,
    sessionInputTokens: sessionTotalInput,
    sessionOutputTokens: sessionTotalOutput,
    sessionCostCents,
  };
}

type ChatMessage = {
  role: string;
  content: unknown;
};