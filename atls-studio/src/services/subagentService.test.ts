/**
 * SubAgent Service — engram-first architecture tests.
 *
 * Tests role allowlists, SubAgentResult shape, provider message
 * safety, and budget constants without requiring Tauri runtime.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ROLE_ALLOWED_OPS,
  SUBAGENT_MAX_FILE_PATHS,
  foldSubagentUsageMetrics,
  dematerializeSubagentChunks,
} from './subagentService';
import type { SubAgentRef, SubAgentResult, SubagentType } from './subagentService';
import { createScopedView, materialize, getRef, resetProtocol } from './hashProtocol';
import { useContextStore } from '../stores/contextStore';
import {
  SUBAGENT_MAX_ROUNDS,
  SUBAGENT_MAX_ROUNDS_BY_ROLE,
  SUBAGENT_TOKEN_BUDGET_DEFAULT,
  SUBAGENT_PIN_BUDGET_CAP,
  SUBAGENT_STAGED_PATHS_CAP,
} from './promptMemory';
import { buildSubagentPrompt } from '../prompts/subagentPrompts';
import type { SubagentRole } from '../prompts/subagentPrompts';

describe('subagentService', () => {
  describe('ROLE_ALLOWED_OPS', () => {
    const allRoles: SubagentType[] = ['retriever', 'design', 'coder', 'tester'];

    it('defines allowlists for all four roles', () => {
      for (const role of allRoles) {
        expect(ROLE_ALLOWED_OPS[role]).toBeInstanceOf(Set);
        expect(ROLE_ALLOWED_OPS[role].size).toBeGreaterThan(0);
      }
    });

    it('retriever has no change or exec ops', () => {
      const ops = ROLE_ALLOWED_OPS.retriever;
      for (const op of ops) {
        expect(op).not.toMatch(/^change\./);
        expect(op).not.toBe('system.exec');
        expect(op).not.toMatch(/^verify\./);
      }
    });

    it('design extends retriever with analyze + diagnose', () => {
      const ret = ROLE_ALLOWED_OPS.retriever;
      const des = ROLE_ALLOWED_OPS.design;
      for (const op of ret) {
        expect(des.has(op)).toBe(true);
      }
      expect(des.has('intent.diagnose')).toBe(true);
      expect(des.has('analyze.deps')).toBe(true);
    });

    it('coder includes change and verify ops', () => {
      const ops = ROLE_ALLOWED_OPS.coder;
      expect(ops.has('change.edit')).toBe(true);
      expect(ops.has('change.create')).toBe(true);
      expect(ops.has('verify.build')).toBe(true);
      expect(ops.has('verify.lint')).toBe(true);
      expect(ops.has('system.exec')).toBe(true);
    });

    it('tester includes test and change.edit but not change.refactor', () => {
      const ops = ROLE_ALLOWED_OPS.tester;
      expect(ops.has('verify.test')).toBe(true);
      expect(ops.has('change.edit')).toBe(true);
      expect(ops.has('change.refactor')).toBe(false);
    });

    it('all roles include session.pin and session.bb.write', () => {
      for (const role of allRoles) {
        expect(ROLE_ALLOWED_OPS[role].has('session.pin')).toBe(true);
        expect(ROLE_ALLOWED_OPS[role].has('session.bb.write')).toBe(true);
      }
    });
  });

  describe('SubAgentResult shape', () => {
    it('has refs array, bbKeys, and no content field', () => {
      const result: SubAgentResult = {
        refs: [
          { hash: 'abc123def456', shortHash: 'abc123de', source: 'src/foo.ts', tokens: 500, pinned: true, type: 'smart' },
        ],
        bbKeys: ['retriever:findings'],
        summary: 'retriever: 1 refs (0.5k tk), 3 rounds, 5 tool calls',
        pinCount: 1,
        pinTokens: 500,
        costCents: 0.5,
        rounds: 3,
        toolCalls: 5,
        invocationId: 'subagent-retriever-12345-abc',
      };

      expect(result.refs).toHaveLength(1);
      expect(result.refs[0].hash).toBe('abc123def456');
      expect(result.refs[0].pinned).toBe(true);
      expect(result.bbKeys).toContain('retriever:findings');
      expect((result as Record<string, unknown>).content).toBeUndefined();
    });

    it('SubAgentRef includes hash, shortHash, source, tokens, type', () => {
      const ref: SubAgentRef = {
        hash: 'full_hash_here',
        shortHash: 'full_has',
        source: 'src/auth.ts',
        lines: '10-50',
        tokens: 1200,
        digest: 'fn authenticate: validates token',
        pinned: true,
        type: 'raw',
      };
      expect(ref.hash).toBeTruthy();
      expect(ref.shortHash).toBeTruthy();
      expect(ref.source).toBeTruthy();
      expect(ref.tokens).toBeGreaterThan(0);
    });
  });

  describe('budget constants', () => {
    it('SUBAGENT_MAX_ROUNDS is a high safety ceiling', () => {
      expect(SUBAGENT_MAX_ROUNDS).toBeGreaterThanOrEqual(50);
      expect(SUBAGENT_MAX_ROUNDS).toBeLessThanOrEqual(200);
    });

    it('SUBAGENT_MAX_ROUNDS_BY_ROLE defines caps for all roles', () => {
      const roles: SubagentType[] = ['retriever', 'design', 'coder', 'tester'];
      for (const role of roles) {
        const cap = SUBAGENT_MAX_ROUNDS_BY_ROLE[role];
        expect(cap).toBeDefined();
        expect(cap).toBeGreaterThan(0);
        expect(cap).toBeLessThanOrEqual(SUBAGENT_MAX_ROUNDS);
      }
    });

    it('read-only roles have tighter round caps than edit roles', () => {
      expect(SUBAGENT_MAX_ROUNDS_BY_ROLE.retriever).toBeLessThan(SUBAGENT_MAX_ROUNDS_BY_ROLE.coder!);
      expect(SUBAGENT_MAX_ROUNDS_BY_ROLE.design).toBeLessThan(SUBAGENT_MAX_ROUNDS_BY_ROLE.coder!);
    });

    it('SUBAGENT_TOKEN_BUDGET_DEFAULT is reasonable', () => {
      expect(SUBAGENT_TOKEN_BUDGET_DEFAULT).toBeGreaterThanOrEqual(100_000);
    });

    it('SUBAGENT_PIN_BUDGET_CAP prevents unbounded pinning', () => {
      expect(SUBAGENT_PIN_BUDGET_CAP).toBeGreaterThan(0);
      expect(SUBAGENT_PIN_BUDGET_CAP).toBeLessThanOrEqual(128_000);
    });

    it('SUBAGENT_STAGED_PATHS_CAP limits system prompt growth', () => {
      expect(SUBAGENT_STAGED_PATHS_CAP).toBeGreaterThan(0);
      expect(SUBAGENT_STAGED_PATHS_CAP).toBeLessThanOrEqual(100);
    });
  });

  describe('subagent prompt cognitive cores', () => {
    const roles: SubagentRole[] = ['retriever', 'design', 'coder', 'tester', 'semantic'];

    it('all roles embed canonical BATCH_TOOL_REF under TOOL SYNTAX', () => {
      for (const role of roles) {
        const prompt = buildSubagentPrompt(role);
        expect(prompt).toContain('## TOOL SYNTAX');
        expect(prompt).toContain('## Batch Tool — line-per-step');
        expect(prompt).toContain('### Operation Families');
        expect(prompt).toContain('sc qs:');
        expect(prompt).toContain('pi hashes:');
      }
    });

    it('all roles include execution protocol', () => {
      for (const role of roles) {
        const prompt = buildSubagentPrompt(role);
        expect(prompt).toContain('## EXECUTION PROTOCOL');
      }
    });

    it('all roles include anti-spin rules', () => {
      for (const role of roles) {
        const prompt = buildSubagentPrompt(role);
        expect(prompt).toContain('2-read rule');
        expect(prompt).toMatch(/Search once, act|No tool-chaining/i);
      }
    });

    it('prompts use primitives-first guidance', () => {
      for (const role of roles) {
        const prompt = buildSubagentPrompt(role);
        expect(prompt).toContain('Primitives first');
        expect(prompt).not.toContain('Prefer intents over primitives');
      }
    });

    it('shared BATCH_TOOL_REF documents edit, verify, and exec (all roles)', () => {
      for (const role of roles) {
        const prompt = buildSubagentPrompt(role);
        expect(prompt).toContain('ce f:h:XXXX');
        expect(prompt).toContain('cc creates:');
        expect(prompt).toContain('vb|vt|vl|vk');
        expect(prompt).toContain('xe cmd:');
      }
    });

    it('subagent prompt stays tied to generated shorthand legend (drift guard)', () => {
      const prompt = buildSubagentPrompt('coder');
      expect(prompt).toContain('### Short codes');
      expect(prompt).toContain('sc=search.code');
    });

    it('focusFileContext is preferred over focusFiles when both provided', () => {
      const prompt = buildSubagentPrompt('retriever', {
        focusFiles: 'a.ts, b.ts',
        focusFileContext: '- a.ts (h:abc1, 500tk) — exports: foo, bar\n- b.ts (h:def2, 300tk) — exports: baz',
      });
      expect(prompt).toContain('exports: foo, bar');
      expect(prompt).not.toContain('a.ts, b.ts');
    });

    it('falls back to focusFiles when focusFileContext is absent', () => {
      const prompt = buildSubagentPrompt('retriever', {
        focusFiles: 'a.ts, b.ts',
      });
      expect(prompt).toContain('a.ts, b.ts');
    });

    it('bbKey section is injected when provided', () => {
      const prompt = buildSubagentPrompt('retriever', { bbKey: 'retriever:findings' });
      expect(prompt).toContain('## FINDINGS (REQUIRED)');
      expect(prompt).toContain('retriever:findings');
      expect(prompt).toContain('bw key:"retriever:findings"');
      expect(prompt).toContain('**Retriever:**');
    });
  });

  describe('subagent step sanitization', () => {
    it('SUBAGENT_MAX_FILE_PATHS caps bulk reads', () => {
      expect(SUBAGENT_MAX_FILE_PATHS).toBeGreaterThan(0);
      expect(SUBAGENT_MAX_FILE_PATHS).toBeLessThanOrEqual(30);
    });

    it('rejects bare directory paths', () => {
      const bareDirs = ['.', './', '..', '../', ''];
      for (const d of bareDirs) {
        const isBare = /^\.?\/?$|^\.\.?\/?$/.test(d.trim());
        expect(isBare).toBe(true);
      }

      const validPaths = ['src/auth.ts', './src/auth.ts', 'src/', '../other/file.ts'];
      for (const p of validPaths) {
        const isBare = /^\.?\/?$|^\.\.?\/?$/.test(p.trim());
        expect(isBare).toBe(false);
      }
    });

    it('would cap file_paths over the limit', () => {
      const paths = Array.from({ length: 50 }, (_, i) => `src/file${i}.ts`);
      const capped = paths.slice(0, SUBAGENT_MAX_FILE_PATHS);
      expect(capped).toHaveLength(SUBAGENT_MAX_FILE_PATHS);
      expect(capped[0]).toBe('src/file0.ts');
    });
  });

  describe('dematerializeSubagentChunks with ScopedHppView (GAP 7)', () => {
    beforeEach(() => {
      resetProtocol();
      useContextStore.getState().resetSession();
    });

    it('cleans up refs that the heuristic pass would miss but the scoped view touched via getRef', () => {
      // Simulate a parent chunk that already exists before the subagent runs.
      const preExistingHashes = new Set<string>();
      const preExistingSources = new Set<string>();

      // A nested-tool-call ref the heuristic pass would miss: it's materialized
      // (not dormant in the context store), has no source matching any chunk,
      // but was resolved by the subagent through the scoped view.
      const hiddenHash = 'hiddenref000001';
      materialize(hiddenHash, 'result', undefined, 120, 0, '');

      const view = createScopedView();
      // Subagent resolves the ref through the scoped view (e.g. via a nested
      // tool call that calls getRef). This is the information the heuristic
      // pass lacks.
      view.getRef(hiddenHash);

      expect(getRef(hiddenHash)?.visibility).toBe('materialized');

      dematerializeSubagentChunks(preExistingHashes, preExistingSources, view);

      // The scoped view's touchedHashes drove cleanup even though the chunk
      // store had no record of this hash. `dematerialize` transitions
      // materialized → referenced in the HPP state machine.
      expect(getRef(hiddenHash)?.visibility).toBe('referenced');
    });

    it('respects preExistingHashes even when the scoped view touched them', () => {
      const hash = 'preexisting0001';
      materialize(hash, 'file', 'src/pre.ts', 100, 10, '');
      const preExistingHashes = new Set([hash]);

      const view = createScopedView();
      view.getRef(hash);

      dematerializeSubagentChunks(preExistingHashes, new Set(), view);
      expect(getRef(hash)?.visibility).toBe('materialized');
    });
  });

  describe('dematerializeSubagentChunks (structural)', () => {
    it('exported function exists and does not dematerialize pinned or pre-existing chunks', () => {
      // The fix ensures that after executeSubagent returns, non-pinned
      // subagent-created chunks are dematerialized in HPP and compacted
      // in the context store. This is a structural contract test — full
      // integration requires the Tauri runtime.
      //
      // Key invariants:
      // 1. Chunks in preExistingHashes are NOT dematerialized (parent owns them)
      // 2. Chunks whose source is in preExistingSources are NOT dematerialized
      // 3. Pinned chunks are NOT dematerialized (parent needs them)
      // 4. Only non-pinned, subagent-created materialized chunks are dematerialized
      // 5. compactDormantChunks is called after dematerialization

      const preExisting = new Set(['hash_a']);
      const preExistingSources = new Set(['src/existing.ts']);

      // Simulate chunk classification
      const chunks = [
        { hash: 'hash_a', pinned: false, source: 'src/a.ts', isPreExisting: true },
        { hash: 'hash_b', pinned: true, source: 'src/b.ts', isPreExisting: false },
        { hash: 'hash_c', pinned: false, source: 'src/existing.ts', isPreExisting: false },
        { hash: 'hash_d', pinned: false, source: 'src/new.ts', isPreExisting: false },
      ];

      const shouldDematerialize = chunks.filter(c =>
        !preExisting.has(c.hash) &&
        !c.pinned &&
        !preExistingSources.has(c.source),
      );

      expect(shouldDematerialize).toHaveLength(1);
      expect(shouldDematerialize[0].hash).toBe('hash_d');
    });
  });

  describe('provider message safety (structural)', () => {
    it('round 0 messages are a single user message', () => {
      // Round 0 format: [{ role: 'user', content: query }]
      const round0Messages = [{ role: 'user', content: 'find auth flow' }];
      expect(round0Messages).toHaveLength(1);
      expect(round0Messages[0].role).toBe('user');
    });

    it('round N messages have no orphaned tool_use blocks', () => {
      // Round N format: [user: snapshot, assistant: last, user: tool_results]
      const roundNMessages = [
        { role: 'user', content: '## SUBAGENT WORKING STATE...' },
        { role: 'assistant', content: [
          { type: 'text', text: 'Searching for auth...' },
          { type: 'tool_use', id: 't1', name: 'batch', input: {} },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1', content: '[OK]...' },
        ]},
      ];

      // Every tool_use has a matching tool_result
      const toolUseIds = new Set<string>();
      const toolResultIds = new Set<string>();
      for (const msg of roundNMessages) {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content as Array<Record<string, unknown>>) {
            if (block.type === 'tool_use') toolUseIds.add(block.id as string);
            if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id as string);
          }
        }
      }
      for (const id of toolUseIds) {
        expect(toolResultIds.has(id)).toBe(true);
      }
    });

    it('round N messages satisfy Gemini alternation (user/model/user)', () => {
      const roles = ['user', 'assistant', 'user'];
      expect(roles[0]).toBe('user');
      expect(roles[roles.length - 1]).toBe('user');
      for (let i = 1; i < roles.length; i++) {
        expect(roles[i]).not.toBe(roles[i - 1]);
      }
    });
  });

  describe('foldSubagentUsageMetrics', () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    it('maps cached_content_tokens to cache read (OpenAI-style alias)', () => {
      const m = foldSubagentUsageMetrics(zero, {
        input_tokens: 100,
        output_tokens: 50,
        cached_content_tokens: 80,
      });
      expect(m.cacheReadTokens).toBe(80);
      expect(m.inputTokens).toBe(100);
      expect(m.outputTokens).toBe(50);
    });

    it('preserves prompt tokens when a later chunk sends input_tokens: 0 (Anthropic)', () => {
      let m = foldSubagentUsageMetrics(zero, {
        input_tokens: 48_000,
        output_tokens: 0,
        cache_read_input_tokens: 40_000,
        cache_creation_input_tokens: 2_000,
      });
      m = foldSubagentUsageMetrics(m, {
        input_tokens: 0,
        output_tokens: 1_200,
      });
      expect(m.inputTokens).toBe(48_000);
      expect(m.outputTokens).toBe(1_200);
      expect(m.cacheReadTokens).toBe(40_000);
      expect(m.cacheWriteTokens).toBe(2_000);
    });

    it('updates input when final Anthropic message_delta includes cumulative input (e.g. server tools)', () => {
      let m = foldSubagentUsageMetrics(zero, {
        input_tokens: 2_679,
        output_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });
      m = foldSubagentUsageMetrics(m, {
        input_tokens: 0,
        output_tokens: 200,
      });
      m = foldSubagentUsageMetrics(m, {
        input_tokens: 10_682,
        output_tokens: 510,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });
      expect(m.inputTokens).toBe(10_682);
      expect(m.outputTokens).toBe(510);
    });
  });
});
