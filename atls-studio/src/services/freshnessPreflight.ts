/**
 * Freshness preflight — classify refs and relocate line ranges for same-lineage drift.
 * Used before any mutation or ref-consuming read to ensure stale refs are handled correctly.
 *
 * Rule:
 * - fresh → proceed
 * - rebaseable (same_file_prior_edit, hash_forward) → relocate and proceed
 * - suspect (external_file_change, watcher_event, unknown) → hard-stop, require re-read
 */

import type { FreshnessCause } from './batch/types';
import { useContextStore } from '../stores/contextStore';
import {
  getFreshnessJournal,
  type RebaseConfidence,
  type RebaseEvidence,
  type RebaseStrategy,
  type RebindOutcome,
} from './freshnessJournal';
import { resolveSymbolToLines } from '../utils/symbolResolver';

export type RefClassification = 'fresh' | 'rebaseable' | 'suspect';
export interface PreflightDecision extends RebindOutcome {
  ref: string;
  source?: string;
}
export interface AutomationDecision {
  action: 'proceed' | 'proceed_with_note' | 'review_required' | 'block';
  reason: string;
}

const NORMALIZE_PATH = (p: string) => p.replace(/\\/g, '/').toLowerCase();

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** Parse "15-22" or "15-22,40-55" or "45-" into [(start, end?), ...]. 1-indexed inclusive. */
export function parseLineRanges(spec: string): Array<[number, number | undefined]> | null {
  const out: Array<[number, number | undefined]> = [];
  for (const part of spec.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const dash = t.indexOf('-');
    if (dash >= 0) {
      const startS = t.slice(0, dash).trim();
      const endS = t.slice(dash + 1).trim();
      const start = parseInt(startS, 10);
      if (!Number.isFinite(start)) return null;
      const end = endS ? parseInt(endS, 10) : undefined;
      if (endS && !Number.isFinite(end!)) return null;
      out.push([start, end]);
    } else {
      const n = parseInt(t, 10);
      if (!Number.isFinite(n)) return null;
      out.push([n, n]);
    }
  }
  return out.length > 0 ? out : null;
}

/** Extract lines from content (1-indexed inclusive). Returns null if range invalid. */
function extractLines(content: string, ranges: Array<[number, number | undefined]>): string | null {
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const parts: string[] = [];
  for (const [start, end] of ranges) {
    if (start < 1 || start > total) return null;
    const endLine = end !== undefined ? Math.min(end, total) : total;
    if (endLine < start) return null;
    for (let i = start - 1; i < endLine; i++) {
      parts.push(lines[i]!);
    }
  }
  return parts.join('\n');
}

function locateSnippetFingerprint(content: string, snippet: string): Array<[number, number]> | null {
  const target = snippet.trim();
  if (!target) return null;
  const lines = content.split(/\r?\n/);
  const targetLines = target.split(/\r?\n/).map((line) => line.trim());
  if (targetLines.length === 0) return null;
  let matchStart: number | null = null;
  let matchCount = 0;
  for (let i = 0; i <= lines.length - targetLines.length; i++) {
    const candidate = lines.slice(i, i + targetLines.length).map((line) => line.trim());
    if (candidate.join('\n') === targetLines.join('\n')) {
      matchStart = i + 1;
      matchCount++;
    }
  }
  if (matchCount !== 1 || matchStart == null) return null;
  return [[matchStart, matchStart + targetLines.length - 1]];
}

function parseSymbolShapeSpec(shapeSpec: string | undefined): { kind?: string; name: string } | null {
  if (typeof shapeSpec !== 'string') return null;
  const match = shapeSpec.trim().match(/^([a-z_]+)\(([^)]+)\)$/i);
  if (!match) return null;
  const [, kind, name] = match;
  if (!name?.trim()) return null;
  const normalizedKind = kind.toLowerCase();
  const kindAliases: Record<string, string | undefined> = {
    sym: undefined,
    function: 'fn',
    method: 'fn',
    interface: 'trait',
  };
  return { kind: kindAliases[normalizedKind] ?? normalizedKind, name: name.trim() };
}

