import { beforeEach, describe, expect, it } from 'vitest';
import {
  compressToolLoopHistory,
  deflateToolResults,
  estimateHistoryTokens,
  analyzeHistoryBreakdown,
  extractToolDescription,
} from './historyCompressor';
import { ROLLING_SUMMARY_MARKER } from './historyDistiller';
import { useContextStore } from '../stores/contextStore';
import { useAppStore } from '../stores/appStore';
import { hashContentSync } from '../utils/contextHash';

function resetStore() {
  useContextStore.getState().resetSession();
}

describe('compressToolLoopHistory', () => {
  beforeEach(() => resetStore());

  it('replaces oversized older text rounds while preserving the protected recent window', () => {
    const oldestAssistant = 'A'.repeat(4000);
    const recentAssistant = 'B'.repeat(4000);
    const latestAssistant = 'C'.repeat(4000);
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'initial request' },
      { role: 'assistant', content: oldestAssistant },
      { role: 'user', content: 'tool results 1' },
      { role: 'assistant', content: 'round 1 filler' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'round 2 filler' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: recentAssistant },
      { role: 'user', content: 'tool results 4' },
      { role: 'assistant', content: latestAssistant },
      { role: 'user', content: 'tool results 5' },
    ];

    const before = estimateHistoryTokens(history);
    const count = compressToolLoopHistory(history, 8, 0);
    const after = estimateHistoryTokens(history);

    expect(count).toBeGreaterThan(0);
    expect(typeof history[1]?.content).toBe('string');
    expect(String(history[1]?.content)).toContain('[h:');
    expect(after).toBeLessThan(before);
  });

  it('compresses large text blocks in array-shaped assistant messages', () => {
    const bigText = 'N'.repeat(4000);
    const toolUseId = 'tu_arr';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: bigText },
          { type: 'tool_use', id: toolUseId, name: 'batch', input: { version: '1.0', steps: [] } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: '{ "ok": true }' }],
      },
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r3' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r4' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r5' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r6' },
      { role: 'user', content: 'ok' },
    ];

    const before = estimateHistoryTokens(history);
    const count = compressToolLoopHistory(history, 8, 0);
    const textBlock = (history[1].content as Array<{ type: string; text?: string }>)[0];

    expect(count).toBeGreaterThan(0);
    expect(textBlock.type).toBe('text');
    expect(String(textBlock.text)).toContain('[h:');
    expect(estimateHistoryTokens(history)).toBeLessThan(before);
  });

  it('compresses large text when stored on block.content instead of block.text', () => {
    const bigText = 'M'.repeat(4000);
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'text', content: bigText }] },
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r3' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r4' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r5' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r6' },
      { role: 'user', content: 'ok' },
    ];

    const count = compressToolLoopHistory(history, 8, 0);
    const textBlock = (history[1].content as Array<{ type: string; content?: string }>)[0];

    expect(count).toBeGreaterThan(0);
    expect(String(textBlock.content)).toContain('[h:');
  });
});

describe('compressToolLoopHistory [Stopped] fragments', () => {
  beforeEach(() => resetStore());

  it('compresses small [Stopped] assistant messages below the normal threshold', () => {
    const stoppedContent = 'Let me check\n\n*[Stopped]*';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: stoppedContent },
      { role: 'user', content: 'ok continue' },
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r3' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r4' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r5' },
      { role: 'user', content: 'ok' },
    ];

    const count = compressToolLoopHistory(history, 7, 0);
    expect(count).toBeGreaterThan(0);
    expect(String(history[1].content)).toContain('[h:');
  });

  it('compresses [Stopped] text blocks in array-shaped assistant messages', () => {
    const stoppedText = 'Partial output\n\n*[Stopped]*';
    const toolUseId = 'tu_stop';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: stoppedText },
          { type: 'tool_use', id: toolUseId, name: 'batch', input: { version: '1.0', steps: [] } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r3' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r4' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r5' },
      { role: 'user', content: 'ok' },
    ];

    const count = compressToolLoopHistory(history, 7, 0);
    expect(count).toBeGreaterThan(0);
    const textBlock = (history[1].content as Array<{ type: string; text?: string }>)[0];
    expect(String(textBlock.text)).toContain('[h:');
  });
});

