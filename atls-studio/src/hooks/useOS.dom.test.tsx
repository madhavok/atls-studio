/** @vitest-environment happy-dom */
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOS } from './useOS';

const platformMock = vi.fn<[], Promise<string>>();

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: () => platformMock(),
}));

function Probe() {
  const { os, isMac, isWindows, isLinux, loading } = useOS();
  return (
    <div
      data-testid="os"
      data-os={os}
      data-mac={isMac}
      data-win={isWindows}
      data-linux={isLinux}
      data-loading={loading}
    />
  );
}

async function expectOs(
  t: (id: string) => HTMLElement,
  want: { os: string; mac: string; win: string; linux: string },
) {
  await waitFor(() => {
    expect(t('os').getAttribute('data-loading')).toBe('false');
  });
  expect(t('os').getAttribute('data-os')).toBe(want.os);
  expect(t('os').getAttribute('data-mac')).toBe(want.mac);
  expect(t('os').getAttribute('data-win')).toBe(want.win);
  expect(t('os').getAttribute('data-linux')).toBe(want.linux);
}

describe('useOS', () => {
  afterEach(() => {
    platformMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('maps macos to isMac', async () => {
    platformMock.mockResolvedValue('macos');
    const { getByTestId } = render(<Probe />);
    await expectOs(getByTestId, { os: 'macos', mac: 'true', win: 'false', linux: 'false' });
  });

  it('maps ios to macos', async () => {
    platformMock.mockResolvedValue('ios');
    const { getByTestId } = render(<Probe />);
    await expectOs(getByTestId, { os: 'macos', mac: 'true', win: 'false', linux: 'false' });
  });

  it('maps windows', async () => {
    platformMock.mockResolvedValue('windows');
    const { getByTestId } = render(<Probe />);
    await expectOs(getByTestId, { os: 'windows', mac: 'false', win: 'true', linux: 'false' });
  });

  it('maps linux and freebsd to linux', async () => {
    for (const p of ['linux', 'freebsd'] as const) {
      platformMock.mockResolvedValue(p);
      const { getByTestId, unmount } = render(<Probe />);
      await expectOs(getByTestId, { os: 'linux', mac: 'false', win: 'false', linux: 'true' });
      unmount();
    }
  });

  it('maps other Tauri platforms to unknown', async () => {
    platformMock.mockResolvedValue('android');
    const { getByTestId } = render(<Probe />);
    await expectOs(getByTestId, { os: 'unknown', mac: 'false', win: 'false', linux: 'false' });
  });

  it('falls back to userAgent when platform throws', async () => {
    platformMock.mockRejectedValue(new Error('ipc'));
    vi.stubGlobal('navigator', { userAgent: 'windows nt 10' });
    const { getByTestId } = render(<Probe />);
    await expectOs(getByTestId, { os: 'windows', mac: 'false', win: 'true', linux: 'false' });
  });
});
