/**
 * Session operation handlers — task lifecycle, pin, stage, compact, drop, recall.
 */

import type { ContextStoreApi, OpHandler, HandlerContext, StepOutput } from '../types';
import { SHORT_HASH_LEN, sliceContentByLines } from '../../../utils/contextHash';
import { PROTECTED_RECENT_ROUNDS } from '../../promptMemory';
import { parseHashRef } from '../../../utils/hashRefParsers';
import { invoke } from '@tauri-apps/api/core';
import { normalizeHashRefsToStrings, normalizeSessionPlanSubtasksInput } from '../paramNorm';

/**
 * Resolve a retention short-hash against the FileView store. Returns the
 * view's filePath + sourceRevision when one matches, or undefined. The view's
 * `sourceRevision` is what the Rust backend understands for content reads;
 * the retention hash is TS-only. Used by handlers (stage, retention ops)
 * that accept any `h:<ref>` and need to route FileView refs to their file.
 */
function resolveFileViewRef(
  cleanHash: string,
  ctx: HandlerContext,
): { filePath: string; sourceRevision: string } | undefined {
  const shortPart = cleanHash.split(':')[0];
  if (!shortPart || !/^[0-9a-fA-F_]{6,16}$/.test(shortPart)) return undefined;
  try {
    const views = ctx.store().fileViews;
    if (!views) return undefined;
    for (const view of views.values()) {
      if (
        view.shortHash === shortPart
        || view.shortHash.startsWith(shortPart)
        || shortPart.startsWith(view.shortHash)
      ) {
        return { filePath: view.filePath, sourceRevision: view.sourceRevision };
      }
    }
  } catch {
    // Non-fatal: caller falls back to chunk/registry lookup.
  }
  return undefined;
}

/** If ref is `h:HASH:7-10` / `h:HASH:1-3,5-7`, extract line spec for staged snippet metadata (drift rebase). */
function lineSpecFromHashRef(rawRef: string): string | undefined {
  const p = parseHashRef(rawRef);
  const mod = p?.modifier;
  if (!mod || typeof mod !== 'object' || !('lines' in mod)) return undefined;
  const ranges = mod.lines as Array<[number, number | null]>;
  if (!Array.isArray(ranges)) return undefined;
  return ranges
    .map(([start, end]) => (end == null || end === start ? `${start}` : `${start}-${end}`))
    .join(',');
}

const RECALL_MAX_CHARS = 50_000;
const RECALL_BATCH_MAX_CHARS = 100_000;

let _recallBudgetUsed = 0;

export function resetRecallBudget(): void {
  _recallBudgetUsed = 0;
}

function ok(summary: string, refs: string[] = [], tokens?: number): StepOutput {
  return { kind: 'session', ok: true, refs, summary, tokens };
}

function err(summary: string): StepOutput {
  return { kind: 'session', ok: false, refs: [], summary, error: summary };
}

// ---------------------------------------------------------------------------
// task_plan
// ---------------------------------------------------------------------------

/** `round1_foo: Do the thing` → id `round1_foo`, title `Do the thing` (matches session.advance subtask ids). */
function parseSubtaskString(raw: string): { id: string; title: string } {
  const s = raw.trim();
  const colon = s.indexOf(':');
  if (colon <= 0) return { id: s, title: s };
  const id = s.slice(0, colon).trim();
  const title = s.slice(colon + 1).trim() || id;
  return { id, title };
}

export const handleTaskPlan: OpHandler = async (params, ctx) => {
  const goal = params.goal as string;
  if (!goal) return err('task_plan: missing goal');

  const rawSubtasks = normalizeSessionPlanSubtasksInput(params.subtasks);
  type SubStatus = 'pending' | 'active' | 'done' | 'blocked';
  const subtasks = rawSubtasks.map((s, i) => {
    const st: SubStatus = i === 0 ? 'active' : 'pending';
    if (typeof s === 'string') {
      const { id, title } = parseSubtaskString(s);
      return { id, title, status: st };
    }
    return { id: s.id, title: s.title, status: st };
  });
  ctx.store().setTaskPlan({
    goal,
    subtasks,
    activeSubtaskId: subtasks.length > 0 ? subtasks[0].id : null,
  });
  const activeLabel = subtasks.find(s => s.status === 'active')?.title || 'none';
  return ok(`task_plan: ${subtasks.length} subtasks | ${activeLabel}(active)`);
};

// ---------------------------------------------------------------------------
// task_advance
// ---------------------------------------------------------------------------

