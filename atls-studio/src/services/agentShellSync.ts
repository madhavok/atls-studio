import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/appStore';
import { chatDb } from './chatDb';
import { normPath } from '../hooks/useAtlsPaths';

export interface SyncShellOptions {
  /**
   * Whether to flip the global ATLS active root to this project. Foreground
   * (selected) windows set it; background windows running concurrently against a
   * different repo pass `false` so they don't clobber the active root for others.
   * The project root is still registered and its chat DB initialized either way.
   */
  setActive?: boolean;
}

/** Register a project root and (optionally) focus it, preserving the multi-root workspace. */
export async function syncShellToProjectPath(
  projectPath: string | null | undefined,
  options: SyncShellOptions = {},
): Promise<void> {
  const { setActive = true } = options;
  const target = projectPath?.trim();
  if (!target) return;

  const app = useAppStore.getState();
  const normalized = normPath(target);
  const currentActive = app.activeRoot ? normPath(app.activeRoot) : null;

  // Always ensure the root is registered with the indexer + multi-root workspace.
  const roots = app.rootFolders.map(normPath);
  if (!roots.includes(normalized)) {
    try {
      await invoke('atls_add_root', { rootPath: target });
    } catch (error) {
      console.warn('[agentShellSync] atls_add_root failed:', error);
    }
    app.addRootFolder(target);
  }

  // Always ensure this project's chat DB connection is open (pooled per repo).
  if (!chatDb.isInitialized() || chatDb.getProjectPath() !== target) {
    await chatDb.init(target).catch(() => undefined);
  }

  // Only flip the global active root for the foreground window.
  if (!setActive || currentActive === normalized) return;
  app.setActiveRoot(target);
  try {
    await invoke('atls_set_active_root', { rootPath: target });
  } catch (error) {
    console.warn('[agentShellSync] atls_set_active_root failed:', error);
  }
}
