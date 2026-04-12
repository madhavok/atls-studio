import { describe, expect, it } from 'vitest';
import { getModePrompt } from './modePrompts';

describe('getModePrompt', () => {
  const modes = ['ask', 'designer', 'reviewer', 'retriever', 'refactor', 'agent', 'custom'] as const;

  it.each(modes)('mode %s returns non-empty prompt', (mode) => {
    const p = getModePrompt(mode);
    expect(p.length).toBeGreaterThan(40);
    expect(p).toMatch(/batch|blackboard|BB|pin/i);
  });

  it('ask mode stresses read-only / batch grounding', () => {
    const p = getModePrompt('ask');
    expect(p).toMatch(/read-only|Do not modify/i);
  });

});
