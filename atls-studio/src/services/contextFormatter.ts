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
import { STAGE_SOFT_CEILING } from '../stores/contextStore';
import { HYGIENE_CHECK_INTERVAL_ROUNDS } from './promptMemory';
import { formatChunkTag } from '../utils/contextHash';
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

export function formatSuspectHint(
  suspectSince?: number,
  freshness?: string,
  _freshnessCause?: string,
  _origin?: string,
): string {
  if (suspectSince != null || freshness === 'suspect' || freshness === 'changed') {
    return ' [STALE: re-read before edit]';
  }
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
  let stagedTokens = 0;
  if (stagedSnippets) stagedSnippets.forEach(s => stagedTokens += s.tokens);
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

  if (safetyCompaction) {
    lines.push('## SAFETY RAIL WARNING');
    lines.push(`Auto-compacted ${safetyCompaction.count} unpinned chunks, freed ${(safetyCompaction.freedTokens / 1000).toFixed(1)}k (was at ${safetyCompaction.usageBefore.toFixed(0)}%).`);
    if (safetyCompaction.candidates.length > 0) {
      lines.push('Candidates for drop (oldest unpinned):');
      for (const c of safetyCompaction.candidates.slice(0, 3)) {
        lines.push(`  h:${c.shortHash} ${(c.tokens / 1000).toFixed(1)}k ${c.source || ''} (age: ${c.age})`);
      }
    }
    lines.push('Action: drop completed work, unpin finished files, compact_history if history heavy.');
    lines.push('');
  }

  const latestEvent = memoryEvents && memoryEvents.length > 0 ? memoryEvents[memoryEvents.length - 1] : null;
  const ruleTokens = cognitiveRules ? Array.from(cognitiveRules.values()).reduce((sum, rule) => sum + rule.tokens, 0) : 0;
  const hasRetention = memoryTelemetry && (memoryTelemetry.readsReused > 0 || memoryTelemetry.resultsCollapsed > 0 || memoryTelemetry.outcomeTransitions > 0);
  if (reconcileStats || latestEvent || ruleTokens > 0 || stagedTokens > 0 || hasRetention) {
    lines.push('## MEMORY TELEMETRY');
    const telemetryParts: string[] = [];
    if (historyTokens != null && historyTokens > 0) telemetryParts.push(`history:${(historyTokens / 1000).toFixed(1)}k`);
    if (stagedTokens > 0) telemetryParts.push(`staged:${(stagedTokens / 1000).toFixed(1)}k`);
    if (ruleTokens > 0) telemetryParts.push(`rules:${(ruleTokens / 1000).toFixed(1)}k`);
    if (reconcileStats) telemetryParts.push(`reconcile:${reconcileStats.updated} updated/${reconcileStats.invalidated} invalidated/${reconcileStats.preserved} preserved`);
    if (memoryTelemetry && memoryTelemetry.eventCount > 0) {
      telemetryParts.push(`events:${memoryTelemetry.eventCount}`);
    }
    if (memoryTelemetry) {
      const retParts: string[] = [];
      if (memoryTelemetry.readsReused > 0) retParts.push(`reused:${memoryTelemetry.readsReused}`);
      if (memoryTelemetry.resultsCollapsed > 0) retParts.push(`collapsed:${memoryTelemetry.resultsCollapsed}`);
      if (memoryTelemetry.outcomeTransitions > 0) retParts.push(`transitions:${memoryTelemetry.outcomeTransitions}`);
      if (retParts.length > 0) telemetryParts.push(`retention:${retParts.join(',')}`);
    }
    if (telemetryParts.length > 0) lines.push(telemetryParts.join(' | '));
    if (latestEvent) {
      const eventParts = [`last:${latestEvent.action}`, latestEvent.reason];
      if (latestEvent.source) eventParts.push(latestEvent.source);
      if (latestEvent.freedTokens != null && latestEvent.freedTokens > 0) eventParts.push(`freed:${(latestEvent.freedTokens / 1000).toFixed(1)}k`);
      lines.push(eventParts.join(' | '));
    }
    lines.push('');
  }

  // Pinned-context inventory — scannable one-liner so the model knows what it
  // already has before deciding to read or edit.
  const pinnedEntries: string[] = [];
  for (const chunk of chunks.values()) {
    if (!chunk.pinned) continue;
    const ref = getRef(chunk.hash);
    const basename = chunk.source?.split('/').pop() ?? '?';
    const shape = ref?.pinnedShape ? `:${ref.pinnedShape}` : '';
    pinnedEntries.push(`h:${chunk.shortHash} ${basename}${shape} (${chunk.tokens}tk)`);
  }
  if (pinnedEntries.length > 0) {
    lines.push(`Pinned: ${pinnedEntries.join(', ')}`);
    lines.push('');
  }

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
    let stagedTotal = 0;
    stagedSnippets.forEach(s => stagedTotal += s.tokens);
    lines.push(`Staged: ${stagedSnippets.size} snippets, ${(stagedTotal / 1000).toFixed(1)}k tk (bodies in ## STAGED block above)`);
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

  // Chunks — sorted: pinned first, file types before artifacts, then LRU
  const sortedChunks = Array.from(chunks.values())
    .filter(c => c.type !== 'msg:user' && c.type !== 'msg:asst')
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

    const MAX_SECTION_REFS = 10;
    if (dematerialized.length > 0) {
      lines.push(
        `## DEMATERIALIZED (${dematerialized.length} — last round(s); h:@dematerialized lists hashes)`,
      );
      const shown = dematerialized.slice(0, MAX_SECTION_REFS);
      for (const chunk of shown) {
        const ref = getRef(chunk.hash);
        if (ref) {
          lines.push(`  ${formatRefLine(ref)}`);
        } else {
          const src = chunk.source || chunk.type;
          lines.push(`  h:${chunk.shortHash} ${src} ${chunk.tokens}tk`);
        }
      }
      if (dematerialized.length > MAX_SECTION_REFS) {
        lines.push(`  +${dematerialized.length - MAX_SECTION_REFS} more`);
      }
      lines.push('');
    }

    if (archivedChunks.length > 0) {
      lines.push(`## DORMANT / ARCHIVED (${archivedChunks.length} — cold; use rec h:XXXX or h:@dormant)`);
      const shown = archivedChunks.slice(0, MAX_SECTION_REFS);
      for (const chunk of shown) {
        const ref = getRef(chunk.hash);
        if (ref) {
          lines.push(`  ${formatArchivedRefLine(ref)}`);
        } else {
          const src = chunk.source || chunk.type;
          lines.push(`  h:${chunk.shortHash} ${src} ${chunk.tokens}tk`);
        }
      }
      if (archivedChunks.length > MAX_SECTION_REFS) {
        lines.push(`  +${archivedChunks.length - MAX_SECTION_REFS} more`);
      }
      lines.push('');
    }

    // Materialized section — full content (first read this turn)
    if (materialized.length > 0) {
      const unpinnedCount = materialized.filter(c => !c.pinned).length;
      const expiryHint = unpinnedCount > 0 ? ` — ${unpinnedCount} unpinned expire next round` : '';
      lines.push(`## ACTIVE ENGRAMS (${materialized.length} materialized${expiryHint})${subtaskLabel}`);
      for (const chunk of materialized) {
        const ref = getRef(chunk.hash);
        const effectivePinShape = ref?.pinnedShape ?? chunk.pinnedShape;
        const shapedPin = chunk.pinned && !!effectivePinShape;
        const pinIndicator = chunk.pinned
          ? (shapedPin ? `[P:${effectivePinShape}] ` : '[P] ')
          : '';
        const compactIndicator = chunk.compacted ? '[C] ' : '';
        const summaryHint = chunk.summary ? ` — ${chunk.summary}` : '';
        const suspectHint = formatSuspectHint(chunk.suspectSince, chunk.freshness, chunk.freshnessCause, chunk.origin);
        const tag = `${compactIndicator}${pinIndicator}<<h:${chunk.shortHash} tk:${chunk.tokens} ${chunk.type}>> ${chunk.source || ''}${suspectHint}${summaryHint}`;
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

  // Archived engrams — visible to hash resolution but outside working memory token budget
  const archivedHppRefs = getArchivedRefs();
  if (archivedHppRefs.length > 0) {
    const totalArchivedTokens = archivedHppRefs.reduce((sum, r) => sum + r.tokens, 0);
    const shown = archivedHppRefs.slice(0, 10);
    lines.push(`## ARCHIVED ENGRAMS (${archivedHppRefs.length} total, ${(totalArchivedTokens / 1000).toFixed(1)}k tk — use recall or pin to restore)`);
    for (const ref of shown) {
      lines.push(`  ${formatArchivedRefLine(ref)}`);
    }
    if (archivedHppRefs.length > 10) {
      lines.push(`  +${archivedHppRefs.length - 10} more (use h:@all to list)`);
    }
    lines.push('');
  }

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

/** Mirror contextStore CHAT_TYPES — excluded from engram classification (BP3 is canonical). */
const CHAT_CHUNK_TYPES = new Set(['msg:user', 'msg:asst']);

/** Dormant engram stub budget (must match getPromptTokens in contextStore). */
const DORMANT_BASE_TOKENS = 15;
const DORMANT_FINDING_TOKENS = 20;

export function formatStatsLine(
  usedTokens: number,
  maxTokens: number,
  chunkCount: number,
  pinnedCount: number,
  bbTokens: number,
  freedTokens: number,
  cacheHitRate?: number,
  batchMetrics?: { toolCalls: number; manageOps: number },
  stagedTokens?: number,
  historyTokens?: number,
  historyBreakdown?: string | null,
  chunks?: Map<string, import('../stores/contextStore').ContextChunk>,
  roundCount?: number,
): string {
  const pct = ((usedTokens / maxTokens) * 100).toFixed(0);
  const usedK = (usedTokens / 1000).toFixed(0);
  const maxK = (maxTokens / 1000).toFixed(0);
  const freedK = (freedTokens / 1000).toFixed(1);

  let line = `<<CTX ${usedK}k/${maxK}k (${pct}%)`;
  if (roundCount != null && roundCount > 0) line += ` | round:${roundCount}`;
  line += ` | chunks:${chunkCount}`;
  if (pinnedCount > 0) line += ` | pinned:${pinnedCount}`;
  if (bbTokens > 0) line += ` | bb:${(bbTokens / 1000).toFixed(1)}k`;
  if (freedTokens > 1000) line += ` | freed:${freedK}k`;
  if (historyTokens != null && historyTokens > 0) {
    const hk = (historyTokens / 1000).toFixed(0);
    line += historyBreakdown ? ` | history:${hk}k (${historyBreakdown})` : ` | history:${hk}k`;
  }
  if (cacheHitRate != null && cacheHitRate > 0) line += ` | cache:${(cacheHitRate * 100).toFixed(0)}%`;
  if (stagedTokens != null && stagedTokens > 0) line += ` | staged:${(stagedTokens / 1000).toFixed(1)}k`;
  if (batchMetrics && batchMetrics.toolCalls > 0) {
    const ratio = batchMetrics.manageOps / batchMetrics.toolCalls;
    line += ` | batch:${ratio.toFixed(1)}ops/call`;
  }
  if (chunks && chunks.size > 0) {
    let activeCount = 0, activeTk = 0, dormantCount = 0, dormantTk = 0;
    for (const c of chunks.values()) {
      if (CHAT_CHUNK_TYPES.has(c.type)) continue;
      // HPP-aware: dormant = compacted OR dematerialized in HPP
      const isDormant = c.compacted || (() => {
        const ref = getRef(c.hash);
        return ref != null && !shouldMaterialize(ref);
      })();
      if (isDormant) {
        dormantCount++;
        const hasFinding = (c.annotations?.length ?? 0) > 0 || !!c.summary;
        dormantTk += DORMANT_BASE_TOKENS + (hasFinding ? DORMANT_FINDING_TOKENS : 0);
      } else {
        activeCount++;
        activeTk += c.tokens;
      }
    }
    line += ` | engrams:${activeCount}(${(activeTk / 1000).toFixed(1)}k) dormant:${dormantCount}(${(dormantTk / 1000).toFixed(1)}k)`;
  }
  line += '>>';

  const percentage = (usedTokens / maxTokens) * 100;
  if (percentage >= 70) {
    line += ' 70% — consider dropping completed work (session.drop) and compacting history (compact_history). Emergency eviction only at 90%+.';
  } else if (percentage >= 50) {
    line += ' consider compacting/dropping completed work — bb_write important findings before they age out';
  }

  // Batch compliance warning: flag single-op manage calls as wasteful
  if (batchMetrics && batchMetrics.toolCalls >= 3 && batchMetrics.manageOps / batchMetrics.toolCalls < 2) {
    line += ' — LOW BATCH RATIO: combine ops into fewer manage calls';
  }

  if (stagedTokens != null && stagedTokens > STAGE_SOFT_CEILING) {
    line += ' — staged heavy: unstage completed work';
  }

  // Turn-based hygiene nudge (skip if already showing 70%+ pressure warning)
  if (roundCount != null && roundCount > 0 && roundCount % HYGIENE_CHECK_INTERVAL_ROUNDS === 0 && percentage < 70) {
    line += ' — HYGIENE: budget check due — review BB, drop unused, unstage completed';
  }

  // Dormant token imbalance nudge (HPP-aware)
  if (chunks && chunks.size > 0) {
    let activeTkSum = 0, dormantRawTkSum = 0;
    for (const c of chunks.values()) {
      if (CHAT_CHUNK_TYPES.has(c.type)) continue;
      const isDormant = c.compacted || (() => {
        const ref = getRef(c.hash);
        return ref != null && !shouldMaterialize(ref);
      })();
      if (isDormant) dormantRawTkSum += c.tokens;
      else activeTkSum += c.tokens;
    }
    if (dormantRawTkSum > activeTkSum && dormantRawTkSum > 2000) {
      line += ' — dormant engrams heavy: drop or distill to BB';
    }
  }

  return line;
}

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
