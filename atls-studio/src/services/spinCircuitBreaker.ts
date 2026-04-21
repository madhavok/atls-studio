/**
 * Spin Circuit Breaker (GAP 1)
 *
 * Wraps {@link diagnoseSpinning} with an escalating tier state machine so
 * high-confidence spin detections drive automatic interventions instead of
 * relying on the model to call `session.diagnose` itself.
 *
 * Tiers:
 *   `none`   — no high-confidence spin in the current evaluation window.
 *   `nudge`  — first high-confidence detection in the current user turn:
 *              emit the existing mode-specific `<<SYSTEM: ...>>` block.
 *   `strong` — same mode detected again within the turn: append explicit
 *              next-action directive and warn that continued spin will halt.
 *   `halt`   — third consecutive detection of the same mode: caller should
 *              abort the tool loop (gated by `haltEnabled`).
 *
 * Escalation is turn-scoped: switching user turns (new `turnId`) resets the
 * state so one turn's spin history does not leak across boundaries. A
 * different spin mode inside the same turn resets the tier to `nudge` for the
 * new mode (evidence that the model is thrashing between failure modes is
 * still suppressed at the `nudge` level — escalation requires repetition).
 *
 * Pure by default: state is kept in a module-private object keyed by turnId,
 * with an explicit {@link resetSpinCircuitBreaker} for tests and session
 * resets. No Zustand / AppStore coupling here; callers project the tier into
 * their observable state.
 */

import type { RoundSnapshot } from '../stores/roundHistoryStore';
import { diagnoseSpinning, type SpinDiagnosis, type SpinMode } from './spinDetector';

export type CircuitBreakerTier = 'none' | 'nudge' | 'strong' | 'halt';

export interface CircuitBreakerEvaluation {
  tier: CircuitBreakerTier;
  diagnosis: SpinDiagnosis;
  /** Steering message the caller should inject into the next prompt. */
  message?: string;
  /**
   * True when the caller must abort the in-flight tool loop. Only ever true
   * for tier `halt` and only when {@link EvaluateSpinOptions.haltEnabled}.
   */
  shouldHalt: boolean;
  /** Consecutive same-mode detections that drove this tier (diagnostics). */
  consecutiveSameMode: number;
}

export interface EvaluateSpinOptions {
  /**
   * Minimum diagnosis confidence required to count as a detection. Default
   * 0.7 — matches the threshold used by the legacy inline spin warning in
   * `aiService.buildDynamicContextBlock`.
   */
  minConfidence?: number;
  /**
   * When false, the `halt` tier is suppressed back to `strong` (message and
   * diagnostics retained, `shouldHalt` stays false). Default false — lets
   * the behavior ship behind a feature flag without losing observability.
   */
  haltEnabled?: boolean;
  /**
   * Master switch for steering injection. When false, every detection is
   * treated as a miss for the state machine (streak decays), the returned
   * tier is `none`, `message` is undefined, and `shouldHalt` is false. The
   * raw diagnosis still flows through so UI can display it. Default `true`.
   */
  steeringEnabled?: boolean;
  /**
   * Modes whose detections should be suppressed. Behaves like `steeringEnabled`
   * off for the matching mode: streak resets so re-enabling the mode later
   * cannot latch into `strong` / `halt`.
   */
  mutedModes?: ReadonlySet<SpinMode>;
  /**
   * Tiers whose steering message should be dropped. Unlike mode muting, this
   * preserves the state machine — the next unmuted tier can continue
   * escalation. Typical use: disable `nudge` but keep `strong` / `halt`.
   */
  mutedTiers?: ReadonlySet<CircuitBreakerTier>;
  /**
   * Defensive override for tests / advanced callers. When set, replaces the
   * diagnosis `diagnoseSpinning` would produce for this call.
   */
  diagnosisOverride?: SpinDiagnosis;
}

interface TurnState {
  turnId: number | 'unscoped';
  currentMode: SpinMode | 'none';
  consecutiveSameMode: number;
}

let state: TurnState | null = null;

/** Reset the circuit-breaker state. Call on session reset or between tests. */
export function resetSpinCircuitBreaker(): void {
  state = null;
}

/**
 * Snapshot of the current breaker state — for telemetry / UI. Returns a
 * shallow copy so callers cannot mutate the internal record.
 */
export function getSpinCircuitBreakerState(): Readonly<TurnState> | null {
  return state ? { ...state } : null;
}

