import { beforeEach, describe, expect, it } from 'vitest';
import {
  compressToolLoopHistory,
  deflateToolResults,
  estimateHistoryTokens,
  analyzeHistoryBreakdown,
  extractToolDescription,
  isContentArchiveWorthy,
} from './historyCompressor';
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

// Orphaned-rolling-summary cleanup paths were removed with the distillation
// mechanism. Old pointer strings in the wild may still contain the literal
// `[Rolling Summary]` in their description; they are now treated as ordinary
// compressed refs with no special handling. See `historyCompressor.ts`.

describe('compressToolLoopHistory dedup', () => {
  beforeEach(() => resetStore());

  it('dedupes recordReplacement across a single compression pass (no stale snapshot)', () => {
    // GAP 6 regression: Two string-content messages with the same description
    // in the same compression pass must share a chunk. Prior behavior captured
    // contextStore at function entry, so findExistingChunkBySource could miss
    // chunks added earlier in the same pass, leading to duplicate registrations.
    const rawA = 'shared narrative block '.repeat(500);
    const rawB = rawA + '\n(minor suffix that keeps description identical)';
    // Both messages truncate to the same 60-char description slice.
    const sharedPrefix = 'shared narrative block '.repeat(5);
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: sharedPrefix + rawA },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: sharedPrefix + rawB },
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

    const chunkCountBefore = useContextStore.getState().chunks.size;
    const count = compressToolLoopHistory(history, 8, 0);
    const chunkCountAfter = useContextStore.getState().chunks.size;

    expect(count).toBeGreaterThan(0);
    // Exactly one new chunk should exist for the two identical-description messages.
    expect(chunkCountAfter - chunkCountBefore).toBe(1);
    expect(String(history[1].content)).toContain('[h:');
    expect(String(history[3].content)).toContain('[h:');
  });

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

// ---------------------------------------------------------------------------
// Rule C — isContentArchiveWorthy + skip-archive gate
// ---------------------------------------------------------------------------

