/**
 * Intent Engine — resolves intent.* macro steps into primitive step sequences.
 *
 * Resolvers are pure functions: IntentContext in, IntentResult out.
 * Forward-chaining between expanded steps uses the existing ref grammar
 * (from_step, ConditionExpr, out/bind, recency refs).
 */

import type {
  IntentOp, IntentResolver, IntentContext, IntentResult, IntentMetrics,
  Step, StepOutput, ContextStoreApi,
} from './types';
import { canSteerExecution } from '../universalFreshness';
import { normalizeStepParams } from './paramNorm';
import { workspacePathKeyDefault } from '../../utils/workspacePathKey';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const INTENT_REGISTRY = new Map<IntentOp, IntentResolver>();

export function registerIntent(op: IntentOp, resolver: IntentResolver): void {
  INTENT_REGISTRY.set(op, resolver);
}

export function getIntentResolver(op: IntentOp): IntentResolver | undefined {
  return INTENT_REGISTRY.get(op);
}

// ---------------------------------------------------------------------------
// Context assembly — backward-looking only
// ---------------------------------------------------------------------------

/**
 * Shared with {@link snapshotTracker}'s path key so intent-level awareness
 * (pinnedSources, edit-region coverage) aligns with the tracker keys used
 * by the executor. See `src/utils/workspacePathKey.ts` for prefix-derivation
 * rules.
 */
function normalizePathKey(p: string): string {
  return workspacePathKeyDefault(p);
}

/** `analyze.*` handlers pass these literal strings as chunk `source` (not file paths). */
const ANALYSIS_CHUNK_NON_PATH_SOURCES = new Set([
  'call_hierarchy',
  'symbol_dep_graph',
  'change_impact',
  'impact_analysis',
  'extract_plan', // legacy before per-file source
]);

function looksLikeAnalysisFilePathSource(source: string): boolean {
  if (ANALYSIS_CHUNK_NON_PATH_SOURCES.has(source)) return false;
  return source.includes('/') || source.includes('\\') || /\.[a-zA-Z0-9]{1,12}$/.test(source);
}

/**
 * Merge keys implied by working-memory chunks so intent elision matches handler storage.
 * `analyze.deps` / `analyze.extract_plan` use addChunk, not setBlackboardEntry; BB-only bbKeys missed them.
 */
function mergeChunkDerivedBbKeys(
  bbKeys: Map<string, { tokens: number; derivedFrom?: string[] }>,
  chunks: ContextStoreApi['chunks'],
): void {
  for (const [, chunk] of chunks) {
    if (chunk.type === 'deps' && chunk.source?.trim()) {
      for (const raw of chunk.source.split(',')) {
        const fp = raw.trim();
        if (!fp) continue;
        const key = `deps:${fp}`;
        if (!bbKeys.has(key)) {
          bbKeys.set(key, { tokens: chunk.tokens });
        }
      }
      continue;
    }

    if (chunk.type === 'analysis' && chunk.source && looksLikeAnalysisFilePathSource(chunk.source)) {
      const key = `extract_plan:${chunk.source}`;
      if (!bbKeys.has(key)) {
        bbKeys.set(key, { tokens: chunk.tokens });
      }
    }
  }
}

