/**
 * Shared workspace-relative path normalization.
 *
 * Motivation: the model frequently prefixes paths with the monorepo workspace
 * name (e.g. `atls-studio/src/foo.ts`) while runtime reads/writes use
 * workspace-relative paths (`src/foo.ts`). Without a common normalization,
 * the snapshot tracker, intent-lookahead, and FileView bookkeeping silently
 * key the same logical file under two different strings.
 *
 * Design:
 *   - `workspacePathKey(p, { prefixes })` — pure helper; the monorepo prefix
 *     list is supplied by the caller. Lower-cases, flips backslashes to
 *     forward slashes, and strips exactly one matching prefix from the head.
 *   - `workspacePathKeyDefault(p)` — convenience wrapper that pulls prefixes
 *     from the `appStore` project profile (so the workspace layout is the
 *     single source of truth) with a fall-back of `['atls-studio/']` to
 *     preserve legacy behavior when no profile is loaded (e.g. cold start,
 *     unit tests that skip profile setup).
 *
 * Intentional NON-goal: this helper does NOT attempt to resolve symlinks,
 * case-insensitively match Windows roots, or normalize `.` / `..`. Callers
 * with those needs should reach for a richer `normalizeSourcePath`-style
 * pipeline (see `services/batch/handlers/change.ts`).
 */

import { useAppStore } from '../stores/appStore';

export interface WorkspacePathKeyOptions {
  /**
   * Monorepo workspace prefixes to strip from the head of the path.
   * Comparison is case-insensitive and tolerant of trailing slash: both
   * `"atls-studio"` and `"atls-studio/"` strip the same way.
   */
  prefixes?: ReadonlyArray<string>;
}

/** Legacy fallback — mirrors the historical hard-coded behavior in snapshotTracker. */
const LEGACY_DEFAULT_PREFIXES: ReadonlyArray<string> = ['atls-studio/'];

/**
 * Normalize a file path into a stable lookup key, stripping exactly one
 * matching monorepo prefix from the head when present.
 *
 * Returns `''` for non-strings / empty inputs (callers typically treat this
 * as "no match"); never throws.
 */
export function workspacePathKey(
  p: string,
  opts: WorkspacePathKeyOptions = {},
): string {
  if (typeof p !== 'string' || p.length === 0) return '';
  let key = p.replace(/\\/g, '/').trim().toLowerCase();
  if (!key) return '';
  const prefixes = opts.prefixes ?? [];
  for (const raw of prefixes) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const norm = raw.replace(/\\/g, '/').toLowerCase();
    const withSlash = norm.endsWith('/') ? norm : `${norm}/`;
    if (key.startsWith(withSlash)) {
      key = key.slice(withSlash.length);
      break;
    }
  }
  return key;
}

/**
 * Read the monorepo workspace prefixes from the live project profile.
 * Falls back to the legacy default when no profile is loaded so cold-start
 * paths and existing unit tests continue to behave identically.
 */
export function getConfiguredWorkspacePrefixes(): ReadonlyArray<string> {
  try {
    const profile = useAppStore.getState().projectProfile;
    const workspaces = profile?.workspaces;
    if (!workspaces || workspaces.length === 0) return LEGACY_DEFAULT_PREFIXES;
    const out: string[] = [];
    for (const ws of workspaces) {
      const p = ws?.path;
      if (typeof p !== 'string') continue;
      const trimmed = p.trim();
      if (!trimmed || trimmed === '.' || trimmed === './') continue;
      out.push(trimmed);
    }
    return out.length > 0 ? out : LEGACY_DEFAULT_PREFIXES;
  } catch {
    return LEGACY_DEFAULT_PREFIXES;
  }
}

/**
 * Convenience wrapper around {@link workspacePathKey} that uses the
 * configured prefixes from {@link getConfiguredWorkspacePrefixes}. This is
 * what callers in the batch layer (snapshotTracker, intents, …) should use.
 */
export function workspacePathKeyDefault(p: string): string {
  return workspacePathKey(p, { prefixes: getConfiguredWorkspacePrefixes() });
}
