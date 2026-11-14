// packages/ui/show/protocol-session/protocol-session-machine.ts
//
// Pure state machine for a guided protocol session: an ordered list of steps
// runs from a start affordance through each step to a measured completion.
// Time is injected (nowMs) — the reducer never reads a clock, so every
// transition is deterministic and testable. Steps, durations, advance rules,
// and capture fields all arrive as data; the machine names no domain.

export interface ProtocolStep {
  /** Stable step id (row id). */
  id: string;
  /** Planned duration in seconds; 0 or absent = untimed. */
  plannedSeconds?: number;
  /** Declarative advance rule evaluated against live signals. */
  advance?: AdvanceCondition;
  /** Field id this step captures into (input steps). */
  captureField?: string;
}

export interface AdvanceCondition {
  op: string;
  args?: Readonly<Record<string, unknown>>;
}

/** One captured input, ordered — repeat captures never overwrite. */
export interface StepCapture {
  stepId: string;
  fieldId: string;
  value: unknown;
  atMs: number;
}

/** Per-step measured record appended when a step ends. */
export interface StepTranscriptEntry {
  stepId: string;
  plannedSeconds: number;
  actualSeconds: number;
  captures: StepCapture[];
}

export type SessionPhase = 'idle' | 'running' | 'completed' | 'abandoned';

export interface SessionState {
  phase: SessionPhase;
  /** Index into steps while running; equals steps.length after completion. */
  stepIndex: number;
  /** nowMs when the current step started (running only). */
  stepStartedAtMs: number;
  /** nowMs when the session started. */
  sessionStartedAtMs: number;
  /** Session identity for replay-proof downstream writes. */
  sessionId: string;
  transcript: StepTranscriptEntry[];
  /** Captures for the CURRENT step (moved into transcript on advance). */
  pendingCaptures: StepCapture[];
  /** True if the document lost visibility at any point while running. */
  visibilityLost: boolean;
}

export type SessionEvent =
  | { type: 'start'; nowMs: number; sessionId: string }
  | { type: 'advance'; nowMs: number }
  | { type: 'capture'; nowMs: number; fieldId: string; value: unknown }
  | { type: 'abandon'; nowMs: number }
  | { type: 'visibility-lost' };

export function initialSessionState(): SessionState {
  return {
    phase: 'idle',
    stepIndex: 0,
    stepStartedAtMs: 0,
    sessionStartedAtMs: 0,
    sessionId: '',
    transcript: [],
    pendingCaptures: [],
    visibilityLost: false,
  };
}

function closeCurrentStep(state: SessionState, steps: readonly ProtocolStep[], nowMs: number): StepTranscriptEntry {
  const step = steps[state.stepIndex];
  return {
    stepId: step?.id ?? String(state.stepIndex),
    plannedSeconds: step?.plannedSeconds ?? 0,
    actualSeconds: Math.max(0, (nowMs - state.stepStartedAtMs) / 1000),
    captures: state.pendingCaptures,
  };
}

/**
 * Advance the session one event. Terminal phases (completed/abandoned) latch:
 * every event is a no-op after them, so a stray re-render or double tap can
 * never emit twice.
 */
export function reduceSession(
  state: SessionState,
  steps: readonly ProtocolStep[],
  event: SessionEvent,
): SessionState {
  if (state.phase === 'completed' || state.phase === 'abandoned') return state;

  switch (event.type) {
    case 'start': {
      if (state.phase !== 'idle') return state;
      if (steps.length === 0) {
        // Zero-step protocol: honest immediate completion with an empty transcript.
        return {
          ...state,
          phase: 'completed',
          sessionId: event.sessionId,
          sessionStartedAtMs: event.nowMs,
          stepStartedAtMs: event.nowMs,
        };
      }
      return {
        ...state,
        phase: 'running',
        stepIndex: 0,
        sessionId: event.sessionId,
        sessionStartedAtMs: event.nowMs,
        stepStartedAtMs: event.nowMs,
        transcript: [],
        pendingCaptures: [],
      };
    }
    case 'capture': {
      if (state.phase !== 'running') return state;
      const capture: StepCapture = {
        stepId: steps[state.stepIndex]?.id ?? String(state.stepIndex),
        fieldId: event.fieldId,
        value: event.value,
        atMs: event.nowMs,
      };
      return { ...state, pendingCaptures: [...state.pendingCaptures, capture] };
    }
    case 'advance': {
      if (state.phase !== 'running') return state;
      const entry = closeCurrentStep(state, steps, event.nowMs);
      const transcript = [...state.transcript, entry];
      const nextIndex = state.stepIndex + 1;
      if (nextIndex >= steps.length) {
        return { ...state, phase: 'completed', stepIndex: nextIndex, transcript, pendingCaptures: [] };
      }
      return {
        ...state,
        stepIndex: nextIndex,
        stepStartedAtMs: event.nowMs,
        transcript,
        pendingCaptures: [],
      };
    }
    case 'abandon': {
      if (state.phase !== 'running') return state;
      const entry = closeCurrentStep(state, steps, event.nowMs);
      return { ...state, phase: 'abandoned', transcript: [...state.transcript, entry], pendingCaptures: [] };
    }
    case 'visibility-lost': {
      if (state.phase !== 'running') return state;
      return { ...state, visibilityLost: true };
    }
    default:
      return state;
  }
}

/** Measured summary for the completion payload — every number is measured, never asserted. */
export interface SessionSummary {
  sessionId: string;
  stepsTotal: number;
  stepsCompleted: number;
  plannedSeconds: number;
  actualSeconds: number;
  captures: StepCapture[];
  visibilityLost: boolean;
  completed: boolean;
}

export function summarizeSession(state: SessionState, steps: readonly ProtocolStep[]): SessionSummary {
  const plannedSeconds = steps.reduce((sum, s) => sum + (s.plannedSeconds ?? 0), 0);
  const actualSeconds = state.transcript.reduce((sum, e) => sum + e.actualSeconds, 0);
  return {
    sessionId: state.sessionId,
    stepsTotal: steps.length,
    stepsCompleted: state.transcript.length,
    plannedSeconds,
    actualSeconds,
    captures: state.transcript.flatMap((e) => e.captures),
    visibilityLost: state.visibilityLost,
    completed: state.phase === 'completed',
  };
}
