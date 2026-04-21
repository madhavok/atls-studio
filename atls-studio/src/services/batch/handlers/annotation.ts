/**
 * Annotation/engram operation handlers — rule, annotate, link, retype, split, merge, engram_edit, annotate.design.
 */

import type { OpHandler, StepOutput, ContextStoreApi } from '../types';
import { SHORT_HASH_LEN } from '../../../utils/contextHash';
import { resolveForwardChain as manifestResolveForwardChain } from '../../hashManifest';

function ok(summary: string, refs: string[] = []): StepOutput {
  return { kind: 'session', ok: true, refs, summary };
}

function err(summary: string): StepOutput {
  return { kind: 'session', ok: false, refs: [], summary, error: summary };
}

/** Base hash segment (strips h: and shape/line suffix). */
function baseHashFromRef(ref: string): string {
  const rest = ref.startsWith('h:') ? ref.slice(2) : ref;
  return rest.includes(':') ? rest.split(':')[0]! : rest;
}

/**
 * If `ref` is a FileView retention hash, return the view's `sourceRevision`
 * (the real content hash backing the view) so annotation handlers can pass
 * it to chunk-based stores. Returns undefined for non-view refs; callers
 * fall through to normal resolution.
 */
function viewSourceRevisionForRef(ref: string, store: ContextStoreApi): string | undefined {
  if (!ref || !ref.startsWith('h:')) return undefined;
  const short = baseHashFromRef(ref).slice(0, SHORT_HASH_LEN);
  if (!short || !/^[0-9a-fA-F_]{6,16}$/.test(short)) return undefined;
  const views = store.fileViews;
  if (!views) return undefined;
  const toFullRef = (sr: string) => (sr.startsWith('h:') ? sr : `h:${sr}`);
  for (const view of views.values()) {
    if (
      view.shortHash === short
      || view.shortHash.startsWith(short)
      || short.startsWith(view.shortHash)
    ) {
      return toFullRef(view.sourceRevision);
    }
  }
  // Stale-ref recovery: if the short isn't a live view, walk the
  // hash-manifest forward chain. Annotate/link refs copied from past
  // tool output after an edit should route to the current view.
  try {
    const walk = manifestResolveForwardChain(short);
    if (walk.kind === 'resolved') {
      for (const view of views.values()) {
        if (
          view.shortHash === walk.shortHash
          || view.shortHash.startsWith(walk.shortHash)
          || walk.shortHash.startsWith(view.shortHash)
        ) {
          return toFullRef(view.sourceRevision);
        }
      }
    }
  } catch {
    // Non-fatal: fall back to "not a view ref".
  }
  return undefined;
}

/** Block when chunk is suspect — annotation ops mutate in-place and cannot relocate. */
function isChunkSuspect(store: ContextStoreApi): (hash: string) => boolean {
  return (hash: string) => {
    const short = baseHashFromRef(hash).slice(0, SHORT_HASH_LEN);
    for (const [, chunk] of store.chunks) {
      if (chunk.shortHash === short || chunk.hash.startsWith(short)) {
        return chunk.suspectSince != null;
      }
    }
    for (const [, chunk] of store.archivedChunks) {
      if (chunk.shortHash === short || chunk.hash.startsWith(short)) {
        return chunk.suspectSince != null;
      }
    }
    return false;
  };
}

export const handleRule: OpHandler = async (params, ctx) => {
  const action = (params.action as string) || 'set';
  const key = (params.key ?? params.hash) as string;

  if (action === 'list') {
    const rules = ctx.store().listRules();
    if (rules.length === 0) return ok('rule: (no cognitive rules set)');
    const list = rules.map(r => `  ${r.key}: ${r.content} (${r.tokens}tk)`).join('\n');
    return ok(`rule: ${rules.length} active\n${list}`);
  }

  if (!key) return err('rule: missing key param');

  if (action === 'delete') {
    const removed = ctx.store().removeRule(key);
    return ok(removed ? `rule: deleted "${key}"` : `rule: "${key}" not found`);
  }

  const content = params.content as string;
  if (!content) return err('rule: missing content param');
  const { tokens, warning } = ctx.store().setRule(key, content);
  let line = `rule: set "${key}" (${tokens}tk)`;
  if (warning) line += ` | WARNING: ${warning}`;
  return ok(line);
};

/**
 * Unified annotation handler: accepts a free-form `note` and/or structured
 * `fields` (digest/summary/type) on any ref — chunks, FileViews, or staged
 * snippets. Internally routes:
 *   - note     → store.addAnnotation(ref, note)   (free-form, always works)
 *   - fields   → store.editEngram(ref, fields)    (metadata edit in place)
 *
 * `annotate.engram` is a compatibility alias that points at this same
 * handler — from the model's view there's one `annotate` verb that
 * attaches whatever you hand it to a ref. The runtime picks the right
 * backing store based on ref kind.
 *
 * FileView refs used to reject metadata edits because views weren't
 * modeled as engrams; we now route them via `viewSourceRevisionForRef`
 * to the underlying chunk, so both shapes "just work" on view refs too.
 */
