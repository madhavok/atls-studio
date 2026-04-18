/**
 * Tool-result compression encoder.
 *
 * Pairs with the `formatResult` seam in `./toon.ts`. When the chat-level
 * compression toggle is on, the serialized output of `formatResult` is fed
 * through `encodeToolResult` before being returned to the handler.
 *
 * Self-registers with `toon.ts` at module load via
 * `registerCompressionProvider(...)`; see the `__compressionWired` named
 * export at the bottom of this file. That anchor exists so `sy
 * __compressionWired` surfaces the wiring without having to scan the file
 * tail for a trailing module-level call.
 *
 * See `docs/input-compression-merit.md` for scope, risks, and kill criteria.
 *
 * ---------------------------------------------------------------------------
 * Namespace safety
 * ---------------------------------------------------------------------------
 *
 * The encoded form does not conflate with any existing ATLS batch-input
 * shorthand. Three rules enforce this:
 *
 * 1. Substring-dictionary codes use the prefix `~` with numeric suffixes
 *    (`~1`, `~2`, ...). `~` appears nowhere in the existing namespace:
 *    not in op shorthands (SHORT_TO_OP), not in param aliases (PARAM_SHORT /
 *    GLOBAL_ALIASES), not in hash refs (`h:`, `h:@`, `h:$`), not in
 *    conditional shorthands (`!`, `if:`, `in:`, `out:`). Crucially, `$`
 *    is NOT used — reserved for named bindings.
 *
 * 2. Key abbreviations in the legend's `k` section reuse an existing alias
 *    from GLOBAL_ALIASES or PARAM_SHORT when one applies. New codes are
 *    coined only for keys with no existing alias, and each new code is
 *    validated against SHORT_TO_OP / reserved-prefix rules.
 *
 * 3. v1 does NOT code enum values. Deferred to v2.
 *
 * ---------------------------------------------------------------------------
 * Legend format
 * ---------------------------------------------------------------------------
 *
 *   <<dict
 *    k f=file
 *    k ps=file_paths
 *    s ~1=src/services/batch/handlers/
 *    d ^
 *   >>
 *   <body>
 *
 * Each legend entry is on its own line, section marker first. This lets
 * substring literals contain spaces safely (newline is the forbidden char).
 */

import { countTokensSync } from './tokenCounter';
import { registerCompressionProvider } from './toon';
import { useAppStore } from '../stores/appStore';
import { GLOBAL_ALIASES } from '../services/batch/paramNorm';
import { PARAM_SHORT, SHORT_TO_OP } from '../services/batch/opShorthand';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompressionResult {
  encoded: string;
  /** Key-abbreviation map (encoded-key -> raw-key) recovered from the legend. */
  keyMap: Map<string, string>;
  /** Substring dictionary (code -> literal). Codes are always `~N`. */
  substrings: Map<string, string>;
  /** Declared ditto glyph. Single char when ditto was applied, '' otherwise. */
  dittoGlyph: string;
  rawTokens: number;
  encodedTokens: number;
  savedTokens: number;
  savedPct: number;
}

