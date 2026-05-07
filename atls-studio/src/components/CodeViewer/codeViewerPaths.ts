/** Normalize path for consistent editor buffer keys. */
export function normalizeEditorPath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Build a stable Monaco model URI from an app file path. Monaco's TypeScript
 * worker resolves relative imports from the model URI, so anonymous in-memory
 * models make valid project-relative imports appear broken.
 */
export function toEditorModelPath(path: string): string {
  const normalized = normalizeEditorPath(path);
  if (!normalized) return normalized;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(normalized)) return normalized;
  return `file:///${normalized.replace(/^\/+/, '')}`;
}
