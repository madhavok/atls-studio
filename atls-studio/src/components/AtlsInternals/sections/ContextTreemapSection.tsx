import { useMemo } from 'react';
import { useContextStore } from '../../../stores/contextStore';
import { useAppStore } from '../../../stores/appStore';

interface Block {
  key: string;
  label: string;
  tokens: number;
  pct: number;
  color: string;
  children?: Block[];
}

const CATEGORY_COLORS: Record<string, string> = {
  overhead: '#ef4444',
  wm: '#a3a3a3',
  blackboard: '#a855f7',
  staged: '#3b82f6',
  free: 'rgba(34,197,94,0.25)',
};

const CHUNK_STATE_COLORS: Record<string, string> = {
  compacted: '#404040',
  default: '#a3a3a3',
};

function fmtK(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

export function ContextTreemapSection() {
  const chunks = useContextStore((s) => s.chunks);
  const blackboardEntries = useContextStore((s) => s.blackboardEntries);
  const stagedSnippets = useContextStore((s) => s.stagedSnippets);
  const getStats = useContextStore((s) => s.getStats);
  const getUsedTokens = useContextStore((s) => s.getUsedTokens);
  const getBlackboardTokenCount = useContextStore((s) => s.getBlackboardTokenCount);
  const getStagedTokenCount = useContextStore((s) => s.getStagedTokenCount);
  const contextUsage = useAppStore((s) => s.contextUsage);
  const overheadTokens = useAppStore((s) => s.promptMetrics.totalOverheadTokens);
  const entryManifestTokens = useAppStore((s) => s.promptMetrics.entryManifestTokens ?? 0);

  const { blocks, maxTokens } = useMemo(() => {
    const stats = getStats();
    // Same maxTokens resolution as ContextMetricsSection
    const max = stats.maxTokens || contextUsage.maxTokens || 200000;
    const wmTokens = getUsedTokens();
    const bbTokens = getBlackboardTokenCount();
    const stTokens = getStagedTokenCount();
    // Entry manifest is in both overhead and staged; avoid double-count in free calc
    const freeTokens = Math.max(0, max - overheadTokens - wmTokens - bbTokens - stTokens + entryManifestTokens);

    const wmChildren: Block[] = [];
    chunks.forEach((c, hash) => {
      if (c.type === 'msg:user' || c.type === 'msg:asst') return;
      wmChildren.push({
        key: hash,
        label: c.source ? c.source.split('/').pop()! : c.shortHash,
        tokens: c.tokens,
        pct: (c.tokens / max) * 100,
        color: c.compacted ? CHUNK_STATE_COLORS.compacted : CHUNK_STATE_COLORS.default,
      });
    });
    wmChildren.sort((a, b) => b.tokens - a.tokens);

    const bbChildren: Block[] = [];
    blackboardEntries.forEach((e, key) => {
      bbChildren.push({ key, label: key, tokens: e.tokens, pct: (e.tokens / max) * 100, color: '#c084fc' });
    });

    const stChildren: Block[] = [];
    stagedSnippets.forEach((s, key) => {
      stChildren.push({ key, label: s.source.split('/').pop() || key, tokens: s.tokens, pct: (s.tokens / max) * 100, color: '#60a5fa' });
    });

    const result: Block[] = [];
    if (overheadTokens > 0) {
      result.push({ key: 'overhead', label: 'Overhead', tokens: overheadTokens, pct: (overheadTokens / max) * 100, color: CATEGORY_COLORS.overhead });
    }
    if (wmTokens > 0) {
      result.push({ key: 'wm', label: 'Working Memory', tokens: wmTokens, pct: (wmTokens / max) * 100, color: CATEGORY_COLORS.wm, children: wmChildren });
    }
    if (bbTokens > 0) {
      result.push({ key: 'bb', label: 'Blackboard', tokens: bbTokens, pct: (bbTokens / max) * 100, color: CATEGORY_COLORS.blackboard, children: bbChildren });
    }
    if (stTokens > 0) {
      result.push({ key: 'staged', label: 'Staged', tokens: stTokens, pct: (stTokens / max) * 100, color: CATEGORY_COLORS.staged, children: stChildren });
    }
    if (freeTokens > 0) {
      result.push({ key: 'free', label: 'Free', tokens: freeTokens, pct: (freeTokens / max) * 100, color: CATEGORY_COLORS.free });
    }
    return { blocks: result, maxTokens: max };
  }, [chunks, blackboardEntries, stagedSnippets, contextUsage.maxTokens, overheadTokens, entryManifestTokens, getUsedTokens, getBlackboardTokenCount, getStagedTokenCount, getStats]);

  if (maxTokens === 0) {
    return (
      <div className="text-xs text-studio-muted py-6 text-center">
        No context loaded. The treemap populates when chunks enter working memory.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-[10px] text-studio-muted">
        <span>Proportional context composition (live)</span>
        <span>{fmtK(maxTokens)} token budget</span>
      </div>
      <div
        className="flex rounded-lg overflow-hidden border border-studio-border/40"
        style={{ height: 140 }}
      >
        {blocks.map((block) => (
          <TreemapBlock key={block.key} block={block} budgetTokens={maxTokens} />
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] text-studio-muted">
        <LegendItem color={CATEGORY_COLORS.overhead} label="Overhead" />
        <LegendItem color={CATEGORY_COLORS.wm} label="Working Memory" />
        <LegendItem color={CATEGORY_COLORS.blackboard} label="Blackboard" />
        <LegendItem color={CATEGORY_COLORS.staged} label="Staged" />
        <LegendItem color={CATEGORY_COLORS.free} label="Free" />
      </div>
    </div>
  );
}

function TreemapBlock({ block, budgetTokens }: { block: Block; budgetTokens: number }) {
  const proportion = budgetTokens > 0 ? block.tokens / budgetTokens : 0;
  const hasChildren = block.children && block.children.length > 0;
  const showLabels = proportion > 0.06;

  return (
    <div
      className="relative flex flex-col overflow-hidden border-r border-black/20 last:border-r-0"
      style={{
        flex: `${proportion} 0 0%`,
        minWidth: 0,
        backgroundColor: block.color,
      }}
      title={`${block.label}: ${fmtK(block.tokens)} (${block.pct.toFixed(1)}%)`}
    >
      {showLabels && (
        <>
          <div className="px-1.5 pt-1 text-[10px] font-medium text-white/90 truncate" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
            {block.label}
          </div>
          <div className="px-1.5 text-[9px] text-white/60" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}>
            {fmtK(block.tokens)} ({block.pct.toFixed(1)}%)
          </div>
        </>
      )}

      {hasChildren && showLabels && (
        <div className="flex-1 flex flex-wrap gap-px p-1 overflow-hidden content-start">
          {block.children!.slice(0, 12).map((child) => {
            const childProportion = block.tokens > 0 ? child.tokens / block.tokens : 0;
            return (
              <div
                key={child.key}
                className="rounded-sm overflow-hidden flex flex-col justify-end"
                style={{
                  flex: `${Math.max(childProportion, 0.08)} 0 0%`,
                  minWidth: 0,
                  minHeight: 24,
                  maxHeight: 48,
                  backgroundColor: child.color,
                  opacity: 0.85,
                }}
                title={`${child.label}: ${fmtK(child.tokens)}`}
              >
                <div className="px-1 py-0.5 text-[8px] text-white/80 truncate" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>
                  {child.label}
                </div>
              </div>
            );
          })}
          {block.children!.length > 12 && (
            <div className="text-[8px] text-white/40 px-1 self-end">
              +{block.children!.length - 12} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
