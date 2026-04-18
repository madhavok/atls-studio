/**
 * Compression ceiling measurement.
 *
 * Answers the question: "do the tabular tool-result fixtures actually carry
 * enough redundancy to clear the 15% / 10% targets in the main spec?"
 *
 * This is a measurement suite, not a spec. It runs lightweight simulations
 * of what an optimal three-pass encoder could achieve on each fixture and
 * logs the delta at each stage. No encoder code is exercised — the real
 * `encodeToolResult` is still a stub.
 *
 * If this file's assertions pass, building the real encoder is justified:
 * the targets are reachable. If any fail, the thresholds in the main spec
 * should be tuned down before implementation starts.
 */

import { describe, expect, it } from 'vitest';

import { estimateTokens } from './contextHash';
import { formatResult } from './toon';
import { logTokenDelta } from './toonDeltaTestHelpers';
import {
  makeGroupedSearchResult,
  makeLargeCodeSearchResult,
  makeRepetitiveIssuesResult,
  makeTreeListingResult,
} from './toonFixtures';

// ---------------------------------------------------------------------------
// Simulation: ditto-mark replacement across rows of a TOON array
// ---------------------------------------------------------------------------

/**
 * Walks the top-level `[{...},{...},...]` arrays in a TOON string and replaces
 * any `k:v` pair that equals the same-key pair in the immediately preceding
 * row with `k:<dittoGlyph>`. Naive — no nesting awareness inside rows — which
 * is safe for `formatResult` output of the tabular fixtures.
 */
function simulateDitto(s: string, dittoGlyph = '^'): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const arrStart = s.indexOf('[{', i);
    if (arrStart < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, arrStart + 1);

    // Match bracket to find the array's end
    let depth = 0;
    let arrEnd = arrStart;
    let inQuote = false;
    for (let j = arrStart; j < s.length; j++) {
      const c = s[j];
      if (inQuote) {
        if (c === '"' && s[j - 1] !== '\\') inQuote = false;
        continue;
      }
      if (c === '"') inQuote = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0 && c === ']') {
          arrEnd = j;
          break;
        }
      }
    }

    const inner = s.slice(arrStart + 1, arrEnd);
    const rows = splitTopLevelObjects(inner);
    if (rows.length < 2) {
      out += inner + ']';
      i = arrEnd + 1;
      continue;
    }

    const parsed = rows.map(parseObjectPairs);
    const compressed: string[] = [];
    for (let r = 0; r < parsed.length; r++) {
      if (r === 0) {
        compressed.push(`{${parsed[0].map((p) => `${p.k}:${p.v}`).join(',')}}`);
        continue;
      }
      const prev = new Map(parsed[r - 1].map((p) => [p.k, p.v]));
      compressed.push(
        `{${parsed[r]
          .map((p) => (prev.get(p.k) === p.v ? `${p.k}:${dittoGlyph}` : `${p.k}:${p.v}`))
          .join(',')}}`,
      );
    }
    out += compressed.join(',') + ']';
    i = arrEnd + 1;
  }
  return out;
}

function splitTopLevelObjects(inner: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inQuote) {
      if (c === '"' && inner[i - 1] !== '\\') inQuote = false;
      continue;
    }
    if (c === '"') inQuote = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0 && c === '}' && inner[i + 1] === ',' && inner[i + 2] === '{') {
        parts.push(inner.slice(start, i + 1));
        start = i + 2;
        i += 1;
      }
    }
  }
  parts.push(inner.slice(start));
  return parts.filter((p) => p.startsWith('{') && p.endsWith('}'));
}