describe('compressToolLoopHistory orphaned compressed rolling summaries', () => {
  beforeEach(() => resetStore());

  it('removes compressed rolling summary pointers from history', () => {
    const orphanedRef = '[-> h:a1b2c3d4, 969tk | history:assistant:[Rolling Summary] decisions...files...]';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'assistant', content: orphanedRef },
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'round 0' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'round 1' },
      { role: 'user', content: 'ok' },
    ];

    compressToolLoopHistory(history, 3, 0);

    const hasOrphan = history.some(
      (m) => typeof m.content === 'string' && m.content === orphanedRef,
    );
    expect(hasOrphan).toBe(false);
  });

  it('increments orphanSummaryRemovals in appStore when orphans are removed', () => {
    const orphanedRef = '[-> h:a1b2c3d4, 969tk | history:assistant:[Rolling Summary] decisions...files...]';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'assistant', content: orphanedRef },
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'round 0' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'round 1' },
      { role: 'user', content: 'ok' },
    ];

    const before = useAppStore.getState().promptMetrics.orphanSummaryRemovals;
    compressToolLoopHistory(history, 3, 0);
    const after = useAppStore.getState().promptMetrics.orphanSummaryRemovals;
    expect(after).toBeGreaterThan(before);
  });
});

describe('compressToolLoopHistory dedup', () => {
  beforeEach(() => resetStore());

  it('reuses an existing chunk by content hash instead of creating a duplicate', () => {
    const bigContent = 'export const data = ' + 'x'.repeat(5000) + ';\n';
    useContextStore.getState().addChunk(bigContent, 'smart', 'src/data.ts');
    const chunkCountBefore = useContextStore.getState().chunks.size;

    const toolUseId = 'tu_ctx';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUseId, name: 'batch', input: { version: '1.0', steps: [{ use: 'read.context', with: { file_paths: ['src/data.ts'] } }] } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: bigContent },
        ],
      },
      { role: 'assistant', content: 'step 2' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 3' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 4' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 5' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 6' },
      { role: 'user', content: 'ok' },
    ];

    const count = compressToolLoopHistory(history, 8, 0);
    expect(count).toBeGreaterThan(0);

    const toolResult = (history[2].content as Array<{ content: string }>)[0];
    expect(toolResult.content).toContain('[h:');

    const chunkCountAfter = useContextStore.getState().chunks.size;
    expect(chunkCountAfter).toBe(chunkCountBefore);
  });

  it('reuses a batch-handler chunk with different source via source-match fallback', () => {
    const bigContent = 'export function search() {}\n'.repeat(400);
    useContextStore.getState().addChunk('different serialization of same result', 'search', 'search.code:auth');
    const chunkCountBefore = useContextStore.getState().chunks.size;

    const toolUseId = 'tu_search';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'find auth' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUseId, name: 'batch', input: { version: '1.0', steps: [{ use: 'search.code', with: { queries: ['auth'] } }] } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: bigContent },
        ],
      },
      { role: 'assistant', content: 'step 2' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 3' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 4' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 5' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 6' },
      { role: 'user', content: 'ok' },
    ];

    const count = compressToolLoopHistory(history, 8, 0);
    expect(count).toBeGreaterThan(0);

    const toolResult = (history[2].content as Array<{ content: string }>)[0];
    expect(toolResult.content).toContain('[h:');

    const chunkCountAfter = useContextStore.getState().chunks.size;
    expect(chunkCountAfter).toBe(chunkCountBefore);
  });
});

// ---------------------------------------------------------------------------
// deflateToolResults
// ---------------------------------------------------------------------------

