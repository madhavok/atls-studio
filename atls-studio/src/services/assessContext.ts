/**
 * Assess Context — ephemeral steering signal that surfaces cleanup candidates.
 *
 * Mirrors the {@link spinCircuitBreaker} shape: pure module with module-private
 * state, evaluated once per round by the tool loop, published through
 * {@link ToolLoopSteering} and consumed in `buildDynamicContextBlock`.
 *
 * Unlike spin detection, ASSESS is resource-based rather than behavior-based:
 * it reports the top-K pinned FileViews / pinned artifacts that have gone idle
 * or survived edit-forwarding without use. The model is asked to emit one of
 * `release (pu) | compact (pc tier:sig) | hold` per listed ref before any new
 * read.
 *
 * Trigger model:
 *   - User-turn boundary (`round === 0`): fire if pinned content exceeds
 *     `boundaryMinTokens` (default 1k). Surfaces what the prior turn left
 *     behind.
 *   - Mid-loop: fire if `ctxPct >= midLoopCtxThreshold` (default 80) OR a new
 *     edit-forwarded pin appeared since the last evaluation.
 *
 * Dedupe (single-fire, per plan):
 *   - `firedKey = bucket + ':' + sortedCandidateHashes`.
 *   - Re-fires only when the candidate set changes or the CTX bucket climbs
 *     (mid → hi). Stays quiet on repeat fires.
 *
 * State:
 *   - Sidecar (`fvSidecar`) tracks revision changes per file path to count
 *     `survivedEditsWhileIdle` — pin auto-forwarded without a corresponding
 *     `lastAccessed` bump. Session-scoped; survives turn boundaries.
 *   - Dedupe state (`turnDedupe`) is keyed by `turnId`; reset implicitly when
 *     `turnId` changes.
 *   - Idle rounds are derived from `Date.now() - lastAccessed` rather than an
 *     absolute round counter, so accounting stays correct across turn
 *     boundaries where `round` resets to 0.
 *
 * Purity: no store writes. All bookkeeping happens in `_session`, which is
 * cleared by {@link resetAssessContext} at session reset / test boundaries.
 */

import type { FileView } from './fileViewStore';
import type { ContextChunk } from '../stores/contextStore';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AssessCandidate {
  /** `h:fv:<hash>` for FileViews, short hash for other chunks. */
  hash: string;
  kind: 'fileview' | 'artifact';
  /** Display label — file path or chunk source. */
  label: string;
  tokens: number;
  idleRounds: number;
  /** Count of auto-forwards observed since the last access bump; 0 for non-views. */
  survivedEditsWhileIdle: number;
  reasons: string[];
  score: number;
}

export interface AssessEvaluation {
  fired: boolean;
  firedKey: string;
  message?: string;
  candidates: AssessCandidate[];
  ctxPct: number;
}

export interface AssessSnapshotInput {
  fileViews: Map<string, FileView>;
  chunks: Map<string, ContextChunk>;
  /** Chunks already covered by a pinned FileView — exclude from artifact scan. */
  fileViewCoveredChunkHashes: Set<string>;
  /** Chunk hashes recently cited by active BB findings; excluded to avoid
   *  suggesting cleanup on just-used evidence. Optional. */
  recentlyCitedChunkHashes?: Set<string>;
  /** Chunk/FileView hashes flagged suspect/stale; these need `rec`, not cleanup. */
  suspectChunkHashes?: Set<string>;
  ctxUsedTokens: number;
  ctxMaxTokens: number;
  /** Round within the current turn (streamChat). `0` = user-turn boundary. */
  round: number;
  /** Stable id of the enclosing user turn; state resets when it changes. */
  turnId: number | 'unscoped';
  /** If the active task plan lists files, paths outside this set score higher. */
  taskPlanFilePaths?: Set<string>;
  /** Override wall clock for deterministic tests. Defaults to `Date.now()`. */
  now?: number;
  /** Approximate round duration for idle-round estimation. Default 30s. */
  roundMs?: number;
}

