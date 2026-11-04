// packages/group/read-data/board-time-log.ts
//
// The TIME-LOG primitive (pure leaf): a history of work sessions on a board item — the EFFORT axis the
// board did not have. Each session is {startMs, durationMs}; the log reduces to total time, session
// count, last-worked recency, time in a trailing window, average session size, and effort rankings. It
// composes with the metric primitive into velocity (progress per hour) WITHOUT inventing a new goal
// engine (L069). Physics only: finite-number arithmetic over completed sessions, no clock (`now` is
// injected wherever recency matters). Fail-closed: any malformed raw normalizes to an empty log, never
// throws. Start/stop timers are NOT the leaf's concern — the leaf only ever sees COMPLETED sessions; a
// pending live timer lives in the bridge/UI and appends a completed session on stop.

/** One completed work session: when it started + how long it lasted (both ms). */
export interface TimeSession {
  readonly startMs: number;
  readonly durationMs: number;
}

export type TimeLog = readonly TimeSession[];

const EMPTY_LOG: TimeLog = [];
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000; // ECMAScript Date valid range — a startMs beyond it is not a real instant.
// A single session's duration is bounded so that MAX_SESSIONS * MAX_DURATION_MS stays < Number.MAX_SAFE_INTEGER
// (9.007e15) — otherwise a couple of `durationMs: Number.MAX_VALUE` sessions overflow totalDurationMs to Infinity,
// which then poisons averageSessionMs and formatDuration. 4e12 ms ≈ 127 years — no real work session approaches it.
const MAX_DURATION_MS = 4_000_000_000_000;
/** Max sessions kept from one item's `extra.timeLog` — a guardrail against a paste-bombed/corrupted persisted
 *  value (an uncapped million-entry array is filtered + sorted every read, per item, in the effort rollups). */
const MAX_SESSIONS = 2048;
/** Hard scan bound so an all-junk bomb (which never fills the keep cap) is still O(1) work. */
const MAX_SESSION_SCAN = 16384;

const isBoundedPosInt = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;

function isSession(v: unknown): v is TimeSession {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return isBoundedPosInt(o.startMs, MAX_TIMESTAMP_MS) && isBoundedPosInt(o.durationMs, MAX_DURATION_MS);
}

/**
 * Fail-closed normalizer: keep only well-formed sessions (bounded positive-integer start + duration), capped
 * and sorted ascending by start. Non-array → empty. The magnitude bound keeps `totalDurationMs` finite (no
 * Infinity overflow), and the count/scan caps keep the read O(1)-bounded. Self-describing DATA + generic reader (L090).
 */
export function timeLogFromRaw(raw: unknown): TimeLog {
  if (!Array.isArray(raw)) return EMPTY_LOG;
  const kept: TimeSession[] = [];
  const scanEnd = Math.min(raw.length, MAX_SESSION_SCAN);
  for (let i = 0; i < scanEnd && kept.length < MAX_SESSIONS; i += 1) {
    const s = raw[i];
    if (isSession(s)) kept.push({ startMs: s.startMs, durationMs: s.durationMs });
  }
  return kept.sort((a, b) => a.startMs - b.startMs);
}

/** Total time logged across every session. */
export function totalDurationMs(log: TimeLog): number {
  return log.reduce((sum, s) => sum + s.durationMs, 0);
}

/** How many sessions have been logged. */
export function sessionCount(log: TimeLog): number {
  return log.length;
}

/** When work most recently ENDED (start + duration of the latest-starting session), or null if none. */
export function lastWorkedAtMs(log: TimeLog): number | null {
  if (log.length === 0) return null;
  const latest = log[log.length - 1]; // sorted ascending by start
  return latest.startMs + latest.durationMs;
}

/** Time logged in the trailing window ending at `now` (sessions that STARTED within [now-windowMs, now]). */
export function timeInWindowMs(log: TimeLog, now: number, windowMs: number): number {
  const floor = now - windowMs;
  return log.reduce((sum, s) => (s.startMs >= floor && s.startMs <= now ? sum + s.durationMs : sum), 0);
}

/** Mean session length (0 when there are no sessions). */
export function averageSessionMs(log: TimeLog): number {
  return log.length === 0 ? 0 : Math.round(totalDurationMs(log) / log.length);
}

/**
 * Human duration: "2h 30m" / "45m" / "3h" / "0m" (minute granularity — work sessions, not stopwatch).
 * Deterministic + clock-free.
 */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** Progress-per-hour velocity: `progressedUnits / totalHours`, or null when there is no time logged. */
export function progressPerHour(progressedUnits: number, totalMs: number): number | null {
  if (totalMs <= 0) return null;
  return progressedUnits / (totalMs / 3_600_000);
}

/** A row for ranking items by an effort measure. */
export interface TimeRow<T> {
  readonly item: T;
  readonly log: TimeLog;
  readonly ms: number;
}

/** Rank items by TOTAL time invested (most first). Items with no sessions are excluded. */
export function rankByTotalTime<T>(items: readonly T[], logOf: (item: T) => TimeLog): TimeRow<T>[] {
  const rows: TimeRow<T>[] = [];
  items.forEach((item) => {
    const log = logOf(item);
    const ms = totalDurationMs(log);
    if (ms > 0) rows.push({ item, log, ms });
  });
  return rows.sort((a, b) => b.ms - a.ms);
}

/** Rank items by RECENT time (in the trailing window, most first). Zero-in-window items are excluded. */
export function rankByRecentTime<T>(items: readonly T[], logOf: (item: T) => TimeLog, now: number, windowMs: number): TimeRow<T>[] {
  const rows: TimeRow<T>[] = [];
  items.forEach((item) => {
    const log = logOf(item);
    const ms = timeInWindowMs(log, now, windowMs);
    if (ms > 0) rows.push({ item, log, ms });
  });
  return rows.sort((a, b) => b.ms - a.ms);
}
