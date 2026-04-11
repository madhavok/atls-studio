import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTauri, safeListen } from './tauri';

describe('tauri helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isTauri is false when window is undefined', () => {
    expect(isTauri()).toBe(false);
  });

  it('safeListen returns sync noop outside Tauri', async () => {
    const u = await safeListen('evt', () => {});
    expect(typeof u).toBe('function');
    u();
  });

  it('isTauri true when TAURI internals present', () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    expect(isTauri()).toBe(true);
  });
});
