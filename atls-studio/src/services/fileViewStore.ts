/**
 * FileView store module — pure data layer for the unified FileView state engine.
 *
 * This module contains:
 *   - Data types: {@link FilledRegion}, {@link FileView}, {@link IncomingFill}
 *   - Interval-merge logic: {@link mergeFilledRegion}
 *   - Coverage auto-promote: {@link shouldAutoPromoteToFullBody}
 *   - Auto-heal reconcile: {@link reconcileFileView}
 *   - Retention-hash forwarding chain: {@link matchesViewRef}
 *
 * All functions are pure — they take current state + inputs and return new state.
 * Zustand integration lives in contextStore.ts and invokes these helpers.
 *
 * ## Post-edit statefulness contract
 *
 * FileView is **stateful across own-edits** — the runtime (executor's
 * `refreshContextAfterEdit`) refills the view with authoritative post-edit
 * content at rebased coordinates before the next prompt render, so the model
 * does not re-read files it just edited. Delivery is split:
 *
 *   1. {@link reconcileFileView} with `postEditResolved: true` — advances
 *      `sourceRevision`, rebases line numbers via `freshnessJournal`,
 *      appends the old `shortHash` to `previousShortHashes`, and skips
 *      `pendingRefetches` (the caller is about to refill).
 *   2. The runtime then re-slices each surviving region from the resolved
 *      new body and calls `applyFillFromChunk(origin: 'refetch',
 *      refetchedAtRound)` — `mergeFilledRegion` dedupes/overwrites so
 *      regions end up with true post-edit bytes at true post-edit lines.
 *   3. `wasFullBody` views get `applyFullBodyFromChunk` with the new
 *      content; slice views stay slice views (no auto-promotion on own-
 *      edit).
 *
 * Callers who do NOT have authoritative post-edit content (external file
 * changes, session restore) omit `postEditResolved` — pinned views then
 * queue `pendingRefetches` so the caller can refetch asynchronously.
 *
 * ## Stable identity (path-derived)
 *
 * The retention `shortHash` is `filePath`-derived — stable across every
 * revision of the file. A pin in round 1 remains valid in round 100
 * regardless of how many edits happened between. `sourceRevision` rolls
 * internally for backend resolution; the model-visible ref does not.
 *
 * `FileView.previousShortHashes` survives as a session-restore migration
 * path: legacy snapshots persisted revision-scoped shortHashes, and
 * `migrateLegacyFileView` pushes those onto the chain so transcript cites
 * from those sessions keep resolving. New views never populate it.
 *
 * See docs/engrams.md — the "FileView — the unified file-content surface"
 * section (esp. "Post-edit statefulness" and "Stable identity across
 * revisions").
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
   * When `fullBody` is set, records HOW it was populated:
   *   - `'read'`           — an explicit full-body read via {@link applyFullBodyToView}.
   *   - `'coverage_promote'` — implicit promotion from {@link applyFillToView}
   *     when accumulated regions crossed {@link COVERAGE_PROMOTE_RATIO}.
   *
   * Optional for backwards compatibility with legacy in-memory views; absent
   * when `fullBody` is undefined. Surfaced in the FILE VIEWS header so the
   * model can distinguish an intentional full read from a region-stitched
   * auto-promote (the latter may be stale at edge ranges the heuristic
   * approximated rather than actually read).
   */
  fullBodyOrigin?: 'read' | 'coverage_promote';
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
  /**
   * Short-hash forwarding chain for this view. The view's retention `shortHash`
   * is `(filePath, sourceRevision)`-derived, so it **changes** on every
   * revision bump. Historical refs the model cites from earlier rounds
   * (`pu h:<oldShort>`, `ce f:h:<oldShort>:…`, etc.) would otherwise stop
   * resolving the moment an own-edit advances the revision.
   *
   * Every time the view's `shortHash` changes, the previous value is appended
   * here. Lookup helpers (`findViewByRef`, `resolveAnyRef`,
   * `resolveCiteFromView`) walk this chain in addition to the direct
   * `shortHash` match so stale transcript refs keep routing to the same
   * logical view.
   *
   * Lifetime: **indefinite — entries live until the view is dropped** (via
   * `dro`, `pruneFileViewsForChunks`, session clear, or `dropChunks` on the
   * constituent hashes). Memory cost is bounded by the per-view edit count
   * which is already bounded by WM pressure. Serialized with the view in
   * session snapshots so a restored session does not lose the ability to
   * resolve transcript refs.
   */
  previousShortHashes?: string[];
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

