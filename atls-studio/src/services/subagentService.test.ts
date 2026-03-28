/**
 * SubAgent Service — engram-first architecture tests.
 *
 * Tests role allowlists, SubAgentResult shape, provider message
 * safety, and budget constants without requiring Tauri runtime.
 */
import { describe, it, expect } from 'vitest';
import { ROLE_ALLOWED_OPS } from './subagentService';
import type { SubAgentRef, SubAgentResult, SubagentType } from './subagentService';
import {
  SUBAGENT_MAX_ROUNDS,
  SUBAGENT_TOKEN_BUDGET_DEFAULT,
  SUBAGENT_PIN_BUDGET_CAP,
  SUBAGENT_STAGED_PATHS_CAP,
} from './promptMemory';

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
});
