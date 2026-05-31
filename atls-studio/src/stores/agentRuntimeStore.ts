import { create } from 'zustand';
import type { ContextUsage, MessageToolCall, MessagePart, MessageSegment } from './appStore';
import type { ChatAttachment } from './attachmentStore';

export type AgentRuntimeRole = 'user' | 'assistant' | 'system';
export type AgentRuntimeStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentRuntimeMessage {
  id: string;
  role: AgentRuntimeRole;
  content: string;
  timestamp: Date;
  toolName?: string;
  parts?: MessagePart[];
  segments?: MessageSegment[];
}

export interface AgentRuntimeTelemetry {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: number;
  rounds: number;
  retries: number;
  latencyMs?: number;
  lastTool?: string;
}

export interface ParentAgentEvent {
  id: string;
  parentSessionId: string;
  childWindowId: string;
  title: string;
  role?: string;
  status: AgentRuntimeStatus;
  summary: string;
  createdAt: Date;
}

export interface AgentRuntime {
  windowId: string;
  sessionId: string;
  parentSessionId: string;
  role?: string;
  messages: AgentRuntimeMessage[];
  draft: string;
  streamingText: string;
  streamingReasoning: string;
  isGenerating: boolean;
  /** Parent batch/delegate mirror activity — does not block user Run. */
  proxyActive: boolean;
  status: AgentRuntimeStatus;
  toolCalls: MessageToolCall[];
  telemetry: AgentRuntimeTelemetry;
  activeStreamIds: string[];
  lastError?: string;
  abortController?: AbortController;
  fileClaims: string[];
  canContinue: boolean;
  attachments: ChatAttachment[];
  createdAt: Date;
  updatedAt: Date;
}

interface AgentRuntimeState {
  runtimesByWindow: Record<string, AgentRuntime>;
  parentEventsBySession: Record<string, ParentAgentEvent[]>;

  ensureRuntime: (input: { windowId: string; sessionId: string; parentSessionId: string; role?: string; title?: string }) => AgentRuntime;
  hydrateRuntime: (windowId: string, messages: AgentRuntimeMessage[]) => void;
  setDraft: (windowId: string, draft: string) => void;
  appendMessage: (windowId: string, message: Omit<AgentRuntimeMessage, 'id' | 'timestamp'> & { id?: string; timestamp?: Date }) => AgentRuntimeMessage | null;
  replaceLastAssistantMessage: (windowId: string, content: string) => void;
  finalizeLastAssistantMessage: (windowId: string, content: string, parts?: MessagePart[], segments?: MessageSegment[]) => AgentRuntimeMessage | null;
  setStreamingText: (windowId: string, text: string) => void;
  setStreamingReasoning: (windowId: string, text: string) => void;
  startRun: (windowId: string, controller: AbortController) => void;
  setProxyActive: (windowId: string, proxyActive: boolean) => void;
  finishRun: (windowId: string, status: AgentRuntimeStatus, error?: string) => void;
  addStreamId: (windowId: string, streamId: string) => void;
  addToolCall: (windowId: string, toolCall: MessageToolCall) => void;
  updateTelemetry: (windowId: string, patch: Partial<AgentRuntimeTelemetry>) => void;
  setFileClaims: (windowId: string, fileClaims: string[]) => void;
  setCanContinue: (windowId: string, canContinue: boolean) => void;
  addAttachment: (windowId: string, attachment: ChatAttachment) => void;
  removeAttachment: (windowId: string, attachmentId: string) => void;
  clearAttachments: (windowId: string) => void;
  cancelRun: (windowId: string) => string[];
  evictRuntime: (windowId: string) => void;
  appendParentEvent: (event: Omit<ParentAgentEvent, 'id' | 'createdAt'>) => void;
  reset: () => void;
}

const EMPTY_TELEMETRY: AgentRuntimeTelemetry = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costCents: 0,
  rounds: 0,
  retries: 0,
};

const MAX_RUNTIME_MESSAGES = 500;

function trimMessages(messages: AgentRuntimeMessage[]): AgentRuntimeMessage[] {
  if (messages.length <= MAX_RUNTIME_MESSAGES) return messages;
  const system = messages.filter((message) => message.role === 'system');
  const rest = messages.filter((message) => message.role !== 'system');
  const keep = rest.slice(-(MAX_RUNTIME_MESSAGES - system.length));
  return [...system, ...keep];
}
function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function createRuntime(input: { windowId: string; sessionId: string; parentSessionId: string; role?: string }): AgentRuntime {
  const now = new Date();
  return {
    windowId: input.windowId,
    sessionId: input.sessionId,
    parentSessionId: input.parentSessionId,
    role: input.role,
    messages: [],
    draft: '',
    streamingText: '',
    streamingReasoning: '',
    isGenerating: false,
    proxyActive: false,
    status: 'idle',
    toolCalls: [],
    telemetry: { ...EMPTY_TELEMETRY },
    activeStreamIds: [],
    fileClaims: [],
    canContinue: false,
    attachments: [],
    createdAt: now,
    updatedAt: now,
  };
}

