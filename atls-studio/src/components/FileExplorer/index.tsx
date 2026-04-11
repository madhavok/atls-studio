import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore, FileNode, type WorkspaceEntry } from '../../stores/appStore';
import { useAttachmentStore, setInternalDragPayload, consumeInternalDragPayload } from '../../stores/attachmentStore';
import { useAtls } from '../../hooks/useAtls';
import { getTerminalStore } from '../../stores/terminalStore';
import {
  FolderIcon, FileIcon, ChevronIcon, PinIcon,
  CopyIcon, OpenIcon, RevealIcon, DeleteIcon, RefreshIcon,
  RenameIcon, NewFileIcon, NewFolderIcon, CutIcon, PasteIcon,
  CollapseIcon, ChatIcon, IgnoreIcon, PlayIcon, StopIcon,
  DragHandleIcon, IgnoredIndicatorIcon,
} from './icons';
import {
  filterFileNodesByQuery,
  flattenVisiblePaths,
  isImageFile,
} from './fileExplorerTreeUtils';
import {
  effectiveContextMenuPaths,
  parentPathForRename,
  pathsToRelativeClipboardText,
  resolveRootFolderForMenuPath,
  workspaceEntryAbsPath,
} from './fileExplorerPaths';

// --- Context menu state ---
interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  name: string;
  type: 'file' | 'directory';
  ignored?: boolean;
}

// Inline editing state (rename or new file/folder)
interface InlineEditState {
  parentPath: string;          // directory path where the input appears
  nodePath?: string;           // existing node path (for rename)
  mode: 'rename' | 'newFile' | 'newFolder';
  initialValue: string;
}


// --- Menu button helper ---
const MENU_BTN = "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-studio-text hover:bg-studio-border/50 transition-colors text-left";
const MENU_DANGER = "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-studio-error hover:bg-studio-error/10 transition-colors text-left";
const MENU_SEP = "border-t border-studio-border my-1";

// --- Context Menu ---
interface ContextMenuProps {
  menu: ContextMenuState;
  projectPath: string;
  selectedPaths: Set<string>;
  clipboardPaths: string[];
  clipboardMode: 'copy' | 'cut' | null;
  onClose: () => void;
  onOpen: (path: string) => void;
  onDelete: (paths: string[]) => void;
  onRename: (path: string, name: string) => void;
  onNewFile: (dirPath: string) => void;
  onNewFolder: (dirPath: string) => void;
  onCut: (paths: string[]) => void;
  onCopy: (paths: string[]) => void;
  onPaste: (destDir: string) => void;
  onCollapseAll: () => void;
  onAddToChat: (paths: string[]) => void;
  onAddToIgnore: (paths: string[], rootPath: string) => void;
  onRemoveFromIgnore: (paths: string[], rootPath: string) => void;
  rootFolders: string[];
}

function ContextMenu({
  menu, projectPath, selectedPaths, clipboardPaths, clipboardMode,
  onClose, onOpen, onDelete, onRename, onNewFile, onNewFolder,
  onCut, onCopy, onPaste, onCollapseAll, onAddToChat, onAddToIgnore, onRemoveFromIgnore,
  rootFolders,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  /** Root that contains menu.path (for multi-root workspaces) */
  const rootForPath = useMemo(
    () => resolveRootFolderForMenuPath(menu.path, projectPath, rootFolders),
    [menu.path, projectPath, rootFolders],
  );

  // Determine effective paths: if right-clicked item is in selection, use full selection
  const effectivePaths = useMemo(
    () => effectiveContextMenuPaths(menu.path, selectedPaths),
    [menu.path, selectedPaths],
  );

  const isMulti = effectivePaths.length > 1;
  const hasIgnoredInSelection = menu.ignored;
  const hasFilesInSelection = isMulti
    ? effectivePaths.some(p => !p.endsWith('/') && !p.endsWith('\\'))
    : menu.type === 'file';

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleCopyPath = async () => {
    try { await writeText(effectivePaths.join('\n')); } catch (e) { console.error('Failed to copy path:', e); }
    onClose();
  };
  const handleCopyRelativePath = async () => {
    try {
      await writeText(pathsToRelativeClipboardText(effectivePaths, projectPath));
    } catch (e) { console.error('Failed to copy relative path:', e); }
    onClose();
  };
  const handleReveal = async () => {
    try { await revealItemInDir(menu.path); } catch (e) { console.error('Failed to reveal:', e); }
    onClose();
  };
  const handleDelete = async () => {
    const label = isMulti ? `${effectivePaths.length} items` : `"${menu.name}"`;
    const confirmed = await tauriConfirm(
      `Are you sure you want to delete ${label}?`,
      { title: 'Confirm Delete', kind: 'warning' }
    );
    if (confirmed) onDelete(effectivePaths);
    onClose();
  };

  // Position within viewport
  const adjustedX = Math.min(menu.x, window.innerWidth - 220);
  const adjustedY = Math.min(menu.y, window.innerHeight - 400);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-studio-surface border border-studio-border rounded-lg shadow-xl py-1 min-w-[200px]"
      style={{ left: adjustedX, top: adjustedY }}
    >
      <div className="px-3 py-1.5 text-xs text-studio-muted border-b border-studio-border truncate max-w-[220px]" title={isMulti ? `${effectivePaths.length} items` : menu.name}>
        {isMulti ? `${effectivePaths.length} items selected` : menu.name}
      </div>

      {/* Group 1: Open + Add to Chat */}
      {menu.type === 'file' && !isMulti && (
        <button className={MENU_BTN} onClick={() => { onOpen(menu.path); onClose(); }}>
          <OpenIcon /> Open
        </button>
      )}
      {hasFilesInSelection && (
        <button className={MENU_BTN} onClick={() => { onAddToChat(effectivePaths); onClose(); }}>
          <ChatIcon /> Add to Chat{isMulti ? ` (${effectivePaths.length})` : ''}
        </button>
      )}

      <div className={MENU_SEP} />

      {/* Group 2: New File / New Folder (only on directory context or single item) */}
      {menu.type === 'directory' && !isMulti && (
        <>
          <button className={MENU_BTN} onClick={() => { onNewFile(menu.path); onClose(); }}>
            <NewFileIcon /> New File
          </button>
          <button className={MENU_BTN} onClick={() => { onNewFolder(menu.path); onClose(); }}>
            <NewFolderIcon /> New Folder
          </button>
          <div className={MENU_SEP} />
        </>
      )}

      {/* Group 3: Cut / Copy / Paste */}
      <button className={MENU_BTN} onClick={() => { onCut(effectivePaths); onClose(); }}>
        <CutIcon /> Cut
      </button>
      <button className={MENU_BTN} onClick={() => { onCopy(effectivePaths); onClose(); }}>
        <CopyIcon /> Copy
      </button>
      {menu.type === 'directory' && clipboardPaths.length > 0 && (
        <button className={MENU_BTN} onClick={() => { onPaste(menu.path); onClose(); }}>
          <PasteIcon /> Paste{clipboardMode === 'cut' ? ' (Move)' : ''}
        </button>
      )}

      <div className={MENU_SEP} />

      {/* Group 4: Copy Path */}
      <button className={MENU_BTN} onClick={handleCopyPath}>
        <CopyIcon /> Copy Path
      </button>
      <button className={MENU_BTN} onClick={handleCopyRelativePath}>
        <CopyIcon /> Copy Relative Path
      </button>

      <div className={MENU_SEP} />

      {/* Group 5: Rename + Reveal */}
      {!isMulti && (
        <button className={MENU_BTN} onClick={() => { onRename(menu.path, menu.name); onClose(); }}>
          <RenameIcon /> Rename
        </button>
      )}
      <button className={MENU_BTN} onClick={handleReveal}>
        <RevealIcon /> Reveal in Explorer
      </button>
      {hasIgnoredInSelection ? (
        <button
          className={MENU_BTN}
          onClick={() => {
            onRemoveFromIgnore(effectivePaths, rootForPath);
            onClose();
          }}
        >
          <IgnoreIcon /> {menu.type === 'directory' ? 'Unignore Folder' : 'Unignore File'}
          {isMulti ? ` (${effectivePaths.length})` : ''}
        </button>
      ) : (
        <button
          className={MENU_BTN}
          onClick={() => {
            onAddToIgnore(effectivePaths, rootForPath);
            onClose();
          }}
        >
          <IgnoreIcon /> {menu.type === 'directory' ? 'Ignore Folder' : 'Ignore File'}
          {isMulti ? ` (${effectivePaths.length})` : ''}
        </button>
      )}

      <div className={MENU_SEP} />

      {/* Group 6: Collapse All */}
      <button className={MENU_BTN} onClick={() => { onCollapseAll(); onClose(); }}>
        <CollapseIcon /> Collapse All
      </button>

      <div className={MENU_SEP} />

      {/* Group 7: Delete */}
      <button className={MENU_DANGER} onClick={handleDelete}>
        <DeleteIcon /> Delete{isMulti ? ` (${effectivePaths.length})` : ''}
      </button>
    </div>
  );
}

