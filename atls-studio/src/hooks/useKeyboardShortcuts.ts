import { useEffect } from 'react';

interface KeyboardShortcutsConfig {
  onQuickActions: () => void;
  onQuickFind: () => void;
  onSettings: () => void;
  onSearchPanel: () => void;
  onOpenProject: () => void;
  onToggleTerminal: () => void;
}

export function useKeyboardShortcuts(config: KeyboardShortcutsConfig) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Shift+P or Cmd+Shift+P - Quick Actions
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        config.onQuickActions();
      }
      // Ctrl+P or Cmd+P - Quick Find (file search)
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'p') {
        e.preventDefault();
        config.onQuickFind();
      }
      // Ctrl+, or Cmd+, - Settings
      else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        config.onSettings();
      }
      // Ctrl+Shift+F or Cmd+Shift+F - Search in Files
      else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        config.onSearchPanel();
      }
      // Ctrl+O or Cmd+O - Open Project
      else if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault();
        config.onOpenProject();
      }
      // Ctrl+` or Cmd+` - Toggle Terminal
      else if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault();
        config.onToggleTerminal();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [config]);
}
