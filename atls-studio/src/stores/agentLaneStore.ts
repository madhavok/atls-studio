import { create } from 'zustand';
import type { AIProvider } from '../services/aiService';

export type AgentLaneRole =
  | 'primary'
  | 'orchestrator'
  | 'coder'
  | 'reviewer'
  | 'tester'
  | 'debugger'
  | 'researcher'
  | 'documenter'
  | 'custom';

export type AgentLaneKind = 'manual' | 'swarm';
export type AgentLaneStatus = 'idle' | 'running' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type ManualAgentLaneRole = Exclude<AgentLaneRole, 'primary' | 'orchestrator'>;

export interface AgentLaneTelemetry {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: number;
  rounds: number;
  latencyMs?: number;
  lastTool?: string;
  retries: number;
}

export interface AgentLaneMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export interface AgentLane {
  id: string;
  sessionId: string;
  kind: AgentLaneKind;
  role: AgentLaneRole;
  title: string;
  objective: string;
  status: AgentLaneStatus;
  model?: string;
  provider?: AIProvider;
  taskId?: string;
  childSessionId?: string;
  fileClaims: string[];
  messages: AgentLaneMessage[];
  telemetry: AgentLaneTelemetry;
  createdAt: Date;
  updatedAt: Date;
  error?: string;
}

interface SerializedAgentLane extends Omit<AgentLane, 'createdAt' | 'updatedAt' | 'messages'> {
  createdAt: string;
  updatedAt: string;
  messages: Array<Omit<AgentLaneMessage, 'timestamp'> & { timestamp: string }>;
}

interface AgentLaneState {
  lanesBySession: Record<string, AgentLane[]>;
  selectedLaneBySession: Record<string, string>;
  expandedLaneBySession: Record<string, string | null>;
  draftsByLane: Record<string, string>;

  spawnManualLane: (sessionId: string, role: ManualAgentLaneRole, objective?: string) => string;
  removeLane: (sessionId: string, laneId: string) => void;
  selectLane: (sessionId: string, laneId: string) => void;
  toggleLaneExpanded: (sessionId: string, laneId: string) => void;
  setLaneDraft: (laneId: string, draft: string) => void;
  setLaneStatus: (laneId: string, status: AgentLaneStatus, error?: string) => void;
  appendLaneMessage: (laneId: string, message: Omit<AgentLaneMessage, 'id' | 'timestamp'>) => void;
  replaceLastAssistantMessage: (laneId: string, content: string) => void;
  updateLaneTelemetry: (laneId: string, patch: Partial<AgentLaneTelemetry>) => void;
  clearSessionLanes: (sessionId: string) => void;
  mergeHydratedLanes: (sessionId: string, lanes: AgentLane[]) => void;
}

const STORAGE_KEY = 'atls-agent-lanes-v1';

const EMPTY_TELEMETRY: AgentLaneTelemetry = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costCents: 0,
  rounds: 0,
  retries: 0,
};

export const AGENT_LANE_ROLE_LABELS: Record<AgentLaneRole, string> = {
  primary: 'Primary',
  orchestrator: 'Orchestrator',
  coder: 'Coder',
  reviewer: 'Reviewer',
  tester: 'Tester',
  debugger: 'Debugger',
  researcher: 'Researcher',
  documenter: 'Documenter',
  custom: 'Custom',
};

export const MANUAL_AGENT_ROLES: ManualAgentLaneRole[] = [
  'coder',
  'reviewer',
  'tester',
  'debugger',
  'researcher',
  'documenter',
  'custom',
];

function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function reviveLane(lane: SerializedAgentLane): AgentLane {
  return {
    ...lane,
    telemetry: { ...EMPTY_TELEMETRY, ...lane.telemetry },
    createdAt: new Date(lane.createdAt),
    updatedAt: new Date(lane.updatedAt),
    messages: lane.messages.map((message) => ({
      ...message,
      timestamp: new Date(message.timestamp),
    })),
  };
}

