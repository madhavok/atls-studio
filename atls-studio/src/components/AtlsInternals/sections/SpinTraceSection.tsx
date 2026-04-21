import { useCallback, useMemo, useState } from 'react';
import { useRoundHistoryStore, isMainChatRound } from '../../../stores/roundHistoryStore';
import {
  diagnoseSpinning,
  phaseColorKeyFromSnapshot,
  phaseDisplayFromSnapshot,
  type SpinDiagnosis,
  type SpinMode,
} from '../../../services/spinDetector';
import { useAppStore, type MessageToggles, type MessageTogglesPatch } from '../../../stores/appStore';

const MODE_LABELS: Record<SpinMode, string> = {
  context_loss: 'Context Loss',
  goal_drift: 'Goal Drift',
  stuck_in_phase: 'Stuck in Phase',
  tool_confusion: 'Tool Confusion',
  volatile_unpinned: 'Volatile — Not Pinned',
  completion_gate: 'Completion Gate',
  none: 'None',
};

const MODE_COLORS: Record<SpinMode, string> = {
  context_loss: 'text-red-400',
  goal_drift: 'text-orange-400',
  stuck_in_phase: 'text-yellow-400',
  tool_confusion: 'text-purple-400',
  volatile_unpinned: 'text-red-500',
  completion_gate: 'text-blue-400',
  none: 'text-studio-muted',
};

/** Mode keys exposed to the per-mode toggle grid (excludes synthetic `none`). */
const TOGGLEABLE_SPIN_MODES: Array<Exclude<SpinMode, 'none'>> = [
  'context_loss',
  'goal_drift',
  'stuck_in_phase',
  'tool_confusion',
  'volatile_unpinned',
  'completion_gate',
];

type TierKey = keyof MessageToggles['spin']['tiers'];
const TIER_LABELS: Record<TierKey, string> = { nudge: 'Nudge', strong: 'Strong', halt: 'Halt' };

/**
 * Compact pill-style toggle reused throughout the Interventions panel.
 * Matches the accent/border language used by other Internals rows so the
 * panel does not look grafted onto the section.
 */
