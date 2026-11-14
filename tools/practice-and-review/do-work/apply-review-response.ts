// packages/spaced-repetition/do-work/apply-review-response.ts
//
// =============================================================================
// PURPOSE — close the review loop
// =============================================================================
//
// `scheduleNextReview` (read-data) computes the spacing math. This module turns
// that math into the package's own record: given the prior schedule and a recall
// grade, it builds the NEXT `review-schedule` record to persist. That is the
// step that closes the loop — capture grade -> compute spacing -> write the next
// due record so the item resurfaces on time.
//
// Pure + deterministic: the caller supplies `reviewedAtMs` (no Date.now) and the
// new schedule id, so the same input always builds the same record. The owner's
// review-response handler (a workflow action) calls this and writes the returned
// record via the normal write path — this module performs no I/O and imports no
// other package (zero coupling).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { ReviewScheduleRecord } from "@/packages/spaced-repetition/read-data/spaced-repetition-types";
import { readReviewSchedulePolicy } from "@/packages/spaced-repetition/read-data/read-spaced-repetition";
import {
  DEFAULT_REVIEW_POLICY,
  scheduleNextReview,
  type ReviewSchedulePolicy,
  type ReviewSrsState,
} from "@/packages/spaced-repetition/read-data/schedule-next-review";

const MS_PER_DAY = 86_400_000;

export type ApplyReviewResponseInput = {
  /** The schedule the learner just reviewed against (absent = first review). */
  prior?: ReviewScheduleRecord;
  /** Identity of the prompt and learner the new schedule belongs to. */
  promptId: string;
  learnerId: string;
  /** Recall grade — an open token resolved by the scheduler's DATA policy. */
  grade: string;
  /** When the review happened, epoch ms (injected for purity). */
  reviewedAtMs: number;
  /** Id for the new schedule record (injected so the builder stays pure). */
  nextScheduleId: string;
  /** Scheduling policy; defaults inside the scheduler when omitted. */
  policy?: ReviewSchedulePolicy;
  /** Rows that may contain a review-schedule-policy record. */
  rows?: unknown;
};

/**
 * Build the next `review-schedule` record from a recall response.
 *
 * Reads the prior SRS state off the prior schedule record (treating its absence
 * as a brand-new item), runs the scheduler, and emits a fully-formed schedule
 * record carrying the new SRS state and a date-only `dueAt` (matching the
 * existing record convention). `state` is `'due'` — the new schedule is the next
 * thing waiting for the learner.
 */
export function buildNextScheduleRecord(input: ApplyReviewResponseInput): ReviewScheduleRecord {
  const prior: ReviewSrsState | undefined = priorSrsState(input.prior);
  const policy = input.policy ?? (input.rows ? readReviewSchedulePolicy(input.rows) : null) ?? DEFAULT_REVIEW_POLICY;

  const result = scheduleNextReview({
    prior,
    grade: input.grade,
    reviewedAtMs: input.reviewedAtMs,
    policy,
  });

  return {
    kind: "review-schedule",
    scheduleId: input.nextScheduleId,
    promptId: input.promptId,
    learnerId: input.learnerId,
    dueAt: toDateOnly(result.dueAtMs),
    state: "due",
    reps: result.state.reps,
    easeFactor: result.state.easeFactor,
    intervalDays: result.state.intervalDays,
  };
}

/** Lift the carried SRS numbers off a prior record. Returns undefined when the
 *  record (or its SRS fields) is absent so the scheduler starts fresh. */
function priorSrsState(record?: ReviewScheduleRecord): ReviewSrsState | undefined {
  if (
    !record ||
    record.reps === undefined ||
    record.easeFactor === undefined ||
    record.intervalDays === undefined
  ) {
    return undefined;
  }
  return {
    reps: record.reps,
    easeFactor: record.easeFactor,
    intervalDays: record.intervalDays,
  };
}

/** Epoch ms -> "YYYY-MM-DD" (UTC), matching the existing schedule record format.
 *  Deterministic: derived purely from the injected ms, no wall clock. */
function toDateOnly(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export { MS_PER_DAY };
