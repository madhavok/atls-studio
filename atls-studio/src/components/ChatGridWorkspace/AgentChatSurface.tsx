import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { AgentWindow } from '../../stores/agentWindowStore';
import { chatDb } from '../../services/chatDb';
import { useAgentRuntimeStore, type AgentRuntimeMessage } from '../../stores/agentRuntimeStore';
import { useAgentWindowStore } from '../../stores/agentWindowStore';
import { useAgentWindowRunner } from '../../hooks/useAgentWindowRunner';
import { useAppStore } from '../../stores/appStore';
import { AgentAttachmentBar } from './AgentAttachmentBar';
import { AgentToolTrace } from './AgentToolTrace';
import { syncShellToProjectPath } from '../../services/agentShellSync';

interface AgentChatSurfaceProps {
  window: AgentWindow;
  showControls?: boolean;
  onOpenOptions?: () => void;
}

function toRuntimeMessages(messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: Date }>): AgentRuntimeMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
  }));
}

export const AgentChatSurface = memo(function AgentChatSurface({ window, showControls = false, onOpenOptions }: AgentChatSurfaceProps) {
  const runtime = useAgentRuntimeStore((s) => s.runtimesByWindow[window.windowId]);
  const settings = useAppStore((s) => s.settings);
  const rootFolders = useAppStore((s) => s.rootFolders);
  const activeRoot = useAppStore((s) => s.activeRoot);
  const projectPath = useAppStore((s) => s.projectPath);
  const setWindowProjectPath = useAgentWindowStore((s) => s.setWindowProjectPath);
  const selectedWindowId = useAgentWindowStore((s) => s.selectedWindowByParent[window.parentSessionId]);
  const availableModels = useAppStore((s) => s.availableModels);
  const chatMode = useAppStore((s) => s.chatMode);
  const ensureRuntime = useAgentRuntimeStore((s) => s.ensureRuntime);
  const hydrateRuntime = useAgentRuntimeStore((s) => s.hydrateRuntime);
  const setDraft = useAgentRuntimeStore((s) => s.setDraft);
  const { runWindow, cancelWindow, continueWindow } = useAgentWindowRunner();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

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

  const scrollToBottom = useCallback((force = false) => {
    if (!force && userScrolledUpRef.current) return;
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    transcriptEndRef.current?.scrollIntoView?.({ block: 'end' });
    setShowJumpToLatest(false);
  }, []);

  const handleTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distanceFromBottom > 64;
    userScrolledUpRef.current = scrolledUp;
    setShowJumpToLatest(scrolledUp);
  }, []);

  useEffect(() => {
    if (!runtime?.isGenerating) return;
    userScrolledUpRef.current = false;
    scrollToBottom(true);
  }, [runtime?.isGenerating, scrollToBottom]);

  useEffect(() => {
    if (!runtime) return;
    scrollToBottom();
  }, [runtime, runtime?.messages.length, runtime?.streamingText, scrollToBottom]);

  const safeRuntime = runtime;
  if (!safeRuntime) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-center text-xs text-studio-muted">
        Initializing window runtime...
      </div>
    );
  }
  const canSend = (safeRuntime.draft.trim().length > 0 || safeRuntime.attachments.length > 0) && !safeRuntime.isGenerating;
  const showAttachments = window.kind === 'primary' || window.kind === 'standard';
  const selectedModel = availableModels.find((model) => model.id === settings.selectedModel);
  const modelLabel = selectedModel?.name ?? settings.selectedModel;
  const workerLabel = settings.subagentModel === 'none'
    ? 'off'
    : settings.subagentModel
      ? settings.subagentModel
      : 'auto';
  const projectOptions = rootFolders.length > 0 ? rootFolders : (projectPath ? [projectPath] : []);
  const windowProjectPath = window.projectPath ?? activeRoot ?? projectPath ?? '';

  return (
    <div className="flex h-full max-h-full min-h-0 flex-col overflow-hidden" onClick={(event) => event.stopPropagation()}>
      <div
        ref={transcriptRef}
        onScroll={handleTranscriptScroll}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 text-xs scrollbar-thin"
        data-testid={`agent-runtime-transcript-${window.windowId}`}
      >
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
            {safeRuntime.messages.map((message, index) => {
              const isStreamingDuplicate = safeRuntime.isGenerating
                && message.role === 'assistant'
                && index === safeRuntime.messages.length - 1
                && message.content === safeRuntime.streamingText;
              if (isStreamingDuplicate) return null;
              return (
              <div
                key={message.id}
                className={`min-w-0 overflow-hidden rounded-lg border p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${
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
                <div className="whitespace-pre-wrap break-words leading-relaxed text-studio-text [overflow-wrap:anywhere]">{message.content}</div>
              </div>
              );
            })}
            {safeRuntime.isGenerating && safeRuntime.streamingReasoning && (
              <div className="min-w-0 overflow-hidden rounded-lg border border-violet-400/25 bg-violet-500/8 p-2">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-violet-300">reasoning</div>
                <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-violet-100/90 [overflow-wrap:anywhere]">
                  {safeRuntime.streamingReasoning}
                </div>
              </div>
            )}
            {safeRuntime.isGenerating && safeRuntime.streamingText && (
              <div className="min-w-0 overflow-hidden rounded-lg border border-cyan-400/30 bg-cyan-500/8 p-2">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-300">
                  {safeRuntime.isGenerating ? 'streaming' : 'latest stream'}
                </div>
                <div className="whitespace-pre-wrap break-words leading-relaxed text-studio-text [overflow-wrap:anywhere]">{safeRuntime.streamingText}</div>
              </div>
            )}
            <AgentToolTrace toolCalls={safeRuntime.toolCalls} />
            <div ref={transcriptEndRef} />
          </div>
        )}
        {showJumpToLatest && (
          <button
            type="button"
            onClick={() => {
              userScrolledUpRef.current = false;
              scrollToBottom(true);
            }}
            className="sticky bottom-2 left-full z-10 rounded-full border border-studio-title/40 bg-studio-bg/90 px-2 py-1 font-mono text-[9px] uppercase tracking-wide text-studio-title shadow-lg"
          >
            Latest
          </button>
        )}
      </div>

      {safeRuntime.lastError && (
        <div className="mx-3 mb-2 rounded-lg border border-red-400/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
          {safeRuntime.lastError}
        </div>
      )}

      <div className="shrink-0 border-t border-studio-border/70 bg-studio-bg/45 p-2">
        {showControls && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-studio-border/60 bg-studio-bg/60 px-2 py-1" data-testid={`agent-card-controls-${window.windowId}`}>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[9px] uppercase tracking-[0.14em] text-studio-muted">
              <span className="text-studio-title">Controls</span>
              <span className="truncate" title={modelLabel}>Model: {modelLabel}</span>
              <span>Mode: {chatMode}</span>
              <span className="truncate" title={workerLabel}>Worker: {workerLabel}</span>
              {projectOptions.length > 0 && (
                <label className="flex min-w-0 items-center gap-1">
                  <span className="shrink-0">Root:</span>
                  <select
                    value={windowProjectPath}
                    onChange={(event) => {
                      const next = event.target.value || undefined;
                      setWindowProjectPath(window.windowId, next);
                      if (selectedWindowId === window.windowId && next) {
                        void syncShellToProjectPath(next);
                      }
                    }}
                    className="min-w-0 max-w-[140px] truncate rounded border border-studio-border/60 bg-studio-bg/80 px-1 py-0.5 text-[9px] normal-case tracking-normal text-studio-text"
                    aria-label={`Project root for ${window.title}`}
                  >
                    {projectOptions.map((root) => (
                      <option key={root} value={root}>{root.split(/[/\\]/).pop() || root}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <button
              type="button"
              onClick={onOpenOptions}
              className="rounded border border-studio-title/40 bg-studio-title/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-studio-title hover:border-studio-title"
            >
              Options
            </button>
          </div>
        )}
        {showAttachments && (
          <AgentAttachmentBar windowId={window.windowId} disabled={safeRuntime.isGenerating} />
        )}
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
          <div className="flex items-center gap-2">
            {safeRuntime.canContinue && !safeRuntime.isGenerating && (
              <button
                type="button"
                aria-label={`Continue ${window.title}`}
                onClick={() => continueWindow(window.windowId)}
                className="rounded-lg border border-emerald-400/50 bg-emerald-500/10 px-3 py-1 text-[10px] uppercase tracking-wide text-emerald-200"
              >
                Continue
              </button>
            )}
            {safeRuntime.isGenerating ? (
            <button
              type="button"
              aria-label={`Stop ${window.title}`}
              onClick={() => cancelWindow(window.windowId)}
              className="rounded-lg border border-red-400/50 bg-red-500/10 px-3 py-1 text-[10px] uppercase tracking-wide text-red-200"
            >
              Stop
            </button>
            ) : (
              <button
                type="button"
                disabled={!canSend}
                aria-label={`Run ${window.title}`}
                onClick={() => { void runWindow(window.windowId, safeRuntime.draft); }}
                className="rounded-lg border border-studio-title/50 bg-studio-title/10 px-3 py-1 text-[10px] uppercase tracking-wide text-studio-title disabled:cursor-not-allowed disabled:opacity-50"
              >
                Run
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
