/**
 * System operation handlers — terminal exec and backend utility passthroughs.
 */

import { ensureTerminalTarget, getTerminalStore, resolveTerminalTarget } from '../../../stores/terminalStore';
import { toTOON, formatResult, FORMAT_RESULT_MAX_GIT } from '../../../utils/toon';
import { countTokensSync } from '../../../utils/tokenCounter';
import type { HandlerContext, OpHandler, StepOutput } from '../types';

/** Strip PTY echo noise and PowerShell cd error blocks; exported for unit tests. */
export function sanitizeExecOutput(output: string): string {
  const normalized = output.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const lines = normalized.split('\n');
  let start = 0;

  // Strip echoed wrapper — ConPTY often splits so the next line starts with `"; ` (continuation of Write-Host "...")
  while (start < lines.length) {
    const trimmed = lines[start]?.trim() ?? '';
    if (trimmed.startsWith('Write-Host "##ATLS_')) {
      start++;
      continue;
    }
    if (
      (trimmed.startsWith('";') || trimmed.startsWith(';'))
      && (trimmed.includes('& {') || trimmed.includes('2>&1') || trimmed.includes('$__ec'))
    ) {
      start++;
      continue;
    }
    if (
      trimmed.startsWith('& {')
      && (trimmed.includes('2>&1') || trimmed.includes('$__ec'))
    ) {
      start++;
      continue;
    }
    // Echoed `& '...\atls-agent-exec-....ps1'` invoke line
    if (
      trimmed.startsWith('& ')
      && trimmed.includes('atls-agent-exec-')
      && trimmed.includes('.ps1')
    ) {
      start++;
      continue;
    }
    break;
  }

  // Strip PowerShell "cd : Cannot find path" error blocks
  while (start < lines.length && lines[start]?.startsWith('cd : Cannot find path ')) {
    start += 1;
    while (start < lines.length) {
      const line = lines[start]?.trim() ?? '';
      if (
        line === ''
        || line.startsWith('At line:')
        || line.startsWith('+ CategoryInfo')
        || line.startsWith('+ FullyQualifiedErrorId')
        || /^[~\s^]+$/.test(line)
      ) {
        start += 1;
        continue;
      }
      break;
    }
  }

  let rest = lines.slice(start).join('\n').trim();
  // Strip any leaked ATLS markers (8-char id from randomUUID().slice(0, 8))
  rest = rest.replace(/##ATLS_START_[a-fA-F0-9]{8}##/g, '');
  rest = rest.replace(/##ATLS_END_[a-fA-F0-9]{8}_(?:-?\d+|\$__ec)##/g, '');
  rest = rest.replace(/##ATLS_END_[a-fA-F0-9]{8}[^#\n]*##/g, '');
  return rest.replace(/\n{3,}/g, '\n\n').trim();
}

function ok(summary: string, content?: unknown): StepOutput {
  return { kind: 'raw', ok: true, refs: [], summary, content };
}

function err(summary: string): StepOutput {
  return { kind: 'raw', ok: false, refs: [], summary, error: summary };
}

export const handleSystemExec: OpHandler = async (params, ctx) => {
  const cmd = params.cmd as string | undefined;
  if (!cmd) return err('system.exec: ERROR missing cmd');

  const terminalStore = getTerminalStore();
  const targetId = await ensureTerminalTarget(params.terminal_id as string | undefined, ctx);

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
    const hash = ctx.store().addChunk(content, 'exec:out', cmd, undefined, undefined, undefined, { ttl: 3 });
    const tk = countTokensSync(content);
    return {
      kind: 'raw' as const,
      ok: true,
      refs: [`h:${hash}`],
      summary: `exec: ${cmd} → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
      content: normalizedResult,
    };
  } catch (error) {
    const content = toTOON({
      exitCode: -1,
      output: `Error: ${error}`,
      success: false,
    });
    return err(content);
  }
};

const MUTATING_GIT_ACTIONS = ['stage', 'unstage', 'commit', 'push', 'reset', 'restore'];

async function echoGitToTerminal(
  ctx: { swarmTerminalId?: string; isSwarmAgent?: boolean },
  raw: unknown,
  action: string,
): Promise<void> {
  try {
    const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const output = typeof r.output === 'string' ? r.output.trim() : '';
    const success = r.success !== false && r.exitCode !== 1;
    const targetId = resolveTerminalTarget(undefined, ctx);
    if (!targetId) return;

    const terminalStore = getTerminalStore();
    const terminal = terminalStore.terminals.get(targetId);
    if (!terminal?.isAlive) return;

    const label = `git ${action}`;
    if (terminal.isAgent) {
      const icon = success ? '\u2713' : '\u2717';
      terminalStore.appendAgentMessage(targetId, `[${label}] ${icon} ${output || action}`);
      return;
    }

    const statusIcon = success ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
    const summary = output.split('\n')[0] || action;
    const line = `\r\n\x1b[90m[${label}]\x1b[0m ${statusIcon} ${summary}\r\n`;
    await terminalStore.writeRaw(targetId, `echo "${line.replace(/"/g, '`"')}"\r`);
  } catch {
    // Non-fatal: terminal echo is best-effort
  }
}

export const handleSystemGit: OpHandler = async (params, ctx) => {
  const action = (params.action as string) ?? 'status';
  try {
    const result = await ctx.atlsBatchQuery('git', params);
    const content = typeof result === 'string' ? result : formatResult(result, FORMAT_RESULT_MAX_GIT);

    if (action === 'restore' && result && typeof result === 'object') {
      clearEditLessonsForRestoredFiles(result as Record<string, unknown>, params, ctx);
    }

    if (MUTATING_GIT_ACTIONS.includes(action)) {
      echoGitToTerminal(ctx, result, action);
      return ok(content, result);
    }

    const source = `git.${action}`;
    const hash = ctx.store().addChunk(content, 'result', source, undefined, undefined, undefined, { ttl: 3 });
    const tk = countTokensSync(content);
    return {
      kind: 'raw' as const,
      ok: true,
      refs: [`h:${hash}`],
      summary: `${source} → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
      tokens: tk,
      content: result,
    };
  } catch (error) {
    return err(`system.git: ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const handleSystemWorkspaces: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('workspaces', params);
    return ok(typeof result === 'string' ? result : formatResult(result), result);
  } catch (error) {
    return err(`system.workspaces: ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const handleSystemHelp: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('help', params);
    return ok(typeof result === 'string' ? result : formatResult(result), result);
  } catch (error) {
    return err(`system.help: ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * After git restore, remove stale `edit:` and `err:` BB entries for
 * restored files so the DAMAGED EDIT banner doesn't persist and
 * trap the model in a fix-loop.
 */
function clearEditLessonsForRestoredFiles(
  result: Record<string, unknown>,
  params: Record<string, unknown>,
  ctx: HandlerContext,
): void {
  try {
    const restored = result.files_restored as string[] | undefined;
    const paramFiles = (params.files ?? params.file_paths ?? params.paths) as string[] | undefined;
    const filePaths = restored ?? paramFiles;
    if (!Array.isArray(filePaths) || filePaths.length === 0) return;

    const store = ctx.store();
    for (const fp of filePaths) {
      const basename = String(fp).split('/').pop() ?? String(fp);
      store.removeBlackboardEntry(`edit:${basename}`);
      store.removeBlackboardEntry(`err:${basename}`);
      store.removeBlackboardEntry(`fix:${basename}`);
      store.removeBlackboardEntry(`repair:${basename}`);
    }
  } catch {
    // Non-fatal: stale BB entries are annoying but not dangerous
  }
}