export interface EvaluateAssessOptions {
  /** FileView idle threshold in rounds (mid-loop path). Default 2. */
  idleRoundsMin?: number;
  /** Non-FileView pinned artifact idle threshold in rounds. Default 3. */
  artifactIdleRoundsMin?: number;
  /** Minimum tokens for non-FileView artifacts. Default 1000. */
  artifactMinTokens?: number;
  /** Max candidates emitted (K). Default 5. */
  maxCandidates?: number;
  /** Mid-loop CTX fire threshold (percent). Default 80. */
  midLoopCtxThreshold?: number;
  /** On the user-turn boundary path, pinned tokens sum below this = no fire. Default 1000. */
  boundaryMinTokens?: number;
}

export const DEFAULT_ROUND_MS = 30_000;

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

interface FvSidecarEntry {
  revisionAtLastAccess: string;
  lastAccessedSeen: number;
  forwardsWhileIdle: number;
}

interface TurnDedupe {
  lastFiredKey: string;
  lastCtxBucket: 'mid' | 'hi';
}

interface SessionState {
  fvSidecar: Map<string, FvSidecarEntry>;
  turnDedupe: Map<number | 'unscoped', TurnDedupe>;
}

let _session: SessionState | null = null;

function ensureSession(): SessionState {
  if (!_session) {
    _session = { fvSidecar: new Map(), turnDedupe: new Map() };
  }
  return _session;
}

/** Reset all module-private state. Call on session reset and between tests. */
export function resetAssessContext(): void {
  _session = null;
}

/** Read-only snapshot for telemetry / debugging. */
export function getAssessContextState(): {
  fvSidecarSize: number;
  turnCount: number;
} | null {
  if (!_session) return null;
  return {
    fvSidecarSize: _session.fvSidecar.size,
    turnCount: _session.turnDedupe.size,
  };
}

// ---------------------------------------------------------------------------
// Observation — keeps sidecar in sync with store
// ---------------------------------------------------------------------------

interface FvObservation {
  idleRounds: number;
  forwards: number;
}

function observeFileViews(
  input: AssessSnapshotInput,
  session: SessionState,
): Map<string, FvObservation> {
  const now = input.now ?? Date.now();
  const roundMs = input.roundMs ?? DEFAULT_ROUND_MS;
  const out = new Map<string, FvObservation>();

  for (const view of input.fileViews.values()) {
    const prev = session.fvSidecar.get(view.filePath);
    if (!prev) {
      session.fvSidecar.set(view.filePath, {
        revisionAtLastAccess: view.sourceRevision,
        lastAccessedSeen: view.lastAccessed,
        forwardsWhileIdle: 0,
      });
      out.set(view.filePath, {
        idleRounds: idleRoundsFromTs(now, view.lastAccessed, roundMs),
        forwards: 0,
      });
      continue;
    }
    let { revisionAtLastAccess, lastAccessedSeen, forwardsWhileIdle } = prev;
    if (view.lastAccessed > lastAccessedSeen) {
      // Access advanced since last observation — reset idle counters.
      revisionAtLastAccess = view.sourceRevision;
      lastAccessedSeen = view.lastAccessed;
      forwardsWhileIdle = 0;
    } else if (view.sourceRevision !== revisionAtLastAccess) {
      // Revision bumped without an access → silent edit-forward.
      revisionAtLastAccess = view.sourceRevision;
      forwardsWhileIdle += 1;
    }
    session.fvSidecar.set(view.filePath, {
      revisionAtLastAccess,
      lastAccessedSeen,
      forwardsWhileIdle,
    });
    out.set(view.filePath, {
      idleRounds: idleRoundsFromTs(now, lastAccessedSeen, roundMs),
      forwards: forwardsWhileIdle,
    });
  }

  // GC: drop sidecar entries for views no longer present.
  for (const path of Array.from(session.fvSidecar.keys())) {
    if (!input.fileViews.has(path)) session.fvSidecar.delete(path);
  }

  return out;
}

function idleRoundsFromTs(now: number, lastAccessed: number, roundMs: number): number {
  const diff = now - lastAccessed;
  if (!Number.isFinite(diff) || diff <= 0) return 0;
  return Math.floor(diff / Math.max(1, roundMs));
}

// ---------------------------------------------------------------------------
// Candidate selection & ranking
// ---------------------------------------------------------------------------

const ARTIFACT_TYPES: ReadonlySet<string> = new Set([
  'search',
  'symbol',
  'deps',
  'analysis',
  'issues',
  'result',
  'call',
]);

