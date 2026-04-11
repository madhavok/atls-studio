/** Normalize path for consistent editor buffer keys. */
export function normalizeEditorPath(path: string): string {
  return path.replace(/\\/g, '/');
}
