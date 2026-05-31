import { useAppStore } from '../stores/appStore';
import { useAgentWindowStore } from '../stores/agentWindowStore';
import { useOrchestrationUiStore } from '../stores/orchestrationUiStore';
import { useSwarmStore, type SwarmTask } from '../stores/swarmStore';
import { orchestrator } from './orchestrator';
import { getProviderFromModelId } from '../utils/pricingProvider';

export async function recoverSwarmTask(task: SwarmTask): Promise<{ ok: boolean; error?: string }> {
  const swarm = useSwarmStore.getState();
  const sessionId = swarm.sessionId;
  const projectPath = useAppStore.getState().projectPath;
  if (!sessionId || !projectPath) {
    return { ok: false, error: 'No active swarm session/project was available to dispatch recovery.' };
  }

  useOrchestrationUiStore.getState().selectTask(task.id);
  swarm.setTaskFailureReason(task.id, '');
  swarm.updateTaskStatus(task.id, 'pending');
  swarm.setStatus('running');

  try {
    const orchestratorConfig = swarm.agentConfigs.find((config) => config.role === 'orchestrator');
    const settings = useAppStore.getState().settings;
    await orchestrator.resumeAfterApproval(sessionId, projectPath, {
      model: orchestratorConfig?.model || settings.selectedModel,
      provider: orchestratorConfig?.provider || settings.selectedProvider || getProviderFromModelId(settings.selectedModel),
      maxConcurrentAgents: swarm.maxConcurrentAgents,
      autoApprove: true,
    });
    return { ok: true };
  } catch (error) {
    swarm.setStatus('paused');
    const message = error instanceof Error ? error.message : String(error);
    swarm.setTaskFailureReason(task.id, message);
    return { ok: false, error: message };
  }
}

export function syncSwarmSelection(taskId: string, parentSessionId: string): void {
  useOrchestrationUiStore.getState().selectTask(taskId);
  useAgentWindowStore.getState().selectWindow(parentSessionId, `swarm-${taskId}`);
}

export function canRecoverSwarmTask(task: SwarmTask): boolean {
  return task.status === 'failed' || task.status === 'cancelled' || task.status === 'awaiting_input';
}

export function canStopSwarmTask(task: SwarmTask): boolean {
  return task.status === 'running' || task.status === 'pending';
}

export function pauseSwarmTask(task: SwarmTask): void {
  useOrchestrationUiStore.getState().selectTask(task.id);
  useSwarmStore.getState().updateTaskStatus(task.id, 'cancelled');
  useSwarmStore.getState().setTaskFailureReason(task.id, 'Stopped from grid swarm card.');
  useSwarmStore.getState().setStatus('paused');
}
