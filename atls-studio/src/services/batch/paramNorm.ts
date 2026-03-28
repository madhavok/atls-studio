/**
 * Parameter Normalization — centralized alias resolution and coercion.
 *
 * Resolves all param aliases to canonical names before handler dispatch.
 * Absorbs cross-IDE conventions (Cursor, Cline, Aider, Claude) so
 * cross-trained models work without handler-level compensation.
 */

import type { OperationKind } from './types';
import { validateSourceIdentity } from '../universalFreshness';

// ---------------------------------------------------------------------------
// Alias Registry — declarative mapping from alias → canonical name
// ---------------------------------------------------------------------------

/** Global aliases applied to all operations. */
const GLOBAL_ALIASES: Readonly<Record<string, string>> = {
  // File path: ATLS internal
  file: 'file_path',
  f: 'file_path',
  // File path: cross-IDE (Cline, Aider, Claude, Cursor)
  path: 'file_path',
  target_file: 'file_path',
  source_file: 'file_path',
  // Symbol
  symbol: 'symbol_names',
  symbol_name: 'symbol_names',
  // Edit content: cross-IDE
  old_str: 'old',
  old_string: 'old',
  new_str: 'new',
  new_string: 'new',
  original_lines: 'old',
  updated_lines: 'new',
  // Other
  command: 'cmd',
  contents: 'content',
  refs: 'hashes',
};

/**
 * Per-operation alias overrides. These take precedence over globals
 * and only apply when the step's `use` matches the key.
 */
const OP_ALIASES: Readonly<Partial<Record<OperationKind, Readonly<Record<string, string>>>>> = {
  'search.code': { query: 'queries' },
  'search.issues': { mode: 'issue_mode' },
  'search.symbol': { name: 'symbol_names', query: 'symbol_names' },
  'analyze.impact': { from: 'file_paths' },
  'analyze.blast_radius': { from: 'file_paths' },
  'intent.understand': { file: 'file_paths', files: 'file_paths' },
  'intent.edit_multi': { files: 'edits', changes: 'edits' },
  'intent.investigate': { files: 'file_paths' },
  'intent.diagnose': { files: 'file_paths', filter: 'severity' },
  'intent.survey': { dir: 'directory', path: 'directory' },
  'intent.refactor': { file: 'file_path', symbol: 'symbol_names', symbols: 'symbol_names' },
  'change.refactor': { source_file: 'source_file', target_file: 'target_file', from: 'source_file', to: 'target_file' },
  'intent.create': { path: 'target_path', file: 'target_path', references: 'ref_files' },
  'intent.test': { file: 'source_file', test: 'test_file' },
  'intent.search_replace': { query: 'search_query', old: 'old_text', new: 'new_text', glob: 'file_glob' },
  'intent.extract': { file: 'source_file', symbols: 'symbol_names', target: 'target_file' },
  'system.git': { paths: 'files', file_paths: 'files' },
};

// ---------------------------------------------------------------------------
// Scalar-to-Array Coercion — promote single values to arrays
// ---------------------------------------------------------------------------

/**
 * After alias resolution, if the canonical key holds a scalar string,
 * promote it to a single-element array under the target key.
 * Source key is removed after promotion.
 *
 * Only applies to ops that expect the array form — ops that use
 * singular `file_path` (e.g. change.edit, read.lines) are excluded.
 */
const SCALAR_TO_ARRAY: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'file_path', to: 'file_paths' },
  { from: 'symbol_name', to: 'symbol_names' },
];

/** Ops that use singular file_path — do NOT promote to file_paths. */
const SINGULAR_FILE_PATH_OPS = new Set<OperationKind>([
  'change.edit',
  'change.create',
  'change.split_module',
  'read.lines',
  'analyze.extract_plan',
  'intent.edit',
  'intent.refactor',
  'intent.extract',
]);

/**
 * Operations where `query` (string) should be promoted to `queries` (array).
 * Only applies when the operation expects `queries` as canonical.
 */
const QUERY_TO_QUERIES_OPS = new Set<OperationKind>(['search.code']);

// ---------------------------------------------------------------------------
// Symbol prefix stripping — fn(name) / cls(name) → name
// ---------------------------------------------------------------------------

const SYMBOL_PREFIX_RE = /^(?:fn|sym|cls|class|struct|trait|interface|protocol|enum|record|extension|mixin|impl|type|const|macro|ctor|property|field|operator|event|object|actor|union)\((.+)\)$/;

