import { describe, it, expect, beforeEach } from 'vitest';
import { useContextStore } from '../stores/contextStore';
import { deduplicateOutput } from './outputDedup';

describe('deduplicateOutput', () => {
  beforeEach(() => {
    useContextStore.getState().resetSession();
  });

  it('returns unchanged when chunk registry is empty', () => {
    const r = deduplicateOutput('```ts\na\nb\nc\nd\n```');
    expect(r.refsInserted).toBe(0);
    expect(r.text).toContain('```');
  });

  it('replaces a high-overlap code block with an h: ref', () => {
    const code = ['const a = 1', 'const b = 2', 'const c = 3', 'const d = 4'].join('\n');
    const store = useContextStore.getState();
    store.addChunk(code, 'smart', 'src/x.ts');

    const block = `\`\`\`ts\n${code}\n\`\`\``;
    const r = deduplicateOutput(`Here:\n${block}`);
    expect(r.refsInserted).toBeGreaterThanOrEqual(1);
    expect(r.text).toMatch(/h:[a-f0-9]/);
    expect(r.text).not.toContain('const a = 1');
  });
});