export interface EncodeOptions {
  minSavedPct?: number;
  maxDictEntries?: number;
  minDictKeyLength?: number;
  minKeyLengthForAbbrev?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LEGEND_OPEN = '<<dict';
export const LEGEND_CLOSE = '>>\n';
export const LEGEND_SECTION_KEYS = 'k';
export const LEGEND_SECTION_SUBSTRINGS = 's';
export const LEGEND_SECTION_DITTO = 'd';
export const SUBSTRING_CODE_PREFIX = '~';
export const DEFAULT_DITTO_GLYPH = '^';
export const SUBSTRING_CODE_PATTERN = /~\d+/g;

const DEFAULT_OPTS: Required<EncodeOptions> = {
  minSavedPct: 10,
  maxDictEntries: 32,
  minDictKeyLength: 4,
  minKeyLengthForAbbrev: 3,
};

/** Inputs smaller than this are never worth encoding (legend overhead dominates). */
const MIN_RAW_BYTES = 256;

/** Max substring length to consider for dict coding. */
const SUBSTRING_MAX_LEN = 32;

/** Min occurrences for a key to be worth abbreviating. */
const MIN_KEY_OCCURRENCES = 3;

/** Min occurrences for a substring to be worth coding. */
const MIN_SUBSTRING_OCCURRENCES = 3;

/** TOON structural chars — substring candidates may not cross these. */
const STRUCTURAL_BOUNDARIES = new Set<string>(['{', '}', '[', ']', ',', ':', '"']);

/** Natural content breaks (path segment separators, punctuation). A substring
 *  may end at these positions even though they aren't TOON structure — lets
 *  us code shared prefixes like `src/services/` across unique full paths. */
const CONTENT_BOUNDARIES = new Set<string>(['/', '.', '-', '_']);

/** Characters forbidden INSIDE a substring-dict candidate. Includes all
 *  structural chars so a code never spans a k:v separator, row boundary,
 *  or nested-object edge. Newlines also forbidden (break legend format). */
const FORBIDDEN_INSIDE_SUBSTRING = new Set<string>([
  '{', '}', '[', ']', ',', ':', '"', '\n',
]);

/** Detects a raw bare `^` as a standalone value (would collide with ditto glyph). */
const BARE_GLYPH_VALUE_RE = /[,{[][^,{[\]:]*:\^[,}\]]/;

export function hasCompressionLegend(s: string): boolean {
  return typeof s === 'string' && s.startsWith(LEGEND_OPEN);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function encodeToolResult(raw: string, opts?: EncodeOptions): CompressionResult | null {
  if (typeof raw !== 'string' || raw.length < MIN_RAW_BYTES) return null;
  const o = { ...DEFAULT_OPTS, ...opts };
  const rawTokens = countTokensSync(raw);
  if (rawTokens === 0) return null;

  // Pass 1: key abbreviation
  const rawKeyToCode = buildKeyAbbreviations(raw, o);
  let work = rawKeyToCode.size > 0 ? applyKeyAbbreviations(raw, rawKeyToCode) : raw;

  // Pass 2: ditto (skip when raw already contains a bare glyph value)
  const skipDitto = BARE_GLYPH_VALUE_RE.test(raw);
  let dittoUsed = false;
  if (!skipDitto) {
    const dittoResult = applyDittoEncode(work, DEFAULT_DITTO_GLYPH);
    work = dittoResult.result;
    dittoUsed = dittoResult.dittoUsed;
  }

  // Pass 3: substring dict. Avoid colliding with any `~N` that happens to be
  // present in the raw input. Dictionary building and applying happen together
  // (iterative greedy) so the returned `work` is already substituted.
  const reservedCodes = collectReservedCodes(work);
  const dictResult = buildSubstringDictionary(work, o, reservedCodes);
  const substrToCode = dictResult.substrToCode;
  work = dictResult.appliedBody;

  // Invert maps for the public return shape (code -> raw).
  const codeToKey = invertMap(rawKeyToCode);
  const codeToSubstr = invertMap(substrToCode);

  // Emit legend — always declare the ditto glyph (even if unused on this
  // payload) so the model sees a stable contract in the legend header.
  const legend = emitLegend(codeToKey, codeToSubstr, DEFAULT_DITTO_GLYPH);
  const encoded = legend + work;

  // Gate on real savings
  const encodedTokens = countTokensSync(encoded);
  const savedTokens = rawTokens - encodedTokens;
  const savedPct = rawTokens > 0 ? (savedTokens / rawTokens) * 100 : 0;
  if (savedPct < o.minSavedPct) return null;
  if (encoded.length >= raw.length) return null;

  return {
    encoded,
    keyMap: codeToKey,
    substrings: codeToSubstr,
    dittoGlyph: DEFAULT_DITTO_GLYPH,
    rawTokens,
    encodedTokens,
    savedTokens,
    savedPct,
  };
}

export function decodeToolResult(encoded: string): string {
  if (!hasCompressionLegend(encoded)) return encoded;
  const parsed = parseLegend(encoded);
  let body = encoded.slice(parsed.bodyStart);
  // Reverse substring dict (longest codes first to avoid partial overlap)
  const substrEntries = Array.from(parsed.codeToSubstr.entries()).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [code, literal] of substrEntries) {
    body = splitJoin(body, code, literal);
  }
  // Reverse ditto + keys via a single structural walk
  return reverseDittoAndKeys(body, parsed.glyph, parsed.codeToKey);
}

// ---------------------------------------------------------------------------
// Legend emit / parse
// ---------------------------------------------------------------------------

function emitLegend(
  codeToKey: Map<string, string>,
  codeToSubstr: Map<string, string>,
  glyph: string,
): string {
  const lines: string[] = [LEGEND_OPEN];
  for (const [code, rawKey] of codeToKey) {
    lines.push(` ${LEGEND_SECTION_KEYS} ${code}=${rawKey}`);
  }
  for (const [code, literal] of codeToSubstr) {
    lines.push(` ${LEGEND_SECTION_SUBSTRINGS} ${code}=${literal}`);
  }
  if (glyph.length > 0) {
    lines.push(` ${LEGEND_SECTION_DITTO} ${glyph}`);
  }
  return lines.join('\n') + '\n' + LEGEND_CLOSE;
}

interface ParsedLegend {
  codeToKey: Map<string, string>;
  codeToSubstr: Map<string, string>;
  glyph: string;
  bodyStart: number;
}

function parseLegend(encoded: string): ParsedLegend {
  const closeIdx = encoded.indexOf(LEGEND_CLOSE);
  const codeToKey = new Map<string, string>();
  const codeToSubstr = new Map<string, string>();
  let glyph = '';
  if (closeIdx < 0) {
    return { codeToKey, codeToSubstr, glyph, bodyStart: 0 };
  }
  const legendBody = encoded.slice(LEGEND_OPEN.length, closeIdx);
  const lines = legendBody.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/^\s+/, '');
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith(LEGEND_SECTION_KEYS + ' ')) {
      const entry = trimmed.slice(LEGEND_SECTION_KEYS.length + 1);
      const eq = entry.indexOf('=');
      if (eq > 0) codeToKey.set(entry.slice(0, eq), entry.slice(eq + 1));
    } else if (trimmed.startsWith(LEGEND_SECTION_SUBSTRINGS + ' ')) {
      const entry = trimmed.slice(LEGEND_SECTION_SUBSTRINGS.length + 1);
      const eq = entry.indexOf('=');
      if (eq > 0) codeToSubstr.set(entry.slice(0, eq), entry.slice(eq + 1));
    } else if (trimmed.startsWith(LEGEND_SECTION_DITTO + ' ')) {
      glyph = trimmed.slice(LEGEND_SECTION_DITTO.length + 1);
    }
  }
  return { codeToKey, codeToSubstr, glyph, bodyStart: closeIdx + LEGEND_CLOSE.length };
}

