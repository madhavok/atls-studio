import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { AgentWindow } from '../../stores/agentWindowStore';
import { chatDb } from '../../services/chatDb';
import { useAgentRuntimeStore, type AgentRuntimeMessage } from '../../stores/agentRuntimeStore';
import { useAgentWindowStore } from '../../stores/agentWindowStore';
import { useAgentWindowRunner } from '../../hooks/useAgentWindowRunner';
import { useAppStore } from '../../stores/appStore';
import { AgentAttachmentBar } from './AgentAttachmentBar';
import type { Message } from '../../stores/appStore';
import { AgentMessageParts } from './AgentMessageParts';
import { AgentToolTrace } from './AgentToolTrace';
import { AgentStreamingSegments } from './AgentStreamingSegments';
import { syncShellToProjectPath } from '../../services/agentShellSync';
import { ModelModeSelector } from '../ModelModeSelector';

interface AgentChatSurfaceProps {
  window: AgentWindow;
  showControls?: boolean;
  onOpenOptions?: () => void;
}

/** Local wall-clock label for a message (HH:MM). Display-only; never sent to the model. */
function formatClockTime(value: Date | string | number | undefined): string {
  if (value === undefined) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const ROLE_BUBBLE_CLASS: Record<AgentRuntimeMessage['role'], string> = {
  user: 'border-studio-title/30 bg-studio-title/[0.07] ring-1 ring-inset ring-studio-title/10',
  system: 'border-amber-400/25 bg-amber-500/[0.07] text-amber-100/90',
  assistant: 'border-studio-border/50 bg-studio-surface/40',
};

const ROLE_CHIP_CLASS: Record<AgentRuntimeMessage['role'], string> = {
  user: 'text-studio-title',
  system: 'text-amber-300/90',
  assistant: 'text-studio-accent-bright/90',
};

function toRuntimeMessages(messages: Message[]): AgentRuntimeMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    parts: message.parts,
    segments: message.segments,
  }));
}

export const AgentChatSurface = memo(function AgentChatSurface({ window, showControls = false, onOpenOptions }: AgentChatSurfaceProps) {
  const runtime = useAgentRuntimeStore((s) => s.runtimesByWindow[window.windowId]);
  const rootFolders = useAppStore((s) => s.rootFolders);
  const activeRoot = useAppStore((s) => s.activeRoot);
  const projectPath = useAppStore((s) => s.projectPath);
  const setWindowProjectPath = useAgentWindowStore((s) => s.setWindowProjectPath);
  const selectedWindowId = useAgentWindowStore((s) => s.selectedWindowByParent[window.parentSessionId]);
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
    if (window.kind !== 'primary' && window.status === 'running' && !current?.isGenerating && !current?.proxyActive) {
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
      const usage = result.session.context_usage;
      hydrateRuntime(
        window.windowId,
        toRuntimeMessages(result.messages),
        usage
          ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
              costCents: usage.cost_cents ?? 0,
            }
          : undefined,
      );
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
    if (!runtime?.isGenerating && !runtime?.proxyActive) return;
    userScrolledUpRef.current = false;
    scrollToBottom(true);
  }, [runtime?.isGenerating, runtime?.proxyActive, scrollToBottom]);

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
  const streamLive = safeRuntime.isGenerating || safeRuntime.proxyActive;
  const showAttachments = window.kind === 'primary' || window.kind === 'standard';
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
                && !message.toolName
                && index === safeRuntime.messages.length - 1
                && message.content === safeRuntime.streamingText;
              if (isStreamingDuplicate) return null;
              const clock = formatClockTime(message.timestamp);
              return (
              <div
                key={message.id}
                className={`min-w-0 overflow-hidden rounded-xl border px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${ROLE_BUBBLE_CLASS[message.role]}`}
              >
                <div className="mb-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em]">
                  <span className={ROLE_CHIP_CLASS[message.role]}>{message.role}</span>
                  {message.toolName && <span className="truncate text-studio-muted">{message.toolName}</span>}
                  {clock && <span className="ml-auto shrink-0 normal-case tracking-normal text-studio-muted/70 tabular-nums">{clock}</span>}
                </div>
                <div className={
                  message.role === 'assistant' && (message.parts?.length || message.segments?.length)
                    ? 'min-w-0 [overflow-wrap:anywhere]'
                    : message.role === 'assistant'
                      ? 'markdown-message text-xs leading-relaxed text-studio-text [overflow-wrap:anywhere]'
                      : 'whitespace-pre-wrap break-words leading-relaxed text-studio-text [overflow-wrap:anywhere]'
                }>
                  {message.role === 'assistant' && (message.parts?.length || message.segments?.length) ? (
                    <AgentMessageParts
                      content={message.content}
                      parts={message.parts}
                      segments={message.segments}
                    />
                  ) : message.role === 'assistant' ? (
                    <AgentMessageParts content={message.content} />
                  ) : (
                    message.content
                  )}
                </div>
              </div>
              );
            })}
            {safeRuntime.isGenerating ? (
              <AgentStreamingSegments
                windowId={window.windowId}
                isGenerating={safeRuntime.isGenerating}
                fallbackText={safeRuntime.streamingText}
                fallbackReasoning={safeRuntime.streamingReasoning}
              />
            ) : safeRuntime.proxyActive ? (
              <>
                {safeRuntime.streamingText && (
                  <div className="min-w-0 overflow-hidden rounded-xl border border-studio-border/50 bg-studio-surface/40 px-2.5 py-2 text-xs leading-relaxed text-studio-text [overflow-wrap:anywhere]">
                    {safeRuntime.streamingText}
                  </div>
                )}
                <AgentToolTrace toolCalls={safeRuntime.toolCalls} windowId={window.windowId} />
              </>
            ) : (safeRuntime.status === 'failed' || safeRuntime.status === 'cancelled') && safeRuntime.toolCalls.length > 0 ? (
              // Failed/cancelled runs never finalize their parts into the transcript,
              // so surface the partial tool trace here for diagnostics. Completed/idle
              // runs already render their tools inside the finalized message above.
              <AgentToolTrace toolCalls={safeRuntime.toolCalls} windowId={window.windowId} />
            ) : null}
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
          <div className="mb-2 space-y-2 rounded-lg border border-studio-border/60 bg-studio-bg/60 px-2 py-1.5" data-testid={`agent-card-controls-${window.windowId}`}>
            <ModelModeSelector menuPlacement="up" />
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[9px] uppercase tracking-[0.14em] text-studio-muted">
                <span className="text-studio-title">Controls</span>
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
          </div>
        )}
        {showAttachments && (
          <AgentAttachmentBar windowId={window.windowId} disabled={safeRuntime.isGenerating} />
        )}
        <textarea
          value={safeRuntime.draft}
          onChange={(event) => setDraft(window.windowId, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend) void runWindow(window.windowId, safeRuntime.draft);
            }
          }}
          placeholder={window.role ? `Send task to ${window.role} delegate...` : window.kind === 'primary' ? 'Send a parent session task...' : 'Send an independent task...'}
          className="min-h-[58px] w-full resize-none rounded-lg border border-studio-border bg-studio-bg/80 px-2 py-1.5 text-xs text-studio-text placeholder:text-studio-muted focus:outline-none focus:ring-1 focus:ring-studio-title/40"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-studio-muted">
            {streamLive ? 'live stream active' : `${safeRuntime.telemetry.rounds} rounds`}
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
