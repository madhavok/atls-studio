/**
 * Context Formatter — builds working memory blocks for Layer 3 injection.
 *
 * Integrates with the Hash Pointer Protocol: chunks the model has already
 * seen are emitted as compact digest lines (h:ref + structure) instead of
 * full content, cutting per-chunk cost from ~2000+ tokens to ~20-30 tokens.
 *
 * Extracted from contextStore.ts to keep the store focused on state.
 */

import type { ContextChunk, BlackboardEntry, CognitiveRule, EngramAnnotation, Synapse, ManifestEntry, TaskPlan, StagedSnippet, TransitionBridge, MemoryEvent, ReconcileStats, MemoryTelemetrySummary } from '../stores/contextStore';
import { STAGED_OMITTED_POINTER_TOKENS } from '../stores/contextStore';
import type { FileView } from './fileViewStore';
import { formatChunkTag } from '../utils/contextHash';
import { collectFileViewChunkHashes, renderAllFileViewBlocks } from './fileViewRender';
import {
  getRef,
  shouldMaterialize,
  formatRefLine,
  formatArchivedRefLine,
  getArchivedRefs,
  materialize,
  getTurn,
  getTurnDelta,
} from './hashProtocol';
import { setPinned } from './hashProtocolState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatterInput {
  chunks: Map<string, ContextChunk>;
  blackboardEntries: Map<string, BlackboardEntry>;
  cognitiveRules?: Map<string, CognitiveRule>;
  droppedManifest: Map<string, ManifestEntry>;
  stagedSnippets?: Map<string, StagedSnippet>;
  taskPlan: TaskPlan | null;
  maxTokens: number;
  freedTokens: number;
  usedTokens: number;
  pinnedCount: number;
  bbTokens: number;
  cacheHitRate?: number;
  transitionBridge?: TransitionBridge | null;
  batchMetrics?: { toolCalls: number; manageOps: number };
  historyTokens?: number;
  historyBreakdown?: string | null;
  memoryEvents?: MemoryEvent[];
  reconcileStats?: ReconcileStats | null;
  memoryTelemetry?: MemoryTelemetrySummary | null;
  safetyCompaction?: {
    count: number;
    freedTokens: number;
    usageBefore: number;
    candidates: Array<{ shortHash: string; tokens: number; source?: string; age: string }>;
  } | null;
  /** FileView blocks for the file-content surface. Empty map renders nothing. */
  fileViews?: Map<string, FileView>;
  /** Current round number — drives ephemeral [edited this round] markers. */
  currentRound?: number;
}

// ---------------------------------------------------------------------------
// Working Memory (Layer 3)
// ---------------------------------------------------------------------------

const FILE_TYPES: ReadonlySet<string> = new Set([
  'file', 'smart', 'raw', 'tree', 'search', 'symbol', 'deps', 'issues',
]);

/**
 * ContextChunk.pinned is authoritative. HPP ChunkRef.pinned must match so
 * advanceTurn does not dematerialize chunks the model pinned before a ref
 * existed (session.pin was a no-op until first materialize).
 */
function syncHppPinsWithStore(chunks: ContextChunk[]): void {
  for (const chunk of chunks) {
    const digest = chunk.editDigest || chunk.digest || '';
    const totalLines = Math.max(1, chunk.content.split('\n').length);
    if (chunk.pinned) {
      let ref = getRef(chunk.hash);
      if (!ref || ref.visibility === 'referenced') {
        materialize(chunk.hash, chunk.type, chunk.source, chunk.tokens, totalLines, digest, chunk.shortHash);
        ref = getRef(chunk.hash);
      }
      setPinned(chunk.hash, true, chunk.pinnedShape ?? ref?.pinnedShape);
    } else {
      const ref = getRef(chunk.hash);
      if (ref?.pinned) {
        setPinned(chunk.hash, false);
      }
    }
  }
}

function formatEngramMeta(chunk: ContextChunk): string[] {
  const meta: string[] = [];
  if (chunk.annotations?.length) {
    for (const ann of chunk.annotations) {
      meta.push(`  [note] ${ann.content}`);
    }
  }
  if (chunk.synapses?.length) {
    for (const syn of chunk.synapses) {
      meta.push(`  → h:${syn.targetHash.slice(0, 6)} (${syn.relation})`);
    }
  }
  return meta;
}

/**
 * Mirrors `computeActiveEngramSources` in `contextStore.ts`: returns staged
 * source paths that are also covered by an active (materialized, non-compacted)
 * engram. Kept here (not imported from the store) to avoid a circular dep.
 */
