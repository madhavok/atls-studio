import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/appStore';
import { useAgentRuntimeStore, type AgentRuntimeMessage } from '../stores/agentRuntimeStore';
import { useAgentWindowStore, type AgentWindow } from '../stores/agentWindowStore';
import { useContextStore } from '../stores/contextStore';
import { chatDb } from '../services/chatDb';
import { streamChat, type AIConfig, type AIProvider, type ChatMessage, type WorkspaceContext } from '../services/aiService';
import { getPricingProviderForModel } from '../utils/pricingProvider';
import { isExtendedContextEnabled, modelSupportsExtendedContext } from '../utils/modelCapabilities';
import { resolveModelSettings } from '../utils/modelSettings';
import { buildDelegationContext, summarizeChildResult } from '../services/delegationContext';
import { handleDelegateToolCall, handleSubAgentProgress } from '../services/agentDelegateBridge';

function getApiKeyForProvider(provider: AIProvider): string {
  const settings = useAppStore.getState().settings;
  switch (provider) {
    case 'anthropic': return settings.anthropicApiKey;
    case 'openai': return settings.openaiApiKey;
    case 'openrouter': return settings.openrouterApiKey;
    case 'google': return settings.googleApiKey;
    case 'vertex': return settings.vertexAccessToken;
    case 'lmstudio': return '';
    default: return '';
  }
}

function getSelectedModelProvider(): AIProvider {
  const state = useAppStore.getState();
  return getPricingProviderForModel(state.settings.selectedModel, state.settings.selectedProvider, state.availableModels);
}

function getWindowProvider(window: AgentWindow): AIProvider {
  const settings = useAppStore.getState().settings;
  if (window.role && settings.subagentModel !== 'none' && settings.subagentProvider) {
    return settings.subagentProvider as AIProvider;
  }
  return getSelectedModelProvider();
}

function getWindowModel(window: AgentWindow): string {
  const settings = useAppStore.getState().settings;
  if (window.role && settings.subagentModel && settings.subagentModel !== 'none') {
    return settings.subagentModel;
  }
  return settings.selectedModel;
}

function getAIConfig(window: AgentWindow): AIConfig {
  const state = useAppStore.getState();
  const { settings } = state;
  const provider = getWindowProvider(window);
  const model = getWindowModel(window);
  const anthropicBeta =
    provider === 'anthropic' &&
    isExtendedContextEnabled(
      model,
      'anthropic',
      settings.extendedContextByModelId ?? {},
      settings.extendedContext,
    ) &&
    modelSupportsExtendedContext(model, 'anthropic')
      ? ['context-1m-2025-08-07']
      : undefined;
  const modelSettings = resolveModelSettings(
    window.role ? settings.subagentOutputSpeed ?? settings.modelOutputSpeed : settings.modelOutputSpeed,
    window.role ? settings.subagentThinking ?? settings.modelThinking : settings.modelThinking,
    model,
    provider,
    settings.maxTokens,
  );
  return {
    provider,
    model,
    apiKey: getApiKeyForProvider(provider),
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    projectId: settings.vertexProjectId,
    region: provider === 'vertex' ? settings.vertexRegion : undefined,
    baseUrl: provider === 'lmstudio' ? settings.lmstudioBaseUrl : undefined,
    anthropicBeta,
    ...modelSettings,
  };
}

function getWorkspaceContext(): WorkspaceContext {
  const app = useAppStore.getState();
  const focus = app.focusProfile;
  const platform = navigator.platform.toLowerCase();
  const os = platform.includes('win') ? 'windows' : platform.includes('mac') ? 'macos' : 'linux';
  const shell = os === 'windows' ? 'powershell' : os === 'macos' ? 'zsh' : 'bash';
  return {
    profile: app.projectProfile,
    activeFile: app.activeFile,
    openFiles: app.openFiles,
    os,
    shell,
    cwd: app.projectPath || undefined,
    atlsReady: app.atlsInitialized,
    focusProfile: { name: app.focusProfileName, matrix: focus.matrix },
  };
}

function runtimeMessagesToChat(messages: AgentRuntimeMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role === 'system' ? 'system' : message.role,
    content: message.content,
  }));
}

async function persistMessage(sessionId: string, message: AgentRuntimeMessage): Promise<void> {
  if (!chatDb.isInitialized()) return;
  if (message.role === 'system') return;
  try {
    await chatDb.addMessage(sessionId, message.role, message.content, undefined, message.id);
  } catch (error) {
    console.warn('[AgentWindowRunner] Failed to persist message:', error);
  }
}

