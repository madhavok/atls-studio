/**
 * Context Hash Utilities
 * 
 * Hash generation and token estimation for context chunks.
 * Every piece of content gets a unique hash for tracking.
 * 
 * Uses dual FNV-1a hashing (two 32-bit seeds) to produce a 16-char hex hash.
 * First SHORT_HASH_LEN (6) chars used as shortHash for display; full 16 chars as Map key.
 */

/** Canonical short hash length. 6 chars = ~16M unique refs per session.
 *  Backend uses adaptive 6-8 on collision; frontend defaults to 6. */
export const SHORT_HASH_LEN = 6;

// Chunk types for granular context management
export type ChunkType = 
  | 'msg:user'   // User message
  | 'msg:asst'   // Assistant message
  | 'call'       // Tool call (the request)
  | 'result'     // Tool result
  | 'file'       // File content
  | 'exec:cmd'   // Terminal command
  | 'exec:out'   // Terminal output
  // ATLS-specific types for working memory
  | 'smart'      // Smart context (symbols, imports, exports)
  | 'raw'        // Raw file content
  | 'search'     // Code search results
  | 'symbol'     // Symbol usage/definition
  | 'deps'       // Dependencies/call hierarchy
  | 'issues'     // Find issues results
  | 'tree'       // Project structure tree
  | 'analysis';  // Batch analyze.* structured outputs (deps, extract_plan, etc.)

const CHUNK_TAG_TYPES: ChunkType[] = [
  'msg:user',
  'msg:asst',
  'call',
  'result',
  'file',
  'exec:cmd',
  'exec:out',
  'smart',
  'raw',
  'search',
  'symbol',
  'deps',
  'issues',
  'tree',
  'analysis',
];

/** Pre-sorted by descending length for longest-prefix matching in parseChunkTag */
const CHUNK_TAG_TYPES_BY_LENGTH: ChunkType[] = [...CHUNK_TAG_TYPES].sort((a, b) => b.length - a.length);

/**
 * FNV-1a 32-bit hash with configurable offset basis.
 * Used internally to produce two independent 32-bit hashes.
 */
function fnv1a32(content: string, offsetBasis: number): number {
  let hash = offsetBasis;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    // FNV prime for 32-bit: 0x01000193
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // ensure unsigned
}

/**
 * Synchronous hash producing 16 hex chars (64 bits of entropy).
 * Concatenates two independent FNV-1a 32-bit hashes with different seeds.
 * Collision probability ~50% at ~4 billion entries (vs ~77k with old djb2 8-char).
 */
export function hashContentSync(content: string): string {
  const h1 = fnv1a32(content, 0x811c9dc5);  // standard FNV offset basis
  const h2 = fnv1a32(content, 0x050c5d1f);  // alternate offset basis
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Estimate token count for content.
 * Adapts chars-per-token ratio based on content density:
 *   - Minified / dense code (few newlines, low whitespace): ~2.5 chars/token
 *   - Normal code: ~3.5 chars/token
 *   - Prose / comments (high whitespace): ~4.5 chars/token
 *   - Whitespace-heavy (padding, blank lines): ~5 chars/token
 */
export function estimateTokens(content: string): number {
  if (!content || content.length === 0) return 0;
  const len = content.length;

  let hasCode = false;
  let newlineCount = 0;
  let wsCount = 0;
  let cjkCount = 0;

  for (let i = 0; i < len; i++) {
    const c = content.charCodeAt(i);
    if (c === 10) newlineCount++;
    if (c === 32 || c === 9 || c === 10 || c === 13) wsCount++;
    if (!hasCode) {
      if (c === 123 || c === 125 || c === 91 || c === 93 || c === 40 || c === 41 || c === 59) {
        hasCode = true;
      }
    }
    // CJK Unified Ideographs + common CJK ranges
    if (c >= 0x3000 && ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x3000 && c <= 0x303F))) {
      cjkCount++;
    }
  }

  const lineCount = newlineCount + 1;
  const charsPerLine = len / lineCount;
  const wsRatio = wsCount / len;

  let charsPerToken: number;
  if (hasCode && charsPerLine > 200) {
    charsPerToken = 2.5;
  } else if (hasCode && wsRatio < 0.15) {
    charsPerToken = 3.0;
  } else if (hasCode) {
    charsPerToken = 3.5;
  } else if (wsRatio > 0.45) {
    charsPerToken = 5.0;
  } else if (wsRatio > 0.30) {
    charsPerToken = 4.5;
  } else {
    charsPerToken = 3.8;
  }

  // CJK characters typically tokenize to ~1.5 tokens each (not 3-4 chars/token)
  // Adjust: subtract CJK chars from general pool, add their token estimate separately
  const nonCjkLen = len - cjkCount;
  const cjkTokens = Math.ceil(cjkCount * 1.5);
  return Math.max(1, Math.ceil(nonCjkLen / charsPerToken) + cjkTokens);
}

