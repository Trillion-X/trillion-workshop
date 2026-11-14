// packages/business-event/read-data/read-funnel-conversion.ts
//
// =============================================================================
// PURPOSE — funnel / stage-conversion read-model over the business-event spine
// =============================================================================
//
// "How many subjects got from stage N to stage N+1, and where do they drop off?"
// is the LEARN half of the loop for acquisition + onboarding + any sequential
// journey (visit -> signup -> first-session -> subscribe -> renew). This is a
// PURE projection over a `BusinessEventStream`: it invents no events and stores
// nothing. A funnel is entirely DATA — an ordered list of stage MATCHERS plus the
// field-path that identifies the subject whose progression is tracked.
//
// =============================================================================
// WHY THIS SHAPE (1000x gauntlet trace)
// =============================================================================
//
// L055 deepest root: a funnel surface is blind when every funnel is bespoke code
//   (`if subscribed then ...`). The deepest fix is a generic projection whose
//   stages, match criteria, and subject key are DATA — so "ad funnel", "coaching
//   onboarding funnel", and a golf business's funnel are the SAME code over
//   different DATA rows.
// L063/L069 + enum dissolution: there is NO closed list of stages, no
//   `switch(stage)`, no `FunnelKind` union. A stage is `{ id, all: Criterion[] }`
//   where each criterion is a DATA field-path + expected value. Adding a stage,
//   reordering, or defining a brand-new funnel is DATA, never code.
// L090 (self-describing data, blind handler): the projection never reads a
//   specific event field by name in code — it reads ONLY the paths the funnel
//   DATA names, via the SSOT `readPath`. It cannot know it is a "tennis" funnel.
// SSOT: reads the event stream only; the `FieldPath`/`readPath` walk is the one
//   shared primitive (field-path.ts), not a private copy.
// Performance: ONE O(n·stages) pass to find each subject's furthest stage, then
//   O(subjects) to roll up. Group state is a flat map keyed by subject id (P3/P4).
//
// =============================================================================
// FUNNEL MODEL (stated explicitly so the numbers are unambiguous)
// =============================================================================
//
// A subject "reached stage K" iff ANY of their events matches stage K's criteria.
// `reachedCount[K]` counts subjects whose FURTHEST matched stage index is >= K
// (monotonic: reaching a later stage implies you got at least that far — the
// standard "got at least this deep" funnel definition). Therefore counts are
// non-increasing down the funnel, conversion is `reached[K] / reached[K-1]`, and
// drop-off is `reached[K-1] - reached[K]`. Stages need NOT be matched in order by
// the events themselves (out-of-order / missing intermediate events are fine) —
// only the furthest stage reached matters. A subject who matches no stage is
// counted in `subjects` but contributes to no stage.
// =============================================================================

import type { BusinessEventStream } from './business-event-types';
import { type FieldPath, readPath } from './field-path';

/** One match criterion: the value at `path` (stringified) must equal `equals`. */
export interface FunnelCriterion {
  readonly path: FieldPath;
  readonly equals: string;
}

/**
 * One funnel stage. `all` criteria must ALL hold for an event to match the stage
 * (logical AND). An empty `all` matches every event (an "any activity" stage).
 * `id` is the display/result key — DATA, never used for branching.
 */
export interface FunnelStageSpec {
  readonly id: string;
  readonly all: readonly FunnelCriterion[];
}

/**
 * A complete funnel definition — pure DATA. `stages` are ordered (index 0 is the
 * top). `subjectPath` names the field whose value identifies the subject being
 * tracked through the funnel (e.g. `['actor','id']` to track per actor, or
 * `['correlationId']` to track per journey/session). Events whose subject value
 * is missing/empty are skipped (fail-closed — an unattributable event cannot
 * advance any subject).
 */
export interface FunnelSpec {
  readonly id: string;
  readonly stages: readonly FunnelStageSpec[];
  readonly subjectPath: FieldPath;
}

