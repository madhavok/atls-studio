/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import { useRefactorStore } from './refactorStore';

describe('refactorStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useRefactorStore.getState().resetConfig();
    useRefactorStore.getState().resetSession();
  });

  it('setConfig merges and getConfigForPrompt includes thresholds', () => {
    useRefactorStore.getState().setConfig({ maxFileLines: 999 });
    const prompt = useRefactorStore.getState().getConfigForPrompt();
    expect(prompt).toContain('999');
    expect(prompt).toContain('REFACTORING THRESHOLDS');
  });

  it('addTarget and addPlan append; resetSession clears', () => {
    useRefactorStore.getState().addTarget({
      path: 'a.ts',
      lines: 100,
      methodCount: 3,
      avgComplexity: 4,
      maxComplexity: 8,
      highComplexityMethods: [],
      dependentCount: 0,
      suggestedStrategy: 'feature',
    });
    expect(useRefactorStore.getState().targets).toHaveLength(1);

    useRefactorStore.getState().addPlan({
      id: 'p1',
      sourcePath: 'a.ts',
      targetPath: 'b.ts',
      methods: ['m'],
      strategy: 'feature',
      riskLevel: 'low',
      status: 'planned',
    });
    expect(useRefactorStore.getState().plans).toHaveLength(1);

    useRefactorStore.getState().resetSession();
    expect(useRefactorStore.getState().targets).toHaveLength(0);
    expect(useRefactorStore.getState().plans).toHaveLength(0);
  });

  it('updatePlan merges fields by id', () => {
    useRefactorStore.getState().addPlan({
      id: 'x',
      sourcePath: 'a.ts',
      targetPath: 'b.ts',
      methods: [],
      strategy: 'layer',
      riskLevel: 'medium',
      status: 'planned',
    });
    useRefactorStore.getState().updatePlan('x', { status: 'approved' });
    expect(useRefactorStore.getState().plans[0]?.status).toBe('approved');
  });
});
