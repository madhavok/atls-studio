import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../stores/contextStore', () => ({
  useContextStore: {
    getState: () => ({
      pruneStagedSnippets: vi.fn(() => ({ removed: 0 })),
    }),
  },
}));
vi.mock('../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      setPromptMetrics: vi.fn(),
      promptMetrics: { roundCount: 0 },
    }),
  },
}));

const { createGuardrailCallbacks, historyCompressionMiddleware, contextHygieneMiddleware } = await import('./chatMiddleware');
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
  it('returns ctx unchanged when under budget and protected rounds', () => {
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
    const result = historyCompressionMiddleware(ctx);
    expect(result.reliefAction).toBe('none');
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

  it('skips when roundCount < 20', () => {
    (useAppStore.getState as any).mockReturnValue
      ?? vi.spyOn(useAppStore, 'getState').mockReturnValue({ setPromptMetrics: vi.fn(), promptMetrics: { roundCount: 5 } } as any);
    const ctx = makeCtx();
    const result = contextHygieneMiddleware(ctx);
    expect(result.reliefAction).toBe('none');
  });

  it('skips when roundCount >= 20 but history is under token threshold', () => {
    vi.spyOn(useAppStore, 'getState').mockReturnValue({ setPromptMetrics: vi.fn(), promptMetrics: { roundCount: 25 } } as any);
    const ctx = makeCtx();
    const result = contextHygieneMiddleware(ctx);
    expect(result.reliefAction).toBe('none');
  });
});
