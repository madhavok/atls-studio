/**
 * Context read/load/shape handlers — read, read_lines, read_shaped, load, shape, emit.
 */

import type { OpHandler, StepOutput, ExpandedFilePath, HandlerContext } from '../types';
import { getFreshnessHintForRefs } from '../../freshnessPreflight';
import { hashContentSync, SHORT_HASH_LEN, sliceContentByLines, type DigestSymbol } from '../../../utils/contextHash';
import { countTokensSync } from '../../../utils/tokenCounter';
import { invoke } from '@tauri-apps/api/core';
import { invokeWithTimeout } from '../../toolHelpers';
import { parseHashRef } from '../../../utils/hashRefParsers';
import { parseLineRanges } from '../../../utils/hashModifierParser';
import { resolveRecencyInString } from '../../../utils/hashResolver';
import { useRetentionStore } from '../../../stores/retentionStore';
import { formatResult } from '../../../utils/toon';

interface ResolvedHashContent {
  content: string;
  source: string | null;
  content_hash?: string;
  /** @deprecated Rust no longer emits this; prefer content_hash */
  snapshot_hash?: string;
  selector?: string | null;
  target_range?: Array<[number, number | null]>;
  actual_range?: Array<[number, number | null]>;
  context_lines?: number;
}

interface BackendContextEntry {
  file?: string;
  path?: string;
  content?: string;
  context?: unknown;
  text?: string;
  content_hash?: string;
  h?: string;
  previous?: Record<string, unknown>;
  symbols?: DigestSymbol[];
}

/** File/hash reads — aligned with session pin staging; large repos need headroom. */
const READ_TIMEOUT_MS = 15_000;

/** Max paths per backend `context` full query to avoid timeouts on large trees (e.g. intent.survey). */
const READ_SHAPED_CONTEXT_CHUNK = 400;

/** Reject values that are clearly content, not file paths or refs. */
function validatePathParam(value: unknown, paramName: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return `${paramName} must be a string, got ${typeof value}`;
  if (value.length > 1024) return `${paramName} too long (${value.length} chars) — looks like content, not a path`;
  if (value.includes('\n')) return `${paramName} contains newlines — looks like content, not a path`;
  return null;
}

/** Single `h:TOKEN` ref — backend read_lines often returns `h` already prefixed; do not double-wrap. */
function normalizeHashRefToken(h: string): string {
  let s = h.trim();
  while (s.startsWith('h:h:')) s = s.slice(2);
  if (!s) return h;
  return s.startsWith('h:') ? s : `h:${s}`;
}

function ok(summary: string, refs: string[] = [], tokens?: number, content?: unknown): StepOutput {
  return { kind: 'file_refs', ok: true, refs, summary, tokens, content };
}

function err(summary: string): StepOutput {
  return { kind: 'file_refs', ok: false, refs: [], summary, error: summary };
}

function extractSymbolsFromContextResult(result: unknown): DigestSymbol[] | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  const items = Array.isArray(r.results) ? r.results : [];
  const syms: DigestSymbol[] = [];
  for (const item of items) {
    const symbols = (item as Record<string, unknown>)?.symbols;
    if (Array.isArray(symbols)) syms.push(...(symbols as DigestSymbol[]));
  }
  return syms.length > 0 ? syms : undefined;
}

function formatLineRanges(ranges: Array<[number, number | null]> | undefined): string {
  if (!Array.isArray(ranges) || ranges.length === 0) return '';
  return ranges
    .map(([start, end]) => (end == null || end === start ? `${start}` : `${start}-${end}`))
    .join(',');
}

/** Engram types whose body is not a single on-disk file; `source` is often a query/symbol, not `file_path`. */
const READ_LINES_ENGRAM_TYPES = new Set([
  'search',
  'symbol',
  'deps',
  'issues',
  'analysis',
  'blackboard',
]);

function engramLineRanges(
  linesSpec: string,
  totalLines: number,
  contextLines: number,
): { target: Array<[number, number | null]>; actual: Array<[number, number | null]> } | null {
  const parsed = parseLineRanges(linesSpec.trim());
  if (!parsed?.length) return null;
  const buffered = Math.max(0, Math.min(5, Math.trunc(contextLines)));
  const actual: Array<[number, number | null]> = [];
  for (const [start, end] of parsed) {
    const actualStart = Math.max(1, start - buffered);
    const endCap = end ?? totalLines;
    const actualEnd = Math.min(endCap + buffered, totalLines);
    actual.push([actualStart, actualEnd]);
  }
  return { target: parsed, actual };
}

function extractContentHash(payload: Record<string, unknown>): string | undefined {
  const h = payload.content_hash ?? payload.hash;
  return typeof h === 'string' ? h : undefined;
}

function extractFilePath(payload: Record<string, unknown>): string | undefined {
  const filePath = payload.file ?? payload.path;
  return typeof filePath === 'string' ? filePath : undefined;
}

