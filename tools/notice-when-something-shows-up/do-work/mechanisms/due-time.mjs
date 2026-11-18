#!/usr/bin/env node
/**
 * tools/notice-when-something-shows-up/do-work/mechanisms/due-time.mjs
 *
 * Purpose
 *   One waiting mechanism: wait for what timed-action says is due, and report
 *   each due occurrence when it comes. When something is due is timed-action's
 *   alone (tools/run-work-later-or-on-a-repeat `whenToWake`: recurring schedules
 *   by minute, hour, day or week in any IANA zone with their own clock-change
 *   rule, one-off actions with their time windows, fleet spread). This leaf only
 *   asks it, waits until the time it names, and tells what came due. It replaces
 *   the engine's own time wakes (trillion-rust src/wake.rs `On::Time`, T4.3, then
 *   T4.7): time is one more thing the noticer notices.
 *
 * Settings (a waiter row's mechanism_settings): timed-action's own DATA, as its
 * rows are written for tool:when-to-run-next.
 *   { schedules?, time_windows?, actions?, spread?, retry_seconds? }
 *   - schedules: RecurringWindowSchedule rows. A wake hears one with a fact
 *     wake {kind: <the waiter's change_kind>, match: {schedule_id}}.
 *   - time_windows, actions: one-off actions; heard by match {record_id}.
 *   - retry_seconds: how long to wait before asking again after a fact the
 *     engine did not take (60 when left out). The occurrence stays due meanwhile.
 *
 * Non-negotiable invariants
 *   - Exactly once. Each occurrence is told under its own event key (timed-
 *     action's occurrence key; a one-off's record and operation), and the engine
 *     admits one fact per key (src/wake.rs `fact`, its marker), so telling it
 *     again after a restart is never a second run.
 *   - An occurrence counts as done only once the engine took its fact: the fact
 *     is timed-action's owner proof. A refused tell leaves it due.
 *   - A schedule first seen starts at its first time from now (timed-action
 *     `resume_from_ms`, set when the waiter first runs), never catching up on
 *     every time since its start_local_date.
 *   - The state stays bounded however long a schedule runs: per schedule, only
 *     the proof of its last told occurrence and resume_from_ms at that
 *     occurrence's start; per one-off, only the receipts of actions still named.
 *
 * Security
 *   No credential, no network, no filesystem access. Hostile settings can only
 *   change when it tells; timed-action refuses a schedule it cannot read
 *   (rejected_schedules), said on standard error.
 */
import { whenToWake } from "../../../run-work-later-or-on-a-repeat/do-work/when-to-wake.ts";

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::due-time";

/** The longest one wait may be: what a timer holds (2^31 - 1 ms). A longer wait is several. */
const LONGEST_WAIT_MS = 2_147_483_647;
const PROOF_OWNER = "notice-when-something-shows-up";

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: ["schedule_id", "start", "end", "record_id", "operation"],
    conditions: ["became-reachable"],
  };
}

/** The settings as timed-action's input parts, or null when they name nothing to wait for. */
export function readSettings(settings = {}) {
  const rows = (value) => (Array.isArray(value) ? value : []);
  const schedules = rows(settings.schedules);
  const actions = rows(settings.actions);
  if (schedules.length === 0 && actions.length === 0) return null;
  const retry = Number(settings.retry_seconds);
  return {
    schedules,
    time_windows: rows(settings.time_windows),
    actions,
    spread: settings.spread ?? null,
    retry_ms: (Number.isFinite(retry) && retry > 0 ? retry : 60) * 1000,
  };
}

/** One question to timed-action for each schedule (each keeps its own resume point) and one for the one-off actions. */
export function dueAt(rule, state, nowMs) {
  const asked = rule.schedules.map((schedule) => {
    const kept = state.schedules[schedule.schedule_id] ?? { resume_from_ms: state.first_seen_ms, proofs: [] };
    return whenToWake({ now: nowMs, schedules: [schedule], occurrence_states: kept.proofs, resume_from_ms: kept.resume_from_ms, spread: rule.spread });
  });
  if (rule.actions.length > 0) {
    asked.push(whenToWake({ now: nowMs, time_windows: rule.time_windows, actions: rule.actions, receipts: state.receipts, spread: rule.spread }));
  }
  const next = asked.map((answer) => answer.next_wake_at).filter(Boolean).map((at) => Date.parse(at));
  return {
    recurring: asked.flatMap((answer) => answer.recurring_due),
    oneOff: asked.flatMap((answer) => answer.scheduled_due),
    rejected: asked.flatMap((answer) => answer.rejected_schedules),
    next_ms: next.length > 0 ? Math.min(...next) : null,
  };
}

