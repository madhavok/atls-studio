import { useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { useRoundHistoryStore, isMainChatRound } from '../../../stores/roundHistoryStore';

const COLORS = {
  staticSystem: '#ef4444',
  history: '#0ea5e9',
  staged: '#3b82f6',
  workspace: '#a855f7',
  blackboard: '#a855f7',
  wm: '#a3a3a3',
  archived: '#ec4899',
  overhead: '#ec4899',
  free: 'rgba(34,197,94,0.3)',
};

function fmtK(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v);
}

export function ContextTimelineSection() {
  const snapshots = useRoundHistoryStore((s) => s.snapshots);

  // Main chat agent only (excludes subagent + swarm worker snapshots)
  const mainSnapshots = useMemo(() => snapshots.filter(isMainChatRound), [snapshots]);
  // Track which rounds had subagent invocations for event markers
  const subagentRounds = useMemo(() => {
    const rounds = new Set<number>();
    for (const s of snapshots) {
      if (s.isSubagentRound) rounds.add(s.round);
    }
    return rounds;
  }, [snapshots]);

  const data = useMemo(
    () =>
      mainSnapshots.map((s) => {
        const workingMemoryPromptTokens = Math.max(
          0,
          s.estimatedTotalPromptTokens
            - s.staticSystemTokens
            - s.conversationHistoryTokens
            - s.stagedBucketTokens
            - s.workspaceContextTokens
            - s.overheadTokens,
        );
        const freePromptTokens = Math.max(0, s.maxTokens - s.estimatedTotalPromptTokens);

        return {
          round: s.round,
          'Static/System': s.staticSystemTokens,
          'History': s.conversationHistoryTokens,
          Staged: s.stagedBucketTokens,
          Workspace: s.workspaceContextTokens,
          'Working Memory': workingMemoryPromptTokens,
          Overhead: s.overheadTokens,
          Free: freePromptTokens,
          max: s.maxTokens,
        };
      }),
    [mainSnapshots],
  );

  if (data.length === 0) {
    return (
      <div className="text-xs text-studio-muted py-6 text-center">
        No round data yet. Start a conversation to see context grow and shrink over time.
      </div>
    );
  }

  const maxTokens = data[data.length - 1]?.max ?? 200000;

  return (
    <div className="space-y-3">
      <div className="flex justify-between text-[10px] text-studio-muted">
        <span>Stacked prompt-sent composition per round</span>
        <span>Budget: {fmtK(maxTokens)} tokens</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
          <XAxis
            dataKey="round"
            type="category"
            tick={{ fill: '#737373', fontSize: 10 }}
            tickLine={false}
            label={{ value: 'Round', position: 'insideBottomRight', offset: -4, fill: '#737373', fontSize: 10 }}
          />
          <YAxis
            tickFormatter={fmtK}
            tick={{ fill: '#737373', fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: '#262626' }}
            width={48}
            domain={[0, maxTokens]}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const round = typeof label === 'number' ? label : Number(label);
              const snap = mainSnapshots.find((s) => s.round === round);
              return (
                <div
                  style={{ backgroundColor: '#141414', border: '1px solid #262626', borderRadius: 6, fontSize: 11, padding: '8px 10px' }}
                  className="text-neutral-200"
                >
                  <div className="font-medium mb-1">Round {label}</div>
                  {snap?.verificationConfidence != null && (
                    <div className="text-[10px] text-neutral-400 mb-0.5">
                      Verify: <span className="text-neutral-200">{snap.verificationConfidence}</span>
                      {snap.verificationLabel ? ` — ${snap.verificationLabel}` : ''}
                    </div>
                  )}
                  {snap?.historyBreakdownLabel != null && snap.historyBreakdownLabel.length > 0 && (
                    <div className="text-[9px] text-neutral-500 font-mono mb-0.5 max-w-[280px] break-all">{snap.historyBreakdownLabel}</div>
                  )}
                  {snap?.roundLatencyMs != null && (
                    <div className="text-[10px] text-neutral-400 mb-1">
                      Latency {snap.roundLatencyMs.toFixed(0)} ms
                      {snap.timeToFirstTokenMs != null ? ` · TTFT ${snap.timeToFirstTokenMs.toFixed(0)} ms` : ''}
                    </div>
                  )}
                  {payload.map((p) => (
                    <div key={String(p.dataKey)} className="flex justify-between gap-4 text-[10px]">
                      <span style={{ color: p.color }}>{p.name}</span>
                      <span>{fmtK(Number(p.value) || 0)}</span>
                    </div>
                  ))}
                </div>
              );
            }}
          />
          <ReferenceLine y={maxTokens} stroke="#737373" strokeDasharray="4 2" label={{ value: 'max', fill: '#737373', fontSize: 9, position: 'right' }} />
          {/* SubAgent invocation markers */}
          {[...subagentRounds].map((round) => (
            <ReferenceLine
              key={`sa-${round}`}
              x={round}
              stroke="#14b8a6"
              strokeDasharray="3 3"
              strokeWidth={1.5}
              label={{ value: 'SA', fill: '#14b8a6', fontSize: 8, position: 'top' }}
            />
          ))}
          <Area type="monotone" dataKey="Static/System" stackId="1" stroke={COLORS.staticSystem} fill={COLORS.staticSystem} fillOpacity={0.7} isAnimationActive={false} />
          <Area type="monotone" dataKey="History" stackId="1" stroke={COLORS.history} fill={COLORS.history} fillOpacity={0.65} isAnimationActive={false} />
          <Area type="monotone" dataKey="Staged" stackId="1" stroke={COLORS.staged} fill={COLORS.staged} fillOpacity={0.55} isAnimationActive={false} />
          <Area type="monotone" dataKey="Workspace" stackId="1" stroke={COLORS.workspace} fill={COLORS.workspace} fillOpacity={0.5} isAnimationActive={false} />
          <Area type="monotone" dataKey="Working Memory" stackId="1" stroke={COLORS.wm} fill={COLORS.wm} fillOpacity={0.5} isAnimationActive={false} />
          <Area type="monotone" dataKey="Overhead" stackId="1" stroke={COLORS.overhead} fill={COLORS.overhead} fillOpacity={0.35} isAnimationActive={false} />
          <Area type="monotone" dataKey="Free" stackId="1" stroke="transparent" fill={COLORS.free} fillOpacity={1} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
      <div className="text-[10px] text-studio-muted">
        Main chat rounds only (subagent and swarm worker rounds excluded). Staged and archived tokens are tracked memory-state metrics and are excluded here because they are not additive prompt slices.
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] text-studio-muted">
        <Legend color={COLORS.staticSystem} label="Static/System" />
        <Legend color={COLORS.history} label="History" />
        <Legend color={COLORS.staged} label="Staged" />
        <Legend color={COLORS.workspace} label="Workspace" />
        <Legend color={COLORS.wm} label="Working Memory" />
        <Legend color={COLORS.overhead} label="Overhead" />
        <Legend color={COLORS.free} label="Free" />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
