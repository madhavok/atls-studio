/**
 * TOON (Token-Oriented Object Notation) serializer + line-per-step batch parser.
 * Compact alternative to JSON for AI model outputs — typically 40-60% fewer tokens.
 *
 * Serializer rules:
 *  - Booleans: 1 / 0
 *  - Null/undefined/empty string: omitted
 *  - Strings: unquoted unless they contain special chars
 *  - Objects: {key:val,key:val}
 *  - Arrays: [val,val]
 *
 * Batch line-per-step format (model -> tool input):
 *  - One step per line: STEP_ID <operation> key:val key:val ... (<operation> = short code or dotted name, not the literal string USE)
 *  - Dataflow shorthand: in:stepId.path
 *  - Conditional shorthand: if:stepId.ok
 *  - Complex nested objects: inline JSON-like {...} syntax
 */

import { normalizeOperationUse } from '../services/batch/opShorthand';

// Pre-compiled regexes for toTOON hot path (avoid per-call RegExp allocation)
const TOON_NEEDS_QUOTE_RE = /[:\s,{}[\]]/;
const TOON_ESCAPE_QUOTE_RE = /"/g;

export function toTOON(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (TOON_NEEDS_QUOTE_RE.test(value)) {
      return `"${value.replace(TOON_ESCAPE_QUOTE_RE, '\\"')}"`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    // Single-pass filter+map: avoid intermediate array from .map().filter()
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const s = toTOON(value[i]);
      if (s) parts.push(s);
    }
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    // Single-pass filter+map+join: avoid .filter().map().join() triple iteration
    const parts: string[] = [];
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i];
      if (v !== null && v !== undefined && v !== '') {
        parts.push(`${k}:${toTOON(v)}`);
      }
    }
    return parts.length > 0 ? `{${parts.join(',')}}` : '';
  }
  return String(value);
}

// ============================================================================
// File-path compaction — groups arrays of objects by their file/path field
// ============================================================================

const FILE_KEYS = ['file', 'f', 'path'] as const;

/**
 * Detect the dominant file-path field in an array of objects.
 * Returns the key name if >50% of object entries share it, else null.
 */
function detectFileKey(arr: unknown[]): string | null {
  const counts: Record<string, number> = {};
  let objCount = 0;

  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      objCount++;
      const rec = item as Record<string, unknown>;
      for (const key of FILE_KEYS) {
        if (typeof rec[key] === 'string') {
          counts[key] = (counts[key] || 0) + 1;
          // Early exit: if any key already exceeds 50% threshold, return immediately
          if (counts[key] > objCount * 0.5 && objCount >= 2) return key;
        }
      }
    }
  }

  if (objCount < 2) return null;
  for (const key of FILE_KEYS) {
    if ((counts[key] || 0) > objCount * 0.5) return key;
  }
  return null;
}

/**
 * Recursively walk a JSON structure and group arrays-of-objects by their
 * file-path field (file/f/path). Replaces the array with an object keyed
 * by file path, removing the file field from each entry.
 *
 * Only groups when uniqueFiles < totalEntries (actual dedup benefit).
 * Also strips redundant `relative_path` fields during grouping.
 */
export function compactByFile(data: unknown): unknown {
  if (data === null || data === undefined || typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    let changed = false;
    const recursed: unknown[] = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const r = compactByFile(data[i]);
      recursed[i] = r;
      if (r !== data[i]) changed = true;
    }
    const arr = changed ? recursed : data;

    if (arr.length < 2) return arr;

    const fileKey = detectFileKey(arr);
    if (!fileKey) return arr;

    const fileValues = new Set<string>();
    let withKey = 0;
    for (const item of arr) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const val = (item as Record<string, unknown>)[fileKey];
        if (typeof val === 'string') {
          fileValues.add(val);
          withKey++;
        }
      }
    }

    if (fileValues.size >= withKey || withKey < arr.length * 0.5) return arr;

    const grouped: Record<string, unknown[]> = {};
    const ungrouped: unknown[] = [];

    for (const item of arr) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        const val = obj[fileKey];
        if (typeof val === 'string') {
          if (!grouped[val]) grouped[val] = [];
          const entry = { ...obj };
          delete entry[fileKey];
          delete entry['relative_path'];
          grouped[val].push(entry);
          continue;
        }
      }
      ungrouped.push(item);
    }

    if (ungrouped.length > 0) {
      grouped['_other'] = ungrouped;
    }
    return grouped;
  }

  const obj = data as Record<string, unknown>;
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const r = compactByFile(val);
    result[key] = r;
    if (r !== val) changed = true;
  }
  return changed ? result : obj;
}