/** Standard (non-shaped) context query results → one WM chunk per file; shared by read.context and multi-path read.file. */
function ingestStandardContextItems(
  ctx: HandlerContext,
  items: Array<Record<string, unknown>>,
  opts: {
    loadType: string;
    readShape?: string;
    readBind?: string[];
    isTreeRead: boolean;
    filePaths: string[];
    opLabel: 'read' | 'load';
  },
  io: {
    lines: string[];
    allRefs: string[];
    readResults: Array<Record<string, unknown>>;
    totalTokensDelta: number;
    treePathsAccum: string[];
    treeTextsAccum: string[];
    treePathsTruncated: boolean;
  },
): void {
  const { loadType, readShape, readBind, isTreeRead, filePaths, opLabel } = opts;
  const isFull = loadType === 'raw' || loadType === 'full';
  const chunkType = isFull ? 'raw' : 'smart';
  const bindIds = readBind?.length ? readBind : undefined;
  const p = `${opLabel}:`;

  for (const item of items) {
    const r = item as Record<string, unknown>;
    if (r.error) {
      const errFile = String(r.file || '?');
      const errMsg = String(r.error);
      if (isTreeRead && (errMsg.includes('not found') || errMsg.includes('not a directory'))) {
        io.lines.push(`${p} ${errFile} → ERROR ${errMsg} — tree reads expect a directory path (e.g. "src/"), not an individual file. Use type:"smart" to read files.`);
      } else {
        io.lines.push(`${p} ${errFile} → ERROR ${errMsg}`);
      }
      continue;
    }
    let raw: unknown = r.content ?? r.context ?? r.text;
    if (isTreeRead && typeof r.tree === 'string') {
      raw = r.tree;
    }
    const content = (typeof raw === 'string') ? raw : formatResult(raw ?? item);
    const src = isTreeRead
      ? String(r.root ?? r.file ?? r.path ?? filePaths[0] ?? '')
      : String(r.file ?? r.path ?? filePaths[0] ?? '');
    const backendHash = extractContentHash(r);
    if (backendHash && src) {
      const reusedRead = ctx.store().findReusableRead({ filePath: src, sourceRevision: backendHash, shape: readShape, contextType: loadType });
      if (reusedRead) {
        useRetentionStore.getState().incrementReadsReused();
        io.allRefs.push(`h:${reusedRead}`);
        io.readResults.push({ file: src, h: `h:${reusedRead}`, ...(backendHash ? { content_hash: backendHash } : {}) });
        io.lines.push(`${p} ERROR redundant — ${src} already at h:${reusedRead} (same rev). Content is live. Use read.lines(ref:"h:${reusedRead}:LL-LL") for a different span, or change.edit file_path:"h:${reusedRead}:source". Do NOT re-read.`);
        continue;
      }
    }

    const hash = ctx.store().addChunk(
      content,
      chunkType,
      src,
      (item as Record<string, unknown>).symbols as DigestSymbol[] | undefined,
      undefined,
      backendHash,
      {
        ...(bindIds ? { subtaskIds: bindIds } : {}),
        ...(backendHash ? { sourceRevision: backendHash } : {}),
        viewKind: 'latest',
        ...(backendHash && src ? { readSpan: { filePath: src, sourceRevision: backendHash, shape: readShape, contextType: loadType } } : {}),
      },
    );
    const tk = countTokensSync(content);
    io.totalTokensDelta += tk;
    io.allRefs.push(`h:${hash}`);
    io.readResults.push({
      file: src,
      h: `h:${hash}`,
      ...(backendHash ? { content_hash: backendHash } : {}),
      ...(isTreeRead && r.root != null ? { root: r.root } : {}),
    });
    if (isTreeRead) {
      if (typeof r.tree === 'string') io.treeTextsAccum.push(r.tree);
      if (Array.isArray(r.file_paths)) {
        for (const fp of r.file_paths as string[]) io.treePathsAccum.push(fp);
      }
      if (r.file_paths_truncated === true) io.treePathsTruncated = true;
    }
    ctx.store().clearSuspect(src);
    if (backendHash) ctx.store().reconcileSourceRevision(src, backendHash);
    ctx.store().recordMemoryEvent({ action: 'read', reason: 'context', source: src, newRevision: backendHash, refs: [`h:${hash}`] });
    const prevInfo = r.previous as Record<string, unknown> | undefined;
    const prevSuffix = prevInfo ? ` previous:${prevInfo.hash} edits:${prevInfo.edits}` : '';
    io.lines.push(`${p} ${src} → h:${hash} (${tk}tk)${prevSuffix}`);
  }
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

export const handleLoad: OpHandler = async (params, ctx) => {
  const filePaths = (params.file_paths as string[] | undefined) ?? [];
  const loadType = (params.type as string) || 'smart';
  if (!filePaths.length) return err('load: ERROR missing file_paths param');
  for (const fp of filePaths) {
    const pathErr = validatePathParam(fp, 'load: file_path');
    if (pathErr) return err(pathErr);
  }

  const lines: string[] = [];
  const isFull = loadType === 'raw' || loadType === 'full';
  if (isFull) {
    lines.push('load: NOTE type:"smart" is 70% smaller and sufficient for most tasks — use full when you need canonical mutation authority');
  }

  try {
    const backendType = loadType === 'raw' ? 'full' : loadType;
    const result = await ctx.atlsBatchQuery('context', { type: backendType, file_paths: filePaths });
    const resultStr = typeof result === 'string' ? result : formatResult(result);
    const symbols = extractSymbolsFromContextResult(result);
    const resultObj = result as Record<string, unknown> | undefined;
    const items = Array.isArray(resultObj?.results) ? resultObj!.results as Array<Record<string, unknown>> : [];
    const backendHash = items.length === 1 && typeof items[0]?.content_hash === 'string'
      ? items[0].content_hash as string : undefined;

    if (filePaths.length === 1 && backendHash) {
      const reused = ctx.store().findReusableRead({ filePath: filePaths[0], sourceRevision: backendHash, contextType: loadType });
      if (reused) {
        useRetentionStore.getState().incrementReadsReused();
        lines.push(`load: ERROR redundant — ${filePaths[0]} already at h:${reused} (same rev). Content is live at that hash. Do NOT re-read. Use h:${reused} in file_path params directly, or change.edit file_path:"h:${reused}:source".`);
        return { kind: 'file_refs', ok: false, refs: [`h:${reused}`], summary: lines.join('\n'), tokens: 0 };
      }
    }

    if (filePaths.length > 1) {
      const io = {
        lines,
        allRefs: [] as string[],
        readResults: [] as Array<Record<string, unknown>>,
        totalTokensDelta: 0,
        treePathsAccum: [] as string[],
        treeTextsAccum: [] as string[],
        treePathsTruncated: false,
      };
      ingestStandardContextItems(ctx, items, {
        loadType,
        isTreeRead: false,
        filePaths,
        opLabel: 'load',
      }, io);
      const store = ctx.store();
      const freshnessHint = getFreshnessHintForRefs(store, io.allRefs);
      const summary = lines.join('\n');
      return {
        kind: 'file_refs',
        ok: true,
        refs: io.allRefs,
        summary: freshnessHint ? `${summary}\n${freshnessHint}` : summary,
        tokens: io.totalTokensDelta,
        content: { results: io.readResults },
        ...(freshnessHint ? { _hash_warnings: [freshnessHint] } : {}),
      };
    }

    const hash = ctx.store().addChunk(resultStr, isFull ? 'raw' : 'smart', filePaths.join(', '), symbols, undefined, backendHash, {
      ...(backendHash && filePaths.length === 1 ? { readSpan: { filePath: filePaths[0], sourceRevision: backendHash, contextType: loadType } } : {}),
    });
    const tokens = countTokensSync(resultStr);
    lines.push(`load: ${filePaths.join(', ')} → h:${hash} (${(tokens / 1000).toFixed(1)}k tk)`);
    return { kind: 'file_refs', ok: true, refs: [`h:${hash}`], summary: lines.join('\n'), tokens };
  } catch (loadErr) {
    return err(`load: ERROR ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`);
  }
};

// ---------------------------------------------------------------------------
// read (standard + shaped paths)
// ---------------------------------------------------------------------------

export const handleRead: OpHandler = async (params, ctx) => {
  const rawFilePaths = (params.file_paths as string[] | undefined) ?? [];
  const loadType = (params.type as string) || 'smart';
  const wantHistory = params.history === true;
  const readShape = params.shape as string | undefined;
  const readBind = params.bind as string[] | undefined;
  if (!rawFilePaths.length) return err('read: ERROR missing file_paths param');
  for (const fp of rawFilePaths) {
    const pathErr = validatePathParam(fp, 'read: file_path');
    if (pathErr) return err(pathErr);
  }

  const lines: string[] = [];
  const allRefs: string[] = [];
  const readResults: Array<Record<string, unknown>> = [];
  let totalTokensDelta = 0;
  const isTreeRead = loadType === 'tree';
  const treePathsAccum: string[] = [];
  const treeTextsAccum: string[] = [];
  let treePathsTruncated = false;
  const isFull = loadType === 'raw' || loadType === 'full';
  if (isFull && !readShape) {
    lines.push('read: NOTE type:"smart" is 70% smaller and sufficient for most tasks — use full when you need canonical mutation authority');
  }
  if (isTreeRead) {
    const fileExtRe = /\.\w{1,10}$/;
    const suspiciousFiles = rawFilePaths.filter(p => fileExtRe.test(p));
    if (suspiciousFiles.length > 0) {
      lines.push(`read: NOTE type:"tree" is designed for directories. ${suspiciousFiles.join(', ')} look like file paths — use type:"smart" to read individual files, or provide directory paths for tree.`);
    }
  }

  const { items: expandedItems, notes: expandNotes } = await ctx.expandFilePathRefs(rawFilePaths);
  for (const note of expandNotes) lines.push(`read: ${note}`);
  const filePaths = expandedItems.filter((it): it is ExpandedFilePath & { kind: 'path' } => it.kind === 'path').map(it => it.path);
  const temporalItems = expandedItems.filter((it): it is ExpandedFilePath & { kind: 'content' } => it.kind === 'content');

  try {
    if (readShape) {
      const backendFullByPath = new Map<string, BackendContextEntry>();
      if (filePaths.length > 0) {
        const fullResult = await ctx.atlsBatchQuery('context', { type: 'full', file_paths: filePaths }) as Record<string, unknown>;
        const items = Array.isArray(fullResult.results) ? fullResult.results : [];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const entry = item as BackendContextEntry;
          const source = extractFilePath(entry as unknown as Record<string, unknown>);
          if (source) backendFullByPath.set(source, entry);
        }
      }
      for (const fp of filePaths) {
        const fullEntry = backendFullByPath.get(fp);
        const result = await _processShapedFile(
          ctx,
          fp,
          typeof fullEntry?.content === 'string' ? fullEntry.content : null,
          extractContentHash((fullEntry ?? {}) as Record<string, unknown>),
          readShape,
          readBind,
          lines,
        );
        if (result) {
          allRefs.push(...result.refs);
          totalTokensDelta += result.tokens;
          if (result.artifact) readResults.push(result.artifact);
        }
      }
      for (const ti of temporalItems) {
        const result = await _processShapedFile(ctx, ti.source, ti.content, undefined, readShape, readBind, lines);
        if (result) {
          allRefs.push(...result.refs);
          totalTokensDelta += result.tokens;
          if (result.artifact) readResults.push(result.artifact);
        }
      }
    } else {
      // Standard path: full content into working memory
      for (const ti of temporalItems) {
        const sourceRevision = hashContentSync(ti.content);
        const hash = ctx.store().addChunk(ti.content, 'smart', ti.source, undefined, undefined, sourceRevision, { sourceRevision, viewKind: 'latest' });
        const tk = countTokensSync(ti.content);
        totalTokensDelta += tk;
        allRefs.push(`h:${hash}`);
        readResults.push({
          file: ti.source,
          h: `h:${hash}`,
          content_hash: sourceRevision,
        });
        ctx.store().clearSuspect(ti.source);
        ctx.store().reconcileSourceRevision(ti.source, sourceRevision);
        ctx.store().recordMemoryEvent({ action: 'read', reason: 'context_temporal', source: ti.source, newRevision: sourceRevision, refs: [`h:${hash}`] });
        lines.push(`read: ${ti.source} → h:${hash} (${tk}tk)`);
      }
      if (filePaths.length > 0) {
        const backendType = loadType === 'raw' ? 'full' : loadType;
        const contextParams: Record<string, unknown> = { type: backendType, file_paths: filePaths };
        if (wantHistory) contextParams.history = true;
        const result = await ctx.atlsBatchQuery('context', contextParams) as Record<string, unknown>;
        const items = (result as Record<string, unknown>)?.results;
        if (Array.isArray(items)) {
          const io = {
            lines,
            allRefs,
            readResults,
            totalTokensDelta, // carry temporal-item token sum into per-file ingest
            treePathsAccum,
            treeTextsAccum,
            treePathsTruncated,
          };
          ingestStandardContextItems(ctx, items as Array<Record<string, unknown>>, {
            loadType,
            readShape,
            readBind,
            isTreeRead,
            filePaths,
            opLabel: 'read',
          }, io);
          totalTokensDelta = io.totalTokensDelta;
          treePathsTruncated = io.treePathsTruncated;
        } else {
          lines.push('read: no results');
        }
      }
    }
  } catch (readErr) {
    return err(`read: ERROR ${readErr instanceof Error ? readErr.message : String(readErr)}`);
  }

  const store = ctx.store();
  const freshnessHint = getFreshnessHintForRefs(store, allRefs);
  const summary = lines.join('\n');
  const contentOut: Record<string, unknown> = { results: readResults };
  if (isTreeRead) {
    contentOut.file_paths = [...new Set(treePathsAccum)];
    contentOut.tree = treeTextsAccum.join('\n\n');
    if (treePathsTruncated) contentOut.file_paths_truncated = true;
  }
  return {
    kind: 'file_refs', ok: true, refs: allRefs, summary: freshnessHint ? `${summary}\n${freshnessHint}` : summary,
    tokens: totalTokensDelta,
    content: contentOut,
    ...(freshnessHint ? { _hash_warnings: [freshnessHint] } : {}),
  };
};

