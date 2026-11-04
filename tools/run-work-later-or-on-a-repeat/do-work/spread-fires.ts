// parts/timed-action/do-work/spread-fires.ts
//
// Purpose: spread scheduled fires so many stores do not all run at :00, without ever making a time a person pinned late.
// A recurring occurrence slips later by a share of its own interval (capped); a one-off fire that lands on a round
// minute moves only earlier, by a few seconds (never before its record was created). The offset comes from the row's
// own id, so the same row has the same offset on every wake and after every restart.
//
// Non-Negotiable Invariants:
//   1. Pure: nothing reads a clock or random; the offset is the BLAKE3 hash of the id, so a replayed wake answers the same.
//   2. Every number is the caller's `spread` config (src/scheduler.json `spread`); with none, nothing moves.
//   3. A recurring occurrence only moves later and by at most `recurring_cap_seconds`; a one-off moves only earlier, only
//      from a minute divisible by `one_shot_minute_mod`, and never before `created_at_ms`.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { blake3 } from '@noble/hashes/blake3.js';

export interface SpreadConfig {
  readonly recurring_frac: number;
  readonly recurring_cap_seconds: number;
  readonly one_shot_minute_mod: number;
  readonly one_shot_floor_seconds: number;
  readonly one_shot_max_seconds: number;
}

const MS_PER_MINUTE = 60_000;
const UNIT_MINUTES = { minute: 1, hour: 60, day: 1440, week: 10_080 } as const;

/** A number in [0, 1) that is the same for the same id on every wake. */
export function fractionOf(id: string): number {
  const bytes = blake3(new TextEncoder().encode(String(id)));
  return (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0) / 2 ** 32;
}

/** The length of a schedule's step in milliseconds, from its cadence. */
export function intervalMsOf(cadence: { unit?: string; interval?: number } | undefined): number {
  const unit = UNIT_MINUTES[cadence?.unit as keyof typeof UNIT_MINUTES];
  return unit ? unit * (cadence?.interval ?? 1) * MS_PER_MINUTE : 0;
}

/** A recurring occurrence's start moved later by frac(id) x recurring_frac x interval, at most the cap. */
export function spreadRecurringStart(startMs: number, id: string, intervalMs: number, config?: SpreadConfig | null): number {
  if (!config || !(intervalMs > 0)) return startMs;
  return startMs + Math.floor(Math.min(fractionOf(id) * config.recurring_frac * intervalMs, config.recurring_cap_seconds * 1000));
}

/** A one-off due time moved only earlier when it sits on a minute divisible by one_shot_minute_mod; never before creation. */
export function spreadOneShotDue(dueMs: number, id: string, createdAtMs: number | null, config?: SpreadConfig | null): number {
  if (!config || !(config.one_shot_minute_mod > 0) || dueMs % MS_PER_MINUTE !== 0) return dueMs;
  if (Math.floor(dueMs / MS_PER_MINUTE) % config.one_shot_minute_mod !== 0) return dueMs;
  const early = (config.one_shot_floor_seconds + fractionOf(id) * (config.one_shot_max_seconds - config.one_shot_floor_seconds)) * 1000;
  const moved = dueMs - Math.floor(early);
  return createdAtMs != null && moved < createdAtMs ? dueMs : moved;
}