// ============================================================================
// Public API
// ============================================================================

/** Default ceiling for TOON tool results (characters). */
export const FORMAT_RESULT_MAX_DEFAULT = 80000;

/** Search / FTS and memory-grep payloads can be large. */
export const FORMAT_RESULT_MAX_SEARCH = 120000;

/** Git status/diff payloads from `system.git`. */
export const FORMAT_RESULT_MAX_GIT = 100000;

/**
 * Format a tool result as TOON with a size ceiling.
 * Applies file-path compaction before serialization for token efficiency.
 */
export function formatResult(result: unknown, maxSize = FORMAT_RESULT_MAX_DEFAULT): string {
  const compacted = compactByFile(result);
  const toon = toTOON(compacted);
  if (toon.length > maxSize) {
    return toon.substring(0, maxSize) + '\n[truncated - narrow query]';
  }
  return toon;
}

/**
 * Serialize a value for token estimation / history metrics — no truncation.
 * Uses file compaction + TOON (aligned with batch `formatResult` without size cap).
 */
export function serializeForTokenEstimate(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(value);
  const compacted = compactByFile(value);
  return toTOON(compacted);
}

/**
 * Flatten Anthropic-style message content (string or block array) for token counting.
 * TOON-serializes object fields (`input`, tool_result `content`) instead of JSON.stringify.
 */
// ============================================================================
// Line-per-step batch parser (model tool_use input -> UnifiedBatchRequest)
// ============================================================================

const JSON_KEYWORDS = new Set(['true', 'false', 'null']);

/**
 * Minimal JS-object-to-JSON converter for inline nested objects.
 * Quotes unquoted keys and bare non-keyword identifier values.
 * Handles: {line:10,action:replace,content:"const x = 1;"} -> valid JSON.
 */
export function jsObjectToJson(input: string): string {
  const len = input.length;
  const out: string[] = [];
  let i = 0;

  while (i < len) {
    const ch = input[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out.push('"');
      i++;
      while (i < len && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < len) {
          if (quote !== '"' && input[i + 1] === quote) {
            out.push(quote);
            i += 2;
          } else {
            out.push(input[i], input[i + 1]);
            i += 2;
          }
        } else {
          const c = input[i];
          if (c === '\n') out.push('\\n');
          else if (c === '\r') out.push('\\r');
          else if (c === '\t') out.push('\\t');
          else if (c === '"' && quote !== '"') out.push('\\"');
          else out.push(c);
          i++;
        }
      }
      if (i < len) { out.push('"'); i++; }
    } else if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      const start = i;
      i++;
      while (i < len) {
        const c = input.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95) i++;
        else break;
      }
      const ident = input.slice(start, i);
      let j = i;
      while (j < len && (input[j] === ' ' || input[j] === '\n' || input[j] === '\r' || input[j] === '\t')) j++;
      if (j < len && input[j] === ':') {
        out.push('"', ident, '"');
      } else if (JSON_KEYWORDS.has(ident)) {
        out.push(ident);
      } else {
        out.push('"', ident, '"');
      }
    } else if (ch === ',') {
      let j = i + 1;
      while (j < len && (input[j] === ' ' || input[j] === '\n' || input[j] === '\r' || input[j] === '\t')) j++;
      if (j < len && (input[j] === '}' || input[j] === ']')) {
        i++;
      } else {
        out.push(',');
        i++;
      }
    } else {
      out.push(ch);
      i++;
    }
  }
  return out.join('');
}

/**
 * Tokenize a batch line into space-separated tokens, respecting quoted strings
 * and balanced braces/brackets (for inline JSON objects).
 */
