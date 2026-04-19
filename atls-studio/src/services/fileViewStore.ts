/**
 * FileView store module — pure data layer for the unified FileView state engine.
 *
 * This module contains:
 *   - Data types: {@link FilledRegion}, {@link FileView}, {@link IncomingFill}
 *   - Interval-merge logic: {@link mergeFilledRegion}
 *   - Coverage auto-promote: {@link shouldAutoPromoteToFullBody}
 *   - Auto-heal reconcile: {@link reconcileFileView}
 *
 * All functions are pure — they take current state + inputs and return new state.
 * Zustand integration lives in contextStore.ts and invokes these helpers.
 *
 * See docs/ — plan: Unified FileView.
 */
import { hashContentSync, SHORT_HASH_LEN } from '../utils/contextHash';
import { countTokensSync } from '../utils/tokenCounter';
import { getFreshnessJournal } from './freshnessJournal';
import type { FileSkeleton } from './fileView';
import { normalizePath } from './fileView';
// Type-only import: EngramAnnotation is defined in contextStore. Importing it
// back keeps FileView.annotations structurally identical to
// ContextChunk.annotations. The import is erased at runtime, so no cycle.
import type { EngramAnnotation } from '../stores/contextStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A filled region inside a FileView — a contiguous range of source lines
 * whose body content is known from one or more read operations.
 */
export interface FilledRegion {
  /** 1-based start line, inclusive */
  start: number;
  /** 1-based end line, inclusive */
  end: number;
  /** `N|CONTENT` rows covering [start, end], sorted by line number */
  content: string;
  /** Source chunk hashes this region aggregates; deduped */
  chunkHashes: string[];
  /** BPE (or heuristic) token count of `content` */
  tokens: number;
  /** 'read' = direct agent read, 'refetch' = auto-heal replacement */
  origin: 'read' | 'refetch';
  /** Round at which this region was refetched (drives the ephemeral marker) */
  refetchedAtRound?: number;
}

export type FileViewFreshness = 'fresh' | 'shifted' | 'suspect';
export type FileViewFreshnessCause =
  | 'same_file_prior_edit'
  | 'external_file_change'
  | 'session_restore'
  | 'unknown';

/**
 * A live, progressively-refined view of one file at one source revision.
 * Key = normalized filePath. One view per path.
 */
export interface FileView {
  filePath: string;
  sourceRevision: string;
  observedRevision: string;
  totalLines: number;
  /** imports + sig rows, stitched and cached per revision */
  skeletonRows: string[];
  /** Which shape op produced the body portion of the skeleton */
  sigLevel: 'sig' | 'fold';
  /** Sorted non-overlapping regions, in file order */
  filledRegions: FilledRegion[];
  /** Set iff a full read landed or coverage auto-promote fired */
  fullBody?: string;
  /** Chunk hash that owns fullBody, when set */
  fullBodyChunkHash?: string;
  /**
   * Aggregate identity: `h:<SHORT_HASH_LEN hex>` derived from (filePath, sourceRevision).
   * Shares the chunk-hash namespace — the model sees one format. Lookup routes
   * `h:<short>` to either the fileViews map (views first) or chunks map via
   * `resolveAnyRef` in contextStore.
   */
  hash: string;
  /** Short hex portion of `hash` (without the `h:` prefix), for O(1) prefix lookups. */
  shortHash: string;
  lastAccessed: number;
  pinned: boolean;
  pinnedShape?: string;
  /**
   * Wall-clock timestamp at which auto-pin first set `pinned = true`.
   * Absent when the pin was created by explicit `session.pin` (manual).
   * Cleared when the view is unpinned. Used by the telemetry path to detect
   * auto-pins that were released without ever being re-accessed
   * (`lastAccessed <= autoPinnedAt` at release time).
   */
  autoPinnedAt?: number;
  freshness?: FileViewFreshness;
  freshnessCause?: FileViewFreshnessCause;
  /** Rebase-failed ranges surfaced as `[REMOVED was L205-213]` until resolved */
  removedMarkers?: Array<{ start: number; end: number }>;
  /**
   * Pending refetches from the last reconcile. Populated for pinned
   * content-changed regions; caller processes under a per-round cap.
   */
  pendingRefetches?: PendingRefetch[];
  /**
   * Free-form notes attached to this view via `annotate.note` with a FileView
   * hash. Persists across rounds alongside the view; rendered in the
   * `## FILE VIEWS` block header. Parallels `ContextChunk.annotations`.
   */
  annotations?: EngramAnnotation[];
}