export const useAgentRuntimeStore = create<AgentRuntimeState>((set, get) => ({
  runtimesByWindow: {},
  parentEventsBySession: {},

  ensureRuntime: (input) => {
    const existing = get().runtimesByWindow[input.windowId];
    if (existing) return existing;
    const runtime = createRuntime(input);
    set((state) => ({
      runtimesByWindow: { ...state.runtimesByWindow, [input.windowId]: runtime },
    }));
    return runtime;
  },

  hydrateRuntime: (windowId, messages) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime || messages.length === 0) return {};
    const hasPersistedContent = runtime.messages.some((message) => message.role === 'user' || message.role === 'assistant');
    if (hasPersistedContent) return {};
    return {
      runtimesByWindow: {
        ...state.runtimesByWindow,
        [windowId]: {
          ...runtime,
          messages,
          telemetry: {
            ...runtime.telemetry,
            rounds: messages.filter((message) => message.role === 'assistant').length,
          },
          updatedAt: new Date(),
        },
      },
    };
  }),

  setDraft: (windowId, draft) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime) return {};
    return { runtimesByWindow: { ...state.runtimesByWindow, [windowId]: { ...runtime, draft, updatedAt: new Date() } } };
  }),

  appendMessage: (windowId, message) => {
    const next: AgentRuntimeMessage = {
      id: message.id ?? createId('rt-msg'),
      role: message.role,
      content: message.content,
      toolName: message.toolName,
      timestamp: message.timestamp ?? new Date(),
    };
    set((state) => {
      const runtime = state.runtimesByWindow[windowId];
      if (!runtime) return {};
      return {
        runtimesByWindow: {
          ...state.runtimesByWindow,
          [windowId]: {
            ...runtime,
            messages: trimMessages([...runtime.messages, next]),
            updatedAt: new Date(),
          },
        },
      };
    });
    return get().runtimesByWindow[windowId] ? next : null;
  },

  replaceLastAssistantMessage: (windowId, content) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime) return {};
    const last = runtime.messages[runtime.messages.length - 1];
    const messages = last?.role === 'assistant'
      ? [...runtime.messages.slice(0, -1), { ...last, content }]
      : [...runtime.messages, { id: createId('rt-msg'), role: 'assistant' as const, content, timestamp: new Date() }];
    return { runtimesByWindow: { ...state.runtimesByWindow, [windowId]: { ...runtime, messages, updatedAt: new Date() } } };
  }),

  finalizeLastAssistantMessage: (windowId, content, parts, segments) => {
    let finalized: AgentRuntimeMessage | null = null;
    set((state) => {
      const runtime = state.runtimesByWindow[windowId];
      if (!runtime) return {};
      const last = runtime.messages[runtime.messages.length - 1];
      const resolvedContent = content || last?.content || '';
      const next: AgentRuntimeMessage = last?.role === 'assistant'
        ? { ...last, content: resolvedContent, parts, segments }
        : {
          id: createId('rt-msg'),
          role: 'assistant',
          content: resolvedContent,
          timestamp: new Date(),
          parts,
          segments,
        };
      finalized = next;
      const messages = last?.role === 'assistant'
        ? [...runtime.messages.slice(0, -1), next]
        : [...runtime.messages, next];
      return {
        runtimesByWindow: {
          ...state.runtimesByWindow,
          [windowId]: { ...runtime, messages: trimMessages(messages), updatedAt: new Date() },
        },
      };
    });
    return finalized;
  },

  setStreamingText: (windowId, streamingText) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime) return {};
    return { runtimesByWindow: { ...state.runtimesByWindow, [windowId]: { ...runtime, streamingText, updatedAt: new Date() } } };
  }),

  setStreamingReasoning: (windowId, streamingReasoning) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime) return {};
    return { runtimesByWindow: { ...state.runtimesByWindow, [windowId]: { ...runtime, streamingReasoning, updatedAt: new Date() } } };
  }),

  startRun: (windowId, abortController) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime) return {};
    return {
      runtimesByWindow: {
        ...state.runtimesByWindow,
        [windowId]: {
          ...runtime,
          abortController,
          isGenerating: true,
          status: 'running',
          streamingText: '',
          streamingReasoning: '',
          toolCalls: [],
          proxyActive: false,
          lastError: undefined,
          canContinue: false,
          telemetry: {
            ...runtime.telemetry,
            rounds: runtime.telemetry.rounds + 1,
            retries: runtime.status === 'failed' ? runtime.telemetry.retries + 1 : runtime.telemetry.retries,
          },
          updatedAt: new Date(),
        },
      },
    };
  }),

  setProxyActive: (windowId, proxyActive) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime || runtime.proxyActive === proxyActive) return {};
    return {
      runtimesByWindow: {
        ...state.runtimesByWindow,
        [windowId]: {
          ...runtime,
          proxyActive,
          status: proxyActive ? 'running' : runtime.status,
          updatedAt: new Date(),
        },
      },
    };
  }),

  finishRun: (windowId, status, error) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime) return {};
    return {
      runtimesByWindow: {
        ...state.runtimesByWindow,
        [windowId]: {
          ...runtime,
          isGenerating: false,
          proxyActive: false,
          status,
          streamingText: '',
          streamingReasoning: '',
          abortController: undefined,
          activeStreamIds: [],
          lastError: error,
          canContinue: false,
          updatedAt: new Date(),
        },
      },
    };
  }),

  addStreamId: (windowId, streamId) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime || runtime.activeStreamIds.includes(streamId)) return {};
    return { runtimesByWindow: { ...state.runtimesByWindow, [windowId]: { ...runtime, activeStreamIds: [...runtime.activeStreamIds, streamId] } } };
  }),

  addToolCall: (windowId, toolCall) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime) return {};
    const toolCalls = runtime.toolCalls.some((call) => call.id === toolCall.id)
      ? runtime.toolCalls.map((call) => call.id === toolCall.id ? { ...call, ...toolCall } : call)
      : [...runtime.toolCalls, toolCall];
    return { runtimesByWindow: { ...state.runtimesByWindow, [windowId]: { ...runtime, toolCalls, updatedAt: new Date() } } };
  }),

  updateTelemetry: (windowId, patch) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime) return {};
    return { runtimesByWindow: { ...state.runtimesByWindow, [windowId]: { ...runtime, telemetry: { ...runtime.telemetry, ...patch }, updatedAt: new Date() } } };
  }),

  setFileClaims: (windowId, fileClaims) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime) return {};
    return { runtimesByWindow: { ...state.runtimesByWindow, [windowId]: { ...runtime, fileClaims, updatedAt: new Date() } } };
  }),

  setCanContinue: (windowId, canContinue) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime || runtime.canContinue === canContinue) return {};
    return { runtimesByWindow: { ...state.runtimesByWindow, [windowId]: { ...runtime, canContinue, updatedAt: new Date() } } };
  }),

  addAttachment: (windowId, attachment) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime) return {};
    return {
      runtimesByWindow: {
        ...state.runtimesByWindow,
        [windowId]: { ...runtime, attachments: [...runtime.attachments, attachment], updatedAt: new Date() },
      },
    };
  }),

  removeAttachment: (windowId, attachmentId) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime) return {};
    return {
      runtimesByWindow: {
        ...state.runtimesByWindow,
        [windowId]: {
          ...runtime,
          attachments: runtime.attachments.filter((attachment) => attachment.id !== attachmentId),
          updatedAt: new Date(),
        },
      },
    };
  }),

  clearAttachments: (windowId) => set((state) => {
    const runtime = state.runtimesByWindow[windowId];
    if (!runtime || runtime.attachments.length === 0) return {};
    return { runtimesByWindow: { ...state.runtimesByWindow, [windowId]: { ...runtime, attachments: [], updatedAt: new Date() } } };
  }),

  cancelRun: (windowId) => {
    const runtime = get().runtimesByWindow[windowId];
    if (!runtime) return [];
    runtime.abortController?.abort();
    const streamIds = [...runtime.activeStreamIds];
    get().finishRun(windowId, 'cancelled');
    return streamIds;
  },

  evictRuntime: (windowId) => set((state) => {
    if (!state.runtimesByWindow[windowId]) return {};
    const { [windowId]: _removed, ...runtimesByWindow } = state.runtimesByWindow;
    return { runtimesByWindow };
  }),

  appendParentEvent: (event) => set((state) => {
    const next: ParentAgentEvent = { ...event, id: createId('agent-event'), createdAt: new Date() };
    const events = [next, ...(state.parentEventsBySession[event.parentSessionId] ?? [])].slice(0, 25);
    return {
      parentEventsBySession: {
        ...state.parentEventsBySession,
        [event.parentSessionId]: events,
      },
    };
  }),

  reset: () => set({ runtimesByWindow: {}, parentEventsBySession: {} }),
}));
