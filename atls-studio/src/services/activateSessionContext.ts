import { useAppStore } from '../stores/appStore';
import { useAgentRuntimeStore } from '../stores/agentRuntimeStore';
import { useAgentWindowStore, type AgentWindow } from '../stores/agentWindowStore';

/** Switch grid focus to a parent session without full loadSession / contextStore reset. */
export function activateParentSession(sessionId: string, title = 'Primary Chat'): void {
  const windowStore = useAgentWindowStore.getState();
  windowStore.ensurePrimaryWindow(sessionId, title);
  windowStore.setActiveParentSession(sessionId);
  windowStore.selectWindow(sessionId, `primary-${sessionId}`);
  useAppStore.getState().loadSession(sessionId);
  useAgentRuntimeStore.getState().ensureRuntime({
    windowId: `primary-${sessionId}`,
    sessionId,
    parentSessionId: sessionId,
  });
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('current_session_id', sessionId);
  }
}

/** Sync focused grid window session into legacy appStore + localStorage session id. */
export function activateSessionContext(window: AgentWindow): void {
  activateParentSession(window.parentSessionId, window.title);
  if (window.kind !== 'primary') {
    useAgentWindowStore.getState().selectWindow(window.parentSessionId, window.windowId);
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('current_session_id', window.sessionId);
  }
}