export const handleTaskAdvance: OpHandler = async (params, ctx) => {
  let subtaskId = typeof params.subtask === 'string' ? params.subtask.trim() : undefined;
  const plan = ctx.store().taskPlan;
  if (!plan) return err('task_advance: plan not started — call session.plan first');

  const planProgress = (): string => {
    const done = plan.subtasks.filter(s => s.status === 'done').length;
    return `${done}/${plan.subtasks.length} done`;
  };
  if (!subtaskId) {
    const { subtasks } = plan;
    const currentIdx = subtasks.findIndex(s => s.status === 'active');
    if (currentIdx < 0) return err(`task_advance: no active subtask (${planProgress()}) — call session.status to inspect`);
    const next = subtasks[currentIdx + 1];
    if (!next) return err(`task_advance: plan complete (${planProgress()}) — use task_complete for final summary`);
    subtaskId = next.id;
  }

  // Primary: exact id match. Fallbacks handle common model mistakes where the
  // model passes the human title (`Inspect`) or a wrong-case id — reject only
  // when the fallback is ambiguous, so plans never advance to the wrong row.
  let target = plan.subtasks.find(s => s.id === subtaskId);
  if (!target) {
    const needle = subtaskId.toLowerCase();
    const byIdCI = plan.subtasks.filter(s => s.id.toLowerCase() === needle);
    if (byIdCI.length === 1) {
      target = byIdCI[0];
      subtaskId = target.id;
    } else {
      const byTitle = plan.subtasks.filter(s => s.title.trim().toLowerCase() === needle);
      if (byTitle.length === 1) {
        target = byTitle[0];
        subtaskId = target.id;
      }
    }
  }
  if (!target) return err(`task_advance: subtask "${subtaskId}" not found in plan (${planProgress()})`);
  if (target.status === 'done') return ok(`task_advance: subtask "${subtaskId}" already done (${planProgress()}) — advance to a different one or task_complete`);

  const summary = typeof params.summary === 'string' ? (params.summary as string).trim() : '';
  if (summary.length < 50) {
    // Self-discriminating: tell the model what's about to happen so they
    // can judge whether extending the summary will complete the plan or
    // just advance to the next subtask.
    const nextIdx = plan.subtasks.findIndex(s => s.id === subtaskId);
    const afterNext = plan.subtasks[nextIdx + 1];
    const hint = afterNext
      ? `next: ${afterNext.id}(${afterNext.title})`
      : `this is the final subtask — task_complete will be required after`;
    return err(`task_advance: summary too short (got ${summary.length}, need ≥50 chars) for subtask "${subtaskId}" — ${hint}`);
  }

  // Advance gate: warn when advancing without BB findings in this phase
  const bm = ctx.store().getBatchMetrics();
  const hadFindings = bm.hadSubstantiveBbWrite || bm.hadBbWrite;
  let advanceWarning = '';
  if (!hadFindings) {
    advanceWarning = 'WARNING: advancing without BB findings or edits in this phase — knowledge won\'t persist without findings or summary.\n';
  }

  const { unloaded, freedTokens } = ctx.store().advanceSubtask(subtaskId, summary);
  return ok(
    `${advanceWarning}task_advance: ${subtaskId}(active) | ${unloaded} chunks archived (${(freedTokens / 1000).toFixed(1)}k tokens freed)`,
    [],
    -freedTokens,
  );
};

// ---------------------------------------------------------------------------
// task_status
// ---------------------------------------------------------------------------

export const handleTaskStatus: OpHandler = async (_params, ctx) => {
  const plan = ctx.store().taskPlan;
  if (!plan) return ok('task_status: no plan set');
  const statusParts = plan.subtasks.map(s => `${s.id}(${s.status})`).join(', ');
  return ok(`task_status: ${plan.goal} | ${statusParts}`);
};

// ---------------------------------------------------------------------------
// unload
// ---------------------------------------------------------------------------

export const handleUnload: OpHandler = async (params, ctx) => {
  const rawFromParams = normalizeHashRefsToStrings(params.hashes);
  const { refs: expanded, notes } = resolveRefsOrStepIds(params, ctx, rawFromParams);
  if (!expanded.length) {
    return err('unload: retention op missing refs — provide h: refs or step-id.');
  }

  const confirmWildcard = params.confirmWildcard === true;
  const { freed, count, pinnedKept } = ctx.store().unloadChunks(expanded, { confirmWildcard });
  if (count === 0 && pinnedKept === 0) {
    const noteSuffix = notes.length > 0 ? ` | ${notes.join('; ')}` : '';
    return err(
      `unload: no matching refs in manifest${noteSuffix}. Check the HASH MANIFEST before retrying; evicted refs can't be unloaded.`,
    );
  }
  let line = `unload: ${count} chunks freed (${(freed / 1000).toFixed(1)}k tokens)`;
  if (pinnedKept > 0) line += ` | ${pinnedKept} pinned kept`;
  if (notes.length > 0) line += ` | ${notes.join('; ')}`;
  return ok(line, [], -freed);
};

// ---------------------------------------------------------------------------
// compact
// ---------------------------------------------------------------------------

export const handleCompact: OpHandler = async (params, ctx) => {
  const rawFromParams = normalizeHashRefsToStrings(params.hashes);
  const { refs: expanded, notes } = resolveRefsOrStepIds(params, ctx, rawFromParams);
  if (!expanded.length) {
    return err('compact: retention op missing refs — provide h: refs or step-id.');
  }

  const confirmWildcard = params.confirmWildcard === true;
  const tier = (params.tier as 'pointer' | 'sig' | undefined) ?? 'pointer';

  let sigContentByRef: Map<string, string> | undefined;
  if (tier === 'sig') {
    const { invoke } = await import('@tauri-apps/api/core');
    const { invokeWithTimeout } = await import('../../toolHelpers');
    const READ_TIMEOUT_MS = 15_000;
    sigContentByRef = new Map();
    for (const ref of expanded) {
      const rawRef = ref.startsWith('h:') ? ref : `h:${ref}`;
      const content = ctx.store().getChunkContent(rawRef);
      if (!content) continue;
      const chunks = ctx.store().chunks;
      const norm = (r: string) => (r.startsWith('h:') ? r.slice(2) : r).slice(0, 8);
      let chunkHash: string | undefined;
      for (const [, c] of chunks) {
        if (c.shortHash === norm(rawRef) || c.hash.startsWith(norm(rawRef))) {
          chunkHash = c.hash;
          break;
        }
      }
      if (!chunkHash) {
        const arch = ctx.store().archivedChunks;
        for (const [, c] of arch) {
          if (c.shortHash === norm(rawRef) || c.hash.startsWith(norm(rawRef))) {
            chunkHash = c.hash;
            break;
          }
        }
      }
      if (!chunkHash) continue;
      try {
        await invoke('register_hash_content', { hash: chunkHash, content, source: null, lang: null });
        const resolved = await invokeWithTimeout<{ content: string }>('resolve_hash_ref', {
          rawRef: `h:${chunkHash}:sig`,
        }, READ_TIMEOUT_MS);
        if (resolved?.content) sigContentByRef.set(rawRef, resolved.content);
      } catch (e) {
        console.warn(`[session] sig resolution failed for ${rawRef}:`, e);
      }
    }
  }

  const { compacted, freedTokens } = ctx.store().compactChunks(expanded, { confirmWildcard, tier, sigContentByRef });
  if (compacted === 0) {
    const noteSuffix = notes.length > 0 ? ` | ${notes.join('; ')}` : '';
    return err(
      `compact: no refs to compact${noteSuffix} — they're already compact or released.`,
    );
  }
  const tierLabel = tier === 'sig' ? ' (sig tier)' : '';
  let line = `compact: ${compacted} chunks compacted${tierLabel} (${(freedTokens / 1000).toFixed(1)}k freed). Use h:HASH in tool params to reference.`;
  if (notes.length > 0) line += ` | ${notes.join('; ')}`;
  return ok(line, [], -freedTokens);
};

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

