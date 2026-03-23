import { describe, it, expect, beforeEach } from 'vitest';

function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
}

Object.defineProperty(globalThis, 'localStorage', {
  value: createLocalStorageMock(),
  configurable: true,
});

const {
  readLastActiveSessionId,
  writeLastActiveSessionId,
  syncCurrentSessionIdToLocalStorage,
} = await import('./lastActiveSession');

describe('lastActiveSession', () => {
  const project = 'F:/proj/foo';

  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips last session id per project', () => {
    expect(readLastActiveSessionId(project)).toBeNull();
    writeLastActiveSessionId(project, 'sess-1');
    expect(readLastActiveSessionId(project)).toBe('sess-1');
    writeLastActiveSessionId(project, null);
    expect(readLastActiveSessionId(project)).toBeNull();
  });

  it('syncs current_session_id for batch tooling', () => {
    syncCurrentSessionIdToLocalStorage('abc');
    expect(localStorage.getItem('current_session_id')).toBe('abc');
    syncCurrentSessionIdToLocalStorage(null);
    expect(localStorage.getItem('current_session_id')).toBeNull();
  });
});