describe('deflateToolResults', () => {
  beforeEach(() => resetStore());

  it('replaces tool_result content with pointer when content hash matches a chunk', () => {
    const fileContent = 'export function hello() { return "world"; }\n'.repeat(20);
    const store = useContextStore.getState();
    const hash = store.addChunk(fileContent, 'smart', 'src/hello.ts');

    const toolResults = [
      { type: 'tool_result', tool_use_id: 'tu_1', content: fileContent },
    ];
    const history: Array<{ role: string; content: unknown }> = [];

    const count = deflateToolResults(toolResults, history);

    expect(count).toBe(1);
    expect(toolResults[0].content).toContain('[h:');
    expect(toolResults[0].content).toContain(`h:${hash.slice(0, 8)}`);
    expect(toolResults[0].content).not.toContain('export function hello');
  });

  it('skips tool_results that are already deflated', () => {
    const toolResults = [
      { type: 'tool_result', tool_use_id: 'tu_1', content: '[-> h:abc123, 50tk | already deflated]' },
    ];
    const history: Array<{ role: string; content: unknown }> = [];

    const count = deflateToolResults(toolResults, history);

    expect(count).toBe(0);
    expect(toolResults[0].content).toBe('[-> h:abc123, 50tk | already deflated]');
  });

  it('does not deflate content that has no matching chunk', () => {
    const content = 'some unique content not in the store';
    const toolResults = [
      { type: 'tool_result', tool_use_id: 'tu_1', content },
    ];
    const history: Array<{ role: string; content: unknown }> = [];

    const count = deflateToolResults(toolResults, history);

    expect(count).toBe(0);
    expect(toolResults[0].content).toBe(content);
  });

  it('does not alias batch results when tool_use is missing (no source-match on generic label)', () => {
    useContextStore.getState().addChunk('stale shared placeholder', 'result', 'tool_result');
    const a = 'x'.repeat(4000);
    const b = 'y'.repeat(4000);
    const countA = deflateToolResults(
      [{ type: 'tool_result', tool_use_id: 'id-a', content: a }],
      [],
    );
    const countB = deflateToolResults(
      [{ type: 'tool_result', tool_use_id: 'id-b', content: b }],
      [],
    );
    expect(countA).toBe(1);
    expect(countB).toBe(1);
    expect(useContextStore.getState().chunks.get(hashContentSync(a))).toBeDefined();
    expect(useContextStore.getState().chunks.get(hashContentSync(b))).toBeDefined();
  });

  it('falls back to source-based matching when content hash differs', () => {
    // batch tool_use with steps — extractToolDescription produces "read.context:src/app.ts"
    const toolUseId = 'tu_batch';
    const history: Array<{ role: string; content: unknown }> = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUseId, name: 'batch', input: { version: '1.0', steps: [{ use: 'read.context', with: { file_paths: ['src/app.ts'] } }] } },
        ],
      },
    ];

    // Store a chunk whose source matches the description "read.context:src/app.ts"
    useContextStore.getState().addChunk('original file content', 'smart', 'read.context:src/app.ts');

    const toolResults = [
      { type: 'tool_result', tool_use_id: toolUseId, content: 'different content but same source description' },
    ];

    const count = deflateToolResults(toolResults, history);

    expect(count).toBe(1);
    expect(toolResults[0].content).toContain('[h:');
  });

  it('deflates multiple tool_results in a single pass', () => {
    const store = useContextStore.getState();
    const content1 = 'file one content\n'.repeat(15);
    const content2 = 'file two content\n'.repeat(15);
    store.addChunk(content1, 'smart', 'src/one.ts');
    store.addChunk(content2, 'smart', 'src/two.ts');

    const toolResults = [
      { type: 'tool_result', tool_use_id: 'tu_1', content: content1 },
      { type: 'tool_result', tool_use_id: 'tu_2', content: content2 },
    ];
    const history: Array<{ role: string; content: unknown }> = [];

    const count = deflateToolResults(toolResults, history);

    expect(count).toBe(2);
    expect(toolResults[0].content).toContain('[h:');
    expect(toolResults[1].content).toContain('[h:');
  });

  it('deflates using source-match when content hash differs', () => {
    const store = useContextStore.getState();
    // Add a chunk whose source matches a tool description
    store.addChunk('full file content for app.ts\n'.repeat(10), 'smart', 'read.context:src/app.ts');

    const toolResults = [
      { type: 'tool_result', tool_use_id: 'tu_read', content: 'serialized differently but same file' },
    ];
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_read', name: 'read', input: { path: 'src/app.ts' } }] },
    ];

    // The content hash won't match, but description resolves to "read:src/app.ts"
    // which won't match "read.context:src/app.ts" exactly — this tests that the
    // deflation path doesn't crash and returns 0 when no match is found.
    const count = deflateToolResults(toolResults, history);
    // Source "read:src/app.ts" !== "read.context:src/app.ts" so no match
    expect(count).toBe(0);

    // Now test with an exact source match
    store.addChunk('exact match content\n'.repeat(10), 'result', 'read:src/app.ts');
    const toolResults2 = [
      { type: 'tool_result', tool_use_id: 'tu_read', content: 'different serialization' },
    ];
    const count2 = deflateToolResults(toolResults2, history);
    expect(count2).toBe(1);
    expect(toolResults2[0].content).toContain('[h:');
  });
});

