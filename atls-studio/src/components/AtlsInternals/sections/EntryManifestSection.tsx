import { useState, useMemo } from 'react';
import { useAppStore, type EntryManifestEntry } from '../../../stores/appStore';
import { countTokensSync } from '../../../utils/tokenCounter';

type SortKey = 'path' | 'tokens' | 'lines' | 'importance' | 'method' | 'tier';

const TOKEN_BUDGET = 5000;

const TIER_COLORS: Record<string, string> = {
  full: 'text-green-400',
  summary: 'text-yellow-400',
};

const TIER_BG: Record<string, string> = {
  full: 'bg-green-500/20',
  summary: 'bg-yellow-500/20',
};

const METHOD_LABELS: Record<string, string> = {
  naming: 'Name',
  graph: 'Graph',
  both: 'Both',
};

function fmtK(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

function scalingTier(count: number): string {
  if (count <= 10) return 'Small';
  if (count <= 25) return 'Medium';
  return 'Large';
}

function SortHeader({ label, sortKey: sk, current, asc, onClick }: {
  label: string; sortKey: SortKey; current: SortKey; asc: boolean; onClick: (k: SortKey) => void;
}) {
  const arrow = current === sk ? (asc ? ' \u25B2' : ' \u25BC') : '';
  return (
    <th
      className="text-left text-[10px] text-studio-muted uppercase tracking-wide py-1 px-2 cursor-pointer hover:text-studio-accent select-none whitespace-nowrap"
      onClick={() => onClick(sk)}
    >
      {label}{arrow}
    </th>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-studio-surface rounded p-2 border border-studio-border flex-1 min-w-[80px]">
      <div className="text-[10px] text-studio-muted uppercase tracking-wide">{label}</div>
      <div className="text-sm font-mono text-studio-text mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-studio-muted mt-0.5">{sub}</div>}
    </div>
  );
}

