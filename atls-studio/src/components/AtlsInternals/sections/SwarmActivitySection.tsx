import { useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Dot } from 'recharts';
import { useSwarmStore, type SwarmTask, type AgentRole } from '../../../stores/swarmStore';
import { useRoundHistoryStore, type RoundSnapshot } from '../../../stores/roundHistoryStore';
import { formatCost } from '../../../stores/costStore';

const TASK_COLORS = ['#f59e0b', '#10b981', '#6366f1', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

function fmtK(v: number): string {
  return v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

function fmtMs(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
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
    for (const t of tasks) {
      if (!map.has(t.id)) {
        map.set(t.id, TASK_COLORS[seen.length % TASK_COLORS.length]);
        seen.push(t.id);
      }
    }
    return map;
  }, [tasks]);

  const chartData = useMemo(() =>
    swarmSnapshots.map((s, i) => ({
      round: i + 1,
      cost: s.costCents,
      latency: s.roundLatencyMs ?? 0,
      taskId: s.swarmTaskId,
      color: s.swarmTaskId ? (taskColorMap.get(s.swarmTaskId) ?? '#f59e0b') : '#f59e0b',
    })),
    [swarmSnapshots, taskColorMap],
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

      {/* Swarm Round Cost Timeline */}
      {chartData.length > 0 && (
        <div>
          <div className="text-[10px] text-studio-muted uppercase tracking-wide mb-1">Swarm Round Cost Timeline</div>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="round" tick={{ fontSize: 9, fill: '#888' }} />
              <YAxis
                yAxisId="cost"
                tick={{ fontSize: 9, fill: '#888' }}
                tickFormatter={(v: number) => `${v.toFixed(1)}¢`}
                width={40}
              />
              <YAxis
                yAxisId="latency"
                orientation="right"
                tick={{ fontSize: 9, fill: '#888' }}
                tickFormatter={(v: number) => v >= 1000 ? `${(v/1000).toFixed(0)}s` : `${v}ms`}
                width={36}
              />
              <Tooltip
                contentStyle={{ background: '#1e1e2e', border: '1px solid #333', fontSize: 11 }}
                formatter={(value, name) => {
                  const v = typeof value === 'number' ? value : 0;
                  return name === 'cost' ? [`${v.toFixed(2)}¢`, 'Cost'] : [fmtMs(v), 'Latency'];
                }}
              />
              <Line
                yAxisId="cost"
                type="monotone"
                dataKey="cost"
                stroke="#f59e0b"
                strokeWidth={1.5}
                dot={(props: any) => {
                  const { cx, cy, payload } = props;
                  if (cx == null || cy == null) return <></>;
                  return <Dot cx={cx} cy={cy} r={3} fill={payload.color} stroke="none" />;
                }}
              />
              <Line yAxisId="latency" type="monotone" dataKey="latency" stroke="#6366f1" dot={false} strokeWidth={1} strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
          <div className="text-[9px] text-studio-muted mt-0.5">{swarmSnapshots.length} swarm rounds — amber: cost, indigo dashed: latency</div>
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
