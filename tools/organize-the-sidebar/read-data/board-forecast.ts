// packages/group/read-data/board-forecast.ts
//
// The FORECAST primitive: project a finish from a remaining quantity, a rate of progress, and a deadline.
// A vision board's goals each have a distance left (metric.remaining), a pace (velocity = the progress
// logged per hour), and often a due date. This composes the three into "at your current pace you hit the
// target on <date>", a pace verdict against the deadline (ahead / behind / stalled / moving), and the pace
// you would NEED to make the deadline. It reuses the metric + time-log + due-date primitives with no new
// engine (L069 generative primitive over L063 composition). Pure + fail-closed: `now` is INJECTED (no
// clock lives here); a missing or non-positive velocity yields NO projected date (a date derived from zero
// motion would be a lie), only the required-pace ask.

const HOUR_MS = 3_600_000;

/** How a goal's pace sits against its deadline (or lack of one). */
export type PaceVerdict = 'complete' | 'stalled' | 'moving' | 'ahead' | 'behind';

/** Everything the forecast engine needs — all numbers, all injected, zero Society. */
export interface ForecastInput {
  /** Metric distance to target in the metric's own units (>= 0; 0 = already there). */
  readonly remainingUnits: number;
  /** Progress units per hour; null or <= 0 means no forward motion. */
  readonly velocityPerHour: number | null;
  /** Injected wall-clock ms (the shell passes Date.now(); tests pass a fixed instant). */
  readonly now: number;
  /** A deadline ms when the goal has one; leave unset for a goal with no date. */
  readonly due?: number | null;
}

/** The projected finish and how it lands against the deadline. */
export interface Forecast {
  readonly verdict: PaceVerdict;
  /** Effort-hours to reach the target at the current pace; null when stalled or already complete. */
  readonly hoursRemaining: number | null;
  /** Projected completion instant (now + hoursRemaining, ms); null when stalled. */
  readonly projectedMs: number | null;
  /** Pace (units/hour) needed to hit `due` exactly; null when no future deadline or already complete. */
  readonly requiredVelocityPerHour: number | null;
  /** due - projectedMs (positive = finishes with time to spare); null when either instant is missing. */
  readonly slackMs: number | null;
}

/** A finite, positive number or null — the fail-closed normalizer both `due` and velocity flow through. */
function positive(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Project a finish. Order is fail-closed:
 *  - no quantifiable work left (remaining <= 0 or non-finite) -> `complete`, projected = now;
 *  - work left but no forward motion (velocity <= 0) -> `stalled`, NO projected date, but the required
 *    pace to make the deadline is still surfaced so the ask is visible;
 *  - moving, no deadline -> `moving` with a projected date;
 *  - moving, with a deadline -> `ahead` (finishes on/before due) or `behind` (finishes after due).
 */
export function forecast(input: ForecastInput): Forecast {
  const { remainingUnits, now } = input;
  const due = positive(input.due);
  const hoursUntilDue = due !== null && due > now ? (due - now) / HOUR_MS : null;
  const requiredVelocityPerHour = hoursUntilDue !== null && Number.isFinite(remainingUnits) ? remainingUnits / hoursUntilDue : null;

  // A NON-FINITE remaining (a crafted metric whose span overflows to ±Infinity) is NOT "complete" — it is
  // unquantifiable, so fail CLOSED to stalled (no projected date) rather than report a false finish. Only a
  // genuinely finite remaining ≤ 0 means the target is already met.
  if (!Number.isFinite(remainingUnits)) {
    return { verdict: 'stalled', hoursRemaining: null, projectedMs: null, requiredVelocityPerHour: null, slackMs: null };
  }
  if (remainingUnits <= 0) {
    return { verdict: 'complete', hoursRemaining: 0, projectedMs: now, requiredVelocityPerHour: null, slackMs: due !== null ? due - now : null };
  }

  const velocity = positive(input.velocityPerHour);
  if (velocity === null) {
    return { verdict: 'stalled', hoursRemaining: null, projectedMs: null, requiredVelocityPerHour, slackMs: null };
  }

  const hoursRemaining = remainingUnits / velocity;
  const projectedMs = now + hoursRemaining * HOUR_MS;
  // A subnormal velocity (e.g. 5e-324) makes hoursRemaining / projectedMs overflow to Infinity — a bogus
  // "date" a renderer would format as garbage. Fail CLOSED to stalled rather than emit a non-finite instant.
  if (!Number.isFinite(hoursRemaining) || !Number.isFinite(projectedMs)) {
    return { verdict: 'stalled', hoursRemaining: null, projectedMs: null, requiredVelocityPerHour, slackMs: null };
  }
  if (due === null) {
    return { verdict: 'moving', hoursRemaining, projectedMs, requiredVelocityPerHour: null, slackMs: null };
  }
  const slackMs = due - projectedMs;
  return { verdict: slackMs >= 0 ? 'ahead' : 'behind', hoursRemaining, projectedMs, requiredVelocityPerHour, slackMs };
}

/** Sort weight — risk first: behind, then stalled, then moving, ahead, complete. */
const VERDICT_ORDER: Record<PaceVerdict, number> = { behind: 0, stalled: 1, moving: 2, ahead: 3, complete: 4 };

/** Order two forecasts risk-first: verdict weight, then most-behind slack / steepest required pace first. */
export function compareForecasts(a: Forecast, b: Forecast): number {
  const w = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
  if (w !== 0) return w;
  if (a.slackMs !== null && b.slackMs !== null) return a.slackMs - b.slackMs; // most behind (smallest) first
  const ra = a.requiredVelocityPerHour ?? -1;
  const rb = b.requiredVelocityPerHour ?? -1;
  return rb - ra; // steepest ask first
}