function skipQuotedString(line: string, pos: number): number {
  const quote = line[pos];
  let i = pos + 1;
  const len = line.length;
  while (i < len && line[i] !== quote) {
    if (line[i] === '\\' && i + 1 < len) i += 2; else i++;
  }
  if (i < len) i++;
  return i;
}

function tokenizeBatchLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = line.length;

  while (i < len) {
    while (i < len && line[i] === ' ') i++;
    if (i >= len) break;

    const start = i;
    if (line[i] === '{' || line[i] === '[') {
      let depth = 0;
      let inQuote = false;
      let quoteChar = '"';
      while (i < len) {
        const c = line[i];
        if (inQuote) {
          if (c === '\\' && i + 1 < len) { i += 2; continue; }
          if (c === quoteChar) inQuote = false;
        } else {
          if (c === '"' || c === "'" || c === '`') { inQuote = true; quoteChar = c; }
          else if (c === '{' || c === '[') depth++;
          else if (c === '}' || c === ']') { depth--; if (depth === 0) { i++; break; } }
        }
        i++;
      }
      tokens.push(line.slice(start, i));
    } else if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      i = skipQuotedString(line, i);
      tokens.push(line.slice(start, i));
    } else {
      while (i < len && line[i] !== ' ') {
        const c = line[i];
        if (c === '"' || c === "'" || c === '`') {
          i = skipQuotedString(line, i);
        } else {
          i++;
        }
      }
      tokens.push(line.slice(start, i));
    }
  }
  return tokens;
}
const RE_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * Parse a value string from a key:value token.
 * Handles numbers, booleans, comma-separated arrays, JSON objects/arrays, and quoted strings.
 */
function parseParamValue(raw: string): unknown {
  if (raw === '' || raw === undefined) return true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;

  if (RE_NUMBER.test(raw)) return Number(raw);

  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(jsObjectToJson(raw));
    } catch {
      return raw;
    }
  }

  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
  }

  if (raw.includes(',') && !raw.includes('"')) {
    return raw.split(',').map(s => {
      const trimmed = s.trim();
      if (RE_NUMBER.test(trimmed)) return Number(trimmed);
      return trimmed;
    });
  }

  return raw;
}

/**
 * Expand dataflow shorthand: `in:r1.refs` -> `{ hashes: { from_step: "r1", path: "refs" } }`
 */
function expandDataflow(val: string): Record<string, unknown> {
  const dotIdx = val.indexOf('.');
  if (dotIdx === -1) return { hashes: { from_step: val, path: 'refs' } };
  return { hashes: { from_step: val.slice(0, dotIdx), path: val.slice(dotIdx + 1) } };
}

/**
 * Expand conditional shorthand: `if:e1.ok` -> `{ step_ok: "e1" }`
 * Used by line-per-step parsing and by JSON batch steps when `if` is a string.
 */
export function expandBatchIfShorthand(val: string): Record<string, unknown> {
  if (val.endsWith('.ok')) return { step_ok: val.slice(0, -3) };
  if (val.endsWith('.refs')) return { step_has_refs: val.slice(0, -5) };
  if (val.startsWith('!')) return { not: expandBatchIfShorthand(val.slice(1)) };
  return { step_ok: val };
}

/**
 * Parse the line-per-step batch format into a UnifiedBatchRequest.
 *
 * Format: one step per line, first two tokens are id and operation,
 * remaining tokens are key:value params.
 *
 * Example:
 *   r1 read.context type:smart file_paths:src/api.ts,src/db.ts
 *   p1 session.pin in:r1.refs
 *   v1 verify.typecheck if:e1.ok
 */
