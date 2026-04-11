import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbTask } from '../services/chatDb';
import { useSwarmStore } from './swarmStore';

describe('swarmStore', () => {
  beforeEach(() => {
    useSwarmStore.getState().resetSwarm();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes idle with no session', () => {
    const s = useSwarmStore.getState();
    expect(s.status).toBe('idle');
    expect(s.sessionId).toBeNull();
    expect(s.isActive).toBe(false);
  });

  it('startSwarm activates researching session', () => {
    useSwarmStore.getState().startSwarm('sess-a', 'ship widgets');
    const s = useSwarmStore.getState();
    expect(s.isActive).toBe(true);
    expect(s.sessionId).toBe('sess-a');
    expect(s.status).toBe('researching');
    expect(s.userRequest).toBe('ship widgets');
    expect(s.orchestrationPlanTokens).toBe(0);
  });

  it('resetSwarm returns to idle', () => {
    useSwarmStore.getState().startSwarm('s', 'x');
    useSwarmStore.getState().resetSwarm();
    expect(useSwarmStore.getState().isActive).toBe(false);
    expect(useSwarmStore.getState().sessionId).toBeNull();
  });

  it('pauseSwarm and resumeSwarm only resume from paused', () => {
    useSwarmStore.getState().startSwarm('s', 'x');
    useSwarmStore.setState({ status: 'running' });
    useSwarmStore.getState().pauseSwarm();
    expect(useSwarmStore.getState().status).toBe('paused');
    useSwarmStore.getState().resumeSwarm();
    expect(useSwarmStore.getState().status).toBe('running');
    useSwarmStore.setState({ status: 'researching' });
    useSwarmStore.getState().resumeSwarm();
    expect(useSwarmStore.getState().status).toBe('researching');
  });

  it('cancelSwarm graceful sets flags without failing status', () => {
    useSwarmStore.getState().startSwarm('s', 'x');
    useSwarmStore.setState({ status: 'running' });
    useSwarmStore.getState().cancelSwarm('graceful');
    const s = useSwarmStore.getState();
    expect(s.cancelRequested).toBe(true);
    expect(s.cancelMode).toBe('graceful');
    expect(s.status).toBe('running');
  });

  it('cancelSwarm immediate marks failed and cancels running tasks', () => {
    useSwarmStore.getState().startSwarm('s', 'x');
    const id = useSwarmStore.getState().addTask({
      title: 't',
      description: '',
      assignedModel: 'm',
      assignedProvider: 'anthropic',
      assignedRole: 'coder',
      contextHashes: [],
      fileClaims: [],
      contextFiles: [],
      dependencies: [],
    });
    useSwarmStore.getState().updateTaskStatus(id, 'running');
    useSwarmStore.getState().cancelSwarm('immediate');
    const s = useSwarmStore.getState();
    expect(s.status).toBe('failed');
    expect(s.tasks.find((t) => t.id === id)?.status).toBe('cancelled');
  });

  it('addTask updateTaskStatus updateStats and filters by status', () => {
    const id = useSwarmStore.getState().addTask({
      title: 'a',
      description: '',
      assignedModel: 'm',
      assignedProvider: 'anthropic',
      assignedRole: 'coder',
      contextHashes: [],
      fileClaims: [],
      contextFiles: [],
      dependencies: [],
    });
    expect(useSwarmStore.getState().getTasksByStatus('pending')).toHaveLength(1);
    useSwarmStore.getState().updateTaskStatus(id, 'running');
    expect(useSwarmStore.getState().getRunningTasks()).toHaveLength(1);
    useSwarmStore.getState().updateTaskStatus(id, 'completed');
    expect(useSwarmStore.getState().getTasksByStatus('completed')).toHaveLength(1);
    const st = useSwarmStore.getState().stats;
    expect(st.completedTasks).toBe(1);
    expect(st.runningTasks).toBe(0);
  });

  it('getReadyTasks respects dependencies', () => {
    const depId = useSwarmStore.getState().addTask({
      title: 'dep',
      description: '',
      assignedModel: 'm',
      assignedProvider: 'anthropic',
      assignedRole: 'coder',
      contextHashes: [],
      fileClaims: [],
      contextFiles: [],
      dependencies: [],
    });
    const childId = useSwarmStore.getState().addTask({
      title: 'child',
      description: '',
      assignedModel: 'm',
      assignedProvider: 'anthropic',
      assignedRole: 'coder',
      contextHashes: [],
      fileClaims: [],
      contextFiles: [],
      dependencies: [depId],
    });
    expect(useSwarmStore.getState().getReadyTasks().map((t) => t.id)).toEqual([depId]);
    useSwarmStore.getState().updateTaskStatus(depId, 'completed');
    expect(useSwarmStore.getState().getReadyTasks().map((t) => t.id)).toEqual([childId]);
  });

  it('updateTaskResult updateTaskError and updateTaskStats accumulate', () => {
    const id = useSwarmStore.getState().addTask({
      title: 't',
      description: '',
      assignedModel: 'm',
      assignedProvider: 'anthropic',
      assignedRole: 'coder',
      contextHashes: [],
      fileClaims: [],
      contextFiles: [],
      dependencies: [],
    });
    useSwarmStore.getState().updateTaskResult(id, 'done');
    useSwarmStore.getState().updateTaskError(id, 'e1');
    const t1 = useSwarmStore.getState().tasks.find((t) => t.id === id)!;
    expect(t1.result).toBe('done');
    expect(t1.retryCount).toBe(1);
    useSwarmStore.getState().updateTaskStats(id, 10, 2);
    useSwarmStore.getState().updateTaskStats(id, 5, 1);
    const t2 = useSwarmStore.getState().tasks.find((t) => t.id === id)!;
    expect(t2.tokensUsed).toBe(15);
    expect(t2.costCents).toBe(3);
  });

  it('addTaskMessage and appendToTaskMessage update conversationLog', () => {
    const id = useSwarmStore.getState().addTask({
      title: 't',
      description: '',
      assignedModel: 'm',
      assignedProvider: 'anthropic',
      assignedRole: 'coder',
      contextHashes: [],
      fileClaims: [],
      contextFiles: [],
      dependencies: [],
    });
    useSwarmStore.getState().addTaskMessage(id, { role: 'user', content: 'hi' });
    useSwarmStore.getState().appendToTaskMessage(id, ' there');
    const log = useSwarmStore.getState().tasks.find((t) => t.id === id)!.conversationLog;
    expect(log).toHaveLength(2);
    expect(log[1].role).toBe('assistant');
    expect(log[1].content).toBe(' there');
    useSwarmStore.getState().appendToTaskMessage(id, '!');
    expect(useSwarmStore.getState().tasks.find((t) => t.id === id)!.conversationLog[1].content).toBe(' there!');
  });

  it('setResearch setPlan approvePlan setSynthesis setStatus', () => {
    useSwarmStore.getState().startSwarm('s', 'x');
    useSwarmStore.getState().setResearch({
      filesToModify: [],
      filesForContext: [],
      patterns: [],
      dependencies: [],
      considerations: [],
      rawFindings: '',
      smartHashes: new Map(),
      rawHashes: new Map(),
      fileContents: new Map(),
      projectContext: null,
    });
    expect(useSwarmStore.getState().research).not.toBeNull();
    useSwarmStore.getState().addResearchLog('step');
    expect(useSwarmStore.getState().researchLogs.some((l) => l.includes('step'))).toBe(true);
    useSwarmStore.getState().setPlan('do things');
    expect(useSwarmStore.getState().plan).toBe('do things');
    expect(useSwarmStore.getState().status).toBe('planning');
    useSwarmStore.getState().approvePlan();
    expect(useSwarmStore.getState().planApproved).toBe(true);
    expect(useSwarmStore.getState().status).toBe('running');
    useSwarmStore.getState().setSynthesis('syn');
    expect(useSwarmStore.getState().synthesis).toBe('syn');
    useSwarmStore.getState().setStatus('synthesizing');
    expect(useSwarmStore.getState().status).toBe('synthesizing');
  });

  it('updateStats does not clobber synthesizing when all tasks finished', () => {
    useSwarmStore.getState().startSwarm('s', 'x');
    const id = useSwarmStore.getState().addTask({
      title: 't',
      description: '',
      assignedModel: 'm',
      assignedProvider: 'anthropic',
      assignedRole: 'coder',
      contextHashes: [],
      fileClaims: [],
      contextFiles: [],
      dependencies: [],
    });
    useSwarmStore.getState().updateTaskStatus(id, 'completed');
    useSwarmStore.setState({ status: 'synthesizing' });
    useSwarmStore.getState().updateStats();
    expect(useSwarmStore.getState().status).toBe('synthesizing');
  });

  it('recordOrchestrationPlanUsage and recordOrchestrationSynthesisUsage roll into stats', () => {
    useSwarmStore.getState().startSwarm('s', 'x');
    useSwarmStore.getState().recordOrchestrationPlanUsage(100, 50, 3);
    useSwarmStore.getState().recordOrchestrationSynthesisUsage(20, 10, 1);
    const st = useSwarmStore.getState().stats;
    expect(st.planPhaseTokens).toBe(150);
    expect(st.planPhaseCostCents).toBe(3);
    expect(st.synthesisPhaseTokens).toBe(30);
    expect(st.synthesisPhaseCostCents).toBe(1);
    expect(st.totalTokensUsed).toBe(180);
    expect(st.totalCostCents).toBe(4);
  });

  it('rehydrateTasks restores session and stats from db rows', () => {
    const rows: DbTask[] = [
      {
        id: 't1',
        session_id: 'sess',
        title: 'a',
        description: 'd',
        status: 'completed',
        tokens_used: 10,
        cost_cents: 1,
      },
      {
        id: 't2',
        session_id: 'sess',
        title: 'b',
        status: 'failed',
        tokens_used: 5,
        cost_cents: 2,
      },
    ];
    useSwarmStore.getState().rehydrateTasks('sess', rows);
    const s = useSwarmStore.getState();
    expect(s.sessionId).toBe('sess');
    expect(s.tasks).toHaveLength(2);
    expect(s.isActive).toBe(false);
    expect(s.status).toBe('completed');
    expect(s.stats.totalTokensUsed).toBe(15);
    expect(s.stats.totalCostCents).toBe(3);
  });

  it('rehydrateTasks with empty array is a no-op', () => {
    useSwarmStore.getState().startSwarm('before', 'x');
    useSwarmStore.getState().rehydrateTasks('sess', []);
    expect(useSwarmStore.getState().sessionId).toBe('before');
  });

  it('checkRateLimit resets window after expiry', () => {
    vi.useFakeTimers();
    const t0 = 10_000_000;
    vi.setSystemTime(t0);
    const lim = useSwarmStore.getState().rateLimiter.providers.anthropic;
    useSwarmStore.setState({
      rateLimiter: {
        providers: {
          ...useSwarmStore.getState().rateLimiter.providers,
          anthropic: {
            ...lim,
            windowStart: t0,
            currentRequests: lim.requestsPerMinute,
            currentTokens: lim.tokensPerMinute - 1,
          },
        },
      },
    });
    expect(useSwarmStore.getState().checkRateLimit('anthropic', 10)).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(useSwarmStore.getState().checkRateLimit('anthropic', 10)).toBe(true);
  });

  it('getWaitTime honors retryAfter from handleRateLimitError', () => {
    useSwarmStore.getState().handleRateLimitError('openai', 3);
    expect(useSwarmStore.getState().getWaitTime('openai')).toBe(3000);
  });
});
