import { describe, expect, it, vi } from 'vitest';
import {
  COMPACT_HISTORY_TURN_THRESHOLD,
  COMPACT_HISTORY_TOKEN_THRESHOLD,
} from './promptMemory';

const pruneStagedMock = vi.hoisted(() =>
  vi.fn(() => ({ freed: 0, removed: 0, reliefAction: 'none' as const })),
);

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../stores/contextStore', () => ({
  useContextStore: {
    getState: () => ({
      pruneStagedSnippets: pruneStagedMock,
    }),
  },
}));
vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      setPromptMetrics: vi.fn(),
      promptMetrics: { roundCount: 0 },
      settings: {
        selectedProvider: 'anthropic',
        selectedModel: 'claude-3-5-sonnet-20241022',
      },
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));

function mockAppState() {
  return {
    setPromptMetrics: vi.fn(),
    promptMetrics: { roundCount: 0 },
    settings: {
      selectedProvider: 'anthropic',
      selectedModel: 'claude-3-5-sonnet-20241022',
    },
  };
}

const {
  createGuardrailCallbacks,
  historyCompressionMiddleware,
  contextHygieneMiddleware,
  promptBudgetMiddleware,
  runBeforeRoundMiddlewares,
} = await import('./chatMiddleware');
const { useAppStore } = await import('../stores/appStore');

describe('createGuardrailCallbacks', () => {
  it('forwards calls when session is valid', () => {
    const onToken = vi.fn();
    const onDone = vi.fn();
    const callbacks = createGuardrailCallbacks({ onToken, onDone } as any, () => true);
    callbacks.onToken('x');
    callbacks.onDone();
    expect(onToken).toHaveBeenCalledWith('x');
    expect(onDone).toHaveBeenCalled();
  });

  it('suppresses calls when session is invalid', () => {
    const onToken = vi.fn();
    const onDone = vi.fn();
    const callbacks = createGuardrailCallbacks({ onToken, onDone } as any, () => false);
    callbacks.onToken('x');
    callbacks.onDone();
    expect(onToken).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('guards optional callbacks when present', () => {
    const onClear = vi.fn();
    const callbacks = createGuardrailCallbacks({ onClear } as any, () => true);
    callbacks.onClear?.();
    expect(onClear).toHaveBeenCalled();
  });
});

describe('historyCompressionMiddleware', () => {
  it('returns ctx unchanged when under budget and protected rounds', async () => {
    const ctx = {
      conversationHistory: [{ role: 'user', content: 'hi' }],
      round: 0,
      priorTurnBoundary: 0,
      config: {} as any,
      mode: 'chat' as any,
      reliefAction: 'none' as any,
      abortSignal: new AbortController().signal,
      isSessionValid: () => true,
    };
    const result = await historyCompressionMiddleware(ctx);
    expect(result.reliefAction).toBe('none');
  });
});

describe('promptBudgetMiddleware', () => {
  it('sets reliefAction when staged snippets are pruned', async () => {
    pruneStagedMock.mockReturnValueOnce({ freed: 10, removed: 2, reliefAction: 'evict_staged' });
    const ctx = {
      conversationHistory: [],
      round: 0,
      priorTurnBoundary: 0,
      config: {} as any,
      mode: 'agent' as any,
      reliefAction: 'none' as any,
      abortSignal: new AbortController().signal,
      isSessionValid: () => true,
    };
    const result = await promptBudgetMiddleware(ctx);
    expect(result.reliefAction).toBe('evict_staged');
  });
});

describe('runBeforeRoundMiddlewares', () => {
  it('runs middlewares in order and preserves ctx when compress skips', async () => {
    const ctx = {
      conversationHistory: [{ role: 'user', content: 'hi' }],
      round: 1,
      priorTurnBoundary: 0,
      config: {} as any,
      mode: 'chat' as any,
      reliefAction: 'none' as any,
      abortSignal: new AbortController().signal,
      isSessionValid: () => true,
    };
    const out = await runBeforeRoundMiddlewares(ctx, [
      historyCompressionMiddleware,
      promptBudgetMiddleware,
    ]);
    expect(out.round).toBe(1);
    expect(out.reliefAction).toBe('none');
  });
});

describe('contextHygieneMiddleware', () => {
  function makeCtx(overrides?: Partial<{ round: number; reliefAction: string }>) {
    return {
      conversationHistory: [{ role: 'user', content: 'hi' }],
      round: overrides?.round ?? 0,
      priorTurnBoundary: 0,
      config: {} as any,
      mode: 'agent' as any,
      reliefAction: (overrides?.reliefAction ?? 'none') as any,
      abortSignal: new AbortController().signal,
      isSessionValid: () => true,
    };
  }

  it(`skips when roundCount < ${COMPACT_HISTORY_TURN_THRESHOLD}`, async () => {
    vi.spyOn(useAppStore, 'getState').mockReturnValue({
      ...mockAppState(),
      promptMetrics: { roundCount: Math.max(0, COMPACT_HISTORY_TURN_THRESHOLD - 1) },
    } as any);
    const ctx = makeCtx();
    const result = await contextHygieneMiddleware(ctx);
    expect(result.reliefAction).toBe('none');
  });

  it(`skips when roundCount >= ${COMPACT_HISTORY_TURN_THRESHOLD} but history is under ${COMPACT_HISTORY_TOKEN_THRESHOLD} tokens`, async () => {
    vi.spyOn(useAppStore, 'getState').mockReturnValue({
      ...mockAppState(),
      promptMetrics: { roundCount: COMPACT_HISTORY_TURN_THRESHOLD },
    } as any);
    const ctx = makeCtx();
    const result = await contextHygieneMiddleware(ctx);
    expect(result.reliefAction).toBe('none');
  });
});
