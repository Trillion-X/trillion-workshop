// packages/spaced-repetition/read-data/schedule-next-review.ts
//
// =============================================================================
// PURPOSE — the missing critical piece of the review loop
// =============================================================================
//
// The package already CAPTURES a recall grade (review-response-request) and
// SHOWS the due queue, but nothing computed the NEXT due date from a grade — so
// the loop never closed. This module is that computation: a pure, deterministic
// spaced-repetition scheduler. Given a prior review state and a recall grade it
// returns the next review state (reps, ease, interval) and the next due time.
//
// =============================================================================
// WHY THIS SHAPE (1000x gauntlet trace)
// =============================================================================
//
// L055 deepest root: a learner re-reviews because memory DECAYS. The scheduler's
//   job is "from how well you just recalled, when should this resurface?" — the
//   physics of spaced repetition, not anything tennis/quiz/book specific.
// L063 category / L069 generative primitive: ONE function schedules ANY
//   reviewable thing — a swing drill, a flashcard, a tactic, a book passage, a
//   basketball rep. The item is opaque (a promptId + prior state); the scheduler
//   never knows the domain. It produces capabilities never designed for: every
//   subject gets spacing for free.
// Enum dissolution (no closed grade set): `grade` is an OPEN string mapped to a
//   recall quality in [0,1] via `policy.gradeQuality` DATA. Adding a new grade
//   button ("forgot", "trivial", a 0–5 numeric scale) is a DATA row, never a
//   code edit. The SM-2-family update is the one primitive; Leitner and
//   fixed-interval fall out as special cases of the same function via policy.
// SSOT: the schedule record is the source of truth; this function PURELY derives
//   the next one. It creates no store and re-reads no global state.
// Purity / performance: time is injected (`reviewedAtMs`) — no Date.now — so the
//   function is deterministic, snapshot-testable, and allocation-light (a couple
//   of numbers, no I/O, sub-microsecond).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

const MS_PER_DAY = 86_400_000;

/** The spaced-repetition state carried forward between reviews. Self-describing
 *  (L090): the scheduler reads only these numbers, never the item's domain. */
export type ReviewSrsState = {
  /** Consecutive successful recalls (resets to 0 on a lapse). */
  reps: number;
  /** Ease multiplier (SM-2 "EF"): how fast the interval grows. */
  easeFactor: number;
  /** Current interval in whole days. */
  intervalDays: number;
};

/** Society DATA — every knob of the scheduler. No algorithm is hardcoded; a
 *  different spacing behavior is a different policy record, not different code.
 *  `gradeQuality` is the open grade→quality map that dissolves the grade enum. */
export type ReviewSchedulePolicy = {
  /** Starting ease for a brand-new item. */
  initialEase: number;
  /** Lower bound on ease so an item can never collapse to same-day forever. */
  minEase: number;
  /** Interval after the first successful recall. */
  firstIntervalDays: number;
  /** Interval after the second successful recall. */
  secondIntervalDays: number;
  /** Open map: grade token -> recall quality in [0,1]. Unknown grades are
   *  treated as a total lapse (quality 0) — fail-safe extensibility. */
  gradeQuality: Record<string, number>;
  /** Quality below which the item lapses (reps reset to 0). */
  lapseBelowQuality: number;
};

/** The default policy. Plain English: four buttons, "good" keeps you on track,
 *  "easy" stretches the gap, "hard" barely passes, "again" sends it back to the
 *  start. These are DATA defaults — an owner overrides any of them. */
export const DEFAULT_REVIEW_POLICY: ReviewSchedulePolicy = {
  initialEase: 2.5,
  minEase: 1.3,
  firstIntervalDays: 1,
  secondIntervalDays: 6,
  gradeQuality: { again: 0, hard: 0.6, good: 0.8, easy: 1 },
  lapseBelowQuality: 0.6,
};

/** Society DATA — display label for each grade token. OPEN map: a new grade
 *  needs no entry here (the helper Title-Cases the token as a fallback). This is
 *  the ONE place grade labels live, so the review surface renders its buttons
 *  from the policy + this map — adding a grade is a DATA row, never a surface
 *  code edit (the surface enumerates nothing). */
