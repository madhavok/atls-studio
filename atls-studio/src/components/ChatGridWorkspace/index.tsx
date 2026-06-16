import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react';
import { useAppStore, type ChatSession, type Message } from '../../stores/appStore';
import { useSwarmStore, type AgentMessage, type SwarmTask } from '../../stores/swarmStore';
import { useRoundHistoryStore } from '../../stores/roundHistoryStore';
import {
  useAgentWindowStore,
  type AgentWindow,
  type AgentWindowColor,
  type AgentWindowStatus,
  type ArrangeStrategy,
  type PanelKind,
} from '../../stores/agentWindowStore';
import { chatDb } from '../../services/chatDb';
import { ChatTelemetryPane } from './ChatTelemetryPane';
import { AgentChatSurface } from './AgentChatSurface';
import { ConversationSelector } from './ConversationSelector';
import { GridErrorBoundary } from './GridErrorBoundary';
import { CanvasFrame } from './CanvasFrame';
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore';
import { activateAgentWindow, activateAgentParentSession } from '../../services/activateAgentWindow';
import { evictContextPartition, persistContextSession } from '../../services/contextSessionPartition';
import { disposeParentSessionRuntimes, disposeWindowRuntime } from '../../services/agentGridLifecycle';
import { useAgentGridPersistence } from '../../hooks/useAgentGridPersistence';
import { canRecoverSwarmTask, canStopSwarmTask, pauseSwarmTask, recoverSwarmTask, syncSwarmSelection } from '../../services/swarmWindowBridge';
import { ModelModeSelector } from '../ModelModeSelector';
import { Settings } from '../Settings';
import { MissionControlBody, TelemetryBody, RuntimeContextBody, AgentTerminalBody } from '../OrchestrationCockpit';

export type ChatGridVariant = 'primary' | 'dock';

interface ChatGridWorkspaceProps {
  variant?: ChatGridVariant;
}

type SessionPreviewMap = Record<string, Message[]>;

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

const PANEL_OPTIONS: Array<{ kind: PanelKind; label: string }> = [
  { kind: 'mission', label: 'Mission Control' },
  { kind: 'telemetry', label: 'Telemetry' },
  { kind: 'context', label: 'Runtime Context' },
  { kind: 'terminal', label: 'Agent Terminal' },
];

function kindLabelFor(window: AgentWindow): string {
  switch (window.kind) {
    case 'primary': return 'parent session';
    case 'swarm': return 'managed swarm window';
    case 'panel': return 'cockpit panel';
    default: return 'standard agent session';
  }
}

function projectLabelFor(window: AgentWindow): string | undefined {
  if (!window.projectPath) return undefined;
  return window.projectPath.split(/[/\\]/).filter(Boolean).pop();
}

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

