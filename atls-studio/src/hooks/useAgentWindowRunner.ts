import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { generateTitle, useAppStore, type Message } from '../stores/appStore';
import { useAgentRuntimeStore, type AgentRuntimeMessage } from '../stores/agentRuntimeStore';
import { useAgentWindowStore, type AgentWindow } from '../stores/agentWindowStore';
import type { ChatAttachment } from '../stores/attachmentStore';
import { chatDb } from '../services/chatDb';
import { streamChat, type AIConfig, type AIProvider, type ChatMessage, type WorkspaceContext } from '../services/aiService';
import { formatAttachmentForLLM } from '../utils/fileAttachments';
import { getPricingProviderForModel } from '../utils/pricingProvider';
import { isExtendedContextEnabled, modelSupportsExtendedContext } from '../utils/modelCapabilities';
import { resolveModelSettings } from '../utils/modelSettings';
import { buildDelegationContext } from '../services/delegationContext';
import { syncShellToProjectPath } from '../services/agentShellSync';
import { buildAgentWindowStreamCallbacks } from './agentWindowStreamCallbacks';
import { persistGridAssistantTurn, persistGridUserMessage } from '../services/agentGridMessagePersist';
import { useAtls } from './useAtls';

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

function getWindowMaxTokens(window: AgentWindow): number {
  const settings = useAppStore.getState().settings;
  if (window.role) return Math.min(settings.maxTokens, 8192);
  return settings.maxTokens;
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
  const customAgent = !window.role && state.chatMode === 'agent'
    ? state.customAgents.find((agent) => agent.id === state.selectedAgent)
    : undefined;
  return {
    provider,
    model,
    apiKey: getApiKeyForProvider(provider),
    maxTokens: getWindowMaxTokens(window),
    temperature: settings.temperature,
    projectId: settings.vertexProjectId,
    region: provider === 'vertex' ? settings.vertexRegion : undefined,
    baseUrl: provider === 'lmstudio' ? settings.lmstudioBaseUrl : undefined,
    anthropicBeta,
    systemPrompt: customAgent?.systemPrompt,
    ...modelSettings,
  };
}

function getWorkspaceContext(window?: AgentWindow): WorkspaceContext {
  const app = useAppStore.getState();
  const focus = app.focusProfile;
  const platform = navigator.platform.toLowerCase();
  const os = platform.includes('win') ? 'windows' : platform.includes('mac') ? 'macos' : 'linux';
  const shell = os === 'windows' ? 'powershell' : os === 'macos' ? 'zsh' : 'bash';
  const cwd = window?.projectPath ?? app.projectPath ?? undefined;
  return {
    profile: app.projectProfile,
    activeFile: app.activeFile,
    openFiles: app.openFiles,
    os,
    shell,
    cwd,
    atlsReady: app.atlsInitialized,
    focusProfile: { name: app.focusProfileName, matrix: focus.matrix },
  };
}

const CONTINUATION_PROMPT = 'Continue working. When fully done, either provide a brief final summary or call task_complete with a summary.';

async function buildPromptWithAttachments(
  trimmed: string,
  attachments: ChatAttachment[],
  projectPath: string | null | undefined,
): Promise<{ prompt: string; displayContent: string }> {
  if (attachments.length === 0) {
    return { prompt: trimmed, displayContent: trimmed };
  }

  let fileContextBlock = '';
  for (const att of attachments) {
    if (att.type !== 'file') continue;
    let content = att.content;
    if (!content && att.path) {
      try {
        content = await invoke<string>('read_file_contents', { path: att.path, projectRoot: projectPath ?? undefined });
      } catch {
        content = `[Error reading ${att.name}]`;
      }
    }
    if (!content) continue;
    if (att.fileType === 'code' && att.metadata) {
      fileContextBlock += `\n${formatAttachmentForLLM(att)}\n`;
    } else {
      fileContextBlock += `\n<file path="${att.path || att.name}">\n${content}\n</file>\n`;
    }
  }

  const displayContent = trimmed + `\n\n[Attached: ${attachments.map((attachment) => attachment.name).join(', ')}]`;
  const prompt = fileContextBlock ? `${trimmed}${fileContextBlock}` : displayContent;
  return { prompt, displayContent };
}

function runtimeMessagesToChat(messages: AgentRuntimeMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role === 'system' ? 'system' : message.role,
    content: message.content,
  }));
}

async function persistMessage(sessionId: string, message: AgentRuntimeMessage): Promise<void> {
  if (message.role === 'user') {
    await persistGridUserMessage(sessionId, message);
    return;
  }
  if (message.role === 'assistant' && message.parts?.length) {
    await persistGridAssistantTurn(sessionId, message, message.parts, message.content);
    return;
  }
  if (!chatDb.isInitialized() || message.role === 'system') return;
  try {
    await chatDb.addMessage(sessionId, message.role, message.content, undefined, message.id);
  } catch (error) {
    console.warn('[AgentWindowRunner] Failed to persist message:', error);
  }
}

function shouldAutoTitle(title: string): boolean {
  return /^(Primary Chat|New Conversation|New Chat|Agent Session \d+|Agent Window \d+)$/i.test(title.trim());
}

