import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { safeListen } from '../utils/tauri';
import { useAppStore } from './appStore';
import { tryParseAgentExecPtyBuffer } from './terminalExecCapture';

// Strip ANSI escape sequences from PTY output for AI consumption
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[\??[0-9;]*[hl]|\x1b[()][0-9A-B]|\x1b\[[\d;]*m|\x1b/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// Types
export interface TerminalInstance {
  id: string;
  name: string;
  cwd: string;
  isAlive: boolean;
  isAgent: boolean;
  createdAt: Date;
  // Note: output buffer is stored separately (non-reactive) for performance
}

export interface ExecutionResult {
  exitCode: number;
  output: string;
  success: boolean;
}

export interface AgentCommandEntry {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  status: 'running' | 'done' | 'error' | 'timeout' | 'message';
  timestamp: number;
}

// Command queue item
interface QueuedCommand {
  command: string;
  resolve: (result: ExecutionResult) => void;
  reject: (error: Error) => void;
}

interface TerminalStore {
  // State
  terminals: Map<string, TerminalInstance>;
  activeTerminalId: string | null;
  activeAgentTerminalId: string | null;
  nextTerminalNumber: number;  // Monotonic counter - never decrements
  outputListeners: Map<string, UnlistenFn>;
  exitListeners: Map<string, UnlistenFn>;
  
  // Command queue state (per terminal)
  commandQueues: Map<string, QueuedCommand[]>;
  isExecuting: Map<string, boolean>;

  // Agent log version counter (triggers re-renders for AgentTerminalView)
  agentLogVersion: number;
  
  // Actions
  createTerminal: (cwd?: string, options?: { background?: boolean; name?: string; isAgent?: boolean }) => Promise<string>;
  closeTerminal: (id: string) => Promise<void>;
  setActiveTerminal: (id: string) => void;
  setActiveAgentTerminal: (id: string) => void;
  appendOutput: (id: string, data: string) => void;
  getOutputBuffer: (id: string) => string[];
  clearOutputBuffer: (id: string) => void;
  getTerminalsArray: () => TerminalInstance[];
  getUserTerminals: () => TerminalInstance[];
  getAgentTerminals: () => TerminalInstance[];
  
  // AI execution (queued)
  executeCommand: (command: string, terminalId?: string) => Promise<ExecutionResult>;
  
  // Raw write (fire-and-forget, no marker wrapping — for dev servers / long-running processes)
  writeRaw: (terminalId: string, data: string) => Promise<void>;

  // Poll the backend is_pty_busy command to detect when a shell command finishes.
  // Returns a cleanup function. Calls onComplete(success) when the shell becomes idle.
  watchPtyBusy: (terminalId: string, onComplete: (success: boolean) => void) => () => void;

  // Agent terminal display
  getAgentLog: (terminalId: string) => AgentCommandEntry[];
  appendAgentMessage: (terminalId: string, message: string) => void;
  sendInterrupt: (terminalId: string) => Promise<void>;

  // Internal: actual execution (not queued)
  _executeCommandDirect: (command: string, terminalId: string) => Promise<ExecutionResult>;
  _processQueue: (terminalId: string) => Promise<void>;
  
  /** Mark PTY as dead (backend gone or write failed). Mirrors pty-exit handling. */
  markTerminalDead: (id: string) => void;

  // Initialization
  setupOutputListener: (id: string) => Promise<void>;
  cleanupTerminal: (id: string) => Promise<void>;
}

// Sleep helper
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Maximum output buffer size (chunks)
const MAX_OUTPUT_BUFFER_SIZE = 1000;

// Separate output buffers that don't trigger React re-renders
// These are only used for AI command parsing, not UI rendering
const outputBuffers = new Map<string, string[]>();

// Pending command completions - resolvers waiting for markers
interface PendingCompletion {
  marker: string;
  resolve: (result: ExecutionResult) => void;
  startMarker: string;
  buffer: string;
  timeoutId: ReturnType<typeof setTimeout>;
}
const pendingCompletions = new Map<string, PendingCompletion[]>();

// ---------------------------------------------------------------------------
// Agent display filter — non-reactive state for streaming command output
// ---------------------------------------------------------------------------

interface AgentDisplayState {
  phase: 'idle' | 'awaiting_start' | 'streaming';
  activeMarker: string | null;
  activeEntryId: string | null;
  lineBuf: string;
}

const agentLogEntries = new Map<string, AgentCommandEntry[]>();
const agentDisplayStates = new Map<string, AgentDisplayState>();
let agentLogFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAgentLogFlush(): void {
  if (agentLogFlushTimer) return;
  agentLogFlushTimer = setTimeout(() => {
    agentLogFlushTimer = null;
    useTerminalStore.setState(s => ({ agentLogVersion: s.agentLogVersion + 1 }));
  }, 50);
}

function flushAgentLogNow(): void {
  if (agentLogFlushTimer) {
    clearTimeout(agentLogFlushTimer);
    agentLogFlushTimer = null;
  }
  useTerminalStore.setState(s => ({ agentLogVersion: s.agentLogVersion + 1 }));
}

function finalizeAgentEntry(
  terminalId: string,
  entryId: string,
  exitCode: number,
  status: 'done' | 'error' | 'timeout',
): void {
  const entries = agentLogEntries.get(terminalId);
  const entry = entries?.find(e => e.id === entryId);
  if (entry) {
    entry.exitCode = exitCode;
    entry.status = status;
    entry.output = entry.output.trimEnd();
  }
  const ds = agentDisplayStates.get(terminalId);
  if (ds) {
    ds.phase = 'idle';
    ds.activeMarker = null;
    ds.activeEntryId = null;
    ds.lineBuf = '';
  }
  flushAgentLogNow();
}

/** Line-buffer state machine: extracts clean output between START/END markers. */
function processAgentDisplayChunk(terminalId: string, data: string): void {
  const ds = agentDisplayStates.get(terminalId);
  if (!ds || ds.phase === 'idle') return;

  ds.lineBuf += data;
  const parts = ds.lineBuf.split(/\r?\n/);
  ds.lineBuf = parts.pop() || '';

  let dirty = false;
  const entries = agentLogEntries.get(terminalId);
  const activeEntry = entries?.find(e => e.id === ds.activeEntryId);

  const endTag = ds.activeMarker ? `##ATLS_END_${ds.activeMarker}_` : null;
  const startTag = ds.activeMarker ? `##ATLS_START_${ds.activeMarker}##` : null;

  for (const rawLine of parts) {
    const clean = stripAnsi(rawLine.replace(/\r/g, '')).trim();

    switch (ds.phase) {
      case 'awaiting_start':
        // Exact match only — the standalone Write-Host output is just the
        // marker text; the shell echo has surrounding wrapper code.
        if (startTag && clean === startTag) {
          ds.phase = 'streaming';
        }
        break;
      case 'streaming': {
        // END marker can appear mid-line (PowerShell concatenates output
        // with the next Write-Host when | Out-String flushes).
        const endIdx = endTag ? clean.indexOf(endTag) : -1;
        if (endIdx !== -1) {
          // Capture any output text before the marker on this line
          if (endIdx > 0 && activeEntry) {
            const before = clean.slice(0, endIdx).trimEnd();
            if (before) {
              activeEntry.output += before + '\n';
              dirty = true;
            }
          }
          ds.phase = 'idle';
          ds.activeMarker = null;
        } else if (activeEntry) {
          // Skip lines that are just the start marker echo or wrapper noise
          if (startTag && clean === startTag) break;
          if (clean.includes('##ATLS_START_') || clean.includes('##ATLS_END_')) break;
          if (activeEntry.output || clean) {
            activeEntry.output += clean + '\n';
            dirty = true;
          }
        }
        break;
      }
    }
  }

  if (dirty) scheduleAgentLogFlush();
}

// Get output buffer (non-reactive)
function getOutputBufferDirect(id: string): string[] {
  return outputBuffers.get(id) || [];
}

// Append to output buffer and check for completion markers (non-reactive)
function appendOutputDirect(id: string, data: string): void {
  let buffer = outputBuffers.get(id);
  if (!buffer) {
    buffer = [];
    outputBuffers.set(id, buffer);
  }
  buffer.push(data);
  // Trim if too large
  if (buffer.length > MAX_OUTPUT_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - MAX_OUTPUT_BUFFER_SIZE);
  }
  
  // Check for pending completions (event-driven instead of polling)
  const pending = pendingCompletions.get(id);
  if (pending && pending.length > 0) {
    // Accumulate data in pending buffer
    for (const p of pending) {
      p.buffer += data;
    }
    // Check each pending completion for its marker
    checkPendingCompletions(id);
  }

  // Feed agent display filter (streams clean output to agentLogEntries)
  processAgentDisplayChunk(id, data);
}

// Check if any pending completions have their marker
function checkPendingCompletions(terminalId: string): void {
  const pending = pendingCompletions.get(terminalId);
  if (!pending || pending.length === 0) return;
  
  // Process in order (FIFO)
  const toRemove: number[] = [];
  
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const parsed = tryParseAgentExecPtyBuffer(p.buffer, p.marker, p.startMarker);
    if (parsed) {
      clearTimeout(p.timeoutId);
      p.resolve(parsed);
      toRemove.push(i);
    }
  }
  
  // Remove completed items (in reverse to maintain indices)
  for (let i = toRemove.length - 1; i >= 0; i--) {
    pending.splice(toRemove[i], 1);
  }
}

