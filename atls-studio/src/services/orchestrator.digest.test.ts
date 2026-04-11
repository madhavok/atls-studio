import { describe, expect, it, vi } from 'vitest';

vi.mock('../stores/swarmStore', () => ({
  useSwarmStore: { getState: () => ({ cancelSwarm: vi.fn() }) },
}));

const { orchestrator } = await import('./orchestrator');

describe('OrchestratorService buildResearchDigest', () => {
  it('builds file digests, dependency edges, and keyword-scoped edit plan', () => {
    const svc = orchestrator as unknown as {
      buildResearchDigest: (
        smartContent: { path: string; content: string }[],
        filesToModify: string[],
        filesForContext: string[],
        smartHashes: Map<string, string>,
        rawHashes: Map<string, string>,
        fileContents: Map<string, string>,
        keywords: string[],
        projectProfile: string,
      ) => {
        files: Map<string, { path: string; imports: string[]; editTargets: unknown[]; relevanceScore: number }>;
        dependencyGraph: Map<string, string[]>;
        editPlan: unknown[];
        projectProfile: string;
      };
    };

    const ts = `import { x } from './dep';
export function fooBar() { return x; }
`;
    const digest = svc.buildResearchDigest(
      [{ path: 'src/a.ts', content: ts }],
      ['src/a.ts'],
      [],
      new Map([['src/a.ts', 'smartH']]),
      new Map([['src/a.ts', 'rawH']]),
      new Map([['src/a.ts', ts]]),
      ['fooBar'],
      'test-profile',
    );

    expect(digest.projectProfile).toBe('test-profile');
    const file = digest.files.get('src/a.ts');
    expect(file).toBeDefined();
    expect(file!.imports).toContain('./dep');
    expect(file!.relevanceScore).toBeGreaterThanOrEqual(1);
    expect(digest.dependencyGraph.get('src/a.ts')).toEqual(['./dep']);
    expect(digest.editPlan.length).toBeGreaterThanOrEqual(1);
  });
});
