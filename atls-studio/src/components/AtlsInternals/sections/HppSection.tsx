import { useState, useMemo } from 'react';
import { getAllRefs, getTurn, type ChunkRef, type ChunkVisibility } from '../../../services/hashProtocol';
import { useCostStore } from '../../../stores/costStore';
import { useAppStore } from '../../../stores/appStore';

type SortKey = 'hash' | 'type' | 'source' | 'tokens' | 'visibility' | 'turn';

const VISIBILITY_COLORS: Record<ChunkVisibility, string> = {
  materialized: 'text-green-400',
  referenced: 'text-yellow-400',
  archived: 'text-blue-400',
  evicted: 'text-red-400',
};

const VISIBILITY_BG: Record<ChunkVisibility, string> = {
  materialized: 'bg-green-500/20',
  referenced: 'bg-yellow-500/20',
  archived: 'bg-blue-500/20',
  evicted: 'bg-red-500/20',
};

export function HppSection() {
  const [filterType, setFilterType] = useState<string>('all');
  const [filterVis, setFilterVis] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('turn');
  const [sortAsc, setSortAsc] = useState(false);

  const outputTokensSaved = useCostStore((s) => s.outputTokensSaved);
  const outputDedupsApplied = useCostStore((s) => s.outputDedupsApplied);
  const refDensityHistory = useCostStore((s) => s.refDensityHistory);
  const setRefReplacements = useCostStore((s) => s.setRefReplacements);
  const setRefTokensSaved = useCostStore((s) => s.setRefTokensSaved);

  const turn = getTurn();
  const refs = useMemo(() => getAllRefs(), [turn]);

  const types = useMemo(() => {
    const s = new Set(refs.map((r) => r.type));
    return ['all', ...Array.from(s).sort()];
  }, [refs]);

  const filtered = useMemo(() => {
    let list = refs;
    if (filterType !== 'all') list = list.filter((r) => r.type === filterType);
    if (filterVis !== 'all') list = list.filter((r) => r.visibility === filterVis);

    const dir = sortAsc ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'hash': return dir * a.shortHash.localeCompare(b.shortHash);
        case 'type': return dir * a.type.localeCompare(b.type);
        case 'source': return dir * (a.source ?? '').localeCompare(b.source ?? '');
        case 'tokens': return dir * (a.tokens - b.tokens);
        case 'visibility': return dir * a.visibility.localeCompare(b.visibility);
        case 'turn': return dir * (a.seenAtTurn - b.seenAtTurn);
        default: return 0;
      }
    });
  }, [refs, filterType, filterVis, sortKey, sortAsc]);

  const counts = useMemo(() => {
    const c = { materialized: 0, referenced: 0, archived: 0, evicted: 0, totalTokens: 0 };
    for (const r of refs) {
      c[r.visibility]++;
      c.totalTokens += r.tokens;
    }
    return c;
  }, [refs]);

  const latestDensity = refDensityHistory.length > 0
    ? refDensityHistory[refDensityHistory.length - 1]
    : 0;

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  const openFile = useAppStore.getState().openFile;
  const handleRefClick = (ref: ChunkRef) => {
    if (ref.source && !ref.source.includes('*')) {
      openFile(ref.source);
    }
  };

  const SortHeader = ({ label, k }: { label: string; k: SortKey }) => (
    <th
      className="px-2 py-1.5 text-left text-xs font-medium text-studio-muted cursor-pointer hover:text-studio-text select-none"
      onClick={() => handleSort(k)}
    >
      {label} {sortKey === k ? (sortAsc ? '↑' : '↓') : ''}
    </th>
  );

  return (
    <div className="space-y-3">
      {/* Stats Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCard label="Total Refs" value={refs.length} />
        <StatCard label="Current Turn" value={turn} />
        <StatCard label="Output Tokens Saved" value={outputTokensSaved.toLocaleString()} accent />
        <StatCard label="Dedup Applied" value={outputDedupsApplied} />
      </div>

      {/* Visibility breakdown */}
      <div className="flex gap-3 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-studio-muted">Materialized</span>
          <span className="text-studio-text font-medium">{counts.materialized}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-yellow-500" />
          <span className="text-studio-muted">Referenced</span>
          <span className="text-studio-text font-medium">{counts.referenced}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          <span className="text-studio-muted">Evicted</span>
          <span className="text-studio-text font-medium">{counts.evicted}</span>
        </span>
      </div>

      {/* HPP v3 stats */}
      <div className="flex gap-4 text-xs text-studio-muted">
        <span>Set-Ref Replacements: <span className="text-studio-text font-medium">{setRefReplacements}</span></span>
        <span>Set-Ref Tokens Saved: <span className="text-studio-text font-medium">{setRefTokensSaved.toLocaleString()}</span></span>
        <span>Ref Density: <span className="text-studio-text font-medium">{(latestDensity * 100).toFixed(1)}%</span></span>
      </div>

      {/* Density sparkline */}
      {refDensityHistory.length > 1 && (
        <div className="h-8 flex items-end gap-px">
          {refDensityHistory.slice(-40).map((d, i) => (
            <div
              key={i}
              className="flex-1 bg-studio-accent/60 rounded-t-sm min-w-[2px]"
              style={{ height: `${Math.min(100, Math.max(2, d * 100))}%` }}
              title={`${(d * 100).toFixed(1)}%`}
            />
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 text-xs">
        <select
          className="bg-studio-surface border border-studio-border rounded px-2 py-1 text-studio-text text-xs"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
        >
          {types.map((t) => <option key={t} value={t}>{t === 'all' ? 'All Types' : t}</option>)}
        </select>
        <select
          className="bg-studio-surface border border-studio-border rounded px-2 py-1 text-studio-text text-xs"
          value={filterVis}
          onChange={(e) => setFilterVis(e.target.value)}
        >
          <option value="all">All Visibility</option>
          <option value="materialized">Materialized</option>
          <option value="referenced">Referenced</option>
          <option value="evicted">Evicted</option>
        </select>
        <span className="text-studio-muted ml-auto">{filtered.length} refs</span>
      </div>

      {/* Ref Table */}
      <div className="overflow-x-auto max-h-64 overflow-y-auto scrollbar-thin">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-studio-surface">
            <tr className="border-b border-studio-border">
              <SortHeader label="Hash" k="hash" />
              <SortHeader label="Type" k="type" />
              <SortHeader label="Source" k="source" />
              <SortHeader label="Tokens" k="tokens" />
              <SortHeader label="Visibility" k="visibility" />
              <SortHeader label="Turn" k="turn" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((ref) => (
              <tr
                key={ref.hash}
                className="border-b border-studio-border/30 hover:bg-studio-border/20 cursor-pointer"
                onClick={() => handleRefClick(ref)}
              >
                <td className="px-2 py-1 font-mono text-studio-accent">h:{ref.shortHash}</td>
                <td className="px-2 py-1">
                  <span className="px-1.5 py-0.5 rounded bg-studio-border/40 text-studio-text">{ref.type}</span>
                </td>
                <td className="px-2 py-1 text-studio-muted max-w-[200px] truncate" title={ref.source}>
                  {ref.source ? ref.source.split(/[/\\]/).pop() : '—'}
                </td>
                <td className="px-2 py-1 text-right font-mono">{ref.tokens.toLocaleString()}</td>
                <td className="px-2 py-1">
                  <span className={`px-1.5 py-0.5 rounded text-xs ${VISIBILITY_BG[ref.visibility]} ${VISIBILITY_COLORS[ref.visibility]}`}>
                    {ref.visibility}
                  </span>
                </td>
                <td className="px-2 py-1 text-right font-mono text-studio-muted">{ref.seenAtTurn}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-2 py-4 text-center text-studio-muted">No refs registered</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="bg-studio-surface/50 rounded px-3 py-2 border border-studio-border/30">
      <div className="text-[10px] text-studio-muted uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-semibold ${accent ? 'text-studio-accent' : 'text-studio-text'}`}>{value}</div>
    </div>
  );
}
