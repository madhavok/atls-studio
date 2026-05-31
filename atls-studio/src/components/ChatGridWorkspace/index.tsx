import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppStore, type ChatSession, type Message } from '../../stores/appStore';
import { useSwarmStore, type AgentMessage, type SwarmTask } from '../../stores/swarmStore';
import { useRoundHistoryStore } from '../../stores/roundHistoryStore';
import {
  useAgentWindowStore,
  type AgentWindow,
  type AgentWindowColor,
  type AgentWindowStatus,
} from '../../stores/agentWindowStore';
import { SWARM_ORCHESTRATION_TAB_ID } from '../../constants/swarmOrchestrationTab';
import { chatDb } from '../../services/chatDb';
import { ChatTelemetryPane } from './ChatTelemetryPane';
import { AgentChatSurface } from './AgentChatSurface';
import { ConversationSelector } from './ConversationSelector';
import { GridErrorBoundary } from './GridErrorBoundary';
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore';
import { activateAgentWindow } from '../../services/activateAgentWindow';
import { writeLastActiveSessionId } from '../../services/lastActiveSession';
import { disposeParentSessionRuntimes, disposeWindowRuntime } from '../../services/agentGridLifecycle';
import { canRecoverSwarmTask, canStopSwarmTask, pauseSwarmTask, recoverSwarmTask, syncSwarmSelection } from '../../services/swarmWindowBridge';
import { ModelModeSelector } from '../ModelModeSelector';
import { Settings } from '../Settings';

export type ChatGridVariant = 'primary' | 'dock';

interface ChatGridWorkspaceProps {
  variant?: ChatGridVariant;
}

type SessionPreviewMap = Record<string, Message[]>;

const EMPTY_WINDOWS: AgentWindow[] = [];
const EMPTY_PARENT_EVENTS: ReturnType<typeof useAgentRuntimeStore.getState>['parentEventsBySession'][string] = [];

const COLOR_CLASSES: Record<AgentWindowColor, string> = {
  cyan: 'border-cyan-400/60 shadow-cyan-500/10',
  violet: 'border-violet-400/60 shadow-violet-500/10',
  emerald: 'border-emerald-400/60 shadow-emerald-500/10',
  amber: 'border-amber-400/60 shadow-amber-500/10',
  rose: 'border-rose-400/60 shadow-rose-500/10',
  blue: 'border-blue-400/60 shadow-blue-500/10',
};

const COLOR_TEXT: Record<AgentWindowColor, string> = {
  cyan: 'text-cyan-300',
  violet: 'text-violet-300',
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  rose: 'text-rose-300',
  blue: 'text-blue-300',
};

function createSessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function getSessionTitle(session: ChatSession | undefined, fallback: string): string {
  return session?.title?.trim() || fallback;
}

function getRoundCount(messages: Message[]): number {
  return messages.filter((message) => message.role === 'assistant').length;
}

function normalizeSwarmStatus(status: SwarmTask['status']): AgentWindowStatus {
  if (status === 'running' || status === 'pending' || status === 'awaiting_input') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'idle';
}

