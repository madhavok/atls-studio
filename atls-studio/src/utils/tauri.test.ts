import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTauri, safeListen } from './tauri';

const listenMock = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: unknown) => listenMock(event, handler),
}));

describe('tauri helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    listenMock.mockReset();
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

  it('safeListen subscribes via listen when inside Tauri', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const unlisten = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten);
    const cb = vi.fn();
    const u = await safeListen('my-event', cb);
    expect(listenMock).toHaveBeenCalledWith('my-event', cb);
    u();
    expect(unlisten).toHaveBeenCalled();
  });

  it('safeListen returns noop when listen throws', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listenMock.mockRejectedValueOnce(new Error('nope'));
    const u = await safeListen('bad', () => {});
    expect(warn).toHaveBeenCalled();
    u();
    warn.mockRestore();
  });
});
