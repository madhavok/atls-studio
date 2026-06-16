import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentRuntimeStore } from '../stores/agentRuntimeStore';
import { useAgentWindowStore } from '../stores/agentWindowStore';
import { buildAgentWindowStreamCallbacks } from './agentWindowStreamCallbacks';
import { getAgentWindowStreamRefs } from '../services/agentWindowStreamRefs';

describe('buildAgentWindowStreamCallbacks', () => {
  beforeEach(() => {
    useAgentWindowStore.getState().reset();
    useAgentRuntimeStore.getState().reset();
    useAgentWindowStore.getState().hydrateProject('/tmp/project');
    useAgentWindowStore.getState().ensurePrimaryWindow('session-1', 'Primary Chat');
    useAgentRuntimeStore.getState().ensureRuntime({
      windowId: 'primary-session-1',
      sessionId: 'session-1',
      parentSessionId: 'session-1',
    });
  });

  it('closes open text blocks on onStepStart', () => {
    const window = useAgentWindowStore.getState().windowsByParent['session-1'][0];
    const callbacks = buildAgentWindowStreamCallbacks({
      window,
      windowId: window.windowId,
      startedAt: Date.now(),
      fullResponseRef: { current: '' },
      runErroredRef: { current: false },
      persistMessage: () => {},
    });
    const refs = getAgentWindowStreamRefs(window.windowId);

    callbacks.onTextStart?.('text-1');
    callbacks.onToken?.('hello');
    callbacks.onStepStart?.();

    expect(refs.streamingSegmentsRef.current.some((segment) => segment.type === 'text')).toBe(true);
    expect(refs.streamingSegmentsRef.current.find((segment) => segment.type === 'text')?.state).toBe('done');
  });

  it('updates tool segments on onToolResult without system messages', () => {
    const window = useAgentWindowStore.getState().windowsByParent['session-1'][0];
    const callbacks = buildAgentWindowStreamCallbacks({
      window,
      windowId: window.windowId,
      startedAt: Date.now(),
      fullResponseRef: { current: '' },
      runErroredRef: { current: false },
      persistMessage: () => {},
    });

    callbacks.onToolInputAvailable?.('tool-1', 'read.context', { path: 'src/App.tsx' });
    callbacks.onToolCall?.({
      id: 'tool-1',
      name: 'read.context',
      args: { path: 'src/App.tsx' },
      status: 'running',
    });
    callbacks.onToolResult?.('tool-1', 'file contents');

    const runtime = useAgentRuntimeStore.getState().runtimesByWindow[window.windowId];
    expect(runtime.messages.some((message) => message.role === 'system')).toBe(false);
    expect(runtime.toolCalls[0]?.result).toBe('file contents');
    expect(runtime.toolCalls[0]?.status).toBe('completed');
  });

  it('does not overwrite aiService-accumulated telemetry via a usage callback', () => {
    const window = useAgentWindowStore.getState().windowsByParent['session-1'][0];
    // Simulate aiService having accumulated cumulative cost/tokens for the window.
    useAgentRuntimeStore.getState().updateTelemetry(window.windowId, {
      inputTokens: 5000,
      outputTokens: 3000,
      totalTokens: 8000,
      costCents: 123,
    });

    const callbacks = buildAgentWindowStreamCallbacks({
      window,
      windowId: window.windowId,
      startedAt: Date.now(),
      fullResponseRef: { current: '' },
      runErroredRef: { current: false },
      persistMessage: () => {},
    });

    // The grid callback must not own usage telemetry; aiService is the single
    // source of truth. A per-round/per-invocation overwrite here previously
    // dropped prior-turn cost on every new user message. Invoking onUsageUpdate
    // with per-round values must leave the accumulated total untouched.
    callbacks.onUsageUpdate({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      maxTokens: 200000,
      percentage: 0,
      costCents: 1,
    });

    const telemetry = useAgentRuntimeStore.getState().runtimesByWindow[window.windowId]?.telemetry;
    expect(telemetry?.costCents).toBe(123);
    expect(telemetry?.totalTokens).toBe(8000);
  });

  it('records subagent progress on the parent window runtime', () => {
    const window = useAgentWindowStore.getState().windowsByParent['session-1'][0];
    const callbacks = buildAgentWindowStreamCallbacks({
      window,
      windowId: window.windowId,
      startedAt: Date.now(),
      fullResponseRef: { current: '' },
      runErroredRef: { current: false },
      persistMessage: () => {},
    });

    callbacks.onSubagentProgress?.('step-delegate', {
      toolName: 'delegate.code',
      status: 'Reading src',
      round: 2,
      done: false,
    });

    const runtime = useAgentRuntimeStore.getState().runtimesByWindow[window.windowId];
    expect(runtime.subagentProgressByStep['step-delegate']).toHaveLength(1);
    expect(runtime.subagentProgressByStep['step-delegate'][0].round).toBe(2);
  });
});
