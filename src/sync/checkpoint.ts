export type SyncPhase = 'contacts' | 'journeys' | 'tickets';

export interface CheckpointState {
  checkpointPhase: string | null;
  checkpointPageToken: string | null;
  checkpointPagesDone: number;
  checkpointSinceIso: string | null;
  checkpointRunStartedAt: Date | null;
  watermark: Date | null;
}

export interface ResumeRunStart {
  mode: 'resume';
  phase: SyncPhase;
  pageToken: string | undefined;
  pagesDone: number;
  sinceIso: string | undefined;
  runStartedAt: Date;
}

export interface FreshRunStart {
  mode: 'fresh';
  phase: 'contacts';
  pageToken: undefined;
  pagesDone: 0;
  sinceIso: string | undefined;
  runStartedAt: Date;
}

export type RunStart = ResumeRunStart | FreshRunStart;

function isSyncPhase(value: string): value is SyncPhase {
  return value === 'contacts' || value === 'journeys' || value === 'tickets';
}

/**
 * Decides whether a run starts fresh or resumes mid-flight, purely from a
 * SyncState-shaped snapshot — no I/O, so this is directly unit-testable.
 * A non-null checkpointPhase means a previous invocation didn't reach
 * completion (crash, kill -9, dead connection); its sinceIso/runStartedAt
 * are reused verbatim rather than recomputed, so the eventual watermark
 * reflects when the logical run actually started.
 */
export function resolveRunStart(state: CheckpointState, now: () => Date = () => new Date()): RunStart {
  if (state.checkpointPhase && isSyncPhase(state.checkpointPhase)) {
    return {
      mode: 'resume',
      phase: state.checkpointPhase,
      pageToken: state.checkpointPageToken ?? undefined,
      pagesDone: state.checkpointPagesDone,
      sinceIso: state.checkpointSinceIso ?? undefined,
      runStartedAt: state.checkpointRunStartedAt ?? now(),
    };
  }
  return {
    mode: 'fresh',
    phase: 'contacts',
    pageToken: undefined,
    pagesDone: 0,
    sinceIso: state.watermark ? state.watermark.toISOString() : undefined,
    runStartedAt: now(),
  };
}

export interface CheckpointColumns {
  checkpointPhase: string | null;
  checkpointPageToken: string | null;
  checkpointPagesDone: number;
  checkpointSinceIso: string | null;
  checkpointRunStartedAt: Date | null;
}

export function nextPageCheckpoint(
  phase: SyncPhase,
  pagesDone: number,
  nextPageToken: string | undefined,
  sinceIso: string | undefined,
  runStartedAt: Date,
): CheckpointColumns {
  return {
    checkpointPhase: phase,
    checkpointPageToken: nextPageToken ?? null,
    checkpointPagesDone: pagesDone,
    checkpointSinceIso: sinceIso ?? null,
    checkpointRunStartedAt: runStartedAt,
  };
}

export function phaseTransitionCheckpoint(nextPhase: SyncPhase, sinceIso: string | undefined, runStartedAt: Date): CheckpointColumns {
  return {
    checkpointPhase: nextPhase,
    checkpointPageToken: null,
    checkpointPagesDone: 0,
    checkpointSinceIso: sinceIso ?? null,
    checkpointRunStartedAt: runStartedAt,
  };
}

export function clearedCheckpoint(): CheckpointColumns {
  return {
    checkpointPhase: null,
    checkpointPageToken: null,
    checkpointPagesDone: 0,
    checkpointSinceIso: null,
    checkpointRunStartedAt: null,
  };
}
