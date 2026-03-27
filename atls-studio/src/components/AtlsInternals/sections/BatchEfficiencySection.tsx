import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend as RLegend,
} from 'recharts';
import { useRoundHistoryStore, isMainChatRound } from '../../../stores/roundHistoryStore';
import { useCostStore, formatCost } from '../../../stores/costStore';

const COLORS = {
  toolCalls: '#3b82f6',
  manageOps: '#a855f7',
  savings: '#22c55e',
};

export function BatchEfficiencySection() {
  const snapshots = useRoundHistoryStore((s) => s.snapshots);
  const chatCostCents = useCostStore((s) => s.chatCostCents);

  // Main chat agent only (subagent + swarm batching is separate)
  const mainSnapshots = useMemo(() => snapshots.filter(isMainChatRound), [snapshots]);
  const subagentRoundCount = useMemo(
    () => snapshots.filter((s) => s.isSubagentRound).length,
    [snapshots],
  );
  const swarmRoundCount = useMemo(
    () => snapshots.filter((s) => s.isSwarmRound).length,
    [snapshots],
  );
  const subagentToolCalls = useMemo(
    () => snapshots.filter((s) => s.isSubagentRound).reduce((sum, s) => sum + s.toolCalls, 0),
    [snapshots],
  );

  const { data, totalActual, totalHypothetical, totalToolCalls, totalManageOps, savingsPct } = useMemo(() => {
    const d = mainSnapshots.map((s, i) => {
      const prev = i > 0 ? mainSnapshots[i - 1] : null;
      const tc = prev ? s.toolCalls - prev.toolCalls : s.toolCalls;
      const mo = prev ? s.manageOps - prev.manageOps : s.manageOps;
      return {
        round: s.round,
        'Tool Calls': Math.max(0, tc),
        'Manage Ops': Math.max(0, mo),
      };
    });
    let actual = 0, hypothetical = 0;
    for (const s of mainSnapshots) {
      actual += s.actualCost;
      hypothetical += s.hypotheticalNonBatchedCost;
    }
    const last = mainSnapshots[mainSnapshots.length - 1];
    const tc = last?.toolCalls ?? 0;
    const mo = last?.manageOps ?? 0;
    const pct = hypothetical > 0 ? ((hypothetical - actual) / hypothetical) * 100 : 0;
    return {
      data: d,
      totalActual: actual,
      totalHypothetical: hypothetical,
      totalToolCalls: tc,
      totalManageOps: mo,
      savingsPct: pct,
    };
  }, [mainSnapshots]);

  if (data.length === 0) {
    return (
      <div className="text-xs text-studio-muted py-6 text-center">
        No round data yet. Batch efficiency metrics appear after tool calls are executed.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Batch ratio chart */}
      <div className="flex justify-between text-[10px] text-studio-muted">
        <span>Tool calls vs batched manage ops per round</span>
        <span>
          Batch ratio: {totalToolCalls > 0 ? (totalManageOps / totalToolCalls).toFixed(1) : '—'}x
        </span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} barSize={14} barGap={2} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
          <XAxis
            dataKey="round"
            type="category"
            tick={{ fill: '#737373', fontSize: 10 }}
            tickLine={false}
          />
          <YAxis
            yAxisId="count"
            tick={{ fill: '#737373', fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: '#262626' }}
            width={32}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#141414', border: '1px solid #262626', borderRadius: 6, fontSize: 11 }}
            labelStyle={{ color: '#e5e5e5' }}
            labelFormatter={(l) => `Round ${l}`}
          />
          <RLegend wrapperStyle={{ fontSize: 10, color: '#737373' }} iconSize={8} />
          <Bar yAxisId="count" dataKey="Tool Calls" fill={COLORS.toolCalls} fillOpacity={0.8} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          <Bar yAxisId="count" dataKey="Manage Ops" fill={COLORS.manageOps} fillOpacity={0.8} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>

      {/* Hypothetical cost comparison */}
      <div className="border border-studio-border/40 rounded-lg p-3 bg-studio-surface/30">
        <div className="text-xs text-studio-muted mb-2 font-medium">
          Non-Batched Cost Comparison
        </div>
        <div className="text-[10px] text-studio-muted mb-3">
          If every manage op were a separate API round-trip (re-sending full context each time):
        </div>

        {/* Savings gauge */}
        <div className="mb-3">
          <div className="flex justify-between text-[10px] text-studio-muted mb-1">
            <span>Batching savings</span>
            <span className="text-studio-success font-medium">{savingsPct.toFixed(1)}%</span>
          </div>
          <div className="h-3 bg-studio-border/30 rounded-full overflow-hidden flex">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(savingsPct, 100)}%`,
                backgroundColor: COLORS.savings,
                opacity: 0.7,
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <CostCard label="Hypothetical Cost" value={formatCost(totalHypothetical)} sub="without batching" warn />
          <CostCard label="Actual Cost" value={formatCost(chatCostCents)} sub="with batching" />
          <CostCard label="Saved" value={formatCost(Math.max(0, totalHypothetical - chatCostCents))} sub={`${savingsPct.toFixed(0)}% reduction`} accent />
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-2">
        <MiniStat label="Total Tool Calls" value={totalToolCalls} />
        <MiniStat label="Total Manage Ops" value={totalManageOps} />
        <MiniStat label="Rounds" value={data.length} />
        <MiniStat label="Avg Ops/Round" value={data.length > 0 ? (totalManageOps / data.length).toFixed(1) : '—'} />
      </div>

      {(subagentRoundCount > 0 || swarmRoundCount > 0) && (
        <div className="text-[10px] text-teal-400/70 mt-1">
          Excludes
          {subagentRoundCount > 0 && (
            <span>
              {' '}
              {subagentRoundCount} subagent round{subagentRoundCount !== 1 ? 's' : ''} ({subagentToolCalls} tool call{subagentToolCalls !== 1 ? 's' : ''})
            </span>
          )}
          {subagentRoundCount > 0 && swarmRoundCount > 0 && ';'}
          {swarmRoundCount > 0 && (
            <span>
              {' '}
              {swarmRoundCount} swarm worker round{swarmRoundCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function CostCard({ label, value, sub, accent, warn }: {
  label: string; value: string; sub?: string; accent?: boolean; warn?: boolean;
}) {
  return (
    <div className="bg-studio-bg/50 rounded px-2 py-1.5 border border-studio-border/30">
      <div className="text-[10px] text-studio-muted">{label}</div>
      <div className={`text-sm font-semibold font-mono ${accent ? 'text-studio-success' : warn ? 'text-studio-error' : 'text-studio-text'}`}>
        {value}
      </div>
      {sub && <div className="text-[9px] text-studio-muted">{sub}</div>}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
      <div className="text-[10px] text-studio-muted">{label}</div>
      <div className="text-sm font-semibold text-studio-text">{value}</div>
    </div>
  );
}
