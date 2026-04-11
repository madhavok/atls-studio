export const ZOOM_LEVELS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5];
export const DEFAULT_ZOOM_INDEX = 2;
export const ZOOM_STORAGE_KEY = 'atls-studio-zoom';

export function loadZoomIndex(): number {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(ZOOM_STORAGE_KEY) : null;
    if (saved !== null) {
      const idx = parseInt(saved, 10);
      if (idx >= 0 && idx < ZOOM_LEVELS.length) return idx;
    }
  } catch (_e) { /* ignore */ }
  return DEFAULT_ZOOM_INDEX;
}

export function saveZoomIndex(index: number): void {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(index));
  } catch (_e) { /* ignore */ }
}