// ---------------------------------------------------------------------------
// read_lines
// ---------------------------------------------------------------------------

/** Convert modifier.lines ([[15,30],[40,55]]) to backend "15-30,40-55" format */
function modifierLinesToBackend(modifier: { lines?: Array<[number | null, number | null]> }): string | null {
  const lines = modifier?.lines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return lines
    .map(([a, b]) => (b != null ? `${a}-${b}` : `${a}-`))
    .join(',');
}

export const handleReadLines: OpHandler = async (params, ctx) => {
  let rlHash = params.hash as string | undefined;
  let rlLines = typeof params.lines === 'number' ? String(params.lines) : params.lines as string | undefined;
  const requestedContextLines = Math.max(0, Math.min(5, Math.trunc((params.context_lines as number | undefined) ?? 3)));

  // Accept ref (h:XXXX:15-50) as shorthand — parse into hash + lines
  // Coerce non-string ref to string when possible (e.g. number from dataflow)
  let ref: string | undefined;
  if (params.ref != null) {
    if (typeof params.ref === 'string') {
      ref = params.ref;
    } else if (typeof params.ref === 'number') {
      ref = String(params.ref);
    } else {
      return err(`read_lines: ref must be a string (h:XXXX:lines), got ${typeof params.ref}`);
    }
  }
  if (ref != null) {
    // Resolve recency refs (h:$last, h:$last_read, etc.) before parsing —
    // these are not valid hex hashes and would fail parseHashRef otherwise.
    ref = resolveRecencyInString(ref);
    if (ref.length > 200) {
      return err(`read_lines: ref too long (${ref.length} chars) — expected h:XXXX:lines format, not code content. Pass hash and lines as separate params.`);
    }
    if (!ref.startsWith('h:') && !ref.startsWith('bb:')) {
      return err(`read_lines: ref must start with h: — got "${ref.slice(0, 50)}..."`);
    }
  }
  if ((!rlHash || !rlLines) && ref) {
    const parsed = parseHashRef(ref);
    if (parsed) {
      rlHash = rlHash || `h:${parsed.hash}`;
      if (!rlLines) {
        const fromMod = modifierLinesToBackend(parsed.modifier as { lines?: Array<[number | null, number | null]> });
        if (fromMod) rlLines = fromMod;
      }
    } else if (typeof ref === 'string') {
      // Fallback when parseHashRef fails: extract h:XXXX:15-50 or h:XXXX:15-50,60-80
      const refMatch = ref.match(/^h:([0-9a-fA-F_]{6,16}):?(\d+-\d*(?:,\d+-\d*)*)?$/);
      if (refMatch) {
        rlHash = rlHash || `h:${refMatch[1]}`;
        if (refMatch[2]) rlLines = rlLines || refMatch[2];
      }
    }
  }

  // Accept file_path + start_line/end_line as alternative (docs-friendly) — need hash from context
  const fp = params.file_path as string | undefined;
  const startLine = params.start_line as number | undefined;
  const endLine = params.end_line as number | undefined;
  if (!rlLines && fp != null && startLine != null && endLine != null) {
    rlLines = `${startLine}-${endLine}`;
  }
  if (!rlLines && fp != null && ((startLine != null) !== (endLine != null))) {
    return err('read_lines: start_line and end_line must be provided together (paired range required).');
  }
  const refHint = ref && !rlLines ? ` Ref "${ref}" has no line range — provide lines (e.g. "15-50"), start_line + end_line, or use h:XXXX:15-50 format.` : '';
  if (!rlLines) {
    return err(`read_lines: requires lines (e.g. "15-50") or ref (h:XXXX:15-50) or (start_line + end_line).${refHint}`);
  }

  // Resolve file_path → hash when hash missing but file_path + lines provided
  if (!rlHash && fp) {
    const { items } = await ctx.expandFilePathRefs([fp]);
    const pathItem = items.find((it): it is ExpandedFilePath & { kind: 'path' } => it.kind === 'path');
    if (pathItem) {
      const ctxResult = await ctx.atlsBatchQuery('context', { type: 'full', file_paths: [pathItem.path] });
      const results = (ctxResult as Record<string, unknown>)?.results as Array<Record<string, unknown>> | undefined;
      const first = results?.[0];
      const contentHash = first?.content_hash ?? first?.hash;
      if (typeof contentHash === 'string') rlHash = contentHash.startsWith('h:') ? contentHash : `h:${contentHash}`;
    }
  }

  const hashHint = ref && !rlHash ? ` Ref "${ref}" missing valid hash — use h:XXXX:15-50 (6-16 hex chars).` : '';
  if (!rlHash) {
    return err(`read_lines: requires hash (or ref h:XXXX:15-50, or file_path to resolve).${hashHint}`);
  }

  const rlHistory = params.history === true;
  try {
    const explicitFilePath = fp;
    const chunkInfo = ctx.store().getChunkForHashRef(rlHash);
    const engramType = chunkInfo?.chunkType;
    if (
      !explicitFilePath
      && chunkInfo
      && engramType
      && READ_LINES_ENGRAM_TYPES.has(engramType)
    ) {
      const body = chunkInfo.content ?? '';
      const totalLines = body.length === 0 ? 0 : body.split('\n').length;
      const rangeInfo = engramLineRanges(rlLines, totalLines, requestedContextLines);
      if (!rangeInfo) {
        return err(`read_lines: invalid lines spec for engram — ${rlLines}`);
      }
      const rlContent = sliceContentByLines(body, rlLines, false, requestedContextLines);
      if (!rlContent.trim()) {
        return err(`read_lines: no lines matched for engram (${rlLines}; engram has ${totalLines} lines)`);
      }
      const { target: targetRange, actual: actualRange } = rangeInfo;
      const tk = countTokensSync(rlContent);
      const targetLabel = formatLineRanges(targetRange) || rlLines;
      const actualLabel = formatLineRanges(actualRange);
      const displayFile = `engram:${normalizeHashRefToken(rlHash)}`;
      const contentHash = hashContentSync(body);
      const lineSpecForRef =
        formatLineRanges(targetRange) || (typeof rlLines === 'string' ? rlLines.trim() : '');
      const baseRef = normalizeHashRefToken(rlHash);
      const rlRefs = lineSpecForRef ? [`${baseRef}:${lineSpecForRef}`] : [baseRef];
      const rlStore = ctx.store();
      const rlFreshnessHint = getFreshnessHintForRefs(rlStore, rlRefs);
      const kindLabel = engramType === 'blackboard' ? 'blackboard' : engramType;
      const rlSummary =
        `read_lines: ${displayFile}:${targetLabel} → ${baseRef} (${kindLabel}, ${tk}tk, ctx:${requestedContextLines}${actualLabel ? ` actual:${actualLabel}` : ''})\n${rlContent}`;
      const fullSummary = rlFreshnessHint ? `${rlSummary}\n${rlFreshnessHint}` : rlSummary;
      return {
        kind: 'file_refs',
        ok: true,
        refs: rlRefs,
        summary: fullSummary,
        tokens: tk,
        ...(rlFreshnessHint ? { _hash_warnings: [rlFreshnessHint] } : {}),
        content: {
          file: displayFile,
          hash: baseRef,
          content_hash: contentHash,
          target_range: targetRange,
          actual_range: actualRange,
          context_lines: requestedContextLines,
          content: rlContent,
        },
      };
    }

    const rlParams: Record<string, unknown> = { hash: rlHash, lines: rlLines, context_lines: requestedContextLines };
    // Always provide file_path to the backend as a fallback for path resolution.
    // Prefer the explicit param, fall back to looking up the source from context store.
    let effectiveFp = fp || params.file_path as string | undefined;
    if (!effectiveFp && chunkInfo?.source) effectiveFp = chunkInfo.source;
    if (effectiveFp) rlParams.file_path = effectiveFp;
    if (rlHistory) rlParams.history = true;
    const rlResult = await ctx.atlsBatchQuery('read_lines', rlParams) as Record<string, unknown>;
    if (rlResult.error) {
      return err(`read_lines: ERROR ${rlResult.error}${rlResult.hint ? ' — ' + rlResult.hint : ''}`);
    }
    const rlContent = String(rlResult.content ?? '');
    const rlFile = String(rlResult.file ?? '');
    const rlH = String(rlResult.h ?? rlHash);
    const prevInfo = rlResult.previous as Record<string, unknown> | undefined;
    const prevSuffix = prevInfo ? ` previous:${prevInfo.hash} edits:${prevInfo.edits}` : '';
    const targetRange = Array.isArray(rlResult.target_range) ? rlResult.target_range as Array<[number, number | null]> : undefined;
    const actualRange = Array.isArray(rlResult.actual_range) ? rlResult.actual_range as Array<[number, number | null]> : undefined;
    const usedContextLines = typeof rlResult.context_lines === 'number' ? rlResult.context_lines : requestedContextLines;
    const targetLabel = formatLineRanges(targetRange) || rlLines;
    const actualLabel = formatLineRanges(actualRange);
    const tk = countTokensSync(rlContent);
    ctx.store().clearSuspect(rlFile || rlH);
    const rlContentHash = typeof rlResult.content_hash === 'string' ? String(rlResult.content_hash) : undefined;

    // Read-span reuse: if a prior chunk covers this range at the same revision, reuse it
    if (rlFile && rlContentHash && actualRange?.length) {
      const rangeStart = actualRange[0]?.[0];
      const lastRange = actualRange[actualRange.length - 1];
      const rangeEnd = lastRange?.[1] ?? lastRange?.[0];
      if (rangeStart != null && rangeEnd != null) {
        const reusedLines = ctx.store().findReusableRead({ filePath: rlFile, startLine: rangeStart, endLine: rangeEnd, sourceRevision: rlContentHash });
        if (reusedLines) {
          useRetentionStore.getState().incrementReadsReused();
          const lineSpecForRef =
            formatLineRanges(actualRange) || formatLineRanges(targetRange) || (typeof rlLines === 'string' ? rlLines.trim() : '');
          const baseRef = normalizeHashRefToken(`h:${reusedLines}`);
          const refWithLines = lineSpecForRef ? `${baseRef}:${lineSpecForRef}` : baseRef;
          const reuseSummary = `read_lines: ERROR redundant — ${rlFile}:${targetLabel} already at h:${reusedLines} (same rev). Content is live. Chain from this ref — change.edit file_path:"h:${reusedLines}:source" or read.lines ref:"h:${reusedLines}:LL-LL" for a different span. Do NOT re-read.`;
          return {
            kind: 'file_refs', ok: false, refs: [refWithLines],
            summary: reuseSummary, tokens: 0,
            content: { file: rlFile, hash: reusedLines, ...(rlContentHash ? { content_hash: rlContentHash } : {}), target_range: targetRange, actual_range: actualRange, context_lines: usedContextLines, content: rlContent },
          };
        }
      }
    }

    if (rlFile && rlContentHash) {
      ctx.store().reconcileSourceRevision(rlFile, rlContentHash);
      ctx.store().recordMemoryEvent({ action: 'read', reason: 'read_lines', source: rlFile, newRevision: rlContentHash, refs: [normalizeHashRefToken(rlH)] });
    }
    const lineSpecForRef =
      formatLineRanges(actualRange) || formatLineRanges(targetRange) || (typeof rlLines === 'string' ? rlLines.trim() : '');
    const baseRef = normalizeHashRefToken(rlH);
    const rlRefs = lineSpecForRef ? [`${baseRef}:${lineSpecForRef}`] : [baseRef];
    const rlStore = ctx.store();
    const rlFreshnessHint = getFreshnessHintForRefs(rlStore, rlRefs);
    const priorRanges = rlFile ? rlStore.getPriorReadRanges(rlFile).filter(r => r !== (actualLabel || targetLabel)) : [];
    const priorRangesHint = priorRanges.length > 0 ? `\nNOTE previously read regions for this file: ${priorRanges.join(', ')}.` : '';
    const rlSummary = `read_lines: ${rlFile}:${targetLabel} → ${rlH} (${tk}tk, ctx:${usedContextLines}${actualLabel ? ` actual:${actualLabel}` : ''})${prevSuffix}\n${rlContent}`;
    const fullSummary = `${rlSummary}${rlFreshnessHint ? '\n' + rlFreshnessHint : ''}${priorRangesHint}`;
    return {
      kind: 'file_refs', ok: true,
      refs: rlRefs,
      summary: fullSummary,
      tokens: tk,
      ...(rlFreshnessHint ? { _hash_warnings: [rlFreshnessHint] } : {}),
      content: {
        file: rlFile,
        hash: rlH,
        ...(rlContentHash ? { content_hash: rlContentHash } : {}),
        target_range: targetRange,
        actual_range: actualRange,
        context_lines: usedContextLines,
        content: rlContent,
      },
    };
  } catch (readErr) {
    return err(`read_lines: ERROR ${readErr instanceof Error ? readErr.message : String(readErr)}`);
  }
};

