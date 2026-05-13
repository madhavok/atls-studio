import { describe, expect, it } from 'vitest';
import type { AgentLane } from '../stores/agentLaneStore';
import type { SwarmTask } from '../stores/swarmStore';
import type { RoundSnapshot } from '../stores/roundHistoryStore';
import { buildManualLaneTelemetry, buildMissionTelemetry, buildSwarmLaneTelemetry, formatCompactNumber } from './multiagentTelemetry';

const baseTelemetry = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costCents: 0,
  rounds: 0,
  retries: 0,
};

function manualLane(overrides: Partial<AgentLane> = {}): AgentLane {
  return {
    id: 'lane-1',
    sessionId: 'session-1',
    kind: 'manual',
    role: 'reviewer',
    title: 'Reviewer Lane',
    objective: '',
    status: 'running',
    fileClaims: [],
    messages: [{ id: 'msg-1', role: 'assistant', content: 'Reviewing src/App.tsx', timestamp: new Date() }],
    telemetry: { ...baseTelemetry, totalTokens: 100, costCents: 2 },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function swarmTask(overrides: Partial<SwarmTask> = {}): SwarmTask {
  return {
    id: 'task-1',
    title: 'Implement feature',
    description: 'Implement the requested feature',
    status: 'completed',
    assignedModel: 'claude-sonnet-4-5',
    assignedProvider: 'anthropic',
    assignedRole: 'coder',
    contextHashes: [],
    fileClaims: [],
    contextFiles: [],
    dependencies: [],
    tokensUsed: 500,
    costCents: 10,
    retryCount: 1,
    maxRetries: 3,
    conversationLog: [{ id: 'agent-msg-1', role: 'assistant', content: 'Done', timestamp: new Date() }],
    ...overrides,
  };
}

function snapshot(overrides: Partial<RoundSnapshot> = {}): RoundSnapshot {
  return {
    round: 1,
    timestamp: Date.now(),
    wmTokens: 0,
    bbTokens: 0,
    stagedTokens: 0,
    archivedTokens: 0,
    overheadTokens: 0,
    freeTokens: 1000,
    maxTokens: 1000,
    staticSystemTokens: 0,
    conversationHistoryTokens: 0,
    stagedBucketTokens: 0,
    workspaceContextTokens: 0,
    providerInputTokens: 0,
    estimatedTotalPromptTokens: 0,
    cacheStablePrefixTokens: 0,
    cacheChurnTokens: 0,
    reliefAction: 'none',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    costCents: 3,
    compressionSavings: 0,
    rollingSavings: 0,
    rolledRounds: 0,
    rollingSummaryTokens: 0,
    freedTokens: 0,
    cumulativeSaved: 0,
    toolCalls: 0,
    manageOps: 0,
    hypotheticalNonBatchedCost: 0,
    actualCost: 0,
    ...overrides,
  };
}

describe('multiagentTelemetry', () => {
  it('formats compact numbers', () => {
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(1200)).toBe('1.2k');
  });

  it('builds mission telemetry from snapshots, manual lanes, and swarm tasks', () => {
    const telemetry = buildMissionTelemetry({
      snapshots: [snapshot({ roundLatencyMs: 120 })],
      manualLanes: [manualLane()],
      swarmTasks: [swarmTask()],
      contextTotalTokens: 250,
      contextMaxTokens: 1000,
    });

    expect(telemetry.totalTokens).toBe(150);
    expect(telemetry.costCents).toBe(3);
    expect(telemetry.activeAgents).toBe(1);
    expect(telemetry.completedAgents).toBe(1);
    expect(telemetry.contextPressurePct).toBe(25);
    expect(telemetry.avgLatencyMs).toBe(120);
  });

  it('builds lane telemetry views', () => {
    expect(buildManualLaneTelemetry(manualLane()).lastEvent).toContain('Reviewing');
    expect(buildSwarmLaneTelemetry(swarmTask(), [snapshot({ isSwarmRound: true, swarmTaskId: 'task-1' })]).rounds).toBe(1);
  });
});