/**
 * Format a chunk reference for compressed history.
 * Uses h: prefix so compressed refs are directly usable as hash references in tool calls.
 * With digest: multi-line block showing hash + symbols/key lines.
 * Without: single-line [h:{hash} {tokens}tk {description}]
 *
 * Token-optimized: dropped `->` arrow and `,` separator (saves ~2 tokens per ref
 * on Claude/OpenAI tokenizers; spaces between fields tokenize more efficiently
 * than punctuation-heavy separators in BPE).
 */
export function formatChunkRef(
  shortHash: string,
  tokens: number,
  source?: string,
  description?: string,
  digest?: string,
): string {
  const header = description
    ? `[h:${shortHash} ${tokens}tk ${description}]`
    : `[h:${shortHash} ${tokens}tk${source ? ` ${source}` : ''}]`;
  if (digest) {
    return `${header}\n${digest}`;
  }
  return header;
}

export function formatChunkTag(
  shortHash: string,
  tokens: number,
  type: ChunkType,
  source?: string,
): string {
  return `«h:${shortHash} ${tokens}tk ${type}${source ? ` ${source}` : ''}»`;
}

/**
 * Parse a chunk tag back to components
 */
export function parseChunkTag(tag: string): {
  hash: string;
  tokens: number;
  type: string;
  source?: string;
} | null {
  // Supports both new format «h:XXXX 450tk type source» and legacy «h:XXXX tk:450 type:source»
  const match = tag.match(/^«h:(\w+)\s+(?:tk:(\d+)|(\d+)tk)\s+(.+)»$/);
  if (!match) return null;
  const tokensStr = match[2] ?? match[3];

  const payload = match[4];
  const type = CHUNK_TAG_TYPES_BY_LENGTH.find((chunkType) => payload === chunkType || payload.startsWith(`${chunkType} `) || payload.startsWith(`${chunkType}:`));
  if (!type) return null;

  const rest = payload.slice(type.length);
  const source = rest.startsWith(' ') ? rest.slice(1) : rest.startsWith(':') ? rest.slice(1) : undefined;

  return {
    hash: match[1],
    tokens: parseInt(tokensStr, 10),
    type,
    source: source || undefined,
  };
}

/**
 * Format tokens for display (e.g., 2400 -> "2.4k")
 */

// Max symbols to include in a digest line
const DIGEST_MAX_SYMBOLS = 12;
// Max lines for extractive digest of non-file chunks
const DIGEST_MAX_LINES = 3;

/**
 * Symbol info from the ATLS backend (subset of SymbolContext).
 * Passed in from the caller — no backend call happens here.
 */
export interface DigestSymbol {
  name: string;
  kind: string;
  signature?: string | null;
  startLine?: number;
  endLine?: number;
}

/**
 * Generate a compact digest for a chunk.
 *
 * For file-based chunks (smart/raw/file): uses ATLS symbol data if provided,
 * producing "kind name | kind name | …" lines.
 * For other types: extracts first/last meaningful lines.
 *
 * Returns empty string if no useful digest can be produced.
 */
export function generateDigest(
  content: string,
  type: ChunkType,
  symbols?: DigestSymbol[],
): string {
  if (symbols && symbols.length > 0) {
    return formatSymbolDigest(symbols);
  }

  switch (type) {
    case 'file':
    case 'smart':
    case 'raw':
      return extractCodeDigest(content);
    case 'search':
      return extractSearchDigest(content);
    case 'exec:out':
      return extractExecDigest(content);
    case 'issues':
    case 'deps':
    case 'symbol':
    case 'result':
      return extractKeyLines(content);
    default:
      return '';
  }
}

