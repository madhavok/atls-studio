import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { safeListen } from '../utils/tauri';
import { useAppStore, FileNode, Issue, ProjectProfile, FocusMatrix, IssueCounts, ALL_CATEGORIES } from '../stores/appStore';
import { useContextStore, setBulkRevisionResolver } from '../stores/contextStore';
import { useRetentionStore } from '../stores/retentionStore';
import { useRef, useCallback, useEffect } from 'react';
import { transformIssues } from './useAtlsTransforms';
import { normPath } from './useAtlsPaths';

// ---------------------------------------------------------------------------
// Own-write suppression: paths recently written by ATLS edits are excluded
// from file_tree_changed processing to prevent spurious intel:file_change.
// ---------------------------------------------------------------------------
const OWN_WRITE_TTL_MS = 3000;
const ownWritePaths = new Map<string, number>();

export function registerOwnWrite(paths: string[]): void {
  const now = Date.now();
  for (const p of paths) ownWritePaths.set(normPath(p).toLowerCase(), now);
}

function filterOwnWrites(paths: string[]): string[] {
  if (ownWritePaths.size === 0) return paths;
  const now = Date.now();
  // Prune expired entries
  for (const [k, t] of ownWritePaths) {
    if (now - t > OWN_WRITE_TTL_MS) ownWritePaths.delete(k);
  }
  return paths.filter(p => !ownWritePaths.has(normPath(p).toLowerCase()));
}

// ---------------------------------------------------------------------------
// Shared helpers (module-level, no React dependency)
// ---------------------------------------------------------------------------

interface ScanProgressEvent {
  processed: number;
  total: number;
  current_file?: string;
  progress: number;
}

interface CanonicalRevisionChangedEvent {
  path: string;
  revision: string;
  previous_revision?: string | null;
}

interface FileTreeChangedEvent {
  root: string;
  count: number;
  paths?: string[];
}

/** Compute focus-profile filters for issue queries. */
function buildIssueFilters(): { catFilter?: string[]; sevFilter?: string[] } {
  const { focusProfile, focusProfileName } = useAppStore.getState();
  const activeCats = Object.keys(focusProfile.matrix).filter(
    k => (focusProfile.matrix[k]?.length ?? 0) > 0,
  );
  const activeSevs = [...new Set(Object.values(focusProfile.matrix).flat())];
  const allSevs = activeSevs.length === 3
    && activeSevs.includes('high')
    && activeSevs.includes('medium')
    && activeSevs.includes('low');
  const isFullScan = focusProfileName === 'Full Scan'
    || (allSevs && activeCats.length >= ALL_CATEGORIES.length);

  return {
    catFilter: (!isFullScan && activeCats.length > 0) ? activeCats : undefined,
    sevFilter: (!isFullScan && activeSevs.length > 0) ? activeSevs : undefined,
  };
}

// ---------------------------------------------------------------------------
// Serial scan queue
// ---------------------------------------------------------------------------

interface ScanJob {
  rootPath: string;
  forceFullRescan: boolean;
}

const scanQueue: ScanJob[] = [];
let scanProcessorRunning = false;