// ---------------------------------------------------------------------------
// TOON structural scanner
// ---------------------------------------------------------------------------

interface KVPosition {
  keyStart: number;
  keyEnd: number;
  valStart: number;
  valEnd: number;
}

interface ObjectInfo {
  objStart: number; // position of `{`
  objEnd: number;   // position AFTER `}`
  pairs: KVPosition[];
}

interface ArrayInfo {
  arrStart: number;
  arrEnd: number;
  objects: ObjectInfo[];
}

const KEY_NAME_RE = /^[a-zA-Z_$~][a-zA-Z0-9_$~]*$/;

/**
 * Parse all top-level-or-nested `[{...},{...},...]` arrays in the string that
 * contain direct object children. Returns them in document order with their
 * k:v positions resolved.
 */
function parseRowArrays(s: string): ArrayInfo[] {
  const arrays: ArrayInfo[] = [];
  let i = 0;
  const len = s.length;

  while (i < len) {
    const c = s[i];
    if (c === '"') {
      i = skipString(s, i);
      continue;
    }
    if (c === '[') {
      // Check if first non-whitespace char inside is `{`
      let j = i + 1;
      while (j < len && (s[j] === ' ' || s[j] === '\n')) j++;
      if (j < len && s[j] === '{') {
        const arrEnd = findBracketEnd(s, i, '[', ']');
        const objects = parseObjectsInArray(s, i + 1, arrEnd - 1);
        if (objects.length >= 2) {
          arrays.push({ arrStart: i, arrEnd, objects });
        }
        // Continue past this array (nested arrays inside objects will be picked up
        // by future scans; not critical for ditto correctness on the common case).
        i = arrEnd;
        continue;
      }
    }
    i++;
  }
  return arrays;
}

