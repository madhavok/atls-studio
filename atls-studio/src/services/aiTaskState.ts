import { useContextStore, setCacheHitRateAccessor, setWorkspacesAccessor } from '../stores/contextStore';

export function allSubtasksDone(): boolean {
  const ctx = useContextStore.getState();
  const plan = ctx.taskPlan;
  if (!plan || plan.subtasks.length === 0) return false;
  return plan.subtasks.every(s => s.status === 'done');
}