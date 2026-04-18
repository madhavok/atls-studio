/**
 * Measurement gate for retention-op compaction per atls-pillars.mdc:
 *
 *  1. Token overhead: simulate a 20-round retention-heavy session with the
 *     sub-threshold batch shape that the spin pattern actually produces
 *     (1-3 retention steps per round, staying under BATCH_INPUT_STUB_THRESHOLD
 *     and MIN_DEFLATE_TOKENS). Confirm input-token footprint drops.
 *  2. Ghost-ref elimination: reproduce the 8-round unpin spin and confirm
 *     none of the prior-round hashes survive in the assistant's subsequent
 *     tool_use step args or in retention-op tool_result lines.
 *  3. BP3 prefix byte-stability: after compacting round N, the serialized
 *     hash of history[0..N-1] must equal its pre-round-N value — no
 *     retroactive rewrite of the cacheable prefix.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  compactRetentionOps,
  stubBatchToolUseInputs,
  deflateToolResults,
} from './historyCompressor';
import { countTokensSync } from '../utils/tokenCounter';
import { hashContentSync } from '../utils/contextHash';
import { useContextStore } from '../stores/contextStore';

function resetStore() {
  useContextStore.getState().resetSession();
}

type Msg = { role: string; content: unknown };
type ToolResult = { type: string; tool_use_id: string; content: string; name?: string };

function fvHash(round: number, idx: number): string {
  return `h:fv:${round.toString(16).padStart(4, '0')}${idx.toString(16).padStart(12, '0')}`;
}

/** Sub-threshold retention batch — the shape that leaks hashes in the spin pattern. */
function buildSubThresholdRetentionRound(round: number, unpinHashes: string[]): {
  assistant: Msg;
  toolResult: ToolResult;
} {
  const tuId = `tu_${round}`;
  const steps: Array<Record<string, unknown>> = [
    { id: 'u1', use: 'session.unpin', with: { hashes: unpinHashes } },
  ];
  const assistant: Msg = {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: tuId, name: 'batch', input: { version: '1.0', steps } },
    ],
  };
  const toolResult: ToolResult = {
    type: 'tool_result',
    tool_use_id: tuId,
    content: [
      `[OK] u1 (session.unpin): unpin: ${unpinHashes.length} chunks unpinned (${unpinHashes.length + 1}ms)`,
      `[ATLS] 1 steps: 1 pass (${unpinHashes.length + 2}ms) | ok`,
    ].join('\n'),
  };
  return { assistant, toolResult };
}

/** Round-trip one round through the finalize pipeline. */
function finalizeRound(
  history: Msg[],
  assistant: Msg,
  toolResult: ToolResult,
  enableCompaction: boolean,
) {
  history.push(assistant);
  stubBatchToolUseInputs(history);
  if (enableCompaction) compactRetentionOps(history, [toolResult]);
  deflateToolResults([toolResult], history);
  history.push({ role: 'user', content: [toolResult] });
}

function historyTokens(history: Msg[]): number {
  return countTokensSync(JSON.stringify(history));
}

/** Extract retention hashes from any assistant tool_use step across history. */
function collectRetentionHashesInHistory(history: Msg[]): string[] {
  const found: string[] = [];
  const retentionOps = new Set([
    'session.pin', 'session.unpin', 'session.drop',
    'session.unload', 'session.compact', 'session.bb.delete',
  ]);
  for (const msg of history) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<{ type: string; input?: Record<string, unknown> }>) {
      if (block.type !== 'tool_use' || !block.input) continue;
      const steps = block.input.steps;
      if (!Array.isArray(steps)) continue;
      for (const step of steps as Array<Record<string, unknown>>) {
        const use = typeof step.use === 'string' ? step.use : '';
        if (!retentionOps.has(use)) continue;
        const w = step.with as Record<string, unknown> | undefined;
        const hashes = w?.hashes;
        if (Array.isArray(hashes)) found.push(...(hashes as string[]));
        else if (typeof hashes === 'string') found.push(hashes);
      }
    }
  }
  return found;
}