export const handleStage: OpHandler = async (params, ctx) => {
  const rawHash = params.hash as string | undefined;
  const lines = params.lines as string | undefined;
  const rawContent = params.content as string | undefined;
  const label = params.label as string | undefined;
  const hashes = params.hashes as string[] | undefined;
  const contextLines = Math.max(0, Math.min(5, Math.trunc((params.context_lines as number | undefined) ?? 3)));

  // Batch stage: hashes/refs array (from auto_stage_refs or model) — resolve each ref and stage by content+label
  const hashList = Array.isArray(hashes) ? hashes : [];
  if (hashList.length > 0) {
    let totalTokens = 0;
    const staged: string[] = [];
    const failed: string[] = [];
    for (const ref of hashList) {
      const rawRef = ref.startsWith('h:') ? ref : `h:${ref}`;
      try {
        // FileView retention refs are TS-only; rewrite to the view's
        // sourceRevision before asking the Rust registry so a retention
        // hash stages identically to a chunk hash. `resolve_hash_ref` for a
        // file-scoped ref returns the file body; we then stage the full
        // body under the view's retention ref as the stage key.
        const bareCandidate = rawRef.slice(2);
        const viewHit = resolveFileViewRef(bareCandidate, ctx);
        const effectiveRef = viewHit
          ? (viewHit.sourceRevision.startsWith('h:') ? viewHit.sourceRevision : `h:${viewHit.sourceRevision}`)
          : rawRef;
        const resolved = await invoke<{ content: string; source?: string | null }>('resolve_hash_ref', {
          rawRef: effectiveRef,
          sessionId: ctx.sessionId ?? null,
        });
        if (resolved?.content) {
          const stageKey = rawRef;
          const lineSpec = lineSpecFromHashRef(rawRef);
          const result = ctx.store().stageSnippet(
            stageKey,
            resolved.content,
            resolved.source || viewHit?.filePath || rawRef,
            lineSpec,
            undefined,
            undefined,
            'derived',
          );
          if (result.ok) {
            totalTokens += result.tokens;
            staged.push(rawRef);
          } else failed.push(rawRef);
        } else failed.push(rawRef);
      } catch (e) {
        console.warn(`[session] stage resolve failed for ${rawRef}:`, e);
        failed.push(rawRef);
      }
    }
    const total = ctx.store().getStagedTokenCount();
    const line = failed.length > 0
      ? `stage_batch: ${staged.length} staged, ${failed.length} failed [${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '...' : ''}]. Total: ${(total / 1000).toFixed(1)}k`
      : `stage_batch: ${staged.length} refs staged (${totalTokens}tk). Total: ${(total / 1000).toFixed(1)}k`;
    return ok(line, [], totalTokens);
  }

  if (rawContent) {
    const key = label || `content-${Date.now()}`;
    const result = ctx.store().stageSnippet(key, rawContent, label || 'inline', undefined, undefined, undefined, 'snapshot');
    if (!result.ok) return err(`stage: ${result.error}`);
    const total = ctx.store().getStagedTokenCount();
    return ok(`staged [${key}] (${result.tokens}tk). Total staged: ${(total / 1000).toFixed(1)}k`, [], result.tokens);
  }

  if (!rawHash || !lines) return err('stage: requires (hash + lines) or (content + label)');
  let cleanHash = rawHash.startsWith('h:') ? rawHash.slice(2) : rawHash;
  const stageKey = label || `${rawHash.startsWith('h:') ? rawHash : `h:${cleanHash}`}:${lines}:ctx(${contextLines})`;

  const ctxState = ctx.store();
  let sourcePath: string | undefined;
  let chunkIsRaw = false;
  let inMemoryContent: string | undefined;

  // Accept FileView retention hashes in the same slot as regular chunk refs.
  // Views live in `fileViews`, not `chunks`; resolve to the view's file +
  // sourceRevision so the backend read_lines call below works identically
  // to a chunk-backed stage. This mirrors the FileView pre-pass in
  // change.ts so the single ref the model sees works across all slots.
  const viewRef = resolveFileViewRef(cleanHash, ctx);
  if (viewRef) {
    sourcePath = viewRef.filePath;
    cleanHash = viewRef.sourceRevision.replace(/^h:/, '');
  }

  for (const chunks of [ctxState.archivedChunks, ctxState.chunks]) {
    for (const chunk of chunks.values()) {
      if (chunk.shortHash === cleanHash || chunk.hash.startsWith(cleanHash)) {
        sourcePath = chunk.source;
        chunkIsRaw = chunk.type === 'raw' || chunk.type === 'file';
        if (chunkIsRaw) {
          if (chunks === ctxState.archivedChunks) {
            inMemoryContent = chunk.content;
          } else if (chunk.compacted) {
            inMemoryContent = ctxState.archivedChunks.get(chunk.hash)?.content;
          } else {
            inMemoryContent = chunk.content;
          }
        }
        break;
      }
    }
    if (sourcePath !== undefined) break;
  }

  let resolvedContent: string | undefined;

  if (chunkIsRaw && inMemoryContent) {
    resolvedContent = sliceContentByLines(inMemoryContent, lines, false, contextLines);
  } else {
    const rlParams: Record<string, unknown> = { hash: `h:${cleanHash}`, lines, context_lines: contextLines };
    if (sourcePath) rlParams.file_path = sourcePath;
    try {
      const backendResult = await ctx.atlsBatchQuery('read_lines', rlParams);
      let r = backendResult as Record<string, unknown>;
      if (r.error === 'stale' && sourcePath) {
        try {
          const refreshResult = await ctx.atlsBatchQuery('context', { type: 'full', file_paths: [sourcePath] });
          const rrItems = (refreshResult as Record<string, unknown>)?.results;
          const rr = Array.isArray(rrItems) ? rrItems[0] as Record<string, unknown> : {} as Record<string, unknown>;
          const newHash = (rr.content_hash ?? rr.hash) as string | undefined;
          if (newHash) {
            const retryResult = await ctx.atlsBatchQuery('read_lines', { hash: newHash, lines, file_path: sourcePath, context_lines: contextLines });
            r = retryResult as Record<string, unknown>;
          }
        } catch (e) { console.warn(`[session] stale auto-refresh failed for ${sourcePath}:`, e); }
        if (r.error === 'stale') {
          return err(`stage h:${cleanHash}: file changed on disk and auto-refresh failed — re-read first`);
        }
      } else if (r.error) {
        // Hash not found — fall through to chat DB
      }
      if (r.content) resolvedContent = String(r.content);
    } catch (backendErr) {
      console.warn(`[stage] backend read_lines failed for h:${cleanHash}:`, backendErr);
    }
  }

  if (!resolvedContent) {
    try {
      const { chatDb } = await import('../../chatDb');
      if (ctx.sessionId && chatDb.isInitialized()) {
        const entry = await chatDb.getContentByHash(ctx.sessionId, cleanHash);
        if (entry) {
          resolvedContent = sliceContentByLines(entry.content, lines, false, contextLines);
          sourcePath = sourcePath || entry.source || 'blackboard';
        }
      }
    } catch (e) { console.warn(`[session] chatDb content lookup failed for h:${cleanHash}:`, e); }
  }

  if (!resolvedContent) return err(`stage: h:${cleanHash} not found — load or read the file first`);

  const stageResult = ctx.store().stageSnippet(stageKey, resolvedContent, sourcePath || 'unknown', lines, cleanHash, undefined, 'derived');
  if (!stageResult.ok) return err(`stage: ${stageResult.error}`);
  const stageTotal = ctx.store().getStagedTokenCount();
  return ok(`staged ${stageKey} lines:${lines} ctx:${contextLines} (${stageResult.tokens}tk, ${sourcePath || 'unknown'}). Total: ${(stageTotal / 1000).toFixed(1)}k`, [], stageResult.tokens);
};

