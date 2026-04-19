import { beforeEach, describe, expect, it } from 'vitest';
import {
  compactRetentionOps,
  stubBatchToolUseInputs,
  deflateToolResults,
} from './historyCompressor';
import { useContextStore } from '../stores/contextStore';
import { hashContentSync } from '../utils/contextHash';

function resetStore() {
  useContextStore.getState().resetSession();
}

type Msg = { role: string; content: unknown };
type ToolResult = { type: string; tool_use_id: string; content: string; name?: string };

function mkAssistant(steps: Array<Record<string, unknown>>, id = 'tu_1'): Msg {
  return {
    role: 'assistant',
    content: [
      { type: 'tool_use', id, name: 'batch', input: { version: '1.0', steps } },
    ],
  };
}

function mkToolResult(id: string, content: string): ToolResult {
  return { type: 'tool_result', tool_use_id: id, content };
}

function getSteps(msg: Msg): Array<Record<string, unknown>> {
  const blocks = msg.content as Array<{ type: string; input?: Record<string, unknown> }>;
  return (blocks[0].input?.steps ?? []) as Array<Record<string, unknown>>;
}

describe('compactRetentionOps — tool_use step args (ephemeral)', () => {
  beforeEach(() => resetStore());

  it('strips with and in from retention steps — nothing handler-parseable remains', () => {
    const history: Msg[] = [
      { role: 'user', content: 'go' },
      mkAssistant([
        { id: 'u1', use: 'session.unpin', with: { hashes: ['h:fv:X', 'h:fv:Y', 'h:fv:Z'] } },
      ]),
    ];
    const { stepsCompacted } = compactRetentionOps(history, []);
    expect(stepsCompacted).toBe(1);
    const step = getSteps(history[1])[0];
    // Persisted shape is {id, use} only — no args, no markers.
    expect(step).toEqual({ id: 'u1', use: 'session.unpin' });
    expect(step.with).toBeUndefined();
    expect(step._compacted).toBeUndefined();
    expect(step._receipt).toBeUndefined();
    // JSON-serialization-stable: a serialized observer sees nothing beyond id+use.
    expect(JSON.parse(JSON.stringify(step))).toEqual({ id: 'u1', use: 'session.unpin' });
  });

  it('strips with for pin with single-string hashes', () => {
    const history: Msg[] = [
      { role: 'user', content: 'go' },
      mkAssistant([
        { id: 'p1', use: 'session.pin', with: { hashes: 'h:fv:A' } },
      ]),
    ];
    compactRetentionOps(history, []);
    const step = getSteps(history[1])[0];
    expect(step.with).toBeUndefined();
    expect(step).toEqual({ id: 'p1', use: 'session.pin' });
  });

  it('strips with for bb.delete (keys array)', () => {
    const history: Msg[] = [
      { role: 'user', content: 'go' },
      mkAssistant([
        { id: 'd1', use: 'session.bb.delete', with: { keys: ['k1', 'k2'] } },
      ]),
    ];
    compactRetentionOps(history, []);
    expect(getSteps(history[1])[0]).toEqual({ id: 'd1', use: 'session.bb.delete' });
  });

  it('strips step.in dataflow reference (also a ghost-ref vector)', () => {
    const history: Msg[] = [
      { role: 'user', content: 'go' },
      mkAssistant([
        {
          id: 'p1',
          use: 'session.pin',
          in: { hashes: { from_step: 'r1', path: 'refs' } },
        },
      ]),
    ];
    const { stepsCompacted } = compactRetentionOps(history, []);
    expect(stepsCompacted).toBe(1);
    const step = getSteps(history[1])[0];
    expect(step.in).toBeUndefined();
    expect(step.with).toBeUndefined();
    expect(step).toEqual({ id: 'p1', use: 'session.pin' });
  });

  it('strips scope-based drop args too — no args survives on any retention step', () => {
    const history: Msg[] = [
      { role: 'user', content: 'go' },
      mkAssistant([
        { id: 'd1', use: 'session.drop', with: { scope: 'archived', max: 25 } },
      ]),
    ];
    const { stepsCompacted } = compactRetentionOps(history, []);
    expect(stepsCompacted).toBe(1);
    const step = getSteps(history[1])[0];
    // Ephemeral principle: manifest carries state; scope arg not needed in history.
    expect(step.with).toBeUndefined();
    expect(step).toEqual({ id: 'd1', use: 'session.drop' });
  });

  it('leaves non-retention ops alone in mixed batch', () => {
    const history: Msg[] = [
      { role: 'user', content: 'go' },
      mkAssistant([
        { id: 'r1', use: 'read.shaped', with: { ps: 'src/foo.ts', shape: 'sig' } },
        { id: 'p1', use: 'session.pin', with: { hashes: ['h:fv:A', 'h:fv:B'] } },
        { id: 'b1', use: 'session.bb.write', with: { key: 'finding:x', content: 'clear — no issues' } },
        { id: 'u1', use: 'session.unpin', with: { hashes: ['h:fv:C'] } },
      ]),
    ];
    const { stepsCompacted } = compactRetentionOps(history, []);
    expect(stepsCompacted).toBe(2); // pin + unpin
    const steps = getSteps(history[1]);
    expect(steps[0].with).toEqual({ ps: 'src/foo.ts', shape: 'sig' }); // read preserved
    expect(steps[1].with).toBeUndefined(); // pin stripped
    expect(steps[2].with).toEqual({ key: 'finding:x', content: 'clear — no issues' }); // bb.write preserved
    expect(steps[3].with).toBeUndefined(); // unpin stripped
  });
});

