import { useMemo } from 'react';
import { useContextStore } from '../../../stores/contextStore';
import { useAppStore } from '../../../stores/appStore';
import { getGeminiCacheSnapshot } from '../../../services/geminiCache';

interface Block {
  key: string;
  label: string;
  tokens: number;
  pct: number;
  color: string;
  sub?: string;
}

const ANTHROPIC_COLORS: Record<string, string> = {
  static: '#6366f1',
  bp3: '#0ea5e9',
  uncached: '#64748b',
};

const PREFIX_COLORS: Record<string, string> = {
  cached: '#0ea5e9',
  uncached: '#64748b',
};

function fmtK(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

export function CacheCompositionSection() {
  const selectedProvider = useAppStore((s) => s.settings.selectedProvider);
  const promptMetrics = useAppStore((s) => s.promptMetrics);
  const cacheMetrics = useAppStore((s) => s.cacheMetrics);
  const getStagedTokenCount = useContextStore((s) => s.getStagedTokenCount);
  const getUsedTokens = useContextStore((s) => s.getUsedTokens);
  const getBlackboardTokenCount = useContextStore((s) => s.getBlackboardTokenCount);
  const contextUsage = useAppStore((s) => s.contextUsage);
  const maxTokens = contextUsage.maxTokens || 200000;

  const { blocks, providerLabel, note } = useMemo(() => {
    const provider = selectedProvider || 'anthropic';
    const stTokens = getStagedTokenCount();
    const wmTokens = getUsedTokens();
    const bbTokens = getBlackboardTokenCount();

    if (provider === 'lmstudio') {
      return {
        blocks: [] as Block[],
        providerLabel: 'LM Studio',
        note: 'Cache not supported',
      };
    }

    const bp1 =
      (promptMetrics.modePromptTokens ?? 0) +
      (promptMetrics.shellGuideTokens ?? 0) +
      (promptMetrics.contextControlTokens ?? 0);
    const bp2 = promptMetrics.bp2ToolDefTokens ?? 0;
    const historyTokens = (promptMetrics.bp3PriorTurnsTokens ?? 0);
    const stagedTokens = stTokens;
    const uncached =
      (promptMetrics.workspaceContextTokens ?? 0) + wmTokens + bbTokens + stagedTokens;

    if (provider === 'anthropic') {
      const staticCached = bp1 + bp2;
      const result: Block[] = [];
      if (staticCached > 0) result.push({ key: 'static', label: 'Static (System+Tools)', tokens: staticCached, pct: 0, color: ANTHROPIC_COLORS.static, sub: '5m TTL' });
      if (historyTokens > 0) result.push({ key: 'bp3', label: 'BP3 History', tokens: historyTokens, pct: 0, color: ANTHROPIC_COLORS.bp3, sub: 'append-only' });
      if (uncached > 0) result.push({ key: 'uncached', label: 'Uncached', tokens: uncached, pct: 0, color: ANTHROPIC_COLORS.uncached, sub: 'BB+staged+WM' });
      const total = result.reduce((s, b) => s + b.tokens, 0);
      result.forEach((b) => { b.pct = total > 0 ? (b.tokens / total) * 100 : 0; });
      return {
        blocks: result,
        providerLabel: 'Anthropic',
        note: cacheMetrics.sessionCacheReads > 0 ? `Last: ${fmtK(cacheMetrics.sessionCacheReads)} from cache` : undefined,
      };
    }

    if (provider === 'openai') {
      const openaiCached = bp1 + bp2 + historyTokens + stagedTokens;
      const openaiUncached = (promptMetrics.workspaceContextTokens ?? 0) + wmTokens + bbTokens;
      const result: Block[] = [];
      if (openaiCached > 0) result.push({ key: 'cached', label: 'Cached prefix', tokens: openaiCached, pct: 0, color: PREFIX_COLORS.cached, sub: 'system+tools+prior+staged' });
      if (openaiUncached > 0) result.push({ key: 'uncached', label: 'Uncached', tokens: openaiUncached, pct: 0, color: PREFIX_COLORS.uncached, sub: 'dynamic+WM+BB' });
      const total = result.reduce((s, b) => s + b.tokens, 0);
      result.forEach((b) => { b.pct = total > 0 ? (b.tokens / total) * 100 : 0; });
      return {
        blocks: result,
        providerLabel: 'OpenAI',
        note: cacheMetrics.lastRequestCachedTokens != null && cacheMetrics.lastRequestCachedTokens > 0
          ? `Last: ${fmtK(cacheMetrics.lastRequestCachedTokens)} from cache`
          : undefined,
      };
    }

    if (provider === 'google' || provider === 'vertex') {
      const snapshot = getGeminiCacheSnapshot();
      const isVertex = provider === 'vertex';
      const cachedCount = isVertex ? snapshot.vertexCachedMessageCount : snapshot.googleCachedMessageCount;
      const hasCache = (isVertex ? snapshot.vertexCacheName : snapshot.googleCacheName) != null;
      const lastCached = cacheMetrics.lastRequestCachedTokens ?? 0;

      const allTokens = bp1 + bp2 + historyTokens + stagedTokens + (promptMetrics.workspaceContextTokens ?? 0) + wmTokens + bbTokens;
      const cachedEst = hasCache ? bp1 + bp2 + Math.min(historyTokens, cachedCount * 400) : 0;
      const cached = lastCached > 0 ? lastCached : cachedEst;
      const uncachedTotal = lastCached > 0 ? Math.max(0, allTokens - lastCached) : (hasCache ? allTokens - cachedEst : allTokens);

      const result: Block[] = [];
      if (cached > 0) result.push({ key: 'cached', label: 'CachedContent', tokens: cached, pct: 0, color: PREFIX_COLORS.cached, sub: hasCache ? `${cachedCount} msgs` : undefined });
      if (uncachedTotal > 0) result.push({ key: 'uncached', label: 'Uncached', tokens: uncachedTotal, pct: 0, color: PREFIX_COLORS.uncached, sub: 'dynamic+remaining' });
      const total = result.reduce((s, b) => s + b.tokens, 0);
      result.forEach((b) => { b.pct = total > 0 ? (b.tokens / total) * 100 : 0; });
      return {
        blocks: result,
        providerLabel: provider === 'vertex' ? 'Vertex' : 'Google',
        note: lastCached > 0
          ? `Last: ${fmtK(lastCached)} from cache`
          : hasCache ? `Cached: ${cachedCount} msgs` : 'No cache until ≥32k tokens',
      };
    }

    return {
      blocks: [] as Block[],
      providerLabel: provider,
      note: 'Cache composition for other providers not mapped',
    };
  }, [selectedProvider, promptMetrics, cacheMetrics, getStagedTokenCount, getUsedTokens, getBlackboardTokenCount, contextUsage.maxTokens]);

  if (selectedProvider === 'lmstudio') {
    return (
      <div className="space-y-2">
        <div className="text-[10px] text-studio-muted">Cache composition</div>
        <div className="text-xs text-studio-muted py-4 text-center rounded-lg border border-studio-border/40 bg-studio-surface/30">
          {note}
        </div>
      </div>
    );
  }

  if (blocks.length === 0) {
    return (
      <div className="space-y-2">
        <div className="text-[10px] text-studio-muted">Cache composition ({providerLabel})</div>
        <div className="text-xs text-studio-muted py-4 text-center rounded-lg border border-studio-border/40 bg-studio-surface/30">
          No cache data yet. Send a message to populate.
        </div>
      </div>
    );
  }

  const total = blocks.reduce((s, b) => s + b.tokens, 0);

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-[10px] text-studio-muted">
        <span>Cache composition ({providerLabel})</span>
        <span>{fmtK(total)} tokens</span>
      </div>
      <div
        className="flex rounded-lg overflow-hidden border border-studio-border/40"
        style={{ height: 100 }}
      >
        {blocks.map((block) => (
          <div
            key={block.key}
            className="relative flex flex-col overflow-hidden border-r border-black/20 last:border-r-0"
            style={{
              flex: `${block.pct} 0 0%`,
              minWidth: 0,
              backgroundColor: block.color,
            }}
            title={`${block.label}: ${fmtK(block.tokens)} (${block.pct.toFixed(1)}%)${block.sub ? ` — ${block.sub}` : ''}`}
          >
            {block.pct > 0.08 && (
              <>
                <div className="px-1.5 pt-1 text-[10px] font-medium text-white/90 truncate" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
                  {block.label}
                </div>
                <div className="px-1.5 text-[9px] text-white/60" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
                  {fmtK(block.tokens)} ({block.pct.toFixed(1)}%)
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] text-studio-muted">
        {blocks.map((b) => (
          <span key={b.key} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: b.color }} />
            {b.label} {b.sub && <span className="opacity-75">({b.sub})</span>}
          </span>
        ))}
      </div>
      {note && (
        <div className="text-[10px] text-studio-muted italic">{note}</div>
      )}
    </div>
  );
}