/**
 * Generate an edit-ready digest that includes line-range anchors for each symbol.
 * Format: "fn authenticate:15-32 | cls AuthService:34-89 | ..."
 *
 * Falls back to regex-based extraction with line counting when no symbol data.
 * This is the digest used by the compact operation so the AI retains
 * enough structural info to target edits by hash + line number.
 */
export function generateEditReadyDigest(
  content: string,
  type: ChunkType,
  symbols?: DigestSymbol[],
): string {
  if (symbols && symbols.length > 0) {
    return formatSymbolDigestWithLines(symbols);
  }
  // Fallback: regex-based extraction with line numbers
  if (type === 'file' || type === 'smart' || type === 'raw') {
    return extractCodeDigestWithLines(content);
  }
  return generateDigest(content, type, symbols);
}

/** Format symbols with line ranges: "fn name:15-32 | cls Name:34-89" */
function formatSymbolDigestWithLines(symbols: DigestSymbol[]): string {
  const items = symbols.slice(0, DIGEST_MAX_SYMBOLS);
  const parts: string[] = [];
  for (const s of items) {
    const kindAbbrev = abbreviateKind(s.kind);
    if (s.startLine != null && s.endLine != null) {
      parts.push(`${kindAbbrev} ${s.name}:${s.startLine}-${s.endLine}`);
    } else if (s.startLine != null) {
      parts.push(`${kindAbbrev} ${s.name}:${s.startLine}`);
    } else {
      parts.push(`${kindAbbrev} ${s.name}`);
    }
  }
  const line = parts.join(' | ');
  const overflow = symbols.length > DIGEST_MAX_SYMBOLS
    ? ` (+${symbols.length - DIGEST_MAX_SYMBOLS} more)`
    : '';
  return `  ${line}${overflow}`;
}

/** Regex-based code digest with line numbers for each extracted symbol */
function extractCodeDigestWithLines(content: string): string {
  const sigRe = /(?:^|\n)\s*(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|function|def|func|class|struct|interface|trait|enum|type|impl)\s+(\w+)/g;
  const entries: string[] = [];
  let m: RegExpExecArray | null;
  let lineNum = 1;
  let lastIdx = 0;
  while ((m = sigRe.exec(content)) !== null && entries.length < DIGEST_MAX_SYMBOLS) {
    const name = m[1];
    // Count newlines in [lastIdx, m.index] inclusive. The match may start at `\n`
    // from `(?:^|\n)`; that newline is at m.index and must count toward this symbol's
    // line, not the next (exclusive end would defer it and shift every line down by 1).
    for (let k = lastIdx; k <= m.index; k++) {
      if (content.charCodeAt(k) === 10) lineNum++;
    }
    lastIdx = m.index + 1;
    entries.push(`${name}:${lineNum}`);
  }
  if (entries.length === 0) return '';
  return `  ${entries.join(' | ')}`;
}

/** Format ATLS symbols into a compact pipe-separated digest */
function formatSymbolDigest(symbols: DigestSymbol[]): string {
  const items = symbols.slice(0, DIGEST_MAX_SYMBOLS);
  const parts: string[] = [];
  for (const s of items) {
    const kindAbbrev = abbreviateKind(s.kind);
    parts.push(`${kindAbbrev} ${s.name}`);
  }
  const line = parts.join(' | ');
  const overflow = symbols.length > DIGEST_MAX_SYMBOLS
    ? ` (+${symbols.length - DIGEST_MAX_SYMBOLS} more)`
    : '';
  return `  ${line}${overflow}`;
}

const KIND_ABBREVIATIONS: Record<string, string> = {
  function: 'fn', method: 'fn', constructor: 'ctor',
  class: 'cls', struct: 'struct', interface: 'iface',
  enum: 'enum', type: 'type', trait: 'trait',
  variable: 'var', constant: 'const', property: 'prop',
  module: 'mod', namespace: 'ns', impl: 'impl',
  macro: 'mac', decorator: 'dec', protocol: 'proto',
};

/** Abbreviate symbol kind for compact display */
function abbreviateKind(kind: string): string {
  return KIND_ABBREVIATIONS[kind.toLowerCase()] || kind.slice(0, 4);
}

/** Fallback: extract fn/class/struct names from raw code via lightweight regex */
function extractCodeDigest(content: string): string {
  const sigRe = /(?:^|\n)\s*(?:export\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|function|def|func|class|struct|interface|trait|enum|type|impl)\s+(\w+)/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = sigRe.exec(content)) !== null && names.length < DIGEST_MAX_SYMBOLS) {
    names.push(m[1]);
  }
  if (names.length === 0) return '';
  return `  ${names.join(' | ')}`;
}