/** Refresh Intelligence (profile + issues) for a root, writing directly to the store. */
async function refreshIntelligenceForRoot(rootPath: string) {
  useAppStore.getState().setScanStatus({ phase: 'Loading issues' });
  await invoke('atls_set_active_root', { rootPath }).catch(() => {});

  let profileSummary = '';
  try {
    const profile = await invoke<ProjectProfile>('atls_get_project_profile');
    useAppStore.setState({ projectProfile: profile });
    const stats = profile?.stats;
    profileSummary = stats
      ? `files:${stats.files} langs:${Object.keys(stats.langs).length} loc:${stats.loc}`
      : 'no stats';
  } catch (e) {
    console.error('[ScanQueue] profile refresh failed:', e);
  }

  let issueCount = 0;
  try {
    const { catFilter, sevFilter } = buildIssueFilters();
    const [issues, counts] = await Promise.all([
      invoke<Issue[]>('find_issues', { rootPath, categories: catFilter, severities: sevFilter, limit: 5000 }),
      invoke<IssueCounts>('get_issue_counts', { rootPath, categories: catFilter, severities: sevFilter }),
    ]);
    useAppStore.setState({ issues: transformIssues(issues), issueCounts: counts, languageHealth: null });
    issueCount = counts?.total ?? issues.length;
  } catch (e) {
    console.error('[ScanQueue] issues refresh failed:', e);
  }

  // Rehydrate engrams: verify revisions against hash registry instead of blanket suspect
  const rootName = rootPath.split(/[/\\]/).pop() || rootPath;
  const ts = new Date().toISOString().slice(11, 19);
  const contextStore = useContextStore.getState();
  const stats = await contextStore.refreshRoundEnd();
  contextStore.bumpWorkspaceRev();

  const parts = [`profile(${profileSummary})`, `issues:${issueCount}`];
  if (stats.pathsProcessed > 0) {
    parts.push(`engrams: ${stats.updated} reconciled, ${stats.invalidated} invalidated, ${stats.preserved} preserved`);
  }
  contextStore.setBlackboardEntry('fix:useAtls.ts', `[${ts}] Intelligence refreshed for ${rootName}; ${parts.join('; ')}.`);
}