function loadPersistedLanes(): Pick<AgentLaneState, 'lanesBySession' | 'selectedLaneBySession' | 'expandedLaneBySession' | 'draftsByLane'> {
  if (typeof localStorage === 'undefined') {
    return { lanesBySession: {}, selectedLaneBySession: {}, expandedLaneBySession: {}, draftsByLane: {} };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { lanesBySession: {}, selectedLaneBySession: {}, expandedLaneBySession: {}, draftsByLane: {} };
    const parsed = JSON.parse(raw) as {
      lanesBySession?: Record<string, SerializedAgentLane[]>;
      selectedLaneBySession?: Record<string, string>;
      expandedLaneBySession?: Record<string, string | null>;
      draftsByLane?: Record<string, string>;
    };
    const lanesBySession = Object.fromEntries(
      Object.entries(parsed.lanesBySession ?? {}).map(([sessionId, lanes]) => [
        sessionId,
        lanes.map(reviveLane),
      ]),
    );
    return {
      lanesBySession,
      selectedLaneBySession: parsed.selectedLaneBySession ?? {},
      expandedLaneBySession: parsed.expandedLaneBySession ?? {},
      draftsByLane: parsed.draftsByLane ?? {},
    };
  } catch {
    return { lanesBySession: {}, selectedLaneBySession: {}, expandedLaneBySession: {}, draftsByLane: {} };
  }
}

function persist(state: Pick<AgentLaneState, 'lanesBySession' | 'selectedLaneBySession' | 'expandedLaneBySession' | 'draftsByLane'>) {
  if (typeof localStorage === 'undefined') return;
  const serializable = {
    lanesBySession: state.lanesBySession,
    selectedLaneBySession: state.selectedLaneBySession,
    expandedLaneBySession: state.expandedLaneBySession,
    draftsByLane: state.draftsByLane,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}

function mutateLane(
  lanesBySession: Record<string, AgentLane[]>,
  laneId: string,
  updater: (lane: AgentLane) => AgentLane,
): Record<string, AgentLane[]> {
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(lanesBySession).map(([sessionId, lanes]) => [
      sessionId,
      lanes.map((lane) => {
        if (lane.id !== laneId) return lane;
        changed = true;
        return updater(lane);
      }),
    ]),
  );
  return changed ? next : lanesBySession;
}

const persisted = loadPersistedLanes();

