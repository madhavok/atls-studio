import { useMemo } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend as RLegend,
} from 'recharts';
import { useRoundHistoryStore, isMainChatRound, computeMainChatRoundCostStats } from '../../../stores/roundHistoryStore';
import { useCostStore, formatCost } from '../../../stores/costStore';

const COLORS = {
  input: '#3b82f6',
  output: '#a855f7',
  cacheRead: 'rgba(34,197,94,0.55)',
  cacheWrite: '#f59e0b',
  cost: '#eab308',
  cacheSaved: '#22c55e',
};

function fmtK(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

export function CostIOSection() {
  const snapshots = useRoundHistoryStore((s) => s.snapshots);

  const chatCostCents = useCostStore((s) => s.chatCostCents);
  const chatSubAgentCostCents = useCostStore((s) => s.chatSubAgentCostCents);
  const subAgentUsages = useCostStore((s) => s.subAgentUsages);

  const mainSnapshots = useMemo(() => snapshots.filter(isMainChatRound), [snapshots]);
  const subagentSnapshots = useMemo(() => snapshots.filter((s) => s.isSubagentRound), [snapshots]);
  const swarmSnapshots = useMemo(() => snapshots.filter((s) => s.isSwarmRound), [snapshots]);

  const { mainRoundsCostSum, avgMainRoundCost, avgInputCost, avgOutputCost, truncated: roundHistoryTruncated } = useMemo(
    () => computeMainChatRoundCostStats(snapshots),
    [snapshots],
  );

  const researchRatio = useMemo(() => {
    if (mainSnapshots.length === 0) return 0;
    const researchCount = mainSnapshots.filter(s => s.isResearchRound).length;
    return researchCount / mainSnapshots.length;
  }, [mainSnapshots]);

  const avgNewCoverageResearchRounds = useMemo(() => {
    const research = mainSnapshots.filter(s => s.isResearchRound);
    if (research.length === 0) return null;
    const sum = research.reduce((a, s) => a + (s.newCoverage ?? 0), 0);
    return Math.round((sum / research.length) * 10) / 10;
  }, [mainSnapshots]);

  const { chartData, costData, totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCacheSavings } = useMemo(() => {
    const cd = mainSnapshots.map((s) => {
      // Anthropic: inputTokens = uncached only, cache buckets are non-overlapping → stack all.
      // OpenAI/Google/Vertex: inputTokens = total prompt including cached subset → subtract to avoid double-count.
      const isAnthropicRound = s.provider === 'anthropic';
      const uncachedInput = isAnthropicRound
        ? s.inputTokens
        : Math.max(0, s.inputTokens - s.cacheReadTokens);
      return {
        round: s.round,
        Input: uncachedInput,
        Output: s.outputTokens,
        'Cache Read': s.cacheReadTokens,
        'Cache Write': s.cacheWriteTokens,
      };
    });
    const costD = mainSnapshots.map((s) => ({
      round: s.round,
      Cost: Math.round(s.costCents * 100) / 100,
      // Billing-grade per-round cache savings — (no-cache cost) − (actual cost).
      // 0 when the round had no cache tokens, non-negative otherwise.
      'Cache Saved': Math.round((s.cacheSavingsCents ?? 0) * 100) / 100,
    }));
    let tIn = 0, tOut = 0, tCache = 0, tCacheW = 0, tCacheSave = 0;
    for (const s of mainSnapshots) {
      tIn += s.inputTokens;
      tOut += s.outputTokens;
      tCache += s.cacheReadTokens;
      tCacheW += s.cacheWriteTokens;
      tCacheSave += s.cacheSavingsCents ?? 0;
    }
    return {
      chartData: cd,
      costData: costD,
      totalInput: tIn,
      totalOutput: tOut,
      totalCacheRead: tCache,
      totalCacheWrite: tCacheW,
      totalCacheSavings: tCacheSave,
    };
  }, [mainSnapshots]);

  const costAxisMax = useMemo(() => {
    let m = 0;
    for (const row of costData) {
      if (row.Cost > m) m = row.Cost;
    }
    const headroom = m > 0 ? m * 1.12 : 1;
    return Math.max(headroom, 0.01);
  }, [costData]);

  if (chatCostCents === 0 && chartData.length === 0 && subagentSnapshots.length === 0 && swarmSnapshots.length === 0) {
    return (
      <div className="text-xs text-studio-muted py-6 text-center">
        No round data yet. Cost and I/O metrics appear after the first API round.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {chartData.length > 0 && (
        <>
          {/* Token I/O stacked bars — single Y-axis */}
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, left: 4, bottom: 0 }} barCategoryGap="18%" barGap={1}>
              <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
              <XAxis
                dataKey="round"
                type="category"
                tick={{ fill: '#737373', fontSize: 10 }}
                tickLine={false}
              />
              <YAxis
                tickFormatter={fmtK}
                tick={{ fill: '#737373', fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: '#262626' }}
                width={48}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#141414', border: '1px solid #262626', borderRadius: 6, fontSize: 11 }}
                labelStyle={{ color: '#e5e5e5' }}
                formatter={(value?: number) => fmtK(value ?? 0)}
                labelFormatter={(l) => `Main Round ${l}`}
              />
              <RLegend wrapperStyle={{ fontSize: 10, color: '#737373' }} iconSize={8} />
              <Bar dataKey="Input" stackId="io" fill={COLORS.input} fillOpacity={0.85} radius={[0, 0, 0, 0]} maxBarSize={40} isAnimationActive={false} />
              <Bar dataKey="Cache Read" stackId="io" fill={COLORS.cacheRead} fillOpacity={0.9} radius={[0, 0, 0, 0]} maxBarSize={40} isAnimationActive={false} />
              <Bar dataKey="Cache Write" stackId="io" fill={COLORS.cacheWrite} fillOpacity={0.85} radius={[0, 0, 0, 0]} maxBarSize={40} isAnimationActive={false} />
              <Bar dataKey="Output" stackId="io" fill={COLORS.output} fillOpacity={0.85} radius={[2, 2, 0, 0]} maxBarSize={40} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>

          {/* Cost per round — separate chart, single Y-axis */}
          <ResponsiveContainer width="100%" height={100}>
            <LineChart data={costData} margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
              <XAxis
                dataKey="round"
                type="category"
                tick={{ fill: '#737373', fontSize: 10 }}
                tickLine={false}
                label={{ value: 'Round', position: 'insideBottomRight', offset: -4, fill: '#737373', fontSize: 10 }}
              />
              <YAxis
                tickFormatter={(v: number) => formatCost(v)}
                tick={{ fill: '#eab308', fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: '#262626' }}
                width={48}
                domain={[0, costAxisMax]}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#141414', border: '1px solid #262626', borderRadius: 6, fontSize: 11 }}
                labelStyle={{ color: '#e5e5e5' }}
                formatter={(value?: number) => formatCost(value ?? 0)}
                labelFormatter={(l) => `Main Round ${l}`}
              />
              <Line
                type="monotone"
                dataKey="Cost"
                stroke={COLORS.cost}
                strokeWidth={2}
                dot={{ r: 2.5, fill: COLORS.cost, strokeWidth: 0 }}
                activeDot={{ r: 4, fill: COLORS.cost }}
                isAnimationActive={false}
              />
              {totalCacheSavings > 0 && (
                <Line
                  type="monotone"
                  dataKey="Cache Saved"
                  stroke={COLORS.cacheSaved}
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  dot={{ r: 2, fill: COLORS.cacheSaved, strokeWidth: 0 }}
                  activeDot={{ r: 3.5, fill: COLORS.cacheSaved }}
                  isAnimationActive={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <StatCard
          label="Session total"
          value={formatCost(chatCostCents)}
          subtitle="main + subagents (API)"
          accent
        />
        <StatCard
          label="Main rounds total"
          value={mainSnapshots.length > 0 ? formatCost(mainRoundsCostSum) : '—'}
          subtitle="sum of main snapshot costs (chart series)"
        />
        <StatCard
          label={roundHistoryTruncated ? 'Avg cost / main round (~)' : 'Avg cost / main round'}
          value={mainSnapshots.length > 0 ? formatCost(avgMainRoundCost) : '—'}
          subtitle={
            roundHistoryTruncated
              ? 'windowed: avg over last 200 rounds; older dropped'
              : 'main agent only; session total includes subagents'
          }
        />
        <StatCard label="Main input" value={fmtK(totalInput)} />
        <StatCard label="Main output" value={fmtK(totalOutput)} />
        <StatCard label="Main cache reads" value={fmtK(totalCacheRead)} />
        <StatCard label="Main cache writes" value={fmtK(totalCacheWrite)} subtitle="1.25× input price" />
        <StatCard
          label="Cache savings (billed)"
          value={totalCacheSavings > 0 ? formatCost(totalCacheSavings) : '—'}
          subtitle="(no-cache cost) − (actual cost) per round, summed"
        />
        <StatCard
          label="Avg input cost"
          value={mainSnapshots.length > 0 ? formatCost(avgInputCost) : '—'}
          subtitle="per main round"
        />
        <StatCard
          label="Avg output cost"
          value={mainSnapshots.length > 0 ? formatCost(avgOutputCost) : '—'}
          subtitle="per main round"
        />
        {mainSnapshots.length > 0 && (
          <StatCard
            label="Research ratio"
            value={`${Math.round(researchRatio * 100)}%`}
            subtitle={
              researchRatio > 0.7
                ? 'high — many mutation-free rounds; may be spinning'
                : 'share of main rounds with no edit / delegate / BB write'
            }
            accent={researchRatio > 0.7}
          />
        )}
        {avgNewCoverageResearchRounds != null && (
          <StatCard
            label="Avg new files (research)"
            value={String(avgNewCoverageResearchRounds)}
            subtitle="mean newCoverage on mutation-free rounds; higher = more fresh paths per round"
          />
        )}
      </div>

      <div className="text-[10px] text-studio-muted space-y-0.5">
        <div>
          Showing {chartData.length} main chat rounds
          {(subagentSnapshots.length > 0 || swarmSnapshots.length > 0) && (
            <span>
              {' '}
              ({[
                subagentSnapshots.length > 0 && `${subagentSnapshots.length} subagent`,
                swarmSnapshots.length > 0 && `${swarmSnapshots.length} swarm`,
              ].filter(Boolean).join('; ')} excluded from chart)
            </span>
          )}
          .
        </div>
        {swarmSnapshots.length > 0 && (
          <div>
            Swarm worker API cost is not included in session total (isolated metrics).
          </div>
        )}
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

function StatCard({ label, value, subtitle, accent }: { label: string; value: string; subtitle?: string; accent?: boolean }) {
  return (
    <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
      <div className="text-[10px] text-studio-muted">{label}</div>
      <div className={`text-sm font-semibold font-mono ${accent ? 'text-studio-warning' : 'text-studio-text'}`}>{value}</div>
      {subtitle && <div className="text-[9px] text-studio-muted mt-0.5 leading-tight">{subtitle}</div>}
    </div>
  );
}
