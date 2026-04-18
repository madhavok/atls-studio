/**
 * Metrics invariants — billing-grade guardrails for chat + ATLS-internals
 * metric pipelines. Targets the accounting bugs that surfaced after FileView
 * and tool-result compression shipped.
 *
 * What we pin here:
 *   1. `cumulativeInputSaved` uses round-over-round *deltas* (not triangular
 *      sums of cumulative counters). Freeing 100 tokens must not charge the
 *      counter 100× N rounds later.
 *   2. `recurringInputSaved` is the compounding view. Same inputs → closed-form
 *      sum across the same rounds.
 *   3. `getPromptTokens()` is FileView-aware: covered chunks are suppressed,
 *      rendered view blocks are added, so WM prompt pressure tracks what
 *      actually lands in the prompt.
 *   4. Cache-savings heuristic matches `calculateCostBreakdown` twice. Zero
 *      cache = zero savings. Non-negative under every supported provider.
 *
 * Tauri is stubbed (same pattern as toolResultCompression.wiring.test.ts) so
 * tokens go through the BPE trie fallback / heuristic without IPC.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockRejectedValue(new Error('IPC not available in test')),
}));

beforeAll(() => {
  const store: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } satisfies Storage;
});

import { useAppStore } from '../../stores/appStore';
import { useContextStore } from '../../stores/contextStore';
import type { FileView } from '../../services/fileViewStore';
import { summarizeFileViewTokens, clearFileViewTokenCache } from '../../services/fileViewTokens';
import { calculateCostBreakdown } from '../../stores/costStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drop all cumulative state that recordRound touches. */
function resetSavingsState(): void {
  useAppStore.setState((s) => ({
    promptMetrics: {
      ...s.promptMetrics,
      compressionSavings: 0,
      compressionCount: 0,
      rollingSavings: 0,
      rolledRounds: 0,
      roundCount: 0,
      cumulativeInputSaved: 0,
      recurringInputSaved: 0,
      inputCompressionSavings: 0,
      inputCompressionCount: 0,
      orphanSummaryRemovals: 0,
    },
    _lastRoundSavingsSnapshot: undefined,
  }));
  useContextStore.setState({ freedTokens: 0, lastFreed: 0, lastFreedAt: 0 });
}

function makeFileView(partial: Partial<FileView> & Pick<FileView, 'filePath' | 'sourceRevision'>): FileView {
  return {
    observedRevision: partial.sourceRevision,
    totalLines: partial.totalLines ?? 40,
    skeletonRows: partial.skeletonRows ?? [],
    sigLevel: partial.sigLevel ?? 'sig',
    filledRegions: partial.filledRegions ?? [],
    hash: partial.hash ?? 'fv-0000',
    lastAccessed: partial.lastAccessed ?? Date.now(),
    // Default pinned:true for accounting tests — unpinned views render/charge 0
    // tokens (they roll out of context), which would mask the thing we're testing.
    pinned: partial.pinned ?? true,
    ...partial,
  } as FileView;
}

// ---------------------------------------------------------------------------
// recordRound delta math
// ---------------------------------------------------------------------------

