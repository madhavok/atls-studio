import { useAgentRuntimeStore } from '../stores/agentRuntimeStore';
import { useAgentWindowStore } from '../stores/agentWindowStore';
import { useAppStore } from '../stores/appStore';

/** Toast when an unfocused grid window finishes a run. */
export function notifyBackgroundWindowComplete(windowId: string, status: 'completed' | 'failed' | 'cancelled'): void {
  if (status === 'cancelled') return;
  const windowStore = useAgentWindowStore.getState();
  const activeParent = windowStore.activeParentSessionId;
  const selectedId = activeParent ? windowStore.selectedWindowByParent[activeParent] : undefined;
  if (selectedId === windowId) return;

  const window = Object.values(windowStore.windowsByParent)
    .flat()
    .find((candidate) => candidate.windowId === windowId);
  if (!window) return;

  const runtime = useAgentRuntimeStore.getState().runtimesByWindow[windowId];
  const summary = runtime?.messages[runtime.messages.length - 1]?.content?.slice(0, 120) ?? '';
  useAppStore.getState().addToast({
    type: status === 'completed' ? 'success' : 'error',
    message: status === 'completed'
      ? `${window.title} finished${summary ? `: ${summary}` : ''}`
      : `${window.title} failed${runtime?.lastError ? `: ${runtime.lastError}` : ''}`,
  });
}