// ---------------------------------------------------------------------------
// unstage
// ---------------------------------------------------------------------------

export const handleUnstage: OpHandler = async (params, ctx) => {
  const rawHash = params.hash as string | undefined;
  const unstageLabel = params.label as string | undefined;
  const unstageHashes = normalizeHashRefsToStrings(params.hashes);

  if (unstageHashes.length > 0) {
    if (unstageHashes[0] === '*') {
      const { freed } = ctx.store().unstageSnippet('*');
      const remaining = ctx.store().getStagedTokenCount();
      const note = remaining > 0 ? ` (entry sigs retained: ${(remaining / 1000).toFixed(1)}k)` : '';
      return ok(`unstaged all (${(freed / 1000).toFixed(1)}k freed)${note}`, [], -freed);
    }
    let totalFreed = 0;
    const notFound: string[] = [];
    for (const h of unstageHashes) {
      const clean = h.startsWith('h:') ? h : `h:${h}`;
      const { freed } = ctx.store().unstageSnippet(clean);
      totalFreed += freed;
      if (freed === 0) notFound.push(clean);
    }
    const matched = unstageHashes.length - notFound.length;
    if (totalFreed === 0 && unstageHashes.length > 0) {
      return err(`unstage: none of ${unstageHashes.length} refs found in stage: ${notFound.join(', ')}`);
    }
    const nfNote = notFound.length > 0 ? `, not found: ${notFound.join(', ')}` : '';
    return ok(`unstaged ${matched}/${unstageHashes.length} entries (${(totalFreed / 1000).toFixed(1)}k freed)${nfNote}`, [], -totalFreed);
  }

  const unstageKey = unstageLabel || (rawHash ? (rawHash.startsWith('h:') ? rawHash : `h:${rawHash}`) : undefined);
  if (!unstageKey) return err('unstage: requires hash, label, or hashes:["*"]');
  const { freed } = ctx.store().unstageSnippet(unstageKey);
  if (freed === 0) return err(`unstage: ${unstageKey} not found in stage`);
  return ok(`unstaged ${unstageKey} (${(freed / 1000).toFixed(1)}k freed). Total: ${(ctx.store().getStagedTokenCount() / 1000).toFixed(1)}k`, [], -freed);
};

// ---------------------------------------------------------------------------
// drop
// ---------------------------------------------------------------------------

function toBaseHash(ref: string): string {
  const rest = ref.startsWith('h:') ? ref.slice(2) : ref;
  return rest.includes(':') ? rest.split(':')[0]! : rest;
}

function collectChunkDetails(
  hashes: string[],
  store: () => { chunks: Map<string, { hash: string; shortHash: string; source?: string; tokens: number }> },
): string {
  if (hashes.length === 0 || hashes.includes('*') || hashes.includes('all')) return '';
  const chunks = store().chunks;
  const details: string[] = [];
  for (const h of hashes) {
    const normalized = toBaseHash(h);
    for (const [, chunk] of chunks) {
      if (chunk.hash === normalized || chunk.shortHash === normalized || chunk.hash.startsWith(normalized) || normalized.startsWith(chunk.hash)) {
        const name = chunk.source ? (chunk.source.split(/[/\\]/).pop() || chunk.source) : chunk.shortHash;
        details.push(`h:${chunk.shortHash} ${name}`);
        break;
      }
    }
  }
  return details.join(', ');
}

