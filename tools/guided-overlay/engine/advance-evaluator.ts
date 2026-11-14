// packages/guided-overlay/engine/advance-evaluator.ts
//
// PURPOSE
// The advance-condition evaluator (engine mechanism M4). A step's
// `advance_condition` is a DECLARATIVE predicate `{ op, args }` evaluated against
// live step signals. `op` is an OPEN string dispatched through the shared
// blind-registry (tap-next | target-interacted | answer-given | media-watched |
// timeout | all-of | any-of | <future>): a new advance rule is one `register()`,
// never a coded branch. `all-of` / `any-of` recurse through the SAME evaluator,
// so arbitrary compositions ("answered AND watched 90%", "tapped OR timed out")
// emerge for free (the L069 adversarial-combinatorial property).
//
// All thresholds (`min_ratio`, `ms`) are DATA in `args`, never engine constants.

import { createBlindRegistry, type BlindRegistry } from '../../ui/show/blind-registry/blind-registry';

/** A declarative advance predicate as it appears in step DATA. */
export interface AdvanceCondition {
  readonly op: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

/** Live signals the host feeds the evaluator for the current step. */
export interface AdvanceSignals {
  readonly nextTapped?: boolean;
  readonly targetInteracted?: boolean;
  readonly answer?: string;
  readonly mediaRatio?: number; // 0..1
  readonly elapsedMs?: number;
  readonly surfaceCompletionRefs?: readonly string[];
  /** Owner fact refs resolved by the live signal bridge, keyed by declared ref. */
  readonly ownerReadbacks?: Readonly<Record<string, unknown>>;
}

/** Evaluate a child condition (passed to composite ops so they recurse). */
export type EvaluateFn = (condition: AdvanceCondition, signals: AdvanceSignals) => boolean;

/** A predicate: does this op's condition hold for the given signals? */
export type AdvancePredicate = (
  args: Readonly<Record<string, unknown>>,
  signals: AdvanceSignals,
  evaluate: EvaluateFn,
) => boolean;

function asConditions(value: unknown): AdvanceCondition[] {
  return Array.isArray(value) ? (value.filter((c) => c && typeof (c as AdvanceCondition).op === 'string') as AdvanceCondition[]) : [];
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Create an advance-predicate registry seeded with the built-in ops. Unknown ops
 * resolve to a predicate that returns `false` (no AUTO-advance) — safe, because
 * the user can still advance via the nav buttons; a typo never traps them.
 */
export function createAdvanceRegistry(): BlindRegistry<AdvancePredicate> {
  const reg = createBlindRegistry<AdvancePredicate>({ fallback: () => false });
  reg.register('tap-next', (_a, s) => s.nextTapped === true);
  reg.register('target-interacted', (_a, s) => s.targetInteracted === true);
  reg.register('answer-given', (_a, s) => typeof s.answer === 'string' && s.answer.length > 0);
  reg.register('media-watched', (a, s) => num(s.mediaRatio, 0) >= num(a.min_ratio, 1));
  reg.register('timeout', (a, s) => num(s.elapsedMs, 0) >= num(a.ms, 0));
  reg.register('surface-completed', (a, s) => (
    typeof a.completion_ref === 'string'
    && s.surfaceCompletionRefs?.includes(a.completion_ref) === true
  ));
  reg.register('all-of', (a, s, ev) => {
    const of = asConditions(a.of);
    return of.length > 0 && of.every((c) => ev(c, s));
  });
  reg.register('any-of', (a, s, ev) => asConditions(a.of).some((c) => ev(c, s)));
  reg.register('owner-readback', ownerReadbackSatisfied);
  return reg;
}

/**
 * Whether the step may advance now, given live signals. Composite ops recurse
 * through this same function. Pass a custom `registry` to add ops; omit for the
 * built-ins.
 */
export function canAdvance(
  condition: AdvanceCondition,
  signals: AdvanceSignals,
  registry: BlindRegistry<AdvancePredicate> = createAdvanceRegistry(),
): boolean {
  const evaluate: EvaluateFn = (c, s) => registry.resolve(c.op)(c.args ?? {}, s, evaluate);
  return evaluate(condition, signals);
}

// ---------------------------------------------------------------------------
// Owner-readback op (OD-04/OD-05 dependency): a step may gate advancement on a
// DESTINATION OWNER'S readback rather than a local gesture. The op is DATA-only
// here: `args.owner_readbacks` is a map of opaque owner fact refs the surface's
// live signal bridge has already resolved. The evaluator never names an owner.
// `args.field` narrows an object readback to one of its fields before the
// comparison; `args.every_ms` is how often the surface reads it again.
// ---------------------------------------------------------------------------

function readbackValueSatisfied(read: unknown, args: Readonly<Record<string, unknown>>): boolean {
  // `field` names the one field of an object readback the condition is about (`connected` of `{ connected, app }`).
  const value = typeof args.field === 'string' && read !== null && typeof read === 'object' && !Array.isArray(read)
    ? (read as Record<string, unknown>)[args.field]
    : read;
  if (value === undefined || value === null) return false;
  const requiredValuesPresent = Array.isArray(args.required_values_present)
    ? args.required_values_present
    : null;
  if (requiredValuesPresent && requiredValuesPresent.length > 0) {
    if (!Array.isArray(value)) return false;
    return requiredValuesPresent.every((required) => value.includes(required));
  }
  const requiredNonempty = args.required_nonempty === true;
  if (requiredNonempty) {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
  }
  const requiredValues = Array.isArray(args.required_answer_values)
    ? args.required_answer_values
    : Array.isArray(args.accepted_states)
      ? args.accepted_states
      : null;
  if (requiredValues && requiredValues.length > 0) {
    return requiredValues.includes(value as never);
  }
  const requiredStates = args.required_states;
  if (Array.isArray(requiredStates) && requiredStates.length > 0) {
    const state = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).visible_state ?? (value as Record<string, unknown>).owner_state
      : value;
    return requiredStates.includes(state as never);
  }
  return true;
}

/**
 * Whether every declared owner fact ref has been resolved to a satisfying value
 * by the live signal bridge. Registered as the `owner-readback` op.
 */
export function ownerReadbackSatisfied(
  args: Readonly<Record<string, unknown>>,
  signals: AdvanceSignals,
): boolean {
  const readbacks = signals.ownerReadbacks;
  if (!readbacks) return false;
  const refs = [
    args.readback_ref,
    args.answer_fact_ref,
    args.objective_answer_ref,
  ].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
  if (refs.length === 0) return false;
  return refs.every((ref) => readbackValueSatisfied(readbacks[ref], args));
}
