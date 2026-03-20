/**
 * Change operation handlers — edit, create, delete, refactor, rollback.
 * Includes edit post-processing (hash registration, stale invalidation, diff injection, lesson extraction).
 */

import type { OpHandler, StepOutput } from '../types';
import { useContextStore } from '../../../stores/contextStore';
import { getPreflightAutomationDecision, runFreshnessPreflight } from '../../../services/freshnessPreflight';
import { recordFreshnessJournal } from '../../../services/freshnessJournal';
import { invoke } from '@tauri-apps/api/core';
import { SHORT_HASH_LEN } from '../../../utils/contextHash';
import { parseHashRef } from '../../../utils/hashRefParsers';
import { canonicalizeSnapshotHash } from '../snapshotTracker';

function ok(summary: string, refs: string[] = [], content?: unknown): StepOutput {
  return { kind: 'edit_result', ok: true, refs, summary, content };
}

function err(summary: string): StepOutput {
  return { kind: 'edit_result', ok: false, refs: [], summary, error: summary };
}

function errWithContent(summary: string, content: unknown): StepOutput {
  return { kind: 'edit_result', ok: false, refs: [], summary, error: summary, content };
}

class EditValidationError extends Error {
  errorClass: string;
  details?: Record<string, unknown>;

  constructor(message: string, errorClass: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'EditValidationError';
    this.errorClass = errorClass;
    this.details = details;
  }
}

function throwEditValidationError(
  message: string,
  errorClass: string,
  details?: Record<string, unknown>,
): never {
  throw new EditValidationError(message, errorClass, details);
}

// ---------------------------------------------------------------------------
// Edit post-processing helpers
// ---------------------------------------------------------------------------

export function registerEditHashes(result: unknown, params: Record<string, unknown>): void {
  try {
    const store = useContextStore.getState();
    const entries: Array<Record<string, unknown>> = [];

    if (result && typeof result === 'object') {
      if (Array.isArray(result)) {
        for (const item of result) {
          if (item && typeof item === 'object') entries.push(item as Record<string, unknown>);
        }
      } else {
        const r = result as Record<string, unknown>;
        const arr = r.results ?? r.batch ?? r.drafts;
        if (Array.isArray(arr)) {
          entries.push(...(arr as Array<Record<string, unknown>>));
        } else if (r.h || r.hash) {
          entries.push(r);
        }
      }
    }

    const paramSource = (params.file_path || params.file) as string | undefined;
    const sessionId = typeof localStorage !== 'undefined'
      ? localStorage.getItem('current_session_id')
      : null;

    for (const entry of entries) {
      const newHash = (entry.h || entry.hash) as string | undefined;
      const oldHash = (entry.old_h || entry.old_hash) as string | undefined;
      const source = (entry.f || entry.file || entry.path || entry.file_path || paramSource) as string | undefined;

      if (source && sessionId && newHash) {
        const srcNorm = source.replace(/\\/g, '/').toLowerCase();
        for (const c of store.chunks.values()) {
          if (c.compacted || !c.source || c.content.length < 20) continue;
          const cNorm = c.source.replace(/\\/g, '/').toLowerCase();
          if (cNorm === srcNorm || cNorm.endsWith('/' + srcNorm) || srcNorm.endsWith('/' + cNorm)) {
            invoke('chat_db_insert_shadow_version', {
              sessionId,
              sourcePath: source,
              hash: c.hash,
              content: c.content,
              replacedBy: newHash.replace(/^h:/, ''),
            }).catch(e => console.warn('[shadow] Failed to persist shadow version:', e));
            break;
          }
        }
      }

      if (newHash && source && !source.startsWith('h:')) {
        store.registerEditHash(newHash, source);
        store.recordRevisionAdvance(source, newHash.replace(/^h:/, ''), 'same_file_prior_edit', sessionId ?? undefined);
        const lineDelta = estimateLineDeltaForSource(params, source);
        recordFreshnessJournal({
          source,
          previousRevision: oldHash?.replace(/^h:/, ''),
          currentRevision: newHash.replace(/^h:/, ''),
          lineDelta: lineDelta !== 0 ? lineDelta : undefined,
          recordedAt: Date.now(),
        });
        store.recordMemoryEvent({
          action: 'write',
          reason: 'canonical_revision_changed',
          source,
          oldRevision: oldHash?.replace(/^h:/, ''),
          newRevision: newHash.replace(/^h:/, ''),
          refs: [`h:${newHash.replace(/^h:/, '').slice(0, SHORT_HASH_LEN)}`],
        });
      }
      if (newHash && oldHash && newHash !== oldHash) {
        const oldChunk = store.chunks.get(oldHash) ?? Array.from(store.chunks.values()).find(c => c.shortHash === oldHash?.slice(0, SHORT_HASH_LEN));
        if (oldChunk?.pinned) {
          store.pinChunks([newHash]);
          store.unpinChunks([oldHash]);
        }
      }
    }
  } catch (e) {
    console.warn('[edit] Failed to register edit hashes:', e);
  }
}

function estimateLineDeltaFromLineEdits(lineEdits: unknown): number {
  if (!Array.isArray(lineEdits)) return 0;
  let delta = 0;
  for (const edit of lineEdits) {
    if (!edit || typeof edit !== 'object') continue;
    const entry = edit as Record<string, unknown>;
    const action = typeof entry.action === 'string' ? entry.action : '';
    const count = typeof entry.count === 'number' && Number.isFinite(entry.count) ? entry.count : 1;
    const contentLines = typeof entry.content === 'string' && entry.content.length > 0
      ? entry.content.split(/\r?\n/).length
      : 0;
    if (action === 'insert_before' || action === 'insert_after') delta += contentLines;
    else if (action === 'delete') delta -= count;
    else if (action === 'replace') delta += contentLines - count;
  }
  return delta;
}

function estimateLineDeltaForSource(params: Record<string, unknown>, source: string): number {
  const normalizedSource = normalizeSourcePath(source);
  if (typeof params.file === 'string' && normalizeSourcePath(params.file) === normalizedSource) {
    if (Array.isArray(params.line_edits)) return estimateLineDeltaFromLineEdits(params.line_edits);
    if (typeof params.old === 'string' && typeof params.new === 'string') {
      return params.new.split(/\r?\n/).length - params.old.split(/\r?\n/).length;
    }
  }
  if (Array.isArray(params.edits)) {
    let delta = 0;
    for (const edit of params.edits) {
      if (!edit || typeof edit !== 'object') continue;
      const entry = edit as Record<string, unknown>;
      const file = entry.file ?? entry.file_path;
      if (typeof file !== 'string' || normalizeSourcePath(file) !== normalizedSource) continue;
      if (Array.isArray(entry.line_edits)) delta += estimateLineDeltaFromLineEdits(entry.line_edits);
      else if (typeof entry.old === 'string' && typeof entry.new === 'string') {
        delta += entry.new.split(/\r?\n/).length - entry.old.split(/\r?\n/).length;
      }
    }
    return delta;
  }
  return 0;
}

export function invalidateStaleHashes(result: unknown): void {
  try {
    if (!result || typeof result !== 'object') return;
    const r = result as Record<string, unknown>;
    const arr = (r.results ?? r.batch ?? r.drafts) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(arr)) return;

    const staleHashes: string[] = [];
    for (const entry of arr) {
      const oldHash = (entry.old_h ?? entry.old_hash) as string | undefined;
      const newHash = (entry.h ?? entry.hash) as string | undefined;
      if (oldHash && newHash && oldHash !== newHash) {
        staleHashes.push(oldHash);
      }
    }
    if (staleHashes.length > 0) {
      useContextStore.getState().invalidateStaleHashes(staleHashes);
    }
  } catch (e) {
    console.warn('[change] post-edit invalidation failed:', e);
  }
}

export function injectDiffRefs(result: unknown): void {
  try {
    if (!result || typeof result !== 'object') return;
    const r = result as Record<string, unknown>;
    const arr = (r.batch ?? r.results ?? r.drafts) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(arr)) return;

    for (const entry of arr) {
      const newHash = (entry.h ?? entry.hash) as string | undefined;
      const oldHash = (entry.old_h ?? entry.old_hash) as string | undefined;
      if (newHash && oldHash && newHash !== oldHash) {
        const fmtNew = newHash.startsWith('h:') ? newHash : `h:${newHash.slice(0, SHORT_HASH_LEN)}`;
        const fmtOld = oldHash.startsWith('h:') ? oldHash : `h:${oldHash.slice(0, SHORT_HASH_LEN)}`;
        try { entry.diff = `${fmtOld}..${fmtNew}`; } catch { /* frozen object */ }
      }
    }
  } catch {
    // best-effort
  }
}

