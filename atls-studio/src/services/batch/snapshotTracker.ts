/**
 * SnapshotTracker — per-batch file snapshot hash and awareness tracker.
 *
 * Tracks the canonical `content_hash` for each file read or written during a
 * batch execution. The executor uses this to automatically inject content hashes
 * into change steps, removing the need for callers to manually wire hashes.
 *
 * Supports tiered awareness: CANONICAL (full read), TARGETED (read.lines covering
 * edit region), SHAPED (structural signature only). The executor gate uses
 * awareness levels to allow targeted edits without a full-file re-read when the
 * AI has sufficient coverage of the edit region.
 */

import { validateSourceIdentity } from '../universalFreshness';

export type ReadKind = 'canonical' | 'shaped' | 'cached' | 'lines';

export enum AwarenessLevel {
  NONE = 0,
  SHAPED = 1,
  TARGETED = 2,
  CANONICAL = 3,
}

export interface LineRegion {
  start: number;
  end: number;
}

export interface SnapshotIdentity {
  filePath: string;
  snapshotHash: string;
  /** Hash recorded during a true canonical read. Preserved across non-canonical updates
   *  so edit gates can verify canonical provenance even after snapshotHash advances. */
  canonicalHash?: string;
  readAt: number;
  readKind: ReadKind;
  readRegions?: LineRegion[];
  shapeHash?: string;
  /** Total lines in file (from read_lines / context) — used to treat full-span line reads as mutation authority. */
  fullFileLineCount?: number;
}

export interface RecordOpts {
  readRegion?: LineRegion;
  shapeHash?: string;
  fullFileLineCount?: number;
}

/**
 * Map path strings to a single tracker key. The model often prefixes repo-relative
 * paths with `atls-studio/` while read.lines results use workspace-relative paths
 * without it (e.g. `docs/foo` vs `atls-studio/docs/foo`). Merge those aliases so
 * read coverage and content_hash injection see the same file.
 */
function normalizePathKey(p: string): string {
  let key = p.replace(/\\/g, '/').trim().toLowerCase();
  const mono = 'atls-studio/';
  if (key.startsWith(mono)) key = key.slice(mono.length);
  return key;
}

/**
 * Strip `h:` prefix and any modifier suffixes to get bare canonical hash.
 * Mirrors Rust `snapshot::canonicalize_hash`.
 */
export function canonicalizeSnapshotHash(value: string): string {
  const stripped = value.startsWith('h:') ? value.slice(2) : value;
  const colonIdx = stripped.indexOf(':');
  return colonIdx >= 0 ? stripped.slice(0, colonIdx) : stripped;
}