/** Try to find block in content. Returns new [start, end] (1-indexed) or null. */
export function relocateLineRanges(
  content: string,
  ranges: Array<[number, number | undefined]>,
  contextLines = 3,
): Array<[number, number]> | null {
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  if (total === 0) return null;

  const block = extractLines(content, ranges);
  if (!block) return null;

  const blockLines = block.split(/\r?\n/);
  const firstLine = blockLines[0];
  const lastLine = blockLines[blockLines.length - 1];
  if (!firstLine) return null;

  // 1. Exact anchor match
  const [origStart] = ranges[0]!;
  const origEnd = ranges[0]![1] ?? origStart;
  const origLen = origEnd - origStart + 1;
  if (origStart >= 1 && origStart <= total) {
    const endLine = Math.min(origEnd, total);
    const extracted = lines.slice(origStart - 1, endLine).join('\n');
    if (extracted === block) {
      return [[origStart, endLine]];
    }
  }

  // 2. Nearby window ±10 lines
  const window = 10;
  const searchStart = Math.max(0, origStart - 1 - window);
  const searchEnd = Math.min(total, origEnd + window);
  for (let i = searchStart; i <= Math.min(searchEnd, total - blockLines.length); i++) {
    const slice = lines.slice(i, i + blockLines.length);
    if (slice.join('\n') === block) {
      return [[i + 1, i + blockLines.length]];
    }
  }

  // 3. Fuzzy: find unique match using first/last line
  const firstTrim = firstLine.trim();
  const lastTrim = lastLine.trim();
  let matchStart: number | null = null;
  let matchCount = 0;
  for (let i = 0; i <= total - blockLines.length; i++) {
    const lineAt = lines[i]?.trim();
    const lineAtEnd = lines[i + blockLines.length - 1]?.trim();
    if (lineAt === firstTrim && lineAtEnd === lastTrim) {
      const slice = lines.slice(i, i + blockLines.length).join('\n');
      if (slice === block) {
        matchStart = i + 1;
        matchCount++;
      }
    }
  }
  if (matchCount === 1 && matchStart != null) {
    return [[matchStart, matchStart + blockLines.length - 1]];
  }

  return null;
}

export interface PreflightResult {
  params: Record<string, unknown>;
  warnings: string[];
  blocked: boolean;
  error?: string;
  relocationSummary?: string;
  confidence: RebaseConfidence;
  strategy: RebaseStrategy;
  decisions: PreflightDecision[];
  /** Content hashes from the preflight context call; handler can use instead of refreshContentHashes. */
  refreshedHashes?: Map<string, string>;
  /** Shape hash comparison metadata (when shape_match strategy is used). */
  shapeUnchanged?: boolean;
  shapeHashPrevious?: string;
  shapeHashCurrent?: string;
}

export function getPreflightAutomationDecision(result: Pick<PreflightResult, 'blocked' | 'confidence' | 'strategy'>): AutomationDecision {
  if (result.blocked || result.confidence === 'none' || result.strategy === 'blocked') {
    return { action: 'block', reason: 'identity_or_freshness_block' };
  }
  if (result.confidence === 'low') {
    return { action: 'review_required', reason: 'low_confidence_rebind' };
  }
  if (result.confidence === 'medium' && result.strategy !== 'fresh') {
    return { action: 'proceed_with_note', reason: 'medium_confidence_rebind' };
  }
  return { action: 'proceed', reason: 'verified_or_fresh' };
}

/** Operations that consume file-backed refs and need preflight */
const PREFLIGHT_OPS = new Set([
  'draft', 'batch_edits', 'edit', 'read_lines', 'context', 'create_files', 'refactor',
  'code_search', 'find_symbol', 'symbol_usage', 'find_issues', 'detect_patterns',
  'dependencies', 'call_hierarchy', 'symbol_dep_graph', 'change_impact', 'impact_analysis',
  'extract_plan', 'verify', 'git', 'workspaces', 'ast_query',
]);

function isRebaseableCause(cause: FreshnessCause): boolean {
  return cause === 'same_file_prior_edit' || cause === 'hash_forward';
}

function isSuspectCause(cause: FreshnessCause): boolean {
  return cause === 'external_file_change' || cause === 'watcher_event' || cause === 'unknown';
}

