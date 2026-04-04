import { describe, expect, it } from 'vitest';
import { injectMarkerHtml } from './MarkdownMessage';

describe('injectMarkerHtml', () => {
  it('replaces template markers with tpl-card spans', () => {
    const out = injectMarkerHtml('«tpl:foo|a|b»');
    expect(out).toContain('class="tpl-card"');
    expect(out).toContain('data-tpl="foo"');
  });

  it('deduplicates repeated status badges with identical step', () => {
    const raw = '«st:working|step:1/3» «st:working|step:1/3»';
    const out = injectMarkerHtml(raw);
    const matches = out.match(/class="status-badge"/g);
    expect(matches?.length ?? 0).toBe(1);
  });
});