export const handleDrop: OpHandler = async (params, ctx) => {
  const scope = typeof params.scope === 'string' ? params.scope.trim().toLowerCase() : undefined;
  let rawHashes: string[];

  if (scope === 'dormant') {
    const maxRaw = params.max;
    const max = typeof maxRaw === 'number' && Number.isFinite(maxRaw)
      ? Math.max(1, Math.min(10_000, Math.trunc(maxRaw)))
      : undefined;
    const collected: string[] = [];
    for (const [, c] of ctx.store().chunks) {
      if (!c.compacted || c.pinned) continue;
      collected.push(`h:${c.shortHash}`);
      if (max != null && collected.length >= max) break;
    }
    if (!collected.length) {
      return ok('drop: 0 dormant compacted unpinned chunks (nothing to drop)');
    }
    rawHashes = collected;
  } else if (scope === 'archived') {
    // Mirror scope:dormant ergonomics — collect archived hashes so the model
    // can clear cold storage without hand-enumerating every hash.
    const maxRaw = params.max;
    const max = typeof maxRaw === 'number' && Number.isFinite(maxRaw)
      ? Math.max(1, Math.min(10_000, Math.trunc(maxRaw)))
      : undefined;
    const collected: string[] = [];
    for (const [, c] of ctx.store().archivedChunks) {
      collected.push(`h:${c.shortHash}`);
      if (max != null && collected.length >= max) break;
    }
    if (!collected.length) {
      return ok('drop: 0 archived chunks (nothing to drop)');
    }
    rawHashes = collected;
  } else {
    rawHashes = normalizeHashRefsToStrings(params.hashes);
  }

  // Scope drops already emitted concrete h:refs above; explicit-hash drops
  // run through the shared step-id + set-selector resolver for parity with
  // other retention ops.
  const isScopeDrop = scope === 'dormant' || scope === 'archived';
  let expanded: string[];
  let notes: string[];
  if (isScopeDrop) {
    const r = ctx.expandSetRefsInHashes(rawHashes);
    expanded = r.expanded;
    notes = r.notes;
  } else {
    const helper = resolveRefsOrStepIds(params, ctx, rawHashes);
    if (!helper.refs.length) {
      return err('drop: retention op missing refs — provide h: refs, a scope (dormant|archived), or step-id.');
    }
    expanded = helper.refs;
    notes = helper.notes;
  }

  const droppedDetail = collectChunkDetails(expanded, ctx.store);
  const { dropped, freedTokens } = ctx.store().dropChunks(expanded, { confirmWildcard: true });
  // Explicit-hash drops that matched nothing should err loudly.
  if (dropped === 0 && scope === undefined) {
    const noteSuffix = notes.length > 0 ? ` | ${notes.join('; ')}` : '';
    return err(
      `drop: no matching refs in manifest${noteSuffix}. Check the HASH MANIFEST before retrying; refs that aren't listed are already released.`,
    );
  }
  let line = `drop: ${dropped} chunks permanently dropped (${(freedTokens / 1000).toFixed(1)}k freed, manifest entries kept)`;
  if (notes.length > 0) line += ` | ${notes.join('; ')}`;
  if (droppedDetail) line += ` | dropped: [${droppedDetail}]`;
  if (scope === 'dormant') line += ' | scope:dormant';
  else if (scope === 'archived') line += ' | scope:archived';
  return ok(line, [], -freedTokens);
};

// ---------------------------------------------------------------------------
// pin / unpin
// ---------------------------------------------------------------------------

/** Base hash segment from h:XXXX or h:XXXX:lines (matches contextStore refToBaseHash). */
function baseHashFromRefToken(h: string): string {
  const rest = h.startsWith('h:') ? h.slice(2) : h;
  return rest.includes(':') ? rest.split(':')[0]! : rest;
}

/** True when the segment after h: looks like a real short hash (hex), not a step id (e.g. r1, s2). */
function isPlausibleHashBaseSegment(base: string): boolean {
  return /^[0-9a-fA-F]{6,64}$/.test(base);
}

/**
 * Recover hashes from a misplaced dataflow string in `params.in` (e.g. `"r1.refs"`).
 * Models sometimes write `with: { in: "r1.refs" }` in structured JSON, imitating
 * the `q:` line syntax `pi in:r1.refs`. The `q:` parser handles this correctly via
 * `expandDataflow`, but when placed in `with` instead of `step.in`, the executor
 * passes it through as a plain param. This recovers by resolving the step output.
 */
function recoverDataflowIn(params: Record<string, unknown>, ctx: HandlerContext): string[] {
  const raw = params.in;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const val = raw.trim().replace(/^in:/, '');
  const dotIdx = val.indexOf('.');
  const stepId = dotIdx === -1 ? val : val.slice(0, dotIdx);
  const output = ctx.getStepOutput?.(stepId);
  if (!output?.refs?.length) return [];
  materializeFileRefsContentIfNeeded(output, ctx.store());
  return output.refs;
}

/**
 * Shared helper for retention ops (pin / unpin / drop / compact / unload /
 * recall). Resolves a raw ref list into concrete `h:` hashes, expanding:
 *   - `in:` dataflow strings in `params.in` (misplaced binding syntax)
 *   - Bare step-ids (e.g. `pu r1`) to that step's output refs
 *   - Set selectors (`h:@pinned`, `h:@edited`, etc.) via
 *     `ctx.expandSetRefsInHashes`
 *
 * Returns `{ refs, notes }` where `refs` is the expanded list and `notes`
 * carries any binding-expansion hints (e.g. `r1 → h:abc, h:def`) for the
 * model's step summary. Keeps handler parity so `pu r1`, `dro r1`,
 * `pc r1` are all first-class without each handler reinventing the logic.
 */
