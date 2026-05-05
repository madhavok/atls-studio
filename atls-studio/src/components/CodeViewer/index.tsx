import { CloseIcon } from '../icons';
import { getLanguage } from '../../utils/languageMap';
import { useState, useCallback, useEffect, useRef } from 'react';
import Editor, { OnMount, Monaco } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { safeListen } from '../../utils/tauri';
import { useAppStore } from '../../stores/appStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { MarkdownMessage } from '../AiChat/MarkdownMessage';
import { AtlsInternals, INTERNALS_TAB_ID } from '../AtlsInternals';
import { SwarmPanel } from '../SwarmPanel';
import { SwarmErrorBoundary } from '../SwarmPanel/SwarmErrorBoundary';
import { SWARM_ORCHESTRATION_TAB_ID } from '../../constants/swarmOrchestrationTab';
import { normalizeEditorPath } from './codeViewerPaths';
import { mergeDefinitionsAndReferencesUnique } from './codeViewerSymbolRefs';


// Symbol usage types
interface SymbolLocation {
  file: string;
  line: number;
  kind?: string;
}

interface SymbolUsage {
  symbol: string;
  definitions: SymbolLocation[];
  references: SymbolLocation[];
}

// References panel types
interface ReferencesState {
  isOpen: boolean;
  symbol: string;
  references: SymbolLocation[];
}

interface CanonicalRevisionChangedEvent {
  path: string;
  revision: string;
  previous_revision?: string | null;
}

const DESIGN_PREVIEW_TAB = '__design_preview__';

