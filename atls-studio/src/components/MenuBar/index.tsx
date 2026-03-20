import { useState, useRef, useEffect, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../../stores/appStore';
import { INTERNALS_TAB_ID } from '../AtlsInternals';

const ZOOM_LEVELS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5];
const DEFAULT_ZOOM_INDEX = 2;
const ZOOM_STORAGE_KEY = 'atls-studio-zoom';

function loadZoomIndex(): number {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(ZOOM_STORAGE_KEY) : null;
    if (saved !== null) {
      const idx = parseInt(saved, 10);
      if (idx >= 0 && idx < ZOOM_LEVELS.length) return idx;
    }
  } catch (_e) { /* ignore */ }
  return DEFAULT_ZOOM_INDEX;
}

function saveZoomIndex(index: number): void {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(index));
  } catch (_e) { /* ignore */ }
}

interface MenuItem {
  label?: string;
  shortcut?: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
}

interface MenuGroup {
  label: string;
  items?: MenuItem[];
  action?: () => void;
}

interface MenuBarProps {
  onNewProject: () => void;
  onOpenProject: () => void;
  onSaveFile: () => void;
  onSettings: () => void;
  onNewChat: () => void;
  onFindInFiles: () => void;
  onFindInFile: () => void;
  onReplaceInFile: () => void;
  onToggleTerminal: () => void;
  onAddFolder?: () => void;
  onSaveWorkspace?: () => void;
  onOpenWorkspace?: () => void;
  onCloseWorkspace?: () => void;
}

