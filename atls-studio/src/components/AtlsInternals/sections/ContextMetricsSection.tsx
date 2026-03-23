import { useAppStore } from '../../../stores/appStore';
import { useContextStore } from '../../../stores/contextStore';

export function ContextMetricsSection() {
  const promptMetrics = useAppStore((s) => s.promptMetrics);
  const cacheMetrics = useAppStore((s) => s.cacheMetrics);
  const contextUsage = useAppStore((s) => s.contextUsage);
  const emDepth = useAppStore((s) => s.settings.entryManifestDepth) ?? 'sigs';
  const getStats = useContextStore((s) => s.getStats);
  const freedTokens = useContextStore((s) => s.freedTokens);

  const stats = getStats();
  const maxTokens = stats.maxTokens || contextUsage.maxTokens || 200000;
  const overheadTokens = promptMetrics.totalOverheadTokens;
  const contextTokens = stats.usedTokens || 0;
  const freeTokens = Math.max(0, maxTokens - contextTokens);

  const overheadPct = maxTokens > 0 ? (overheadTokens / maxTokens) * 100 : 0;
  const activeContextTokens = Math.max(0, contextTokens - overheadTokens);
  const contextPct = maxTokens > 0 ? (activeContextTokens / maxTokens) * 100 : 0;
  const freePct = maxTokens > 0 ? (freeTokens / maxTokens) * 100 : 0;

  const cacheTotal = cacheMetrics.sessionCacheWrites + cacheMetrics.sessionCacheReads + cacheMetrics.sessionUncached;
  const cacheWritePct = cacheTotal > 0 ? (cacheMetrics.sessionCacheWrites / cacheTotal) * 100 : 0;
  const cacheReadPct = cacheTotal > 0 ? (cacheMetrics.sessionCacheReads / cacheTotal) * 100 : 0;
  const uncachedPct = cacheTotal > 0 ? (cacheMetrics.sessionUncached / cacheTotal) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Budget split bar */}
      <div>
        <div className="flex justify-between text-xs text-studio-muted mb-1">
          <span>Context Budget</span>
          <span>{(maxTokens / 1000).toFixed(0)}k tokens</span>
        </div>
        <div className="h-4 bg-studio-border/30 rounded-full overflow-hidden flex">
          <div
            className="h-full bg-red-500/70"
            style={{ width: `${overheadPct}%` }}
            title={`Overhead: ${overheadTokens.toLocaleString()}tk (${overheadPct.toFixed(1)}%)`}
          />
          <div
            className="h-full bg-studio-accent/70"
            style={{ width: `${contextPct}%` }}
            title={`Context: ${contextTokens.toLocaleString()}tk (${contextPct.toFixed(1)}%)`}
          />
          <div
            className="h-full bg-green-500/30"
            style={{ width: `${freePct}%` }}
            title={`Free: ${freeTokens.toLocaleString()}tk (${freePct.toFixed(1)}%)`}
          />
        </div>
        <div className="flex gap-3 text-[10px] text-studio-muted mt-1">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/70" /> Overhead {overheadPct.toFixed(1)}%</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-studio-accent/70" /> Active CTX {contextPct.toFixed(1)}%</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500/30" /> Free {freePct.toFixed(1)}%</span>
        </div>
      </div>

      {/* Prompt overhead breakdown */}
      <div>
        <div className="text-xs text-studio-muted mb-2 font-medium">Prompt Overhead Breakdown</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <OverheadRow label="Mode Prompt" tokens={promptMetrics.modePromptTokens} total={overheadTokens} />
          <OverheadRow label="Tool References" tokens={promptMetrics.toolRefTokens} total={overheadTokens} />
          <OverheadRow label="Shell Guide" tokens={promptMetrics.shellGuideTokens} total={overheadTokens} />
          <OverheadRow label="Native Tools" tokens={promptMetrics.nativeToolTokens} total={overheadTokens} />
          <OverheadRow label="Context Control" tokens={promptMetrics.contextControlTokens} total={overheadTokens} />
          <OverheadRow label="Workspace Context" tokens={promptMetrics.workspaceContextTokens} total={overheadTokens} />
          {emDepth !== 'off' && <OverheadRow label="Entry Manifest" tokens={promptMetrics.entryManifestTokens ?? 0} total={overheadTokens} />}
        </div>
      </div>

      {/* Savings */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <SavingStat label="Compression Savings" value={promptMetrics.compressionSavings.toLocaleString()} sub={`${promptMetrics.compressionCount} ops`} />
        <SavingStat label="Rolling Savings" value={(promptMetrics.rollingSavings ?? 0).toLocaleString()} sub={`${promptMetrics.rolledRounds ?? 0} rounds distilled`} />
        <SavingStat label="Freed Tokens" value={freedTokens.toLocaleString()} sub="lifetime relieved, excluded from active CTX" />
        <SavingStat label="Rounds" value={promptMetrics.roundCount} />
        <SavingStat label="Cumulative Saved" value={promptMetrics.cumulativeInputSaved.toLocaleString()} accent />
      </div>

      {/* Cache performance */}
      <div>
        <div className="text-xs text-studio-muted mb-2 font-medium">Provider Cache Performance</div>
        <div className="h-3 bg-studio-border/30 rounded-full overflow-hidden flex mb-1">
          <div className="h-full bg-blue-500/70" style={{ width: `${cacheWritePct}%` }} title={`Writes: ${cacheMetrics.sessionCacheWrites.toLocaleString()}`} />
          <div className="h-full bg-green-500/70" style={{ width: `${cacheReadPct}%` }} title={`Reads: ${cacheMetrics.sessionCacheReads.toLocaleString()}`} />
          <div className="h-full bg-gray-500/50" style={{ width: `${uncachedPct}%` }} title={`Uncached: ${cacheMetrics.sessionUncached.toLocaleString()}`} />
        </div>
        <div className="flex gap-3 text-[10px] text-studio-muted">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-500/70" /> Writes {cacheMetrics.sessionCacheWrites.toLocaleString()}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-500/70" /> Reads {cacheMetrics.sessionCacheReads.toLocaleString()}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-gray-500/50" /> Uncached {cacheMetrics.sessionUncached.toLocaleString()}</span>
        </div>
        <div className="flex gap-4 text-xs text-studio-muted mt-2">
          <span>Session Hit Rate: <span className="text-studio-text font-medium">{(cacheMetrics.sessionHitRate * 100).toFixed(1)}%</span></span>
          <span>Last Request: <span className="text-studio-text font-medium">{(cacheMetrics.lastRequestHitRate * 100).toFixed(1)}%</span></span>
          <span>Requests: <span className="text-studio-text font-medium">{cacheMetrics.sessionRequests}</span></span>
        </div>
      </div>
    </div>
  );
}

function OverheadRow({ label, tokens, total }: { label: string; tokens: number; total: number }) {
  const pct = total > 0 ? (tokens / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-studio-muted flex-1">{label}</span>
      <div className="w-16 h-1.5 bg-studio-border/30 rounded-full overflow-hidden">
        <div className="h-full bg-red-500/50 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-studio-text font-mono w-12 text-right">{tokens.toLocaleString()}</span>
    </div>
  );
}

function SavingStat({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: boolean }) {
  return (
    <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
      <div className="text-[10px] text-studio-muted" title={label === 'Freed Tokens' ? 'Tokens removed from working memory/context over time; not part of current CTX.' : undefined}>{label}</div>
      <div className={`text-sm font-semibold ${accent ? 'text-studio-accent' : 'text-studio-text'}`}>{value}</div>
      {sub && <div className="text-[10px] text-studio-muted">{sub}</div>}
    </div>
  );
}