// --- Inline edit input (rename / new file / new folder) ---
interface InlineInputProps {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  level: number;
  icon: React.ReactNode;
}

function InlineInput({ initialValue, onCommit, onCancel, level, icon }: InlineInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      // Select filename without extension for rename
      const dotIdx = initialValue.lastIndexOf('.');
      if (dotIdx > 0) {
        inputRef.current.setSelectionRange(0, dotIdx);
      } else {
        inputRef.current.select();
      }
    }
  }, [initialValue]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      const trimmed = value.trim();
      if (trimmed && trimmed !== initialValue) onCommit(trimmed);
      else onCancel();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div
      className="flex items-center gap-1 py-0.5 px-2"
      style={{ paddingLeft: level * 12 + 8 }}
    >
      {icon}
      <input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          const trimmed = value.trim();
          if (trimmed && trimmed !== initialValue) onCommit(trimmed);
          else onCancel();
        }}
        className="flex-1 text-sm bg-studio-bg border border-studio-accent rounded px-1 py-0 focus:outline-none text-studio-text min-w-0"
      />
    </div>
  );
}

// --- Background (empty-space) context menu ---
interface BackgroundContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onAddFolder: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onCollapseAll: () => void;
  onRefresh: () => void;
  onRevealProjectRoot?: () => void;
}

function BackgroundContextMenu({ x, y, onClose, onAddFolder, onNewFile, onNewFolder, onPaste, canPaste, onCollapseAll, onRefresh, onRevealProjectRoot }: BackgroundContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const adjustedX = Math.min(x, window.innerWidth - 220);
  const adjustedY = Math.min(y, window.innerHeight - 200);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-studio-surface border border-studio-border rounded-lg shadow-xl py-1 min-w-[200px]"
      style={{ left: adjustedX, top: adjustedY }}
    >
      <button className={MENU_BTN} onClick={() => { onNewFile(); onClose(); }}>
        <NewFileIcon /> New File
      </button>
      <button className={MENU_BTN} onClick={() => { onNewFolder(); onClose(); }}>
        <NewFolderIcon /> New Folder
      </button>
      {canPaste && (
        <button className={MENU_BTN} onClick={() => { onPaste(); onClose(); }}>
          <PasteIcon /> Paste
        </button>
      )}
      <div className={MENU_SEP} />
      <button className={MENU_BTN} onClick={() => { onRefresh(); onClose(); }}>
        <RefreshIcon /> Refresh
      </button>
      <button className={MENU_BTN} onClick={() => { onCollapseAll(); onClose(); }}>
        <CollapseIcon /> Collapse All
      </button>
      {onRevealProjectRoot && (
        <button className={MENU_BTN} onClick={() => { onRevealProjectRoot(); onClose(); }}>
          <RevealIcon /> Reveal Project in Explorer
        </button>
      )}
      <div className={MENU_SEP} />
      <button className={MENU_BTN} onClick={() => { onAddFolder(); onClose(); }}>
        <NewFolderIcon /> Add Folder to Workspace...
      </button>
    </div>
  );
}

// --- Root header context menu ---
interface RootHeaderContextMenuProps {
  x: number;
  y: number;
  rootPath: string;
  onClose: () => void;
  onRemoveFolder: (path: string) => void;
  onNewFile: (dirPath: string) => void;
  onNewFolder: (dirPath: string) => void;
  onPaste: (destDir: string) => void;
  canPaste: boolean;
  onReveal: (path: string) => void;
  onCollapseAll: () => void;
}

function RootHeaderContextMenu({ x, y, rootPath, onClose, onRemoveFolder, onNewFile, onNewFolder, onPaste, canPaste, onReveal, onCollapseAll }: RootHeaderContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const adjustedX = Math.min(x, window.innerWidth - 220);
  const adjustedY = Math.min(y, window.innerHeight - 150);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-studio-surface border border-studio-border rounded-lg shadow-xl py-1 min-w-[220px]"
      style={{ left: adjustedX, top: adjustedY }}
    >
      <button className={MENU_BTN} onClick={() => { onNewFile(rootPath); onClose(); }}>
        <NewFileIcon /> New File
      </button>
      <button className={MENU_BTN} onClick={() => { onNewFolder(rootPath); onClose(); }}>
        <NewFolderIcon /> New Folder
      </button>
      {canPaste && (
        <button className={MENU_BTN} onClick={() => { onPaste(rootPath); onClose(); }}>
          <PasteIcon /> Paste
        </button>
      )}
      <div className={MENU_SEP} />
      <button className={MENU_BTN} onClick={() => { onReveal(rootPath); onClose(); }}>
        <RevealIcon /> Reveal in Explorer
      </button>
      <button className={MENU_BTN} onClick={() => { onCollapseAll(); onClose(); }}>
        <CollapseIcon /> Collapse All
      </button>
      <div className={MENU_SEP} />
      <button className={MENU_DANGER} onClick={() => { onRemoveFolder(rootPath); onClose(); }}>
        <DeleteIcon /> Remove Folder from Workspace
      </button>
    </div>
  );
}

// --- FileTree ---
interface FileTreeProps {
  nodes: FileNode[];
  level?: number;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  allVisiblePaths: string[];
  inlineEdit: InlineEditState | null;
  onInlineCommit: (value: string) => void;
  onInlineCancel: () => void;
}