export function MenuBar({ onNewProject, onOpenProject, onSaveFile, onSettings, onNewChat, onFindInFiles, onFindInFile, onReplaceInFile, onToggleTerminal, onAddFolder, onSaveWorkspace, onOpenWorkspace, onCloseWorkspace }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [zoomIndex, setZoomIndex] = useState(loadZoomIndex);
  const menuRef = useRef<HTMLDivElement>(null);
  const { 
    quickActionsOpen, setQuickActionsOpen,
    quickFindOpen, setQuickFindOpen,
    setSearchPanelOpen,
    setTerminalOpen,
  } = useAppStore();

  const zoomPercent = Math.round(ZOOM_LEVELS[zoomIndex] * 100);
  
  const applyZoom = useCallback((level: number) => {
    document.documentElement.style.fontSize = `${level * 16}px`;
  }, []);

  useEffect(() => {
    applyZoom(ZOOM_LEVELS[zoomIndex]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  
  const zoomIn = useCallback(() => {
    const newIndex = Math.min(zoomIndex + 1, ZOOM_LEVELS.length - 1);
    setZoomIndex(newIndex);
    applyZoom(ZOOM_LEVELS[newIndex]);
    saveZoomIndex(newIndex);
  }, [zoomIndex, applyZoom]);
  
  const zoomOut = useCallback(() => {
    const newIndex = Math.max(zoomIndex - 1, 0);
    setZoomIndex(newIndex);
    applyZoom(ZOOM_LEVELS[newIndex]);
    saveZoomIndex(newIndex);
  }, [zoomIndex, applyZoom]);
  
  const resetZoom = useCallback(() => {
    setZoomIndex(DEFAULT_ZOOM_INDEX);
    applyZoom(ZOOM_LEVELS[DEFAULT_ZOOM_INDEX]);
    saveZoomIndex(DEFAULT_ZOOM_INDEX);
  }, [applyZoom]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const menus: MenuGroup[] = [
    {
      label: 'File',
      items: [
        { label: 'New Project', shortcut: 'Ctrl+Shift+N', action: onNewProject },
        { label: 'Open Project...', shortcut: 'Ctrl+O', action: onOpenProject },
        { label: 'New Chat', shortcut: 'Ctrl+N', action: onNewChat },
        { label: 'Add Folder to Workspace...', action: onAddFolder, disabled: !onAddFolder },
        { separator: true },
        { label: 'Save Workspace As...', action: onSaveWorkspace, disabled: !onSaveWorkspace },
        { label: 'Open Workspace...', action: onOpenWorkspace },
        { label: 'Close Workspace', action: onCloseWorkspace, disabled: !onCloseWorkspace },
        { separator: true },
        { label: 'Save', shortcut: 'Ctrl+S', action: onSaveFile },
        { label: 'Save All', shortcut: 'Ctrl+Shift+S', action: onSaveFile },
        { separator: true },
        { label: 'Settings', shortcut: 'Ctrl+,', action: onSettings },
        { separator: true },
        { label: 'Exit', shortcut: 'Alt+F4', action: () => getCurrentWindow().close() },
      ]
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', action: () => document.execCommand('undo') },
        { label: 'Redo', shortcut: 'Ctrl+Shift+Z', action: () => document.execCommand('redo') },
        { separator: true },
        { label: 'Cut', shortcut: 'Ctrl+X', action: () => document.execCommand('cut') },
        { label: 'Copy', shortcut: 'Ctrl+C', action: () => document.execCommand('copy') },
        { label: 'Paste', shortcut: 'Ctrl+V', action: () => document.execCommand('paste') },
        { separator: true },
        { label: 'Find in File', shortcut: 'Ctrl+F', action: onFindInFile },
        { label: 'Replace', shortcut: 'Ctrl+H', action: onReplaceInFile },
      ]
    },
    {
      label: 'View',
      items: [
        { label: 'Quick Actions', shortcut: 'Ctrl+Shift+P', action: () => setQuickActionsOpen(!quickActionsOpen) },
        { label: 'Quick Find', shortcut: 'Ctrl+P', action: () => setQuickFindOpen(!quickFindOpen) },
        { label: 'Search in Files', shortcut: 'Ctrl+Shift+F', action: onFindInFiles },
        { separator: true },
        { label: 'Toggle Terminal', shortcut: 'Ctrl+`', action: onToggleTerminal },
        { separator: true },
        { label: 'Zoom In', shortcut: 'Ctrl+=', action: zoomIn },
        { label: 'Zoom Out', shortcut: 'Ctrl+-', action: zoomOut },
        { label: 'Reset Zoom', shortcut: 'Ctrl+0', action: resetZoom },
      ]
    },
    {
      label: 'ATLS',
      action: () => useAppStore.getState().openFile(INTERNALS_TAB_ID),
    },
    {
      label: 'Help',
      items: [
        { label: 'Documentation', action: () => window.open('https://atls.dev/docs', '_blank', 'noopener,noreferrer') },
        { label: 'Keyboard Shortcuts', action: () => setQuickActionsOpen(true) },
        { separator: true },
        { label: 'About ATLS Studio', action: onSettings },
      ]
    }
  ];

  const handleMenuClick = (label: string) => {
    setOpenMenu(openMenu === label ? null : label);
  };

  const handleItemClick = (item: MenuItem) => {
    if (!item.disabled && item.action) {
      item.action();
    }
    setOpenMenu(null);
  };

  return (
    <div 
      ref={menuRef}
      className="flex items-center select-none relative h-8 bg-studio-surface border-b border-studio-border"
    >
      {menus.map((menu) => (
        <div key={menu.label} className="relative">
          <button
            onClick={() => {
              if (menu.action && !menu.items) {
                menu.action();
                setOpenMenu(null);
              } else {
                handleMenuClick(menu.label);
              }
            }}
            onMouseEnter={() => openMenu && !menu.action && setOpenMenu(menu.label)}
            className={`px-3 py-1 text-sm transition-colors ${
              openMenu === menu.label
                ? 'bg-studio-accent-bright text-studio-bg'
                : 'text-studio-text hover:bg-studio-bg'
            }`}
          >
            {menu.label}
          </button>
          
          {openMenu === menu.label && menu.items && (
            <div className="absolute top-full left-0 z-50 min-w-48 py-1 shadow-xl bg-studio-surface border border-studio-border mt-0">
              {menu.items.map((item, idx) => (
                item.separator ? (
                  <div key={idx} className="my-1 border-t border-studio-border" />
                ) : (
                  <button
                    key={idx}
                    onClick={() => handleItemClick(item)}
                    disabled={item.disabled}
                    className={`w-full px-3 py-1.5 text-sm text-left flex items-center justify-between ${
                      item.disabled
                        ? 'text-studio-muted cursor-not-allowed'
                        : 'text-studio-text hover:bg-studio-accent-bright hover:text-studio-bg'
                    }`}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && (
                      <span className={`ml-8 text-xs ${
                        item.disabled ? 'text-studio-muted/50' : 'text-studio-muted'
                      }`}>
                        {item.shortcut}
                      </span>
                    )}
                  </button>
                )
              ))}
            </div>
          )}
        </div>
      ))}
      
      <div className="flex-1" />
      
      <div className="flex items-center gap-0.5 mr-2">
        <button
          onClick={zoomOut}
          disabled={zoomIndex === 0}
          className="p-1 rounded transition-colors hover:bg-studio-bg text-studio-muted disabled:text-studio-muted/30"
          title="Zoom Out"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 13H5v-2h14v2z" />
          </svg>
        </button>
        <button
          onClick={resetZoom}
          className="px-1.5 py-0.5 text-xs rounded transition-colors min-w-[40px] hover:bg-studio-bg text-studio-muted"
          title="Reset Zoom"
        >
          {zoomPercent}%
        </button>
        <button
          onClick={zoomIn}
          disabled={zoomIndex === ZOOM_LEVELS.length - 1}
          className="p-1 rounded transition-colors hover:bg-studio-bg text-studio-muted disabled:text-studio-muted/30"
          title="Zoom In"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
