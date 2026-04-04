/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useOS } from './useOS';

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(async () => 'windows'),
}));

describe('useOS', () => {
  it('resolves platform from Tauri', async () => {
    const { result } = renderHook(() => useOS());
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.os).toBe('windows');
    expect(result.current.isWindows).toBe(true);
  });
});
