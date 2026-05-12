/**
 * Structural payload efficiency: verbose keys, redundant hashes, default noise,
 * duplicate nested blocks, inconsistent naming. Uses `estimateTokens` (same heuristic
 * as production metrics). For BPE-level numbers on the same string literals, run
 * `cargo test bpe_structural_` in `src-tauri`.
 */
import { describe, expect, it } from 'vitest';

import { CONTEXT_CONTROL, CONTEXT_CONTROL_V2 } from '../prompts/cognitiveCore';
import { EDIT_DISCIPLINE, EDIT_DISCIPLINE_V2 } from '../prompts/editDiscipline';
import { HASH_PROTOCOL_CORE, HASH_PROTOCOL_CORE_V2 } from '../prompts/hashProtocol';
import { getModePrompt } from '../prompts/modePrompts';
import { BATCH_TOOL_REF, BATCH_TOOL_REF_V2 } from '../prompts/toolRef';
import { estimateTokens } from './contextHash';
import { logTokenDelta } from './toonDeltaTestHelpers';
import { toTOON } from './toon';
import {
  BPE_COMPACT_DEFAULTS_JSON,
  BPE_COMPACT_KEYS_JSON,
  BPE_DUPLICATE_NESTED_JSON,
  BPE_NAMING_REFERENCES_JSON,
  BPE_NAMING_REFS_JSON,
  BPE_SINGLE_HASH_JSON,
  BPE_SINGLE_NESTED_JSON,
  BPE_TRIPLE_HASH_JSON,
  BPE_VERBOSE_DEFAULTS_JSON,
  BPE_VERBOSE_KEYS_JSON,
} from './payloadStructuralFixtures';

function logStructuralDelta(label: string, baseline: string, improved: string, improvedLabel = 'compact') {
  return logTokenDelta(`struct: ${label}`, baseline, improved, improvedLabel);
}

describe('payload structural efficiency (heuristic tokens)', () => {
  it('verbose snake_case keys vs short keys (same semantics)', () => {
    const { jsonTok, altTok } = logStructuralDelta(
      'result keys (file/content_hash vs f/h)',
      BPE_VERBOSE_KEYS_JSON,
      BPE_COMPACT_KEYS_JSON,
    );
    expect(altTok).toBeLessThan(jsonTok);
  });

  it('triple hash identity vs single h ref', () => {
    const { jsonTok, altTok } = logStructuralDelta(
      'h+content_hash vs h+file (no duplicate hex)',
      BPE_TRIPLE_HASH_JSON,
      BPE_SINGLE_HASH_JSON,
    );
    expect(altTok).toBeLessThan(jsonTok);
  });

  it('explicit defaults + empty arrays vs omitted', () => {
    const { jsonTok, altTok } = logStructuralDelta(
      'git-style defaults (false/0/[]) vs minimal',
      BPE_VERBOSE_DEFAULTS_JSON,
      BPE_COMPACT_DEFAULTS_JSON,
    );
    expect(altTok).toBeLessThan(jsonTok);
  });

  it('extract_plan-style duplicate nested block vs modules only', () => {
    const { jsonTok, altTok } = logStructuralDelta(
      'proposed_modules + extract_methods_params mirror',
      BPE_DUPLICATE_NESTED_JSON,
      BPE_SINGLE_NESTED_JSON,
    );
    expect(altTok).toBeLessThan(jsonTok);
  });

  it('inconsistent naming: total_references vs total_refs (same counts)', () => {
    const { jsonTok, altTok } = logStructuralDelta(
      'total_references vs total_refs',
      BPE_NAMING_REFERENCES_JSON,
      BPE_NAMING_REFS_JSON,
    );
    expect(altTok).toBeLessThan(jsonTok);
  });

  it('prompt surfaces: BATCH_TOOL_REF + EDIT_DISCIPLINE token budget (per turn)', () => {
    const batchTok = estimateTokens(BATCH_TOOL_REF);
    const editTok = estimateTokens(EDIT_DISCIPLINE);
    const combined = batchTok + editTok;
    console.log(
      `[struct payload] prompt surfaces | BATCH_TOOL_REF: ${BATCH_TOOL_REF.length} ch / ${batchTok} tok | EDIT_DISCIPLINE: ${EDIT_DISCIPLINE.length} ch / ${editTok} tok | combined: ${combined} tok (heuristic; sent every turn with system bundle)`,
    );
    expect(batchTok).toBeGreaterThan(0);
    expect(editTok).toBeGreaterThan(0);
  });

  it('agent v2 prompt surfaces are smaller than v1 shared agent surfaces', () => {
    const v1 = [
      getModePrompt('agent'),
      BATCH_TOOL_REF,
      EDIT_DISCIPLINE,
      CONTEXT_CONTROL,
      HASH_PROTOCOL_CORE,
    ].join('\n');
    const v2 = [
      getModePrompt('agent', { agentPromptVersion: 'v2' }),
      BATCH_TOOL_REF_V2,
      EDIT_DISCIPLINE_V2,
      CONTEXT_CONTROL_V2,
      HASH_PROTOCOL_CORE_V2,
    ].join('\n');
    const v1Tok = estimateTokens(v1);
    const v2Tok = estimateTokens(v2);
    console.log(
      `[struct payload] agent prompt surfaces | v1: ${v1.length} ch / ${v1Tok} tok | v2: ${v2.length} ch / ${v2Tok} tok | Δ ${v1Tok - v2Tok} tok (${(((v1Tok - v2Tok) / v1Tok) * 100).toFixed(1)}%)`,
    );
    expect(v2Tok).toBeGreaterThan(0);
    expect(v2Tok).toBeLessThan(v1Tok);
  });

  it('TOON omits null/empty string but still serializes false and 0 (potential future omission)', () => {
    const withNoise = { ok: true, clean: false, ahead: 0, staged: [] as string[] };
    const minimal = { ok: true };
    const tNoise = estimateTokens(toTOON(withNoise));
    const tMin = estimateTokens(toTOON(minimal));
    logTokenDelta(
      'struct: TOON false/0/[] vs minimal same facts',
      toTOON(withNoise),
      toTOON(minimal),
      'minimal TOON',
    );
    expect(tMin).toBeLessThan(tNoise);
  });
});