export function EntryManifestSection() {
  const [sortKey, setSortKey] = useState<SortKey>('importance');
  const [sortAsc, setSortAsc] = useState(false);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  const manifest = useAppStore((s) => s.projectProfile?.entryManifest);
  const entryManifestDepth = useAppStore((s) => s.settings.entryManifestDepth ?? 'paths');
  const openFile = useAppStore.getState().openFile;

  const entries: EntryManifestEntry[] = manifest ?? [];

  /** Same path line as `_buildStaticSystemPrompt` (BP1 ## Entry Points). */
  const pathListLine = useMemo(
    () => entries.map(e => `${e.path} (${e.method}, ${e.lines}L)`).join(' | '),
    [entries],
  );

  const stats = useMemo(() => {
    let totalTokens = 0;
    let fullCount = 0;
    let summaryCount = 0;
    for (const e of entries) {
      totalTokens += e.tokens;
      if (e.tier === 'full') fullCount++;
      else summaryCount++;
    }
    const pathsInBp1 = entryManifestDepth === 'paths' || entryManifestDepth === 'paths_sigs';
    const pathsTokens = pathsInBp1 && pathListLine.length > 0 ? countTokensSync(pathListLine) : 0;
    return { totalTokens, fullCount, summaryCount, total: entries.length, pathsTokens, pathsInBp1 };
  }, [entries, pathListLine, entryManifestDepth]);

  const sorted = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    return [...entries].sort((a, b) => {
      switch (sortKey) {
        case 'path': return dir * a.path.localeCompare(b.path);
        case 'tokens': return dir * (a.tokens - b.tokens);
        case 'lines': return dir * (a.lines - b.lines);
        case 'importance': return dir * (a.importance - b.importance);
        case 'method': return dir * a.method.localeCompare(b.method);
        case 'tier': return dir * a.tier.localeCompare(b.tier);
        default: return 0;
      }
    });
  }, [entries, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  const budgetPct = stats.totalTokens > 0 ? Math.min(100, (stats.totalTokens / TOKEN_BUDGET) * 100) : 0;
  const fullPct = stats.fullCount > 0 && stats.total > 0
    ? (entries.filter(e => e.tier === 'full').reduce((s, e) => s + e.tokens, 0) / TOKEN_BUDGET) * 100
    : 0;

  if (entries.length === 0) {
    return (
      <div className="text-xs text-studio-muted py-6 text-center">
        No entry points detected. Load a project with source files to populate the manifest.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary stats */}
      <div className="flex gap-2 flex-wrap">
        <StatCard label="Entries" value={String(stats.total)} sub={scalingTier(stats.total)} />
        <StatCard
          label="Paths"
          value={stats.pathsInBp1 ? fmtK(stats.pathsTokens) : '—'}
          sub={stats.pathsInBp1 ? 'path list line (BP1)' : `not in BP1 (${entryManifestDepth})`}
        />
        <StatCard label="Sig Tokens" value={fmtK(stats.totalTokens)} sub={`of ${fmtK(TOKEN_BUDGET)} budget`} />
        <StatCard label="Full Sig" value={String(stats.fullCount)} />
        <StatCard label="Summary" value={String(stats.summaryCount)} />
        <StatCard label="In BP1" value={entries.length > 0 ? 'Yes' : 'No'} sub="static prompt block" />
      </div>

      {/* Budget bar */}
      <div className="bg-studio-surface rounded p-2 border border-studio-border">
        <div className="text-[10px] text-studio-muted uppercase tracking-wide mb-1">
          Token Budget ({budgetPct.toFixed(0)}% used)
        </div>
        <div className="w-full h-3 bg-studio-bg rounded-full overflow-hidden flex">
          <div
            className="h-full bg-green-500/60 transition-all"
            style={{ width: `${Math.min(fullPct, 100)}%` }}
            title={`Full sig: ${entries.filter(e => e.tier === 'full').reduce((s, e) => s + e.tokens, 0)} tokens`}
          />
          <div
            className="h-full bg-yellow-500/60 transition-all"
            style={{ width: `${Math.min(budgetPct - fullPct, 100 - fullPct)}%` }}
            title={`Summary: ${entries.filter(e => e.tier === 'summary').reduce((s, e) => s + e.tokens, 0)} tokens`}
          />
        </div>
        <div className="flex gap-3 mt-1 text-[10px] text-studio-muted">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-green-500/60 inline-block" /> Full sig
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-yellow-500/60 inline-block" /> Summary
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-studio-bg border border-studio-border inline-block" /> Free
          </span>
        </div>
      </div>

      {/* Entry table */}
      <div className="overflow-x-auto scrollbar-thin scrollbar-thumb-studio-border scrollbar-track-transparent">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-studio-border">
              <SortHeader label="Path" sortKey="path" current={sortKey} asc={sortAsc} onClick={handleSort} />
              <SortHeader label="Tokens" sortKey="tokens" current={sortKey} asc={sortAsc} onClick={handleSort} />
              <SortHeader label="Lines" sortKey="lines" current={sortKey} asc={sortAsc} onClick={handleSort} />
              <SortHeader label="Importance" sortKey="importance" current={sortKey} asc={sortAsc} onClick={handleSort} />
              <SortHeader label="Method" sortKey="method" current={sortKey} asc={sortAsc} onClick={handleSort} />
              <SortHeader label="Tier" sortKey="tier" current={sortKey} asc={sortAsc} onClick={handleSort} />
              <th className="text-left text-[10px] text-studio-muted uppercase tracking-wide py-1 px-2">BP1</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => {
              const isExpanded = expandedPath === entry.path;
              const tokenPct = (entry.tokens / TOKEN_BUDGET) * 100;

              return (
                <tr key={entry.path} className="border-b border-studio-border/30 group">
                  <td className="py-1.5 px-2">
                    <div className="flex items-center gap-1">
                      <button
                        className="text-[10px] text-studio-muted hover:text-studio-accent mr-0.5"
                        onClick={() => setExpandedPath(isExpanded ? null : entry.path)}
                        title={isExpanded ? 'Collapse sig' : 'Expand sig'}
                      >
                        {isExpanded ? '\u25BC' : '\u25B6'}
                      </button>
                      <span
                        className="font-mono text-studio-text hover:text-studio-accent cursor-pointer truncate max-w-[220px]"
                        title={entry.path}
                        onClick={() => openFile(entry.path)}
                      >
                        {entry.path}
                      </span>
                    </div>
                    {isExpanded && entry.sig && (
                      <pre className="mt-1 ml-4 text-[10px] font-mono text-studio-muted bg-studio-bg rounded p-2 max-h-48 overflow-y-auto scrollbar-thin whitespace-pre-wrap">
                        {entry.sig}
                      </pre>
                    )}
                  </td>
                  <td className="py-1.5 px-2 font-mono text-studio-text whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span>{fmtK(entry.tokens)}</span>
                      <div className="w-12 h-1.5 bg-studio-bg rounded-full overflow-hidden">
                        <div className="h-full bg-studio-accent/50 rounded-full" style={{ width: `${Math.min(tokenPct, 100)}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className="py-1.5 px-2 font-mono text-studio-muted">{entry.lines}</td>
                  <td className="py-1.5 px-2 font-mono text-studio-text">{entry.importance.toFixed(1)}</td>
                  <td className="py-1.5 px-2">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-studio-border/30 text-studio-muted">
                      {METHOD_LABELS[entry.method] || entry.method}
                    </span>
                  </td>
                  <td className="py-1.5 px-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${TIER_BG[entry.tier] || ''} ${TIER_COLORS[entry.tier] || 'text-studio-muted'}`}>
                      {entry.tier}
                    </span>
                  </td>
                  <td className="py-1.5 px-2">
                    <span className="w-2 h-2 rounded-full inline-block bg-indigo-400"
                      title="Included in BP1 (static)"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
