import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetState = vi.fn();

vi.mock('../../../stores/appStore', () => ({
  useAppStore: { getState: () => mockGetState() },
}));

import {
  handleDelegateRetrieve,
  handleDelegateDesign,
  handleDelegateCode,
  handleDelegateTest,
} from './delegate';

describe('delegate handlers', () => {
  beforeEach(() => {
    mockGetState.mockReset();
  });

  it('fails fast when project path is missing', async () => {
    mockGetState.mockReturnValue({ projectPath: null, settings: { subagentModel: 'claude' } });
    const out = await handleDelegateRetrieve({ query: 'q' }, {} as never, 's1');
    expect(out.ok).toBe(false);
    expect(out.summary).toMatch(/no project path/i);
  });

  it('fails when subagent is disabled', async () => {
    mockGetState.mockReturnValue({
      projectPath: '/proj',
      settings: { subagentModel: 'none' },
    });
    const out = await handleDelegateDesign({ query: 'q' }, {} as never, 's1');
    expect(out.ok).toBe(false);
    expect(out.summary).toMatch(/subagent is disabled/i);
  });

  it('exports all four delegate handlers', () => {
    expect(typeof handleDelegateRetrieve).toBe('function');
    expect(typeof handleDelegateDesign).toBe('function');
    expect(typeof handleDelegateCode).toBe('function');
    expect(typeof handleDelegateTest).toBe('function');
  });
});