function resolveRefsOrStepIds(
  params: Record<string, unknown>,
  ctx: HandlerContext,
  rawFromParams: string[],
): { refs: string[]; notes: string[] } {
  let rawHashes = rawFromParams;
  if (!rawHashes.length) {
    rawHashes = recoverDataflowIn(params, ctx);
  }
  if (!rawHashes.length) return { refs: [], notes: [] };

  const { expanded, notes } = ctx.expandSetRefsInHashes(rawHashes);

  // Materialize any file_refs from prior steps so refs resolve in the store.
  ctx.forEachStepOutput?.((_, out) => {
    materializeFileRefsContentIfNeeded(out, ctx.store());
  });

  // Resolve bare step-ids (e.g. `r1`) to their output refs. Hash-prefixed
  // tokens pass through unchanged.
  const resolved = expanded.flatMap(ref => {
    const token = typeof ref === 'string' ? ref : String(ref);
    if (token.startsWith('h:')) return [token];
    const stepOutput = ctx.getStepOutput?.(token);
    if (stepOutput?.refs?.length) {
      materializeFileRefsContentIfNeeded(stepOutput, ctx.store());
      notes.push(`${token} \u2192 ${stepOutput.refs.join(', ')}`);
      return stepOutput.refs;
    }
    return [token];
  });

  return { refs: resolved, notes };
}

/**
 * Ensure read_lines / file_refs step outputs exist as engrams before pinChunks.
 * read.lines returns file_refs with embedded content but does not call addChunk until post-batch deflation;
 * session.pin in the same batch must materialize first.
 */
function materializeFileRefsContentIfNeeded(out: StepOutput, store: ContextStoreApi): void {
  if (out.kind !== 'file_refs' || !out.ok || !out.content || typeof out.content !== 'object') return;
  const root = out.content as Record<string, unknown>;
  const singles: Array<Record<string, unknown>> = [];

  if (!Array.isArray(root.results) && typeof root.file === 'string' && typeof root.content === 'string') {
    singles.push(root);
  }
  const results = root.results;
  if (Array.isArray(results)) {
    for (const item of results) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (typeof row.file === 'string' && typeof row.content === 'string') {
        singles.push(row);
      }
    }
  }

  for (const row of singles) {
    const file = row.file as string;
    const text = row.content as string;
    const hashField = row.hash ?? row.h;
    if (typeof hashField !== 'string') continue;
    const testRef = hashField.startsWith('h:') ? hashField : `h:${hashField}`;
    if (store.getChunkForHashRef(testRef)) continue;
    const snap = typeof row.content_hash === 'string' ? row.content_hash
      : typeof row.snapshot_hash === 'string' ? row.snapshot_hash : undefined;
    const backendKey = baseHashFromRefToken(testRef);
    const opts: Record<string, unknown> = {};
    if (snap) opts.sourceRevision = snap;
    const ar = row.actual_range;
    if (Array.isArray(ar) && file && snap) {
      const first = ar[0] as [number, number | null] | undefined;
      const last = ar[ar.length - 1] as [number, number | null] | undefined;
      if (first && last) {
        opts.readSpan = {
          filePath: file,
          sourceRevision: snap,
          startLine: first[0],
          endLine: last[1] ?? last[0],
        };
      }
    }
    store.addChunk(text, 'result', file, undefined, undefined, backendKey, opts);
  }
}

export const handlePin: OpHandler = async (params, ctx) => {
  const bindingWarnHashes = typeof params._binding_warning_hashes === 'string' ? params._binding_warning_hashes : '';
  const rawFromParams = normalizeHashRefsToStrings(params.hashes ?? params.refs);
  const { refs: resolved, notes } = resolveRefsOrStepIds(params, ctx, rawFromParams);
  if (!resolved.length) {
    if (bindingWarnHashes) {
      return err(
        `pin: ${bindingWarnHashes} If the prior step was a search/read that returned no new refs (deduped or empty), re-run it or pin a different step that has h:refs.`,
      );
    }
    return err(
      'pin: missing refs — provide h:refs or step-id. Reads auto-pin, so `pi` is only for non-read artifacts (search/verify/exec results).',
    );
  }

  const pinShape = (params.shape as string) || undefined;
  const { count, alreadyPinned } = ctx.store().pinChunks(resolved, pinShape);
  // Zero-match failure path — surface loudly so the model sees something went
  // wrong instead of silently trusting a fake `ok`. "already pinned" is still
  // a success outcome (idempotent pin on a real ref), so it returns ok.
  if (count === 0 && alreadyPinned === 0) {
    let msg = `pin: no matching chunks for ${resolved.length} ref${resolved.length === 1 ? '' : 's'} — they may be released or already pinned.`;
    const suspicious = resolved.filter((t) => !isPlausibleHashBaseSegment(baseHashFromRefToken(t)));
    if (suspicious.length > 0) {
      const sample = suspicious[0]!;
      const stepGuess = baseHashFromRefToken(sample);
      msg += ` If "${sample}" was meant to name a batch step, use hashes from that step's output, bare step id "${stepGuess}", or in:{hashes:{from_step:"${stepGuess}",path:"refs"}}; the h: prefix is only for real content hashes (6+ hex), not step ids.`;
    }
    if (notes.length > 0) msg += ` | ${notes.join('; ')}`;
    return err(msg);
  }
  const shapeTag = pinShape ? ` (shape:${pinShape})` : '';
  let line = count > 0
    ? `pin: ${count} chunk${count > 1 ? 's' : ''} pinned${shapeTag}`
    : `pin: ${alreadyPinned} already pinned${shapeTag}`;
  // Legacy "BLOCKED full-file read" message removed. Under FileView, full-file
  // chunks are legitimate pin targets and skippedFullFile is never incremented.
  // The field stays on the return type as a compat no-op for older callers.
  if (notes.length > 0) line += ` | ${notes.join('; ')}`;
  // Emit resolved hashes on refs so formatters can suppress the volatile-pin nudge
  // for refs pinned in this same batch. session.pin is not in READ_SEARCH_OPS, so these
  // refs do NOT get re-aggregated into volatileRefs.
  return ok(line, resolved);
};

