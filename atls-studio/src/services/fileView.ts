/**
 * FileView — the new state engine for file context.
 *
 * This module owns the skeleton primitive: given a (path, sourceRevision), produce
 * an ordered list of `N|CONTENT` rows composed of
 *   - ShapeOp::Imports output (stitched at the top)
 *   - ShapeOp::Sig output (folded symbol signatures with slice-native `[start-end]` markers)
 *
 * When sig exceeds a token budget, falls back to `ShapeOp::Fold` (depth>=2 hidden)
 * which preserves the same row format so downstream overlay logic is identical.
 *
 * See docs/ — plan: Unified FileView.
 */
import { invoke } from '@tauri-apps/api/core';
import { countTokensSync } from '../utils/tokenCounter';

export interface SymbolAnchor {
  /** 1-based start line of the symbol's signature row */
  line: number;
  /** 1-based inclusive end of the folded body, when present */
  endLine?: number;
  /** The full `N|CONTENT` row as emitted by the shape op */
  raw: string;
  /** Whether this row carries a `{ ... } [A-B]` fold marker */
  folded: boolean;
}

export interface FileSkeleton {
  /** Normalized forward-slash, lowercased path — matches awarenessCache keying */
  path: string;
  /** File content_hash at which this skeleton was composed */
  revision: string;
  /** Total source lines, as reported by the backend for the revision */
  totalLines: number;
  /** Skeleton rows, monotonic by 1-based line number, imports + sig stitched */
  rows: string[];
  /** BPE (or heuristic) token count of rows.join('\n') */
  tokens: number;
  /** Which shape op produced the symbol-body portion */
  sigLevel: 'sig' | 'fold';
}

/**
 * Token budget above which the skeleton falls back from `:sig` to `:fold`.
 * `:fold` hides depth>=2 blocks but preserves the `N|CONTENT` row shape, so
 * the downstream line-overlay fill algorithm is identical.
 */
export const SKELETON_TOKEN_BUDGET_DEFAULT = 1500;

const SKELETON_CACHE_MAX = 100;

interface CacheEntry {
  revision: string;
  skeleton: FileSkeleton;
}

const _cache = new Map<string, CacheEntry>();

/** Test/reset hook. */
export function clearSkeletonCache(): void {
  _cache.clear();
}

/** Cheap introspection for tests and telemetry. */
export function skeletonCacheSize(): number {
  return _cache.size;
}

/** Minimal shape of the resolve_hash_ref response we consume. */
export interface ResolvedShape {
  content: string;
  total_lines?: number | null;
}

export type SkeletonInvoker = (rawRef: string) => Promise<ResolvedShape>;

export interface GetFileSkeletonOptions {
  /** Override the token budget for fold-fallback */
  budget?: number;
  /** Dependency-injectable invoker — defaults to tauri resolve_hash_ref */
  invoker?: SkeletonInvoker;
}

/**
 * Compose a skeleton for (path, revision). Cached by path; invalidated when
 * `revision` differs from the cached entry's revision.
 *
 * Does not mutate any store — pure primitive. Consumers upstack into FileView.
 */
