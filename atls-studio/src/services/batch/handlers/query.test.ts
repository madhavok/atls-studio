import { describe, it, expect } from 'vitest';
import {
  handleSearchCode,
  handleSearchSymbol,
  handleSearchMemory,
} from './query';

describe('query handlers', () => {
  it('exports search handlers', () => {
    expect(typeof handleSearchCode).toBe('function');
    expect(typeof handleSearchSymbol).toBe('function');
    expect(typeof handleSearchMemory).toBe('function');
  });
});