function WindowHeader({
  window,
  selected,
  active,
  activeRounds,
  totalRounds,
  actions,
}: {
  window: AgentWindow;
  selected: boolean;
  active: boolean;
  activeRounds: number;
  totalRounds: number;
  actions?: ReactNode;
}) {
  return (
    <div className="border-b border-studio-border/70 bg-gradient-to-r from-studio-bg/90 via-studio-surface/55 to-studio-bg/65 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-emerald-400' : selected ? 'bg-studio-title' : 'bg-studio-border'}`} />
        <div className="min-w-0 flex-1">
          <div className={`truncate text-xs font-semibold ${COLOR_TEXT[window.groupColor]}`}>{window.title}</div>
          <div className="truncate font-mono text-[9px] uppercase tracking-[0.16em] text-studio-muted">
            {window.kind === 'primary' ? 'parent session' : window.kind === 'swarm' ? 'managed swarm window' : 'standard agent session'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="rounded-full border border-studio-border/60 bg-studio-bg/60 px-2 py-0.5 font-mono text-[9px] uppercase text-studio-muted">
            {window.status}
          </span>
          <span className="rounded-full border border-studio-title/20 bg-studio-title/10 px-2 py-0.5 font-mono text-[9px] text-studio-title" title="Active session rounds / total session rounds">
            {activeRounds}/{totalRounds} rnd
          </span>
          {actions}
        </div>
      </div>
    </div>
  );
}

function ChatWindowShell({
  window,
  selected,
  active,
  activeRounds,
  totalRounds,
  onSelect,
  children,
  actions,
  testId,
}: {
  window: AgentWindow;
  selected: boolean;
  active: boolean;
  activeRounds: number;
  totalRounds: number;
  onSelect: () => void;
  children: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className={`group flex h-[520px] min-h-[420px] max-h-[calc(100vh-9rem)] flex-col overflow-hidden rounded-xl border bg-studio-surface/70 shadow-2xl backdrop-blur-sm transition-colors ${COLOR_CLASSES[window.groupColor]} ${
        selected ? 'ring-1 ring-studio-title/40' : 'hover:border-studio-title/35'
      }`}
      data-testid={testId}
      onClick={onSelect}
    >
      <WindowHeader
        window={window}
        selected={selected}
        active={active}
        activeRounds={activeRounds}
        totalRounds={totalRounds}
        actions={actions}
      />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  );
}

function TranscriptPreview({ messages, emptyText }: { messages: Message[]; emptyText: string }) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-studio-muted">
        {emptyText}
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto p-3 text-xs">
      <div className="space-y-2">
        {messages.slice(-5).map((message) => (
          <div key={message.id} className="rounded-lg border border-studio-border/50 bg-studio-bg/45 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-studio-muted">{message.role}</div>
            <div className="line-clamp-4 whitespace-pre-wrap leading-relaxed text-studio-text">{message.content}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SwarmTranscript({ task }: { task: SwarmTask }) {
  const messages = task.conversationLog.map((message: AgentMessage): Message => ({
    id: message.id,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.toolName ? `${message.toolName}: ${message.content}` : message.content,
    timestamp: message.timestamp,
  }));
  return <TranscriptPreview messages={messages} emptyText="This managed swarm window has not emitted a transcript yet." />;
}

function ChatOptionsModal({
  open,
  onClose,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-6 pt-20"
      data-testid="chat-options-modal"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl overflow-visible rounded-xl border border-studio-border bg-studio-surface shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-studio-border px-3 py-2">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-studio-title">Chat Options</div>
            <div className="text-[10px] text-studio-muted">Shared model, mode, routing, and generation controls</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenSettings}
              className="rounded-lg border border-studio-title/40 bg-studio-title/10 px-2 py-1 text-[10px] uppercase tracking-wide text-studio-title"
              title="Settings"
            >
              Settings
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-studio-border px-2 py-1 text-[10px] uppercase tracking-wide text-studio-muted hover:text-studio-text"
            >
              Close
            </button>
          </div>
        </div>
        <div className="overflow-visible">
          <ModelModeSelector menuPlacement="down" />
        </div>
      </div>
    </div>
  );
}

export const ChatGridWorkspace = memo(function ChatGridWorkspace({ variant = 'primary' }: ChatGridWorkspaceProps) {
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const chatMode = useAppStore((s) => s.chatMode);
  const messages = useAppStore((s) => s.messages);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const contextUsage = useAppStore((s) => s.contextUsage);
  const promptMetrics = useAppStore((s) => s.promptMetrics);
  const chatSessions = useAppStore((s) => s.chatSessions);
  const projectPath = useAppStore((s) => s.projectPath);
  const openFile = useAppStore((s) => s.openFile);
  const addToast = useAppStore((s) => s.addToast);
  const hydrateProject = useAgentWindowStore((s) => s.hydrateProject);
  const setActiveParentSession = useAgentWindowStore((s) => s.setActiveParentSession);
  const ensurePrimaryWindow = useAgentWindowStore((s) => s.ensurePrimaryWindow);
  const removeWindow = useAgentWindowStore((s) => s.removeWindow);
  const closeParentSession = useAgentWindowStore((s) => s.closeParentSession);
  const selectWindow = useAgentWindowStore((s) => s.selectWindow);
  const renameWindow = useAgentWindowStore((s) => s.renameWindow);
  const setTelemetryCollapsed = useAgentWindowStore((s) => s.setTelemetryCollapsed);
  const activeParentSessionId = useAgentWindowStore((s) => s.activeParentSessionId);
  const windowsByParent = useAgentWindowStore((s) => s.windowsByParent);
  const selectedWindowByParent = useAgentWindowStore((s) => s.selectedWindowByParent);
  const swarmTasks = useSwarmStore((s) => s.tasks);
  const swarmStats = useSwarmStore((s) => s.stats);
  const swarmActive = useSwarmStore((s) => s.isActive);
  const swarmStatus = useSwarmStore((s) => s.status);
  const snapshots = useRoundHistoryStore((s) => s.snapshots);
  const runtimesByWindow = useAgentRuntimeStore((s) => s.runtimesByWindow);
  const [previewBySession, setPreviewBySession] = useState<SessionPreviewMap>({});
  const [optionsModalOpen, setOptionsModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recoveringSwarmTaskId, setRecoveringSwarmTaskId] = useState<string | null>(null);

  const activeGroupId = activeParentSessionId ?? currentSessionId ?? 'draft-parent';
  const parentEvents = useAgentRuntimeStore((s) => s.parentEventsBySession[activeGroupId] ?? EMPTY_PARENT_EVENTS);
  const activeParentSession = chatSessions.find((session) => session.id === activeGroupId);
  const windows = useMemo(() => {
    const flattened = Object.values(windowsByParent).flat();
    return flattened.length > 0 ? flattened : EMPTY_WINDOWS;
  }, [windowsByParent]);
  const selectedWindowId = selectedWindowByParent[activeGroupId] ?? `primary-${activeGroupId}`;
  const telemetryCollapsed = useAgentWindowStore((s) => s.telemetryCollapsedByParent[activeGroupId] ?? variant === 'dock');

  useEffect(() => {
    hydrateProject(projectPath, chatSessions);
  }, [chatSessions, hydrateProject, projectPath]);

  useEffect(() => {
    if (currentSessionId && !activeParentSessionId) setActiveParentSession(currentSessionId);
  }, [activeParentSessionId, currentSessionId, setActiveParentSession]);

  useEffect(() => {
    if (!currentSessionId) return;
    const currentSession = chatSessions.find((session) => session.id === currentSessionId);
    ensurePrimaryWindow(currentSessionId, getSessionTitle(currentSession, 'Primary Chat'));
  }, [chatSessions, currentSessionId, ensurePrimaryWindow]);

  useEffect(() => {
    if (!activeParentSessionId) return;
    ensurePrimaryWindow(activeParentSessionId, getSessionTitle(activeParentSession, 'Primary Chat'));
  }, [activeParentSession, activeParentSessionId, ensurePrimaryWindow]);

  useEffect(() => {
    for (const window of windows) {
      if (window.kind !== 'primary') continue;
      const session = chatSessions.find((candidate) => candidate.id === window.sessionId);
      if (!session) continue;
      const title = getSessionTitle(session, window.title);
      if (title !== window.title) renameWindow(window.windowId, title);
    }
  }, [chatSessions, renameWindow, windows]);

  useEffect(() => {
    for (const task of swarmTasks) {
      useAgentWindowStore.getState().upsertSwarmWindow(
        activeGroupId,
        task.id,
        task.title,
        task.assignedRole,
        normalizeSwarmStatus(task.status),
      );
    }
  }, [activeGroupId, swarmTasks]);

  useEffect(() => {
    if (!chatDb.isInitialized()) return;
    let cancelled = false;
    const missing = windows
      .filter((window) => window.kind !== 'swarm' && window.sessionId !== currentSessionId && !previewBySession[window.sessionId])
      .map((window) => window.sessionId);
    if (missing.length === 0) return;
    void Promise.all(missing.map(async (sessionId) => {
      try {
        const result = await chatDb.loadFullSession(sessionId);
        return [sessionId, result?.messages ?? []] as const;
      } catch {
        return [sessionId, []] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setPreviewBySession((current) => ({
        ...current,
        ...Object.fromEntries(entries),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, previewBySession, windows]);

  const selectedWindow = windows.find((window) => window.windowId === selectedWindowId) ?? windows[0];
  const gridClass = variant === 'dock'
    ? 'grid grid-cols-1 gap-3'
    : telemetryCollapsed
      ? 'grid grid-cols-1 gap-3 2xl:grid-cols-2'
      : 'grid grid-cols-1 gap-3 xl:grid-cols-2';

  const selectAndLoadWindow = useCallback(async (window: AgentWindow) => {
    await activateAgentWindow(window);
    selectWindow(window.parentSessionId, window.windowId);
    if (window.kind === 'swarm') {
      const taskId = window.windowId.replace(/^swarm-/, '');
      syncSwarmSelection(taskId, window.parentSessionId);
    }
  }, [selectWindow]);

  const createParentSession = useCallback(async () => {
    const existingCount = chatSessions.filter((session) => session.title.startsWith('Agent Session')).length;
    const title = `Agent Session ${existingCount + 1}`;
    const sessionId = createSessionId();
    if (chatDb.isInitialized()) {
      try {
        await chatDb.createSession('agent', title, sessionId);
      } catch (error) {
        addToast({
          type: 'error',
          message: `Agent session could not be created: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
    }
    useAppStore.setState((state) => ({
      chatSessions: [
        {
          id: sessionId,
          title,
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          contextUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0 },
        },
        ...state.chatSessions.filter((session) => session.id !== sessionId),
      ],
    }));
    ensurePrimaryWindow(sessionId, title);
    setActiveParentSession(sessionId);
    selectWindow(sessionId, `primary-${sessionId}`);
    const projectPath = useAgentWindowStore.getState().projectPath ?? useAppStore.getState().projectPath;
    if (projectPath) writeLastActiveSessionId(projectPath, sessionId);
    useAgentRuntimeStore.getState().ensureRuntime({
      windowId: `primary-${sessionId}`,
      sessionId,
      parentSessionId: sessionId,
    });
  }, [addToast, chatSessions, ensurePrimaryWindow, selectWindow, setActiveParentSession]);

  const focusChildWindow = useCallback((childWindowId: string) => {
    const window = Object.values(useAgentWindowStore.getState().windowsByParent)
      .flat()
      .find((candidate) => candidate.windowId === childWindowId);
    if (!window) return;
    void selectAndLoadWindow(window);
  }, [selectAndLoadWindow]);

  const renderedWindows = useMemo(() => windows.filter((window) => {
    if (window.parentSessionId !== activeGroupId) return false;
    if (window.kind !== 'swarm') return true;
    return swarmTasks.some((task) => `swarm-${task.id}` === window.windowId);
  }), [activeGroupId, swarmTasks, windows]);

  return (
    <div className="h-full min-h-0 overflow-hidden bg-studio-bg text-studio-text" data-testid={`chat-grid-${variant}`}>
      <div className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-studio-border bg-gradient-to-r from-studio-surface/95 via-studio-bg/80 to-studio-surface/80 px-3 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
            <div className="flex items-center gap-2">
              <ConversationSelector
                projectPath={projectPath}
                chatSessions={chatSessions}
                activeParentSessionId={activeGroupId}
                onCreateSession={() => { void createParentSession(); }}
              />
              <div className="min-w-0 flex-1">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-studio-title">Standard Agent Window Grid</h2>
                <p className="truncate text-[10px] text-studio-muted">
                  {chatMode} / {renderedWindows.length} session windows
                  {swarmActive ? ` / swarm ${swarmStatus}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { void createParentSession(); }}
                className="rounded-lg border border-studio-title/50 bg-studio-title/10 px-3 py-1.5 text-[10px] uppercase tracking-wide text-studio-title shadow-[0_0_22px_rgba(34,211,238,0.10)] hover:border-studio-title"
              >
                New Parent Session
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className={gridClass}>
              {renderedWindows.map((window) => {
                const selected = window.parentSessionId === activeGroupId && window.windowId === selectedWindowId;
                const runtime = runtimesByWindow[window.windowId];
                const active = window.kind === 'standard' || window.kind === 'primary'
                  ? Boolean(runtime?.isGenerating)
                  : window.sessionId === currentSessionId && window.kind !== 'swarm';
                const task = window.kind === 'swarm'
                  ? swarmTasks.find((candidate) => `swarm-${candidate.id}` === window.windowId)
                  : undefined;
                const previewMessages = window.kind === 'standard' || window.kind === 'primary'
                  ? []
                  : active
                  ? messages
                  : window.kind === 'swarm'
                    ? []
                    : previewBySession[window.sessionId] ?? [];
                const totalRounds = window.kind === 'standard' || window.kind === 'primary'
                  ? runtime?.telemetry.rounds ?? 0
                  : active
                  ? promptMetrics.roundCount || getRoundCount(messages)
                  : getRoundCount(previewMessages);
                const activeRounds = window.kind === 'standard' || window.kind === 'primary'
                  ? (runtime?.isGenerating ? 1 : 0)
                  : active && isGenerating
                  ? Math.max(1, useAppStore.getState().agentProgress.round)
                  : 0;

                return (
                  <ChatWindowShell
                    key={window.windowId}
                    window={window}
                    selected={selected}
                    active={active}
                    activeRounds={activeRounds}
                    totalRounds={totalRounds}
                    onSelect={() => { void selectAndLoadWindow(window); }}
                    testId={window.kind === 'primary' ? 'primary-chat-window' : window.kind === 'swarm' ? `swarm-chat-window-${task?.id ?? window.windowId}` : `agent-chat-window-${window.windowId}`}
                    actions={
                      <>
                        {window.kind === 'swarm' && task && canStopSwarmTask(task) && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              pauseSwarmTask(task);
                            }}
                            className="rounded-full border border-red-400/40 px-2 py-0.5 text-[9px] uppercase tracking-wide text-red-200 hover:bg-red-500/10"
                          >
                            Stop
                          </button>
                        )}
                        {window.kind === 'swarm' && task && canRecoverSwarmTask(task) && (
                          <button
                            type="button"
                            disabled={recoveringSwarmTaskId === task.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              setRecoveringSwarmTaskId(task.id);
                              void recoverSwarmTask(task).then((result) => {
                                if (!result.ok && result.error) {
                                  addToast({ type: 'error', message: result.error });
                                }
                              }).finally(() => setRecoveringSwarmTaskId(null));
                            }}
                            className="rounded-full border border-yellow-500/40 px-2 py-0.5 text-[9px] uppercase tracking-wide text-yellow-200 disabled:opacity-60"
                          >
                            {recoveringSwarmTaskId === task.id ? 'Queuing' : task.status === 'awaiting_input' ? 'Continue' : 'Recover'}
                          </button>
                        )}
                        {window.kind === 'swarm' && task && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              syncSwarmSelection(task.id, window.parentSessionId);
                              openFile(SWARM_ORCHESTRATION_TAB_ID);
                            }}
                            className="rounded-full border border-studio-title/40 px-2 py-0.5 text-[9px] uppercase tracking-wide text-studio-title"
                          >
                            Inspector
                          </button>
                        )}
                        {window.kind === 'swarm' && !task && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openFile(SWARM_ORCHESTRATION_TAB_ID);
                            }}
                            className="rounded-full border border-studio-title/40 px-2 py-0.5 text-[9px] uppercase tracking-wide text-studio-title"
                          >
                            Inspector
                          </button>
                        )}
                        {window.kind === 'standard' && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void disposeWindowRuntime(window.windowId).finally(() => {
                                removeWindow(window.parentSessionId, window.windowId);
                              });
                            }}
                            className="rounded-full border border-red-400/30 px-2 py-0.5 text-[9px] uppercase tracking-wide text-red-300 hover:bg-red-500/10"
                          >
                            Close
                          </button>
                        )}
                        {window.kind === 'primary' && window.sessionId !== currentSessionId && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void disposeParentSessionRuntimes(window.parentSessionId).finally(() => {
                                closeParentSession(window.parentSessionId);
                              });
                            }}
                            className="rounded-full border border-red-400/30 px-2 py-0.5 text-[9px] uppercase tracking-wide text-red-300 hover:bg-red-500/10"
                            title="Close parent session window"
                          >
                            Close
                          </button>
                        )}
                      </>
                    }
                  >
                    {window.kind === 'standard' || window.kind === 'primary' ? (
                      <GridErrorBoundary windowId={window.windowId}>
                        <AgentChatSurface
                          window={window}
                          showControls
                          onOpenOptions={() => setOptionsModalOpen(true)}
                        />
                      </GridErrorBoundary>
                    ) : task ? (
                      <SwarmTranscript task={task} />
                    ) : (
                      <TranscriptPreview
                        messages={previewMessages}
                        emptyText="Select this managed swarm window to inspect it."
                      />
                    )}
                  </ChatWindowShell>
                );
              })}
            </div>
          </div>
        </div>
        <ChatTelemetryPane
          selectedWindow={selectedWindow}
          windows={renderedWindows}
          sessions={chatSessions}
          currentSessionId={currentSessionId}
          messages={messages}
          contextUsage={contextUsage}
          promptMetrics={promptMetrics}
          snapshots={snapshots}
          swarmTasks={swarmTasks}
          swarmStats={swarmStats}
          runtimesByWindow={runtimesByWindow}
          parentEvents={parentEvents}
          onFocusChildWindow={focusChildWindow}
          collapsed={telemetryCollapsed}
          onToggleCollapsed={() => setTelemetryCollapsed(activeGroupId, !telemetryCollapsed)}
        />
      </div>
      <ChatOptionsModal
        open={optionsModalOpen}
        onClose={() => setOptionsModalOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Settings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
});

export default ChatGridWorkspace;