function toTitleMessage(message: AgentRuntimeMessage): Message {
  return {
    id: message.id,
    role: 'user',
    content: message.content,
    timestamp: message.timestamp,
  };
}

function updateWindowSessionTitle(window: AgentWindow, title: string): void {
  useAgentWindowStore.getState().renameWindow(window.windowId, title);
  useAppStore.setState((state) => ({
    chatSessions: state.chatSessions.map((session) => (
      session.id === window.sessionId
        ? { ...session, title, updatedAt: new Date() }
        : session
    )),
  }));
  if (chatDb.isInitialized()) {
    void chatDb.updateSessionTitle(window.sessionId, title).catch((error) => {
      console.warn('[AgentWindowRunner] Failed to update session title:', error);
    });
  }
}

export function useAgentWindowRunner() {
  const { initAtls } = useAtls();
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

    const controller = new AbortController();
    const appState = useAppStore.getState();
    const windowProjectPath = window.projectPath ?? appState.projectPath ?? undefined;
    const currentAttachments = useAgentRuntimeStore.getState().runtimesByWindow[windowId]?.attachments ?? [];
    const { prompt: runPrompt, displayContent } = await buildPromptWithAttachments(trimmed, currentAttachments, windowProjectPath ?? null);
    if (currentAttachments.length > 0) {
      runtimeStore.clearAttachments(windowId);
    }

    const delegationContext = window.role
      ? buildDelegationContext({
          parentWindow,
          childRole: window.role,
          task: runPrompt,
          parentMessages,
        })
      : '';
    const fileClaims = window.role === 'coder' || window.role === 'debugger' || window.role === 'tester'
      ? Array.from(new Set([appState.activeFile, ...appState.openFiles].filter((path): path is string => Boolean(path))))
      : [];
    runtimeStore.setFileClaims(windowId, fileClaims);
    const hadUserMessage = runtime.messages.some((message) => message.role === 'user');
    const userMessage = runtimeStore.appendMessage(windowId, { role: 'user', content: displayContent });
    if (userMessage) void persistMessage(window.sessionId, userMessage);
    if (userMessage && window.kind === 'primary' && !hadUserMessage && shouldAutoTitle(window.title)) {
      const title = generateTitle([toTitleMessage(userMessage)]);
      updateWindowSessionTitle(window, title);
    }
    runtimeStore.setDraft(windowId, '');
    runtimeStore.startRun(windowId, controller);
    useAgentWindowStore.getState().setWindowStatus(windowId, 'running');

    const fullResponseRef = { current: '' };
    const runErroredRef = { current: false };
    const startedAt = Date.now();
    const prior = useAgentRuntimeStore.getState().runtimesByWindow[windowId]?.messages ?? [];
    const chatMessages: ChatMessage[] = [
      ...(delegationContext ? [{ role: 'system' as const, content: delegationContext }] : []),
      ...runtimeMessagesToChat(prior),
    ];

    try {
      const shellPath = windowProjectPath ?? appState.projectPath ?? undefined;
      if (shellPath) {
        await syncShellToProjectPath(shellPath).catch((error) => {
          console.warn('[AgentWindowRunner] shell sync failed:', error);
        });
        if (!useAppStore.getState().atlsInitialized) {
          await initAtls(shellPath);
        }
      }
      const callbacks = buildAgentWindowStreamCallbacks({
        window,
        windowId,
        startedAt,
        fullResponseRef,
        runErroredRef,
        persistMessage: (sessionId, message) => { void persistMessage(sessionId, message); },
        persistAssistantTurn: (sessionId, message, parts, content) => {
          void persistGridAssistantTurn(sessionId, message, parts, content);
        },
      });
      await streamChat(config, chatMessages, callbacks, getWorkspaceContext(window), window.role === 'reviewer' ? 'reviewer' : 'agent', {
        allowConcurrent: true,
        abortSignal: controller.signal,
        dbSessionId: window.sessionId,
        windowId,
        fileClaims,
        projectPath: windowProjectPath,
        chatMode: window.role ? 'agent' : useAppStore.getState().chatMode,
        onCanContinueChange: (canContinue: boolean) => {
          runtimeStore.setCanContinue(windowId, canContinue);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtimeStore.finishRun(windowId, controller.signal.aborted ? 'cancelled' : 'failed', message);
      useAgentWindowStore.getState().setWindowStatus(windowId, controller.signal.aborted ? 'paused' : 'failed');
    }
  }, [initAtls]);

  const cancelWindow = useCallback((windowId: string) => {
    const streamIds = useAgentRuntimeStore.getState().cancelRun(windowId);
    useAgentWindowStore.getState().setWindowStatus(windowId, 'paused');
    for (const streamId of streamIds) {
      void invoke('cancel_chat_stream', { streamId }).catch((error) => {
        console.warn('[AgentWindowRunner] Failed to cancel stream:', error);
      });
    }
  }, []);

  const continueWindow = useCallback((windowId: string) => {
    const runtime = useAgentRuntimeStore.getState().runtimesByWindow[windowId];
    if (!runtime?.canContinue || runtime.isGenerating) return;
    useAgentRuntimeStore.getState().setCanContinue(windowId, false);
    void runWindow(windowId, CONTINUATION_PROMPT);
  }, [runWindow]);

  return { runWindow, cancelWindow, continueWindow };
}
