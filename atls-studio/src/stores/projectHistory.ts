import { rehydrateDate } from '../utils/persistenceHelpers';

export interface ProjectHistoryEntry {
  path: string;
  name: string;
  lastOpened: Date;
}

// LocalStorage keys
const PROJECT_HISTORY_KEY = 'atls-project-history';
const PROJECT_HISTORY_SCHEMA_VERSION = 1;
const PROJECT_HISTORY_LIMIT = 5;

type ProjectHistoryCache = {
  raw: string | null | undefined;
  entries: ProjectHistoryEntry[];
};

let projectHistoryCache: ProjectHistoryCache = {
  raw: undefined,
  entries: [],
};

/** Validate a raw object as ProjectHistoryEntry. Returns null if invalid. */
function validateProjectHistoryEntry(raw: unknown): ProjectHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const path = o.path;
  const name = o.name;
  const lastOpened = o.lastOpened;
  if (typeof path !== 'string' || path === '') return null;
  if (typeof name !== 'string') return null;
  return {
    path,
    name,
    lastOpened: rehydrateDate(lastOpened),
  };
}

function cloneProjectHistoryEntry(entry: ProjectHistoryEntry): ProjectHistoryEntry {
  return { ...entry, lastOpened: new Date(entry.lastOpened) };
}

function cloneProjectHistory(entries: ProjectHistoryEntry[]): ProjectHistoryEntry[] {
  return entries.map(cloneProjectHistoryEntry);
}

export function normalizeProjectHistory(history: ProjectHistoryEntry[]): ProjectHistoryEntry[] {
  return [...history]
    .sort((a, b) => b.lastOpened.getTime() - a.lastOpened.getTime())
    .slice(0, PROJECT_HISTORY_LIMIT);
}

// Load project history from localStorage with schema validation and date rehydration
export function loadProjectHistory(): ProjectHistoryEntry[] {
  try {
    const saved = localStorage.getItem(PROJECT_HISTORY_KEY);
    if (!saved) {
      projectHistoryCache = { raw: saved, entries: [] };
      return [];
    }
    if (saved === projectHistoryCache.raw) {
      return cloneProjectHistory(projectHistoryCache.entries);
    }
    const parsed: unknown = JSON.parse(saved);
    let rawEntries: unknown[];
    if (Array.isArray(parsed)) {
      rawEntries = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const schemaVersion = record.schemaVersion;
      if (schemaVersion !== PROJECT_HISTORY_SCHEMA_VERSION) {
        console.warn(`Project history: unsupported schema version ${String(schemaVersion)}`);
        localStorage.removeItem(PROJECT_HISTORY_KEY);
        projectHistoryCache = { raw: null, entries: [] };
        return [];
      }
      if (!Array.isArray(record.entries)) {
        console.warn('Project history: invalid format (expected {schemaVersion, entries})');
        localStorage.removeItem(PROJECT_HISTORY_KEY);
        projectHistoryCache = { raw: null, entries: [] };
        return [];
      }
      rawEntries = record.entries;
    } else {
      console.warn('Project history: invalid format (expected array or {schemaVersion, entries})');
      localStorage.removeItem(PROJECT_HISTORY_KEY);
      projectHistoryCache = { raw: null, entries: [] };
      return [];
    }
    const history: ProjectHistoryEntry[] = [];
    for (const raw of rawEntries) {
      const entry = validateProjectHistoryEntry(raw);
      if (entry) history.push(entry);
    }
    const normalizedHistory = normalizeProjectHistory(history);
    projectHistoryCache = {
      raw: saved,
      entries: cloneProjectHistory(normalizedHistory),
    };
    return cloneProjectHistory(normalizedHistory);
  } catch (e) {
    console.error('Failed to load project history:', e);
  }
  projectHistoryCache = { raw: undefined, entries: [] };
  return [];
}

// Save project history to localStorage with schema version for future migrations
export function saveProjectHistory(history: ProjectHistoryEntry[]) {
  try {
    const normalizedHistory = normalizeProjectHistory(history);
    const payload = {
      schemaVersion: PROJECT_HISTORY_SCHEMA_VERSION,
      entries: normalizedHistory.map((entry) => ({
        path: entry.path,
        name: entry.name,
        lastOpened: entry.lastOpened.toISOString(),
      })),
    };
    const serialized = JSON.stringify(payload);
    if (serialized === projectHistoryCache.raw) return;
    localStorage.setItem(PROJECT_HISTORY_KEY, serialized);
    projectHistoryCache = {
      raw: serialized,
      entries: cloneProjectHistory(normalizedHistory),
    };
  } catch (e) {
    console.error('Failed to save project history:', e);
  }
}
