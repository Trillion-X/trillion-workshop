// parts/timed-action/do-work/materialize-recurring-windows.ts (ported from bitfield-packages packages/timed-action/do-work;
// its wall-time reading, zone check and clock-change rule are the shared ./wall-time.ts)
// timed-action's recurrence materializer is deliberately a pure DATA reduction.
// It owns recurring window identity and progression, never clocks or effects: a
// caller gives it schedule DATA plus durable occurrence state and persists its
// deterministic materialization intents with compare-and-exchange on occurrence_key.

import { DAY_MS, addCivilDays, addCivilMinutes, localParts, pad, parseDate, parseTime, resolveStart, timeZoneName, weekday } from './wall-time.ts';
import type { DstFoldPolicy, DstGapPolicy } from './wall-time.ts';

export type { DstFoldPolicy, DstGapPolicy } from './wall-time.ts';

export interface RecurringWindowSchedule {
  readonly schedule_id: string;
  readonly label?: string;
  readonly title?: string;
  readonly name?: string;
  readonly source_generation: string | number;
  readonly schedule_revision: string | number;
  readonly timezone: string;
  readonly start_local_date: string; // YYYY-MM-DD in timezone
  readonly cadence: {
    // 'minute' and 'hour' repeat within each day on the grid through local_window.start (every `interval` minutes or
    // hours), never more often than every MIN_STEP_MINUTES; 'day' and 'week' run once at local_window.start.
    readonly unit: 'minute' | 'hour' | 'day' | 'week';
    readonly interval?: number;
    // Required for a weekly cadence; 0=Sunday … 6=Saturday.
    readonly weekdays?: readonly number[];
  };
  readonly local_window: {
    readonly start: string; // HH:MM
    readonly duration_minutes: number;
  };
  readonly dst?: {
    readonly gap?: DstGapPolicy;
    readonly fold?: DstFoldPolicy;
  };
  // The recurrence owner is generic DATA. The timed-action runtime wraps this
  // synchronous owner call with durable occurrence-state + receipt writes; an
  // asynchronous acceptance is deliberately not a supported completion mode.
  readonly action: {
    readonly operation: string;
    readonly owner_ref: string;
    readonly owner_dispatch: {
      readonly name: string;
      readonly input: unknown;
    };
    readonly completion: {
      readonly mode: 'synchronous-owner-return';
    };
  };
}

// State is append-friendly: a successful owner writes owner_outcome evidence for
// the occurrence. A dispatch acknowledgement is intentionally not an outcome and
// is ignored for progression.
export interface RecurringOccurrenceState {
  readonly occurrence_key: string;
  readonly materialization_key?: string;
  readonly materialized_at?: string;
  readonly owner_outcome?: {
    readonly proven: boolean;
    readonly owner_ref?: string;
    readonly proof_ref?: string;
    readonly observed_at?: string;
  };
  readonly dispatch_acknowledged_at?: string;
}

export interface RecurringMaterializationInput {
  readonly schedules?: readonly RecurringWindowSchedule[];
  readonly occurrence_states?: readonly RecurringOccurrenceState[];
  // Bounded defence against an untrusted historical schedule with every previous
  // occurrence proven. The reducer fails closed instead of doing unbounded work.
  readonly max_calendar_scan_days?: number;
  // The current instant. A schedule that repeats within the day passes over an unproven time whose next time has
  // also already come, so a schedule that was asleep runs once on waking instead of once for every time it missed.
  readonly now_ms?: number;
}

export interface RecurringWindowPlanInput {
  readonly now: string | number;
  readonly schedules: readonly RecurringWindowSchedule[];
  readonly max_occurrences_per_schedule: number;
  readonly max_calendar_scan_days?: number;
}

const DAY_MINUTES = 1_440;
// Nothing repeats more often than this: a schedule is work someone's account pays for on every run.
export const MIN_STEP_MINUTES = 5;
const STEP_MINUTES: Record<string, number> = { minute: 1, hour: 60 };
const MAX_CALENDAR_SCAN_DAYS = 4_096;
const MAX_PLANNED_OCCURRENCES_PER_SCHEDULE = 1_000;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function identityText(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}