function FileTree({ nodes, level = 0, onContextMenu, allVisiblePaths, inlineEdit, onInlineCommit, onInlineCancel }: FileTreeProps) {
  const {
    expandedFolders, toggleFolder, openFile,
    selectedFiles, toggleFileSelection,
    clipboardPaths, clipboardMode,
  } = useAppStore();

  return (
    <div className="select-none">
      {nodes.map((node) => {
        const isExpanded = expandedFolders.has(node.path);
        const isSelected = selectedFiles.has(node.path);
        const isCut = clipboardMode === 'cut' && clipboardPaths.includes(node.path);

        // Check if this node is being renamed
        const isRenaming = inlineEdit?.mode === 'rename' && inlineEdit.nodePath === node.path;

        return (
          <div key={node.path}>
            {isRenaming ? (
              <InlineInput
                initialValue={node.name}
                onCommit={onInlineCommit}
                onCancel={onInlineCancel}
                level={level}
                icon={node.type === 'directory'
                  ? <FolderIcon open={isExpanded} />
                  : <FileIcon language={node.language} />
                }
              />
            ) : (
              <div
                className={`
                  flex items-center gap-1 py-0.5 px-2 cursor-pointer rounded
                  hover:bg-studio-border/50
                  ${isSelected ? 'bg-studio-accent/20 text-studio-accent' : ''}
                  ${isCut ? 'opacity-50' : ''}
                `}
                style={{ paddingLeft: level * 12 + 8 }}
                draggable
                onDragStart={(e) => {
                  // If dragged item is in selection, drag all selected; otherwise just this one
                  const paths = selectedFiles.has(node.path) && selectedFiles.size > 1
                    ? Array.from(selectedFiles)
                    : [node.path];
                  const payload = paths.map(p => {
                    const n = p.split(/[/\\]/).pop() || p;
                    // For the dragged node, use its known type; for other selected items, look up in tree
                    const itemType = p === node.path ? node.type : (() => {
                      const findType = (searchNodes: FileNode[]): string => {
                        for (const nd of searchNodes) {
                          if (nd.path === p) return nd.type;
                          if (nd.children) { const f = findType(nd.children); if (f) return f; }
                        }
                        return '';
                      };
                      return findType(nodes) || 'file';
                    })();
                    return { path: p, name: n, type: itemType };
                  });
                  // Store in shared module-level variable (WebView2 blocks dataTransfer)
                  setInternalDragPayload(payload);
                  // Signal the chat panel to show its drop overlay
                  useAttachmentStore.getState().setInternalDragActive(true);
                  // Also set dataTransfer as fallback
                  try {
                    e.dataTransfer.setData('application/x-atls-files', JSON.stringify(payload));
                    e.dataTransfer.setData('text/plain', paths.join('\n'));
                  } catch { /* WebView2 may block this */ }
                  e.dataTransfer.effectAllowed = 'copy';
                  // Custom drag ghost showing file count
                  const ghost = document.createElement('div');
                  ghost.style.cssText = 'position:fixed;top:-200px;left:-200px;padding:6px 12px;background:#2563eb;color:#fff;border-radius:6px;font-size:12px;white-space:nowrap;pointer-events:none;z-index:9999;';
                  ghost.textContent = payload.length > 1 ? `${payload.length} files` : (payload[0]?.name || 'file');
                  document.body.appendChild(ghost);
                  e.dataTransfer.setDragImage(ghost, 0, 0);
                  requestAnimationFrame(() => document.body.removeChild(ghost));
                }}
                onDragEnd={(e) => {
                  // Clear the drag overlay on the chat panel
                  useAttachmentStore.getState().setInternalDragActive(false);
                  // WebView2 blocks HTML5 onDrop on the target, so we detect
                  // the drop location from the source side using elementFromPoint.
                  const payload = consumeInternalDragPayload();
                  if (!payload || payload.length === 0) return;
                  
                  const target = document.elementFromPoint(e.clientX, e.clientY);
                  if (!target) return;
                  const chatPanel = target.closest('[data-drop-target="chat"]');
                  if (!chatPanel) return;
                  
                  // Dropped over the chat panel -- add files as attachments
                  const store = useAttachmentStore.getState();
                  for (const item of payload) {
                    if (item.type === 'directory') continue;
                    if (isImageFile(item.name)) {
                      invoke<{ data: string; media_type: string }>('read_file_as_base64', { path: item.path })
                        .then(result => store.addImageAttachment(item.name, item.path, result.data, result.media_type))
                        .catch(err => console.error('Failed to read image:', err));
                    } else {
                      store.addFileAttachment(item.name, item.path);
                    }
                  }
                }}
                onClick={(e) => {
                  if (node.type === 'directory') {
                    toggleFolder(node.path);
                  }
                  // Always handle selection
                  toggleFileSelection(node.path, e.ctrlKey || e.metaKey, e.shiftKey, allVisiblePaths);
                  // Open file on plain click
                  if (node.type === 'file' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                    openFile(node.path);
                  }
                }}
                onContextMenu={(e) => onContextMenu(e, node)}
              >
                {node.type === 'directory' && <ChevronIcon open={isExpanded} />}
                {node.type === 'directory'
                  ? <FolderIcon open={isExpanded} />
                  : <FileIcon language={node.language} />
                }
                <span className="text-sm truncate flex-1 min-w-0">{node.name}</span>
                {node.ignored && <IgnoredIndicatorIcon />}
              </div>
            )}

            {/* Inline new file/folder input: appears as first child of this directory */}
            {node.type === 'directory' && isExpanded && inlineEdit &&
              (inlineEdit.mode === 'newFile' || inlineEdit.mode === 'newFolder') &&
              inlineEdit.parentPath === node.path && (
                <InlineInput
                  initialValue=""
                  onCommit={onInlineCommit}
                  onCancel={onInlineCancel}
                  level={level + 1}
                  icon={inlineEdit.mode === 'newFolder'
                    ? <FolderIcon open={false} />
                    : <FileIcon />
                  }
                />
              )}

            {node.type === 'directory' && isExpanded && node.children && (
              <FileTree
                nodes={node.children}
                level={level + 1}
                onContextMenu={onContextMenu}
                allVisiblePaths={allVisiblePaths}
                inlineEdit={inlineEdit}
                onInlineCommit={onInlineCommit}
                onInlineCancel={onInlineCancel}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Workspace script dropdown (with pin toggles) ---
function WorkspaceScriptDropdown({
  absPath,
  onSelect,
  onClose,
  pinnedForWs,
  onTogglePin,
}: {
  absPath: string;
  onSelect: (scriptName: string) => void;
  onClose: () => void;
  pinnedForWs: string[];
  onTogglePin: (wsPath: string, scriptName: string, add: boolean) => void;
}) {
  const [scripts, setScripts] = useState<Array<{ name: string; cmd: string }>>([]);
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const pinnedSet = useMemo(() => new Set(pinnedForWs), [pinnedForWs]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  useEffect(() => {
    let cancelled = false;
    invoke<{ scripts: Array<{ name: string; cmd: string }> }>('atls_get_workspace_scripts', { absPath })
      .then(r => { if (!cancelled) setScripts(r.scripts ?? []); })
      .catch(() => { if (!cancelled) setScripts([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [absPath]);

  return (
    <div ref={ref} className="min-w-[160px]">
      {loading && <div className="px-3 py-2 text-xs text-studio-muted">Loading...</div>}
      {!loading && !scripts.length && (
        <div className="px-3 py-2 text-xs text-studio-muted">No scripts</div>
      )}
      {!loading && scripts.map(s => {
        const isPinned = pinnedSet.has(s.name);
        return (
          <div key={s.name} className="flex items-center group">
            <button
              onClick={() => onSelect(s.name)}
              className="flex-1 text-left px-3 py-1.5 text-xs text-studio-text hover:bg-studio-accent/10 transition-colors truncate"
              title={`Run: ${s.name}`}
            >
              {s.name}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onTogglePin(absPath, s.name, !isPinned); }}
              className={`p-1 mr-1 rounded transition-colors ${isPinned ? 'text-studio-accent opacity-100' : 'text-studio-muted opacity-30 hover:opacity-70'} hover:bg-studio-border/50`}
              title={isPinned ? 'Unpin from custom view' : 'Pin to custom view'}
            >
              <PinIcon filled={isPinned} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// --- Workspaces section block (draggable, reusable) ---
export function WorkspacesSectionBlock({
  workspaces,
  workspacesSectionExpanded,
  setWorkspacesSectionExpanded,
  workspaceToTerminal,
  scriptDropdownOpen,
  setScriptDropdownOpen,
  getWorkspaceAbsPath,
  handleWorkspaceStart,
  handleWorkspaceStop,
  draggable,
  onDragStart,
  height,
  scriptViewMode,
  setScriptViewMode,
  pinnedScripts,
  onTogglePin,
  onDismissError,
}: {
  workspaces: WorkspaceEntry[];
  workspacesSectionExpanded: boolean;
  setWorkspacesSectionExpanded: (fn: (prev: boolean) => boolean) => void;
  workspaceToTerminal: Record<string, { terminalId: string; status: 'running' | 'stopped' | 'errored' }>;
  scriptDropdownOpen: string | null;
  setScriptDropdownOpen: (v: string | null) => void;
  getWorkspaceAbsPath: (ws: WorkspaceEntry) => string;
  handleWorkspaceStart: (ws: WorkspaceEntry, scriptName?: string) => void;
  handleWorkspaceStop: (ws: WorkspaceEntry) => void;
  draggable: boolean;
  onDragStart: (e: React.DragEvent) => void;
  height: number;
  scriptViewMode: 'all' | 'custom';
  setScriptViewMode: (v: 'all' | 'custom') => void;
  pinnedScripts: Record<string, string[]>;
  onTogglePin: (wsPath: string, scriptName: string, add: boolean) => void;
  onDismissError: (wsPath: string) => void;
}) {
  const visibleWorkspaces = useMemo(() => {
    if (scriptViewMode === 'all') return workspaces;
    return workspaces.filter(ws => {
      const absPath = getWorkspaceAbsPath(ws);
      const pins = pinnedScripts[absPath];
      return pins && pins.length > 0;
    });
  }, [workspaces, scriptViewMode, pinnedScripts, getWorkspaceAbsPath]);

  return (
    <div className="border-t border-studio-border flex flex-col flex-shrink-0 overflow-hidden" style={{ height }}>
      <div
        className={`flex items-center gap-1 px-2 py-1.5 cursor-pointer select-none hover:bg-studio-border/30 transition-colors ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
        onClick={() => setWorkspacesSectionExpanded(prev => !prev)}
        draggable={draggable}
        onDragStart={e => { e.stopPropagation(); onDragStart(e); }}
        title={draggable ? 'Drag to reorder sections (drop in upper/lower half)' : undefined}
      >
        {draggable && (
          <span className="opacity-60 hover:opacity-100" title="Drag to reorder">
            <DragHandleIcon />
          </span>
        )}
        <ChevronIcon open={workspacesSectionExpanded} />
        <span className="text-xs font-semibold text-studio-title uppercase tracking-wide">Workspaces</span>
      </div>
      {workspacesSectionExpanded && (
        <div className="flex-1 min-h-[60px] flex flex-col overflow-hidden">
          <div className="flex-shrink-0 px-2 py-1.5 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setScriptViewMode('all')}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${scriptViewMode === 'all' ? 'bg-studio-accent/20 text-studio-accent' : 'text-studio-muted hover:bg-studio-border/30 hover:text-studio-text'}`}
              title="Show all workspaces and scripts"
            >
              All
            </button>
            <button
              onClick={() => setScriptViewMode('custom')}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${scriptViewMode === 'custom' ? 'bg-studio-accent/20 text-studio-accent' : 'text-studio-muted hover:bg-studio-border/30 hover:text-studio-text'}`}
              title="Show only workspaces with pinned scripts"
            >
              Custom
            </button>
          </div>
          <div className="flex-1 min-h-0 px-2 pb-2 overflow-y-auto scrollbar-thin">
          {workspaces.length === 0 ? (
            <p className="text-xs text-studio-muted py-2">No workspaces detected. Scan project to refresh.</p>
          ) : visibleWorkspaces.length === 0 && scriptViewMode === 'custom' ? (
            <p className="text-xs text-studio-muted py-2">No pinned scripts yet. Switch to All, open a script dropdown, and pin scripts.</p>
          ) : (
            <div className="space-y-1.5">
              {visibleWorkspaces.map((ws) => {
                const absPath = getWorkspaceAbsPath(ws);
                const wsEntry = workspaceToTerminal[absPath];
                const isRunning = wsEntry?.status === 'running';
                const isErrored = wsEntry?.status === 'errored';
                const dropdownOpen = scriptDropdownOpen === absPath;
                const wsPins = pinnedScripts[absPath] ?? [];
                return (
                  <div key={ws.name} className={`rounded border ${isErrored ? 'bg-studio-error/5 border-studio-error/30' : 'bg-studio-surface/50 border-studio-border/50'}`}>
                    <div className="flex items-center gap-2 py-1.5 px-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {isRunning && (
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" title="Running" aria-label="Running" />
                          )}
                          {isErrored && (
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" title="Exited with error" aria-label="Error" />
                          )}
                          <span className="text-xs font-medium text-studio-text truncate" title={ws.name}>{ws.name}</span>
                          <div className="flex gap-0.5 shrink-0">
                            {ws.types.slice(0, 2).map(t => (
                              <span key={t} className="text-[10px] px-1 py-0.5 rounded bg-studio-accent/10 text-studio-accent">{t}</span>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 relative">
                        {isRunning ? (
                          <button
                            onClick={() => handleWorkspaceStop(ws)}
                            className="p-1 rounded hover:bg-studio-error/20 text-studio-error transition-colors"
                            title="Stop"
                          >
                            <StopIcon />
                          </button>
                        ) : (
                          <>
                            {isErrored && (
                              <button
                                onClick={() => onDismissError(absPath)}
                                className="p-1 rounded hover:bg-studio-border/50 text-studio-muted hover:text-studio-text transition-colors text-[10px]"
                                title="Dismiss error"
                              >
                                ×
                              </button>
                            )}
                            <button
                              onClick={() => { if (isErrored) onDismissError(absPath); handleWorkspaceStart(ws); }}
                              className={`p-1 rounded transition-colors ${isErrored ? 'hover:bg-studio-accent/20 text-studio-accent animate-pulse' : 'hover:bg-studio-accent/20 text-studio-accent'}`}
                              title={isErrored ? 'Restart' : 'Start default'}
                            >
                              <PlayIcon />
                            </button>
                            <div className="relative">
                              <button
                                onClick={() => setScriptDropdownOpen(dropdownOpen ? null : absPath)}
                                className="p-1 rounded hover:bg-studio-border/50 text-studio-muted hover:text-studio-text transition-colors text-[10px]"
                                title="Browse scripts (pin from here)"
                              >
                                <ChevronIcon open={dropdownOpen} />
                              </button>
                              {dropdownOpen && (
                                <div className="absolute right-0 top-full mt-0.5 z-20 py-1 bg-studio-bg border border-studio-border rounded shadow-lg min-w-[120px]">
                                  <WorkspaceScriptDropdown
                                    absPath={absPath}
                                    onSelect={(name) => handleWorkspaceStart(ws, name)}
                                    onClose={() => setScriptDropdownOpen(null)}
                                    pinnedForWs={wsPins}
                                    onTogglePin={onTogglePin}
                                  />
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    {/* Pinned scripts shown inline */}
                    {wsPins.length > 0 && (
                      <div className="flex flex-wrap gap-1 px-2 pb-1.5 -mt-0.5">
                        {wsPins.map(scriptName => (
                          <button
                            key={scriptName}
                            onClick={() => handleWorkspaceStart(ws, scriptName)}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-studio-accent/10 text-studio-accent hover:bg-studio-accent/20 transition-colors group"
                            title={`Run ${scriptName}`}
                          >
                            <PlayIcon />
                            <span>{scriptName}</span>
                            <span
                              onClick={(e) => { e.stopPropagation(); onTogglePin(absPath, scriptName, false); }}
                              className="ml-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 cursor-pointer"
                              title="Unpin"
                            >
                              ×
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Main FileExplorer ---
export function FileExplorer() {
  const {
    explorerCollapsed, toggleExplorerCollapsed,
    files, projectPath, projectHistory, openFile, setSelectedFile,
    selectedFiles, clearSelection, expandedFolders, toggleFolder,
    collapseAllFolders,
    clipboardPaths, clipboardMode, setClipboard, clearClipboard,
    rootFolders, rootFileTrees, activeRoot, addToast,
    projectProfile, setTerminalOpen,
  } = useAppStore();
  const { addFileAttachment } = useAttachmentStore();
  const { newProject, openProjectWithPicker, openProject, loadFileTree, addFolderToWorkspace, removeFolderFromWorkspace, refreshAllFileTrees, switchActiveRoot, scanProject } = useAtls();
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [bgContextMenu, setBgContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [rootHeaderMenu, setRootHeaderMenu] = useState<{ x: number; y: number; rootPath: string } | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set());
  const [workspacesSectionExpanded, setWorkspacesSectionExpanded] = useState(true);
  const [workspaceToTerminal, setWorkspaceToTerminal] = useState<Record<string, { terminalId: string; status: 'running' | 'stopped' | 'errored' }>>({});
  const [scriptDropdownOpen, setScriptDropdownOpen] = useState<string | null>(null);
  const [workspacesSectionFirst, setWorkspacesSectionFirst] = useState(() => {
    try {
      return localStorage.getItem('explorer-workspaces-first') === 'true';
    } catch { return false; }
  });
  const [workspacesSectionHeight, setWorkspacesSectionHeight] = useState(() => {
    try {
      const v = localStorage.getItem('explorer-workspaces-height');
      return v ? Math.max(80, Math.min(500, parseInt(v, 10) || 192)) : 192;
    } catch { return 192; }
  });
  const [scriptViewMode, setScriptViewMode] = useState<'all' | 'custom'>(() => {
    try {
      const v = localStorage.getItem('explorer-workspace-script-view');
      return (v === 'custom' || v === 'all') ? v : 'all';
    } catch { return 'all'; }
  });
  const [pinnedScripts, setPinnedScripts] = useState<Record<string, string[]>>(() => {
    try {
      const raw = localStorage.getItem('explorer-workspace-pinned-scripts-v2');
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch { return {}; }
  });
  const contentAreaRef = useRef<HTMLDivElement>(null);

  const togglePinnedScript = useCallback((wsPath: string, scriptName: string, add: boolean) => {
    setPinnedScripts(prev => {
      const current = prev[wsPath] ?? [];
      let next: string[];
      if (add) {
        next = current.includes(scriptName) ? current : [...current, scriptName];
      } else {
        next = current.filter(n => n !== scriptName);
      }
      const result = { ...prev };
      if (next.length > 0) {
        result[wsPath] = next;
      } else {
        delete result[wsPath];
      }
      return result;
    });
  }, []);

  const handleDismissError = useCallback((wsPath: string) => {
    setWorkspaceToTerminal(prev => {
      const next = { ...prev };
      delete next[wsPath];
      return next;
    });
  }, []);

  const isMultiRoot = rootFolders.length > 1;
  const workspaces = projectProfile?.workspaces ?? [];
  const projectRoot = activeRoot ?? projectPath ?? rootFolders[0] ?? '';

  const filteredFiles = useMemo(
    () => filterFileNodesByQuery(files, searchQuery),
    [files, searchQuery],
  );

  // Refresh
  const handleRefresh = useCallback(async () => {
    if (rootFolders.length > 0) {
      await refreshAllFileTrees();
    } else if (projectPath) {
      await loadFileTree(projectPath);
    }
  }, [rootFolders, refreshAllFileTrees, projectPath, loadFileTree]);

  // Build flat visible path list for Shift+range select
  const allVisiblePaths = useMemo(
    () => flattenVisiblePaths(filteredFiles, expandedFolders),
    [filteredFiles, expandedFolders]
  );

  // --- Context menu handlers ---
  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, path: node.path, name: node.name, type: node.type, ignored: node.ignored });
  }, []);

  const handleCloseContextMenu = useCallback(() => setContextMenu(null), []);

  const handleRevealPath = useCallback(async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch (e) {
      console.error('Failed to reveal path:', e);
      addToast({ type: 'error', message: 'Failed to reveal path in explorer' });
    }
  }, [addToast]);

  const handleOpenFile = useCallback((path: string) => {
    setSelectedFile(path);
    openFile(path);
  }, [openFile, setSelectedFile]);

  const handleDelete = useCallback(async (paths: string[]) => {
    const results: { path: string; ok: boolean; error?: string }[] = [];
    for (const p of paths) {
      try {
        await invoke('delete_path', { path: p });
        results.push({ path: p, ok: true });
      } catch (e) {
        results.push({ path: p, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const succeeded = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);
    if (succeeded > 0) await handleRefresh();
    if (failed.length === 0) {
      addToast({ type: 'success', message: paths.length > 1 ? `Deleted ${paths.length} items` : 'Deleted item', duration: 2000 });
    } else if (succeeded === 0) {
      addToast({ type: 'error', message: `Failed to delete: ${failed[0].error}` });
    } else {
      addToast({ type: 'warning', message: `Deleted ${succeeded} of ${paths.length} items. Failed: ${failed.map(f => f.path.split(/[\/\\]/).pop()).join(', ')}` });
    }
  }, [handleRefresh, addToast]);

  const handleRename = useCallback((path: string, name: string) => {
    setInlineEdit({ parentPath: parentPathForRename(path), nodePath: path, mode: 'rename', initialValue: name });
  }, []);

  const handleNewFile = useCallback((dirPath: string) => {
    // Ensure folder is expanded
    if (!expandedFolders.has(dirPath)) toggleFolder(dirPath);
    setInlineEdit({ parentPath: dirPath, mode: 'newFile', initialValue: '' });
  }, [expandedFolders, toggleFolder]);

  const handleNewFolder = useCallback((dirPath: string) => {
    if (!expandedFolders.has(dirPath)) toggleFolder(dirPath);
    setInlineEdit({ parentPath: dirPath, mode: 'newFolder', initialValue: '' });
  }, [expandedFolders, toggleFolder]);

  const handleInlineCommit = useCallback(async (value: string) => {
    if (!inlineEdit || !projectPath) { setInlineEdit(null); return; }
    try {
      if (inlineEdit.mode === 'rename' && inlineEdit.nodePath) {
        await invoke('rename_path', { oldPath: inlineEdit.nodePath, newName: value });
      } else if (inlineEdit.mode === 'newFile') {
        const sep = inlineEdit.parentPath.includes('/') ? '/' : '\\';
        await invoke('create_file', { path: inlineEdit.parentPath + sep + value });
      } else if (inlineEdit.mode === 'newFolder') {
        const sep = inlineEdit.parentPath.includes('/') ? '/' : '\\';
        await invoke('create_folder', { path: inlineEdit.parentPath + sep + value });
      }
      await handleRefresh();
      if (inlineEdit.mode === 'rename' && inlineEdit.nodePath) {
        addToast({ type: 'success', message: 'Renamed successfully', duration: 2000 });
      } else if (inlineEdit.mode === 'newFile') {
        addToast({ type: 'success', message: 'File created', duration: 2000 });
      } else if (inlineEdit.mode === 'newFolder') {
        addToast({ type: 'success', message: 'Folder created', duration: 2000 });
      }
    } catch (e) {
      console.error('Inline edit failed:', e);
      addToast({ type: 'error', message: `Explorer action failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    setInlineEdit(null);
  }, [inlineEdit, projectPath, handleRefresh, addToast]);

  const handleInlineCancel = useCallback(() => setInlineEdit(null), []);

  // Cut / Copy / Paste
  const handleCut = useCallback((paths: string[]) => setClipboard(paths, 'cut'), [setClipboard]);
  const handleCopy = useCallback((paths: string[]) => setClipboard(paths, 'copy'), [setClipboard]);
  const handlePaste = useCallback(async (destDir: string) => {
    if (!projectPath || clipboardPaths.length === 0 || !clipboardMode) return;
    try {
      for (const src of clipboardPaths) {
        if (clipboardMode === 'cut') {
          const name = src.split(/[/\\]/).pop() || src;
          await invoke('rename_path', { oldPath: src, newName: name, destDir });
        } else {
          await invoke('copy_path', { src, destDir });
        }
      }
      clearClipboard();
      await handleRefresh();
      addToast({ type: 'success', message: clipboardMode === 'cut' ? 'Moved successfully' : 'Copied successfully', duration: 2000 });
    } catch (e) {
      console.error('Paste failed:', e);
      addToast({ type: 'error', message: `Paste failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [projectPath, clipboardPaths, clipboardMode, clearClipboard, handleRefresh, addToast]);

  // Add to chat
  const handleAddToChat = useCallback(async (paths: string[]) => {
    for (const p of paths) {
      const name = p.split(/[/\\]/).pop() || p;
      if (isImageFile(name)) {
        try {
          const result = await invoke<{ data: string; media_type: string }>('read_file_as_base64', { path: p });
          useAttachmentStore.getState().addImageAttachment(
            name, p, result.data, result.media_type
          );
        } catch (e) {
          console.error('Failed to read image:', e, p);
        }
      } else {
        addFileAttachment(name, p);
      }
    }
  }, [addFileAttachment]);


  // Remove from .atlsignore
  const handleRemoveFromIgnore = useCallback(
    async (paths: string[], rootPath: string) => {
      if (!rootPath) {
        addToast({ type: 'error', message: 'No project root—open a project first' });
        return;
      }
      try {
        const affectedRoots = new Set<string>();
        for (const p of paths) {
          const root = rootFolders.find(
            (r) => p.startsWith(r + '/') || p.startsWith(r + '\\') || p === r
          ) ?? rootPath;
          await invoke('remove_from_atlsignore', { path: p, rootPath: root });
          affectedRoots.add(root);
        }
        addToast({ type: 'success', message: 'Removed from .atlsignore', duration: 2000 });
        await handleRefresh();
        for (const root of affectedRoots) scanProject(root, false);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        addToast({ type: 'error', message: `Failed to remove from .atlsignore: ${msg}` });
      }
    },
    [handleRefresh, rootFolders, addToast, scanProject]
  );

  // Add to .atlsignore (adds pattern, refreshes file tree)
  const handleAddToIgnore = useCallback(
    async (paths: string[], rootPath: string) => {
      if (!rootPath) {
        addToast({ type: 'error', message: 'No project root—open a project first' });
        return;
      }
      try {
        const affectedRoots = new Set<string>();
        for (const p of paths) {
          const root = rootFolders.find(
            (r) => p.startsWith(r + '/') || p.startsWith(r + '\\') || p === r
          ) ?? rootPath;
          await invoke('add_to_atlsignore', { path: p, rootPath: root });
          affectedRoots.add(root);
        }
        addToast({ type: 'success', message: `Added to .atlsignore`, duration: 2000 });
        await handleRefresh();
        for (const root of affectedRoots) scanProject(root, false);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        addToast({ type: 'error', message: `Failed to add to .atlsignore: ${msg}` });
      }
    },
    [handleRefresh, rootFolders, addToast, scanProject]
  );

  // Click on empty area clears selection
  const handleBackgroundClick = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  // Right-click on empty space
  const handleBackgroundContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      setBgContextMenu({ x: e.clientX, y: e.clientY });
    }
  }, []);

  // Resolve workspace absolute path (abs_path from profile, or projectRoot + rel path)
  const getWorkspaceAbsPath = useCallback(
    (ws: WorkspaceEntry): string => workspaceEntryAbsPath(ws, projectRoot),
    [projectRoot],
  );

  // Start workspace: get scripts, create terminal, run default command
  const handleWorkspaceStart = useCallback(async (ws: WorkspaceEntry, scriptName?: string) => {
    const absPath = getWorkspaceAbsPath(ws);
    if (!absPath) {
      addToast({ type: 'error', message: 'Could not resolve workspace path' });
      return;
    }
    try {
      const result = await invoke<{ scripts: Array<{ name: string; cmd: string }>; default?: string }>('atls_get_workspace_scripts', { absPath });
      const { scripts, default: defaultName } = result;
      if (!scripts?.length) {
        addToast({ type: 'error', message: 'No runnable scripts found' });
        return;
      }
      const target = scriptName
        ? scripts.find(s => s.name === scriptName)
        : scripts.find(s => s.name === defaultName) ?? scripts[0];
      if (!target) {
        addToast({ type: 'error', message: 'Script not found' });
        return;
      }
      const terminalStore = getTerminalStore();
      const terminalId = await terminalStore.createTerminal(absPath, { name: ws.name });
      setTerminalOpen(true);
      await terminalStore.writeRaw(terminalId, target.cmd + '\r');
      setWorkspaceToTerminal(prev => ({ ...prev, [absPath]: { terminalId, status: 'running' } }));

      // Watch for the command to finish (prompt returns) or error
      const cancelWatch = terminalStore.watchPtyBusy(terminalId, (success) => {
        setWorkspaceToTerminal(prev => {
          const entry = prev[absPath];
          if (!entry || entry.terminalId !== terminalId) return prev;
          if (success) {
            const next = { ...prev };
            delete next[absPath];
            return next;
          }
          return { ...prev, [absPath]: { ...entry, status: 'errored' } };
        });
      });
      promptWatchersRef.current.set(terminalId, cancelWatch);

      setScriptDropdownOpen(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast({ type: 'error', message: `Failed to start: ${msg}` });
    }
  }, [getWorkspaceAbsPath, addToast, setTerminalOpen]);

  // Stop workspace: send Ctrl+C to the terminal
  const handleWorkspaceStop = useCallback(async (ws: WorkspaceEntry) => {
    const absPath = getWorkspaceAbsPath(ws);
    const entry = workspaceToTerminal[absPath];
    if (!entry) return;
    try {
      // Cancel any prompt watcher for this terminal
      const cancelWatch = promptWatchersRef.current.get(entry.terminalId);
      if (cancelWatch) {
        cancelWatch();
        promptWatchersRef.current.delete(entry.terminalId);
      }
      await invoke('write_pty', { id: entry.terminalId, data: '\x03' });
      setWorkspaceToTerminal(prev => {
        const next = { ...prev };
        delete next[absPath];
        return next;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast({ type: 'error', message: `Failed to stop: ${msg}` });
    }
  }, [getWorkspaceAbsPath, workspaceToTerminal, addToast]);

  // Track prompt watchers so we can cancel them on stop/unmount
  const promptWatchersRef = useRef<Map<string, () => void>>(new Map());

  // Listen for pty-exit to update workspace status (success → remove, error → mark errored)
  const exitUnlistensRef = useRef<Map<string, () => void>>(new Map());
  useEffect(() => {
    const seen = new Set(exitUnlistensRef.current.keys());
    for (const entry of Object.values(workspaceToTerminal)) {
      if (entry.status !== 'running') continue;
      const tid = entry.terminalId;
      if (seen.has(tid)) continue;
      seen.add(tid);
      listen<boolean>(`pty-exit-${tid}`, (event) => {
        // Cancel prompt watcher — shell exited, no more prompts to watch
        const cancelWatch = promptWatchersRef.current.get(tid);
        if (cancelWatch) {
          cancelWatch();
          promptWatchersRef.current.delete(tid);
        }

        const success = event.payload;
        setWorkspaceToTerminal(prev => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(next)) {
            if (v.terminalId === tid) {
              if (success) {
                delete next[k];
              } else {
                next[k] = { ...v, status: 'errored' };
              }
            }
          }
          return next;
        });
        exitUnlistensRef.current.get(tid)?.();
        exitUnlistensRef.current.delete(tid);
      }).then(unlisten => {
        exitUnlistensRef.current.set(tid, unlisten);
      }).catch(e => console.warn(`[FileExplorer] Failed to listen for pty-exit-${tid}:`, e));
    }
  }, [workspaceToTerminal]);

  // Cleanup all exit listeners and prompt watchers on unmount
  useEffect(() => {
    return () => {
      for (const unlisten of exitUnlistensRef.current.values()) unlisten();
      exitUnlistensRef.current.clear();
      for (const cancel of promptWatchersRef.current.values()) cancel();
      promptWatchersRef.current.clear();
    };
  }, []);

  // Persist workspaces section order, height, script view mode, and pinned scripts
  useEffect(() => {
    try {
      localStorage.setItem('explorer-workspaces-first', String(workspacesSectionFirst));
      localStorage.setItem('explorer-workspaces-height', String(workspacesSectionHeight));
      localStorage.setItem('explorer-workspace-script-view', scriptViewMode);
      localStorage.setItem('explorer-workspace-pinned-scripts-v2', JSON.stringify(pinnedScripts));
    } catch { /* ignore */ }
  }, [workspacesSectionFirst, workspacesSectionHeight, scriptViewMode, pinnedScripts]);

  // Drag-and-drop: reorder Workspaces section above/below File Tree
  const handleWorkspacesDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', 'workspaces');
    e.dataTransfer.effectAllowed = 'move';
  }, []);
  const handleWorkspacesDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);
  const handleWorkspacesDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.getData('text/plain') !== 'workspaces') return;
    const rect = contentAreaRef.current?.getBoundingClientRect();
    if (!rect) return;
    const midY = rect.top + rect.height / 2;
    setWorkspacesSectionFirst(e.clientY < midY);
  }, []);

  // Resize handle: drag to change Workspaces section height
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    let lastY = e.clientY;
    const onMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientY - lastY;
      lastY = ev.clientY;
      const deltaAdjusted = workspacesSectionFirst ? delta : -delta;
      setWorkspacesSectionHeight(h => Math.max(80, Math.min(500, h + deltaAdjusted)));
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [workspacesSectionFirst]);

  // Collapsed state: small tab on right edge with expand affordance
  if (explorerCollapsed) {
    return (
      <div className="h-full flex bg-studio-surface border-r border-studio-border">
        <div className="flex-1" />
        <button
          onClick={toggleExplorerCollapsed}
          className="flex-shrink-0 w-8 flex items-center justify-center bg-studio-surface border-l border-studio-border rounded-l-md hover:bg-studio-border transition-colors text-studio-muted hover:text-studio-text self-center"
          title="Expand Explorer"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-2 border-b border-studio-border">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-studio-title uppercase tracking-wide">Explorer</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleExplorerCollapsed}
              className="p-1 hover:bg-studio-surface rounded transition-colors text-studio-muted hover:text-studio-text"
              title="Collapse Explorer"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            {projectPath && (
              <button
                onClick={handleRefresh}
                className="p-1 hover:bg-studio-surface rounded transition-colors text-studio-muted hover:text-studio-text"
                title="Refresh file tree"
              >
                <RefreshIcon />
              </button>
            )}
          </div>
        </div>
        <input
          type="text"
          placeholder="Search files..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-2 py-1 text-sm bg-studio-bg border border-studio-border rounded focus:outline-none focus:border-studio-accent placeholder:text-studio-muted"
        />
      </div>

      {/* File Tree + Workspaces (draggable order) */}
      <div
        ref={contentAreaRef}
        className="flex-1 flex flex-col min-h-0 overflow-hidden"
        onDragOver={handleWorkspacesDragOver}
        onDrop={handleWorkspacesDrop}
      >
        {workspacesSectionFirst && (projectRoot || projectPath) && (
          <>
            <WorkspacesSectionBlock
              workspaces={workspaces}
              workspacesSectionExpanded={workspacesSectionExpanded}
              setWorkspacesSectionExpanded={setWorkspacesSectionExpanded}
              workspaceToTerminal={workspaceToTerminal}
              scriptDropdownOpen={scriptDropdownOpen}
              setScriptDropdownOpen={setScriptDropdownOpen}
              getWorkspaceAbsPath={getWorkspaceAbsPath}
              handleWorkspaceStart={handleWorkspaceStart}
              handleWorkspaceStop={handleWorkspaceStop}
              draggable
              onDragStart={handleWorkspacesDragStart}
              height={workspacesSectionHeight}
              scriptViewMode={scriptViewMode}
              setScriptViewMode={setScriptViewMode}
              pinnedScripts={pinnedScripts}
              onTogglePin={togglePinnedScript}
              onDismissError={handleDismissError}
            />
            <div
              role="separator"
              aria-label="Resize workspaces"
              className="h-2 flex-shrink-0 cursor-ns-resize hover:bg-studio-accent/20 transition-colors flex items-center justify-center group border-t border-studio-border/50"
              onMouseDown={handleResizeMouseDown}
              title="Drag to resize workspaces panel"
            >
              <span className="w-10 h-0.5 rounded-full bg-studio-border opacity-60 group-hover:opacity-100 group-hover:bg-studio-accent/60" />
            </div>
          </>
        )}
        {/* File Tree */}
        <div
          className="flex-1 overflow-y-auto scrollbar-thin py-1 min-h-0"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleBackgroundClick();
          }}
          onContextMenu={handleBackgroundContextMenu}
        >
          {rootFolders.length === 0 && !projectPath ? (
            <div className="p-4 text-studio-muted text-sm">
              <div className="flex gap-2 mb-3">
                <button
                  onClick={newProject}
                  className="flex-1 px-3 py-2 text-sm bg-studio-accent/10 text-studio-accent border border-studio-accent/30 rounded hover:bg-studio-accent/20 transition-colors"
                >
                  New Project
                </button>
                <button
                  onClick={openProjectWithPicker}
                  className="flex-1 px-3 py-2 text-sm bg-studio-accent/10 text-studio-accent border border-studio-accent/30 rounded hover:bg-studio-accent/20 transition-colors"
                >
                  Open Project
                </button>
              </div>
              {projectHistory.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide mb-2 text-studio-title">Recent Projects</p>
                  <div className="space-y-1">
                    {projectHistory.map(project => (
                      <button
                        key={project.path}
                        onClick={() => openProject(project.path)}
                        className="w-full text-left px-2 py-1.5 rounded hover:bg-studio-surface transition-colors group"
                        title={project.path}
                      >
                        <div className="flex items-center gap-2">
                          <FolderIcon open={false} />
                          <span className="text-sm text-studio-text truncate">{project.name}</span>
                        </div>
                        <p className="text-xs text-studio-muted truncate ml-6">{project.path}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {projectHistory.length === 0 && (
                <p className="text-center text-xs">Click "Open Project" to get started</p>
              )}
            </div>
          ) : isMultiRoot ? (
            rootFileTrees.map((rt) => {
              const isCollapsed = collapsedRoots.has(rt.root);
              const isActive = activeRoot === rt.root || activeRoot?.replace(/\\/g, '/') === rt.root.replace(/\\/g, '/');
              const rootFilteredFiles = filterFileNodesByQuery(rt.files, searchQuery);
              const rootVisiblePaths = flattenVisiblePaths(rootFilteredFiles, expandedFolders);
              return (
                <div key={rt.root} className="mb-0.5">
                  <div
                    className={`flex items-center gap-1 px-2 py-1 cursor-pointer select-none sticky top-0 z-10 ${
                      isActive ? 'bg-studio-accent/10 border-l-2 border-studio-accent' : 'bg-studio-surface/80 border-l-2 border-transparent'
                    } hover:bg-studio-border/30 transition-colors`}
                    onClick={() => {
                      switchActiveRoot(rt.root);
                      setCollapsedRoots(prev => {
                        const next = new Set(prev);
                        if (next.has(rt.root)) next.delete(rt.root);
                        else next.add(rt.root);
                        return next;
                      });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setRootHeaderMenu({ x: e.clientX, y: e.clientY, rootPath: rt.root });
                    }}
                    title={rt.root}
                  >
                    <ChevronIcon open={!isCollapsed} />
                    <FolderIcon open={!isCollapsed} />
                    <span className="text-xs font-semibold text-studio-title uppercase tracking-wide truncate flex-1">{rt.name}</span>
                  </div>
                  {!isCollapsed && (
                    rootFilteredFiles.length === 0 ? (
                      <div className="px-4 py-2 text-center text-studio-muted text-xs">
                        {searchQuery ? 'No matching files' : 'Empty folder'}
                      </div>
                    ) : (
                      <FileTree
                        nodes={rootFilteredFiles}
                        onContextMenu={handleContextMenu}
                        allVisiblePaths={rootVisiblePaths}
                        inlineEdit={inlineEdit}
                        onInlineCommit={handleInlineCommit}
                        onInlineCancel={handleInlineCancel}
                      />
                    )
                  )}
                </div>
              );
            })
          ) : filteredFiles.length === 0 ? (
            <div className="p-4 text-center text-studio-muted text-sm">
              {searchQuery ? 'No matching files' : 'Empty folder'}
            </div>
          ) : (
            <FileTree
              nodes={filteredFiles}
              onContextMenu={handleContextMenu}
              allVisiblePaths={allVisiblePaths}
              inlineEdit={inlineEdit}
              onInlineCommit={handleInlineCommit}
              onInlineCancel={handleInlineCancel}
            />
          )}
        </div>
        {!workspacesSectionFirst && (projectRoot || projectPath) && (
          <>
            <div
              role="separator"
              aria-label="Resize workspaces"
              className="h-2 flex-shrink-0 cursor-ns-resize hover:bg-studio-accent/20 transition-colors flex items-center justify-center group border-t border-studio-border/50"
              onMouseDown={handleResizeMouseDown}
              title="Drag to resize workspaces panel"
            >
              <span className="w-10 h-0.5 rounded-full bg-studio-border opacity-60 group-hover:opacity-100 group-hover:bg-studio-accent/60" />
            </div>
            <WorkspacesSectionBlock
              workspaces={workspaces}
              workspacesSectionExpanded={workspacesSectionExpanded}
              setWorkspacesSectionExpanded={setWorkspacesSectionExpanded}
              workspaceToTerminal={workspaceToTerminal}
              scriptDropdownOpen={scriptDropdownOpen}
              setScriptDropdownOpen={setScriptDropdownOpen}
              getWorkspaceAbsPath={getWorkspaceAbsPath}
              handleWorkspaceStart={handleWorkspaceStart}
              handleWorkspaceStop={handleWorkspaceStop}
              draggable
              onDragStart={handleWorkspacesDragStart}
              height={workspacesSectionHeight}
              scriptViewMode={scriptViewMode}
              setScriptViewMode={setScriptViewMode}
              pinnedScripts={pinnedScripts}
              onTogglePin={togglePinnedScript}
              onDismissError={handleDismissError}
            />
          </>
        )}
      </div>

      {/* Context Menu (node) */}
      {contextMenu && (projectPath || rootFolders.length > 0) && (
        <ContextMenu
          menu={contextMenu}
          projectPath={projectPath || rootFolders[0] || ''}
          selectedPaths={selectedFiles}
          clipboardPaths={clipboardPaths}
          clipboardMode={clipboardMode}
          onClose={handleCloseContextMenu}
          onOpen={handleOpenFile}
          onDelete={handleDelete}
          onRename={handleRename}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          onCut={handleCut}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onCollapseAll={collapseAllFolders}
          onAddToChat={handleAddToChat}
          onAddToIgnore={handleAddToIgnore}
          onRemoveFromIgnore={handleRemoveFromIgnore}
          rootFolders={rootFolders}
        />
      )}

      {/* Context Menu (empty-space background) */}
      {bgContextMenu && (projectPath || rootFolders.length > 0) && (
        <BackgroundContextMenu
          x={bgContextMenu.x}
          y={bgContextMenu.y}
          onClose={() => setBgContextMenu(null)}
          onAddFolder={addFolderToWorkspace}
          onNewFile={() => handleNewFile(projectRoot)}
          onNewFolder={() => handleNewFolder(projectRoot)}
          onPaste={() => handlePaste(projectRoot)}
          canPaste={clipboardPaths.length > 0 && !!clipboardMode && !!projectRoot}
          onCollapseAll={collapseAllFolders}
          onRefresh={handleRefresh}
          onRevealProjectRoot={projectRoot ? () => handleRevealPath(projectRoot) : undefined}
        />
      )}

      {/* Context Menu (root header) */}
      {rootHeaderMenu && (
        <RootHeaderContextMenu
          x={rootHeaderMenu.x}
          y={rootHeaderMenu.y}
          rootPath={rootHeaderMenu.rootPath}
          onClose={() => setRootHeaderMenu(null)}
          onRemoveFolder={removeFolderFromWorkspace}
          onNewFile={handleNewFile}
          onNewFolder={handleNewFolder}
          onPaste={handlePaste}
          canPaste={clipboardPaths.length > 0 && !!clipboardMode}
          onReveal={handleRevealPath}
          onCollapseAll={collapseAllFolders}
        />
      )}
    </div>
  );
}
