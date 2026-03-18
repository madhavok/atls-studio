/**
 * UHPP Phase 6: Shorthand Notation — Parser, Compiler, and Reference
 *
 * Implements compact operational notation that compiles to existing batch
 * step descriptors. Each shorthand form is parsed into a typed AST node
 * (ShorthandOp) and then compiled into 1+ BatchStepDescriptors.
 *
 * See: docs/UHPP_PHASE6_SHORTHAND.md
 */

import type {
  HydrationMode,
  VerificationLevel,
  ExpansionPolicy,
  ShorthandOp,
  ShorthandOpKind,
  ShorthandError,
  ShorthandParseResult,
  BatchStepDescriptor,
  ShorthandCompileResult,
  HashAlgorithm,
  HashStratification,
} from './uhppCanonical';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_OPS: ReadonlySet<ShorthandOpKind> = new Set([
  'target', 'hydrate', 'neighbors', 'diff', 'extract',
  'rewrite', 'verify', 'stage', 'pin', 'drop',
]);

const HYDRATION_MODES: ReadonlySet<string> = new Set([
  'id_only', 'digest', 'edit_ready_digest', 'exact_span',
  'semantic_slice', 'neighborhood_pack', 'full', 'diff_view',
  'verification_summary',
]);

const VERIFICATION_LEVELS: ReadonlySet<string> = new Set([
  'freshness', 'structural', 'relationship', 'parser', 'typecheck', 'test',
]);

const EXPANSION_POLICIES: ReadonlySet<string> = new Set([
  'minimal', 'local', 'transitive', 'full',
]);

const OP_LEVENSHTEIN_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Hash algorithm stratification
// ---------------------------------------------------------------------------

/** Default hash stratification: FNV1a for speed, SHA-256 for durability. */
export const DEFAULT_HASH_STRATIFICATION: HashStratification = {
  runtime_identity: 'fnv1a_32',
  persistence_identity: 'sha256',
  verification_identity: 'sha256',
};

export function getHashAlgorithm(
  stratification: HashStratification,
  purpose: 'runtime' | 'persistence' | 'verification',
): HashAlgorithm {
  switch (purpose) {
    case 'runtime': return stratification.runtime_identity;
    case 'persistence': return stratification.persistence_identity;
    case 'verification': return stratification.verification_identity;
  }
}

