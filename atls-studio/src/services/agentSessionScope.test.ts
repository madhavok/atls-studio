/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDbSessionId, setActiveRunScope } from './agentSessionScope';

describe('agentSessionScope', () => {
  beforeEach(() => {
    setActiveRunScope(null);
  });

  it('resolveDbSessionId prefers active run scope', () => {
    setActiveRunScope({ dbSessionId: 'grid-session' });
    expect(resolveDbSessionId('legacy')).toBe('grid-session');
  });

  it('resolveDbSessionId falls back to argument', () => {
    expect(resolveDbSessionId('legacy')).toBe('legacy');
  });
});
