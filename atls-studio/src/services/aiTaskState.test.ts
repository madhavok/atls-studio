import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetState = vi.fn();

vi.mock('../stores/contextStore', () => ({
  useContextStore: {
    getState: () => mockGetState(),
  },
}));

import { allSubtasksDone, hasActivePlanWithIncompleteSubtasks, getIncompleteSubtaskIds } from './aiTaskState';

describe('allSubtasksDone', () => {
  beforeEach(() => {
    mockGetState.mockReset();
  });

  it('returns false when no plan', () => {
    mockGetState.mockReturnValue({ taskPlan: null });
    expect(allSubtasksDone()).toBe(false);
  });

  it('returns false when subtasks empty', () => {
    mockGetState.mockReturnValue({ taskPlan: { subtasks: [] } });
    expect(allSubtasksDone()).toBe(false);
  });

  it('returns true when every subtask is done', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        subtasks: [
          { status: 'done' },
          { status: 'done' },
        ],
      },
    });
    expect(allSubtasksDone()).toBe(true);
  });

  it('returns false when any subtask is not done', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        subtasks: [{ status: 'done' }, { status: 'running' }],
      },
    });
    expect(allSubtasksDone()).toBe(false);
  });
});

describe('hasActivePlanWithIncompleteSubtasks', () => {
  beforeEach(() => {
    mockGetState.mockReset();
  });

  it('returns false when no plan', () => {
    mockGetState.mockReturnValue({ taskPlan: null });
    expect(hasActivePlanWithIncompleteSubtasks()).toBe(false);
  });

  it('returns false when plan is superseded', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        status: 'superseded',
        subtasks: [{ id: 'a', status: 'pending' }],
      },
    });
    expect(hasActivePlanWithIncompleteSubtasks()).toBe(false);
  });

  it('returns false when all subtasks are done', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        status: 'active',
        subtasks: [
          { id: 'a', status: 'done' },
          { id: 'b', status: 'done' },
        ],
      },
    });
    expect(hasActivePlanWithIncompleteSubtasks()).toBe(false);
  });

  it('returns true when active plan has pending subtasks', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        status: 'active',
        subtasks: [
          { id: 'a', status: 'done' },
          { id: 'b', status: 'active' },
          { id: 'c', status: 'pending' },
        ],
      },
    });
    expect(hasActivePlanWithIncompleteSubtasks()).toBe(true);
  });

  it('returns true when active plan has blocked subtasks', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        status: 'active',
        subtasks: [
          { id: 'a', status: 'done' },
          { id: 'b', status: 'blocked' },
        ],
      },
    });
    expect(hasActivePlanWithIncompleteSubtasks()).toBe(true);
  });

  it('returns false when only the final subtask is active (single phase)', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        status: 'active',
        subtasks: [{ id: 'only', status: 'active' }],
      },
    });
    expect(hasActivePlanWithIncompleteSubtasks()).toBe(false);
  });

  it('returns false when last subtask is active and all prior are done', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        status: 'active',
        subtasks: [
          { id: 'a', status: 'done' },
          { id: 'b', status: 'done' },
          { id: 'c', status: 'active' },
        ],
      },
    });
    expect(hasActivePlanWithIncompleteSubtasks()).toBe(false);
  });

  it('returns true when active is not last and later subtasks are pending', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        status: 'active',
        subtasks: [
          { id: 'a', status: 'active' },
          { id: 'b', status: 'pending' },
        ],
      },
    });
    expect(hasActivePlanWithIncompleteSubtasks()).toBe(true);
  });
});

describe('getIncompleteSubtaskIds', () => {
  beforeEach(() => {
    mockGetState.mockReset();
  });

  it('returns empty array when no plan', () => {
    mockGetState.mockReturnValue({ taskPlan: null });
    expect(getIncompleteSubtaskIds()).toEqual([]);
  });

  it('returns only non-done subtask ids', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        status: 'active',
        subtasks: [
          { id: 'a', status: 'done' },
          { id: 'b', status: 'active' },
          { id: 'c', status: 'pending' },
        ],
      },
    });
    expect(getIncompleteSubtaskIds()).toEqual(['b', 'c']);
  });

  it('excludes final active tail when only last subtask is active', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        status: 'active',
        subtasks: [{ id: 'tail', status: 'active' }],
      },
    });
    expect(getIncompleteSubtaskIds()).toEqual([]);
  });

  it('excludes final active tail when prior subtasks are done', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        status: 'active',
        subtasks: [
          { id: 'a', status: 'done' },
          { id: 'b', status: 'active' },
        ],
      },
    });
    expect(getIncompleteSubtaskIds()).toEqual([]);
  });

  it('returns empty array when all done', () => {
    mockGetState.mockReturnValue({
      taskPlan: {
        status: 'active',
        subtasks: [
          { id: 'a', status: 'done' },
          { id: 'b', status: 'done' },
        ],
      },
    });
    expect(getIncompleteSubtaskIds()).toEqual([]);
  });
});
