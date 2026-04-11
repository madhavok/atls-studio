import type { FileNode } from '../../stores/appStore';

/** Filter tree by filename substring (case-insensitive). Matching parents keep only matching descendant branches. */
export function filterFileNodesByQuery(nodes: FileNode[], query: string): FileNode[] {
  if (!query) return nodes;
  const q = query.toLowerCase();
  return nodes.reduce<FileNode[]>((acc, node) => {
    if (node.name.toLowerCase().includes(q)) {
      acc.push(node);
    } else if (node.children) {
      const filtered = filterFileNodesByQuery(node.children, query);
      if (filtered.length > 0) {
        acc.push({ ...node, children: filtered, expanded: true });
      }
    }
    return acc;
  }, []);
}

/** Flatten visible tree nodes into an ordered path list (for Shift+range select). */
export function flattenVisiblePaths(nodes: FileNode[], expandedFolders: Set<string>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    paths.push(node.path);
    if (node.type === 'directory' && expandedFolders.has(node.path) && node.children) {
      paths.push(...flattenVisiblePaths(node.children, expandedFolders));
    }
  }
  return paths;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);

export function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext);
}