export function useAgentWindowRunner() {
  const runWindow = useCallback(async (windowId: string, prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;

    const window = Object.values(useAgentWindowStore.getState().windowsByParent)
      .flat()
      .find((candidate) => candidate.windowId === windowId);
    if (!window) return;

    const runtimeStore = useAgentRuntimeStore.getState();
    const runtime = runtimeStore.ensureRuntime({
      windowId,
      sessionId: window.sessionId,
      parentSessionId: window.parentSessionId,
      role: window.role,
    });
    if (runtime.isGenerating) return;

    if (window.role && useAppStore.getState().settings.subagentModel === 'none') {
      const failed = runtimeStore.appendMessage(windowId, {
        role: 'system',
        content: 'Worker routing is disabled. Pick a worker model before running this delegate.',
      });
      if (failed) void persistMessage(window.sessionId, failed);
      runtimeStore.finishRun(windowId, 'failed', 'Worker routing is disabled.');
      return;
    }

    const config = getAIConfig(window);
    if (!config.apiKey && config.provider !== 'lmstudio') {
      const failed = runtimeStore.appendMessage(windowId, {
        role: 'assistant',
        content: `Provider required. Configure ${config.provider} before running this agent window.`,
      });
      if (failed) void persistMessage(window.sessionId, failed);
      runtimeStore.finishRun(windowId, 'failed', 'Provider required.');
      return;
    }

    const parentWindow = useAgentWindowStore.getState().windowsByParent[window.parentSessionId]
      ?.find((candidate) => candidate.sessionId === window.parentSessionId) ?? window;
    const parentRuntime = useAgentRuntimeStore.getState().runtimesByWindow[parentWindow.windowId];
    const parentMessages = parentRuntime?.messages ?? useAppStore.getState().messages;
    const delegationContext = window.role
      ? buildDelegationContext({
          parentWindow,
          childRole: window.role,
          task: trimmed,
          parentMessages,
        })
      : '';

    const controller = new AbortController();
    const appState = useAppStore.getState();
    const fileClaims = window.role === 'coder' || window.role === 'debugger' || window.role === 'tester'
      ? Array.from(new Set([appState.activeFile, ...appState.openFiles].filter((path): path is string => Boolean(path))))
      : [];
    runtimeStore.setFileClaims(windowId, fileClaims);
    const userMessage = runtimeStore.appendMessage(windowId, { role: 'user', content: trimmed });
    if (userMessage) void persistMessage(window.sessionId, userMessage);
    runtimeStore.setDraft(windowId, '');
    runtimeStore.startRun(windowId, controller);
    useAgentWindowStore.getState().setWindowStatus(windowId, 'running');

    let fullResponse = '';
    const startedAt = Date.now();
    const prior = useAgentRuntimeStore.getState().runtimesByWindow[windowId]?.messages ?? [];
    const chatMessages: ChatMessage[] = [
      ...(delegationContext ? [{ role: 'system' as const, content: delegationContext }] : []),
      ...runtimeMessagesToChat(prior),
    ];

    try {
      await streamChat(config, chatMessages, {
        onToken: (token) => {
          fullResponse += token;
          runtimeStore.setStreamingText(windowId, fullResponse);
          runtimeStore.replaceLastAssistantMessage(windowId, fullResponse);
        },
        onToolCall: (toolCall) => {
          runtimeStore.addToolCall(windowId, toolCall);
          runtimeStore.updateTelemetry(windowId, { lastTool: toolCall.name });
          handleDelegateToolCall(window.parentSessionId, toolCall);
          toolCall.syntheticChildren?.forEach((child) => handleDelegateToolCall(window.parentSessionId, child));
        },
        onToolResult: (id, result) => {
          runtimeStore.updateTelemetry(windowId, { lastTool: id });
          const systemMessage = runtimeStore.appendMessage(windowId, {
            role: 'system',
            toolName: id,
            content: result.slice(0, 800),
          });
          if (systemMessage) void persistMessage(window.sessionId, systemMessage);
        },
        onUsageUpdate: (usage) => {
          runtimeStore.updateTelemetry(windowId, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            costCents: usage.costCents ?? 0,
          });
        },
        onSubagentProgress: (stepId, progress) => {
          handleSubAgentProgress(window.parentSessionId, stepId, progress);
        },
        onError: (error) => {
          runtimeStore.finishRun(windowId, controller.signal.aborted ? 'cancelled' : 'failed', error.message);
          useAgentWindowStore.getState().setWindowStatus(windowId, controller.signal.aborted ? 'paused' : 'failed');
        },
        onDone: () => {
          const latest = useAgentRuntimeStore.getState().runtimesByWindow[windowId];
          if (fullResponse.trim()) {
            const finalMessage = latest?.messages[latest.messages.length - 1];
            if (finalMessage?.role === 'assistant') void persistMessage(window.sessionId, finalMessage);
          }
          const finalStatus = controller.signal.aborted ? 'cancelled' : fullResponse.trim() ? 'completed' : 'failed';
          runtimeStore.updateTelemetry(windowId, { latencyMs: Date.now() - startedAt });
          runtimeStore.finishRun(windowId, finalStatus);
          useAgentWindowStore.getState().setWindowStatus(windowId, finalStatus === 'completed' ? 'completed' : finalStatus === 'cancelled' ? 'paused' : 'failed');
          const completed = useAgentRuntimeStore.getState().runtimesByWindow[windowId];
          if (window.role && completed) {
            runtimeStore.appendParentEvent({
              parentSessionId: window.parentSessionId,
              childWindowId: windowId,
              title: window.title,
              role: window.role,
              status: finalStatus,
              summary: summarizeChildResult(completed.messages),
            });
          }
        },
        onStreamId: (streamId) => runtimeStore.addStreamId(windowId, streamId),
        onClear: () => {
          fullResponse = '';
          runtimeStore.setStreamingText(windowId, '');
        },
        onStatus: (message) => {
          if (!message) return;
          runtimeStore.appendMessage(windowId, { role: 'system', content: message });
        },
      }, getWorkspaceContext(), window.role === 'reviewer' ? 'reviewer' : 'agent', {
        allowConcurrent: true,
        abortSignal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtimeStore.finishRun(windowId, controller.signal.aborted ? 'cancelled' : 'failed', message);
      useAgentWindowStore.getState().setWindowStatus(windowId, controller.signal.aborted ? 'paused' : 'failed');
    }
  }, []);

  const cancelWindow = useCallback((windowId: string) => {
    const streamIds = useAgentRuntimeStore.getState().cancelRun(windowId);
    useAgentWindowStore.getState().setWindowStatus(windowId, 'paused');
    for (const streamId of streamIds) {
      void invoke('cancel_chat_stream', { streamId }).catch((error) => {
        console.warn('[AgentWindowRunner] Failed to cancel stream:', error);
      });
    }
  }, []);

  return { runWindow, cancelWindow };
}
