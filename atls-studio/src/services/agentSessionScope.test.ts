/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  markRunRoundMutation,
  markRunVerification,
  readRunHadVerification,
  readRunRoundHadMutations,
  resetRunRoundHadMutations,
  resolveDbSessionId,
  resolveScopedProjectPath,
  setActiveRunScope,
  withDbSessionScope,
} from './agentSessionScope';

describe('agentSessionScope', () => {
  beforeEach(() => {
    setActiveRunScope(null);
    localStorage.removeItem('current_session_id');
  });

  it('resolveDbSessionId prefers active run scope', () => {
    setActiveRunScope({ dbSessionId: 'grid-session' });
    expect(resolveDbSessionId('legacy')).toBe('grid-session');
  });

  it('resolveDbSessionId falls back to argument', () => {
    expect(resolveDbSessionId('legacy')).toBe('legacy');
  });

  it('resolveScopedProjectPath prefers active run scope', () => {
    setActiveRunScope({ dbSessionId: 's', projectPath: '/grid/root' });
    expect(resolveScopedProjectPath('/legacy')).toBe('/grid/root');
  });

  it('tracks mutation flags on scoped loop state', () => {
    const loopState = { roundHadMutations: false, hadVerification: false };
    setActiveRunScope({ dbSessionId: 's', loopState });
    markRunRoundMutation();
    markRunVerification();
    expect(readRunRoundHadMutations()).toBe(true);
    expect(readRunHadVerification()).toBe(true);
    resetRunRoundHadMutations();
    expect(readRunRoundHadMutations()).toBe(false);
    expect(readRunHadVerification()).toBe(true);
  });

  it('withDbSessionScope syncs localStorage session id for legacy readers', async () => {
    localStorage.setItem('current_session_id', 'prior');
    await withDbSessionScope({ dbSessionId: 'scoped' }, async () => {
      expect(localStorage.getItem('current_session_id')).toBe('scoped');
      expect(resolveDbSessionId(null)).toBe('scoped');
    });
    expect(localStorage.getItem('current_session_id')).toBe('prior');
  });
});
