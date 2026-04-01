import { useContextStore, setCacheHitRateAccessor, setWorkspacesAccessor } from '../stores/contextStore';

export function allSubtasksDone(): boolean {
  const ctx = useContextStore.getState();
  const plan = ctx.taskPlan;
  if (!plan || plan.subtasks.length === 0) return false;
  return plan.subtasks.every(s => s.status === 'done');
}

/** True when a session.plan is active and at least one subtask is not done. */
export function hasActivePlanWithIncompleteSubtasks(): boolean {
  const plan = useContextStore.getState().taskPlan;
  if (!plan || plan.status !== 'active') return false;
  return plan.subtasks.some(s => s.status !== 'done');
}

/** Returns ids of subtasks that are not yet done (for system messages). */
export function getIncompleteSubtaskIds(): string[] {
  const plan = useContextStore.getState().taskPlan;
  if (!plan) return [];
  return plan.subtasks.filter(s => s.status !== 'done').map(s => s.id);
}