function scheduleError(schedule: RecurringWindowSchedule): string | null {
  if (!text(schedule?.schedule_id) || !identityText(schedule?.source_generation) || !identityText(schedule?.schedule_revision)) return 'missing_identity_component';
  if (!parseDate(schedule?.start_local_date) || !parseTime(schedule?.local_window?.start)) return 'invalid_local_window';
  if (!Number.isInteger(schedule?.local_window?.duration_minutes) || schedule.local_window.duration_minutes <= 0 || schedule.local_window.duration_minutes > 10_080) return 'invalid_duration';
  const interval = schedule?.cadence?.interval ?? 1;
  if (!Number.isInteger(interval) || interval <= 0 || interval > 512) return 'invalid_interval';
  const unit = schedule?.cadence?.unit;
  if (unit !== 'day' && unit !== 'week' && !Object.hasOwn(STEP_MINUTES, unit)) return 'invalid_cadence_unit';
  const step = stepMinutes(schedule);
  if (step !== null && (step < MIN_STEP_MINUTES || step > DAY_MINUTES)) return 'invalid_interval';
  if (schedule.cadence.unit === 'week' && (!Array.isArray(schedule.cadence.weekdays) || schedule.cadence.weekdays.length === 0 || schedule.cadence.weekdays.some((value) => !Number.isInteger(value) || value < 0 || value > 6))) return 'invalid_weekdays';
  if (schedule.dst?.gap && schedule.dst.gap !== 'skip' && schedule.dst.gap !== 'next-valid') return 'invalid_gap_policy';
  if (schedule.dst?.fold && schedule.dst.fold !== 'earlier' && schedule.dst.fold !== 'later' && schedule.dst.fold !== 'both') return 'invalid_fold_policy';
  if (!text(schedule?.action?.operation) || !text(schedule?.action?.owner_ref) || !text(schedule?.action?.owner_dispatch?.name)) return 'invalid_action_owner';
  if (schedule?.action?.completion?.mode !== 'synchronous-owner-return') return 'unsupported_completion_mode';
  if (timeZoneName(schedule.timezone) === null) return 'invalid_timezone';
  return null;
}

// How many minutes apart a schedule that repeats within the day runs; null for one that runs once a day or week.
function stepMinutes(schedule: RecurringWindowSchedule): number | null {
  const per = STEP_MINUTES[schedule?.cadence?.unit as string];
  return per ? per * (schedule.cadence.interval ?? 1) : null;
}

// The local times a schedule asks for on one date, earliest first: its one start, or for a schedule that repeats
// within the day every minute of the day on the grid through its start (09:00 every 2 hours is 01:00, 03:00 ... 23:00).
function requestedTimes(schedule: RecurringWindowSchedule): string[] {
  const step = stepMinutes(schedule);
  if (step === null) return [schedule.local_window.start];
  const at = parseTime(schedule.local_window.start)!;
  const first = (at.hour * 60 + at.minute) % step;
  const times: string[] = [];
  for (let minute = first; minute < DAY_MINUTES; minute += step) times.push(`${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`);
  return times;
}

function isCandidateDate(schedule: RecurringWindowSchedule, date: string, offsetDays: number): boolean {
  if (stepMinutes(schedule) !== null) return true;
  const interval = schedule.cadence.interval ?? 1;
  if (schedule.cadence.unit === 'day') return offsetDays % interval === 0;
  // Sunday-anchored, host-independent week index.
  const start = parseDate(schedule.start_local_date)!;
  const startWeekStart = Date.UTC(start.year, start.month - 1, start.day) - weekday(schedule.start_local_date) * DAY_MS;
  const candidate = parseDate(date)!;
  const candidateWeekStart = Date.UTC(candidate.year, candidate.month - 1, candidate.day) - weekday(date) * DAY_MS;
  const weekIndex = Math.round((candidateWeekStart - startWeekStart) / (7 * DAY_MS));
  return weekIndex >= 0 && weekIndex % interval === 0 && schedule.cadence.weekdays!.includes(weekday(date));
}

export function recurringOccurrenceKey(identity: {
  schedule_id: string;
  source_generation: string | number;
  schedule_revision: string | number;
  timezone: string;
  requested_start: CivilDateTime;
  requested_end: CivilDateTime;
  resolved_start: CivilDateTime;
  resolved_end: CivilDateTime;
  fold: string;
}): string {
  // JSON preserves all identity components losslessly and prevents delimiter
  // collisions between arbitrary schedule IDs and local strings.
  return `timed-action.recurring-window::${encodeURIComponent(JSON.stringify([
    identity.schedule_id,
    String(identity.source_generation),
    String(identity.schedule_revision),
    identity.timezone,
    identity.requested_start.date, identity.requested_start.time,
    identity.requested_end.date, identity.requested_end.time,
    identity.resolved_start.date, identity.resolved_start.time,
    identity.resolved_end.date, identity.resolved_end.time,
    identity.fold,
  ]))}`;
}