/** Per-stage result row. */
export interface FunnelStageResult {
  readonly stageId: string;
  /** Subjects whose furthest reached stage index is >= this stage. */
  readonly reachedCount: number;
  /** reached / top-of-funnel reached (stage 0); 0 when the top is empty. 1.0 at stage 0. */
  readonly overallRate: number;
  /** reached[K] / reached[K-1]; null at stage 0; 0 when the previous stage is empty. */
  readonly stepRate: number | null;
  /** reached[K-1] - reached[K] subjects lost entering this stage; 0 at stage 0. */
  readonly dropOff: number;
}

/** Whole-funnel result. */
export interface FunnelResult {
  readonly funnelId: string;
  /** Distinct subjects observed (any subject with at least one attributable event). */
  readonly subjects: number;
  readonly stages: readonly FunnelStageResult[];
}

/** Does this value (coerced to string) equal the criterion's expected string? */
function valueEquals(value: unknown, expected: string): boolean {
  if (value == null) return false;
  return (typeof value === 'string' ? value : String(value)) === expected;
}

/** Does an event satisfy ALL of a stage's criteria? (empty criteria => true). */
function eventMatchesStage(event: unknown, stage: FunnelStageSpec): boolean {
  for (const criterion of stage.all) {
    if (!valueEquals(readPath(event, criterion.path), criterion.equals)) return false;
  }
  return true;
}

/**
 * Compute funnel conversion. ONE pass to find each subject's furthest stage, then
 * a roll-up into per-stage counts, conversion rates, and drop-off. Deterministic,
 * pure, fail-closed (events with no resolvable subject are ignored). The same code
 * runs ANY funnel by passing a different `FunnelSpec` DATA value.
 */
export function computeFunnelConversion(
  events: BusinessEventStream,
  funnel: FunnelSpec,
): FunnelResult {
  const stageCount = funnel.stages.length;

  // subjectId -> furthest stage index reached (-1 = no stage yet). Flat side-map.
  const furthest = new Map<string, number>();

  for (const event of events) {
    const subjectValue = readPath(event, funnel.subjectPath);
    if (subjectValue == null || subjectValue === '') continue; // fail-closed: unattributable
    const subjectId = typeof subjectValue === 'string' ? subjectValue : String(subjectValue);

    // Find the deepest stage this single event matches (so a "subscribe" event
    // that also satisfies an earlier "any activity" stage advances to the deepest).
    let deepestForEvent = -1;
    for (let k = stageCount - 1; k >= 0; k -= 1) {
      if (eventMatchesStage(event, funnel.stages[k])) {
        deepestForEvent = k;
        break;
      }
    }
    if (deepestForEvent < 0) {
      // No stage matched, but the subject is still observed.
      if (!furthest.has(subjectId)) furthest.set(subjectId, -1);
      continue;
    }
    const prior = furthest.get(subjectId);
    if (prior === undefined || deepestForEvent > prior) furthest.set(subjectId, deepestForEvent);
  }

  // Roll up: reached[k] = subjects whose furthest >= k.
  const reached = new Array<number>(stageCount).fill(0);
  for (const furthestIndex of furthest.values()) {
    for (let k = 0; k <= furthestIndex; k += 1) reached[k] += 1;
  }

  const topReached = stageCount > 0 ? reached[0] : 0;
  const stages: FunnelStageResult[] = funnel.stages.map((stage, k) => {
    const reachedCount = reached[k];
    const prev = k === 0 ? null : reached[k - 1];
    return {
      stageId: stage.id,
      reachedCount,
      overallRate: topReached === 0 ? 0 : reachedCount / topReached,
      stepRate: prev === null ? null : prev === 0 ? 0 : reachedCount / prev,
      dropOff: prev === null ? 0 : prev - reachedCount,
    };
  });

  return { funnelId: funnel.id, subjects: furthest.size, stages };
}
