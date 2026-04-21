import type { ShapeOp, HashModifierV2 } from './uhppTypes';
import { UHPP_ANCHOR_PREFIXES } from './uhppAnchorPrefixes';

const SHAPE_KEYWORDS = new Set(['sig', 'fold', 'dedent', 'nocomment', 'imports', 'exports']);

const TYPO_HINTS: Record<string, string> = {
  sgi: 'sig',
  sg: 'sig',
  imorts: 'imports',
  imort: 'imports',
  soure: 'source',
  soruce: 'source',
  contnet: 'content',
};

export function parseModifierChain(chain: string): HashModifierV2 | null {
  // Single keyword modifiers
  if (chain === 'source') return 'source';
  if (chain === 'content') return 'content';
  if (chain === 'tokens') return 'tokens';
  if (chain === 'meta') return 'meta';
  if (chain === 'lang') return 'lang';

  // Shape-only modifier
  const shape = parseShapeOp(chain);
  if (shape) return { shape };

  // Symbol anchors: fn(name), sym(name), optionally chained with :shape
  const anchor = parseSymbolAnchor(chain);
  if (anchor) return anchor;

  // Lines with optional shape: "15-30:dedent"
  const shapeSep = findShapeSeparator(chain);
  if (shapeSep !== null) {
    const linesPart = chain.slice(0, shapeSep);
    const shapePart = chain.slice(shapeSep + 1);
    const ranges = parseLineRanges(linesPart);
    const shapeOp = parseShapeOp(shapePart);
    if (ranges && shapeOp) return { lines: ranges, shape: shapeOp };
  }

  // Plain line ranges
  const ranges = parseLineRanges(chain);
  if (ranges) return { lines: ranges };

  return null;
}

/**
 * Like `parseModifierChain` but returns a reason when the chain is invalid.
 * Used for diagnostics (e.g. typos like `sgi` → `sig`).
 */
export function parseModifierChainWithError(
  chain: string,
):
  | { ok: true; modifier: HashModifierV2 }
  | { ok: false; reason: string; suggestion?: string } {
  const modifier = parseModifierChain(chain);
  if (modifier !== null) return { ok: true, modifier };
  const lc = chain.toLowerCase();
  const hint = TYPO_HINTS[lc];
  if (hint) {
    return {
      ok: false,
      reason: 'unrecognized modifier chain',
      suggestion: hint,
    };
  }
  // Line-range diagnostic: when the chain "looks like" a range attempt
  // (leading digit or minus, embedded dash) but failed validation, surface
  // the specific reason so the model can self-correct without guessing.
  const looksLikeRange = /^[-\d]/.test(chain) && chain.includes('-');
  if (looksLikeRange) {
    const shapeSep = findShapeSeparator(chain);
    const linesPart = shapeSep !== null ? chain.slice(0, shapeSep) : chain;
    const ranges = parseLineRangesWithError(linesPart);
    if (!ranges.ok) {
      const suggestion = ranges.reason === 'inverted_range'
        ? 'ensure start <= end (e.g. "50-100" not "100-50")'
        : ranges.reason === 'non_positive_start' || ranges.reason === 'non_positive_end'
          ? 'line numbers are 1-based (no 0 or negative values)'
          : undefined;
      return {
        ok: false,
        reason: `invalid line range: ${ranges.reason}`,
        suggestion,
      };
    }
  }
  return { ok: false, reason: 'unrecognized modifier chain' };
}

export function parseShapeOp(s: string): ShapeOp | null {
  if (SHAPE_KEYWORDS.has(s)) return s as ShapeOp;

  const headMatch = s.match(/^head\((\d+)\)$/);
  if (headMatch) return { head: parseInt(headMatch[1], 10) };

  const tailMatch = s.match(/^tail\((\d+)\)$/);
  if (tailMatch) return { tail: parseInt(tailMatch[1], 10) };

  const grepMatch = s.match(/^grep\((.+)\)$/);
  if (grepMatch && grepMatch[1]) return { grep: grepMatch[1] };

  const exMatch = s.match(/^ex\((.+)\)$/);
  if (exMatch) {
    const ranges = parseLineRanges(exMatch[1]);
    if (ranges) return { exclude: ranges };
  }

  const hlMatch = s.match(/^hl\((.+)\)$/);
  if (hlMatch) {
    const ranges = parseLineRanges(hlMatch[1]);
    if (ranges) return { highlight: ranges };
  }

  // Semantic modifiers: concept(name), pattern(name), if(expr)
  const conceptMatch = s.match(/^concept\((.+)\)$/);
  if (conceptMatch && conceptMatch[1]) return { concept: conceptMatch[1] };

  const patternMatch = s.match(/^pattern\((.+)\)$/);
  if (patternMatch && patternMatch[1]) return { pattern: patternMatch[1] };

  const ifMatch = s.match(/^if\((.+)\)$/);
  if (ifMatch && ifMatch[1]) return { if: ifMatch[1] };

  return null;
}

