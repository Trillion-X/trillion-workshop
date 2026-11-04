// src/schedule-lateness.mjs
//
// PURPOSE
//   Says how late a recurring run is against its own time, in three classes (on time, late, catch-up), with a grace in
//   proportion to the schedule's cadence. Pure: it is given the due time, the time now and the period, and reads the
//   numbers from src/schedule-lateness.json. src/automations.mjs keeps the class on the schedule's last run.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every number and class name is DATA (src/schedule-lateness.json); nothing here names a schedule or a unit.
//   2. The grace is the period times grace_fraction, clamped between grace_min_seconds and grace_max_seconds.
//   3. A run is never early: a due time in the future is on time.
import settings from '../../shared-code/src/schedule-lateness.json' with { type: 'json' };

/** The grace, in seconds, for a schedule that repeats every `periodSeconds`. */
export const graceSecondsOf = (periodSeconds, rules = settings) =>
  Math.max(rules.grace_min_seconds, Math.min(periodSeconds * rules.grace_fraction, rules.grace_max_seconds));

/** 'on_time', 'late' or 'catch_up' (the DATA's class names) for a run due at `dueMs` that starts at `nowMs`. */
export function latenessOf({ dueMs, nowMs, periodSeconds }, rules = settings) {
  const lateSeconds = (nowMs - dueMs) / 1000;
  if (!(lateSeconds > rules.on_time_seconds)) return rules.classes.on_time;
  return lateSeconds <= graceSecondsOf(periodSeconds, rules) ? rules.classes.late : rules.classes.catch_up;
}
