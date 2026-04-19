/**
 * FileView token estimator — keeps `getPromptTokens` and per-round snapshots
 * honest after the Unified FileView ships.
 *
 * Problem: `contextStore.getPromptTokens()` used to sum `c.tokens` across all
 * chunks, but the context formatter now
 *   1. suppresses chunks whose hash is covered by any live FileView, and
 *   2. injects a rendered block (skeleton + fills + fullBody + markers) for
 *      every view.
 * Counting chunks alone drifts both ways — usually understates WM, sometimes
 * overstates it — so the bar, the efficiency %, and the round snapshot all
 * disagree with what the model actually sees.
 *
 * This module computes the delta directly from view structure without
 * re-counting raw text. Token numbers come from the FileView's own fields
 * (`filledRegions[].tokens`, skeletonRows joined + `countTokensSync`), and a
 * tiny LRU cache keyed by `(filePath, sourceRevision, structureFingerprint)`
 * prevents the `countTokensSync` path from firing on steady-state renders.
 *
 * See `docs/metrics.md` for the billed-vs-estimated framing.
 */

import type { FileView } from './fileViewStore';
import { countTokensSync } from '../utils/tokenCounter';

/** Estimator output for a single FileView. */
export interface FileViewTokenEstimate {
  /** Tokens contributed by skeleton rows not overlaid by any fill region. */
  skeletonTokens: number;
  /** Tokens contributed by filled regions (uses stored `region.tokens`). */
  filledTokens: number;
  /** Tokens contributed by `fullBody`, if set. Dominates skeleton + fills. */
  fullBodyTokens: number;
  /** Tokens for header + markers + trailing fences. Small but non-zero. */
  chromeTokens: number;
  /** Total tokens the view contributes to the prompt. */
  total: number;
}

/** Aggregate estimator output across all views. */
export interface FileViewsTokenSummary {
  /** Sum of per-view `total`. The number to add to prompt pressure. */
  totalRenderedTokens: number;
  /**
   * Sum of skeleton body token contribution (excluding chrome). Surfaces as
   * `PromptMetrics.fileViewRenderedTokens` for the UI.
   */
  skeletonTokens: number;
  /** Same kind of sum for fills + fullBody. */
  bodyTokens: number;
  /** Number of views contributing. */
  viewCount: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  fingerprint: string;
  estimate: FileViewTokenEstimate;
}

/**
 * Small, bounded LRU. Keyed by `view.filePath` — one entry per path, evicted
 * via insertion-order once size exceeds `MAX_ENTRIES`. Map iteration order
 * in JS is insertion order; re-inserting an existing key refreshes its slot.
 */
const MAX_ENTRIES = 256;
const cache = new Map<string, CacheEntry>();

