import { getRef } from './hashProtocol';

// Round-refresh hook — invoked by advanceTurn before returning. Keeps hashProtocol decoupled from Zustand/UI.
let _roundRefreshHook: (() => void | Promise<void>) | null = null;

export function setRoundRefreshHook(fn: (() => void | Promise<void>) | null): void {
  _roundRefreshHook = fn;
}

export function getRoundRefreshHook(): (() => void | Promise<void>) | null {
  return _roundRefreshHook;
}

export function setPinned(hash: string, pinned: boolean, shape?: string): void {
  const ref = getRef(hash);
  if (ref) {
    ref.pinned = pinned;
    ref.pinnedShape = shape || undefined;
  }
}