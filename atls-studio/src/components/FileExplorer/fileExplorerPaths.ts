import type { WorkspaceEntry } from '../../stores/appStore';

/** Root folder that contains `menuPath` (multi-root workspaces). */
export function resolveRootFolderForMenuPath(
  menuPath: string,
  projectPath: string,
  rootFolders: string[],
): string {
  const path = menuPath.replace(/\\/g, '/');
  for (const r of rootFolders) {
    const root = r.replace(/\\/g, '/');
    if (path.startsWith(`${root}/`) || path === root) return r;
  }
  return projectPath || rootFolders[0] || '';
}

/** Paths targeted by the context menu: full selection if the menu node is part of a multi-select, else the clicked path. */
export function effectiveContextMenuPaths(menuPath: string, selectedPaths: Set<string>): string[] {
  if (selectedPaths.has(menuPath) && selectedPaths.size > 1) {
    return Array.from(selectedPaths);
  }
  return [menuPath];
}

/** One line per path, relative to project root (strip leading separators). */
export function pathsToRelativeClipboardText(paths: string[], projectPath: string): string {
  return paths.map((p) => p.replace(projectPath, '').replace(/^[/\\]/, '')).join('\n');
}

/** Parent directory path for inline rename UI. */
export function parentPathForRename(fullPath: string): string {
  const lastSep = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
  if (lastSep > 0) return fullPath.substring(0, lastSep);
  return fullPath.substring(0, lastSep === 0 ? 1 : 0) || '.';
}

/** Resolved absolute path for a workspace entry (profile abs_path or joined under project root). */
export function workspaceEntryAbsPath(ws: WorkspaceEntry, projectRoot: string | undefined): string {
  if (ws.abs_path) return ws.abs_path;
  const rel = ws.path === '.' ? '' : ws.path.replace(/\//g, projectRoot?.includes('\\') ? '\\' : '/');
  if (!projectRoot) return '';
  const trimmedRoot = projectRoot.replace(/\/$|\\$/, '');
  const sep = projectRoot.includes('\\') ? '\\' : '/';
  return rel ? `${trimmedRoot}${sep}${rel}` : trimmedRoot;
}
