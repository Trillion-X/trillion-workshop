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
 *   - from_wakes: {kind}: also watch what each switched-on wake that hears facts
 *     of `kind` asks for in its `watch` ({schedules?, time_windows?, actions?},
 *     trillion-rust src/wake.rs `On::Fact`), read at the door's wake:list. Each
 *     schedule then lives once, on the row whose wake wants it.
 *   - look_again_seconds: with from_wakes, the longest wait before the wakes are
 *     read again, so a wake switched on later is watched (60 when left out).
 *   - from_rows: {table?, column?}: also watch what each kept workflow row asks
 *     for, read on every pass from the database the waiter's own credential_name
 *     opens: every entry of the row's `column` (default `wakes`, a JSON list, in
 *     `table`, default `workflow_recipes`) that says `switched_on: true` is read as
 *     a listening wake, its `on.fact.watch` watched. So a kept workflow's times
 *     live once, on its own row: a row switched on, changed or taken away is
 *     watched, rewatched or let go at the next look, with no hand-kept list.
 *     A row that is no list, or an entry with no watch, names nothing.
 *     from_rows also takes {computer?, unplaced?}. An entry of a kept row may name
 *     `computer`, the plain id of the computer it runs on (1 to 64 letters, digits,
 *     `-` and `_`). Each computer's waiter says its own id in `computer` and watches
 *     only the entries that name it. An entry that names no computer is unplaced:
 *     it goes to the waiters that say `unplaced: true`, which is the default for a
 *     waiter that names no computer (and false for one that does). So every
 *     existing row and waiter keeps working with no change, and a waiter that
 *     names no computer never fires another computer's entries. An entry whose
 *     `computer` is not a string matches no waiter and is named once on standard
 *     error. Why the choice is made in this one reader: the engine's admit-once
 *     marker is per computer, so an occurrence told on two computers would run
 *     twice; each entry must be told on exactly one. No computer id is written
 *     in this file: every id comes from the waiter's own input.
 *
 * Non-negotiable invariants
 *   - Exactly once. Each occurrence is told under its own event key (timed-
 *     action's occurrence key; a one-off's record and operation), and the engine
 *     admits one fact per key (src/wake.rs `fact`, its marker), so telling it
 *     again after a restart is never a second run.
 *   - An occurrence counts as done only once the engine took its fact: the fact
 *     is timed-action's owner proof. A refused tell leaves it due.
 *   - A schedule first seen starts at its first time from now (timed-action
 *     `resume_from_ms`, set when the leaf first sees that schedule, so one a
 *     wake switched on later starts then), never catching up on every time
 *     since its start_local_date.
 *   - A schedule asleep through many of its times is told once on waking, for its latest time, with how many it
 *     passed over (`missed_before`, timed-action's own count), never once for every time it missed.
 *   - The state stays bounded however long a schedule runs: per schedule, only
 *     the proof of its last told occurrence and resume_from_ms at that
 *     occurrence's start; per one-off, only the receipts of actions still named.
 *
 * Security
 *   No credential, no network, no filesystem access, but with from_rows: then
 *   one read-only SELECT of the named table over the waiter's own credential,
 *   through the run's proxy (row-changes.mjs `clientOptions`); the table and
 *   column are plain names checked before use, and the computer id is a query parameter, never text put in the query. Hostile settings can only
 *   change when it tells; timed-action refuses a schedule it cannot read
 *   (rejected_schedules), said on standard error.
 */
import { whenToWake } from "../../../run-work-later-or-on-a-repeat/do-work/timed-action.mjs";
import { clientOptions } from "./row-changes.mjs";
import { readGivenCredential } from "./given-credential.mjs";

async function connectWithPg(connection) {
  const { default: pg } = await import("pg");
  const client = new pg.Client(await clientOptions(connection));
  await client.connect();
  return client;
}

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::due-time";

/** The longest one wait may be: what a timer holds (2^31 - 1 ms). A longer wait is several. */
const LONGEST_WAIT_MS = 2_147_483_647;
const PROOF_OWNER = "notice-when-something-shows-up";

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: ["schedule_id", "start", "end", "missed_before", "missed_since", "record_id", "operation"],
    conditions: ["became-reachable"],
  };
}

const rows = (value) => (Array.isArray(value) ? value : []);
const seconds = (value, otherwise) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : otherwise) * 1000;

