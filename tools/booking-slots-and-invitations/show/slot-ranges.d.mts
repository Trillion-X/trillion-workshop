export interface SlotRange { id: string; startAt: string; endAt: string }
export interface SlotWindow { weekday: number; start: string; end: string }
export interface SlotOneOff { start_ms: number; end_ms: number }
export function mergeRanges<T extends SlotRange>(ranges: T[]): T[];
export function addRange(ranges: SlotRange[], range: { startAt: string; endAt: string }): SlotRange[];
export function rangesToWindows(ranges: SlotRange[], timezone: string): SlotWindow[];
export function rangesToOneOffs(ranges: SlotRange[], durationMin: number): SlotOneOff[];
export function oneOffsToWindows(slots: SlotOneOff[], timezone: string): SlotWindow[];
export function scheduleToRanges(schedule: { days: { weekday: number; intervals: { start_minute: number; end_minute: number }[] }[] },
  dayKeys: string[], weekdayOf: (key: string) => number, at: (key: string, minute: number) => string): SlotRange[];
