import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetState = vi.fn();
const mockContextGetState = vi.fn();
const mockExecuteSubagent = vi.fn();

vi.mock('../../../stores/appStore', () => ({
  useAppStore: {
    getState: () => mockGetState(),
    // tokenCounter registers a subscriber at module init — give it a no-op.
    subscribe: () => () => {},
  },
}));

vi.mock('../../../stores/contextStore', () => ({
  useContextStore: { getState: () => mockContextGetState() },
}));

vi.mock('../../subagentService', () => ({
  executeSubagent: (...args: unknown[]) => mockExecuteSubagent(...args),
}));

import {
  handleDelegateRetrieve,
  handleDelegateDesign,
  handleDelegateCode,
  handleDelegateTest,
} from './delegate';

const baseSubagentResult = {
  refs: [] as { hash: string; shortHash: string; source: string; tokens: number; pinned: boolean; type: string }[],
  summary: 'retriever: 0 refs (0.0k tk), 1 rounds',
  costCents: 0,
  toolCalls: 0,
};

describe('delegate handlers', () => {
  beforeEach(() => {
    mockGetState.mockReset();
    mockContextGetState.mockReset();
    mockExecuteSubagent.mockReset();
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

  it('inlines blackboard bodies into the step summary', async () => {
    mockGetState.mockReturnValue({
      projectPath: '/proj',
      settings: { subagentModel: 'claude-3-haiku' },
    });
    mockContextGetState.mockReturnValue({
      getCurrentRev: () => 'ws-rev-1',
      getBlackboardEntry: (key: string) =>
        key === 'retriever:findings'
          ? 'Answer: resolveHashRef dispatches at line 47; supports h:XXXX and line selectors.'
          : null,
      stagedSnippets: new Map(),
      chunks: new Map(),
    });
    mockExecuteSubagent.mockResolvedValue({
      ...baseSubagentResult,
      bbKeys: ['retriever:findings'],
      pinCount: 0,
      pinTokens: 100,
      rounds: 2,
      invocationId: 'inv-test',
      finalText: 'Planning note only.',
    });

    const out = await handleDelegateRetrieve({ query: 'how does hash protocol resolve refs' }, {} as never, 's1');
    expect(out.ok).toBe(true);
    expect(out.summary).toContain('--- Blackboard (retriever:findings) ---');
    expect(out.summary).toContain('resolveHashRef');
    expect(out.summary).toContain('--- Assistant (final turn) ---');
    expect(out.summary).toContain('Planning note only.');
  });

  it('summary never contains a trace line — refs + findings are the canonical signal', async () => {
    // A live audit showed the trace degenerated to "R1: batch | R2: batch |
    // ..." because the toolTrace captures the Anthropic-visible tool
    // envelope, not the ops inside each batch. The parent already has
    // everything it needs: refs (what came back) + findings (how the
    // sub-agent interpreted it) + round count (how much work). A trace
    // line adds noise without signal.
    mockGetState.mockReturnValue({
      projectPath: '/proj',
      settings: { subagentModel: 'claude-3-haiku', selectedProvider: 'anthropic', selectedModel: 'claude-3-haiku' },
      availableModels: [],
    });
    mockContextGetState.mockReturnValue({
      getCurrentRev: () => 'ws-rev-1',
      getBlackboardEntry: () => null,
      stagedSnippets: new Map(),
      chunks: new Map(),
    });
    mockExecuteSubagent.mockResolvedValue({
      ...baseSubagentResult,
      bbKeys: [],
      pinCount: 1,
      pinTokens: 200,
      rounds: 5,
      invocationId: 'inv-no-trace',
      finalText: undefined,
      toolTrace: [
        { toolName: 'batch', message: 'batch', round: 0, ts: 100, done: false },
        { toolName: 'batch', message: 'batch', round: 1, ts: 200, done: false },
        { toolName: 'batch', message: 'batch', round: 2, ts: 300, done: false },
        { toolName: 'batch', message: 'batch', round: 3, ts: 400, done: false },
        { toolName: 'batch', message: 'batch', round: 4, ts: 500, done: false },
      ],
    });

    const out = await handleDelegateRetrieve({ query: 'q' }, {} as never, 's-no-trace');
    expect(out.ok).toBe(true);
    // No trace line — even when toolTrace is populated.
    expect(out.summary).not.toContain('trace:');
    expect(out.summary).not.toMatch(/R1:\s*batch/);
    // Header still carries round count (the useful piece of trace info).
    expect(out.summary).toContain('5 rounds');
  });

  it('uses legacy Delegate Findings heading when only assistant text is present', async () => {
    mockGetState.mockReturnValue({
      projectPath: '/proj',
      settings: { subagentModel: 'claude-3-haiku' },
    });
    mockContextGetState.mockReturnValue({
      getCurrentRev: () => 'ws-rev-1',
      getBlackboardEntry: () => null,
      stagedSnippets: new Map(),
      chunks: new Map(),
    });
    mockExecuteSubagent.mockResolvedValue({
      ...baseSubagentResult,
      bbKeys: [],
      pinCount: 0,
      pinTokens: 0,
      rounds: 1,
      invocationId: 'inv-2',
      finalText: 'No BB write; assistant only.',
    });

    const out = await handleDelegateRetrieve({ query: 'q' }, {} as never, 's2');
    expect(out.ok).toBe(true);
    expect(out.summary).toContain('--- Delegate Findings ---');
    expect(out.summary).toContain('No BB write');
    expect(out.summary).not.toContain('--- Assistant (final turn) ---');
  });
});
