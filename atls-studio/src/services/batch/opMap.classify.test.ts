import { describe, expect, it } from 'vitest';
import { isIntentOp, isMutatingOp, isReadonlyOp, isSessionOp } from './opMap';

describe('opMap operation classification', () => {
  it('isReadonlyOp covers search/read/analyze/verify and readonly session and system', () => {
    expect(isReadonlyOp('search.code')).toBe(true);
    expect(isReadonlyOp('read.context')).toBe(true);
    expect(isReadonlyOp('analyze.deps')).toBe(true);
    expect(isReadonlyOp('verify.build')).toBe(true);
    expect(isReadonlyOp('session.stats')).toBe(true);
    expect(isReadonlyOp('session.debug')).toBe(true);
    expect(isReadonlyOp('session.diagnose')).toBe(true);
    expect(isReadonlyOp('session.bb.read')).toBe(true);
    expect(isReadonlyOp('session.bb.list')).toBe(true);
    expect(isReadonlyOp('session.status')).toBe(true);
    expect(isReadonlyOp('session.recall')).toBe(true);
    expect(isReadonlyOp('system.git')).toBe(true);
    expect(isReadonlyOp('system.help')).toBe(true);
    expect(isReadonlyOp('system.workspaces')).toBe(true);
    expect(isReadonlyOp('intent.understand')).toBe(true);
  });

  it('isReadonlyOp is false for mutating operations', () => {
    expect(isReadonlyOp('change.edit')).toBe(false);
    expect(isReadonlyOp('system.exec')).toBe(false);
    expect(isReadonlyOp('session.pin')).toBe(false);
  });

  it('isIntentOp matches intent prefix', () => {
    expect(isIntentOp('intent.edit')).toBe(true);
    expect(isIntentOp('read.context')).toBe(false);
  });

  it('isMutatingOp matches change and system.exec', () => {
    expect(isMutatingOp('change.create')).toBe(true);
    expect(isMutatingOp('system.exec')).toBe(true);
    expect(isMutatingOp('read.context')).toBe(false);
  });

  it('isSessionOp matches session and annotate', () => {
    expect(isSessionOp('session.plan')).toBe(true);
    expect(isSessionOp('annotate.note')).toBe(true);
    expect(isSessionOp('change.edit')).toBe(false);
  });
});