export const handleAnnotate: OpHandler = async (params, ctx) => {
  const hash = params.hash as string;
  const note = params.note as string | undefined;
  const fields = params.fields as Record<string, unknown> | undefined;
  if (!hash) return err('annotate: missing hash param');
  if (!note && (!fields || typeof fields !== 'object')) {
    return err('annotate: pass `note` (string) and/or `fields` (metadata edits)');
  }

  const store = ctx.store();
  const resolved = viewSourceRevisionForRef(hash, store) ?? hash;
  if (isChunkSuspect(store)(resolved)) {
    return err('annotate: ref changed — re-read and retry');
  }

  const outRefs: string[] = [];
  const parts: string[] = [];
  const shortOut = (h: string) => (h.startsWith('h:') ? h.slice(2) : h);

  if (note) {
    const annotateResult = store.addAnnotation(resolved, note);
    if (!annotateResult.ok) return err(`annotate: ${annotateResult.error}`);
    parts.push(`note:${annotateResult.id}`);
  }

  if (fields && typeof fields === 'object') {
    const editResult = store.editEngram(resolved, fields);
    if (!editResult.ok) return err(`annotate: ${editResult.error}`);
    if (editResult.newHash) {
      const ref = `h:${editResult.newHash}`;
      outRefs.push(ref);
      parts.push(editResult.metadataOnly ? `fields (metadata in-place)` : `fields → ${ref}`);
    } else {
      parts.push('fields applied');
    }
  }

  return ok(`annotate: h:${shortOut(resolved)} — ${parts.join(' | ')}`, outRefs);
};

/**
 * Compatibility alias: `annotate.engram`. Previous prompts/tools expected
 * a `fields`-only op; we funnel it through the unified `handleAnnotate`
 * so existing call sites keep working without a second code path.
 */
export const handleEngramEdit: OpHandler = async (params, ctx) => {
  if (!params.hash) return err('annotate: missing hash param');
  if (!params.fields || typeof params.fields !== 'object') {
    return err('annotate: missing fields param');
  }
  return handleAnnotate(params, ctx);
};

export const handleLink: OpHandler = async (params, ctx) => {
  const fromRaw = params.from as string;
  const toRaw = params.to as string;
  const relation = params.relation as string;
  if (!fromRaw || !toRaw) return err('link: missing from/to params');

  const store = ctx.store();
  // Route FileView refs to their backing content chunk (sourceRevision).
  // Views aren't linkable entities on their own — the chunk underneath is.
  // Falls through for BB, path, or regular chunk refs.
  const fromResolved = viewSourceRevisionForRef(fromRaw, store) ?? fromRaw;
  const toResolved = viewSourceRevisionForRef(toRaw, store) ?? toRaw;
  const from = store.resolveLinkRefToHash(fromResolved);
  const to = store.resolveLinkRefToHash(toResolved);
  const suspect = isChunkSuspect(store);
  if (suspect(from) || suspect(to)) {
    return err('link: ref changed — re-read and retry');
  }
  const validRelations = new Set(['caused_by', 'depends_on', 'related_to', 'supersedes', 'refines']);
  const rel = relation && validRelations.has(relation) ? relation : 'related_to';
  const result = store.addSynapse(from, to, rel);
  if (result.ok) return ok(`link: synapse ${from} → ${to} (${rel})`);
  return err(`link: ${result.error}`);
};

export const handleRetype: OpHandler = async (params, ctx) => {
  const hash = params.hash as string;
  const newType = params.type as string;
  if (!hash) return err('retype: missing hash param');
  if (!newType) return err('retype: missing type param');

  const store = ctx.store();
  if (isChunkSuspect(store)(hash)) {
    return err('retype: ref changed — re-read and retry');
  }
  const result = store.retypeChunk(hash, newType);
  if (result.ok) return ok(`retype: h:${hash.startsWith('h:') ? hash.slice(2) : hash} → ${newType}`);
  return err(`retype: ${result.error}`);
};

export const handleSplit: OpHandler = async (params, ctx) => {
  const hash = params.hash as string;
  const at = params.at as number;
  if (!hash) return err('split: missing hash param');
  if (at == null || typeof at !== 'number') return err('split: missing/invalid at param (line number)');

  const store = ctx.store();
  if (isChunkSuspect(store)(hash)) {
    return err('split: ref changed — re-read and retry');
  }
  const result = store.splitEngram(hash, at);
  if (result.ok && result.hashes) {
    return ok(`split: h:${result.hashes[0]} + h:${result.hashes[1]} (original archived)`, result.hashes.map(h => `h:${h}`));
  }
  return err(`split: ${result.error}`);
};

export const handleMerge: OpHandler = async (params, ctx) => {
  const hashes = params.hashes as string[];
  const summary = params.summary as string | undefined;
  if (!hashes?.length || hashes.length < 2) return err('merge: need at least 2 hashes');

  const store = ctx.store();
  const suspect = isChunkSuspect(store);
  if (hashes.some(h => suspect(h))) {
    return err('merge: ref changed — re-read and retry');
  }
  const result = store.mergeEngrams(hashes, summary);
  if (result.ok) return ok(`merge: h:${result.newHash} (${hashes.length} engrams merged, originals archived)`, result.newHash ? [`h:${result.newHash}`] : []);
  return err(`merge: ${result.error}`);
};

export const handleDesignWrite: OpHandler = async (params, _ctx) => {
  const { useAppStore } = await import('../../../stores/appStore');
  const appStore = useAppStore.getState();
  if (appStore.chatMode !== 'designer') {
    return err('annotate.design: only available in Designer chat mode');
  }

  const content = params.content as string;
  if (!content || typeof content !== 'string') return err('annotate.design: missing content');

  const append = params.append === true;
  const sessionId = appStore.currentSessionId;
  const prev = appStore.designPreviewContent;
  const next = append ? (prev + content) : content;
  appStore.setDesignPreview(next, sessionId);
  return ok(`annotate.design: preview updated (${next.length} chars)`);
};
