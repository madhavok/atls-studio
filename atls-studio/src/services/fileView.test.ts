import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      settings: {
        selectedProvider: 'anthropic',
        selectedModel: 'claude-3-5-sonnet-20241022',
      },
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));

const {
  SKELETON_TOKEN_BUDGET_DEFAULT,
  clearSkeletonCache,
  getFileSkeleton,
  mergeSkeletonRows,
  normalizePath,
  parseAnchor,
  parseFoldMarker,
  parseLineNumber,
  parseRows,
  skeletonCacheSize,
} = await import('./fileView');

describe('fileView — parse helpers', () => {
  it('parseLineNumber extracts the 1-based line number from the N|CONTENT prefix', () => {
    expect(parseLineNumber('   1|import foo;')).toBe(1);
    expect(parseLineNumber('  42|fn bar() { ... } [42-56]')).toBe(42);
    expect(parseLineNumber('2000|const foo = 1;')).toBe(2000);
  });

  it('parseLineNumber returns null for malformed rows', () => {
    expect(parseLineNumber('no prefix here')).toBeNull();
    expect(parseLineNumber('|no leading number')).toBeNull();
    expect(parseLineNumber('')).toBeNull();
  });

  it('parseFoldMarker extracts [start-end] range', () => {
    expect(parseFoldMarker('  42|fn bar() { ... } [42-56]')).toEqual({ start: 42, end: 56 });
    expect(parseFoldMarker(' 205|fn x() { ... } [205-213]')).toEqual({ start: 205, end: 213 });
  });

  it('parseFoldMarker returns null when no marker present', () => {
    expect(parseFoldMarker('  42|type Foo = number;')).toBeNull();
    expect(parseFoldMarker('  42|fn bar() {')).toBeNull();
  });

  it('parseFoldMarker rejects inverted ranges', () => {
    expect(parseFoldMarker('  42|fn bad { ... } [56-42]')).toBeNull();
  });

  it('parseAnchor composes line + foldedness', () => {
    const a = parseAnchor('  42|fn bar(): T { ... } [42-56]');
    expect(a).toEqual({
      line: 42,
      endLine: 56,
      raw: '  42|fn bar(): T { ... } [42-56]',
      folded: true,
    });

    const b = parseAnchor('   3|type Foo = string;');
    expect(b).toEqual({
      line: 3,
      endLine: undefined,
      raw: '   3|type Foo = string;',
      folded: false,
    });
  });

  it('parseRows filters non-prefixed lines', () => {
    const text = [
      '   1|import React from "react";',
      'this is an orphan line',
      '  17|const FOO = 1;',
      '',
      '  42|fn bar(): T { ... } [42-56]',
    ].join('\n');
    expect(parseRows(text)).toEqual([
      '   1|import React from "react";',
      '  17|const FOO = 1;',
      '  42|fn bar(): T { ... } [42-56]',
    ]);
  });

  it('normalizePath is forward-slash + lowercase', () => {
    expect(normalizePath('Atls-Studio/Src/Utils/Foo.Ts')).toBe('atls-studio/src/utils/foo.ts');
    expect(normalizePath('atls-studio\\src\\foo.ts')).toBe('atls-studio/src/foo.ts');
    expect(normalizePath('A\\B\\C')).toBe('a/b/c');
  });
});