export const handleUnpin: OpHandler = async (params, ctx) => {
  const rawFromParams = normalizeHashRefsToStrings(params.hashes);
  const { refs: resolved, notes } = resolveRefsOrStepIds(params, ctx, rawFromParams);
  if (!resolved.length) {
    return err('unpin: retention op missing refs — provide h: refs or step-id.');
  }

  const { count, alreadyUnpinned, unknown } = ctx.store().unpinChunks(resolved);
  if (count === 0) {
    const noteSuffix = notes.length > 0 ? ` | ${notes.join('; ')}` : '';
    // Idempotent no-op: everything passed in was already released.
    if (alreadyUnpinned > 0 && unknown === 0) {
      return ok(`unpin: 0 unpinned (${alreadyUnpinned} already unpinned — no-op)${noteSuffix}`);
    }
    if (unknown > 0 && alreadyUnpinned === 0) {
      return err(
        `unpin: ${unknown} ref${unknown === 1 ? '' : 's'} did not resolve — check the HASH MANIFEST.${noteSuffix}`,
      );
    }
    if (unknown > 0 && alreadyUnpinned > 0) {
      return err(
        `unpin: ${unknown} unknown ref${unknown === 1 ? '' : 's'}, ${alreadyUnpinned} already unpinned — check the HASH MANIFEST.${noteSuffix}`,
      );
    }
    return err(`unpin: no matching pinned refs in manifest${noteSuffix}.`);
  }
  let line = `unpin: ${count} chunk${count > 1 ? 's' : ''} unpinned`;
  if (alreadyUnpinned > 0) line += ` (${alreadyUnpinned} already unpinned)`;
  if (unknown > 0) line += ` (${unknown} unknown)`;
  if (notes.length > 0) line += ` | ${notes.join('; ')}`;
  return ok(line);
};

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

export const handleRecall: OpHandler = async (params, ctx) => {
  const rawFromParams = normalizeHashRefsToStrings(params.hashes);
  const { refs: expanded, notes } = resolveRefsOrStepIds(params, ctx, rawFromParams);
  if (!expanded.length) return err('recall: retention op missing refs — provide h: refs or step-id.');

  const lines: string[] = [];
  if (notes.length > 0) lines.push(`recall: ${notes.join('; ')}`);

  for (const h of expanded) {
    const chunkInfo = ctx.store().getChunkForHashRef(h);
    const content = chunkInfo?.content ?? ctx.store().getChunkContent(h);
    if (!content) {
      lines.push(`recall:${h}: ref unavailable — re-read to restore`);
      continue;
    }
    let recallContent = content;
    if (recallContent.length > RECALL_MAX_CHARS) {
      recallContent = recallContent.slice(0, RECALL_MAX_CHARS) + '\n... [truncated at 50k chars]';
    }
    if (_recallBudgetUsed + recallContent.length > RECALL_BATCH_MAX_CHARS) {
      lines.push(`recall:${h}: BUDGET_EXCEEDED (100k batch limit reached)`);
      continue;
    }
    _recallBudgetUsed += recallContent.length;
    ctx.store().touchChunk(h);
    // Type header so the model can tell what kind of chunk it pulled back
    // (file vs. batch summary vs. search result vs. …). Silent echo of a
    // giant batch-summary chunk used to be indistinguishable from real
    // file content, which caused unproductive re-reads downstream.
    const kind = chunkInfo?.chunkType ?? 'chunk';
    const src = chunkInfo?.source ? ` source:${chunkInfo.source}` : '';
    lines.push(`recall:${h} (${kind}, ${recallContent.length} chars${src}):\n${recallContent}`);
  }
  return ok(lines.join('\n'), expanded);
};

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

export const handleStats: OpHandler = async (_params, ctx) => {
  const stats = ctx.store().getStats();
  const usedK = (stats.usedTokens / 1000).toFixed(1);
  const maxK = (stats.maxTokens / 1000).toFixed(0);
  const freedK = (stats.freedTokens / 1000).toFixed(1);
  const pinnedCount = ctx.store().getPinnedCount();
  const bbK = (stats.bbTokens / 1000).toFixed(1);
  let header = `Context: ${usedK}k/${maxK}k tokens`;
  if (pinnedCount > 0) header += ` | ${pinnedCount} pinned`;
  if (stats.bbCount > 0) header += ` | bb:${bbK}k (${stats.bbCount} entries)`;
  header += ` | freed:${freedK}k`;
  const telemetry = stats.memoryTelemetry;
  if (telemetry.eventCount > 0) {
    header += ` | mem:${telemetry.eventCount}`;
    if (telemetry.rebindCount > 0) header += ` rebind:${telemetry.rebindCount}`;
    if (telemetry.blockCount > 0) header += ` block:${telemetry.blockCount}`;
    if (telemetry.retryCount > 0) header += ` retry:${telemetry.retryCount}`;
  }
  const planState = ctx.store().taskPlan;
  const planLine = planState ? `\nPlan: ${planState.goal} | ${planState.subtasks.map(s => `${s.id}(${s.status})`).join(', ')}` : '';
  const pinnedChunks = stats.chunks.filter(c => c.pinned);
  const unpinnedCount = stats.chunkCount - pinnedChunks.length;
  const pinnedList = pinnedChunks.map(c => `  ${c.h}: ${c.tk}tk ${c.type}${c.src ? `:${c.src}` : ''}`).join('\n');
  const unpinnedLine = unpinnedCount > 0 ? `\n  (+${unpinnedCount} unpinned chunks)` : '';
  return ok(`${header}${planLine}\n\nPinned:\n${pinnedList || '  (none)'}${unpinnedLine}`);
};

// ---------------------------------------------------------------------------
// debug (context_debug)
// ---------------------------------------------------------------------------

