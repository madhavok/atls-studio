/** @vitest-environment happy-dom */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MenuBar } from './index';
import { INTERNALS_TAB_ID } from '../AtlsInternals';
import { DEFAULT_ZOOM_INDEX, ZOOM_STORAGE_KEY } from './menuBarZoomStorage';

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

const openFileMock = vi.fn();
const appStoreState = {
  quickActionsOpen: false,
  setQuickActionsOpen: vi.fn(),
  quickFindOpen: false,
  setQuickFindOpen: vi.fn(),
  setSearchPanelOpen: vi.fn(),
  setTerminalOpen: vi.fn(),
  openFile: openFileMock,
};

vi.mock('../../stores/appStore', () => ({
  useAppStore: Object.assign(
    () => appStoreState,
    { getState: () => appStoreState },
  ),
}));

const defaultProps = {
  onNewProject: vi.fn(),
  onOpenProject: vi.fn(),
  onSaveFile: vi.fn(),
  onSettings: vi.fn(),
  onNewChat: vi.fn(),
  onFindInFiles: vi.fn(),
  onFindInFile: vi.fn(),
  onReplaceInFile: vi.fn(),
  onToggleTerminal: vi.fn(),
};

describe('MenuBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(ZOOM_STORAGE_KEY);
    document.documentElement.style.fontSize = '';
    appStoreState.quickActionsOpen = false;
    appStoreState.quickFindOpen = false;
  });

  it('opens File menu and runs New Chat action', () => {
    const onNewChat = vi.fn();
    render(<MenuBar {...defaultProps} onNewChat={onNewChat} />);
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    fireEvent.click(screen.getByRole('button', { name: /New Chat/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('calls Tauri close on Exit', () => {
    render(<MenuBar {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    fireEvent.click(screen.getByRole('button', { name: /^Exit\b/i }));
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('opens internals tab from ATLS menu', () => {
    render(<MenuBar {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'ATLS' }));
    expect(openFileMock).toHaveBeenCalledWith(INTERNALS_TAB_ID);
  });

  it('toggles Quick Actions from View menu', () => {
    render(<MenuBar {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    fireEvent.click(screen.getByRole('button', { name: /Quick Actions/i }));
    expect(appStoreState.setQuickActionsOpen).toHaveBeenCalledWith(true);
  });

  it('closes dropdown on outside mousedown', () => {
    render(<MenuBar {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    expect(screen.getByRole('button', { name: /New Chat/i })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('button', { name: /New Chat/i })).toBeNull();
  });

  it('zoom in updates storage and label', () => {
    render(<MenuBar {...defaultProps} />);
    const pctBefore = screen.getByTitle('Reset Zoom').textContent;
    expect(pctBefore).toBe('100%');
    fireEvent.click(screen.getByTitle('Zoom In'));
    expect(screen.getByTitle('Reset Zoom').textContent).toBe('110%');
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe(String(DEFAULT_ZOOM_INDEX + 1));
  });

  it('Close Workspace stays disabled when onCloseWorkspace is omitted', () => {
    render(<MenuBar {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    const closeBtn = screen.getByRole('button', { name: 'Close Workspace' });
    expect((closeBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(closeBtn);
  });
});
