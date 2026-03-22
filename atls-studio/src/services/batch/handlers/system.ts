/**
 * System operation handlers — terminal exec and backend utility passthroughs.
 */

import { useAppStore } from '../../../stores/appStore';
import { getTerminalStore } from '../../../stores/terminalStore';
import { toTOON } from '../../../utils/toon';
import type { HandlerContext, OpHandler, StepOutput } from '../types';

/** Prefix workspace-relative path with rel_path when git runs in project root. Exported for tests. */
export function prefixFilePath(path: string, relPath: string): string {
  const p = path.replace(/\\/g, '/');
  const r = relPath.replace(/\\/g, '/');
  if (p === r || p.startsWith(r + '/')) return path;
  return `${r}/${p}`;
}
import { checkRetention } from './retention';

function sanitizeExecOutput(output: string): string {
  const normalized = output.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const lines = normalized.split('\n');
  let start = 0;

  if (lines[0]?.startsWith('"; ') && lines[0].includes(' | Out-String; $__ec = if ($?) {')) {
    start = 1;
  }

  while (start < lines.length && lines[start]?.startsWith('cd : Cannot find path ')) {
    start += 1;
    while (start < lines.length) {
      const line = lines[start]?.trim() ?? '';
      if (
        line === '' ||
        line.startsWith('At line:') ||
        line.startsWith('+') ||
        line.startsWith('~') ||
        line.startsWith('+ CategoryInfo') ||
        line.startsWith('+ FullyQualifiedErrorId')
      ) {
        start += 1;
        continue;
      }
      break;
    }
  }

  return lines.slice(start).join('\n').trim();
}

function ok(summary: string, content?: unknown): StepOutput {
  return { kind: 'raw', ok: true, refs: [], summary, content };
}

function err(summary: string): StepOutput {
  return { kind: 'raw', ok: false, refs: [], summary, error: summary };
}

// Session-scoped agent terminal for the main (non-swarm) agent.
// Reused across exec calls within the same AI session to avoid spawning
// a new PTY for every command. Reset via resetMainAgentTerminal().
let _mainAgentTerminalId: string | null = null;

/** Clear cached main-agent terminal. Called when a new AI session starts. */
export function resetMainAgentTerminal(): void {
  _mainAgentTerminalId = null;
}

export function resolveTerminalTarget(
  explicitId: string | undefined,
  ctx: { swarmTerminalId?: string; isSwarmAgent?: boolean },
): string | null {
  if (explicitId) return explicitId;
  if (ctx.swarmTerminalId) return ctx.swarmTerminalId;
  // Reuse cached main-agent terminal if still alive
  if (_mainAgentTerminalId) {
    const t = getTerminalStore().terminals.get(_mainAgentTerminalId);
    if (t?.isAlive) return _mainAgentTerminalId;
    _mainAgentTerminalId = null;
  }
  return null;
}