export const useAgentLaneStore = create<AgentLaneState>((set, get) => ({
  ...persisted,

  spawnManualLane: (sessionId, role, objective = '') => {
    const now = new Date();
    const lane: AgentLane = {
      id: createId('lane'),
      sessionId,
      kind: 'manual',
      role,
      title: `${AGENT_LANE_ROLE_LABELS[role]} Lane`,
      objective,
      status: 'idle',
      fileClaims: [],
      messages: [],
      telemetry: { ...EMPTY_TELEMETRY },
      createdAt: now,
      updatedAt: now,
    };
    set((state) => {
      const lanesBySession = {
        ...state.lanesBySession,
        [sessionId]: [...(state.lanesBySession[sessionId] ?? []), lane],
      };
      const selectedLaneBySession = { ...state.selectedLaneBySession, [sessionId]: lane.id };
      const expandedLaneBySession = { ...state.expandedLaneBySession, [sessionId]: lane.id };
      const next = { lanesBySession, selectedLaneBySession, expandedLaneBySession };
      persist({ ...state, ...next });
      return next;
    });
    return lane.id;
  },

  removeLane: (sessionId, laneId) => set((state) => {
    const lanes = (state.lanesBySession[sessionId] ?? []).filter((lane) => lane.id !== laneId);
    const lanesBySession = { ...state.lanesBySession, [sessionId]: lanes };
    const selectedLaneBySession = { ...state.selectedLaneBySession };
    const expandedLaneBySession = { ...state.expandedLaneBySession };
    const draftsByLane = { ...state.draftsByLane };
    delete draftsByLane[laneId];
    if (selectedLaneBySession[sessionId] === laneId) selectedLaneBySession[sessionId] = 'primary';
    if (expandedLaneBySession[sessionId] === laneId) expandedLaneBySession[sessionId] = null;
    const next = { lanesBySession, selectedLaneBySession, expandedLaneBySession, draftsByLane };
    persist({ ...state, ...next });
    return next;
  }),

  selectLane: (sessionId, laneId) => set((state) => {
    const selectedLaneBySession = { ...state.selectedLaneBySession, [sessionId]: laneId };
    persist({ ...state, selectedLaneBySession });
    return { selectedLaneBySession };
  }),

  toggleLaneExpanded: (sessionId, laneId) => set((state) => {
    const current = state.expandedLaneBySession[sessionId] ?? null;
    const expandedLaneBySession = { ...state.expandedLaneBySession, [sessionId]: current === laneId ? null : laneId };
    persist({ ...state, expandedLaneBySession });
    return { expandedLaneBySession };
  }),

  setLaneDraft: (laneId, draft) => set((state) => {
    const draftsByLane = { ...state.draftsByLane, [laneId]: draft };
    persist({ ...state, draftsByLane });
    return { draftsByLane };
  }),

  setLaneStatus: (laneId, status, error) => set((state) => {
    const lanesBySession = mutateLane(state.lanesBySession, laneId, (lane) => ({
      ...lane,
      status,
      error,
      updatedAt: new Date(),
    }));
    persist({ ...state, lanesBySession });
    return { lanesBySession };
  }),

  appendLaneMessage: (laneId, message) => set((state) => {
    const lanesBySession = mutateLane(state.lanesBySession, laneId, (lane) => ({
      ...lane,
      messages: [...lane.messages, { ...message, id: createId('lane-msg'), timestamp: new Date() }],
      updatedAt: new Date(),
    }));
    persist({ ...state, lanesBySession });
    return { lanesBySession };
  }),

  replaceLastAssistantMessage: (laneId, content) => set((state) => {
    const lanesBySession = mutateLane(state.lanesBySession, laneId, (lane) => {
      const messages = [...lane.messages];
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') {
        messages[messages.length - 1] = { ...last, content, timestamp: new Date() };
      } else {
        messages.push({ id: createId('lane-msg'), role: 'assistant', content, timestamp: new Date() });
      }
      return { ...lane, messages, updatedAt: new Date() };
    });
    persist({ ...state, lanesBySession });
    return { lanesBySession };
  }),

  updateLaneTelemetry: (laneId, patch) => set((state) => {
    const lanesBySession = mutateLane(state.lanesBySession, laneId, (lane) => ({
      ...lane,
      telemetry: { ...lane.telemetry, ...patch },
      updatedAt: new Date(),
    }));
    persist({ ...state, lanesBySession });
    return { lanesBySession };
  }),

  clearSessionLanes: (sessionId) => set((state) => {
    const lanesBySession = { ...state.lanesBySession };
    delete lanesBySession[sessionId];
    const selectedLaneBySession = { ...state.selectedLaneBySession };
    const expandedLaneBySession = { ...state.expandedLaneBySession };
    delete selectedLaneBySession[sessionId];
    delete expandedLaneBySession[sessionId];
    const laneIds = new Set((state.lanesBySession[sessionId] ?? []).map((lane) => lane.id));
    const draftsByLane = Object.fromEntries(
      Object.entries(state.draftsByLane).filter(([laneId]) => !laneIds.has(laneId)),
    );
    const next = { lanesBySession, selectedLaneBySession, expandedLaneBySession, draftsByLane };
    persist({ ...state, ...next });
    return next;
  }),

  mergeHydratedLanes: (sessionId, lanes) => set((state) => {
    if (lanes.length === 0) return state;
    const existing = state.lanesBySession[sessionId] ?? [];
    const existingIds = new Set(existing.map((lane) => lane.id));
    const merged = [...existing, ...lanes.filter((lane) => !existingIds.has(lane.id))];
    const lanesBySession = { ...state.lanesBySession, [sessionId]: merged };
    const selectedLaneBySession = state.selectedLaneBySession[sessionId]
      ? state.selectedLaneBySession
      : { ...state.selectedLaneBySession, [sessionId]: merged[0]?.id ?? 'primary' };
    const next = { lanesBySession, selectedLaneBySession };
    persist({ ...state, ...next });
    return next;
  }),
}));

export function getSessionLaneKey(sessionId: string | null): string {
  return sessionId ?? 'unsaved-session';
}

export function getLanePromptPrefix(role: AgentLaneRole, objective: string): string {
  const label = AGENT_LANE_ROLE_LABELS[role];
  const objectiveLine = objective.trim() ? ` Objective: ${objective.trim()}` : '';
  return `You are the ${label} lane in a multiagent ATLS mission.${objectiveLine} Keep your response compact, operational, and focused on your assigned lane.`;
}
