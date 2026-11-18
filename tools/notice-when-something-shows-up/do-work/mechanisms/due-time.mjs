#!/usr/bin/env node
/**
 * tools/notice-when-something-shows-up/do-work/mechanisms/due-time.mjs
 *
 * Purpose
 *   One waiting mechanism: wait for a due time (once at an instant, or a repeat
 *   of fixed steps or of wall-clock time in a zone) and report it when it comes.
 *   It replaces the engine's own time wakes (trillion-rust src/wake.rs
 *   `On::Time` and `Repeat`, T4.3 then T4.7): time is one more thing the noticer
 *   notices, and a tool hears it as a fact like any other.
 *
 * Non-negotiable invariants (each matches a wake time test)
 *   - Exactly once. Each due time is told under its own event key (its instant),
 *     and the engine admits one fact per key (src/wake.rs `fact`, its marker), so
 *     a restart that tells a due time again is never a second run.
 *   - A missed repeat fires once. After a sleep, only the newest due time is
 *     told, with `missed`: how many due times before it were slept through
 *     (wake test a_missed_repeat_fires_once_on_wake).
 *   - A new repeat starts at its first due time from now: due times before it
 *     was first seen are never told. That first due time is kept (keepState)
 *     before anything is told, so a restart before it still tells it.
 *   - In a zone (an IANA name), the kth due time is the anchor's wall-clock time
 *     moved k steps of wall-clock time, so "Monday 9 AM" stays 9 AM local across
 *     a change of offset (wake test a_repeat_in_a_time_zone_keeps_its_wall_clock_time).
 *     A wall time the zone skips is the first minute after the gap; one it
 *     repeats is its earlier instant (tools/wall-time `next-valid`, `earlier`).
 *   - A once-at time is told once and then never again (state `done`).
 *   - A zone that is not one, a step of zero, or a zone on a once-at time is
 *     refused, never read as UTC.
 *
 * Settings (a waiter row's mechanism_settings)
 *   { at_ms }                       once, at this instant (ms since the epoch)
 *   { every_ms, from_ms?, zone? }   a repeat: due at from_ms + k * every_ms
 *                                   (from_ms 0 when left out), in zone's wall
 *                                   clock when it names one
 *
 * Security
 *   No credential, no network, no filesystem access. Hostile settings can only
 *   change when it tells.
 */
import { partsAt, possibleInstants, resolveStart, timeZoneName } from "../../../wall-time/read-data/wall-time.mjs";

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::due-time";

/** The longest one wait may be: what a timer holds (2^31 - 1 ms). A longer wait is several. */
const LONGEST_WAIT_MS = 2_147_483_647;
const MINUTE_MS = 60_000;

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: ["due_ms", "missed"],
    conditions: ["became-reachable"],
  };
}

/** The settings as a due-time rule, or null when they are not one. */
export function readSettings(settings = {}) {
  const whole = (value) => Number.isSafeInteger(value) && value >= 0;
  if (settings.at_ms !== undefined) {
    if (!whole(settings.at_ms) || settings.every_ms !== undefined || settings.zone !== undefined) return null;
    return { at_ms: settings.at_ms };
  }
  if (!whole(settings.every_ms) || settings.every_ms === 0) return null;
  const from = settings.from_ms ?? 0;
  if (!whole(from)) return null;
  if (settings.zone === undefined) return { every_ms: settings.every_ms, from_ms: from, zone: null };
  const zone = timeZoneName(settings.zone);
  return zone === null ? null : { every_ms: settings.every_ms, from_ms: from, zone };
}

/** A civil wall-clock time as ms of a clock with no zone: what `Date.UTC` of its fields gives. */
function civilOf(instantMs, zone) {
  const parts = partsAt(instantMs, zone);
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)) + (((instantMs % 1000) + 1000) % 1000);
}

/** The instant of civil ms `civil` in `zone`: a skipped minute moves to the first one after the gap, a repeated one
 *  takes its earlier instant; the part below the minute is carried as it is. */
function instantOf(civil, zone) {
  const minute = Math.floor(civil / MINUTE_MS) * MINUTE_MS;
  const at = new Date(minute).toISOString();
  const requested = { date: at.slice(0, 10), time: at.slice(11, 16) };
  const exact = possibleInstants(requested, zone);
  const resolved = exact.length > 0 ? exact[0] : resolveStart(requested, zone, "next-valid", "earlier")[0]?.instant_ms;
  return resolved === undefined ? Number.MAX_SAFE_INTEGER : resolved + (civil - minute);
}