function ToggleRow({
  label,
  description,
  value,
  onChange,
  accent,
  disabled,
  titleWhenDisabled,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  accent?: 'default' | 'warning';
  disabled?: boolean;
  titleWhenDisabled?: string;
}) {
  const onBg = accent === 'warning' ? 'bg-studio-warning' : 'bg-studio-accent';
  return (
    <div
      className={`flex items-center justify-between gap-3 px-2 py-1.5 rounded border border-studio-border/30 bg-studio-surface/50 ${disabled ? 'opacity-60' : ''}`}
      title={disabled ? titleWhenDisabled : undefined}
    >
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-studio-text truncate">{label}</div>
        {description && (
          <div className="text-[9px] text-studio-muted leading-snug">{description}</div>
        )}
      </div>
      <button
        type="button"
        aria-pressed={value}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!value)}
        className={`shrink-0 w-8 h-4 rounded-full transition-colors ${value ? onBg : 'bg-studio-border'} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <div
          className={`w-3 h-3 bg-white rounded-full shadow transition-transform ${value ? 'translate-x-4' : 'translate-x-0.5'}`}
        />
      </button>
    </div>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] text-studio-muted uppercase tracking-wider mb-1">{children}</div>
  );
}

function InterventionsPanel() {
  const mt = useAppStore((s) => s.settings.messageToggles);
  const updateMessageToggles = useAppStore((s) => s.updateMessageToggles);
  const [open, setOpen] = useState(false);

  const patch = useCallback((p: MessageTogglesPatch) => updateMessageToggles(p), [updateMessageToggles]);

  // Rough count of suppressed categories so collapsed header shows at-a-glance
  // whether anything is off without expanding.
  const suppressedCount = useMemo(() => {
    let n = 0;
    if (!mt.spin.enabled) n += 1;
    for (const m of TOGGLEABLE_SPIN_MODES) if (!mt.spin.modes[m]) n += 1;
    for (const t of Object.keys(mt.spin.tiers) as TierKey[]) if (!mt.spin.tiers[t] && t !== 'halt') n += 1;
    if (!mt.assess) n += 1;
    if (!mt.completion.verifyStale) n += 1;
    if (!mt.completion.continueImpl) n += 1;
    if (!mt.edits.damaged) n += 1;
    if (!mt.edits.recent) n += 1;
    if (!mt.edits.escalatedRepair) n += 1;
    if (!mt.batchReadSpinWarn) n += 1;
    return n;
  }, [mt]);

  return (
    <div className="border border-studio-border/40 rounded bg-studio-surface/30">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-studio-border/20 transition-colors"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="text-studio-muted text-[10px] w-3 inline-block">{open ? '▾' : '▸'}</span>
        <span className="text-[11px] font-medium text-studio-text">Interventions</span>
        <span className="text-[9px] text-studio-muted">
          Control which &lt;&lt;…&gt;&gt; messages get sent to the model.
        </span>
        {suppressedCount > 0 && (
          <span
            className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-studio-warning/20 text-studio-warning"
            title={`${suppressedCount} intervention(s) currently suppressed`}
          >
            {suppressedCount} off
          </span>
        )}
      </button>

      {open && (
        <div className="px-2 pb-2 space-y-3 border-t border-studio-border/20 pt-2">
          <div className="text-[9px] text-studio-warning bg-studio-warning/10 rounded px-2 py-1">
            Disabling these can let the model spin or loop longer before auto-correcting.
          </div>

          {/* Spin circuit breaker */}
          <div>
            <GroupHeading>Spin Circuit Breaker</GroupHeading>
            <div className="space-y-1">
              <ToggleRow
                label="Spin steering (master)"
                description="When off, evaluateSpin is skipped — no spin messages, no halt."
                value={mt.spin.enabled}
                onChange={(v) => patch({ spin: { enabled: v } })}
              />
              <div className="grid grid-cols-2 gap-1">
                {TOGGLEABLE_SPIN_MODES.map((m) => (
                  <ToggleRow
                    key={m}
                    label={MODE_LABELS[m]}
                    value={mt.spin.modes[m]}
                    onChange={(v) => patch({ spin: { modes: { [m]: v } } })}
                    disabled={!mt.spin.enabled}
                    titleWhenDisabled="Enable spin steering to toggle per-mode."
                  />
                ))}
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(Object.keys(TIER_LABELS) as TierKey[]).map((t) => (
                  <ToggleRow
                    key={t}
                    label={TIER_LABELS[t]}
                    description={
                      t === 'halt'
                        ? 'Aborts the tool loop'
                        : t === 'strong'
                          ? 'Repeated same-mode'
                          : 'First detection'
                    }
                    value={mt.spin.tiers[t]}
                    onChange={(v) => patch({ spin: { tiers: { [t]: v } } })}
                    accent={t === 'halt' ? 'warning' : 'default'}
                    disabled={!mt.spin.enabled}
                    titleWhenDisabled="Enable spin steering to toggle tiers."
                  />
                ))}
              </div>
            </div>
          </div>

          {/* ASSESS */}
          <div>
            <GroupHeading>ASSESS</GroupHeading>
            <ToggleRow
              label="Pinned-WM hygiene"
              description="Prompts the model to review/release pinned working-memory under CTX pressure."
              value={mt.assess}
              onChange={(v) => patch({ assess: v })}
            />
          </div>

          {/* Completion */}
          <div>
            <GroupHeading>Completion Blocker</GroupHeading>
            <div className="space-y-1">
              <ToggleRow
                label="Verify stale"
                description="<<SYSTEM: Verification artifacts are stale…>>"
                value={mt.completion.verifyStale}
                onChange={(v) => patch({ completion: { verifyStale: v } })}
              />
              <ToggleRow
                label="Continue implementation"
                description="<<SYSTEM: Continue any remaining implementation…>>"
                value={mt.completion.continueImpl}
                onChange={(v) => patch({ completion: { continueImpl: v } })}
              />
            </div>
          </div>

          {/* Edit banners */}
          <div>
            <GroupHeading>Edit Banners</GroupHeading>
            <div className="space-y-1">
              <ToggleRow
                label="Damaged edit"
                description="<<DAMAGED EDIT: …>> for edit: BB entries with matching err: entries."
                value={mt.edits.damaged}
                onChange={(v) => patch({ edits: { damaged: v } })}
              />
              <ToggleRow
                label="Recent edits"
                description="<<RECENT EDITS: …>> anti-re-read banner for healthy edit: entries."
                value={mt.edits.recent}
                onChange={(v) => patch({ edits: { recent: v } })}
              />
              <ToggleRow
                label="Escalated repair"
                description="<<ESCALATED REPAIR: …>> for repair: BB entries with ≥2 attempts."
                value={mt.edits.escalatedRepair}
                onChange={(v) => patch({ edits: { escalatedRepair: v } })}
              />
            </div>
          </div>

          {/* Batch summary */}
          <div>
            <GroupHeading>Batch Summary</GroupHeading>
            <ToggleRow
              label="Read-spin WARN / NUDGE"
              description="<<WARN:>> / <<NUDGE:>> lines in batch summaries when re-reading / dry-running."
              value={mt.batchReadSpinWarn}
              onChange={(v) => patch({ batchReadSpinWarn: v })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function confidenceBar(confidence: number) {
  const pct = Math.round(confidence * 100);
  const color = confidence >= 0.7 ? 'bg-red-500' : confidence >= 0.4 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-studio-border/40 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-studio-muted w-8 text-right">{pct}%</span>
    </div>
  );
}

const PHASE_COLORS: Record<string, string> = {
  search: 'bg-blue-500/60',
  read: 'bg-cyan-500/60',
  edit: 'bg-green-500/60',
  preview: 'bg-amber-500/50',
  verify: 'bg-yellow-500/60',
  bb: 'bg-purple-500/60',
  delegate: 'bg-teal-500/60',
  consolidate: 'bg-violet-500/50',
  analyze: 'bg-sky-500/55',
  session: 'bg-indigo-500/55',
  annotate: 'bg-fuchsia-500/50',
  intent: 'bg-rose-500/45',
  system: 'bg-slate-500/55',
  mixed_ops: 'bg-orange-500/45',
  other: 'bg-studio-border/40',
};

function DiagnosisCard({ diagnosis, muted }: { diagnosis: SpinDiagnosis; muted: boolean }) {
  if (!diagnosis.spinning) {
    return (
      <div className="text-xs text-green-400 py-1">
        No spin detected.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs font-semibold ${MODE_COLORS[diagnosis.mode]}`}>
          {MODE_LABELS[diagnosis.mode]}
        </span>
        <span className="text-[10px] text-studio-muted">
          since round {diagnosis.triggerRound}
        </span>
        {muted && (
          <span
            className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-studio-border/40 text-studio-muted border border-studio-border/60"
            title="This mode is currently muted — detections are not sent to the model or escalated."
          >
            muted — not sent to model
          </span>
        )}
      </div>
      {confidenceBar(diagnosis.confidence)}
      <div className="text-[10px] text-studio-muted space-y-0.5">
        {diagnosis.evidence.map((e, i) => (
          <div key={i} className="pl-2 border-l border-studio-border/40">
            {e}
          </div>
        ))}
      </div>
      <div className="text-[10px] text-studio-warning bg-studio-warning/10 rounded px-2 py-1">
        {diagnosis.suggestedAction}
      </div>
    </div>
  );
}