export function parseBatchLines(q: string): { version: '1.0'; steps: Record<string, unknown>[] } {
  const rawLines = q.split('\n');
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i].trim();
    if (t) lines.push(t);
  }
  const steps: Record<string, unknown>[] = [];

  for (const line of lines) {
    if (line.startsWith('@policy ') || line.startsWith('--') || line.startsWith('#')) continue;

    const tokens = tokenizeBatchLine(line);
    if (tokens.length < 2) continue;

    const id = tokens[0];
    const use = normalizeOperationUse(tokens[1]);
    const step: Record<string, unknown> = { id, use };
    const withParams: Record<string, unknown> = {};
    let hasWithParams = false;

    for (let t = 2; t < tokens.length; t++) {
      const token = tokens[t];
      const colonIdx = token.indexOf(':');
      if (colonIdx === -1) continue;

      const key = token.slice(0, colonIdx);
      const rawVal = token.slice(colonIdx + 1);

      // Detect bare hash refs (h:XXXX, possibly with :line-spec or :modifier).
      // These should accumulate into `hashes`, not become `{ h: "XXXX" }`.
      if (key === 'h' && /^[0-9a-f]/i.test(rawVal)) {
        const existing = withParams.hashes;
        const hashRef = token; // preserve full token including h: prefix
        if (Array.isArray(existing)) {
          existing.push(hashRef);
        } else {
          withParams.hashes = [hashRef];
        }
        hasWithParams = true;
        continue;
      }

      // Catch a recurring AI parser mistake: `hashes:in:r1.refs`. The AI is
      // trying to express "pin the refs produced by step r1" but packaged the
      // dataflow shorthand inside a `hashes:` value. Treat it as if they had
      // written `in:r1.refs`, promote to `step.in`, and surface a warning so
      // handlers can return a targeted hint instead of an opaque "bad hashes"
      // failure.
      if (key === 'hashes' && rawVal.startsWith('in:')) {
        const dataflow = rawVal.slice(3);
        if (/\.(refs|ok)$/.test(dataflow) || !dataflow.includes(':')) {
          step.in = expandDataflow(dataflow);
          const warnings = (step._parseWarnings as string[] | undefined) ?? [];
          warnings.push(
            `malformed \`hashes:in:${dataflow}\` rewritten to \`in:${dataflow}\` — use \`in:STEP.refs\` for dataflow, \`hashes:[h:...]\` for literal hashes`,
          );
          step._parseWarnings = warnings;
          continue;
        }
      }

      if (key === 'in') {
        step.in = expandDataflow(rawVal);
      } else if (key === 'if') {
        step.if = expandBatchIfShorthand(rawVal);
      } else if (key === 'on_error') {
        step.on_error = rawVal;
      } else {
        withParams[key] = parseParamValue(rawVal);
        hasWithParams = true;
      }
    }

    if (hasWithParams) step.with = withParams;
    steps.push(step);
  }

  return { version: '1.0' as const, steps };
}

/**
 * Expand batch Q-field args to a structured request.
 * If args.q is a string, parse it as line-per-step format.
 * If args already has version+steps (legacy JSON), pass through unchanged.
 * Sync and idempotent.
 */
export function expandBatchQ(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.q === 'string') {
    return parseBatchLines(args.q);
  }
  return args;
}

// ============================================================================
// Message content serialization (token estimation)
// ============================================================================

export function serializeMessageContentForTokens(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return serializeForTokenEstimate(content);
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      parts.push(serializeForTokenEstimate(block));
      continue;
    }
    const b = block as Record<string, unknown>;
    const type = typeof b.type === 'string' ? b.type : '';
    if (type === 'tool_use' && b.input !== undefined) {
      const name = typeof b.name === 'string' ? b.name : '';
      const id = typeof b.id === 'string' ? b.id : '';
      parts.push(
        `{type:tool_use,name:${serializeForTokenEstimate(name)},id:${serializeForTokenEstimate(id)},input:${serializeForTokenEstimate(b.input)}}`,
      );
      continue;
    }
    if (type === 'tool_result') {
      const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
      const c = b.content;
      const inner = typeof c === 'string' ? c : serializeForTokenEstimate(c);
      parts.push(`{type:tool_result,tool_use_id:${serializeForTokenEstimate(id)},content:${inner}}`);
      continue;
    }
    if (type === 'text') {
      const text =
        typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '';
      parts.push(text);
      continue;
    }
    parts.push(serializeForTokenEstimate(block));
  }
  return parts.join('\n');
}