const LESSON_BB_ERR_CAP = 200;
const LESSON_BB_FIX_CAP = 300;
const _namespaceBudgetWarned = new Set<string>();

function evictLessonNamespace(
  store: ReturnType<typeof useContextStore.getState>,
  prefix: string,
  cap: number,
): void {
  const entries = store.listBlackboardEntries().filter(e => e.key.startsWith(prefix));
  const totalTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
  if (totalTokens <= cap) return;

  if (!_namespaceBudgetWarned.has(prefix)) {
    _namespaceBudgetWarned.add(prefix);
    console.log(`[batch] BB namespace '${prefix}' at ${totalTokens}tk (cap: ${cap}tk). Oldest will be dropped next write.`);
    return;
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));
  let freed = 0;
  let evictedCount = 0;
  for (const entry of entries) {
    if (totalTokens - freed <= cap) break;
    store.removeBlackboardEntry(entry.key);
    freed += entry.tokens;
    evictedCount++;
  }
  if (evictedCount > 0) {
    console.log(`[batch] BB namespace '${prefix}' exceeded cap. Evicted ${evictedCount} oldest entries (${freed}tk freed).`);
  }
}

function hasLintErrorsInResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;
  if (Boolean(r.has_errors)) return true;
  const lints = r.lints as Record<string, unknown> | undefined;
  const errCount = (lints?.by_severity as Record<string, number> | undefined)?.error;
  return typeof errCount === 'number' && errCount > 0;
}

function formatLintErrorHint(result: unknown): string {
  if (!result || typeof result !== 'object') return 'Written file(s) have lint errors.';
  const r = result as Record<string, unknown>;
  const topIssues = (r.lints as Record<string, unknown> | undefined)?.top_issues ?? r.top_issues;
  const issues = Array.isArray(topIssues) ? topIssues : [];
  const first = issues[0] as Record<string, unknown> | undefined;
  if (first?.file && first?.line && first?.message) {
    const file = String(first.file).split(/[/\\]/).pop() ?? first.file;
    return `${file} L${first.line}: ${String(first.message).slice(0, 60)}`;
  }
  return 'Written file(s) have syntax/lint errors.';
}

export function extractEditLessons(result: unknown, params: Record<string, unknown>): void {
  try {
    if (!result || typeof result !== 'object') return;
    const r = result as Record<string, unknown>;
    const store = useContextStore.getState();

    const entries = (r.batch ?? r.results ?? r.drafts) as Array<Record<string, unknown>> | undefined;
    const singleEntry = (!entries && (r.h || r.hash)) ? [r] : undefined;
    const items = entries ?? singleEntry;
    if (!Array.isArray(items)) return;

    const lints = r.lints as Record<string, unknown> | undefined;
    const topIssues = (lints?.top_issues ?? r.top_issues) as Array<Record<string, unknown>> | undefined;
    const hasErrors = Boolean(r.has_errors) || (lints?.by_severity as Record<string, number> | undefined)?.error as number > 0;

    for (const entry of items) {
      const file = (entry.f ?? entry.file ?? entry.path ?? entry.file_path ?? params.file ?? params.file_path) as string | undefined;
      if (!file) continue;
      const basename = file.split('/').pop() ?? file;

      if (hasErrors && topIssues && topIssues.length > 0) {
        const fileErrors = topIssues
          .filter(issue => {
            const issueFile = (issue.file as string) ?? '';
            return issueFile.endsWith(basename) || issueFile === file;
          })
          .slice(0, 3);

        if (fileErrors.length > 0) {
          const lesson = fileErrors
            .map(e => `L${e.line} ${e.severity}: ${(e.message as string || '').slice(0, 80)}`)
            .join(' | ');
          store.setBlackboardEntry(`err:${basename}`, lesson);
        }
      } else if (!hasErrors) {
        const errKey = `err:${basename}`;
        const priorErr = store.getBlackboardEntry(errKey);
        if (priorErr) {
          store.setBlackboardEntry(`fix:${basename}`, `resolved: ${priorErr}`);
          store.removeBlackboardEntry(errKey);
        }
      }
    }

    evictLessonNamespace(store, 'err:', LESSON_BB_ERR_CAP);
    evictLessonNamespace(store, 'fix:', LESSON_BB_FIX_CAP);
  } catch (e) {
    console.warn('[change] lesson extraction failed:', e);
  }
}

const LESSON_BB_EDIT_CAP = 400;

/**
 * Write a compact BB summary of what was just edited so the model
 * remembers across turns without pinning (which breaks caching).
 * Entries use the `edit:` namespace and are auto-evicted when stale.
 */
function recordEditSummary(result: unknown, params: Record<string, unknown>): void {
  try {
    if (!result || typeof result !== 'object') return;
    const r = result as Record<string, unknown>;
    const store = useContextStore.getState();

    const entries = (r.batch ?? r.results ?? r.drafts) as Array<Record<string, unknown>> | undefined;
    const singleEntry = (!entries && (r.h || r.hash)) ? [r] : undefined;
    const items = entries ?? singleEntry;
    if (!Array.isArray(items)) return;

    for (const entry of items) {
      const file = (entry.f ?? entry.file ?? entry.path ?? entry.file_path ?? params.file ?? params.file_path) as string | undefined;
      if (!file) continue;
      const basename = file.split('/').pop() ?? file;
      const hash = (entry.h ?? entry.hash) as string | undefined;
      const shortHash = hash ? `h:${hash.replace(/^h:/, '').slice(0, SHORT_HASH_LEN)}` : '';

      // Build a one-line summary: "h:abc123 lines 40-60 (+5/-2)"
      const linesChanged = (entry.lines_changed ?? entry.line_count) as number | undefined;
      const lineDelta = estimateLineDeltaForSource(params, file);
      const lineInfo = linesChanged ? ` ${linesChanged}L` : '';
      const deltaInfo = lineDelta !== 0 ? ` (${lineDelta > 0 ? '+' : ''}${lineDelta})` : '';

      store.setBlackboardEntry(
        `edit:${basename}`,
        `${shortHash}${lineInfo}${deltaInfo} @${Date.now()}`,
      );
    }

    evictLessonNamespace(store, 'edit:', LESSON_BB_EDIT_CAP);
  } catch (e) {
    console.warn('[change] edit lesson recording failed:', e);
  }
}

function extractAffectedPaths(result: unknown): string[] {
  const paths: string[] = [];
  if (!result || typeof result !== 'object') return paths;
  const r = result as Record<string, unknown>;
  const arr = (r.results ?? r.batch ?? r.drafts) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(arr)) {
    for (const entry of arr) {
      const f = (entry.f ?? entry.file ?? entry.path ?? entry.file_path) as string | undefined;
      if (f) paths.push(f);
    }
  } else {
    const f = (r.file ?? r.path ?? r.file_path) as string | undefined;
    if (f) paths.push(f);
  }
  const created = (r.created ?? r.created_files ?? r.written_target_files) as string[] | undefined;
  if (Array.isArray(created)) paths.push(...created.filter((p): p is string => typeof p === 'string'));
  const deleted = r.deleted_files as string[] | undefined;
  if (Array.isArray(deleted)) paths.push(...deleted.filter((p): p is string => typeof p === 'string'));
  return [...new Set(paths)];
}

function extractRefs(result: unknown): string[] {
  const refs: string[] = [];
  if (!result || typeof result !== 'object') return refs;
  const r = result as Record<string, unknown>;
  const arr = (r.results ?? r.batch ?? r.drafts) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(arr)) {
    for (const entry of arr) {
      const h = (entry.h ?? entry.hash) as string | undefined;
      if (h) refs.push(h.startsWith('h:') ? h : `h:${h}`);
    }
  } else if (r.h || r.hash) {
    const h = (r.h ?? r.hash) as string;
    refs.push(h.startsWith('h:') ? h : `h:${h}`);
  }
  // Include created file paths so verify/diff can scope to them
  const created = (r.created ?? r.created_files ?? r.written_target_files) as string[] | undefined;
  if (Array.isArray(created)) {
    for (const path of created) {
      if (typeof path === 'string' && path.length > 0 && !refs.includes(path)) {
        refs.push(path);
      }
    }
  }
  return refs;
}

function normalizeSourcePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/** Reject values that are clearly content, not file paths or refs. */
function validatePathParam(value: unknown, paramName: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') return `${paramName} must be a string, got ${typeof value}`;
  if (value.length > 1024) return `${paramName} too long (${value.length} chars) — looks like content, not a path`;
  if (value.includes('\n')) return `${paramName} contains newlines — looks like content, not a path`;
  return null;
}

