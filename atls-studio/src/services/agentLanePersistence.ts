import { chatDb } from './chatDb';
import {
  type AgentLane,
  type AgentLaneMessage,
  type AgentLaneRole,
  type AgentLaneStatus,
  type AgentLaneTelemetry,
} from '../stores/agentLaneStore';

interface AgentLaneMessageMeta {
  atlsType: 'agent_lane_message';
  lane: {
    id: string;
    role: AgentLaneRole;
    title: string;
    objective: string;
    status: AgentLaneStatus;
    fileClaims: string[];
    telemetry: AgentLaneTelemetry;
    createdAt: string;
    updatedAt: string;
  };
  messageRole: AgentLaneMessage['role'];
}

function canPersist(sessionId: string): boolean {
  return Boolean(sessionId && sessionId !== 'unsaved-session' && chatDb.isInitialized());
}

export async function persistAgentLaneMessage(
  sessionId: string,
  lane: AgentLane,
  message: Pick<AgentLaneMessage, 'role' | 'content'>,
): Promise<void> {
  if (!canPersist(sessionId)) return;
  const meta: AgentLaneMessageMeta = {
    atlsType: 'agent_lane_message',
    lane: {
      id: lane.id,
      role: lane.role,
      title: lane.title,
      objective: lane.objective,
      status: lane.status,
      fileClaims: lane.fileClaims,
      telemetry: lane.telemetry,
      createdAt: lane.createdAt.toISOString(),
      updatedAt: new Date().toISOString(),
    },
    messageRole: message.role,
  };
  await chatDb.addMessage(sessionId, 'agent', message.content, lane.id, undefined, JSON.stringify(meta));
}

export async function loadPersistedAgentLanes(sessionId: string): Promise<AgentLane[]> {
  if (!canPersist(sessionId)) return [];
  const messages = await chatDb.getMessages(sessionId);
  const grouped = new Map<string, { meta: AgentLaneMessageMeta; messages: AgentLaneMessage[] }>();

  for (const message of messages) {
    if (!message.metadata) continue;
    let meta: AgentLaneMessageMeta | null = null;
    try {
      const parsed = JSON.parse(message.metadata) as AgentLaneMessageMeta;
      if (parsed?.atlsType === 'agent_lane_message') meta = parsed;
    } catch {
      continue;
    }
    if (!meta) continue;
    const bucket = grouped.get(meta.lane.id) ?? { meta, messages: [] };
    bucket.messages.push({
      id: message.id,
      role: meta.messageRole,
      content: message.content,
      timestamp: new Date(message.timestamp),
    });
    grouped.set(meta.lane.id, bucket);
  }

  return Array.from(grouped.values()).map(({ meta, messages }) => ({
    id: meta.lane.id,
    sessionId,
    kind: 'manual',
    role: meta.lane.role,
    title: meta.lane.title,
    objective: meta.lane.objective,
    status: meta.lane.status,
    fileClaims: meta.lane.fileClaims,
    messages: messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
    telemetry: meta.lane.telemetry,
    createdAt: new Date(meta.lane.createdAt),
    updatedAt: new Date(meta.lane.updatedAt),
  }));
}

export function isAgentLaneMessageMetadata(metadata?: string | null): boolean {
  if (!metadata) return false;
  try {
    return (JSON.parse(metadata) as { atlsType?: string })?.atlsType === 'agent_lane_message';
  } catch {
    return false;
  }
}