function ownerOutcomeProven(state: RecurringOccurrenceState): boolean {
  const outcome = state.owner_outcome;
  return outcome?.proven === true && !!text(outcome.owner_ref) && !!text(outcome.proof_ref) && !!text(outcome.observed_at);
}

function materializationCommitted(state: RecurringOccurrenceState): boolean {
  return state.materialization_key === state.occurrence_key && !!text(state.materialized_at);
}

export function materializeRecurringWindows(input: RecurringMaterializationInput = {}) {
  const schedules = Array.isArray(input.schedules) ? [...input.schedules] : [];
  const states = Array.isArray(input.occurrence_states) ? input.occurrence_states : [];
  const maxDays = Number.isInteger(input.max_calendar_scan_days) && input.max_calendar_scan_days! > 0
    ? Math.min(input.max_calendar_scan_days!, MAX_CALENDAR_SCAN_DAYS)
    : MAX_CALENDAR_SCAN_DAYS;
  const nowMs = Number.isFinite(input.now_ms) ? input.now_ms! : null;
  const scheduleIdCounts = new Map<string, number>();
  for (const schedule of schedules) if (text(schedule?.schedule_id)) scheduleIdCounts.set(schedule.schedule_id, (scheduleIdCounts.get(schedule.schedule_id) ?? 0) + 1);
  const stateByKey = new Map<string, RecurringOccurrenceState[]>();
  for (const state of states) {
    if (!text(state?.occurrence_key)) continue;
    const bucket = stateByKey.get(state.occurrence_key) ?? [];
    bucket.push(state);
    stateByKey.set(state.occurrence_key, bucket);
  }

  const materializations: Array<Record<string, unknown>> = [];
  const active_occurrences: Array<Record<string, unknown>> = [];
  const rejected_schedules: Array<Record<string, string>> = [];
  const skipped_resolutions: Array<Record<string, unknown>> = [];

  for (const schedule of schedules.sort((left, right) => String(left?.schedule_id ?? '').localeCompare(String(right?.schedule_id ?? '')))) {
    const error = scheduleError(schedule);
    if (error || (scheduleIdCounts.get(schedule.schedule_id) ?? 0) !== 1) {
      rejected_schedules.push({ schedule_id: String(schedule?.schedule_id ?? ''), reason: error ?? 'conflicting_schedule_id' });
      continue;
    }
    const gap = schedule.dst?.gap ?? 'skip';
    const fold = schedule.dst?.fold ?? 'earlier';
    const times = requestedTimes(schedule);
    const step = stepMinutes(schedule);
    let selected = false;
    for (let offsetDays = 0; offsetDays < maxDays && !selected; offsetDays += 1) {
      const date = addCivilDays(schedule.start_local_date, offsetDays);
      if (!isCandidateDate(schedule, date, offsetDays)) continue;
      for (const requestedTime of times) {
        if (selected) break;
        const requestedStart = { date, time: requestedTime };
        const requestedEnd = addCivilMinutes(requestedStart, schedule.local_window.duration_minutes);
        const starts = resolveStart(requestedStart, schedule.timezone, gap, fold);
        if (starts.length === 0) {
          skipped_resolutions.push({ schedule_id: schedule.schedule_id, requested_start: requestedStart, timezone: schedule.timezone, reason: 'dst_gap_skip' });
          continue;
        }
        const candidates = starts.map((start) => {
          const resolvedEnd = addCivilMinutes(start.resolved, schedule.local_window.duration_minutes);
          const key = recurringOccurrenceKey({
            schedule_id: schedule.schedule_id,
            source_generation: schedule.source_generation,
            schedule_revision: schedule.schedule_revision,
            timezone: schedule.timezone,
            requested_start: requestedStart,
            requested_end: requestedEnd,
            resolved_start: start.resolved,
            resolved_end: resolvedEnd,
            fold: start.fold,
          });
          return { start, resolvedEnd, key };
        });
        // A fold configured as both is one logical local window with two branches:
        // do not advance past either until every branch has owner outcome proof.
        if (candidates.every((candidate) => (stateByKey.get(candidate.key) ?? []).some(ownerOutcomeProven))) continue;
        if (step !== null && nowMs !== null && candidates.every((candidate) => candidate.start.instant_ms + step * 60_000 <= nowMs)) continue;
        for (const candidate of candidates) {
          const statesForOccurrence = stateByKey.get(candidate.key) ?? [];
          if (statesForOccurrence.some(ownerOutcomeProven)) continue;
          const committed = statesForOccurrence.some(materializationCommitted);
          const occurrence = {
            occurrence_key: candidate.key,
            schedule_id: schedule.schedule_id,
            schedule_label: text(schedule.label) ?? text(schedule.title) ?? text(schedule.name),
            source_generation: String(schedule.source_generation),
            schedule_revision: String(schedule.schedule_revision),
            timezone: schedule.timezone,
            requested_local_window: { start: requestedStart, end: requestedEnd },
            resolved_local_window: { start: candidate.start.resolved, end: candidate.resolvedEnd, fold: candidate.start.fold },
            start: new Date(candidate.start.instant_ms).toISOString(),
            end: new Date(candidate.start.instant_ms + schedule.local_window.duration_minutes * 60_000).toISOString(),
            action: schedule.action,
          };
          if (!committed) {
            materializations.push({
              kind: 'recurring-window-materialization',
              materialization_key: candidate.key,
              compare_exchange_key: candidate.key,
              occurrence,
              initial_state: { occurrence_key: candidate.key, materialization_key: candidate.key, materialized_at: null },
            });
          }
          active_occurrences.push({ ...occurrence, retry_same_occurrence: committed });
        }
        selected = true;
      }
    }
    if (!selected) rejected_schedules.push({ schedule_id: schedule.schedule_id, reason: 'scan_limit_without_unresolved_occurrence' });
  }

  return {
    schema: 'timed-action.recurring-window-materialization.v1',
    materializations,
    active_occurrences,
    rejected_schedules,
    skipped_resolutions,
  };
}

