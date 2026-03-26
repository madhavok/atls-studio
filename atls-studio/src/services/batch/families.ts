/**
 * Operation Families — single source of truth for all batch operation metadata.
 *
 * Every consumer (toolRef prompt, drift tests, chat UI icons, compressor)
 * derives from this one file. Adding a new operation is a one-file edit.
 */

import type { OperationKind } from './types';

// ---------------------------------------------------------------------------
// Core data structure
// ---------------------------------------------------------------------------

export interface OpEntry {
  readonly op: OperationKind;
  /** Optional inline hint shown after the op name in the family listing (e.g. '(hashes:["h:X",...])') */
  readonly hint?: string;
}

export interface OperationFamily {
  readonly icon: string;
  readonly ops: readonly OpEntry[];
}

/**
 * Canonical registry of operation families.
 *
 * Order matters: families and ops within each family are listed in the
 * same order they appear in the BATCH_TOOL_REF prompt. The `satisfies`
 * check ensures every op is a valid OperationKind from types.ts.
 */
export const OPERATION_FAMILIES = {
  discover: {
    icon: '🔍',
    ops: [
      { op: 'search.code' },
      { op: 'search.symbol' },
      { op: 'search.usage' },
      { op: 'search.similar' },
      { op: 'search.issues' },
      { op: 'search.patterns' },
      { op: 'search.memory' },
    ],
  },
  understand: {
    icon: '📖',
    ops: [
      { op: 'read.context' },
      { op: 'read.shaped' },
      { op: 'read.lines' },
      { op: 'read.file' },
      { op: 'analyze.deps' },
      { op: 'analyze.calls' },
      { op: 'analyze.structure' },
      { op: 'analyze.impact' },
      { op: 'analyze.blast_radius' },
      { op: 'analyze.extract_plan' },
    ],
  },
  change: {
    icon: '✏️',
    ops: [
      { op: 'change.edit' },
      { op: 'change.create' },
      { op: 'change.delete' },
      { op: 'change.refactor' },
      { op: 'change.rollback' },
      { op: 'change.split_module' },
    ],
  },
  verify: {
    icon: '✔️',
    ops: [
      { op: 'verify.build' },
      { op: 'verify.test' },
      { op: 'verify.lint' },
      { op: 'verify.typecheck' },
    ],
  },
  session: {
    icon: '⚡',
    ops: [
      { op: 'session.plan' },
      { op: 'session.advance' },
      { op: 'session.status' },
      { op: 'session.pin', hint: '(hashes:["h:X",...])' },
      { op: 'session.unpin' },
      { op: 'session.stage' },
      { op: 'session.unstage' },
      { op: 'session.compact' },
      { op: 'session.unload' },
      { op: 'session.drop' },
      { op: 'session.recall' },
      { op: 'session.stats' },
      { op: 'session.debug' },
      { op: 'session.bb.write' },
      { op: 'session.bb.read' },
      { op: 'session.bb.delete' },
      { op: 'session.bb.list' },
      { op: 'session.rule' },
      { op: 'session.emit' },
      { op: 'session.shape' },
      { op: 'session.load' },
      { op: 'session.compact_history' },
    ],
  },
  annotate: {
    icon: '📝',
    ops: [
      { op: 'annotate.engram', hint: '(hash, fields:{...})' },
      { op: 'annotate.note' },
      { op: 'annotate.link', hint: '(from:"h:X" to:"h:Y")' },
      { op: 'annotate.retype' },
      { op: 'annotate.split' },
      { op: 'annotate.merge' },
      { op: 'annotate.design' },
    ],
  },
  delegate: {
    icon: '🤖',
    ops: [
      { op: 'delegate.retrieve' },
      { op: 'delegate.design' },
    ],
  },
  system: {
    icon: '⌨️',
    ops: [
      { op: 'system.exec', hint: 'cmd → temp .ps1' },
      { op: 'system.git' },
      { op: 'system.workspaces' },
      { op: 'system.help' },
    ],
  },
  intent: {
    icon: '🎯',
    ops: [
      { op: 'intent.understand' },
      { op: 'intent.edit' },
      { op: 'intent.edit_multi' },
      { op: 'intent.investigate' },
      { op: 'intent.diagnose' },
      { op: 'intent.survey' },
      { op: 'intent.refactor' },
      { op: 'intent.create' },
      { op: 'intent.test' },
      { op: 'intent.search_replace' },
      { op: 'intent.extract' },
    ],
  },
} as const satisfies Record<string, OperationFamily>;

export type FamilyName = keyof typeof OPERATION_FAMILIES;

// ---------------------------------------------------------------------------
// Derived constants — computed once at import time
// ---------------------------------------------------------------------------

export const FAMILY_NAMES: readonly FamilyName[] =
  Object.keys(OPERATION_FAMILIES) as FamilyName[];

export const ALL_OPERATIONS: readonly OperationKind[] =
  FAMILY_NAMES.flatMap(f => OPERATION_FAMILIES[f].ops.map(e => e.op));

export const FAMILY_ICONS: Readonly<Record<string, string>> =
  Object.fromEntries(FAMILY_NAMES.map(f => [f, OPERATION_FAMILIES[f].icon]));

// ---------------------------------------------------------------------------
// Prompt generation — produces the "### Operation Families" block
// ---------------------------------------------------------------------------

/**
 * Generate the Operation Families block for BATCH_TOOL_REF.
 * Output is deterministic and matches the hand-written format exactly.
 */
export function generateFamilyLines(): string {
  return FAMILY_NAMES.map(family => {
    const { ops } = OPERATION_FAMILIES[family];
    const opList = ops.map(e => {
      const entry = e as OpEntry;
      return entry.hint ? `${entry.op} ${entry.hint}` : entry.op;
    }).join(', ');
    return `${family}: ${opList}`;
  }).join('\n');
}
