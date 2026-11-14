// parts/ui/show/schedule-calendar/index.ts
//
// PURPOSE
//   The one import point for the calendar things are dragged onto, and the pure placement arithmetic it draws with.

export { ScheduleCalendar } from './ScheduleCalendar';
export type { ScheduleCalendarProps, ScheduleCalendarWords, ScheduleItem, ScheduleOpenModifiers, ScheduleRange, ScheduleTrayGroup, ScheduleVerbRegistrar, ScheduleVerbRun, ScheduleView } from './ScheduleCalendar';
export { EventOptions } from './EventOptions';
export type { EventOptionsProps, EventOptionsWords, EventRepeatChoice, EventRepeatSetting, EventReminderSetting } from './EventOptions';
export { presetsFor, recurrenceToRRule, rruleToRecurrence, rruleToLabel } from './event-repeat.mjs';
export type { CustomRepeat, RepeatData, RepeatPreset } from './event-repeat.mjs';
export { addGuests, guestFields, removeGuest } from './event-guests.mjs';
export { groupSourcesByAccount } from './calendar-source-groups';
export { minutesOf as reminderMinutesOf, reminderLabel, reminderOverrides, withReminder, withoutReminder } from './event-reminders.mjs';
export type { ReminderData } from './event-reminders.mjs';
export { EventProperties } from '../event-properties';
export type { EventPropertiesProps, EventPropertyChoice, EventPropertyField, EventPropertySetting } from '../event-properties';
export { TaskRecurrence } from '../task-recurrence/TaskRecurrence';
export type { TaskRecurrenceChoice, TaskRecurrenceProps, TaskRecurrenceValue, TaskRecurrenceWords } from '../task-recurrence/TaskRecurrence';
export { CalendarControls } from './CalendarControls';
export { WeeklyAvailability } from './WeeklyAvailability';
export type {
  CalendarAccount, CalendarAccountCalendar, CalendarAccessRole, CalendarSelection,
  CalendarControlSource, CalendarControlPreferences, CalendarControlsWords,
  CalendarControlNavigationItem, CalendarControlColor, CalendarControlsProps, CalendarControlTimeZone, CalendarControlPerson,
  CalendarControlChoice, CalendarControlTimeFormat, CalendarControlDateFormat, CalendarControlZoomOption,
} from './CalendarControls';
export type {
  WeeklyAvailabilityDay, WeeklyAvailabilityInterval, WeeklyAvailabilitySchedule,
  WeeklyAvailabilityWords, WeeklyAvailabilityProps,
} from './WeeklyAvailability';
export { visibleRange, visibleDays, shiftAnchor, dayKey, dayStart, addDays, durationAtDelta, timeAt } from './schedule-placement.mjs';
export { dayOverrideOf, planSchedule } from './schedule-planner.mjs';
export { timeboxEvent, timeboxPolicies } from './timebox-policy.mjs';
export type { TimeboxEvent, TimeboxPolicy } from './timebox-policy.mjs';
export type {
  ScheduleDayLoad, ScheduleKeptTask, SchedulePlan, SchedulePlanEvent, SchedulePlannerOptions, SchedulePlanTask,
  ScheduleProposal, ScheduleUnscheduledReason, ScheduleUnscheduledTask, ScheduleWorkingHours,
} from './schedule-planner.mjs';