describe('compactRetentionOps — tool_result per-step lines (ephemeral)', () => {
  beforeEach(() => resetStore());

  it('removes OK retention lines entirely — not collapsed to ok', () => {
    const tr = mkToolResult('tu_1', [
      '[OK] u1 (session.unpin): unpin: 4 chunks unpinned (1ms)',
      '[OK] u2 (session.unpin): unpin: 3 chunks unpinned (19ms)',
      '[OK] d1 (session.bb.delete): bb_delete: 1 entries removed (42ms)',
      '[OK] d2 (session.drop): drop: 25 chunks permanently dropped (35.8k freed, manifest entries kept) | scope:archived (25ms)',
      '[ATLS] 4 steps: 4 pass (89ms) | ok',
    ].join('\n'));
    const { resultLinesCompacted } = compactRetentionOps([], [tr]);
    expect(resultLinesCompacted).toBe(4);
    // Only the footer remains.
    expect(tr.content).toBe('[ATLS] 4 steps: 4 pass (89ms) | ok');
    // No retention OK chatter left behind.
    expect(tr.content).not.toContain('session.unpin');
    expect(tr.content).not.toContain('session.drop');
    expect(tr.content).not.toContain('session.bb.delete');
    // No per-step "[OK] <id> (<op>): ok" stubs (the old spin surface). The
    // [ATLS] footer legitimately ends with "| ok" and is untouched.
    expect(tr.content).not.toMatch(/^\[OK\]\s+\S+\s+\(\S+\):\s+ok$/m);
  });

  it('strips hash-bearing drop tails completely (ghost-ref vector)', () => {
    const tr = mkToolResult('tu_1', [
      '[OK] d1 (session.drop): drop: 12 chunks permanently dropped (5.8k freed, manifest entries kept) | dropped: [h:0b897d session.bb.write, h:cb829d task_complete, h:e135b9 session.unload +17]',
      '[ATLS] 1 steps: 1 pass (4ms) | ok',
    ].join('\n'));
    compactRetentionOps([], [tr]);
    expect(tr.content).toBe('[ATLS] 1 steps: 1 pass (4ms) | ok');
    expect(tr.content).not.toContain('h:0b897d');
    expect(tr.content).not.toContain('h:cb829d');
  });

  it('preserves FAIL lines verbatim — diagnostic signal survives', () => {
    const tr = mkToolResult('tu_1', [
      '[OK] u1 (session.unpin): unpin: 4 chunks unpinned (1ms)',
      "[FAIL] p1 (session.pin): pin: ERROR step 'r1' produced no h:refs — cannot pin. Re-run a read/search that returns VOLATILE refs, or pass explicit hashes:h:… (pin in the same batch as the read when possible).",
      '[ATLS] 2 steps: 1 pass, 1 fail (667ms) | failed',
    ].join('\n'));
    const { resultLinesCompacted } = compactRetentionOps([], [tr]);
    expect(resultLinesCompacted).toBe(1);
    // OK unpin is gone.
    expect(tr.content).not.toContain('session.unpin');
    // FAIL line kept verbatim.
    expect(tr.content).toContain("[FAIL] p1 (session.pin): pin: ERROR step 'r1' produced no h:refs");
    expect(tr.content).toContain('[ATLS] 2 steps: 1 pass, 1 fail (667ms) | failed');
  });

  it('leaves non-retention per-step lines untouched', () => {
    const tr = mkToolResult('tu_1', [
      '[OK] r1 (read.shaped): read_shaped: atls-studio/src/foo.ts → h:fv:487c21dc87d47896 (full:76563tk, shaped:72tk, saved:100%)',
      '[OK] b1 (session.bb.write): bb_write: h:bb:finding:x (42tk) — use h:bb:finding:x in response',
      '[OK] s1 (search.code): search: foo → h:60f7df (0.3k tk)',
      '[OK] v1 (verify.build): verify.build: OK (1.2k tk)',
      '[OK] u1 (session.unpin): unpin: 3 chunks unpinned (19ms)',
      '[ATLS] 5 steps: 5 pass (123ms) | ok',
    ].join('\n'));
    const { resultLinesCompacted } = compactRetentionOps([], [tr]);
    expect(resultLinesCompacted).toBe(1);
    expect(tr.content).toContain('[OK] r1 (read.shaped): read_shaped: atls-studio/src/foo.ts');
    expect(tr.content).toContain('[OK] b1 (session.bb.write): bb_write: h:bb:finding:x');
    expect(tr.content).toContain('[OK] s1 (search.code): search: foo');
    expect(tr.content).toContain('[OK] v1 (verify.build): verify.build: OK');
    // Unpin line removed, not rewritten.
    expect(tr.content).not.toContain('session.unpin');
  });

  it('ignores non-batch tool_result content (no per-step lines)', () => {
    const tr = mkToolResult('tu_1', 'just some plain text output');
    const { resultLinesCompacted } = compactRetentionOps([], [tr]);
    expect(resultLinesCompacted).toBe(0);
    expect(tr.content).toBe('just some plain text output');
  });
});

