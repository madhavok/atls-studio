import { create } from 'zustand';

export type AgentWindowKind = 'primary' | 'standard' | 'swarm';
export type AgentWindowStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed';
export type AgentWindowColor = 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose' | 'blue';

export interface AgentWindow {
  windowId: string;
  sessionId: string;
  parentSessionId: string;
  title: string;
  status: AgentWindowStatus;
  groupColor: AgentWindowColor;
  kind: AgentWindowKind;
  role?: string;
  sourceToolCallId?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface SerializedAgentWindow extends Omit<AgentWindow, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
}

interface AgentWindowState {
  activeParentSessionId: string | null;
  windowsByParent: Record<string, AgentWindow[]>;
  selectedWindowByParent: Record<string, string>;
  telemetryCollapsedByParent: Record<string, boolean>;

  setActiveParentSession: (sessionId: string) => void;
  ensurePrimaryWindow: (parentSessionId: string, title?: string) => void;
  spawnStandardWindow: (
    parentSessionId: string,
    sessionId: string,
    title?: string,
    role?: string,
    sourceToolCallId?: string,
    options?: { select?: boolean },
  ) => string;
  upsertSwarmWindow: (parentSessionId: string, taskId: string, title: string, role?: string, status?: AgentWindowStatus) => string;
  removeWindow: (parentSessionId: string, windowId: string) => void;
  selectWindow: (parentSessionId: string, windowId: string) => void;
  renameWindow: (windowId: string, title: string) => void;
  setWindowStatus: (windowId: string, status: AgentWindowStatus) => void;
  setTelemetryCollapsed: (parentSessionId: string, collapsed: boolean) => void;
  reset: () => void;
}

const STORAGE_KEY = 'atls-agent-windows-v1';
const COLORS: AgentWindowColor[] = ['cyan', 'violet', 'emerald', 'amber', 'rose', 'blue'];

function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function reviveWindow(window: SerializedAgentWindow): AgentWindow {
  return {
    ...window,
    createdAt: new Date(window.createdAt),
    updatedAt: new Date(window.updatedAt),
  };
}

function loadPersisted(): Pick<AgentWindowState, 'activeParentSessionId' | 'windowsByParent' | 'selectedWindowByParent' | 'telemetryCollapsedByParent'> {
  if (typeof localStorage === 'undefined') {
    return { activeParentSessionId: null, windowsByParent: {}, selectedWindowByParent: {}, telemetryCollapsedByParent: {} };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { activeParentSessionId: null, windowsByParent: {}, selectedWindowByParent: {}, telemetryCollapsedByParent: {} };
    const parsed = JSON.parse(raw) as {
      activeParentSessionId?: string | null;
      windowsByParent?: Record<string, SerializedAgentWindow[]>;
      selectedWindowByParent?: Record<string, string>;
      telemetryCollapsedByParent?: Record<string, boolean>;
    };
    return {
      activeParentSessionId: parsed.activeParentSessionId ?? null,
      windowsByParent: Object.fromEntries(
        Object.entries(parsed.windowsByParent ?? {}).map(([parentId, windows]) => [
          parentId,
          windows.map(reviveWindow),
        ]),
      ),
      selectedWindowByParent: parsed.selectedWindowByParent ?? {},
      telemetryCollapsedByParent: parsed.telemetryCollapsedByParent ?? {},
    };
  } catch {
    return { activeParentSessionId: null, windowsByParent: {}, selectedWindowByParent: {}, telemetryCollapsedByParent: {} };
  }
}

function persist(state: Pick<AgentWindowState, 'activeParentSessionId' | 'windowsByParent' | 'selectedWindowByParent' | 'telemetryCollapsedByParent'>) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function primaryWindow(parentSessionId: string, title = 'Primary Chat'): AgentWindow {
  const now = new Date();
  return {
    windowId: `primary-${parentSessionId}`,
    sessionId: parentSessionId,
    parentSessionId,
    title,
    status: 'idle',
    groupColor: 'cyan',
    kind: 'primary',
    createdAt: now,
    updatedAt: now,
  };
}

function mutateWindow(
  windowsByParent: Record<string, AgentWindow[]>,
  windowId: string,
  updater: (window: AgentWindow) => AgentWindow,
): Record<string, AgentWindow[]> {
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(windowsByParent).map(([parentId, windows]) => [
      parentId,
      windows.map((window) => {
        if (window.windowId !== windowId) return window;
        const nextWindow = updater(window);
        if (nextWindow !== window) changed = true;
        return nextWindow;
      }),
    ]),
  );
  return changed ? next : windowsByParent;
}

const persisted = loadPersisted();