function parseObjectPairs(obj: string): Array<{ k: string; v: string }> {
  const body = obj.replace(/^\{/, '').replace(/\}$/, '');
  const pairs: Array<{ k: string; v: string }> = [];
  let start = 0;
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (i < body.length && inQuote) {
      if (c === '"' && body[i - 1] !== '\\') inQuote = false;
      continue;
    }
    if (i === body.length || (depth === 0 && c === ',')) {
      const piece = body.slice(start, i);
      const colonIdx = piece.indexOf(':');
      if (colonIdx > 0) {
        pairs.push({ k: piece.slice(0, colonIdx), v: piece.slice(colonIdx + 1) });
      }
      start = i + 1;
      continue;
    }
    if (c === '"') inQuote = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Simulation: greedy substring dictionary
// ---------------------------------------------------------------------------

interface DictResult {
  encoded: string;
  /** Full legend header prepended when concatenated. */
  legend: string;
  /** Number of dictionary entries chosen. */
  entries: number;
}

/**
 * Greedy substring extraction. On each pass, counts every substring in a
 * bounded length range, picks the one with highest net byte savings after
 * accounting for legend overhead, replaces it in the body, iterates until
 * no further gain is possible or the entry cap is reached.
 *
 * Not optimal — optimal is NP-hard — but greedy gives a consistent lower
 * bound on achievable savings within ~5 percentage points of optimal on
 * the kinds of redundancy these fixtures exhibit.
 */
function simulateSubstringDict(
  s: string,
  opts: { minLen?: number; maxLen?: number; minFreq?: number; maxEntries?: number } = {},
): DictResult {
  const minLen = opts.minLen ?? 5;
  const maxLen = opts.maxLen ?? 40;
  const minFreq = opts.minFreq ?? 3;
  const maxEntries = opts.maxEntries ?? 24;

  let body = s;
  const entries: Array<{ code: string; value: string }> = [];
  let codeNum = 1;

  while (entries.length < maxEntries) {
    const bestSub = findBestSubstring(body, minLen, Math.min(maxLen, body.length), minFreq, codeNum);
    if (!bestSub || bestSub.savings <= 0) break;
    const code = `~${codeNum++}`;
    entries.push({ code, value: bestSub.sub });
    body = body.split(bestSub.sub).join(code);
  }

  const legend = entries.length > 0
    ? `<<dict\n s ${entries.map((e) => `${e.code}=${e.value}`).join(' ')}\n>>\n`
    : '';
  return { encoded: legend + body, legend, entries: entries.length };
}

function findBestSubstring(
  body: string,
  minLen: number,
  maxLen: number,
  minFreq: number,
  codeNum: number,
): { sub: string; savings: number } | null {
  const counts = new Map<string, number>();
  for (let L = minLen; L <= maxLen; L++) {
    if (L > body.length) break;
    for (let i = 0; i + L <= body.length; i++) {
      const sub = body.substr(i, L);
      counts.set(sub, (counts.get(sub) ?? 0) + 1);
    }
  }
  const codeLen = `~${codeNum}`.length;
  let best: { sub: string; savings: number } | null = null;
  for (const [sub, count] of counts) {
    if (count < minFreq) continue;
    // After replacement: each occurrence costs `codeLen` instead of `sub.length`.
    // Legend entry adds ` ${code}=${sub}` ≈ codeLen + 2 + sub.length bytes.
    const bodyDelta = (sub.length - codeLen) * count;
    const legendCost = codeLen + 2 + sub.length;
    const savings = bodyDelta - legendCost;
    if (savings > 0 && (!best || savings > best.savings)) {
      best = { sub, savings };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface Stage {
  label: string;
  content: string;
  tokens: number;
  bytes: number;
}

function measureStages(fixtureName: string, fixture: unknown): Stage[] {
  const raw = formatResult(fixture);
  const afterDitto = simulateDitto(raw);
  const afterDict = simulateSubstringDict(afterDitto);

  const stages: Stage[] = [
    { label: 'raw (post formatResult)', content: raw, tokens: estimateTokens(raw), bytes: raw.length },
    { label: 'after ditto', content: afterDitto, tokens: estimateTokens(afterDitto), bytes: afterDitto.length },
    {
      label: `after dict (${afterDict.entries} entries)`,
      content: afterDict.encoded,
      tokens: estimateTokens(afterDict.encoded),
      bytes: afterDict.encoded.length,
    },
  ];

  console.log(`\n[ceiling] ${fixtureName}`);
  const base = stages[0];
  for (const st of stages) {
    const savedTok = base.tokens - st.tokens;
    const savedPct = base.tokens === 0 ? '0.0' : ((savedTok / base.tokens) * 100).toFixed(1);
    const savedBytes = base.bytes - st.bytes;
    const savedBytesPct = base.bytes === 0 ? '0.0' : ((savedBytes / base.bytes) * 100).toFixed(1);
    console.log(
      `  ${st.label.padEnd(40)} | ${String(st.bytes).padStart(6)} B (${savedBytesPct.padStart(5)}% saved) | ${String(st.tokens).padStart(5)} tok (${savedPct.padStart(5)}% saved)`,
    );
  }
  return stages;
}

function savedPctTokens(stages: Stage[]): number {
  const base = stages[0].tokens;
  const final = stages[stages.length - 1].tokens;
  if (base === 0) return 0;
  return ((base - final) / base) * 100;
}

describe('compression ceiling — do fixtures carry enough redundancy for the targets?', () => {
  it('large code search (120 rows) — ceiling should clear 15% target', () => {
    const stages = measureStages('large code search (120 rows)', makeLargeCodeSearchResult(120));
    const ceiling = savedPctTokens(stages);
    logTokenDelta(
      'ceiling: large code search (120 rows)',
      stages[0].content,
      stages[stages.length - 1].content,
      'ditto+dict',
    );
    expect(ceiling).toBeGreaterThanOrEqual(15);
  });

  it('repetitive issues (80) — ceiling should clear 15% target', () => {
    const stages = measureStages('repetitive issues (80)', makeRepetitiveIssuesResult(80));
    const ceiling = savedPctTokens(stages);
    logTokenDelta(
      'ceiling: repetitive issues (80)',
      stages[0].content,
      stages[stages.length - 1].content,
      'ditto+dict',
    );
    expect(ceiling).toBeGreaterThanOrEqual(15);
  });

  it('tree listing (depth 5, breadth 6) — ceiling should clear 10% target', () => {
    const stages = measureStages('tree listing (5 x 6)', makeTreeListingResult(5, 6));
    const ceiling = savedPctTokens(stages);
    logTokenDelta(
      'ceiling: tree listing (5 x 6)',
      stages[0].content,
      stages[stages.length - 1].content,
      'ditto+dict',
    );
    expect(ceiling).toBeGreaterThanOrEqual(10);
  });

  it('large code search (40 rows) — reports ceiling for reference (no assertion)', () => {
    measureStages('large code search (40 rows)', makeLargeCodeSearchResult(40));
  });

  it('repetitive issues (30) — reports ceiling for reference (no assertion)', () => {
    measureStages('repetitive issues (30)', makeRepetitiveIssuesResult(30));
  });

  it('grouped search (12 groups x 10 rows) — ditto alone should save >= 8% before dict runs', () => {
    const fixtureName = 'grouped search (12 x 10)';
    const fixture = makeGroupedSearchResult(10, 12);
    const raw = formatResult(fixture);
    const afterDitto = simulateDitto(raw);
    const rawTok = estimateTokens(raw);
    const dittoTok = estimateTokens(afterDitto);
    const dittoSavedPct = rawTok === 0 ? 0 : ((rawTok - dittoTok) / rawTok) * 100;
    console.log(
      `\n[ceiling] ${fixtureName} (ditto-only)` +
        `\n  raw                                      | ${String(raw.length).padStart(6)} B | ${String(rawTok).padStart(5)} tok` +
        `\n  after ditto (column-above dedup)         | ${String(afterDitto.length).padStart(6)} B | ${String(dittoTok).padStart(5)} tok (${dittoSavedPct.toFixed(1)}% saved)`,
    );
    // Also report the full ceiling with dict layered on top for reference.
    measureStages(fixtureName, fixture);
    expect(dittoSavedPct).toBeGreaterThanOrEqual(8);
  });
});