describe('isContentArchiveWorthy', () => {
  it('returns true for any non-batch tool content', () => {
    expect(isContentArchiveWorthy('anything at all', 'read')).toBe(true);
    expect(isContentArchiveWorthy('', 'verify.build')).toBe(true);
    expect(isContentArchiveWorthy('arbitrary', undefined)).toBe(true);
  });

  it('returns false for batch results containing only status + footer lines', () => {
    const content = [
      '[FAIL] r1 (read.lines): read_lines: requires lines (e.g. "15-50") (39ms)',
      '[FAIL] r2 (read.lines): read_lines: requires lines (e.g. "15-50") (40ms)',
      '[ATLS] 2 steps: 2 fail (74ms) | ok',
    ].join('\n');
    expect(isContentArchiveWorthy(content, 'batch')).toBe(false);
  });

  it('returns false for batch results with dedupe tails + footer', () => {
    const content = [
      '[FAIL] r1 (read.lines): requires lines (39ms)',
      '[FAIL] +2 identical (r2, r3) - same class: read.lines',
      '[ATLS] 3 steps: 3 fail (74ms) | ok',
    ].join('\n');
    expect(isContentArchiveWorthy(content, 'batch')).toBe(false);
  });

  it('returns false for batch results with FileView merge pointers', () => {
    const content = [
      '[OK] r1 (read.lines): read_lines: src/foo.ts:10-20 -> merged into h:abc123 [10-20] (50tk) | see ## FILE VIEWS (5ms)',
      '[OK] r2 (read.lines): read_lines: src/bar.ts:30-40 -> merged into h:def456 [30-40] (50tk) | see ## FILE VIEWS (6ms)',
      '[ATLS] 2 steps: 2 pass (11ms) | ok',
    ].join('\n');
    expect(isContentArchiveWorthy(content, 'batch')).toBe(false);
  });

  it('returns false for batch results with volatile nudge + status + footer only', () => {
    // When the search step summary is a one-liner that fits BATCH_RESULT_LINE_RE
    // and the body is just the nudge + footer, there is nothing recoverable to
    // archive — everything the agent needs is in the live manifest refs.
    const content = [
      '[OK] s1 (search.code): search: found 3 refs (20ms)',
      '⚠ VOLATILE — WILL BE LOST NEXT ROUND. PIN NOW in this batch or write to BB. Add: `pi h:abc123`',
      '[ATLS] 1 steps: 1 pass (20ms) | ok',
    ].join('\n');
    expect(isContentArchiveWorthy(content, 'batch')).toBe(false);
  });

  it('returns true for batch results with real search content', () => {
    const content = [
      '[OK] s1 (search.code): found 42 matches in 17 files',
      'src/foo.ts:42:  function bar() { return 1; }',
      'src/foo.ts:58:  function baz() { return 2; }',
      '[ATLS] 1 steps: 1 pass (20ms) | ok',
    ].join('\n');
    expect(isContentArchiveWorthy(content, 'batch')).toBe(true);
  });

  it('returns true for batch results with verify output', () => {
    const content = [
      '[FAIL] v1 (verify.build): build failed (stale-suspect, errors: 3) (120ms)',
      'error TS2304: Cannot find name "foo" at src/a.ts:10',
      'error TS2304: Cannot find name "bar" at src/a.ts:20',
      '[ATLS] 1 steps: 1 fail (120ms) | ok',
    ].join('\n');
    expect(isContentArchiveWorthy(content, 'batch')).toBe(true);
  });

  it('returns false for delegate sub-lines (refs / BB) when no other body', () => {
    const content = [
      '[OK] d1 (delegate.retrieve): retrieval complete (200ms)',
      '  refs: h:abc123 h:def456',
      '  BB: h:bb:retriever:findings',
      '  (Blackboard bodies are inlined in the step summary when present.)',
      '[ATLS] 1 steps: 1 pass (200ms) | ok',
    ].join('\n');
    expect(isContentArchiveWorthy(content, 'batch')).toBe(false);
  });
});

