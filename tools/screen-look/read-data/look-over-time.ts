// Compatibility exports for Trillion's account tool, screens and data readers.
// Workshop owns the schedule algorithms; the calling app supplies its own plan DATA here.

import settings from '../look-over-time.json' with { type: 'json' };
import {
  blendLookValues as sharedBlendLookValues,
  changeLookPlan as sharedChangeLookPlan,
  deviceZone,
  holdEnds as sharedHoldEnds,
  isTimeZone,
  lookAtTime as sharedLookAtTime,
  nextPointAfter as sharedNextPointAfter,
  over,
  readLookPlan as sharedReadLookPlan,
  sayLookPlan as sharedSayLookPlan,
  screenLookScheme,
  startOfDay,
  sunCrossing,
  blendValue,
  colourOf,
  contrast,
  type LookHold,
  type LookMoment,
  type LookNow,
  type LookOverTimeSettings,
  type LookPlan,
  type LookPlace,
  type LookPoint,
  type LookPreset,
  type Rgba,
} from 'trillion-workshop/tools/screen-looks/read-data/look-over-time.mjs';

export {
  blendValue,
  colourOf,
  contrast,
  deviceZone,
  isTimeZone,
  over,
  screenLookScheme,
  startOfDay,
  sunCrossing,
};
export type { LookHold, LookMoment, LookNow, LookPlan, LookPlace, LookPoint, LookPreset, Rgba };

export const LOOK_OVER_TIME = settings as LookOverTimeSettings;
export const LOOK_PLAN_RECORD = LOOK_OVER_TIME.record_key;

export function lookAtTime(plan: LookPlan | null | undefined, now: Date, deviceZoneName: string): LookNow | null {
  return sharedLookAtTime(plan, now, deviceZoneName, LOOK_OVER_TIME);
}

export function holdEnds(plan: LookPlan, hold: LookHold, deviceZoneName: string): number {
  return sharedHoldEnds(plan, hold, deviceZoneName, LOOK_OVER_TIME);
}

export function nextPointAfter(plan: LookPlan | null | undefined, now: Date, deviceZoneName: string): Date | null {
  return sharedNextPointAfter(plan, now, deviceZoneName, LOOK_OVER_TIME);
}

export function readLookPlan(value: unknown): LookPlan | null {
  return sharedReadLookPlan(value, LOOK_OVER_TIME);
}

export function changeLookPlan(current: LookPlan | null, change: Record<string, unknown>, looks: readonly string[]): LookPlan {
  return sharedChangeLookPlan(current, change, looks, LOOK_OVER_TIME);
}

export function sayLookPlan(plan: LookPlan | null, nameOf: (id: string) => string): string {
  return sharedSayLookPlan(plan, nameOf, LOOK_OVER_TIME);
}

export function blendLookValues(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>, t: number): Record<string, string> {
  return sharedBlendLookValues(a, b, t, LOOK_OVER_TIME);
}