type EditTargetKind = 'file' | 'exact_span' | 'display_only';

function deriveEditTargetMeta(value: unknown): { edit_target_ref?: string; edit_target_kind?: EditTargetKind; edit_target_range?: [number, number | null][]; edit_target_hash?: string } {
  if (typeof value !== 'string' || !value.startsWith('h:')) return {};
  const parsed = parseHashRef(value);
  if (!parsed) return {};
  const { modifier } = parsed;
  const isExactSpan = typeof modifier === 'object' && 'lines' in modifier && !('shape' in modifier);
  const edit_target_hash = `h:${parsed.hash}`;
  if (modifier === 'auto' || modifier === 'content' || modifier === 'source') {
    return { edit_target_ref: value, edit_target_kind: 'file', edit_target_hash };
  }
  if (isExactSpan) {
    return {
      edit_target_ref: value,
      edit_target_kind: 'exact_span',
      edit_target_range: modifier.lines,
      edit_target_hash,
    };
  }
  return { edit_target_ref: value, edit_target_kind: 'display_only', edit_target_hash };
}

function normalizePathKey(value: string): string {
  return normalizeSourcePath(value);
}

function normalizeHashRefForLookup(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('h:')) return trimmed;
  const base = trimmed.slice(2).split(':')[0]?.trim();
  return base ? `h:${base}` : trimmed;
}

function canonicalizeContentHash(value: unknown, fallbackHash?: string): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return canonicalizeSnapshotHash(value.trim());
  }
  return fallbackHash ? canonicalizeSnapshotHash(fallbackHash) : undefined;
}

function sameCanonicalHash(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return canonicalizeSnapshotHash(a) === canonicalizeSnapshotHash(b);
}

function stripDisplayLinePrefixes(content: string): string {
  return content
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\d+\|/, ''))
    .join('\n');
}

/** Detect whether content looks like it was copied from read_lines output (has N| prefixes). */
function hasDisplayLinePrefixes(content: string): boolean {
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return false;
  const prefixed = lines.filter(l => /^\s*\d+\|/.test(l));
  return prefixed.length >= lines.length * 0.6;
}

function normalizeExactSpanEditPayload(params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params };
  if (!Array.isArray(next.edits)) return next;
  next.edits = next.edits.map((edit) => {
    if (!edit || typeof edit !== 'object') return edit;
    const entry = { ...(edit as Record<string, unknown>) };
    const targetMeta = deriveEditTargetMeta(entry.file_path ?? entry.file);
    Object.assign(entry, targetMeta);
    const targetKind = entry.edit_target_kind;
    const canonicalSnapshotHash = canonicalizeContentHash(
      entry.snapshot_hash ?? entry.content_hash,
      entry.edit_target_hash as string | undefined,
    );
    if (typeof canonicalSnapshotHash === 'string') {
      entry.snapshot_hash = canonicalSnapshotHash;
      entry.content_hash = canonicalSnapshotHash;
    }
    if (typeof entry.old === 'string') {
      if (targetKind === 'exact_span' || hasDisplayLinePrefixes(entry.old)) {
        entry.old = stripDisplayLinePrefixes(entry.old);
      }
    }
    if (typeof entry.new === 'string' && hasDisplayLinePrefixes(entry.new)) {
      entry.new = stripDisplayLinePrefixes(entry.new);
    }
    return entry;
  });
  return next;
}

function canonicalizeDraftEditFileField(edit: Record<string, unknown>): Record<string, unknown> {
  const next = { ...edit };
  const canonicalFile = typeof next.file === 'string'
    ? next.file
    : (typeof next.file_path === 'string' ? next.file_path : undefined);
  if (typeof canonicalFile === 'string') {
    next.file = canonicalFile;
    delete next.file_path;
  }
  return next;
}

function inheritSingleEditContext(params: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(params.edits) || params.edits.length !== 1) return params;
  const first = params.edits[0];
  if (!first || typeof first !== 'object') return params;
  const entry = { ...(first as Record<string, unknown>) };
  const hasOwnFile = typeof entry.file === 'string' || typeof entry.file_path === 'string';
  const hasTextReplace = entry.old != null || entry.new != null;
  if (hasOwnFile || !hasTextReplace) return params;

  const inheritedFile = typeof params.file === 'string'
    ? params.file
    : (typeof params.file_path === 'string' ? params.file_path : undefined);
  if (typeof inheritedFile !== 'string') return params;

  entry.file = inheritedFile;
  const targetMeta = deriveEditTargetMeta(inheritedFile);
  if (entry.snapshot_hash == null && entry.content_hash == null) {
    const inheritedHash = canonicalizeContentHash(params.snapshot_hash ?? params.content_hash, targetMeta.edit_target_hash);
    if (typeof inheritedHash === 'string') {
      entry.snapshot_hash = inheritedHash;
      entry.content_hash = inheritedHash;
    }
  }
  if (entry.edit_target_ref == null && typeof targetMeta.edit_target_ref === 'string') entry.edit_target_ref = targetMeta.edit_target_ref;
  if (entry.edit_target_kind == null && typeof targetMeta.edit_target_kind === 'string') entry.edit_target_kind = targetMeta.edit_target_kind;
  if (entry.edit_target_hash == null && typeof targetMeta.edit_target_hash === 'string') entry.edit_target_hash = targetMeta.edit_target_hash;
  if (entry.edit_target_range == null && Array.isArray(targetMeta.edit_target_range)) entry.edit_target_range = targetMeta.edit_target_range;

  return {
    ...params,
    edits: [entry],
  };
}

function extractTargetFiles(params: Record<string, unknown>): string[] {
  const targets = new Set<string>();
  const direct = params.file_path;
  if (typeof direct === 'string' && direct.length > 0 && !direct.startsWith('h:')) {
    targets.add(direct);
  }
  const creates = params.creates;
  if (Array.isArray(creates)) {
    for (const create of creates) {
      if (!create || typeof create !== 'object') continue;
      const path = (create as Record<string, unknown>).path;
      if (typeof path === 'string' && path.length > 0 && !path.startsWith('h:')) {
        targets.add(path);
      }
    }
  }
  const edits = params.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue;
      const file = (edit as Record<string, unknown>).file ?? (edit as Record<string, unknown>).file_path;
      if (typeof file === 'string' && file.length > 0 && !file.startsWith('h:')) {
        targets.add(file);
      }
    }
  }
  return [...targets];
}

async function resolveTargetFiles(
  params: Record<string, unknown>,
): Promise<{ params: Record<string, unknown>; targetFiles: string[] }> {
  const next = { ...params };
  const targets = new Set<string>();
  const hashLookups = new Map<string, Array<(source: string) => void>>();

  const registerTarget = (value: unknown) => {
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('h:')) return;
    targets.add(value);
  };

  const registerHashTarget = (value: unknown, assign: (source: string) => void) => {
    if (typeof value !== 'string' || value.length === 0 || !value.startsWith('h:')) return;
    const lookupRef = normalizeHashRefForLookup(value);
    const callbacks = hashLookups.get(lookupRef) ?? [];
    callbacks.push(assign);
    hashLookups.set(lookupRef, callbacks);
  };

  registerTarget(next.file_path ?? next.file);
  Object.assign(next, deriveEditTargetMeta(next.file_path ?? next.file));
  registerHashTarget(next.file_path, (source) => { next.file_path = source; });
  registerHashTarget(next.file, (source) => { next.file = source; });

  if (Array.isArray(next.creates)) {
    next.creates = next.creates.map((create) => {
      if (!create || typeof create !== 'object') return create;
      const entry = { ...(create as Record<string, unknown>) };
      registerTarget(entry.path);
      return entry;
    });
  }

  if (Array.isArray(next.edits)) {
    next.edits = next.edits.map((edit) => {
      if (!edit || typeof edit !== 'object') return edit;
      const entry = { ...(edit as Record<string, unknown>) };
      Object.assign(entry, deriveEditTargetMeta(entry.file_path ?? entry.file));
      registerTarget(entry.file_path ?? entry.file);
      registerHashTarget(entry.file_path, (source) => { entry.file_path = source; });
      registerHashTarget(entry.file, (source) => { entry.file = source; });
      return entry;
    });
  }

  if (hashLookups.size > 0) {
    type BatchResolvedEntry = { source?: string | null; content: string; tokens: number };
    type ResolvedHashEntry = { source?: string | null; content: string };
    const refs = [...hashLookups.keys()];
    const resolved = await invoke<Array<BatchResolvedEntry | null>>('batch_resolve_hash_refs', { refs });
    const unresolvedRefs: string[] = [];
    refs.forEach((ref, index) => {
      const source = resolved[index]?.source;
      if (typeof source !== 'string' || source.length === 0) {
        unresolvedRefs.push(ref);
        return;
      }
      targets.add(source);
      for (const assign of hashLookups.get(ref) ?? []) assign(source);
    });
    if (unresolvedRefs.length > 0) {
      const sessionId = typeof localStorage !== 'undefined'
        ? localStorage.getItem('current_session_id')
        : null;
      const fallbackEntries = await Promise.all(unresolvedRefs.map(async (ref) => {
        try {
          return await invoke<ResolvedHashEntry>('resolve_hash_ref', {
            rawRef: ref,
            sessionId,
          });
        } catch (e) {
          console.warn('[change] fallback hash resolve failed for', ref, e);
          return null;
        }
      }));
      unresolvedRefs.forEach((ref, index) => {
        const source = fallbackEntries[index]?.source;
        if (typeof source !== 'string' || source.length === 0) return;
        targets.add(source);
        for (const assign of hashLookups.get(ref) ?? []) assign(source);
      });
    }
  }

  return { params: next, targetFiles: [...targets] };
}