// ---------------------------------------------------------------------------
// read_shaped
// ---------------------------------------------------------------------------

export const handleReadShaped: OpHandler = async (params, ctx) => {
  const rawShapedPaths = (params.file_paths as string[] | undefined) ?? [];
  const maxFiles = params.max_files as number | undefined;
  let pathsForShaped = rawShapedPaths;
  if (typeof maxFiles === 'number' && maxFiles > 0 && rawShapedPaths.length > maxFiles) {
    pathsForShaped = rawShapedPaths.slice(0, maxFiles);
  }
  const shape = params.shape as string;
  const shapedBind = params.bind as string[] | undefined;
  if (!pathsForShaped.length) return err('read_shaped: ERROR missing file_paths param');
  if (!shape) return err('read_shaped: ERROR missing shape param (e.g. "sig", "42-80:dedent", "fn(name)")');
  for (const fp of pathsForShaped) {
    const pathErr = validatePathParam(fp, 'read_shaped: file_path');
    if (pathErr) return err(pathErr);
  }

  const { items: shapedItems, notes: shapedNotes } = await ctx.expandFilePathRefs(pathsForShaped);
  const lines: string[] = [];
  const allRefs: string[] = [];
  const shapedResults: Array<Record<string, unknown>> = [];
  let totalTokensDelta = 0;

  if (
    typeof maxFiles === 'number' &&
    maxFiles > 0 &&
    rawShapedPaths.length > maxFiles
  ) {
    lines.push(`read_shaped: NOTE file_paths capped to ${maxFiles} (max_files)`);
  }
  for (const note of shapedNotes) lines.push(`read_shaped: ${note}`);

  let chunkLoadErrors = 0;
  try {
    const fileBacked = shapedItems.filter((item): item is ExpandedFilePath & { kind: 'path' } => item.kind === 'path');
    const backendFullByPath = new Map<string, BackendContextEntry>();
    if (fileBacked.length > 0) {
      const allPaths = fileBacked.map(item => item.path);
      for (let off = 0; off < allPaths.length; off += READ_SHAPED_CONTEXT_CHUNK) {
        const slice = allPaths.slice(off, off + READ_SHAPED_CONTEXT_CHUNK);
        try {
          const fullResult = await ctx.atlsBatchQuery('context', { type: 'full', file_paths: slice }) as Record<string, unknown>;
          const items = Array.isArray(fullResult.results) ? fullResult.results : [];
          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const entry = item as BackendContextEntry;
            const source = extractFilePath(entry as unknown as Record<string, unknown>);
            if (source) backendFullByPath.set(source, entry);
          }
        } catch (chunkErr) {
          chunkLoadErrors += 1;
          lines.push(
            `read_shaped: context full chunk [${off}..${off + slice.length}) → ERROR ${chunkErr instanceof Error ? chunkErr.message : String(chunkErr)}`,
          );
        }
      }
    }
    for (const item of shapedItems) {
      const content = item.kind === 'content' ? item.content : null;
      const source = item.kind === 'content' ? item.source : item.path;
      const fullEntry = item.kind === 'path' ? backendFullByPath.get(item.path) : undefined;
      const result = await _processShapedFile(
        ctx,
        source,
        content ?? (typeof fullEntry?.content === 'string' ? fullEntry.content : null),
        extractContentHash((fullEntry ?? {}) as Record<string, unknown>),
        shape,
        shapedBind,
        lines,
      );
      if (result) {
        allRefs.push(...result.refs);
        totalTokensDelta += result.tokens;
        if (result.artifact) shapedResults.push(result.artifact);
      }
    }
  } catch (readErr) {
    if (allRefs.length === 0) {
      return err(`read_shaped: ERROR ${readErr instanceof Error ? readErr.message : String(readErr)}`);
    }
    lines.push(`read_shaped: ERROR (after partial progress) ${readErr instanceof Error ? readErr.message : String(readErr)}`);
  }

  const store = ctx.store();
  const freshnessHint = getFreshnessHintForRefs(store, allRefs);
  const partialNote =
    chunkLoadErrors > 0 && allRefs.length > 0
      ? `\nread_shaped: NOTE partial success — ${chunkLoadErrors} context chunk(s) failed; ${allRefs.length} ref(s) staged.`
      : '';
  const summary = lines.join('\n') + partialNote;
  const shapedOk = allRefs.length > 0;
  return {
    kind: 'file_refs',
    ok: shapedOk,
    refs: allRefs,
    summary: freshnessHint ? `${summary}\n${freshnessHint}` : summary,
    tokens: totalTokensDelta,
    content: { results: shapedResults },
    ...(freshnessHint ? { _hash_warnings: [freshnessHint] } : {}),
    ...(!shapedOk ? { error: 'read_shaped: no files staged (context chunks and/or per-file reads failed)' } : {}),
  };
};

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