export function buildIntentContext(
  store: () => ContextStoreApi,
  stepOutputs: ReadonlyMap<string, StepOutput>,
): IntentContext {
  const s = store();

  const staged: Map<string, { source?: string; tokens: number }> = new Map();
  const stagedEntries = s.getStagedEntries();
  for (const [key, entry] of stagedEntries) {
    if (!canSteerExecution({ stageState: (entry as { stageState?: string }).stageState, freshness: (entry as { freshness?: string }).freshness })) continue;
    staged.set(key, { source: entry.source, tokens: entry.tokens });
  }

  const pinned = new Set<string>();
  const pinnedSources = new Set<string>();
  for (const [hash, chunk] of s.chunks) {
    if (chunk.pinned) {
      pinned.add(hash);
      if (chunk.source) pinnedSources.add(normalizePathKey(chunk.source));
    }
  }

  const bbKeys: Map<string, { tokens: number; derivedFrom?: string[] }> = new Map();
  for (const entry of s.listBlackboardEntries()) {
    if (!canSteerExecution({ state: entry.state })) continue;
    const meta = s.getBlackboardEntryWithMeta(entry.key);
    bbKeys.set(entry.key, {
      tokens: entry.tokens,
      derivedFrom: meta?.derivedFrom,
    });
  }

  mergeChunkDerivedBbKeys(bbKeys, s.chunks);

  const awareness: Map<string, { snapshotHash: string; level: number; readRegions: Array<{ start: number; end: number }> }> = new Map();
  for (const [, entry] of s.getAwarenessCache()) {
    awareness.set(normalizePathKey(entry.filePath), {
      snapshotHash: entry.snapshotHash,
      level: entry.level,
      readRegions: entry.readRegions,
    });
  }

  return {
    staged,
    pinned,
    pinnedSources,
    bbKeys,
    awareness,
    priorOutputs: stepOutputs,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveResult {
  expanded: Step[];
  lookahead: Step[];
  metrics: IntentMetrics[];
}

function isIntentOp(use: string): use is IntentOp {
  return use.startsWith('intent.');
}

export function resolveIntents(
  steps: Step[],
  context: IntentContext,
): ResolveResult {
  const expanded: Step[] = [];
  const lookahead: Step[] = [];
  const metrics: IntentMetrics[] = [];

  for (const step of steps) {
    if (!isIntentOp(step.use)) {
      expanded.push(step);
      continue;
    }

    const resolver = INTENT_REGISTRY.get(step.use);
    if (!resolver) {
      expanded.push(step);
      continue;
    }

    const raw = step.with ?? {};
    const normalized = normalizeStepParams(step.use, { ...raw });
    const params = { ...normalized, _intentId: (raw._intentId as string | undefined) ?? step.id };
    const result: IntentResult = resolver(params, context);

    const intentId = step.id;
    for (const s of result.steps) {
      expanded.push(s);
    }

    if (result.prepareNext) {
      for (let i = 0; i < result.prepareNext.length; i++) {
        const la = result.prepareNext[i];
        lookahead.push({
          ...la,
          id: la.id || `${intentId}__lookahead_${i}`,
        });
      }
    }

    const totalPossible = estimateTotalSteps(step.use);
    const lookaheadCount = result.prepareNext?.length ?? 0;
    metrics.push({
      intentName: step.use,
      totalPossibleSteps: totalPossible,
      emittedSteps: result.steps.length,
      skippedSteps: Math.max(0, totalPossible - result.steps.length),
      lookaheadSteps: lookaheadCount,
      // Resolver-side reason. Executor overrides to 'pressured' at the gate
      // (see executeUnifiedBatch's lookahead guard) when isPressured()
      // drops these steps before dispatch.
      lookaheadReason: lookaheadCount > 0 ? 'emitted' : 'no_targets',
    });
  }

  return { expanded, lookahead, metrics };
}

function estimateTotalSteps(op: IntentOp): number {
  switch (op) {
    case 'intent.understand': return 4;
    case 'intent.edit': return 3;
    case 'intent.edit_multi': return 10;
    case 'intent.investigate': return 4;
    case 'intent.diagnose': return 5;
    case 'intent.survey': return 4;
    case 'intent.refactor': return 6;
    case 'intent.create': return 4;
    case 'intent.test': return 4;
    case 'intent.search_replace': return 12;
    case 'intent.extract': return 4;
    default: return 4;
  }
}

// ---------------------------------------------------------------------------
// Pressure check
// ---------------------------------------------------------------------------

const PRESSURE_THRESHOLD = 0.85;

export function isPressured(store: () => ContextStoreApi): boolean {
  const s = store();
  if (s.maxTokens <= 0) return false;
  return s.getUsedTokens() / s.maxTokens >= PRESSURE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Helpers for resolvers
// ---------------------------------------------------------------------------

export function makeStepId(intentId: string, primitive: string, index?: number): string {
  const suffix = index != null ? `_${index}` : '';
  return `${intentId}__${primitive}${suffix}`;
}

/**
 * File paths from intent.* `with` params. Recognizes `ps` (token-efficient shorthand for
 * `file_paths` per paramNorm) because intent resolvers run on raw params before per-step
 * alias normalization in some call paths.
 */
export function normalizeIntentFilePaths(params: Record<string, unknown>): string[] {
  if (Array.isArray(params.ps)) return params.ps as string[];
  if (typeof params.ps === 'string') return [params.ps];
  if (Array.isArray(params.file_paths)) return params.file_paths as string[];
  if (typeof params.file_path === 'string') return [params.file_path];
  if (Array.isArray(params.files)) return params.files as string[];
  if (typeof params.file === 'string') return [params.file];
  return [];
}

/** Check if a file source path appears in the staged map (by normalized source match). */
export function isFileStaged(staged: IntentContext['staged'], filePath: string): boolean {
  const norm = normalizePathKey(filePath);
  for (const [, entry] of staged) {
    if (entry.source && normalizePathKey(entry.source) === norm) return true;
  }
  return false;
}

/** Check if any chunk for a file source is pinned. */
export function isFilePinned(pinnedSources: IntentContext['pinnedSources'], filePath: string): boolean {
  return pinnedSources.has(normalizePathKey(filePath));
}

/** Get awareness entry for a file path. */
export function getFileAwareness(
  awareness: IntentContext['awareness'],
  filePath: string,
): { snapshotHash: string; level: number; readRegions: Array<{ start: number; end: number }> } | undefined {
  return awareness.get(normalizePathKey(filePath));
}

/**
 * Resolve a potentially workspace-abbreviated path (e.g. `utils/foo.ts`) to
 * the canonical path stored in awareness (`src/utils/foo.ts`) by unique
 * suffix match. Returns the input unchanged when an exact key exists; the
 * matched canonical path when a single awareness entry ends in the input
 * path; or undefined when the suffix is ambiguous.
 *
 * Intent macros use this to align their emitted sub-steps with the tracker
 * keys used by the executor, so `intent.edit_multi` targeting
 * `utils/foo.ts` works after a prior read resolved and stored the file
 * under `src/utils/foo.ts`.
 */
export function resolveAwarenessPathBySuffix(
  awareness: IntentContext['awareness'],
  filePath: string,
): string | undefined {
  const key = normalizePathKey(filePath);
  if (!key) return undefined;
  if (awareness.has(key)) return filePath;
  const suffix = key.startsWith('/') ? key : `/${key}`;
  const matches: string[] = [];
  for (const k of awareness.keys()) {
    if (k === key) return key;
    if (k.endsWith(suffix)) matches.push(k);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Estimate file size from awareness readRegions. */
export function estimateFileLines(awareness: IntentContext['awareness'], filePath: string): number {
  const entry = getFileAwareness(awareness, filePath);
  if (!entry || entry.readRegions.length === 0) return 0;
  let maxEnd = 0;
  for (const r of entry.readRegions) {
    if (r.end > maxEnd) maxEnd = r.end;
  }
  return maxEnd;
}

// ---------------------------------------------------------------------------
// Prepare-Next Engine — compute lookahead targets
// ---------------------------------------------------------------------------

const MAX_LOOKAHEAD_FILES = 3;

/**
 * Build lookahead steps for an intent based on its expanded results.
 * Returns read.shaped steps for related files (sigs only, ~200tk each).
 * Capped at MAX_LOOKAHEAD_FILES to bound speculative cost.
 */
export function computeNextTargets(
  intentId: string,
  intentName: IntentOp,
  targetFiles: string[],
  context: IntentContext,
): Step[] {
  const candidates = collectCandidates(intentName, targetFiles, context);

  const filtered = candidates.filter(f => {
    if (isFileStaged(context.staged, f)) return false;
    if (getFileAwareness(context.awareness, f)) return false;
    return true;
  });

  const capped = filtered.slice(0, MAX_LOOKAHEAD_FILES);

  return capped.map((f, i) => ({
    id: `${intentId}__lookahead_${i}`,
    use: 'read.shaped' as const,
    with: { file_paths: [f], shape: 'sig' },
  }));
}

function collectCandidates(
  intentName: IntentOp,
  targetFiles: string[],
  context: IntentContext,
): string[] {
  switch (intentName) {
    case 'intent.understand':
    case 'intent.refactor':
    case 'intent.create':
      return collectFromDepsGraph(targetFiles, context);
    case 'intent.edit':
    case 'intent.edit_multi':
    case 'intent.search_replace':
      return collectFromDepsGraph(targetFiles, context);
    case 'intent.investigate':
    case 'intent.diagnose':
      return collectFromDepsGraph(targetFiles, context);
    case 'intent.survey':
      return collectHubFiles(context);
    case 'intent.extract':
      return collectFromDepsGraph(targetFiles, context);
    case 'intent.test':
      return [];
    default:
      return [];
  }
}

/**
 * Extract related files from deps BB entries (derivedFrom field).
 */
function collectFromDepsGraph(
  targetFiles: string[],
  context: IntentContext,
): string[] {
  const results: string[] = [];
  for (const f of targetFiles) {
    const depsEntry = context.bbKeys.get(`deps:${f}`);
    if (depsEntry?.derivedFrom) {
      results.push(...depsEntry.derivedFrom);
    }
  }
  return results;
}

/** Extract hub files from BB — files with highest import count. */
function collectHubFiles(context: IntentContext): string[] {
  const hubs: string[] = [];
  for (const [key, entry] of context.bbKeys) {
    if (key.startsWith('hub:') && entry.derivedFrom) {
      hubs.push(...entry.derivedFrom);
    }
  }
  return hubs;
}