describe('fileView — mergeSkeletonRows', () => {
  it('merges sig and imports rows in ascending line order', () => {
    const imports = [
      '   1|import { foo } from "./foo";',
      '   2|import { bar } from "./bar";',
    ];
    const sig = [
      '  42|fn a() { ... } [42-56]',
      '  58|fn b() { ... } [58-70]',
    ];
    expect(mergeSkeletonRows(imports, sig)).toEqual([
      '   1|import { foo } from "./foo";',
      '   2|import { bar } from "./bar";',
      '  42|fn a() { ... } [42-56]',
      '  58|fn b() { ... } [58-70]',
    ]);
  });

  it('deduplicates by line number with imports winning over sig', () => {
    const imports = ['   1|IMPORT WINS'];
    const sig = ['   1|SIG LOSES', '  42|fn b() { ... } [42-56]'];
    expect(mergeSkeletonRows(imports, sig)).toEqual([
      '   1|IMPORT WINS',
      '  42|fn b() { ... } [42-56]',
    ]);
  });

  it('skips malformed rows silently', () => {
    const imports = ['junk', '   1|import "a";'];
    const sig = ['malformed too', '  42|fn b() { ... } [42-56]'];
    expect(mergeSkeletonRows(imports, sig)).toEqual([
      '   1|import "a";',
      '  42|fn b() { ... } [42-56]',
    ]);
  });

  it('handles empty inputs', () => {
    expect(mergeSkeletonRows([], [])).toEqual([]);
    expect(mergeSkeletonRows([], ['  42|fn a() { ... } [42-56]'])).toEqual([
      '  42|fn a() { ... } [42-56]',
    ]);
    expect(mergeSkeletonRows(['   1|import "a";'], [])).toEqual(['   1|import "a";']);
  });

  it('sorts large-line-number entries correctly (lexicographic trap)', () => {
    // 100 sorts before 9 lexicographically; numeric sort should keep them in order.
    const rows = [
      '   9|nine',
      ' 100|onehundred',
      '  10|ten',
    ];
    expect(mergeSkeletonRows([], rows)).toEqual([
      '   9|nine',
      '  10|ten',
      ' 100|onehundred',
    ]);
  });
});