/** Drain the scan queue one job at a time. Module-level singleton. */
async function processScanQueue() {
  if (scanProcessorRunning) return;
  scanProcessorRunning = true;

  const setState = (s: Record<string, unknown>) => useAppStore.getState().setScanStatus(s as Partial<import('../stores/appStore').ScanStatus>);
  let progressUnlisten: UnlistenFn | null = null;

  try {
    let completed = 0;

    while (scanQueue.length > 0) {
      const total = completed + scanQueue.length;
      const job = scanQueue.shift()!;
      const rootName = job.rootPath.split(/[/\\]/).pop() || job.rootPath;

      setState({
        isScanning: true, progress: 0, filesProcessed: 0, filesTotal: 0,
        phase: total > 1 ? `Repo ${completed + 1}/${total} — ${rootName}` : 'Preparing scan',
        currentScanRoot: job.rootPath, scanQueueTotal: total, scanQueueCompleted: completed,
      });

      progressUnlisten = await safeListen<ScanProgressEvent>('scan_progress', (ev) => {
        const qTotal = completed + scanQueue.length + 1;
        setState({
          isScanning: true,
          progress: Math.round(ev.payload.progress),
          filesProcessed: ev.payload.processed,
          filesTotal: ev.payload.total,
          currentFile: ev.payload.current_file,
          phase: qTotal > 1 ? `Repo ${completed + 1}/${qTotal} — ${rootName}` : 'Scanning files',
          scanQueueTotal: qTotal, scanQueueCompleted: completed, currentScanRoot: job.rootPath,
        });
      });

      try {
        let fullRescan = job.forceFullRescan;
        if (!fullRescan) {
          await invoke('atls_set_active_root', { rootPath: job.rootPath });
          try {
            const profile = await invoke<any>('atls_get_project_profile');
            fullRescan = !profile?.stats || profile.stats.files === 0;
          } catch { fullRescan = true; }
        }

        const { focusProfile } = useAppStore.getState();
        const matrix: FocusMatrix | undefined =
          Object.keys(focusProfile.matrix).length > 0 ? focusProfile.matrix : undefined;

        await invoke('scan_project', { rootPath: job.rootPath, fullRescan, matrix });
      } catch (err) {
        console.error(`[ScanQueue] scan failed for ${job.rootPath}:`, err);
      } finally {
        if (progressUnlisten) { progressUnlisten(); progressUnlisten = null; }
      }

      completed++;
    }

    // Restore the user's active root and refresh Intelligence for the pre-scan root
    const { activeRoot, projectPath, rootFolders } = useAppStore.getState();
    const originalRoot = activeRoot ?? projectPath ?? rootFolders[0];
    if (originalRoot) {
      await invoke('atls_set_active_root', { rootPath: originalRoot }).catch(() => {});
      await refreshIntelligenceForRoot(originalRoot);
    }

    setState({
      isScanning: false, progress: 100, phase: undefined,
      scanQueueTotal: undefined, scanQueueCompleted: undefined, currentScanRoot: undefined,
    });
  } catch (err) {
    console.error('[ScanQueue] processor error:', err);
    useAppStore.getState().setScanStatus({
      isScanning: false, progress: 0, phase: undefined,
      scanQueueTotal: undefined, scanQueueCompleted: undefined, currentScanRoot: undefined,
    });
  } finally {
    scanProcessorRunning = false;
    if (progressUnlisten) progressUnlisten();
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAtls() {
  const {
    setProjectPath, setFiles, setScanStatus,
    setIssues, setIssueCounts, setProjectProfile, setLanguageHealth,
    setAtlsInitialized, addToProjectHistory,
    addRootFolder, removeRootFolder, setActiveRoot,
    setWorkspaceFilePath, setRootFileTrees, clearWorkspace,
  } = useAppStore();

  const eventListeners = useRef<UnlistenFn[]>([]);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChangedPathsRef = useRef<Map<string, string>>(new Map());
  const pendingCoarseRefreshRef = useRef(false);
  const projectPath = useAppStore(s => s.projectPath);

  // ---- ATLS lifecycle ----------------------------------------------------

  const initAtls = useCallback(async (rootPath: string) => {
    try {
      for (const u of eventListeners.current) u();
      eventListeners.current = [];

      const result = await invoke<any>('atls_init', { rootPath });
      console.log('ATLS initialized:', result);
      setAtlsInitialized(true);

      const indexUnlisten = await safeListen<{
        phase: string; total: number; indexed?: number; removed?: number; current_file?: string;
      }>('index_progress', (event) => {
        const p = event.payload;
        if (p.phase === 'start') {
          setScanStatus({ isScanning: true, progress: 0, filesProcessed: 0, filesTotal: p.total, phase: 'Indexing changes' });
        } else if (p.phase === 'indexing') {
          const pct = p.total > 0 ? Math.round(((p.indexed ?? 0) / p.total) * 100) : 0;
          setScanStatus({ isScanning: true, progress: pct, filesProcessed: p.indexed ?? 0, filesTotal: p.total, currentFile: p.current_file, phase: 'Indexing changes' });
        } else if (p.phase === 'done') {
          setScanStatus({ isScanning: false, progress: 100, filesProcessed: p.indexed ?? p.removed ?? p.total, filesTotal: p.total, phase: undefined });
        }
      });
      eventListeners.current.push(indexUnlisten);
      return true;
    } catch (error) {
      console.error('Failed to initialize ATLS:', error);
      setAtlsInitialized(false);
      return false;
    }
  }, [setAtlsInitialized, setScanStatus]);

  const fetchProjectProfile = useCallback(async (): Promise<ProjectProfile | null> => {
    try {
      const profile = await invoke<ProjectProfile>('atls_get_project_profile');
      setProjectProfile(profile);
      return profile;
    } catch (error) {
      console.error('Failed to fetch project profile:', error);
      return null;
    }
  }, [setProjectProfile]);

  const disposeAtls = useCallback(async () => {
    try {
      for (const u of eventListeners.current) u();
      eventListeners.current = [];
      await invoke('atls_dispose');
      setAtlsInitialized(false);
      setProjectProfile(null);
    } catch (error) {
      console.error('Failed to dispose ATLS:', error);
    }
  }, [setProjectProfile]);

  // ---- File tree ---------------------------------------------------------

  const loadFileTree = useCallback(async (rootPath: string) => {
    try {
      setFiles(await invoke<FileNode[]>('get_file_tree', { path: rootPath }));
    } catch (error) {
      console.error('Failed to load file tree:', error);
      setFiles([]);
    }
  }, [setFiles]);

  const refreshAllFileTrees = useCallback(async () => {
    const { rootFolders: roots } = useAppStore.getState();
    const trees: { root: string; name: string; files: FileNode[] }[] = [];
    for (const root of roots) {
      try {
        const files = await invoke<FileNode[]>('get_file_tree', { path: root });
        trees.push({ root, name: root.split(/[/\\]/).pop() || root, files });
      } catch (e) {
        console.error('Failed to load tree for root:', root, e);
      }
    }
    setRootFileTrees(trees);
    if (trees.length > 0) setFiles(trees[0].files);
  }, [setRootFileTrees, setFiles]);

  // ---- File watchers -----------------------------------------------------

  const setupFileWatcher = useCallback(async (rootPath: string) => {
    try { await invoke('start_file_watcher', { rootPath }); }
    catch (e) { console.error('Failed to setup file watcher:', e); }
  }, []);

  const stopFileWatcher = useCallback(async (rootPath?: string) => {
    try { await invoke('stop_file_watcher', { rootPath: rootPath ?? null }); }
    catch { /* ignore */ }
  }, []);

  // Listener for canonical_revision_changed — reconcile same-source engrams when file content changes
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    (async () => {
      unlisten = await safeListen<CanonicalRevisionChangedEvent>('canonical_revision_changed', (ev) => {
        const { path, revision } = ev.payload;
        pendingChangedPathsRef.current.delete(normPath(path).toLowerCase());
        const stats = useContextStore.getState().reconcileSourceRevision(path, revision);
        if (stats.total > 0) {
          console.log('[useAtls] canonical_revision_changed:', path, stats);
        }
      });
    })();
    return () => { unlisten?.(); };
  }, []);

  // Wire session-independent bulk revision resolver (single IPC call for all paths)
  useEffect(() => {
    setBulkRevisionResolver(async (paths: string[]) => {
      const result = await invoke<Record<string, string | null>>('get_current_revisions', { paths });
      return new Map(Object.entries(result));
    });
    return () => { setBulkRevisionResolver(null); };
  }, []);

  // Single shared listener for file_tree_changed events (all roots)
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    (async () => {
      unlisten = await safeListen<FileTreeChangedEvent>('file_tree_changed', (ev) => {
        const changedPaths = Array.isArray(ev.payload.paths)
          ? [...new Map(
            ev.payload.paths
              .filter((path): path is string => typeof path === 'string' && path.length > 0)
              .map((path) => {
                const normalized = normPath(path);
                return [normalized.toLowerCase(), normalized] as const;
              }),
          ).values()]
          : [];
        const ctxState = useContextStore.getState();
        const externalPaths = filterOwnWrites(changedPaths);
        if (externalPaths.length > 0) {
          pendingCoarseRefreshRef.current = false;
          externalPaths.forEach((path) => pendingChangedPathsRef.current.set(path.toLowerCase(), path));
          ctxState.markEngramsSuspect(externalPaths, 'watcher_event');
          ctxState.bumpWorkspaceRev(externalPaths);
          ctxState.invalidateArtifactsForPaths(externalPaths);
          useRetentionStore.getState().evictMutationSensitive();
        } else {
          pendingCoarseRefreshRef.current = true;
          ctxState.markEngramsSuspect(undefined, 'unknown');
          ctxState.bumpWorkspaceRev();
          useRetentionStore.getState().evictMutationSensitive();
          console.warn('[useAtls] file_tree_changed missing exact paths; falling back to coarse suspect marking');
        }
        if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = setTimeout(async () => {
          const snapshotKeys = [...pendingChangedPathsRef.current.keys()];
          try {
            await refreshAllFileTrees();
            const pendingPaths = [...pendingChangedPathsRef.current.values()];
            const pendingPathSet = new Set(pendingPaths.map((path) => path.toLowerCase()));
            const currentCtxState = useContextStore.getState();
            const staleEngrams: string[] = [];
            if (pendingPathSet.size > 0 && currentCtxState.chunks.size > 0) {
              for (const [, chunk] of currentCtxState.chunks) {
                if (!chunk.source || chunk.suspectSince == null) continue;
                const srcNorm = normPath(chunk.source).toLowerCase();
                if (!pendingPathSet.has(srcNorm)) continue;
                staleEngrams.push(`h:${chunk.shortHash} ${chunk.source}`);
                if (staleEngrams.length >= 20) break;
              }
            }
            if (staleEngrams.length > 0) {
              const ts = new Date().toISOString().slice(11, 19);
              const rootName = ev.payload.root.split(/[/\\]/).pop() || ev.payload.root;
              const touchedLabel = pendingPaths.length > 0
                ? `${pendingPaths.length} exact file${pendingPaths.length === 1 ? '' : 's'}`
                : `${snapshotKeys.length} file${snapshotKeys.length === 1 ? '' : 's'}`;
              currentCtxState.setBlackboardEntry(
                'intel:file_change',
                `[${ts}] ${touchedLabel} changed externally in ${rootName}. Unsafe external file change — re-read required. Potentially stale engrams: ${staleEngrams.slice(0, 5).join(', ')}${staleEngrams.length > 5 ? ` +${staleEngrams.length - 5} more` : ''}.`,
              );
            } else if (pendingCoarseRefreshRef.current) {
              const ts = new Date().toISOString().slice(11, 19);
              const rootName = ev.payload.root.split(/[/\\]/).pop() || ev.payload.root;
              currentCtxState.setBlackboardEntry(
                'intel:file_change',
                `[${ts}] ${ev.payload.count} files changed in ${rootName}. Exact paths were unavailable — freshness marked conservatively; re-read before edit.`,
              );
            }
          } catch (e) {
            console.error('[useAtls] file_tree_changed refresh failed:', e);
          } finally {
            if (!pendingCoarseRefreshRef.current) {
              snapshotKeys.forEach((key) => pendingChangedPathsRef.current.delete(key));
            }
            pendingCoarseRefreshRef.current = false;
            refreshTimeoutRef.current = null;
          }
        }, 300);
      });
    })();
    return () => {
      unlisten?.();
      if (refreshTimeoutRef.current) { clearTimeout(refreshTimeoutRef.current); refreshTimeoutRef.current = null; }
      pendingChangedPathsRef.current.clear();
      pendingCoarseRefreshRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-setup/teardown watchers when rootFolders changes
  const rootFolders = useAppStore(s => s.rootFolders);
  const prevRootsRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevRootsRef.current;
    for (const r of rootFolders.filter(r => !prev.includes(r))) setupFileWatcher(r);
    for (const r of prev.filter(r => !rootFolders.includes(r))) stopFileWatcher(r);
    prevRootsRef.current = rootFolders;
    if (rootFolders.length === 0) stopFileWatcher();
  }, [rootFolders, setupFileWatcher, stopFileWatcher]);

  // ---- File I/O ----------------------------------------------------------

  const readFile = async (path: string): Promise<string | null> => {
    try { return await invoke<string>('read_file_contents', { path }); }
    catch (e) { console.error('Failed to read file:', e); return null; }
  };

  const writeFile = async (path: string, contents: string): Promise<boolean> => {
    try {
      const projectRoot = useAppStore.getState().rootFolders[0];
      await invoke('write_file_contents', {
        path,
        contents,
        ...(projectRoot !== undefined ? { projectRoot } : {}),
      });
      return true;
    }
    catch (e) { console.error('Failed to write file:', e); return false; }
  };

  const saveFile = async () => {
    const { activeFile } = useAppStore.getState();
    if (activeFile) console.log('Save file:', activeFile);
  };

  // ---- Scanning & issues -------------------------------------------------

  const refreshIssues = useCallback(async (rootPath: string, category?: string, severity?: string) => {
    try {
      const { catFilter, sevFilter } = buildIssueFilters();
      const [issues, counts] = await Promise.all([
        invoke<Issue[]>('find_issues', { rootPath, category, severity, categories: catFilter, severities: sevFilter, limit: 5000 }),
        invoke<IssueCounts>('get_issue_counts', { rootPath, category, severity, categories: catFilter, severities: sevFilter }),
      ]);
      setIssues(transformIssues(issues));
      setIssueCounts(counts);
    } catch (error) {
      console.error('Failed to refresh issues:', error);
    }
  }, [setIssues, setIssueCounts]);

  /** Enqueue a scan. Runs serially; status bar shows repo progress when > 1. */
  const scanProject = useCallback((rootPath: string, forceFullRescan = false) => {
    const norm = normPath(rootPath);
    if (scanQueue.some(j => normPath(j.rootPath) === norm)) return;
    const { scanStatus } = useAppStore.getState();
    if (normPath(scanStatus.currentScanRoot ?? '') === norm) return;

    scanQueue.push({ rootPath, forceFullRescan });

    if (!scanProcessorRunning) {
      setScanStatus({ isScanning: true, progress: 0, phase: 'Queued' });
      processScanQueue();
    } else {
      const total = (scanStatus.scanQueueCompleted ?? 0) + scanQueue.length + 1;
      setScanStatus({ scanQueueTotal: total });
    }
  }, [setScanStatus]);

  // ---- Code intelligence -------------------------------------------------

  const searchCode = async (query: string, limit = 20): Promise<any[]> => {
    try { return (await invoke<any>('atls_search_code', { query, limit }))?.results || []; }
    catch { return []; }
  };

  const getSymbolUsage = async (symbolName: string): Promise<any> => {
    try { return await invoke('atls_get_symbol_usage', { symbolName }); }
    catch { return null; }
  };

  const diagnoseSymbols = async (query: string, searchType = 'contains', fileFilter?: string, limit = 50): Promise<any> => {
    try { return await invoke('atls_diagnose_symbols', { query, searchType, fileFilter, limit }); }
    catch { return null; }
  };

  const searchFiles = async (query: string): Promise<string[]> => {
    const { projectPath: pp } = useAppStore.getState();
    if (!pp || !query.trim()) return [];
    try { return await invoke<string[]>('search_files', { query, path: pp }); }
    catch { return []; }
  };

  const getFileContext = async (filePath: string): Promise<any> => {
    try { return (await invoke<any>('atls_get_file_context', { filePath }))?.context || null; }
    catch { return null; }
  };

  // ---- Project open flows ------------------------------------------------

  const newProject = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'New Project — Select or create a folder',
      });
      if (!selected) return;
      const path = selected as string;
      await invoke('create_project_directory', { path });
      await openProjectAt(path);
    } catch (error) {
      console.error('Failed to create project:', error);
      setScanStatus({ isScanning: false, progress: 0, phase: undefined });
    }
  };

  const openProjectWithPicker = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Open Project' });
      if (!selected) return;
      const path = selected as string;
      await openProjectAt(path);
    } catch (error) {
      console.error('Failed to open project:', error);
      setScanStatus({ isScanning: false, progress: 0, phase: undefined });
    }
  };

  const openProjectAt = async (path: string) => {
    try {
      setProjectPath(path);
      addToProjectHistory(path);
      addRootFolder(path);
      await loadFileTree(path);

      setScanStatus({ isScanning: true, progress: 0, phase: 'Initializing' });
      if (await initAtls(path)) {
        await refreshAllFileTrees();
        scanProject(path, false);
      } else {
        setScanStatus({ isScanning: false, progress: 100, phase: undefined });
      }
    } catch (error) {
      console.error('Failed to open project:', error);
      setScanStatus({ isScanning: false, progress: 0, phase: undefined });
    }
  };
  const openProject = openProjectAt;

  // ---- Multi-root workspace operations -----------------------------------

  const addFolderToWorkspace = useCallback(async (): Promise<boolean> => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Add Folder to Workspace' });
      if (!selected) return false;
      const path = selected as string;

      await invoke('atls_add_root', { rootPath: path });
      addRootFolder(path);
      addToProjectHistory(path);
      await setupFileWatcher(path);
      await refreshAllFileTrees();
      scanProject(path, false);
      return true;
    } catch (error) {
      console.error('Failed to add folder to workspace:', error);
      return false;
    }
  }, [addRootFolder, addToProjectHistory, setupFileWatcher, refreshAllFileTrees, scanProject]);

  const removeFolderFromWorkspace = useCallback(async (path: string): Promise<boolean> => {
    try {
      await invoke('atls_remove_root', { rootPath: path });
      removeRootFolder(path);
      await stopFileWatcher(path);
      await refreshAllFileTrees();

      const { activeRoot: newActive } = useAppStore.getState();
      if (newActive) {
        await invoke('atls_set_active_root', { rootPath: newActive });
        await fetchProjectProfile();
        await refreshIssues(newActive);
        setLanguageHealth(null);
      } else {
        setIssues([]);
        setIssueCounts({ high: 0, medium: 0, low: 0, total: 0 });
        setProjectProfile(null);
        setLanguageHealth(null);
      }
      return true;
    } catch (error) {
      console.error('Failed to remove folder from workspace:', error);
      return false;
    }
  }, [removeRootFolder, stopFileWatcher, refreshAllFileTrees, fetchProjectProfile, refreshIssues, setIssues, setIssueCounts, setProjectProfile, setLanguageHealth]);

  const switchActiveRoot = useCallback(async (rootPath: string) => {
    const { activeRoot: current } = useAppStore.getState();
    if (normPath(current ?? '') === normPath(rootPath)) return;

    setActiveRoot(rootPath);
    await invoke('atls_set_active_root', { rootPath }).catch(console.error);
    await fetchProjectProfile();
    await refreshIssues(rootPath);
    setLanguageHealth(null);
  }, [setActiveRoot, fetchProjectProfile, refreshIssues, setLanguageHealth]);

  const saveWorkspace = useCallback(async (): Promise<boolean> => {
    try {
      let filePath = useAppStore.getState().workspaceFilePath;
      if (!filePath) {
        const selected = await save({ title: 'Save Workspace As', filters: [{ name: 'ATLS Workspace', extensions: ['atls-workspace'] }] });
        if (!selected) return false;
        filePath = selected;
      }
      await invoke('atls_save_workspace', { filePath });
      setWorkspaceFilePath(filePath);
      return true;
    } catch (error) {
      console.error('Failed to save workspace:', error);
      return false;
    }
  }, [setWorkspaceFilePath]);

  const openWorkspace = useCallback(async (): Promise<boolean> => {
    try {
      const selected = await open({ title: 'Open Workspace', filters: [{ name: 'ATLS Workspace', extensions: ['atls-workspace'] }], multiple: false });
      if (!selected) return false;
      const filePath = selected as string;

      await stopFileWatcher();
      const result = await invoke<{ status: string; roots: string[]; workspaceFile: string }>('atls_open_workspace', { filePath });
      clearWorkspace();
      setAtlsInitialized(true);
      setWorkspaceFilePath(filePath);
      for (const root of result.roots) {
        addRootFolder(root);
        addToProjectHistory(root);
        await setupFileWatcher(root);
      }
      await refreshAllFileTrees();
      for (const root of result.roots) scanProject(root, false);
      return true;
    } catch (error) {
      console.error('Failed to open workspace:', error);
      return false;
    }
  }, [stopFileWatcher, clearWorkspace, setAtlsInitialized, setWorkspaceFilePath, addRootFolder, addToProjectHistory, setupFileWatcher, refreshAllFileTrees, scanProject]);

  const closeWorkspace = useCallback(async () => {
    try {
      await stopFileWatcher();
      await invoke('atls_dispose');
      clearWorkspace();
    } catch (error) {
      console.error('Failed to close workspace:', error);
    }
  }, [stopFileWatcher, clearWorkspace]);

  // ---- Public API --------------------------------------------------------

  return {
    newProject,
    openProject,
    openProjectWithPicker,
    openFolder: openProjectWithPicker, // legacy alias
    loadFileTree,
    readFile, writeFile, saveFile,
    initAtls, disposeAtls, fetchProjectProfile,
    setupFileWatcher, stopFileWatcher,
    scanProject, refreshIssues,
    addFolderToWorkspace, removeFolderFromWorkspace, switchActiveRoot,
    saveWorkspace, openWorkspace, closeWorkspace, refreshAllFileTrees,
    searchCode, getSymbolUsage, getFileContext, diagnoseSymbols, searchFiles,
  };
}

export default useAtls;