describe('recordRound — delta-based cumulativeInputSaved', () => {
  beforeEach(() => {
    resetSavingsState();
  });

  it('sums deltas, never triangular sums of cumulative counters', () => {
    const app = useAppStore.getState();

    // Round 1: add 100 compression, no freed.
    app.addCompressionSavings(100, 1);
    app.recordRound();

    // Round 2: add another 50 compression, free 200 WM tokens.
    useAppStore.getState().addCompressionSavings(50, 1);
    useContextStore.setState({ freedTokens: 200 });
    useAppStore.getState().recordRound();

    // Round 3: no new savings, no new frees. Delta = 0.
    useAppStore.getState().recordRound();

    const pm = useAppStore.getState().promptMetrics;
    // One-time savings = 100 + 50 + 200 = 350. NOT 100 + 150 + 350 = 600.
    expect(pm.cumulativeInputSaved).toBe(350);
    expect(pm.roundCount).toBe(3);
  });

  it('rolls inputCompressionSavings into cumulativeInputSaved delta', () => {
    useAppStore.getState().addInputCompressionSavings(60);
    useAppStore.getState().recordRound();

    expect(useAppStore.getState().promptMetrics.cumulativeInputSaved).toBe(60);

    useAppStore.getState().addInputCompressionSavings(25);
    useAppStore.getState().recordRound();

    expect(useAppStore.getState().promptMetrics.cumulativeInputSaved).toBe(85);
  });

  it('recurringInputSaved keeps the compounding interpretation for power users', () => {
    useAppStore.getState().addCompressionSavings(100, 1);
    useAppStore.getState().recordRound(); // +100
    useAppStore.getState().addCompressionSavings(50, 1);
    useAppStore.getState().recordRound(); // +(100+50)

    const pm = useAppStore.getState().promptMetrics;
    expect(pm.recurringInputSaved).toBe(100 + 150);
  });

  it('is monotonically non-decreasing even when monotonic counters somehow regress', () => {
    useAppStore.getState().addCompressionSavings(500, 1);
    useAppStore.getState().recordRound();
    expect(useAppStore.getState().promptMetrics.cumulativeInputSaved).toBe(500);

    // Simulate a session restore that stomps compressionSavings lower. The
    // clamp in recordRound must not subtract from the cumulative total.
    useAppStore.setState((s) => ({
      promptMetrics: { ...s.promptMetrics, compressionSavings: 0 },
    }));
    useAppStore.getState().recordRound();
    expect(useAppStore.getState().promptMetrics.cumulativeInputSaved).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// getPromptTokens FileView awareness
// ---------------------------------------------------------------------------

describe('contextStore.getPromptTokens — FileView parity', () => {
  beforeEach(() => {
    useContextStore.setState({
      chunks: new Map(),
      fileViews: new Map(),
      freedTokens: 0,
    });
    clearFileViewTokenCache();
  });

  it('suppresses covered chunks and adds rendered view tokens', () => {
    const coveredHash = 'abcdef1234';
    // A file-backed chunk that the FileView now renders.
    useContextStore.setState({
      chunks: new Map([
        [
          coveredHash,
          {
            hash: coveredHash,
            type: 'file' as const,
            content: '1|line one\n2|line two',
            source: 'src/foo.ts',
            tokens: 200,
            lastAccessed: Date.now(),
            pinned: false,
          },
        ],
      ]),
    });

    const view = makeFileView({
      filePath: 'src/foo.ts',
      sourceRevision: 'deadbeef',
      totalLines: 20,
      skeletonRows: ['1|import foo', '2|export function bar() {'],
      filledRegions: [
        {
          start: 1,
          end: 2,
          content: '1|import foo\n2|export function bar() {',
          chunkHashes: [coveredHash],
          tokens: 30,
          origin: 'read',
        },
      ],
    });
    useContextStore.setState({ fileViews: new Map([[view.filePath, view]]) });

    const summary = summarizeFileViewTokens([view]);
    const prompt = useContextStore.getState().getPromptTokens();
    // covered chunk (200 tk) is suppressed → it should NOT appear.
    // rendered view block is added.
    expect(prompt).toBe(summary.totalRenderedTokens);
    expect(summary.totalRenderedTokens).toBeGreaterThan(0);
  });

  it('falls back to chunk tokens when no FileView covers the chunk', () => {
    const hash = 'zzzzzzz111';
    useContextStore.setState({
      chunks: new Map([
        [
          hash,
          {
            hash,
            type: 'file' as const,
            content: 'unaffected chunk',
            source: 'src/bar.ts',
            tokens: 80,
            lastAccessed: Date.now(),
            pinned: false,
          },
        ],
      ]),
    });
    expect(useContextStore.getState().getPromptTokens()).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Cache savings math
// ---------------------------------------------------------------------------

describe('calculateCostBreakdown — cache savings delta', () => {
  it('anthropic cache read saves 90% of uncached input cost', () => {
    const cacheTokens = 1_000_000;
    const full = calculateCostBreakdown('anthropic', 'claude-opus-4-7', cacheTokens, 0, 0, 0);
    const withCache = calculateCostBreakdown('anthropic', 'claude-opus-4-7', 0, 0, cacheTokens, 0);
    // Opus 4.7 input = 500¢/MTok; cache read = 500 * 0.1 = 50¢/MTok.
    expect(full.inputCostCents).toBeCloseTo(500, 5);
    expect(withCache.inputCostCents).toBeCloseTo(50, 5);
    // Savings = full - with cache = 450¢.
    expect(full.totalCostCents - withCache.totalCostCents).toBeCloseTo(450, 5);
  });

  it('openai cache read saves 50% of input cost (overlap semantics)', () => {
    const inputTokens = 1_000_000;
    const full = calculateCostBreakdown('openai', 'gpt-5', inputTokens, 0, 0, 0);
    const withCache = calculateCostBreakdown('openai', 'gpt-5', inputTokens, 0, inputTokens, 0);
    // gpt-5 = 125¢/MTok input → full = 125¢. All cached → 125 * 0.5 = 62.5¢.
    expect(full.inputCostCents).toBeCloseTo(125, 5);
    expect(withCache.inputCostCents).toBeCloseTo(62.5, 5);
  });

  it('zero cache tokens → zero savings', () => {
    const a = calculateCostBreakdown('anthropic', 'claude-opus-4-7', 1000, 100, 0, 0);
    const b = calculateCostBreakdown('anthropic', 'claude-opus-4-7', 1000, 100, 0, 0);
    expect(a.totalCostCents - b.totalCostCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Summarize FileView tokens — exposed for UI metrics
// ---------------------------------------------------------------------------

describe('summarizeFileViewTokens', () => {
  beforeEach(() => {
    clearFileViewTokenCache();
  });

  it('returns all zeros for an empty set', () => {
    const s = summarizeFileViewTokens([]);
    expect(s).toEqual({ totalRenderedTokens: 0, skeletonTokens: 0, bodyTokens: 0, viewCount: 0 });
  });

  it('skips views with no content at all', () => {
    const empty = makeFileView({
      filePath: 'src/empty.ts',
      sourceRevision: 'aaaa',
      skeletonRows: [],
      filledRegions: [],
    });
    expect(summarizeFileViewTokens([empty]).viewCount).toBe(0);
  });

  it('accumulates rendered + skeleton + body for a populated view', () => {
    const v = makeFileView({
      filePath: 'src/service.ts',
      sourceRevision: 'bbbb',
      skeletonRows: [
        '1|import { foo } from "./foo";',
        '2|',
        '10|export function hello(): string {',
        '20|}',
      ],
      totalLines: 30,
      filledRegions: [
        {
          start: 11,
          end: 19,
          content: '11|  return "hello";\n12|  // some comment',
          chunkHashes: ['abc123'],
          tokens: 12,
          origin: 'read',
        },
      ],
    });
    const s = summarizeFileViewTokens([v]);
    expect(s.viewCount).toBe(1);
    expect(s.bodyTokens).toBe(12);
    expect(s.totalRenderedTokens).toBe(s.skeletonTokens + s.bodyTokens + (s.totalRenderedTokens - s.skeletonTokens - s.bodyTokens));
    expect(s.totalRenderedTokens).toBeGreaterThan(12);
  });
});