function getChunkAgeMs(chunk: { createdAt?: Date; lastAccessed?: number }): number | null {
  if (chunk.createdAt instanceof Date) return Date.now() - chunk.createdAt.getTime();
  if (typeof chunk.lastAccessed === 'number') return Date.now() - chunk.lastAccessed;
  return null;
}

function collectDisplayOnlyRefs(params: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const collect = (candidate: unknown, kind: unknown) => {
    if (kind !== 'display_only' || typeof candidate !== 'string') return;
    refs.add(candidate);
  };
  collect(params.edit_target_ref, params.edit_target_kind);
  if (Array.isArray(params.edits)) {
    for (const edit of params.edits) {
      if (!edit || typeof edit !== 'object') continue;
      const entry = edit as Record<string, unknown>;
      collect(entry.edit_target_ref, entry.edit_target_kind);
    }
  }
  return [...refs];
}

function collectSuspectRefs(targetFiles: string[], freshnessTtlMs?: number): string[] {
  const store = useContextStore.getState();
  const targets = targetFiles.map(normalizeSourcePath);
  if (targets.length === 0) return [];

  const refs = new Set<string>();
  const maybeSuspect = (
    source: string | undefined,
    ref: string,
    suspectSince?: number,
    ageMs?: number | null,
  ) => {
    if (!source) return;
    const sourceNorm = normalizeSourcePath(source);
    const matchesTarget = targets.some(target => sourceNorm === target);
    if (!matchesTarget) return;
    if (suspectSince != null) {
      refs.add(ref);
      return;
    }
    if (freshnessTtlMs != null && ageMs != null && ageMs > freshnessTtlMs) {
      refs.add(ref);
    }
  };

  for (const chunk of store.chunks.values()) {
    const viewKind = chunk.viewKind ?? 'latest';
    if (viewKind !== 'latest') continue;
    maybeSuspect(chunk.source, `h:${chunk.shortHash} ${chunk.source ?? chunk.type}`, chunk.suspectSince, getChunkAgeMs(chunk));
  }
  for (const [key, snippet] of store.stagedSnippets) {
    const viewKind = snippet.viewKind ?? ((snippet.lines || snippet.shapeSpec) ? 'derived' : 'latest');
    if (viewKind !== 'latest') continue;
    maybeSuspect(snippet.source, `${key} ${snippet.source}`, snippet.suspectSince, null);
  }

  return [...refs];
}

function extractTopLevelError(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const payload = result as Record<string, unknown>;
  return typeof payload.error === 'string' ? payload : null;
}

function hasExactSpanTarget(params: Record<string, unknown>): boolean {
  if (params.edit_target_kind === 'exact_span') return true;
  if (!Array.isArray(params.edits)) return false;
  return params.edits.some((edit) => (
    !!edit
    && typeof edit === 'object'
    && (edit as Record<string, unknown>).edit_target_kind === 'exact_span'
  ));
}

function collectRefreshedHashes(params: Record<string, unknown>): Set<string> {
  const hashes = new Set<string>();
  const add = (value: unknown) => {
    const canonical = canonicalizeContentHash(value);
    if (canonical) hashes.add(canonical);
  };
  if (params.content_hash_refreshed === true || params.snapshot_hash_refreshed === true) {
    add(params.snapshot_hash ?? params.content_hash);
  }
  if (Array.isArray(params.edits)) {
    for (const edit of params.edits) {
      if (!edit || typeof edit !== 'object') continue;
      const entry = edit as Record<string, unknown>;
      if (entry.content_hash_refreshed === true || entry.snapshot_hash_refreshed === true) {
        add(entry.snapshot_hash ?? entry.content_hash);
      }
    }
  }
  return hashes;
}

function sanitizeSuccessfulEditWarnings(
  result: unknown,
  _params: Record<string, unknown>,
): unknown {
  // stale_hash_followed_latest warnings are never suppressed -- they signal
  // that the backend applied edits against content that drifted from what
  // the caller composed against, even if a pre-write hash refresh made the
  // hash itself current.  Suppressing them hid evidence of wrong-line writes.
  return result;
}

function formatEditErrorSummary(payload: Record<string, unknown>): string {
  const errorClass = typeof payload.error_class === 'string' ? payload.error_class : undefined;
  const message = typeof payload.error === 'string' ? payload.error : 'edit failed';
  const next = typeof payload._next === 'string' ? payload._next : undefined;
  return `edit: ERROR${errorClass ? ` [${errorClass}]` : ''} ${message}${next ? ` — ${next}` : ''}`;
}

function summarizeEditParams(params: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ['file', 'file_path', 'lines', 'stale_policy', 'retry_on_failure', 'require_fresh_read', 'freshness_ttl_ms']) {
    if (params[key] !== undefined) summary[key] = params[key];
  }
  if (params.snapshot_hash !== undefined) summary.snapshot_hash = params.snapshot_hash;
  if (Array.isArray(params.edits)) {
    summary.edits = params.edits
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => ({
        file: entry.file,
        file_path: entry.file_path,
        lines: entry.lines,
        snapshot_hash: entry.snapshot_hash ?? entry.content_hash,
        edit_target_ref: entry.edit_target_ref,
        edit_target_kind: entry.edit_target_kind,
      }));
  }
  return summary;
}

function buildEditReproPack(args: {
  operation: string;
  targetFiles: string[];
  params: Record<string, unknown>;
  preflight?: import('../../../services/freshnessPreflight').PreflightResult | null;
  automation?: import('../../../services/freshnessPreflight').AutomationDecision | null;
  errorClass?: string;
}): Record<string, unknown> {
  return {
    operation: args.operation,
    target_files: args.targetFiles,
    error_class: args.errorClass,
    params: summarizeEditParams(args.params),
    preflight: args.preflight
      ? {
        blocked: args.preflight.blocked,
        confidence: args.preflight.confidence,
        strategy: args.preflight.strategy,
        action: args.automation?.action,
        reason: args.automation?.reason,
        decisions: args.preflight.decisions,
      }
      : undefined,
  };
}

function collectEditValidationTargets(params: Record<string, unknown>): string[] {
  const targets = new Set<string>();
  const maybeAdd = (value: unknown) => {
    if (typeof value === 'string' && value.length > 0) targets.add(value);
  };
  maybeAdd(params.file);
  maybeAdd(params.file_path);
  if (Array.isArray(params.edits)) {
    for (const edit of params.edits) {
      if (!edit || typeof edit !== 'object') continue;
      const entry = edit as Record<string, unknown>;
      maybeAdd(entry.file);
      maybeAdd(entry.file_path);
    }
  }
  return [...targets];
}

function inferEditOperationForValidation(params: Record<string, unknown>): string {
  try {
    return resolveEditOperation(params).operation;
  } catch {
    return 'draft';
  }
}

function attachPreflightMetadata(
  result: unknown,
  preflight: import('../../../services/freshnessPreflight').PreflightResult,
  automation: import('../../../services/freshnessPreflight').AutomationDecision,
  operation: string,
  targetFiles: string[],
  params: Record<string, unknown>,
): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const payload = result as Record<string, unknown>;
  return {
    ...payload,
    rebind: {
      action: automation.action,
      reason: automation.reason,
      strategy: preflight.strategy,
      confidence: preflight.confidence,
      summary: preflight.relocationSummary,
      decisions: preflight.decisions,
      repro_pack: buildEditReproPack({
        operation,
        targetFiles,
        params,
        preflight,
        automation,
      }),
    },
  };
}

