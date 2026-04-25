import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyVerifyResult, didVerifyPass, handleVerifyBuild } from './verify';
import { useRetentionStore } from '../../../stores/retentionStore';

describe('didVerifyPass', () => {
  it('prefers backend success over missing has_errors', () => {
    expect(didVerifyPass({ success: false })).toBe(false);
    expect(didVerifyPass({ success: true })).toBe(true);
  });

  it('does not treat missing has_errors as a pass', () => {
    expect(didVerifyPass({ summary: 'no flags present' })).toBe(false);
  });

  it('falls back to legacy flags when status is unknown', () => {
    expect(didVerifyPass({ status: 'unknown', success: true })).toBe(true);
    expect(didVerifyPass({ status: 'unknown', passed: true })).toBe(true);
    expect(didVerifyPass({ status: 'unknown', has_errors: true })).toBe(false);
    expect(classifyVerifyResult({ status: 'unknown', success: true })).toEqual({
      passed: true,
      classification: 'pass',
    });
  });
});

describe('handleVerifyBuild', () => {
  beforeEach(() => {
    useRetentionStore.getState().reset();
  });

  it('returns a failed verify_result with h:ref when backend success is false', async () => {
    const out = await handleVerifyBuild(
      {},
      {
        atlsBatchQuery: async () => ({ success: false, summary: 'build failed' }),
        store: () => ({
          addChunk: () => 'abc123',
        }),
      } as Parameters<typeof handleVerifyBuild>[1],
    );

    expect(out.ok).toBe(false);
    expect(out.refs).toContain('h:abc123');
    expect(out.summary).toContain('verify.build');
    expect(out.summary).toContain('failed');
    expect(out.summary).toContain('h:abc123');
  });

  it('returns a passed verify_result with h:ref when backend success is true', async () => {
    const out = await handleVerifyBuild(
      {},
      {
        atlsBatchQuery: async () => ({ success: true, summary: 'build passed' }),
        store: () => ({
          addChunk: () => 'def456',
        }),
      } as Parameters<typeof handleVerifyBuild>[1],
    );

    expect(out.ok).toBe(true);
    expect(out.refs).toContain('h:def456');
    expect(out.summary).toContain('passed');
  });
});
