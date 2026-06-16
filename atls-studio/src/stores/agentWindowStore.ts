import { create } from 'zustand';

export type AgentWindowKind = 'primary' | 'standard' | 'swarm' | 'panel';
export type AgentWindowStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed';
export type AgentWindowColor = 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose' | 'blue';
/** Built-in cockpit panels rendered as first-class canvas windows. */
export type PanelKind = 'mission' | 'telemetry' | 'context' | 'terminal';
export type ArrangeStrategy = 'grid' | 'tidy' | 'cascade';

export interface CanvasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
  /** Panel windows (mission/telemetry/context/terminal) carry their panel kind. */
  panelKind?: PanelKind;
  /** Project root this window operates against. First-class on the flat canvas. */
  projectPath?: string;
  /** Canvas geometry (absolute coordinates in canvas space). */
  rect: CanvasRect;
  zIndex: number;
  minimized: boolean;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface SerializedAgentWindow extends Omit<AgentWindow, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
}

export interface CanvasViewport {
  pan: { x: number; y: number };
  zoom: number;
  arrangeStrategy: ArrangeStrategy;
}

interface AgentWindowState {
  projectPath: string | null;
  activeParentSessionId: string | null;
  windowsByParent: Record<string, AgentWindow[]>;
  selectedWindowByParent: Record<string, string>;
  telemetryCollapsedByParent: Record<string, boolean>;
  viewport: CanvasViewport;

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
  ensurePanelWindow: (parentSessionId: string, panelKind: PanelKind, title: string) => string;
  removeWindow: (parentSessionId: string, windowId: string) => void;
  closeParentSession: (parentSessionId: string) => void;
  selectWindow: (parentSessionId: string, windowId: string) => void;
  renameWindow: (windowId: string, title: string) => void;
  setWindowStatus: (windowId: string, status: AgentWindowStatus) => void;
  setWindowProjectPath: (windowId: string, projectPath: string | undefined) => void;
  setTelemetryCollapsed: (parentSessionId: string, collapsed: boolean) => void;
  // Canvas geometry actions
  moveWindow: (windowId: string, x: number, y: number) => void;
  resizeWindow: (windowId: string, w: number, h: number) => void;
  bringToFront: (windowId: string) => void;
  toggleMinimized: (windowId: string) => void;
  togglePinned: (windowId: string) => void;
  setPan: (pan: { x: number; y: number }) => void;
  setZoom: (zoom: number) => void;
  autoArrange: (strategy: ArrangeStrategy) => void;
  reset: () => void;
  /** Clear in-memory grid state without wiping per-project localStorage layout. */
  resetInMemory: () => void;
}

const STORAGE_KEY_PREFIX = 'atls-agent-windows-v2';
const LEGACY_STORAGE_KEY_PREFIX = 'atls-agent-windows-v1';
const COLORS: AgentWindowColor[] = ['cyan', 'violet', 'emerald', 'amber', 'rose', 'blue'];

const DEFAULT_W = 420;
const DEFAULT_H = 520;
const GAP = 28;
const CANVAS_MARGIN = 40;
const GRID_COLUMNS = 3;
const CASCADE_STEP = 36;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;

const DEFAULT_VIEWPORT: CanvasViewport = {
  pan: { x: 0, y: 0 },
  zoom: 1,
  arrangeStrategy: 'grid',
};

type PersistedAgentWindowState = Pick<
  AgentWindowState,
  'activeParentSessionId' | 'windowsByParent' | 'selectedWindowByParent' | 'telemetryCollapsedByParent' | 'viewport'
>;

const EMPTY_PERSISTED: PersistedAgentWindowState = {
  activeParentSessionId: null,
  windowsByParent: {},
  selectedWindowByParent: {},
  telemetryCollapsedByParent: {},
  viewport: DEFAULT_VIEWPORT,
};

function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Default cascade-style placement for a newly created window. */
function defaultRect(index: number): CanvasRect {
  const col = index % GRID_COLUMNS;
  const row = Math.floor(index / GRID_COLUMNS);
  return {
    x: CANVAS_MARGIN + col * (DEFAULT_W + GAP),
    y: CANVAS_MARGIN + row * (DEFAULT_H + GAP),
    w: DEFAULT_W,
    h: DEFAULT_H,
  };
}