export interface PendingRefetch {
  start: number;
  end: number;
  /** Reason we need to refetch this span */
  cause: FileViewFreshnessCause;
  /** Round at which we detected staleness */
  detectedAtRound: number;
}

export interface IncomingFill {
  start: number;
  end: number;
  /** `N|CONTENT` rows covering the full range */
  content: string;
  /** The chunk hash backing this fill */
  chunkHash: string;
  /** BPE tokens; if omitted, computed via countTokensSync */
  tokens?: number;
  origin?: 'read' | 'refetch';
  refetchedAtRound?: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Fraction of estimated full-body tokens at which we auto-promote. */
export const COVERAGE_PROMOTE_RATIO = 0.9;

/** Fallback estimator when we have no language-specific avg. ~bytes/3 for code. */
export const AVG_TOKENS_PER_LINE_DEFAULT = 10;

/** Max auto-refetches per round. Overflow drops regions and surfaces an aggregate hint. */
export const MAX_REFETCHES_PER_ROUND_DEFAULT = 10;

// ---------------------------------------------------------------------------
// Interval merge
// ---------------------------------------------------------------------------

/**
 * Merge an incoming fill into the sorted non-overlapping region list.
 *
 * Handles overlap AND adjacency (touching intervals merge).
 *
 * On line-level collision inside the merged range, the **incoming** fill's
 * content wins (it's newer / authoritative).
 */
export function mergeFilledRegion(
  regions: FilledRegion[],
  incoming: IncomingFill,
): FilledRegion[] {
  if (incoming.end < incoming.start) {
    // Defensive: ignore inverted ranges.
    return regions.slice();
  }

  const incomingRows = parseRowsByLine(incoming.content);
  const lineToRow = new Map<number, string>();
  for (const [ln, row] of incomingRows) lineToRow.set(ln, row);
  const hashes = new Set<string>();
  hashes.add(incoming.chunkHash);

  let resultStart = incoming.start;
  let resultEnd = incoming.end;
  let hasOverlap = false;
  const kept: FilledRegion[] = [];

  for (const region of regions) {
    const overlapsOrAdjacent =
      region.start <= resultEnd + 1 && region.end >= resultStart - 1;
    if (overlapsOrAdjacent) {
      hasOverlap = true;
      resultStart = Math.min(resultStart, region.start);
      resultEnd = Math.max(resultEnd, region.end);
      const existingRows = parseRowsByLine(region.content);
      for (const [ln, row] of existingRows) {
        // Incoming wins — only fill gaps from existing.
        if (!lineToRow.has(ln)) lineToRow.set(ln, row);
      }
      for (const h of region.chunkHashes) hashes.add(h);
    } else {
      kept.push(region);
    }
  }

  const mergedLines = Array.from(lineToRow.keys()).sort((a, b) => a - b);
  const mergedContent = mergedLines.map(n => lineToRow.get(n)!).join('\n');
  const tokens =
    incoming.tokens != null && !hasOverlap
      ? incoming.tokens
      : countTokensSync(mergedContent);

  const merged: FilledRegion = {
    start: resultStart,
    end: resultEnd,
    content: mergedContent,
    chunkHashes: Array.from(hashes),
    tokens,
    origin: incoming.origin ?? 'read',
    refetchedAtRound: incoming.refetchedAtRound,
  };

  kept.push(merged);
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

/** Remove the region that covers `chunkHash` (or drop the hash from a shared region). */
export function dropRegionByChunk(
  regions: FilledRegion[],
  chunkHash: string,
): FilledRegion[] {
  const out: FilledRegion[] = [];
  for (const r of regions) {
    if (!r.chunkHashes.includes(chunkHash)) {
      out.push(r);
      continue;
    }
    if (r.chunkHashes.length === 1) {
      // Sole source — drop entire region.
      continue;
    }
    // Shared region: drop the hash, keep content as-is.
    out.push({
      ...r,
      chunkHashes: r.chunkHashes.filter(h => h !== chunkHash),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coverage auto-promote
// ---------------------------------------------------------------------------

/**
 * Returns true when accumulated region tokens cross the promote threshold
 * relative to estimated full-body tokens. Caller materializes `fullBody` and
 * drops the region list.
 */
export function shouldAutoPromoteToFullBody(
  view: Pick<FileView, 'filledRegions' | 'totalLines' | 'fullBody'>,
  avgTokensPerLine: number = AVG_TOKENS_PER_LINE_DEFAULT,
): boolean {
  if (view.fullBody !== undefined) return false;
  if (view.totalLines <= 0) return false;
  const filledTokens = view.filledRegions.reduce((s, r) => s + r.tokens, 0);
  const estimatedFullBody = view.totalLines * avgTokensPerLine;
  if (estimatedFullBody <= 0) return false;
  return filledTokens >= COVERAGE_PROMOTE_RATIO * estimatedFullBody;
}

/**
 * Compose fullBody from sorted filled regions. Assumes coverage promote
 * conditions hold — caller is responsible for the decision.
 */
export function composeFullBodyFromRegions(view: Pick<FileView, 'filledRegions'>): string {
  return view.filledRegions.map(r => r.content).join('\n');
}

// ---------------------------------------------------------------------------
// Auto-heal reconcile
// ---------------------------------------------------------------------------

export interface ReconcileInputs {
  /** New content_hash for the file */
  currentRevision: string;
  /** Cause as determined by the caller (reconcileSourceRevision) */
  cause: FileViewFreshnessCause;
  /** Current round number for refetch marker bookkeeping */
  round: number;
  /** Fresh skeleton for the new revision (caller is responsible for building) */
  newSkeleton?: FileSkeleton;
}

export interface ReconcileOutcome {
  /** The new view state after auto-heal */
  view: FileView;
  /** Whether anything in the view changed */
  updated: boolean;
  /** Refetch requests the caller should enqueue for async processing */
  refetchRequests: PendingRefetch[];
  /** Regions whose content is gone at shifted position — surfaced as [REMOVED] */
  rebaseFailures: Array<{ start: number; end: number }>;
}

/**
 * Pure auto-heal reconcile for a single FileView.
 *
 * Policy (Section 6 of the plan):
 * - Skeleton regenerates (caller supplies newSkeleton if revision changed).
 * - same_file_prior_edit: shifted regions rebase via freshnessJournal.lineDelta.
 * - Pinned content-changed regions go into pendingRefetches.
 * - Unpinned content-changed regions drop silently.
 * - Rebase failure (no matching line delta) surfaces [REMOVED].
 */
export function reconcileFileView(
  view: FileView,
  inputs: ReconcileInputs,
): ReconcileOutcome {
  const { currentRevision, cause, round, newSkeleton } = inputs;

  // Revision unchanged → only bump observedRevision; no region work.
  if (view.sourceRevision === currentRevision) {
    if (view.observedRevision === currentRevision) {
      return { view, updated: false, refetchRequests: [], rebaseFailures: [] };
    }
    return {
      view: { ...view, observedRevision: currentRevision, freshness: 'fresh' },
      updated: true,
      refetchRequests: [],
      rebaseFailures: [],
    };
  }

  const isSameFileEdit = cause === 'same_file_prior_edit';
  const journalEntry = getFreshnessJournal(view.filePath);
  const lineDelta = journalEntry?.lineDelta;

  const rebased: FilledRegion[] = [];
  const refetchRequests: PendingRefetch[] = [];
  const rebaseFailures: Array<{ start: number; end: number }> = [];

  for (const region of view.filledRegions) {
    if (isSameFileEdit && lineDelta != null && lineDelta !== 0) {
      // Shifted: rebase line numbers, keep content — rows still describe the
      // same source text, just at new line numbers after the edit.
      const shifted: FilledRegion = {
        ...region,
        start: region.start + lineDelta,
        end: region.end + lineDelta,
        // Rewrite the N| prefix on each row to reflect the new lines.
        content: shiftRowsByLine(region.content, lineDelta),
      };
      if (shifted.start < 1) {
        // Rebase pushed the region below line 1 — treat as gone.
        rebaseFailures.push({ start: region.start, end: region.end });
        continue;
      }
      rebased.push(shifted);
      continue;
    }

    // Content-change branch: either no journal delta available, or cause is
    // external / session_restore. Pinned views auto-refetch under cap;
    // unpinned drop silently.
    if (view.pinned) {
      refetchRequests.push({
        start: region.start,
        end: region.end,
        cause,
        detectedAtRound: round,
      });
    }
    // Unpinned region just disappears.
  }

  // fullBody invalidates on revision bump unless same_file_edit with a delta
  // (in which case shifted rebase may still hold; but without per-line delta
  // mapping inside fullBody we conservatively clear and let the model re-read).
  const clearedFullBody = view.fullBody !== undefined;

  const nextHashParts = computeFileViewHashParts(view.filePath, currentRevision);
  const nextView: FileView = {
    ...view,
    sourceRevision: currentRevision,
    observedRevision: currentRevision,
    skeletonRows: newSkeleton?.rows ?? view.skeletonRows,
    sigLevel: newSkeleton?.sigLevel ?? view.sigLevel,
    totalLines: newSkeleton?.totalLines ?? view.totalLines,
    filledRegions: rebased,
    fullBody: undefined,
    fullBodyChunkHash: undefined,
    hash: nextHashParts.hash,
    shortHash: nextHashParts.shortHash,
    freshness: isSameFileEdit && rebased.length > 0 ? 'shifted' : 'fresh',
    freshnessCause: cause,
    pendingRefetches: refetchRequests.length > 0 ? refetchRequests : undefined,
    removedMarkers: rebaseFailures.length > 0
      ? [...(view.removedMarkers ?? []), ...rebaseFailures]
      : view.removedMarkers,
    lastAccessed: Date.now(),
  };
  void clearedFullBody; // fullBody intentionally discarded — see note above

  return {
    view: nextView,
    updated: true,
    refetchRequests,
    rebaseFailures,
  };
}

/**
 * Drop refetch requests beyond the per-round cap. Returns the processable
 * subset and the count skipped. Priority: caller supplies ordered list
 * (pinned-first, then LRU).
 */
export function applyRefetchCap<T>(
  requests: T[],
  cap: number = MAX_REFETCHES_PER_ROUND_DEFAULT,
): { processed: T[]; skipped: number } {
  if (requests.length <= cap) return { processed: requests.slice(), skipped: 0 };
  return {
    processed: requests.slice(0, cap),
    skipped: requests.length - cap,
  };
}

/**
 * Called when a constituent chunk TTL-expires or is evicted — drop any
 * region(s) backed by this hash. Returns the new region list.
 */
export function onConstituentChunkRemoved(
  view: FileView,
  chunkHash: string,
): FileView {
  const nextRegions = dropRegionByChunk(view.filledRegions, chunkHash);
  if (nextRegions === view.filledRegions) return view;
  const nextHashParts = computeFileViewHashParts(view.filePath, view.sourceRevision);
  return {
    ...view,
    filledRegions: nextRegions,
    hash: nextHashParts.hash,
    shortHash: nextHashParts.shortHash,
    lastAccessed: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// View construction & updates
// ---------------------------------------------------------------------------

/** Compose a fresh empty FileView around a skeleton. */
export function createFileView(skeleton: FileSkeleton, opts?: { pinned?: boolean }): FileView {
  const path = normalizePath(skeleton.path);
  const { hash, shortHash } = computeFileViewHashParts(path, skeleton.revision);
  return {
    filePath: path,
    sourceRevision: skeleton.revision,
    observedRevision: skeleton.revision,
    totalLines: skeleton.totalLines,
    skeletonRows: skeleton.rows,
    sigLevel: skeleton.sigLevel,
    filledRegions: [],
    hash,
    shortHash,
    lastAccessed: Date.now(),
    pinned: opts?.pinned ?? false,
    freshness: 'fresh',
  };
}

/**
 * Apply a fill to a FileView. Handles coverage auto-promote to fullBody.
 * Idempotent re-insert of the same chunk is a no-op (interval-merge still runs).
 */
export function applyFillToView(
  view: FileView,
  fill: IncomingFill,
  opts?: { avgTokensPerLine?: number },
): FileView {
  const nextRegions = mergeFilledRegion(view.filledRegions, fill);
  const probe: FileView = {
    ...view,
    filledRegions: nextRegions,
  };
  const refreshed = computeFileViewHashParts(view.filePath, view.sourceRevision);
  if (shouldAutoPromoteToFullBody(probe, opts?.avgTokensPerLine)) {
    const body = composeFullBodyFromRegions(probe);
    return {
      ...view,
      fullBody: body,
      fullBodyChunkHash: fill.chunkHash,
      filledRegions: nextRegions,
      hash: refreshed.hash,
      shortHash: refreshed.shortHash,
      lastAccessed: Date.now(),
    };
  }
  return {
    ...view,
    filledRegions: nextRegions,
    hash: refreshed.hash,
    shortHash: refreshed.shortHash,
    lastAccessed: Date.now(),
  };
}

/**
 * Apply a full-body fill directly, bypassing region accounting.
 * Used when a full-file read explicitly requests the whole body.
 */
export function applyFullBodyToView(
  view: FileView,
  fullBody: string,
  chunkHash: string,
): FileView {
  const { hash, shortHash } = computeFileViewHashParts(view.filePath, view.sourceRevision);
  return {
    ...view,
    fullBody,
    fullBodyChunkHash: chunkHash,
    hash,
    shortHash,
    lastAccessed: Date.now(),
  };
}

/** Clear refetch queue after caller has processed it (success or failure). */
export function clearPendingRefetches(view: FileView): FileView {
  if (!view.pendingRefetches) return view;
  return { ...view, pendingRefetches: undefined };
}

/** Clear a [REMOVED] marker (e.g. after agent re-reads that range). */
export function clearRemovedMarker(
  view: FileView,
  start: number,
  end: number,
): FileView {
  if (!view.removedMarkers?.length) return view;
  const next = view.removedMarkers.filter(m => !(m.start === start && m.end === end));
  if (next.length === view.removedMarkers.length) return view;
  return {
    ...view,
    removedMarkers: next.length > 0 ? next : undefined,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Build a deterministic short ref (`h:<SHORT_HASH_LEN hex>`) identity — stable
 * per `(filePath, revision)`. Shares the chunk-hash namespace; the runtime
 * disambiguates via `resolveAnyRef` in contextStore (views first, chunks
 * fallback).
 *
 * Identity does NOT depend on filled regions or fullBody: the view IS the file
 * at this revision, regardless of how much the agent has materialized. This is
 * what makes the ref stable as the view grows; identity changes only on
 * revision bumps (source edits) or path changes.
 */
export function computeFileViewHash(filePath: string, revision: string): string {
  return computeFileViewHashParts(filePath, revision).hash;
}

/**
 * Same as {@link computeFileViewHash} but returns both the full ref and the
 * raw short-hash portion, so callers can populate FileView.shortHash without
 * re-slicing.
 */
export function computeFileViewHashParts(
  filePath: string,
  revision: string,
): { hash: string; shortHash: string } {
  const parts = [normalizePath(filePath), revision].join('|');
  const shortHash = hashContentSync(parts).slice(0, SHORT_HASH_LEN);
  return { hash: `h:${shortHash}`, shortHash };
}

/**
 * Restore migration: legacy snapshots persisted FileViews with `h:fv:<16hex>`
 * hashes and no `shortHash` field. The unified namespace retires the prefix;
 * recompute the view's hash deterministically so restored sessions keep
 * working against the current runtime. No-op when already current.
 */
export function migrateLegacyFileView(view: FileView): FileView {
  const expected = computeFileViewHashParts(view.filePath, view.sourceRevision);
  if (view.hash === expected.hash && view.shortHash === expected.shortHash) return view;
  return { ...view, hash: expected.hash, shortHash: expected.shortHash };
}

/** Parse `N|CONTENT` rows into a line→row map. Skips malformed rows. */
export function parseRowsByLine(content: string): Map<number, string> {
  const map = new Map<number, string>();
  if (!content) return map;
  for (const line of content.split('\n')) {
    const m = /^\s*(\d+)\|/.exec(line);
    if (m) map.set(parseInt(m[1], 10), line);
  }
  return map;
}

/**
 * Rewrite the `N|` prefix on each row by adding `delta` to the line number.
 * Preserves right-alignment width (4-col minimum) when possible.
 */
export function shiftRowsByLine(content: string, delta: number): string {
  if (delta === 0 || !content) return content;
  return content
    .split('\n')
    .map(row => {
      const m = /^(\s*)(\d+)(\|.*)$/.exec(row);
      if (!m) return row;
      const newLine = parseInt(m[2], 10) + delta;
      if (newLine < 1) return row; // defensive; caller handles rebase fail
      return `${m[1]}${String(newLine).padStart(Math.max(m[2].length, 1))}${m[3]}`;
    })
    .join('\n');
}
