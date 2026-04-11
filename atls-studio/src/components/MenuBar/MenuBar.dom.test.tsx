/** @vitest-environment happy-dom */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MenuBar } from './index';

const { closeMock } = vi.hoisted(() => ({ closeMock: vi.fn() }));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: closeMock,
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
  }),
}));

describe('MenuBar', () => {
  it('opens File menu and runs New Chat action', () => {
    const onNewChat = vi.fn();
    render(
      <MenuBar
        onNewProject={vi.fn()}
        onOpenProject={vi.fn()}
        onSaveFile={vi.fn()}
        onSettings={vi.fn()}
        onNewChat={onNewChat}
        onFindInFiles={vi.fn()}
        onFindInFile={vi.fn()}
        onReplaceInFile={vi.fn()}
        onToggleTerminal={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    fireEvent.click(screen.getByRole('button', { name: /New Chat/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});
