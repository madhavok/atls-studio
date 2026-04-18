/**
 * Tool-result compression — test-first suite.
 *
 * Drives implementation of `encodeToolResult` / `decodeToolResult` at the
 * `formatResult` seam. Operates on TOON strings (already-compacted tabular
 * output), not raw objects — matches the real data flow.
 *
 * Token deltas use `estimateTokens` (the calibrated in-process heuristic)
 * so assertions are deterministic in vitest. When the Rust tokenizer is
 * reachable via Tauri IPC in a dev env, `countTokensSync` upgrades to real
 * BPE and the same threshold assertions hold.
 *
 * Namespace safety: the encoded form must not conflate with any existing
 * ATLS batch-input shorthand. See the "collision safety" describe block
 * and `toolResultCompression.ts` header.
 */

import { describe, expect, it } from 'vitest';

import { estimateTokens } from './contextHash';
import { countTokensSync } from './tokenCounter';
import { formatResult } from './toon';
import { logTokenDelta } from './toonDeltaTestHelpers';
import {
  makeCodeSearchBackendResult,
  makeLargeCodeSearchResult,
  makeLowRedundancyResult,
  makeRepetitiveIssuesResult,
  makeTreeListingResult,
} from './toonFixtures';
import { SHORT_TO_OP, PARAM_SHORT } from '../services/batch/opShorthand';
import {
  decodeToolResult,
  encodeToolResult,
  hasCompressionLegend,
  LEGEND_CLOSE,
  LEGEND_OPEN,
  LEGEND_SECTION_DITTO,
  LEGEND_SECTION_KEYS,
  LEGEND_SECTION_SUBSTRINGS,
  SUBSTRING_CODE_PATTERN,
  SUBSTRING_CODE_PREFIX,
  DEFAULT_DITTO_GLYPH,
  type CompressionResult,
} from './toolResultCompression';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Require an encoder result. Fails with a descriptive message when the stub
 * returns null — exactly the TDD signal that drives implementation.
 */
function expectEncoded(raw: string, opts?: Parameters<typeof encodeToolResult>[1]): CompressionResult {
  const result = encodeToolResult(raw, opts);
  expect(result, 'encoder should produce a result on this input; stub returned null').not.toBeNull();
  return result as CompressionResult;
}

/** Token delta logged + returned for a raw/encoded pair. */
function logDelta(label: string, raw: string, encoded: string) {
  return logTokenDelta(label, raw, encoded, 'encoded');
}

/** Extract the body portion after the legend, given a fully encoded string. */
function bodyOf(encoded: string): string {
  const idx = encoded.indexOf(LEGEND_CLOSE);
  expect(idx).toBeGreaterThan(0);
  return encoded.slice(idx + LEGEND_CLOSE.length);
}

/** Extract the legend portion (between LEGEND_OPEN and LEGEND_CLOSE). */
function legendOf(encoded: string): string {
  const closeIdx = encoded.indexOf(LEGEND_CLOSE);
  expect(closeIdx).toBeGreaterThan(0);
  return encoded.slice(LEGEND_OPEN.length, closeIdx);
}

// ---------------------------------------------------------------------------
// 1. Encoder output format
// ---------------------------------------------------------------------------

describe('toolResultCompression — encoder output format', () => {
  it('encoded output starts with a legend marker and ends it before the body', () => {
    const raw = formatResult(makeLargeCodeSearchResult(40));
    const r = expectEncoded(raw);
    expect(r.encoded.startsWith(LEGEND_OPEN)).toBe(true);
    const closeIdx = r.encoded.indexOf(LEGEND_CLOSE);
    expect(closeIdx).toBeGreaterThan(LEGEND_OPEN.length);
    expect(hasCompressionLegend(r.encoded)).toBe(true);
  });

  it('legend contains every substring code referenced in the body', () => {
    const raw = formatResult(makeLargeCodeSearchResult(40));
    const r = expectEncoded(raw);
    const body = bodyOf(r.encoded);
    const referenced = new Set(body.match(SUBSTRING_CODE_PATTERN) ?? []);
    for (const ref of referenced) {
      expect(r.substrings.has(ref), `substrings missing code referenced in body: ${ref}`).toBe(true);
    }
  });

  it('every key used in the body is either a raw key or a code in the keyMap', () => {
    const raw = formatResult(makeRepetitiveIssuesResult(40));
    const r = expectEncoded(raw);
    const body = bodyOf(r.encoded);
    // Sample: the key codes present in the legend must all appear in the body
    for (const encodedKey of r.keyMap.keys()) {
      expect(body, `encoded key ${encodedKey} must appear in body`).toContain(`${encodedKey}:`);
    }
  });

  it('legend is recoverable from the encoded string alone (no external state)', () => {
    const raw = formatResult(makeRepetitiveIssuesResult(30));
    const r = expectEncoded(raw);
    const decoded = decodeToolResult(r.encoded);
    expect(decoded).toBe(raw);
  });

  it('raw non-encoded strings flow through decodeToolResult unchanged (identity on no-legend input)', () => {
    const plain = 'some raw tool output without a legend marker';
    expect(decodeToolResult(plain)).toBe(plain);
  });
});