export const DEFAULT_GRADE_LABELS: Record<string, string> = {
  again: 'Again',
  hard: 'Hard',
  good: 'Good',
  easy: 'Easy',
};

/** One review button, derived from DATA. The surface maps over these — it never
 *  names a grade. `token` is the open grade sent back; `label` is what's shown. */
export type ReviewGradeButton = { token: string; label: string };

/**
 * Build the ordered review buttons for a policy from DATA alone: one button per
 * `policy.gradeQuality` key, labelled via `labels` (Title-Cased token fallback).
 * Pure + total. The grade SET has ONE source of truth — the policy — so the
 * scheduler and the surface can never drift, and a new grade button appears by
 * adding a `gradeQuality` row (enum dissolution; L069/L090).
 */
export function reviewGradeButtons(
  policy: ReviewSchedulePolicy = DEFAULT_REVIEW_POLICY,
  labels: Record<string, string> = DEFAULT_GRADE_LABELS,
): ReviewGradeButton[] {
  return Object.keys(policy.gradeQuality).map((token) => ({
    token,
    label: labels[token] ?? titleCaseToken(token),
  }));
}

/** Fallback label for a grade token with no DATA label: `forgot` -> `Forgot`,
 *  `very-easy` -> `Very Easy`. Keeps unknown grades self-describing. */
function titleCaseToken(token: string): string {
  return token
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export type ScheduleNextInput = {
  /** Prior state; absent means this is the item's first ever review. */
  prior?: ReviewSrsState;
  /** Recall grade — an open token resolved through `policy.gradeQuality`. */
  grade: string;
  /** When the review happened, in epoch ms (injected for purity). */
  reviewedAtMs: number;
  /** Scheduling policy; defaults to DEFAULT_REVIEW_POLICY. */
  policy?: ReviewSchedulePolicy;
};

export type ScheduleNextResult = {
  /** The next state to persist on the schedule record. */
  state: ReviewSrsState;
  /** Next due time in epoch ms. */
  dueAtMs: number;
  /** True when the grade fell below the lapse threshold (reps reset). */
  lapsed: boolean;
  /** The resolved recall quality in [0,1] (for observability/tests). */
  quality: number;
};

/**
 * Compute the next review schedule from a recall grade. Pure + total: any input
 * (including an unknown grade or a first-ever review) yields a well-formed
 * result. The SM-2 ease update runs on a normalized 0–5 quality; intervals grow
 * by ease after the second success and reset on a lapse.
 */
export function scheduleNextReview(input: ScheduleNextInput): ScheduleNextResult {
  const policy = input.policy ?? DEFAULT_REVIEW_POLICY;
  const prior: ReviewSrsState = input.prior ?? {
    reps: 0,
    easeFactor: policy.initialEase,
    intervalDays: 0,
  };

  // Resolve the open grade token to a recall quality; unknown -> lapse (0).
  const quality = clamp01(policy.gradeQuality[input.grade] ?? 0);
  const lapsed = quality < policy.lapseBelowQuality;

  // SM-2 ease update on a 0–5 scale (q5 = quality * 5), floored at minEase.
  const q5 = quality * 5;
  const easeDelta = 0.1 - (5 - q5) * (0.08 + (5 - q5) * 0.02);
  const easeFactor = Math.max(policy.minEase, prior.easeFactor + easeDelta);

  let reps: number;
  let intervalDays: number;
  if (lapsed) {
    reps = 0;
    intervalDays = policy.firstIntervalDays;
  } else {
    reps = prior.reps + 1;
    if (reps === 1) intervalDays = policy.firstIntervalDays;
    else if (reps === 2) intervalDays = policy.secondIntervalDays;
    else intervalDays = Math.max(1, Math.round(prior.intervalDays * easeFactor));
  }

  return {
    state: { reps, easeFactor, intervalDays },
    dueAtMs: input.reviewedAtMs + intervalDays * MS_PER_DAY,
    lapsed,
    quality,
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
