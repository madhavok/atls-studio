import { describe, expect, it } from 'vitest';
import {
  distillRound,
  emptyRollingSummary,
  formatSummaryMessage,
  isRollingSummaryEmpty,
  isRollingSummaryMessage,
  MAX_SUMMARY_ITEMS_PER_ARRAY,
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

  it('distillRound skips compressed hash pointer lines in assistant text', () => {
    const facts = distillRound([
      {
        role: 'assistant',
        content: '[-> h:a1b2c3d4, 969tk | history:assistant:some previous text that was compressed]',
      },
      { role: 'user', content: 'ok' },
    ]);
    expect(facts.decisions).toEqual([]);
    expect(facts.workDone).toEqual([]);
  });

  it('distillRound skips pointer lines in array-shaped assistant content', () => {
    const facts = distillRound([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '[-> h:deadbeef, 512tk | history:assistant:compressed block]' },
          { type: 'text', text: 'This is a real decision about architecture' },
        ],
      },
      { role: 'user', content: 'sounds good' },
    ]);
    expect(facts.decisions).toEqual(['This is a real decision about architecture']);
  });

  it('updateRollingSummary caps each array at MAX_SUMMARY_ITEMS_PER_ARRAY', () => {
    let summary = emptyRollingSummary();
    for (let i = 0; i < 20; i++) {
      summary = updateRollingSummary(summary, {
        decisions: [`decision ${i}`],
        filesChanged: [`file${i}.ts`],
        userPreferences: [],
        workDone: [`work item ${i}`],
        errors: [`error ${i}`],
      });
    }
    expect(summary.decisions.length).toBeLessThanOrEqual(MAX_SUMMARY_ITEMS_PER_ARRAY);
    expect(summary.filesChanged.length).toBeLessThanOrEqual(MAX_SUMMARY_ITEMS_PER_ARRAY);
    expect(summary.workDone.length).toBeLessThanOrEqual(MAX_SUMMARY_ITEMS_PER_ARRAY);
    expect(summary.errors.length).toBeLessThanOrEqual(MAX_SUMMARY_ITEMS_PER_ARRAY);
    expect(summary.decisions[0]).toContain('decision 12');
  });

  it('updateRollingSummary rejects pointer strings via dedupePush', () => {
    const base = emptyRollingSummary();
    const withPointers = updateRollingSummary(base, {
      decisions: ['[-> h:abc12345, 400tk | history:assistant:[Rolling Summary]...]'],
      filesChanged: [],
      userPreferences: [],
      workDone: ['[-> h:fff00000, 200tk | done]'],
      errors: [],
    });
    expect(withPointers.decisions).toEqual([]);
    expect(withPointers.workDone).toEqual([]);
  });
});