function computeActiveEngramStagedSources(
  chunks: Map<string, ContextChunk>,
  stagedSnippets: Map<string, StagedSnippet>,
): Set<string> {
  const stagedSources = new Set<string>();
  for (const [, snippet] of stagedSnippets) {
    if (snippet.source) stagedSources.add(snippet.source.replace(/\\/g, '/').toLowerCase());
  }
  const activeEngramSources = new Set<string>();
  if (stagedSources.size === 0) return activeEngramSources;
  for (const [, chunk] of chunks) {
    if (chunk.compacted || !chunk.source) continue;
    const chunkSourceNorm = chunk.source.replace(/\\/g, '/').toLowerCase();
    if (!stagedSources.has(chunkSourceNorm)) continue;
    const ref = getRef(chunk.hash);
    if (!ref || shouldMaterialize(ref)) {
      activeEngramSources.add(chunk.source);
    }
  }
  return activeEngramSources;
}

export function formatSuspectHint(
  _suspectSince?: number,
  _freshness?: string,
  _freshnessCause?: string,
  _origin?: string,
): string {
  // Freshness state is now runtime-internal: pinned diverged views
  // auto-refetch (surfacing `[edited L..]` next round) and unpinned
  // diverged views drop silently. The `[STALE: re-read before edit]`
  // label previously emitted here added noise without changing behavior.
  return '';
}


/**
 * Build the working memory block the model sees each turn.
 *
 * Materialized chunks (first time seen) → full content.
 * Referenced chunks (seen in prior turn) → compact h:ref digest line.
 */