async function refreshContentHashes(
  ctx: import('../types').HandlerContext,
  filePaths: string[],
): Promise<Map<string, string>> {
  const refreshed = new Map<string, string>();
  if (filePaths.length === 0) return refreshed;
  const result = await ctx.atlsBatchQuery('context', { type: 'full', file_paths: filePaths });
  const entries = (result as Record<string, unknown>)?.results;
  if (!Array.isArray(entries)) return refreshed;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const payload = entry as Record<string, unknown>;
    const file = payload.file ?? payload.path;
    const contentHash = payload.snapshot_hash ?? payload.content_hash ?? payload.hash;
    if (typeof file === 'string' && typeof contentHash === 'string') {
      refreshed.set(normalizePathKey(file), contentHash);
      useContextStore.getState().clearSuspect(file);
    }
  }
  return refreshed;
}

function applyRefreshedContentHashes(
  resolved: Record<string, unknown>,
  refreshed: Map<string, string>,
): Record<string, unknown> {
  if (refreshed.size === 0) return resolved;
  const next = { ...resolved };
  const file = (next.file ?? next.file_path) as string | undefined;
  const fileKey = typeof file === 'string' ? normalizePathKey(file) : undefined;
  if (fileKey && refreshed.has(fileKey)) {
    const refreshedHash = refreshed.get(fileKey);
    if (typeof refreshedHash === 'string') {
        next.snapshot_hash = refreshedHash;
      next.content_hash = refreshedHash;
      next.content_hash_refreshed = true;
      // edit_target_hash always follows the canonical snapshot hash
      if (typeof next.edit_target_hash === 'string') {
        next.edit_target_hash = refreshedHash;
      }
    }
  }
  if (Array.isArray(next.edits)) {
    next.edits = next.edits.map((edit) => {
      if (!edit || typeof edit !== 'object') return edit;
      const entry = { ...(edit as Record<string, unknown>) };
      const entryFile = (entry.file ?? entry.file_path) as string | undefined;
      const entryFileKey = typeof entryFile === 'string' ? normalizePathKey(entryFile) : undefined;
      if (entryFileKey && refreshed.has(entryFileKey)) {
        const refreshedHash = refreshed.get(entryFileKey);
        if (typeof refreshedHash === 'string') {
          entry.snapshot_hash = refreshedHash;
          entry.content_hash = refreshedHash;
          entry.content_hash_refreshed = true;
          if (typeof entry.edit_target_hash === 'string') {
            entry.edit_target_hash = refreshedHash;
          }
        }
      }
      return entry;
    });
  }
  return next;
}

function normalizeCreateParams(params: Record<string, unknown>): Record<string, unknown> {
  const overwrite = params.overwrite === true;
  if (Array.isArray(params.creates)) {
    return {
      files: params.creates
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          path: item.path,
          content: item.content,
          overwrite: item.overwrite === true || overwrite,
        })),
      overwrite,
    };
  }
  const path = typeof params.path === 'string'
    ? params.path
    : (typeof params.file_path === 'string' ? params.file_path : params.file);
  const content = params.content;
  if (typeof path !== 'string' || typeof content !== 'string') {
    throw new Error('change.create requires creates:[{path,content}] or path/content');
  }
  return {
    files: [{ path, content, overwrite }],
    overwrite,
  };
}

// ---------------------------------------------------------------------------
// change.edit — routes to correct backend operation (draft, batch_edits, undo, etc.)
// ---------------------------------------------------------------------------

/** Canonicalize anchor-style line_edits payloads to { file, line_edits } before dispatch. Exported for tests. */
export function normalizeEditParams(params: Record<string, unknown>): Record<string, unknown> {
  const normalizedParams = inheritSingleEditContext(normalizeExactSpanEditPayload(params));
  const edits = normalizedParams.edits as Array<Record<string, unknown>> | undefined;
  const hasTopLevelLineEdits = Array.isArray(normalizedParams.line_edits) && (normalizedParams.line_edits as unknown[]).length > 0;
  const hasFile = typeof normalizedParams.file === 'string' || typeof normalizedParams.file_path === 'string';

  // Case 1: edits: [{ file, line_edits }] or [{ file_path, line_edits }] without mode — promote to top-level
  if (Array.isArray(edits) && edits.length > 0 && !normalizedParams.mode) {
    const hasBatchLineEdits = edits.some(e => Array.isArray(e.line_edits));
    const hasOldNew = edits.some(e => e.old != null || e.new != null);
    if (hasBatchLineEdits && !hasOldNew) {
      const first = edits[0];
      const fileVal = (typeof first.file === 'string' ? first.file : first.file_path) as string | undefined;
      const le = first.line_edits as unknown[] | undefined;
      if (edits.length === 1 && typeof fileVal === 'string' && Array.isArray(le) && le.length > 0) {
        const { edits: _edits, ...rest } = normalizedParams;
        const targetMeta = deriveEditTargetMeta(fileVal);
        const contentHash = canonicalizeContentHash(first.snapshot_hash ?? first.content_hash, targetMeta.edit_target_hash);
        return {
          ...rest,
          file: fileVal,
          line_edits: le,
          ...(contentHash ? { snapshot_hash: contentHash } : {}),
          ...(contentHash ? { content_hash: contentHash } : {}),
          ...targetMeta,
        };
      }
      return { ...normalizedParams, mode: 'batch_edits' };
    }
  }

  // Case 2: line_edits present but no file — try edits[0].file or edits[0].file_path
  if (hasTopLevelLineEdits && !hasFile && Array.isArray(edits) && edits[0]) {
    const f = edits[0].file ?? edits[0].file_path;
    if (typeof f === 'string') {
      const targetMeta = deriveEditTargetMeta(f);
      const contentHash = canonicalizeContentHash(edits[0].snapshot_hash ?? edits[0].content_hash, targetMeta.edit_target_hash);
      return {
        ...normalizedParams,
        file: f,
        ...(contentHash ? { snapshot_hash: contentHash } : {}),
        ...(contentHash ? { content_hash: contentHash } : {}),
        ...targetMeta,
      };
    }
  }

  const topLevelFile = typeof normalizedParams.file_path === 'string' ? normalizedParams.file_path : normalizedParams.file;
  const topLevelMeta = deriveEditTargetMeta(topLevelFile);
  const contentHash = canonicalizeContentHash(normalizedParams.snapshot_hash ?? normalizedParams.content_hash, topLevelMeta.edit_target_hash);
  return {
    ...normalizedParams,
    ...(contentHash ? { snapshot_hash: contentHash } : {}),
    ...(contentHash ? { content_hash: contentHash } : {}),
    ...topLevelMeta,
  };
}

/** Brace-language extensions that benefit from pre-dispatch block validation. */
const BRACE_LANG_EXTS = /\.(ts|tsx|js|jsx|rs|go|java|cs|cpp|c|h|hpp|scala|kt)(\?|$)/i;

/**
 * Check brace balance in content. Returns final depth (0 = balanced). Depth going negative = invalid.
 */
function braceDepth(content: string): { depth: number; unbalanced: boolean } {
  let depth = 0;
  let inStr = false;
  let inBlockComment = false;
  let inLineComment = false;
  let quote = '';
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const c2 = content.slice(i, i + 2);
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c2 === '*/') { inBlockComment = false; i++; }
      continue;
    }
    if (inStr) {
      if (c === '\\' && i + 1 < content.length) { i++; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; continue; }
    if (c2 === '//') { inLineComment = true; continue; }
    if (c2 === '/*') { inBlockComment = true; i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth < 0) return { depth, unbalanced: true }; }
  }
  return { depth, unbalanced: depth !== 0 };
}

/**
 * Pre-dispatch validation for anchor replace with multiline content.
 * Rejects obviously unbalanced brace blocks in brace-language files.
 * Rust (.rs): enforces strict syntax; provides actionable diagnostics.
 * Exported for tests.
 */
export function validateAnchorReplaceContent(file: string, lineEdits: Array<Record<string, unknown>>): void {
  if (!BRACE_LANG_EXTS.test(file)) return;
  const isRust = /\.rs(\?|$)/i.test(file);
  for (let i = 0; i < lineEdits.length; i++) {
    const e = lineEdits[i];
    if (e.action !== 'replace') continue;
    const hasAnchor = e.anchor != null || e.symbol != null;
    if (!hasAnchor) continue;
    const content = typeof e.content === 'string' ? e.content : '';
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    const { depth, unbalanced } = braceDepth(content);
    if (unbalanced || depth !== 0) {
      const base = `line_edits[${i}] anchor replace: multiline content has unbalanced braces (depth=${depth})`;
      const hint = isRust
        ? ' — For Rust: ensure replacement is a complete item (e.g. full fn body). Set count explicitly if block extent is ambiguous. Pre-write lint will reject invalid syntax.'
        : ' — fix block before dispatch';
      throwEditValidationError(base + hint, 'anchor_replace_unbalanced', {
        file,
        index: i,
        depth,
      });
    }
  }
}