function steeringMessage(mode: SpinMode, tier: CircuitBreakerTier, diagnosis: SpinDiagnosis): string | undefined {
  if (tier === 'none') return undefined;

  const base: Record<SpinMode, string> = {
    none: '',
    context_loss:
      '<<SYSTEM: SPIN — context loss. You are re-examining files you already processed. Check BB for existing findings. Use rec(h:XXXX) to restore evicted context.>>',
    goal_drift:
      '<<SYSTEM: SPIN — goal drift. Recent actions diverge from the task plan. Review BB status and refocus on the original goal.>>',
    stuck_in_phase:
      '<<SYSTEM: SPIN — stuck in phase. Reads without progress. Write BB findings for what you know, then act.>>',
    tool_confusion:
      '<<SYSTEM: SPIN — tool confusion. Recent rounds used near-identical tool calls. Declare a specific blocker or try a fundamentally different approach.>>',
    volatile_unpinned:
      '<<SYSTEM: CRITICAL — YOU ARE NOT PINNING. Reads/searches returned VOLATILE h:refs but you did NOT pin them in the SAME batch. You MUST add pi in:rN.refs (or pi hashes:h:XXXX) in the SAME batch call as your reads.>>',
    completion_gate:
      '<<SYSTEM: SPIN — completion blocked. Address the specific requirement or call task_complete with an honest summary.>>',
  };

  const nudge = base[mode] || '<<SYSTEM: SPIN detected — refocus on the current task.>>';
  if (tier === 'nudge') return nudge;

  if (tier === 'strong') {
    return [
      nudge,
      `<<SYSTEM: CIRCUIT BREAKER — ${mode} detected on consecutive rounds (confidence ${(diagnosis.confidence * 100).toFixed(0)}%). ${diagnosis.suggestedAction || 'Take the suggested corrective action now.'} If this spin continues the tool loop will be halted.>>`,
    ].join('\n');
  }

  // tier === 'halt'
  return `<<SYSTEM: CIRCUIT BREAKER HALTED — ${mode} persisted across ${Math.max(3, 1)}+ consecutive rounds. Aborting the tool loop. ${diagnosis.suggestedAction || ''}>>`.trim();
}

/**
 * Evaluate the current snapshot window and advance the breaker state machine.
 * Idempotent per (round, turnId) pair — safe to call multiple times with the
 * same snapshots without double-counting escalations.
 */
export function evaluateSpin(
  snapshots: RoundSnapshot[],
  opts: EvaluateSpinOptions = {},
): CircuitBreakerEvaluation {
  const minConfidence = opts.minConfidence ?? 0.7;
  const haltEnabled = opts.haltEnabled ?? false;
  const steeringEnabled = opts.steeringEnabled ?? true;
  const mutedModes = opts.mutedModes;
  const mutedTiers = opts.mutedTiers;

  const diagnosis = opts.diagnosisOverride ?? diagnoseSpinning(snapshots);
  const mainRounds = snapshots.filter(s => !s.isSubagentRound && !s.isSwarmRound);
  const latestTurnId = mainRounds[mainRounds.length - 1]?.turnId ?? 'unscoped';

  if (!state || state.turnId !== latestTurnId) {
    state = { turnId: latestTurnId, currentMode: 'none', consecutiveSameMode: 0 };
  }

  const rawHit = diagnosis.spinning && diagnosis.confidence >= minConfidence;
  // Mode-level suppression: treat as a miss so the FSM decays. Prevents a
  // silent streak from jumping to strong / halt if the user re-enables the
  // mode mid-turn.
  const modeMuted = rawHit && !!mutedModes && mutedModes.has(diagnosis.mode);
  const hit = rawHit && steeringEnabled && !modeMuted;

  if (!hit) {
    // Decay: no hit this round resets the streak so transient detections don't
    // latch into a halt after a quiet round. Same branch handles
    // master-off (`!steeringEnabled`) and per-mode muting.
    state.currentMode = 'none';
    state.consecutiveSameMode = 0;
    return {
      tier: 'none',
      diagnosis,
      shouldHalt: false,
      consecutiveSameMode: 0,
    };
  }

  if (state.currentMode === diagnosis.mode) {
    state.consecutiveSameMode += 1;
  } else {
    state.currentMode = diagnosis.mode;
    state.consecutiveSameMode = 1;
  }

  let tier: CircuitBreakerTier;
  if (state.consecutiveSameMode >= 3) {
    tier = haltEnabled ? 'halt' : 'strong';
  } else if (state.consecutiveSameMode >= 2) {
    tier = 'strong';
  } else {
    tier = 'nudge';
  }

  // Tier-level mute: drop the message and suppress halt without touching
  // FSM state so the next unmuted tier continues the escalation.
  const tierMuted = !!mutedTiers && mutedTiers.has(tier);
  const message = tierMuted ? undefined : steeringMessage(diagnosis.mode, tier, diagnosis);
  const shouldHalt = tier === 'halt' && !tierMuted;

  return {
    tier,
    diagnosis,
    message,
    shouldHalt,
    consecutiveSameMode: state.consecutiveSameMode,
  };
}
