import { useContextStore, setCacheHitRateAccessor, setWorkspacesAccessor } from '../stores/contextStore';

export function allSubtasksDone(): boolean {
  const ctx = useContextStore.getState();
  const plan = ctx.taskPlan;
  if (!plan || plan.subtasks.length === 0) return false;
  return plan.subtasks.every(s => s.status === 'done');
}

/**
 * True when session.plan is active and task_complete / end_turn should be deferred
 * until remaining phases are advanced or resolved.
 *
 * The final subtask stays `active` until task_complete (session.advance has no next
 * subtask), so that case is not treated as incomplete.
 */
export function hasActivePlanWithIncompleteSubtasks(): boolean {
  const plan = useContextStore.getState().taskPlan;
  if (!plan || plan.status !== 'active') return false;
  const st = plan.subtasks;
  if (st.length === 0) return false;
  if (st.every(s => s.status === 'done')) return false;

  if (st.some(s => s.status === 'pending' || s.status === 'blocked')) return true;

  const activeIdx = st.findIndex(s => s.status === 'active');
  if (activeIdx < 0) return true;

  const lastIdx = st.length - 1;
  if (activeIdx === lastIdx && st.slice(0, lastIdx).every(s => s.status === 'done')) {
    return false;
  }

  return st.some(s => s.status !== 'done');
}

/** Ids of subtasks that still block completion (aligned with hasActivePlanWithIncompleteSubtasks). */
export function getIncompleteSubtaskIds(): string[] {
  const plan = useContextStore.getState().taskPlan;
  if (!plan) return [];
  const st = plan.subtasks;
  const activeIdx = st.findIndex(s => s.status === 'active');
  const lastIdx = st.length - 1;
  const isFinalActiveTail =
    activeIdx >= 0 &&
    activeIdx === lastIdx &&
    st.slice(0, lastIdx).every(s => s.status === 'done');

  return st
    .filter((s, i) => {
      if (s.status === 'done') return false;
      if (s.status === 'pending' || s.status === 'blocked') return true;
      if (s.status === 'active' && isFinalActiveTail && i === lastIdx) return false;
      return true;
    })
    .map(s => s.id);
}