async function ensureTerminalTarget(
  explicitId: string | undefined,
  ctx: { swarmTerminalId?: string; isSwarmAgent?: boolean },
): Promise<string> {
  const id = resolveTerminalTarget(explicitId, ctx);
  if (id) return id;
  // All AI-driven commands use agent terminals
  const terminalStore = getTerminalStore();
  const newId = await terminalStore.createTerminal(undefined, {
    background: true,
    isAgent: true,
    name: ctx.isSwarmAgent ? undefined : 'Agent',
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  // Cache for the main (non-swarm) agent session
  if (!ctx.isSwarmAgent) _mainAgentTerminalId = newId;
  return newId;
}

export const handleSystemExec: OpHandler = async (params, ctx) => {
  const cmd = params.cmd as string | undefined;
  if (!cmd) return err('system.exec: ERROR missing cmd');

  const terminalStore = getTerminalStore();
  const targetId = await ensureTerminalTarget(params.terminal_id as string | undefined, ctx);
  useAppStore.getState().setTerminalOpen(true);

  try {
    const result = await terminalStore.executeCommand(cmd, targetId);
    const sanitizedOutput = sanitizeExecOutput(result.output) || '(no output)';
    const normalizedResult = {
      ...result,
      output: sanitizedOutput,
    };
    const content = toTOON({
      exitCode: result.exitCode,
      output: sanitizedOutput,
      success: result.success,
    });
    const retained = checkRetention('system.exec', params, content, result.success, 'raw', `exec: ${cmd.slice(0, 60)}`);
    if (retained.reused) return retained.output;
    return ok(content, normalizedResult);
  } catch (error) {
    const content = toTOON({
      exitCode: -1,
      output: `Error: ${error}`,
      success: false,
    });
    return err(content);
  }
};

/** Build git command string; prefixes file paths with workspace rel_path when applicable. Exported for tests. */
export function buildGitCommand(params: Record<string, unknown>, ctx: HandlerContext): string | null {
  const action = (params.action as string) ?? 'status';
  const parts = ['git'];

  const wsName = params.workspace as string | undefined;
  const relPath = ctx.getWorkspaceRelPath?.(wsName) ?? null;

  const prefixFiles = (paths: string[]): string[] => {
    if (!relPath || relPath === '.') return paths;
    return paths.map((p) => prefixFilePath(String(p), relPath));
  };

  switch (action) {
    case 'status': parts.push('status'); break;
    case 'diff': {
      parts.push('diff');
      if (params.staged || params.cached) parts.push('--cached');
      const files = params.files ?? params.file_paths ?? params.paths;
      if (Array.isArray(files)) parts.push('--', ...prefixFiles(files.map(String)));
      break;
    }
    case 'stage': {
      const files = params.files ?? params.file_paths ?? params.paths;
      if (params.all) { parts.push('add', '-A'); }
      else if (Array.isArray(files) && files.length > 0) { parts.push('add', '--', ...prefixFiles(files.map(String))); }
      else return null;
      break;
    }
    case 'unstage': {
      const files = params.files ?? params.file_paths ?? params.paths;
      parts.push('restore', '--staged');
      if (Array.isArray(files) && files.length > 0) parts.push('--', ...prefixFiles(files.map(String)));
      else parts.push('.');
      break;
    }
    case 'commit': {
      const msg = params.message as string | undefined;
      if (!msg) return null;
      parts.push('commit', '-m', `"${msg.replace(/"/g, '\\"')}"`);
      break;
    }
    case 'push': parts.push('push'); break;
    case 'log': {
      parts.push('log', '--oneline', `-${params.count ?? 10}`);
      break;
    }
    case 'reset': {
      parts.push('reset');
      if (params.hard) parts.push('--hard');
      if (typeof params.ref === 'string') parts.push(params.ref);
      break;
    }
    default: return null;
  }
  return parts.join(' ');
}

export const handleSystemGit: OpHandler = async (params, ctx) => {
  const gitCmd = buildGitCommand(params, ctx);

  // Mutating actions (stage, commit, push, reset) run through PTY for visibility
  const mutatingActions = ['stage', 'unstage', 'commit', 'push', 'reset'];
  const action = (params.action as string) ?? 'status';

  if (gitCmd && mutatingActions.includes(action)) {
    const terminalStore = getTerminalStore();
    const targetId = await ensureTerminalTarget(params.terminal_id as string | undefined, ctx);

    useAppStore.getState().setTerminalOpen(true);

    try {
      const result = await terminalStore.executeCommand(gitCmd, targetId);
      const sanitizedOutput = sanitizeExecOutput(result.output) || '(no output)';
      const content = toTOON({ exitCode: result.exitCode, output: sanitizedOutput, success: result.success });
      const retained = checkRetention('system.git', params, content, result.success, 'raw', `git: ${action}`);
      if (retained.reused) return retained.output;
      return ok(content, { ...result, output: sanitizedOutput });
    } catch (error) {
      return err(`system.git: ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Read-only actions use the structured backend for rich parsed output
  try {
    const result = await ctx.atlsBatchQuery('git', params);
    const content = typeof result === 'string' ? result : JSON.stringify(result);
    const retained = checkRetention('system.git', params, content, true, 'raw', `git: ${action}`);
    if (retained.reused) return retained.output;
    return ok(content, result);
  } catch (error) {
    return err(`system.git: ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const handleSystemWorkspaces: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('workspaces', params);
    return ok(typeof result === 'string' ? result : JSON.stringify(result), result);
  } catch (error) {
    return err(`system.workspaces: ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const handleSystemHelp: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('help', params);
    return ok(typeof result === 'string' ? result : JSON.stringify(result), result);
  } catch (error) {
    return err(`system.help: ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
};