function estimateViewTokens(view: FileView): number {
  const filled = view.filledRegions.reduce((s, r) => s + (r.tokens ?? 0), 0);
  if (filled > 0) return filled;
  if (view.fullBody) return Math.ceil(view.fullBody.length / 3);
  return 0;
}

function fmtTokens(n: number): string {
  if (n >= 1000) {
    const v = n / 1000;
    return (v >= 10 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '')) + 'k';
  }
  return String(Math.max(0, Math.round(n)));
}

/**
 * Build the ranked candidate list for a snapshot. Pure — no dedupe/trigger
 * logic. Exported for direct use in tests and the evaluation pipeline.
 */
export function selectCandidates(
  input: AssessSnapshotInput,
  opts: EvaluateAssessOptions = {},
): AssessCandidate[] {
  const idleRoundsMin = opts.idleRoundsMin ?? 2;
  const artifactIdleRoundsMin = opts.artifactIdleRoundsMin ?? 3;
  const artifactMinTokens = opts.artifactMinTokens ?? 1000;
  const maxCandidates = opts.maxCandidates ?? 5;
  const now = input.now ?? Date.now();
  const roundMs = input.roundMs ?? DEFAULT_ROUND_MS;

  const session = ensureSession();
  const fvObs = observeFileViews(input, session);

  const candidates: AssessCandidate[] = [];

  // --- Pinned FileViews ---
  for (const view of input.fileViews.values()) {
    if (!view.pinned) continue;
    if (view.freshness === 'suspect') continue; // needs rec, not cleanup
    if (input.suspectChunkHashes?.has(view.hash)) continue;
    const tokens = estimateViewTokens(view);
    if (tokens <= 0) continue;

    const obs = fvObs.get(view.filePath) ?? { idleRounds: 0, forwards: 0 };
    const outOfScope =
      input.taskPlanFilePaths !== undefined
      && input.taskPlanFilePaths.size > 0
      && !input.taskPlanFilePaths.has(view.filePath);

    const idleEligible = obs.idleRounds >= idleRoundsMin;
    if (!idleEligible && !outOfScope) continue;

    const reasons: string[] = [];
    if (obs.idleRounds > 0) {
      if (obs.forwards > 0) {
        const plural = obs.forwards === 1 ? '' : 's';
        reasons.push(`idle:${obs.idleRounds}r (pin survived ${obs.forwards} edit${plural} untouched)`);
      } else {
        reasons.push(`idle:${obs.idleRounds}r`);
      }
    }
    if (outOfScope) reasons.push('out of subtask scope');
    if (reasons.length === 0) reasons.push('pinned but idle');

    const score = tokens * (obs.idleRounds + 2 * obs.forwards)
      + (outOfScope ? tokens * 0.5 : 0);

    candidates.push({
      hash: view.hash,
      kind: 'fileview',
      label: view.filePath,
      tokens,
      idleRounds: obs.idleRounds,
      survivedEditsWhileIdle: obs.forwards,
      reasons,
      score,
    });
  }

  // --- Pinned non-FileView artifacts ---
  for (const chunk of input.chunks.values()) {
    if (!chunk.pinned) continue;
    if (!ARTIFACT_TYPES.has(chunk.type)) continue;
    if (chunk.tokens < artifactMinTokens) continue;
    if (input.fileViewCoveredChunkHashes.has(chunk.hash)) continue;
    if (input.suspectChunkHashes?.has(chunk.hash)) continue;
    if (input.recentlyCitedChunkHashes?.has(chunk.hash)) continue;
    if (chunk.freshness === 'changed' || chunk.freshness === 'suspect') continue;

    const idleRounds = idleRoundsFromTs(now, chunk.lastAccessed, roundMs);
    if (idleRounds < artifactIdleRoundsMin) continue;

    candidates.push({
      hash: chunk.hash,
      kind: 'artifact',
      label: chunk.source ?? chunk.type,
      tokens: chunk.tokens,
      idleRounds,
      survivedEditsWhileIdle: 0,
      reasons: [`${chunk.type} pin idle:${idleRounds}r`],
      score: chunk.tokens * idleRounds,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, Math.max(0, maxCandidates));
}

// ---------------------------------------------------------------------------
// Evaluation — triggers, dedupe, message formatting
// ---------------------------------------------------------------------------

function ctxBucket(ctxPct: number, threshold: number): 'mid' | 'hi' {
  return ctxPct >= threshold ? 'hi' : 'mid';
}

function buildFiredKey(candidates: AssessCandidate[], bucket: 'mid' | 'hi'): string {
  const hashes = candidates.map(c => c.hash).sort().join(',');
  return `${bucket}:${hashes}`;
}

function parseBucket(key: string): 'mid' | 'hi' | null {
  if (!key) return null;
  const idx = key.indexOf(':');
  if (idx < 0) return null;
  const b = key.slice(0, idx);
  return b === 'mid' || b === 'hi' ? b : null;
}

function sameHashList(a: string, b: string): boolean {
  return a.slice(a.indexOf(':') + 1) === b.slice(b.indexOf(':') + 1);
}

export function formatAssessMessage(
  candidates: AssessCandidate[],
  input: AssessSnapshotInput,
): string {
  const ctxPct = input.ctxMaxTokens > 0
    ? Math.round((input.ctxUsedTokens / input.ctxMaxTokens) * 100)
    : 0;
  const u = fmtTokens(input.ctxUsedTokens);
  const m = fmtTokens(input.ctxMaxTokens);
  const n = candidates.length;
  const noun = n === 1 ? 'target' : 'targets';
  const header =
    `<<ASSESS: CTX ${ctxPct}% (${u}/${m}). ${n} pinned ${noun} bloating WM. Decide before next read:`;
  const rows = candidates.map(c => {
    const tok = fmtTokens(c.tokens);
    return `  ${c.hash}  ${c.label}  ${tok}  ${c.reasons.join(', ')}`;
  });
  const footer =
    'Per row: release (pu hashes:h:X) | compact (pc hashes:h:X tier:sig) | hold (no-op; cite why).>>';
  return [header, ...rows, footer].join('\n');
}

/**
 * Evaluate the current round. Pure w.r.t. `_session` state: invoking twice
 * with the same snapshot is idempotent (the first call updates `lastFiredKey`;
 * the second sees the same key and returns `fired: false`).
 */
export function evaluateAssess(
  input: AssessSnapshotInput,
  opts: EvaluateAssessOptions = {},
): AssessEvaluation {
  const midLoopCtxThreshold = opts.midLoopCtxThreshold ?? 80;
  const boundaryMinTokens = opts.boundaryMinTokens ?? 1000;
  const ctxPct = input.ctxMaxTokens > 0
    ? (input.ctxUsedTokens / input.ctxMaxTokens) * 100
    : 0;
  const bucket = ctxBucket(ctxPct, midLoopCtxThreshold);

  const session = ensureSession();
  const dedupe = session.turnDedupe.get(input.turnId)
    ?? { lastFiredKey: '', lastCtxBucket: 'mid' as const };

  const candidates = selectCandidates(input, opts);

  if (candidates.length === 0) {
    return { fired: false, firedKey: dedupe.lastFiredKey, candidates: [], ctxPct };
  }

  const isUserTurnBoundary = input.round === 0;
  const hasNewForward = candidates.some(c => c.kind === 'fileview' && c.survivedEditsWhileIdle > 0);
  const boundaryEligible = isUserTurnBoundary
    && candidates.reduce((s, c) => s + c.tokens, 0) >= boundaryMinTokens;
  const midLoopEligible = !isUserTurnBoundary
    && (ctxPct >= midLoopCtxThreshold || hasNewForward);

  if (!boundaryEligible && !midLoopEligible) {
    return { fired: false, firedKey: dedupe.lastFiredKey, candidates, ctxPct };
  }

  const key = buildFiredKey(candidates, bucket);

  if (dedupe.lastFiredKey) {
    const prevBucket = parseBucket(dedupe.lastFiredKey) ?? 'mid';
    const candidatesChanged = !sameHashList(dedupe.lastFiredKey, key);
    const bucketClimbed = prevBucket === 'mid' && bucket === 'hi';
    if (!candidatesChanged && !bucketClimbed) {
      return { fired: false, firedKey: dedupe.lastFiredKey, candidates, ctxPct };
    }
  }

  session.turnDedupe.set(input.turnId, { lastFiredKey: key, lastCtxBucket: bucket });

  return {
    fired: true,
    firedKey: key,
    candidates,
    ctxPct,
    message: formatAssessMessage(candidates, input),
  };
}
