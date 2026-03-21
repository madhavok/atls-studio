/**
 * Frontend hash reference resolver — resolves h:XXXX refs from context store + chat DB.
 * Mirrors backend resolve_hash_refs; used before atls_batch_query so backend receives
 * resolved params.
 *
 * HPP v2: Extended with ShapeOp, DiffRef, SymbolAnchor parsing.
 * HPP v3: Set references (h:@selector) for multi-hash operations.
 * HPP v4: Recency refs (h:$last / h:$last-N) for intra-batch hash chaining.
 */

import { sliceContentByLines, SHORT_HASH_LEN } from './contextHash';
import { parseModifierChain } from './hashModifierParser';
import { applyShape, dedent } from './shapeOps';
import { resolveSymbolToLines } from './symbolResolver';
import { parseHashRef, parseDiffRef, parseSetExpression, parseSetRef } from './hashRefParsers';
import type {
  CompositeSetRef,
  HashModifierV2,
  ParsedDiffRef,
  ParsedHashRef,
  ParsedSetExpression,
  ParsedSetRef,
  SetRefExpansion,
  SetRefResult,
  SetSelector,
  ShapeOp,
} from './uhppTypes';
export { parseHashRef, parseDiffRef, parseSetExpression, parseSetRef } from './hashRefParsers';
export type {
  CompositeSetRef,
  HashModifierV2,
  ParsedDiffRef,
  ParsedHashRef,
  ParsedSetExpression,
  ParsedSetRef,
  SetRefExpansion,
  SetRefResult,
  SetSelector,
  ShapeOp,
} from './uhppTypes';

// ---------------------------------------------------------------------------
// HPP v4: Recency ref resolution (h:$last, h:$last-1, etc.)
// ---------------------------------------------------------------------------

const RECENCY_PATTERN = /h:\$last(?:-(\d+))?/g;
const RECENCY_EDIT_PATTERN = /h:\$last_edit(?:-(\d+))?/g;
const RECENCY_READ_PATTERN = /h:\$last_read(?:-(\d+))?/g;
const RECENCY_STAGE_PATTERN = /h:\$last_stage(?:-(\d+))?/g;

/**
 * Replace all h:$last-N, h:$last_edit-N, h:$last_read-N, h:$last_stage-N
 * occurrences in a string with real hashes from the typed recency stacks.
 * Unresolvable refs are left as-is.
 */
let _resolveRecencyRef: ((offset: number) => string | null) | null = null;
let _resolveEditRecencyRef: ((offset: number) => string | null) | null = null;
let _resolveReadRecencyRef: ((offset: number) => string | null) | null = null;
let _resolveStageRecencyRef: ((offset: number) => string | null) | null = null;

/** Register the recency resolver from contextStore (called once at init). */
export function setRecencyResolver(fn: (offset: number) => string | null): void {
  _resolveRecencyRef = fn;
}

/** Register the edit recency resolver (for h:$last_edit in undo params). */
export function setEditRecencyResolver(fn: (offset: number) => string | null): void {
  _resolveEditRecencyRef = fn;
}

/** Register the read recency resolver (for h:$last_read — file reads only). */
export function setReadRecencyResolver(fn: (offset: number) => string | null): void {
  _resolveReadRecencyRef = fn;
}

/** Register the stage recency resolver (for h:$last_stage — staged snippets only). */
export function setStageRecencyResolver(fn: (offset: number) => string | null): void {
  _resolveStageRecencyRef = fn;
}

export function resolveRecencyInString(text: string): string {
  const trimmed = text.trim();

  // Match recency refs with optional trailing modifier chain (e.g. h:$last:60-80, h:$last_edit:sig)
  const editMatch = /^(h:\$last_edit(?:-(\d+))?)(?=:|$)/.exec(trimmed);
  if (editMatch && _resolveEditRecencyRef) {
    const offset = editMatch[2] ? parseInt(editMatch[2], 10) : 0;
    const real = _resolveEditRecencyRef(offset);
    return real ? text.replace(editMatch[1], `h:${real}`) : text;
  }

  const readMatch = /^(h:\$last_read(?:-(\d+))?)(?=:|$)/.exec(trimmed);
  if (readMatch && _resolveReadRecencyRef) {
    const offset = readMatch[2] ? parseInt(readMatch[2], 10) : 0;
    const real = _resolveReadRecencyRef(offset);
    return real ? text.replace(readMatch[1], `h:${real}`) : text;
  }

  const stageMatch = /^(h:\$last_stage(?:-(\d+))?)(?=:|$)/.exec(trimmed);
  if (stageMatch && _resolveStageRecencyRef) {
    const offset = stageMatch[2] ? parseInt(stageMatch[2], 10) : 0;
    const real = _resolveStageRecencyRef(offset);
    return real ? text.replace(stageMatch[1], `h:${real}`) : text;
  }

  // h:$last must be checked last — it's a prefix of the specialized variants
  const match = /^(h:\$last(?:-(\d+))?)(?=:|$)/.exec(trimmed);
  if (!match || !_resolveRecencyRef) {
    return text;
  }

  const offset = match[2] ? parseInt(match[2], 10) : 0;
  const real = _resolveRecencyRef(offset);
  return real ? text.replace(match[1], `h:${real}`) : text;
}

