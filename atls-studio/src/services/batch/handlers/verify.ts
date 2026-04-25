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
import { countTokensSync } from '../../../utils/tokenCounter';
import { formatResult } from '../../../utils/toon';
import { checkRetention } from './retention';
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
  if (typeof r.status === 'string' && VALID_STATUSES.includes(r.status)) {
    return r.status === 'pass' || r.status === 'pass-with-warnings';
  }
  if (typeof r.success === 'boolean') return r.success;
  if (typeof r.passed === 'boolean') return r.passed;
  if (typeof r.has_errors === 'boolean') return !r.has_errors;
  return false;
}

/**
 * Default tail size for verify.* bodies. Matches PowerShell `Select-Object
 * -Last 20` / unix `tail -n 20`. Models can override via the `tail_lines`
 * param on any verify.* step; hard-capped at VERIFY_TAIL_MAX_CAP to prevent
 * accidental context blowup.
 */
const VERIFY_TAIL_DEFAULT_LINES = 20;
const VERIFY_TAIL_MAX_CAP = 200;
/** Byte budget per line — the total byte cap scales with requested line count. */
const VERIFY_TAIL_BYTES_PER_LINE = 256;

/**
 * Resolve the effective `tail_lines` from caller params. Clamps to
 * [1, VERIFY_TAIL_MAX_CAP]; non-numeric / missing falls back to the default.
 */
function resolveTailLines(params: Record<string, unknown>): number {
  const raw = params.tail_lines;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return VERIFY_TAIL_DEFAULT_LINES;
  return Math.min(VERIFY_TAIL_MAX_CAP, Math.max(1, Math.floor(raw)));
}

/**
 * Bound a body of text to the last N lines / M bytes. UTF-8 safe on the
 * byte slice (snaps to a char boundary). Preserves the tail end because
 * the relevant diagnostics usually sit at the bottom.
 */
function boundTail(text: string, maxLines: number): string {
  const trimmed = text.replace(/\n+$/, '');
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  const from = Math.max(0, lines.length - maxLines);
  const tailed = lines.slice(from).join('\n');
  const maxBytes = maxLines * VERIFY_TAIL_BYTES_PER_LINE;
  if (tailed.length <= maxBytes) return tailed;
  // Naive byte slice is fine — JS strings are UTF-16 units; we accept a
  // possible low-surrogate orphan at the start because `…` follows anyway.
  return '…' + tailed.slice(tailed.length - maxBytes);
}

/**
 * Extract the preferred body text for the tail.
 *
 * Order of preference:
 *   1. Concatenated `rendered` fields from parsed `issues[]` — only clippy
 *      produces this (via `--message-format=json`), and it's what a user
 *      sees with `--message-format=human`. ~4.7x smaller than NDJSON tail.
 *   2. Backend-provided `raw_tail` — pre-bounded tail of combined
 *      stdout+stderr. Works for eslint/flake8/go vet/pytest/tsc/cargo build
 *      (they emit human-readable output natively).
 *
 * See src/services/batch/handlers/lintOutputFormats.test.ts for the
 * measurement that drove this ordering.
 */
function extractVerifyBody(r: Record<string, unknown>, maxLines: number): string {
  const issues = Array.isArray(r.issues) ? (r.issues as unknown[]) : null;
  if (issues && issues.length > 0) {
    const rendered: string[] = [];
    for (const iss of issues) {
      if (iss && typeof iss === 'object' && typeof (iss as { rendered?: unknown }).rendered === 'string') {
        rendered.push((iss as { rendered: string }).rendered);
      }
    }
    if (rendered.length > 0) {
      return boundTail(rendered.join(''), maxLines);
    }
  }
  if (typeof r.raw_tail === 'string') {
    return boundTail(r.raw_tail as string, maxLines);
  }
  return '';
}

/**
 * Build the model-facing chunk body for a verify.* step.
 *
 * Output shape:
 *   verify.<mode>: <status> (<N issues>, exit <code>)
 *   <tail body — human-readable, last `tail_lines` lines>
 *
 * `tail_lines` defaults to 20 and is capped at 200 — same knob as PowerShell
 * `Select-Object -Last N`. Errors tend to cluster at the bottom of compiler/
 * linter output, so the tail captures the most actionable signal.
 *
 * Source of the tail body, in order:
 *   1. Concatenated `issues[*].rendered` (clippy — human-readable form of
 *      the parsed NDJSON; ~4.7x better than tailing raw NDJSON).
 *   2. `raw_tail` field from Rust (all other linters — clean stdout tail).
 *
 * Falls back to `formatResult(raw)` when neither is available (older Rust
 * binary or unexpected shape). No regression path.
 */
export function formatVerifyTail(
  r: Record<string, unknown>,
  mode: string,
  passed: boolean,
  params: Record<string, unknown> = {},
): string {
  const count = typeof r.issue_count === 'number' ? (r.issue_count as number) : undefined;
  const exit = typeof r.exit_code === 'number' ? (r.exit_code as number) : undefined;
  const parts: string[] = [];
  if (count !== undefined) parts.push(`${count} issues`);
  if (exit !== undefined) parts.push(`exit ${exit}`);
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const statusLine = `verify.${mode}: ${passed ? 'passed' : 'failed'}${suffix}`;
  const maxLines = resolveTailLines(params);
  const body = extractVerifyBody(r, maxLines);
  return body ? `${statusLine}\n${body}` : statusLine;
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

      // Prefer compact tail body (uses issues[].rendered when present, else
      // raw_tail). Honors agent-supplied `tail_lines` param (default 20, max
      // 200). Falls back to TOON formatting only when neither tail source
      // is available.
      const hasTailSource = r.raw_tail !== undefined || Array.isArray(r.issues);
      const resultStr = hasTailSource
        ? formatVerifyTail(r, mode, passed, params)
        : formatResult(raw);
      const opKind = `verify.${mode}` as const;
      const retained = checkRetention(opKind, params, resultStr, passed, 'verify_result', opKind, classification);
      if (retained.reused) return retained.output;

      const hash = ctx.store().addChunk(resultStr, 'result', opKind, undefined, summary);
      const tk = countTokensSync(resultStr);
      return {
        kind: 'verify_result' as const,
        ok: passed,
        refs: [`h:${hash}`],
        summary: `${opKind}: ${passed ? 'passed' : 'failed'} → h:${hash} (${(tk / 1000).toFixed(1)}k tk)`,
        tokens: tk,
        content: raw,
        classification,
      };
    } catch (caught) {
      return verifyErr(`verify.${mode}: ERROR ${caught instanceof Error ? caught.message : String(caught)}`, 'tool-error');
    }
  };
}

export const handleVerifyBuild: OpHandler = makeVerifyHandler('build');
export const handleVerifyTest: OpHandler = makeVerifyHandler('test');
export const handleVerifyLint: OpHandler = makeVerifyHandler('lint');
export const handleVerifyTypecheck: OpHandler = makeVerifyHandler('typecheck');
