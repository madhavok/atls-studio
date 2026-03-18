/**
 * Verify operation handlers — build, test, lint, typecheck.
 *
 * Execution still uses the Rust backend (which handles project-type detection,
 * timeout, and structured result parsing). After the backend returns, we echo
 * the command + abbreviated output into the active terminal so the user can
 * see what ran.
 */

import { useAppStore } from '../../../stores/appStore';
import { getTerminalStore } from '../../../stores/terminalStore';
import { resolveTerminalTarget } from './system';
import type { OpHandler, StepOutput, VerifyClassification } from '../types';
import { checkRetention } from './retention';

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

    if (!terminal.isAgent) {
      useAppStore.getState().setTerminalOpen(true);
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

function makeVerifyHandler(mode: string): OpHandler {
  return async (params, ctx) => {
    const merged = { ...params, type: mode };
    try {
      const raw = await ctx.atlsBatchQuery('verify', merged);
      const { passed, classification } = classifyVerifyResult(raw);
      const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
      const summary = typeof r.summary === 'string' ? r.summary : `verify.${mode}: ${passed ? 'passed' : 'failed'}`;
      const resultStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const retained = checkRetention(`verify.${mode}` as any, params, resultStr, passed, 'verify_result', `verify.${mode}`, classification);
      if (retained.reused) return retained.output;

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
