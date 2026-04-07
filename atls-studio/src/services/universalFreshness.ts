/**
 * Universal Freshness — shared state taxonomy, identity validation, and execution gating.
 *
 * Governing invariant:
 *   Only artifacts in state=active and authority=current may influence the next mutation.
 *   Everything else may be shown, audited, searched, or summarized — but never used
 *   as the default next action.
 */

export type UniversalState = 'active' | 'historical' | 'superseded' | 'duplicate' | 'distilled';

export interface FreshnessMetadata {
  state: UniversalState;
  sourceIdentity?: string;
  sourceRevision?: string;
  observedRevision?: string;
  supersededBy?: string;
  supersededAt?: number;
  validatedAt?: number;
}

export function isExecutionAuthoritative(meta: FreshnessMetadata): boolean {
  return meta.state === 'active';
}

/**
 * Unified gate: returns true only when the artifact is eligible to steer execution.
 * Accepts a loose shape so callers can pass BB entries, staged snippets, retention entries,
 * or task directives without adapting the object first.
 *
 * Note: `editSessionId` on engrams is for HPP lineage / pool matching, not this gate —
 * steering stays revision- and state-based so hash continuity works across chat sessions.
 */
export function canSteerExecution(artifact: {
  state?: UniversalState | string;
  stageState?: string;
  traceState?: string;
  freshness?: string;
}): boolean {
  if (artifact.state === 'superseded' || artifact.state === 'historical'
    || artifact.state === 'duplicate' || artifact.state === 'distilled') return false;
  if (artifact.stageState === 'stale' || artifact.stageState === 'superseded') return false;
  if (artifact.traceState === 'duplicate' || artifact.traceState === 'distilled') return false;
  if (artifact.freshness === 'suspect' || artifact.freshness === 'changed') return false;
  return true;
}

const BOGUS_PATH_PATTERNS: RegExp[] = [
  /^results\.\d+\./,
  /^content\.\w+\.\d+$/,
  /\{\{.*\}\}/,
];

/**
 * Validate and normalize a file path identity before it enters any store.
 * Returns undefined for bogus / placeholder / empty values.
 */
export function validateSourceIdentity(
  path: string | undefined,
  _workspaceRoots?: string[],
): string | undefined {
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized || normalized === '.' || normalized === '/') return undefined;
  if (BOGUS_PATH_PATTERNS.some(p => p.test(normalized))) return undefined;
  if (!normalized.includes('/') && !normalized.includes('.')) return undefined;
  return normalized;
}
