import { useState, useMemo } from 'react';
import { useAppStore, type Message } from '../../../stores/appStore';
import { analyzeToolTokens, formatToolDisplayName, type ToolTokenReport, type ToolTokenEntry } from '../../../utils/toolTokenMetrics';

type SortKey = 'name' | 'calls' | 'argTokens' | 'resultTokens' | 'totalTokens' | 'avg' | 'max';

export function ToolTokenSection() {
  const messages = useAppStore((s) => s.messages);
  const [sortKey, setSortKey] = useState<SortKey>('totalTokens');
  const [sortAsc, setSortAsc] = useState(false);

  const report: ToolTokenReport = useMemo(
    () => analyzeToolTokens(messages as Message[]),
    [messages],
  );

  const sorted = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    return [...report.entries].sort((a, b) => {
      switch (sortKey) {
        case 'name': return dir * formatToolDisplayName(a.toolName).localeCompare(formatToolDisplayName(b.toolName));
        case 'calls': return dir * (a.callCount - b.callCount);
        case 'argTokens': return dir * (a.totalArgTokens - b.totalArgTokens);
        case 'resultTokens': return dir * (a.totalResultTokens - b.totalResultTokens);
        case 'totalTokens': return dir * (a.totalTokens - b.totalTokens);
        case 'avg': return dir * (a.avgResultTokens - b.avgResultTokens);
        case 'max': return dir * (a.maxResultTokens - b.maxResultTokens);
        default: return 0;
      }
    });
  }, [report.entries, sortKey, sortAsc]);

  const maxTotal = useMemo(
    () => Math.max(1, ...report.entries.map((e) => e.totalTokens)),
    [report.entries],
  );

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  const SortHeader = ({ label, k, align }: { label: string; k: SortKey; align?: string }) => (
    <th
      className={`px-2 py-1.5 text-xs font-medium text-studio-muted cursor-pointer hover:text-studio-text select-none ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => handleSort(k)}
    >
      {label} {sortKey === k ? (sortAsc ? '↑' : '↓') : ''}
    </th>
  );

  return (
    <div className="space-y-3">
      {/* Grand totals */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <GrandStat label="Tool Calls" value={report.totalToolCalls} />
        <GrandStat label="Arg Tokens" value={report.grandTotalArgTokens.toLocaleString()} />
        <GrandStat label="Result Tokens" value={report.grandTotalResultTokens.toLocaleString()} />
        <GrandStat label="Total Tool Tokens" value={report.grandTotalTokens.toLocaleString()} accent />
        <GrandStat label="Text / User Tokens" value={`${report.textSegmentTokens.toLocaleString()} / ${report.userMessageTokens.toLocaleString()}`} />
      </div>

      <div className="text-[10px] text-studio-muted">
        Tool rows show emitted tool names; batch child steps appear under their concrete step tool names when telemetry is available.
      </div>

      {/* Per-tool bar chart */}
      {sorted.length > 0 && (
        <div className="space-y-1">
          {sorted.slice(0, 10).map((entry) => {
            const argPct = maxTotal > 0 ? (entry.totalArgTokens / maxTotal) * 100 : 0;
            const resPct = maxTotal > 0 ? (entry.totalResultTokens / maxTotal) * 100 : 0;
            return (
              <div key={entry.toolName} className="flex items-center gap-2 text-xs">
                <span className="w-28 truncate text-studio-muted font-mono" title={formatToolDisplayName(entry.toolName)}>
                  {formatToolDisplayName(entry.toolName)}
                </span>
                <div className="flex-1 h-3 bg-studio-border/20 rounded-full overflow-hidden flex">
                  <div className="h-full bg-blue-500/60" style={{ width: `${argPct}%` }} title={`Args: ${entry.totalArgTokens}`} />
                  <div className="h-full bg-orange-500/60" style={{ width: `${resPct}%` }} title={`Results: ${entry.totalResultTokens}`} />
                </div>
                <span className="w-14 text-right font-mono text-studio-muted">{entry.totalTokens.toLocaleString()}</span>
              </div>
            );
          })}
          <div className="flex gap-3 text-[10px] text-studio-muted mt-1">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-500/60" /> Args</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-orange-500/60" /> Results</span>
          </div>
        </div>
      )}

      {/* Detailed table */}
      <div className="overflow-x-auto max-h-56 overflow-y-auto scrollbar-thin">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-studio-surface">
            <tr className="border-b border-studio-border">
              <SortHeader label="Tool" k="name" />
              <SortHeader label="Calls" k="calls" align="right" />
              <SortHeader label="Arg Tk" k="argTokens" align="right" />
              <SortHeader label="Result Tk" k="resultTokens" align="right" />
              <SortHeader label="Total" k="totalTokens" align="right" />
              <SortHeader label="Avg Result" k="avg" align="right" />
              <SortHeader label="Max Result" k="max" align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => (
              <tr key={entry.toolName} className="border-b border-studio-border/30 hover:bg-studio-border/20">
                <td className="px-2 py-1 font-mono text-studio-accent">{formatToolDisplayName(entry.toolName)}</td>
                <td className="px-2 py-1 text-right">{entry.callCount}</td>
                <td className="px-2 py-1 text-right font-mono">{entry.totalArgTokens.toLocaleString()}</td>
                <td className="px-2 py-1 text-right font-mono">{entry.totalResultTokens.toLocaleString()}</td>
                <td className="px-2 py-1 text-right font-mono font-medium">{entry.totalTokens.toLocaleString()}</td>
                <td className="px-2 py-1 text-right font-mono text-studio-muted">{entry.avgResultTokens.toLocaleString()}</td>
                <td className="px-2 py-1 text-right font-mono text-studio-muted">{entry.maxResultTokens.toLocaleString()}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={7} className="px-2 py-4 text-center text-studio-muted">No tool calls in current chat</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GrandStat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
      <div className="text-[10px] text-studio-muted">{label}</div>
      <div className={`text-sm font-semibold ${accent ? 'text-studio-accent' : 'text-studio-text'}`}>{value}</div>
    </div>
  );
}
