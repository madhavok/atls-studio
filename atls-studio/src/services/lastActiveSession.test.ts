import { describe, it, expect, beforeEach, vi } from 'vitest';

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

  it('returns null for empty project path and ignores invalid stored JSON', () => {
    expect(readLastActiveSessionId('')).toBeNull();
    localStorage.setItem('atls:last-active-session-by-project-v1', 'not-json');
    expect(readLastActiveSessionId(project)).toBeNull();
  });

  it('treats array JSON as empty map', () => {
    localStorage.setItem('atls:last-active-session-by-project-v1', '[]');
    expect(readLastActiveSessionId(project)).toBeNull();
  });

  it('ignores writeLastActiveSessionId when project path is empty', () => {
    writeLastActiveSessionId('', 'x');
    expect(localStorage.getItem('atls:last-active-session-by-project-v1')).toBeNull();
  });

  it('swallows localStorage write errors', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    writeLastActiveSessionId(project, 's');
    spy.mockRestore();
  });

  it('swallows errors from syncCurrentSessionIdToLocalStorage', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    syncCurrentSessionIdToLocalStorage('z');
    spy.mockRestore();
  });

  it('treats missing localStorage as no-op for reads and writes', () => {
    const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
      Object.defineProperty(globalThis, 'localStorage', {
        value: undefined,
        configurable: true,
        writable: true,
        enumerable: true,
      });
      expect(readLastActiveSessionId('X:/p')).toBeNull();
      writeLastActiveSessionId('X:/p', 'z');
    } finally {
      if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    }
  });

  it('swallows removeItem errors from syncCurrentSessionIdToLocalStorage', () => {
    const rm = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('nope');
    });
    syncCurrentSessionIdToLocalStorage(null);
    rm.mockRestore();
  });
});
