// parts/timed-action/do-work/when-to-wake.ts
//
// Purpose: one call a Durable Object alarm makes on each wake. It reads the person's schedule DATA (recurring
// schedules with their occurrence state, and one-off scheduled actions with their time windows and receipts), and
// answers three things: what is due now, which recurring occurrences to record before running them, and when to wake
// next. The alarm is the only clock; both reductions it composes stay pure.
//
// Non-Negotiable Invariants:
//   1. `now` is given (ISO text or epoch milliseconds); nothing here reads a clock, so a replayed wake gives the same
//      answer.
//   2. A recurring occurrence is due once its start has come and stays due until its owner's outcome is proven
//      (materializeRecurringWindows keeps it active); a one-off action is due once its window has come and until a
//      receipt names it (evaluateDueScheduledActions).
//   3. `next_wake_at` is the earliest start still ahead, counting what is due now as done: the occurrence after each
//      due recurring one, recurring occurrences not yet due, and unfired one-off actions that carry their dispatch;
//      null when nothing is ahead. The caller runs what is due and sets the alarm there, or sooner when something due
//      failed and must be retried (a failed occurrence stays due on the next wake).
//   4. Nothing here names a schedule, action or owner; each row carries its own dispatch.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { actionOperation, evaluateDueScheduledActions, receiptKey, resolveDueAt } from './evaluate-due-scheduled-actions.ts';
import { materializeRecurringWindows } from './materialize-recurring-windows.ts';
import { intervalMsOf, spreadOneShotDue, spreadRecurringStart } from './spread-fires.ts';
import type { SpreadConfig } from './spread-fires.ts';
import type { RecurringOccurrenceState, RecurringWindowSchedule } from './materialize-recurring-windows.ts';

export interface WakeInput {
  readonly now: string | number;
  readonly schedules?: readonly RecurringWindowSchedule[];
  readonly occurrence_states?: readonly RecurringOccurrenceState[];
  readonly time_windows?: readonly Record<string, unknown>[];
  readonly actions?: readonly Record<string, unknown>[];
  readonly receipts?: readonly Record<string, unknown>[];
  readonly max_calendar_scan_days?: number;
  // How fires are spread (spread-fires.ts); without it nothing moves.
  readonly spread?: SpreadConfig | null;
}

const list = <T>(value: readonly T[] | undefined): readonly T[] => (Array.isArray(value) ? value : []);

export function whenToWake(input: WakeInput) {
  const nowMs = typeof input.now === 'number' ? input.now : Date.parse(String(input.now));
  if (!Number.isFinite(nowMs)) throw new Error('when-to-wake: `now` is not a time');
  const now = new Date(nowMs).toISOString();

  const recurring = materializeRecurringWindows({
    schedules: list(input.schedules),
    occurrence_states: list(input.occurrence_states),
    max_calendar_scan_days: input.max_calendar_scan_days,
    now_ms: nowMs,
  });
  // With a spread config, a recurring occurrence starts a share of its interval later (spread-fires.ts); the one-off
  // windows below are moved only earlier. The reductions then see the spread times, so due and next wake agree.
  const spread = input.spread ?? null;
  const intervalBySchedule = new Map(list(input.schedules).map((schedule) => [schedule.schedule_id, intervalMsOf(schedule.cadence)]));
  const spreadStart = (occurrence: Record<string, unknown>) => (spread
    ? { ...occurrence, start: new Date(spreadRecurringStart(Date.parse(String(occurrence.start)), String(occurrence.schedule_id), intervalBySchedule.get(String(occurrence.schedule_id)) ?? 0, spread)).toISOString() }
    : occurrence);
  const activeOccurrences = recurring.active_occurrences.map(spreadStart);
  const recurringDue = activeOccurrences.filter((occurrence) => Date.parse(String(occurrence.start)) <= nowMs);
  const dueKeys = new Set(recurringDue.map((occurrence) => occurrence.occurrence_key));
  // The occurrences that follow once what is due now is done: the same reduction with each due occurrence proven.
  const afterDue = recurringDue.length
    ? materializeRecurringWindows({
        schedules: list(input.schedules),
        occurrence_states: [
          ...list(input.occurrence_states),
          ...[...dueKeys].map((occurrence_key) => ({
            occurrence_key,
            owner_outcome: { proven: true, owner_ref: 'when-to-wake', proof_ref: 'counted-as-done', observed_at: now },
          })),
        ],
        max_calendar_scan_days: input.max_calendar_scan_days,
        now_ms: nowMs,
      }).active_occurrences.map(spreadStart)
    : activeOccurrences;
  const ahead: number[] = afterDue
    .map((occurrence) => Date.parse(String(occurrence.start)))
    .filter((start) => start > nowMs);

  const createdAtOf = (window: Record<string, unknown>) => {
    const created = Date.parse(String(window.created_at ?? ''));
    return Number.isFinite(created) ? created : null;
  };
  const timeWindows = list(input.time_windows).map((window) => {
    const dueMs = Date.parse(String(resolveDueAt(window) ?? ''));
    if (!spread || !Number.isFinite(dueMs)) return window;
    return { ...window, due_at: new Date(spreadOneShotDue(dueMs, String(window.record_id), createdAtOf(window), spread)).toISOString() };
  });
  const scheduled = evaluateDueScheduledActions({
    time_windows: timeWindows,
    actions: list(input.actions),
    receipts: list(input.receipts),
    now,
  });
  const windowByRecord = new Map(timeWindows.filter((window) => window?.record_id != null).map((window) => [window.record_id, window]));
  const fired = new Set(list(input.receipts).filter((receipt) => receipt?.record_id != null).map((receipt) => receiptKey(receipt.record_id, receipt.operation)));
  for (const action of list(input.actions)) {
    const dispatch = action?.dispatch as { name?: unknown } | undefined;
    if (action?.record_id == null || dispatch?.name == null) continue;
    if (fired.has(receiptKey(action.record_id, actionOperation(action)))) continue;
    const dueAt = resolveDueAt(windowByRecord.get(action.record_id));
    const dueMs = dueAt == null ? NaN : Date.parse(String(dueAt));
    if (dueMs > nowMs) ahead.push(dueMs);
  }

  return {
    now,
    recurring_due: recurringDue,
    materializations: recurring.materializations.filter((materialization) => dueKeys.has(materialization.materialization_key)),
    scheduled_due: scheduled.due,
    next_wake_at: ahead.length ? new Date(Math.min(...ahead)).toISOString() : null,
    rejected_schedules: recurring.rejected_schedules,
    skipped_resolutions: recurring.skipped_resolutions,
  };
}