// ---------------------------------------------------------------------------
// Utility: Levenshtein distance for suggestions
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function suggestOperation(input: string): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const op of VALID_OPS) {
    const dist = levenshtein(input.toLowerCase(), op);
    if (dist < bestDist && dist <= OP_LEVENSHTEIN_THRESHOLD) {
      bestDist = dist;
      best = op;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tokenizer helpers
// ---------------------------------------------------------------------------

function stripParens(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  const openParen = trimmed.indexOf('(');
  if (openParen < 0) return null;
  if (!trimmed.endsWith(')')) return null;
  const name = trimmed.slice(0, openParen).trim();
  const args = trimmed.slice(openParen + 1, -1).trim();
  return { name, args };
}

/**
 * Split argument string on commas, respecting quoted strings and parentheses.
 */
function splitArgs(args: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

/**
 * Parse a space-separated list of refs (e.g., "h:abc h:def h:ghi").
 */
function parseRefList(input: string): string[] {
  return input.split(/\s+/).filter(Boolean);
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Error factory
// ---------------------------------------------------------------------------

function makeError(
  message: string,
  position: number,
  expected: string,
  suggestion?: string,
): ShorthandError {
  return { message, position, expected, suggestion };
}

function failResult(raw: string, error: ShorthandError): ShorthandParseResult {
  return { success: false, error, raw_input: raw };
}

function okResult(raw: string, op: ShorthandOp): ShorthandParseResult {
  return { success: true, op, raw_input: raw };
}

// ---------------------------------------------------------------------------
// Parser — individual op parsers
// ---------------------------------------------------------------------------

function parseTarget(args: string[], raw: string): ShorthandParseResult {
  if (args.length < 1 || !args[0]) {
    return failResult(raw, makeError('target() requires a ref argument', 7, 'target(ref)'));
  }
  return okResult(raw, { kind: 'target', ref: args[0] });
}

function parseHydrate(args: string[], raw: string): ShorthandParseResult {
  if (args.length < 2) {
    return failResult(raw, makeError(
      'hydrate() requires mode and ref',
      8, 'hydrate(mode, ref)',
    ));
  }
  const mode = args[0];
  if (!HYDRATION_MODES.has(mode)) {
    return failResult(raw, makeError(
      `Invalid hydration mode '${mode}'`,
      8, `one of: ${[...HYDRATION_MODES].join(', ')}`,
    ));
  }
  return okResult(raw, { kind: 'hydrate', mode: mode as HydrationMode, ref: args[1] });
}

function parseNeighbors(args: string[], raw: string): ShorthandParseResult {
  if (args.length < 2) {
    return failResult(raw, makeError(
      'neighbors() requires ref and scope',
      10, 'neighbors(ref, scope)',
    ));
  }
  const scope = args[1];
  if (!EXPANSION_POLICIES.has(scope)) {
    return failResult(raw, makeError(
      `Invalid scope '${scope}'`,
      10 + args[0].length + 2,
      `one of: ${[...EXPANSION_POLICIES].join(', ')}`,
    ));
  }
  return okResult(raw, { kind: 'neighbors', ref: args[0], scope: scope as ExpansionPolicy });
}

function parseDiff(args: string[], raw: string): ShorthandParseResult {
  if (args.length === 1 && args[0].includes('..')) {
    const [oldRef, newRef] = args[0].split('..', 2);
    if (oldRef && newRef) {
      return okResult(raw, { kind: 'diff', old_ref: oldRef, new_ref: newRef });
    }
  }
  if (args.length >= 2) {
    return okResult(raw, { kind: 'diff', old_ref: args[0], new_ref: args[1] });
  }
  return failResult(raw, makeError(
    'diff() requires old..new or two ref arguments',
    5, 'diff(old..new) or diff(old, new)',
  ));
}

function parseExtract(args: string[], raw: string): ShorthandParseResult {
  if (args.length < 2) {
    return failResult(raw, makeError(
      'extract() requires from_ref and into_path',
      8, 'extract(from, into) or extract(from, into, sym1 sym2)',
    ));
  }
  const fromRef = args[0];
  let intoPath = args[1];
  if (intoPath.startsWith('into:')) {
    intoPath = intoPath.slice(5);
  }
  const symbolNames = args.length >= 3
    ? parseRefList(unquote(args[2]))
    : undefined;
  return okResult(raw, {
    kind: 'extract',
    from_ref: fromRef,
    into_path: intoPath,
    symbol_names: symbolNames,
  });
}

function parseRewrite(args: string[], raw: string): ShorthandParseResult {
  if (args.length < 2) {
    return failResult(raw, makeError(
      'rewrite() requires ref and intent',
      8, 'rewrite(ref, "intent description")',
    ));
  }
  return okResult(raw, {
    kind: 'rewrite',
    ref: args[0],
    intent: unquote(args.slice(1).join(', ')),
  });
}

function parseVerify(args: string[], raw: string): ShorthandParseResult {
  if (args.length < 2) {
    return failResult(raw, makeError(
      'verify() requires level and at least one ref',
      7, 'verify(level, ref1 ref2 ...)',
    ));
  }
  const level = args[0];
  if (!VERIFICATION_LEVELS.has(level)) {
    return failResult(raw, makeError(
      `Invalid verification level '${level}'`,
      7, `one of: ${[...VERIFICATION_LEVELS].join(', ')}`,
    ));
  }
  const refs = parseRefList(args.slice(1).join(' '));
  if (refs.length === 0) {
    return failResult(raw, makeError(
      'verify() requires at least one ref',
      7 + level.length + 2,
      'verify(level, ref1 ref2 ...)',
    ));
  }
  return okResult(raw, { kind: 'verify', level: level as VerificationLevel, refs });
}

function parseRefListOp(kind: 'stage' | 'pin' | 'drop', args: string[], raw: string): ShorthandParseResult {
  const combined = args.join(' ');
  const refs = parseRefList(combined);
  if (refs.length === 0) {
    return failResult(raw, makeError(
      `${kind}() requires at least one ref`,
      kind.length + 1,
      `${kind}(ref1 ref2 ...)`,
    ));
  }
  return okResult(raw, { kind, refs });
}

// ---------------------------------------------------------------------------
// Public parse API
// ---------------------------------------------------------------------------

/**
 * Parse a shorthand expression into a typed ShorthandOp.
 *
 * Accepted forms:
 *   target(h:XXXX)
 *   hydrate(digest, h:XXXX)
 *   neighbors(h:XXXX, local)
 *   diff(h:OLD..h:NEW)
 *   extract(h:XXXX, into:path)
 *   rewrite(h:XXXX, "intent text")
 *   verify(typecheck, h:XXXX h:YYYY)
 *   stage(h:XXXX h:YYYY)
 *   pin(h:XXXX)
 *   drop(h:XXXX h:YYYY)
 */
export function parseShorthand(input: string): ShorthandParseResult {
  const raw = input.trim();
  if (!raw) {
    return failResult(raw, makeError('Empty input', 0, 'shorthand expression'));
  }

  const parsed = stripParens(raw);
  if (!parsed) {
    return failResult(raw, makeError(
      'Expected function-call syntax: op(args)',
      0, 'op(args)',
      'Shorthand uses function-call notation, e.g. target(h:XXXX)',
    ));
  }

  const { name, args: argsStr } = parsed;
  const lowerName = name.toLowerCase();

  if (!VALID_OPS.has(lowerName as ShorthandOpKind)) {
    const suggestion = suggestOperation(lowerName);
    return failResult(raw, makeError(
      `Unknown operation '${name}'`,
      0,
      `one of: ${[...VALID_OPS].join(', ')}`,
      suggestion ? `Did you mean '${suggestion}'?` : undefined,
    ));
  }

  const args = splitArgs(argsStr);

  switch (lowerName) {
    case 'target': return parseTarget(args, raw);
    case 'hydrate': return parseHydrate(args, raw);
    case 'neighbors': return parseNeighbors(args, raw);
    case 'diff': return parseDiff(args, raw);
    case 'extract': return parseExtract(args, raw);
    case 'rewrite': return parseRewrite(args, raw);
    case 'verify': return parseVerify(args, raw);
    case 'stage': return parseRefListOp('stage', args, raw);
    case 'pin': return parseRefListOp('pin', args, raw);
    case 'drop': return parseRefListOp('drop', args, raw);
    default:
      return failResult(raw, makeError(`Unhandled op '${name}'`, 0, 'valid operation'));
  }
}

// ---------------------------------------------------------------------------
// Compiler — shorthand → batch step descriptors
// ---------------------------------------------------------------------------

function compileTarget(op: Extract<ShorthandOp, { kind: 'target' }>): BatchStepDescriptor[] {
  return [{
    step_kind: 'read.shaped',
    params: { ref: op.ref, modifier: 'auto' },
  }];
}

function compileHydrate(op: Extract<ShorthandOp, { kind: 'hydrate' }>): BatchStepDescriptor[] {
  return [{
    step_kind: 'read.shaped',
    params: { ref: op.ref, hydration_mode: op.mode },
  }];
}

function compileNeighbors(op: Extract<ShorthandOp, { kind: 'neighbors' }>): BatchStepDescriptor[] {
  return [{
    step_kind: 'analyze.deps',
    params: { ref: op.ref, expansion: op.scope },
  }];
}

function compileDiff(op: Extract<ShorthandOp, { kind: 'diff' }>): BatchStepDescriptor[] {
  return [{
    step_kind: 'read.shaped',
    params: { diff_ref: `${op.old_ref}..${op.new_ref}` },
  }];
}

function compileExtract(op: Extract<ShorthandOp, { kind: 'extract' }>): BatchStepDescriptor[] {
  const params: Record<string, unknown> = {
    action: 'execute',
    operation: 'extract',
    source_ref: op.from_ref,
    destination_file: op.into_path,
  };
  if (op.symbol_names?.length) {
    params.symbol_names = op.symbol_names;
  }
  return [{
    step_kind: 'change.refactor',
    params,
  }];
}

function compileRewrite(op: Extract<ShorthandOp, { kind: 'rewrite' }>): BatchStepDescriptor[] {
  return [{
    step_kind: 'change.edit',
    params: { ref: op.ref, intent: op.intent },
  }];
}

function compileVerify(op: Extract<ShorthandOp, { kind: 'verify' }>): BatchStepDescriptor[] {
  const levelToStep: Record<string, string> = {
    freshness: 'verify.freshness',
    structural: 'verify.build',
    relationship: 'verify.build',
    parser: 'verify.lint',
    typecheck: 'verify.build',
    test: 'verify.test',
  };
  return [{
    step_kind: levelToStep[op.level] ?? `verify.${op.level}`,
    params: { target_refs: op.refs, level: op.level },
  }];
}

function compileRefListOp(
  stepKind: string,
  refs: string[],
): BatchStepDescriptor[] {
  return [{
    step_kind: stepKind,
    params: { refs },
  }];
}

/**
 * Compile a parsed shorthand op into batch step descriptors.
 */
export function compileShorthand(op: ShorthandOp): ShorthandCompileResult {
  const warnings: string[] = [];
  let steps: BatchStepDescriptor[];

  switch (op.kind) {
    case 'target':
      steps = compileTarget(op);
      break;
    case 'hydrate':
      steps = compileHydrate(op);
      break;
    case 'neighbors':
      steps = compileNeighbors(op);
      break;
    case 'diff':
      steps = compileDiff(op);
      break;
    case 'extract':
      steps = compileExtract(op);
      if (op.symbol_names && op.symbol_names.length > 10) {
        warnings.push('Extracting >10 symbols may produce large changeset');
      }
      break;
    case 'rewrite':
      steps = compileRewrite(op);
      break;
    case 'verify':
      steps = compileVerify(op);
      break;
    case 'stage':
      steps = compileRefListOp('session.stage', op.refs);
      break;
    case 'pin':
      steps = compileRefListOp('session.pin', op.refs);
      break;
    case 'drop':
      steps = compileRefListOp('session.drop', op.refs);
      break;
    default: {
      const _exhaustive: never = op;
      steps = [];
      warnings.push(`Unhandled shorthand op kind: ${(_exhaustive as ShorthandOp).kind}`);
    }
  }

  return { op, batch_steps: steps, warnings };
}

// ---------------------------------------------------------------------------
// Convenience: parse + compile in one call
// ---------------------------------------------------------------------------

/**
 * Parse and compile a shorthand expression in one step.
 * Returns either a compile result or a parse error.
 */
export function parseAndCompile(
  input: string,
): { compiled: ShorthandCompileResult } | { error: ShorthandError } {
  const parseResult = parseShorthand(input);
  if (!parseResult.success || !parseResult.op) {
    return { error: parseResult.error! };
  }
  return { compiled: compileShorthand(parseResult.op) };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate a shorthand expression without compiling.
 * Returns true if the expression can be parsed.
 */
export function isValidShorthand(input: string): boolean {
  return parseShorthand(input).success;
}

/**
 * Get the operation kind from a shorthand expression, or undefined if invalid.
 */
export function getShorthandKind(input: string): ShorthandOpKind | undefined {
  const result = parseShorthand(input);
  return result.op?.kind;
}

// ---------------------------------------------------------------------------
// Syntax reference — for inclusion in HASH_PROTOCOL_SPEC
// ---------------------------------------------------------------------------

/**
 * Generate the shorthand syntax reference block suitable for
 * injection into HASH_PROTOCOL_SPEC or model system prompts.
 */
export function generateShorthandReference(): string {
  return [
    '## UHPP Shorthand Operations',
    '',
    'Compact notation for common workflows. Each compiles to batch steps.',
    '',
    '| Shorthand | Purpose | Example |',
    '|-----------|---------|---------|',
    '| `target(ref)` | Resolve ref to current target | `target(h:abc1)` |',
    '| `hydrate(mode, ref)` | Expand ref at hydration mode | `hydrate(digest, h:abc1)` |',
    '| `neighbors(ref, scope)` | Expand context around ref | `neighbors(h:abc1, local)` |',
    '| `diff(old..new)` | View diff between two refs | `diff(h:old1..h:new1)` |',
    '| `extract(from, into)` | Extract content to new file | `extract(h:abc1, src/helpers.ts)` |',
    '| `rewrite(ref, intent)` | Rewrite with stated intent | `rewrite(h:abc1, "add error handling")` |',
    '| `verify(level, refs)` | Verify at specified level | `verify(typecheck, h:abc1 h:def2)` |',
    '| `stage(refs)` | Stage refs into context | `stage(h:abc1 h:def2)` |',
    '| `pin(refs)` | Pin refs to prevent eviction | `pin(h:abc1)` |',
    '| `drop(refs)` | Drop refs from context | `drop(h:abc1 h:def2)` |',
    '',
    'Hydration modes: id_only, digest, edit_ready_digest, exact_span, semantic_slice, neighborhood_pack, full, diff_view, verification_summary',
    'Verification levels: freshness, structural, relationship, parser, typecheck, test',
    'Expansion scopes: minimal, local, transitive, full',
  ].join('\n');
}

/**
 * List all valid shorthand operation names.
 */
export function listShorthandOps(): ShorthandOpKind[] {
  return [...VALID_OPS];
}
