/**
 * Project-aware chat actions for the left-panel orchestrator.
 *
 * Chats live in per-project SQLite (`<repo>/.atls/chat.db`) selected by a single
 * Rust `active_path` pointer. These helpers centralize the open/create/delete flows
 * so the sidebar component stays thin, and so cross-project operations always:
 *   1. route reads/writes for non-active projects through `chatDb.withProjectScope`
 *      (serialized via the chatDb op queue), and
 *   2. restore the genuinely-active project scope afterward.
 *
 * Hook-backed dependencies (`openProject`, `createNewSession`, `deleteSession`) are
 * injected so this module stays pure/testable and respects React hook rules.
 */

import { chatDb } from './chatDb';
import { useAppStore } from '../stores/appStore';
import { activateAgentParentSession } from './activateAgentWindow';

const DEFAULT_NEW_CHAT_TITLE = 'New Chat';
const SCOPE_WAIT_TIMEOUT_MS = 5000;
const SCOPE_POLL_INTERVAL_MS = 40;

export interface ProjectChatActionDeps {
  /** Switches the active project (from useAtls). Drives chatDb re-scope via useChatPersistence. */
  openProject: (path: string) => Promise<void>;
  /** Canonical new-session creator for the active project (from useChatPersistence). */
  createNewSession: () => Promise<string | null>;
  /** Canonical session deleter for the active project (from useChatPersistence). */
  deleteSession: (sessionId: string) => Promise<void>;
}

function isActiveProject(projectPath: string): boolean {
  return (
    useAppStore.getState().projectPath === projectPath &&
    chatDb.getProjectPath() === projectPath
  );
}

/** Resolve once chatDb's active pointer matches `target`, or false on timeout. */
async function waitForProjectScope(target: string, timeoutMs = SCOPE_WAIT_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now();
  while (chatDb.getProjectPath() !== target) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, SCOPE_POLL_INTERVAL_MS));
  }
  return true;
}

/**
 * Make `target` the active project and ensure chatDb is scoped to it.
 * Returns true when chatDb is confirmed scoped to `target`.
 */
async function ensureProjectActive(target: string, deps: ProjectChatActionDeps): Promise<boolean> {
  if (useAppStore.getState().projectPath !== target) {
    await deps.openProject(target);
    return waitForProjectScope(target);
  }
  if (chatDb.getProjectPath() !== target) {
    await chatDb.withProjectScope(target, async () => undefined);
  }
  return chatDb.getProjectPath() === target;
}

/**
 * Open (activate) an existing conversation, switching the active project first if needed.
 */
export async function openChatInProject(
  projectPath: string,
  sessionId: string,
  title: string,
  deps: ProjectChatActionDeps,
): Promise<boolean> {
  const ready = await ensureProjectActive(projectPath, deps);
  if (!ready) return false;
  await activateAgentParentSession(sessionId, title || DEFAULT_NEW_CHAT_TITLE, projectPath);
  return true;
}

/**
 * Spawn a new conversation under a project header and activate it.
 *
 * Same-project: uses the canonical `createNewSession` (full context/cost resets).
 * Cross-project: creates the row in the target DB first so the project-switch session
 * reload includes it, then switches + activates.
 */
export async function createChatInProject(
  projectPath: string,
  deps: ProjectChatActionDeps,
): Promise<string | null> {
  if (isActiveProject(projectPath)) {
    const sessionId = await deps.createNewSession();
    if (sessionId) {
      await activateAgentParentSession(sessionId, DEFAULT_NEW_CHAT_TITLE, projectPath);
    }
    return sessionId;
  }

  const sessionId = await chatDb.withProjectScope(projectPath, () =>
    chatDb.createSession('agent', DEFAULT_NEW_CHAT_TITLE),
  );
  const ready = await ensureProjectActive(projectPath, deps);
  if (!ready) return null;
  await activateAgentParentSession(sessionId, DEFAULT_NEW_CHAT_TITLE, projectPath);
  return sessionId;
}

/**
 * Delete a conversation. For the active project this runs the canonical deleter
 * (which also clears live chat state when deleting the current session). For other
 * projects it scopes the delete to that DB and restores the active scope afterward.
 */
export async function deleteChatInProject(
  projectPath: string,
  sessionId: string,
  deps: ProjectChatActionDeps,
): Promise<void> {
  if (isActiveProject(projectPath)) {
    await deps.deleteSession(sessionId);
    return;
  }

  await chatDb.withProjectScope(projectPath, () => chatDb.deleteSession(sessionId));

  const activePath = useAppStore.getState().projectPath;
  if (activePath && activePath !== projectPath) {
    await chatDb.withProjectScope(activePath, async () => undefined);
  }
}