/** Check if any of the given refs point to suspect chunks. Returns hint string when so. */
export function getFreshnessHintForRefs(
  store: { chunks: Map<string, { shortHash: string; hash: string; suspectSince?: number; freshnessCause?: FreshnessCause }>; archivedChunks: Map<string, { shortHash: string; hash: string; suspectSince?: number; freshnessCause?: FreshnessCause }> },
  refs: string[],
): string | undefined {
  if (!refs.length) return undefined;
  for (const r of refs) {
    const short = r.replace(/^h:/, '').slice(0, 8);
    for (const [, chunk] of store.chunks) {
      if ((chunk.shortHash === short || chunk.hash.startsWith(short)) && chunk.suspectSince != null) {
        if (!chunk.freshnessCause || isSuspectCause(chunk.freshnessCause)) {
          return 'WARNING: some refs may be stale (file changed externally); re-read before editing';
        }
      }
    }
    for (const [, chunk] of store.archivedChunks) {
      if ((chunk.shortHash === short || chunk.hash.startsWith(short)) && chunk.suspectSince != null) {
        if (!chunk.freshnessCause || isSuspectCause(chunk.freshnessCause)) {
          return 'WARNING: some refs may be stale (file changed externally); re-read before editing';
        }
      }
    }
  }
  return undefined;
}

/** Classify a ref's freshness for the given target files */
export function classifyRefFreshness(
  source: string | undefined,
  sourceRevision: string | undefined,
  observedRevision: string | undefined,
  suspectSince: number | undefined,
  freshnessCause: FreshnessCause | undefined,
  targetFilesNorm: Set<string>,
): RefClassification {
  if (!source) return 'fresh';
  const srcNorm = NORMALIZE_PATH(source);
  if (!targetFilesNorm.has(srcNorm)) return 'fresh';
  const cause = freshnessCause ?? 'unknown';
  if (suspectSince != null) {
    if (isRebaseableCause(cause)) return 'rebaseable';
    return 'suspect';
  }
  if (observedRevision && sourceRevision && observedRevision !== sourceRevision) {
    if (isRebaseableCause(cause)) return 'rebaseable';
    if (isSuspectCause(cause)) return 'suspect';
    return 'suspect';
  }
  return 'fresh';
}

