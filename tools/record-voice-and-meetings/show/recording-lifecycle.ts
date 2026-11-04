export type RecordingPhase =
  | 'requesting' | 'recording' | 'paused' | 'stopping' | 'flushing'
  | 'saving' | 'saved' | 'cancelled' | 'interrupted'
  | 'recoverable-error' | 'terminal-error';

export type RecordingCompletionObservation = {
  /** Opaque DATA-selected reference. Consumers must not branch on its spelling. */
  reasonRef: string;
  observedAtMs: number;
  sourceRef: string;
};

export type RecordingTiming = {
  activeStartedAtMs: number | null;
  accumulatedActiveMs: number;
};

export function beginActiveTime(nowMs: number): RecordingTiming {
  return { activeStartedAtMs: nowMs, accumulatedActiveMs: 0 };
}

export function pauseActiveTime(timing: RecordingTiming, nowMs: number): RecordingTiming {
  if (timing.activeStartedAtMs === null) return timing;
  return {
    activeStartedAtMs: null,
    accumulatedActiveMs: timing.accumulatedActiveMs + Math.max(0, nowMs - timing.activeStartedAtMs),
  };
}

export function resumeActiveTime(timing: RecordingTiming, nowMs: number): RecordingTiming {
  return timing.activeStartedAtMs === null ? { ...timing, activeStartedAtMs: nowMs } : timing;
}

export function activeDurationMs(timing: RecordingTiming, nowMs: number): number {
  return timing.accumulatedActiveMs
    + (timing.activeStartedAtMs === null ? 0 : Math.max(0, nowMs - timing.activeStartedAtMs));
}

export type StopArbiterState = {
  phase: RecordingPhase;
  completion: RecordingCompletionObservation | null;
  providerStopInvoked: boolean;
};

/** First timestamped observation wins and moves to stopping before provider I/O. */
export function claimStop(current: StopArbiterState, completion: RecordingCompletionObservation): {
  state: StopArbiterState;
  accepted: boolean;
  invokeProviderStop: boolean;
} {
  if (current.completion || current.providerStopInvoked
    || ['stopping', 'flushing', 'saving', 'saved', 'cancelled', 'terminal-error'].includes(current.phase)) {
    return { state: current, accepted: false, invokeProviderStop: false };
  }
  return {
    state: { phase: 'stopping', completion, providerStopInvoked: true },
    accepted: true,
    invokeProviderStop: true,
  };
}