export const handleShape: OpHandler = async (params, ctx) => {
  const hashRef = params.hash as string;
  if (!hashRef) return err('shape: ERROR missing hash param');

  try {
    const rawRef = hashRef.startsWith('h:') ? hashRef : `h:${hashRef}`;
    const resolved = await invokeWithTimeout<ResolvedHashContent>('resolve_hash_ref', { rawRef }, READ_TIMEOUT_MS);
    const hash = ctx.store().addChunk(resolved.content, 'smart', resolved.source || undefined);
    const tokens = countTokensSync(resolved.content);
    return ok(`shape: ${hashRef} → h:${hash} (${tokens}tk)`, [`h:${hash}`], tokens);
  } catch (shapeErr) {
    return err(`shape: ERROR ${shapeErr instanceof Error ? shapeErr.message : String(shapeErr)}`);
  }
};

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

export const handleEmit: OpHandler = async (params, ctx) => {
  const content = params.content as string;
  const label = (params.label as string) || 'emitted';
  const lang = params.lang as string | undefined;
  if (!content) return err('emit: ERROR missing content param');

  const { dematerialize } = await import('../../hashProtocol');
  const hash = ctx.store().addChunk(content, 'result', label);
  const tokens = countTokensSync(content);
  dematerialize(hash);

  invoke('register_hash_content', {
    hash,
    content,
    source: label,
    lang: lang || null,
  }).catch(e => console.warn('[emit] register_hash_content failed:', e));

  return ok(`emit: h:${hash.slice(0, SHORT_HASH_LEN)} (${tokens}tk) "${label}" — use h:${hash.slice(0, SHORT_HASH_LEN)} in response`, [`h:${hash}`], tokens);
};

