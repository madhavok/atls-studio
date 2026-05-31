/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateAgentParentSession } from './activateAgentWindow';
import { useAppStore } from '../stores/appStore';
import { useAgentWindowStore } from '../stores/agentWindowStore';

const activateContextSessionMock = vi.hoisted(() => vi.fn(async () => undefined));
const persistContextSessionMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('./contextSessionPartition', () => ({
  activateContextSession: activateContextSessionMock,
  persistContextSession: persistContextSessionMock,
  isContextSessionLocked: () => false,
}));

vi.mock('./agentShellSync', () => ({
  syncShellToProjectPath: vi.fn(async () => undefined),
}));

describe('activateAgentParentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentWindowStore.getState().reset();
    useAppStore.setState({ currentSessionId: 'session-a', chatSessions: [] });
  });

  it('persists previous session and activates context for the selected parent', async () => {
    await activateAgentParentSession('session-b', 'Mission Beta', '/tmp/project');
    expect(persistContextSessionMock).toHaveBeenCalledWith('session-a', { toDb: true });
    expect(activateContextSessionMock).toHaveBeenCalledWith('session-b', { loadFromDb: true });
    expect(useAppStore.getState().currentSessionId).toBe('session-b');
  });
});
