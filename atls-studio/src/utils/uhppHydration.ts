/**
 * UHPP Phase 2 — Hydration API
 *
 * Maps the 9 named hydration modes to the existing modifier-based resolution
 * pipeline. Provides cost estimation and a uniform `hydrate(mode, ref)` entry
 * point so callers no longer need to know raw modifier syntax.
 *
 * See: docs/UHPP_PHASE2_DUAL_FORM.md, docs/UHPP_END_STATE_SPEC.md §Hydration
 */

import type { HydrationMode, HydrationResult, HydrationCost } from './uhppCanonical';
import type { HashLookup, HashLookupResult } from './hashResolver';
import { estimateTokens, hashContentSync, generateDigest, generateEditReadyDigest } from './contextHash';
import type { ChunkType, DigestSymbol } from './contextHash';

// ---------------------------------------------------------------------------
// Mode → estimated token multiplier (fraction of full content tokens)
// ---------------------------------------------------------------------------

const MODE_TOKEN_FRACTION: Record<HydrationMode, number> = {
  id_only: 0,
  digest: 0.04,
  edit_ready_digest: 0.06,
  exact_span: 0.15,
  semantic_slice: 0.20,
  neighborhood_pack: 0.60,
  full: 1.0,
  diff_view: 0.30,
  verification_summary: 0.02,
};

const MODE_REQUIRES_BACKEND: Record<HydrationMode, boolean> = {
  id_only: false,
  digest: false,
  edit_ready_digest: false,
  exact_span: false,
  semantic_slice: true,
  neighborhood_pack: true,
  full: false,
  diff_view: true,
  verification_summary: false,
};

const MODE_CACHEABLE: Record<HydrationMode, boolean> = {
  id_only: true,
  digest: true,
  edit_ready_digest: true,
  exact_span: true,
  semantic_slice: true,
  neighborhood_pack: false,
  full: true,
  diff_view: false,
  verification_summary: false,
};

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the token cost of hydrating a ref at each mode.
 * Used by the runtime to pick the cheapest sufficient form.
 */
export function estimateHydrationCosts(fullTokens: number): HydrationCost[] {
  const modes: HydrationMode[] = [
    'id_only', 'digest', 'edit_ready_digest', 'exact_span',
    'semantic_slice', 'neighborhood_pack', 'full', 'diff_view',
    'verification_summary',
  ];
  return modes.map(mode => ({
    mode,
    estimated_tokens: Math.ceil(fullTokens * MODE_TOKEN_FRACTION[mode]),
    requires_backend: MODE_REQUIRES_BACKEND[mode],
    cacheable: MODE_CACHEABLE[mode],
  }));
}

/**
 * Pick the cheapest hydration mode that meets a minimum token threshold.
 * Returns 'full' if no cheaper mode is sufficient.
 */
export function cheapestSufficientMode(
  fullTokens: number,
  minimumTokens: number,
): HydrationMode {
  const ranked: HydrationMode[] = [
    'id_only', 'digest', 'edit_ready_digest', 'exact_span',
    'semantic_slice', 'diff_view', 'neighborhood_pack', 'full',
  ];
  for (const mode of ranked) {
    const est = Math.ceil(fullTokens * MODE_TOKEN_FRACTION[mode]);
    if (est >= minimumTokens) return mode;
  }
  return 'full';
}

// ---------------------------------------------------------------------------
// Core hydration function
// ---------------------------------------------------------------------------

export interface HydrateOptions {
  /** For exact_span mode: line range spec like "15-30" */
  lines?: string;
  /** For semantic_slice mode: symbol name */
  symbolName?: string;
  /** For semantic_slice mode: symbol kind (fn, cls, etc.) */
  symbolKind?: string;
  /** For diff_view mode: the other ref to diff against */
  diffRef?: string;
  /** Symbol data for digest modes (avoids re-parsing) */
  symbols?: DigestSymbol[];
  /** Content type hint for digest generation */
  contentType?: string;
}

