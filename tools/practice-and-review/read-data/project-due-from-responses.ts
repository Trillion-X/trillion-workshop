// packages/spaced-repetition/read-data/project-due-from-responses.ts
//
// =============================================================================
// PURPOSE — close the review loop on the READ side (SSOT-correct)
// =============================================================================
//
// The recall RESPONSE is the truth the learner produces; the due date is DERIVED
// from the response history, not a separately-authored fact. This module folds a
// prompt's responses (in chronological order) through the scheduler to produce
// the current spaced-repetition state and the next due time — so the queue
// reflects actual review history with no duplicated source of truth.
//
// This REUSES `scheduleNextReview` (read-data): the write-time record builder
// (`do-work/apply-review-response`) and this read-time projection are two
// consumers of the ONE scheduling primitive (L069), never a second copy of the
// SM-2 math.
//
// Pure + deterministic: `nowMs` is injected (no Date.now); response timestamps
// are parsed from each record's `createdAt`.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type {
  ReviewPromptRecord,
  ReviewResponseRequestRecord,
} from "@/packages/spaced-repetition/read-data/spaced-repetition-types";
import {
  scheduleNextReview,
  type ReviewSchedulePolicy,
  type ReviewSrsState,
} from "@/packages/spaced-repetition/read-data/schedule-next-review";

/** A prompt's review standing, derived purely from its response history. */
export type ReviewStanding = {
  prompt: ReviewPromptRecord;
  /** Folded SRS state after the last response; undefined if never reviewed. */
  state?: ReviewSrsState;
  /** Next due time in epoch ms; undefined if never reviewed (due immediately). */
  dueAtMs?: number;
  /** True when the item is due at `nowMs` (never reviewed = always due). */
  isDue: boolean;
  /** Count of responses folded (review history depth). */
  reviewCount: number;
};

/**
 * Fold one prompt's responses (chronological) into its current SRS state.
 * Returns undefined when there are no responses (a brand-new, always-due item).
 * Each step feeds the prior state + the response grade into `scheduleNextReview`.
 */
export function foldReviewHistory(
  responses: readonly ReviewResponseRequestRecord[],
  policy?: ReviewSchedulePolicy,
): { state: ReviewSrsState; dueAtMs: number } | undefined {
  const ordered = [...responses].sort(byCreatedAt);
  if (ordered.length === 0) return undefined;

  let state: ReviewSrsState | undefined;
  let dueAtMs = 0;
  for (const response of ordered) {
    const result = scheduleNextReview({
      prior: state,
      grade: response.response,
      reviewedAtMs: parseMs(response.createdAt),
      policy,
    });
    state = result.state;
    dueAtMs = result.dueAtMs;
  }
  return { state: state as ReviewSrsState, dueAtMs };
}

/**
 * Project the review queue purely from prompts + responses at `nowMs`.
 * Never-reviewed prompts are due immediately; reviewed prompts are due when
 * their folded `dueAtMs <= nowMs`. Due items first, then by soonest due.
 */
export function dueQueueFromResponses(
  prompts: readonly ReviewPromptRecord[],
  responses: readonly ReviewResponseRequestRecord[],
  nowMs: number,
  policy?: ReviewSchedulePolicy,
  learnerId?: string,
): ReviewStanding[] {
  const byPrompt = groupByPrompt(responses, learnerId);

  return prompts
    .map((prompt): ReviewStanding => {
      const own = byPrompt.get(prompt.promptId) ?? [];
      const folded = foldReviewHistory(own, policy);
      if (!folded) {
        return { prompt, isDue: true, reviewCount: 0 };
      }
      return {
        prompt,
        state: folded.state,
        dueAtMs: folded.dueAtMs,
        isDue: folded.dueAtMs <= nowMs,
        reviewCount: own.length,
      };
    })
    .sort(byDueThenPrompt);
}

function groupByPrompt(
  responses: readonly ReviewResponseRequestRecord[],
  learnerId?: string,
): Map<string, ReviewResponseRequestRecord[]> {
  const map = new Map<string, ReviewResponseRequestRecord[]>();
  for (const r of responses) {
    if (learnerId && r.learnerId !== learnerId) continue;
    const list = map.get(r.promptId) ?? [];
    list.push(r);
    map.set(r.promptId, list);
  }
  return map;
}

function byCreatedAt(a: ReviewResponseRequestRecord, b: ReviewResponseRequestRecord): number {
  return parseMs(a.createdAt) - parseMs(b.createdAt);
}

/** Due items first; within each group, soonest due first, then prompt text.
 *  Never-reviewed (no dueAtMs) sort before scheduled items among the due. */
function byDueThenPrompt(a: ReviewStanding, b: ReviewStanding): number {
  if (a.isDue !== b.isDue) return a.isDue ? -1 : 1;
  const ad = a.dueAtMs ?? 0;
  const bd = b.dueAtMs ?? 0;
  if (ad !== bd) return ad - bd;
  return a.prompt.prompt.localeCompare(b.prompt.prompt);
}

/** ISO timestamp -> epoch ms; NaN-safe (unparseable sorts as epoch 0). */
function parseMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}