interface FingerprintRow {
  round: number;
  phaseLabel: string;
  phaseColorKey: string;
  phaseTitle: string;
  toolCount: number;
  pathCount: number;
  readStepCount: number | undefined;
  readSpanCount: number | undefined;
  bbCount: number;
  isResearch: boolean;
  hasPlateau: boolean;
  evictedCount: number;
  steeringCount: number;
  textHashShort: string;
  wmDelta: number;
  hashRefsCount: number;
}

function FingerprintTimeline({ rows }: { rows: FingerprintRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[10px] text-studio-muted">No fingerprint data.</div>;
  }

  return (
    <div className="space-y-0.5">
      <div className="grid grid-cols-[36px_80px_minmax(0,1fr)_28px_28px_28px_26px_32px_30px_36px] gap-1 text-[9px] text-studio-muted uppercase tracking-wider pb-1 border-b border-studio-border/20">
        <span>Rnd</span>
        <span>Phase</span>
        <span>Tools</span>
        <span title="Unique paths touched by any op this round">Paths</span>
        <span title="Successful read.* batch steps">Reads</span>
        <span title="Distinct path + line span keys">Spans</span>
        <span>BB</span>
        <span>WM∆</span>
        <span>Refs</span>
        <span>Flags</span>
      </div>
      {rows.map((row) => {
        const flags: string[] = [];
        if (row.isResearch) flags.push('R');
        if (row.hasPlateau) flags.push('P');
        if (row.evictedCount > 0) flags.push(`E${row.evictedCount}`);
        if (row.steeringCount > 0) flags.push(`S${row.steeringCount}`);

        return (
          <div key={row.round} className="grid grid-cols-[36px_80px_minmax(0,1fr)_28px_28px_28px_26px_32px_30px_36px] gap-1 text-[10px] items-center">
            <span className="text-studio-muted font-mono">{row.round}</span>
            <span
              className={`${PHASE_COLORS[row.phaseColorKey] ?? PHASE_COLORS.other} rounded px-1 py-0.5 text-center text-[9px] font-mono truncate`}
              title={row.phaseTitle}
            >
              {row.phaseLabel}
            </span>
            <span
              className="text-studio-text font-mono truncate"
              title={`${row.toolCount} batch steps (ops) this round`}
            >
              {row.toolCount > 0 ? `${row.toolCount} ops` : '-'}
            </span>
            <span className="text-studio-muted font-mono" title="Unique paths from tool targets (all op kinds)">
              {row.pathCount || '-'}
            </span>
            <span className="text-studio-muted font-mono text-[9px]" title="Successful read.* steps">
              {row.readStepCount != null && row.readStepCount > 0 ? row.readStepCount : '—'}
            </span>
            <span className="text-studio-muted font-mono text-[9px]" title="Distinct read spans (path + range)">
              {row.readSpanCount != null && row.readSpanCount > 0 ? row.readSpanCount : '—'}
            </span>
            <span className={`font-mono ${row.bbCount > 0 ? 'text-green-400' : 'text-studio-muted'}`}>
              {row.bbCount || '-'}
            </span>
            <span className={`font-mono text-[9px] ${row.wmDelta > 0 ? 'text-green-400' : row.wmDelta < 0 ? 'text-red-400' : 'text-studio-muted'}`}>
              {row.wmDelta !== 0 ? (row.wmDelta > 0 ? `+${row.wmDelta}` : row.wmDelta) : '-'}
            </span>
            <span className="text-studio-muted font-mono text-[9px]">{row.hashRefsCount || '-'}</span>
            <span className="text-studio-muted font-mono text-[9px]">
              {flags.length > 0 ? flags.join(',') : '-'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function SpinTraceSection() {
  const snapshots = useRoundHistoryStore((s) => s.snapshots);
  const spinToggles = useAppStore((s) => s.settings.messageToggles.spin);

  const mainSnapshots = useMemo(() => snapshots.filter(isMainChatRound), [snapshots]);

  const diagnosis = useMemo(() => {
    if (mainSnapshots.length < 3) return null;
    return diagnoseSpinning(snapshots);
  }, [snapshots, mainSnapshots.length]);

  // Current detected mode counts as "muted" for the purposes of the badge when
  // the master switch is off OR the specific mode toggle is off. This mirrors
  // the decay branch in `evaluateSpin` (see `spinCircuitBreaker.ts`).
  const detectedModeMuted = useMemo(() => {
    if (!diagnosis?.spinning || diagnosis.mode === 'none') return false;
    if (!spinToggles.enabled) return true;
    return spinToggles.modes[diagnosis.mode] === false;
  }, [diagnosis, spinToggles]);

  const fingerprintRows: FingerprintRow[] = useMemo(() => {
    const recent = mainSnapshots.slice(-10);
    return recent.map((s) => ({
      round: s.round,
      phaseLabel: phaseDisplayFromSnapshot(s),
      phaseColorKey: phaseColorKeyFromSnapshot(s),
      phaseTitle: (s.toolSignature?.length ?? 0) > 0 ? (s.toolSignature ?? []).join(', ') : '',
      toolCount: s.toolSignature?.length ?? 0,
      pathCount: s.targetFiles?.length ?? 0,
      readStepCount: s.readFileStepCount,
      readSpanCount: s.uniqueReadSpans,
      bbCount: s.bbDelta?.length ?? 0,
      isResearch: s.isResearchRound ?? false,
      hasPlateau: s.coveragePlateau ?? false,
      evictedCount: s.hashRefsEvicted?.length ?? 0,
      steeringCount: s.steeringInjected?.length ?? 0,
      textHashShort: s.assistantTextHash?.slice(0, 4) ?? '',
      wmDelta: s.wmDelta ?? 0,
      hashRefsCount: s.hashRefsConsumed?.length ?? 0,
    }));
  }, [mainSnapshots]);

  const textRepeatCount = useMemo(() => {
    const hashes = mainSnapshots.slice(-10).map(s => s.assistantTextHash).filter(Boolean);
    const seen = new Map<string, number>();
    for (const h of hashes) {
      if (h) seen.set(h, (seen.get(h) ?? 0) + 1);
    }
    let repeats = 0;
    for (const count of seen.values()) {
      if (count > 1) repeats += count - 1;
    }
    return repeats;
  }, [mainSnapshots]);

  // Interventions panel is configuration, not diagnostics — it must stay
  // reachable even before the first API round so users can pre-configure
  // which messages get sent. Only the diagnostic sub-views are gated by
  // `mainSnapshots.length`.
  if (mainSnapshots.length === 0) {
    return (
      <div className="space-y-3">
        <InterventionsPanel />
        <div className="text-xs text-studio-muted py-6 text-center">
          No round data yet. Spin diagnostics appear after the first 3 API rounds.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Interventions — master / per-mode / per-tier toggles for every
          <<...>> message the app injects. Placed above diagnostics so users
          can correlate detections with which signals are currently sent. */}
      <InterventionsPanel />

      {/* Diagnosis */}
      <div className="bg-studio-surface/50 rounded px-3 py-2 border border-studio-border/30">
        <div className="text-[10px] text-studio-muted uppercase tracking-wider mb-1">Current Diagnosis</div>
        {diagnosis ? (
          <DiagnosisCard diagnosis={diagnosis} muted={detectedModeMuted} />
        ) : (
          <div className="text-xs text-studio-muted">Need 3+ rounds for diagnosis.</div>
        )}
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Rounds</div>
          <div className="text-sm font-semibold font-mono text-studio-text">{mainSnapshots.length}</div>
        </div>
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Text Repeats</div>
          <div className={`text-sm font-semibold font-mono ${textRepeatCount > 0 ? 'text-studio-warning' : 'text-studio-text'}`}>
            {textRepeatCount}
          </div>
        </div>
        <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
          <div className="text-[10px] text-studio-muted">Spin Mode</div>
          <div className={`text-sm font-semibold ${diagnosis ? MODE_COLORS[diagnosis.mode] : 'text-studio-muted'}`}>
            {diagnosis ? MODE_LABELS[diagnosis.mode] : '-'}
          </div>
        </div>
      </div>

      {/* Research convergence */}
      {mainSnapshots.length > 0 && (() => {
        const l = mainSnapshots[mainSnapshots.length - 1];
        if (l.totalResearchRounds == null && l.newCoverage == null) return null;
        return (
          <div className="grid grid-cols-3 gap-2">
            {l.totalResearchRounds != null && (
              <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
                <div className="text-[10px] text-studio-muted">Research Rounds</div>
                <div className="text-sm font-semibold font-mono text-studio-text">{l.totalResearchRounds}</div>
              </div>
            )}
            {l.newCoverage != null && (
              <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
                <div className="text-[10px] text-studio-muted">New Coverage</div>
                <div className={`text-sm font-semibold font-mono ${l.coveragePlateau ? 'text-amber-400' : 'text-studio-text'}`}>{l.newCoverage}</div>
                {l.coveragePlateau && <div className="text-[9px] text-amber-400">plateau</div>}
              </div>
            )}
            {(l.substantiveBbWrites ?? 0) > 0 && (
              <div className="bg-studio-surface/50 rounded px-2 py-1.5 border border-studio-border/30">
                <div className="text-[10px] text-studio-muted">Substantive BB Writes</div>
                <div className="text-sm font-semibold font-mono text-green-400">{l.substantiveBbWrites}</div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Fingerprint timeline */}
      <div>
        <div className="text-[10px] text-studio-muted uppercase tracking-wider mb-1">
          Round Fingerprints (last {fingerprintRows.length})
        </div>
        <FingerprintTimeline rows={fingerprintRows} />
      </div>

      <div className="text-[9px] text-studio-muted">
        R=research P=plateau E=evicted S=steering. Use <code className="text-studio-accent">dg</code> (session.diagnose) for model-readable trace.
      </div>
    </div>
  );
}
