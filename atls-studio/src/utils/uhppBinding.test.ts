import { describe, it, expect } from 'vitest';
import {
  getOperationProfile,
  classifyOperation,
  extractTargetRefs,
  inferTargetKind,
  scoreToConfidence,
  aggregateConfidence,
  detectAmbiguity,
  rankCandidates,
  candidatesFromPreflight,
  produceBindingResult,
  needsBinding,
} from './uhppBinding';
import type {
  CandidateTarget,
  BindingConfidence,
} from './uhppCanonical';

// ---------------------------------------------------------------------------
// classifyOperation
// ---------------------------------------------------------------------------

describe('classifyOperation', () => {
  it('classifies known operations correctly', () => {
    expect(classifyOperation('search.code')).toBe('discover');
    expect(classifyOperation('read.context')).toBe('understand');
    expect(classifyOperation('analyze.deps')).toBe('understand');
    expect(classifyOperation('change.edit')).toBe('mutate');
    expect(classifyOperation('change.refactor')).toBe('mutate');
    expect(classifyOperation('verify.build')).toBe('verify');
    expect(classifyOperation('session.plan')).toBe('session');
    expect(classifyOperation('delegate.retrieve')).toBe('delegate');
    expect(classifyOperation('system.exec')).toBe('system');
  });

  it('falls back to prefix-based classification for unknown ops', () => {
    expect(classifyOperation('search.unknown')).toBe('discover');
    expect(classifyOperation('change.new_thing')).toBe('mutate');
    expect(classifyOperation('verify.custom')).toBe('verify');
  });

  it('returns system for completely unknown prefix', () => {
    expect(classifyOperation('foo.bar')).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// getOperationProfile
// ---------------------------------------------------------------------------

describe('getOperationProfile', () => {
  it('returns profile for known operations', () => {
    const profile = getOperationProfile('change.edit');
    expect(profile.family).toBe('mutate');
    expect(profile.requires_target).toBe(true);
    expect(profile.min_hydration).toBe('edit_ready_digest');
    expect(profile.default_verification).toContain('freshness');
    expect(profile.eligible_target_kinds).toContain('file');
    expect(profile.eligible_target_kinds).toContain('symbol');
  });

  it('returns profile for verify ops (no targets needed)', () => {
    const profile = getOperationProfile('verify.build');
    expect(profile.requires_target).toBe(false);
    expect(profile.eligible_target_kinds).toEqual([]);
  });

  it('returns fallback profile for unknown ops', () => {
    const profile = getOperationProfile('unknown.thing');
    expect(profile.family).toBe('discover');
    expect(profile.requires_target).toBe(false);
  });

  it('change.refactor requires typecheck verification', () => {
    const profile = getOperationProfile('change.refactor');
    expect(profile.default_verification).toContain('typecheck');
    expect(profile.default_verification).toContain('structural');
  });
});

// ---------------------------------------------------------------------------
// extractTargetRefs
// ---------------------------------------------------------------------------

describe('extractTargetRefs', () => {
  it('extracts file from params', () => {
    expect(extractTargetRefs({ file: 'src/foo.ts' })).toEqual(['src/foo.ts']);
  });

  it('extracts file_path from params', () => {
    expect(extractTargetRefs({ file_path: 'src/bar.ts' })).toEqual(['src/bar.ts']);
  });

  it('extracts file_paths array', () => {
    expect(extractTargetRefs({ file_paths: ['a.ts', 'b.ts'] })).toEqual(['a.ts', 'b.ts']);
  });

  it('extracts from edits array', () => {
    const result = extractTargetRefs({
      edits: [
        { file: 'src/x.ts', content: '...' },
        { file: 'src/y.ts', content: '...' },
      ],
    });
    expect(result).toContain('src/x.ts');
    expect(result).toContain('src/y.ts');
  });

  it('deduplicates refs', () => {
    const result = extractTargetRefs({
      file: 'src/x.ts',
      file_path: 'src/x.ts',
    });
    expect(result).toEqual(['src/x.ts']);
  });

  it('extracts hash refs from hashes array', () => {
    expect(extractTargetRefs({ hashes: ['h:abc123', 'h:def456'] }))
      .toEqual(['h:abc123', 'h:def456']);
  });

  it('returns empty for no targets', () => {
    expect(extractTargetRefs({ query: 'search term' })).toEqual([]);
  });

  it('extracts from creates array', () => {
    const result = extractTargetRefs({
      creates: [{ file: 'new.ts', content: '...' }],
    });
    expect(result).toEqual(['new.ts']);
  });
});

// ---------------------------------------------------------------------------
// inferTargetKind
// ---------------------------------------------------------------------------

describe('inferTargetKind', () => {
  it('identifies hash refs as symbol targets', () => {
    expect(inferTargetKind('h:abc123')).toBe('symbol');
  });

  it('identifies literal paths as file targets', () => {
    expect(inferTargetKind('src/foo.ts')).toBe('file');
  });

  it('identifies refs with line numbers as exact_span', () => {
    expect(inferTargetKind('src/foo.ts:15')).toBe('exact_span');
  });
});

// ---------------------------------------------------------------------------
// scoreToConfidence
// ---------------------------------------------------------------------------

describe('scoreToConfidence', () => {
  it('maps high scores', () => {
    expect(scoreToConfidence(1.0)).toBe('high');
    expect(scoreToConfidence(0.8)).toBe('high');
  });

  it('maps medium scores', () => {
    expect(scoreToConfidence(0.7)).toBe('medium');
    expect(scoreToConfidence(0.5)).toBe('medium');
  });

  it('maps low scores', () => {
    expect(scoreToConfidence(0.3)).toBe('low');
    expect(scoreToConfidence(0.2)).toBe('low');
  });

  it('maps none for zero', () => {
    expect(scoreToConfidence(0.0)).toBe('none');
    expect(scoreToConfidence(0.1)).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// aggregateConfidence
// ---------------------------------------------------------------------------

describe('aggregateConfidence', () => {
  it('returns high for empty array', () => {
    expect(aggregateConfidence([])).toBe('high');
  });

  it('returns the minimum confidence', () => {
    expect(aggregateConfidence(['high', 'high'])).toBe('high');
    expect(aggregateConfidence(['high', 'medium'])).toBe('medium');
    expect(aggregateConfidence(['high', 'low'])).toBe('low');
    expect(aggregateConfidence(['medium', 'none'])).toBe('none');
  });

  it('handles single element', () => {
    expect(aggregateConfidence(['low'])).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// detectAmbiguity
// ---------------------------------------------------------------------------

describe('detectAmbiguity', () => {
  const makeCandidate = (conf: BindingConfidence, score: number): CandidateTarget => ({
    ref: 'h:test',
    target_kind: 'file',
    confidence: conf,
    confidence_score: score,
    match_reason: 'test',
  });

  it('returns unresolved for empty candidates', () => {
    expect(detectAmbiguity([])).toBe('unresolved');
  });

  it('returns unambiguous for single candidate', () => {
    expect(detectAmbiguity([makeCandidate('high', 0.9)])).toBe('unambiguous');
  });

  it('returns unambiguous if exactly one high-confidence candidate', () => {
    expect(detectAmbiguity([
      makeCandidate('high', 0.9),
      makeCandidate('low', 0.2),
    ])).toBe('unambiguous');
  });

  it('returns multiple_candidates if multiple high-confidence', () => {
    expect(detectAmbiguity([
      makeCandidate('high', 0.9),
      makeCandidate('high', 0.85),
    ])).toBe('multiple_candidates');
  });

  it('returns partial if no high-confidence candidates', () => {
    expect(detectAmbiguity([
      makeCandidate('medium', 0.6),
      makeCandidate('medium', 0.5),
    ])).toBe('partial');
  });
});

// ---------------------------------------------------------------------------
// rankCandidates
// ---------------------------------------------------------------------------

describe('rankCandidates', () => {
  it('sorts by confidence_score descending', () => {
    const candidates: CandidateTarget[] = [
      { ref: 'a', target_kind: 'file', confidence: 'low', confidence_score: 0.3, match_reason: 'x' },
      { ref: 'b', target_kind: 'file', confidence: 'high', confidence_score: 0.95, match_reason: 'y' },
      { ref: 'c', target_kind: 'file', confidence: 'medium', confidence_score: 0.6, match_reason: 'z' },
    ];
    const ranked = rankCandidates(candidates);
    expect(ranked[0]!.ref).toBe('b');
    expect(ranked[1]!.ref).toBe('c');
    expect(ranked[2]!.ref).toBe('a');
  });

  it('does not mutate input array', () => {
    const original: CandidateTarget[] = [
      { ref: 'a', target_kind: 'file', confidence: 'low', confidence_score: 0.3, match_reason: 'x' },
      { ref: 'b', target_kind: 'file', confidence: 'high', confidence_score: 0.95, match_reason: 'y' },
    ];
    rankCandidates(original);
    expect(original[0]!.ref).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// candidatesFromPreflight
// ---------------------------------------------------------------------------

describe('candidatesFromPreflight', () => {
  it('produces candidates from preflight decisions', () => {
    const result = candidatesFromPreflight(
      {
        confidence: 'high',
        strategy: 'fresh',
        blocked: false,
        warnings: [],
        decisions: [{
          ref: 'h:abc123',
          source: 'src/foo.ts',
          classification: 'fresh',
          confidence: 'high',
          factors: ['revision_match'],
        }],
      },
      ['h:abc123'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.ref).toBe('h:abc123');
    expect(result[0]!.confidence).toBe('high');
    expect(result[0]!.source_path).toBe('src/foo.ts');
    expect(result[0]!.match_reason).toContain('fresh');
  });

  it('falls back to raw refs when no decisions', () => {
    const result = candidatesFromPreflight(
      {
        confidence: 'medium',
        strategy: 'symbol_identity',
        blocked: false,
        warnings: [],
        decisions: [],
      },
      ['src/bar.ts'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.ref).toBe('src/bar.ts');
    expect(result[0]!.confidence).toBe('medium');
  });

  it('marks blocked preflights in match_reason', () => {
    const result = candidatesFromPreflight(
      {
        confidence: 'none',
        strategy: 'blocked',
        blocked: true,
        warnings: ['stale hash'],
        decisions: [],
      },
      ['src/stale.ts'],
    );
    expect(result[0]!.match_reason).toBe('blocked_by_preflight');
  });
});

// ---------------------------------------------------------------------------
// produceBindingResult
// ---------------------------------------------------------------------------

describe('produceBindingResult', () => {
  it('produces a complete binding result for a change.edit', () => {
    const result = produceBindingResult({
      step_id: 's1',
      operation: 'change.edit',
      params: { file: 'src/main.ts' },
    });
    expect(result.step_id).toBe('s1');
    expect(result.requested_operation).toBe('change.edit');
    expect(result.operation_family).toBe('mutate');
    expect(result.resolved_targets).toHaveLength(1);
    expect(result.resolved_targets[0]!.ref).toBe('src/main.ts');
    expect(result.confidence).toBe('high');
    expect(result.ambiguity_status).toBe('unambiguous');
    expect(result.required_hydration).toBe('edit_ready_digest');
    expect(result.required_verification).toContain('freshness');
  });

  it('warns when targets have mismatched kinds', () => {
    const result = produceBindingResult({
      step_id: 's2',
      operation: 'change.delete',
      params: { target: 'h:abc123' },
    });
    expect(result.warnings.some(w => w.includes('target_kind_mismatch'))).toBe(true);
  });

  it('warns when operation requires targets but none found', () => {
    const result = produceBindingResult({
      step_id: 's3',
      operation: 'change.edit',
      params: { query: 'something' },
    });
    expect(result.warnings).toContain('no_targets_resolved');
    expect(result.resolved_targets).toHaveLength(0);
  });

  it('incorporates preflight data', () => {
    const result = produceBindingResult({
      step_id: 's4',
      operation: 'change.edit',
      params: { file: 'src/x.ts' },
      preflight: {
        confidence: 'medium',
        strategy: 'symbol_identity',
        blocked: false,
        warnings: ['line drift detected'],
        decisions: [{
          ref: 'src/x.ts',
          source: 'src/x.ts',
          classification: 'rebaseable',
          confidence: 'medium',
          factors: ['symbol_identity'],
        }],
      },
    });
    expect(result.confidence).toBe('medium');
    expect(result.warnings).toContain('line drift detected');
  });

  it('produces binding for discover ops with no targets', () => {
    const result = produceBindingResult({
      step_id: 's5',
      operation: 'search.code',
      params: { query: 'auth' },
    });
    expect(result.operation_family).toBe('discover');
    expect(result.resolved_targets).toHaveLength(0);
    expect(result.confidence).toBe('high');
    expect(result.ambiguity_status).toBe('unresolved');
    expect(result.warnings).toHaveLength(0);
  });

  it('detects ambiguity with multiple hash targets', () => {
    const result = produceBindingResult({
      step_id: 's6',
      operation: 'change.edit',
      params: { hashes: ['h:abc', 'h:def', 'h:ghi'] },
    });
    expect(result.resolved_targets).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// needsBinding
// ---------------------------------------------------------------------------

describe('needsBinding', () => {
  it('returns false for ops that do not require targets', () => {
    expect(needsBinding('search.code', { query: 'test' })).toBe(false);
    expect(needsBinding('verify.build', {})).toBe(false);
  });

  it('returns true for mutating ops with literal paths', () => {
    expect(needsBinding('change.edit', { file: 'src/foo.ts' })).toBe(true);
  });

  it('returns true for read ops with hash refs', () => {
    expect(needsBinding('read.context', { hashes: ['h:abc123'] })).toBe(true);
  });

  it('returns false for read ops with only literal paths', () => {
    expect(needsBinding('read.context', { file: 'src/foo.ts' })).toBe(false);
  });

  it('returns false when params have no target fields', () => {
    expect(needsBinding('change.edit', { content: 'hello' })).toBe(false);
  });
});