/** A repeat's due times (src/wake.rs `Repeat`, the same three questions). */
export function repeatOf({ every_ms: every, from_ms: anchor, zone }) {
  const anchorCivil = zone === null ? null : civilOf(anchor, zone);
  const slot = (k) => {
    const moved = k * every;
    if (!Number.isSafeInteger(moved)) return Number.MAX_SAFE_INTEGER;
    return zone === null ? anchor + moved : instantOf(anchorCivil + moved, zone);
  };
  /** The index of the newest due time at or before `now`; null before the first. Fixed steps, then moved by the few
   *  due times a change of offset shifts. */
  const lastAtOrBefore = (now) => {
    if (now < slot(0)) return null;
    let k = Math.floor(Math.max(0, now - anchor) / every);
    while (slot(k + 1) <= now) k += 1;
    while (k > 0 && slot(k) > now) k -= 1;
    return k;
  };
  /** The first due time strictly after `now`. */
  const after = (now) => {
    const k = lastAtOrBefore(now);
    return slot(k === null ? 0 : k + 1);
  };
  return { slot, lastAtOrBefore, after };
}

/**
 * Wait for each due time and report it.
 *
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers
 * @param {(transition:object)=>Promise<boolean|void>} handlers.onTransition called once per due time; its `event_key`
 *   is the due instant, its `state` what this waiter keeps with it once told; it answers false when the fact was not told
 * @param {AbortSignal} handlers.signal stops the wait
 * @param {object|null} [handlers.state] what this waiter kept last (the carrier's kept folder), null the first time
 * @param {(state:object)=>Promise<void>} [handlers.keepState] keep `state` without telling anything
 * @param {()=>number} [handlers.nowMs] injected clock, for tests
 * @param {(ms:number, signal:AbortSignal)=>Promise<void>} [handlers.sleep] injected sleep, for tests
 */
export async function watchForTransitions(settings, handlers) {
  const rule = readSettings(settings);
  if (rule === null) throw new Error("due-time settings must be {at_ms} or {every_ms, from_ms?, zone?} with a zone the runtime knows");
  const nowMs = handlers.nowMs ?? (() => Date.now());
  const sleep = handlers.sleep ?? defaultSleep;
  const signal = handlers.signal;
  const keepState = handlers.keepState ?? (async () => {});
  let state = handlers.state ?? null;

  const waitUntil = async (due) => {
    for (let left = due - nowMs(); left > 0 && !signal?.aborted; left = due - nowMs()) {
      await sleep(Math.min(left, LONGEST_WAIT_MS), signal);
    }
  };
  const tell = (due, missed, kept) => handlers.onTransition({
    condition: "became-reachable",
    observed_identity: {},
    detail: { due_ms: due, missed },
    event_key: String(due),
    state: kept,
  });

  if ("at_ms" in rule) {
    // A refused tell keeps nothing, so the next start of this waiter tells it again.
    if (state?.done === true && state.due_ms === rule.at_ms) return;
    await waitUntil(rule.at_ms);
    if (signal?.aborted) return;
    await tell(rule.at_ms, 0, { done: true, due_ms: rule.at_ms });
    return;
  }

  const repeat = repeatOf(rule);
  let next = Number.isSafeInteger(state?.next_ms) ? state.next_ms : null;
  if (next === null) {
    // A new repeat starts at its first due time from now, kept before anything is told.
    next = repeat.after(nowMs() - 1);
    state = { next_ms: next };
    await keepState(state);
  }
  // `next` is the first due time not yet told; `until` is when to look again (later than `next` after a refused tell,
  // so the refused due time is counted as missed by the next one told, and kept to be told again after a restart).
  let until = next;
  while (!signal?.aborted) {
    await waitUntil(until);
    if (signal?.aborted) return;
    // The newest due time fires once; the due times slept through are counted, never each told.
    const newest = repeat.lastAtOrBefore(nowMs()) ?? 0;
    const missed = Math.max(0, newest - (repeat.lastAtOrBefore(next) ?? 0));
    const following = repeat.slot(newest + 1);
    const told = await tell(repeat.slot(newest), missed, { next_ms: following });
    if (told !== false) next = following;
    until = following;
  }
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
