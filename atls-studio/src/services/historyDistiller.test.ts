import { describe, expect, it } from 'vitest';
import {
  distillRound,
  emptyRollingSummary,
  formatSummaryMessage,
  isRollingSummaryEmpty,
  isRollingSummaryMessage,
  ROLLING_SUMMARY_MARKER,
  trimSummaryToTokenBudget,
  updateRollingSummary,
} from './historyDistiller';
import { estimateTokens } from '../utils/contextHash';
import { ROLLING_SUMMARY_MAX_TOKENS } from './promptMemory';

describe('historyDistiller', () => {
  it('updateRollingSummary merges and dedupes', () => {
    const a = emptyRollingSummary();
    const b = updateRollingSummary(a, {
      decisions: ['Use X', 'use x'],
      filesChanged: ['a.ts'],
      userPreferences: [],
      workDone: [],
      errors: [],
    });
    expect(b.decisions).toEqual(['Use X']);
    expect(b.filesChanged).toEqual(['a.ts']);
  });

  it('formatSummaryMessage uses assistant role and marker', () => {
    const m = formatSummaryMessage({
      ...emptyRollingSummary(),
      decisions: ['chose approach A'],
    });
    expect(m.role).toBe('assistant');
    expect(m.content).toContain(ROLLING_SUMMARY_MARKER);
    expect(m.content).toContain('chose approach A');
  });

  it('isRollingSummaryMessage detects marker', () => {
    expect(
      isRollingSummaryMessage({
        role: 'assistant',
        content: `${ROLLING_SUMMARY_MARKER}\n**Decisions**\n- x`,
      }),
    ).toBe(true);
    expect(isRollingSummaryMessage({ role: 'assistant', content: 'hello' })).toBe(false);
  });

  it('trimSummaryToTokenBudget stays under cap', () => {
    const huge = emptyRollingSummary();
    for (let i = 0; i < 200; i++) {
      huge.decisions.push(`decision line ${i} with some text to grow tokens`);
    }
    const trimmed = trimSummaryToTokenBudget(huge, ROLLING_SUMMARY_MAX_TOKENS);
    const body = formatSummaryMessage(trimmed).content;
    expect(estimateTokens(body)).toBeLessThanOrEqual(ROLLING_SUMMARY_MAX_TOKENS + 50);
  });

  it('distillRound extracts paths from batch tool_use', () => {
    const facts = distillRound([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'batch',
            input: {
              version: '1.0',
              steps: [{ use: 'read.context', with: { file_paths: ['src/foo.ts'] } }],
            },
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] },
    ]);
    expect(facts.filesChanged.some((p) => p.includes('foo.ts'))).toBe(true);
  });

  it('isRollingSummaryEmpty', () => {
    expect(isRollingSummaryEmpty(emptyRollingSummary())).toBe(true);
    expect(isRollingSummaryEmpty({ ...emptyRollingSummary(), decisions: ['x'] })).toBe(false);
  });
});
