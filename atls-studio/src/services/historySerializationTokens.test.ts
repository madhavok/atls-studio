/**
 * JSON.stringify vs TOON-based history serialization — token footprint.
 */
import { describe, expect, it } from 'vitest';

import { estimateHistoryTokens, analyzeHistoryBreakdown } from './historyCompressor';
import { estimateTokens } from '../utils/contextHash';
import { countTokensSync } from '../utils/tokenCounter';
import { formatResult, serializeMessageContentForTokens } from '../utils/toon';
import {
  makeCodeSearchBackendResult,
  makeMemorySearchStructured,
} from '../utils/toonFixtures';
import {
  logTokenDelta,
  logObjectJsonVsFormatResult,
  expectToonUnderstandable,
} from '../utils/toonDeltaTestHelpers';

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

  it('S7: serializeMessageContentForTokens retains tool identity and payload cues', () => {
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
    const ser = serializeMessageContentForTokens(content);
    const { jsonTok, altTok } = logTokenDelta(
      'S7 message blocks tool_use + tool_result',
      JSON.stringify(content),
      ser,
      'serializeMessageContentForTokens',
    );
    expect(altTok).toBeLessThan(jsonTok);
    expectToonUnderstandable(ser, [
      'tool_use',
      'batch',
      'call_1',
      'read.context',
      'ok:1',
      'x.ts',
    ]);
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
    const out = formatResult(structured);
    const { jsonTok, altTok } = logObjectJsonVsFormatResult('search.memory structured payload', structured);
    expect(altTok).toBeLessThan(jsonTok);
    expect(out).toContain('search.memory');
    expectToonUnderstandable(out, ['active', 'h:deadbeef', 'read.context', 'line with token']);
  });
});

function countManualArrayHistoryTokens(history: Array<{ role: string; content: unknown }>): number {
  return history.reduce((sum, msg) => {
    if (typeof msg.content === 'string') return sum + countTokensSync(msg.content);
    if (Array.isArray(msg.content)) return sum + countTokensSync(serializeMessageContentForTokens(msg.content));
    return sum;
  }, 0);
}