export interface DropRegionByChunkOptions {
  /**
   * When true, a region whose only backing chunk is removed **keeps** its line
   * `content` with `chunkHashes` cleared (detached from WM). When false
   * (default), sole-owner regions are removed (prior behavior).
   */
  retainSoleOwnerContent?: boolean;
}

/** Remove the region that covers `chunkHash` (or drop the hash from a shared region). */
export function dropRegionByChunk(
  regions: FilledRegion[],
  chunkHash: string,
  options?: DropRegionByChunkOptions,
): FilledRegion[] {
  const retainSole = options?.retainSoleOwnerContent ?? false;
  const out: FilledRegion[] = [];
  for (const r of regions) {
    if (!r.chunkHashes.includes(chunkHash)) {
      out.push(r);
      continue;
    }
    if (r.chunkHashes.length === 1) {
      if (retainSole) {
        out.push({ ...r, chunkHashes: [] });
      }
      // Else: sole source — drop entire region.
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

/**
 * Per-edit positional delta — same shape as `PositionalDelta` in
 * batch/executor.ts. Duplicated here (as a structural type) so the pure
 * fileViewStore module doesn't take a reverse-dependency on executor.
 *
 * A region rebase interprets each delta as "at `line`, N lines were
 * inserted/removed (N = delta)". `lineInclusive` (insert_before / prepend)
 * shifts targets at `line` itself; otherwise only targets strictly below
 * `line` shift. Sum the deltas whose anchors apply to each region edge
 * (`start` and `end`) independently — that's the same per-position math
 * `rebaseRegionsByDeltas` uses for snapshotTracker readRegions.
 */
export interface ReconcilePositionalDelta {
  line: number;
  delta: number;
  lineInclusive?: boolean;
}

export interface ReconcileInputs {
  /** New content_hash for the file */
  currentRevision: string;
  /** Cause as determined by the caller (reconcileSourceRevision) */
  cause: FileViewFreshnessCause;
  /** Current round number for refetch marker bookkeeping */
  round: number;
  /** Fresh skeleton for the new revision (caller is responsible for building) */
  newSkeleton?: FileSkeleton;
  /**
   * When true, the caller has already resolved authoritative post-edit
   * content and will immediately refill the view's regions / fullBody from
   * it (see `refreshContextAfterEdit` in executor.ts). In that case the
   * reconcile pass must NOT populate `pendingRefetches` — there is nothing
   * for the refetch cap worker to fetch; the content is already about to
   * land. Without this hint, pinned views would render
   * `[changed: N pending refetch — re-read on demand]` for edits the
   * runtime fully resolved, nudging the model into a redundant re-read.
   *
   * Only relevant for `cause: 'same_file_prior_edit'`. Ignored for
   * `external_file_change` and `session_restore` — those still need the
   * refetch queue because the runtime does not have the content.
   */
  postEditResolved?: boolean;
  /**
   * Per-edit positional deltas from the mutation that triggered this
   * reconcile. When provided (typically by `refreshContextAfterEdit`
   * passing the `buildPerFileDeltaMap` result), region coordinates rebase
   * with PER-POSITION precision — regions above the edit anchor stay put,
   * regions below shift by the net delta at that anchor. This is the same
   * math used by `rebaseRegionsByDeltas` / `applyDeltasToLineEdits` for
   * tracker readRegions and future line_edits.
   *
   * Without this, only a single scalar `freshnessJournal.lineDelta` is
   * available and gets applied UNIFORMLY to every region — which is wrong
   * for edits that only shift part of the file. That's the bug that made
   * same-batch multi-edit chains corrupt the view and sent the model back
   * to re-reading.
   *
   * Applies only when `cause === 'same_file_prior_edit'`. For other causes
   * (external change, session restore) we don't have deltas by construction
   * — the caller didn't make the edit.
   */
  positionalDeltas?: ReconcilePositionalDelta[];
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
  const { currentRevision, cause, round, newSkeleton, postEditResolved, positionalDeltas } = inputs;

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
  const hasPositionalDeltas = isSameFileEdit && Array.isArray(positionalDeltas) && positionalDeltas.length > 0;
  // Scalar fallback: only when we don't have positional-delta precision AND
  // there's a journal entry. External changes / session restore never have
  // deltas by construction — the caller didn't make the edit.
  const journalEntry = !hasPositionalDeltas ? getFreshnessJournal(view.filePath) : undefined;
  const scalarLineDelta = journalEntry?.lineDelta;

  const rebased: FilledRegion[] = [];
  const refetchRequests: PendingRefetch[] = [];
  const rebaseFailures: Array<{ start: number; end: number }> = [];

  for (const region of view.filledRegions) {
    if (hasPositionalDeltas) {
      // Per-position rebase: sum deltas whose anchor applies to `start` and
      // `end` INDEPENDENTLY. A region strictly above every edit anchor does
      // not shift; a region strictly below shifts by the cumulative delta;
      // a region that spans an edit gets its start and end shifted by
      // different amounts (expand/contract).
      //
      // Same math as `rebaseRegionsByDeltas` in batch/executor.ts. The
      // content is DELIBERATELY NOT shifted here: the caller
      // (`refreshContextAfterEdit`) will re-slice each region from the
      // resolved post-edit body at the new coordinates immediately after
      // reconcile returns, so any intermediate renumbering would be thrown
      // away.
      let startShift = 0;
      let endShift = 0;
      for (const d of positionalDeltas!) {
        if (d.lineInclusive ? d.line <= region.start : d.line < region.start) startShift += d.delta;
        if (d.lineInclusive ? d.line <= region.end : d.line < region.end) endShift += d.delta;
      }
      const newStart = region.start + startShift;
      const newEnd = region.end + endShift;
      if (newEnd < newStart || newStart < 1) {
        rebaseFailures.push({ start: region.start, end: region.end });
        continue;
      }
      rebased.push({
        ...region,
        start: newStart,
        end: newEnd,
        // Content will be overwritten by the caller's refill; keep the
        // pre-edit bytes as a stable placeholder so any reader that touches
        // the region BEFORE the refill runs at least sees textually-valid
        // rows. The refill's `mergeFilledRegion` overwrite will replace
        // them with authoritative bytes on the next round render.
        content: region.content,
      });
      continue;
    }

    if (isSameFileEdit && scalarLineDelta != null && scalarLineDelta !== 0) {
      // Legacy path: scalar lineDelta (no positional precision). Still used
      // by external-to-this-path callers that only populated the journal.
      // Applies uniformly to every region — caller accepts that limitation.
      const shifted: FilledRegion = {
        ...region,
        start: region.start + scalarLineDelta,
        end: region.end + scalarLineDelta,
        content: shiftRowsByLine(region.content, scalarLineDelta),
      };
      if (shifted.start < 1) {
        rebaseFailures.push({ start: region.start, end: region.end });
        continue;
      }
      rebased.push(shifted);
      continue;
    }

    if (isSameFileEdit && postEditResolved) {
      // Runtime has authoritative post-edit content and will re-apply it
      // immediately after reconcile (see `refreshContextAfterEdit`). Keep
      // the region in the list at its pre-edit coordinates as a placeholder
      // so the caller can re-slice at those coords against the new body.
      // Do NOT queue a pendingRefetch: there is nothing to fetch.
      rebased.push(region);
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
  // Record the old shortHash in the forwarding chain so historical refs from
  // prior rounds (in transcripts, BB entries, etc.) still route to this view.
  // Only push when the shortHash actually changed — identical revisions or
  // no-op reconciles skip to avoid chain bloat.
  const nextPreviousShortHashes = view.shortHash === nextHashParts.shortHash
    ? view.previousShortHashes
    : appendPreviousShortHash(view.previousShortHashes, view.shortHash);
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
    fullBodyOrigin: undefined,
    hash: nextHashParts.hash,
    shortHash: nextHashParts.shortHash,
    previousShortHashes: nextPreviousShortHashes,
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
 * Append `oldShort` to a view's forwarding chain. Idempotent — re-appending
 * the same value is a no-op (tail check), so repeat reconciles at the same
 * revision don't grow the chain. Returns a new array (immutable).
 */
function appendPreviousShortHash(
  existing: string[] | undefined,
  oldShort: string,
): string[] {
  if (!oldShort) return existing ?? [];
  if (existing && existing.length > 0 && existing[existing.length - 1] === oldShort) {
    return existing;
  }
  return existing ? [...existing, oldShort] : [oldShort];
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
 * region(s) backed by this hash. **Pinned** views retain region **content** when
 * the sole backing chunk is removed (`chunkHashes` cleared); unpinned views
 * thin as before. **fullBody** owned by the evicted chunk: pinned keeps body,
 * clears `fullBodyChunkHash`; unpinned clears full body.
 */
export function onConstituentChunkRemoved(
  view: FileView,
  chunkHash: string,
): FileView {
  const nextRegions = dropRegionByChunk(view.filledRegions, chunkHash, {
    retainSoleOwnerContent: view.pinned,
  });

  let fullBody = view.fullBody;
  let fullBodyChunkHash = view.fullBodyChunkHash;
  let fullBodyOrigin = view.fullBodyOrigin;

  if (view.fullBody !== undefined && view.fullBodyChunkHash === chunkHash) {
    if (view.pinned) {
      fullBodyChunkHash = undefined;
    } else {
      fullBody = undefined;
      fullBodyChunkHash = undefined;
      fullBodyOrigin = undefined;
    }
  }

  const regionsChanged = nextRegions !== view.filledRegions;
  const fullBodyChanged =
    fullBody !== view.fullBody
    || fullBodyChunkHash !== view.fullBodyChunkHash
    || fullBodyOrigin !== view.fullBodyOrigin;

  if (!regionsChanged && !fullBodyChanged) return view;

  const nextHashParts = computeFileViewHashParts(view.filePath, view.sourceRevision);
  return {
    ...view,
    filledRegions: nextRegions,
    fullBody,
    fullBodyChunkHash,
    fullBodyOrigin,
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
      fullBodyOrigin: 'coverage_promote',
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
    fullBodyOrigin: 'read',
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
 * per **filePath**, across every revision. The view IS the file at that path;
 * revisions come and go, but the retention ref the model sees does not.
 *
 * Why this is path-derived (not path+revision):
 * - Pinned = always fresh. A pinned view's `h:<short>` stays valid across any
 *   number of edits. `sourceRevision` rolls internally; the short does not.
 * - No transcript thrash. A transcript from round 1 citing `h:bfb7e0` still
 *   resolves to the same view in round 100 — no forwarding chain walk, no
 *   dormant manifest rows from stale shorts, no re-read spiral.
 * - Simpler lookups. `findViewByRef` is a single-pass exact match. No
 *   `previousShortHashes` chain traversal in the hot path.
 *
 * The `revision` parameter is accepted for backward compatibility with
 * existing call sites (and migration logic in {@link migrateLegacyFileView})
 * but deliberately IGNORED in the hash input. The chunk namespace still
 * carries its own revision-derived shorts separately.
 *
 * Collision surface: `SHORT_HASH_LEN=6` (24 bits) with N open views keeps the
 * birthday-bound well under 1% for realistic session sizes. Already tracked
 * via `refCollisions` in contextStore.
 */
export function computeFileViewHash(filePath: string, revision?: string): string {
  return computeFileViewHashParts(filePath, revision).hash;
}

/**
 * Same as {@link computeFileViewHash} but returns both the full ref and the
 * raw short-hash portion, so callers can populate FileView.shortHash without
 * re-slicing.
 *
 * Path-derived: `revision` is ignored (see {@link computeFileViewHash}).
 * Kept in the signature so every legacy call site compiles without edits.
 */
export function computeFileViewHashParts(
  filePath: string,
  revision?: string,
): { hash: string; shortHash: string } {
  void revision;
  const shortHash = hashContentSync(normalizePath(filePath)).slice(0, SHORT_HASH_LEN);
  return { hash: `h:${shortHash}`, shortHash };
}

/**
 * Restore migration: bring a persisted FileView up to the current identity
 * scheme. Handles two eras:
 *
 *   1. **Pre-unify** (`h:fv:<16hex>` prefix, no `shortHash` field) — legacy
 *      snapshots from before `d617604` (the namespace unification).
 *   2. **Revision-scoped** (`(path, revision)`-derived `shortHash`) — the
 *      intermediate period between `d617604` and the switch to path-derived
 *      identity. The old shortHash is revision-scoped; after reload the
 *      view needs the new path-derived short, but any transcript ref the
 *      model still carries uses the old revision-scoped form.
 *
 * In case (2) the legacy shortHash is appended to `previousShortHashes` so
 * transcript refs like `pu h:<oldShort>` continue to resolve to this view
 * via `findViewByRef`'s forwarding-chain fallback. Idempotent: re-running
 * on an already-current view is a no-op.
 */
export function migrateLegacyFileView(view: FileView): FileView {
  const expected = computeFileViewHashParts(view.filePath);
  if (view.hash === expected.hash && view.shortHash === expected.shortHash) return view;
  // Pre-unify snapshots carried `h:fv:<16hex>` with no short — no transcript
  // cite chain to preserve, just rewrite. Revision-scoped snapshots carried
  // a short we want to keep resolvable; push it into previousShortHashes.
  const legacyShort = view.shortHash;
  const isPreUnify = !legacyShort || legacyShort.length === 0;
  const nextPrev = isPreUnify
    ? view.previousShortHashes
    : appendPreviousShortHash(view.previousShortHashes, legacyShort);
  return {
    ...view,
    hash: expected.hash,
    shortHash: expected.shortHash,
    previousShortHashes: nextPrev,
  };
}

/**
 * Does `candidateShort` point at this view — either directly (current
 * `shortHash`) or via the forwarding chain (a previous `shortHash` from
 * before one or more revision bumps)?
 *
 * Matches the same "short ≥ 6 hex, prefix OK in either direction" rule used
 * by `findViewByRef` in contextStore so retention callers behave identically
 * whether they hit the current or a historical ref.
 */
export function matchesViewRef(view: FileView, candidateShort: string): boolean {
  if (!candidateShort) return false;
  if (shortHashMatches(view.shortHash, candidateShort)) return true;
  const previous = view.previousShortHashes;
  if (!previous) return false;
  for (const prev of previous) {
    if (shortHashMatches(prev, candidateShort)) return true;
  }
  return false;
}

function shortHashMatches(viewShort: string, candidate: string): boolean {
  if (!viewShort || !candidate) return false;
  if (viewShort === candidate) return true;
  if (viewShort.startsWith(candidate)) return true;
  if (candidate.startsWith(viewShort)) return true;
  return false;
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
