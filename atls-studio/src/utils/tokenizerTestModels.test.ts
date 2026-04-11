import { describe, expect, it } from 'vitest';
import {
  TOKENIZER_TEST_MODEL_ANTHROPIC,
  TOKENIZER_TEST_MODEL_GOOGLE,
  TOKENIZER_TEST_MODEL_OPENAI,
} from './tokenizerTestModels';

describe('tokenizerTestModels', () => {
  it('exports non-empty canonical ids', () => {
    expect(TOKENIZER_TEST_MODEL_OPENAI.length).toBeGreaterThan(3);
    expect(TOKENIZER_TEST_MODEL_ANTHROPIC.length).toBeGreaterThan(3);
    expect(TOKENIZER_TEST_MODEL_GOOGLE.length).toBeGreaterThan(3);
  });
});