/** The settings as timed-action's input parts, or null when they name nothing to wait for. */
export function readSettings(settings = {}) {
  const schedules = rows(settings.schedules);
  const actions = rows(settings.actions);
  const fromWakes = typeof settings.from_wakes?.kind === "string" && settings.from_wakes.kind !== "" ? settings.from_wakes.kind : null;
  const fromRows = rowsSource(settings.from_rows);
  if (schedules.length === 0 && actions.length === 0 && fromWakes === null && fromRows === null) return null;
  return {
    schedules,
    time_windows: rows(settings.time_windows),
    actions,
    spread: settings.spread ?? null,
    retry_ms: seconds(settings.retry_seconds, 60),
    from_wakes: fromWakes,
    from_rows: fromRows,
    look_again_ms: seconds(settings.look_again_seconds, 60),
  };
}

/** A plain SQL name: lower-case letters, digits and `_`, not starting with a digit. */
const PLAIN_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** A computer id: letters, digits, `-` and `_`, 1 to 64 characters. */
const PLAIN_COMPUTER = /^[A-Za-z0-9_-]{1,64}$/;

/** `from_rows` as {table, column, computer, unplaced}, or null when it is not asked for; a name, computer or flag that is
 *  not plain refuses the settings. A waiter that names no computer takes the unplaced entries unless it says otherwise. */
export function rowsSource(value) {
  if (value === undefined || value === null || value === false) return null;
  const table = value?.table ?? "workflow_recipes";
  const column = value?.column ?? "wakes";
  if (!PLAIN_NAME.test(table) || !PLAIN_NAME.test(column)) throw new Error(`due-time from_rows names a table or column that is not a plain name: ${table}.${column}`);
  const computer = value?.computer ?? null;
  if (computer !== null && (typeof computer !== "string" || !PLAIN_COMPUTER.test(computer))) throw new Error("due-time from_rows names a computer that is not a plain id (1 to 64 letters, digits, - and _)");
  const unplaced = value?.unplaced ?? computer === null;
  if (typeof unplaced !== "boolean") throw new Error("due-time from_rows unplaced is not true or false");
  return { table, column, computer, unplaced };
}

/** The query that reads the switched-on wake entries of the kept rows this waiter watches, one per row of the answer.
 *  $1 is the waiter's computer (null when it names none), $2 whether it takes the entries that name no computer. An
 *  entry whose `computer` is not a string is read with `misplaced` true, so it can be named; it is never watched. */
export const keptWakesSql = ({ table, column }) => `SELECT w AS wake, (w ? 'computer' AND jsonb_typeof(w -> 'computer') <> 'string') AS misplaced
  FROM ${table} r,
  jsonb_array_elements(CASE WHEN jsonb_typeof(r.${column}) = 'array' THEN r.${column} ELSE '[]'::jsonb END) w
  WHERE jsonb_typeof(w) = 'object' AND w ->> 'switched_on' = 'true'
  AND ((w ? 'computer' AND jsonb_typeof(w -> 'computer') <> 'string')
    OR (w ? 'computer' AND w ->> 'computer' = $1) OR (NOT (w ? 'computer') AND $2::boolean))`;

/** The switched-on wake entries of the kept rows this waiter watches, read once through `client` ({query(sql, params) ->
 *  {rows}}). `onMisplaced` hears each entry whose `computer` is not a string; such an entry is not returned. */
export async function keptWakes(client, source, onMisplaced = () => {}) {
  const answer = await client.query(keptWakesSql(source), [source.computer ?? null, source.unplaced]);
  const wakes = [];
  for (const row of answer?.rows ?? []) {
    if (!row.wake || typeof row.wake !== "object") continue;
    if (row.misplaced === true) onMisplaced(row.wake);
    else wakes.push(row.wake);
  }
  return wakes;
}

/** The rule with what the listening wakes ask to be watched (each wake's `watch`) added; a schedule or action two
 *  wakes name the same way is watched once. */
