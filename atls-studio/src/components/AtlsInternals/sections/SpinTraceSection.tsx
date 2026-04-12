import { useMemo } from 'react';
import { useRoundHistoryStore, isMainChatRound } from '../../../stores/roundHistoryStore';
import {
  diagnoseSpinning,
  phaseColorKeyFromSnapshot,
  phaseDisplayFromSnapshot,
  type SpinDiagnosis,
  type SpinMode,
} from '../../../services/spinDetector';

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

function DiagnosisCard({ diagnosis }: { diagnosis: SpinDiagnosis }) {
  if (!diagnosis.spinning) {
    return (
      <div className="text-xs text-green-400 py-1">
        No spin detected.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-semibold ${MODE_COLORS[diagnosis.mode]}`}>
          {MODE_LABELS[diagnosis.mode]}
        </span>
        <span className="text-[10px] text-studio-muted">
          since round {diagnosis.triggerRound}
        </span>
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
  fileCount: number;
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
      <div className="grid grid-cols-[40px_88px_1fr_40px_40px_36px_36px_40px] gap-1 text-[9px] text-studio-muted uppercase tracking-wider pb-1 border-b border-studio-border/20">
        <span>Rnd</span>
        <span>Phase</span>
        <span>Tools</span>
        <span>Files</span>
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
          <div key={row.round} className="grid grid-cols-[40px_88px_1fr_40px_40px_36px_36px_40px] gap-1 text-[10px] items-center">
            <span className="text-studio-muted font-mono">{row.round}</span>
            <span
              className={`${PHASE_COLORS[row.phaseColorKey] ?? PHASE_COLORS.other} rounded px-1 py-0.5 text-center text-[9px] font-mono truncate`}
              title={row.phaseTitle}
            >
              {row.phaseLabel}
            </span>
            <span className="text-studio-text font-mono truncate" title={`${row.toolCount} tools`}>
              {row.toolCount > 0 ? `${row.toolCount} ops` : '-'}
            </span>
            <span className="text-studio-muted font-mono">{row.fileCount || '-'}</span>
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

  const mainSnapshots = useMemo(() => snapshots.filter(isMainChatRound), [snapshots]);

  const diagnosis = useMemo(() => {
    if (mainSnapshots.length < 3) return null;
    return diagnoseSpinning(snapshots);
  }, [snapshots, mainSnapshots.length]);

  const fingerprintRows: FingerprintRow[] = useMemo(() => {
    const recent = mainSnapshots.slice(-10);
    return recent.map((s) => ({
      round: s.round,
      phaseLabel: phaseDisplayFromSnapshot(s),
      phaseColorKey: phaseColorKeyFromSnapshot(s),
      phaseTitle: (s.toolSignature?.length ?? 0) > 0 ? (s.toolSignature ?? []).join(', ') : '',
      toolCount: s.toolSignature?.length ?? 0,
      fileCount: s.targetFiles?.length ?? 0,
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

  if (mainSnapshots.length === 0) {
    return (
      <div className="text-xs text-studio-muted py-6 text-center">
        No round data yet. Spin diagnostics appear after the first 3 API rounds.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Diagnosis */}
      <div className="bg-studio-surface/50 rounded px-3 py-2 border border-studio-border/30">
        <div className="text-[10px] text-studio-muted uppercase tracking-wider mb-1">Current Diagnosis</div>
        {diagnosis ? <DiagnosisCard diagnosis={diagnosis} /> : (
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
