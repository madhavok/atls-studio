import { invoke } from '@tauri-apps/api/core';
import { useAgentRuntimeStore } from '../stores/agentRuntimeStore';
import { useAgentWindowStore, exportAgentGridSnapshot, importAgentGridSnapshot, type AgentGridWorkspaceSnapshot } from '../stores/agentWindowStore';
import { clearDelegateBridgeState } from './agentDelegateBridge';

/** Cancel all in-flight grid agent streams and reset runtime state. */
export async function cancelAllGridAgentRuns(): Promise<void> {
  const runtimeStore = useAgentRuntimeStore.getState();
  const streamIds: string[] = [];
  for (const runtime of Object.values(runtimeStore.runtimesByWindow)) {
    if (runtime.isGenerating) {
      runtime.abortController?.abort();
      streamIds.push(...runtime.activeStreamIds);
    }
  }
  runtimeStore.reset();
  clearDelegateBridgeState();
  await Promise.all(
    streamIds.map((streamId) =>
      invoke('cancel_chat_stream', { streamId }).catch(() => undefined),
    ),
  );
}

/** Reset in-memory grid window state; per-project layout remains in localStorage. */
export function resetAgentWindowStoreForWorkspaceClose(): void {
  useAgentWindowStore.getState().resetInMemory();
}

/** Build workspace v2 agent grid payload from all open roots. */
export function buildWorkspaceAgentGridSnapshot(projectPaths: string[]): AgentGridWorkspaceSnapshot {
  return exportAgentGridSnapshot(projectPaths);
}

/** Apply workspace v2 agent grid payload after open. */
export function restoreWorkspaceAgentGridSnapshot(snapshot: AgentGridWorkspaceSnapshot | null | undefined): void {
  importAgentGridSnapshot(snapshot);
}