const FILE_FIELDS = ['file', 'file_path', 'file_paths', 'target_file', 'source_file', 'path', 'from', 'from_path', 'target', 'target_path', 'deletes', 'delete'];
const HASH_FIELDS = ['hash', 'content_hash', 'old_hash', 'new_hash', 'undo', 'hashes', 'refs', 'to', 'edit_target_hash'];
const SYMBOL_FIELDS = ['symbol', 'symbol_name', 'name'];
/** Ref strings that must not be expanded to file content by resolveHashRefsInParams.
 * `ref` is used by read.lines as h:HASH:lines — expanding to content breaks line extraction. */
const PASSTHROUGH_REF_FIELDS = new Set(['edit_target_ref', 'ref']);

/** Fields where inline h:ref replacement within larger strings is allowed. */
const INLINE_RESOLVE_FIELDS = new Set([
  'query', 'queries', 'message', 'summary', 'description',
  'key', 'value', 'comment', 'label', 'content',
]);

/** Array keys whose child objects contain literal file content — inline h:ref
 *  expansion inside these would corrupt code being written to disk. */
const LITERAL_CONTENT_ARRAYS = new Set(['line_edits', 'creates', 'edits']);

/** All UHPP symbol anchor prefixes. Mirrors Rust UHPP_ANCHOR_PREFIXES. */
const UHPP_ANCHOR_PREFIXES: Array<[string, string | null]> = [
  ['fn', 'fn'], ['sym', null], ['cls', 'cls'], ['class', 'cls'],
  ['struct', 'struct'], ['trait', 'trait'], ['interface', 'trait'],
  ['protocol', 'protocol'], ['enum', 'enum'], ['record', 'record'],
  ['extension', 'extension'], ['mixin', 'mixin'], ['impl', 'impl'],
  ['type', 'type'], ['const', 'const'], ['static', 'static'],
  ['mod', 'mod'], ['ns', 'mod'], ['namespace', 'mod'], ['package', 'mod'],
  ['macro', 'macro'], ['ctor', 'ctor'], ['property', 'property'],
  ['field', 'field'], ['enum_member', 'enum_member'], ['variant', 'enum_member'],
  ['operator', 'operator'], ['event', 'event'], ['object', 'object'],
  ['actor', 'actor'], ['union', 'union'],
];

const UHPP_ANCHOR_KINDS_RE = UHPP_ANCHOR_PREFIXES.map(([p]) => p).join('|');
const HASH_MODIFIER_TOKEN_RE =
  `(?:[0-9]+(?:-[0-9]*)?(?:,[0-9]+(?:-[0-9]*)?)*|(?:${UHPP_ANCHOR_KINDS_RE})\\([^)]+\\)|sig|fold|dedent|nocomment|imports|exports|content|source|tokens|meta|lang|head\\(\\d+\\)|tail\\(\\d+\\)|grep\\([^)]+\\)|ex\\([^)]+\\)|hl\\([^)]+\\)|concept\\([^)]+\\)|pattern\\([^)]+\\)|if\\([^)]+\\))`;

/** Lightweight regex for detecting h:refs anywhere in a string (non-global for testing). */
const INLINE_HREF_DETECT = new RegExp(
  `h:[0-9a-fA-F]{6,16}(?::${HASH_MODIFIER_TOKEN_RE})*`
);

