/**
 * Spin Diagnostics — per-round semantic fingerprint accumulator.
 *
 * Collects tool signatures, target files, BB deltas, WM churn, hash ref usage,
 * and steering signals during each agent round. The accumulated fingerprint is
 * merged into the RoundSnapshot at capture time, enabling post-hoc spin analysis
 * and early-warning injection.
 *
 * Thread model: single writer (aiService tool loop), reset at round start.
 */

import { hashContentSync } from '../utils/contextHash';

// ---------------------------------------------------------------------------
// Round Fingerprint — accumulated during a single tool-loop round
// ---------------------------------------------------------------------------

export interface RoundFingerprint {
  toolSignature: string[];
  targetFiles: string[];
  bbDelta: string[];
  wmDelta: number;
  hashRefsConsumed: string[];
  hashRefsEvicted: string[];
  assistantTextHash: string;
  steeringInjected: string[];
}

let _current: RoundFingerprint = emptyFingerprint();

function emptyFingerprint(): RoundFingerprint {
  return {
    toolSignature: [],
    targetFiles: [],
    bbDelta: [],
    wmDelta: 0,
    hashRefsConsumed: [],
    hashRefsEvicted: [],
    assistantTextHash: '',
    steeringInjected: [],
  };
}

export function resetRoundFingerprint(): void {
  _current = emptyFingerprint();
}

export function getRoundFingerprint(): Readonly<RoundFingerprint> {
  return _current;
}

// ---------------------------------------------------------------------------
// Accumulation methods — called from aiService / executor / middleware
// ---------------------------------------------------------------------------

/** Record tool names from batch step results. */
export function recordToolSignature(toolNames: string[]): void {
  for (const name of toolNames) {
    _current.toolSignature.push(name);
  }
}

/** Record file paths touched by tool calls this round. */
export function recordTargetFiles(paths: string[]): void {
  const seen = new Set(_current.targetFiles);
  for (const p of paths) {
    const normalized = p.replace(/\\/g, '/');
    if (!seen.has(normalized)) {
      seen.add(normalized);
      _current.targetFiles.push(normalized);
    }
  }
}

/** Record BB keys written/updated. */
export function recordBbDelta(keys: string[]): void {
  for (const k of keys) {
    if (!_current.bbDelta.includes(k)) {
      _current.bbDelta.push(k);
    }
  }
}

/** Record net pin/unpin delta. Positive = pins added, negative = unpins. */
export function recordWmDelta(delta: number): void {
  _current.wmDelta += delta;
}

/** Record hash refs the model referenced in tool params. */
export function recordHashRefsConsumed(refs: string[]): void {
  const seen = new Set(_current.hashRefsConsumed);
  for (const r of refs) {
    const short = r.startsWith('h:') ? r.slice(0, 8) : r.slice(0, 6);
    if (!seen.has(short)) {
      seen.add(short);
      _current.hashRefsConsumed.push(short);
    }
  }
}

/** Record hash refs evicted by history compression this round. */
export function recordHashRefsEvicted(refs: string[]): void {
  const seen = new Set(_current.hashRefsEvicted);
  for (const r of refs) {
    const short = r.startsWith('h:') ? r.slice(0, 8) : r.slice(0, 6);
    if (!seen.has(short)) {
      seen.add(short);
      _current.hashRefsEvicted.push(short);
    }
  }
}

/** Compute and store a short hash of assistant visible text. */
export function recordAssistantTextHash(text: string): void {
  if (!text.trim()) {
    _current.assistantTextHash = '';
    return;
  }
  const full = hashContentSync(text.trim());
  _current.assistantTextHash = full.slice(0, 8);
}

/** Record which <<SYSTEM:...>> steering blocks were injected. */
export function recordSteeringInjected(blocks: string[]): void {
  _current.steeringInjected = blocks;
}

// ---------------------------------------------------------------------------
// Extraction helpers — extract file paths and hash refs from batch results
// ---------------------------------------------------------------------------

const HASH_REF_PATTERN = /\bh:[0-9a-f]{4,16}/gi;

/** Extract h:XXXX references from a string. */
export function extractHashRefs(text: string): string[] {
  const matches = text.match(HASH_REF_PATTERN);
  if (!matches) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    const short = m.slice(0, 8);
    if (!seen.has(short)) {
      seen.add(short);
      result.push(short);
    }
  }
  return result;
}

/** Extract file paths from batch step results. */
export function extractTargetFilesFromStepResults(
  stepResults: Array<{ use: string; ok: boolean; artifacts?: Record<string, unknown>; summary?: string }>,
): string[] {
  const paths: string[] = [];
  for (const step of stepResults) {
    if (!step.ok) continue;
    const arts = step.artifacts;
    if (!arts) continue;

    if (typeof arts.file === 'string') paths.push(arts.file);
    if (typeof arts.path === 'string') paths.push(arts.path);
    if (typeof arts.file_path === 'string') paths.push(arts.file_path);
    if (typeof arts.source === 'string' && arts.source.includes('/')) paths.push(arts.source);

    const drafts = (arts.drafts ?? arts.results ?? arts.batch) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(drafts)) {
      for (const d of drafts) {
        const f = (d.f ?? d.file ?? d.path ?? d.file_path) as string | undefined;
        if (f) paths.push(f);
      }
    }

    if (Array.isArray(arts.file_paths)) {
      for (const fp of arts.file_paths) {
        if (typeof fp === 'string') paths.push(fp);
      }
    }
  }
  return paths;
}

/** Extract BB keys written from batch step results. */
export function extractBbDeltaFromStepResults(
  stepResults: Array<{ use: string; ok: boolean; summary?: string }>,
  batchArgs?: Record<string, unknown>,
): string[] {
  const keys: string[] = [];
  const steps = Array.isArray(batchArgs?.steps) ? batchArgs.steps as Array<Record<string, unknown>> : [];

  for (let i = 0; i < stepResults.length; i++) {
    const step = stepResults[i];
    if (!step.ok || step.use !== 'session.bb.write') continue;
    const matchingStep = steps.find(s => String(s?.id ?? '') === (step as { id?: string }).id) ?? steps[i];
    const w = matchingStep?.with as Record<string, unknown> | undefined;
    const key = w?.key as string | undefined;
    if (key) keys.push(key);
  }
  return keys;
}

/** Extract <<SYSTEM:...>> steering blocks from a dynamic context string. */
export function extractSteeringBlocks(dynamicContext: string): string[] {
  const blocks: string[] = [];
  const pattern = /<<SYSTEM:[^>]*>>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(dynamicContext)) !== null) {
    blocks.push(match[0]);
  }
  const damaged = /<<DAMAGED EDIT:[^>]*>>/g;
  while ((match = damaged.exec(dynamicContext)) !== null) {
    blocks.push(match[0]);
  }
  const escalated = /<<ESCALATED REPAIR:[^>]*>>/g;
  while ((match = escalated.exec(dynamicContext)) !== null) {
    blocks.push(match[0]);
  }
  return blocks;
}