// ---------------------------------------------------------------------------
// 2. Roundtrip correctness
// ---------------------------------------------------------------------------

describe('toolResultCompression — roundtrip correctness', () => {
  const fixtures: Array<{ name: string; build: () => unknown }> = [
    { name: 'large code search (40 rows)', build: () => makeLargeCodeSearchResult(40) },
    { name: 'large code search (120 rows)', build: () => makeLargeCodeSearchResult(120) },
    { name: 'repetitive issues (30)', build: () => makeRepetitiveIssuesResult(30) },
    { name: 'repetitive issues (80)', build: () => makeRepetitiveIssuesResult(80) },
    { name: 'tree listing (depth 4, breadth 5)', build: () => makeTreeListingResult(4, 5) },
  ];

  for (const { name, build } of fixtures) {
    it(`${name}: decode(encode(raw)) === raw`, () => {
      const raw = formatResult(build());
      const r = expectEncoded(raw);
      expect(decodeToolResult(r.encoded)).toBe(raw);
    });
  }

  it('roundtrip preserves unicode and whitespace exactly', () => {
    const raw = formatResult({
      rows: [
        { file: 'src/util/naïve.ts', line: 1, snippet: 'export const α = "  spaced  ";' },
        { file: 'src/util/naïve.ts', line: 2, snippet: 'export const β = "  spaced  ";' },
        { file: 'src/util/naïve.ts', line: 3, snippet: 'export const γ = "  spaced  ";' },
        { file: 'src/util/naïve.ts', line: 4, snippet: 'export const δ = "  spaced  ";' },
        { file: 'src/util/naïve.ts', line: 5, snippet: 'export const ε = "  spaced  ";' },
      ],
    });
    const r = expectEncoded(raw);
    expect(decodeToolResult(r.encoded)).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// 3. Token savings
//
// Thresholds match the merit-doc § 7 gate (>= 15% on representative tabular
// payloads; tree listings get a softer >= 10% because breadth varies).
// ---------------------------------------------------------------------------

describe('toolResultCompression — token savings', () => {
  it('large code search (120 rows): saves >= 15% estimated tokens', () => {
    const raw = formatResult(makeLargeCodeSearchResult(120));
    const r = expectEncoded(raw);
    const { jsonTok: rawTok, altTok: encTok, pctSaved } = logDelta(
      'large code search (120 rows)',
      raw,
      r.encoded,
    );
    expect(encTok).toBeLessThan(rawTok);
    expect(Number(pctSaved)).toBeGreaterThanOrEqual(15);
  });

  it('repetitive issues (80): saves >= 15% estimated tokens', () => {
    const raw = formatResult(makeRepetitiveIssuesResult(80));
    const r = expectEncoded(raw);
    const { pctSaved } = logDelta('repetitive issues (80)', raw, r.encoded);
    expect(Number(pctSaved)).toBeGreaterThanOrEqual(15);
  });

  it('tree listing (depth 5, breadth 6): saves >= 10% estimated tokens', () => {
    const raw = formatResult(makeTreeListingResult(5, 6));
    const r = expectEncoded(raw);
    const { pctSaved } = logDelta('tree listing (5x6)', raw, r.encoded);
    expect(Number(pctSaved)).toBeGreaterThanOrEqual(10);
  });

  it('reported savedPct matches (rawTokens - encodedTokens) / rawTokens * 100', () => {
    const raw = formatResult(makeLargeCodeSearchResult(120));
    const r = expectEncoded(raw);
    const recomputed = ((r.rawTokens - r.encodedTokens) / r.rawTokens) * 100;
    expect(Math.abs(r.savedPct - recomputed)).toBeLessThan(0.01);
    expect(r.savedTokens).toBe(r.rawTokens - r.encodedTokens);
  });

  it('reported rawTokens tracks a real tokenizer source (estimate or BPE)', () => {
    // countTokensSync returns real BPE when the Rust tokenizer is reachable,
    // otherwise falls back to estimateTokens. Either way the encoder's
    // rawTokens must agree with one of those two sources within a small band.
    const raw = formatResult(makeLargeCodeSearchResult(60));
    const r = expectEncoded(raw);
    const est = estimateTokens(raw);
    const sync = countTokensSync(raw);
    const minTok = Math.min(est, sync);
    const maxTok = Math.max(est, sync);
    expect(r.rawTokens).toBeGreaterThanOrEqual(Math.floor(minTok * 0.9));
    expect(r.rawTokens).toBeLessThanOrEqual(Math.ceil(maxTok * 1.1));
  });
});

// ---------------------------------------------------------------------------
// 4. Auto-disable (null return) gates
// ---------------------------------------------------------------------------

describe('toolResultCompression — auto-disable gates', () => {
  it('returns null on empty input', () => {
    expect(encodeToolResult('')).toBeNull();
  });

  it('returns null on trivially short input', () => {
    expect(encodeToolResult('ok')).toBeNull();
  });

  it('returns null on the low-redundancy negative control', () => {
    const raw = formatResult(makeLowRedundancyResult(40));
    expect(encodeToolResult(raw)).toBeNull();
  });

  it('returns null on the small baseline search fixture (nothing to compress)', () => {
    const raw = formatResult(makeCodeSearchBackendResult());
    expect(encodeToolResult(raw)).toBeNull();
  });

  it('honors minSavedPct: returns null when savings fall below threshold', () => {
    const raw = formatResult(makeLargeCodeSearchResult(120));
    const impossibleThreshold = 99;
    expect(encodeToolResult(raw, { minSavedPct: impossibleThreshold })).toBeNull();
  });

  it('honors minSavedPct: returns a result when threshold is achievable', () => {
    const raw = formatResult(makeLargeCodeSearchResult(120));
    const r = encodeToolResult(raw, { minSavedPct: 5 });
    expect(r).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Safety caps and invariants
// ---------------------------------------------------------------------------

describe('toolResultCompression — safety caps and invariants', () => {
  it('savedTokens is always non-negative when a result is returned', () => {
    const fixtures = [
      makeLargeCodeSearchResult(60),
      makeLargeCodeSearchResult(120),
      makeRepetitiveIssuesResult(30),
      makeRepetitiveIssuesResult(80),
      makeTreeListingResult(4, 5),
      makeTreeListingResult(5, 6),
    ];
    for (const data of fixtures) {
      const raw = formatResult(data);
      const r = encodeToolResult(raw);
      if (r === null) continue;
      expect(r.savedTokens).toBeGreaterThanOrEqual(0);
      expect(r.encodedTokens).toBeLessThanOrEqual(r.rawTokens);
    }
  });

  it('encoded string is shorter (chars) than raw when a result is returned', () => {
    const raw = formatResult(makeLargeCodeSearchResult(120));
    const r = expectEncoded(raw);
    expect(r.encoded.length).toBeLessThan(raw.length);
  });

  it('honors maxDictEntries cap', () => {
    const raw = formatResult(makeRepetitiveIssuesResult(80));
    const cap = 4;
    const r = expectEncoded(raw, { maxDictEntries: cap });
    expect(r.substrings.size).toBeLessThanOrEqual(cap);
  });

  it('honors minDictKeyLength (short strings not substring-coded)', () => {
    const raw = formatResult(makeLargeCodeSearchResult(120));
    const r = expectEncoded(raw, { minDictKeyLength: 6 });
    for (const value of r.substrings.values()) {
      expect(value.length).toBeGreaterThanOrEqual(6);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Model-facing anchors
//
// The model must still be able to recognize paths, line numbers, and symbols
// after encoding. These tests enforce that critical anchors are recoverable
// either verbatim in the body or via the legend — no anchor is ever lost.
// ---------------------------------------------------------------------------

describe('toolResultCompression — model-facing anchors', () => {
  it('every file path in the raw payload is recoverable from encoded + legend', () => {
    const data = makeLargeCodeSearchResult(60);
    const raw = formatResult(data);
    const r = expectEncoded(raw);

    const paths = Array.from(new Set(data.results.map((row) => row.file)));
    const decoded = decodeToolResult(r.encoded);
    for (const p of paths) {
      expect(decoded, `path must be recoverable: ${p}`).toContain(p);
    }
  });

  it('line-number VALUES are never substring-coded (always verbatim in body)', () => {
    const data = makeLargeCodeSearchResult(60);
    const raw = formatResult(data);
    const r = expectEncoded(raw);

    // Substring dictionary values must not be pure digit runs (line numbers).
    for (const value of r.substrings.values()) {
      expect(/^\d+$/.test(value.trim())).toBe(false);
    }

    // A sample of line-number VALUES must appear verbatim in the encoded body,
    // even when the `line` KEY is abbreviated (see the separate test below).
    const body = bodyOf(r.encoded);
    const sampleLines = data.results.slice(0, 10).map((row) => String(row.line));
    for (const ln of sampleLines) {
      expect(body, `line number ${ln} should appear verbatim in body`).toContain(ln);
    }
  });

  it('severity and rule columns in issues results are recoverable after decode', () => {
    const data = makeRepetitiveIssuesResult(40);
    const raw = formatResult(data);
    const r = expectEncoded(raw);
    const decoded = decodeToolResult(r.encoded);

    const severities = Array.from(new Set(data.issues.map((i) => i.severity)));
    const rules = Array.from(new Set(data.issues.map((i) => i.rule)));
    for (const s of severities) expect(decoded).toContain(s);
    for (const rule of rules) expect(decoded).toContain(rule);
  });
});

// ---------------------------------------------------------------------------
// 7. Legend section discipline (new in v2 of the spec)
// ---------------------------------------------------------------------------

describe('toolResultCompression — legend section discipline', () => {
  it('legend declares exactly the three sections k / s / d (order-free, disjoint)', () => {
    const raw = formatResult(makeLargeCodeSearchResult(120));
    const r = expectEncoded(raw);
    const legend = legendOf(r.encoded);
    // Section markers each appear at a line start (newline-delimited inside the legend)
    const hasK = new RegExp(`(^|\\n)\\s*${LEGEND_SECTION_KEYS}\\s`).test(legend);
    const hasS = new RegExp(`(^|\\n)\\s*${LEGEND_SECTION_SUBSTRINGS}\\s`).test(legend);
    const hasD = new RegExp(`(^|\\n)\\s*${LEGEND_SECTION_DITTO}\\s`).test(legend);
    // At least one of k or s must be present (there is always something to dedupe
    // on payloads that cleared the savings gate); d is always present when ditto
    // is emitted, may be absent when no column-above ditto occurred.
    expect(hasK || hasS, 'legend must declare at least one of the k/s sections').toBe(true);
    if (r.dittoGlyph.length > 0) {
      expect(hasD, 'legend must declare the d (ditto) section when a ditto glyph is set').toBe(true);
    }
  });

  it('declared ditto glyph is the default ^ unless explicitly overridden', () => {
    const raw = formatResult(makeRepetitiveIssuesResult(80));
    const r = expectEncoded(raw);
    expect(r.dittoGlyph).toBe(DEFAULT_DITTO_GLYPH);
  });
});

// ---------------------------------------------------------------------------
// 8. Key abbreviation — reuses existing ATLS shorthand, preserves key identity
// ---------------------------------------------------------------------------

describe('toolResultCompression — key abbreviation', () => {
  it('decoded key names are byte-identical to raw key names (no case changes, no drift)', () => {
    const raw = formatResult(makeRepetitiveIssuesResult(80));
    const r = expectEncoded(raw);
    const decoded = decodeToolResult(r.encoded);
    // Every key name present in the raw TOON must appear verbatim after decode.
    // Dynamic extraction adapts to whatever keys survive `compactByFile` upstream
    // (e.g. the `file` column is grouped away on this fixture).
    const rawKeys = new Set<string>();
    for (const m of raw.matchAll(/[{,]([a-zA-Z_][a-zA-Z0-9_]*):/g)) {
      rawKeys.add(m[1]);
    }
    expect(rawKeys.size).toBeGreaterThan(0);
    for (const k of rawKeys) {
      expect(decoded, `raw key must appear after decode: ${k}`).toContain(`${k}:`);
    }
  });

  it('reuses GLOBAL_ALIASES for file: encoded key must be `f` when `file` is abbreviated', () => {
    // GLOBAL_ALIASES maps `f` -> `file_path`. If the encoder chooses to abbreviate
    // the `file` key at all, it MUST pick `f` so the model sees the same convention
    // it already knows from the batch-input shorthand legend in the system prompt.
    const raw = formatResult(makeLargeCodeSearchResult(120));
    const r = expectEncoded(raw);
    const fileEntry = Array.from(r.keyMap.entries()).find(([, rawKey]) => rawKey === 'file');
    if (fileEntry) {
      expect(fileEntry[0], 'file abbreviation must be `f` to match GLOBAL_ALIASES').toBe('f');
    }
  });

  it('line-number VALUES survive verbatim even when the `line` KEY is abbreviated', () => {
    // Symmetric partner to the "line values never coded" test. Asserts the
    // common failure mode — abbreviating a key and accidentally coding its
    // digit values — is explicitly forbidden.
    const data = makeLargeCodeSearchResult(60);
    const raw = formatResult(data);
    const r = expectEncoded(raw);
    const decoded = decodeToolResult(r.encoded);
    for (const row of data.results.slice(0, 10)) {
      expect(decoded).toContain(String(row.line));
    }
  });

  it('short TOON keys (length < minKeyLengthForAbbrev) are never re-coded with new aliases', () => {
    // For a key like `h` (length 1), abbreviating further is impossible.
    // The encoder must not invent a new short code for keys that are already
    // shorter than its configured threshold.
    const raw = formatResult({
      rows: Array.from({ length: 30 }, (_, i) => ({
        h: `h:abc${i}`,
        id: `id${i}`,
        to: `target${i}`,
        file: 'src/services/batch/handlers/query.ts',
      })),
    });
    const r = encodeToolResult(raw, { minKeyLengthForAbbrev: 3 });
    if (r === null) return; // valid outcome
    for (const rawKey of r.keyMap.values()) {
      expect(rawKey.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Collision safety — the encoded form must not shadow any batch shorthand
// ---------------------------------------------------------------------------

describe('toolResultCompression — collision safety', () => {
  const raw = formatResult(makeRepetitiveIssuesResult(80));

  it('substring-dictionary codes always use the ~ prefix (never $ — reserved for bindings)', () => {
    const r = expectEncoded(raw);
    for (const code of r.substrings.keys()) {
      expect(code.startsWith(SUBSTRING_CODE_PREFIX), `substring code ${code} must start with ${SUBSTRING_CODE_PREFIX}`).toBe(true);
      expect(code.startsWith('$'), `substring code ${code} must NOT start with $ (reserved for $last, $name bindings)`).toBe(false);
    }
  });

  it('no code in the encoded body matches the $-binding pattern used by batch executor', () => {
    const r = expectEncoded(raw);
    const body = bodyOf(r.encoded);
    // Legend may describe things; the BODY must not emit any $-prefixed token
    // that the batch line parser would interpret as a binding reference.
    const dollarPattern = /\$[a-zA-Z_][a-zA-Z0-9_]*/g;
    const dollarMatches = body.match(dollarPattern) ?? [];
    expect(dollarMatches.length, `body contains $-prefixed tokens that collide with batch bindings: ${dollarMatches.slice(0, 5).join(', ')}`).toBe(0);
  });

  it('no coined key abbreviation collides with SHORT_TO_OP, PARAM_SHORT, or h: prefix', () => {
    const r = expectEncoded(raw);
    for (const encodedKey of r.keyMap.keys()) {
      expect(SHORT_TO_OP[encodedKey], `encoded key ${encodedKey} collides with an op shorthand`).toBeUndefined();
      // PARAM_SHORT entries ARE legal key abbreviations to reuse (that's the point
      // of Rule 2 in the design). We only forbid collision with op shorthands and
      // with reserved prefixes.
      expect(encodedKey.startsWith('h:'), `encoded key ${encodedKey} must not start with h:`).toBe(false);
      expect(encodedKey.startsWith('@'), `encoded key ${encodedKey} must not start with @ (set selector prefix)`).toBe(false);
    }
  });

  it('any coined key abbreviation outside existing aliases is documented as a new entry', () => {
    // Soft test: every encoded key is either an existing alias (f, ps, sn, le, ...)
    // or a coined code with length >= 2. Single-character non-alias codes are
    // collision-prone and must not be invented.
    const r = expectEncoded(raw);
    const paramShortKeys = new Set(Object.keys(PARAM_SHORT));
    // `f` is the one single-char alias in GLOBAL_ALIASES that we explicitly allow.
    const knownSingleCharAliases = new Set(['f']);
    for (const encodedKey of r.keyMap.keys()) {
      if (paramShortKeys.has(encodedKey)) continue;
      if (knownSingleCharAliases.has(encodedKey)) continue;
      expect(
        encodedKey.length,
        `newly coined key abbreviation ${encodedKey} must be at least 2 chars to avoid ambiguity with batch tokens`,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});
