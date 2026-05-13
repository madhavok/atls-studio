import type { RoundSnapshot } from '../stores/roundHistoryStore';
import type { AgentLane, AgentLaneTelemetry } from '../stores/agentLaneStore';
import type { SwarmTask, SwarmStats } from '../stores/swarmStore';

export interface MissionTelemetry {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  rounds: number;
  activeAgents: number;
  blockedAgents: number;
  completedAgents: number;
  failedAgents: number;
  avgLatencyMs: number | null;
  contextPressurePct: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LaneTelemetryView extends AgentLaneTelemetry {
  status: string;
  lastEvent: string;
}

const EMPTY_MISSION_TELEMETRY: MissionTelemetry = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  costCents: 0,
  rounds: 0,
  activeAgents: 0,
  blockedAgents: 0,
  completedAgents: 0,
  failedAgents: 0,
  avgLatencyMs: null,
  contextPressurePct: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

export function buildMissionTelemetry({
  snapshots,
  manualLanes,
  swarmTasks,
  swarmStats,
  contextTotalTokens,
  contextMaxTokens,
}: {
  snapshots: RoundSnapshot[];
  manualLanes: AgentLane[];
  swarmTasks: SwarmTask[];
  swarmStats?: SwarmStats;
  contextTotalTokens: number;
  contextMaxTokens: number;
}): MissionTelemetry {
  const mission = { ...EMPTY_MISSION_TELEMETRY };

  for (const snapshot of snapshots) {
    mission.inputTokens += snapshot.inputTokens;
    mission.outputTokens += snapshot.outputTokens;
    mission.costCents += snapshot.costCents;
    mission.cacheReadTokens += snapshot.cacheReadTokens;
    mission.cacheWriteTokens += snapshot.cacheWriteTokens;
    if (snapshot.roundLatencyMs) mission.avgLatencyMs = (mission.avgLatencyMs ?? 0) + snapshot.roundLatencyMs;
  }

  mission.rounds = snapshots.length;
  mission.totalTokens = mission.inputTokens + mission.outputTokens;
  if (mission.avgLatencyMs !== null && snapshots.length > 0) {
    mission.avgLatencyMs = Math.round(mission.avgLatencyMs / snapshots.length);
  }

  const laneStatuses = [
    ...manualLanes.map((lane) => lane.status),
    ...swarmTasks.map((task) => task.status),
  ];
  mission.activeAgents = laneStatuses.filter((status) => status === 'running').length;
  mission.blockedAgents = laneStatuses.filter((status) => status === 'awaiting_input' || status === 'blocked' || status === 'paused').length;
  mission.completedAgents = laneStatuses.filter((status) => status === 'completed').length;
  mission.failedAgents = laneStatuses.filter((status) => status === 'failed' || status === 'cancelled').length;

  if (swarmStats) {
    mission.totalTokens += swarmStats.totalTokensUsed;
    mission.costCents += swarmStats.totalCostCents;
  }

  mission.contextPressurePct = contextMaxTokens > 0
    ? Math.min(100, Math.round((contextTotalTokens / contextMaxTokens) * 100))
    : 0;

  return mission;
}

export function buildManualLaneTelemetry(lane: AgentLane): LaneTelemetryView {
  const last = lane.messages[lane.messages.length - 1];
  return {
    ...lane.telemetry,
    status: lane.status,
    lastEvent: last?.content.split('\n')[0]?.slice(0, 120) || 'No lane activity yet.',
  };
}

export function buildSwarmLaneTelemetry(task: SwarmTask, snapshots: RoundSnapshot[]): LaneTelemetryView {
  const taskSnapshots = snapshots.filter((snapshot) => snapshot.swarmTaskId === task.id);
  const inputTokens = taskSnapshots.reduce((sum, snapshot) => sum + snapshot.inputTokens, 0);
  const outputTokens = taskSnapshots.reduce((sum, snapshot) => sum + snapshot.outputTokens, 0);
  const latencyValues = taskSnapshots.map((snapshot) => snapshot.roundLatencyMs).filter((value): value is number => typeof value === 'number');
  const avgLatency = latencyValues.length > 0
    ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length)
    : undefined;
  const last = task.conversationLog[task.conversationLog.length - 1];

  return {
    inputTokens,
    outputTokens,
    totalTokens: task.tokensUsed || inputTokens + outputTokens,
    costCents: task.costCents,
    rounds: taskSnapshots.length,
    latencyMs: avgLatency,
    lastTool: last?.toolName,
    retries: task.retryCount,
    status: task.status,
    lastEvent: task.error || last?.content?.split('\n')[0]?.slice(0, 120) || task.description,
  };
}
