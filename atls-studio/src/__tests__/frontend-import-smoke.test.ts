import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
  }),
}));

vi.mock('react-dom/client', () => ({
  default: {
    createRoot: () => ({
      render: vi.fn(),
    }),
  },
  createRoot: () => ({
    render: vi.fn(),
  }),
}));

describe('frontend import smoke', () => {
  beforeAll(() => {
    if (!('localStorage' in globalThis)) {
      const storage = new Map<string, string>();
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => void storage.set(key, value),
          removeItem: (key: string) => void storage.delete(key),
        },
        configurable: true,
      });
    }

    if (!('document' in globalThis)) {
      Object.defineProperty(globalThis, 'document', {
        value: {
          getElementById: () => ({}),
        },
        configurable: true,
      });
    }
  });

  it('loads hashProtocol named exports used by contextStore', async () => {
    const hashProtocol = await import('../services/hashProtocol');

    expect(hashProtocol.setPinned).toBeTypeOf('function');
    expect(hashProtocol.getActiveRefs).toBeTypeOf('function');
  });

  it('loads contextStore and app entry dependencies without export errors', async () => {
    const [{ useContextStore }, mainModule] = await Promise.all([
      import('../stores/contextStore'),
      import('../main'),
    ]);

    expect(useContextStore).toBeTypeOf('function');
    expect(mainModule).toBeDefined();
  }, 15000);
});