export function parseSymbolAnchor(chain: string): HashModifierV2 | null {
  const parenEnd = chain.indexOf(')');
  if (parenEnd < 0) return null;

  const anchorPart = chain.slice(0, parenEnd + 1);
  const rest = chain.slice(parenEnd + 1);

  let shapeSuffix: ShapeOp | undefined;
  if (rest.startsWith(':')) {
    shapeSuffix = parseShapeOp(rest.slice(1)) ?? undefined;
    if (!shapeSuffix) return null;
  } else if (rest.length > 0) {
    return null;
  }

  for (const [prefix, canonicalKind] of UHPP_ANCHOR_PREFIXES) {
    const re = new RegExp(`^${prefix}\\((.+)\\)$`);
    const m = anchorPart.match(re);
    if (m) {
      const name = m[1].trim();
      if (!name) return null;
      return canonicalKind
        ? { symbol: { kind: canonicalKind, name, shape: shapeSuffix } }
        : { symbol: { name, shape: shapeSuffix } };
    }
  }

  return null;
}

/**
 * Strict line-range validation (1-based inclusive). Rejects:
 *   - non-numeric start/end (`abc`, `abc-def`)
 *   - zero or negative start (`0-5`, `-3-7`)
 *   - inverted ranges (`100-50`)
 *   - negative end (`5--3`)
 *
 * Open-ended ranges (`50-`) are allowed; `end = null` means "through EOF".
 * Callers that need a reason for rejection (e.g. diagnostic UIs) should use
 * {@link parseLineRangesWithError}; the silent `null` form is preserved for
 * fast-path callers and guard checks like {@link findShapeSeparator}.
 */
export function parseLineRanges(s: string): [number, number | null][] | null {
  const result = parseLineRangesWithError(s);
  return result.ok ? result.ranges : null;
}

export type ParseLineRangesError =
  | 'empty'
  | 'non_numeric'
  | 'non_positive_start'
  | 'non_positive_end'
  | 'inverted_range';

export function parseLineRangesWithError(
  s: string,
):
  | { ok: true; ranges: [number, number | null][] }
  | { ok: false; reason: ParseLineRangesError } {
  const ranges: [number, number | null][] = [];
  for (const part of s.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const dashPos = t.indexOf('-', t.startsWith('-') ? 1 : 0);
    if (dashPos >= 0) {
      const startStr = t.slice(0, dashPos);
      const endStr = t.slice(dashPos + 1);
      const start = parseInt(startStr, 10);
      if (isNaN(start)) return { ok: false, reason: 'non_numeric' };
      if (start < 1) return { ok: false, reason: 'non_positive_start' };
      if (endStr === '') {
        ranges.push([start, null]);
        continue;
      }
      const end = parseInt(endStr, 10);
      if (isNaN(end)) return { ok: false, reason: 'non_numeric' };
      if (end < 1) return { ok: false, reason: 'non_positive_end' };
      if (end < start) return { ok: false, reason: 'inverted_range' };
      ranges.push([start, end]);
    } else {
      const line = parseInt(t, 10);
      if (isNaN(line)) return { ok: false, reason: 'non_numeric' };
      if (line < 1) return { ok: false, reason: 'non_positive_start' };
      ranges.push([line, line]);
    }
  }
  return ranges.length > 0
    ? { ok: true, ranges }
    : { ok: false, reason: 'empty' };
}

export function findShapeSeparator(s: string): number | null {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ':' && depth === 0) {
      const before = s.slice(0, i);
      if (parseLineRanges(before)) return i;
    }
  }
  return null;
}
