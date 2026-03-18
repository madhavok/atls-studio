import { useCostStore, formatCost, type SubAgentUsage } from '../../../stores/costStore';
import { useRoundHistoryStore } from '../../../stores/roundHistoryStore';
import { useMemo, useState } from 'react';

function fmtK(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

function InvocationRow({ usage }: { usage: SubAgentUsage }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-studio-border/20 rounded overflow-hidden">
      <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-studio-surface/50 text-xs"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-teal-400 font-medium capitalize">{usage.type}</span>
        <span className="text-studio-muted">{usage.model}</span>
        <span className="text-studio-muted ml-auto">{usage.rounds}r / {usage.toolCalls}t</span>
        <span className="text-studio-warning font-mono">{formatCost(usage.costCents)}</span>
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
            <span className="text-studio-muted">Provider</span>
            <span>{usage.provider}</span>
            <span className="text-studio-muted">Input tokens</span>
            <span>{fmtK(usage.inputTokens)}</span>
            <span className="text-studio-muted">Output tokens</span>
            <span>{fmtK(usage.outputTokens)}</span>
            <span className="text-studio-muted">Cache read</span>
            <span>{fmtK(usage.cacheReadTokens)}</span>
            <span className="text-studio-muted">Pin tokens</span>
            <span className="text-teal-400">{fmtK(usage.pinTokens)}</span>
            <span className="text-studio-muted">Pin efficiency</span>
            <span>
              {usage.inputTokens > 0
                ? `${((usage.pinTokens / usage.inputTokens) * 100).toFixed(1)}%`
                : 'N/A'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function SubAgentSection() {
  const subAgentUsages = useCostStore((s) => s.subAgentUsages);
  const chatSubAgentCostCents = useCostStore((s) => s.chatSubAgentCostCents);
  const chatCostCents = useCostStore((s) => s.chatCostCents);
  const snapshots = useRoundHistoryStore((s) => s.snapshots);

  const stats = useMemo(() => {
    const subRounds = snapshots.filter((s) => s.isSubagentRound);
    const totalPinTokens = subAgentUsages.reduce((s, u) => s + u.pinTokens, 0);
    const totalToolCalls = subAgentUsages.reduce((s, u) => s + u.toolCalls, 0);
    const avgCost = subAgentUsages.length > 0
      ? chatSubAgentCostCents / subAgentUsages.length
      : 0;
    const mainModelCost = chatCostCents - chatSubAgentCostCents;
    const costRatio = mainModelCost > 0
      ? chatSubAgentCostCents / mainModelCost
      : 0;

    return {
      invocations: subAgentUsages.length,
      subRounds: subRounds.length,
      totalPinTokens,
      totalToolCalls,
      avgCost,
      costRatio,
    };
  }, [subAgentUsages, chatSubAgentCostCents, chatCostCents, snapshots]);

  if (subAgentUsages.length === 0) {
    return (
      <div className="text-xs text-studio-muted py-6 text-center">
        No subagent invocations yet. The main model can dispatch a retriever subagent via the <code className="text-teal-400">subagent</code> tool.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Invocations</div>
          <div className="text-sm font-semibold font-mono text-teal-400">{stats.invocations}</div>
        </div>
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Total Cost</div>
          <div className="text-sm font-semibold font-mono text-studio-warning">{formatCost(chatSubAgentCostCents)}</div>
        </div>
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Pin Tokens</div>
          <div className="text-sm font-semibold font-mono">{fmtK(stats.totalPinTokens)}</div>
        </div>
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Cost Ratio</div>
          <div className="text-sm font-semibold font-mono">
            {(stats.costRatio * 100).toFixed(1)}%
          </div>
          <div className="text-[9px] text-studio-muted">of main model cost</div>
        </div>
      </div>

      {/* Per-invocation list */}
      <div className="space-y-1">
        <div className="text-[10px] text-studio-muted uppercase tracking-wide">Invocations</div>
        {subAgentUsages.map((usage) => (
          <InvocationRow key={usage.invocationId} usage={usage} />
        ))}
      </div>
    </div>
  );
}