function PanelBody({ panelKind }: { panelKind: PanelKind | undefined }) {
  switch (panelKind) {
    case 'mission': return <div className="h-full overflow-y-auto p-3"><MissionControlBody /></div>;
    case 'telemetry': return <div className="h-full overflow-y-auto p-3"><TelemetryBody /></div>;
    case 'context': return <div className="h-full overflow-y-auto p-3"><RuntimeContextBody /></div>;
    case 'terminal': return <div className="h-full min-h-0 p-2"><AgentTerminalBody /></div>;
    default: return <div className="p-4 text-xs text-studio-muted">Unknown panel.</div>;
  }
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
  const addToast = useAppStore((s) => s.addToast);
  const hydrateProject = useAgentWindowStore((s) => s.hydrateProject);
  const setActiveParentSession = useAgentWindowStore((s) => s.setActiveParentSession);
  const ensurePrimaryWindow = useAgentWindowStore((s) => s.ensurePrimaryWindow);
  const ensurePanelWindow = useAgentWindowStore((s) => s.ensurePanelWindow);
  const removeWindow = useAgentWindowStore((s) => s.removeWindow);
  const closeParentSession = useAgentWindowStore((s) => s.closeParentSession);
  const selectWindow = useAgentWindowStore((s) => s.selectWindow);
  const renameWindow = useAgentWindowStore((s) => s.renameWindow);
  const setTelemetryCollapsed = useAgentWindowStore((s) => s.setTelemetryCollapsed);
  const moveWindow = useAgentWindowStore((s) => s.moveWindow);
  const resizeWindow = useAgentWindowStore((s) => s.resizeWindow);
  const bringToFront = useAgentWindowStore((s) => s.bringToFront);
  const toggleMinimized = useAgentWindowStore((s) => s.toggleMinimized);
  const togglePinned = useAgentWindowStore((s) => s.togglePinned);
  const autoArrange = useAgentWindowStore((s) => s.autoArrange);
  const setPan = useAgentWindowStore((s) => s.setPan);
  const setZoom = useAgentWindowStore((s) => s.setZoom);
  const viewport = useAgentWindowStore((s) => s.viewport);
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
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [recoveringSwarmTaskId, setRecoveringSwarmTaskId] = useState<string | null>(null);
  useAgentGridPersistence();

  const activeGroupId = activeParentSessionId ?? currentSessionId ?? 'draft-parent';
  const parentEvents = useAgentRuntimeStore((s) => s.parentEventsBySession[activeGroupId] ?? EMPTY_PARENT_EVENTS);
  const activeParentSession = chatSessions.find((session) => session.id === activeGroupId);
  const windows = useMemo(() => Object.values(windowsByParent).flat(), [windowsByParent]);
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
      .filter((window) => window.kind === 'swarm' ? false : window.kind !== 'panel' && window.sessionId !== currentSessionId && !previewBySession[window.sessionId])
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

  const selectAndLoadWindow = useCallback(async (window: AgentWindow) => {
    if (window.kind === 'panel') {
      selectWindow(window.parentSessionId, window.windowId);
      return;
    }
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
    const targetProjectPath = useAgentWindowStore.getState().projectPath ?? useAppStore.getState().projectPath;
    await activateAgentParentSession(sessionId, title, targetProjectPath);
  }, [addToast, chatSessions]);

  const addPanel = useCallback((panelKind: PanelKind, label: string) => {
    ensurePanelWindow(activeGroupId, panelKind, label);
    setPanelMenuOpen(false);
  }, [activeGroupId, ensurePanelWindow]);

  const focusChildWindow = useCallback((childWindowId: string) => {
    const window = Object.values(useAgentWindowStore.getState().windowsByParent)
      .flat()
      .find((candidate) => candidate.windowId === childWindowId);
    if (!window) return;
    void selectAndLoadWindow(window);
  }, [selectAndLoadWindow]);

  // Windows visible on the flat canvas: all sessions/projects, swarm windows only when their task is live.
  const renderedWindows = useMemo(() => windows.filter((window) => {
    if (window.kind !== 'swarm') return true;
    return swarmTasks.some((task) => `swarm-${task.id}` === window.windowId);
  }), [swarmTasks, windows]);

  const closeWindow = useCallback((window: AgentWindow) => {
    if (window.kind === 'standard' || window.kind === 'panel') {
      void disposeWindowRuntime(window.windowId).finally(() => {
        removeWindow(window.parentSessionId, window.windowId);
      });
      return;
    }
    if (window.kind !== 'primary') return;

    const closeParent = () => {
      void disposeParentSessionRuntimes(window.parentSessionId).finally(() => {
        void persistContextSession(window.sessionId, { toDb: true }).finally(() => {
          evictContextPartition(window.sessionId);
          closeParentSession(window.parentSessionId);
        });
      });
    };

    if (window.sessionId !== currentSessionId) {
      closeParent();
      return;
    }

    // Closing the active session window: switch to another session first, otherwise
    // the ensure-primary effect would immediately recreate it.
    const next = Object.values(useAgentWindowStore.getState().windowsByParent)
      .flat()
      .find((candidate) => candidate.kind === 'primary' && candidate.windowId !== window.windowId);
    if (!next) {
      addToast({ type: 'info', message: 'This is the only session window. Create another session before closing it.' });
      return;
    }
    void activateAgentParentSession(next.sessionId, next.title, next.projectPath).finally(closeParent);
  }, [addToast, closeParentSession, currentSessionId, removeWindow]);

  const computeRounds = useCallback((window: AgentWindow): { active: number; total: number; live: boolean } => {
    const runtime = runtimesByWindow[window.windowId];
    if (window.kind === 'standard' || window.kind === 'primary') {
      const live = Boolean(runtime?.isGenerating || runtime?.proxyActive);
      return { active: live ? 1 : 0, total: runtime?.telemetry.rounds ?? 0, live };
    }
    if (window.kind === 'panel') return { active: 0, total: 0, live: false };
    // swarm
    const live = window.sessionId === currentSessionId;
    const preview = previewBySession[window.sessionId] ?? [];
    const total = live ? promptMetrics.roundCount || getRoundCount(messages) : getRoundCount(preview);
    const active = live && isGenerating ? Math.max(1, useAppStore.getState().agentProgress.round) : 0;
    return { active, total, live };
  }, [currentSessionId, isGenerating, messages, previewBySession, promptMetrics.roundCount, runtimesByWindow]);

  const renderWindowBody = useCallback((window: AgentWindow): ReactNode => {
    if (window.kind === 'panel') return <PanelBody panelKind={window.panelKind} />;
    if (window.kind === 'standard' || window.kind === 'primary') {
      return (
        <GridErrorBoundary windowId={window.windowId}>
          <AgentChatSurface window={window} showControls onOpenOptions={() => setOptionsModalOpen(true)} />
        </GridErrorBoundary>
      );
    }
    const task = swarmTasks.find((candidate) => `swarm-${candidate.id}` === window.windowId);
    if (task) return <SwarmTranscript task={task} />;
    return <TranscriptPreview messages={previewBySession[window.sessionId] ?? []} emptyText="Select this managed swarm window to inspect it." />;
  }, [previewBySession, swarmTasks]);

  const renderWindowActions = useCallback((window: AgentWindow): ReactNode => {
    if (window.kind !== 'swarm') return null;
    const task = swarmTasks.find((candidate) => `swarm-${candidate.id}` === window.windowId);
    return (
      <>
        {task && canStopSwarmTask(task) && (
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); pauseSwarmTask(task); }}
            className="rounded-full border border-red-400/40 px-2 py-0.5 text-[9px] uppercase tracking-wide text-red-200 hover:bg-red-500/10"
          >
            Stop
          </button>
        )}
        {task && canRecoverSwarmTask(task) && (
          <button
            type="button"
            disabled={recoveringSwarmTaskId === task.id}
            onClick={(event) => {
              event.stopPropagation();
              setRecoveringSwarmTaskId(task.id);
              void recoverSwarmTask(task).then((result) => {
                if (!result.ok && result.error) addToast({ type: 'error', message: result.error });
              }).finally(() => setRecoveringSwarmTaskId(null));
            }}
            className="rounded-full border border-yellow-500/40 px-2 py-0.5 text-[9px] uppercase tracking-wide text-yellow-200 disabled:opacity-60"
          >
            {recoveringSwarmTaskId === task.id ? 'Queuing' : task.status === 'awaiting_input' ? 'Continue' : 'Recover'}
          </button>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            if (task) syncSwarmSelection(task.id, window.parentSessionId);
            useAgentWindowStore.getState().ensurePanelWindow(window.parentSessionId, 'mission', 'Mission Control');
          }}
          className="rounded-full border border-studio-title/40 px-2 py-0.5 text-[9px] uppercase tracking-wide text-studio-title"
          title="Open Mission Control panel"
        >
          Mission
        </button>
      </>
    );
  }, [addToast, recoveringSwarmTaskId, swarmTasks]);

  const toolbar = (
    <div className="border-b border-studio-border bg-gradient-to-r from-studio-surface/95 via-studio-bg/80 to-studio-surface/80 px-3 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
      <div className="flex flex-wrap items-center gap-2">
        <ConversationSelector
          projectPath={projectPath}
          chatSessions={chatSessions}
          activeParentSessionId={activeGroupId}
          onCreateSession={() => { void createParentSession(); }}
        />
        <div className="min-w-0 flex-1">
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-studio-title">Agent Canvas</h2>
          <p className="truncate text-[10px] text-studio-muted">
            {chatMode} / {renderedWindows.length} windows{swarmActive ? ` / swarm ${swarmStatus}` : ''}
          </p>
        </div>
        {variant === 'primary' && (
          <div className="flex items-center gap-1">
            <span className="font-mono text-[9px] uppercase tracking-wide text-studio-muted">Arrange</span>
            {(['grid', 'tidy', 'cascade'] as ArrangeStrategy[]).map((strategy) => (
              <button
                key={strategy}
                type="button"
                onClick={() => autoArrange(strategy)}
                className={`rounded border px-2 py-1 text-[10px] capitalize ${viewport.arrangeStrategy === strategy ? 'border-studio-title/60 text-studio-title' : 'border-studio-border text-studio-muted hover:text-studio-text'}`}
                title={strategy === 'tidy' ? 'Tidy by project' : `Auto-arrange (${strategy})`}
              >
                {strategy === 'tidy' ? 'By project' : strategy}
              </button>
            ))}
            <div className="mx-1 h-5 w-px bg-studio-border" />
            <button type="button" onClick={() => setZoom(viewport.zoom - 0.1)} className="rounded border border-studio-border px-2 py-1 text-[10px] text-studio-muted hover:text-studio-text" title="Zoom out">−</button>
            <button type="button" onClick={() => setZoom(1)} className="rounded border border-studio-border px-2 py-1 font-mono text-[10px] text-studio-muted hover:text-studio-text" title="Reset zoom">{Math.round(viewport.zoom * 100)}%</button>
            <button type="button" onClick={() => setZoom(viewport.zoom + 0.1)} className="rounded border border-studio-border px-2 py-1 text-[10px] text-studio-muted hover:text-studio-text" title="Zoom in">+</button>
            <button type="button" onClick={() => setPan({ x: 0, y: 0 })} className="rounded border border-studio-border px-2 py-1 text-[10px] text-studio-muted hover:text-studio-text" title="Reset pan">Center</button>
            <div className="mx-1 h-5 w-px bg-studio-border" />
            <div className="relative">
              <button
                type="button"
                onClick={() => setPanelMenuOpen((open) => !open)}
                className="rounded border border-studio-border px-2 py-1 text-[10px] text-studio-muted hover:text-studio-text"
              >
                + Panel
              </button>
              {panelMenuOpen && (
                <div className="absolute right-0 z-30 mt-1 w-40 rounded border border-studio-border bg-studio-surface p-1 shadow-xl">
                  {PANEL_OPTIONS.map((option) => (
                    <button
                      key={option.kind}
                      type="button"
                      onClick={() => addPanel(option.kind, option.label)}
                      className="block w-full rounded px-2 py-1 text-left text-[10px] text-studio-muted hover:bg-studio-border/40 hover:text-studio-text"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => { void createParentSession(); }}
          className="rounded-lg border border-studio-title/50 bg-studio-title/10 px-3 py-1.5 text-[10px] uppercase tracking-wide text-studio-title shadow-[0_0_22px_rgba(34,211,238,0.10)] hover:border-studio-title"
        >
          New Session
        </button>
      </div>
    </div>
  );

  const body = variant === 'dock'
    ? (
      <DockStack
        windows={renderedWindows}
        selectedWindowId={selectedWindowId}
        currentSessionId={currentSessionId}
        runtimesByWindow={runtimesByWindow}
        onSelect={(window) => { void selectAndLoadWindow(window); }}
        renderBody={renderWindowBody}
      />
    )
    : (
      <CanvasSurface
        pan={viewport.pan}
        zoom={viewport.zoom}
        onPan={setPan}
        onZoom={setZoom}
      >
        {renderedWindows.map((window) => {
          const selected = window.windowId === selectedWindowId;
          const { active, total } = computeRounds(window);
          return (
            <CanvasFrame
              key={window.windowId}
              window={window}
              selected={selected}
              active={active > 0}
              zoom={viewport.zoom}
              activeRounds={active}
              totalRounds={total}
              colorClass={COLOR_CLASSES[window.groupColor]}
              colorText={COLOR_TEXT[window.groupColor]}
              kindLabel={kindLabelFor(window)}
              projectLabel={projectLabelFor(window)}
              onSelect={() => { void selectAndLoadWindow(window); }}
              onMove={(x, y) => moveWindow(window.windowId, x, y)}
              onResize={(w, h) => resizeWindow(window.windowId, w, h)}
              onBringToFront={() => bringToFront(window.windowId)}
              onToggleMinimized={() => toggleMinimized(window.windowId)}
              onTogglePinned={() => togglePinned(window.windowId)}
              onClose={window.kind === 'swarm' ? undefined : () => closeWindow(window)}
              actions={renderWindowActions(window)}
              testId={window.kind === 'primary' ? 'primary-chat-window' : window.kind === 'panel' ? `panel-window-${window.panelKind}` : window.kind === 'swarm' ? `swarm-chat-window-${window.windowId.replace(/^swarm-/, '')}` : `agent-chat-window-${window.windowId}`}
            >
              {renderWindowBody(window)}
            </CanvasFrame>
          );
        })}
      </CanvasSurface>
    );

  return (
    <div className="h-full min-h-0 overflow-hidden bg-studio-bg text-studio-text" data-testid={`chat-grid-${variant}`}>
      <div className="flex h-full min-h-0">
        <div className="flex min-w-0 flex-1 flex-col">
          {toolbar}
          <div className="relative min-h-0 flex-1 overflow-hidden">{body}</div>
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

function CanvasSurface({
  pan,
  zoom,
  onPan,
  onZoom,
  children,
}: {
  pan: { x: number; y: number };
  zoom: number;
  onPan: (pan: { x: number; y: number }) => void;
  onZoom: (zoom: number) => void;
  children: ReactNode;
}) {
  const [localPan, setLocalPan] = useState(pan);
  const panRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    if (!panRef.current) setLocalPan(pan);
  }, [pan]);

  const onBackgroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    panRef.current = { startX: event.clientX, startY: event.clientY, origX: localPan.x, origY: localPan.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onBackgroundPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    setLocalPan({
      x: pan.origX + (event.clientX - pan.startX),
      y: pan.origY + (event.clientY - pan.startY),
    });
  };
  const onBackgroundPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panRef.current) return;
    panRef.current = null;
    onPan(localPan);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    onZoom(zoom - Math.sign(event.deltaY) * 0.1);
  };

  return (
    <div
      className="absolute inset-0 cursor-grab overflow-hidden bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.05)_1px,transparent_0)] [background-size:24px_24px] active:cursor-grabbing"
      data-testid="agent-canvas-surface"
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={onBackgroundPointerUp}
      onWheel={onWheel}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${localPan.x}px, ${localPan.y}px) scale(${zoom})` }}
      >
        {children}
      </div>
    </div>
  );
}

function DockStack({
  windows,
  selectedWindowId,
  currentSessionId,
  runtimesByWindow,
  onSelect,
  renderBody,
}: {
  windows: AgentWindow[];
  selectedWindowId: string;
  currentSessionId: string | null;
  runtimesByWindow: ReturnType<typeof useAgentRuntimeStore.getState>['runtimesByWindow'];
  onSelect: (window: AgentWindow) => void;
  renderBody: (window: AgentWindow) => ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="grid grid-cols-1 gap-3">
        {windows.map((window) => {
          const runtime = runtimesByWindow[window.windowId];
          const active = window.kind === 'standard' || window.kind === 'primary'
            ? Boolean(runtime?.isGenerating || runtime?.proxyActive)
            : window.sessionId === currentSessionId;
          const selected = window.windowId === selectedWindowId;
          return (
            <section
              key={window.windowId}
              className={`flex h-[520px] flex-col overflow-hidden rounded-xl border bg-studio-surface/70 shadow-2xl backdrop-blur-sm ${COLOR_CLASSES[window.groupColor]} ${selected ? 'ring-1 ring-studio-title/40' : ''}`}
              onClick={() => onSelect(window)}
              data-testid={window.kind === 'primary' ? 'primary-chat-window' : `agent-chat-window-${window.windowId}`}
            >
              <div className="border-b border-studio-border/70 bg-studio-bg/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-emerald-400' : selected ? 'bg-studio-title' : 'bg-studio-border'}`} />
                  <div className={`truncate text-xs font-semibold ${COLOR_TEXT[window.groupColor]}`}>{window.title}</div>
                  <span className="ml-auto rounded-full border border-studio-border/60 bg-studio-bg/60 px-2 py-0.5 font-mono text-[9px] uppercase text-studio-muted">{window.status}</span>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">{renderBody(window)}</div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export default ChatGridWorkspace;