export function CodeViewer() {
  const { openFiles, activeFile, closeFile, setActiveFile, openFile, projectPath, activeRoot, pendingScrollLine, setPendingScrollLine } = useAppStore();
  const chatMode = useAppStore((s) => s.chatMode);
  const designPreviewContent = useAppStore((s) => s.designPreviewContent);
  const editorTheme = useAppStore((s) => s.settings.theme === 'light' ? 'vs' : 'vs-dark');
  const swarmActive = useSwarmStore((s) => s.isActive);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [designPreviewTabActive, setDesignPreviewTabActive] = useState(false);
  const [originalContents, setOriginalContents] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refsState, setRefsState] = useState<ReferencesState>({ isOpen: false, symbol: '', references: [] });
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const referenceClickTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  const activeRootRef = useRef(activeRoot);
  activeRootRef.current = activeRoot;
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;

  // Stable refs for the event listener closure (avoids stale captures)
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  const fileContentsRef = useRef(fileContents);
  fileContentsRef.current = fileContents;
  const originalContentsRef = useRef(originalContents);
  originalContentsRef.current = originalContents;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  // Check if a file has unsaved changes
  const isDirty = useCallback((path: string): boolean => {
    return fileContents[path] !== originalContents[path] && originalContents[path] !== undefined;
  }, [fileContents, originalContents]);

  const normalizePath = useCallback((path: string): string => normalizeEditorPath(path), []);

  const hasDesignPreview =
    chatMode === 'designer' && designPreviewContent.length > 0;
  const showDesignPreview =
    hasDesignPreview && (openFiles.length === 0 || designPreviewTabActive);

  // Load or refresh file content when the active editor tab changes.
  // Inactive tabs keep a cached buffer; activating a tab re-reads from disk so it stays fresh (unless dirty).
  useEffect(() => {
    if (!activeFile || activeFile === INTERNALS_TAB_ID || activeFile === SWARM_ORCHESTRATION_TAB_ID) return;
    if (showDesignPreview) return;

    const path = activeFile;
    const normalizedPath = normalizePath(path);
    const fc = fileContentsRef.current;
    const oc = originalContentsRef.current;
    const hasDirtyEdits =
      fc[path] !== oc[path] && oc[path] !== undefined;
    if (hasDirtyEdits) return;

    const root = activeRoot ?? projectPath;
    if (!root) return;

    const loadFile = async () => {
      setLoading((prev) => ({ ...prev, [path]: true, [normalizedPath]: true }));
      setErrors((prev) => ({ ...prev, [path]: '', [normalizedPath]: '' }));

      try {
        const content = await invoke<string>('read_file_contents', {
          path,
          projectRoot: root,
        });
        if (activeFileRef.current !== path) return;
        setFileContents((prev) => ({ ...prev, [path]: content, [normalizedPath]: content }));
        setOriginalContents((prev) => ({ ...prev, [path]: content, [normalizedPath]: content }));
      } catch (error) {
        if (activeFileRef.current !== path) return;
        console.error('[CodeViewer] Failed to read file:', path, error);
        setErrors((prev) => ({
          ...prev,
          [path]: `Failed to read file: ${error}`,
          [normalizedPath]: `Failed to read file: ${error}`,
        }));
      } finally {
        setLoading((prev) => ({ ...prev, [path]: false, [normalizedPath]: false }));
      }
    };

    loadFile();
  }, [activeFile, showDesignPreview, normalizePath, projectPath, activeRoot]);

  // Scroll to pending line when set by SearchPanel or AtlsPanel
  useEffect(() => {
    if (pendingScrollLine && editorRef.current) {
      editorRef.current.revealLineInCenter(pendingScrollLine);
      editorRef.current.setPosition({ lineNumber: pendingScrollLine, column: 1 });
      setPendingScrollLine(null);
    }
  }, [pendingScrollLine, activeFile, setPendingScrollLine]);

  // Save file
  const saveFile = useCallback(async (path: string) => {
    const root = activeRoot ?? projectPath;
    if (!root) {
      useAppStore.getState().addToast({ type: 'error', message: 'No project open—open a project first' });
      return;
    }
    // Prefer editor content for active file (avoids stale state if user saves before React flushes)
    const content = path === activeFile && editorRef.current?.getModel()
      ? editorRef.current.getModel()!.getValue()
      : (fileContents[path] ?? fileContents[path.replace(/\\/g, '/')]);
    const orig = originalContents[path] ?? originalContents[path.replace(/\\/g, '/')];
    if (content === undefined || content === orig) return;

    setSaving(prev => ({ ...prev, [path]: true, [path.replace(/\\/g, '/')]: true }));
    
    try {
      await invoke('write_file_contents', { path, contents: content, projectRoot: root });
      setOriginalContents(prev => ({ ...prev, [path]: content, [path.replace(/\\/g, '/')]: content }));
      useAppStore.getState().addToast({ type: 'success', message: `Saved ${path.split(/[/\\]/).pop()}`, duration: 2000 });
    } catch (error) {
      useAppStore.getState().addToast({ type: 'error', message: `Failed to save: ${error}` });
      setErrors(prev => ({ 
        ...prev, 
        [path]: `Failed to save file: ${error}`,
        [path.replace(/\\/g, '/')]: `Failed to save file: ${error}` 
      }));
    } finally {
      setSaving(prev => ({ ...prev, [path]: false, [path.replace(/\\/g, '/')]: false }));
    }
  }, [fileContents, originalContents, projectPath, activeRoot, activeFile]);

  // Save active file
  const saveActiveFile = useCallback(() => {
    if (activeFile) {
      saveFile(activeFile);
    }
  }, [activeFile, saveFile]);

  // Handle Ctrl+S globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveActiveFile();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveActiveFile]);

  // Handle save from Quick Actions (Ctrl+Shift+P > Save File)
  useEffect(() => {
    const handler = () => saveActiveFile();
    window.addEventListener('editor-save-file', handler);
    return () => window.removeEventListener('editor-save-file', handler);
  }, [saveActiveFile]);

  // Clean up pending reference click timeout on unmount
  useEffect(() => {
    return () => { if (referenceClickTimeout.current) clearTimeout(referenceClickTimeout.current); };
  }, []);

  // Auto-refresh open files when they change on disk (AI edits, external tools, watcher)
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    (async () => {
      unlisten = await safeListen<CanonicalRevisionChangedEvent>('canonical_revision_changed', async (ev) => {
        const changedPath = ev.payload.path;
        const changedNorm = changedPath.replace(/\\/g, '/');

        const currentOpenFiles = openFilesRef.current;
        const matchedFile = currentOpenFiles.find((f) => {
          const fNorm = f.replace(/\\/g, '/');
          return fNorm === changedNorm || f === changedPath;
        });
        if (!matchedFile) return;

        const currentActive = activeFileRef.current;
        const activeNorm = currentActive?.replace(/\\/g, '/');
        const matchedNormForActive = matchedFile.replace(/\\/g, '/');
        if (
          currentActive !== matchedFile &&
          activeNorm !== matchedNormForActive
        ) {
          return;
        }

        // Skip files we're currently saving (our own write triggered this event)
        const currentSaving = savingRef.current;
        const matchedNorm = matchedNormForActive;
        if (currentSaving[matchedFile] || currentSaving[matchedNorm]) return;

        const currentContents = fileContentsRef.current;
        const currentOriginals = originalContentsRef.current;
        const hasDirtyEdits = currentContents[matchedFile] !== currentOriginals[matchedFile]
          && currentOriginals[matchedFile] !== undefined;

        const root = useAppStore.getState().activeRoot ?? useAppStore.getState().projectPath;
        if (!root) return;

        try {
          const diskContent = await invoke<string>('read_file_contents', { path: matchedFile, projectRoot: root });

          // No-op if content already matches (e.g. user just saved this file)
          if (diskContent === currentContents[matchedFile]) return;

          if (hasDirtyEdits) {
            useAppStore.getState().addToast({
              type: 'warning',
              message: `"${matchedFile.split(/[/\\]/).pop()}" was modified externally. Save or discard your changes, then reopen to see the latest version.`,
              duration: 8000,
            });
            return;
          }

          setFileContents((prev) => ({ ...prev, [matchedFile]: diskContent, [matchedNorm]: diskContent }));
          setOriginalContents((prev) => ({ ...prev, [matchedFile]: diskContent, [matchedNorm]: diskContent }));
        } catch (err) {
          console.error('[CodeViewer] Failed to reload changed file:', matchedFile, err);
        }
      });
    })();
    return () => { unlisten?.(); };
  }, []);

  // ── Auto-refresh open files on external filesystem changes (git, other editors, CLI tools) ──
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    (async () => {
      unlisten = await safeListen<{ root: string; count: number; paths: string[] }>('file_tree_changed', async (ev) => {
        const changedPaths: string[] = ev.payload.paths ?? [];
        if (changedPaths.length === 0) return;

        const currentOpenFiles = openFilesRef.current;
        if (currentOpenFiles.length === 0) return;

        const root = useAppStore.getState().activeRoot ?? useAppStore.getState().projectPath;
        if (!root) return;

        for (const changedPath of changedPaths) {
          const changedNorm = changedPath.replace(/\\/g, '/');
          const matchedFile = currentOpenFiles.find((f) => {
            const fNorm = f.replace(/\\/g, '/');
            return fNorm === changedNorm || f === changedPath;
          });
          if (!matchedFile) continue;

          const currentActive = activeFileRef.current;
          const activeNorm = currentActive?.replace(/\\/g, '/');
          const matchedNorm = matchedFile.replace(/\\/g, '/');
          if (currentActive !== matchedFile && activeNorm !== matchedNorm) continue;

          // Skip files we're currently saving
          const currentSaving = savingRef.current;
          if (currentSaving[matchedFile] || currentSaving[matchedNorm]) continue;

          const currentContents = fileContentsRef.current;
          const currentOriginals = originalContentsRef.current;
          const hasDirtyEdits = currentContents[matchedFile] !== currentOriginals[matchedFile]
            && currentOriginals[matchedFile] !== undefined;

          try {
            const diskContent = await invoke<string>('read_file_contents', { path: matchedFile, projectRoot: root });

            // No-op if content already matches
            if (diskContent === currentContents[matchedFile]) continue;

            if (hasDirtyEdits) {
              useAppStore.getState().addToast({
                type: 'warning',
                message: `"${matchedFile.split(/[/\\]/).pop()}" was modified externally. Save or discard your local changes.`,
              });
              continue;
            }

            // Update content from disk
            setFileContents((prev) => ({
              ...prev,
              [matchedFile]: diskContent,
              [matchedNorm]: diskContent,
            }));
            setOriginalContents((prev) => ({
              ...prev,
              [matchedFile]: diskContent,
              [matchedNorm]: diskContent,
            }));
          } catch {
            // File may have been deleted — ignore
          }
        }
      });
    })();
    return () => { unlisten?.(); };
  }, []);

  // Get word at cursor position
  const getWordAtCursor = useCallback((): string | null => {
    if (!editorRef.current || !monacoRef.current) return null;
    
    const model = editorRef.current.getModel();
    const position = editorRef.current.getPosition();
    
    if (!model || !position) return null;
    
    const word = model.getWordAtPosition(position);
    return word?.word || null;
  }, []);

  // Jump to Source (F12)
  const handleJumpToSource = useCallback(async () => {
    const word = getWordAtCursor();
    const root = activeRootRef.current ?? projectPathRef.current;
    if (!word || !root) return;

    try {
      const usage = await invoke<SymbolUsage>('get_symbol_usage', {
        symbol: word,
        path: root,
      });

      const currentFile = activeFileRef.current;
      const def = usage.definitions.find((definition) => definition.file === currentFile) ?? usage.definitions[0];
      if (def) {
        openFile(def.file);
        setPendingScrollLine(def.line);
      }
    } catch (error) {
      console.error('Jump to source failed:', error);
    }
  }, [getWordAtCursor, openFile]);

  // Find Usages (Shift+F12)
  const handleFindUsages = useCallback(async () => {
    const word = getWordAtCursor();
    const root = activeRootRef.current ?? projectPathRef.current;
    if (!word || !root) return;

    try {
      const usage = await invoke<SymbolUsage>('get_symbol_usage', { 
        symbol: word, 
        path: root 
      });

      const references = mergeDefinitionsAndReferencesUnique(usage.definitions, usage.references);

      setRefsState({
        isOpen: true,
        symbol: word,
        references,
      });
    } catch (error) {
      console.error('Find usages failed:', error);
    }
  }, [getWordAtCursor]);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    editor.updateOptions({
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      lineNumbers: 'on',
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      automaticLayout: false,
    });

    // Debounced layout on container resize instead of automaticLayout
    const container = editor.getDomNode()?.parentElement;
    if (container) {
      let layoutTimer: ReturnType<typeof setTimeout> | null = null;
      const ro = new ResizeObserver(() => {
        if (layoutTimer) clearTimeout(layoutTimer);
        layoutTimer = setTimeout(() => editor.layout(), 100);
      });
      ro.observe(container);
      editor.onDidDispose(() => ro.disconnect());
    }

    // Add Ctrl+S save command
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveActiveFile();
    });

    // Add custom keyboard shortcuts
    editor.addCommand(monaco.KeyCode.F12, () => {
      handleJumpToSource();
    });

    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F12, () => {
      handleFindUsages();
    });

    // Add context menu actions
    editor.addAction({
      id: 'save-file',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      contextMenuGroupId: '1_file',
      contextMenuOrder: 1,
      run: () => saveActiveFile(),
    });

    editor.addAction({
      id: 'jump-to-source',
      label: 'Jump to Source',
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => handleJumpToSource(),
    });

    editor.addAction({
      id: 'find-usages',
      label: 'Find Usages',
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: () => handleFindUsages(),
    });
  }, [handleJumpToSource, handleFindUsages, saveActiveFile]);

  const handleContentChange = useCallback((value: string | undefined, path: string) => {
    if (value !== undefined) {
      const normalizedPath = normalizePath(path);
      setFileContents((prev) => ({
        ...prev,
        [path]: value,
        [normalizedPath]: value,
      }));
    }
  }, [normalizePath]);

  const handleReferenceClick = useCallback((ref: SymbolLocation) => {
    // Cancel any pending reference navigation to prevent race conditions
    if (referenceClickTimeout.current) {
      clearTimeout(referenceClickTimeout.current);
      referenceClickTimeout.current = null;
    }
    openFile(ref.file);
    referenceClickTimeout.current = setTimeout(() => {
      referenceClickTimeout.current = null;
      if (editorRef.current) {
        editorRef.current.revealLineInCenter(ref.line);
        editorRef.current.setPosition({ lineNumber: ref.line, column: 1 });
      }
    }, 100);
  }, [openFile]);

  // Handle close with unsaved changes
  const handleCloseFile = useCallback((file: string) => {
    if (file === SWARM_ORCHESTRATION_TAB_ID && swarmActive) return;
    if (isDirty(file)) {
      const confirmed = window.confirm(
        `"${file.split('/').pop()}" has unsaved changes.\n\nDiscard changes and close?`
      );
      if (!confirmed) return;
    }
    // Clean up file state
    setFileContents(prev => {
      const normalizedPath = normalizePath(file);
      const next = { ...prev };
      delete next[file];
      delete next[normalizedPath];
      return next;
    });
    setOriginalContents(prev => {
      const normalizedPath = normalizePath(file);
      const next = { ...prev };
      delete next[file];
      delete next[normalizedPath];
      return next;
    });
    closeFile(file);
  }, [closeFile, isDirty, normalizePath, swarmActive]);

  const isInternalsActive = activeFile === INTERNALS_TAB_ID;
  const isSwarmTabActive = activeFile === SWARM_ORCHESTRATION_TAB_ID;

  if (openFiles.length === 0 && !hasDesignPreview) {
    return (
      <div className="h-full flex items-center justify-center bg-studio-bg">
        <div className="text-center text-studio-muted">
          <svg className="w-16 h-16 mx-auto mb-4 opacity-30" viewBox="0 0 24 24" fill="currentColor">
            <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z" />
          </svg>
          <p className="text-sm">No file open</p>
          <p className="text-xs mt-1">Select a file from the explorer</p>
        </div>
      </div>
    );
  }

  // Get current file state
  const isLoading = !showDesignPreview && activeFile ? loading[activeFile] : false;
  const isSaving = !showDesignPreview && activeFile ? saving[activeFile] : false;
  const error = activeFile ? errors[activeFile] : '';
  const content = activeFile ? fileContents[activeFile] : '';

  // Build tabs: Design Preview (if applicable) + file tabs + virtual tabs
  const tabs: { id: string; label: string; isDesign?: boolean; isInternals?: boolean; isSwarmOrchestration?: boolean }[] = [];
  if (hasDesignPreview) {
    tabs.push({ id: DESIGN_PREVIEW_TAB, label: 'Plan Preview', isDesign: true });
  }
  openFiles.forEach((file) => {
    if (file === INTERNALS_TAB_ID) {
      tabs.push({ id: INTERNALS_TAB_ID, label: 'ATLS Internals', isInternals: true });
    } else if (file === SWARM_ORCHESTRATION_TAB_ID) {
      tabs.push({ id: SWARM_ORCHESTRATION_TAB_ID, label: 'Swarm Orchestration', isSwarmOrchestration: true });
    } else {
      tabs.push({ id: file, label: file.split(/[/\\]/).pop() || file });
    }
  });

  return (
    <div className="h-full flex flex-col bg-studio-bg">
      {/* Tab Bar */}
      <div className="flex items-center bg-studio-surface border-b border-studio-border overflow-x-auto scrollbar-thin">
        {tabs.map((tab) => {
          const isActive = tab.isDesign
            ? designPreviewTabActive
            : tab.id === activeFile && !designPreviewTabActive;
          const isVirtual = tab.isDesign || tab.isInternals || tab.isSwarmOrchestration;
          const fileIsDirty = !isVirtual && isDirty(tab.id);
          const fileIsSaving = !isVirtual && saving[tab.id];
          
          return (
            <div
              key={tab.id}
              className={`
                flex items-center gap-2 px-3 py-2 border-r border-studio-border
                cursor-pointer group shrink-0
                ${isActive 
                  ? 'bg-studio-bg text-studio-text border-t-2 border-t-studio-accent' 
                  : 'bg-studio-surface text-studio-muted hover:bg-studio-border/30'
                }
              `}
              onClick={() => {
                if (tab.isDesign) {
                  setDesignPreviewTabActive(true);
                } else {
                  setDesignPreviewTabActive(false);
                  setActiveFile(tab.id);
                }
              }}
            >
              {/* Swarm tab icon */}
              {tab.isSwarmOrchestration && (
                <span className="text-sm">🐝</span>
              )}
              {/* Internals tab icon */}
              {tab.isInternals && (
                <svg className="w-3.5 h-3.5 text-studio-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                </svg>
              )}
              {/* Dirty/Saving indicator */}
              {fileIsSaving ? (
                <span className="w-2 h-2 rounded-full bg-studio-warning animate-pulse" title="Saving..." />
              ) : fileIsDirty ? (
                <span className="w-2 h-2 rounded-full bg-studio-accent" title="Unsaved changes" />
              ) : null}
              
              <span className="text-sm">
                {tab.label}
                {fileIsDirty && !fileIsSaving && <span className="ml-1 text-studio-accent">*</span>}
              </span>
              {/* Hide close button for swarm tab while active */}
              {!(tab.isSwarmOrchestration && swarmActive) && (
                <button
                  className={`
                    p-0.5 rounded hover:bg-studio-border
                    ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
                  `}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (tab.isDesign) {
                      useAppStore.getState().clearDesignPreview();
                      setDesignPreviewTabActive(false);
                      const fallbackFile = openFiles.find((file) => file !== tab.id);
                      if (fallbackFile) {
                        setActiveFile(fallbackFile);
                      }
                    } else {
                      handleCloseFile(tab.id);
                    }
                  }}
                >
                  <CloseIcon className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Main Editor Area */}
      <div className="flex-1 flex min-h-0">
        {/* Editor, Plan Preview, Swarm Orchestration, or ATLS Internals */}
        <div className="flex-1 flex flex-col relative min-h-0 overflow-hidden">
          {isSwarmTabActive ? (
            <SwarmErrorBoundary>
              <SwarmPanel />
            </SwarmErrorBoundary>
          ) : isInternalsActive ? (
            <AtlsInternals />
          ) : showDesignPreview ? (
            <div className="flex-1 overflow-y-auto p-4 markdown-message">
              <MarkdownMessage content={designPreviewContent} />
            </div>
          ) : (
            <>
              {activeFile && isLoading && (
                <div className="h-full flex items-center justify-center bg-studio-bg">
                  <div className="text-center text-studio-muted">
                    <div className="w-8 h-8 border-2 border-studio-accent border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                    <p className="text-sm">Loading file...</p>
                  </div>
                </div>
              )}
              
              {activeFile && error && !isLoading && (
                <div className="h-full flex items-center justify-center bg-studio-bg">
                  <div className="text-center text-studio-error">
                    <svg className="w-12 h-12 mx-auto mb-2 opacity-50" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
                    </svg>
                    <p className="text-sm">{error}</p>
                    <button
                      type="button"
                      className="mt-3 px-3 py-1.5 text-sm rounded bg-studio-surface border border-studio-border hover:bg-studio-border/50 text-studio-text"
                      onClick={() => {
                        const normalizedPath = normalizePath(activeFile);
                        setErrors(prev => ({ ...prev, [activeFile]: '', [normalizedPath]: '' }));
                        setLoading(prev => ({ ...prev, [activeFile]: false, [normalizedPath]: false }));
                        setFileContents(prev => {
                          const next = { ...prev };
                          delete next[activeFile];
                          delete next[normalizedPath];
                          return next;
                        });
                        setOriginalContents(prev => {
                          const next = { ...prev };
                          delete next[activeFile];
                          delete next[normalizedPath];
                          return next;
                        });
                      }}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}
              
              {activeFile && !isLoading && !error && (
                <>
                  <Editor
                    height="100%"
                    language={getLanguage(activeFile)}
                    value={content || ''}
                    onChange={(value) => handleContentChange(value, activeFile)}
                    onMount={handleEditorMount}
                    theme={editorTheme}
                    options={{
                      readOnly: false,
                      minimap: { enabled: false },
                      fontSize: 13,
                      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                      lineNumbers: 'on',
                      renderLineHighlight: 'line',
                      scrollBeyondLastLine: false,
                      automaticLayout: false,
                    }}
                  />
                  
                  {/* Saving indicator overlay */}
                  {isSaving && (
                    <div className="absolute bottom-4 right-4 bg-studio-surface border border-studio-border px-3 py-1.5 rounded-lg flex items-center gap-2 shadow-lg">
                      <div className="w-4 h-4 border-2 border-studio-accent border-t-transparent rounded-full animate-spin" />
                      <span className="text-xs text-studio-muted">Saving...</span>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* References Panel */}
        {refsState.isOpen && (
          <div className="w-64 border-l border-studio-border bg-studio-surface flex flex-col">
            <div className="flex items-center justify-between p-2 border-b border-studio-border">
              <span className="text-xs font-medium">
                Usages: <span className="text-studio-accent">{refsState.symbol}</span>
              </span>
              <button
                onClick={() => setRefsState({ isOpen: false, symbol: '', references: [] })}
                className="p-1 text-studio-muted hover:text-studio-text rounded"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {refsState.references.length === 0 ? (
                <div className="p-4 text-center text-studio-muted text-xs">
                  No usages found
                </div>
              ) : (
                refsState.references.map((ref, index) => {
                  const filename = ref.file.split(/[/\\]/).pop() || ref.file;
                  return (
                    <div
                      key={`${ref.file}:${ref.line}:${index}`}
                      className="px-2 py-1.5 hover:bg-studio-border/50 cursor-pointer"
                      onClick={() => handleReferenceClick(ref)}
                    >
                      <div className="text-xs truncate">{filename}</div>
                      <div className="text-xs text-studio-muted flex items-center gap-2">
                        <span>Line {ref.line}</span>
                        {ref.kind && (
                          <span className="px-1 bg-studio-accent/20 text-studio-accent rounded">
                            {ref.kind}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="p-2 border-t border-studio-border text-xs text-studio-muted">
              {refsState.references.length} usages
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default CodeViewer;