describe('compactRetentionOps — idempotence', () => {
  beforeEach(() => resetStore());

  it('running twice equals running once (tool_use)', () => {
    const history: Msg[] = [
      { role: 'user', content: 'go' },
      mkAssistant([
        { id: 'u1', use: 'session.unpin', with: { hashes: ['h:fv:A', 'h:fv:B', 'h:fv:C'] } },
      ]),
    ];
    const first = compactRetentionOps(history, []);
    const snapshot = JSON.stringify(history[1]);
    const second = compactRetentionOps(history, []);
    expect(first.stepsCompacted).toBe(1);
    expect(second.stepsCompacted).toBe(0);
    // WeakSet idempotence: the step object is flagged, so a second pass is a no-op.
    expect(JSON.stringify(history[1])).toBe(snapshot);
  });

  it('running twice equals running once (tool_result)', () => {
    const tr = mkToolResult('tu_1',
      '[OK] u1 (session.unpin): unpin: 3 chunks unpinned (19ms)\n[ATLS] 1 steps: 1 pass | ok',
    );
    const first = compactRetentionOps([], [tr]);
    const snapshot = tr.content;
    const second = compactRetentionOps([], [tr]);
    expect(first.resultLinesCompacted).toBe(1);
    // Nothing to strip the second time — the OK line is gone.
    expect(second.resultLinesCompacted).toBe(0);
    expect(tr.content).toBe(snapshot);
    expect(tr.content).toBe('[ATLS] 1 steps: 1 pass | ok');
  });
});