/**
 * Hydrate a hash reference at the specified mode.
 *
 * This is the canonical entry point for mode-driven resolution.
 * For modes that require backend resolution (semantic_slice, neighborhood_pack,
 * diff_view), this function produces the content from available frontend data
 * or throws with a message indicating backend resolution is needed.
 */
export async function hydrate(
  mode: HydrationMode,
  hash: string,
  lookup: HashLookup,
  options: HydrateOptions = {},
): Promise<HydrationResult> {
  const base: Omit<HydrationResult, 'content' | 'token_estimate'> = {
    ref: `h:${hash}`,
    mode,
  };

  if (mode === 'id_only') {
    return { ...base, content: hash, token_estimate: 1 };
  }

  const entry = await lookup(hash);
  if (!entry) {
    throw new Error(`hydrate: h:${hash} not found — content may have been evicted`);
  }

  switch (mode) {
    case 'digest': {
      const digest = generateDigest(
        entry.content,
        (options.contentType ?? 'file') as ChunkType,
        options.symbols,
      );
      const content = digest || `[no digest available for h:${hash}]`;
      return {
        ...base,
        content,
        content_hash: hashContentSync(content),
        token_estimate: estimateTokens(content),
      };
    }

    case 'edit_ready_digest': {
      const digest = generateEditReadyDigest(
        entry.content,
        (options.contentType ?? 'file') as ChunkType,
        options.symbols,
      );
      const content = digest || `[no edit-ready digest for h:${hash}]`;
      return {
        ...base,
        content,
        content_hash: hashContentSync(content),
        token_estimate: estimateTokens(content),
      };
    }

    case 'exact_span': {
      if (!options.lines) {
        throw new Error('hydrate(exact_span) requires options.lines');
      }
      const content = sliceLines(entry.content, options.lines);
      return {
        ...base,
        content,
        content_hash: hashContentSync(content),
        token_estimate: estimateTokens(content),
      };
    }

    case 'full': {
      return {
        ...base,
        content: entry.content,
        content_hash: hashContentSync(entry.content),
        token_estimate: estimateTokens(entry.content),
      };
    }

    case 'semantic_slice':
      throw new Error(
        `hydrate(semantic_slice) requires backend resolution — ` +
        `use h:${hash}:${options.symbolKind ?? 'fn'}(${options.symbolName ?? '?'}) via batch`,
      );

    case 'neighborhood_pack':
      throw new Error(
        'hydrate(neighborhood_pack) requires backend resolution — not yet implemented',
      );

    case 'diff_view':
      throw new Error(
        `hydrate(diff_view) requires backend resolution — ` +
        `use h:${hash}..h:${options.diffRef ?? '?'} via batch`,
      );

    case 'verification_summary':
      throw new Error(
        'hydrate(verification_summary) requires structured VerificationResult data',
      );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple line slicer for exact_span mode (1-indexed, inclusive). */
function sliceLines(content: string, linesSpec: string): string {
  const lines = content.split('\n');
  const total = lines.length;
  const output: string[] = [];

  for (const part of linesSpec.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const dashIdx = trimmed.indexOf('-');
    if (dashIdx >= 0) {
      const start = parseInt(trimmed.slice(0, dashIdx), 10);
      const endStr = trimmed.slice(dashIdx + 1);
      const end = endStr ? parseInt(endStr, 10) : total;
      if (isNaN(start) || start < 1) continue;
      const actualEnd = isNaN(end) ? total : Math.min(end, total);
      for (let i = start - 1; i < actualEnd; i++) {
        output.push(lines[i] ?? '');
      }
    } else {
      const line = parseInt(trimmed, 10);
      if (!isNaN(line) && line >= 1 && line <= total) {
        output.push(lines[line - 1] ?? '');
      }
    }
  }
  return output.join('\n');
}

/**
 * Check whether a mode can be resolved purely on the frontend.
 */
export function isFrontendResolvable(mode: HydrationMode): boolean {
  return !MODE_REQUIRES_BACKEND[mode];
}
