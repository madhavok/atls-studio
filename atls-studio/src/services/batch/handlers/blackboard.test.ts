import { describe, it, expect } from 'vitest';
import { handleBbWrite, handleBbRead, handleBbDelete, handleBbList } from './blackboard';

describe('blackboard handlers', () => {
  it('exports bb handlers', () => {
    expect(typeof handleBbWrite).toBe('function');
    expect(typeof handleBbRead).toBe('function');
    expect(typeof handleBbDelete).toBe('function');
    expect(typeof handleBbList).toBe('function');
  });
});
