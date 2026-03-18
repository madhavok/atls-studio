import { describe, expect, it } from 'vitest';
import type { AIProvider, ChatMessage, ChatMode } from './aiService';

function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
}

Object.defineProperty(globalThis, 'localStorage', {
  value: createLocalStorageMock(),
  configurable: true,
});

const { areToolsEnabledForProvider, deriveMutationCompletionBlocker } = await import('./aiService');
const { useAppStore } = await import('../stores/appStore');

function normalizeConversationHistoryForTest(messages: Array<ChatMessage & {
  parts?: Array<{ type: string; content?: string; toolCall?: { id: string; name: string; args?: Record<string, unknown>; result?: string } }>;
  segments?: Array<{ type: string; content?: string; toolCall?: { id: string; name: string; args?: Record<string, unknown>; result?: string } }>;
}>): Array<{ role: string; content: unknown }> {
  const normalized: Array<{ role: string; content: unknown }> = [];
  let pendingToolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> | null = null;

  for (const msg of messages) {
    if (pendingToolResults?.length && msg.role !== 'user') {
      normalized.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = null;
    }

    if (msg.role === 'assistant' && msg.parts?.length) {
      const modelBlocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = [];
      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
      for (const part of msg.parts) {
        if (part.type === 'text' && part.content) {
          modelBlocks.push({ type: 'text', text: part.content });
        } else if (part.type === 'tool' && part.toolCall) {
          modelBlocks.push({
            type: 'tool_use',
            id: part.toolCall.id,
            name: part.toolCall.name,
            input: part.toolCall.args ?? {},
          });
          if (part.toolCall.result != null) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: part.toolCall.id,
              content: part.toolCall.result,
            });
          }
        }
      }
      normalized.push({ role: 'assistant', content: modelBlocks });
      if (toolResults.length > 0) pendingToolResults = toolResults;
      continue;
    }

    if (msg.role === 'user' && pendingToolResults?.length) {
      normalized.push({ role: 'user', content: [...pendingToolResults, { type: 'text', text: String(msg.content) }] });
      pendingToolResults = null;
      continue;
    }

    normalized.push({ role: msg.role, content: msg.content });
  }

  if (pendingToolResults?.length) {
    normalized.push({ role: 'user', content: pendingToolResults });
  }

  return normalized;
}

function hasToolResultBlocksForTest(content: unknown): boolean {
  return Array.isArray(content)
    && content.some(
      (block) => typeof block === 'object'
        && block !== null
        && 'type' in block
        && (block as { type?: string }).type === 'tool_result',
    );
}

function injectCurrentRoundUserContentForTest(content: unknown, fullPrefix: string): unknown {
  const userContentBlocks: Array<{ type: string; text?: string; content?: string; tool_use_id?: string }> = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block && 'text' in block) {
        userContentBlocks.push({ type: 'text', text: (block as { text?: string }).text ?? '' });
      } else {
        userContentBlocks.push(block as { type: string; text?: string; content?: string; tool_use_id?: string });
      }
    }
    if (fullPrefix) {
      userContentBlocks.push({ type: 'text', text: `\n\n${fullPrefix}` });
    }
    return userContentBlocks;
  }
  return typeof content === 'string' && fullPrefix ? `${content}\n\n${fullPrefix}` : content;
}

function assembleProviderMessagesForTest(durableHistory: Array<{ role: string; content: unknown }>): Array<{ role: string; content: unknown }> {
  const layeredMessages: Array<{ role: string; content: unknown }> = [];
  const lastUserIndex = durableHistory.reduceRight((acc, msg, index) => acc === -1 && msg.role === 'user' ? index : acc, -1);
  // Staged content always goes into the dynamic block (no staged synthetic pair).
  let dynamicContextBlock = 'STAGED\n\nDYNAMIC';

  for (let i = 0; i < durableHistory.length; i++) {
    const msg = durableHistory[i];
    if (i === lastUserIndex) {
      layeredMessages.push({
        role: 'user',
        content: injectCurrentRoundUserContentForTest(msg.content, dynamicContextBlock),
      });
      continue;
    }
    layeredMessages.push(msg);
  }

  return layeredMessages;
}

