import { vi, type Mock } from 'vitest';

/** Ref used by `createTauriEventListenMock` to capture the last `listen` callback. */
export function createTauriEventListenRef() {
  return { menuCb: null as null | ((e: { payload: string }) => void) };
}

/**
 * Mocks `@tauri-apps/api/event` `listen` so tests can call `ref.menuCb?.({ payload: 'x' })`.
 * Reuse the pattern from `App.dom.test.tsx`.
 */
export function createTauriEventListenMock(
  ref: ReturnType<typeof createTauriEventListenRef> = createTauriEventListenRef()
) {
  return {
    ref,
    listen: vi.fn((_e: string, cb: (e: { payload: string }) => void) => {
      ref.menuCb = cb;
      return Promise.resolve(vi.fn());
    }) as Mock,
  };
}

/**
 * `invoke` that resolves to a default or per-command result (synchronous mock shape).
 */
export function createTauriCoreInvokeMock(
  map: Record<string, unknown> = {}
): (cmd: string, _args?: unknown) => Promise<unknown> {
  return (cmd) => {
    if (Object.prototype.hasOwnProperty.call(map, cmd)) {
      return Promise.resolve(map[cmd]);
    }
    return Promise.resolve(undefined);
  };
}
