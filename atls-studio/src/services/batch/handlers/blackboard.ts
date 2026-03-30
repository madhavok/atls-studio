/**
 * Blackboard operation handlers — bb_write, bb_read, bb_delete, bb_list.
 */

import type { OpHandler, StepOutput } from '../types';
import { countTokensSync } from '../../../utils/tokenCounter';
import { normalizeHashRefsToStrings } from '../paramNorm';

function ok(summary: string, refs: string[] = []): StepOutput {
  return { kind: 'bb_ref', ok: true, refs, summary };
}

function err(summary: string): StepOutput {
  return { kind: 'bb_ref', ok: false, refs: [], summary, error: summary };
}

/** @returns false if DB was required and the operation failed */
async function persistBlackboardNote(key: string, content: string, sessionId: string | null, noteState?: string, filePath?: string): Promise<boolean> {
  try {
    const { chatDb } = await import('../../chatDb');
    if (sessionId && chatDb.isInitialized()) {
      await chatDb.setBlackboardNote(sessionId, key, content, noteState, filePath);
    }
    return true;
  } catch (e) {
    console.warn('[bb] Failed to persist bb note:', e);
    return false;
  }
}

/** @returns false if DB was required and the operation failed */
async function deleteBlackboardNote(key: string, sessionId: string | null): Promise<boolean> {
  try {
    const { chatDb } = await import('../../chatDb');
    if (sessionId && chatDb.isInitialized()) {
      await chatDb.deleteBlackboardNote(sessionId, key);
    }
    return true;
  } catch (e) {
    console.warn('[bb] Failed to delete bb note:', e);
    return false;
  }
}

export const handleBbWrite: OpHandler = async (params, ctx) => {
  const key = params.key as string;
  const content = params.content as string;
  if (!key) return err('bb_write: ERROR missing key');
  if (key.startsWith('__ctx_')) return err('bb_write: ERROR reserved key prefix __ctx_');

  if (!content || content.trim() === '') {
    const dbOk = await deleteBlackboardNote(key, ctx.sessionId);
    if (!dbOk) return err('bb_write: ERROR could not delete note from database');
    const removed = ctx.store().removeBlackboardEntry(key);
    return ok(removed ? `bb_write: ${key} deleted (empty content)` : `bb_write: ${key} not found`);
  }

  const derivedFrom = normalizeHashRefsToStrings(params.derived_from ?? params.derivedFrom);
  const derivedOpt = derivedFrom.length > 0 ? derivedFrom : undefined;
  const { tokens } = ctx.store().setBlackboardEntry(key, content, derivedOpt?.length ? { derivedFrom: derivedOpt } : undefined);
  const entryMeta = ctx.store().getBlackboardEntryWithMeta(key);
  let line = `bb_write: h:bb:${key} (${tokens}tk) — use h:bb:${key} in response`;
  if (derivedOpt?.length) line += ` | derived_from: ${derivedOpt.join(', ')}`;
  const persisted = await persistBlackboardNote(key, content, ctx.sessionId, entryMeta?.state ?? 'active', entryMeta?.filePath);
  if (!persisted) {
    ctx.store().removeBlackboardEntry(key);
    return err('bb_write: ERROR could not persist note to database');
  }

  if (derivedOpt?.length) {
    const meta = ctx.store().getBlackboardEntryWithMeta(key);
    const staleWarnings: string[] = [];
    for (let i = 0; i < derivedOpt.length; i++) {
      const awareness = ctx.store().getAwareness(derivedOpt[i]);
      const storedRev = meta?.derivedRevisions?.[i];
      if (awareness && storedRev && awareness.snapshotHash !== storedRev) {
        staleWarnings.push(derivedOpt[i]);
      }
    }
    if (staleWarnings.length > 0) {
      line += ` [STALE DERIVATION: ${staleWarnings.join(', ')}]`;
    }
  }

  const stem = key.replace(/[-_]?\d+$|[-_]?(final|latest|v\d+)$/i, '');
  if (stem && stem !== key) {
    const allEntries = ctx.store().listBlackboardEntries();
    const superseded = allEntries
      .filter(e => e.key !== key && e.key.startsWith(stem))
      .map(e => e.key);
    if (superseded.length > 0) {
      line += ` | NOTE: ${superseded.length} older version(s) may be superseded: ${superseded.join(', ')} — consider session.bb.delete`;
    }
  }

  return ok(line, [`h:bb:${key}`]);
};

