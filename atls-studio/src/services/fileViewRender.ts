/**
 * Rendering layer for the Unified FileView.
 *
 * Produces the `=== path h:<RET> (N lines) === ... ===` block that replaces
 * flat file-backed chunks in WORKING MEMORY. Pure function — takes a
 * FileView + current round + lookup for filled regions, returns a string.
 *
 * One ref per work object: the fence emits a single retention hash
 * (`h:<view.shortHash>`). Retention ops (`pi`/`pu`/`pc`/`dro`) and edit
 * citations both accept this ref — the runtime's `injectSnapshotHashes`
 * swaps the retention hash for the view's current `sourceRevision` when
 * it lands in a `content_hash` slot. The model never needs to pick a slot.
 */
import type { FileView, FilledRegion } from './fileViewStore';
import { detectRegionGaps } from './fileViewStore';

/** Fence marker for FileView blocks. */
const FENCE_TOP = '===';
const FENCE_BOT = '===';


/** Parse the 1-based line number from the `N|` prefix of a row. */
function parseLineNumber(row: string): number | null {
  const m = /^\s*(\d+)\|/.exec(row);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Interval-overlay: replace skeleton rows whose line number falls inside any
 * filled region with that region's rows. Region rows are sorted by line number.
 */
function overlayRegions(
  skeletonRows: string[],
  regions: FilledRegion[],
): string[] {
  if (regions.length === 0) return skeletonRows.slice();

  // Sort regions by start, defensive.
  const sorted = regions.slice().sort((a, b) => a.start - b.start);

  const rows: string[] = [];
  let ri = 0;
  for (const skelRow of skeletonRows) {
    const line = parseLineNumber(skelRow);
    if (line == null) {
      rows.push(skelRow);
      continue;
    }
    // Advance ri past regions that end before this line.
    while (ri < sorted.length && sorted[ri].end < line) {
      rows.push(...sorted[ri].content.split('\n'));
      ri++;
    }
    // Inside a region? Suppress skeleton rows; region's content is authoritative.
    if (ri < sorted.length && sorted[ri].start <= line && line <= sorted[ri].end) {
      continue;
    }
    rows.push(skelRow);
  }
  // Emit any trailing regions not yet consumed.
  while (ri < sorted.length) {
    rows.push(...sorted[ri].content.split('\n'));
    ri++;
  }
  return rows;
}

/** Emitted when ShapeOp::Sig returns nothing (binary, minified, parse fail). */
const UNPARSEABLE_PLACEHOLDER = '(no sig extracted — read lines to explore)';

/** Max annotations surfaced inline in the FileView header. Overflow is summarized. */
const ANNOTATIONS_VISIBLE_CAP = 3;
/** Per-note char cap to bound overhead on views with long notes. */
const ANNOTATION_CHAR_CAP = 160;

export interface RenderFileViewOptions {
  /** Current round number; drives ephemeral `[edited L..-..L.. this round]` markers. */
  currentRound: number;
  /** When true, emit `[filled h:<short>]` provenance alongside regions (default false). */
  debugProvenance?: boolean;
}

/**
 * Render a FileView block suitable for injection into WORKING MEMORY.
 *
 * Layout:
 *   === path h:<retention short> (N lines) [pinned?] ===
 *   <row>
 *   <row>
 *   ...
 *   <ephemeral markers>
 *   ===
 */
export function renderFileViewBlock(view: FileView, opts: RenderFileViewOptions): string {
  const header = formatHeader(view);
  const annotations = formatAnnotations(view);
  const body = formatBody(view);
  const markers = formatMarkers(view, opts.currentRound);

  const parts: string[] = [header];
  if (annotations) parts.push(annotations);
  if (body) parts.push(body);
  if (markers) parts.push(markers);
  parts.push(FENCE_BOT);
  return parts.join('\n');
}

/**
 * Render view-level annotations (from `annotate.note` on a FileView hash) as
 * compact header lines. No overhead when the view has no annotations.
 */
function formatAnnotations(view: FileView): string {
  const notes = view.annotations;
  if (!notes || notes.length === 0) return '';
  const lines: string[] = [];
  const visible = notes.slice(0, ANNOTATIONS_VISIBLE_CAP);
  for (const note of visible) {
    const text = note.content.replace(/\s+/g, ' ').trim();
    const capped = text.length > ANNOTATION_CHAR_CAP
      ? text.slice(0, ANNOTATION_CHAR_CAP - 1) + '…'
      : text;
    lines.push(`  note: ${capped}`);
  }
  const overflow = notes.length - visible.length;
  if (overflow > 0) {
    lines.push(`  note: +${overflow} more`);
  }
  return lines.join('\n');
}

function formatHeader(view: FileView): string {
  const pinSuffix = view.pinned ? ' [pinned]' : '';
  let promoteSuffix = '';
  if (view.fullBodyOrigin === 'coverage_promote') {
    const gaps = detectRegionGaps(view.filledRegions, view.totalLines);
    promoteSuffix = gaps.length > 0
      ? ` [fullBody: promoted, ${gaps.length} gap${gaps.length === 1 ? '' : 's'} unread]`
      : ' [fullBody: promoted]';
  }
  return `${FENCE_TOP} ${view.filePath} h:${view.shortHash} (${view.totalLines} lines)${pinSuffix}${promoteSuffix} ${FENCE_TOP}`;
}

function formatBody(view: FileView): string {
  if (view.fullBody !== undefined) {
    return view.fullBody;
  }
  const hasSkeleton = view.skeletonRows.length > 0;
  const hasRegions = view.filledRegions.length > 0;
  if (!hasSkeleton && !hasRegions) {
    return UNPARSEABLE_PLACEHOLDER;
  }
  if (!hasSkeleton) {
    // Skeleton empty but we have region content — emit regions directly.
    return view.filledRegions
      .slice()
      .sort((a, b) => a.start - b.start)
      .map(r => r.content)
      .join('\n');
  }
  return overlayRegions(view.skeletonRows, view.filledRegions).join('\n');
}

function formatMarkers(view: FileView, currentRound: number): string {
  const parts: string[] = [];

  // Ephemeral `[edited Lx-y this round]` for regions refetched this round.
  for (const region of view.filledRegions) {
    if (region.origin === 'refetch' && region.refetchedAtRound === currentRound) {
      parts.push(`[edited L${region.start}-${region.end} this round]`);
    }
  }

  // Persistent `[REMOVED was Lx-y]` for rebase-failed regions.
  if (view.removedMarkers && view.removedMarkers.length > 0) {
    for (const mark of view.removedMarkers) {
      parts.push(`[REMOVED was L${mark.start}-${mark.end}]`);
    }
  }

  // Aggregate hint when refetches were capped.
  if (view.pendingRefetches && view.pendingRefetches.length > 0) {
    const n = view.pendingRefetches.length;
    parts.push(`[changed: ${n} region${n === 1 ? '' : 's'} pending refetch — re-read on demand]`);
  }

  return parts.join('\n');
}

/**
 * Bulk render for WORKING MEMORY assembly. Emits blocks only for pinned views
 * (unpinned views roll out of prompt context like any other unpinned engram,
 * per docs/engrams.md lifecycle); sorts by `lastAccessed` descending.
 */
export function renderAllFileViewBlocks(
  views: Iterable<FileView>,
  opts: RenderFileViewOptions,
): string[] {
  const arr: FileView[] = [];
  for (const v of views) {
    // Unpinned views are dormant — state stays warm for cheap re-pin, but
    // nothing renders. Symmetric with unpinned chunk dematerialization.
    if (!v.pinned) continue;
    // Skip views with no content AT ALL (no skeleton, no fills, no fullBody,
    // no markers) — they're indistinguishable from a missing view.
    const hasContent =
      v.skeletonRows.length > 0 ||
      v.filledRegions.length > 0 ||
      v.fullBody !== undefined ||
      (v.removedMarkers?.length ?? 0) > 0 ||
      (v.pendingRefetches?.length ?? 0) > 0;
    if (hasContent) arr.push(v);
  }
  arr.sort((a, b) => b.lastAccessed - a.lastAccessed);
  return arr.map(v => renderFileViewBlock(v, opts));
}

/**
 * Collect every chunk hash referenced by any **pinned** FileView. Used to
 * filter file-backed chunks from the flat ACTIVE ENGRAMS listing so the same
 * bytes don't appear twice in WORKING MEMORY. Unpinned views do not render,
 * so their constituent chunks are allowed to re-surface under normal HPP
 * rules (dematerialize → dormant digest → TTL-archive).
 */
export function collectFileViewChunkHashes(views: Iterable<FileView>): Set<string> {
  const set = new Set<string>();
  for (const v of views) {
    if (!v.pinned) continue;
    for (const region of v.filledRegions) {
      for (const h of region.chunkHashes) set.add(h);
    }
    if (v.fullBodyChunkHash) set.add(v.fullBodyChunkHash);
  }
  return set;
}
