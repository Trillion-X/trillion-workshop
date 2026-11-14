// packages/ui/show/protocol-session/ProtocolSession.tsx
//
// The guided protocol session surface: start affordance → each step actively
// presented (content registry) and advanced (advance registry) → measured
// completion reported through onLifecycle. The component owns the clock and
// interaction wiring; all decisions live in the pure machine + registries.
// Steps arrive as data rows — this component names no protocol.

import * as React from 'react';

import type { BlindRegistry } from '../blind-registry/blind-registry';
import { cn } from '../cn';
import {
  canAdvanceStep,
  createStepAdvanceRegistry,
  type StepAdvancePredicate,
  type StepSignals,
} from './advance-registry';
import {
  initialSessionState,
  reduceSession,
  summarizeSession,
  type AdvanceCondition,
  type ProtocolStep,
  type SessionSummary,
} from './protocol-session-machine';
import {
  createStepContentRegistry,
  type StepContentRenderer,
} from './step-content-registry';

/** One step as the surface supplies it: machine fields + the open content data bag. */
export interface ProtocolSessionStep extends ProtocolStep {
  /** Content renderer key (open — resolved via the step-content registry). */
  content?: string;
  /** The step row's open data bag handed to the content renderer. */
  data: Readonly<Record<string, unknown>>;
}

export type SessionLifecycleEvent = 'started' | 'completed' | 'abandoned';

export interface ProtocolSessionProps {
  steps: readonly ProtocolSessionStep[];
  /** Title above the session (the protocol's human name). */
  title?: string;
  /** One human line under the title on the idle screen. */
  intro?: string;
  /** Start button label. */
  startLabel?: string;
  /** Advance button label for tap-advanced steps. */
  nextLabel?: string;
  /** Completion headline. */
  doneLabel?: string;
  /** Reports lifecycle boundaries with the measured summary. */
  onLifecycle?: (event: SessionLifecycleEvent, summary: SessionSummary) => void;
  /**
   * Skip the idle screen and begin at the first step on mount. For a one-step
   * input session (a check-in) the input IS the only real interaction — an
   * extra Start tap would be friction, not guidance.
   */
  autoStart?: boolean;
  contentRegistry?: BlindRegistry<StepContentRenderer>;
  advanceRegistry?: BlindRegistry<StepAdvancePredicate>;
  /** Injected id factory (tests); defaults to crypto.randomUUID. */
  makeSessionId?: () => string;
  className?: string;
}

function defaultSessionId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  return c && 'randomUUID' in c ? c.randomUUID() : `sess-${Math.random().toString(36).slice(2)}`;
}

