import { useContextStore } from '../../../stores/contextStore';

export function ReconcileFreshnessSection() {
  const reconcileStats = useContextStore((s) => s.reconcileStats);
  const freshnessMirror = useContextStore((s) => s.freshnessMirror);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[10px] text-studio-muted mb-2 font-medium">Last reconcile sweep</div>
        {reconcileStats ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <KV label="Source" value={reconcileStats.source} wide />
            <KV
              label="Revision"
              value={
                reconcileStats.revision && reconcileStats.revision.length > 0
                  ? reconcileStats.revision.slice(0, 12) + (reconcileStats.revision.length > 12 ? '…' : '')
                  : '—'
              }
              wide
            />
            <KV label="Total" value={String(reconcileStats.total)} />
            <KV label="Updated" value={String(reconcileStats.updated)} accent="text-emerald-400" />
            <KV label="Invalidated" value={String(reconcileStats.invalidated)} accent="text-amber-400" />
            <KV label="Preserved" value={String(reconcileStats.preserved)} />
            {reconcileStats.bbSuperseded != null ? (
              <KV label="BB superseded" value={String(reconcileStats.bbSuperseded)} />
            ) : null}
            <KV
              label="At"
              value={new Date(reconcileStats.at).toLocaleString()}
              wide
            />
          </div>
        ) : (
          <p className="text-xs text-studio-muted">No reconcile stats yet this session.</p>
        )}
      </div>

      <div>
        <div className="text-[10px] text-studio-muted mb-2 font-medium">Freshness counters (file watch / invalidation)</div>
        <p className="text-[9px] text-studio-muted mb-2">Resets on session reset. Mirrors bounded invalidation paths.</p>
        <div className="grid grid-cols-2 sm:grid-cols-2 gap-2 text-[11px]">
          <KV label="file_tree w/ paths" value={String(freshnessMirror.fileTreeChangedWithPaths)} />
          <KV label="file_tree coarse (no paths)" value={String(freshnessMirror.fileTreeChangedCoarseNoPaths)} accent="text-amber-400" />
          <KV label="Engrams marked suspect" value={String(freshnessMirror.engramsMarkedSuspectFromPaths)} />
          <KV label="Coarse awareness only" value={String(freshnessMirror.coarseAwarenessOnlyInvalidations)} />
        </div>
      </div>
    </div>
  );
}

function KV({ label, value, wide, accent }: { label: string; value: string; wide?: boolean; accent?: string }) {
  return (
    <div className={`border border-studio-border/25 rounded px-2 py-1 bg-studio-bg/40 ${wide ? 'sm:col-span-2' : ''}`}>
      <div className="text-[9px] text-studio-muted">{label}</div>
      <div className={`text-xs break-all ${accent ?? ''}`}>{value}</div>
    </div>
  );
}