function effectiveExplicitLineEditCount(edit: Record<string, unknown>): number {
  const raw = edit.count;
  if (raw == null) return 1;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
    throwEditValidationError(
      'line_edits count must be a positive integer',
      'invalid_line_edit',
      { count: raw },
    );
  }
  return raw;
}

function coalesceExplicitLineEdits(lineEdits: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const explicit = lineEdits.map((edit, index) => ({ edit: { ...edit }, index }));
  explicit.sort((a, b) => ((a.edit.line as number) ?? 0) - ((b.edit.line as number) ?? 0) || a.index - b.index);

  const out: Array<Record<string, unknown>> = [];

  const pushOrMerge = (entry: Record<string, unknown>, index: number) => {
    const action = entry.action;
    const line = entry.line;
    const hasExplicitLine = typeof line === 'number' && Number.isInteger(line) && line > 0;
    const explicitOnly = hasExplicitLine && entry.anchor == null && entry.symbol == null;
    const count = explicitOnly && (action === 'replace' || action === 'delete')
      ? effectiveExplicitLineEditCount(entry)
      : null;
    const prev = out[out.length - 1];

    if (!prev || !explicitOnly || count == null) {
      out.push(entry);
      return;
    }

    const prevExplicitOnly = typeof prev.line === 'number'
      && Number.isInteger(prev.line)
      && (prev.line as number) > 0
      && prev.anchor == null
      && prev.symbol == null;
    const prevAction = prev.action;
    const prevCount = prevExplicitOnly && (prevAction === 'replace' || prevAction === 'delete')
      ? effectiveExplicitLineEditCount(prev)
      : null;

    if (prevCount == null || prevAction == null) {
      out.push(entry);
      return;
    }

    const prevStart = (prev.line as number) - 1;
    const prevEnd = prevStart + prevCount;
    const start = (line as number) - 1;
    const end = start + count;
    const overlaps = start < prevEnd && prevStart < end;
    const adjacent = start === prevEnd;

    if (prevAction === 'delete' && action === 'delete' && (overlaps || adjacent)) {
      prev.count = Math.max(prevEnd, end) - prevStart;
      return;
    }

    if (prevAction === 'replace' && action === 'replace' && adjacent) {
      const prevContent = typeof prev.content === 'string' ? prev.content : '';
      const nextContent = typeof entry.content === 'string' ? entry.content : '';
      prev.count = prevCount + count;
      prev.content = [prevContent, nextContent].filter(Boolean).join('\n');
      return;
    }

    if (overlaps) {
      throwEditValidationError(
        `line_edits overlap: edit ${index} conflicts with a prior explicit edit and could not be auto-coalesced`,
        'overlapping_line_edits',
        {
          prior: { line_start: prevStart + 1, line_end: prevEnd, action: prevAction },
          current: { line_start: start + 1, line_end: end, action },
        },
      );
    }

    out.push(entry);
  };

  for (const { edit, index } of explicit) {
    pushOrMerge(edit, index + 1);
  }

  return out;
}

function formatDisplayOnlyRefError(refs: string[]): StepOutput {
  const payload = {
    error: 'display_only_refs_not_edit_safe',
    error_class: 'edit_target_not_edit_safe',
    refs,
    _next: 'Re-read an exact file or exact line span, then retry with a file-backed target instead of a shaped/display ref',
  };
  return errWithContent(
    `edit: ERROR [edit_target_not_edit_safe] ${refs.join(', ')} cannot be edited directly`,
    payload,
  );
}

function resolveEditOperation(params: Record<string, unknown>): { operation: string; resolved: Record<string, unknown> } {
  const resolved = { ...params };

  const isUndo = typeof params.undo === 'string'
    || (params.action === 'undo' && (typeof params.file === 'string' || typeof params.hash === 'string' || typeof params.file_path === 'string'));
  const isRevise = typeof params.revise === 'string';
  const isFlush = Array.isArray(params.flush);
  const isListDrafts = params.list_drafts === true;
  const isDiff = typeof params.diff === 'string';
  const isBatchEdits = params.mode === 'batch_edits' && Array.isArray(params.edits);
  const hasLineEdits = Array.isArray(params.line_edits) && (params.line_edits as unknown[]).length > 0;
  const hasSymbolEdits = params.symbol_edits && Array.isArray(params.symbol_edits) && (params.symbol_edits as unknown[]).length > 0;
  const hasEdits = params.edits && Array.isArray(params.edits) && (params.edits as unknown[]).length > 0;
  const hasCreates = params.creates && Array.isArray(params.creates) && (params.creates as unknown[]).length > 0;
  const hasDeletes = params.deletes && Array.isArray(params.deletes) && (params.deletes as unknown[]).length > 0;

  if (isUndo) {
    const undoTarget = params.undo || params.file_path || params.file || params.hash;
    resolved.undo = undoTarget;
    return { operation: 'undo', resolved };
  }
  if (isListDrafts) return { operation: 'list_drafts', resolved };
  if (isDiff) return { operation: 'diff', resolved };
  if (isFlush) return { operation: 'flush', resolved };
  if (isRevise) {
    resolved.hash = params.revise;
    return { operation: 'revise', resolved };
  }
  if (hasDeletes) {
    resolved.file_paths = params.deletes;
    resolved.confirm = params.confirm ?? (params.dry_run !== true);
    return { operation: 'delete_files', resolved };
  }
  if (isBatchEdits) {
    const editsArr = params.edits as Array<Record<string, unknown>>;
    const hasOldNew = editsArr.some(e => e.old != null || e.new != null);
    const hasBatchLineEdits = editsArr.some(e => Array.isArray(e.line_edits));
    if (hasOldNew && !hasBatchLineEdits) {
      const { mode: _m, ...rest } = resolved;
      return { operation: 'draft', resolved: rest };
    }
    return { operation: 'batch_edits', resolved };
  }
  // Prioritize line-edit branch: anchor line_edits must go through canonical { file, line_edits }, never fallback edits path
  if (hasLineEdits) {
    const fileVal = params.file_path || params.file;
    const fileSet = typeof fileVal === 'string';
    if (!fileSet) {
      throwEditValidationError(
        'change.edit with line_edits requires file or file_path (or edits[0].file)',
        'missing_edit_target',
      );
    }
    const leRaw = params.line_edits as unknown[];
    if (!Array.isArray(leRaw) || leRaw.length === 0) {
      throwEditValidationError('line_edits requires non-empty line_edits array', 'invalid_line_edits');
    }
    const VALID_ACTIONS = new Set([
      'insert_before',
      'insert_after',
      'prepend',
      'append',
      'replace',
      'replace_body',
      'delete',
    ]);
    // Validate each entry: must have (anchor or symbol or line) and explicit valid action. No silent defaults.
    // Backend LineEdit requires line: u32 for serde; when anchor/symbol present, line=0 signals resolve-from-anchor.
    let le = leRaw.map((e: unknown, i: number) => {
      const o = (e && typeof e === 'object' ? { ...(e as object) } : {}) as Record<string, unknown>;
      const hasAnchor = o.anchor != null && typeof o.anchor === 'string';
      const hasSymbol = o.symbol != null && typeof o.symbol === 'string';
      const hasLine = o.line != null;
      if (!hasAnchor && !hasSymbol && !hasLine) {
        throwEditValidationError(`line_edits[${i}] requires anchor, symbol, or line`, 'invalid_line_edit', { index: i });
      }
      const action = o.action;
      if (action == null || typeof action !== 'string') {
        throwEditValidationError(
          `line_edits[${i}] requires action (insert_before|insert_after|replace|replace_body|delete)`,
          'invalid_line_edit',
          { index: i },
        );
      }
      if (!VALID_ACTIONS.has(action as string)) {
        throwEditValidationError(
          `line_edits[${i}] invalid action "${action}". Valid: insert_before|insert_after|replace|replace_body|delete`,
          'invalid_line_edit',
          { index: i, action },
        );
      }
      if (hasLine && (typeof o.line !== 'number' || !Number.isInteger(o.line) || o.line <= 0)) {
        throwEditValidationError(`line_edits[${i}] line must be a positive integer`, 'invalid_line_edit', { index: i, line: o.line });
      }
      if ((hasAnchor || hasSymbol) && !hasLine) o.line = 0; // backend serde contract: 0 = resolve from anchor/symbol
      return o;
    });
    // Pre-dispatch: validate anchor replace content for brace languages — reject obviously unbalanced blocks
    validateAnchorReplaceContent(fileVal as string, le);
    le = coalesceExplicitLineEdits(le);
    // Backend expects exact { file, line_edits }; strip file_path, edits, etc. to avoid mixed/unsupported shape
    const canonical: Record<string, unknown> = {
      file: fileVal,
      line_edits: le,
    };
    const canonicalHash = canonicalizeContentHash(params.snapshot_hash ?? params.content_hash, params.edit_target_hash as string | undefined);
    if (typeof canonicalHash === 'string') {
      canonical.snapshot_hash = canonicalHash;
      canonical.content_hash = canonicalHash;
    }
    if (typeof params.edit_target_ref === 'string') canonical.edit_target_ref = params.edit_target_ref;
    if (typeof params.edit_target_kind === 'string') canonical.edit_target_kind = params.edit_target_kind;
    if (typeof params.edit_target_hash === 'string') canonical.edit_target_hash = params.edit_target_hash;
    if (Array.isArray(params.edit_target_range)) canonical.edit_target_range = params.edit_target_range;
    return { operation: 'draft', resolved: canonical };
  }
  if (hasCreates || hasEdits || hasSymbolEdits) {
    if (Array.isArray(resolved.edits)) {
      resolved.edits = resolved.edits.map((edit) => {
        if (!edit || typeof edit !== 'object') return edit;
        const entry = canonicalizeDraftEditFileField(edit as Record<string, unknown>);
        const canonicalHash = canonicalizeContentHash(entry.snapshot_hash ?? entry.content_hash, entry.edit_target_hash as string | undefined);
        entry.snapshot_hash = canonicalHash;
        entry.content_hash = canonicalHash;
        if (sameCanonicalHash(entry.edit_target_hash, entry.content_hash)) {
          entry.edit_target_hash = entry.content_hash;
        }
        return entry;
      });
    }
    return { operation: 'draft', resolved };
  }
  return { operation: 'draft', resolved };
}

