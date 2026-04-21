/**
 * Operation Shorthand — 2-3 char codes for batch `q` line-per-step format.
 *
 * Maps short mnemonic codes to canonical OperationKind strings.
 * Normalization happens once at parse time; all downstream consumers
 * (executor, UI, allowlists, spin detection) see canonical names.
 *
 * Full dotted names are always accepted — shorthands are optional sugar.
 */

import type { OperationKind } from './types';

const SHORT_TO_OP_ENTRIES: ReadonlyArray<readonly [string, OperationKind]> = [
  // discover
  ['sc',  'search.code'],
  ['sy',  'search.symbol'],
  ['su',  'search.usage'],
  ['sv',  'search.similar'],
  ['si',  'search.issues'],
  ['sp',  'search.patterns'],
  ['sm',  'search.memory'],
  // understand
  ['rc',  'read.context'],
  ['rs',  'read.shaped'],
  ['rl',  'read.lines'],
  ['rf',  'read.file'],
  ['ad',  'analyze.deps'],
  ['ac',  'analyze.calls'],
  ['at',  'analyze.structure'],
  ['ai',  'analyze.impact'],
  ['ab',  'analyze.blast_radius'],
  ['ax',  'analyze.extract_plan'],
  ['ag',  'analyze.graph'],
  // change
  ['ce',  'change.edit'],
  ['cc',  'change.create'],
  ['cd',  'change.delete'],
  ['cf',  'change.refactor'],
  ['cb',  'change.rollback'],
  ['cm',  'change.split_module'],
  // verify
  ['vb',  'verify.build'],
  ['vt',  'verify.test'],
  ['vl',  'verify.lint'],
  ['vk',  'verify.typecheck'],
  // session
  ['spl', 'session.plan'],
  ['sa',  'session.advance'],
  ['ss',  'session.status'],
  ['pi',  'session.pin'],
  ['pu',  'session.unpin'],
  ['sg',  'session.stage'],
  ['ust', 'session.unstage'],
  ['pc',  'session.compact'],
  ['ulo', 'session.unload'],
  ['dro', 'session.drop'],
  ['rec', 'session.recall'],
  ['st',  'session.stats'],
  ['db',  'session.debug'],
  ['dg',  'session.diagnose'],
  ['bw',  'session.bb.write'],
  ['br',  'session.bb.read'],
  ['bd',  'session.bb.delete'],
  ['bl',  'session.bb.list'],
  ['ru',  'session.rule'],
  ['em',  'session.emit'],
  ['sh',  'session.shape'],
  // session.load (ld) is deprecated in the model-facing tool list (see
  // toolRef.ts) but its handler stays wired for internal/subagent callers
  // and chat-history replay. The shortcode stays in the registry so the full
  // OperationKind ↔ shortcode round-trip remains consistent; it is simply
  // not advertised in the default descriptors.
  ['ld',  'session.load'],
  ['ch',  'session.compact_history'],
  // annotate (one op: nn / annotate.note — accepts `note` and/or `fields`)
  ['nn',  'annotate.note'],
  ['nk',  'annotate.link'],
  ['nr',  'annotate.retype'],
  ['ns',  'annotate.split'],
  ['nm',  'annotate.merge'],
  ['nd',  'annotate.design'],
  // delegate
  ['dr',  'delegate.retrieve'],
  ['dd',  'delegate.design'],
  ['dc',  'delegate.code'],
  ['dt',  'delegate.test'],
  // system
  ['xe',  'system.exec'],
  ['xg',  'system.git'],
  ['xw',  'system.workspaces'],
  ['xh',  'system.help'],
  // intent
  ['iu',  'intent.understand'],
  ['ie',  'intent.edit'],
  ['im',  'intent.edit_multi'],
  ['iv',  'intent.investigate'],
  ['id',  'intent.diagnose'],
  ['srv', 'intent.survey'],
  ['ifr', 'intent.refactor'],
  ['ic',  'intent.create'],
  ['it',  'intent.test'],
  ['is',  'intent.search_replace'],
  ['ix',  'intent.extract'],
];

export const SHORT_TO_OP: Readonly<Record<string, OperationKind>> =
  Object.fromEntries(SHORT_TO_OP_ENTRIES) as Record<string, OperationKind>;

export const OP_TO_SHORT: Readonly<Record<OperationKind, string>> =
  Object.fromEntries(SHORT_TO_OP_ENTRIES.map(([s, op]) => [op, s])) as Record<OperationKind, string>;

/**
 * Resolve a short code to canonical OperationKind.
 * Returns the input unchanged if it is already canonical or unknown.
 */
export function normalizeOperationUse(raw: string): OperationKind | string {
  return SHORT_TO_OP[raw] ?? raw;
}

// ---------------------------------------------------------------------------
// Param key shorthands (v1 — high-frequency keys)
// ---------------------------------------------------------------------------

export const PARAM_SHORT: Readonly<Record<string, string>> = {
  ps: 'file_paths',
  sn: 'symbol_names',
  qs: 'queries',
  le: 'line_edits',
  sl: 'start_line',
  el: 'end_line',
  sf: 'severity_filter',
  ff: 'focus_files',
};

// ---------------------------------------------------------------------------
// Prompt generation — compact legend for BATCH_TOOL_REF
// ---------------------------------------------------------------------------

/** Generate the shorthand key block for the system prompt. */
export function generateShorthandLegend(): string {
  const opLines = SHORT_TO_OP_ENTRIES.map(([s, op]) => `${s}=${op}`).join(' ');
  const paramLines = Object.entries(PARAM_SHORT).map(([s, c]) => `${s}=${c}`).join(' ');
  return [
    '### Short codes (full names always accepted)',
    `Ops: ${opLines}`,
    `Params: ${paramLines}`,
  ].join('\n');
}

