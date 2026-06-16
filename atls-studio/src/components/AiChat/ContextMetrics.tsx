import { memo, useMemo, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useContextStore } from '../../stores/contextStore';
import { useRoundHistoryStore } from '../../stores/roundHistoryStore';
import { formatCost, calculateCostBreakdown, type AIProvider as CostProvider } from '../../stores/costStore';
import { formatTokens } from '../../utils/toolTokenMetrics';
import {
  getEffectiveContextWindow,
  getExtendedContextResolutionFromSettings,
} from '../../utils/modelCapabilities';
import { getPricingProviderForModel } from '../../utils/pricingProvider';

type OverheadSegment = { label: string; tokens: number; color: string };
type BudgetBucket = { label: string; tokens: number; color: string };

/**
 * Compact, collapsible chat telemetry readout: prompt-overhead breakdown,
 * context savings (incl. the input-compression encoder rollup), provider cache
 * performance, BP3 logical-cache state, and the per-round budget split.
 *
 * Reads the live `appStore` / `contextStore` / `roundHistoryStore` singletons,
 * which reflect the currently focused session (per-session partition swap), so
 * this is only meaningful for the live/focused chat.
 */
export const ContextMetrics = memo(function ContextMetrics() {
  const pm = useAppStore(state => state.promptMetrics);
  const cacheMetrics = useAppStore(state => state.cacheMetrics);
  const logicalCache = useAppStore(state => state.logicalCache);
  const freedTokens = useContextStore(state => state.freedTokens);
  const chunks = useContextStore(state => state.chunks);
  const getPromptTokens = useContextStore((s) => s.getPromptTokens);
  const availableModels = useAppStore(state => state.availableModels);
  const selectedModel = useAppStore(state => state.settings.selectedModel);
  const selectedProvider = useAppStore(state => state.settings.selectedProvider);
  const extendedContext = useAppStore(state => state.settings.extendedContext);
  const extendedContextByModelId = useAppStore(state => state.settings.extendedContextByModelId);
  const extendedResolution = useMemo(
    () => getExtendedContextResolutionFromSettings({ extendedContext, extendedContextByModelId }),
    [extendedContext, extendedContextByModelId]
  );
  const emDepth = useAppStore(state => state.settings.entryManifestDepth) ?? 'sigs';
  const [expanded, setExpanded] = useState(false);

  const currentModel = availableModels.find(m => m.id === selectedModel);
  const maxTokens = currentModel
    ? (getEffectiveContextWindow(currentModel.id, currentModel.provider, currentModel.contextWindow, extendedResolution) ?? 200000)
    : 200000;
  const provider = getPricingProviderForModel(selectedModel, selectedProvider, availableModels);

  const latestSnapshot = useRoundHistoryStore(s => s.snapshots.length > 0 ? s.snapshots[s.snapshots.length - 1] : undefined);
  const wmTokens = useMemo(() => getPromptTokens(), [chunks, getPromptTokens]);
  const fallbackUsedTokens = wmTokens + (pm.totalOverheadTokens || 0);
  const usedTokens = latestSnapshot?.estimatedTotalPromptTokens ?? fallbackUsedTokens;

  const budgetSplitBuckets = useMemo((): BudgetBucket[] => {
    if (!latestSnapshot) return [];
    const s = latestSnapshot;
    return [
      { label: 'System', tokens: s.staticSystemTokens, color: 'bg-purple-500/70' },
      { label: 'History', tokens: s.conversationHistoryTokens, color: 'bg-violet-500/70' },
      { label: 'Staged', tokens: s.stagedBucketTokens, color: 'bg-fuchsia-500/70' },
      { label: 'WM', tokens: s.wmTokens, color: 'bg-studio-accent' },
      { label: 'Workspace', tokens: s.workspaceContextTokens, color: 'bg-amber-500/70' },
    ].filter((b) => b.tokens > 0);
  }, [latestSnapshot]);

  // Per-round savings display: current WM-side counters the user can see right
  // now. `inputCompressionSavings` (tool-result encoder toggle) is a distinct
  // input-compression track — show it alongside so the toggle surfaces a signal.
  const inputCompressionSavings = pm.inputCompressionSavings ?? 0;
  // `rollingSavings` retained as zero-valued legacy on `PromptMetrics` so
  // persisted snapshots still round-trip; no longer summed here.
  const perRoundSavings =
    pm.compressionSavings
    + freedTokens
    + inputCompressionSavings;
  // cumulativeInputSaved is now a delta-accumulated monotonic total (see
  // appStore.recordRound); represents tokens we never sent, not compounded.
  const { cumulativeInputSaved, roundCount } = pm;
  const recurringInputSaved = pm.recurringInputSaved ?? 0;
  const hasData =
    pm.totalOverheadTokens > 0
    || perRoundSavings > 0
    || cumulativeInputSaved > 0
    || chunks.size > 0
    || latestSnapshot != null;

  const overheadPct = Math.min(100, (pm.totalOverheadTokens / maxTokens) * 100);
  const efficiency = usedTokens > 0
    ? Math.round((wmTokens / usedTokens) * 100)
    : 100;

  // Cost estimate for cumulative input savings. Blend in the session cache-read
  // share so the $ reflects what those tokens would have ACTUALLY cost (much of
  // the "avoided" budget would have been billed at the cache-read rate, not the
  // full input rate). calculateCostBreakdown handles the provider-specific
  // cache formula for us.
  const cacheReadShare = (() => {
    const total = cacheMetrics.sessionCacheReads
      + cacheMetrics.sessionCacheWrites
      + cacheMetrics.sessionUncached;
    if (total <= 0) return 0;
    return cacheMetrics.sessionCacheReads / total;
  })();
  const cumulativeCacheReadPortion = Math.round(cumulativeInputSaved * cacheReadShare);
  const cumulativeUncachedPortion = Math.max(0, cumulativeInputSaved - cumulativeCacheReadPortion);
  const cumulativeCostCents = calculateCostBreakdown(
    provider as CostProvider,
    selectedModel,
    provider === 'anthropic' ? cumulativeUncachedPortion : cumulativeInputSaved,
    0,
    provider === 'anthropic' ? cumulativeCacheReadPortion : 0,
    0,
  ).totalCostCents;

  // Per-session cache savings, in cents — sum of provider-accurate per-round
  // cache deltas from round history. Stays consistent with Cost & I/O charts.
  const sessionCacheSavingsCents = useMemo(() => {
    // Cheap single-pass sum; roundHistoryStore caps at MAX_SNAPSHOTS.
    const snaps = useRoundHistoryStore.getState().snapshots;
    let s = 0;
    for (const snap of snaps) s += snap.cacheSavingsCents ?? 0;
    return s;
  }, [latestSnapshot]);

  const segments: OverheadSegment[] = useMemo(() => {
    const segs: OverheadSegment[] = [
      { label: 'Mode Prompt', tokens: pm.modePromptTokens, color: 'bg-purple-500' },
      { label: 'Tool Reference', tokens: pm.toolRefTokens, color: 'bg-blue-500' },
      { label: 'Shell Guide', tokens: pm.shellGuideTokens, color: 'bg-cyan-500' },
      { label: 'Native Tools', tokens: pm.nativeToolTokens, color: 'bg-rose-500' },
      { label: 'Primer', tokens: pm.primerTokens, color: 'bg-teal-500' },
      { label: 'Context Control (BP1)', tokens: pm.contextControlTokens, color: 'bg-indigo-500' },
      { label: 'Workspace Ctx', tokens: pm.workspaceContextTokens, color: 'bg-amber-500' },
    ].filter(s => s.tokens > 0);
    if (emDepth !== 'off') {
      segs.push({ label: 'Entry Manifest', tokens: pm.entryManifestTokens ?? 0, color: 'bg-emerald-500' });
    }
    return segs;
  }, [pm.modePromptTokens, pm.toolRefTokens, pm.shellGuideTokens, pm.nativeToolTokens, pm.primerTokens, pm.contextControlTokens, pm.workspaceContextTokens, pm.entryManifestTokens, emDepth]);

  const metricsCollapseHint = hasData
    ? 'Click for overhead breakdown, savings, provider cache, and budget split.'
    : 'Click to open; data appears after the first context build / round.';

  const headerOverheadTitle = `Prompt overhead (mode, tools, guides, workspace block, etc.): ${pm.totalOverheadTokens.toLocaleString()} tokens (~${formatTokens(pm.totalOverheadTokens)}).`;

  const headerSavedTitle = [
    'ESTIMATED. One-time input tokens never sent this session — sum of per-round',
    'deltas on compression, rolling-summary, WM freed, and input-compression counters.',
    'Does not double-count recurring saves across rounds (see recurringInputSaved',
    'for the compounding view).',
    `${cumulativeInputSaved.toLocaleString()} tokens (~${formatTokens(cumulativeInputSaved)}).`,
    `~${formatCost(cumulativeCostCents)} value, blended at session cache-read share ${(cacheReadShare * 100).toFixed(0)}% (output not included).`,
  ].join('\n');

  const headerRoundsTitle = `Main chat tool-loop rounds counted this session: ${roundCount.toLocaleString()}.`;

  const headerEffTitle = [
    'Efficiency: working-memory (chunk) tokens as a share of estimated total prompt.',
    `WM: ${wmTokens.toLocaleString()} (~${formatTokens(wmTokens)})`,
    `Estimated used: ${usedTokens.toLocaleString()} (~${formatTokens(usedTokens)})`,
    `→ ${efficiency}%`,
  ].join('\n');

  const headerCacheTitle = [
    `Provider prompt-cache session stats: ${cacheMetrics.sessionRequests.toLocaleString()} request(s).`,
    `Hit rate: ${Math.round(cacheMetrics.sessionHitRate * 100)}% (cache read tokens as a share of read+write+uncached totals).`,
    `Reads: ${cacheMetrics.sessionCacheReads.toLocaleString()} | Writes: ${cacheMetrics.sessionCacheWrites.toLocaleString()} | Uncached: ${cacheMetrics.sessionUncached.toLocaleString()}`,
  ].join('\n');

  const headerBp3Title = logicalCache.bp3Hit === null
    ? 'BP3: no data.'
    : [
        'Anthropic logical cache: prior-turns prefix (BP3) reuse vs churn.',
        logicalCache.bp3Hit ? 'Last check: HIT (prefix stable).' : 'Last check: MISS (prefix changed).',
        logicalCache.bp3Reason ? `Reason: ${logicalCache.bp3Reason}` : '',
      ].filter(Boolean).join('\n');

  const overheadLineRightTitle = `Overhead uses ${pm.totalOverheadTokens.toLocaleString()} of ${maxTokens.toLocaleString()} max window tokens (${overheadPct.toFixed(1)}%).`;

  const budgetUsedMaxTitle = [
    latestSnapshot
      ? 'Latest round snapshot: estimated total prompt tokens vs model max.'
      : 'No snapshot yet: WM + overhead estimate vs model max.',
    `Used: ${usedTokens.toLocaleString()} (~${formatTokens(usedTokens)})`,
    `Max: ${maxTokens.toLocaleString()} (~${formatTokens(maxTokens)})`,
  ].join('\n');

  return (
    <div className="px-2 text-[9px] text-studio-muted">
      <button
        className="w-full flex items-center gap-1.5 py-0.5 hover:text-studio-text transition-colors"
        onClick={() => setExpanded(!expanded)}
        type="button"
        title={metricsCollapseHint}
      >
        <span className="text-studio-accent shrink-0 cursor-help" title={metricsCollapseHint}>metrics</span>
        {hasData ? (
          <>
            <span className="shrink-0 cursor-help" title={headerOverheadTitle}>overhead:{formatTokens(pm.totalOverheadTokens)}</span>
        {cumulativeInputSaved > 0 && (
          <span className="shrink-0 text-studio-success cursor-help" title={headerSavedTitle}>saved:{formatTokens(cumulativeInputSaved)}</span>
        )}
        {roundCount > 0 && (
          <span className="shrink-0 cursor-help" title={headerRoundsTitle}>r:{roundCount}</span>
        )}
        <span className="shrink-0 cursor-help" title={headerEffTitle}>eff:{efficiency}%</span>
        {cacheMetrics.sessionRequests > 0 && (
          <span className="shrink-0 text-studio-success cursor-help" title={headerCacheTitle}>cache:{Math.round(cacheMetrics.sessionHitRate * 100)}%</span>
        )}
        {provider === 'anthropic' && logicalCache.bp3Hit !== null && (
          <span className={`shrink-0 cursor-help ${logicalCache.bp3Hit ? 'text-green-400' : 'text-red-400'}`} title={headerBp3Title}>
            bp3:{logicalCache.bp3Hit ? 'hit' : 'miss'}
          </span>
        )}
          </>
        ) : (
          <span className="shrink-0 text-studio-muted cursor-help" title={metricsCollapseHint}>no data yet</span>
        )}
        <svg className={`w-2.5 h-2.5 text-studio-text-muted transition-transform ml-auto ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {expanded && (
        <div className="pb-1 space-y-1.5">
          {/* Overhead breakdown bar */}
          <div>
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-studio-text-secondary cursor-help" title="Non-user content counted toward the prompt: system-mode text, tool references, guides, workspace injection, etc.">
                Prompt Overhead
              </span>
              <span className="cursor-help" title={overheadLineRightTitle}>
                {formatTokens(pm.totalOverheadTokens)} ({overheadPct.toFixed(1)}% of window)
              </span>
            </div>
            <div className="flex h-1.5 rounded-full overflow-hidden bg-studio-border">
              {segments.map((seg) => {
                const pct = pm.totalOverheadTokens > 0 ? (seg.tokens / pm.totalOverheadTokens) * 100 : 0;
                const segTitle = `${seg.label}: ${seg.tokens.toLocaleString()} tokens (~${formatTokens(seg.tokens)}), ${pct.toFixed(1)}% of overhead bar.`;
                return (
                  <div
                    key={seg.label}
                    className={`${seg.color} transition-all cursor-help`}
                    style={{ width: `${pct}%` }}
                    title={segTitle}
                  />
                );
              })}
            </div>
            <div className="flex flex-wrap gap-x-2 gap-y-0 mt-0.5">
              {segments.map((seg) => (
                <span
                  key={seg.label}
                  className="flex items-center gap-0.5 cursor-help"
                  title={`${seg.label}: ${seg.tokens.toLocaleString()} tokens (~${formatTokens(seg.tokens)}).`}
                >
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${seg.color}`} />
                  <span>{seg.label} {formatTokens(seg.tokens)}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Savings breakdown — per-round + cumulative */}
          {(perRoundSavings > 0 || cumulativeInputSaved > 0) && (
            <div className="border-t border-studio-border pt-1">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-studio-text-secondary cursor-help" title="Tokens not sent or reclaimed via compression, rolling summaries, and WM frees; cumulative line sums per-round savings over the session.">
                  Context Savings
                </span>
                <span className="text-studio-text-muted cursor-help" title={headerRoundsTitle}>
                  {roundCount} round{roundCount !== 1 ? 's' : ''}
                </span>
              </div>
              {/* Per-round breakdown */}
              <div className="flex flex-wrap gap-x-3 gap-y-0">
                <span className="text-studio-text-secondary cursor-help" title="Per API call: compression + rolling distill savings + WM freed tokens (current counters).">
                  per round:
                </span>
                {pm.compressionSavings > 0 && (
                  <span
                    className="cursor-help"
                    title={`History/tool-result compression savings (current window): ${pm.compressionSavings.toLocaleString()} tokens across ${pm.compressionCount.toLocaleString()} item(s).`}
                  >
                    compression {formatTokens(pm.compressionSavings)} ({pm.compressionCount} items)
                  </span>
                )}
                {freedTokens > 0 && (
                  <span className="cursor-help" title={`Working-memory chunks freed or compacted: ${freedTokens.toLocaleString()} tokens (~${formatTokens(freedTokens)}).`}>
                    freed {formatTokens(freedTokens)}
                  </span>
                )}
                {inputCompressionSavings > 0 && (
                  <span
                    className="cursor-help"
                    title={
                      `Tool-result input-compression encoder savings (compressToolResults toggle). `
                      + `${inputCompressionSavings.toLocaleString()} tokens across ${(pm.inputCompressionCount ?? 0).toLocaleString()} tool result${(pm.inputCompressionCount ?? 0) === 1 ? '' : 's'}.`
                    }
                  >
                    input-comp {formatTokens(inputCompressionSavings)} ({pm.inputCompressionCount ?? 0} results)
                  </span>
                )}
                {pm.orphanSummaryRemovals > 0 && (
                  <span className="cursor-help" title={`Compressed rolling-summary pointers removed as orphans: ${pm.orphanSummaryRemovals.toLocaleString()}.`}>
                    orphans {pm.orphanSummaryRemovals} removed
                  </span>
                )}
                {perRoundSavings > 0 && (
                  <span
                    className="text-studio-text-secondary cursor-help"
                    title={`Sum of per-round counters (compression + rolling + freed + input-compression): ${perRoundSavings.toLocaleString()} tokens (~${formatTokens(perRoundSavings)}).`}
                  >
                    = {formatTokens(perRoundSavings)}/call
                  </span>
                )}
              </div>
              {/* Cumulative — est. one-time tokens never sent (delta-accumulated) */}
              {cumulativeInputSaved > 0 && (
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span
                    className="text-studio-success font-medium cursor-help"
                    title={headerSavedTitle}
                  >
                    est.cumulative: {formatTokens(cumulativeInputSaved)} input tokens never sent
                  </span>
                  {cumulativeCostCents > 0 && (
                    <span className="text-studio-success cursor-help" title={headerSavedTitle}>
                      (~{formatCost(cumulativeCostCents)} value)
                    </span>
                  )}
                  {recurringInputSaved > 0 && (
                    <span
                      className="text-studio-muted cursor-help"
                      title={
                        'Compounding view (not billed): assumes each round re-sends everything and compression + rolling pools re-save themselves.\n'
                        + `${recurringInputSaved.toLocaleString()} tokens summed across ${roundCount} round${roundCount === 1 ? '' : 's'}. Ignores provider prompt caching.`
                      }
                    >
                      · recur {formatTokens(recurringInputSaved)}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* FileView telemetry — unified file-content surface, non-billed */}
          {(pm.fileViewCount ?? 0) > 0 && (
            <div className="border-t border-studio-border pt-1">
              <div className="flex items-center justify-between mb-0.5">
                <span
                  className="text-studio-text-secondary cursor-help"
                  title="Unified FileView: one block per file, skeleton + fills replace flat chunks. Counters are observational; target for staleReadRounds is zero."
                >
                  FileView
                </span>
                <span className="cursor-help" title={`Live FileView blocks: ${(pm.fileViewCount ?? 0).toLocaleString()}.`}>
                  {pm.fileViewCount ?? 0} view{(pm.fileViewCount ?? 0) === 1 ? '' : 's'}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0">
                {(pm.fileViewRenderedTokens ?? 0) > 0 && (
                  <span
                    className="cursor-help"
                    title={
                      'ESTIMATED. Skeleton + fills + fullBody tokens rendered into WM this round, vs the sum of underlying chunks these views replaced.\n'
                      + `rendered ${(pm.fileViewRenderedTokens ?? 0).toLocaleString()} · covered ${(pm.fileViewCoveredChunkTokens ?? 0).toLocaleString()} · delta ${((pm.fileViewRenderedTokens ?? 0) - (pm.fileViewCoveredChunkTokens ?? 0)).toLocaleString()}`
                    }
                  >
                    rendered {formatTokens(pm.fileViewRenderedTokens ?? 0)} · chunks {formatTokens(pm.fileViewCoveredChunkTokens ?? 0)}
                  </span>
                )}
                {(pm.fileViewReuseCount ?? 0) > 0 && (
                  <span
                    className="text-studio-success cursor-help"
                    title={`Rounds a FileView rendered without a new fill — measures reuse vs. first-touch premium (${(pm.fileViewReuseCount ?? 0).toLocaleString()}).`}
                  >
                    reuse {(pm.fileViewReuseCount ?? 0).toLocaleString()}
                  </span>
                )}
                {((pm.autoHealShiftedCount ?? 0) + (pm.autoRefetchCount ?? 0)) > 0 && (
                  <span
                    className="cursor-help"
                    title={
                      `Auto-heal counts: shifted rebases ${(pm.autoHealShiftedCount ?? 0).toLocaleString()}, `
                      + `refetches ${(pm.autoRefetchCount ?? 0).toLocaleString()} (skipped by cap ${(pm.autoRefetchSkippedByCap ?? 0).toLocaleString()}).`
                    }
                  >
                    heal {(pm.autoHealShiftedCount ?? 0).toLocaleString()}/{(pm.autoRefetchCount ?? 0).toLocaleString()}
                  </span>
                )}
                {(pm.staleReadRounds ?? 0) > 0 && (
                  <span
                    className="text-studio-error cursor-help"
                    title="Rounds where the model emitted a 'let me re-read because stale' self-correction. Target zero — non-zero indicates an auto-heal bug."
                  >
                    stale {(pm.staleReadRounds ?? 0).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Cache performance */}
          {cacheMetrics.sessionRequests > 0 && (
            <div className="border-t border-studio-border pt-1">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-studio-text-secondary cursor-help" title="Provider prompt-cache token accounting for this app session (reads/writes/uncached).">
                  Cache Performance
                </span>
                <span className="cursor-help" title={`Recorded cache-bearing API requests this session: ${cacheMetrics.sessionRequests.toLocaleString()}.`}>
                  {cacheMetrics.sessionRequests} request{cacheMetrics.sessionRequests !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0">
                <span className="text-studio-success font-medium cursor-help" title={headerCacheTitle}>
                  hit rate: {Math.round(cacheMetrics.sessionHitRate * 100)}%
                </span>
                {cacheMetrics.sessionCacheReads > 0 && (
                  <span
                    className="cursor-help"
                    title={`Cache read (reused prefix) tokens summed: ${cacheMetrics.sessionCacheReads.toLocaleString()} (~${formatTokens(cacheMetrics.sessionCacheReads)}).`}
                  >
                    reads: {formatTokens(cacheMetrics.sessionCacheReads)}
                  </span>
                )}
                {cacheMetrics.sessionCacheWrites > 0 && (
                  <span
                    className="cursor-help"
                    title={`Cache creation / write tokens summed: ${cacheMetrics.sessionCacheWrites.toLocaleString()} (~${formatTokens(cacheMetrics.sessionCacheWrites)}).`}
                  >
                    writes: {formatTokens(cacheMetrics.sessionCacheWrites)}
                  </span>
                )}
                {cacheMetrics.sessionUncached > 0 && (
                  <span
                    className="text-studio-text-secondary cursor-help"
                    title={`Uncached prompt tokens (billed as fresh) summed: ${cacheMetrics.sessionUncached.toLocaleString()} (~${formatTokens(cacheMetrics.sessionUncached)}).`}
                  >
                    uncached: {formatTokens(cacheMetrics.sessionUncached)}
                  </span>
                )}
              </div>
              {sessionCacheSavingsCents > 0 && (
                <div className="flex items-center gap-2 mt-0.5">
                  <span
                    className="text-studio-success cursor-help"
                    title={
                      'Billing-grade cache savings: sum of (no-cache cost) − (with-cache cost) across recorded rounds, using the same calculateCostBreakdown the chat/session totals use. '
                      + `Session cache reads: ${cacheMetrics.sessionCacheReads.toLocaleString()} tokens; provider-specific discount applied per round.`
                    }
                  >
                    {formatCost(sessionCacheSavingsCents)} saved via cache
                  </span>
                </div>
              )}
              {provider === 'anthropic' && logicalCache.staticHit !== null && (
                <div className="flex flex-wrap gap-x-3 gap-y-0 mt-0.5">
                  <span className="text-studio-text-secondary cursor-help" title="Logical cache expectation from last request: static system prefix and BP3 prior-turns stability.">
                    expected:
                  </span>
                  <span
                    className={`cursor-help ${logicalCache.staticHit ? 'text-green-400' : 'text-red-400'}`}
                    title={
                      logicalCache.staticHit
                        ? 'Static system prefix matched cache breakpoint (expected HIT).'
                        : 'Static system prefix changed; cache breakpoint may miss.'
                    }
                  >
                    Static {logicalCache.staticHit ? 'HIT' : 'MISS'}
                  </span>
                  <span
                    className={`cursor-help ${logicalCache.bp3Hit ? 'text-green-400' : 'text-red-400'}`}
                    title={headerBp3Title}
                  >
                    BP3 {logicalCache.bp3Hit ? 'HIT' : 'MISS'}
                    {logicalCache.bp3Reason && <span className="text-studio-muted"> ({logicalCache.bp3Reason})</span>}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Context budget split — buckets match aiService RoundSnapshot / getEstimatedTotalPromptTokens */}
          <div className="border-t border-studio-border pt-1">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-studio-text-secondary cursor-help" title="Last round snapshot buckets (system, history, staged, WM, workspace) when available; bar widths are share of model max window.">
                Budget Split
              </span>
              <span className="cursor-help" title={budgetUsedMaxTitle}>
                {formatTokens(usedTokens)} / {formatTokens(maxTokens)}
              </span>
            </div>
            {latestSnapshot && budgetSplitBuckets.length > 0 ? (
              <>
                <div className="flex h-1.5 rounded-full overflow-hidden bg-studio-border">
                  {budgetSplitBuckets.map((b) => {
                    const wPct = Math.min(100, (b.tokens / maxTokens) * 100);
                    const bTitle = `${b.label}: ${b.tokens.toLocaleString()} tokens (~${formatTokens(b.tokens)}), ${wPct.toFixed(1)}% of max window.`;
                    return (
                      <div
                        key={b.label}
                        className={`${b.color} transition-all cursor-help`}
                        style={{ width: `${wPct}%` }}
                        title={bTitle}
                      />
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-0 mt-0.5">
                  {budgetSplitBuckets.map((b) => (
                    <span
                      key={b.label}
                      className="flex items-center gap-0.5 cursor-help"
                      title={`${b.label}: ${b.tokens.toLocaleString()} tokens (~${formatTokens(b.tokens)}).`}
                    >
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${b.color}`} />
                      {b.label.toLowerCase()} {formatTokens(b.tokens)}
                    </span>
                  ))}
                  <span
                    className="flex items-center gap-0.5 cursor-help"
                    title={`Remaining headroom: ${Math.max(0, maxTokens - usedTokens).toLocaleString()} tokens (~${formatTokens(Math.max(0, maxTokens - usedTokens))}) before max context.`}
                  >
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-studio-border" />
                    free {formatTokens(Math.max(0, maxTokens - usedTokens))}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="flex h-1.5 rounded-full overflow-hidden bg-studio-border">
                  <div
                    className="bg-studio-accent/80 transition-all cursor-help"
                    style={{ width: `${Math.min(100, maxTokens > 0 ? (usedTokens / maxTokens) * 100 : 0)}%` }}
                    title={`Estimated prompt fill (no bucket snapshot): ${usedTokens.toLocaleString()} (~${formatTokens(usedTokens)}) — ${(maxTokens > 0 ? (usedTokens / maxTokens) * 100 : 0).toFixed(1)}% of ${maxTokens.toLocaleString()} max.`}
                  />
                </div>
                <div className="text-[9px] text-studio-text-muted mt-0.5">
                  {latestSnapshot
                    ? 'Bucket segments are zero; total above still reflects last round estimate.'
                    : 'No round snapshot yet — bar is WM + overhead estimate; bucketed split after the first completed round.'}
                </div>
                <div className="flex flex-wrap gap-x-2 gap-y-0 mt-0.5">
                  <span
                    className="flex items-center gap-0.5 cursor-help"
                    title={`Remaining headroom: ${Math.max(0, maxTokens - usedTokens).toLocaleString()} tokens (~${formatTokens(Math.max(0, maxTokens - usedTokens))}).`}
                  >
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-studio-border" />
                    free {formatTokens(Math.max(0, maxTokens - usedTokens))}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default ContextMetrics;