/** Merge overlapping or adjacent 1-based inclusive line regions. */
export function mergeRanges(ranges: LineRegion[]): LineRegion[] {
  if (ranges.length <= 1) return ranges.slice();
  const sorted = ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: LineRegion[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = merged[merged.length - 1];
    if (cur.start <= last.end + 1) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Check if a set of merged regions fully covers a target region. */
function regionsCover(regions: LineRegion[], target: LineRegion): boolean {
  for (const r of regions) {
    if (r.start <= target.start && r.end >= target.end) return true;
  }
  return false;
}

export class SnapshotTracker {
  private snapshots = new Map<string, SnapshotIdentity>();

  /** Record a snapshot hash for a file (from a read or write result). */
  record(filePath: string, snapshotHash: string, readKind: ReadKind = 'canonical', opts?: RecordOpts): void {
    if (!validateSourceIdentity(filePath)) return;
    const key = normalizePathKey(filePath);
    const bare = canonicalizeSnapshotHash(snapshotHash);
    const existing = this.snapshots.get(key);

    if (existing && existing.readKind === 'canonical' && readKind !== 'canonical') {
      // Don't downgrade readKind. Shaped reads carry a derived hash — keep canonical snapshotHash for CE gates.
      if (readKind !== 'shaped') {
        existing.snapshotHash = bare;
      } else {
        existing.shapeHash = opts?.shapeHash ?? bare;
      }
      existing.readAt = Date.now();
      if (opts?.readRegion) {
        const regions = existing.readRegions ? [...existing.readRegions, opts.readRegion] : [opts.readRegion];
        existing.readRegions = mergeRanges(regions);
      }
      if (opts?.fullFileLineCount != null) {
        existing.fullFileLineCount = opts.fullFileLineCount;
      }
      return;
    }

    const identity: SnapshotIdentity = {
      filePath,
      snapshotHash: bare,
      readAt: Date.now(),
      readKind,
    };

    if (readKind === 'canonical') {
      identity.canonicalHash = bare;
    } else if (existing?.canonicalHash) {
      identity.canonicalHash = existing.canonicalHash;
    }

    if (existing) {
      identity.readRegions = existing.readRegions ? [...existing.readRegions] : undefined;
      identity.shapeHash = existing.shapeHash;
      identity.fullFileLineCount = existing.fullFileLineCount;
    }

    if (opts?.readRegion) {
      const regions = identity.readRegions ? [...identity.readRegions, opts.readRegion] : [opts.readRegion];
      identity.readRegions = mergeRanges(regions);
    }
    if (opts?.shapeHash) {
      identity.shapeHash = opts.shapeHash;
    }
    if (opts?.fullFileLineCount != null) {
      identity.fullFileLineCount = opts.fullFileLineCount;
    }

    this.snapshots.set(key, identity);
  }

  /** Get the canonical snapshot hash for a file, if tracked. */
  getHash(filePath: string): string | undefined {
    return this.snapshots.get(normalizePathKey(filePath))?.snapshotHash;
  }

  /** Get the full identity for a file, if tracked. */
  getIdentity(filePath: string): SnapshotIdentity | undefined {
    return this.snapshots.get(normalizePathKey(filePath));
  }

  /**
   * First file path whose tracked snapshot hash matches (e.g. resolve content_hash to path).
   * If multiple files share a hash, the first map insertion order wins.
   */
  findFilePathForSnapshotHash(hashOrRef: string): string | undefined {
    const bare = canonicalizeSnapshotHash(hashOrRef);
    for (const [, v] of this.snapshots) {
      if (v.snapshotHash === bare) return v.filePath;
    }
    return undefined;
  }

  /** Check if a hash is stale (differs from the tracked snapshot). */
  isStale(filePath: string, hash: string): boolean {
    const tracked = this.getHash(filePath);
    if (!tracked) return false;
    return canonicalizeSnapshotHash(hash) !== tracked;
  }

  /** Get tracked hashes for a set of files. */
  getAllForFiles(paths: string[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const p of paths) {
      const h = this.getHash(p);
      if (h) result.set(p, h);
    }
    return result;
  }

  /** Invalidate a tracked file (e.g. after external change detected). */
  invalidate(filePath: string): void {
    this.snapshots.delete(normalizePathKey(filePath));
  }

  /**
   * Invalidate a file's old hash and record a new one as canonical.
   * Used after a mutation step to ensure subsequent steps see the
   * post-mutation hash and pass the canonical read gate.
   * Clears readRegions and shapeHash since the file content changed.
   */
  invalidateAndRerecord(filePath: string, newHash: string): void {
    const key = normalizePathKey(filePath);
    const bare = canonicalizeSnapshotHash(newHash);
    this.snapshots.delete(key);
    this.snapshots.set(key, {
      filePath,
      snapshotHash: bare,
      canonicalHash: bare,
      readAt: Date.now(),
      readKind: 'canonical',
    });
  }

  /** Clear all tracked snapshots. */
  clear(): void {
    this.snapshots.clear();
  }

  /** Number of tracked files. */
  get size(): number {
    return this.snapshots.size;
  }

  /** Compute the awareness level for a file, optionally scoped to an edit region. */
  getAwarenessLevel(filePath: string, editRegion?: LineRegion): AwarenessLevel {
    const identity = this.snapshots.get(normalizePathKey(filePath));
    if (!identity) return AwarenessLevel.NONE;
    if (identity.canonicalHash != null) return AwarenessLevel.CANONICAL;
    // Promote full-span lines reads to CANONICAL (mirrors hasCanonicalRead)
    if (identity.readKind === 'lines') {
      const n = identity.fullFileLineCount;
      if (n != null && n >= 1 && identity.readRegions?.length
          && regionsCover(identity.readRegions, { start: 1, end: n })) {
        return AwarenessLevel.CANONICAL;
      }
    }
    if (editRegion && identity.readRegions && identity.readRegions.length > 0) {
      if (regionsCover(identity.readRegions, editRegion)) return AwarenessLevel.TARGETED;
    }
    if (identity.readKind === 'shaped' || identity.readKind === 'lines' || identity.readKind === 'cached') {
      return AwarenessLevel.SHAPED;
    }
    return AwarenessLevel.NONE;
  }

  /** Check if the given line range is fully covered by recorded readRegions. */
  hasReadCoverage(filePath: string, start: number, end: number): boolean {
    const identity = this.snapshots.get(normalizePathKey(filePath));
    if (!identity?.readRegions || identity.readRegions.length === 0) return false;
    return regionsCover(identity.readRegions, { start, end });
  }

  /** Compare stored shape hash to a new one for structural change detection. */
  isStructurallyUnchanged(filePath: string, newShapeHash: string): boolean {
    const identity = this.snapshots.get(normalizePathKey(filePath));
    if (!identity?.shapeHash) return false;
    return identity.shapeHash === newShapeHash;
  }

  /**
   * Gate for mutation: true when a verified canonical hash exists (from a true
   * canonical read or full-span line read). Uses the dedicated canonicalHash
   * field so that non-canonical hash updates don't satisfy the gate.
   */
  hasCanonicalRead(filePath: string): boolean {
    const identity = this.snapshots.get(normalizePathKey(filePath));
    if (!identity) return false;
    if (identity.canonicalHash != null) return true;
    if (identity.readKind !== 'lines') return false;
    const n = identity.fullFileLineCount;
    if (n == null || n < 1 || !identity.readRegions?.length) return false;
    return regionsCover(identity.readRegions, { start: 1, end: n });
  }

  /**
   * Require canonical reads for all target files. Returns list of files
   * that lack a canonical read in this batch.
   */
  requireCanonicalReads(filePaths: string[]): string[] {
    return filePaths.filter(fp => !this.hasCanonicalRead(fp));
  }

  /** Iterate all tracked snapshot identities. */
  entries(): IterableIterator<[string, SnapshotIdentity]> {
    return this.snapshots.entries();
  }

  /**
   * Extract content_hash from a backend response. Supports `hash` and `h` aliases.
   */
  static extractHash(response: Record<string, unknown>): string | undefined {
    const sh = response.content_hash ?? response.hash ?? response.h;
    return typeof sh === 'string' ? sh : undefined;
  }

  /**
   * Extract file path from a backend response. Supports `f` alias from batch/drafts.
   */
  static extractFilePath(response: Record<string, unknown>): string | undefined {
    const fp = response.file ?? response.file_path ?? response.path ?? response.f;
    return typeof fp === 'string' ? fp : undefined;
  }

  /**
   * Record all file snapshots from a backend response. Handles:
   * - `results` array (read.context, read.lines)
   * - `drafts` / `batch` arrays (change.edit output)
   * - Single top-level file + hash entry
   *
   * Uses stage-then-commit: all entries are validated first, then applied
   * atomically so partial extraction failures don't leave inconsistent state.
   */
  recordFromResponse(response: Record<string, unknown>, readKind: ReadKind = 'canonical'): void {
    const staged: Array<{ fp: string; sh: string; opts?: RecordOpts }> = [];

    const arr = response.results ?? response.drafts ?? response.batch;
    if (Array.isArray(arr)) {
      for (const entry of arr) {
        if (entry && typeof entry === 'object') {
          const rec = entry as Record<string, unknown>;
          const fp = SnapshotTracker.extractFilePath(rec);
          const sh = SnapshotTracker.extractHash(rec);
          if (!fp || !sh) continue;
          const lineCount = typeof rec.lines === 'number' ? rec.lines : undefined;
          const opts = lineCount != null ? { fullFileLineCount: lineCount } : undefined;
          staged.push({ fp, sh, opts });
        }
      }
    } else {
      const fp = SnapshotTracker.extractFilePath(response);
      const sh = SnapshotTracker.extractHash(response);
      if (fp && sh) {
        const lineCount = typeof response.lines === 'number' ? response.lines : undefined;
        const opts = lineCount != null ? { fullFileLineCount: lineCount } : undefined;
        staged.push({ fp, sh, opts });
      }
    }

    for (const { fp, sh, opts } of staged) {
      this.record(fp, sh, readKind, opts);
    }
  }
}
