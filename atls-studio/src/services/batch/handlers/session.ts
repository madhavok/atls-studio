/**
 * Session operation handlers — task lifecycle, pin, stage, compact, drop, recall.
 */

import type { ContextStoreApi, OpHandler, HandlerContext, StepOutput } from '../types';
import { SHORT_HASH_LEN, sliceContentByLines } from '../../../utils/contextHash';
import { PROTECTED_RECENT_ROUNDS } from '../../promptMemory';
import { parseHashRef } from '../../../utils/hashRefParsers';
import { invoke } from '@tauri-apps/api/core';
import { normalizeHashRefsToStrings } from '../paramNorm';

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
  if (!goal) return err('task_plan: ERROR missing goal');

  const rawSubtasks = params.subtasks as Array<string | { id: string; title: string }> | undefined;
  type SubStatus = 'pending' | 'active' | 'done' | 'blocked';
  const subtasks = (rawSubtasks || []).map((s, i) => {
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
  if (!plan) return err('task_advance: ERROR no active plan — call session.plan first');

  if (!subtaskId) {
    const { subtasks } = plan;
    const currentIdx = subtasks.findIndex(s => s.status === 'active');
    if (currentIdx < 0) return err('task_advance: ERROR no active subtask in plan — call session.status to inspect');
    const next = subtasks[currentIdx + 1];
    if (!next) return err('task_advance: plan complete — use task_complete for final summary');
    subtaskId = next.id;
  }

  const target = plan.subtasks.find(s => s.id === subtaskId);
  if (!target) return err(`task_advance: ERROR subtask "${subtaskId}" not found in plan`);
  if (target?.status === 'done') return err(`task_advance: ERROR subtask "${subtaskId}" already done`);

  const summary = typeof params.summary === 'string' ? (params.summary as string).trim() : '';
  if (summary.length < 50) {
    return err('task_advance: ERROR summary required (min 50 chars) - describe what was accomplished and key findings');
  }

  // Advance gate: warn when advancing without BB findings in this phase
  const bm = ctx.store().getBatchMetrics();
  const hadFindings = bm.hadSubstantiveBbWrite || bm.hadBbWrite;
  let advanceWarning = '';
  if (!hadFindings) {
    advanceWarning = 'WARNING: Advancing without BB findings or edits in this phase. Knowledge will be lost on dehydration. Write bb:finding:{target} before advancing, or ensure summary: captures all findings.\n';
  }

  const { unloaded, freedTokens } = ctx.store().advanceSubtask(subtaskId, summary);
  return ok(
    `${advanceWarning}task_advance: ${subtaskId}(active) | ${unloaded} chunks archived (${(freedTokens / 1000).toFixed(1)}k tokens freed, recallable by hash)`,
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
  const rawHashes = normalizeHashRefsToStrings(params.hashes);
  if (!rawHashes.length) return err('unload: ERROR missing hashes param');

  const { expanded, notes } = ctx.expandSetRefsInHashes(rawHashes);
  const confirmWildcard = params.confirmWildcard === true;
  const { freed, count, pinnedKept } = ctx.store().unloadChunks(expanded, { confirmWildcard });
  let line = `unload: ${count} chunks freed (${(freed / 1000).toFixed(1)}k tokens)`;
  if (pinnedKept > 0) line += ` | ${pinnedKept} pinned kept`;
  if (notes.length > 0) line += ` | ${notes.join('; ')}`;
  return ok(line, [], -freed);
};

// ---------------------------------------------------------------------------
// compact
// ---------------------------------------------------------------------------

export const handleCompact: OpHandler = async (params, ctx) => {
  const rawHashes = normalizeHashRefsToStrings(params.hashes);
  if (!rawHashes.length) return err('compact: ERROR missing hashes param');

  const { expanded, notes } = ctx.expandSetRefsInHashes(rawHashes);
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
        const resolved = await invoke<{ content: string; source?: string | null }>('resolve_hash_ref', {
          rawRef,
          sessionId: ctx.sessionId ?? null,
        });
        if (resolved?.content) {
          const stageKey = rawRef;
          const lineSpec = lineSpecFromHashRef(rawRef);
          const result = ctx.store().stageSnippet(
            stageKey,
            resolved.content,
            resolved.source || rawRef,
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
      : `stage_batch: ${staged.length} refs staged (${totalTokens}tk). Total: ${(total / 1000).toFixed(1)}k. Visible next round.`;
    return ok(line, [], totalTokens);
  }

  if (rawContent) {
    const key = label || `content-${Date.now()}`;
    const result = ctx.store().stageSnippet(key, rawContent, label || 'inline', undefined, undefined, undefined, 'snapshot');
    if (!result.ok) return err(`stage: ${result.error}`);
    const total = ctx.store().getStagedTokenCount();
    return ok(`staged [${key}] (${result.tokens}tk). Total staged: ${(total / 1000).toFixed(1)}k. Visible in staged next round.`, [], result.tokens);
  }

  if (!rawHash || !lines) return err('stage: requires (hash + lines) or (content + label)');
  const cleanHash = rawHash.startsWith('h:') ? rawHash.slice(2) : rawHash;
  const stageKey = label || `${rawHash.startsWith('h:') ? rawHash : `h:${cleanHash}`}:${lines}:ctx(${contextLines})`;

  const ctxState = ctx.store();
  let sourcePath: string | undefined;
  let chunkIsRaw = false;
  let inMemoryContent: string | undefined;

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
  return ok(`staged ${stageKey} lines:${lines} ctx:${contextLines} (${stageResult.tokens}tk, ${sourcePath || 'unknown'}). Total: ${(stageTotal / 1000).toFixed(1)}k. Visible next round.`, [], stageResult.tokens);
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
  const rawHashes = normalizeHashRefsToStrings(params.hashes);
  if (!rawHashes.length) return err('drop: ERROR missing hashes param');

  const { expanded, notes } = ctx.expandSetRefsInHashes(rawHashes);
  const droppedDetail = collectChunkDetails(expanded, ctx.store);
  const { dropped, freedTokens } = ctx.store().dropChunks(expanded, { confirmWildcard: true });
  let line = `drop: ${dropped} chunks permanently dropped (${(freedTokens / 1000).toFixed(1)}k freed, manifest entries kept)`;
  if (notes.length > 0) line += ` | ${notes.join('; ')}`;
  if (droppedDetail) line += ` | dropped: [${droppedDetail}]`;
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
  const rawHashes = normalizeHashRefsToStrings(params.hashes ?? params.refs);
  if (!rawHashes.length) {
    return err('pin: ERROR missing hashes param (expected string[], h:… strings, or {ref}/{hash}/{h} objects)');
  }

  const { expanded, notes } = ctx.expandSetRefsInHashes(rawHashes);

  // Materialize any file_refs from prior steps so refs resolve in the store (same batch as read.lines).
  ctx.forEachStepOutput?.((_, out) => {
    materializeFileRefsContentIfNeeded(out, ctx.store());
  });

  // Resolve step IDs to their output chunk hashes (pin-by-step-ID support)
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

  const pinShape = (params.shape as string) || undefined;
  const { count, alreadyPinned } = ctx.store().pinChunks(resolved, pinShape);
  const shapeTag = pinShape ? ` (shape:${pinShape})` : '';
  let line = count > 0
    ? `pin: ${count} chunk${count > 1 ? 's' : ''} pinned${shapeTag}`
    : alreadyPinned > 0
      ? `pin: ${alreadyPinned} already pinned${shapeTag}`
      : `pin: no matching chunks`;
  if (count === 0 && alreadyPinned === 0) {
    const suspicious = resolved.filter((t) => !isPlausibleHashBaseSegment(baseHashFromRefToken(t)));
    if (suspicious.length > 0) {
      const sample = suspicious[0]!;
      const stepGuess = baseHashFromRefToken(sample);
      line += ` — if "${sample}" was meant to name a batch step, use hashes from that step's output, bare step id "${stepGuess}", or in:{hashes:{from_step:"${stepGuess}",path:"refs"}}; the h: prefix is only for real content hashes (6+ hex), not step ids`;
    }
  }
  if (notes.length > 0) line += ` | ${notes.join('; ')}`;
  return ok(line);
};

export const handleUnpin: OpHandler = async (params, ctx) => {
  const rawHashes = normalizeHashRefsToStrings(params.hashes);
  if (!rawHashes.length) return err('unpin: ERROR missing hashes param');

  const { expanded, notes } = ctx.expandSetRefsInHashes(rawHashes);
  const count = ctx.store().unpinChunks(expanded);
  let line = count > 0 ? `unpin: ${count} chunk${count > 1 ? 's' : ''} unpinned` : `unpin: no matching chunks`;
  if (notes.length > 0) line += ` | ${notes.join('; ')}`;
  return ok(line);
};

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

export const handleRecall: OpHandler = async (params, ctx) => {
  const rawHashes = normalizeHashRefsToStrings(params.hashes);
  if (!rawHashes.length) return err('recall: ERROR missing hashes param');

  const { expanded, notes } = ctx.expandSetRefsInHashes(rawHashes);
  const lines: string[] = [];
  if (notes.length > 0) lines.push(`recall: ${notes.join('; ')}`);

  for (const h of expanded) {
    const content = ctx.store().getChunkContent(h);
    if (!content) {
      lines.push(`recall:${h}: NOT_FOUND (evicted or unknown)`);
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
    lines.push(`recall:${h}: ${recallContent}`);
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
  let header = `Context: ${usedK}k/${maxK}k tokens | ${stats.chunkCount} chunks`;
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
        .map((c: { shortHash: string; tokens: number; source?: string }) =>
          `h:${c.shortHash} ${c.tokens}tk ${c.source?.split(/[/\\]/).pop() ?? '?'}`)
        .join(', ')}${chunkCount > 5 ? ` ... +${chunkCount - 5} more` : ''}`
    : '';
  return ok(
    `debug: ${stats.usedTokens / 1000}k tk | ${chunkCount} chunks | ${archiveCount} archived | staged:${stagedK}k${planLine}${chunkSummary}`,
  );
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