/** Extract file paths from search results */
function extractSearchDigest(content: string): string {
  const fileRe = /(?:^|\n)\s*(?:File|Match|→)\s*:?\s*([^\n:]+\.\w+)/g;
  const files: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(content)) !== null && files.length < DIGEST_MAX_LINES) {
    files.push(m[1].trim());
  }
  if (files.length === 0) return extractKeyLines(content);
  return files.map(f => `  ${f}`).join('\n');
}

/** Extract command + last lines from terminal output */
function extractExecDigest(content: string): string {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return '';
  const parts: string[] = [`  $ ${lines[0].slice(0, 80)}`];
  if (lines.length > 2) {
    const tail = lines.slice(-2).map(l => `  ${l.slice(0, 80)}`);
    parts.push(...tail);
  }
  return parts.join('\n');
}

/** Generic: take first N non-empty lines */
function extractKeyLines(content: string): string {
  const lines = content.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !l.startsWith('#'));
  if (lines.length === 0) return '';
  return lines.slice(0, DIGEST_MAX_LINES).map(l => `  ${l.slice(0, 100)}`).join('\n');
}

/** One row per search hit — used for structured bindings (content.file_paths) and summaries. */
export interface CodeSearchHitRow {
  file: string;
  line: number;
  end_line?: number;
}

/**
 * Flatten backend `code_search` JSON into hit rows.
 * The API wraps hits as `{ results: [ { query, results: [...] }, … ] }` (per-query blocks),
 * and may use compact (`r`), tiered (`high`/`medium`), or grouped (`groups`) shapes.
 * Older extractors assumed `results` was a flat hit list — that left file_paths empty for bindings.
 */
export function flattenCodeSearchHits(result: unknown): CodeSearchHitRow[] {
  const rows: CodeSearchHitRow[] = [];
  if (!result || typeof result !== 'object') return rows;
  const obj = result as Record<string, unknown>;
  const outer = obj.results;
  if (!Array.isArray(outer)) return rows;

  function pushRow(file: string | undefined, line: unknown, endLine: unknown) {
    if (typeof file !== 'string' || !file.trim()) return;
    const ln = typeof line === 'number' && Number.isFinite(line) && line > 0 ? line : 1;
    const el = typeof endLine === 'number' && Number.isFinite(endLine) && endLine >= ln ? endLine : undefined;
    rows.push({ file: file.trim(), line: ln, end_line: el });
  }

  function walkRawHit(hit: Record<string, unknown>) {
    const file = (hit.file ?? hit.f ?? hit.path ?? hit.file_path) as string | undefined;
    const line = hit.line ?? hit.l;
    const endLine = hit.end_line ?? hit.endLine;
    pushRow(file, line, endLine);
  }

  for (const block of outer) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;

    if (Array.isArray(b.results)) {
      for (const h of b.results) {
        if (h && typeof h === 'object') walkRawHit(h as Record<string, unknown>);
      }
      continue;
    }

    if (Array.isArray(b.r)) {
      for (const h of b.r) {
        if (h && typeof h === 'object') walkRawHit(h as Record<string, unknown>);
      }
      continue;
    }

    if (Array.isArray(b.high) || Array.isArray(b.medium)) {
      const high = Array.isArray(b.high) ? b.high : [];
      const medium = Array.isArray(b.medium) ? b.medium : [];
      for (const h of high) {
        if (h && typeof h === 'object') walkRawHit(h as Record<string, unknown>);
      }
      for (const h of medium) {
        if (h && typeof h === 'object') walkRawHit(h as Record<string, unknown>);
      }
      continue;
    }

    if (Array.isArray(b.groups)) {
      for (const g of b.groups) {
        if (!g || typeof g !== 'object') continue;
        const gObj = g as Record<string, unknown>;
        const gf = gObj.file as string | undefined;
        const matches = gObj.matches;
        if (Array.isArray(matches)) {
          for (const m of matches) {
            if (m && typeof m === 'object') {
              const mObj = m as Record<string, unknown>;
              pushRow(gf, mObj.line ?? mObj.l, undefined);
            }
          }
        }
      }
      continue;
    }

    if (b.file || b.f) {
      walkRawHit(b);
    }
  }

  return rows;
}

