/**
 * Turn-boundary state preservation — stateful-machine invariants.
 *
 * The chat loop must guarantee: end-of-turn-N history equals start-of-turn-N+1
 * history (minus the appended user message). These tests lock in the three
 * contracts that make that invariant hold:
 *
 *   1. `compressToolLoopHistory(_, _, priorTurnBoundary)` never mutates
 *      messages at indices < priorTurnBoundary.
 *   2. `contextHygieneMiddleware` threads its received `priorTurnBoundary`
 *      through to the compressor, so mid-turn hygiene cannot touch the
 *      frozen prefix.
 *   3. The cache-reuse pattern in `streamChatWithTools`
 *      (`[...structuredClone(_endOfTurnHistory), ...new]`) isolates the
 *      snapshot from in-place mutations on the active history.
 *
 * Unit-focused: we exercise the contracts directly rather than running a
 * full tool-loop round, which would require extensive provider mocking.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../stores/contextStore', () => ({
  useContextStore: {
    getState: () => ({
      pruneStagedSnippets: vi.fn(() => ({ freed: 0, removed: 0, reliefAction: 'none' as const })),
      resetSession: vi.fn(),
      setRollingSummary: vi.fn(),
      chunks: new Map(),
      addChunk: vi.fn(() => 'h:deadbeef'),
      rollingSummary: {
        decisions: [], filesChanged: [], userPreferences: [], workDone: [],
        findings: [], errors: [], currentGoal: '', nextSteps: [], blockers: [],
      },
    }),
  },
}));
vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      setPromptMetrics: vi.fn(),
      addRollingSavings: vi.fn(),
      addCompressionSavings: vi.fn(),
      promptMetrics: { roundCount: 0 },
      settings: {
        selectedProvider: 'anthropic',
        selectedModel: 'claude-3-5-sonnet-20241022',
      },
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));

const { compressToolLoopHistory } = await import('./historyCompressor');
const { contextHygieneMiddleware } = await import('./chatMiddleware');
const { useAppStore } = await import('../stores/appStore');
const { COMPACT_HISTORY_TURN_THRESHOLD } = await import('./promptMemory');

function mockAppStateWithRounds(roundCount: number) {
  return {
    setPromptMetrics: vi.fn(),
    addRollingSavings: vi.fn(),
    addCompressionSavings: vi.fn(),
    promptMetrics: { roundCount },
    settings: {
      selectedProvider: 'anthropic',
      selectedModel: 'claude-3-5-sonnet-20241022',
    },
  };
}

describe('turn-boundary: compressToolLoopHistory respects priorTurnBoundary', () => {
  it('does not mutate messages at indices < priorTurnBoundary', () => {
    // Prior turn: 3 messages that would otherwise be candidates for text compression.
    const priorTurnAssistant = 'P'.repeat(4000);
    const priorTurnResult = 'R'.repeat(4000);
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'turn 1 request' },
      { role: 'assistant', content: priorTurnAssistant },
      { role: 'user', content: priorTurnResult },
      // Current turn begins at index 3.
      { role: 'user', content: 'turn 2 request' },
      { role: 'assistant', content: 'T'.repeat(4000) },
      { role: 'user', content: 'ack' },
      { role: 'assistant', content: 'T'.repeat(4000) },
      { role: 'user', content: 'ack' },
      { role: 'assistant', content: 'T'.repeat(4000) },
      { role: 'user', content: 'ack' },
    ];
    const priorTurnBoundary = 3;

    // Snapshot the prior-turn content BEFORE compression. Deep-clone so later
    // comparisons aren't affected by any mutations.
    const snapshot = history.slice(0, priorTurnBoundary).map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : structuredClone(m.content),
    }));

    compressToolLoopHistory(history, undefined, priorTurnBoundary);

    // Prior-turn messages must remain structurally identical.
    for (let i = 0; i < priorTurnBoundary; i++) {
      expect(history[i].role).toBe(snapshot[i].role);
      expect(history[i].content).toEqual(snapshot[i].content);
    }
  });

  it('scopes rolling-window eviction to the current turn only', () => {
    // Many large rounds in the prior turn; a few in the current turn. With
    // boundary set, prior-turn rounds cannot be evicted into a rolling summary
    // even if the round count exceeds the window threshold.
    const history: Array<{ role: string; content: unknown }> = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: 'user', content: `prior user ${i}` });
      history.push({ role: 'assistant', content: `prior assistant ${i}` });
    }
    const priorTurnBoundary = history.length;
    for (let i = 0; i < 3; i++) {
      history.push({ role: 'user', content: `current user ${i}` });
      history.push({ role: 'assistant', content: `current assistant ${i}` });
    }

    const priorSnapshot = history
      .slice(0, priorTurnBoundary)
      .map(m => ({ role: m.role, content: m.content }));
    const priorLength = priorTurnBoundary;

    compressToolLoopHistory(history, undefined, priorTurnBoundary);

    // First `priorLength` entries still correspond to the same prior-turn
    // messages; none were spliced out by applyRollingHistoryWindow.
    expect(history.length).toBeGreaterThanOrEqual(priorLength);
    for (let i = 0; i < priorLength; i++) {
      expect(history[i].role).toBe(priorSnapshot[i].role);
      expect(history[i].content).toBe(priorSnapshot[i].content);
    }
  });
});

describe('turn-boundary: contextHygieneMiddleware honors priorTurnBoundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not mutate prior-turn prefix when hygiene fires mid-turn-2', async () => {
    // Force the hygiene trigger: roundCount above turn threshold.
    vi.spyOn(useAppStore, 'getState').mockReturnValue(
      mockAppStateWithRounds(COMPACT_HISTORY_TURN_THRESHOLD + 1) as any,
    );

    // Prior turn (frozen): 4 messages with compressible content.
    // Current turn: 6 messages that can be compressed.
    const priorTurnAssistant = 'P'.repeat(6000);
    const history: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'turn 1 request' },
      { role: 'assistant', content: priorTurnAssistant },
      { role: 'user', content: 'ack' },
      { role: 'assistant', content: 'turn 1 reply' },
      // boundary = 4
      { role: 'user', content: 'turn 2 request' },
      { role: 'assistant', content: 'T'.repeat(8000) },
      { role: 'user', content: 'T'.repeat(8000) },
      { role: 'assistant', content: 'T'.repeat(8000) },
      { role: 'user', content: 'T'.repeat(8000) },
      { role: 'assistant', content: 'T'.repeat(8000) },
    ];
    const priorTurnBoundary = 4;

    const priorSnapshot = history.slice(0, priorTurnBoundary).map(m => ({
      role: m.role,
      content: m.content,
    }));

    const ctx = {
      conversationHistory: history,
      round: 5,
      priorTurnBoundary,
      config: {} as any,
      mode: 'agent' as any,
      reliefAction: 'none' as any,
      abortSignal: new AbortController().signal,
      isSessionValid: () => true,
    };

    await contextHygieneMiddleware(ctx);

    // Middleware may or may not have compressed depending on token estimate,
    // but whatever it did, the prior-turn prefix must be untouched.
    for (let i = 0; i < priorTurnBoundary; i++) {
      expect(history[i].role).toBe(priorSnapshot[i].role);
      expect(history[i].content).toBe(priorSnapshot[i].content);
    }
  });
});

describe('turn-boundary: deep-clone reuse pattern isolates the snapshot', () => {
  it('mutating the active history does not affect _endOfTurnHistory snapshot', () => {
    // Simulates the pattern used in streamChatWithTools when
    // historyReusedFromCache is true:
    //   conversationHistory = [...structuredClone(_endOfTurnHistory), ...new]
    const endOfTurnHistory: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'turn 1' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reasoning' },
          { type: 'tool_use', id: 'tu_1', name: 'batch', input: { _stubbed: '2 steps: rs×1, sc×1', _compressed: true } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '[-> h:abc, 1.2k | result]' }],
      },
    ];
    const newMessages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'turn 2 request' },
    ];

    const conversationHistory = [...structuredClone(endOfTurnHistory), ...newMessages];

    // Mutate the active history in ways the compression pipeline would:
    // splice a message, replace an assistant tool_use input, rewrite a tool_result.
    conversationHistory.splice(1, 1);
    const firstUser = conversationHistory[0];
    if (typeof firstUser.content === 'string') {
      firstUser.content = '[compressed]';
    }

    // The snapshot must retain its original shape.
    expect(endOfTurnHistory).toHaveLength(3);
    expect(endOfTurnHistory[0].content).toBe('turn 1');
    const assistantBlocks = endOfTurnHistory[1].content as Array<Record<string, unknown>>;
    expect(assistantBlocks[1].type).toBe('tool_use');
    expect((assistantBlocks[1] as { input: { _stubbed: string } }).input._stubbed).toBe(
      '2 steps: rs×1, sc×1',
    );
    const toolResults = endOfTurnHistory[2].content as Array<Record<string, unknown>>;
    expect(toolResults[0].type).toBe('tool_result');
    expect(toolResults[0].content).toBe('[-> h:abc, 1.2k | result]');
  });

  it('shallow-spread without structuredClone LEAKS mutations (regression guard)', () => {
    // Proves the fix is necessary: with a plain spread, the snapshot is
    // corrupted when the active history is mutated in place. This test
    // documents the failure mode the fix prevents.
    const endOfTurnHistory: Array<{ role: string; content: unknown }> = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', input: { steps: [] } }] },
    ];
    const conversationHistory = [...endOfTurnHistory, { role: 'user', content: 'new' }];

    const block = (conversationHistory[0].content as Array<Record<string, unknown>>)[0];
    block.input = { _stubbed: 'mutated', _compressed: true };

    const leakedBlock = (endOfTurnHistory[0].content as Array<Record<string, unknown>>)[0];
    // Without structuredClone, the shared reference leaks the mutation.
    expect((leakedBlock as { input: { _stubbed: string } }).input._stubbed).toBe('mutated');
  });
});