export const handleSessionDebug: OpHandler = async (_params, ctx) => {
  const { getBatchFailureSummary, BATCH_FAILURE_THRESHOLD } = await import('../../freshnessTelemetry');
  const state = ctx.store();
  const stats = state.getStats();
  const stagedK = (state.getStagedTokenCount() / 1000).toFixed(1);
  const chunkCount = state.chunks?.size ?? 0;
  const archiveCount = state.archivedChunks?.size ?? 0;
  const plan = state.taskPlan;
  const planLine = plan
    ? ` | Plan: ${plan.goal} [${plan.subtasks.map(s => `${s.id}:${s.status}`).join(', ')}]`
    : '';
  const chunkSummary = chunkCount > 0
    ? `\nChunks (${chunkCount}): ${Array.from(state.chunks?.values() ?? [])
        .slice(0, 5)
        .map((c: { shortHash: string; tokens: number; source?: string; type?: string }) =>
          `h:${c.shortHash} ${c.tokens}tk ${c.source?.split(/[/\\]/).pop() ?? c.type ?? '?'}`)
        .join(', ')}${chunkCount > 5 ? ` ... +${chunkCount - 5} more` : ''}`
    : '';

  // Batch-failure telemetry: surface only *repeated* misuse (count >= threshold)
  // so persistent blind spots are visible without re-echoing one-off error
  // prose the model already saw inline (and which would undo the
  // anti-spin vocabulary cleanup elsewhere). Clip snippets hard — debug
  // is a diagnostic, not an error replay.
  const FAIL_SNIPPET_CAP = 80;
  const clip = (s: string): string => (s.length > FAIL_SNIPPET_CAP ? s.slice(0, FAIL_SNIPPET_CAP - 1) + '…' : s);
  const failureSummary = getBatchFailureSummary();
  let failureBlock = '';
  if (failureSummary.length > 0) {
    const crossing = failureSummary.filter(e => e.count >= BATCH_FAILURE_THRESHOLD);
    if (crossing.length > 0) {
      const topLines = crossing.slice(0, 5).map(
        e => `  [x${e.count}] ${e.op}: ${clip(e.errorSnippet)}`,
      );
      failureBlock = `\nRepeated failures (${crossing.length} classes):\n${topLines.join('\n')}`;
    }
  }

  return ok(
    `debug: ${stats.usedTokens / 1000}k tk | ${archiveCount} archived | staged:${stagedK}k${planLine}${chunkSummary}${failureBlock}`,
  );
};

// ---------------------------------------------------------------------------
// diagnose (spin diagnostics)
// ---------------------------------------------------------------------------

export const handleSessionDiagnose: OpHandler = async (_params, _ctx) => {
  const { useRoundHistoryStore } = await import('../../../stores/roundHistoryStore');
  const { diagnoseSpinning, formatSpinTrace, computeWmDiff } = await import('../../spinDetector');

  const snapshots = useRoundHistoryStore.getState().snapshots;
  if (snapshots.length < 3) {
    return ok('diagnose: Not enough rounds yet (need at least 3). No spin diagnosis available.');
  }

  const diagnosis = diagnoseSpinning(snapshots);
  const trace = formatSpinTrace(snapshots);

  const mainSnaps = snapshots.filter(s => !s.isSubagentRound && !s.isSwarmRound);
  const older = mainSnaps.length >= 4 ? mainSnaps[mainSnaps.length - 4] : mainSnaps[0];
  const newer = mainSnaps[mainSnaps.length - 1];
  const wmDiff = computeWmDiff(older, newer);

  const parts: string[] = [];

  // Only surface "SPIN DETECTED" when we're meaningfully confident. Low-
  // confidence matches (≤50%) used to fire on deliberate, planned tool
  // sweeps (e.g. "edit → search without BB update" over a 3-round window)
  // and pushed the model toward corrective actions it didn't need. Lower
  // confidence still gets reported as a weak signal so a model explicitly
  // running diagnose can see what's borderline.
  const SPIN_DIAGNOSE_THRESHOLD = 0.5;
  if (diagnosis.spinning && diagnosis.confidence >= SPIN_DIAGNOSE_THRESHOLD) {
    parts.push(`SPIN DETECTED: ${diagnosis.mode} (confidence: ${(diagnosis.confidence * 100).toFixed(0)}%)`);
    parts.push(`Trigger: round ${diagnosis.triggerRound}`);
    parts.push(`Evidence:\n${diagnosis.evidence.map(e => `  - ${e}`).join('\n')}`);
    parts.push(`Action: ${diagnosis.suggestedAction}`);
  } else if (diagnosis.spinning) {
    parts.push(`No spin detected. (weak signal: ${diagnosis.mode} at ${(diagnosis.confidence * 100).toFixed(0)}% — below action threshold)`);
  } else {
    parts.push('No spin detected.');
  }

  parts.push(`\nRound trace (last ${Math.min(mainSnaps.length, 5)}):\n${trace}`);
  parts.push(`\nWM diff (${older?.round ?? '?'} -> ${newer?.round ?? '?'}):\n${wmDiff}`);

  return ok(parts.join('\n'));
};

// ---------------------------------------------------------------------------
// compact_history
// ---------------------------------------------------------------------------

export const handleCompactHistory: OpHandler = async (_params, ctx) => {
  if (ctx.toolLoopState) {
    const { compressToolLoopHistory, analyzeHistoryBreakdown, formatHistoryBreakdown } = await import('../../historyCompressor');
    // Pass the same currentRound to both compress and analyze so the
    // protected-window calculation is identical (avoids misleading hints).
    const currentRound = ctx.toolLoopState.round;
    const count = compressToolLoopHistory(
      ctx.toolLoopState.conversationHistory,
      currentRound,
      ctx.toolLoopState.priorTurnBoundary,
    );
    if (count === 0) {
      const breakdown = analyzeHistoryBreakdown(
        ctx.toolLoopState.conversationHistory,
        ctx.toolLoopState.priorTurnBoundary ?? 0,
        currentRound,
      );
      const detail = formatHistoryBreakdown(breakdown);
      const hint = breakdown.compressibleCount === 0
        ? ' — nothing above threshold; all content is small or already compressed'
        : ` — ${breakdown.compressibleCount} items (${(breakdown.compressibleTokens / 1000).toFixed(1)}k) above threshold but in protected window (last ${PROTECTED_RECENT_ROUNDS} rounds)`;
      return ok(`compact_history: compressed ${count} tool results | history:${(breakdown.total / 1000).toFixed(0)}k (${detail})${hint}`);
    }
    return ok(`compact_history: compressed ${count} tool results`);
  }
  return ok('compact_history: no active tool loop state');
};
