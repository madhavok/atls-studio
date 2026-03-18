import { describe, expect, it } from 'vitest';
import { didVerifyPass, handleVerifyBuild } from './verify';

describe('didVerifyPass', () => {
  it('prefers backend success over missing has_errors', () => {
    expect(didVerifyPass({ success: false })).toBe(false);
    expect(didVerifyPass({ success: true })).toBe(true);
  });

  it('does not treat missing has_errors as a pass', () => {
    expect(didVerifyPass({ summary: 'no flags present' })).toBe(false);
  });
});

describe('handleVerifyBuild', () => {
  it('returns a failed verify_result when backend success is false', async () => {
    const out = await handleVerifyBuild(
      {},
      {
        atlsBatchQuery: async () => ({ success: false, summary: 'build failed' }),
      } as Parameters<typeof handleVerifyBuild>[1],
    );

    expect(out.ok).toBe(false);
    expect(out.summary).toBe('build failed');
  });
});
