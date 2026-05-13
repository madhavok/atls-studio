import { useAppStore } from '../stores/appStore';
import { useAgentRuntimeStore, type AgentRuntimeMessage } from '../stores/agentRuntimeStore';
import { useAgentWindowStore, type AgentWindow } from '../stores/agentWindowStore';
import { chatDb } from './chatDb';
import type { ToolCallEvent } from './aiService';
import type { SubAgentProgressEvent } from './batch/types';

const bridgeWindowByKey = new Map<string, string>();
const pendingSessionCreates = new Map<string, Promise<unknown>>();

function createSessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `delegate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function delegateRoleFromName(name: string): string {
  const raw = name.startsWith('delegate.') ? name.slice('delegate.'.length) : name;
  if (raw === 'code') return 'coder';
  if (raw === 'test') return 'tester';
  if (raw === 'retrieve') return 'researcher';
  if (raw === 'design') return 'designer';
  return raw || 'delegate';
}

function titleForRole(role: string): string {
  return `${role[0]?.toUpperCase() ?? 'D'}${role.slice(1)} Delegate`;
}

function sourceIdForToolCall(toolCall: ToolCallEvent): string {
  const stepId = toolCall.args?.step_id;
  return typeof stepId === 'string' && stepId.trim() ? stepId : toolCall.id;
}

async function persistRuntimeMessage(sessionId: string, message: AgentRuntimeMessage): Promise<void> {
  if (!chatDb.isInitialized()) return;
  try {
    await pendingSessionCreates.get(sessionId);
    const role = message.role === 'system' ? 'assistant' : message.role;
    const content = message.role === 'system' ? `[status] ${message.content}` : message.content;
    await chatDb.addMessage(sessionId, role, content, undefined, message.id);
  } catch (error) {
    console.warn('[DelegateBridge] Failed to persist delegate message:', error);
  }
}

function upsertChatSession(sessionId: string, title: string) {
  useAppStore.setState((state) => {
    if (state.chatSessions.some((session) => session.id === sessionId)) return {};
    return {
      chatSessions: [
        {
          id: sessionId,
          title,
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0 },
        },
        ...state.chatSessions,
      ],
    };
  });
}

function getParentWindow(parentSessionId: string): AgentWindow | undefined {
  return useAgentWindowStore.getState().windowsByParent[parentSessionId]
    ?.find((window) => window.sessionId === parentSessionId);
}

function ensureDelegateWindow({
  parentSessionId,
  sourceId,
  role,
  title,
}: {
  parentSessionId: string;
  sourceId: string;
  role: string;
  title?: string;
}): AgentWindow | null {
  const key = `${parentSessionId}:${sourceId}`;
  const existingWindowId = bridgeWindowByKey.get(key);
  const parentWindows = useAgentWindowStore.getState().windowsByParent[parentSessionId] ?? [];
  const existing = existingWindowId
    ? parentWindows.find((window) => window.windowId === existingWindowId)
    : parentWindows.find((window) => window.sourceToolCallId === sourceId);
  if (existing) return existing;

  const childTitle = title || titleForRole(role);
  const sessionId = createSessionId();
  if (chatDb.isInitialized()) {
    const pendingCreate = chatDb.createSession('agent', childTitle, sessionId).catch((error) => {
      console.warn('[DelegateBridge] Failed to create delegate session:', error);
    });
    pendingSessionCreates.set(sessionId, pendingCreate);
    void pendingCreate.finally(() => pendingSessionCreates.delete(sessionId));
  }
  upsertChatSession(sessionId, childTitle);
  const windowId = useAgentWindowStore.getState().spawnStandardWindow(
    parentSessionId,
    sessionId,
    childTitle,
    role,
    sourceId,
    { select: false },
  );
  bridgeWindowByKey.set(key, windowId);
  useAgentRuntimeStore.getState().ensureRuntime({
    windowId,
    sessionId,
    parentSessionId,
    role,
  });
  const parentTitle = getParentWindow(parentSessionId)?.title ?? 'parent chat';
  const systemMessage = useAgentRuntimeStore.getState().appendMessage(windowId, {
    role: 'system',
    content: `Spawned by model delegate call ${sourceId} from ${parentTitle}.`,
  });
  if (systemMessage) void persistRuntimeMessage(sessionId, systemMessage);
  return useAgentWindowStore.getState().windowsByParent[parentSessionId]?.find((window) => window.windowId === windowId) ?? null;
}

export function handleDelegateToolCall(parentSessionId: string | null, toolCall: ToolCallEvent): void {
  if (!parentSessionId || !toolCall.name.startsWith('delegate.')) return;
  const role = delegateRoleFromName(toolCall.name);
  const sourceId = sourceIdForToolCall(toolCall);
  const title = `${titleForRole(role)} · ${sourceId.slice(0, 6)}`;
  const window = ensureDelegateWindow({
    parentSessionId,
    sourceId,
    role,
    title,
  });
  if (!window) return;
  const runtimeStore = useAgentRuntimeStore.getState();
  const argsSummary = toolCall.args && Object.keys(toolCall.args).length > 0
    ? `\nArgs: ${JSON.stringify(toolCall.args).slice(0, 900)}`
    : '';
  if (toolCall.status === 'running' || toolCall.status === 'pending') {
    useAgentWindowStore.getState().setWindowStatus(window.windowId, 'running');
    const message = runtimeStore.appendMessage(window.windowId, {
      role: 'assistant',
      toolName: toolCall.name,
      content: `Delegate call ${toolCall.status}.${argsSummary}`,
    });
    if (message) void persistRuntimeMessage(window.sessionId, message);
    runtimeStore.startRun(window.windowId, new AbortController());
    return;
  }

  const terminalStatus = toolCall.status === 'completed' ? 'completed' : 'failed';
  const resultContent = toolCall.result?.trim()
    ? toolCall.result.trim()
    : `Delegate ${terminalStatus}.`;
  const resultMessage = runtimeStore.appendMessage(window.windowId, {
    role: terminalStatus === 'completed' ? 'assistant' : 'system',
    toolName: toolCall.name,
    content: resultContent,
  });
  if (resultMessage) void persistRuntimeMessage(window.sessionId, resultMessage);
  runtimeStore.finishRun(window.windowId, terminalStatus);
  useAgentWindowStore.getState().setWindowStatus(window.windowId, terminalStatus);
  runtimeStore.appendParentEvent({
    parentSessionId,
    childWindowId: window.windowId,
    title: window.title,
    role: window.role,
    status: terminalStatus,
    summary: resultContent.slice(0, 900),
  });
}

export function handleSubAgentProgress(parentSessionId: string | null, stepId: string, progress: SubAgentProgressEvent): void {
  if (!parentSessionId) return;
  const role = delegateRoleFromName(progress.toolName);
  const delegateDone = progress.done && progress.toolName.startsWith('delegate.');
  const window = ensureDelegateWindow({
    parentSessionId,
    sourceId: stepId,
    role,
    title: `${titleForRole(role)} · ${stepId.slice(0, 6)}`,
  });
  if (!window) return;
  const runtimeStore = useAgentRuntimeStore.getState();
  useAgentWindowStore.getState().setWindowStatus(window.windowId, delegateDone ? 'completed' : 'running');
  if (!delegateDone) {
    const runtime = useAgentRuntimeStore.getState().runtimesByWindow[window.windowId];
    if (!runtime?.isGenerating) runtimeStore.startRun(window.windowId, new AbortController());
  }
  const content = `Round ${progress.round}: ${progress.status}`;
  runtimeStore.setStreamingText(window.windowId, content);
  const message = runtimeStore.appendMessage(window.windowId, {
    role: 'assistant',
    toolName: progress.toolName,
    content,
  });
  if (message) void persistRuntimeMessage(window.sessionId, message);
  runtimeStore.updateTelemetry(window.windowId, {
    rounds: Math.max(runtimeStore.runtimesByWindow[window.windowId]?.telemetry.rounds ?? 0, progress.round),
    lastTool: progress.toolName,
  });
  if (delegateDone) {
    runtimeStore.finishRun(window.windowId, 'completed');
    runtimeStore.appendParentEvent({
      parentSessionId,
      childWindowId: window.windowId,
      title: window.title,
      role: window.role,
      status: 'completed',
      summary: content,
    });
  }
}