export const handleBbRead: OpHandler = async (params, ctx) => {
  let keys = params.keys as string[] | string | undefined;
  if (typeof keys === 'string') keys = [keys];
  if (!keys?.length) return err('bb_read: ERROR missing keys param');

  const lines: string[] = [];
  const refs: string[] = [];
  for (const k of keys) {
    const meta = ctx.store().getBlackboardEntryWithMeta(k);
    if (meta) {
      let staleWarning = '';
      if (meta.derivedFrom?.length && meta.derivedRevisions?.length) {
        const staleFiles: string[] = [];
        const pairLen = Math.min(meta.derivedFrom.length, meta.derivedRevisions.length);
        for (let i = 0; i < pairLen; i++) {
          const path = meta.derivedFrom[i];
          const storedRev = meta.derivedRevisions[i];
          if (!storedRev) continue;
          const awareness = ctx.store().getAwareness(path);
          if (awareness && awareness.snapshotHash !== storedRev) {
            staleFiles.push(path);
          }
        }
        if (staleFiles.length > 0) {
          staleWarning = ` [stale: source changed — ${staleFiles.join(', ')}]`;
        }
      }
      let supersededWarning = '';
      if (meta.state === 'superseded') {
        const byHash = meta.supersededBy ? ` by h:${meta.supersededBy.slice(0, 8)}` : '';
        supersededWarning = ` [superseded${byHash} — not in active reasoning]`;
      } else if (meta.state === 'historical') {
        supersededWarning = ' [historical — not authoritative for action]';
      }
      const tk = countTokensSync(meta.content);
      const visibleNote = meta.state === 'active' ? ' — visible in ## BLACKBOARD block' : ' — excluded from ## BLACKBOARD';
      lines.push(`bb_read:${k}: [-> bb:${k}, ${tk}tk${visibleNote}]${staleWarning}${supersededWarning}`);
      refs.push(`h:bb:${k}`);
    } else {
      lines.push(`bb_read:${k}: NOT_FOUND`);
    }
  }
  return ok(lines.join('\n'), refs);
};

export const handleBbDelete: OpHandler = async (params, ctx) => {
  let keys = params.keys as string[] | string | undefined;
  if (typeof keys === 'string') keys = [keys];
  if (!keys?.length) return err('bb_delete: ERROR missing keys param');

  let deleted = 0;
  for (const k of keys) {
    const dbOk = await deleteBlackboardNote(k, ctx.sessionId);
    if (!dbOk) {
      return err(`bb_delete: ERROR could not delete ${k} from database`);
    }
    if (ctx.store().removeBlackboardEntry(k)) deleted++;
  }
  return ok(`bb_delete: ${deleted} entries removed`);
};

export const handleBbList: OpHandler = async (_params, ctx) => {
  const entries = ctx.store().listBlackboardEntries();
  if (entries.length === 0) return ok('bb_list: (empty)');

  const activeEntries = entries.filter(e => e.state === 'active');
  const supersededEntries = entries.filter(e => e.state !== 'active');

  const formatEntry = (e: typeof entries[0]): string => {
    const stateLabel = e.state === 'active' ? '' :
      e.state === 'superseded' ? ` [superseded${e.supersededBy ? ` by h:${e.supersededBy.slice(0, 8)}` : ''}]` :
      ` [${e.state}]`;
    return `  ${e.key}: ${e.preview} (${e.tokens}tk)${stateLabel}`;
  };

  const lines: string[] = [];
  if (activeEntries.length > 0) {
    lines.push(...activeEntries.map(formatEntry));
  }
  if (supersededEntries.length > 0) {
    lines.push(`  --- ${supersededEntries.length} superseded/historical ---`);
    lines.push(...supersededEntries.map(formatEntry));
  }

  const refs = entries.map(e => `h:bb:${e.key}`);
  return ok(`bb_list: ${entries.length} entries (${activeEntries.length} active, ${supersededEntries.length} superseded)\n${lines.join('\n')}`, refs);
};
