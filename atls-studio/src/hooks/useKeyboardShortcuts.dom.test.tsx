/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

function fire(key: string, opts: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }),
  );
}

describe('useKeyboardShortcuts', () => {
  it('invokes onQuickActions for Ctrl+Shift+P', () => {
    const onQuickActions = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        onQuickActions,
        onQuickFind: vi.fn(),
        onSettings: vi.fn(),
        onSearchPanel: vi.fn(),
        onOpenProject: vi.fn(),
        onToggleTerminal: vi.fn(),
      }),
    );
    fire('P', { ctrlKey: true, shiftKey: true });
    expect(onQuickActions).toHaveBeenCalledTimes(1);
  });

  it('invokes onSettings for Ctrl+,', () => {
    const onSettings = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts({
        onQuickActions: vi.fn(),
        onQuickFind: vi.fn(),
        onSettings,
        onSearchPanel: vi.fn(),
        onOpenProject: vi.fn(),
        onToggleTerminal: vi.fn(),
      }),
    );
    fire(',', { ctrlKey: true });
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});