function flattenWindows(windowsByParent: Record<string, AgentWindow[]>): AgentWindow[] {
  return Object.values(windowsByParent).flat();
}

function nextZIndex(windowsByParent: Record<string, AgentWindow[]>): number {
  const all = flattenWindows(windowsByParent);
  return all.reduce((max, window) => Math.max(max, window.zIndex), 0) + 1;
}

function reviveWindow(window: SerializedAgentWindow): AgentWindow {
  return {
    ...window,
    rect: window.rect ?? defaultRect(0),
    zIndex: window.zIndex ?? 1,
    minimized: window.minimized ?? false,
    pinned: window.pinned ?? false,
    createdAt: new Date(window.createdAt),
    updatedAt: new Date(window.updatedAt),
  };
}

function storageKeyForProject(projectPath: string | null): string {
  const key = projectPath?.trim() ? encodeURIComponent(projectPath.trim()) : 'global';
  return `${STORAGE_KEY_PREFIX}:${key}`;
}

function reviveViewport(raw: Partial<CanvasViewport> | undefined): CanvasViewport {
  if (!raw) return DEFAULT_VIEWPORT;
  return {
    pan: {
      x: typeof raw.pan?.x === 'number' ? raw.pan.x : 0,
      y: typeof raw.pan?.y === 'number' ? raw.pan.y : 0,
    },
    zoom: typeof raw.zoom === 'number' ? clamp(raw.zoom, ZOOM_MIN, ZOOM_MAX) : 1,
    arrangeStrategy: raw.arrangeStrategy === 'tidy' || raw.arrangeStrategy === 'cascade' ? raw.arrangeStrategy : 'grid',
  };
}

function loadPersisted(projectPath: string | null): PersistedAgentWindowState {
  if (typeof localStorage === 'undefined') {
    return EMPTY_PERSISTED;
  }
  try {
    const key = storageKeyForProject(projectPath);
    let raw = localStorage.getItem(key);
    if (!raw && key.includes('v2')) {
      const legacyKey = key.replace(STORAGE_KEY_PREFIX, LEGACY_STORAGE_KEY_PREFIX);
      const legacyRaw = localStorage.getItem(legacyKey);
      if (legacyRaw) {
        localStorage.setItem(key, legacyRaw);
        raw = legacyRaw;
      }
    }
    if (!raw) return EMPTY_PERSISTED;
    const parsed = JSON.parse(raw) as {
      activeParentSessionId?: string | null;
      windowsByParent?: Record<string, SerializedAgentWindow[]>;
      selectedWindowByParent?: Record<string, string>;
      telemetryCollapsedByParent?: Record<string, boolean>;
      viewport?: Partial<CanvasViewport>;
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
      viewport: reviveViewport(parsed.viewport),
    };
  } catch {
    return EMPTY_PERSISTED;
  }
}

function persist(projectPath: string | null, state: PersistedAgentWindowState) {
  if (typeof localStorage === 'undefined') return;
  // Agent canvas layout is stored per-project in localStorage and optionally in .atls-workspace agentGrid.
  localStorage.setItem(storageKeyForProject(projectPath), JSON.stringify(state));
}

function pickPersisted(state: AgentWindowState): PersistedAgentWindowState {
  return {
    activeParentSessionId: state.activeParentSessionId,
    windowsByParent: state.windowsByParent,
    selectedWindowByParent: state.selectedWindowByParent,
    telemetryCollapsedByParent: state.telemetryCollapsedByParent,
    viewport: state.viewport,
  };
}

