import { create } from 'zustand';

export type CockpitDensity = 'compact' | 'comfortable';
export type CockpitWindowKind = 'mission' | 'agents' | 'workbench' | 'context' | 'telemetry' | 'terminal';

export interface CockpitWindowState {
  id: string;
  kind: CockpitWindowKind;
  title: string;
  pinned: boolean;
  minimized: boolean;
}

interface PersistedCockpitState {
  density: CockpitDensity;
  focusMode: boolean;
  selectedTaskId: string | null;
  focusedWindowId: string;
  windows: CockpitWindowState[];
}

interface OrchestrationUiState extends PersistedCockpitState {
  selectTask: (taskId: string | null) => void;
  focusWindow: (windowId: string) => void;
  togglePinned: (windowId: string) => void;
  toggleMinimized: (windowId: string) => void;
  setDensity: (density: CockpitDensity) => void;
  setFocusMode: (enabled: boolean) => void;
  resetLayout: () => void;
}

const STORAGE_KEY = 'atls-orchestration-cockpit-ui-v1';

const DEFAULT_WINDOWS: CockpitWindowState[] = [
  { id: 'mission', kind: 'mission', title: 'Mission Control', pinned: true, minimized: false },
  { id: 'agents', kind: 'agents', title: 'Agent Windows', pinned: true, minimized: false },
  { id: 'workbench', kind: 'workbench', title: 'Workbench', pinned: false, minimized: false },
  { id: 'context', kind: 'context', title: 'Runtime Context', pinned: false, minimized: false },
  { id: 'telemetry', kind: 'telemetry', title: 'Telemetry', pinned: false, minimized: false },
  { id: 'terminal', kind: 'terminal', title: 'Agent Terminal', pinned: false, minimized: false },
];

const DEFAULT_STATE: PersistedCockpitState = {
  density: 'compact',
  focusMode: false,
  selectedTaskId: null,
  focusedWindowId: 'mission',
  windows: DEFAULT_WINDOWS,
};

function readStoredState(): PersistedCockpitState {
  if (typeof localStorage === 'undefined') return DEFAULT_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<PersistedCockpitState>;
    const known = new Map(DEFAULT_WINDOWS.map((w) => [w.id, w]));
    const restored = Array.isArray(parsed.windows)
      ? parsed.windows
        .filter((w): w is CockpitWindowState => Boolean(w?.id && known.has(w.id)))
        .map((w) => ({ ...known.get(w.id)!, ...w }))
      : [];
    for (const fallback of DEFAULT_WINDOWS) {
      if (!restored.some((w) => w.id === fallback.id)) restored.push(fallback);
    }
    return {
      density: parsed.density === 'comfortable' ? 'comfortable' : 'compact',
      focusMode: Boolean(parsed.focusMode),
      selectedTaskId: typeof parsed.selectedTaskId === 'string' ? parsed.selectedTaskId : null,
      focusedWindowId: typeof parsed.focusedWindowId === 'string' ? parsed.focusedWindowId : 'mission',
      windows: restored,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function persistState(state: PersistedCockpitState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Layout persistence is best effort; runtime state stays in the core stores.
  }
}

function patchPersisted(patch: Partial<PersistedCockpitState>): void {
  const current = useOrchestrationUiStore.getState();
  persistState({
    density: patch.density ?? current.density,
    focusMode: patch.focusMode ?? current.focusMode,
    selectedTaskId: patch.selectedTaskId ?? current.selectedTaskId,
    focusedWindowId: patch.focusedWindowId ?? current.focusedWindowId,
    windows: patch.windows ?? current.windows,
  });
}

export const useOrchestrationUiStore = create<OrchestrationUiState>((set) => ({
  ...readStoredState(),

  selectTask: (taskId) => {
    set({ selectedTaskId: taskId });
    patchPersisted({ selectedTaskId: taskId });
  },

  focusWindow: (windowId) => {
    set({ focusedWindowId: windowId });
    patchPersisted({ focusedWindowId: windowId });
  },

  togglePinned: (windowId) => {
    set((state) => {
      const windows = state.windows.map((w) => (
        w.id === windowId ? { ...w, pinned: !w.pinned } : w
      ));
      patchPersisted({ windows });
      return { windows };
    });
  },

  toggleMinimized: (windowId) => {
    set((state) => {
      const windows = state.windows.map((w) => (
        w.id === windowId ? { ...w, minimized: !w.minimized } : w
      ));
      patchPersisted({ windows });
      return { windows };
    });
  },

  setDensity: (density) => {
    set({ density });
    patchPersisted({ density });
  },

  setFocusMode: (focusMode) => {
    set({ focusMode });
    patchPersisted({ focusMode });
  },

  resetLayout: () => {
    const reset = { ...DEFAULT_STATE, windows: DEFAULT_WINDOWS.map((w) => ({ ...w })) };
    set(reset);
    persistState(reset);
  },
}));
