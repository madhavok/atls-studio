import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface DbStatsPayload {
  file_count?: number;
  symbol_count?: number;
  issue_count?: number;
  relation_count?: number;
  signature_count?: number;
  call_count?: number;
  last_indexed?: string | null;
  db_size_bytes?: number | null;
  error?: string;
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function IndexDbSection() {
  const [data, setData] = useState<DbStatsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const raw = await invoke<DbStatsPayload>('atls_get_database_stats');
      setData(raw);
      if (raw.error) setErr(raw.error);
    } catch (e) {
      setData(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="text-[10px] px-2 py-1 rounded border border-studio-border/50 hover:bg-studio-border/20"
          onClick={load}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Load index stats'}
        </button>
        <span className="text-[9px] text-studio-muted">ATLS SQLite index for the active project root</span>
      </div>
      {err && <p className="text-[11px] text-rose-400">{err}</p>}
      {data && !data.error && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
          <Cell label="Files" value={data.file_count ?? '—'} />
          <Cell label="Symbols" value={data.symbol_count ?? '—'} />
          <Cell label="Issues" value={data.issue_count ?? '—'} />
          <Cell label="Relations" value={data.relation_count ?? '—'} />
          <Cell label="Signatures" value={data.signature_count ?? '—'} />
          <Cell label="Calls" value={data.call_count ?? '—'} />
          <Cell label="DB size" value={fmtBytes(data.db_size_bytes ?? null)} />
          <Cell label="Last indexed (max)" value={data.last_indexed ?? '—'} wide />
        </div>
      )}
    </div>
  );
}

function Cell({ label, value, wide }: { label: string; value: string | number; wide?: boolean }) {
  return (
    <div className={`border border-studio-border/25 rounded px-2 py-1 bg-studio-bg/40 ${wide ? 'sm:col-span-3' : ''}`}>
      <div className="text-[9px] text-studio-muted">{label}</div>
      <div className="text-xs font-mono tabular-nums">{value}</div>
    </div>
  );
}
