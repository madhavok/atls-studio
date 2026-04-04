import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetState = vi.fn();

vi.mock('../stores/contextStore', () => ({
  useContextStore: {
    getState: () => mockGetState(),
  },
}));

import { allSubtasksDone } from './aiTaskState';

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