export function withListeners(rule, wakes) {
  const once = (list) => [...new Map(list.map((row) => [JSON.stringify(row), row])).values()];
  const watched = wakes.map((wake) => wake?.on?.fact?.watch ?? {});
  return {
    ...rule,
    schedules: once([...rule.schedules, ...watched.flatMap((watch) => rows(watch.schedules))]),
    time_windows: once([...rule.time_windows, ...watched.flatMap((watch) => rows(watch.time_windows))]),
    actions: once([...rule.actions, ...watched.flatMap((watch) => rows(watch.actions))]),
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
 * @param {(kind:string)=>Promise<object[]>} [handlers.listening] the switched-on wakes that hear facts of a kind
 */
export async function watchForTransitions(settings, handlers) {
  const own = readSettings(settings);
  if (own === null) throw new Error("due-time settings name no schedules, no actions, no from_wakes and no from_rows (timed-action's own rows)");
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
  const tellOnce = (line) => {
    if (!said.has(line)) say(line);
    said.add(line);
  };
  const listening = handlers.listening ?? (async () => []);
  let listeners = [];
  let rowWakes = [];
  // The kept rows' own database, opened once with the waiter's own credential (`from_rows`); a read that fails keeps the
  // wakes the last read found, and is said once. A connection lost between reads is let go and opened again at the next
  // read: unheard, pg's 'error' ends the process. Nov 22 2026, 2:02 to 2:48 AM CST on the Mac: the run proxy's tunnel
  // closed while the waiter slept, "Connection terminated unexpectedly" went unhandled, and its session crashed 8 times.
  let rowsClient = null;
  const letGoRows = (client) => {
    if (rowsClient === client) rowsClient = null;
    Promise.resolve(client?.end?.()).catch(() => {});
  };
  const readRows = async () => {
    if (rowsClient === null) {
      const connection = handlers.connection ?? readGivenCredential(handlers, 4);
      const client = await (handlers.connect ?? connectWithPg)(connection);
      client.on?.("error", (error) => {
        letGoRows(client);
        tellOnce(`due-time: the kept rows' connection was lost: ${error?.message ?? error}`);
      });
      rowsClient = client;
    }
    return keptWakes(rowsClient, own.from_rows, (wake) => tellOnce(`due-time: the kept wake ${wake?.id ?? "(no id)"} names a computer that is not a string, so no waiter watches it`));
  };

  while (!signal?.aborted) {
    if (own.from_wakes !== null) {
      try {
        listeners = await listening(own.from_wakes);
      } catch (error) {
        tellOnce(`due-time: ${error?.message ?? error}`);
      }
    }
    if (own.from_rows !== null) {
      try {
        rowWakes = await readRows();
      } catch (error) {
        letGoRows(rowsClient);
        tellOnce(`due-time: the kept rows could not be read: ${error?.message ?? error}`);
      }
    }
    const rule = withListeners(own, [...listeners, ...rowWakes]);
    const now = nowMs();
    // A schedule seen for the first time (a wake switched on since) starts at its first time from now, kept before
    // anything of it is told.
    const fresh = rule.schedules.filter((schedule) => typeof schedule?.schedule_id === "string" && !state.schedules[schedule.schedule_id]);
    if (fresh.length > 0) {
      const added = Object.fromEntries(fresh.map((schedule) => [schedule.schedule_id, { resume_from_ms: now, proofs: [] }]));
      state = { ...state, schedules: { ...state.schedules, ...added } };
      await keepState(state);
    }
    const due = dueAt(rule, state, now);
    for (const rejected of due.rejected) {
      tellOnce(`due-time: timed-action refused schedule ${rejected.schedule_id}: ${rejected.reason}`);
    }
    let refused = false;
    const observedAt = new Date(now).toISOString();
    for (const occurrence of due.recurring) {
      if (signal?.aborted) return;
      const eventKey = occurrence.occurrence_key;
      const next = provenRecurring(state, occurrence, observedAt, eventKey);
      const told = await handlers.onTransition({ condition: "became-reachable", observed_identity: {}, event_key: eventKey, state: next,
        detail: { schedule_id: occurrence.schedule_id, start: occurrence.start, end: occurrence.end, missed_before: occurrence.missed_before ?? 0,
          missed_since: occurrence.missed_since ?? null, record_id: null, operation: null } });
      if (told === false) refused = true;
      else state = next;
    }
    for (const fire of due.oneOff) {
      if (signal?.aborted) return;
      const eventKey = `${fire.record_id}#${fire.operation}`;
      const next = provenOneOff(state, rule, fire);
      const told = await handlers.onTransition({ condition: "became-reachable", observed_identity: {}, event_key: eventKey, state: next,
        detail: { schedule_id: null, start: fire.due_at ?? null, end: null, missed_before: 0, missed_since: null, record_id: fire.record_id, operation: fire.operation } });
      if (told === false) refused = true;
      else state = next;
    }
    if (due.recurring.length + due.oneOff.length > 0 && !refused) continue; // what was told may have made the next due
    let until = refused ? now + rule.retry_ms : due.next_ms;
    if (own.from_wakes !== null || own.from_rows !== null) until = Math.min(until ?? Infinity, now + own.look_again_ms);
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
