import { describe, it, expect } from 'vitest';
import {
  estimateHydrationCosts,
  cheapestSufficientMode,
  isFrontendResolvable,
  hydrate,
} from './uhppHydration';
import type { HashLookupResult } from './hashResolver';
import type { HydrationMode } from './uhppCanonical';

// ---------------------------------------------------------------------------
// Mock lookup
// ---------------------------------------------------------------------------

const SAMPLE_CODE = `export function authenticate(token: string): boolean {
  if (!token) return false;
  return validateJwt(token);
}

export class AuthService {
  private secret: string;
  constructor(secret: string) { this.secret = secret; }
  verify(token: string) { return authenticate(token); }
}

export const AUTH_HEADER = 'Authorization';
`;

function mockLookup(content = SAMPLE_CODE): (hash: string) => Promise<HashLookupResult | null> {
  return async (hash: string) => {
    if (hash === 'missing') return null;
    return { content, source: 'src/auth.ts' };
  };
}

// ---------------------------------------------------------------------------
// estimateHydrationCosts
// ---------------------------------------------------------------------------

describe('estimateHydrationCosts', () => {
  it('returns costs for all 9 modes', () => {
    const costs = estimateHydrationCosts(1000);
    expect(costs).toHaveLength(9);
    const modes = costs.map(c => c.mode);
    expect(modes).toContain('id_only');
    expect(modes).toContain('full');
    expect(modes).toContain('verification_summary');
  });

  it('id_only is always 0 tokens', () => {
    const costs = estimateHydrationCosts(5000);
    const idOnly = costs.find(c => c.mode === 'id_only')!;
    expect(idOnly.estimated_tokens).toBe(0);
  });

  it('full mode equals input tokens', () => {
    const costs = estimateHydrationCosts(2000);
    const full = costs.find(c => c.mode === 'full')!;
    expect(full.estimated_tokens).toBe(2000);
  });

  it('costs are monotonically non-decreasing in expected order', () => {
    const costs = estimateHydrationCosts(1000);
    const costMap = Object.fromEntries(costs.map(c => [c.mode, c.estimated_tokens]));
    expect(costMap['id_only']).toBeLessThanOrEqual(costMap['digest']);
    expect(costMap['digest']).toBeLessThanOrEqual(costMap['edit_ready_digest']);
    expect(costMap['edit_ready_digest']).toBeLessThanOrEqual(costMap['full']);
  });

  it('marks backend-requiring modes correctly', () => {
    const costs = estimateHydrationCosts(1000);
    const costMap = Object.fromEntries(costs.map(c => [c.mode, c]));
    expect(costMap['id_only'].requires_backend).toBe(false);
    expect(costMap['digest'].requires_backend).toBe(false);
    expect(costMap['full'].requires_backend).toBe(false);
    expect(costMap['semantic_slice'].requires_backend).toBe(true);
    expect(costMap['neighborhood_pack'].requires_backend).toBe(true);
    expect(costMap['diff_view'].requires_backend).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cheapestSufficientMode
// ---------------------------------------------------------------------------

describe('cheapestSufficientMode', () => {
  it('returns id_only when minimum is 0', () => {
    expect(cheapestSufficientMode(1000, 0)).toBe('id_only');
  });

  it('returns full when nothing cheaper is sufficient', () => {
    expect(cheapestSufficientMode(100, 200)).toBe('full');
  });

  it('returns digest for small minimums', () => {
    const mode = cheapestSufficientMode(1000, 30);
    expect(mode).toBe('digest');
  });

  it('returns full when minimum equals full tokens', () => {
    expect(cheapestSufficientMode(1000, 1000)).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// isFrontendResolvable
// ---------------------------------------------------------------------------

describe('isFrontendResolvable', () => {
  const frontendModes: HydrationMode[] = [
    'id_only', 'digest', 'edit_ready_digest', 'exact_span', 'full', 'verification_summary',
  ];
  const backendModes: HydrationMode[] = [
    'semantic_slice', 'neighborhood_pack', 'diff_view',
  ];

  it.each(frontendModes)('%s is frontend-resolvable', (mode) => {
    expect(isFrontendResolvable(mode)).toBe(true);
  });

  it.each(backendModes)('%s requires backend', (mode) => {
    expect(isFrontendResolvable(mode)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hydrate — frontend-resolvable modes
// ---------------------------------------------------------------------------

describe('hydrate', () => {
  describe('id_only', () => {
    it('returns the hash as content with 1 token', async () => {
      const result = await hydrate('id_only', 'abc12345', mockLookup());
      expect(result.mode).toBe('id_only');
      expect(result.content).toBe('abc12345');
      expect(result.token_estimate).toBe(1);
      expect(result.ref).toBe('h:abc12345');
    });

    it('does not call lookup', async () => {
      const result = await hydrate('id_only', 'missing', mockLookup());
      expect(result.content).toBe('missing');
    });
  });

  describe('full', () => {
    it('returns full content with hash and token estimate', async () => {
      const result = await hydrate('full', 'abc12345', mockLookup());
      expect(result.mode).toBe('full');
      expect(result.content).toBe(SAMPLE_CODE);
      expect(result.content_hash).toBeDefined();
      expect(result.token_estimate).toBeGreaterThan(0);
    });
  });

  describe('digest', () => {
    it('returns a compact symbol digest', async () => {
      const result = await hydrate('digest', 'abc12345', mockLookup());
      expect(result.mode).toBe('digest');
      expect(result.content).toContain('authenticate');
      expect(result.content).toContain('AuthService');
      expect(result.token_estimate).toBeLessThan(100);
    });
  });

  describe('edit_ready_digest', () => {
    it('returns line-anchored digest', async () => {
      const result = await hydrate('edit_ready_digest', 'abc12345', mockLookup());
      expect(result.mode).toBe('edit_ready_digest');
      expect(result.content).toContain('authenticate');
      expect(result.content_hash).toBeDefined();
    });
  });

  describe('exact_span', () => {
    it('extracts specified line range', async () => {
      const result = await hydrate('exact_span', 'abc12345', mockLookup(), { lines: '1-3' });
      expect(result.mode).toBe('exact_span');
      const lines = result.content.split('\n');
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(result.content).toContain('authenticate');
    });

    it('throws without lines option', async () => {
      await expect(hydrate('exact_span', 'abc12345', mockLookup()))
        .rejects.toThrow('requires options.lines');
    });
  });

  // ── backend-only modes throw ──

  describe('semantic_slice', () => {
    it('throws with actionable message', async () => {
      await expect(hydrate('semantic_slice', 'abc12345', mockLookup(), {
        symbolName: 'authenticate', symbolKind: 'fn',
      })).rejects.toThrow('requires backend resolution');
    });
  });

  describe('neighborhood_pack', () => {
    it('throws with not-implemented message', async () => {
      await expect(hydrate('neighborhood_pack', 'abc12345', mockLookup()))
        .rejects.toThrow('not yet implemented');
    });
  });

  describe('diff_view', () => {
    it('throws with actionable message', async () => {
      await expect(hydrate('diff_view', 'abc12345', mockLookup(), { diffRef: 'def67890' }))
        .rejects.toThrow('requires backend resolution');
    });
  });

  describe('verification_summary', () => {
    it('throws with structured-data message', async () => {
      await expect(hydrate('verification_summary', 'abc12345', mockLookup()))
        .rejects.toThrow('requires structured VerificationResult');
    });
  });

  // ── error cases ──

  describe('missing hash', () => {
    it('throws when lookup returns null', async () => {
      await expect(hydrate('full', 'missing', mockLookup()))
        .rejects.toThrow('not found');
    });
  });
});