describe('fileView — getFileSkeleton', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    clearSkeletonCache();
  });

  /** Build a deterministic fake resolver keyed on the shape suffix (sig / imports / fold). */
  function makeInvoker(outputs: {
    sig?: string;
    imports?: string;
    fold?: string;
    totalLines?: number;
  }) {
    return vi.fn(async (rawRef: string) => {
      if (rawRef.endsWith(':sig')) {
        return { content: outputs.sig ?? '', total_lines: outputs.totalLines };
      }
      if (rawRef.endsWith(':imports')) {
        return { content: outputs.imports ?? '', total_lines: outputs.totalLines };
      }
      if (rawRef.endsWith(':fold')) {
        return { content: outputs.fold ?? '', total_lines: outputs.totalLines };
      }
      throw new Error(`unexpected shape: ${rawRef}`);
    });
  }

  it('composes imports + sig rows with correct order and token count', async () => {
    const invoker = makeInvoker({
      sig: [
        '  17|const FOO = 1;',
        '  42|fn bar(): T { ... } [42-56]',
      ].join('\n'),
      imports: ['   1|import { x } from "./x";', '   2|import { y } from "./y";'].join('\n'),
      totalLines: 100,
    });

    const sk = await getFileSkeleton('src/foo.ts', 'abc123', { invoker });

    expect(sk.path).toBe('src/foo.ts');
    expect(sk.revision).toBe('abc123');
    expect(sk.totalLines).toBe(100);
    expect(sk.sigLevel).toBe('sig');
    expect(sk.rows).toEqual([
      '   1|import { x } from "./x";',
      '   2|import { y } from "./y";',
      '  17|const FOO = 1;',
      '  42|fn bar(): T { ... } [42-56]',
    ]);
    expect(sk.tokens).toBeGreaterThan(0);
  });

  it('caches by path and short-circuits on same revision', async () => {
    const invoker = makeInvoker({
      sig: '  17|const FOO = 1;',
      imports: '   1|import "a";',
      totalLines: 20,
    });

    const a = await getFileSkeleton('src/foo.ts', 'rev1', { invoker });
    const b = await getFileSkeleton('src/foo.ts', 'rev1', { invoker });
    expect(b).toBe(a);
    expect(invoker).toHaveBeenCalledTimes(2); // sig + imports for rev1 only
  });

  it('reinvokes on revision change (cache-miss)', async () => {
    const invoker = makeInvoker({
      sig: '  17|const FOO = 1;',
      imports: '   1|import "a";',
      totalLines: 20,
    });

    await getFileSkeleton('src/foo.ts', 'rev1', { invoker });
    await getFileSkeleton('src/foo.ts', 'rev2', { invoker });
    expect(invoker).toHaveBeenCalledTimes(4); // rev1 sig+imports, rev2 sig+imports
  });

  it('uses normalized path as cache key (backslash and case collapse)', async () => {
    const invoker = makeInvoker({
      sig: '  17|const FOO = 1;',
      imports: '',
      totalLines: 20,
    });

    const a = await getFileSkeleton('Src\\Foo.ts', 'rev1', { invoker });
    const b = await getFileSkeleton('src/foo.ts', 'rev1', { invoker });
    expect(b).toBe(a);
    expect(invoker).toHaveBeenCalledTimes(2); // one cache population only
  });

  it('deterministic output per revision (same invoker returns same skeleton)', async () => {
    const invoker = makeInvoker({
      sig: '  42|fn bar(): T { ... } [42-56]',
      imports: '   1|import "a";',
      totalLines: 100,
    });

    const a = await getFileSkeleton('src/foo.ts', 'rev1', { invoker });
    clearSkeletonCache();
    const b = await getFileSkeleton('src/foo.ts', 'rev1', { invoker });
    expect(b.rows).toEqual(a.rows);
    expect(b.tokens).toBe(a.tokens);
    expect(b.sigLevel).toBe(a.sigLevel);
  });

  it('falls back to fold when sig exceeds token budget', async () => {
    // Generate a sig that trivially exceeds a low budget; the fold version is smaller.
    const bigSig = Array.from({ length: 200 }, (_, i) =>
      `  ${String(i + 1).padStart(4)}|fn f${i}(): T { ... } [${i + 1}-${i + 10}]`,
    ).join('\n');
    const smallFold = '  10|fn f9(): T { ... } [10-15]';

    const invoker = makeInvoker({
      sig: bigSig,
      fold: smallFold,
      imports: '',
      totalLines: 500,
    });

    const sk = await getFileSkeleton('src/big.ts', 'rev1', { invoker, budget: 50 });
    expect(sk.sigLevel).toBe('fold');
    expect(sk.rows).toEqual(['  10|fn f9(): T { ... } [10-15]']);
    // Invoker calls: sig (over budget), fold, imports.
    expect(invoker).toHaveBeenCalledTimes(3);
  });

  it('keeps sig level when under budget', async () => {
    const invoker = makeInvoker({
      sig: '  17|const FOO = 1;',
      fold: 'SHOULD NOT BE CALLED',
      imports: '',
      totalLines: 20,
    });

    const sk = await getFileSkeleton('src/foo.ts', 'rev1', { invoker, budget: 10_000 });
    expect(sk.sigLevel).toBe('sig');
    expect(sk.rows).toEqual(['  17|const FOO = 1;']);
    expect(invoker).toHaveBeenCalledTimes(2); // sig + imports; fold not touched
  });

  it('sig→fold transition still produces slice-native overlay-compatible rows', async () => {
    // Both sig and fold rows expose slice-native [start-end] markers; the fill
    // algorithm walks the rows by line number regardless of which produced them.
    const bigSig = Array.from({ length: 50 }, (_, i) =>
      `  ${String(i + 1).padStart(4)}|fn f${i}() { ... } [${i + 1}-${i + 5}]`,
    ).join('\n');
    const fold = [
      '   1|// header',
      '  20|fn top() { ... } [20-30]',
      '  35|fn other() { ... } [35-40]',
    ].join('\n');

    const invoker = makeInvoker({ sig: bigSig, fold, imports: '', totalLines: 60 });
    const sk = await getFileSkeleton('src/x.ts', 'rev1', { invoker, budget: 40 });
    expect(sk.sigLevel).toBe('fold');
    // Rows remain parseable as slice-native overlays.
    const [row] = sk.rows.filter(r => r.includes('[20-30]'));
    expect(parseFoldMarker(row)).toEqual({ start: 20, end: 30 });
  });

  it('handles missing imports gracefully (best-effort)', async () => {
    const invoker = vi.fn(async (rawRef: string) => {
      if (rawRef.endsWith(':sig')) return { content: '  17|const FOO = 1;', total_lines: 20 };
      if (rawRef.endsWith(':imports')) throw new Error('imports not supported');
      throw new Error(`unexpected: ${rawRef}`);
    });

    const sk = await getFileSkeleton('src/foo.ts', 'rev1', { invoker });
    expect(sk.rows).toEqual(['  17|const FOO = 1;']);
    expect(sk.sigLevel).toBe('sig');
  });

  it('yields empty rows for unparseable files', async () => {
    const invoker = makeInvoker({ sig: '', imports: '', totalLines: 0 });
    const sk = await getFileSkeleton('src/binary.bin', 'rev1', { invoker });
    expect(sk.rows).toEqual([]);
    expect(sk.tokens).toBe(0);
  });

  it('respects the default token budget constant', () => {
    expect(SKELETON_TOKEN_BUDGET_DEFAULT).toBeGreaterThan(0);
    expect(SKELETON_TOKEN_BUDGET_DEFAULT).toBeLessThanOrEqual(5000);
  });

  it('enforces cache eviction when over SKELETON_CACHE_MAX', async () => {
    const invoker = makeInvoker({ sig: '  1|x = 1;', imports: '', totalLines: 1 });
    // Warm with 150 unique paths; cap is 100 — size should stay bounded.
    for (let i = 0; i < 150; i++) {
      await getFileSkeleton(`src/f${i}.ts`, 'rev1', { invoker });
    }
    expect(skeletonCacheSize()).toBeLessThanOrEqual(100);
  });

  // Regression: the Rust shape resolver historically reported
  // `total_lines = shaped.lines().count()` for sig/fold shapes — the count
  // of sig rows, NOT the source file's total line count. A sparse 8-row sig
  // skeleton for a 296-line file would leak `totalLines = 8` into the
  // FileView, rendering `(8 lines)` fence headers and mis-detecting
  // `wasDense` during edit-refresh.
  //
  // Defensive floor: `getFileSkeleton` now reports the max of the backend's
  // `total_lines` and the largest line / fold-end visible in the rows. This
  // keeps the view's denominator honest even if a shape response ever
  // regresses to the old output-row-count semantics.
  it('totalLines uses fold-end bound when sig response underreports total_lines', async () => {
    const invoker = makeInvoker({
      sig: [
        '  24|interface SectionDef { ... } [24-29]',
        '  53|function loadOrder(): string[] { ... } [53-69]',
        ' 107|export function AtlsInternals() { ... } [107-296]',
      ].join('\n'),
      imports: '',
      totalLines: 3, // bug: backend returns sig row count instead of source total
    });
    const sk = await getFileSkeleton('src/atls-internals.tsx', 'rev1', { invoker });
    // Fold [107-296] pins the lower bound to 296 despite the stale backend count.
    expect(sk.totalLines).toBe(296);
  });

  it('totalLines trusts correct backend total_lines over row max', async () => {
    const invoker = makeInvoker({
      sig: '  42|fn bar(): T { ... } [42-56]',
      imports: '   1|import "a";',
      totalLines: 500, // genuinely reported source total — row max is only 56
    });
    const sk = await getFileSkeleton('src/foo.ts', 'rev1', { invoker });
    expect(sk.totalLines).toBe(500);
  });

  it('uses imports total_lines when sig omits it', async () => {
    const invoker = vi.fn(async (rawRef: string) => {
      if (rawRef.endsWith(':sig')) {
        return { content: '  1|const x = 1;', total_lines: undefined };
      }
      if (rawRef.endsWith(':imports')) {
        return { content: '   1|import "a";', total_lines: 333 };
      }
      throw new Error(`unexpected: ${rawRef}`);
    });
    const sk = await getFileSkeleton('src/only-imports-tl.ts', 'h1', { invoker });
    expect(sk.totalLines).toBe(333);
  });
});
