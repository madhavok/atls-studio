import { describe, expect, it } from 'vitest';
import { hashBp3Prefix, computeLogicalBp3Hit, computeLogicalStaticHit } from './logicalCacheMetrics';

describe('hashBp3Prefix', () => {
  it('returns a stable hash for the same input', () => {
    const history = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'how are you' },
    ];
    const h1 = hashBp3Prefix(history, 2);
    const h2 = hashBp3Prefix(history, 2);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns different hashes for different prefixes', () => {
    const history = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'more' },
    ];
    const h1 = hashBp3Prefix(history, 1);
    const h2 = hashBp3Prefix(history, 2);
    expect(h1).not.toBe(h2);
  });

  it('supports subPrefixLength for append detection', () => {
    const history = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'more' },
    ];
    const fullHash = hashBp3Prefix(history, 2);
    const subHash = hashBp3Prefix(history, 3, 2);
    expect(subHash).toBe(fullHash);
  });
});

describe('computeLogicalBp3Hit', () => {
  it('returns miss on first request (null prev)', () => {
    const result = computeLogicalBp3Hit(null, { hash: 'abc', length: 2 });
    expect(result.hit).toBe(false);
    expect(result.reason).toBe('first request');
  });

  it('returns hit when same length and same hash (identical)', () => {
    const snapshot = { hash: 'abc123def456', length: 3 };
    const result = computeLogicalBp3Hit(snapshot, snapshot);
    expect(result.hit).toBe(true);
    expect(result.reason).toBe('identical');
  });

  it('returns miss when same length but different hash (prefix edited)', () => {
    const prev = { hash: 'abc123def456', length: 3 };
    const curr = { hash: 'xyz789uvw012', length: 3 };
    const result = computeLogicalBp3Hit(prev, curr);
    expect(result.hit).toBe(false);
    expect(result.reason).toBe('prefix edited');
  });

  it('returns hit when append-only (longer curr, sub-prefix matches)', () => {
    const prev = { hash: 'abc123def456', length: 3 };
    const curr = { hash: 'full5678hash', length: 5 };
    const result = computeLogicalBp3Hit(prev, curr, 'abc123def456');
    expect(result.hit).toBe(true);
    expect(result.reason).toBe('append-only');
  });

  it('returns miss when append but sub-prefix hash differs (prefix edited)', () => {
    const prev = { hash: 'abc123def456', length: 3 };
    const curr = { hash: 'full5678hash', length: 5 };
    const result = computeLogicalBp3Hit(prev, curr, 'different_hash');
    expect(result.hit).toBe(false);
    expect(result.reason).toBe('prefix edited');
  });

  it('returns miss when prefix shrunk', () => {
    const prev = { hash: 'abc123def456', length: 5 };
    const curr = { hash: 'abc123def456', length: 3 };
    const result = computeLogicalBp3Hit(prev, curr);
    expect(result.hit).toBe(false);
    expect(result.reason).toBe('prefix shrunk');
  });
});

describe('computeLogicalStaticHit', () => {
  it('returns miss on first request (null prev)', () => {
    const result = computeLogicalStaticHit(null, 'agent|linux|bash|/home');
    expect(result.hit).toBe(false);
    expect(result.reason).toBe('first request');
  });

  it('returns hit when key is unchanged', () => {
    const key = 'agent|linux|bash|/home|true|anthropic||sigs';
    const result = computeLogicalStaticHit(key, key);
    expect(result.hit).toBe(true);
    expect(result.reason).toBe('unchanged');
  });

  it('returns miss when key changes', () => {
    const prev = 'agent|linux|bash|/home|true|anthropic||sigs';
    const curr = 'ask|linux|bash|/home|true|anthropic||sigs';
    const result = computeLogicalStaticHit(prev, curr);
    expect(result.hit).toBe(false);
    expect(result.reason).toBe('static config changed');
  });
});
