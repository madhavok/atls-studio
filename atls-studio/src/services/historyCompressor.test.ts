import { beforeEach, describe, expect, it } from 'vitest';
import { compressToolLoopHistory, deflateToolResults, estimateHistoryTokens } from './historyCompressor';
import { ROLLING_SUMMARY_MARKER } from './historyDistiller';
import { useContextStore } from '../stores/contextStore';
import { useAppStore } from '../stores/appStore';

function resetStore() {
  useContextStore.getState().resetSession();
}

describe('compressToolLoopHistory', () => {
  beforeEach(() => resetStore());

  it('replaces oversized older text rounds while preserving the protected recent window', () => {
    const oldestAssistant = 'A'.repeat(2200);
    const recentAssistant = 'B'.repeat(2200);
    const latestAssistant = 'C'.repeat(2200);
    const history = [
      { role: 'user', content: 'initial request' },
      { role: 'assistant', content: oldestAssistant },
      { role: 'user', content: 'tool results 1' },
      { role: 'assistant', content: recentAssistant },
      { role: 'user', content: 'tool results 2' },
      { role: 'assistant', content: latestAssistant },
      { role: 'user', content: 'tool results 3' },
    ];

    const before = estimateHistoryTokens(history);
    const count = compressToolLoopHistory(history, 5, 0);
    const after = estimateHistoryTokens(history);

    expect(count).toBeGreaterThan(0);
    expect(typeof history[1]?.content).toBe('string');
    expect(String(history[1]?.content)).toContain('[->');
    expect(history[3]?.content).toBe(recentAssistant);
    expect(history[5]?.content).toBe(latestAssistant);
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
    ];

    const before = estimateHistoryTokens(history);
    const count = compressToolLoopHistory(history, 6, 0);
    const textBlock = (history[1].content as Array<{ type: string; text?: string }>)[0];

    expect(count).toBeGreaterThan(0);
    expect(textBlock.type).toBe('text');
    expect(String(textBlock.text)).toContain('[->');
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
    ];

    const count = compressToolLoopHistory(history, 6, 0);
    const textBlock = (history[1].content as Array<{ type: string; content?: string }>)[0];

    expect(count).toBeGreaterThan(0);
    expect(String(textBlock.content)).toContain('[->');
  });
});

describe('compressToolLoopHistory dedup', () => {
  beforeEach(() => resetStore());

  it('reuses an existing chunk by content hash instead of creating a duplicate', () => {
    const bigContent = 'export const data = ' + 'x'.repeat(3000) + ';\n';
    useContextStore.getState().addChunk(bigContent, 'smart', 'src/data.ts');
    const chunkCountBefore = useContextStore.getState().chunks.size;

    // The target tool_result is in round 0. With PROTECTED_RECENT_ROUNDS=4
    // and currentRound=6, skipThreshold=2, so round 0 is eligible.
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
      // Rounds 1-3 pad history past the protection window
      { role: 'assistant', content: 'step 2' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 3' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 4' },
      { role: 'user', content: 'ok' },
    ];

    const count = compressToolLoopHistory(history, 6, 0);
    expect(count).toBeGreaterThan(0);

    const toolResult = (history[2].content as Array<{ content: string }>)[0];
    expect(toolResult.content).toContain('[->');

    // No new chunk should have been created — the existing 'smart' chunk was reused
    const chunkCountAfter = useContextStore.getState().chunks.size;
    expect(chunkCountAfter).toBe(chunkCountBefore);
  });

  it('reuses a batch-handler chunk with different source via source-match fallback', () => {
    const bigContent = 'export function search() {}\n'.repeat(80);
    // Batch handler stores with step-based source (matching extractToolDescription output)
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
      // Pad past the protection window
      { role: 'assistant', content: 'step 2' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 3' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'step 4' },
      { role: 'user', content: 'ok' },
    ];

    const count = compressToolLoopHistory(history, 6, 0);
    expect(count).toBeGreaterThan(0);

    const toolResult = (history[2].content as Array<{ content: string }>)[0];
    expect(toolResult.content).toContain('[->');

    // Source-match found the existing 'search' chunk — no new chunk created
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
    expect(toolResults[0].content).toContain('[->');
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
    expect(toolResults[0].content).toContain('[->');
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
    expect(toolResults[0].content).toContain('[->');
    expect(toolResults[1].content).toContain('[->');
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
    expect(toolResults2[0].content).toContain('[->');
  });
});

describe('compressToolLoopHistory rolling window', () => {
  beforeEach(() => resetStore());

  it('removes oldest round into rolling summary when rounds exceed ROLLING_WINDOW_ROUNDS', () => {
    const history: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 17; i++) {
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
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'assistant', content: `Round ${i} decision about architecture and implementation approach` });
      history.push({ role: 'user', content: `acknowledged round ${i}` });
    }

    compressToolLoopHistory(history, 30, 0);

    const summaryIdx = history.findIndex(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && String(m.content).includes(ROLLING_SUMMARY_MARKER),
    );
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    const content = String(history[summaryIdx].content);
    expect(content).not.toMatch(/^\[->/);
    expect(content).toContain(ROLLING_SUMMARY_MARKER);
  });

  it('rolling summary does not contain hash pointer strings after repeated compression', () => {
    const history: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 20; i++) {
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
    expect(content).not.toContain('[-> h:');
  });
});