describe('compactRetentionOps — integration with stub + deflate', () => {
  beforeEach(() => resetStore());

  it('plays nicely with stubBatchToolUseInputs (stub runs first on big batches)', () => {
    // Build a batch large enough (>=80tk) to trigger stubBatchToolUseInputs.
    const steps: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 15; i++) {
      steps.push({
        id: `u${i}`,
        use: 'session.unpin',
        with: { hashes: [`h:fv:hash${i}aaaaaaaaaaaaaaaa`, `h:fv:hash${i}bbbbbbbbbbbbbbbb`] },
      });
    }
    const history: Msg[] = [
      { role: 'user', content: 'go' },
      mkAssistant(steps),
    ];

    const stubbed = stubBatchToolUseInputs(history);
    expect(stubbed).toBe(1);
    const input = (history[1].content as Array<{ input?: Record<string, unknown> }>)[0].input;
    expect(input?._stubbed).toBeDefined();
    expect(input?.steps).toBeUndefined();

    // compactRetentionOps sees no `steps` array and is a no-op.
    const { stepsCompacted } = compactRetentionOps(history, []);
    expect(stepsCompacted).toBe(0);
  });

  it('compacts sub-threshold retention batches that stub skipped', () => {
    // Small batch that stays under BATCH_INPUT_STUB_THRESHOLD (80tk).
    const history: Msg[] = [
      { role: 'user', content: 'go' },
      mkAssistant([
        { id: 'u1', use: 'session.unpin', with: { hashes: ['h:fv:X'] } },
      ]),
    ];
    const stubbed = stubBatchToolUseInputs(history);
    expect(stubbed).toBe(0); // below threshold — stub skipped

    const { stepsCompacted } = compactRetentionOps(history, []);
    expect(stepsCompacted).toBe(1);
    const step = getSteps(history[1])[0];
    expect(step.with).toBeUndefined();
    expect(step).toEqual({ id: 'u1', use: 'session.unpin' });
  });

  it('deflateToolResults still functions on content after compaction', () => {
    // Create a non-retention tool_result large enough to deflate.
    const tr = mkToolResult('tu_1', [
      '[OK] r1 (read.shaped): read_shaped: atls-studio/src/foo.ts → h:fv:aaaaaaaa (full:1000tk, shaped:100tk, saved:90%) ' + 'padding '.repeat(50),
      '[OK] u1 (session.unpin): unpin: 3 chunks unpinned (19ms)',
      '[ATLS] 2 steps: 2 pass (100ms) | ok',
    ].join('\n'));

    compactRetentionOps([], [tr]);
    expect(tr.content).not.toContain('session.unpin'); // retention line removed
    expect(tr.content).toContain('read_shaped: atls-studio/src/foo.ts'); // non-retention preserved

    // deflateToolResults may collapse or keep based on chunk presence, but it
    // must not error on the post-compaction content.
    expect(() => deflateToolResults([tr], [])).not.toThrow();
  });
});

