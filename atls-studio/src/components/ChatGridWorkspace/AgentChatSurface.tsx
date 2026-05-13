import { memo, useEffect } from 'react';
import type { AgentWindow } from '../../stores/agentWindowStore';
import { chatDb } from '../../services/chatDb';
import { useAgentRuntimeStore, type AgentRuntimeMessage } from '../../stores/agentRuntimeStore';
import { useAgentWindowStore } from '../../stores/agentWindowStore';
import { useAppStore, type Message } from '../../stores/appStore';
import { useAgentWindowRunner } from '../../hooks/useAgentWindowRunner';

interface AgentChatSurfaceProps {
  window: AgentWindow;
}

function toRuntimeMessages(messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: Date }>): AgentRuntimeMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
  }));
}

function appMessagesToRuntime(messages: Message[]): AgentRuntimeMessage[] {
  return messages
    .filter((message): message is Message & { role: 'user' | 'assistant' } => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
    }));
}

export const AgentChatSurface = memo(function AgentChatSurface({ window }: AgentChatSurfaceProps) {
  const runtime = useAgentRuntimeStore((s) => s.runtimesByWindow[window.windowId]);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const appMessages = useAppStore((s) => s.messages);
  const ensureRuntime = useAgentRuntimeStore((s) => s.ensureRuntime);
  const hydrateRuntime = useAgentRuntimeStore((s) => s.hydrateRuntime);
  const setDraft = useAgentRuntimeStore((s) => s.setDraft);
  const { runWindow, cancelWindow } = useAgentWindowRunner();

  useEffect(() => {
    ensureRuntime({
      windowId: window.windowId,
      sessionId: window.sessionId,
      parentSessionId: window.parentSessionId,
      role: window.role,
    });
    const current = useAgentRuntimeStore.getState().runtimesByWindow[window.windowId];
    if (window.kind !== 'primary' && window.status === 'running' && !current?.isGenerating) {
      useAgentWindowStore.getState().setWindowStatus(window.windowId, 'paused');
      useAgentRuntimeStore.getState().appendMessage(window.windowId, {
        role: 'system',
        content: 'Recovered prior delegate window. Transcript is preserved; the live stream is no longer attached.',
      });
    }
  }, [ensureRuntime, window.kind, window.parentSessionId, window.role, window.sessionId, window.status, window.windowId]);

  useEffect(() => {
    if (window.kind !== 'primary' || window.sessionId !== currentSessionId || appMessages.length === 0) return;
    hydrateRuntime(window.windowId, appMessagesToRuntime(appMessages));
  }, [appMessages, currentSessionId, hydrateRuntime, window.kind, window.sessionId, window.windowId]);

  useEffect(() => {
    if (!chatDb.isInitialized()) return;
    let cancelled = false;
    void chatDb.loadFullSession(window.sessionId).then((result) => {
      if (cancelled || !result) return;
      hydrateRuntime(window.windowId, toRuntimeMessages(result.messages));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hydrateRuntime, window.sessionId, window.windowId]);

  const safeRuntime = runtime;
  if (!safeRuntime) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-center text-xs text-studio-muted">
        Initializing window runtime...
      </div>
    );
  }
  const canSend = safeRuntime.draft.trim().length > 0 && !safeRuntime.isGenerating;

  return (
    <div className="flex h-full min-h-0 flex-col" onClick={(event) => event.stopPropagation()}>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs" data-testid={`agent-runtime-transcript-${window.windowId}`}>
        {safeRuntime.messages.length === 0 && !safeRuntime.streamingText ? (
          <div className="flex h-full items-center justify-center text-center text-studio-muted">
            {window.role
              ? `Delegate ${window.role} is ready. Send a task or spawn it from a parent instruction.`
              : window.kind === 'primary'
                ? 'This parent session is ready for agentic chat.'
              : 'This agent window is ready for an independent task.'}
          </div>
        ) : (
          <div className="space-y-2">
            {safeRuntime.messages.map((message) => (
              <div
                key={message.id}
                className={`rounded-lg border p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${
                  message.role === 'user'
                    ? 'border-studio-title/35 bg-studio-title/10'
                    : message.role === 'system'
                      ? 'border-amber-400/25 bg-amber-500/8 text-amber-100/90'
                      : 'border-studio-border/50 bg-studio-bg/45'
                }`}
              >
                <div className="mb-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-studio-muted">
                  <span>{message.role}</span>
                  {message.toolName && <span className="truncate text-studio-title">{message.toolName}</span>}
                </div>
                <div className="whitespace-pre-wrap leading-relaxed text-studio-text">{message.content}</div>
              </div>
            ))}
            {safeRuntime.streamingText && (
              <div className="rounded-lg border border-cyan-400/30 bg-cyan-500/8 p-2">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-300">
                  {safeRuntime.isGenerating ? 'streaming' : 'latest stream'}
                </div>
                <div className="whitespace-pre-wrap leading-relaxed text-studio-text">{safeRuntime.streamingText}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {safeRuntime.lastError && (
        <div className="mx-3 mb-2 rounded-lg border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
          {safeRuntime.lastError}
        </div>
      )}

      <div className="border-t border-studio-border/70 bg-studio-bg/45 p-2">
        <textarea
          value={safeRuntime.draft}
          onChange={(event) => setDraft(window.windowId, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canSend) {
              void runWindow(window.windowId, safeRuntime.draft);
            }
          }}
          placeholder={window.role ? `Send task to ${window.role} delegate...` : window.kind === 'primary' ? 'Send a parent session task...' : 'Send an independent task...'}
          className="min-h-[58px] w-full resize-none rounded-lg border border-studio-border bg-studio-bg/80 px-2 py-1.5 text-xs text-studio-text placeholder:text-studio-muted focus:outline-none focus:ring-1 focus:ring-studio-title/40"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-studio-muted">
            {safeRuntime.isGenerating ? 'live stream active' : `${safeRuntime.telemetry.rounds} rounds`}
          </div>
          {safeRuntime.isGenerating ? (
            <button
              type="button"
              onClick={() => cancelWindow(window.windowId)}
              className="rounded-lg border border-red-400/50 bg-red-500/10 px-3 py-1 text-[10px] uppercase tracking-wide text-red-200"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              disabled={!canSend}
              onClick={() => { void runWindow(window.windowId, safeRuntime.draft); }}
              className="rounded-lg border border-studio-title/50 bg-studio-title/10 px-3 py-1 text-[10px] uppercase tracking-wide text-studio-title disabled:cursor-not-allowed disabled:opacity-50"
            >
              Run
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