describe('compressToolLoopHistory rolling window', () => {
  beforeEach(() => resetStore());

  it('removes oldest round into rolling summary when rounds exceed ROLLING_WINDOW_ROUNDS', () => {
    const history: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 22; i++) {
      history.push({ role: 'assistant', content: `assistant round ${i}` });
      history.push({ role: 'user', content: `user round ${i}` });
    }
    const beforeLen = history.length;
    const beforeRolling = useAppStore.getState().promptMetrics.rollingSavings;
    compressToolLoopHistory(history, 30, 0);
    expect(history.length).toBeLessThan(beforeLen);
    expect(history[0].role).toBe('assistant');
    expect(String(history[0].content)).toContain(ROLLING_SUMMARY_MARKER);
    expect(useAppStore.getState().promptMetrics.rollingSavings).toBeGreaterThan(beforeRolling);
  });

  it('never compresses the rolling summary message to a hash pointer', () => {
    const history: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 25; i++) {
      history.push({ role: 'assistant', content: `Round ${i} decision about architecture and implementation approach` });
      history.push({ role: 'user', content: `acknowledged round ${i}` });
    }

    compressToolLoopHistory(history, 30, 0);

    const summaryIdx = history.findIndex(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && String(m.content).includes(ROLLING_SUMMARY_MARKER),
    );
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    const content = String(history[summaryIdx].content);
    expect(content).not.toMatch(/^\[h:/);
    expect(content).toContain(ROLLING_SUMMARY_MARKER);
  });

  it('rolling summary does not contain hash pointer strings after repeated compression', () => {
    const history: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 25; i++) {
      history.push({ role: 'assistant', content: `Decision ${i}: chose approach that optimizes for performance and clarity` });
      history.push({ role: 'user', content: `acknowledged decision ${i}` });
    }

    for (let pass = 0; pass < 3; pass++) {
      compressToolLoopHistory(history, 30 + pass, 0);
    }

    const summaryIdx = history.findIndex(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && String(m.content).includes(ROLLING_SUMMARY_MARKER),
    );
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    const content = String(history[summaryIdx].content);
    expect(content).not.toContain('[h:');
  });
});

describe('compressToolLoopHistory emergency mode', () => {
  beforeEach(() => resetStore());

  it('emergency mode compresses round 0 tool result when called at round 1', () => {
    const bigResult = 'x'.repeat(6000);
    const toolUseId = 'tu_big';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUseId, name: 'read', input: { path: 'big.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: bigResult },
        ],
      },
      { role: 'assistant', content: 'round 1 response' },
      { role: 'user', content: 'ok' },
    ];

    const count = compressToolLoopHistory(history, 1, 0, { emergency: true });
    expect(count).toBeGreaterThan(0);
    const toolResult = (history[2].content as Array<{ content: string }>)[0];
    expect(toolResult.content).toContain('[h:');
  });

  it('normal mode does NOT compress round 0 tool result when called at round 1', () => {
    const bigResult = 'y'.repeat(6000);
    const toolUseId = 'tu_big2';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUseId, name: 'read', input: { path: 'big2.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: bigResult },
        ],
      },
      { role: 'assistant', content: 'round 1 response' },
      { role: 'user', content: 'ok' },
    ];

    compressToolLoopHistory(history, 1, 0);
    const toolResult = (history[2].content as Array<{ content: string }>)[0];
    expect(toolResult.content).toBe(bigResult);
  });
});

describe('analyzeHistoryBreakdown protectedTokens', () => {
  it('reports protectedTokens for compressible items in the protected window', () => {
    const bigResult = 'z'.repeat(6000);
    const toolUseId = 'tu_analyze';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUseId, name: 'read', input: { path: 'file.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: bigResult },
        ],
      },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'ok' },
    ];

    const breakdown = analyzeHistoryBreakdown(history, 0, 1);
    expect(breakdown.compressibleTokens).toBeGreaterThan(0);
    expect(breakdown.protectedTokens).toBe(breakdown.compressibleTokens);
  });

  it('reports zero protectedTokens when compressible items are outside the window', () => {
    const bigResult = 'w'.repeat(6000);
    const toolUseId = 'tu_old';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUseId, name: 'read', input: { path: 'old.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: bigResult },
        ],
      },
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r3' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r4' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'r5' },
      { role: 'user', content: 'ok' },
    ];

    // skipThreshold = max(0, currentRound - PROTECTED_RECENT_ROUNDS); need currentRound >= 2 so round-0 tool_result is outside the last 1 round.
    const breakdown = analyzeHistoryBreakdown(history, 0, 2);
    expect(breakdown.compressibleTokens).toBeGreaterThan(0);
    expect(breakdown.protectedTokens).toBe(0);
  });

  it('reports zero protectedTokens when currentRound is not provided', () => {
    const bigResult = 'v'.repeat(6000);
    const toolUseId = 'tu_noround';
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUseId, name: 'read', input: { path: 'any.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: bigResult },
        ],
      },
    ];

    const breakdown = analyzeHistoryBreakdown(history, 0);
    expect(breakdown.compressibleTokens).toBeGreaterThan(0);
    expect(breakdown.protectedTokens).toBe(0);
  });
});

describe('extractToolDescription (batch stub)', () => {
  it('preserves stub summary including change preview marker', () => {
    const stub =
      '2 steps: change×1 | change:preview(dry_run)';
    expect(extractToolDescription('batch', { _stubbed: stub, version: '1.0' })).toBe(`batch:${stub}`);
  });
});
