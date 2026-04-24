/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createRootMock = vi.fn(() => ({ render: vi.fn() }));

vi.mock('./App', () => ({ default: () => null }));
vi.mock('./index.css', () => ({}));
vi.mock('./utils/toolResultCompression', () => ({}));
vi.mock('react-dom/client', () => ({
  default: {
    createRoot: (...args: unknown[]) => createRootMock(...args),
  },
}));

describe('main.tsx bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    createRootMock.mockClear();
  });

  it('throws when #root is missing', async () => {
    vi.spyOn(document, 'getElementById').mockReturnValue(null);
    await expect(import('./main')).rejects.toThrow(/#root/);
  });

  it('creates root and render when #root exists', async () => {
    const el = document.createElement('div');
    el.id = 'root';
    vi.spyOn(document, 'getElementById').mockImplementation((id) => (id === 'root' ? el : null));
    await import('./main');
    expect(createRootMock).toHaveBeenCalledWith(el);
  });
});