function skipString(s: string, start: number): number {
  let i = start + 1;
  const len = s.length;
  while (i < len) {
    if (s[i] === '\\' && i + 1 < len) {
      i += 2;
      continue;
    }
    if (s[i] === '"') return i + 1;
    i++;
  }
  return len;
}

function findBracketEnd(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  const len = s.length;
  while (i < len) {
    const c = s[i];
    if (c === '"') {
      i = skipString(s, i);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return len;
}

function parseObjectsInArray(s: string, start: number, end: number): ObjectInfo[] {
  const objects: ObjectInfo[] = [];
  let i = start;
  while (i < end) {
    while (i < end && (s[i] === ',' || s[i] === ' ' || s[i] === '\n')) i++;
    if (i >= end) break;
    if (s[i] !== '{') {
      // Not an object; bail out — this array isn't a row array
      return [];
    }
    const objEnd = findBracketEnd(s, i, '{', '}');
    if (objEnd > end) break;
    const pairs = parseObjectPairs(s, i, objEnd);
    objects.push({ objStart: i, objEnd, pairs });
    i = objEnd;
  }
  return objects;
}

/** Parse the k:v pairs inside `{...}`. objEnd is position AFTER the `}`. */
function parseObjectPairs(s: string, objStart: number, objEnd: number): KVPosition[] {
  const pairs: KVPosition[] = [];
  let i = objStart + 1; // past `{`
  const end = objEnd - 1; // position of `}`

  while (i < end) {
    while (i < end && (s[i] === ',' || s[i] === ' ' || s[i] === '\n')) i++;
    if (i >= end) break;

    // Parse key: letters/digits/underscore, until ':'
    const keyStart = i;
    while (i < end && isKeyChar(s[i])) i++;
    const keyEnd = i;
    if (keyEnd === keyStart || s[i] !== ':') {
      // Not a valid key position; skip this character and continue scanning.
      // This can happen inside malformed input; pragmatic skip.
      i = keyEnd + 1;
      continue;
    }
    i++; // past ':'
    const valStart = i;

    // Parse value: until comma at depth 0 or `}`
    let depth = 0;
    while (i < end) {
      const c = s[i];
      if (c === '"') {
        i = skipString(s, i);
        continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
      i++;
    }
    const valEnd = i;

    const keyName = s.slice(keyStart, keyEnd);
    if (KEY_NAME_RE.test(keyName)) {
      pairs.push({ keyStart, keyEnd, valStart, valEnd });
    }
  }
  return pairs;
}

function isKeyChar(c: string): boolean {
  const code = c.charCodeAt(0);
  if (code >= 97 && code <= 122) return true; // a-z
  if (code >= 65 && code <= 90) return true; // A-Z
  if (code >= 48 && code <= 57) return true; // 0-9
  if (c === '_' || c === '$' || c === '~') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Pass 1 — Key abbreviation
// ---------------------------------------------------------------------------

function buildKeyAbbreviations(raw: string, o: Required<EncodeOptions>): Map<string, string> {
  const keyCounts = new Map<string, number>();
  const arrays = parseRowArrays(raw);
  // Only consider keys that appear inside row-array objects (where key
  // abbreviation is safe — we avoid rewriting top-level JSON-like scalar
  // keys that the model may reason about differently).
  for (const arr of arrays) {
    for (const obj of arr.objects) {
      for (const p of obj.pairs) {
        const key = raw.slice(p.keyStart, p.keyEnd);
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const rawToCode = new Map<string, string>();
  const usedCodes = new Set<string>();

  // Abbreviate longest-name / highest-count keys first so we pick the best
  // collision-free codes for the biggest wins.
  const sorted = Array.from(keyCounts.entries()).sort((a, b) => {
    const byCount = b[1] - a[1];
    if (byCount !== 0) return byCount;
    return b[0].length - a[0].length;
  });

  for (const [rawKey, count] of sorted) {
    if (rawKey.length < o.minKeyLengthForAbbrev) continue;
    if (count < MIN_KEY_OCCURRENCES) continue;
    const code = chooseKeyCode(rawKey, usedCodes);
    if (!code) continue;
    if (code.length >= rawKey.length) continue;
    rawToCode.set(rawKey, code);
    usedCodes.add(code);
  }
  return rawToCode;
}

function chooseKeyCode(rawKey: string, usedCodes: Set<string>): string | null {
  // Rule 2: reuse existing aliases where possible.
  // GLOBAL_ALIASES maps short -> canonical; find entries whose canonical == rawKey.
  for (const [short, canonical] of Object.entries(GLOBAL_ALIASES)) {
    if (canonical === rawKey && isKeyCodeSafe(short, usedCodes)) return short;
  }
  for (const [short, canonical] of Object.entries(PARAM_SHORT)) {
    if (canonical === rawKey && isKeyCodeSafe(short, usedCodes)) return short;
  }
  // Coin a new code. Must be >= 2 chars (single-char coinings are ambiguous).
  const candidates = proposeCoinedCodes(rawKey);
  for (const c of candidates) {
    if (c.length < 2) continue;
    if (!isKeyCodeSafe(c, usedCodes)) continue;
    return c;
  }
  return null;
}

function isKeyCodeSafe(code: string, usedCodes: Set<string>): boolean {
  if (usedCodes.has(code)) return false;
  if (SHORT_TO_OP[code] !== undefined) return false;
  if (code.startsWith('h:')) return false;
  if (code.startsWith('@')) return false;
  if (code.startsWith('$')) return false;
  if (code.startsWith('~')) return false;
  if (code.includes(':')) return false;
  if (!KEY_NAME_RE.test(code)) return false;
  return true;
}

function proposeCoinedCodes(rawKey: string): string[] {
  const out = new Set<string>();
  if (rawKey.length >= 3) out.add(rawKey.slice(0, 3));
  // Vowel-stripped
  const noVowels = rawKey.replace(/[aeiouAEIOU]/g, '');
  if (noVowels.length >= 3) out.add(noVowels.slice(0, 3));
  if (noVowels.length >= 2) out.add(noVowels.slice(0, 2));
  if (rawKey.length >= 2) out.add(rawKey.slice(0, 2));
  // Last resort: prefix + last letter
  if (rawKey.length >= 4) out.add(rawKey[0] + rawKey[rawKey.length - 1]);
  return Array.from(out);
}

function applyKeyAbbreviations(raw: string, rawToCode: Map<string, string>): string {
  // Only rewrite keys at positions identified by the TOON scanner — string
  // replace would also hit values containing the key name as substring.
  const arrays = parseRowArrays(raw);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const arr of arrays) {
    for (const obj of arr.objects) {
      for (const p of obj.pairs) {
        const key = raw.slice(p.keyStart, p.keyEnd);
        const code = rawToCode.get(key);
        if (code) {
          edits.push({ start: p.keyStart, end: p.keyEnd, replacement: code });
        }
      }
    }
  }
  return applyEdits(raw, edits);
}

function applyEdits(
  s: string,
  edits: Array<{ start: number; end: number; replacement: string }>,
): string {
  if (edits.length === 0) return s;
  edits.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const e of edits) {
    if (e.start < cursor) continue; // overlap; skip
    parts.push(s.slice(cursor, e.start));
    parts.push(e.replacement);
    cursor = e.end;
  }
  parts.push(s.slice(cursor));
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Pass 2 — Ditto
// ---------------------------------------------------------------------------

function applyDittoEncode(s: string, glyph: string): { result: string; dittoUsed: boolean } {
  const arrays = parseRowArrays(s);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  let dittoUsed = false;

  for (const arr of arrays) {
    for (let r = 1; r < arr.objects.length; r++) {
      const prev = arr.objects[r - 1];
      const curr = arr.objects[r];
      // Build a key -> value-text map from prev
      const prevMap = new Map<string, string>();
      for (const p of prev.pairs) {
        const k = s.slice(p.keyStart, p.keyEnd);
        const v = s.slice(p.valStart, p.valEnd);
        prevMap.set(k, v);
      }
      for (const p of curr.pairs) {
        const k = s.slice(p.keyStart, p.keyEnd);
        const v = s.slice(p.valStart, p.valEnd);
        // Never ditto if value IS the glyph (ambiguous on decode).
        if (v === glyph) continue;
        if (prevMap.get(k) === v) {
          edits.push({ start: p.valStart, end: p.valEnd, replacement: glyph });
          dittoUsed = true;
        }
      }
    }
  }

  return { result: applyEdits(s, edits), dittoUsed };
}

/**
 * Reverse ditto (using the preceding row's value for the same key) and
 * reverse key-abbreviation in one structural walk.
 */
function reverseDittoAndKeys(
  body: string,
  glyph: string,
  codeToKey: Map<string, string>,
): string {
  // First pass: resolve ditto values (needs value rewrites only).
  const arrays = parseRowArrays(body);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];

  if (glyph.length > 0) {
    for (const arr of arrays) {
      // Walk rows in order, maintaining "resolved values for previous row".
      // This handles transitive ditto chains: row N+1 dittoing a value that
      // itself was dittoed from row N must see the N-level resolved value.
      const resolved = new Map<string, string>();
      for (let r = 0; r < arr.objects.length; r++) {
        const obj = arr.objects[r];
        const current = new Map<string, string>();
        for (const p of obj.pairs) {
          const k = body.slice(p.keyStart, p.keyEnd);
          const v = body.slice(p.valStart, p.valEnd);
          if (r > 0 && v === glyph) {
            const prevVal = resolved.get(k);
            if (prevVal !== undefined) {
              edits.push({ start: p.valStart, end: p.valEnd, replacement: prevVal });
              current.set(k, prevVal);
              continue;
            }
          }
          current.set(k, v);
        }
        resolved.clear();
        for (const [k, v] of current) resolved.set(k, v);
      }
    }
  }

  let result = applyEdits(body, edits);

  // Second pass: reverse key abbreviations on the ditto-expanded body.
  // Invert the code->raw map for use as "replace code with raw" at key positions.
  if (codeToKey.size > 0) {
    const arrays2 = parseRowArrays(result);
    const keyEdits: Array<{ start: number; end: number; replacement: string }> = [];
    for (const arr of arrays2) {
      for (const obj of arr.objects) {
        for (const p of obj.pairs) {
          const key = result.slice(p.keyStart, p.keyEnd);
          const rawKey = codeToKey.get(key);
          if (rawKey !== undefined) {
            keyEdits.push({ start: p.keyStart, end: p.keyEnd, replacement: rawKey });
          }
        }
      }
    }
    result = applyEdits(result, keyEdits);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pass 3 — Substring dictionary
// ---------------------------------------------------------------------------

function collectReservedCodes(s: string): Set<string> {
  const reserved = new Set<string>();
  const matches = s.match(SUBSTRING_CODE_PATTERN);
  if (matches) for (const m of matches) reserved.add(m);
  return reserved;
}

interface DictBuildResult {
  /** code -> expanded literal. Each literal is fully self-contained (no
   *  code references) so decoders can use a single-pass replace. */
  substrToCode: Map<string, string>;
  appliedBody: string;
}

interface DictEntry {
  /** What to find in the working body (may contain earlier codes). */
  sub: string;
  /** What the legend stores (all earlier codes pre-expanded). */
  literal: string;
  code: string;
}

function buildSubstringDictionary(
  s: string,
  o: Required<EncodeOptions>,
  reservedCodes: Set<string>,
): DictBuildResult {
  const entries: DictEntry[] = [];
  let body = s;
  let codeCounter = 1;
  const minLen = o.minDictKeyLength;
  const maxLen = SUBSTRING_MAX_LEN;

  while (entries.length < o.maxDictEntries) {
    const code = nextAvailableCode(codeCounter, reservedCodes);
    codeCounter = parseInt(code.slice(1), 10) + 1;

    const best = findBestBoundaryAlignedSubstring(body, minLen, maxLen, code.length);
    if (!best || best.savings <= 0) break;

    // Compute the legend literal by expanding any earlier codes that appear
    // in best.sub. Keeps each legend entry self-contained — decoders can
    // apply substring reversal in one pass.
    let literal = best.sub;
    for (const prior of entries) {
      literal = splitJoin(literal, prior.code, prior.literal);
    }

    entries.push({ sub: best.sub, literal, code });
    reservedCodes.add(code);
    body = splitJoin(body, best.sub, code);
  }

  const substrToCode = new Map<string, string>();
  for (const e of entries) substrToCode.set(e.literal, e.code);
  return { substrToCode, appliedBody: body };
}

interface BestSubstring {
  sub: string;
  savings: number;
  count: number;
}

function findBestBoundaryAlignedSubstring(
  s: string,
  minLen: number,
  maxLen: number,
  codeLen: number,
): BestSubstring | null {
  // Build a map of substring -> count, considering only candidates that
  // start and end at boundary-adjacent positions (start: immediately after
  // a boundary char or position 0; end: immediately before a boundary char
  // or position s.length).
  const boundaryPositions = findBoundaryStartPositions(s);
  const counts = new Map<string, number>();
  const upperLen = Math.min(maxLen, s.length);

  for (const start of boundaryPositions) {
    const maxSubEnd = Math.min(start + upperLen, s.length);
    // Incrementally grow from `start`, bailing the moment we hit a forbidden
    // char — no candidate beyond that point can be valid (depth / k:v crossing).
    for (let end = start + 1; end <= maxSubEnd; end++) {
      const ch = s[end - 1];
      if (FORBIDDEN_INSIDE_SUBSTRING.has(ch)) break;
      if (end - start < minLen) continue;
      if (!isBoundaryEnd(s, end)) continue;
      const sub = s.slice(start, end);
      // Line numbers and pure-digit values must stay verbatim in the body.
      if (PURE_DIGITS_RE.test(sub)) continue;
      counts.set(sub, (counts.get(sub) ?? 0) + 1);
    }
  }

  let best: BestSubstring | null = null;
  for (const [sub, count] of counts) {
    if (count < MIN_SUBSTRING_OCCURRENCES) continue;
    const legendCost = codeLen + 1 + sub.length + 4; // ` s ~N=<sub>\n` minus constants
    const bodyDelta = (sub.length - codeLen) * count;
    const savings = bodyDelta - legendCost;
    if (savings > 0 && (!best || savings > best.savings)) {
      best = { sub, savings, count };
    }
  }
  return best;
}

const PURE_DIGITS_RE = /^\d+$/;

function findBoundaryStartPositions(s: string): number[] {
  const positions: number[] = [0];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (STRUCTURAL_BOUNDARIES.has(c) || CONTENT_BOUNDARIES.has(c)) {
      positions.push(i + 1);
    }
  }
  return positions;
}

function isBoundaryEnd(s: string, pos: number): boolean {
  if (pos === s.length) return true;
  const c = s[pos];
  return STRUCTURAL_BOUNDARIES.has(c) || CONTENT_BOUNDARIES.has(c);
}

function applySubstringDictionary(s: string, substrToCode: Map<string, string>): string {
  // Already applied during buildSubstringDictionary via splitJoin; this is the
  // re-apply path (currently unused since build also applies). Kept for symmetry.
  let result = s;
  for (const [sub, code] of substrToCode) {
    result = splitJoin(result, sub, code);
  }
  return result;
}

function nextAvailableCode(startCounter: number, reserved: Set<string>): string {
  let n = startCounter;
  while (true) {
    const code = `${SUBSTRING_CODE_PREFIX}${n}`;
    if (!reserved.has(code)) return code;
    n++;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function invertMap(m: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of m) out.set(v, k);
  return out;
}

function splitJoin(s: string, find: string, replace: string): string {
  if (find.length === 0) return s;
  return s.split(find).join(replace);
}

// ---------------------------------------------------------------------------
// Self-register with toon.ts so `formatResult` consults the chat toggle.
//
// Matches the `registerDriftCorrectionProvider` pattern in `contextHash.ts`.
// No circular import: `toon.ts` only exposes the registrar, it does not import
// from this module.
//
// Wrapped in a named `__compressionWired` IIFE export so symbol search (`sy`)
// surfaces the wiring anchor directly, without relying on shape/sig views
// that collapse bare trailing module-level calls. Runtime behavior is
// identical to a bare call — the IIFE runs at import time.
// ---------------------------------------------------------------------------

export const __compressionWired: boolean = (() => {
  registerCompressionProvider(
    () => {
      try {
        return useAppStore.getState().settings.compressToolResults ?? false;
      } catch {
        return false;
      }
    },
    (raw) => {
      const result = encodeToolResult(raw);
      return result ? { encoded: result.encoded, savedTokens: result.savedTokens } : null;
    },
    (tokensSaved) => {
      try {
        useAppStore.getState().addInputCompressionSavings(tokensSaved);
      } catch {
        // Store not available (e.g. in tests that mock appStore); swallow.
      }
    },
  );
  return true;
})();
