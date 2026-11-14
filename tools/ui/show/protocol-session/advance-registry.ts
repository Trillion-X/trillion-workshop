// packages/ui/show/protocol-session/advance-registry.ts
//
// Declarative step-advance rules for a protocol session. A step's `advance`
// is `{ op, args }` resolved through the shared blind registry — an open
// string key, never a switch. Composite ops recurse through the same
// evaluator, so any combination of rules is expressible from data.

import { createBlindRegistry, type BlindRegistry } from '../blind-registry/blind-registry';
import type { AdvanceCondition } from './protocol-session-machine';

/** Live signals the session component feeds the evaluator for the current step. */
export interface StepSignals {
  /** Seconds elapsed in the current step. */
  elapsedSeconds?: number;
  /** True after the user taps the primary advance control. */
  nextTapped?: boolean;
  /** Count of captures recorded for the current step. */
  captureCount?: number;
}

export type StepEvaluateFn = (condition: AdvanceCondition, signals: StepSignals) => boolean;

export type StepAdvancePredicate = (
  args: Readonly<Record<string, unknown>>,
  signals: StepSignals,
  evaluate: StepEvaluateFn,
) => boolean;

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asConditions(value: unknown): AdvanceCondition[] {
  return Array.isArray(value)
    ? (value.filter((c) => c && typeof (c as AdvanceCondition).op === 'string') as AdvanceCondition[])
    : [];
}

/**
 * Registry seeded with the built-in ops. Unknown ops resolve to `false`
 * (never auto-advance) — the tap control still works, so a typo in step
 * data can never trap the user mid-session.
 */
export function createStepAdvanceRegistry(): BlindRegistry<StepAdvancePredicate> {
  const reg = createBlindRegistry<StepAdvancePredicate>({ fallback: () => false });
  reg.register('timeout', (a, s) => num(s.elapsedSeconds, 0) >= num(a.seconds, 0));
  reg.register('tap-next', (_a, s) => s.nextTapped === true);
  reg.register('input-given', (a, s) => num(s.captureCount, 0) >= num(a.count, 1));
  reg.register('all-of', (a, s, ev) => {
    const of = asConditions(a.of);
    return of.length > 0 && of.every((c) => ev(c, s));
  });
  reg.register('any-of', (a, s, ev) => asConditions(a.of).some((c) => ev(c, s)));
  return reg;
}

/** Whether the current step may advance now. Composites recurse through this evaluator. */
export function canAdvanceStep(
  condition: AdvanceCondition | undefined,
  signals: StepSignals,
  registry: BlindRegistry<StepAdvancePredicate> = createStepAdvanceRegistry(),
): boolean {
  if (!condition) return false;
  const evaluate: StepEvaluateFn = (c, s) => registry.resolve(c.op)(c.args ?? {}, s, evaluate);
  return evaluate(condition, signals);
}
