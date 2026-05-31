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
  projectPath: string | null;
  activeParentSessionId: string | null;
  windowsByParent: Record<string, AgentWindow[]>;
  selectedWindowByParent: Record<string, string>;
  telemetryCollapsedByParent: Record<string, boolean>;

  hydrateProject: (projectPath: string | null, sessions?: Array<{ id: string; title?: string }>) => void;
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
  closeParentSession: (parentSessionId: string) => void;
  selectWindow: (parentSessionId: string, windowId: string) => void;
  renameWindow: (windowId: string, title: string) => void;
  setWindowStatus: (windowId: string, status: AgentWindowStatus) => void;
  setTelemetryCollapsed: (parentSessionId: string, collapsed: boolean) => void;
  reset: () => void;
}

const STORAGE_KEY_PREFIX = 'atls-agent-windows-v1';
const COLORS: AgentWindowColor[] = ['cyan', 'violet', 'emerald', 'amber', 'rose', 'blue'];
const EMPTY_PERSISTED: PersistedAgentWindowState = {
  activeParentSessionId: null,
  windowsByParent: {},
  selectedWindowByParent: {},
  telemetryCollapsedByParent: {},
};

type PersistedAgentWindowState = Pick<
  AgentWindowState,
  'activeParentSessionId' | 'windowsByParent' | 'selectedWindowByParent' | 'telemetryCollapsedByParent'
>;

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

function storageKeyForProject(projectPath: string | null): string {
  const key = projectPath?.trim() ? encodeURIComponent(projectPath.trim()) : 'global';
  return `${STORAGE_KEY_PREFIX}:${key}`;
}

function loadPersisted(projectPath: string | null): PersistedAgentWindowState {
  if (typeof localStorage === 'undefined') {
    return EMPTY_PERSISTED;
  }
  try {
    const raw = localStorage.getItem(storageKeyForProject(projectPath));
    if (!raw) return EMPTY_PERSISTED;
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
    return EMPTY_PERSISTED;
  }
}

function persist(projectPath: string | null, state: PersistedAgentWindowState) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(storageKeyForProject(projectPath), JSON.stringify(state));
}

function pickPersisted(state: AgentWindowState): PersistedAgentWindowState {
  return {
    activeParentSessionId: state.activeParentSessionId,
    windowsByParent: state.windowsByParent,
    selectedWindowByParent: state.selectedWindowByParent,
    telemetryCollapsedByParent: state.telemetryCollapsedByParent,
  };
}

function seedFromSessions(sessions: Array<{ id: string; title?: string }> = []): PersistedAgentWindowState {
  const windowsByParent = Object.fromEntries(
    sessions.slice(0, 6).map((session) => [
      session.id,
      [primaryWindow(session.id, session.title?.trim() || 'Primary Chat')],
    ]),
  );
  const selectedWindowByParent = Object.fromEntries(
    Object.keys(windowsByParent).map((sessionId) => [sessionId, `primary-${sessionId}`]),
  );
  const activeParentSessionId = sessions[0]?.id ?? null;
  return {
    activeParentSessionId,
    windowsByParent,
    selectedWindowByParent,
    telemetryCollapsedByParent: {},
  };
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

const persisted = loadPersisted(null);

export const useAgentWindowStore = create<AgentWindowState>((set, get) => ({
  projectPath: null,
  ...persisted,

  hydrateProject: (projectPath, sessions = []) => set((state) => {
    if (state.projectPath === projectPath && Object.keys(state.windowsByParent).length > 0) return {};
    const persistedProject = loadPersisted(projectPath);
    const nextPersisted = Object.keys(persistedProject.windowsByParent).length > 0
      ? persistedProject
      : seedFromSessions(sessions);
    const next = {
      projectPath,
      ...nextPersisted,
    };
    if (Object.keys(next.windowsByParent).length > 0) persist(projectPath, nextPersisted);
    return next;
  }),

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
    persist(state.projectPath, { ...pickPersisted(state), ...next });
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
    persist(state.projectPath, { ...pickPersisted(state), ...next });
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
      persist(state.projectPath, { ...pickPersisted(state), ...next });
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
      persist(state.projectPath, { ...pickPersisted(state), ...next });
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
    persist(state.projectPath, { ...pickPersisted(state), ...next });
    return next;
  }),

  closeParentSession: (parentSessionId) => set((state) => {
    const windowsByParent = { ...state.windowsByParent };
    delete windowsByParent[parentSessionId];
    const selectedWindowByParent = { ...state.selectedWindowByParent };
    delete selectedWindowByParent[parentSessionId];
    const telemetryCollapsedByParent = { ...state.telemetryCollapsedByParent };
    delete telemetryCollapsedByParent[parentSessionId];
    const fallbackParentId = state.activeParentSessionId === parentSessionId
      ? Object.keys(windowsByParent)[0] ?? null
      : state.activeParentSessionId;
    const next = {
      activeParentSessionId: fallbackParentId,
      windowsByParent,
      selectedWindowByParent,
      telemetryCollapsedByParent,
    };
    persist(state.projectPath, next);
    return next;
  }),

  selectWindow: (parentSessionId, windowId) => set((state) => {
    const selectedWindowByParent = { ...state.selectedWindowByParent, [parentSessionId]: windowId };
    persist(state.projectPath, { ...pickPersisted(state), selectedWindowByParent });
    return { selectedWindowByParent };
  }),

  renameWindow: (windowId, title) => set((state) => {
    const windowsByParent = mutateWindow(state.windowsByParent, windowId, (window) => (
      window.title === title ? window : { ...window, title, updatedAt: new Date() }
    ));
    if (windowsByParent === state.windowsByParent) return {};
    persist(state.projectPath, { ...pickPersisted(state), windowsByParent });
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
    persist(state.projectPath, { ...pickPersisted(state), windowsByParent });
    return { windowsByParent };
  }),

  setTelemetryCollapsed: (parentSessionId, collapsed) => set((state) => {
    const telemetryCollapsedByParent = { ...state.telemetryCollapsedByParent, [parentSessionId]: collapsed };
    persist(state.projectPath, { ...pickPersisted(state), telemetryCollapsedByParent });
    return { telemetryCollapsedByParent };
  }),

  reset: () => {
    const currentProjectPath = get().projectPath;
    const next = { projectPath: null, ...EMPTY_PERSISTED };
    persist(currentProjectPath, EMPTY_PERSISTED);
    set(next);
  },
}));
