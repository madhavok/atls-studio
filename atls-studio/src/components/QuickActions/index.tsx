import { useState, useEffect, useRef, useMemo } from 'react';

// Icons
const SearchIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
  </svg>
);

const FileIcon = () => (
  <svg className="w-4 h-4 text-studio-accent" viewBox="0 0 24 24" fill="currentColor">
    <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z" />
  </svg>
);

const AtlsIcon = () => (
  <svg className="w-4 h-4 text-studio-success" viewBox="0 0 24 24" fill="currentColor">
    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="w-4 h-4 text-studio-warning" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
  </svg>
);

const NavigateIcon = () => (
  <svg className="w-4 h-4 text-studio-muted" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
  </svg>
);

const TerminalIcon = () => (
  <svg className="w-4 h-4 text-studio-muted" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z" />
  </svg>
);

export interface QuickAction {
  id: string;
  label: string;
  category: 'file' | 'atls' | 'settings' | 'navigate' | 'terminal';
  shortcut?: string;
  action: () => void;
}

interface QuickActionsProps {
  isOpen: boolean;
  onClose: () => void;
  actions: QuickAction[];
  mode?: 'actions' | 'files';
}

// Simple fuzzy match
function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  
  let queryIndex = 0;
  for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[queryIndex]) {
      queryIndex++;
    }
  }
  return queryIndex === lowerQuery.length;
}

function getCategoryIcon(category: QuickAction['category']) {
  switch (category) {
    case 'file': return <FileIcon />;
    case 'atls': return <AtlsIcon />;
    case 'settings': return <SettingsIcon />;
    case 'navigate': return <NavigateIcon />;
    case 'terminal': return <TerminalIcon />;
    default: return <FileIcon />;
  }
}

export function QuickActions({ isOpen, onClose, actions, mode = 'actions' }: QuickActionsProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter actions based on query
  const filteredActions = useMemo(() => {
    return actions.filter(action => fuzzyMatch(action.label, query));
  }, [actions, query]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selectedElement = listRef.current.children[selectedIndex] as HTMLElement;
      selectedElement?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, filteredActions.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredActions[selectedIndex]) {
          filteredActions[selectedIndex].action();
          onClose();
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  };

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[15vh] z-50"
      onClick={onClose}
    >
      <div 
        className="bg-studio-surface border border-studio-border rounded-lg shadow-2xl w-[500px] max-h-[60vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search Input */}
        <div className="flex items-center gap-2 p-3 border-b border-studio-border">
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === 'files' ? 'Search files by name...' : 'Type to search actions...'}
            className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-studio-muted"
            autoFocus
          />
          <span className="text-xs text-studio-muted">ESC to close</span>
        </div>

        {/* Actions List */}
        <div ref={listRef} className="flex-1 overflow-y-auto scrollbar-thin">
          {filteredActions.length === 0 ? (
            <div className="p-4 text-center text-studio-muted text-sm">
              No matching {mode === 'files' ? 'files' : 'actions'} found
            </div>
          ) : (
            filteredActions.map((action, index) => (
              <div
                key={action.id}
                className={`
                  flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors
                  ${index === selectedIndex ? 'bg-studio-accent/20' : 'hover:bg-studio-border/50'}
                `}
                onClick={() => {
                  action.action();
                  onClose();
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                {getCategoryIcon(action.category)}
                <span className="flex-1 text-sm">{action.label}</span>
                {action.shortcut && (
                  <span className="text-xs text-studio-muted bg-studio-bg px-1.5 py-0.5 rounded font-mono">
                    {action.shortcut}
                  </span>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="px-3 py-2 border-t border-studio-border text-xs text-studio-muted flex items-center gap-4">
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>ESC Close</span>
        </div>
      </div>
    </div>
  );
}

export default QuickActions;