export function ProtocolSession({
  steps,
  title,
  intro,
  startLabel = 'Start',
  nextLabel = 'Next',
  doneLabel = 'Done',
  onLifecycle,
  autoStart = false,
  contentRegistry,
  advanceRegistry,
  makeSessionId = defaultSessionId,
  className,
}: ProtocolSessionProps) {
  const contentReg = React.useMemo(() => contentRegistry ?? createStepContentRegistry(), [contentRegistry]);
  const advanceReg = React.useMemo(() => advanceRegistry ?? createStepAdvanceRegistry(), [advanceRegistry]);

  const [state, setState] = React.useState(initialSessionState);
  const [nowMs, setNowMs] = React.useState(0);
  const [nextTapped, setNextTapped] = React.useState(false);
  const reportedRef = React.useRef<SessionLifecycleEvent | null>(null);

  const machineSteps = React.useMemo<ProtocolStep[]>(
    () => steps.map(({ id, plannedSeconds, advance, captureField }) => ({ id, plannedSeconds, advance, captureField })),
    [steps],
  );

  const running = state.phase === 'running';
  const step = running ? steps[state.stepIndex] : undefined;
  const elapsedSeconds = running ? Math.max(0, (nowMs - state.stepStartedAtMs) / 1000) : 0;

  // The session clock: a coarse interval while running (advance rules read
  // seconds, so sub-100ms precision buys nothing). Timestamps for the
  // transcript use the same clock the interval samples.
  React.useEffect(() => {
    if (!running) return;
    const tick = () => setNowMs(Date.now());
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [running]);

  // Visibility honesty: losing the document mid-session is recorded evidence.
  React.useEffect(() => {
    if (!running) return;
    const onVis = () => {
      if (document.visibilityState === 'hidden') setState((s) => reduceSession(s, machineSteps, { type: 'visibility-lost' }));
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [running, machineSteps]);

  // Advance evaluation: whenever the live signals satisfy the step's rule,
  // dispatch advance and clear the per-step tap latch.
  const signals: StepSignals = {
    elapsedSeconds,
    nextTapped,
    captureCount: state.pendingCaptures.length,
  };
  // A step without an advance rule defaults to tap-advance — data can never
  // trap the user on a step with no way forward.
  const condition: AdvanceCondition | undefined = step ? (step.advance ?? { op: 'tap-next' }) : undefined;
  const shouldAdvance = running && canAdvanceStep(condition, signals, advanceReg);
  React.useEffect(() => {
    if (!shouldAdvance) return;
    setState((s) => reduceSession(s, machineSteps, { type: 'advance', nowMs: Date.now() }));
    setNextTapped(false);
  }, [shouldAdvance, machineSteps]);

  // Lifecycle reporting — the terminal latch in the machine plus this ref
  // guarantee exactly one report per boundary.
  React.useEffect(() => {
    if (!onLifecycle) return;
    if (state.phase === 'running' && reportedRef.current === null) {
      reportedRef.current = 'started';
      onLifecycle('started', summarizeSession(state, machineSteps));
    } else if (state.phase === 'completed' && reportedRef.current !== 'completed') {
      reportedRef.current = 'completed';
      onLifecycle('completed', summarizeSession(state, machineSteps));
    } else if (state.phase === 'abandoned' && reportedRef.current !== 'abandoned') {
      reportedRef.current = 'abandoned';
      onLifecycle('abandoned', summarizeSession(state, machineSteps));
    }
  }, [state, machineSteps, onLifecycle]);

  const start = React.useCallback(() => {
    reportedRef.current = null;
    setNowMs(Date.now());
    setState((s) => reduceSession(s, machineSteps, { type: 'start', nowMs: Date.now(), sessionId: makeSessionId() }));
  }, [machineSteps, makeSessionId]);

  const startedRef = React.useRef(false);
  React.useEffect(() => {
    if (!autoStart || startedRef.current) return;
    startedRef.current = true;
    start();
  }, [autoStart, start]);

  const capture = (fieldId: string, value: unknown) =>
    setState((s) => reduceSession(s, machineSteps, { type: 'capture', nowMs: Date.now(), fieldId, value }));

  const summary = summarizeSession(state, machineSteps);

  return (
    <div className={cn('flex w-full flex-col items-center gap-8', className)} data-testid="protocol-session" data-phase={state.phase}>
      {title ? (
        <span className="text-center text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>
          {title}
        </span>
      ) : null}

      {state.phase === 'idle' ? (
        <div className="flex flex-col items-center gap-6 py-6">
          {intro ? (
            <span className="max-w-[26rem] text-center text-lg leading-relaxed" style={{ color: 'var(--text-secondary, var(--text-muted))' }}>
              {intro}
            </span>
          ) : null}
          <button
            type="button"
            data-testid="session-start"
            onClick={start}
            className="rounded-full px-10 py-4 text-lg font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98]"
            style={{
              color: 'var(--text-on-accent, #0b0b0f)',
              background: 'var(--accent, rgba(150,185,245,0.95))',
            }}
          >
            {startLabel}
          </button>
        </div>
      ) : null}

      {running && step ? (
        <div className="flex w-full flex-col items-center gap-8">
          {/* Step progress dots — position only, no labels to read mid-exercise.
              A one-step session shows none (a single dot is filler). */}
          {steps.length > 1 ? (
          <div className="flex flex-row items-center gap-2" data-testid="session-progress">
            {steps.map((s, i) => (
              <span
                key={s.id}
                aria-hidden
                className="rounded-full transition-all"
                style={{
                  width: i === state.stepIndex ? 20 : 6,
                  height: 6,
                  background:
                    i < state.stepIndex
                      ? 'var(--accent, rgba(150,185,245,0.9))'
                      : i === state.stepIndex
                        ? 'var(--accent, rgba(150,185,245,0.9))'
                        : 'var(--border-subtle, rgba(255,255,255,0.18))',
                }}
              />
            ))}
          </div>
          ) : null}

          {contentReg.resolve(typeof step.content === 'string' ? step.content : 'prompt')({
            data: step.data,
            plannedSeconds: step.plannedSeconds ?? 0,
            elapsedSeconds,
            onCapture: capture,
            onTapNext: () => setNextTapped(true),
          })}

          {/* The tap-advance control renders whenever the rule can consume it. */}
          {conditionUsesTap(condition) ? (
            <button
              type="button"
              data-testid="session-next"
              onClick={() => setNextTapped(true)}
              className="rounded-full px-8 py-3 text-base font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98]"
              style={{
                color: 'var(--text-primary, #fff)',
                background: 'var(--glass-bg-subtle, rgba(255,255,255,0.06))',
                boxShadow: 'inset 0 0 0 1px var(--border-subtle, rgba(255,255,255,0.14))',
              }}
            >
              {state.stepIndex === steps.length - 1 ? doneLabel : nextLabel}
            </button>
          ) : null}
        </div>
      ) : null}

      {state.phase === 'completed' ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center" data-testid="session-complete">
          <span className="text-2xl font-semibold tracking-tight" style={{ color: 'var(--text-primary, #fff)' }}>
            {doneLabel}
          </span>
          <span className="text-sm" style={{ color: 'var(--text-secondary, var(--text-muted))' }}>
            {summary.stepsCompleted > 0
              ? `${summary.stepsCompleted} ${summary.stepsCompleted === 1 ? 'step' : 'steps'} · ${Math.round(summary.actualSeconds)}s`
              : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Whether an advance rule (recursively) consumes the tap signal — decides if the Next control renders. */
function conditionUsesTap(condition: AdvanceCondition | undefined): boolean {
  if (!condition) return false;
  if (condition.op === 'tap-next') return true;
  const of = condition.args?.of;
  if (Array.isArray(of)) return of.some((c) => conditionUsesTap(c as AdvanceCondition));
  return false;
}