// ---------------------------------------------------------------------------
// Shared helper: process a file through the shape pipeline (staged dual-hash)
// ---------------------------------------------------------------------------

async function _processShapedFile(
  ctx: import('../types').HandlerContext,
  source: string,
  preloadedContent: string | null,
  preloadedSnapshotHash: string | undefined,
  shape: string,
  bindIds: string[] | undefined,
  lines: string[],
): Promise<{ refs: string[]; tokens: number; artifact?: Record<string, unknown> } | null> {
  let fullContent = preloadedContent;
  let snapshotHash = preloadedSnapshotHash;

  if (!fullContent && snapshotHash) {
    const resolvedFull = await invokeWithTimeout<ResolvedHashContent>('resolve_hash_ref', {
      rawRef: `h:${snapshotHash}`,
    }, READ_TIMEOUT_MS);
    fullContent = resolvedFull.content;
    snapshotHash = resolvedFull.content_hash ?? resolvedFull.snapshot_hash ?? snapshotHash;
  }

  if (!fullContent) {
    const { useContextStore } = await import('../../../stores/contextStore');
    const ctxChunks = useContextStore.getState().chunks;
    const normPath = source.replace(/\\/g, '/');
    for (const [, chunk] of ctxChunks) {
      if (chunk.source && chunk.source.replace(/\\/g, '/').endsWith(normPath) && chunk.type !== 'result') {
        fullContent = chunk.content;
        snapshotHash = chunk.sourceRevision ?? snapshotHash;
        break;
      }
    }
  }

  if (!fullContent) {
    try {
      fullContent = await invokeWithTimeout<string>('read_file_contents', { path: source, projectRoot: ctx.getProjectPath() }, READ_TIMEOUT_MS);
    } catch (readErr) {
      lines.push(`read_shaped: ${source} → ERROR ${readErr instanceof Error ? readErr.message : String(readErr)}`);
      return null;
    }
  }

  const fullHash = snapshotHash ?? hashContentSync(fullContent);
  const fullTokens = countTokensSync(fullContent);

  if (!snapshotHash) {
    await invokeWithTimeout('register_hash_content', {
      hash: fullHash,
      content: fullContent,
      source,
      lang: null,
    }, READ_TIMEOUT_MS);
  }

  const resolved = await invokeWithTimeout<ResolvedHashContent>('resolve_hash_ref', {
    rawRef: `h:${fullHash}:${shape}`,
  }, READ_TIMEOUT_MS);
  const canonicalContentHash = resolved.content_hash ?? resolved.snapshot_hash ?? fullHash;

  const shapedTokens = countTokensSync(resolved.content);

  const stageResult = ctx.store().stageSnippet(
    canonicalContentHash.slice(0, SHORT_HASH_LEN),
    resolved.content,
    source,
    shape,
    canonicalContentHash,
    shape,
    'derived',
  );

  if (!stageResult.ok) {
    const hash = ctx.store().addChunk(resolved.content, 'smart', source, undefined, undefined, undefined, {
      subtaskIds: bindIds,
      boundDuringPlanning: true,
      fullHash: canonicalContentHash,
      sourceRevision: canonicalContentHash,
      viewKind: 'derived',
    });
    ctx.store().clearSuspect(source);
    ctx.store().reconcileSourceRevision(source, canonicalContentHash);
    ctx.store().recordMemoryEvent({ action: 'read', reason: 'read_shaped_fallback', source, newRevision: canonicalContentHash, refs: [`h:${hash}`] });
    const savedPctFb = fullTokens > 0 ? Math.round((1 - shapedTokens / fullTokens) * 100) : 0;
    const foldHintFb = savedPctFb < 20 && shape === 'fold' ? ' | WARNING: low compression — consider sig shape' : '';
    lines.push(`read_shaped: ${source} → h:${hash} (full:${fullTokens}tk, shaped:${shapedTokens}tk, saved:${savedPctFb}%, staged full — WM fallback)${foldHintFb} | use canonical full read before edits`);
    return {
      refs: [`h:${hash}`],
      tokens: shapedTokens,
      artifact: {
        file: source,
        h: `h:${hash}`,
        content_hash: canonicalContentHash,
        selector: resolved.selector ?? shape,
        shape_hash: hashContentSync(resolved.content),
      },
    };
  }

  if (bindIds) {
    const binding = { hash: canonicalContentHash.slice(0, SHORT_HASH_LEN), source, shape, tokens: shapedTokens, fullHash: canonicalContentHash };
    const plan = ctx.store().taskPlan;
    if (plan) {
      for (const st of plan.subtasks) {
        if (bindIds.includes(st.id)) {
          st.contextManifest = st.contextManifest || [];
          st.contextManifest.push(binding);
        }
      }
    }
  }

  const savedPct = fullTokens > 0 ? Math.round((1 - shapedTokens / fullTokens) * 100) : 0;
  const foldHint = savedPct < 20 && shape === 'fold' ? ' | WARNING: low compression — consider sig shape' : '';
  ctx.store().clearSuspect(source);
  ctx.store().reconcileSourceRevision(source, canonicalContentHash);
  ctx.store().recordMemoryEvent({ action: 'read', reason: 'read_shaped', source, newRevision: canonicalContentHash, refs: [`h:${canonicalContentHash.slice(0, SHORT_HASH_LEN)}`] });
  lines.push(`read_shaped: ${source} → staged:${canonicalContentHash.slice(0, SHORT_HASH_LEN)} (full:${fullTokens}tk, shaped:${shapedTokens}tk, saved:${savedPct}%, cached)${foldHint} | discovery only — use canonical full read before edits`);
  return {
    refs: [`h:${canonicalContentHash.slice(0, SHORT_HASH_LEN)}`],
    tokens: shapedTokens,
    artifact: {
      file: source,
      h: `h:${canonicalContentHash.slice(0, SHORT_HASH_LEN)}`,
      content_hash: canonicalContentHash,
      selector: resolved.selector ?? shape,
      shape_hash: hashContentSync(resolved.content),
    },
  };
}