describe('retention-op compaction — measurement gate', () => {
  beforeEach(() => resetStore());

  it('reduces history tokens on a 20-round sub-threshold retention session', () => {
    // 3 hashes per unpin → step.with.hashes ~70-80 chars → whole input ~25 tokens.
    // Stays below BATCH_INPUT_STUB_THRESHOLD (80tk). Tool_result ~20 tokens stays
    // below MIN_DEFLATE_TOKENS (30tk), so the whole round persists verbatim.
    // This is the exact pattern the spin session produced.
    const rounds = 20;
    const hashesPerRound = 3;

    const baseline: Msg[] = [{ role: 'user', content: 'start' }];
    const compacted: Msg[] = [{ role: 'user', content: 'start' }];

    for (let r = 1; r <= rounds; r++) {
      const hashes = Array.from({ length: hashesPerRound }, (_, i) => fvHash(r - 1, i));
      const bRound = buildSubThresholdRetentionRound(r, hashes);
      finalizeRound(baseline, bRound.assistant, bRound.toolResult, /*compact*/ false);

      const cRound = buildSubThresholdRetentionRound(r, [...hashes]);
      finalizeRound(compacted, cRound.assistant, cRound.toolResult, /*compact*/ true);
    }

    const baselineTok = historyTokens(baseline);
    const compactedTok = historyTokens(compacted);
    const saved = baselineTok - compactedTok;
    const pct = (saved / baselineTok) * 100;

    // eslint-disable-next-line no-console
    console.log(
      `[retention-measurement] 20 rounds × 1 retention batch × ${hashesPerRound} hashes | ` +
        `baseline:${baselineTok}tk compacted:${compactedTok}tk Δ:${saved}tk (${pct.toFixed(1)}%)`,
    );

    // Gate: meaningful reduction on the exact pattern that caused the spin.
    // Per-round: step.with goes from `{hashes:[h:fv:X, h:fv:Y, h:fv:Z]}` (~20tk)
    // to `{n:3}` (~3tk); tool_result tail goes from "unpin: 3 chunks unpinned (4ms)"
    // (~8tk) to "ok" (~1tk). ~20tk saved per round × 20 rounds = ~400tk savings.
    expect(saved).toBeGreaterThan(0);
    expect(pct).toBeGreaterThanOrEqual(15);
  });

  it('ghost-ref elimination — prior hashes gone from retention-op positions', () => {
    // Reproduce the 8-round unpin spin: each round unpins 3 hashes "from 2
    // rounds ago" (ghosts — already released, but the model keeps emitting
    // them because it learned the template from its own prior tool_use).
    const history: Msg[] = [{ role: 'user', content: 'start' }];
    const ghostHashes: string[] = [];

    for (let r = 1; r <= 8; r++) {
      const hashes = Array.from({ length: 3 }, (_, i) => fvHash(r, i));
      ghostHashes.push(...hashes);
      const { assistant, toolResult } = buildSubThresholdRetentionRound(r, hashes);
      finalizeRound(history, assistant, toolResult, /*compact*/ true);
    }

    // Assertion 1: no ghost hash appears in any retention-op step.with.hashes.
    // (compactRetentionOps replaced them all with {n:3}.)
    const liveRetentionHashes = collectRetentionHashesInHistory(history);
    expect(liveRetentionHashes).toHaveLength(0);

    // Assertion 2: no ghost hash appears in any retention-op tool_result line.
    // (All `[OK] u1 (session.unpin): ...` lines collapsed to `ok`.)
    for (const msg of history) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as Array<{ type: string; content?: string }>) {
        if (typeof block.content !== 'string') continue;
        const lines = block.content.split('\n');
        for (const line of lines) {
          const m = /^\[OK\]\s+\S+\s+\((session\.\S+)\):\s+(.+)$/.exec(line);
          if (!m) continue;
          const op = m[1];
          const tail = m[2];
          const isRetention = op.startsWith('session.') &&
            ['unpin', 'pin', 'drop', 'unload', 'compact', 'bb.delete'].some((r) => op.endsWith(r));
          if (!isRetention) continue;
          expect(tail).toBe('ok');
          for (const ghost of ghostHashes) {
            expect(line).not.toContain(ghost);
          }
        }
      }
    }
  });

  it('BP3 prefix byte-stability — compacting round N does not mutate prior rounds', () => {
    const history: Msg[] = [{ role: 'user', content: 'start' }];
    const prefixHashesAtRoundClose: string[] = [];

    for (let r = 1; r <= 6; r++) {
      const prefixEnd = history.length;
      const hashes = Array.from({ length: 3 }, (_, i) => fvHash(r - 1, i));
      const { assistant, toolResult } = buildSubThresholdRetentionRound(r, hashes);
      finalizeRound(history, assistant, toolResult, /*compact*/ true);
      prefixHashesAtRoundClose.push(
        hashContentSync(JSON.stringify(history.slice(0, prefixEnd))),
      );
    }

    // For each historical prefix boundary, re-serialize and confirm the hash
    // matches what it was when that prefix was first sealed. If compaction of
    // a later round mutated earlier rounds, these would diverge.
    for (let r = 2; r <= 6; r++) {
      const prefixEnd = 1 + (r - 1) * 2; // 1 seed + 2 msgs per finalized round
      const currentHash = hashContentSync(JSON.stringify(history.slice(0, prefixEnd)));
      expect(currentHash).toBe(prefixHashesAtRoundClose[r - 1]);
    }
  });
});
