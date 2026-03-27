import { useMemo } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend as RLegend,
} from 'recharts';
import { useRoundHistoryStore, isMainChatRound } from '../../../stores/roundHistoryStore';
import { useCostStore, formatCost } from '../../../stores/costStore';

const COLORS = {
  input: '#3b82f6',
  output: '#a855f7',
  cacheRead: 'rgba(34,197,94,0.55)',
  cost: '#eab308',
};

function fmtK(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

export function CostIOSection() {
  const snapshots = useRoundHistoryStore((s) => s.snapshots);

  const chatCostCents = useCostStore((s) => s.chatCostCents);
  const chatApiCalls = useCostStore((s) => s.chatApiCalls);
  const chatSubAgentCostCents = useCostStore((s) => s.chatSubAgentCostCents);
  const subAgentUsages = useCostStore((s) => s.subAgentUsages);

  const mainSnapshots = useMemo(() => snapshots.filter(isMainChatRound), [snapshots]);
  const subagentSnapshots = useMemo(() => snapshots.filter((s) => s.isSubagentRound), [snapshots]);
  const swarmSnapshots = useMemo(() => snapshots.filter((s) => s.isSwarmRound), [snapshots]);

  const { chartData, totalInput, totalOutput, totalCacheRead } = useMemo(() => {
    const cd = mainSnapshots.map((s) => ({
      round: s.round,
      Input: s.inputTokens,
      Output: s.outputTokens,
      'Cache Read': s.cacheReadTokens,
      Cost: Math.round(s.costCents * 100) / 100,
    }));
    let tIn = 0, tOut = 0, tCache = 0;
    for (const s of mainSnapshots) {
      tIn += s.inputTokens;
      tOut += s.outputTokens;
      tCache += s.cacheReadTokens;
    }
    return { chartData: cd, totalInput: tIn, totalOutput: tOut, totalCacheRead: tCache };
  }, [mainSnapshots]);

  const avgCost = chatApiCalls > 0
    ? Math.round((chatCostCents / chatApiCalls) * 100) / 100
    : 0;

  const costAxisMax = useMemo(() => {
    let m = 0;
    for (const row of chartData) {
      if (row.Cost > m) m = row.Cost;
    }
    const headroom = m > 0 ? m * 1.12 : 1;
    return Math.max(headroom, 0.01);
  }, [chartData]);

  if (chatApiCalls === 0 && chartData.length === 0 && subagentSnapshots.length === 0 && swarmSnapshots.length === 0) {
    return (
      <div className="text-xs text-studio-muted py-6 text-center">
        No round data yet. Cost and I/O metrics appear after the first API round.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {chartData.length > 0 && (
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 4, bottom: 0 }} barCategoryGap="18%" barGap={1}>
            <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
            <XAxis
              dataKey="round"
              type="category"
              tick={{ fill: '#737373', fontSize: 10 }}
              tickLine={false}
              label={{ value: 'Round', position: 'insideBottomRight', offset: -4, fill: '#737373', fontSize: 10 }}
            />
            <YAxis
              yAxisId="tokens"
              tickFormatter={fmtK}
              tick={{ fill: '#737373', fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: '#262626' }}
              width={48}
            />
            <YAxis
              yAxisId="cost"
              orientation="right"
              tick={{ fill: '#eab308', fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: '#262626' }}
              width={40}
              tickFormatter={(v: number) => formatCost(v)}
              domain={[0, costAxisMax]}
            />
            <Tooltip
              contentStyle={{ backgroundColor: '#141414', border: '1px solid #262626', borderRadius: 6, fontSize: 11 }}
              labelStyle={{ color: '#e5e5e5' }}
              formatter={(value?: number, name?: string) => {
                const v = value ?? 0;
                return name === 'Cost' ? formatCost(v) : fmtK(v);
              }}
              labelFormatter={(l) => `Main Round ${l}`}
            />
            <RLegend
              wrapperStyle={{ fontSize: 10, color: '#737373' }}
              iconSize={8}
            />
            <Bar yAxisId="tokens" dataKey="Input" stackId="io" fill={COLORS.input} fillOpacity={0.85} radius={[0, 0, 0, 0]} maxBarSize={40} isAnimationActive={false} />
            <Bar yAxisId="tokens" dataKey="Cache Read" stackId="io" fill={COLORS.cacheRead} fillOpacity={0.9} radius={[0, 0, 0, 0]} maxBarSize={40} isAnimationActive={false} />
            <Bar yAxisId="tokens" dataKey="Output" stackId="io" fill={COLORS.output} fillOpacity={0.85} radius={[2, 2, 0, 0]} maxBarSize={40} isAnimationActive={false} />
            <Line
              yAxisId="cost"
              type="monotone"
              dataKey="Cost"
              stroke={COLORS.cost}
              strokeWidth={2}
              dot={{ r: 2.5, fill: COLORS.cost, strokeWidth: 0 }}
              activeDot={{ r: 4, fill: COLORS.cost }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <StatCard label="Total Cost" value={formatCost(chatCostCents)} accent />
        <StatCard label="Avg Cost/Main Round" value={formatCost(avgCost)} />
        <StatCard label="Main Input" value={fmtK(totalInput)} />
        <StatCard label="Main Output" value={fmtK(totalOutput)} />
        <StatCard label="Main Cache Reads" value={fmtK(totalCacheRead)} />
      </div>

      <div className="text-[10px] text-studio-muted">
        Showing {chartData.length} main chat rounds
        {(subagentSnapshots.length > 0 || swarmSnapshots.length > 0) && (
          <span>
            {' '}
            ({[
              subagentSnapshots.length > 0 && `${subagentSnapshots.length} subagent`,
              swarmSnapshots.length > 0 && `${swarmSnapshots.length} swarm`,
            ].filter(Boolean).join('; ')} excluded)
          </span>
        )}
        .
      </div>

      {subAgentUsages.length > 0 && (
        <div className="border border-teal-500/20 rounded-lg p-2 bg-teal-500/5">
          <div className="text-[10px] text-teal-400 uppercase tracking-wide mb-1">SubAgent Cost Breakdown</div>
          <div className="grid grid-cols-3 gap-2">
            <StatCard label="Main Model" value={formatCost(chatCostCents - chatSubAgentCostCents)} />
            <StatCard
              label={`SubAgents x${subAgentUsages.length}`}
              value={formatCost(chatSubAgentCostCents)}
            />
            <StatCard
              label="Pin Tokens"
              value={fmtK(subAgentUsages.reduce((s, u) => s + u.pinTokens, 0))}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
      <div className="text-[10px] text-studio-muted">{label}</div>
      <div className={`text-sm font-semibold font-mono ${accent ? 'text-studio-warning' : 'text-studio-text'}`}>{value}</div>
    </div>
  );
}

