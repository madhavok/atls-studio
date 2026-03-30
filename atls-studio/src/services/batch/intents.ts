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

function normalizePathKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
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
    const meta = s.getBlackboardEntryWithMeta(entry.key);
    bbKeys.set(entry.key, {
      tokens: entry.tokens,
      derivedFrom: meta?.derivedFrom,
    });
  }

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
    const params = { ...raw, _intentId: raw._intentId ?? step.id };
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
    metrics.push({
      intentName: step.use,
      totalPossibleSteps: totalPossible,
      emittedSteps: result.steps.length,
      skippedSteps: Math.max(0, totalPossible - result.steps.length),
      lookaheadSteps: result.prepareNext?.length ?? 0,
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
      return collectFromDepsGraph(targetFiles, context, 'importers');
    case 'intent.edit':
    case 'intent.edit_multi':
    case 'intent.search_replace':
      return [
        ...collectTestFiles(targetFiles),
        ...collectFromDepsGraph(targetFiles, context, 'importers'),
      ];
    case 'intent.investigate':
    case 'intent.diagnose':
      return collectFromDepsGraph(targetFiles, context, 'neighbors');
    case 'intent.survey':
      return collectHubFiles(context);
    case 'intent.extract':
      return collectFromDepsGraph(targetFiles, context, 'importers');
    case 'intent.test':
      return [];
    default:
      return [];
  }
}

/**
 * Extract related files from deps BB entries.
 * BB entries keyed as deps:${filePath} may contain JSON with importers/callers.
 */
function collectFromDepsGraph(
  targetFiles: string[],
  context: IntentContext,
  relation: 'importers' | 'neighbors',
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

/** Heuristic: test file for a source file. */
function collectTestFiles(targetFiles: string[]): string[] {
  const tests: string[] = [];
  for (const f of targetFiles) {
    const ext = f.match(/\.[^.]+$/)?.[0] ?? '.ts';
    const base = f.replace(/\.[^.]+$/, '');
    tests.push(`${base}.test${ext}`);
    tests.push(`${base}.spec${ext}`);
  }
  return tests;
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