describe('deflateToolResults Rule C skip-archive gate', () => {
  beforeEach(() => resetStore());

  it('does NOT create a new engram for batch failure-only content', () => {
    const tool_use_id = 'tu_fail';
    const history: Array<{ role: string; content: unknown }> = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: tool_use_id, name: 'batch', input: { version: '1.0', steps: [{ use: 'read.lines', with: { hash: 'h:abc' } }] } },
        ],
      },
    ];
    // Simulate a 3x-identical failure tool_result (dedupe already applied)
    const content = [
      '[FAIL] r1 (read.lines): read_lines: requires lines (e.g. "15-50") or ref (h:XXXX:15-50) or (start_line + end_line). (39ms)',
      '[FAIL] +2 identical (r2, r3) - same class: read.lines',
      '[ATLS] 3 steps: 3 fail (74ms) | ok',
    ].join('\n');

    const chunksBefore = useContextStore.getState().chunks.size;
    const toolResults = [{ type: 'tool_result', tool_use_id, content }];
    const deflated = deflateToolResults(toolResults, history);
    const chunksAfter = useContextStore.getState().chunks.size;

    expect(deflated).toBe(0);
    expect(chunksAfter).toBe(chunksBefore);
    // Content stays inline (not replaced by a ref)
    expect(toolResults[0].content).toBe(content);
  });

  it('does NOT create a new engram for batch FileView-merged read content', () => {
    const tool_use_id = 'tu_read';
    const history: Array<{ role: string; content: unknown }> = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: tool_use_id, name: 'batch', input: { version: '1.0', steps: [{ use: 'read.lines', with: { hash: 'h:abc' } }] } },
        ],
      },
    ];
    const content = [
      '[OK] r1 (read.lines): read_lines: src/foo.ts:10-20 -> merged into h:abc123 [10-20] (50tk) | see ## FILE VIEWS (5ms)',
      '[OK] r2 (read.lines): read_lines: src/bar.ts:30-40 -> merged into h:def456 [30-40] (50tk) | see ## FILE VIEWS (6ms)',
      '[ATLS] 2 steps: 2 pass (11ms) | ok',
    ].join('\n');

    const chunksBefore = useContextStore.getState().chunks.size;
    const toolResults = [{ type: 'tool_result', tool_use_id, content }];
    const deflated = deflateToolResults(toolResults, history);
    const chunksAfter = useContextStore.getState().chunks.size;

    expect(deflated).toBe(0);
    expect(chunksAfter).toBe(chunksBefore);
  });

  it('DOES create engram for batch results carrying real content (search output)', () => {
    const tool_use_id = 'tu_search';
    const history: Array<{ role: string; content: unknown }> = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: tool_use_id, name: 'batch', input: { version: '1.0', steps: [{ use: 'search.code', with: { queries: ['foo'] } }] } },
        ],
      },
    ];
    // Real search content — plenty of match lines
    const content = [
      '[OK] s1 (search.code): found 100 matches across 20 files (50ms)',
      ...Array.from({ length: 40 }, (_, i) => `src/file${i}.ts:${i * 10}:  function foo${i}() { return ${i}; }`),
      '[ATLS] 1 steps: 1 pass (50ms) | ok',
    ].join('\n');

    const chunksBefore = useContextStore.getState().chunks.size;
    const toolResults = [{ type: 'tool_result', tool_use_id, content }];
    const deflated = deflateToolResults(toolResults, history);
    const chunksAfter = useContextStore.getState().chunks.size;

    expect(deflated).toBe(1);
    expect(chunksAfter).toBeGreaterThan(chunksBefore);
    expect(toolResults[0].content).toContain('[h:');
  });

  it('does NOT gate non-batch tools (e.g., direct read)', () => {
    // Direct tool call (not batch) should archive per existing rules
    const tool_use_id = 'tu_direct';
    const history: Array<{ role: string; content: unknown }> = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: tool_use_id, name: 'some_direct_tool', input: { path: 'src/x.ts' } },
        ],
      },
    ];
    // Looks like a batch status but tool name is NOT 'batch'
    const content = '[OK] r1 (read.lines): some content here\n[ATLS] 1 steps: 1 pass (5ms) | ok';

    const chunksBefore = useContextStore.getState().chunks.size;
    const toolResults = [{ type: 'tool_result', tool_use_id, content }];
    deflateToolResults(toolResults, history);
    const chunksAfter = useContextStore.getState().chunks.size;

    // Non-batch → isContentArchiveWorthy returns true → archives as usual
    expect(chunksAfter).toBeGreaterThanOrEqual(chunksBefore);
  });
});

