export interface DescribedInterval { start_minute: number; end_minute: number }
export interface DescribedDay { weekday: number; intervals: DescribedInterval[] }
export interface DescriptionIssue {
  code: 'empty' | 'no_times' | 'unreadable_times' | 'no_days' | 'break_without_hours';
  text: string;
}
export function readScheduleDescription(description: string): { days: DescribedDay[]; issues: DescriptionIssue[] };
export const defaultBreakMinutes: number;
export function carveBreak(intervals: DescribedInterval[], minutes?: number, snap?: number): DescribedInterval[];
