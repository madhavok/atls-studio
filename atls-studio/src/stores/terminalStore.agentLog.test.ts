import { describe, expect, it } from 'vitest';
import { useTerminalStore } from './terminalStore';

describe('terminalStore agent log', () => {
  it('appendAgentMessage records message entries', () => {
    const id = 'test-agent-term-log';
    useTerminalStore.getState().appendAgentMessage(id, 'hello agent');
    const entries = useTerminalStore.getState().getAgentLog(id);
    expect(entries.length).toBe(1);
    expect(entries[0].status).toBe('message');
    expect(entries[0].output).toContain('hello agent');
  });
});
