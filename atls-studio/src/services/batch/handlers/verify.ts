/**
 * Verify operation handlers — build, test, lint, typecheck.
 *
 * Execution still uses the Rust backend (which handles project-type detection,
 * timeout, and structured result parsing). After the backend returns, we echo
 * the command + abbreviated output into the active terminal so the user can
 * see what ran.
 */

import { getTerminalStore, resolveTerminalTarget } from '../../../stores/terminalStore';
import { buildWorkspaceVerifyHint } from '../../toolHelpers';
import type { OpHandler, StepOutput, VerifyClassification } from '../types';

const VALID_STATUSES: readonly string[] = ['pass', 'pass-with-warnings', 'fail', 'tool-error'];

function verifyResult(passed: boolean, summary: string, content?: unknown, classification?: VerifyClassification): StepOutput {
  return { kind: 'verify_result', ok: passed, refs: [], summary, content, classification };
}

function verifyErr(summary: string, classification: VerifyClassification = 'fail'): StepOutput {
  return { kind: 'verify_result', ok: false, refs: [], summary, error: summary, classification };
}

async function echoVerifyToTerminal(
  ctx: { swarmTerminalId?: string; isSwarmAgent?: boolean },
  raw: unknown,
  mode: string,
  passed: boolean,
): Promise<void> {
  try {
    const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const command = typeof r.command === 'string' ? r.command : `verify.${mode}`;
    const targetId = resolveTerminalTarget(undefined, ctx);
    if (!targetId) return;

    const terminalStore = getTerminalStore();
    const terminal = terminalStore.terminals.get(targetId);
    if (!terminal?.isAlive) return;

    if (terminal.isAgent) {
      const icon = passed ? '\u2713' : '\u2717';
      terminalStore.appendAgentMessage(targetId, `[verify.${mode}] ${icon} ${command}`);
      return;
    }

    const statusIcon = passed ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
    const line = `\r\n\x1b[90m[verify.${mode}]\x1b[0m ${statusIcon} ${command}\r\n`;
    await terminalStore.writeRaw(targetId, `echo "${line.replace(/"/g, '`"')}"\r`);
  } catch {
    // Non-fatal: terminal echo is best-effort
  }
}

/**
 * Classify a raw verify backend response into a structured result.
 * Uses the `status` field as the authoritative signal; falls back to
 * legacy `success`/`passed`/`has_errors` for backward compat.
 */
export function classifyVerifyResult(raw: unknown): { passed: boolean; classification: VerifyClassification } {
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  if (typeof r.status === 'string' && VALID_STATUSES.includes(r.status)) {
    const status = r.status as VerifyClassification;
    return { passed: status === 'pass' || status === 'pass-with-warnings', classification: status };
  }
  const passed = didVerifyPass(raw);
  return { passed, classification: passed ? 'pass' : 'fail' };
}

export function didVerifyPass(raw: unknown): boolean {
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  if (typeof r.status === 'string') {
    return r.status === 'pass' || r.status === 'pass-with-warnings';
  }
  if (typeof r.success === 'boolean') return r.success;
  if (typeof r.passed === 'boolean') return r.passed;
  if (typeof r.has_errors === 'boolean') return !r.has_errors;
  return false;
}

/** Fold backend `error`, `hint`, `_hint`, and monorepo workspace hints into one line for the model/UI. */
function buildVerifyStepSummary(mode: string, passed: boolean, r: Record<string, unknown>, base: string): string {
  const extras: string[] = [];
  if (typeof r.error === 'string' && r.error.trim()) {
    extras.push(r.error.trim());
  }
  if (typeof r.message === 'string' && r.message.trim() && !base.includes(r.message.trim())) {
    extras.push(r.message.trim());
  }
  const hint =
    (typeof r.hint === 'string' && r.hint.trim() ? r.hint.trim() : null)
    ?? (typeof r._hint === 'string' && r._hint.trim() ? r._hint.trim() : null);
  if (hint) {
    extras.push(hint);
  }
  if (typeof r.resolved_path === 'string' && r.resolved_path.trim()) {
    extras.push(`resolved_path: ${r.resolved_path.trim()}`);
  }
  const out = typeof r.output === 'string' ? r.output : '';
  const wsHint = !passed && out ? buildWorkspaceVerifyHint(out) : null;
  if (wsHint) {
    extras.push(wsHint);
  }
  if (extras.length === 0) {
    return base;
  }
  return `${base} — ${extras.join(' — ')}`;
}

function makeVerifyHandler(mode: string): OpHandler {
  return async (params, ctx) => {
    const merged = { ...params, type: mode };
    try {
      const raw = await ctx.atlsBatchQuery('verify', merged);
      const { passed, classification } = classifyVerifyResult(raw);
      const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
      const baseSummary =
        typeof r.summary === 'string' ? r.summary : `verify.${mode}: ${passed ? 'passed' : 'failed'}`;
      const summary = buildVerifyStepSummary(mode, passed, r, baseSummary);
      echoVerifyToTerminal(ctx, raw, mode, passed);
      return verifyResult(passed, summary, raw, classification);
    } catch (caught) {
      return verifyErr(`verify.${mode}: ERROR ${caught instanceof Error ? caught.message : String(caught)}`, 'tool-error');
    }
  };
}

export const handleVerifyBuild: OpHandler = makeVerifyHandler('build');
export const handleVerifyTest: OpHandler = makeVerifyHandler('test');
export const handleVerifyLint: OpHandler = makeVerifyHandler('lint');
export const handleVerifyTypecheck: OpHandler = makeVerifyHandler('typecheck');
