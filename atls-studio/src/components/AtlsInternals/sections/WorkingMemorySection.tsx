import { useState, useMemo } from 'react';
import { useContextStore, type ContextChunk } from '../../../stores/contextStore';

type SortKey = 'tokens' | 'age' | 'type' | 'source';

const TYPE_COLORS: Record<string, string> = {
  file: 'bg-blue-500/20 text-blue-400',
  smart: 'bg-cyan-500/20 text-cyan-400',
  raw: 'bg-gray-500/20 text-gray-400',
  tree: 'bg-green-500/20 text-green-400',
  search: 'bg-purple-500/20 text-purple-400',
  result: 'bg-orange-500/20 text-orange-400',
  symbol: 'bg-pink-500/20 text-pink-400',
  deps: 'bg-teal-500/20 text-teal-400',
  issues: 'bg-red-500/20 text-red-400',
  plan: 'bg-yellow-500/20 text-yellow-400',
};

export function WorkingMemorySection() {
  const chunks = useContextStore((s) => s.chunks);
  const archivedChunks = useContextStore((s) => s.archivedChunks);
  const freedTokens = useContextStore((s) => s.freedTokens);
  const getStats = useContextStore((s) => s.getStats);
  const getPinnedCount = useContextStore((s) => s.getPinnedCount);

  const [sortKey, setSortKey] = useState<SortKey>('tokens');
  const [sortAsc, setSortAsc] = useState(false);
  const [filterType, setFilterType] = useState<string>('all');
  const [expandedHash, setExpandedHash] = useState<string | null>(null);

  const stats = getStats();
  const pinnedCount = getPinnedCount();

  const chunkList = useMemo(() => {
    const list: Array<{ hash: string; chunk: ContextChunk }> = [];
    chunks.forEach((chunk, hash) => list.push({ hash, chunk }));
    return list;
  }, [chunks]);

  const types = useMemo(() => {
    const s = new Set(chunkList.map((c) => c.chunk.type));
    return ['all', ...Array.from(s).sort()];
  }, [chunkList]);

  const sorted = useMemo(() => {
    let list = chunkList;
    if (filterType !== 'all') list = list.filter((c) => c.chunk.type === filterType);

    const dir = sortAsc ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'tokens': return dir * (a.chunk.tokens - b.chunk.tokens);
        case 'age': return dir * (a.chunk.lastAccessed - b.chunk.lastAccessed);
        case 'type': return dir * a.chunk.type.localeCompare(b.chunk.type);
        case 'source': return dir * (a.chunk.source ?? '').localeCompare(b.chunk.source ?? '');
        default: return 0;
      }
    });
  }, [chunkList, filterType, sortKey, sortAsc]);

  const maxChunkTokens = useMemo(
    () => Math.max(1, ...chunkList.map((c) => c.chunk.tokens)),
    [chunkList],
  );

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  };

  return (
    <div className="space-y-3">
      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <MiniStat label="Chunks" value={stats.chunkCount} />
        <MiniStat label="Pinned" value={pinnedCount} />
        <MiniStat label="Used Tokens" value={stats.usedTokens.toLocaleString()} />
        <MiniStat label="Freed Tokens" value={freedTokens.toLocaleString()} accent />
        <MiniStat label="Archived" value={archivedChunks.size} />
      </div>

      {/* Filters + sort */}
      <div className="flex gap-2 text-xs items-center">
        <select
          className="bg-studio-surface border border-studio-border rounded px-2 py-1 text-studio-text text-xs"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
        >
          {types.map((t) => <option key={t} value={t}>{t === 'all' ? 'All Types' : t}</option>)}
        </select>
        <div className="flex gap-1 ml-auto">
          {(['tokens', 'age', 'type', 'source'] as SortKey[]).map((k) => (
            <button
              key={k}
              className={`px-2 py-0.5 rounded text-xs ${sortKey === k ? 'bg-studio-accent/20 text-studio-accent' : 'text-studio-muted hover:text-studio-text'}`}
              onClick={() => handleSort(k)}
            >
              {k} {sortKey === k ? (sortAsc ? '↑' : '↓') : ''}
            </button>
          ))}
        </div>
      </div>

      {/* Chunk list */}
      <div className="space-y-1 max-h-80 overflow-y-auto scrollbar-thin">
        {sorted.map(({ hash, chunk }) => {
          const isExpanded = expandedHash === hash;
          const barWidth = (chunk.tokens / maxChunkTokens) * 100;
          const typeColor = TYPE_COLORS[chunk.type] ?? 'bg-studio-border/40 text-studio-text';
          const age = Date.now() - chunk.lastAccessed;
          const ageLabel = age < 60000 ? '<1m' : age < 3600000 ? `${Math.floor(age / 60000)}m` : `${Math.floor(age / 3600000)}h`;

          return (
            <div key={hash} className="bg-studio-surface/50 border border-studio-border/30 rounded">
              <div
                className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-studio-border/20"
                onClick={() => setExpandedHash(isExpanded ? null : hash)}
              >
                <span className="text-[10px] text-studio-muted">{isExpanded ? '▼' : '▶'}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${typeColor}`}>{chunk.type}</span>
                {chunk.pinned && <span className="text-[10px] text-yellow-400" title="Pinned">📌</span>}
                <span className="font-mono text-[10px] text-studio-accent" title={hash}>h:{chunk.shortHash}</span>
                <span className="text-[10px] text-studio-muted truncate flex-1" title={chunk.source}>
                  {chunk.source ? chunk.source.split(/[/\\]/).pop() : ''}
                </span>
                <span className="text-[10px] text-studio-muted">{ageLabel}</span>
                {/* Token bar */}
                <div className="w-16 h-1.5 bg-studio-border/30 rounded-full overflow-hidden" title={`${chunk.tokens}tk`}>
                  <div className="h-full bg-studio-accent/60 rounded-full" style={{ width: `${barWidth}%` }} />
                </div>
                <span className="text-[10px] text-studio-muted w-10 text-right font-mono">{chunk.tokens}</span>
              </div>
              {isExpanded && (
                <div className="px-3 pb-2 border-t border-studio-border/20">
                  <div className="flex gap-3 text-[10px] text-studio-muted mt-1 mb-1">
                    <span>Source: {chunk.source ?? '—'}</span>
                    <span>Refs: {chunk.referenceCount ?? 0}</span>
                    <span>Edits: {chunk.editCount ?? 0}</span>
                    {chunk.compacted && <span className="text-yellow-400">Compacted</span>}
                  </div>
                  <pre className="text-xs text-studio-text whitespace-pre-wrap break-words max-h-40 overflow-y-auto scrollbar-thin">
                    {chunk.content.length > 2000 ? chunk.content.slice(0, 2000) + '\n... (truncated)' : chunk.content}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
        {sorted.length === 0 && (
          <div className="text-xs text-studio-muted text-center py-4">No chunks in working memory</div>
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
      <div className="text-[10px] text-studio-muted">{label}</div>
      <div className={`text-sm font-semibold ${accent ? 'text-studio-accent' : 'text-studio-text'}`}>{value}</div>
    </div>
  );
}