/** Resolve all inline h:refs embedded in a larger string. */
async function resolveInlineRefs(
  text: string,
  fieldName: string | undefined,
  lookup: HashLookup,
): Promise<string> {
  if (!text.includes('h:')) return text;
  const pattern = new RegExp(INLINE_HREF_DETECT.source, 'g');
  const matches: { match: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    matches.push({ match: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (matches.length === 0) return text;

  let result = '';
  let cursor = 0;
  for (const { match, start, end } of matches) {
    result += text.slice(cursor, start);
    const parsed = parseHashRef(match);
    if (parsed) {
      try {
        const resolved = await resolveSingle(parsed, fieldName, lookup);
        result += resolved;
      } catch {
        result += match;
      }
    } else {
      result += match;
    }
    cursor = end;
  }
  result += text.slice(cursor);
  return result;
}

export interface HashLookupResult {
  content: string;
  source?: string;
}

export type HashLookup = (hash: string) => Promise<HashLookupResult | null>;

export type SetRefLookup = (selector: SetSelector) => SetRefResult<HashLookupResult>;

// ---------------------------------------------------------------------------
// Regex for h:ref detection in text (used by frontend scanners)
// ---------------------------------------------------------------------------

/** Matches h:XXXX with optional modifiers, including diff refs. */
export const HREF_PATTERN = new RegExp(
  `h:[0-9a-fA-F]{6,16}(?:\\.\\.[h:]?[0-9a-fA-F]{6,16})?(?::${HASH_MODIFIER_TOKEN_RE})*`,
  'g',
);

/** Matches h:bb:keyname blackboard references. Keys may contain alphanumerics, underscores, hyphens, dots, colons. */
export const BB_REF_PATTERN = /h:bb:[a-zA-Z0-9_.\-:]+/g;

/** Matches h:@selector with optional modifier chain (includes temporal + workspace refs). */
export const SET_REF_PATTERN = /h:@(?:sub:[a-zA-Z0-9_-]+|file=[^\s:]+|type=[a-z:]+|edited|latest(?::\d+)?|pinned|all|stale|dormant|HEAD(?:~\d+)?:[^\s:]+|tag:[^\s:]+:[^\s:]+|commit:[0-9a-fA-F]+:[^\s:]+|ws:[a-zA-Z0-9_@/.#-]+|search\([^\n)]*\))(?::(?:sig|fold|dedent|nocomment|imports|exports|diff|concept|pattern|if)(?:\([^)]*\))?)?/g;

const SHAPE_KEYWORDS = new Set(['sig', 'fold', 'dedent', 'nocomment', 'imports', 'exports']);

/**
 * Resolve a single h: ref using the lookup. Returns the resolved string.
 */
async function resolveSingle(
  parsed: ParsedHashRef,
  fieldName: string | undefined,
  lookup: HashLookup
): Promise<string> {
  const { hash, modifier } = parsed;
  const lowerField = fieldName?.toLowerCase();

  if (lowerField && HASH_FIELDS.includes(lowerField)) {
    return hash;
  }

  const entry = await lookup(hash);
  if (!entry) throw new Error(`Hash h:${hash} not found — content may have been evicted or never loaded`);
  if (lowerField && FILE_FIELDS.some(f => lowerField.includes(f)) && modifier !== 'auto') {
    if (!entry.source) throw new Error(`Hash h:${hash} has no source path (may be from search/tool output)`);
    return entry.source;
  }
  if (!entry.content && modifier !== 'source') {
    throw new Error(`Hash h:${hash} has no content (may be compacted — use recall() to re-materialize)`);
  }

  if (modifier === 'source') {
    if (!entry.source) throw new Error(`Hash h:${hash} has no source path (may be from search/tool output)`);
    return entry.source;
  }

  if (modifier === 'content') return entry.content;

  if (modifier === 'auto') return resolveAuto(fieldName, entry);

  if (typeof modifier === 'object' && 'lines' in modifier) {
    const lineSpec = modifier.lines
      .map(([s, e]) => (e == null ? `${s}-` : s === e ? `${s}` : `${s}-${e}`))
      .join(',');
    let extracted = sliceContentByLines(entry.content, lineSpec, true);
    if ('shape' in modifier && modifier.shape) {
      extracted = applyShape(extracted, modifier.shape);
    }
    return extracted;
  }

  if (typeof modifier === 'object' && 'shape' in modifier) {
    return applyShape(entry.content, modifier.shape);
  }

  if (typeof modifier === 'object' && 'symbol' in modifier) {
    const { kind, name, shape } = modifier.symbol;
    const range = resolveSymbolToLines(entry.content, kind, name);
    if (!range) {
      throw new Error(`Symbol '${name}' not found in h:${hash} — content may be shaped (use full-content hash)`);
    }
    const lineSpec = `${range[0]}-${range[1]}`;
    let extracted = sliceContentByLines(entry.content, lineSpec, true);
    if (shape) extracted = applyShape(extracted, shape);
    return extracted;
  }

  // Warn on parser-only semantic modifiers that have no runtime implementation
  if (typeof modifier === 'object') {
    const mod = modifier as Record<string, unknown>;
    if ('concept' in mod) {
      console.warn(`[HPP] :concept(${mod.concept}) is parser-only — returning unfiltered content`);
      return `[WARNING: :concept(${mod.concept}) modifier is not yet implemented — content returned unfiltered]\n${entry.content}`;
    }
    if ('pattern' in mod) {
      console.warn(`[HPP] :pattern(${mod.pattern}) is parser-only — returning unfiltered content`);
      return `[WARNING: :pattern(${mod.pattern}) modifier is not yet implemented — content returned unfiltered]\n${entry.content}`;
    }
    if ('if' in mod) {
      console.warn(`[HPP] :if(${mod.if}) is parser-only — returning unfiltered content`);
      return `[WARNING: :if(${mod.if}) modifier is not yet implemented — content returned unfiltered]\n${entry.content}`;
    }
  }

  return entry.content;
}

/**
 * Resolve based on field name for Auto modifier.
 * HPP v3: expanded field categories for symbol, path array, and hash array fields.
 */
function resolveAuto(fieldName: string | undefined, entry: HashLookupResult): string {
  if (fieldName) {
    const lower = fieldName.toLowerCase();
    if (FILE_FIELDS.some(f => lower.includes(f))) {
      if (!entry.source) throw new Error(`Hash has no source path for field '${fieldName}'`);
      return entry.source;
    }
    if (SYMBOL_FIELDS.some(f => lower.includes(f))) {
      return extractSymbolName(entry) ?? entry.content;
    }
  }
  return entry.content;
}

function resolveSetEntryValue(
  entry: HashLookupResult,
  hash: string,
  fieldName: string | undefined,
  modifier: HashModifierV2,
): string {
  if (fieldName && HASH_FIELDS.includes(fieldName)) return hash;
  if (fieldName && FILE_FIELDS.some(f => fieldName.toLowerCase().includes(f))) {
    if (!entry.source) throw new Error(`Hash h:${hash} has no source path for file-path field '${fieldName}'`);
    return entry.source;
  }
  if (modifier === 'auto') {
    if (entry.source) return entry.source;
    if (!fieldName) throw new Error(`Hash h:${hash} has no source path and no field context — cannot resolve auto in set expansion`);
    return resolveAuto(fieldName, entry);
  }
  if (modifier === 'content') return entry.content;
  if (modifier === 'source') return entry.source ?? entry.content;

  if (typeof modifier === 'object' && 'lines' in modifier) {
    const lineSpec = modifier.lines
      .map(([start, end]) => (end == null ? `${start}-` : start === end ? `${start}` : `${start}-${end}`))
      .join(',');
    let extracted = sliceContentByLines(entry.content, lineSpec, true);
    if ('shape' in modifier && modifier.shape) {
      extracted = applyShape(extracted, modifier.shape);
    }
    return extracted;
  }

  if (typeof modifier === 'object' && 'shape' in modifier) {
    return applyShape(entry.content, modifier.shape);
  }

  if (typeof modifier === 'object' && 'symbol' in modifier) {
    const { kind, name, shape } = modifier.symbol;
    const range = resolveSymbolToLines(entry.content, kind, name);
    if (!range) return entry.content;
    const lineSpec = `${range[0]}-${range[1]}`;
    let extracted = sliceContentByLines(entry.content, lineSpec, true);
    if (shape) extracted = applyShape(extracted, shape);
    return extracted;
  }

  const mod = modifier as unknown as Record<string, unknown>;
  if ('concept' in mod) {
    return `[WARNING: :concept(${mod.concept}) modifier is not yet implemented — content returned unfiltered]\n${entry.content}`;
  }
  if ('pattern' in mod) {
    return `[WARNING: :pattern(${mod.pattern}) modifier is not yet implemented — content returned unfiltered]\n${entry.content}`;
  }
  if ('if' in mod) {
    return `[WARNING: :if(${mod.if}) modifier is not yet implemented — content returned unfiltered]\n${entry.content}`;
  }

  return entry.content;
}

/** Extract primary symbol name from digest metadata if available */
function extractSymbolName(entry: HashLookupResult): string | null {
  if (!entry.content) return null;
  const match = entry.content.match(/^(?:fn|cls|struct|iface|enum|type|trait)\s+(\w+)/m);
  return match ? match[1] : null;
}

export interface SetRefResolution {
  values: string[];
  expansion: SetRefExpansion;
}

/**
 * Resolve a set reference to an array of values, applying the modifier to each entry.
 * For file/hash fields, returns source paths or raw hashes. Otherwise returns content.
 * Returns expansion metadata for transparency.
 */
/**
 * Resolve a composite set ref (union/intersection/difference) by resolving
 * both sides and combining the results.
 */
export function resolveCompositeSetRef(
  composite: CompositeSetRef,
  rawRef: string,
  fieldName: string | undefined,
  setLookup: SetRefLookup,
): SetRefResolution {
  const left: SetRefResult<HashLookupResult> = setLookup(composite.left);
  const right: SetRefResult<HashLookupResult> = setLookup(composite.right);
  const leftSet = new Set(left.hashes);
  const rightSet = new Set(right.hashes);

  let resultHashes: string[] = [];
  let resultEntries: HashLookupResult[] = [];

  switch (composite.op) {
    case '+': {
      // Union: all from left + all from right not already in left
      resultHashes = [...left.hashes];
      resultEntries = [...left.entries];
      for (let i = 0; i < right.hashes.length; i++) {
        if (!leftSet.has(right.hashes[i])) {
          resultHashes.push(right.hashes[i]);
          resultEntries.push(right.entries[i]);
        }
      }
      break;
    }
    case '&': {
      // Intersection: only hashes in both
      resultHashes = [];
      resultEntries = [];
      for (let i = 0; i < left.hashes.length; i++) {
        if (rightSet.has(left.hashes[i])) {
          resultHashes.push(left.hashes[i]);
          resultEntries.push(left.entries[i]);
        }
      }
      break;
    }
    case '-': {
      // Difference: left minus right
      resultHashes = [];
      resultEntries = [];
      for (let i = 0; i < left.hashes.length; i++) {
        if (!rightSet.has(left.hashes[i])) {
          resultHashes.push(left.hashes[i]);
          resultEntries.push(left.entries[i]);
        }
      }
      break;
    }
  }

  const expansion: SetRefExpansion = {
    ref: rawRef,
    matchedCount: resultEntries.length,
    hashes: resultHashes.map(h => `h:${h.slice(0, SHORT_HASH_LEN)}`),
    sources: resultEntries.map((e) => e.source ?? '(no source)'),
  };

  const isFileField = fieldName
    ? FILE_FIELDS.some(f => fieldName.toLowerCase().includes(f))
    : false;
  const isHashField = fieldName ? HASH_FIELDS.includes(fieldName) : false;

  const values = resultEntries.map((entry, i) => {
    if (isHashField) return resultHashes[i];
    if (isFileField) return entry.source ?? resultHashes[i];
    return resolveSetEntryValue(entry, resultHashes[i], fieldName, composite.modifier);
  });

  return { values, expansion };
}

export function resolveSetRefToValues(
  setRef: ParsedSetRef,
  rawRef: string,
  fieldName: string | undefined,
  setLookup: SetRefLookup,
): SetRefResolution {
  const result: SetRefResult<HashLookupResult> = setLookup(setRef.selector);
  const { entries, hashes, error } = result;

  if (error) {
    throw new Error(`Set ref ${rawRef} failed: ${error}`);
  }

  const expansion: SetRefExpansion = {
    ref: rawRef,
    matchedCount: entries.length,
    hashes: hashes.map(h => `h:${h.slice(0, SHORT_HASH_LEN)}`),
    sources: entries.map((e) => e.source ?? '(no source)'),
  };

  if (entries.length === 0) return { values: [], expansion };

  const isFileField = fieldName
    ? FILE_FIELDS.some(f => fieldName.toLowerCase().includes(f))
    : false;
  const isHashField = fieldName ? HASH_FIELDS.includes(fieldName) : false;

  const values = entries.map((entry, i) => {
    if (isHashField) return hashes[i];
    if (isFileField) return entry.source ?? hashes[i];
    return resolveSetEntryValue(entry, hashes[i], fieldName, setRef.modifier);
  });

  return { values, expansion };
}

export interface ResolveResult {
  params: unknown;
  setRefExpansions: SetRefExpansion[];
}

/**
 * Recursively walk params and resolve all h: refs (single and set).
 * Set refs (h:@selector) in array-valued fields expand to arrays of resolved values.
 * Set refs in string-valued fields resolve to comma-separated values.
 * Returns resolved params + expansion metadata for set refs.
 */
export async function resolveHashRefsInParams(
  params: unknown,
  lookup: HashLookup,
  parentKey?: string,
  setLookup?: SetRefLookup,
  _expansions?: SetRefExpansion[],
): Promise<unknown> {
  const expansions = _expansions ?? [];
  const result = await _resolveInner(params, lookup, parentKey, setLookup, expansions, false);
  return result;
}

/**
 * Same as resolveHashRefsInParams but returns structured result with expansion metadata.
 */
export async function resolveHashRefsWithMeta(
  params: unknown,
  lookup: HashLookup,
  parentKey?: string,
  setLookup?: SetRefLookup,
): Promise<ResolveResult> {
  const expansions: SetRefExpansion[] = [];
  const resolved = await _resolveInner(params, lookup, parentKey, setLookup, expansions, false);
  return { params: resolved, setRefExpansions: expansions };
}

async function _resolveInner(
  params: unknown,
  lookup: HashLookup,
  parentKey: string | undefined,
  setLookup: SetRefLookup | undefined,
  expansions: SetRefExpansion[],
  skipInline: boolean,
): Promise<unknown> {
  if (params === null || params === undefined) return params;

  if (typeof params === 'string') {
    // HPP v4: resolve recency refs (h:$last-N) before any other parsing
    const resolved = resolveRecencyInString(params);
    if (parentKey && PASSTHROUGH_REF_FIELDS.has(parentKey)) return resolved;

    if (setLookup) {
        const setExpr = parseSetExpression(resolved);
        if (setExpr) {
          if ('left' in setExpr) {
            const { values, expansion } = resolveCompositeSetRef(setExpr, resolved, parentKey, setLookup);
            expansions.push(expansion);
            return values.length === 1 ? values[0] : values;
          }
          if (isTemporalSelector(setExpr.selector)) {
            const content = await resolveTemporalRef(setExpr.selector, setExpr.modifier);
            if (content !== null) return content;
            return resolved;
          }
          const { values, expansion } = resolveSetRefToValues(setExpr, resolved, parentKey, setLookup);
          expansions.push(expansion);
          return values.length === 1 ? values[0] : values;
        }
      }
    const diffRef = parseDiffRef(resolved);
    if (diffRef) {
      return resolved;
    }

    const parsed = parseHashRef(resolved);
    if (parsed) {
      try {
        return await resolveSingle(parsed, parentKey, lookup);
      } catch (e) {
        console.warn(`[HPP] hash ref unresolved: h:${parsed.hash} (field: ${parentKey ?? '?'}):`, e);
        return resolved;
      }
    }
    // Inline resolution: scan for embedded h:refs in content-bearing fields
    // Skip when inside literal-content arrays (line_edits, creates, edits) to
    // prevent hash patterns in file content from being expanded.
    if (!skipInline && parentKey && INLINE_RESOLVE_FIELDS.has(parentKey) && resolved.includes('h:') && INLINE_HREF_DETECT.test(resolved)) {
      return await resolveInlineRefs(resolved, parentKey, lookup);
    }
    return resolved;
  }

  if (typeof params !== 'object') return params;

  if (Array.isArray(params)) {
    const fieldName = parentKey;
    const expanded: unknown[] = [];
    for (const item of params) {
      if (typeof item === 'string' && setLookup) {
        const setExpr = parseSetExpression(item);
        if (setExpr) {
          const { values, expansion } = 'left' in setExpr
            ? resolveCompositeSetRef(setExpr, item, fieldName, setLookup)
            : resolveSetRefToValues(setExpr, item, fieldName, setLookup);
          expansions.push(expansion);
          expanded.push(...values);
          continue;
        }
      }
      expanded.push(await _resolveInner(item, lookup, fieldName, setLookup, expansions, skipInline));
    }
    return expanded;
  }

  const obj = params as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const childSkipInline = skipInline || LITERAL_CONTENT_ARRAYS.has(key);
    if (typeof val === 'string') {
      // HPP v4: resolve recency refs (h:$last-N) in object values (e.g. undo:"h:$last")
      const resolvedVal = resolveRecencyInString(val);
      if (PASSTHROUGH_REF_FIELDS.has(key)) {
        result[key] = resolvedVal;
        continue;
      }
      if (setLookup) {
        const setExpr = parseSetExpression(resolvedVal);
        if (setExpr) {
          const { values, expansion } = 'left' in setExpr
            ? resolveCompositeSetRef(setExpr, resolvedVal, key, setLookup)
            : resolveSetRefToValues(setExpr, resolvedVal, key, setLookup);
          expansions.push(expansion);
          result[key] = values;
          continue;
        }
      }
      const parsed = parseHashRef(resolvedVal);
      if (parsed) {
        try {
          result[key] = await resolveSingle(parsed, key, lookup);
        } catch (e) {
          console.warn(`[HPP] hash ref unresolved: h:${parsed.hash} (field: ${key}):`, e);
          result[key] = resolvedVal;
        }
      } else if (!childSkipInline && INLINE_RESOLVE_FIELDS.has(key) && INLINE_HREF_DETECT.test(resolvedVal)) {
        result[key] = await resolveInlineRefs(resolvedVal, key, lookup);
      } else {
        result[key] = resolvedVal;
      }
    } else if (val !== null && typeof val === 'object') {
      result[key] = await _resolveInner(val, lookup, key, setLookup, expansions, childSkipInline);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// HPP v4: Temporal ref helpers
// ---------------------------------------------------------------------------

export function isTemporalSelector(sel: SetSelector): sel is
  | { kind: 'head'; path: string; offset?: number }
  | { kind: 'tag'; name: string; path: string }
  | { kind: 'commit'; sha: string; path: string } {
  return sel.kind === 'head' || sel.kind === 'tag' || sel.kind === 'commit';
}

/**
 * Resolve a temporal ref by calling the backend `resolve_temporal_ref` Tauri command.
 * Returns the file content at the specified git revision, or null on failure.
 */
export async function resolveTemporalRef(
  selector: { kind: 'head'; path: string; offset?: number }
    | { kind: 'tag'; name: string; path: string }
    | { kind: 'commit'; sha: string; path: string },
  modifier: HashModifierV2,
): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    let gitRef: string;
    let path: string;

    switch (selector.kind) {
      case 'head':
        gitRef = selector.offset ? `HEAD~${selector.offset}` : 'HEAD';
        path = selector.path;
        break;
      case 'tag':
        gitRef = selector.name;
        path = selector.path;
        break;
      case 'commit':
        gitRef = selector.sha;
        path = selector.path;
        break;
    }

    const result = await invoke<{ content: string; hash: string }>('resolve_temporal_ref', {
      gitRef,
      path,
      shape: modifier !== 'auto' ? formatModifier(modifier) : null,
    });

    return result.content;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[HPP] temporal ref resolution failed:`, msg);
    return null;
  }
}

/** Format a modifier back to string form for passing to backend. */
function formatModifier(mod: HashModifierV2): string | null {
  if (mod === 'auto') return null;
  if (typeof mod === 'string') return mod;
  if (typeof mod === 'object' && 'shape' in mod && typeof mod.shape === 'string') return mod.shape;
  if (typeof mod === 'object' && 'lines' in mod) {
    const lineSpec = mod.lines
      .map(([start, end]) => (end == null ? `${start}-` : start === end ? `${start}` : `${start}-${end}`))
      .join(',');
    if ('shape' in mod && mod.shape && typeof mod.shape === 'string') return `${lineSpec}:${mod.shape}`;
    return lineSpec;
  }
  if (typeof mod === 'object' && 'symbol' in mod) {
    const { kind, name, shape } = mod.symbol;
    const symbolSpec = `${kind ?? 'sym'}(${name})`;
    if (shape && typeof shape === 'string') return `${symbolSpec}:${shape}`;
    return symbolSpec;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shape and symbol helpers (mirror backend shape_ops)
// ---------------------------------------------------------------------------

/**
 * Resolve symbol anchor to 1-based [startLine, endLine] range.
 * Returns null if not found.
 */