// Clear output buffer (non-reactive)
function clearOutputBufferDirect(id: string): void {
  outputBuffers.set(id, []);
}

// Register a pending completion
function registerPendingCompletion(
  terminalId: string, 
  marker: string, 
  startMarker: string,
  timeoutMs: number
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      // Timeout - remove from pending and resolve with error
      const pending = pendingCompletions.get(terminalId);
      if (pending) {
        const idx = pending.findIndex(p => p.marker === marker);
        if (idx !== -1) {
          const p = pending[idx];
          pending.splice(idx, 1);
          console.warn(`[Terminal] Command timed out after ${timeoutMs}ms`);
          resolve({ 
            exitCode: -1, 
            output: `Timeout. Last output: ${p.buffer.slice(-200)}`, 
            success: false 
          });
        } else {
          resolve({ exitCode: -1, output: 'Timeout (marker not found)', success: false });
        }
      } else {
        resolve({ exitCode: -1, output: 'Timeout (terminal destroyed)', success: false });
      }
    }, timeoutMs);
    
    const completion: PendingCompletion = {
      marker,
      resolve,
      startMarker,
      buffer: '',
      timeoutId,
    };
    
    let pending = pendingCompletions.get(terminalId);
    if (!pending) {
      pending = [];
      pendingCompletions.set(terminalId, pending);
    }
    pending.push(completion);
  });
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  // Initial state
  terminals: new Map(),
  activeTerminalId: null,
  activeAgentTerminalId: null,
  nextTerminalNumber: 1,
  outputListeners: new Map(),
  exitListeners: new Map(),
  
  // Command queue state
  commandQueues: new Map(),
  isExecuting: new Map(),

  // Agent log version (incremented to trigger re-renders)
  agentLogVersion: 0,

  markTerminalDead: (id: string) => {
    set(state => {
      const newTerminals = new Map(state.terminals);
      const terminal = newTerminals.get(id);
      if (terminal) {
        newTerminals.set(id, { ...terminal, isAlive: false });
      }
      return { terminals: newTerminals };
    });
  },

  // Create a new terminal
  // Options:
  //   background: true → don't set as active (used by swarm agents)
  //   name: custom display name (e.g., "Agent: coder-1")
  //   isAgent: true → categorize as agent terminal (shown in agent pane)
  createTerminal: async (cwd?: string, options?: { background?: boolean; name?: string; isAgent?: boolean }) => {
    const id = crypto.randomUUID();
    const number = get().nextTerminalNumber;
    const isBackground = options?.background ?? false;
    const isAgent = options?.isAgent ?? false;
    
    const resolvedCwd = cwd || useAppStore.getState().projectPath || '';
    
    const terminal: TerminalInstance = {
      id,
      name: options?.name || `Terminal ${number}`,
      cwd: resolvedCwd,
      isAlive: true,
      isAgent,
      createdAt: new Date(),
    };
    
    // Initialize output buffer (non-reactive)
    clearOutputBufferDirect(id);

    // Update state with new terminal and increment counter
    // Background terminals don't steal active focus
    // Agent terminals update activeAgentTerminalId instead of activeTerminalId
    set(state => {
      const newTerminals = new Map(state.terminals);
      newTerminals.set(id, terminal);
      if (isBackground) {
        return {
          terminals: newTerminals,
          nextTerminalNumber: state.nextTerminalNumber + 1,
          ...(isAgent ? { activeAgentTerminalId: state.activeAgentTerminalId ?? id } : {}),
        };
      }
      return {
        terminals: newTerminals,
        nextTerminalNumber: state.nextTerminalNumber + 1,
        ...(isAgent ? { activeAgentTerminalId: id } : { activeTerminalId: id }),
      };
    });

    // Set up output listener before spawning PTY
    await get().setupOutputListener(id);

    // Spawn PTY process
    try {
      await invoke('spawn_pty', {
        id,
        cwd: resolvedCwd || undefined,
        shell: undefined, // Use OS default
      });

      // Agent terminals are never rendered in xterm, so fitAddon never runs.
      // Widen the PTY so wrapped marker commands fit on a single ConPTY line.
      if (isAgent) {
        await invoke('resize_pty', { id, cols: 250, rows: 24 }).catch(() => {});
      }

      // Wait for the shell to be ready (prompt appeared) before resolving.
      // PowerShell emits "PS path> " when ready; bash/zsh emit "$ " or "% ".
      const READY_TIMEOUT = 3000;
      const POLL_INTERVAL = 80;
      const deadline = Date.now() + READY_TIMEOUT;
      while (Date.now() < deadline) {
        const buf = getOutputBufferDirect(id);
        const recent = buf.slice(-5).join('').replace(/\x1b\[[0-9;]*m/g, '');
        if (/PS [^>]*>\s*$/.test(recent) || /[$%#]\s*$/.test(recent)) break;
        await sleep(POLL_INTERVAL);
      }
    } catch (error) {
      console.error('Failed to spawn PTY:', error);
      get().markTerminalDead(id);
    }

    return id;
  },

  // Close a terminal
  closeTerminal: async (id: string) => {
    const closingTerminal = get().terminals.get(id);
    await get().cleanupTerminal(id);
    // Clean up leaked resources for the closed terminal
    const pending = pendingCompletions.get(id);
    if (pending) {
      for (const p of pending) clearTimeout(p.timeoutId);
      pendingCompletions.delete(id);
    }
    outputBuffers.delete(id);
    agentLogEntries.delete(id);
    agentDisplayStates.delete(id);
    
    set(state => {
      const newTerminals = new Map(state.terminals);
      newTerminals.delete(id);
      
      const wasAgent = closingTerminal?.isAgent ?? false;
      let newActiveId = state.activeTerminalId;
      let newActiveAgentId = state.activeAgentTerminalId;

      if (wasAgent && state.activeAgentTerminalId === id) {
        const remaining = Array.from(newTerminals.values()).filter(t => t.isAgent);
        newActiveAgentId = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
      } else if (!wasAgent && state.activeTerminalId === id) {
        const remaining = Array.from(newTerminals.values()).filter(t => !t.isAgent);
        newActiveId = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
      }
      
      return {
        terminals: newTerminals,
        activeTerminalId: newActiveId,
        activeAgentTerminalId: newActiveAgentId,
      };
    });
  },

  // Set active terminal (user terminals)
  setActiveTerminal: (id: string) => {
    set({ activeTerminalId: id });
  },

  // Set active agent terminal
  setActiveAgentTerminal: (id: string) => {
    set({ activeAgentTerminalId: id });
  },

  // Append output to buffer (for AI parsing) - non-reactive for performance
  appendOutput: (id: string, data: string) => {
    appendOutputDirect(id, data);
  },

  // Get output buffer for a terminal - non-reactive for performance
  getOutputBuffer: (id: string) => {
    return getOutputBufferDirect(id);
  },

  // Clear output buffer - non-reactive for performance
  clearOutputBuffer: (id: string) => {
    clearOutputBufferDirect(id);
  },

  // Get terminals as array (for rendering)
  getTerminalsArray: () => {
    return Array.from(get().terminals.values());
  },

  getUserTerminals: () => {
    return Array.from(get().terminals.values()).filter(t => !t.isAgent);
  },

  getAgentTerminals: () => {
    return Array.from(get().terminals.values()).filter(t => t.isAgent);
  },

  // Execute command with queuing - waits for previous commands to complete
  executeCommand: async (command: string, terminalId?: string): Promise<ExecutionResult> => {
    let id = terminalId || get().activeTerminalId;
    if (!id) {
      // Auto-create a terminal if none exists
      const newId = await get().createTerminal();
      id = newId;
    }

    const terminal = get().terminals.get(id);
    if (!terminal || !terminal.isAlive) {
      return { exitCode: -1, output: 'Terminal not available', success: false };
    }

    // Add to queue and return a promise that resolves when this command completes
    return new Promise((resolve, reject) => {
      const queueItem: QueuedCommand = { command, resolve, reject };
      
      set(state => {
        const newQueues = new Map(state.commandQueues);
        const queue = newQueues.get(id!) || [];
        queue.push(queueItem);
        newQueues.set(id!, queue);
        return { commandQueues: newQueues };
      });
      
      // Trigger queue processing (non-blocking)
      get()._processQueue(id!);
    });
  },

  // Write directly to PTY without marker wrapping (for dev servers / long-running processes).
  // Detects PowerShell continuation prompt (>>) and auto-retries once.
  writeRaw: async (terminalId: string, data: string) => {
    const terminal = get().terminals.get(terminalId);
    if (!terminal || !terminal.isAlive) {
      throw new Error('Terminal not available');
    }

    const MAX_RETRIES = 1;
    const DETECT_DELAY = 600;
    const RECOVERY_TIMEOUT = 2000;
    const POLL = 80;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await invoke('write_pty', { id: terminalId, data });

      // Brief wait then check if shell fell into continuation mode
      await sleep(DETECT_DELAY);
      const buf = getOutputBufferDirect(terminalId);
      const tail = buf.slice(-8).join('');

      // PowerShell continuation prompt: line ending with ">> " (possibly with ANSI codes)
      if (/>> \s*$/.test(tail.replace(/\x1b\[[0-9;]*m/g, ''))) {
        if (attempt < MAX_RETRIES) {
          console.warn(`[TerminalStore] Detected >> continuation prompt on terminal ${terminalId}, retrying...`);
          // Cancel the partial command with Ctrl+C, then wait for a fresh prompt
          await invoke('write_pty', { id: terminalId, data: '\x03' });
          const deadline = Date.now() + RECOVERY_TIMEOUT;
          while (Date.now() < deadline) {
            const b = getOutputBufferDirect(terminalId);
            const recent = b.slice(-5).join('').replace(/\x1b\[[0-9;]*m/g, '');
            if ((/PS [^>]*>\s*$/.test(recent) || /[$%#]\s*$/.test(recent)) && !/>> /.test(recent)) break;
            await sleep(POLL);
          }
          continue;
        }
      }
      return;
    }
  },

  watchPtyBusy: (terminalId: string, onComplete: (success: boolean) => void) => {
    let cancelled = false;
    const POLL_INTERVAL = 750;
    const INITIAL_GRACE = 2000;
    const startTime = Date.now();

    const tick = async () => {
      while (!cancelled) {
        await sleep(POLL_INTERVAL);
        if (cancelled) return;

        const terminal = get().terminals.get(terminalId);
        if (!terminal || !terminal.isAlive) {
          if (!cancelled) onComplete(false);
          return;
        }

        if (Date.now() - startTime < INITIAL_GRACE) continue;

        // Fast-path: detect >> continuation prompt from output buffer
        const buf = getOutputBufferDirect(terminalId);
        const tail = buf.slice(-6).join('').replace(/\x1b\[[0-9;]*m/g, '');
        if (/>> \s*$/.test(tail)) {
          if (!cancelled) onComplete(false);
          return;
        }

        try {
          const busy = await invoke<boolean>('is_pty_busy', { id: terminalId });
          if (!busy && !cancelled) {
            onComplete(true);
            return;
          }
        } catch {
          if (!cancelled) onComplete(false);
          return;
        }
      }
    };
    tick();

    return () => { cancelled = true; };
  },

  // Process command queue for a terminal (one at a time)
  _processQueue: async (terminalId: string) => {
    // Check if already executing
    if (get().isExecuting.get(terminalId)) {
      return; // Another call is processing the queue
    }
    
    // Mark as executing
    set(state => {
      const newIsExecuting = new Map(state.isExecuting);
      newIsExecuting.set(terminalId, true);
      return { isExecuting: newIsExecuting };
    });
    
    try {
      while (true) {
        // Get next command from queue
        const queue = get().commandQueues.get(terminalId) || [];
        if (queue.length === 0) {
          break; // Queue empty
        }
        
        // Dequeue first command
        const queueItem = queue[0];
        set(state => {
          const newQueues = new Map(state.commandQueues);
          const q = newQueues.get(terminalId) || [];
          q.shift(); // Remove first item
          newQueues.set(terminalId, q);
          return { commandQueues: newQueues };
        });
        
        // Execute the command
        try {
          const result = await get()._executeCommandDirect(queueItem.command, terminalId);
          queueItem.resolve(result);
        } catch (error) {
          queueItem.reject(error instanceof Error ? error : new Error(String(error)));
        }
        
        // Small delay between commands to let terminal settle
        await sleep(50);
      }
    } finally {
      // Mark as not executing
      set(state => {
        const newIsExecuting = new Map(state.isExecuting);
        newIsExecuting.set(terminalId, false);
        return { isExecuting: newIsExecuting };
      });
    }
  },

  // Direct command execution (internal, not queued)
  _executeCommandDirect: async (command: string, terminalId: string): Promise<ExecutionResult> => {
    const terminal = get().terminals.get(terminalId);
    if (!terminal || !terminal.isAlive) {
      return { exitCode: -1, output: 'Terminal not available', success: false };
    }

    const marker = crypto.randomUUID().slice(0, 8);
    const startMarker = `##ATLS_START_${marker}##`;
    const endMarker = `##ATLS_END_${marker}_`;

    // For agent terminals, create a display entry and arm the display filter
    let agentEntryId: string | null = null;
    if (terminal.isAgent) {
      agentEntryId = crypto.randomUUID().slice(0, 8);
      let entries = agentLogEntries.get(terminalId);
      if (!entries) { entries = []; agentLogEntries.set(terminalId, entries); }
      entries.push({
        id: agentEntryId,
        command,
        output: '',
        exitCode: null,
        status: 'running',
        timestamp: Date.now(),
      });
      agentDisplayStates.set(terminalId, {
        phase: 'awaiting_start',
        activeMarker: marker,
        activeEntryId: agentEntryId,
        lineBuf: '',
      });
      scheduleAgentLogFlush();
    }

    // Register completion handler BEFORE sending command (event-driven, no polling)
    const completionPromise = registerPendingCompletion(terminalId, marker, startMarker, 30000);

    // PowerShell command with markers
    // Note: $LASTEXITCODE may be null for cmdlets, so we default to 0
    const wrapped = `Write-Host "${startMarker}"; ${command} | Out-String; $__ec = if ($?) { if ($LASTEXITCODE) { $LASTEXITCODE } else { 0 } } else { if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 } }; Write-Host "${endMarker}$__ec##"`;

    // Write to PTY — use \r only; \r\n causes a double-Enter on Windows ConPTY
    try {
      await invoke('write_pty', { id: terminalId, data: wrapped + '\r' });
    } catch (error) {
      if (terminal.isAgent && agentEntryId) {
        finalizeAgentEntry(terminalId, agentEntryId, -1, 'error');
      }
      return { exitCode: -1, output: `Failed to write to terminal: ${error}`, success: false };
    }

    // Wait for completion (event-driven - resolves when marker detected in output)
    const result = await completionPromise;

    // Finalize agent display entry
    if (terminal.isAgent && agentEntryId) {
      const status = result.exitCode === -1 && result.output.startsWith('Timeout')
        ? 'timeout' as const
        : result.success ? 'done' as const : 'error' as const;
      finalizeAgentEntry(terminalId, agentEntryId, result.exitCode, status);
    }

    return result;
  },

  // Agent terminal display methods

  getAgentLog: (terminalId: string) => {
    return agentLogEntries.get(terminalId) || [];
  },

  appendAgentMessage: (terminalId: string, message: string) => {
    let entries = agentLogEntries.get(terminalId);
    if (!entries) { entries = []; agentLogEntries.set(terminalId, entries); }
    entries.push({
      id: crypto.randomUUID().slice(0, 8),
      command: '',
      output: stripAnsi(message),
      exitCode: null,
      status: 'message',
      timestamp: Date.now(),
    });
    flushAgentLogNow();
  },

  sendInterrupt: async (terminalId: string) => {
    const terminal = get().terminals.get(terminalId);
    if (!terminal?.isAlive) return;
    try {
      await invoke('write_pty', { id: terminalId, data: '\x03' });
    } catch (e) {
      console.warn('[Terminal] Failed to send interrupt:', e);
    }
  },

  // Set up output listener for a terminal
  setupOutputListener: async (id: string) => {
    // Listen for PTY output - triggers completion detection for AI commands
    const outputUnlisten = await safeListen<string>(`pty-output-${id}`, (event) => {
      appendOutputDirect(id, event.payload);
    });

    // Listen for PTY exit
    const exitUnlisten = await safeListen(`pty-exit-${id}`, () => {
      get().markTerminalDead(id);
    });

    set(state => ({
      outputListeners: new Map(state.outputListeners).set(id, outputUnlisten),
      exitListeners: new Map(state.exitListeners).set(id, exitUnlisten),
    }));
  },

  // Cleanup a terminal's resources
  cleanupTerminal: async (id: string) => {
    const state = get();
    
    // Kill PTY
    try {
      await invoke('kill_pty', { id });
    } catch (error) {
      console.error('Error killing PTY:', error);
    }

    // Remove listeners
    const outputListener = state.outputListeners.get(id);
    if (outputListener) outputListener();
    
    const exitListener = state.exitListeners.get(id);
    if (exitListener) exitListener();

    set(state => {
      const newOutputListeners = new Map(state.outputListeners);
      newOutputListeners.delete(id);
      const newExitListeners = new Map(state.exitListeners);
      newExitListeners.delete(id);
      return {
        outputListeners: newOutputListeners,
        exitListeners: newExitListeners,
      };
    });
  },
}));

// Export singleton accessor for non-React contexts
export const getTerminalStore = () => useTerminalStore.getState();
