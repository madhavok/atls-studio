import { beforeEach, describe, expect, it } from 'vitest';
import { compressToolLoopHistory, deflateToolResults, estimateHistoryTokens } from './historyCompressor';
import { useContextStore } from '../stores/contextStore';

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
    const count = compressToolLoopHistory(history, 3, 0);
    const after = estimateHistoryTokens(history);

    expect(count).toBeGreaterThan(0);
    expect(typeof history[1]?.content).toBe('string');
    expect(String(history[1]?.content)).toContain('[->');
    expect(history[3]?.content).toBe(recentAssistant);
    expect(history[5]?.content).toBe(latestAssistant);
    expect(after).toBeLessThan(before);
  });
});

describe('compressToolLoopHistory dedup', () => {
  beforeEach(() => resetStore());

  it('reuses an existing chunk by content hash instead of creating a duplicate', () => {
    const bigContent = 'export const data = ' + 'x'.repeat(3000) + ';\n';
    useContextStore.getState().addChunk(bigContent, 'smart', 'src/data.ts');
    const chunkCountBefore = useContextStore.getState().chunks.size;

    // The target tool_result is in round 0. With PROTECTED_RECENT_ROUNDS=2
    // and currentRound=4, skipThreshold=2, so round 0 is eligible.
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

    const count = compressToolLoopHistory(history, 4, 0);
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

    const count = compressToolLoopHistory(history, 4, 0);
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
});