/** One-liner summary from code_search result for chunk display */
export function extractSearchSummary(result: unknown, queries: string[]): string {
  const rows = flattenCodeSearchHits(result);
  const count = rows.length;
  const q = queries.slice(0, 2).join(', ');
  return count > 0 ? `${count} matches for ${q}` : `search: ${q}`;
}

/** One-liner summary from symbol_usage result for chunk display */
export function extractSymbolSummary(result: unknown, symbolNames: string[]): string {
  if (!result || typeof result !== 'object') return symbolNames.join(', ');
  const obj = result as Record<string, unknown>;
  const results = obj.results as unknown[] | undefined;
  const count = Array.isArray(results) ? results.length : 0;
  const syms = symbolNames.slice(0, 2).join(', ');
  return count > 0 ? `${count} refs for ${syms}` : `symbols: ${syms}`;
}

/** One-liner summary from dependencies/change_impact result for chunk display */
export function extractDepsSummary(result: unknown, filePaths: string[], depMode: string): string {
  if (!result || typeof result !== 'object') return filePaths.slice(0, 2).join(', ');
  const obj = result as Record<string, unknown>;
  const results = obj.results as unknown[] | undefined;
  const count = Array.isArray(results) ? results.length : 0;
  const files = filePaths.slice(0, 2).join(', ');
  return count > 0 ? `${depMode}: ${count} entries for ${files}` : `deps ${depMode}: ${files}`;
}

/**
 * Slice content by line range spec (1-indexed, inclusive).
 * Format: "15-22", "15-22,40-55", or "45-" (to end).
 * @param raw If true, return plain lines without line-number prefixes (for content insertion).
 *            If false (default), prefix each line with `NNNN|` (for display/context).
 */
export function sliceContentByLines(content: string, linesSpec: string, raw?: boolean, contextLines = 0): string {
  const lines = content.split('\n');
  const total = lines.length;
  const ranges: [number, number | null][] = [];
  for (const part of linesSpec.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const dashPos = t.indexOf('-');
    if (dashPos >= 0) {
      const startStr = t.slice(0, dashPos);
      const endStr = t.slice(dashPos + 1);
      const start = parseInt(startStr, 10);
      if (isNaN(start) || start < 1) return '';
      const end = endStr ? parseInt(endStr, 10) : null;
      if (endStr && (isNaN(end!) || end! < start)) return '';
      ranges.push([start, end]);
    } else {
      const line = parseInt(t, 10);
      if (isNaN(line) || line < 1) return '';
      ranges.push([line, line]);
    }
  }
  if (ranges.length === 0) return '';

  const output: string[] = [];
  const buffered = Math.max(0, Math.min(5, Math.trunc(contextLines)));
  for (const [start, end] of ranges) {
    const actualStart = Math.max(1, start - buffered);
    const actualEnd = Math.min(end != null ? end + buffered : total, total);
    const startIdx = actualStart - 1;
    if (startIdx >= total) continue;
    const endIdx = actualEnd;
    for (let i = startIdx; i < endIdx; i++) {
      output.push(raw ? (lines[i] ?? '') : `${String(i + 1).padStart(4)}|${lines[i] ?? ''}`);
    }
  }
  return output.join('\n');
}

/** Check if content is a compressed chunk reference (either format). */
export function isCompressedRef(content: string): boolean {
  return content.startsWith('[h:') || content.startsWith('[->');
}

// ---------------------------------------------------------------------------
// HPP v2 Reference Formatters
// ---------------------------------------------------------------------------

/** Format a shaped hash reference: `h:XXXX:lines:shape` or `h:XXXX:shape` */
export function formatShapeRef(shortHash: string, shape: string, lines?: string): string {
  const lineSpec = lines ? `:${lines}` : '';
  return `h:${shortHash}${lineSpec}:${shape}`;
}

/** Format a diff reference: `h:OLD..h:NEW` */
export function formatDiffRef(oldHash: string, newHash: string): string {
  const oldShort = oldHash.length > SHORT_HASH_LEN ? oldHash.slice(0, SHORT_HASH_LEN) : oldHash;
  const newShort = newHash.length > SHORT_HASH_LEN ? newHash.slice(0, SHORT_HASH_LEN) : newHash;
  return `h:${oldShort}..h:${newShort}`;
}
