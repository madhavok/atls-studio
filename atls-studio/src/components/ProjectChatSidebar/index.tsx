/**
 * ProjectChatSidebar
 *
 * Chat-first left panel for the agent canvas orchestrator. Renders recent projects
 * as collapsible headers, each listing that project's conversations. A "+" on each
 * header spawns a new chat in that project; each row can be opened or deleted.
 *
 * Project-scoped DB access and project switching are delegated to projectChatActions
 * so this component stays presentation-focused.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useAgentWindowStore } from '../../stores/agentWindowStore';
import { useAtls } from '../../hooks/useAtls';
import { useChatPersistence } from '../../hooks/useChatPersistence';
import { useProjectChatGroups, type ProjectChatSummary } from '../../hooks/useProjectChatGroups';
import {
  createChatInProject,
  deleteChatInProject,
  openChatInProject,
  type ProjectChatActionDeps,
} from '../../services/projectChatActions';

function formatUpdatedAt(updatedAt?: string | Date): string | null {
  if (!updatedAt) return null;
  const date = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString();
}

interface ChatRowProps {
  projectPath: string;
  session: ProjectChatSummary;
  active: boolean;
  pendingDelete: boolean;
  onOpen: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

const ChatRow = memo(function ChatRow({
  session,
  active,
  pendingDelete,
  onOpen,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: ChatRowProps) {
  const updated = formatUpdatedAt(session.updatedAt);
  return (
    <div
      className={`group flex items-center gap-1 rounded px-2 py-1 text-xs ${
        active ? 'bg-studio-accent/15 text-studio-title' : 'text-studio-text hover:bg-studio-surface'
      }`}
      data-testid="chat-row"
    >
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left"
        title={session.title}
      >
        <span className="block truncate">{session.title || 'Untitled chat'}</span>
        {updated && <span className="block truncate text-[10px] text-studio-muted">{updated}</span>}
      </button>
      {pendingDelete ? (
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={onConfirmDelete}
            className="rounded px-1 text-[10px] uppercase tracking-wide text-red-400 hover:text-red-300"
            aria-label={`Confirm delete ${session.title}`}
          >
            Delete
          </button>
          <button
            type="button"
            onClick={onCancelDelete}
            className="rounded px-1 text-[10px] uppercase tracking-wide text-studio-muted hover:text-studio-text"
            aria-label="Cancel delete"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={onRequestDelete}
          className="shrink-0 rounded p-0.5 text-studio-muted opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
          aria-label={`Delete ${session.title}`}
          title="Delete conversation"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </button>
      )}
    </div>
  );
});

export const ProjectChatSidebar = memo(function ProjectChatSidebar() {
  const projectPath = useAppStore((s) => s.projectPath);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const activeParentSessionId = useAgentWindowStore((s) => s.activeParentSessionId);
  const toggleLeftCollapsed = useAppStore((s) => s.toggleExplorerCollapsed);

  const { openProject, newProject, openProjectWithPicker } = useAtls();
  const { createNewSession, deleteSession } = useChatPersistence();
  const { groups, ensureLoaded, refreshProject } = useProjectChatGroups();

  // Non-active projects are collapsed by default to avoid N DB scopes on mount;
  // the active project is always expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<{ projectPath: string; sessionId: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const deps = useMemo<ProjectChatActionDeps>(
    () => ({ openProject, createNewSession, deleteSession }),
    [openProject, createNewSession, deleteSession],
  );

  const activeSessionId = activeParentSessionId ?? currentSessionId;

  // The active project is always expanded; other projects expand on demand.
  const isExpanded = useCallback(
    (path: string) => path === projectPath || expanded.has(path),
    [expanded, projectPath],
  );

  const toggleGroup = useCallback(
    (path: string) => {
      if (path === projectPath) return; // active group stays expanded
      const willExpand = !expanded.has(path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      if (willExpand) ensureLoaded(path);
    },
    [expanded, projectPath, ensureLoaded],
  );

  // Lazily load any non-active group that is currently expanded.
  useEffect(() => {
    for (const group of groups) {
      if (!group.isActive && expanded.has(group.projectPath) && !group.loaded && !group.loading) {
        ensureLoaded(group.projectPath);
      }
    }
  }, [groups, expanded, ensureLoaded]);

  const handleNewChat = useCallback(
    async (path: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await createChatInProject(path, deps);
        await refreshProject(path);
      } finally {
        setBusy(false);
      }
    },
    [busy, deps, refreshProject],
  );

  const handleOpenChat = useCallback(
    async (path: string, session: ProjectChatSummary) => {
      if (busy) return;
      setBusy(true);
      try {
        await openChatInProject(path, session.id, session.title, deps);
      } finally {
        setBusy(false);
      }
    },
    [busy, deps],
  );

  const handleConfirmDelete = useCallback(
    async (path: string, sessionId: string) => {
      setPendingDelete(null);
      if (busy) return;
      setBusy(true);
      try {
        await deleteChatInProject(path, sessionId, deps);
        await refreshProject(path);
      } finally {
        setBusy(false);
      }
    },
    [busy, deps, refreshProject],
  );

  if (groups.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <SidebarHeader onCollapse={toggleLeftCollapsed} />
        <div className="p-4 text-sm text-studio-muted">
          <p className="mb-3">No projects yet. Open a project to start chatting.</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void newProject()}
              className="rounded border border-studio-border px-2 py-1 text-xs text-studio-text hover:border-studio-accent"
            >
              New Project
            </button>
            <button
              type="button"
              onClick={() => void openProjectWithPicker()}
              className="rounded border border-studio-border px-2 py-1 text-xs text-studio-text hover:border-studio-accent"
            >
              Open Project
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="project-chat-sidebar">
      <SidebarHeader onCollapse={toggleLeftCollapsed} />
      <div className="flex-1 overflow-y-auto scrollbar-thin py-1">
        {groups.map((group) => {
          const groupExpanded = isExpanded(group.projectPath);
          return (
            <div key={group.projectPath} className="mb-1" data-testid="project-group">
              <div className="flex items-center gap-1 px-2 py-1">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.projectPath)}
                  className="flex min-w-0 flex-1 items-center gap-1 text-left"
                  aria-expanded={groupExpanded}
                  title={group.projectPath}
                >
                  <svg
                    className={`h-3 w-3 shrink-0 text-studio-muted transition-transform ${groupExpanded ? 'rotate-90' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span
                    className={`truncate text-xs font-semibold uppercase tracking-wide ${
                      group.isActive ? 'text-studio-title' : 'text-studio-muted'
                    }`}
                  >
                    {group.name}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleNewChat(group.projectPath)}
                  disabled={busy}
                  className="shrink-0 rounded p-0.5 text-studio-muted hover:text-studio-text disabled:opacity-40"
                  aria-label={`New chat in ${group.name}`}
                  title="New chat"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </button>
              </div>

              {groupExpanded && (
                <div className="pl-3">
                  {group.loading ? (
                    <div className="px-2 py-1 text-[11px] text-studio-muted">Loading…</div>
                  ) : group.sessions.length === 0 ? (
                    <div className="px-2 py-1 text-[11px] text-studio-muted">No conversations yet.</div>
                  ) : (
                    group.sessions.map((session) => (
                      <ChatRow
                        key={session.id}
                        projectPath={group.projectPath}
                        session={session}
                        active={session.id === activeSessionId && group.isActive}
                        pendingDelete={
                          pendingDelete?.projectPath === group.projectPath &&
                          pendingDelete?.sessionId === session.id
                        }
                        onOpen={() => void handleOpenChat(group.projectPath, session)}
                        onRequestDelete={() =>
                          setPendingDelete({ projectPath: group.projectPath, sessionId: session.id })
                        }
                        onConfirmDelete={() => void handleConfirmDelete(group.projectPath, session.id)}
                        onCancelDelete={() => setPendingDelete(null)}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

interface SidebarHeaderProps {
  onCollapse: () => void;
}

const SidebarHeader = memo(function SidebarHeader({ onCollapse }: SidebarHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b border-studio-border p-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-studio-title">Chats</h2>
      <button
        type="button"
        onClick={onCollapse}
        className="rounded p-1 text-studio-muted transition-colors hover:bg-studio-surface hover:text-studio-text"
        title="Collapse panel"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
    </div>
  );
});

export default ProjectChatSidebar;