function cachePut(path: string, entry: CacheEntry): void {
  if (cache.has(path)) cache.delete(path);
  cache.set(path, entry);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function cacheGet(path: string, fingerprint: string): FileViewTokenEstimate | null {
  const entry = cache.get(path);
  if (!entry || entry.fingerprint !== fingerprint) return null;
  cache.delete(path);
  cache.set(path, entry);
  return entry.estimate;
}

/** Test-only hook. Production code should not need this. */
export function clearFileViewTokenCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Fingerprint — cheap hash of the structural bits that matter for token cost
// ---------------------------------------------------------------------------

function fingerprintView(view: FileView): string {
  // The stored `region.tokens` counts are pinned to content, so any change in
  // region count/extent shows up here without hashing full bodies.
  const regionSig = view.filledRegions
    .map(r => `${r.start}-${r.end}:${r.tokens}`)
    .join(',');
  const markerSig = view.removedMarkers
    ? view.removedMarkers.map(m => `${m.start}-${m.end}`).join(',')
    : '';
  const pendingCount = view.pendingRefetches?.length ?? 0;
  const skeletonSig = `${view.skeletonRows.length}:${view.sigLevel}`;
  const fullBodyLen = view.fullBody?.length ?? 0;
  return [
    view.sourceRevision,
    view.totalLines,
    skeletonSig,
    regionSig,
    markerSig,
    pendingCount,
    fullBodyLen,
    view.pinned ? '1' : '0',
  ].join('|');
}

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------

const SHORT_REV_LEN = 6;

/** Token cost of the `=== path h:<retention> cite:@h:<cite> (N lines) [pinned] ===` header line. */
function estimateHeaderTokens(view: FileView): number {
  const pinSuffix = view.pinned ? ' [pinned]' : '';
  const cite = view.sourceRevision.replace(/^h:/, '').slice(0, SHORT_REV_LEN);
  const header = `=== ${view.filePath} h:${view.shortHash} cite:@h:${cite} (${view.totalLines} lines)${pinSuffix} ===`;
  return countTokensSync(header);
}

function estimateMarkerTokens(view: FileView, currentRound: number): number {
  const parts: string[] = [];
  for (const region of view.filledRegions) {
    if (region.origin === 'refetch' && region.refetchedAtRound === currentRound) {
      parts.push(`[edited L${region.start}-${region.end} this round]`);
    }
  }
  if (view.removedMarkers && view.removedMarkers.length > 0) {
    for (const m of view.removedMarkers) parts.push(`[REMOVED was L${m.start}-${m.end}]`);
  }
  if (view.pendingRefetches && view.pendingRefetches.length > 0) {
    const n = view.pendingRefetches.length;
    parts.push(`[changed: ${n} region${n === 1 ? '' : 's'} pending refetch — re-read on demand]`);
  }
  if (parts.length === 0) return 0;
  return countTokensSync(parts.join('\n'));
}

/** Lines whose 1-based `N|` prefix falls outside every filled region. */
function skeletonRowsNotCoveredByFills(view: FileView): string[] {
  if (view.filledRegions.length === 0) return view.skeletonRows;
  const ranges = view.filledRegions
    .slice()
    .sort((a, b) => a.start - b.start);
  const kept: string[] = [];
  for (const row of view.skeletonRows) {
    const m = /^\s*(\d+)\|/.exec(row);
    if (!m) {
      kept.push(row);
      continue;
    }
    const line = parseInt(m[1], 10);
    const covered = ranges.some(r => r.start <= line && line <= r.end);
    if (!covered) kept.push(row);
  }
  return kept;
}

/**
 * Estimate tokens for a single view. When `currentRound` is provided, the
 * ephemeral `[edited ... this round]` markers are priced too; otherwise they
 * are treated as absent (matches the round boundary used elsewhere).
 */
export function estimateFileViewTokens(view: FileView, currentRound = 0): FileViewTokenEstimate {
  const fingerprint = fingerprintView(view) + '|r=' + currentRound;
  const cached = cacheGet(view.filePath, fingerprint);
  if (cached) return cached;

  const chromeTokens =
    estimateHeaderTokens(view)
    + estimateMarkerTokens(view, currentRound)
    // Trailing `===` fence (single-line, cheap but not zero).
    + countTokensSync('===');

  let skeletonTokens = 0;
  let filledTokens = 0;
  let fullBodyTokens = 0;

  if (view.fullBody !== undefined) {
    // fullBody replaces skeleton + fills entirely.
    fullBodyTokens = countTokensSync(view.fullBody);
  } else {
    const keptSkeleton = skeletonRowsNotCoveredByFills(view);
    if (keptSkeleton.length > 0) {
      skeletonTokens = countTokensSync(keptSkeleton.join('\n'));
    }
    for (const r of view.filledRegions) {
      filledTokens += r.tokens;
    }
  }

  const estimate: FileViewTokenEstimate = {
    skeletonTokens,
    filledTokens,
    fullBodyTokens,
    chromeTokens,
    total: skeletonTokens + filledTokens + fullBodyTokens + chromeTokens,
  };

  cachePut(view.filePath, { fingerprint, estimate });
  return estimate;
}

/**
 * Aggregate across all live views. Counts **pinned** views only — unpinned
 * views are dormant (do not render, charge 0 tokens), mirroring
 * `renderAllFileViewBlocks`. Also skips pinned views that render nothing.
 */
export function summarizeFileViewTokens(
  views: Iterable<FileView>,
  currentRound = 0,
): FileViewsTokenSummary {
  let totalRenderedTokens = 0;
  let skeletonTokens = 0;
  let bodyTokens = 0;
  let viewCount = 0;
  for (const view of views) {
    if (!view.pinned) continue;
    const hasContent =
      view.skeletonRows.length > 0
      || view.filledRegions.length > 0
      || view.fullBody !== undefined
      || (view.removedMarkers?.length ?? 0) > 0
      || (view.pendingRefetches?.length ?? 0) > 0;
    if (!hasContent) continue;
    const est = estimateFileViewTokens(view, currentRound);
    totalRenderedTokens += est.total;
    skeletonTokens += est.skeletonTokens;
    bodyTokens += est.filledTokens + est.fullBodyTokens;
    viewCount++;
  }
  return { totalRenderedTokens, skeletonTokens, bodyTokens, viewCount };
}
