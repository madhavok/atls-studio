import type { AgentWindow } from '../stores/agentWindowStore';
import { activateSessionContext, activateParentSession } from './activateSessionContext';
import { syncShellToProjectPath } from './agentShellSync';
import { useAgentWindowStore } from '../stores/agentWindowStore';

function resolveWindowProjectPath(window: AgentWindow): string | null {
  return window.projectPath ?? useAgentWindowStore.getState().projectPath;
}

/** Focus a grid window and sync shell ATLS root + chat DB to its project. */
export async function activateAgentWindow(window: AgentWindow): Promise<void> {
  activateSessionContext(window);
  await syncShellToProjectPath(resolveWindowProjectPath(window));
}

/** Switch parent conversation and optionally sync shell project. */
export async function activateAgentParentSession(sessionId: string, title: string, projectPath?: string | null): Promise<void> {
  activateParentSession(sessionId, title);
  await syncShellToProjectPath(projectPath ?? useAgentWindowStore.getState().projectPath);
}