export async function getFileSkeleton(
  path: string,
  revision: string,
  opts?: GetFileSkeletonOptions,
): Promise<FileSkeleton> {
  const key = normalizePath(path);
  const cached = _cache.get(key);
  if (cached && cached.revision === revision) {
    return cached.skeleton;
  }

  const budget = opts?.budget ?? SKELETON_TOKEN_BUDGET_DEFAULT;
  const invoker = opts?.invoker ?? defaultInvoker;
  const bareHash = stripHashPrefix(revision);

  // Body portion: sig first, fall back to fold when over budget.
  const sigRes = await invoker(`h:${bareHash}:sig`);
  const sigRows = parseRows(sigRes.content);
  const sigTokens = countTokensSync(sigRes.content);

  let bodyRows = sigRows;
  let sigLevel: 'sig' | 'fold' = 'sig';
  let bodyTotalLines = sigRes.total_lines ?? undefined;

  if (sigTokens > budget) {
    const foldRes = await invoker(`h:${bareHash}:fold`);
    bodyRows = parseRows(foldRes.content);
    sigLevel = 'fold';
    if (foldRes.total_lines != null) bodyTotalLines = foldRes.total_lines;
  }

  // Imports portion: stitched at the head. Best-effort; failure is a no-op.
  let importRows: string[] = [];
  try {
    const impRes = await invoker(`h:${bareHash}:imports`);
    importRows = parseRows(impRes.content);
    if (impRes.total_lines != null && bodyTotalLines == null) {
      bodyTotalLines = impRes.total_lines;
    }
  } catch {
    // ShapeOp::Imports unsupported for this file; skip silently.
  }

  const rows = mergeSkeletonRows(importRows, bodyRows);
  const composed = rows.join('\n');
  const tokens = rows.length > 0 ? countTokensSync(composed) : 0;

  const totalLines = bodyTotalLines ?? maxLineNumber(rows);

  const skeleton: FileSkeleton = {
    path: key,
    revision,
    totalLines,
    rows,
    tokens,
    sigLevel,
  };

  // LRU-lite cap: evict the oldest on overflow. Map preserves insertion order.
  if (_cache.size >= SKELETON_CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { revision, skeleton });
  return skeleton;
}

/**
 * Parse an `N|CONTENT` row stream. Rows that do not match the prefix pattern
 * are filtered out (e.g. fallback head-of-file when no signatures were extracted).
 */
export function parseRows(text: string): string[] {
  if (!text) return [];
  return text.split('\n').filter(row => LINE_PREFIX_RE.test(row));
}

/**
 * Merge imports and body rows into one monotonic stream.
 *
 * - Sorted ascending by 1-based line number.
 * - On line-number collision, the imports row wins (more specific).
 *   This matters when ShapeOp::Fold's depth<=1 output overlaps with the imports
 *   range near the top of a file.
 */
export function mergeSkeletonRows(imports: string[], body: string[]): string[] {
  const byLine = new Map<number, string>();
  for (const row of body) {
    const n = parseLineNumber(row);
    if (n != null) byLine.set(n, row);
  }
  for (const row of imports) {
    const n = parseLineNumber(row);
    if (n != null) byLine.set(n, row);
  }
  return Array.from(byLine.keys())
    .sort((a, b) => a - b)
    .map(n => byLine.get(n)!);
}

/** Extract the 1-based line number from an `N|CONTENT` row. Returns null if malformed. */
export function parseLineNumber(row: string): number | null {
  const m = LINE_PREFIX_RE.exec(row);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the slice-native fold marker `[start-end]` at the end of a row.
 * Returns null if the row is not folded.
 */
export function parseFoldMarker(row: string): { start: number; end: number } | null {
  const m = FOLD_MARKER_RE.exec(row);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/** Parse a `N|CONTENT` row into a SymbolAnchor. */
export function parseAnchor(row: string): SymbolAnchor | null {
  const line = parseLineNumber(row);
  if (line == null) return null;
  const marker = parseFoldMarker(row);
  return {
    line,
    endLine: marker ? marker.end : undefined,
    raw: row,
    folded: marker != null,
  };
}

/** Normalize a path for FileView keying: forward-slash + lowercased. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function stripHashPrefix(hash: string): string {
  return hash.replace(/^h:/, '');
}

function maxLineNumber(rows: string[]): number {
  let max = 0;
  for (const row of rows) {
    const n = parseLineNumber(row);
    if (n != null && n > max) max = n;
  }
  return max;
}

async function defaultInvoker(rawRef: string): Promise<ResolvedShape> {
  return await invoke<ResolvedShape>('resolve_hash_ref', { rawRef });
}

// Matches the `  17|` prefix used by both extract_signatures and read.lines.
// Tolerates any amount of leading whitespace for line-number right-alignment.
const LINE_PREFIX_RE = /^\s*(\d+)\|/;

// Slice-native fold marker `[A-B]` at end of row.
const FOLD_MARKER_RE = /\[(\d+)-(\d+)\]\s*$/;