/**
 * Purely enumerate bounded future recurrence slots for planning and previews.
 * Unlike materializeRecurringWindows, this does not read or fabricate durable
 * occurrence state and never emits materialization intents. It shares schedule
 * validation, local-calendar progression, occurrence identity, and DST
 * resolution with the runtime reducer.
 */
export function planRecurringWindows(input: RecurringWindowPlanInput) {
  const nowMs = typeof input?.now === 'number' ? input.now : Date.parse(String(input?.now ?? ''));
  if (!Number.isFinite(nowMs)) throw new Error('plan-recurring-windows: `now` is not a time');
  if (!Array.isArray(input?.schedules)) throw new Error('plan-recurring-windows: `schedules` must be a list');
  const countLimit = input.max_occurrences_per_schedule;
  if (!Number.isInteger(countLimit) || countLimit < 1 || countLimit > MAX_PLANNED_OCCURRENCES_PER_SCHEDULE) {
    throw new Error(`plan-recurring-windows: max_occurrences_per_schedule must be an integer from 1 to ${MAX_PLANNED_OCCURRENCES_PER_SCHEDULE}`);
  }
  const scanLimit = Number.isInteger(input.max_calendar_scan_days) && input.max_calendar_scan_days! > 0
    ? Math.min(input.max_calendar_scan_days!, MAX_CALENDAR_SCAN_DAYS)
    : MAX_CALENDAR_SCAN_DAYS;
  const schedules = [...input.schedules];
  const idCounts = new Map<string, number>();
  for (const schedule of schedules) if (text(schedule?.schedule_id)) idCounts.set(schedule.schedule_id, (idCounts.get(schedule.schedule_id) ?? 0) + 1);
  const future_occurrences: Array<Record<string, unknown>> = [];
  const rejected_schedules: Array<Record<string, string>> = [];
  const skipped_resolutions: Array<Record<string, unknown>> = [];
  const coverage: Array<Record<string, unknown>> = [];

  for (const schedule of schedules.sort((left, right) => String(left?.schedule_id ?? '').localeCompare(String(right?.schedule_id ?? '')))) {
    const error = scheduleError(schedule);
    if (error || (idCounts.get(schedule.schedule_id) ?? 0) !== 1) {
      rejected_schedules.push({ schedule_id: String(schedule?.schedule_id ?? ''), reason: error ?? 'conflicting_schedule_id' });
      continue;
    }
    const gap = schedule.dst?.gap ?? 'skip';
    const fold = schedule.dst?.fold ?? 'earlier';
    const times = requestedTimes(schedule);
    const step = stepMinutes(schedule);
    const nowDate = localParts(nowMs, schedule.timezone).date;
    const nowCivil = parseDate(nowDate)!;
    const startCivil = parseDate(schedule.start_local_date)!;
    const firstOffset = Math.max(0, Math.floor((Date.UTC(nowCivil.year, nowCivil.month - 1, nowCivil.day)
      - Date.UTC(startCivil.year, startCivil.month - 1, startCivil.day)) / DAY_MS));
    const before = future_occurrences.length;
    let scannedDays = 0;
    let throughDate: string | null = null;
    let reachedCountLimit = false;
    let localWindowOmittedForCountLimit = false;
    scan: for (let scanOffset = 0; scanOffset < scanLimit; scanOffset += 1) {
      const offsetDays = firstOffset + scanOffset;
      const date = addCivilDays(schedule.start_local_date, offsetDays);
      scannedDays += 1;
      throughDate = date;
      if (!isCandidateDate(schedule, date, offsetDays)) continue;
      for (const requestedTime of times) {
        const requestedStart = { date, time: requestedTime };
        const requestedEnd = addCivilMinutes(requestedStart, schedule.local_window.duration_minutes);
        const starts = resolveStart(requestedStart, schedule.timezone, gap, fold);
        if (starts.length === 0) {
          skipped_resolutions.push({ schedule_id: schedule.schedule_id, requested_start: requestedStart, timezone: schedule.timezone, reason: 'dst_gap_skip' });
          continue;
        }
        const candidates = starts.map((start) => {
          const resolvedEnd = addCivilMinutes(start.resolved, schedule.local_window.duration_minutes);
          const key = recurringOccurrenceKey({
            schedule_id: schedule.schedule_id,
            source_generation: schedule.source_generation,
            schedule_revision: schedule.schedule_revision,
            timezone: schedule.timezone,
            requested_start: requestedStart,
            requested_end: requestedEnd,
            resolved_start: start.resolved,
            resolved_end: resolvedEnd,
            fold: start.fold,
          });
          return { start, resolvedEnd, key };
        }).filter((candidate) => candidate.start.instant_ms > nowMs);
        const remaining = countLimit - (future_occurrences.length - before);
        // `both` is one requested local window with two branches. Keep that
        // indivisible when the remaining bounded result space cannot hold it.
        if (candidates.length > remaining) {
          reachedCountLimit = true;
          localWindowOmittedForCountLimit = true;
          break scan;
        }
        for (const candidate of candidates) {
          future_occurrences.push({
            occurrence_key: candidate.key,
            schedule_id: schedule.schedule_id,
            schedule_label: text(schedule.label) ?? text(schedule.title) ?? text(schedule.name),
            source_generation: String(schedule.source_generation),
            schedule_revision: String(schedule.schedule_revision),
            timezone: schedule.timezone,
            requested_local_window: { start: requestedStart, end: requestedEnd },
            resolved_local_window: { start: candidate.start.resolved, end: candidate.resolvedEnd, fold: candidate.start.fold },
            start: new Date(candidate.start.instant_ms).toISOString(),
            end: new Date(candidate.start.instant_ms + schedule.local_window.duration_minutes * 60_000).toISOString(),
            action: schedule.action,
          });
          if (future_occurrences.length - before === countLimit) {
            reachedCountLimit = true;
            break scan;
          }
        }
      }
    }
    const scannedOut = scannedDays === scanLimit && !reachedCountLimit;
    coverage.push({
      schedule_id: schedule.schedule_id,
      requested_count: countLimit,
      returned_count: future_occurrences.length - before,
      scanned_days: scannedDays,
      scanned_through_local_date: throughDate,
      count_limit_reached: reachedCountLimit,
      scan_limit_reached: scannedOut,
      local_window_omitted_for_count_limit: localWindowOmittedForCountLimit,
      // Recurrences are open-ended; coverage is bounded by one of these limits,
      // never claimed to exhaust the schedule itself.
      recurrence_exhausted: false,
      requested_count_reached: future_occurrences.length - before === countLimit,
      stopped_by: localWindowOmittedForCountLimit ? 'count_limit_before_complete_local_window'
        : reachedCountLimit ? 'count_limit' : scannedOut ? 'scan_limit' : 'no_future_occurrence_in_scan',
      minimum_step_minutes: step ?? null,
    });
  }
  future_occurrences.sort((left, right) => String(left.start).localeCompare(String(right.start))
    || String(left.schedule_id).localeCompare(String(right.schedule_id))
    || String(left.occurrence_key).localeCompare(String(right.occurrence_key)));
  return {
    schema: 'timed-action.recurring-window-plan.v1',
    now: new Date(nowMs).toISOString(),
    max_occurrences_per_schedule: countLimit,
    max_calendar_scan_days: scanLimit,
    future_occurrences,
    rejected_schedules,
    skipped_resolutions,
    coverage,
  };
}
