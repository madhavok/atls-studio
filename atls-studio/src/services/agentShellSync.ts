import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../stores/appStore';
import { chatDb } from './chatDb';
import { normPath } from '../hooks/useAtlsPaths';

/** Register a project root and focus the shell without atls_init (preserves multi-root workspace). */
export async function syncShellToProjectPath(projectPath: string | null | undefined): Promise<void> {
  const target = projectPath?.trim();
  if (!target) return;

  const app = useAppStore.getState();
  const normalized = normPath(target);
  const currentActive = app.activeRoot ? normPath(app.activeRoot) : null;
  if (currentActive === normalized) {
    if (!chatDb.isInitialized() || chatDb.getProjectPath() !== target) {
      await chatDb.init(target).catch(() => undefined);
    }
    return;
  }

  const roots = app.rootFolders.map(normPath);
  if (!roots.includes(normalized)) {
    try {
      await invoke('atls_add_root', { rootPath: target });
    } catch (error) {
      console.warn('[agentShellSync] atls_add_root failed:', error);
    }
    app.addRootFolder(target);
  }

  app.setActiveRoot(target);
  try {
    await invoke('atls_set_active_root', { rootPath: target });
  } catch (error) {
    console.warn('[agentShellSync] atls_set_active_root failed:', error);
  }
  await chatDb.init(target).catch(() => undefined);
}
