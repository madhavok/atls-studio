/**
 * Annotation/engram operation handlers — rule, annotate, link, retype, split, merge, engram_edit, annotate.design.
 */

import type { OpHandler, StepOutput, ContextStoreApi } from '../types';
import { SHORT_HASH_LEN } from '../../../utils/contextHash';

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
  const action = params.action as string;
  const key = params.key as string;
  if (!key) return err('rule: ERROR missing key param');

  if (action === 'delete') {
    const removed = ctx.store().removeRule(key);
    return ok(removed ? `rule: deleted "${key}"` : `rule: "${key}" not found`);
  }

  if (action === 'list') {
    const rules = ctx.store().listRules();
    if (rules.length === 0) return ok('rule: (no cognitive rules set)');
    const list = rules.map(r => `  ${r.key}: ${r.content} (${r.tokens}tk)`).join('\n');
    return ok(`rule: ${rules.length} active\n${list}`);
  }

  const content = params.content as string;
  if (!content) return err('rule: ERROR missing content param');
  const { tokens, warning } = ctx.store().setRule(key, content);
  let line = `rule: set "${key}" (${tokens}tk)`;
  if (warning) line += ` | WARNING: ${warning}`;
  return ok(line);
};

export const handleEngramEdit: OpHandler = async (params, ctx) => {
  const hash = params.hash as string;
  const fields = params.fields as Record<string, unknown> | undefined;
  if (!hash) return err('engram_edit: ERROR missing hash param');
  if (!fields || typeof fields !== 'object') return err('engram_edit: ERROR missing fields param');

  const store = ctx.store();
  if (isChunkSuspect(store)(hash)) {
    return err('engram_edit: ERROR ref is suspect (file changed externally); re-read before editing');
  }
  const result = store.editEngram(hash, fields);
  if (result.ok) {
    const msg = result.metadataOnly
      ? `engram_edit: h:${result.newHash} (metadata updated in-place)`
      : `engram_edit: h:${result.newHash} (content mutated, old hash forwards)`;
    return ok(msg, result.newHash ? [`h:${result.newHash}`] : []);
  }
  return err(`engram_edit: ERROR ${result.error}`);
};

export const handleAnnotate: OpHandler = async (params, ctx) => {
  const hash = params.hash as string;
  const note = params.note as string;
  if (!hash) return err('annotate: ERROR missing hash param');
  if (!note) return err('annotate: ERROR missing note param');

  const store = ctx.store();
  if (isChunkSuspect(store)(hash)) {
    return err('annotate: ERROR ref is suspect (file changed externally); re-read before editing');
  }
  const result = store.addAnnotation(hash, note);
  if (result.ok) {
    return ok(`annotate: added to h:${hash.startsWith('h:') ? hash.slice(2) : hash} (id: ${result.id})`);
  }
  return err(`annotate: ERROR ${result.error}`);
};

export const handleLink: OpHandler = async (params, ctx) => {
  const fromRaw = params.from as string;
  const toRaw = params.to as string;
  const relation = params.relation as string;
  if (!fromRaw || !toRaw) return err('link: ERROR missing from/to params');

  const store = ctx.store();
  const from = store.resolveLinkRefToHash(fromRaw);
  const to = store.resolveLinkRefToHash(toRaw);
  const suspect = isChunkSuspect(store);
  if (suspect(from) || suspect(to)) {
    return err('link: ERROR one or more refs are suspect (file changed externally); re-read before editing');
  }
  const validRelations = new Set(['caused_by', 'depends_on', 'related_to', 'supersedes', 'refines']);
  const rel = relation && validRelations.has(relation) ? relation : 'related_to';
  const result = store.addSynapse(from, to, rel);
  if (result.ok) return ok(`link: synapse ${from} → ${to} (${rel})`);
  return err(`link: ERROR ${result.error}`);
};

export const handleRetype: OpHandler = async (params, ctx) => {
  const hash = params.hash as string;
  const newType = params.type as string;
  if (!hash) return err('retype: ERROR missing hash param');
  if (!newType) return err('retype: ERROR missing type param');

  const store = ctx.store();
  if (isChunkSuspect(store)(hash)) {
    return err('retype: ERROR ref is suspect (file changed externally); re-read before editing');
  }
  const result = store.retypeChunk(hash, newType);
  if (result.ok) return ok(`retype: h:${hash.startsWith('h:') ? hash.slice(2) : hash} → ${newType}`);
  return err(`retype: ERROR ${result.error}`);
};

export const handleSplit: OpHandler = async (params, ctx) => {
  const hash = params.hash as string;
  const at = params.at as number;
  if (!hash) return err('split: ERROR missing hash param');
  if (at == null || typeof at !== 'number') return err('split: ERROR missing/invalid at param (line number)');

  const store = ctx.store();
  if (isChunkSuspect(store)(hash)) {
    return err('split: ERROR ref is suspect (file changed externally); re-read before editing');
  }
  const result = store.splitEngram(hash, at);
  if (result.ok && result.hashes) {
    return ok(`split: h:${result.hashes[0]} + h:${result.hashes[1]} (original archived)`, result.hashes.map(h => `h:${h}`));
  }
  return err(`split: ERROR ${result.error}`);
};

export const handleMerge: OpHandler = async (params, ctx) => {
  const hashes = params.hashes as string[];
  const summary = params.summary as string | undefined;
  if (!hashes?.length || hashes.length < 2) return err('merge: ERROR need at least 2 hashes');

  const store = ctx.store();
  const suspect = isChunkSuspect(store);
  if (hashes.some(h => suspect(h))) {
    return err('merge: ERROR one or more refs are suspect (file changed externally); re-read before editing');
  }
  const result = store.mergeEngrams(hashes, summary);
  if (result.ok) return ok(`merge: h:${result.newHash} (${hashes.length} engrams merged, originals archived)`, result.newHash ? [`h:${result.newHash}`] : []);
  return err(`merge: ERROR ${result.error}`);
};

export const handleDesignWrite: OpHandler = async (params, _ctx) => {
  const { useAppStore } = await import('../../../stores/appStore');
  const appStore = useAppStore.getState();
  if (appStore.chatMode !== 'designer') {
    return err('annotate.design: ERROR only available in Designer chat mode (switch mode to Designer)');
  }

  const content = params.content as string;
  if (!content || typeof content !== 'string') return err('annotate.design: ERROR missing content');

  const append = params.append === true;
  const sessionId = appStore.currentSessionId;
  const prev = appStore.designPreviewContent;
  const next = append ? (prev + content) : content;
  appStore.setDesignPreview(next, sessionId);
  return ok(`annotate.design: preview updated (${next.length} chars)`);
};
