/**
 * useProjectChatGroups
 *
 * Aggregates conversations across recent projects for the left-panel orchestrator.
 *
 * Token/perf (ATLS pillars): the active project's chats come from the live
 * `chatSessions` store (no DB round-trip). Other projects are fetched lazily and
 * only when their header is expanded, capped at 30 rows each, and cached. Each
 * non-active read is scoped via `chatDb.withProjectScope` and the active project's
 * scope is restored afterward so writes never target the wrong DB.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { chatDb } from '../services/chatDb';

export interface ProjectChatSummary {
  id: string;
  title: string;
  updatedAt?: string | Date;
}

export interface ProjectChatGroup {
  projectPath: string;
  name: string;
  isActive: boolean;
  sessions: ProjectChatSummary[];
  loading: boolean;
  loaded: boolean;
}

interface GroupCacheEntry {
  sessions: ProjectChatSummary[];
  loading: boolean;
  loaded: boolean;
}

const SESSION_FETCH_LIMIT = 30;

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** Fetch a non-active project's sessions, then restore the active project scope. */
async function fetchScopedSessions(projectPath: string): Promise<ProjectChatSummary[]> {
  try {
    const rows = await chatDb.withProjectScope(projectPath, () => chatDb.getSessions(SESSION_FETCH_LIMIT));
    return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }));
  } finally {
    const activePath = useAppStore.getState().projectPath;
    if (activePath && activePath !== projectPath && chatDb.getProjectPath() !== activePath) {
      await chatDb.withProjectScope(activePath, async () => undefined);
    }
  }
}

export function useProjectChatGroups() {
  const projectPath = useAppStore((s) => s.projectPath);
  const projectHistory = useAppStore((s) => s.projectHistory);
  const chatSessions = useAppStore((s) => s.chatSessions);

  // Cache of fetched non-active project sessions, keyed by project path.
  const [cache, setCache] = useState<Record<string, GroupCacheEntry>>({});
  // Ref mirror of the cache so ensureLoaded can stay referentially stable.
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  // Stable ordered list of projects: active project first, then recent history (deduped).
  const projects = useMemo(() => {
    const ordered: Array<{ path: string; name: string }> = [];
    const seen = new Set<string>();
    if (projectPath && !seen.has(projectPath)) {
      const fromHistory = projectHistory.find((p) => p.path === projectPath);
      ordered.push({ path: projectPath, name: fromHistory?.name ?? basename(projectPath) });
      seen.add(projectPath);
    }
    for (const entry of projectHistory) {
      if (seen.has(entry.path)) continue;
      ordered.push({ path: entry.path, name: entry.name || basename(entry.path) });
      seen.add(entry.path);
    }
    return ordered;
  }, [projectPath, projectHistory]);

  const refreshProject = useCallback(async (path: string) => {
    // The active project is sourced live from chatSessions; no DB fetch needed.
    if (useAppStore.getState().projectPath === path) return;
    setCache((prev) => ({
      ...prev,
      [path]: { sessions: prev[path]?.sessions ?? [], loading: true, loaded: prev[path]?.loaded ?? false },
    }));
    try {
      const sessions = await fetchScopedSessions(path);
      setCache((prev) => ({ ...prev, [path]: { sessions, loading: false, loaded: true } }));
    } catch {
      setCache((prev) => ({
        ...prev,
        [path]: { sessions: prev[path]?.sessions ?? [], loading: false, loaded: true },
      }));
    }
  }, []);

  const ensureLoaded = useCallback((path: string) => {
    if (useAppStore.getState().projectPath === path) return;
    const existing = cacheRef.current[path];
    if (existing && (existing.loaded || existing.loading)) return;
    void refreshProject(path);
  }, [refreshProject]);

  // Drop cache entries for projects no longer present (bounded memory).
  useEffect(() => {
    const validPaths = new Set(projects.map((p) => p.path));
    setCache((prev) => {
      const next: Record<string, GroupCacheEntry> = {};
      let changed = false;
      for (const [path, entry] of Object.entries(prev)) {
        if (validPaths.has(path)) next[path] = entry;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [projects]);

  const activeSessions = useMemo<ProjectChatSummary[]>(
    () => chatSessions.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })),
    [chatSessions],
  );

  const groups = useMemo<ProjectChatGroup[]>(() => {
    return projects.map((project) => {
      const isActive = project.path === projectPath;
      if (isActive) {
        return {
          projectPath: project.path,
          name: project.name,
          isActive: true,
          sessions: activeSessions,
          loading: false,
          loaded: true,
        };
      }
      const entry = cache[project.path];
      return {
        projectPath: project.path,
        name: project.name,
        isActive: false,
        sessions: entry?.sessions ?? [],
        loading: entry?.loading ?? false,
        loaded: entry?.loaded ?? false,
      };
    });
  }, [projects, projectPath, activeSessions, cache]);

  return { groups, ensureLoaded, refreshProject };
}

export default useProjectChatGroups;
