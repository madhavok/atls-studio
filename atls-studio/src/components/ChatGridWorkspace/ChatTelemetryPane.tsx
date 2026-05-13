import { memo, useMemo } from 'react';
import type { ChatSession, ContextUsage, Message, PromptMetrics } from '../../stores/appStore';
import type { RoundSnapshot } from '../../stores/roundHistoryStore';
import type { SwarmStats, SwarmTask } from '../../stores/swarmStore';
import type { AgentWindow } from '../../stores/agentWindowStore';
import type { AgentRuntime, ParentAgentEvent } from '../../stores/agentRuntimeStore';
import { formatCost } from '../../stores/costStore';
import { buildMissionTelemetry, formatCompactNumber } from '../../utils/multiagentTelemetry';

interface ChatTelemetryPaneProps {
  selectedWindow: AgentWindow | undefined;
  windows: AgentWindow[];
  sessions: ChatSession[];
  currentSessionId: string | null;
  messages: Message[];
  contextUsage: ContextUsage;
  promptMetrics: PromptMetrics;
  snapshots: RoundSnapshot[];
  swarmTasks: SwarmTask[];
  swarmStats: SwarmStats;
  runtimesByWindow: Record<string, AgentRuntime>;
  parentEvents: ParentAgentEvent[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function MiniStat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-md border border-studio-border/50 bg-studio-bg/45 px-2 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]" title={title}>
      <div className="text-[9px] uppercase tracking-[0.16em] text-studio-muted">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[12px] text-studio-text">{value}</div>
    </div>
  );
}

