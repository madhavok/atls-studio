/**
 * Refactor Store - State management for the AI Refactor agent
 *
 * Tracks refactoring configuration, discovered targets, plans,
 * and execution progress for the 4-phase refactoring workflow.
 */

import { create } from 'zustand';

// LocalStorage key for persisting config
const REFACTOR_CONFIG_KEY = 'atls-studio-refactor-config';

// ============================================================================
// Types
// ============================================================================

/** Refactoring configuration thresholds */
export interface RefactorConfig {
  // File size targets
  maxFileLines: number;
  targetFileLines: number;
  maxMethodLines: number;

  // Complexity thresholds
  minComplexityForExtraction: number;
  highComplexityThreshold: number;

  // Strategy auto-selection thresholds
  featureExtractionMaxLines: number;
  featureExtractionMaxComplexity: number;
  featureExtractionMaxDependents: number;

  layerExtractionMaxLines: number;
  layerExtractionMaxComplexity: number;
  layerExtractionMaxDependents: number;

  // Safety settings
  requirePlanReview: boolean;
  verifyAfterEach: boolean;
  commitAfterSuccess: boolean;
  rollbackOnFailure: boolean;
  maxDependentsForAutomatic: number;
  requireReviewForPublicAPI: boolean;
}

/** Strategy types for extraction */
export type ExtractionStrategy = 'feature' | 'layer' | 'multi-phase';

/** A discovered file that exceeds target thresholds */
export interface RefactorTarget {
  path: string;
  lines: number;
  methodCount: number;
  avgComplexity: number;
  maxComplexity: number;
  highComplexityMethods: string[];
  dependentCount: number;
  suggestedStrategy: ExtractionStrategy;
}

/** Planned extraction for a target file */
export interface ExtractionPlan {
  id: string;
  sourcePath: string;
  targetPath: string;
  methods: string[];
  strategy: ExtractionStrategy;
  riskLevel: 'low' | 'medium' | 'high';
  status: 'planned' | 'plan-reviewed' | 'approved' | 'executing' | 'completed' | 'failed' | 'rolled-back';
  planHash?: string;
  error?: string;
}

/** Overall refactoring session state */
export type RefactorPhase = 'idle' | 'discovering' | 'analyzing' | 'planning' | 'executing' | 'complete';

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: RefactorConfig = {
  maxFileLines: 500,
  targetFileLines: 300,
  maxMethodLines: 50,

  minComplexityForExtraction: 5,
  highComplexityThreshold: 15,

  featureExtractionMaxLines: 800,
  featureExtractionMaxComplexity: 10,
  featureExtractionMaxDependents: 5,

  layerExtractionMaxLines: 1500,
  layerExtractionMaxComplexity: 15,
  layerExtractionMaxDependents: 15,

  requirePlanReview: true,
  verifyAfterEach: true,
  commitAfterSuccess: true,
  rollbackOnFailure: true,
  maxDependentsForAutomatic: 5,
  requireReviewForPublicAPI: true,
};

/** Load persisted config from localStorage */
function loadConfig(): RefactorConfig {
  try {
    const saved = localStorage.getItem(REFACTOR_CONFIG_KEY);
    if (saved) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.error('[refactorStore] Failed to load config:', e);
  }
  return { ...DEFAULT_CONFIG };
}

/** Persist config to localStorage */
function saveConfig(config: RefactorConfig) {
  try {
    localStorage.setItem(REFACTOR_CONFIG_KEY, JSON.stringify(config));
  } catch (e) {
    console.error('[refactorStore] Failed to save config:', e);
  }
}

// ============================================================================
// Store
// ============================================================================

interface RefactorState {
  // Configuration
  config: RefactorConfig;
  setConfig: (partial: Partial<RefactorConfig>) => void;
  resetConfig: () => void;

  // Session state
  phase: RefactorPhase;
  setPhase: (phase: RefactorPhase) => void;

  // Discovered targets
  targets: RefactorTarget[];
  setTargets: (targets: RefactorTarget[]) => void;
  addTarget: (target: RefactorTarget) => void;
  clearTargets: () => void;