export const handleEdit: OpHandler = async (params, ctx) => {
  try {
    for (const key of ['file', 'file_path'] as const) {
      const pathErr = validatePathParam(params[key], `edit: ${key}`);
      if (pathErr) return err(pathErr);
    }
    if (Array.isArray(params.edits)) {
      for (const edit of params.edits) {
        if (!edit || typeof edit !== 'object') continue;
        const entry = edit as Record<string, unknown>;
        for (const key of ['file', 'file_path'] as const) {
          const pathErr = validatePathParam(entry[key], `edit: edits[].${key}`);
          if (pathErr) return err(pathErr);
        }
      }
    }
    let preflightResult: import('../../../services/freshnessPreflight').PreflightResult | null = null;
    let automationDecision: import('../../../services/freshnessPreflight').AutomationDecision | null = null;
    const normalized = normalizeEditParams(params);
    const displayOnlyRefs = collectDisplayOnlyRefs(normalized);
    if (displayOnlyRefs.length > 0) {
      return formatDisplayOnlyRefError(displayOnlyRefs);
    }
    const targetResolution = await resolveTargetFiles(normalized);
    const { operation, resolved } = resolveEditOperation(targetResolution.params);
    const targetFiles = targetResolution.targetFiles.length > 0
      ? targetResolution.targetFiles
      : extractTargetFiles(resolved);
    const store = useContextStore.getState();
    if (['draft', 'batch_edits'].includes(operation)) {
      const preflight = await runFreshnessPreflight(operation, resolved, {
        atlsBatchQuery: ctx.atlsBatchQuery,
      });
      store.recordRebindOutcomes(preflight.decisions);
      const automation = getPreflightAutomationDecision(preflight);
      preflightResult = preflight;
      automationDecision = automation;
      if (preflight.blocked) {
        const identityLost = preflight.decisions.some((decision) => decision.classification === 'rebaseable');
        const payload = {
          blocked: true,
          reason: identityLost ? 'identity_lost' : 'suspect_external_change',
          error_class: identityLost ? 'identity_lost' : 'stale_hash',
          action_required: preflight.error,
          status: 'blocked',
          decisions: preflight.decisions,
          repro_pack: buildEditReproPack({
            operation,
            targetFiles,
            params: resolved,
            preflight,
            automation,
            errorClass: identityLost ? 'identity_lost' : 'stale_hash',
          }),
        };
        store.recordMemoryEvent({
          action: 'block',
          reason: identityLost ? 'identity_lost' : 'suspect_external_change',
          refs: targetFiles,
          confidence: preflight.confidence,
          strategy: preflight.strategy,
          factors: preflight.decisions.flatMap((decision) => decision.factors),
        });
        return errWithContent(preflight.error ?? 'File changed externally; re-read required', payload);
      }
      if (automation.action === 'review_required') {
        store.recordMemoryEvent({
          action: 'block',
          reason: 'low_confidence_rebind',
          refs: targetFiles,
          confidence: preflight.confidence,
          strategy: preflight.strategy,
          factors: preflight.decisions.flatMap((decision) => decision.factors),
        });
        return errWithContent('Low-confidence rebind detected; re-read required before edit', {
          blocked: true,
          reason: 'low_confidence_rebind',
          error_class: 'low_confidence_rebind',
          status: 'blocked',
          confidence: preflight.confidence,
          strategy: preflight.strategy,
          decisions: preflight.decisions,
          repro_pack: buildEditReproPack({
            operation,
            targetFiles,
            params: resolved,
            preflight,
            automation,
            errorClass: 'low_confidence_rebind',
          }),
        });
      }
      Object.assign(resolved, preflight.params);
      if (preflight.strategy !== 'fresh') {
        store.recordMemoryEvent({
          action: 'retry',
          reason: `${automation.reason}:${preflight.strategy}:${preflight.confidence}`,
          refs: targetFiles,
          confidence: preflight.confidence,
          strategy: preflight.strategy,
          factors: preflight.decisions.flatMap((decision) => decision.factors),
        });
      }
      if (preflight.relocationSummary) {
        (resolved as Record<string, unknown>)._relocation = {
          anchor_shifted: true,
          summary: preflight.relocationSummary,
        };
      }
    }
    if (targetFiles.length > 0 && ['draft', 'batch_edits'].includes(operation)) {
      const refreshed = preflightResult?.refreshedHashes ?? (await refreshContentHashes(ctx, targetFiles));
      if (refreshed.size > 0) {
        Object.assign(resolved, applyRefreshedContentHashes(resolved, refreshed));
        useContextStore.getState().recordMemoryEvent({
          action: 'retry',
          reason: 'prewrite_refresh',
          refs: targetFiles,
        });
      }
    }
    const isMutatingEditOperation = ['draft', 'batch_edits'].includes(operation);
    const stalePolicy = typeof normalized.stale_policy === 'string'
      ? normalized.stale_policy
      : (normalized.retry_on_failure === true || normalized.retry_with_fresh_read === true
          ? 'retry'
          : (isMutatingEditOperation
              ? 'follow_latest'
              : (normalized.require_fresh_read === true || typeof normalized.freshness_ttl_ms === 'number'
                  ? 'strict'
                  : undefined)));
    const requireFreshRead = normalized.require_fresh_read === true;
    const freshnessTtlMs = typeof normalized.freshness_ttl_ms === 'number'
      ? normalized.freshness_ttl_ms
      : undefined;
    const shouldEnforceFreshnessGate = !isMutatingEditOperation && (requireFreshRead || freshnessTtlMs != null);
    if (shouldEnforceFreshnessGate) {
      const suspectRefs = collectSuspectRefs(targetFiles, freshnessTtlMs);
      if (suspectRefs.length > 0) {
        const payload = {
          blocked: true,
          reason: 'suspect_engrams',
          error_class: 'stale_hash',
          suspect_refs: suspectRefs,
          action: "run read.context(type:'full', file_paths:[...]) or read.file for those files, then retry",
        };
        useContextStore.getState().recordMemoryEvent({
          action: 'block',
          reason: stalePolicy === 'strict' ? 'stale_policy_strict' : 'freshness_gate',
          refs: suspectRefs,
        });
        return errWithContent(
          `edit: ERROR [stale_hash] blocked by freshness policy — ${payload.action}`,
          payload,
        );
      }
    }
    if (stalePolicy === 'follow_latest' && targetFiles.length > 0 && !isMutatingEditOperation) {
      const refreshed = await refreshContentHashes(ctx, targetFiles);
      if (refreshed.size > 0) {
        Object.assign(resolved, applyRefreshedContentHashes(resolved, refreshed));
        useContextStore.getState().recordMemoryEvent({
          action: 'retry',
          reason: 'stale_policy_follow_latest',
          refs: targetFiles,
        });
      }
    }
    const backendStalePolicy = stalePolicy === 'follow_latest' || stalePolicy === 'retry'
      ? 'follow_latest'
      : 'block';
    if (['draft', 'batch_edits'].includes(operation)) {
      (resolved as Record<string, unknown>).stale_policy = backendStalePolicy;
    }
    let result = sanitizeSuccessfulEditWarnings(await ctx.atlsBatchQuery(operation, resolved), resolved);
    const retryOnFailure = stalePolicy === 'retry' || stalePolicy === 'follow_latest';
    const topLevelError = extractTopLevelError(result);
    const errorClass = String(topLevelError?.error_class ?? '');
    const shouldRetry = retryOnFailure
      && !!topLevelError
      && targetFiles.length > 0
      && (
        ['anchor_not_found', 'stale_hash'].includes(errorClass)
        || (hasExactSpanTarget(resolved) && [
          'range_drifted', 'mixed', 'span_out_of_range', 'anchor_mismatch_after_refresh',
        ].includes(errorClass))
      );
    if (shouldRetry) {
      const refreshed = await refreshContentHashes(ctx, targetFiles);
      const retriedParams = applyRefreshedContentHashes(resolved, refreshed);
      useContextStore.getState().recordMemoryEvent({
        action: 'retry',
        reason: errorClass || 'edit_retry',
        refs: targetFiles,
      });
      result = sanitizeSuccessfulEditWarnings(await ctx.atlsBatchQuery(operation, retriedParams), retriedParams);
    }
    const isMutating = ['draft', 'batch_edits'].includes(operation);
    if (isMutating) {
      registerEditHashes(result, resolved);
      invalidateStaleHashes(result);
      injectDiffRefs(result);
      extractEditLessons(result, resolved);
      recordEditSummary(result, resolved);
      const affectedPaths = extractAffectedPaths(result);
      if (affectedPaths.length > 0) {
        useContextStore.getState().bumpWorkspaceRev(affectedPaths);
      }
      if (preflightResult && automationDecision && preflightResult.strategy !== 'fresh') {
        result = attachPreflightMetadata(result, preflightResult, automationDecision, operation, targetFiles, resolved);
      }
    }
    const errorPayload = extractTopLevelError(result);
    if (errorPayload) {
      const enrichedErrorPayload = {
        ...errorPayload,
        repro_pack: buildEditReproPack({
          operation,
          targetFiles,
          params: resolved,
          preflight: preflightResult,
          automation: automationDecision,
          errorClass: String(errorPayload.error_class ?? 'edit_error'),
        }),
      };
      useContextStore.getState().recordMemoryEvent({
        action: 'block',
        reason: String(errorPayload.error_class ?? 'edit_error'),
        refs: targetFiles,
      });
      return errWithContent(formatEditErrorSummary(enrichedErrorPayload), enrichedErrorPayload);
    }
    const refs = extractRefs(result);
    let summary = JSON.stringify(result);
    if (isMutating && hasLintErrorsInResult(result)) {
      const hint = formatLintErrorHint(result);
      summary = `[LINT ERRORS] ${hint} — see lints.top_issues\n${summary}`;
    }
    return ok(summary, refs, result);
  } catch (editErr) {
    if (editErr instanceof EditValidationError) {
      const targetFiles = collectEditValidationTargets(params);
      const reproPack = buildEditReproPack({
        operation: inferEditOperationForValidation(params),
        targetFiles,
        params,
        errorClass: editErr.errorClass,
      });
      useContextStore.getState().recordMemoryEvent({
        action: 'block',
        reason: editErr.errorClass,
        refs: targetFiles,
      });
      const payload = {
        error: editErr.message,
        error_class: editErr.errorClass,
        repro_pack: reproPack,
        ...(editErr.details ?? {}),
      };
      return errWithContent(
        `edit: ERROR [${editErr.errorClass}] ${editErr.message}`,
        payload,
      );
    }
    return err(`edit: ERROR ${editErr instanceof Error ? editErr.message : String(editErr)}`);
  }
};

