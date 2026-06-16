/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentRuntimeStore } from '../stores/agentRuntimeStore';

describe('agentRuntimeStore hydrateRuntime', () => {
  beforeEach(() => {
    useAgentRuntimeStore.getState().reset();
  });

  it('hydrates persisted messages when only recovery system notices exist', () => {
    const runtime = useAgentRuntimeStore.getState().ensureRuntime({
      windowId: 'delegate-1',
      sessionId: 'session-1',
      parentSessionId: 'parent-1',
      role: 'coder',
    });
    useAgentRuntimeStore.getState().appendMessage('delegate-1', {
      role: 'system',
      content: 'Recovered prior delegate window. Transcript is preserved; the live stream is no longer attached.',
    });
    expect(useAgentRuntimeStore.getState().runtimesByWindow['delegate-1']?.messages.length).toBe(1);

    useAgentRuntimeStore.getState().hydrateRuntime('delegate-1', [
      { id: 'u1', role: 'user', content: 'Fix the bug', timestamp: new Date() },
      { id: 'a1', role: 'assistant', content: 'On it.', timestamp: new Date() },
    ]);

    const hydrated = useAgentRuntimeStore.getState().runtimesByWindow['delegate-1'];
    expect(hydrated?.messages).toHaveLength(2);
    expect(hydrated?.messages[0]?.role).toBe('user');
    expect(runtime.windowId).toBe('delegate-1');
  });

  it('restores persisted cost and token telemetry on hydrate', () => {
    useAgentRuntimeStore.getState().ensureRuntime({
      windowId: 'delegate-2',
      sessionId: 'session-2',
      parentSessionId: 'parent-2',
      role: 'coder',
    });

    useAgentRuntimeStore.getState().hydrateRuntime(
      'delegate-2',
      [
        { id: 'u1', role: 'user', content: 'Build it', timestamp: new Date() },
        { id: 'a1', role: 'assistant', content: 'Done.', timestamp: new Date() },
      ],
      { inputTokens: 1200, outputTokens: 800, totalTokens: 2000, costCents: 42 },
    );

    const telemetry = useAgentRuntimeStore.getState().runtimesByWindow['delegate-2']?.telemetry;
    expect(telemetry?.costCents).toBe(42);
    expect(telemetry?.inputTokens).toBe(1200);
    expect(telemetry?.outputTokens).toBe(800);
    expect(telemetry?.totalTokens).toBe(2000);
    expect(telemetry?.rounds).toBe(1);
  });

  it('leaves telemetry at defaults when no persisted usage is provided', () => {
    useAgentRuntimeStore.getState().ensureRuntime({
      windowId: 'delegate-3',
      sessionId: 'session-3',
      parentSessionId: 'parent-3',
      role: 'coder',
    });

    useAgentRuntimeStore.getState().hydrateRuntime('delegate-3', [
      { id: 'u1', role: 'user', content: 'Hello', timestamp: new Date() },
      { id: 'a1', role: 'assistant', content: 'Hi.', timestamp: new Date() },
    ]);

    const telemetry = useAgentRuntimeStore.getState().runtimesByWindow['delegate-3']?.telemetry;
    expect(telemetry?.costCents).toBe(0);
    expect(telemetry?.totalTokens).toBe(0);
  });
});