describe('compactRetentionOps — cache stability invariant', () => {
  beforeEach(() => resetStore());

  it('compacted prefix is byte-stable across later round finalizations', () => {
    // Round 1 finalize — assistant + tool_result for a retention batch.
    const r1Assistant = mkAssistant([
      { id: 'u1', use: 'session.unpin', with: { hashes: ['h:fv:A', 'h:fv:B'] } },
    ], 'tu_r1');
    const r1Result = mkToolResult('tu_r1',
      '[OK] u1 (session.unpin): unpin: 2 chunks unpinned (5ms)\n[ATLS] 1 steps: 1 pass | ok',
    );

    const history: Msg[] = [{ role: 'user', content: 'go' }, r1Assistant];
    compactRetentionOps(history, [r1Result]);
    history.push({ role: 'user', content: [r1Result] });

    const prefixHashAfterR1 = hashContentSync(JSON.stringify(history));

    // Round 2 finalize — independent batch appended.
    const r2Assistant = mkAssistant([
      { id: 'u1', use: 'session.unpin', with: { hashes: ['h:fv:C'] } },
    ], 'tu_r2');
    const r2Result = mkToolResult('tu_r2',
      '[OK] u1 (session.unpin): unpin: 1 chunks unpinned (2ms)\n[ATLS] 1 steps: 1 pass | ok',
    );
    history.push(r2Assistant);
    compactRetentionOps(history, [r2Result]);
    history.push({ role: 'user', content: [r2Result] });

    // The round-1 prefix (first 3 entries) should be byte-stable — compacting
    // round 2 must not retroactively mutate round 1's content.
    const r1PrefixAfterR2 = hashContentSync(JSON.stringify(history.slice(0, 3)));
    const r1PrefixFromR1 = hashContentSync(JSON.stringify(JSON.parse(JSON.stringify([
      history[0], history[1], history[2],
    ]))));
    expect(r1PrefixAfterR2).toBe(r1PrefixFromR1);
    // Sanity: the full history hash changed (round 2 added content).
    expect(hashContentSync(JSON.stringify(history))).not.toBe(prefixHashAfterR1);
  });
});

describe('compactRetentionOps — templating-spin prevention', () => {
  beforeEach(() => resetStore());

  it('persisted retention tool_use has no re-emittable shape', () => {
    // This is the regression test for the spin that motivated the ephemeral
    // rewrite: prior implementation left {n:5, _compacted:true} in the step,
    // which the model templated verbatim as a fresh call with no real hashes.
    const history: Msg[] = [
      { role: 'user', content: 'go' },
      mkAssistant([
        { id: 'u1', use: 'session.unpin', with: { hashes: ['h:fv:A', 'h:fv:B', 'h:fv:C', 'h:fv:D', 'h:fv:E'] } },
      ]),
    ];
    compactRetentionOps(history, []);

    const step = getSteps(history[1])[0];
    const serialized = JSON.stringify(step);

    // Must not contain any of the old markers that made the shape callable-looking.
    expect(serialized).not.toContain('_compacted');
    expect(serialized).not.toContain('_receipt');
    expect(serialized).not.toMatch(/"n":\s*\d/);
    expect(serialized).not.toContain('with');
    // Must not leak any of the original hashes.
    expect(serialized).not.toContain('h:fv:');

    // The only shape the model can template is id+use — and a call with no
    // args triggers the handler's "no hashes supplied" err (see session.ts).
    expect(JSON.parse(serialized)).toEqual({ id: 'u1', use: 'session.unpin' });
  });

  it('persisted retention tool_result has no re-emittable receipt', () => {
    const tr = mkToolResult('tu_1', [
      '[OK] u1 (session.unpin): unpin: 3 chunks unpinned (19ms)',
      '[OK] p1 (session.pin): pin: 2 chunks pinned (5ms)',
      '[OK] d1 (session.drop): drop: 5 chunks permanently dropped (1.2k freed)',
      '[ATLS] 3 steps: 3 pass (25ms) | ok',
    ].join('\n'));
    compactRetentionOps([], [tr]);

    // No per-step OK retention lines survive (the old spin surface).
    expect(tr.content).not.toMatch(/^\[OK\]\s+\S+\s+\(session\.(pin|unpin|drop|unload|compact|bb\.delete)\)/m);
    expect(tr.content).not.toContain('chunks unpinned');
    expect(tr.content).not.toContain('chunks pinned');
    expect(tr.content).not.toContain('chunks permanently dropped');
    // Footer only.
    expect(tr.content).toBe('[ATLS] 3 steps: 3 pass (25ms) | ok');
  });
});
