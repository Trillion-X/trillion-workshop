export interface SchedulePlanTask {
  id: string;
  title: string;
  duration_minutes: number;
  due?: string | null;
  /** A row of schedule-planner.json `deadline_types` (hard, soft, none); hard when absent. Independent of priority. */
  deadline_type?: string | null;
  /** Ranks tasks among each other (schedule-planner.json `priority_order`); never decides whether a deadline binds. */
  priority?: string | null;
  /** The task starts no earlier than this instant or local date. */
  start_on?: string | null;
  /** Ids of tasks that must end before this one starts. */
  blocked_by?: string[];
  /** A task already on the calendar: kept where it is unless `auto_placed` and not pinned. */
  starts_at?: string | null;
  ends_at?: string | null;
  /** The smallest useful slice in minutes: a task too long for any one free stretch is placed in slices no shorter than this. */
  minimum_duration_minutes?: number | null;
  /** Preferred times (local minutes after midnight, optional weekdays 0 = Sunday): the task is only placed inside them, within working hours. */
  preferred_window?: { start_minute: number; end_minute: number; weekdays?: number[] } | null;
  /** A person moved the automatically placed task here; the pin holds until this instant passes. */
  pinned_until?: string | null;
  /** The planner placed it (and may take it back). */
  auto_placed?: boolean;
}

export interface SchedulePlanEvent {
  id?: string;
  starts_at?: string | null;
  ends_at?: string | null;
  minutes?: number;
  all_day?: boolean;
  /** The provider's original local date for an all-day event. */
  day?: string;
  /** Exclusive final local date for a multi-day all-day event. */
  day_end?: string;
}

export interface ScheduleWorkingInterval {
  /** Local minutes after midnight, 0 through 1440. */
  start_minute: number;
  end_minute: number;
}

export interface ScheduleWorkingDay {
  /** Local weekdays: Sunday is 0. */
  weekday: number;
  /** Sorted, nonoverlapping same-day availability windows. An empty list means unavailable. */
  intervals: ScheduleWorkingInterval[];
}

export interface ScheduleWorkingHoursLegacy {
  /** Local minutes after midnight, 0 through 1440. */
  start_minute: number;
  end_minute: number;
  /** Local weekdays: Sunday is 0. */
  weekdays: number[];
}

export interface ScheduleWorkingHoursByDay {
  /** Days omitted from this list have no availability. */
  days: ScheduleWorkingDay[];
}

export type ScheduleWorkingHours = ScheduleWorkingHoursLegacy | ScheduleWorkingHoursByDay;

export type ScheduleUnscheduledReason =
  | 'missing_task_id'
  | 'invalid_duration'
  | 'invalid_due'
  | 'invalid_start'
  | 'due_passed'
  | 'duration_exceeds_workday'
  | 'outside_preferred_times'
  | 'blocker_cycle'
  | 'blocker_unknown'
  | 'blocked_by_unscheduled'
  | 'no_workdays'
  | 'over_capacity'
  | 'no_free_slot_before_deadline'
  | 'no_free_slot_before_horizon';

export interface ScheduleProposal {
  task_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  /** A row of schedule-planner.json `statuses`. */
  status: string;
  /** Placed after a soft deadline it could not meet. */
  late: boolean;
  /** Present when the task is placed in slices: this is slice `chunk_index` of `chunk_count`. */
  chunk_index?: number;
  chunk_count?: number;
  /** Where the task was before the planner took it back; the schedule write expects it as the current start. */
  was_at?: string;
}

export interface ScheduleUnscheduledTask {
  task_id: string | null;
  title: string;
  reason: ScheduleUnscheduledReason;
  /** The blockers that caused `blocked_by_unscheduled`, `blocker_unknown` or `blocker_cycle`. */
  blocker_ids?: string[];
  /** A task the planner took back but could not place again: it is still where it was. */
  was_at?: string;
}

export interface ScheduleKeptTask {
  task_id: string | null;
  title: string;
  starts_at: string;
  ends_at: string;
  /** `pinned`: a live pin holds an automatic task; `fixed`: nobody asked the planner to place it. */
  reason: 'pinned' | 'fixed';
  pinned_until?: string;
}

export interface ScheduleDayLoad {
  day: string;
  planned_minutes: number;
  threshold_minutes: number;
  /** A row of schedule-planner.json `capacity_levels`. */
  level: string;
}

export interface SchedulePlan {
  start_day: string;
  horizon_days: number;
  proposals: ScheduleProposal[];
  unscheduled: ScheduleUnscheduledTask[];
  kept: ScheduleKeptTask[];
  /** Automatic tasks whose pin ran out and went back into this plan. */
  released: string[];
  /** Present when `capacity` was given: the planned minutes of each day with a limit. */
  days?: ScheduleDayLoad[];
}

export interface SchedulePlannerOptions {
  start_day?: string;
  horizon_days?: number;
  working_hours: ScheduleWorkingHours;
  slot_minutes?: number;
  max_tasks?: number;
  max_events?: number;
  default_event_minutes?: number;
  /** Earliest permissible instant; a screen passes its actual current time. */
  earliest_at?: string | null;
  /** Comparator names from the planner (due, priority, duration, input); default is schedule-planner.json `order_by`. */
  order_by?: string[];
  priority_order?: string[];
  /** Start later, stop early, block hours (`blocks`) or switch off (`off`) one local day. */
  day_overrides?: ScheduleDayOverride[];
  /** Caps planned minutes per day: a default, per-weekday (Sunday 0) limits and a caution band below the limit. */
  capacity?: { default_minutes?: number | null; weekdays?: Record<number, number>; caution_band_minutes?: number };
  /** Blockers that are not in this plan: when one ends, or that it is done. */
  blockers?: Record<string, { ends_at?: string | null; done?: boolean }>;
}

export interface ScheduleDayOverride {
  day: string;
  off?: boolean;
  start_minute?: number | null;
  end_minute?: number | null;
  blocks?: Array<{ start_minute: number; end_minute: number }>;
}

/** One day's override checked and normalized (start_minute 0 and end_minute 1440 when not given); throws TypeError when it is not one. */
export function dayOverrideOf(row: ScheduleDayOverride): Required<Omit<ScheduleDayOverride, 'start_minute' | 'end_minute'>> & { start_minute: number; end_minute: number };

/** Propose free local work-hour slots. This pure function never writes tasks or events. */
export function planSchedule(
  tasks: SchedulePlanTask[],
  events: SchedulePlanEvent[],
  options: SchedulePlannerOptions,
): SchedulePlan;
