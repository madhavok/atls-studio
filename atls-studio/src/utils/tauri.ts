import { listen, type UnlistenFn, type EventCallback } from '@tauri-apps/api/event';

/** True when running inside a Tauri webview (vs. a plain browser). */
export function isTauri(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined';
}

/**
 * Wrapper around Tauri `listen` that no-ops gracefully outside the Tauri
 * runtime. Returns a cleanup function that is always safe to call.
 */
export async function safeListen<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  try {
    return await listen<T>(event, handler);
  } catch (e) {
    console.warn(`[safeListen] Failed to subscribe to "${event}":`, e);
    return () => {};
  }
}
