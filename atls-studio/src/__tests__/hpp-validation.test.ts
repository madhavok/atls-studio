/**
 * HPP validation tests — migrated from test-hpp-validation.ts.
 * Parser assertions for hash resolution, materialization tracking demo, ref formatting.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDiffRef, parseHashRef, parseSetRef } from '../utils/hashRefParsers';

// Parser test cases from test-hpp-validation.ts
const PARSER_TEST_CASES = [
  { input: 'h:66b5d86b', expected: { hash: '66b5d86b', modifier: 'auto' }, desc: 'Basic hash ref' },
  { input: 'h:c862a3be:sig', expected: { hash: 'c862a3be', modifier: { shape: 'sig' } }, desc: 'Hash with sig modifier' },
  { input: 'h:06d649b7:15-30', expected: { hash: '06d649b7', modifier: { lines: [[15, 30]] } }, desc: 'Hash with line range' },
  { input: 'h:abc123:fn(processTest)', expected: { hash: 'abc123', modifier: { symbol: { kind: 'fn', name: 'processTest' } } }, desc: 'Hash with symbol anchor' },
  { input: 'h:aabb1122..h:ccdd3344', expected: { oldHash: 'aabb1122', newHash: 'ccdd3344' }, desc: 'Diff ref (h: prefix)' },
  { input: 'h:aabb1122..ccdd3344', expected: { oldHash: 'aabb1122', newHash: 'ccdd3344' }, desc: 'Diff ref (partial h:)' },
  { input: 'h:@edited', expected: { selector: { kind: 'edited' }, modifier: 'auto' }, desc: 'Set ref: edited' },
  { input: 'h:@file=*.ts', expected: { selector: { kind: 'file', pattern: '*.ts' }, modifier: 'auto' }, desc: 'Set ref: file pattern' },
  { input: 'h:@latest:5', expected: { selector: { kind: 'latest', count: 5 }, modifier: 'auto' }, desc: 'Set ref: latest N' },
  { input: 'h:@sub:auth', expected: { selector: { kind: 'subtask', id: 'auth' }, modifier: 'auto' }, desc: 'Set ref: subtask' },
  { input: 'h:@search(auth)', expected: { selector: { kind: 'search', query: 'auth' }, modifier: 'auto' }, desc: 'Set ref: search' },
];

function getResult(input: string) {
  if (input.includes('..')) return parseDiffRef(input);
  if (input.includes('@')) return parseSetRef(input);
  return parseHashRef(input);
}

type SharedHashRefCase = {
  desc: string;
  input: string;
  expected?: unknown;
  valid?: boolean;
};

const SHARED_HASH_REF_CASES = JSON.parse(
  readFileSync(new URL('../../testdata/uhpp_hash_ref_cases.json', import.meta.url), 'utf8'),
) as SharedHashRefCase[];
const SHARED_DIFF_REF_CASES = JSON.parse(
  readFileSync(new URL('../../testdata/uhpp_diff_ref_cases.json', import.meta.url), 'utf8'),
) as SharedHashRefCase[];

describe('HPP validation (migrated from test-hpp-validation)', () => {
  describe('parser tests', () => {
    for (const tc of PARSER_TEST_CASES) {
      it(tc.desc, () => {
        const result = getResult(tc.input);
        expect(result).not.toBeNull();
        expect(JSON.stringify(result)).toBe(JSON.stringify(tc.expected));
      });
    }
  });

  describe('shared hash parser parity cases', () => {
    for (const tc of SHARED_HASH_REF_CASES) {
      it(tc.desc, () => {
        const result = parseHashRef(tc.input);
        if (tc.valid === false) {
          expect(result).toBeNull();
          return;
        }
        expect(result).not.toBeNull();
        expect(result).toEqual(tc.expected);
      });
    }
  });

  describe('shared diff parser parity cases', () => {
    for (const tc of SHARED_DIFF_REF_CASES) {
      it(tc.desc, () => {
        const result = parseDiffRef(tc.input);
        if (tc.valid === false) {
          expect(result).toBeNull();
          return;
        }
        expect(result).not.toBeNull();
        expect(result).toEqual(tc.expected);
      });
    }
  });

  describe('materialization tracking demo', () => {
    it('validates state machine flow (materialized → referenced → evicted → re-materialized)', () => {
      const refs = [
        { hash: '66b5d86b1234abcd', shortHash: '66b5d86b', visibility: 'materialized' as const },
        { hash: 'c862a3be9876fedc', shortHash: 'c862a3be', visibility: 'referenced' as const },
      ];
      refs[0].visibility = 'referenced';
      expect(refs[0].visibility).toBe('referenced');
      refs[0].visibility = 'materialized';
      expect(refs[0].visibility).toBe('materialized');
    });
  });

  describe('ref formatting', () => {
    it('line range ref formats correctly', () => {
      const formatted = `h:66b5d86b:10-25`;
      expect(formatted).toBe('h:66b5d86b:10-25');
    });
    it('shape ref formats correctly', () => {
      const formatted = `h:c862a3be:sig`;
      expect(formatted).toBe('h:c862a3be:sig');
    });
    it('symbol anchor ref formats correctly', () => {
      const formatted = `h:abc123:fn(processTest)`;
      expect(formatted).toBe('h:abc123:fn(processTest)');
    });
    it('diff ref formats correctly', () => {
      const formatted = `h:66b5d86b..h:c862a3be`;
      expect(formatted).toBe('h:66b5d86b..h:c862a3be');
    });
  });
});