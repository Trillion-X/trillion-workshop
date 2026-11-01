import type { Rgba } from './look-scheme.mjs';

export { colourOf, contrast, screenLookScheme, type Rgba } from './look-scheme.mjs';

export type LookMoment = { clock: string } | { anchor: string; minutes?: number };
export type LookPoint = { at: LookMoment; look: string };
/** A hold keeps the screen still: `worn` wears the look the person picked (from `since`), `frozen` keeps the look the
 *  plan showed at `at`. It ends at `until`, or, left out, at the plan's next point after it began. */
export type LookHold = { kind: 'worn'; since: string; until?: string } | { kind: 'frozen'; at: string; until?: string };
export type LookPlace = { latitude: number; longitude: number };
export type LookPlan = {
  on: boolean;
  points: LookPoint[];
  place?: LookPlace | null;
  time_zone?: string | null;
  hold?: LookHold | null;
  preset?: string | null;
};
export type LookPreset = { id: string; label: string; about: string; points: LookPoint[] };
/** Which looks a screen is between now and how far along it is, with the last and next points and any active hold. */
export type LookNow = { from: string; to: string; t: number; since: Date; next: Date; held: LookHold | null };
export type LookOverTimeSettings = {
  record_key: string;
  most_points: number;
  repaint_every_ms: number;
  keep_readable: { ground: string; least_contrast: number };
  anchors: { id: string; label: string; sun: { altitude: number; side: 'rising' | 'setting' } }[];
  presets: LookPreset[];
};

export function deviceZone(): string;
export function startOfDay(instant: number, zone: string): number;
export function isTimeZone(zone: unknown): zone is string;
export function sunCrossing(aroundMs: number, place: LookPlace, altitude: number, side: 'rising' | 'setting'): number | null;
export function lookAtTime(plan: LookPlan | null | undefined, now: Date, deviceZone: string, settings: LookOverTimeSettings): LookNow | null;
export function holdEnds(plan: LookPlan, hold: LookHold, deviceZone: string, settings: LookOverTimeSettings): number;
export function nextPointAfter(plan: LookPlan | null | undefined, now: Date, deviceZone: string, settings: LookOverTimeSettings): Date | null;
export function readLookPlan(value: unknown, settings: LookOverTimeSettings): LookPlan | null;
export function changeLookPlan(current: LookPlan | null, change: Record<string, unknown>, looks: readonly string[], settings: LookOverTimeSettings): LookPlan;
export function sayLookPlan(plan: LookPlan | null, nameOf: (id: string) => string, settings: LookOverTimeSettings): string;
export function blendValue(a: string, b: string, t: number): string;
export const over: (foreground: Rgba, ground: Rgba) => Rgba;
export function blendLookValues(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>, t: number, settings: LookOverTimeSettings): Record<string, string>;
