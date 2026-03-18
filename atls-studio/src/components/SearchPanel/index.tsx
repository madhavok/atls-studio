import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useAtls } from '../../hooks/useAtls';
import { invoke } from '@tauri-apps/api/core';
import { CloseIcon, FileIcon } from '../icons';

// Icons
const SearchIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
  </svg>
);

const LoadingIcon = () => (
  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <circle cx="12" cy="12" r="10" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
  </svg>
);


interface SearchResult {
  file: string;
  line: number;
  column?: number;
  snippet: string;
  matchStart?: number;
  matchEnd?: number;
}

interface SearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SearchPanel({ isOpen, onClose }: SearchPanelProps) {
  const { projectPath, openFile, setSelectedFile, setPendingScrollLine, addToast } = useAppStore();
  const { diagnoseSymbols } = useAtls();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [searchMode, setSearchMode] = useState<'text' | 'symbol'>('text');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Scroll selected result into view
  useEffect(() => {
    if (resultsRef.current && selectedIndex >= 0) {
      const selectedElement = resultsRef.current.children[selectedIndex] as HTMLElement;
      selectedElement?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Perform search using Tauri command
  const performSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim() || !projectPath) {
      setResults([]);
      return;
    }

    setIsSearching(true);
    setSelectedIndex(-1);

    try {
      if (searchMode === 'symbol') {
        // Symbol search via ATLS diagnose_symbols
        const result = await diagnoseSymbols(searchQuery, 'contains', undefined, 100);
        if (result?.symbols) {
          const symbolResults: SearchResult[] = result.symbols.map((s: any) => ({
            file: s.file || s.path || '',
            line: s.line || 1,
            snippet: `${s.kind || 'symbol'}: ${s.name}${s.signature ? ` ${s.signature}` : ''}`,
          }));
          setResults(symbolResults);
        } else {
          setResults([]);
        }
      } else {
        // Text search via Tauri backend
        const searchResults = await invoke<SearchResult[]>('search_text', {
          query: searchQuery,
          path: projectPath,
          caseSensitive,
          useRegex,
        });
        setResults(searchResults);
      }
    } catch (error) {
      addToast({ type: 'error', message: `Search failed: ${error}` });
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [projectPath, caseSensitive, useRegex, searchMode, diagnoseSymbols, addToast]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.length >= 2) {
        performSearch(query);
      } else {
        setResults([]);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, performSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (results[selectedIndex]) {
          handleResultClick(results[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  };

  const handleResultClick = (result: SearchResult) => {
    setSelectedFile(result.file);
    openFile(result.file);
    setPendingScrollLine(result.line);
    onClose();
  };

  // Group results by file
  const groupedResults = results.reduce<Record<string, SearchResult[]>>((acc, result) => {
    if (!acc[result.file]) {
      acc[result.file] = [];
    }
    acc[result.file].push(result);
    return acc;
  }, {});

  const getFileName = (filePath: string) => {
    return filePath.split(/[/\\]/).pop() || filePath;
  };

  const getRelativePath = (filePath: string) => {
    if (projectPath && filePath.startsWith(projectPath)) {
      return filePath.substring(projectPath.length + 1);
    }
    return filePath;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-[400px] bg-studio-surface border-l border-studio-border shadow-2xl z-40 flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-studio-border">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-studio-title">Search in Files</h2>
          <button
            onClick={onClose}
            className="p-1 text-studio-muted hover:text-studio-text rounded transition-colors"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Search Input */}
        <div className="flex items-center gap-2 bg-studio-bg border border-studio-border rounded px-2 py-1.5">
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search text..."
            className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-studio-muted"
          />
          {isSearching && <LoadingIcon />}
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-1 mt-2">
          <button
            onClick={() => setSearchMode('text')}
            className={`text-xs px-2 py-0.5 rounded transition-colors ${
              searchMode === 'text'
                ? 'bg-studio-accent/20 text-studio-accent'
                : 'text-studio-muted hover:text-studio-text'
            }`}
          >
            Text
          </button>
          <button
            onClick={() => setSearchMode('symbol')}
            className={`text-xs px-2 py-0.5 rounded transition-colors ${
              searchMode === 'symbol'
                ? 'bg-studio-accent/20 text-studio-accent'
                : 'text-studio-muted hover:text-studio-text'
            }`}
          >
            Symbol
          </button>
        </div>

        {/* Options (text mode only) */}
        <div className={`flex items-center gap-4 mt-2 text-xs ${searchMode === 'symbol' ? 'opacity-50 pointer-events-none' : ''}`}>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
              className="rounded border-studio-border"
            />
            <span className="text-studio-muted">Case sensitive</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={useRegex}
              onChange={(e) => setUseRegex(e.target.checked)}
              className="rounded border-studio-border"
            />
            <span className="text-studio-muted">Regex</span>
          </label>
        </div>
      </div>

      {/* Results */}
      <div ref={resultsRef} className="flex-1 overflow-y-auto scrollbar-thin">
        {!projectPath ? (
          <div className="p-4 text-center text-studio-muted text-sm">
            Open a project to search
          </div>
        ) : query.length < 2 ? (
          <div className="p-4 text-center text-studio-muted text-sm">
            Type at least 2 characters to search
          </div>
        ) : results.length === 0 && !isSearching ? (
          <div className="p-4 text-center text-studio-muted text-sm">
            No results found for "{query}"
          </div>
        ) : (
          Object.entries(groupedResults).map(([file, fileResults], fileIndex) => (
            <div key={file} className="border-b border-studio-border/50">
              {/* File Header */}
              <div className="flex items-center gap-2 px-3 py-2 bg-studio-bg/50 sticky top-0">
                <FileIcon className="w-4 h-4 text-studio-muted" />
                <span className="text-xs font-medium truncate">{getFileName(file)}</span>
                <span className="text-xs text-studio-muted truncate">{getRelativePath(file)}</span>
                <span className="ml-auto text-xs text-studio-muted">{fileResults.length}</span>
              </div>

              {/* File Results */}
              {fileResults.map((result, resultIndex) => {
                const globalIndex = Object.keys(groupedResults)
                  .slice(0, fileIndex)
                  .reduce((acc, f) => acc + groupedResults[f].length, 0) + resultIndex;

                return (
                  <div
                    key={`${result.file}:${result.line}:${resultIndex}`}
                    className={`
                      px-3 py-1.5 cursor-pointer transition-colors
                      ${globalIndex === selectedIndex ? 'bg-studio-accent/20' : 'hover:bg-studio-border/30'}
                    `}
                    onClick={() => handleResultClick(result)}
                    onMouseEnter={() => setSelectedIndex(globalIndex)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-studio-muted w-8 text-right shrink-0">
                        {result.line}
                      </span>
                      <span className="text-xs font-mono truncate">
                        {highlightMatch(result.snippet, query, caseSensitive)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-studio-border text-xs text-studio-muted flex items-center justify-between">
        <span>{results.length} results</span>
        <span>↑↓ Navigate • ↵ Open • ESC Close</span>
      </div>
    </div>
  );
}

// Highlight matching text in snippet
function highlightMatch(text: string, query: string, caseSensitive: boolean): React.ReactNode {
  if (!query) return text;

  const flags = caseSensitive ? 'g' : 'gi';
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escapedQuery})`, flags));

  return parts.map((part, i) => {
    const isMatch = caseSensitive 
      ? part === query 
      : part.toLowerCase() === query.toLowerCase();
    return isMatch ? (
      <span key={i} className="bg-studio-warning/30 text-studio-warning">{part}</span>
    ) : (
      part
    );
  });
}

export default SearchPanel;