  // Extraction plans
  plans: ExtractionPlan[];
  setPlans: (plans: ExtractionPlan[]) => void;
  addPlan: (plan: ExtractionPlan) => void;
  updatePlan: (id: string, update: Partial<ExtractionPlan>) => void;
  removePlan: (id: string) => void;
  clearPlans: () => void;

  // Progress stats
  stats: {
    filesScanned: number;
    targetsFound: number;
    extractionsPlanned: number;
    extractionsCompleted: number;
    extractionsFailed: number;
    linesReduced: number;
  };
  updateStats: (partial: Partial<RefactorState['stats']>) => void;

  // Session management
  resetSession: () => void;

  // Computed helpers
  getConfigForPrompt: () => string;
}

export const useRefactorStore = create<RefactorState>((set, get) => ({
  // Configuration
  config: loadConfig(),
  setConfig: (partial) =>
    set((state) => {
      const merged = { ...state.config, ...partial };
      saveConfig(merged);
      return { config: merged };
    }),
  resetConfig: () => {
    saveConfig(DEFAULT_CONFIG);
    set({ config: { ...DEFAULT_CONFIG } });
  },

  // Session state
  phase: 'idle',
  setPhase: (phase) => set({ phase }),

  // Targets
  targets: [],
  setTargets: (targets) => set({ targets }),
  addTarget: (target) =>
    set((state) => ({ targets: [...state.targets, target] })),
  clearTargets: () => set({ targets: [] }),

  // Plans
  plans: [],
  setPlans: (plans) => set({ plans }),
  addPlan: (plan) =>
    set((state) => ({ plans: [...state.plans, plan] })),
  updatePlan: (id, update) =>
    set((state) => ({
      plans: state.plans.map((p) => (p.id === id ? { ...p, ...update } : p)),
    })),
  removePlan: (id) =>
    set((state) => ({
      plans: state.plans.filter((p) => p.id !== id),
    })),
  clearPlans: () => set({ plans: [] }),

  // Stats
  stats: {
    filesScanned: 0,
    targetsFound: 0,
    extractionsPlanned: 0,
    extractionsCompleted: 0,
    extractionsFailed: 0,
    linesReduced: 0,
  },
  updateStats: (partial) =>
    set((state) => ({
      stats: { ...state.stats, ...partial },
    })),

  // Session management
  resetSession: () =>
    set({
      phase: 'idle',
      targets: [],
      plans: [],
      stats: {
        filesScanned: 0,
        targetsFound: 0,
        extractionsPlanned: 0,
        extractionsCompleted: 0,
        extractionsFailed: 0,
        linesReduced: 0,
      },
    }),

  // Build config string for system prompt injection
  getConfigForPrompt: () => {
    const c = get().config;
    return [
      `## REFACTORING THRESHOLDS`,
      `Target: ≤${c.maxFileLines} LOC per file (ideal: ${c.targetFileLines})`,
      `Methods: ≤${c.maxMethodLines} LOC, extract when complexity ≥${c.minComplexityForExtraction} (high priority ≥${c.highComplexityThreshold})`,
      ``,
      `## STRATEGY AUTO-SELECT`,
      `Feature extraction: file <${c.featureExtractionMaxLines} LOC, avg complexity <${c.featureExtractionMaxComplexity}, <${c.featureExtractionMaxDependents} dependents`,
      `Layer extraction: file <${c.layerExtractionMaxLines} LOC, avg complexity <${c.layerExtractionMaxComplexity}, <${c.layerExtractionMaxDependents} dependents`,
      `Multi-phase: anything above layer thresholds`,
      ``,
      `## SAFETY`,
      c.requirePlanReview ? `• ALWAYS run impact_analysis + plan before extract/move/rename — present edit tuples for review` : '',
      c.verifyAfterEach ? `• Verify (typecheck + test) after each extraction` : '',
      c.commitAfterSuccess ? `• Commit atomically after each successful extraction` : '',
      c.rollbackOnFailure ? `• Rollback via refactor({action:"rollback"}) on verification failure (hash-based restore)` : '',
      `• Auto-approve extractions with ≤${c.maxDependentsForAutomatic} dependents`,
      c.requireReviewForPublicAPI ? `• Require confirmation for public API changes` : '',
    ]
      .filter(Boolean)
      .join('\n');
  },
}));
