import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useSwarmStore, type SwarmTask, type AgentRole } from '../../../stores/swarmStore';
import { MAX_SNAPSHOTS, useRoundHistoryStore, type RoundSnapshot } from '../../../stores/roundHistoryStore';
import { formatCost } from '../../../stores/costStore';

const TASK_COLORS = ['#f59e0b', '#10b981', '#6366f1', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
const UNASSIGNED_TASK_ID = '__swarm_unassigned__';

function fmtK(v: number): string {
  return v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

function fmtMs(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtElapsed(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.round(seconds)}s`;
}

function fmtCostPerMin(centsPerMin: number): string {
  return centsPerMin > 0 ? `${formatCost(centsPerMin)}/min` : '—';
}

const STATUS_COLORS: Record<string, string> = {
  idle: 'text-gray-400',
  researching: 'text-purple-400',
  planning: 'text-indigo-400',
  running: 'text-blue-400',
  paused: 'text-yellow-400',
  synthesizing: 'text-cyan-400',
  completed: 'text-green-400',
  failed: 'text-red-400',
};

const ROLE_ICONS: Record<AgentRole, string> = {
  orchestrator: '🎯',
  coder: '💻',
  debugger: '🔧',
  reviewer: '👁️',
  tester: '🧪',
  documenter: '📝',
};

const TASK_STATUS_BADGES: Record<SwarmTask['status'], string> = {
  pending: 'bg-gray-500/20 text-gray-400',
  running: 'bg-blue-500/20 text-blue-400',
  awaiting_input: 'bg-yellow-500/20 text-yellow-400',
  completed: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-gray-500/20 text-gray-400',
};

function getTaskStatusBadge(status: SwarmTask['status'] | 'unknown'): string {
  return status === 'unknown' ? 'bg-gray-500/20 text-gray-400' : TASK_STATUS_BADGES[status];
}

function TaskRow({ task }: { task: SwarmTask }) {
  const [expanded, setExpanded] = useState(false);
  const latencyMs = task.startedAt && task.completedAt
    ? new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()
    : null;

  return (
    <div className="border border-studio-border/20 rounded overflow-hidden">
      <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-studio-surface/50 text-xs"
        onClick={() => setExpanded(!expanded)}
      >
        <span>{ROLE_ICONS[task.assignedRole] || '🤖'}</span>
        <span className="font-medium text-studio-text truncate max-w-[160px]">{task.title}</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
          task.status === 'completed' ? 'bg-green-500/20 text-green-400' :
          task.status === 'failed' ? 'bg-red-500/20 text-red-400' :
          task.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
          'bg-gray-500/20 text-gray-400'
        }`}>{task.status}</span>
        <span className="text-studio-muted text-[10px] ml-auto">{task.assignedModel}</span>
        <span className="text-studio-muted font-mono">{fmtK(task.tokensUsed)}</span>
        <span className="text-studio-warning font-mono">{formatCost(task.costCents)}</span>
        <svg
          className={`w-3 h-3 transition-transform text-studio-muted ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24" fill="currentColor"
        >
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </div>

      {expanded && (
        <div className="px-2 py-1.5 border-t border-studio-border/20 bg-studio-bg/50 text-[11px] space-y-1">
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <span className="text-studio-muted">Started</span>
            <span>{task.startedAt ? new Date(task.startedAt).toLocaleTimeString() : '—'}</span>
            <span className="text-studio-muted">Completed</span>
            <span>{task.completedAt ? new Date(task.completedAt).toLocaleTimeString() : '—'}</span>
            <span className="text-studio-muted">Latency</span>
            <span>{latencyMs != null ? fmtMs(latencyMs) : '—'}</span>
            <span className="text-studio-muted">Retries</span>
            <span>{task.retryCount}</span>
            {task.fileClaims.length > 0 && (
              <>
                <span className="text-studio-muted">Files</span>
                <span className="truncate">{task.fileClaims.join(', ')}</span>
              </>
            )}
          </div>
          {task.error && (
            <div className="text-red-400 bg-red-900/20 rounded p-1.5 mt-1">{task.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

interface RoleAgg {
  role: AgentRole;
  count: number;
  tokens: number;
  costCents: number;
}

interface AgentCostEvent {
  taskId: string;
  dataKey: string;
  title: string;
  role: AgentRole | null;
  model: string;
  status: SwarmTask['status'] | 'unknown';
  color: string;
  roundCostCents: number;
  cumulativeCostCents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs?: number;
  timeToFirstTokenMs?: number;
}

interface AgentCostSeries {
  taskId: string;
  dataKey: string;
  title: string;
  role: AgentRole | null;
  model: string;
  status: SwarmTask['status'] | 'unknown';
  color: string;
  totalCostCents: number;
  tokens: number;
  roundCount: number;
  burnRateCentsPerMin: number;
}

interface AgentCostChartRow {
  round: number;
  elapsedSec: number;
  elapsedLabel: string;
  timestamp: number;
  events: AgentCostEvent[];
  [key: string]: number | string | AgentCostEvent[] | undefined;
}

interface AgentCostModel {
  chartData: AgentCostChartRow[];
  series: AgentCostSeries[];
  workerCostCents: number;
}

interface TooltipPayloadItem {
  dataKey?: string | number;
  value?: unknown;
  payload?: AgentCostChartRow;
}

function getTaskId(snapshot: RoundSnapshot): string {
  return snapshot.swarmTaskId ?? UNASSIGNED_TASK_ID;
}

function computeBurnRateCentsPerMin(task: SwarmTask | undefined, totalCostCents: number): number {
  if (!task?.startedAt || totalCostCents <= 0) return 0;
  const startedAt = new Date(task.startedAt).getTime();
  const endedAt = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  const elapsedMinutes = Math.max((endedAt - startedAt) / 60000, 1 / 60);
  return totalCostCents / elapsedMinutes;
}

function buildAgentCostModel(
  tasks: SwarmTask[],
  swarmSnapshots: RoundSnapshot[],
  taskColorMap: Map<string, string>,
): AgentCostModel {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const orderedTaskIds: string[] = [];
  const seenTaskIds = new Set<string>();

  for (const task of tasks) {
    orderedTaskIds.push(task.id);
    seenTaskIds.add(task.id);
  }
  for (const snapshot of swarmSnapshots) {
    const taskId = getTaskId(snapshot);
    if (!seenTaskIds.has(taskId)) {
      orderedTaskIds.push(taskId);
      seenTaskIds.add(taskId);
    }
  }

  const seriesByTaskId = new Map<string, AgentCostSeries>();
  orderedTaskIds.forEach((taskId, index) => {
    const task = taskMap.get(taskId);
    const totalCostCents = task?.costCents ?? 0;
    seriesByTaskId.set(taskId, {
      taskId,
      dataKey: `agent_${index}`,
      title: task?.title ?? 'Unassigned swarm round',
      role: task?.assignedRole ?? null,
      model: task?.assignedModel ?? 'unknown model',
      status: task?.status ?? 'unknown',
      color: taskColorMap.get(taskId) ?? TASK_COLORS[index % TASK_COLORS.length],
      totalCostCents,
      tokens: task?.tokensUsed ?? 0,
      roundCount: 0,
      burnRateCentsPerMin: computeBurnRateCentsPerMin(task, totalCostCents),
    });
  });

  const sortedSnapshots = [...swarmSnapshots].sort((a, b) => a.timestamp - b.timestamp);
  const firstTimestamp = sortedSnapshots[0]?.timestamp ?? Date.now();
  const cumulativeByTaskId = new Map<string, number>();
  const roundCountByTaskId = new Map<string, number>();
  const activeTaskIds = new Set<string>();
  const chartData: AgentCostChartRow[] = [];

  sortedSnapshots.forEach((snapshot, index) => {
    const taskId = getTaskId(snapshot);
    const series = seriesByTaskId.get(taskId);
    if (!series) return;

    const nextCost = (cumulativeByTaskId.get(taskId) ?? 0) + snapshot.costCents;
    cumulativeByTaskId.set(taskId, nextCost);
    roundCountByTaskId.set(taskId, (roundCountByTaskId.get(taskId) ?? 0) + 1);
    activeTaskIds.add(taskId);

    const event: AgentCostEvent = {
      taskId,
      dataKey: series.dataKey,
      title: series.title,
      role: series.role,
      model: series.model,
      status: series.status,
      color: series.color,
      roundCostCents: snapshot.costCents,
      cumulativeCostCents: nextCost,
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      cacheReadTokens: snapshot.cacheReadTokens,
      cacheWriteTokens: snapshot.cacheWriteTokens,
      latencyMs: snapshot.roundLatencyMs,
      timeToFirstTokenMs: snapshot.timeToFirstTokenMs,
    };

    const elapsedSec = Math.max(0, Math.round((snapshot.timestamp - firstTimestamp) / 1000));
    const row: AgentCostChartRow = {
      round: index + 1,
      elapsedSec,
      elapsedLabel: fmtElapsed(elapsedSec),
      timestamp: snapshot.timestamp,
      events: [event],
    };

    for (const activeTaskId of activeTaskIds) {
      const activeSeries = seriesByTaskId.get(activeTaskId);
      if (activeSeries) row[activeSeries.dataKey] = Math.round((cumulativeByTaskId.get(activeTaskId) ?? 0) * 100) / 100;
    }

    chartData.push(row);
  });

  const series = Array.from(seriesByTaskId.values()).map((item) => {
    const snapshotTotal = cumulativeByTaskId.get(item.taskId) ?? 0;
    const totalCostCents = snapshotTotal > 0 ? snapshotTotal : item.totalCostCents;
    return {
      ...item,
      totalCostCents,
      burnRateCentsPerMin: computeBurnRateCentsPerMin(taskMap.get(item.taskId), totalCostCents),
      roundCount: roundCountByTaskId.get(item.taskId) ?? 0,
    };
  });

  return {
    chartData,
    series,
    workerCostCents: series.reduce((sum, item) => sum + item.totalCostCents, 0),
  };
}

function AgentCostTooltip({
  active,
  payload,
  seriesByKey,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  seriesByKey: Map<string, AgentCostSeries>;
}) {
  if (!active || !payload?.length) return null;
  const row = payload.find((item) => item.payload)?.payload;
  if (!row) return null;

  const currentTotals = payload
    .filter((item): item is TooltipPayloadItem & { dataKey: string; value: number } =>
      typeof item.dataKey === 'string' &&
      seriesByKey.has(item.dataKey) &&
      typeof item.value === 'number',
    )
    .sort((a, b) => b.value - a.value)
    .slice(0, 4);

  return (
    <div className="rounded border border-studio-border bg-studio-bg px-2 py-1.5 text-[11px] shadow-lg min-w-[220px]">
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="font-semibold text-studio-text">Swarm round {row.round}</span>
        <span className="text-studio-muted">{row.elapsedLabel}</span>
      </div>
      {row.events.map((event) => (
        <div key={`${event.taskId}-${row.round}`} className="border-t border-studio-border/30 pt-1 mt-1 first:border-t-0 first:pt-0 first:mt-0">
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: event.color }} />
            <span className="font-medium text-studio-text truncate max-w-[170px]">{event.title}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1">
            <span className="text-studio-muted">Role / model</span>
            <span className="truncate">{event.role ?? 'agent'} · {event.model}</span>
            <span className="text-studio-muted">Round cost</span>
            <span className="font-mono text-studio-warning">{formatCost(event.roundCostCents)}</span>
            <span className="text-studio-muted">Agent total</span>
            <span className="font-mono text-studio-warning">{formatCost(event.cumulativeCostCents)}</span>
            <span className="text-studio-muted">Tokens</span>
            <span className="font-mono">{fmtK(event.inputTokens)} in / {fmtK(event.outputTokens)} out</span>
            <span className="text-studio-muted">Cache</span>
            <span className="font-mono">{fmtK(event.cacheReadTokens)} read / {fmtK(event.cacheWriteTokens)} write</span>
            <span className="text-studio-muted">Latency</span>
            <span>{event.latencyMs != null ? fmtMs(event.latencyMs) : '—'}</span>
            <span className="text-studio-muted">TTFB</span>
            <span>{event.timeToFirstTokenMs != null ? fmtMs(event.timeToFirstTokenMs) : '—'}</span>
          </div>
        </div>
      ))}
      {currentTotals.length > 1 && (
        <div className="border-t border-studio-border/30 mt-1 pt-1">
          <div className="text-studio-muted mb-0.5">Current totals</div>
          {currentTotals.map((item) => {
            const series = seriesByKey.get(item.dataKey);
            if (!series) return null;
            return (
              <div key={item.dataKey} className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: series.color }} />
                <span className="truncate">{series.title}</span>
                <span className="ml-auto font-mono text-studio-warning">{formatCost(item.value)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SwarmActivitySection() {
  const tasks = useSwarmStore((s) => s.tasks);
  const stats = useSwarmStore((s) => s.stats);
  const status = useSwarmStore((s) => s.status);
  const planTokens = useSwarmStore((s) => s.orchestrationPlanTokens);
  const planCost = useSwarmStore((s) => s.orchestrationPlanCostCents);
  const synthTokens = useSwarmStore((s) => s.orchestrationSynthesisTokens);
  const synthCost = useSwarmStore((s) => s.orchestrationSynthesisCostCents);
  const snapshots = useRoundHistoryStore((s) => s.snapshots);

  const swarmSnapshots = useMemo(
    () => snapshots.filter((s: RoundSnapshot) => s.isSwarmRound),
    [snapshots],
  );

  const taskColorMap = useMemo(() => {
    const map = new Map<string, string>();
    const seen: string[] = [];
    const assignColor = (taskId: string) => {
      if (!map.has(taskId)) {
        map.set(taskId, TASK_COLORS[seen.length % TASK_COLORS.length]);
        seen.push(taskId);
      }
    };

    for (const t of tasks) {
      assignColor(t.id);
    }
    for (const s of swarmSnapshots) {
      assignColor(getTaskId(s));
    }
    return map;
  }, [tasks, swarmSnapshots]);

  const agentCost = useMemo(
    () => buildAgentCostModel(tasks, swarmSnapshots, taskColorMap),
    [tasks, swarmSnapshots, taskColorMap],
  );

  const activeAgentSeries = useMemo(
    () => agentCost.series.filter((series) => series.roundCount > 0 || series.totalCostCents > 0),
    [agentCost.series],
  );

  const seriesByKey = useMemo(
    () => new Map(agentCost.series.map((series) => [series.dataKey, series])),
    [agentCost.series],
  );

  const agentLegendSeries = useMemo(
    () => [...activeAgentSeries].sort((a, b) => b.totalCostCents - a.totalCostCents || b.roundCount - a.roundCount),
    [activeAgentSeries],
  );

  const roleAgg = useMemo(() => {
    const map = new Map<AgentRole, RoleAgg>();
    for (const t of tasks) {
      const prev = map.get(t.assignedRole);
      if (prev) {
        prev.count++;
        prev.tokens += t.tokensUsed;
        prev.costCents += t.costCents;
      } else {
        map.set(t.assignedRole, { role: t.assignedRole, count: 1, tokens: t.tokensUsed, costCents: t.costCents });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.costCents - a.costCents);
  }, [tasks]);

  const phaseCosts = useMemo(() => {
    const values = [
      { label: 'Plan', costCents: planCost, tokens: planTokens },
      { label: 'Workers', costCents: agentCost.workerCostCents || stats.totalCostCents, tokens: stats.totalTokensUsed },
      { label: 'Synthesis', costCents: synthCost, tokens: synthTokens },
    ];
    const total = values.reduce((sum, item) => sum + item.costCents, 0);
    return values.map((item) => ({
      ...item,
      pct: total > 0 ? Math.round((item.costCents / total) * 100) : 0,
    }));
  }, [agentCost.workerCostCents, planCost, planTokens, stats.totalCostCents, stats.totalTokensUsed, synthCost, synthTokens]);

  const roundHistoryTruncated = snapshots.length >= MAX_SNAPSHOTS;

  if (tasks.length === 0 && swarmSnapshots.length === 0) {
    return (
      <div className="text-xs text-studio-muted py-6 text-center">
        No swarm session active. Switch to Swarm mode to see orchestration telemetry.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Status</div>
          <div className={`text-sm font-semibold capitalize ${STATUS_COLORS[status] || 'text-studio-text'}`}>{status}</div>
        </div>
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Total Cost</div>
          <div className="text-sm font-semibold font-mono text-studio-warning">{formatCost(stats.totalCostCents)}</div>
        </div>
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Total Tokens</div>
          <div className="text-sm font-semibold font-mono">{fmtK(stats.totalTokensUsed)}</div>
        </div>
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Tasks</div>
          <div className="text-sm font-semibold font-mono text-green-400">{stats.completedTasks}<span className="text-studio-muted">/{stats.totalTasks}</span></div>
          {stats.failedTasks > 0 && <div className="text-[9px] text-red-400">{stats.failedTasks} failed</div>}
        </div>
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Plan Phase</div>
          <div className="text-sm font-semibold font-mono">{fmtK(planTokens)}</div>
          <div className="text-[9px] text-studio-muted">{formatCost(planCost)}</div>
        </div>
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Synthesis Phase</div>
          <div className="text-sm font-semibold font-mono">{fmtK(synthTokens)}</div>
          <div className="text-[9px] text-studio-muted">{formatCost(synthCost)}</div>
        </div>
      </div>

      {/* Phase cost split */}
      {phaseCosts.some((phase) => phase.costCents > 0) && (
        <div>
          <div className="text-[10px] text-studio-muted uppercase tracking-wide mb-1">Cost Split</div>
          <div className="grid grid-cols-3 gap-2">
            {phaseCosts.map((phase) => (
              <div key={phase.label} className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
                <div className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="text-studio-muted">{phase.label}</span>
                  <span className="font-mono text-studio-warning">{formatCost(phase.costCents)}</span>
                </div>
                <div className="h-1 bg-studio-bg rounded overflow-hidden mt-1">
                  <div className="h-full bg-studio-warning/80" style={{ width: `${phase.pct}%` }} />
                </div>
                <div className="flex items-center justify-between text-[9px] text-studio-muted mt-0.5">
                  <span>{phase.pct}%</span>
                  <span className="font-mono">{fmtK(phase.tokens)} tok</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent cost timeline */}
      {agentCost.chartData.length > 0 && activeAgentSeries.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-[10px] text-studio-muted uppercase tracking-wide">Swarm Agent Cost Timeline</div>
            <div className="text-[9px] text-studio-muted">
              {activeAgentSeries.length} agents · {swarmSnapshots.length} rounds
            </div>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={agentCost.chartData} margin={{ top: 4, right: 10, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="round"
                tick={{ fontSize: 9, fill: '#888' }}
                tickLine={false}
                label={{ value: 'Swarm round', position: 'insideBottomRight', offset: -4, fill: '#737373', fontSize: 10 }}
              />
              <YAxis
                tick={{ fontSize: 9, fill: '#888' }}
                tickLine={false}
                axisLine={{ stroke: '#262626' }}
                tickFormatter={(v: number) => formatCost(v)}
                width={48}
              />
              <Tooltip content={<AgentCostTooltip seriesByKey={seriesByKey} />} />
              {activeAgentSeries.map((series) => (
                <Line
                  key={series.taskId}
                  type="stepAfter"
                  dataKey={series.dataKey}
                  name={series.title}
                  stroke={series.color}
                  strokeWidth={series.status === 'running' ? 2 : 1.5}
                  dot={series.roundCount <= 24 ? { r: 2, fill: series.color, strokeWidth: 0 } : false}
                  activeDot={{ r: 4, fill: series.color, strokeWidth: 0 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-2">
            {agentLegendSeries.slice(0, 9).map((series) => (
              <div key={series.taskId} className="bg-studio-surface/40 rounded px-2 py-1.5 border border-studio-border/20 text-[10px]">
                <div className="flex items-center gap-1 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: series.color }} />
                  <span>{series.role ? ROLE_ICONS[series.role] : '🤖'}</span>
                  <span className="truncate text-studio-text">{series.title}</span>
                  <span className={`ml-auto px-1 py-0.5 rounded ${getTaskStatusBadge(series.status)}`}>
                    {series.status}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-studio-muted">
                  <span className="font-mono text-studio-warning">{formatCost(series.totalCostCents)}</span>
                  <span>{fmtCostPerMin(series.burnRateCentsPerMin)}</span>
                  <span className="ml-auto">{series.roundCount} rounds</span>
                </div>
              </div>
            ))}
          </div>
          <div className="text-[9px] text-studio-muted mt-1">
            Cumulative spend per agent; hover for per-round cost, tokens, cache, and latency.
            {agentLegendSeries.length > 9 ? ` Showing top 9 of ${agentLegendSeries.length} agents by cost.` : ''}
            {roundHistoryTruncated ? ` Showing the latest ${MAX_SNAPSHOTS} round snapshots; older swarm rounds may be omitted.` : ''}
          </div>
        </div>
      )}

      {agentCost.chartData.length === 0 && activeAgentSeries.length > 0 && (
        <div className="text-[10px] text-studio-muted bg-studio-surface/40 rounded px-2 py-1.5 border border-studio-border/20">
          Per-agent totals are available, but no live swarm round snapshots are present for a timeline. Restored sessions can still show task costs below.
        </div>
      )}

      {/* Per-Role Aggregation */}
      {roleAgg.length > 0 && (
        <div>
          <div className="text-[10px] text-studio-muted uppercase tracking-wide mb-1">Cost by Role</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {roleAgg.map((r) => (
              <div key={r.role} className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
                <div className="flex items-center gap-1 text-[10px]">
                  <span>{ROLE_ICONS[r.role] || '🤖'}</span>
                  <span className="text-studio-muted capitalize">{r.role}</span>
                  <span className="ml-auto text-studio-muted">×{r.count}</span>
                </div>
                <div className="text-xs font-mono text-studio-warning">{formatCost(r.costCents)}</div>
                <div className="text-[9px] text-studio-muted font-mono">{fmtK(r.tokens)} tok</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-Task Breakdown */}
      {tasks.length > 0 && (
        <div>
          <div className="text-[10px] text-studio-muted uppercase tracking-wide mb-1">Tasks ({tasks.length})</div>
          <div className="space-y-1 max-h-[300px] overflow-y-auto">
            {tasks.map((t) => <TaskRow key={t.id} task={t} />)}
          </div>
        </div>
      )}
    </div>
  );
}
