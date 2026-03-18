import { useState, useMemo } from 'react';
import { useContextStore, type BlackboardEntry } from '../../../stores/contextStore';

export function BlackboardSection() {
  const blackboardEntries = useContextStore((s) => s.blackboardEntries);
  const getBlackboardTokenCount = useContextStore((s) => s.getBlackboardTokenCount);
  const removeBlackboardEntry = useContextStore((s) => s.removeBlackboardEntry);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const entries = useMemo(() => {
    const list: Array<{ key: string; entry: BlackboardEntry }> = [];
    blackboardEntries.forEach((entry, key) => {
      list.push({ key, entry });
    });
    return list.sort((a, b) => b.entry.tokens - a.entry.tokens);
  }, [blackboardEntries]);

  const totalTokens = getBlackboardTokenCount();
  const maxTokens = 10000;
  const pct = maxTokens > 0 ? Math.min(100, (totalTokens / maxTokens) * 100) : 0;

  return (
    <div className="space-y-3">
      {/* Budget bar */}
      <div>
        <div className="flex justify-between text-xs text-studio-muted mb-1">
          <span>Token Budget</span>
          <span>{totalTokens.toLocaleString()} / {maxTokens.toLocaleString()}</span>
        </div>
        <div className="h-2 bg-studio-border/30 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : 'bg-studio-accent'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Summary */}
      <div className="flex gap-4 text-xs text-studio-muted">
        <span>Entries: <span className="text-studio-text font-medium">{entries.length}</span></span>
        <span>Total Tokens: <span className="text-studio-text font-medium">{totalTokens.toLocaleString()}</span></span>
      </div>

      {/* Entry list */}
      <div className="space-y-1 max-h-72 overflow-y-auto scrollbar-thin">
        {entries.map(({ key, entry }) => {
          const isExpanded = expandedKey === key;
          return (
            <div
              key={key}
              className="bg-studio-surface/50 border border-studio-border/30 rounded"
            >
              <div
                className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-studio-border/20"
                onClick={() => setExpandedKey(isExpanded ? null : key)}
              >
                <span className="text-[10px] text-studio-muted">{isExpanded ? '▼' : '▶'}</span>
                <span className="font-mono text-xs text-studio-accent flex-1 truncate">{key}</span>
                <span className="text-[10px] text-studio-muted">{entry.tokens}tk</span>
                <span className="text-[10px] text-studio-muted">
                  {entry.createdAt instanceof Date
                    ? entry.createdAt.toLocaleTimeString()
                    : new Date(entry.createdAt).toLocaleTimeString()}
                </span>
                <button
                  className="text-red-400/60 hover:text-red-400 text-xs px-1"
                  onClick={(e) => { e.stopPropagation(); removeBlackboardEntry(key); }}
                  title="Remove entry"
                >
                  ×
                </button>
              </div>
              {isExpanded && (
                <div className="px-3 pb-2 border-t border-studio-border/20">
                  <pre className="text-xs text-studio-text whitespace-pre-wrap break-words mt-1 max-h-40 overflow-y-auto scrollbar-thin">
                    {entry.content}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
        {entries.length === 0 && (
          <div className="text-xs text-studio-muted text-center py-4">No blackboard entries</div>
        )}
      </div>
    </div>
  );
}