// ---------------------------------------------------------------------------
// change.create
// ---------------------------------------------------------------------------

export const handleCreate: OpHandler = async (params, ctx) => {
  try {
    const merged = normalizeCreateParams(params);
    const result = await ctx.atlsBatchQuery('create_files', merged);

    // Truncation diagnosis: warn if any file's written bytes differ from content length
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const r = result as Record<string, unknown>;
      const integrity = r.file_integrity;
      if (Array.isArray(integrity)) {
        for (const entry of integrity) {
          const rec = entry as Record<string, unknown>;
          if (rec.integrity_ok === false) {
            console.warn(
              `[change.create] Integrity mismatch for ${rec.path}: ` +
              `sent ${rec.content_length} bytes, wrote ${rec.written_bytes} bytes ` +
              `(hash: ${rec.content_hash})`,
            );
          }
        }
      }
    }

    const refs = extractRefs(result);
    const affectedPaths = extractAffectedPaths(result);
    if (affectedPaths.length > 0) {
      useContextStore.getState().bumpWorkspaceRev(affectedPaths);
    }
    return ok(JSON.stringify(result), refs, result);
  } catch (createErr) {
    return err(`create: ERROR ${createErr instanceof Error ? createErr.message : String(createErr)}`);
  }
};

// ---------------------------------------------------------------------------
// change.delete
// ---------------------------------------------------------------------------

export const handleDelete: OpHandler = async (params, ctx) => {
  const merged = {
    ...params,
    confirm: params.confirm ?? (params.dry_run !== true),
  };
  delete (merged as Record<string, unknown>).mode;
  try {
    const result = await ctx.atlsBatchQuery('delete_files', merged);
    const affectedPaths = extractAffectedPaths(result);
    if (affectedPaths.length > 0) {
      useContextStore.getState().bumpWorkspaceRev(affectedPaths);
    }
    return ok(JSON.stringify(result), [], result);
  } catch (delErr) {
    return err(`delete: ERROR ${delErr instanceof Error ? delErr.message : String(delErr)}`);
  }
};

// ---------------------------------------------------------------------------
// change.refactor
// ---------------------------------------------------------------------------

export const handleRefactor: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('refactor', params);
    registerEditHashes(result, params);
    invalidateStaleHashes(result);
    injectDiffRefs(result);
    const affectedPaths = extractAffectedPaths(result);
    if (affectedPaths.length > 0) {
      useContextStore.getState().bumpWorkspaceRev(affectedPaths);
    }
    const refs = extractRefs(result);
    return ok(JSON.stringify(result), refs, result);
  } catch (refactorErr) {
    return err(`refactor: ERROR ${refactorErr instanceof Error ? refactorErr.message : String(refactorErr)}`);
  }
};

// ---------------------------------------------------------------------------
// change.rollback
// ---------------------------------------------------------------------------

export const handleRollback: OpHandler = async (params, ctx) => {
  const merged: Record<string, unknown> = { ...params, action: 'rollback' };
  if (!merged.restore && !merged.delete) {
    return err(
      'rollback requires restore:[{file, hash}] (and optionally delete:[paths]) in step with. Get these from refactor execute _rollback on pause, or pass explicitly.',
    );
  }
  try {
    const result = await ctx.atlsBatchQuery('refactor', merged);
    const refs = extractRefs(result);
    return ok(JSON.stringify(result), refs, result);
  } catch (rbErr) {
    return err(`rollback: ERROR ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
  }
};

// ---------------------------------------------------------------------------
// change.split_match
// ---------------------------------------------------------------------------

export const handleSplitMatch: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('split_match', params);
    const refs = extractRefs(result);
    return ok(JSON.stringify(result), refs, result);
  } catch (splitErr) {
    return err(`split_match: ERROR ${splitErr instanceof Error ? splitErr.message : String(splitErr)}`);
  }
};

// ---------------------------------------------------------------------------
// change.split_module
// ---------------------------------------------------------------------------

export const handleSplitModule: OpHandler = async (params, ctx) => {
  try {
    const result = await ctx.atlsBatchQuery('split_module', params);
    const refs = extractRefs(result);
    const affectedPaths = extractAffectedPaths(result);
    if (affectedPaths.length > 0) {
      useContextStore.getState().bumpWorkspaceRev(affectedPaths);
    }
    return ok(JSON.stringify(result), refs, result);
  } catch (splitErr) {
    return err(`split_module: ERROR ${splitErr instanceof Error ? splitErr.message : String(splitErr)}`);
  }
};
