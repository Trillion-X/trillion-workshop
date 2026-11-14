export interface ReminderData {
  max: number;
  max_minutes: number;
  at_start: string;
  before: string;
  presets: { minutes: number }[];
  units: { id: string; minutes: number; one: string; other: string }[];
}
export function minutesOf(amount: string | number, unitId: string, data: ReminderData): number | null;
export function withReminder(list: readonly number[], minutes: number, data: ReminderData): number[] | null;
export function withoutReminder(list: readonly number[], minutes: number): number[];
export function reminderLabel(minutes: number, data: ReminderData): string;
export function reminderOverrides(list: readonly number[]): { useDefault: false; overrides: { method: 'popup'; minutes: number }[] };