function stripSymbolPrefix(value: string): string {
  const trimmed = value.trim();
  const match = SYMBOL_PREFIX_RE.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function normalizeSymbolNames(arr: unknown[]): string[] {
  return arr
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map(stripSymbolPrefix);
}

// ---------------------------------------------------------------------------
// Key-to-keys coercion for blackboard ops
// ---------------------------------------------------------------------------

const KEY_TO_KEYS_OPS = new Set<OperationKind>([
  'session.bb.read',
  'session.bb.delete',
]);

const BB_WRITE_ALIASES: Readonly<Record<string, string>> = {
  derivedFrom: 'derived_from',
};

// ---------------------------------------------------------------------------
// file_paths coercion (batch bindings, model JSON)
// ---------------------------------------------------------------------------

/**
 * Coerce `file_paths` from bindings / nested batch JSON into deduped path/ref strings.
 * Accepts: string, string[], nested arrays, `{ ref }`, `{ path }`, `{ file }`, `{ file_path }`.
 */
export function coerceFilePathsArray(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) out.push(t);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.ref === 'string' && o.ref.trim()) {
        out.push(o.ref.trim());
        return;
      }
      if (typeof o.path === 'string' && o.path.trim()) {
        out.push(o.path.trim());
        return;
      }
      if (typeof o.file === 'string' && o.file.trim()) {
        out.push(o.file.trim());
        return;
      }
      if (typeof o.file_path === 'string' && o.file_path.trim()) {
        out.push(o.file_path.trim());
        return;
      }
    }
  };
  walk(value);
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const p of out) {
    const k = p.replace(/\\/g, '/').toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      dedup.push(p);
    }
  }
  return dedup;
}

/**
 * Coerce `hashes` / `refs` for session.pin (and similar) from batch JSON:
 * strings, nested arrays, `{ ref }`, `{ hash }`, `{ h }`.
 */
export function normalizeHashRefsToStrings(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) out.push(t);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.ref === 'string' && o.ref.trim()) {
        out.push(o.ref.trim());
        return;
      }
      if (typeof o.hash === 'string' && o.hash.trim()) {
        out.push(o.hash.trim());
        return;
      }
      if (typeof o.h === 'string' && o.h.trim()) {
        out.push(o.h.trim());
        return;
      }
    }
  };
  walk(value);
  return out;
}

// ---------------------------------------------------------------------------
// normalizeStepParams — the single entry point
// ---------------------------------------------------------------------------

/**
 * Normalize step `with` params for a given operation.
 *
 * 1. Resolves global + op-specific aliases to canonical names.
 * 2. Promotes scalars to arrays where needed.
 * 3. Strips symbol kind prefixes (fn/cls/...).
 * 4. Returns a new object — never mutates the input.
 */
export function normalizeStepParams(
  op: OperationKind,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const opAliases = OP_ALIASES[op];

  // Pass 1: resolve aliases
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;

    const canonical =
      opAliases?.[key] ??
      (op === 'session.bb.write' ? BB_WRITE_ALIASES[key] : undefined) ??
      GLOBAL_ALIASES[key] ??
      key;

    // Don't overwrite a value already set under the canonical name
    if (canonical !== key && out[canonical] !== undefined) {
      // Keep the existing canonical value, skip the alias
      continue;
    }
    out[canonical] = value;
  }

  // Pass 2: scalar-to-array coercion
  for (const { from, to } of SCALAR_TO_ARRAY) {
    if (from === 'file_path' && SINGULAR_FILE_PATH_OPS.has(op)) continue;
    if (typeof out[from] === 'string' && out[to] === undefined) {
      out[to] = [out[from]];
      delete out[from];
    }
  }

  // Wrap scalar file_paths (from op-specific aliases like from → file_paths)
  if (typeof out.file_paths === 'string') {
    out.file_paths = [out.file_paths];
  }

  // query → queries promotion for search.code
  if (QUERY_TO_QUERIES_OPS.has(op)) {
    if (typeof out.queries === 'string') {
      out.queries = [out.queries];
    } else if (typeof out.query === 'string' && out.queries === undefined) {
      out.queries = [out.query];
      delete out.query;
    }
  }

  // key → keys promotion for bb.read / bb.delete
  if (KEY_TO_KEYS_OPS.has(op)) {
    if (typeof out.key === 'string' && out.keys === undefined) {
      out.keys = [out.key];
      delete out.key;
    }
  }

  // Pass 3: normalize symbol_names entries
  if (Array.isArray(out.symbol_names)) {
    out.symbol_names = normalizeSymbolNames(out.symbol_names);
  } else if (typeof out.symbol_names === 'string') {
    out.symbol_names = [stripSymbolPrefix(out.symbol_names)];
  }

  // Pass 4: validate derived_from for bb.write — hash refs (h:…), { ref }, or real file paths
  if (op === 'session.bb.write' && Array.isArray(out.derived_from)) {
    out.derived_from = (out.derived_from as unknown[]).filter((v) => {
      if (v != null && typeof v === 'object' && typeof (v as { ref?: string }).ref === 'string') {
        return (v as { ref: string }).ref.trim().length > 0;
      }
      if (typeof v === 'string') {
        const t = v.trim();
        if (!t) return false;
        if (t.startsWith('h:')) return true;
        return validateSourceIdentity(t) !== undefined;
      }
      return false;
    });
  }

  return out;
}