export function formatWorkingMemory(input: FormatterInput): string {
  const {
    chunks, blackboardEntries, cognitiveRules, droppedManifest, stagedSnippets, taskPlan,
    maxTokens, freedTokens, usedTokens, pinnedCount, bbTokens, cacheHitRate,
    historyTokens, historyBreakdown, safetyCompaction, memoryEvents, reconcileStats,
    memoryTelemetry,
  } = input;

  if (chunks.size === 0 && blackboardEntries.size === 0 && !taskPlan && droppedManifest.size === 0) {
    return '';
  }

  const lines: string[] = [];

  const currentTurn = getTurn();
  // Emitted staged tokens: entries whose body is omitted because an active
  // engram covers the source pay only a small pointer cost. Matches
  // `getStagedBlock` so CTX / MEMORY TELEMETRY totals line up with the prompt.
  const activeEngramStagedSources = stagedSnippets && stagedSnippets.size > 0
    ? computeActiveEngramStagedSources(chunks, stagedSnippets)
    : null;
  let stagedTokens = 0;
  if (stagedSnippets) {
    stagedSnippets.forEach(s => {
      stagedTokens += (activeEngramStagedSources && s.source != null && activeEngramStagedSources.has(s.source))
        ? STAGED_OMITTED_POINTER_TOKENS
        : s.tokens;
    });
  }
  lines.push(`<!-- WM:turn:${currentTurn} -->`);
  lines.push('## WORKING MEMORY');

  const delta = getTurnDelta();
  const deltaParts: string[] = [];
  if (delta.dematerialized > 0) deltaParts.push(`${delta.dematerialized} dematerialized`);
  if (delta.newMaterialized > 0) deltaParts.push(`${delta.newMaterialized} new`);
  if (safetyCompaction) deltaParts.push(`SAFETY: ${safetyCompaction.count} auto-compacted, ${(safetyCompaction.freedTokens / 1000).toFixed(1)}k freed`);
  if (deltaParts.length > 0) {
    lines.push(`Δ: ${deltaParts.join(' | ')}`);
  }
  lines.push('');

  // `## SAFETY RAIL WARNING` and `## MEMORY TELEMETRY` blocks deleted. The
  // auto-compaction described by SAFETY RAIL is an action the runtime
  // already performed; narrating it was runtime self-description. The
  // MEMORY TELEMETRY block (reconcile stats, retention counts, memory
  // events) is dev-tool data — none of it carried a work-level action for
  // the model. Both surfaces live in the AtlsInternals panel for debugging.
  // Reference the unused inputs so the signature stays stable for callers.
  void safetyCompaction;
  void memoryEvents;
  void reconcileStats;
  void memoryTelemetry;
  void cognitiveRules;

  // Pin inventory is now in ## HASH MANIFEST (dynamic context block)

  // BB summary — full content is in the dynamic context block.
  if (blackboardEntries.size > 0) {
    let activeTk = 0, activeCount = 0, supersededCount = 0;
    blackboardEntries.forEach(e => {
      if (e.state === 'active') { activeTk += e.tokens; activeCount++; }
      else supersededCount++;
    });
    const supersededSuffix = supersededCount > 0 ? `, ${supersededCount} superseded` : '';
    lines.push(`BB: ${activeCount} active entries, ${(activeTk / 1000).toFixed(1)}k tk${supersededSuffix} (in dynamic block — use session.bb.read/write to access)`);
    lines.push('');
  }

  // Cognitive rules — self-imposed behavioral constraints
  if (cognitiveRules && cognitiveRules.size > 0) {
    lines.push('## COGNITIVE RULES');
    cognitiveRules.forEach((rule, key) => {
      lines.push(`- ${key}: ${rule.content}`);
    });
    lines.push('');
  }

  // Transition bridge — auto-surfaces recently archived context after subtask advance
  const { transitionBridge } = input;
  if (transitionBridge && transitionBridge.turnsRemaining > 0) {
    lines.push(`## TRANSITION CONTEXT (subtask "${transitionBridge.completedSubtaskId}" just completed, ${transitionBridge.turnsRemaining} turns remaining)`);
    if (transitionBridge.summary) {
      lines.push(`Summary: ${transitionBridge.summary}`);
    }
    if (transitionBridge.archivedRefs.length > 0) {
      lines.push('Archived (recall by hash):');
      for (const ref of transitionBridge.archivedRefs) {
        lines.push(`  h:${ref.shortHash} ${ref.tokens}tk ${ref.source || ''}`);
      }
    }
    if (transitionBridge.restoredRefs && transitionBridge.restoredRefs.length > 0 && transitionBridge.activatedSubtaskId) {
      lines.push(`Pre-bound context restored for "${transitionBridge.activatedSubtaskId}":`);
      for (const ref of transitionBridge.restoredRefs) {
        lines.push(`  h:${ref.shortHash} ${ref.tokens}tk ${ref.source || ''} [from ${ref.from}]`);
      }
    }
    lines.push('');
  }

  // Staged snippets: full bodies are injected by assembleProviderMessages via
  // getStagedBlock(). Only emit a summary line here so the model sees total cost
  // without duplicating the staged content in the prompt.
  if (stagedSnippets && stagedSnippets.size > 0) {
    lines.push(`Staged: ${stagedSnippets.size} snippets, ${(stagedTokens / 1000).toFixed(1)}k tk (bodies in ## STAGED block above)`);
    lines.push('');
  }

  // Chat context summary — compact overview instead of per-turn listing
  const chatChunks = Array.from(chunks.values())
    .filter(c => c.type === 'msg:user' || c.type === 'msg:asst')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  if (chatChunks.length > 0) {
    // Use historyTokens (actual compressed size) if available; fall back to chunk sum
    const actualHistoryTokens = input.historyTokens;
    let chatTokens = 0;
    for (const c of chatChunks) chatTokens += c.tokens;
    const displayTokens = actualHistoryTokens != null && actualHistoryTokens > 0
      ? actualHistoryTokens
      : chatTokens;
    const displayK = (displayTokens / 1000).toFixed(1);

    // Count by type
    let userCount = 0, asstCount = 0, rollingCount = 0, compactedCount = 0;
    for (const c of chatChunks) {
      if (c.type === 'msg:user') userCount++;
      else asstCount++;
      if (c.content.startsWith('[Rolling Summary]') || c.content.startsWith('[-> h:')) rollingCount++;
      if (c.compacted) compactedCount++;
    }

    lines.push(`## CHAT CONTEXT (${chatChunks.length} turns, ${displayK}k tk actual | user:${userCount} asst:${asstCount} rolling:${rollingCount} compacted:${compactedCount})`);

    // Show only the most recent 6 entries to save prompt tokens
    const recentCount = 6;
    const recent = chatChunks.slice(-recentCount);
    if (chatChunks.length > recentCount) {
      lines.push(`  ... ${chatChunks.length - recentCount} older turns (use h:refs to recall)`);
    }
    for (const c of recent) {
      const preview = c.content.slice(0, 60).replace(/\n/g, ' ');
      if (c.compacted) {
        const digest = c.digest || c.summary || 'compacted';
        lines.push(`[C] h:${c.shortHash} ${c.type} ${c.tokens}tk (${digest})`);
      } else {
        lines.push(`h:${c.shortHash} ${c.type} ${c.tokens}tk "${preview}${c.content.length > 60 ? '...' : ''}"`);
      }
    }
    lines.push('');
  }

  // FileView blocks — the new model-visible surface for file content.
  // Emitted before ACTIVE ENGRAMS so the model reads file-ordered views
  // before the flat chunk listing. File-backed chunks whose hash is covered
  // by any view are filtered out of ACTIVE ENGRAMS to avoid double-rendering.
  const fileViewBlocks = input.fileViews
    ? renderAllFileViewBlocks(input.fileViews.values(), {
        currentRound: input.currentRound ?? 0,
      })
    : [];
  const fileViewCoveredChunkHashes = input.fileViews
    ? collectFileViewChunkHashes(input.fileViews.values())
    : new Set<string>();

  if (fileViewBlocks.length > 0) {
    lines.push(`## FILE VIEWS (${fileViewBlocks.length} ${fileViewBlocks.length === 1 ? 'file' : 'files'})`);
    for (const block of fileViewBlocks) {
      lines.push(block);
    }
    lines.push('');
  }

  // Chunks — sorted: pinned first, file types before artifacts, then LRU.
  // File-backed chunks covered by a FileView are filtered to avoid duplicate
  // bytes — the view already renders that content.
  const sortedChunks = Array.from(chunks.values())
    .filter(c => c.type !== 'msg:user' && c.type !== 'msg:asst')
    .filter(c => !fileViewCoveredChunkHashes.has(c.hash))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const aFile = FILE_TYPES.has(a.type);
      const bFile = FILE_TYPES.has(b.type);
      if (aFile !== bFile) return aFile ? -1 : 1;
      return b.lastAccessed - a.lastAccessed;
    });

  if (sortedChunks.length > 0) {
    const activeSubtaskId = taskPlan?.activeSubtaskId;
    const subtaskLabel = activeSubtaskId
      ? ` (subtask: ${taskPlan?.subtasks.find(s => s.id === activeSubtaskId)?.title || activeSubtaskId})`
      : '';

    syncHppPinsWithStore(sortedChunks);

    // Materialized vs not: dematerialized (referenced, still warm) vs archived (cold)
    const materialized: ContextChunk[] = [];
    const dematerialized: ContextChunk[] = [];
    const archivedChunks: ContextChunk[] = [];

    for (const chunk of sortedChunks) {
      const ref = getRef(chunk.hash);
      if (ref && !shouldMaterialize(ref)) {
        if (ref.visibility === 'archived') archivedChunks.push(chunk);
        else dematerialized.push(chunk);
      } else {
        materialized.push(chunk);
      }
    }

    // Dematerialized and archived listings are now in ## HASH MANIFEST

    // Materialized section — full content (first read this turn)
    if (materialized.length > 0) {
      const unpinnedCount = materialized.filter(c => !c.pinned).length;
      const expiryHint = unpinnedCount > 0 ? ` — ${unpinnedCount} unpinned expire next round` : '';
      lines.push(`## ACTIVE ENGRAMS (${materialized.length} materialized${expiryHint})${subtaskLabel}`);
      for (const chunk of materialized) {
        const ref = getRef(chunk.hash);
        const effectivePinShape = ref?.pinnedShape ?? chunk.pinnedShape;
        const shapedPin = chunk.pinned && !!effectivePinShape;
        const compactIndicator = chunk.compacted ? '[C] ' : '';
        const summaryHint = chunk.summary ? ` — ${chunk.summary}` : '';
        const staleHint = formatSuspectHint(chunk.suspectSince, chunk.freshness, chunk.freshnessCause, chunk.origin);
        const tag = `${compactIndicator}<<h:${chunk.shortHash} tk:${chunk.tokens} ${chunk.type}>> ${chunk.source || ''}${summaryHint}${staleHint}`;
        lines.push(tag.trim());
        const metaLines = formatEngramMeta(chunk);
        if (metaLines.length > 0) lines.push(...metaLines);
        if (chunk.compacted) {
          const isToolType = chunk.type === 'call' || chunk.type === 'result' || chunk.type === 'search';
          const digest = isToolType
            ? (chunk.summary || `[compacted — use h:${chunk.shortHash} in tool params]`)
            : (chunk.editDigest || chunk.digest || chunk.summary || `[compacted — use h:${chunk.shortHash} in tool params]`);
          if (digest !== chunk.summary || !summaryHint) {
            lines.push(digest);
          }
        } else if (shapedPin) {
          const shapedContent = chunk.editDigest || chunk.digest || chunk.summary || chunk.content.slice(0, 500);
          lines.push(shapedContent);
          const totalLines = chunk.content.split('\n').length;
          materialize(
            chunk.hash, chunk.type, chunk.source,
            chunk.tokens, totalLines,
            chunk.editDigest || chunk.digest || '',
            chunk.shortHash,
          );
        } else {
          if (chunk.type === 'call' && chunk.summary) {
            lines.push(chunk.summary);
          } else {
            lines.push(chunk.content);
          }
          const totalLines = chunk.content.split('\n').length;
          materialize(
            chunk.hash, chunk.type, chunk.source,
            chunk.tokens, totalLines,
            chunk.editDigest || chunk.digest || '',
            chunk.shortHash,
          );
        }
        lines.push('');
      }
    }
  }

  // Archived engrams listing is now in ## HASH MANIFEST

  if (droppedManifest.size > 0) {
    const totalTokens = Array.from(droppedManifest.values()).reduce((sum, e) => sum + e.tokens, 0);
    lines.push(`Dropped: ${droppedManifest.size} engrams (${(totalTokens / 1000).toFixed(1)}k freed) — re-read to access`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tagged Context (legacy / debug)
// ---------------------------------------------------------------------------

export function formatTaggedContext(chunks: Map<string, ContextChunk>): string {
  const lines: string[] = [];
  const sorted = Array.from(chunks.values())
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const chunk of sorted) {
    const tag = formatChunkTag(chunk.shortHash, chunk.tokens, chunk.type, chunk.source);
    lines.push(`${tag}\n${chunk.content}`);
  }
  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Stats & Task Lines
// ---------------------------------------------------------------------------

/**
 * CTX banner — diet rendering. Keeps only the fields that inform work-level
 * decisions: pressure %, pinned count, BB token use. Runtime telemetry
 * (chunk count, cache hit rate, staged tokens, batch ops/call, engram/dormant
 * split, round count, freed tokens, history breakdown) moved to the
 * AtlsInternals dev panel. Pressure nudges collapsed to one at-ceiling line;
 * the runtime auto-manages everything below the ceiling via ASSESS.
 *
 * Signature kept stable for callers that still pass the full telemetry bag;
 * unused params are accepted and ignored at the banner layer.
 */
export function formatStatsLine(
  usedTokens: number,
  maxTokens: number,
  _chunkCount: number,
  pinnedCount: number,
  bbTokens: number,
  _freedTokens: number,
  _cacheHitRate?: number,
  _batchMetrics?: { toolCalls: number; manageOps: number },
  _stagedTokens?: number,
  _historyTokens?: number,
  _historyBreakdown?: string | null,
  _chunks?: Map<string, import('../stores/contextStore').ContextChunk>,
  _roundCount?: number,
): string {
  const pct = ((usedTokens / maxTokens) * 100).toFixed(0);

  let line = `<<CTX ${pct}%`;
  if (pinnedCount > 0) line += ` | pinned:${pinnedCount}`;
  if (bbTokens > 0) line += ` | bb:${(bbTokens / 1000).toFixed(1)}k`;
  line += '>>';

  // Single at-ceiling nudge only. Runtime auto-manages pressure below the
  // hard ceiling via ASSESS + auto-compact. Tiered nudges (50% / 70% /
  // HYGIENE / LOW BATCH RATIO / staged-heavy / dormant-heavy) were
  // runtime-internal scheduling leaked as model-facing copy.
  const percentage = (usedTokens / maxTokens) * 100;
  if (percentage >= HARD_CEILING_PCT) {
    line += ' — at ceiling: finish current target and task_complete or hand off';
  }

  return line;
}

/** Pressure percent at which the banner surfaces its single at-ceiling nudge. */
const HARD_CEILING_PCT = 90;

export function formatTaskLine(plan: TaskPlan | null): string {
  if (!plan) return '';

  if (plan.subtasks.length === 0) {
    return `<<TASK: ${plan.goal}>>`;
  }

  const done = plan.subtasks.filter(s => s.status === 'done').length;
  const total = plan.subtasks.length;

  const progressParts = plan.subtasks.map(s => {
    if (s.status === 'done') return `${s.title}(done)`;
    if (s.status === 'active') return `${s.title}(active)`;
    if (s.status === 'blocked') return `${s.title}(blocked)`;
    return s.title;
  });

  return `<<TASK: ${plan.goal}>>\n<<PLAN: [${done}/${total} done] ${progressParts.join(' -> ')}>>`;
}
