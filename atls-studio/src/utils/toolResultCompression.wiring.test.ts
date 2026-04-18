/**
 * End-to-end wiring smoke test.
 *
 * Drives the full toggle path:
 *   useAppStore.setSettings({compressToolResults}) → formatResult() in toon.ts
 *     → registered compression provider in toolResultCompression.ts
 *     → encodeToolResult → back through the compression recorder → store telemetry
 *
 * Mocks Tauri IPC for the tokenizer but uses the real appStore and the real
 * encoder/decoder. Proves the three-file wiring (toon.ts ↔ appStore.ts ↔
 * toolResultCompression.ts) works without needing to launch the desktop app.
 */

import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';

// Mock Tauri IPC for countTokens — the rest of the flow uses real code.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockRejectedValue(new Error('IPC not available in test')),
}));

// The appStore's setSettings persists to localStorage. Stub it before importing.
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

import { formatResult } from './toon';
import { decodeToolResult, hasCompressionLegend } from './toolResultCompression';
import { useAppStore } from '../stores/appStore';
import { makeLargeCodeSearchResult, makeCodeSearchBackendResult } from './toonFixtures';

describe('input-compression wiring (end-to-end)', () => {
  beforeEach(() => {
    // Reset toggle to default between tests
    useAppStore.getState().setSettings({ compressToolResults: false });
  });

  it('toggle OFF: formatResult returns byte-identical raw TOON (no encoding)', () => {
    useAppStore.getState().setSettings({ compressToolResults: false });
    const out = formatResult(makeLargeCodeSearchResult(120));
    expect(hasCompressionLegend(out)).toBe(false);
    expect(out).not.toContain('<<dict');
  });

  it('toggle ON: formatResult emits an encoded payload (dict legend + compressed body)', () => {
    useAppStore.getState().setSettings({ compressToolResults: true });
    const out = formatResult(makeLargeCodeSearchResult(120));
    expect(hasCompressionLegend(out)).toBe(true);
    expect(out.startsWith('<<dict')).toBe(true);
    // decode must return a valid TOON-ish string equivalent to what formatResult
    // would have produced with the toggle off.
    const decoded = decodeToolResult(out);
    const rawEquivalent = (() => {
      useAppStore.getState().setSettings({ compressToolResults: false });
      return formatResult(makeLargeCodeSearchResult(120));
    })();
    expect(decoded).toBe(rawEquivalent);
  });

  it('toggle ON: savings are recorded in promptMetrics.inputCompressionSavings', () => {
    // Reset the counter to measure delta from zero
    const before = useAppStore.getState().promptMetrics.inputCompressionSavings ?? 0;
    const countBefore = useAppStore.getState().promptMetrics.inputCompressionCount ?? 0;

    useAppStore.getState().setSettings({ compressToolResults: true });
    formatResult(makeLargeCodeSearchResult(120));

    const after = useAppStore.getState().promptMetrics.inputCompressionSavings ?? 0;
    const countAfter = useAppStore.getState().promptMetrics.inputCompressionCount ?? 0;

    expect(after).toBeGreaterThan(before);
    expect(countAfter).toBe(countBefore + 1);
  });

  it('toggle ON but small payload: no encoding (null path), no telemetry increment', () => {
    const before = useAppStore.getState().promptMetrics.inputCompressionCount ?? 0;
    useAppStore.getState().setSettings({ compressToolResults: true });
    // Tiny payload — below MIN_RAW_BYTES; encoder returns null, formatResult returns raw.
    const out = formatResult(makeCodeSearchBackendResult());
    expect(hasCompressionLegend(out)).toBe(false);
    const after = useAppStore.getState().promptMetrics.inputCompressionCount ?? 0;
    expect(after).toBe(before);
  });

  it('flipping toggle off mid-session restores byte-identical baseline output', () => {
    const rawBaseline = (() => {
      useAppStore.getState().setSettings({ compressToolResults: false });
      return formatResult(makeLargeCodeSearchResult(120));
    })();

    useAppStore.getState().setSettings({ compressToolResults: true });
    const encoded = formatResult(makeLargeCodeSearchResult(120));
    expect(hasCompressionLegend(encoded)).toBe(true);

    useAppStore.getState().setSettings({ compressToolResults: false });
    const rawAgain = formatResult(makeLargeCodeSearchResult(120));
    expect(rawAgain).toBe(rawBaseline);
    expect(hasCompressionLegend(rawAgain)).toBe(false);
  });
});