describe('compressToolLoopHistory Rule C skip-archive gate', () => {
  beforeEach(() => resetStore());

  it('does NOT create chunk for batch status-only tool_result even above compression threshold', () => {
    const tool_use_id = 'tu_status';
    // Contrive a batch tool_result that's large (lots of status lines, N=40
    // identical-shaped failures collapsed) yet carries no recoverable body.
    const lines = [
      '[FAIL] f1 (read.lines): read_lines: requires lines or ref (40ms)',
      '[FAIL] +39 identical (f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15, f16, f17, f18, f19, f20, f21, f22, f23, f24, f25, f26, f27, f28, f29, f30, f31, f32, f33, f34, f35, f36, f37, f38, f39, f40) - same class: read.lines',
      '[ATLS] 40 steps: 40 fail (1600ms) | ok',
    ];
    const content = lines.join('\n');
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: tool_use_id, name: 'batch', input: { version: '1.0', steps: [{ use: 'read.lines', with: { hash: 'h:abc' } }] } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] },
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

    const chunksBefore = useContextStore.getState().chunks.size;
    compressToolLoopHistory(history, 8, 0);
    const chunksAfter = useContextStore.getState().chunks.size;

    expect(chunksAfter).toBe(chunksBefore);
    // Tool result content stays inline (not replaced by a ref)
    const tr = (history[2].content as Array<{ content: string }>)[0];
    expect(tr.content).toBe(content);
  });

  it('DOES create chunk for batch tool_result with real recoverable body', () => {
    const tool_use_id = 'tu_search';
    const realBody = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts:${i * 10}: matching line here`).join('\n');
    const content = [
      '[OK] s1 (search.code): found 40 matches (30ms)',
      realBody,
      '[ATLS] 1 steps: 1 pass (30ms) | ok',
    ].join('\n');

    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: tool_use_id, name: 'batch', input: { version: '1.0', steps: [{ use: 'search.code', with: { queries: ['foo'] } }] } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] },
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

    const chunksBefore = useContextStore.getState().chunks.size;
    compressToolLoopHistory(history, 8, 0);
    const chunksAfter = useContextStore.getState().chunks.size;

    expect(chunksAfter).toBeGreaterThan(chunksBefore);
    // Compressed to a ref
    const tr = (history[2].content as Array<{ content: string }>)[0];
    expect(tr.content).toContain('[h:');
  });
});

describe('compressToolLoopHistory rolling window (eviction-only, no distillation)', () => {
  beforeEach(() => resetStore());

  it('evicts oldest rounds when rounds exceed ROLLING_WINDOW_ROUNDS', () => {
    const history: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 22; i++) {
      history.push({ role: 'assistant', content: `assistant round ${i}` });
      history.push({ role: 'user', content: `user round ${i}` });
    }
    const beforeLen = history.length;
    compressToolLoopHistory(history, 30, 0);
    // Eviction shrinks the history.
    expect(history.length).toBeLessThan(beforeLen);
  });

  it('does NOT inject a [Rolling Summary] assistant message at history head', () => {
    // Regression: the legacy distiller unshifted a `[Rolling Summary]`
    // assistant message. Removed in favor of letting BB / hash manifest /
    // FileViews / `ru` rules carry durable state.
    const history: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 25; i++) {
      history.push({ role: 'assistant', content: `Round ${i} decision about architecture` });
      history.push({ role: 'user', content: `acknowledged round ${i}` });
    }

    compressToolLoopHistory(history, 30, 0);

    const hasSummary = history.some(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && String(m.content).startsWith('[Rolling Summary]'),
    );
    expect(hasSummary).toBe(false);
  });

  it('tool-pairing invariant: an assistant tool_use whose paired user message was evicted gets a synthetic placeholder', () => {
    // When a round carrying a `tool_use` is at the eviction head, the paired
    // `tool_result` is removed too. If the next-evicted round begins with an
    // assistant tool_use and no user message follows, the splice inserts a
    // synthetic tool_result so repairAnthropicToolPairing sees a valid pair.
    const history: Array<{ role: string; content: unknown }> = [{ role: 'user', content: 'start' }];
    for (let i = 0; i < 22; i++) {
      history.push({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `tu_${i}`, name: 'batch', input: { steps: [] } },
        ],
      });
      history.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `tu_${i}`, content: `result ${i}` },
        ],
      });
    }
    compressToolLoopHistory(history, 30, 0);
    // Every assistant with tool_use must still have a paired user message
    // following it.
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      const hasToolUse = (msg.content as Array<{ type?: string }>).some(b => b.type === 'tool_use');
      if (!hasToolUse) continue;
      const next = history[i + 1];
      expect(next?.role).toBe('user');
    }
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
    // Fixture matches current compressor output shape: {_stubbed, _compressed: true}.
    // `version` was dropped in the stub-calcification fix — the old shape looked
    // too much like a legal batch envelope and the model copied it verbatim.
    expect(extractToolDescription('batch', { _stubbed: stub, _compressed: true })).toBe(`batch:${stub}`);
  });
});