function seedFromSessions(sessions: Array<{ id: string; title?: string }> = []): PersistedAgentWindowState {
  const windowsByParent = Object.fromEntries(
    sessions.slice(0, 6).map((session, index) => [
      session.id,
      [primaryWindow(session.id, session.title?.trim() || 'Primary Chat', undefined, index)],
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
    viewport: DEFAULT_VIEWPORT,
  };
}

function primaryWindow(parentSessionId: string, title = 'Primary Chat', projectPath?: string, index = 0): AgentWindow {
  const now = new Date();
  return {
    windowId: `primary-${parentSessionId}`,
    sessionId: parentSessionId,
    parentSessionId,
    title,
    status: 'idle',
    groupColor: 'cyan',
    kind: 'primary',
    projectPath,
    rect: defaultRect(index),
    zIndex: 1,
    minimized: false,
    pinned: false,
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

/** Recompute rects for all non-pinned windows using the chosen strategy. */
function arrangeRects(
  windowsByParent: Record<string, AgentWindow[]>,
  strategy: ArrangeStrategy,
): Record<string, AgentWindow[]> {
  const ordered = flattenWindows(windowsByParent)
    .filter((window) => !window.pinned && !window.minimized)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const placement = new Map<string, CanvasRect>();

  if (strategy === 'cascade') {
    ordered.forEach((window, index) => {
      placement.set(window.windowId, {
        x: CANVAS_MARGIN + index * CASCADE_STEP,
        y: CANVAS_MARGIN + index * CASCADE_STEP,
        w: window.rect.w,
        h: window.rect.h,
      });
    });
  } else if (strategy === 'tidy') {
    // Cluster by project: each project becomes a vertical column band.
    const byProject = new Map<string, AgentWindow[]>();
    for (const window of ordered) {
      const key = window.projectPath ?? '∅';
      const list = byProject.get(key) ?? [];
      list.push(window);
      byProject.set(key, list);
    }
    let column = 0;
    for (const list of byProject.values()) {
      list.forEach((window, row) => {
        placement.set(window.windowId, {
          x: CANVAS_MARGIN + column * (DEFAULT_W + GAP),
          y: CANVAS_MARGIN + row * (DEFAULT_H + GAP),
          w: window.rect.w,
          h: window.rect.h,
        });
      });
      column += 1;
    }
  } else {
    // grid (row-major)
    ordered.forEach((window, index) => {
      const col = index % GRID_COLUMNS;
      const row = Math.floor(index / GRID_COLUMNS);
      placement.set(window.windowId, {
        x: CANVAS_MARGIN + col * (DEFAULT_W + GAP),
        y: CANVAS_MARGIN + row * (DEFAULT_H + GAP),
        w: window.rect.w,
        h: window.rect.h,
      });
    });
  }

  if (placement.size === 0) return windowsByParent;
  return Object.fromEntries(
    Object.entries(windowsByParent).map(([parentId, windows]) => [
      parentId,
      windows.map((window) => {
        const rect = placement.get(window.windowId);
        return rect ? { ...window, rect, updatedAt: new Date() } : window;
      }),
    ]),
  );
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
    const projectPath = state.projectPath ?? undefined;
    const index = flattenWindows(state.windowsByParent).length;
    const windows = hasPrimary
      ? existing.map((window) => window.windowId === primaryId
        ? { ...window, title, sessionId: parentSessionId, parentSessionId, projectPath: window.projectPath ?? projectPath }
        : window)
      : [primaryWindow(parentSessionId, title, projectPath, index), ...existing];
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
    const state = get();
    const current = state.windowsByParent[parentSessionId] ?? [primaryWindow(parentSessionId)];
    const standardCount = current.filter((window) => window.kind === 'standard').length;
    const totalCount = flattenWindows(state.windowsByParent).length;
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
      projectPath: state.projectPath ?? undefined,
      rect: defaultRect(totalCount),
      zIndex: nextZIndex(state.windowsByParent),
      minimized: false,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };
    set((current2) => {
      const windows = [...(current2.windowsByParent[parentSessionId] ?? [primaryWindow(parentSessionId)]), window];
      const next = {
        windowsByParent: { ...current2.windowsByParent, [parentSessionId]: windows },
        selectedWindowByParent: options?.select === false
          ? current2.selectedWindowByParent
          : { ...current2.selectedWindowByParent, [parentSessionId]: window.windowId },
      };
      persist(current2.projectPath, { ...pickPersisted(current2), ...next });
      return next;
    });
    return window.windowId;
  },

  upsertSwarmWindow: (parentSessionId, taskId, title, role, status = 'idle') => {
    const windowId = `swarm-${taskId}`;
    set((state) => {
      const windows = state.windowsByParent[parentSessionId] ?? [primaryWindow(parentSessionId)];
      const existing = windows.find((window) => window.windowId === windowId);
      const totalCount = flattenWindows(state.windowsByParent).length;
      const nextWindow: AgentWindow = {
        ...(existing ?? {
          windowId,
          sessionId: taskId,
          parentSessionId,
          groupColor: 'violet' as AgentWindowColor,
          kind: 'swarm' as AgentWindowKind,
          projectPath: state.projectPath ?? undefined,
          rect: defaultRect(totalCount),
          zIndex: nextZIndex(state.windowsByParent),
          minimized: false,
          pinned: false,
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

  ensurePanelWindow: (parentSessionId, panelKind, title) => {
    const windowId = `panel-${panelKind}-${parentSessionId}`;
    set((state) => {
      const windows = state.windowsByParent[parentSessionId] ?? [primaryWindow(parentSessionId)];
      if (windows.some((window) => window.windowId === windowId)) return {};
      const totalCount = flattenWindows(state.windowsByParent).length;
      const now = new Date();
      const panel: AgentWindow = {
        windowId,
        sessionId: `${panelKind}-${parentSessionId}`,
        parentSessionId,
        title,
        status: 'idle',
        groupColor: 'blue',
        kind: 'panel',
        panelKind,
        projectPath: state.projectPath ?? undefined,
        rect: { ...defaultRect(totalCount), h: 360 },
        zIndex: nextZIndex(state.windowsByParent),
        minimized: false,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      };
      const next = { windowsByParent: { ...state.windowsByParent, [parentSessionId]: [...windows, panel] } };
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
      viewport: state.viewport,
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

  setWindowProjectPath: (windowId, projectPath) => set((state) => {
    const windowsByParent = mutateWindow(state.windowsByParent, windowId, (window) => (
      window.projectPath === projectPath ? window : { ...window, projectPath, updatedAt: new Date() }
    ));
    if (windowsByParent === state.windowsByParent) return {};
    persist(state.projectPath, { ...pickPersisted(state), windowsByParent });
    return { windowsByParent };
  }),

  setTelemetryCollapsed: (parentSessionId, collapsed) => set((state) => {
    const telemetryCollapsedByParent = { ...state.telemetryCollapsedByParent, [parentSessionId]: collapsed };
    persist(state.projectPath, { ...pickPersisted(state), telemetryCollapsedByParent });
    return { telemetryCollapsedByParent };
  }),

  moveWindow: (windowId, x, y) => set((state) => {
    const windowsByParent = mutateWindow(state.windowsByParent, windowId, (window) => (
      window.rect.x === x && window.rect.y === y
        ? window
        : { ...window, rect: { ...window.rect, x, y }, updatedAt: new Date() }
    ));
    if (windowsByParent === state.windowsByParent) return {};
    persist(state.projectPath, { ...pickPersisted(state), windowsByParent });
    return { windowsByParent };
  }),

  resizeWindow: (windowId, w, h) => set((state) => {
    const width = Math.max(280, w);
    const height = Math.max(200, h);
    const windowsByParent = mutateWindow(state.windowsByParent, windowId, (window) => (
      window.rect.w === width && window.rect.h === height
        ? window
        : { ...window, rect: { ...window.rect, w: width, h: height }, updatedAt: new Date() }
    ));
    if (windowsByParent === state.windowsByParent) return {};
    persist(state.projectPath, { ...pickPersisted(state), windowsByParent });
    return { windowsByParent };
  }),

  bringToFront: (windowId) => set((state) => {
    const top = nextZIndex(state.windowsByParent);
    const windowsByParent = mutateWindow(state.windowsByParent, windowId, (window) => (
      window.zIndex >= top - 1 ? window : { ...window, zIndex: top }
    ));
    if (windowsByParent === state.windowsByParent) return {};
    persist(state.projectPath, { ...pickPersisted(state), windowsByParent });
    return { windowsByParent };
  }),

  toggleMinimized: (windowId) => set((state) => {
    const windowsByParent = mutateWindow(state.windowsByParent, windowId, (window) => (
      { ...window, minimized: !window.minimized, updatedAt: new Date() }
    ));
    if (windowsByParent === state.windowsByParent) return {};
    persist(state.projectPath, { ...pickPersisted(state), windowsByParent });
    return { windowsByParent };
  }),

  togglePinned: (windowId) => set((state) => {
    const windowsByParent = mutateWindow(state.windowsByParent, windowId, (window) => (
      { ...window, pinned: !window.pinned, updatedAt: new Date() }
    ));
    if (windowsByParent === state.windowsByParent) return {};
    persist(state.projectPath, { ...pickPersisted(state), windowsByParent });
    return { windowsByParent };
  }),

  setPan: (pan) => set((state) => {
    const viewport = { ...state.viewport, pan };
    persist(state.projectPath, { ...pickPersisted(state), viewport });
    return { viewport };
  }),

  setZoom: (zoom) => set((state) => {
    const viewport = { ...state.viewport, zoom: clamp(zoom, ZOOM_MIN, ZOOM_MAX) };
    persist(state.projectPath, { ...pickPersisted(state), viewport });
    return { viewport };
  }),

  autoArrange: (strategy) => set((state) => {
    const windowsByParent = arrangeRects(state.windowsByParent, strategy);
    const viewport = { ...state.viewport, arrangeStrategy: strategy, pan: { x: 0, y: 0 } };
    persist(state.projectPath, { ...pickPersisted(state), windowsByParent, viewport });
    return { windowsByParent, viewport };
  }),

  reset: () => {
    const currentProjectPath = get().projectPath;
    const next = { projectPath: null, ...EMPTY_PERSISTED };
    persist(currentProjectPath, EMPTY_PERSISTED);
    set(next);
  },

  resetInMemory: () => set({
    projectPath: null,
    activeParentSessionId: null,
    windowsByParent: {},
    selectedWindowByParent: {},
    telemetryCollapsedByParent: {},
    viewport: DEFAULT_VIEWPORT,
  }),
}));

export type AgentGridWorkspaceSnapshot = {
  version: 2;
  byProject: Record<string, ReturnType<typeof serializePersistedGrid>>;
};

function serializePersistedGrid(state: PersistedAgentWindowState) {
  return {
    activeParentSessionId: state.activeParentSessionId,
    selectedWindowByParent: state.selectedWindowByParent,
    telemetryCollapsedByParent: state.telemetryCollapsedByParent,
    viewport: state.viewport,
    windowsByParent: Object.fromEntries(
      Object.entries(state.windowsByParent).map(([parentId, windows]) => [
        parentId,
        windows.map((window) => ({
          ...window,
          createdAt: window.createdAt.toISOString(),
          updatedAt: window.updatedAt.toISOString(),
        })),
      ]),
    ),
  };
}

function importPersistedGrid(raw: ReturnType<typeof serializePersistedGrid>): PersistedAgentWindowState {
  return {
    activeParentSessionId: raw.activeParentSessionId ?? null,
    selectedWindowByParent: raw.selectedWindowByParent ?? {},
    telemetryCollapsedByParent: raw.telemetryCollapsedByParent ?? {},
    viewport: reviveViewport(raw.viewport),
    windowsByParent: Object.fromEntries(
      Object.entries(raw.windowsByParent ?? {}).map(([parentId, windows]) => [
        parentId,
        windows.map((window) => reviveWindow(window as SerializedAgentWindow)),
      ]),
    ),
  };
}

/** Export per-root agent canvas layout for .atls-workspace v2. */
export function exportAgentGridSnapshot(projectPaths: string[]): AgentGridWorkspaceSnapshot {
  const byProject: AgentGridWorkspaceSnapshot['byProject'] = {};
  for (const projectPath of projectPaths) {
    byProject[projectPath] = serializePersistedGrid(loadPersisted(projectPath));
  }
  return { version: 2, byProject };
}

/** Restore agent canvas layout from workspace file into localStorage + in-memory store. */
export function importAgentGridSnapshot(snapshot: AgentGridWorkspaceSnapshot | null | undefined): void {
  if (!snapshot?.byProject) return;
  for (const [projectPath, raw] of Object.entries(snapshot.byProject)) {
    persist(projectPath, importPersistedGrid(raw));
  }
  const currentProjectPath = useAgentWindowStore.getState().projectPath;
  if (currentProjectPath && snapshot.byProject[currentProjectPath]) {
    const loaded = loadPersisted(currentProjectPath);
    useAgentWindowStore.setState({
      projectPath: currentProjectPath,
      ...loaded,
    });
  }
}