describe('tool loop history normalization', () => {
  it('flushes tool_result blocks when assistant tool call is last message', () => {
    const messages = [
      { role: 'user', content: 'Use all your tools go wild' },
      {
        role: 'assistant',
        content: 'Starting analysis',
        parts: [
          { type: 'text', content: 'Starting analysis' },
          {
            type: 'tool',
            toolCall: {
              id: 'toolu_123',
              name: 'batch',
              args: { goal: 'scan' },
              result: 'ok',
            },
          },
        ],
      },
    ] satisfies Array<ChatMessage & {
      parts?: Array<{ type: string; content?: string; toolCall?: { id: string; name: string; args?: Record<string, unknown>; result?: string } }>;
    }>;

    const normalized = normalizeConversationHistoryForTest(messages);

    expect(normalized).toHaveLength(3);
    expect(normalized[1]?.role).toBe('assistant');
    expect(normalized[2]?.role).toBe('user');
    expect(Array.isArray(normalized[2]?.content)).toBe(true);
    expect((normalized[2]?.content as Array<{ type: string; tool_use_id?: string }>)[0]?.type).toBe('tool_result');
    expect((normalized[2]?.content as Array<{ type: string; tool_use_id?: string }>)[0]?.tool_use_id).toBe('toolu_123');
  });

  it('keeps tool_result immediately after tool_use when assembling the next round', () => {
    const durableHistory = [
      { role: 'user', content: 'Scan the repo' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Starting scan' },
          { type: 'tool_use', id: 'toolu_456', name: 'batch', input: { goal: 'scan' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_456', content: 'ok' },
        ],
      },
    ];

    const assembled = assembleProviderMessagesForTest(durableHistory);

    expect(assembled).toHaveLength(3);
    expect(assembled[1]?.role).toBe('assistant');
    expect(assembled[2]?.role).toBe('user');
    expect(Array.isArray(assembled[2]?.content)).toBe(true);
    const userBlocks = assembled[2]?.content as Array<{ type: string; tool_use_id?: string; text?: string }>;
    expect(userBlocks[0]?.type).toBe('tool_result');
    expect(userBlocks[0]?.tool_use_id).toBe('toolu_456');
    expect(userBlocks.some((block) => block.type === 'text' && block.text?.includes('STAGED'))).toBe(true);
  });
});

describe('provider tool enablement', () => {
  const providers: AIProvider[] = ['anthropic', 'openai', 'google', 'vertex', 'lmstudio'];
  const toolModes: ChatMode[] = ['agent', 'designer', 'reviewer', 'retriever', 'custom', 'swarm', 'refactor', 'planner'];

  it('enables tools for every provider in all modes including ask', () => {
    for (const provider of providers) {
      expect(areToolsEnabledForProvider(provider, 'ask')).toBe(true);
      for (const mode of toolModes) {
        expect(areToolsEnabledForProvider(provider, mode)).toBe(true);
      }
    }
  });
});

describe('mutation completion gating', () => {
  it('requires verify.build after successful mutations', () => {
    expect(deriveMutationCompletionBlocker({
      ok: true,
      summary: 'mutated files',
      step_results: [
        { id: 'edit1', use: 'change.edit', ok: true, duration_ms: 1 },
      ],
      duration_ms: 1,
    })).toBe('Final verification is still required before task completion.');
  });

  it('clears the blocker when verify.build passes', () => {
    expect(deriveMutationCompletionBlocker({
      ok: true,
      summary: 'verified',
      step_results: [
        { id: 'edit1', use: 'change.edit', ok: true, duration_ms: 1 },
        { id: 'verify1', use: 'verify.build', ok: true, duration_ms: 1 },
      ],
      verify: [{ step_id: 'verify1', passed: true, summary: 'verify.build passed' }],
      duration_ms: 1,
    })).toBeNull();
  });

  it('surfaces failed verify results as completion blockers', () => {
    expect(deriveMutationCompletionBlocker({
      ok: false,
      summary: 'verify failed',
      step_results: [
        { id: 'edit1', use: 'change.edit', ok: true, duration_ms: 1 },
        { id: 'verify1', use: 'verify.build', ok: false, classification: 'fail', duration_ms: 1 },
      ],
      verify: [{ step_id: 'verify1', passed: false, summary: 'verify.build failed', classification: 'fail' }],
      duration_ms: 1,
    })).toBe('verify.build failed');
  });

  it('treats pass-with-warnings as success (not a blocker)', () => {
    expect(deriveMutationCompletionBlocker({
      ok: true,
      summary: 'build with warnings',
      step_results: [
        { id: 'edit1', use: 'change.edit', ok: true, duration_ms: 1 },
        { id: 'verify1', use: 'verify.build', ok: true, classification: 'pass-with-warnings', duration_ms: 1 },
      ],
      verify: [{ step_id: 'verify1', passed: true, summary: 'verify.build passed with warnings', classification: 'pass-with-warnings' }],
      duration_ms: 1,
    })).toBeNull();
  });

  it('returns retryable message for tool-error (not a code failure)', () => {
    const result = deriveMutationCompletionBlocker({
      ok: false,
      summary: 'tool error',
      step_results: [
        { id: 'edit1', use: 'change.edit', ok: true, duration_ms: 1 },
        { id: 'verify1', use: 'verify.build', ok: false, classification: 'tool-error', duration_ms: 1 },
      ],
      verify: [{ step_id: 'verify1', passed: false, summary: 'Working directory does not exist', classification: 'tool-error' }],
      duration_ms: 1,
    });
    expect(result).toBe('verify.build hit a tool error (not a code failure). Check working directory and toolchain, then retry.');
  });
});

describe('context defaults', () => {
  it('defaults entry manifest depth to paths', () => {
    expect(useAppStore.getState().settings.entryManifestDepth).toBe('paths');
  });
});
