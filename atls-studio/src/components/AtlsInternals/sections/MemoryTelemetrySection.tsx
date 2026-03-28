import { useMemo, useState } from 'react';
import { useContextStore, type MemoryEvent } from '../../../stores/contextStore';

const ACTIONS: Array<MemoryEvent['action'] | 'all'> = [
  'all',
  'read',
  'write',
  'compact',
  'archive',
  'drop',
  'evict',
  'invalidate',
  'reconcile',
  'retry',
  'block',
];

function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return String(at);
  }
}

export function MemoryTelemetrySection() {
  const memoryEvents = useContextStore((s) => s.memoryEvents);
  const getStats = useContextStore((s) => s.getStats);
  const [actionFilter, setActionFilter] = useState<MemoryEvent['action'] | 'all'>('all');

  const stats = useMemo(() => getStats().memoryTelemetry, [memoryEvents, getStats]);

  const filteredTail = useMemo(() => {
    const tail = [...memoryEvents].reverse();
    if (actionFilter === 'all') return tail.slice(0, 40);
    return tail.filter((e) => e.action === actionFilter).slice(0, 40);
  }, [memoryEvents, actionFilter]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
        <MiniStat label="Events" value={stats.eventCount} />
        <MiniStat label="Block" value={stats.blockCount} accent="text-rose-400" />
        <MiniStat label="Retry" value={stats.retryCount} accent="text-amber-400" />
        <MiniStat label="Rebind (non-fresh)" value={stats.rebindCount} accent="text-cyan-400" />
        <MiniStat label="Low conf." value={stats.lowConfidenceCount} />
        <MiniStat label="Med conf." value={stats.mediumConfidenceCount} />
        <MiniStat label="Reads reused" value={stats.readsReused} accent="text-emerald-400" />
        <MiniStat label="Results collapsed" value={stats.resultsCollapsed} />
        <MiniStat label="Outcome transitions" value={stats.outcomeTransitions} />
      </div>

      {Object.keys(stats.strategyCounts).length > 0 && (
        <div>
          <div className="text-[10px] text-studio-muted mb-1">Strategy counts</div>
          <div className="flex flex-wrap gap-2 text-[10px] font-mono">
            {Object.entries(stats.strategyCounts).map(([k, v]) => (
              <span key={k} className="px-1.5 py-0.5 rounded bg-studio-border/30">
                {k}: {v}
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-[10px] text-studio-muted">Event log (newest first)</span>
          <select
            className="text-[10px] bg-studio-bg border border-studio-border/50 rounded px-1.5 py-0.5"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value as MemoryEvent['action'] | 'all')}
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div className="max-h-48 overflow-y-auto scrollbar-thin border border-studio-border/30 rounded text-[10px] font-mono space-y-1 p-2">
          {filteredTail.length === 0 ? (
            <span className="text-studio-muted">No events for this filter.</span>
          ) : (
            filteredTail.map((ev) => (
              <div key={ev.id} className="border-b border-studio-border/20 pb-1 last:border-0">
                <span className="text-studio-muted">{formatTime(ev.at)}</span>{' '}
                <span className="text-studio-accent">{ev.action}</span>
                {ev.reason ? <span className="text-studio-muted"> — {ev.reason}</span> : null}
                {ev.freedTokens != null ? (
                  <span className="text-emerald-400/90"> (+{ev.freedTokens}tk freed)</span>
                ) : null}
                {ev.refs?.length ? (
                  <div className="text-[9px] text-studio-muted truncate mt-0.5" title={ev.refs.join(', ')}>
                    {ev.refs.slice(0, 4).join(' ')}
                    {ev.refs.length > 4 ? '…' : ''}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="border border-studio-border/25 rounded px-2 py-1 bg-studio-bg/40">
      <div className="text-[9px] text-studio-muted">{label}</div>
      <div className={`text-xs font-medium tabular-nums ${accent ?? ''}`}>{value}</div>
    </div>
  );
}