function Bar({ label, value, max, tone = 'cyan' }: { label: string; value: number; max: number; tone?: 'cyan' | 'violet' | 'emerald' | 'amber' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const toneClass = tone === 'violet'
    ? 'from-violet-500 to-fuchsia-400'
    : tone === 'emerald'
      ? 'from-emerald-500 to-teal-300'
      : tone === 'amber'
        ? 'from-amber-500 to-orange-300'
        : 'from-cyan-500 to-blue-300';
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] text-studio-muted">
        <span>{label}</span>
        <span className="font-mono text-studio-text">{formatCompactNumber(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-studio-bg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
        <div className={`h-full rounded-full bg-gradient-to-r ${toneClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const width = 160;
  const height = 38;
  const max = Math.max(...values, 1);
  const points = values.length > 1
    ? values.map((value, index) => {
        const x = (index / (values.length - 1)) * width;
        const y = height - (value / max) * (height - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ')
    : `0,${height - 2} ${width},${height - 2}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-10 w-full text-cyan-300" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function getClaimConflicts(runtimes: AgentRuntime[]): Array<{ path: string; owners: string[] }> {
  const ownersByPath = new Map<string, string[]>();
  for (const runtime of runtimes) {
    for (const path of runtime.fileClaims) {
      const owners = ownersByPath.get(path) ?? [];
      owners.push(runtime.windowId);
      ownersByPath.set(path, owners);
    }
  }
  return Array.from(ownersByPath.entries())
    .filter(([, owners]) => owners.length > 1)
    .map(([path, owners]) => ({ path, owners }));
}

export const ChatTelemetryPane = memo(function ChatTelemetryPane({
  selectedWindow,
  windows,
  sessions,
  currentSessionId,
  messages,
  contextUsage,
  promptMetrics,
  snapshots,
  swarmTasks,
  swarmStats,
  runtimesByWindow,
  parentEvents,
  collapsed,
  onToggleCollapsed,
}: ChatTelemetryPaneProps) {
  const selectedSession = selectedWindow
    ? sessions.find((session) => session.id === selectedWindow.sessionId)
    : undefined;
  const isLiveSession = Boolean(selectedWindow && selectedWindow.sessionId === currentSessionId);
  const selectedRuntime = selectedWindow ? runtimesByWindow[selectedWindow.windowId] : undefined;
  const selectedTokens = selectedRuntime
    ? selectedRuntime.telemetry.totalTokens
    : isLiveSession
    ? contextUsage.totalTokens
    : selectedSession?.contextUsage?.totalTokens ?? 0;
  const selectedCost = selectedRuntime
    ? selectedRuntime.telemetry.costCents
    : isLiveSession
    ? contextUsage.costCents ?? 0
    : selectedSession?.contextUsage?.costCents ?? 0;
  const selectedRounds = selectedRuntime
    ? selectedRuntime.telemetry.rounds
    : isLiveSession
    ? promptMetrics.roundCount || messages.filter((message) => message.role === 'assistant').length
    : selectedSession?.messages.filter((message) => message.role === 'assistant').length ?? 0;
  const outputTokens = selectedRuntime ? selectedRuntime.telemetry.outputTokens : isLiveSession ? contextUsage.outputTokens : selectedSession?.contextUsage?.outputTokens ?? 0;
  const inputTokens = selectedRuntime ? selectedRuntime.telemetry.inputTokens : isLiveSession ? contextUsage.inputTokens : selectedSession?.contextUsage?.inputTokens ?? 0;
  const contextPressure = isLiveSession && contextUsage.maxTokens > 0
    ? Math.min(100, Math.round((contextUsage.totalTokens / contextUsage.maxTokens) * 100))
    : 0;
  const activeRuntimeCount = Object.values(runtimesByWindow).filter((runtime) => runtime.isGenerating).length;
  const claimConflicts = getClaimConflicts(Object.values(runtimesByWindow));

  const mission = useMemo(
    () => buildMissionTelemetry({
      snapshots,
      manualLanes: [],
      swarmTasks,
      swarmStats,
      contextTotalTokens: contextUsage.totalTokens,
      contextMaxTokens: contextUsage.maxTokens,
    }),
    [contextUsage.maxTokens, contextUsage.totalTokens, snapshots, swarmStats, swarmTasks],
  );
  const tokenTrend = snapshots.slice(-12).map((snapshot) => snapshot.inputTokens + snapshot.outputTokens);

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-l border-studio-border bg-studio-surface/80 py-2" data-testid="chat-telemetry-pane-collapsed">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="rounded-md border border-studio-border/70 px-2 py-1 font-mono text-[10px] text-studio-title hover:border-studio-title/50"
          title="Show chat telemetry"
        >
          TEL
        </button>
        <div className="mt-3 text-[10px] uppercase tracking-[0.2em] text-studio-muted [writing-mode:vertical-lr] rotate-180">
          Telemetry
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-72 shrink-0 overflow-hidden border-l border-studio-border bg-studio-surface/80 shadow-[-12px_0_28px_rgba(0,0,0,0.22)]" data-testid="chat-telemetry-pane">
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-studio-border/70 bg-gradient-to-r from-studio-bg/90 to-studio-surface/60 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-studio-title">Telemetry</div>
              <div className="truncate text-[10px] text-studio-muted">{selectedWindow?.title ?? 'No chat selected'}</div>
            </div>
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="rounded-md border border-studio-border px-2 py-1 text-[10px] uppercase tracking-wide text-studio-muted hover:text-studio-text"
              title="Hide chat telemetry"
            >
              Hide
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <section className="rounded-lg border border-studio-border/70 bg-studio-bg/35 p-2.5 shadow-[0_12px_30px_rgba(0,0,0,0.16)]">
            <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-studio-muted">Selected Chat</div>
            <div className="grid grid-cols-2 gap-1.5">
              <MiniStat label="Tokens" value={formatCompactNumber(selectedTokens)} />
              <MiniStat label="Cost" value={formatCost(selectedCost)} />
              <MiniStat label="Rounds" value={`${selectedRounds}`} />
              <MiniStat label="Context" value={`${contextPressure}%`} />
            </div>
            <div className="mt-3 space-y-2">
              <Bar label="Input" value={inputTokens} max={Math.max(inputTokens, outputTokens, 1)} tone="cyan" />
              <Bar label="Output" value={outputTokens} max={Math.max(inputTokens, outputTokens, 1)} tone="violet" />
              <Bar label="Context Pressure" value={contextPressure} max={100} tone="amber" />
            </div>
          </section>

          <section className="rounded-lg border border-studio-border/70 bg-studio-bg/35 p-2.5 shadow-[0_12px_30px_rgba(0,0,0,0.16)]">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-[0.18em] text-studio-muted">Mission Totals</div>
              <div className="font-mono text-[10px] text-studio-title">{windows.length} windows</div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <MiniStat label="Active" value={`${mission.activeAgents + activeRuntimeCount}`} />
              <MiniStat label="Done" value={`${mission.completedAgents}`} />
              <MiniStat label="Failed" value={`${mission.failedAgents}`} />
              <MiniStat label="Tokens" value={formatCompactNumber(mission.totalTokens)} />
            </div>
            <div className="mt-3 rounded-md border border-studio-border/50 bg-studio-bg/40 p-2">
              <div className="mb-1 text-[10px] text-studio-muted">Token Trend</div>
              <Sparkline values={tokenTrend.length > 0 ? tokenTrend : [0]} />
            </div>
          </section>

          {parentEvents.length > 0 && (
            <section className="rounded-lg border border-studio-border/70 bg-studio-bg/35 p-2.5 shadow-[0_12px_30px_rgba(0,0,0,0.16)]">
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-studio-muted">Child Results</div>
              <div className="space-y-2">
                {parentEvents.slice(0, 5).map((event) => (
                  <div key={event.id} className="rounded-md border border-studio-border/50 bg-studio-bg/40 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-[11px] text-studio-title">{event.title}</div>
                      <div className="font-mono text-[9px] uppercase text-studio-muted">{event.status}</div>
                    </div>
                    <div className="mt-1 line-clamp-3 text-[10px] leading-relaxed text-studio-muted">{event.summary}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {claimConflicts.length > 0 && (
            <section className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-2.5 shadow-[0_12px_30px_rgba(0,0,0,0.16)]">
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-amber-200">File Claim Conflicts</div>
              <div className="space-y-1">
                {claimConflicts.slice(0, 6).map((conflict) => (
                  <div key={conflict.path} className="font-mono text-[10px] text-amber-100/90">
                    {conflict.path} · {conflict.owners.length} windows
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </aside>
  );
});
