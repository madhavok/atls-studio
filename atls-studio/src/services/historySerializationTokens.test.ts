/**
 * JSON.stringify vs TOON-based history serialization — token footprint.
 */
import { describe, expect, it } from 'vitest';

import { estimateHistoryTokens, analyzeHistoryBreakdown } from './historyCompressor';
import { estimateTokens } from '../utils/contextHash';
import { countTokensSync } from '../utils/tokenCounter';
import { formatResult, serializeMessageContentForTokens } from '../utils/toon';
import {
  logTokenDelta,
  logObjectJsonVsFormatResult,
} from '../utils/toonDeltaTestHelpers';

function makeCodeSearchBackendResult() {
  return {
    queries: ['foo', 'bar'],
    results: [
      { file: 'src/a.ts', line: 10, snippet: 'const foo = 1;' },
      { file: 'src/b.ts', line: 22, snippet: 'export function bar() {}' },
    ],
    total_matches: 2,
  };
}

function makeMemorySearchStructured() {
  return {
    tool: 'search.memory',
    query: 'token',
    region_summary: 'active:2',
    total_hits: 2,
    entries: [
      {
        region: 'active' as const,
        ref: 'h:deadbeef',
        source: 'read.context',
        type: 'context',
        tokens: 120,
        hits: [
          { lineNumber: 1, line: 'line with token' },
          { lineNumber: 5, line: 'another token hit' },
        ],
      },
    ],
  };
}

describe('historySerializationTokens', () => {
  it('serializeMessageContentForTokens is more compact than JSON.stringify for tool blocks', () => {
    const content = [
      { type: 'text', text: 'Plan' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'batch',
        input: { version: '1.0', steps: [{ id: 's1', use: 'read.context', with: { file_paths: ['a.ts'] } }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: { ok: true, results: [{ file: 'x.ts', line: 1 }] },
      },
    ];
    const json = JSON.stringify(content);
    const ser = serializeMessageContentForTokens(content);
    const { jsonTok, altTok } = logTokenDelta(
      'assistant message blocks (tool_use + tool_result)',
      json,
      ser,
      'serializeMessageContentForTokens',
    );
    expect(ser.length).toBeLessThan(json.length);
    expect(altTok).toBeLessThan(jsonTok);
  });

  it('estimateHistoryTokens uses TOON serialization for array content', () => {
    const history = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'batch', input: { x: 1, y: [2, 3] } },
        ],
      },
    ];
    const arr = history[1].content as unknown[];
    logTokenDelta(
      'assistant array only: JSON.stringify vs serializeMessageContentForTokens',
      JSON.stringify(arr),
      serializeMessageContentForTokens(arr),
      'serializeMessageContentForTokens',
    );

    const legacyJson = history.reduce((sum, msg) => {
      if (typeof msg.content === 'string') return sum + estimateTokens(msg.content);
      if (Array.isArray(msg.content)) return sum + estimateTokens(JSON.stringify(msg.content));
      return sum;
    }, 0);
    const toonPath = estimateHistoryTokens(history);
    const delta = legacyJson - toonPath;
    const pct = legacyJson === 0 ? '0.0' : ((delta / legacyJson) * 100).toFixed(1);
    console.log(
      `[TOON delta] full history estimateHistoryTokens vs legacy JSON.stringify(array) | legacy: ${legacyJson} tok | current: ${toonPath} tok | Δ ${delta} tok (${pct}%)`,
    );

    const tk = estimateHistoryTokens(history);
    const manual = countManualArrayHistoryTokens(history);
    expect(tk).toBe(manual);
  });

  it('analyzeHistoryBreakdown counts tool_use with TOON input string', () => {
    const history = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'x', input: { a: 1, b: 2 } },
        ],
      },
    ];
    const arr = history[0].content as unknown[];
    logTokenDelta(
      'breakdown fixture: tool_use input JSON.stringify vs serializeForTokenEstimate path',
      JSON.stringify(arr),
      serializeMessageContentForTokens(arr),
      'serializeMessageContentForTokens',
    );

    const b = analyzeHistoryBreakdown(history, 0);
    console.log(
      `[TOON delta] analyzeHistoryBreakdown totals | total:${b.total} compressed:${b.compressed} toolUse:${b.toolUse} toolResults:${b.toolResults} assistantText:${b.assistantText}`,
    );
    expect(b.total).toBeGreaterThan(0);
    expect(b.toolUse).toBeGreaterThan(0);
  });

  it('code_search-shaped result: formatResult(TOON) saves tokens vs JSON', () => {
    const data = makeCodeSearchBackendResult();
    const { jsonTok, altTok } = logObjectJsonVsFormatResult('code_search-shaped backend result', data);
    expect(altTok).toBeLessThan(jsonTok);
  });

  it('search.memory structured payload: formatResult(TOON) vs JSON.stringify', () => {
    const structured = makeMemorySearchStructured();
    const { jsonTok, altTok } = logObjectJsonVsFormatResult('search.memory structured payload', structured);
    expect(altTok).toBeLessThan(jsonTok);
    expect(formatResult(structured)).toContain('search.memory');
  });
});

function countManualArrayHistoryTokens(history: Array<{ role: string; content: unknown }>): number {
  return history.reduce((sum, msg) => {
    if (typeof msg.content === 'string') return sum + countTokensSync(msg.content);
    if (Array.isArray(msg.content)) return sum + countTokensSync(serializeMessageContentForTokens(msg.content));
    return sum;
  }, 0);
}
