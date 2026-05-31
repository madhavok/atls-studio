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
});