/** Run freshness preflight. Returns params (possibly with relocated ranges), warnings, and blocked flag. */
export async function runFreshnessPreflight(
  operation: string,
  params: Record<string, unknown>,
  opts?: {
    atlsBatchQuery?: (op: string, p: Record<string, unknown>) => Promise<unknown>;
    contentByPath?: Map<string, string>;
  },
): Promise<PreflightResult> {
  const warnings: string[] = [];
  if (!PREFLIGHT_OPS.has(operation)) {
    return { params, warnings, blocked: false, confidence: 'high', strategy: 'fresh', decisions: [] };
  }

  const targetFiles = new Set<string>();
  const addTarget = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0 && !v.startsWith('h:')) targetFiles.add(v);
  };
  addTarget(params.file ?? params.file_path);
  if (Array.isArray(params.file_paths)) {
    for (const p of params.file_paths) addTarget(p);
  }
  if (Array.isArray(params.edits)) {
    for (const e of params.edits) {
      if (e && typeof e === 'object') addTarget((e as Record<string, unknown>).file ?? (e as Record<string, unknown>).file_path);
    }
  }
  if (Array.isArray(params.creates)) {
    for (const c of params.creates) {
      if (c && typeof c === 'object') addTarget((c as Record<string, unknown>).path);
    }
  }
  const targetFilesNorm = new Set([...targetFiles].map(normalizePathKey));
  let refreshedHashes: Map<string, string> | undefined;
  let contextResult: Record<string, unknown> | null = null;

  // Single context call: refresh revisions for classification, gather content/hashes for relocation and handler.
  if (opts?.atlsBatchQuery && targetFiles.size > 0) {
    const files = [...targetFiles];
    contextResult = await opts.atlsBatchQuery('context', { type: 'full', file_paths: files }) as Record<string, unknown>;
    const entries = contextResult?.results;
    refreshedHashes = new Map<string, string>();
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const p = entry as Record<string, unknown>;
        const file = p.file ?? p.path;
        const hash = p.snapshot_hash ?? p.content_hash ?? p.hash;
        if (typeof file === 'string' && typeof hash === 'string') {
          refreshedHashes.set(normalizePathKey(file), hash);
        }
      }
    }
    const getRevisionForPath = (path: string): Promise<string | null> => {
      const h = refreshedHashes?.get(normalizePathKey(path));
      return Promise.resolve(typeof h === 'string' ? h : null);
    };
    await useContextStore.getState().refreshRoundEnd({ paths: files, getRevisionForPath });
  }

  const store = useContextStore.getState();
  const suspectRefs: string[] = [];
  const decisions: PreflightResult['decisions'] = [];
  const rebaseableRefs: Array<{ ref: string; source: string; lines?: string; sourceRevision?: string; snippetContent?: string; symbolSpec?: { kind?: string; name: string } | null }> = [];

  for (const chunk of store.chunks.values()) {
    const viewKind = chunk.viewKind ?? 'latest';
    if (viewKind !== 'latest') continue;
    const classification = classifyRefFreshness(
      chunk.source,
      chunk.sourceRevision,
      chunk.observedRevision ?? chunk.sourceRevision,
      chunk.suspectSince,
      chunk.freshnessCause,
      targetFilesNorm,
    );
    const ref = `h:${chunk.shortHash} ${chunk.source ?? chunk.type}`;
    if (classification === 'suspect') {
      suspectRefs.push(ref);
      decisions.push({ ref, source: chunk.source, classification, confidence: 'none', strategy: 'blocked', factors: ['identity_lost'], at: Date.now() });
    } else if (classification === 'rebaseable' && chunk.source) {
      rebaseableRefs.push({ ref, source: chunk.source, sourceRevision: chunk.sourceRevision });
      decisions.push({
        ref,
        source: chunk.source,
        classification,
        confidence: 'low',
        strategy: 'edit_journal',
        factors: chunk.sourceRevision ? ['revision_match'] : [],
        sourceRevision: chunk.sourceRevision,
        observedRevision: chunk.observedRevision ?? chunk.sourceRevision,
        at: Date.now(),
      });
    }
  }
  for (const chunk of store.archivedChunks.values()) {
    const viewKind = chunk.viewKind ?? 'latest';
    if (viewKind !== 'latest') continue;
    const classification = classifyRefFreshness(
      chunk.source,
      chunk.sourceRevision,
      chunk.observedRevision ?? chunk.sourceRevision,
      chunk.suspectSince,
      chunk.freshnessCause,
      targetFilesNorm,
    );
    const ref = `h:${chunk.shortHash} ${chunk.source ?? chunk.type}`;
    if (classification === 'suspect') {
      suspectRefs.push(ref);
      decisions.push({ ref, source: chunk.source, classification, confidence: 'none', strategy: 'blocked', factors: ['identity_lost'], at: Date.now() });
    } else if (classification === 'rebaseable' && chunk.source) {
      rebaseableRefs.push({ ref, source: chunk.source, sourceRevision: chunk.sourceRevision });
      decisions.push({
        ref,
        source: chunk.source,
        classification,
        confidence: 'low',
        strategy: 'edit_journal',
        factors: chunk.sourceRevision ? ['revision_match'] : [],
        sourceRevision: chunk.sourceRevision,
        observedRevision: chunk.observedRevision ?? chunk.sourceRevision,
        at: Date.now(),
      });
    }
  }
  for (const [, snippet] of store.stagedSnippets) {
    const viewKind = snippet.viewKind ?? ((snippet.lines || snippet.shapeSpec) ? 'derived' : 'latest');
    if (viewKind !== 'latest') continue;
    const classification = classifyRefFreshness(
      snippet.source,
      snippet.sourceRevision,
      snippet.observedRevision ?? snippet.sourceRevision,
      snippet.suspectSince,
      snippet.freshnessCause,
      targetFilesNorm,
    );
    const ref = `${snippet.source}`;
    if (classification === 'suspect') {
      suspectRefs.push(ref);
      decisions.push({
        ref,
        source: snippet.source,
        classification,
        confidence: 'none',
        strategy: 'blocked',
        factors: ['identity_lost'],
        linesBefore: snippet.lines,
        sourceRevision: snippet.sourceRevision,
        observedRevision: snippet.observedRevision ?? snippet.sourceRevision,
        at: Date.now(),
      });
    }
    if (classification === 'rebaseable' && snippet.source && snippet.lines) {
      rebaseableRefs.push({
        ref: snippet.source,
        source: snippet.source,
        lines: snippet.lines,
        sourceRevision: snippet.sourceRevision,
        snippetContent: snippet.content,
        symbolSpec: parseSymbolShapeSpec(snippet.shapeSpec),
      });
      decisions.push({
        ref: snippet.source,
        source: snippet.source,
        classification,
        confidence: 'low',
        strategy: 'edit_journal',
        factors: snippet.sourceRevision ? ['revision_match'] : [],
        linesBefore: snippet.lines,
        sourceRevision: snippet.sourceRevision,
        observedRevision: snippet.observedRevision ?? snippet.sourceRevision,
        at: Date.now(),
      });
    }
  }

  if (suspectRefs.length > 0) {
    /** Allow context/read_lines to reach handlers that clear suspect + reconcile (see context.ts handleRead). */
    const healingReadOps = operation === 'context' || operation === 'read_lines';
    if (healingReadOps) {
      if (refreshedHashes && refreshedHashes.size > 0) {
        const store = useContextStore.getState();
        for (const f of targetFiles) {
          const h = refreshedHashes.get(normalizePathKey(f));
          if (typeof h === 'string') {
            store.reconcileSourceRevision(f, h);
          }
        }
      }
      warnings.push(
        'Freshness: suspect engrams matched target paths; allowing context/read_lines to proceed so authority can refresh.',
      );
    } else {
      return {
        params,
        warnings,
        blocked: true,
        error: `File changed externally since pinned; re-read required. Stale refs: ${suspectRefs.slice(0, 3).join(', ')}${suspectRefs.length > 3 ? ` +${suspectRefs.length - 3} more` : ''}`,
        confidence: 'none',
        strategy: 'blocked',
        decisions,
        refreshedHashes,
      };
    }
  }

  let nextParams = params;
  const relocationParts: string[] = [];
  const identityLostRefs: string[] = [];
  let shapeUnchanged: boolean | undefined;
  let shapeHashPrevious: string | undefined;
  let shapeHashCurrent: string | undefined;

  if (rebaseableRefs.length > 0) {
    const contentByPath = opts?.contentByPath ?? new Map<string, string>();
    if (contentByPath.size === 0 && contextResult && Array.isArray(contextResult.results)) {
      for (const entry of contextResult.results) {
        if (entry && typeof entry === 'object') {
          const p = entry as Record<string, unknown>;
          const file = p.file ?? p.path;
          const content = p.content;
          if (typeof file === 'string' && typeof content === 'string') {
            contentByPath.set(normalizePathKey(file), content);
          }
        }
      }
    }

    for (const { ref, source, lines, sourceRevision, snippetContent, symbolSpec } of rebaseableRefs) {
      if (!lines) continue;
      const ranges = parseLineRanges(lines);
      if (!ranges) continue;
      const pathKey = normalizePathKey(source);
      const content = contentByPath.get(pathKey);
      let relocated = null as Array<[number, number]> | null;
      let confidence: RebaseConfidence = 'low';
      let strategy: RebaseStrategy = 'edit_journal';
      let factors: RebaseEvidence[] = sourceRevision ? ['revision_match'] : [];
      const journal = getFreshnessJournal(source);
      if (journal && typeof journal.lineDelta === 'number' && (!sourceRevision || !journal.previousRevision || journal.previousRevision === sourceRevision)) {
        relocated = ranges.map(([start, end]) => {
          const shiftedStart = Math.max(1, start + journal.lineDelta!);
          const shiftedEnd = end == null ? shiftedStart : Math.max(shiftedStart, end + journal.lineDelta!);
          return [shiftedStart, shiftedEnd] as [number, number];
        });
        confidence = 'high';
        strategy = 'edit_journal';
        factors = [...factors, 'journal_line_delta'];
      }
      // shape_match: compare stored shape hash against current file's sig hash
      if (!relocated && content) {
        const awarenessEntry = useContextStore.getState().getAwareness(source);
        const currentHash = refreshedHashes?.get(normalizePathKey(source));
        if (awarenessEntry?.shapeHash && currentHash && opts?.atlsBatchQuery) {
          try {
            const { hashContentSync } = await import('../utils/contextHash');
            const sigResult = await opts.atlsBatchQuery('context', {
              type: 'full', file_paths: [source], shape: 'sig',
            }) as Record<string, unknown>;
            const sigEntries = sigResult?.results as Array<Record<string, unknown>> | undefined;
            const sigContent = sigEntries?.[0]?.shaped_content ?? sigEntries?.[0]?.content;
            if (typeof sigContent === 'string' && sigContent.length > 0) {
              const currentShapeHash = hashContentSync(sigContent);
              shapeHashPrevious = awarenessEntry.shapeHash;
              shapeHashCurrent = currentShapeHash;
              if (currentShapeHash === awarenessEntry.shapeHash) {
                shapeUnchanged = true;
                relocated = ranges.map(([start, end]) => [start, end ?? start] as [number, number]);
                confidence = 'high';
                strategy = 'shape_match';
                factors = [...factors, 'shape_hash_match'];
              } else {
                shapeUnchanged = false;
                factors = [...factors, 'shape_hash_mismatch'];
              }
            }
          } catch {
            // shape resolve failed, fall through to other strategies
          }
        }
      }
      if (!relocated && content) {
        if (symbolSpec) {
          const symbolRange = resolveSymbolToLines(content, symbolSpec.kind, symbolSpec.name);
          // Guard: resolveSymbolToLines returns null when symbol not found
          relocated = (symbolRange != null) ? [[symbolRange[0], symbolRange[1]]] : null;
        }
        if (relocated && relocated.length > 0) {
          confidence = 'medium';
          strategy = 'symbol_identity';
          factors = [...factors, 'symbol_identity'];
        } else {
          relocated = snippetContent ? locateSnippetFingerprint(content, snippetContent) : null;
          if (relocated && relocated.length > 0) {
            confidence = 'medium';
            strategy = 'fingerprint_match';
            factors = [...factors, 'fingerprint_unique'];
          } else if (!snippetContent) {
            relocated = relocateLineRanges(content, ranges);
            if (relocated && relocated.length > 0) {
              confidence = snippetContent ? 'medium' : 'high';
              strategy = 'line_relocation';
              const [origStart, origEnd] = ranges[0]!;
              const [relocatedStart, relocatedEnd] = relocated[0]!;
              factors = [
                ...factors,
                relocatedStart === origStart && relocatedEnd === (origEnd ?? origStart)
                  ? 'exact_line_match'
                  : 'content_window_match',
              ];
            }
          }
        }
      } else if (!relocated) {
        factors = [...factors, 'missing_content'];
      }
      if (!relocated) {
        confidence = 'none';
        strategy = 'blocked';
        factors = [...factors, 'identity_lost'];
      }
      if (relocated && relocated.length > 0) {
        const [start, end] = relocated[0]!;
        const newLines = `${start}-${end}`;
        relocationParts.push(`${strategy} shifted anchor to ${newLines} (was ${lines})`);
        nextParams = { ...nextParams };
        if (nextParams.file === source || nextParams.file_path === source) {
          nextParams = { ...nextParams, lines: newLines };
        }
        if (Array.isArray(nextParams.edits)) {
          nextParams.edits = nextParams.edits.map((e) => {
            if (!e || typeof e !== 'object') return e;
            const entry = e as Record<string, unknown>;
            const f = entry.file ?? entry.file_path;
            if (f === source) return { ...entry, lines: newLines };
            return e;
          });
        }
        const decision = decisions.find((item) => item.ref === ref && item.linesBefore === lines);
        if (decision) {
          decision.linesAfter = newLines;
          decision.confidence = confidence;
          decision.strategy = strategy;
          decision.factors = factors;
          decision.at = Date.now();
        }
      } else {
        identityLostRefs.push(ref);
        const decision = decisions.find((item) => item.ref === ref && item.linesBefore === lines);
        if (decision) {
          decision.confidence = confidence;
          decision.strategy = strategy;
          decision.factors = factors;
          decision.at = Date.now();
        }
      }
    }
  }

  if (identityLostRefs.length > 0) {
    return {
      params: nextParams,
      warnings,
      blocked: true,
      error: `Identity lost while rebinding stale refs; re-read required. Affected refs: ${identityLostRefs.slice(0, 3).join(', ')}${identityLostRefs.length > 3 ? ` +${identityLostRefs.length - 3} more` : ''}`,
      relocationSummary: relocationParts.length > 0 ? relocationParts.join('; ') : undefined,
      confidence: 'none',
      strategy: 'blocked',
      decisions,
      refreshedHashes,
      shapeUnchanged,
      shapeHashPrevious,
      shapeHashCurrent,
    };
  }

  if (relocationParts.length > 0) {
    warnings.push(`Anchor shifted after prior in-batch edit; auto-rebased: ${relocationParts.join('; ')}`);
  }

  return {
    params: nextParams,
    warnings,
    blocked: false,
    relocationSummary: relocationParts.length > 0 ? relocationParts.join('; ') : undefined,
    confidence: decisions.some((item) => item.confidence === 'low')
      ? 'low'
      : decisions.some((item) => item.confidence === 'medium')
        ? 'medium'
        : 'high',
    strategy: decisions.find((item) => item.strategy !== 'fresh')?.strategy ?? 'fresh',
    decisions,
    refreshedHashes,
    shapeUnchanged,
    shapeHashPrevious,
    shapeHashCurrent,
  };
}
