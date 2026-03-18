import type { ShapeOp, HashModifierV2 } from './uhppTypes';

const SHAPE_KEYWORDS = new Set(['sig', 'fold', 'dedent', 'nocomment', 'imports', 'exports']);

const UHPP_ANCHOR_PREFIXES: Array<[string, string | null]> = [
  ['fn', 'fn'], ['sym', null], ['cls', 'cls'], ['class', 'cls'],
  ['struct', 'struct'], ['trait', 'trait'], ['interface', 'trait'],
  ['protocol', 'protocol'], ['enum', 'enum'], ['record', 'record'],
  ['union', 'union'], ['type', 'type'], ['alias', 'alias'],
  ['const', 'const'], ['var', 'var'], ['let', 'let'],
  ['prop', 'prop'], ['field', 'field'], ['attr', 'attr'],
  ['method', 'method'], ['impl', 'impl'], ['mod', 'mod'],
  ['ns', 'ns'], ['pkg', 'pkg'], ['test', 'test'],
  ['macro', 'macro'],
];

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
      return canonicalKind
        ? { symbol: { kind: canonicalKind, name: m[1], shape: shapeSuffix } }
        : { symbol: { name: m[1], shape: shapeSuffix } };
    }
  }

  return null;
}

export function parseLineRanges(s: string): [number, number | null][] | null {
  const ranges: [number, number | null][] = [];
  for (const part of s.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const dashPos = t.indexOf('-');
    if (dashPos >= 0) {
      const startStr = t.slice(0, dashPos);
      const endStr = t.slice(dashPos + 1);
      const start = parseInt(startStr, 10);
      if (isNaN(start)) return null;
      const end = endStr ? parseInt(endStr, 10) : null;
      if (endStr && isNaN(end!)) return null;
      ranges.push([start, end]);
    } else {
      const line = parseInt(t, 10);
      if (isNaN(line)) return null;
      ranges.push([line, line]);
    }
  }
  return ranges.length > 0 ? ranges : null;
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