export const useAgentWindowStore = create<AgentWindowState>((set, get) => ({
  ...persisted,

  setActiveParentSession: (sessionId) => set((state) => {
    const windows = state.windowsByParent[sessionId] ?? [primaryWindow(sessionId)];
    const next = {
      activeParentSessionId: sessionId,
      windowsByParent: { ...state.windowsByParent, [sessionId]: windows },
      selectedWindowByParent: {
        ...state.selectedWindowByParent,
        [sessionId]: state.selectedWindowByParent[sessionId] ?? windows[0].windowId,
      },
    };
    persist({ ...state, ...next });
    return next;
  }),

  ensurePrimaryWindow: (parentSessionId, title = 'Primary Chat') => set((state) => {
    const existing = state.windowsByParent[parentSessionId] ?? [];
    const primaryId = `primary-${parentSessionId}`;
    const hasPrimary = existing.some((window) => window.windowId === primaryId);
    const windows = hasPrimary
      ? existing.map((window) => window.windowId === primaryId ? { ...window, title, sessionId: parentSessionId, parentSessionId } : window)
      : [primaryWindow(parentSessionId, title), ...existing];
    const next = {
      windowsByParent: { ...state.windowsByParent, [parentSessionId]: windows },
      selectedWindowByParent: {
        ...state.selectedWindowByParent,
        [parentSessionId]: state.selectedWindowByParent[parentSessionId] ?? primaryId,
      },
    };
    persist({ ...state, ...next });
    return next;
  }),

  spawnStandardWindow: (parentSessionId, sessionId, title, role, sourceToolCallId, options) => {
    const now = new Date();
    const current = get().windowsByParent[parentSessionId] ?? [primaryWindow(parentSessionId)];
    const standardCount = current.filter((window) => window.kind === 'standard').length;
    const window: AgentWindow = {
      windowId: createId('agent-window'),
      sessionId,
      parentSessionId,
      title: title || `Agent Window ${standardCount + 1}`,
      status: 'idle',
      groupColor: COLORS[(standardCount + 1) % COLORS.length],
      kind: 'standard',
      role,
      sourceToolCallId,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => {
      const windows = [...(state.windowsByParent[parentSessionId] ?? [primaryWindow(parentSessionId)]), window];
      const next = {
        windowsByParent: { ...state.windowsByParent, [parentSessionId]: windows },
        selectedWindowByParent: options?.select === false
          ? state.selectedWindowByParent
          : { ...state.selectedWindowByParent, [parentSessionId]: window.windowId },
      };
      persist({ ...state, ...next });
      return next;
    });
    return window.windowId;
  },

  upsertSwarmWindow: (parentSessionId, taskId, title, role, status = 'idle') => {
    const windowId = `swarm-${taskId}`;
    set((state) => {
      const windows = state.windowsByParent[parentSessionId] ?? [primaryWindow(parentSessionId)];
      const existing = windows.find((window) => window.windowId === windowId);
      const nextWindow: AgentWindow = {
        ...(existing ?? {
          windowId,
          sessionId: taskId,
          parentSessionId,
          groupColor: 'violet' as AgentWindowColor,
          kind: 'swarm' as AgentWindowKind,
          createdAt: new Date(),
        }),
        title,
        role,
        status,
        updatedAt: new Date(),
      };
      const nextWindows = existing
        ? windows.map((window) => window.windowId === windowId ? nextWindow : window)
        : [...windows, nextWindow];
      const next = { windowsByParent: { ...state.windowsByParent, [parentSessionId]: nextWindows } };
      persist({ ...state, ...next });
      return next;
    });
    return windowId;
  },

  removeWindow: (parentSessionId, windowId) => set((state) => {
    const windows = (state.windowsByParent[parentSessionId] ?? []).filter((window) => window.windowId !== windowId || window.kind === 'primary');
    const selectedWindowByParent = { ...state.selectedWindowByParent };
    if (selectedWindowByParent[parentSessionId] === windowId) selectedWindowByParent[parentSessionId] = `primary-${parentSessionId}`;
    const next = {
      windowsByParent: { ...state.windowsByParent, [parentSessionId]: windows },
      selectedWindowByParent,
    };
    persist({ ...state, ...next });
    return next;
  }),

  selectWindow: (parentSessionId, windowId) => set((state) => {
    const selectedWindowByParent = { ...state.selectedWindowByParent, [parentSessionId]: windowId };
    persist({ ...state, selectedWindowByParent });
    return { selectedWindowByParent };
  }),

  renameWindow: (windowId, title) => set((state) => {
    const windowsByParent = mutateWindow(state.windowsByParent, windowId, (window) => (
      window.title === title ? window : { ...window, title, updatedAt: new Date() }
    ));
    if (windowsByParent === state.windowsByParent) return {};
    persist({ ...state, windowsByParent });
    return { windowsByParent };
  }),

  setWindowStatus: (windowId, status) => set((state) => {
    const windowsByParent = mutateWindow(state.windowsByParent, windowId, (window) => {
      if (window.status === status) return window;
      return {
      ...window,
      status,
      updatedAt: new Date(),
      };
    });
    if (windowsByParent === state.windowsByParent) return {};
    persist({ ...state, windowsByParent });
    return { windowsByParent };
  }),

  setTelemetryCollapsed: (parentSessionId, collapsed) => set((state) => {
    const telemetryCollapsedByParent = { ...state.telemetryCollapsedByParent, [parentSessionId]: collapsed };
    persist({ ...state, telemetryCollapsedByParent });
    return { telemetryCollapsedByParent };
  }),

  reset: () => {
    const next = { activeParentSessionId: null, windowsByParent: {}, selectedWindowByParent: {}, telemetryCollapsedByParent: {} };
    persist(next);
    set(next);
  },
}));