/** The state after `occurrence` was told: its proof alone, and the resume point at its start. */
function provenRecurring(state, occurrence, observedAt, eventKey) {
  const start = Date.parse(occurrence.start);
  const proof = { occurrence_key: occurrence.occurrence_key, materialization_key: occurrence.occurrence_key, materialized_at: observedAt,
    owner_outcome: { proven: true, owner_ref: PROOF_OWNER, proof_ref: eventKey, observed_at: observedAt } };
  // Everything starting before it now counts as passed (resume_from_ms), so its proof is the only one kept; a fold told
  // as both instants keeps the later one due, since it starts after.
  return { ...state, schedules: { ...state.schedules, [occurrence.schedule_id]: { resume_from_ms: start, proofs: [proof] } } };
}

/** The state after a one-off was told: its receipt, and only the receipts of actions the settings still name. */
function provenOneOff(state, rule, fire) {
  const named = new Set(rule.actions.map((action) => action?.record_id));
  const receipts = [...state.receipts, { record_id: fire.record_id, operation: fire.operation }].filter((receipt) => named.has(receipt.record_id));
  return { ...state, receipts };
}

/**
 * Wait for each due occurrence and report it.
 *
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers
 * @param {(transition:object)=>Promise<boolean|void>} handlers.onTransition called once per due occurrence; its
 *   `event_key` names the occurrence, its `state` is what this waiter keeps once told; it answers false when not told
 * @param {AbortSignal} handlers.signal stops the wait
 * @param {object|null} [handlers.state] what this waiter kept last, null the first time
 * @param {(state:object)=>Promise<void>} [handlers.keepState] keep `state` without telling anything
 * @param {()=>number} [handlers.nowMs] injected clock, for tests
 * @param {(ms:number, signal:AbortSignal)=>Promise<void>} [handlers.sleep] injected sleep, for tests
 * @param {(line:string)=>void} [handlers.say] where a rejected schedule is said (standard error)
 */
export async function watchForTransitions(settings, handlers) {
  const rule = readSettings(settings);
  if (rule === null) throw new Error("due-time settings name no schedules and no actions (timed-action's own rows)");
  const nowMs = handlers.nowMs ?? (() => Date.now());
  const sleep = handlers.sleep ?? defaultSleep;
  const signal = handlers.signal;
  const keepState = handlers.keepState ?? (async () => {});
  const say = handlers.say ?? ((line) => console.error(line));
  let state = handlers.state ?? null;
  if (state === null || !Number.isFinite(state.first_seen_ms)) {
    state = { first_seen_ms: nowMs(), schedules: {}, receipts: [] };
    await keepState(state);
  }
  const said = new Set();

  while (!signal?.aborted) {
    const now = nowMs();
    const due = dueAt(rule, state, now);
    for (const rejected of due.rejected) {
      const line = `due-time: timed-action refused schedule ${rejected.schedule_id}: ${rejected.reason}`;
      if (!said.has(line)) say(line);
      said.add(line);
    }
    let refused = false;
    const observedAt = new Date(now).toISOString();
    for (const occurrence of due.recurring) {
      if (signal?.aborted) return;
      const eventKey = occurrence.occurrence_key;
      const next = provenRecurring(state, occurrence, observedAt, eventKey);
      const told = await handlers.onTransition({ condition: "became-reachable", observed_identity: {}, event_key: eventKey, state: next,
        detail: { schedule_id: occurrence.schedule_id, start: occurrence.start, end: occurrence.end, record_id: null, operation: null } });
      if (told === false) refused = true;
      else state = next;
    }
    for (const fire of due.oneOff) {
      if (signal?.aborted) return;
      const eventKey = `${fire.record_id}#${fire.operation}`;
      const next = provenOneOff(state, rule, fire);
      const told = await handlers.onTransition({ condition: "became-reachable", observed_identity: {}, event_key: eventKey, state: next,
        detail: { schedule_id: null, start: fire.due_at ?? null, end: null, record_id: fire.record_id, operation: fire.operation } });
      if (told === false) refused = true;
      else state = next;
    }
    if (due.recurring.length + due.oneOff.length > 0 && !refused) continue; // what was told may have made the next due
    const until = refused ? now + rule.retry_ms : due.next_ms;
    await waitUntil(until, { nowMs, sleep, signal });
  }
}

async function waitUntil(until, { nowMs, sleep, signal }) {
  if (until === null) {
    while (!signal?.aborted) await sleep(LONGEST_WAIT_MS, signal);
    return;
  }
  for (let left = until - nowMs(); left > 0 && !signal?.aborted; left = until - nowMs()) {
    await sleep(Math.min(left, LONGEST_WAIT_MS), signal);
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
