import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/notice-when-something-shows-up/do-work/tell-the-engine.mjs
//
// The noticer run as a Workshop tool: the same resident emitter (emit-arrival-fact.mjs) with a carrier that tells the
// person's engine each fact at its door's `wake:arrive`, instead of appending a record to the retired runtime. A wake
// whose `on: {fact: {kind, from: ["run"], match}}` hears it starts its tool (trillion-rust src/wake.rs).
//
// - The waiter rows come from the run's input ({waiters: [...]}, the same descriptor rows things-to-store-and-run.json
//   ships), never from a store: which waiters run is the person's own DATA, given to the run.
// - The door is the run's own capability on fd 3 ({url, resource, capability}); the run reaches only the fact kinds its
//   row names as rights ({at, id: <kind>, operations: ["wake:arrive"]}).
// - A fact is a few short text fields: kind (the waiter's change_kind), event_id and the payload's scalar fields as
//   text, observed_identity's flattened in; nested lists stay out. The event id is the waiter's address and the
//   transition's own event key when it names one (a due time's instant: `clock::due@1794986100000`), so telling it
//   again after a restart is the same fact and the engine admits it once (src/wake.rs `fact`, its marker). Without
//   one it is the address, when this run started and how many facts it has told for that waiter: unique without
//   keeping anything.
// - Given a kept folder (`--keep <folder>`: the row's `invoke.kept_folder`, one folder per account and tool that lasts
//   between runs, trillion-rust src/tool_runs/tools/container.rs `kept_folder`), each waiter's last fact and its
//   mechanism's state are kept there, one file per waiter address, written whole (a new file renamed over the old),
//   only after the engine accepted the fact. Two waiters that emit at one address keep apart (each file is the waiter and its address). A restarted waiter resumes from it (its sequence, a repeat's next due
//   time). Without one they are kept in memory for this run alone.
// - Each wake keeps its own places: given `--wake <id>` (the row's run fills it from the task's `cause.wake`, the id of
//   the wake that started the run, a copy's `<declared id>/<name>`), every kept key starts with that id
//   (kept-places.mjs `keptKeyOf`), so the copies of one wake (keep-noticing-row-changes and a copy of it per pursuit
//   database, each over its own database) keep apart in one kept folder and in one places_in database. A wake's
//   first run under keys that name it carries over once from the place kept under the key without one (Nov 25 2026,
//   3:07 AM CST: four copies were each given one shared place). A run no wake started is given no id (the fill leaves
//   the word out) and keeps under the key without one.
// - Given `places_in` in the input (the vault name of a database of the person's, held on PLACES_FD), each waiter's place
//   is kept there instead, in one row per tool and kept key (do-work/kept-places.mjs), so it travels with the person and
//   the tool when the wake moves to another computer: the next computer goes on from where the last one stopped, and
//   tells nothing twice and passes over nothing (Nov 25 2026, 1:50 AM CST: a move by wake:switch found a place from
//   before Nov 22 in the other computer's kept folder and told days of row changes again). A place there wins over one in
//   this computer's kept folder. A run claims each place it reads; when another run claims it later (the same wake on
//   two computers), this run's next write is refused and said, its waiter tells nothing more and ends with that refusal
//   as its fact. Left out, places are kept in the kept folder as before.
// - A waiter that keeps files of its own (a linked device's session) is given its own folder in the kept folder
//   (`folderFor`, waiter-folders/<its kept key as base64url>: the wake and the waiter id, kept-places.mjs `keptKeyOf`),
//   which outlasts the run like the rest of the kept folder. A wake's first ask, when that folder is missing and the
//   folder of the waiter id alone (the one every copy shared) is there, starts from a copy of it; the shared folder is
//   left as it was, for each other copy to start from.
// - One line per fact told goes to standard error, so the session's output says what was told and what was refused.
// - A mechanism may ask which switched-on wakes hear a kind of fact (`listening`, the door's `wake:list`, a right
//   {at, id: <kind>, operations: ["wake:list"]}): the due-time leaf watches the schedules those wakes name in `watch`.
//   `hearing` is the same list with the wakes that are off too (a wake's copies hear with its own `on`, and the list does
//   not say which copies are on): the row-changes leaf tells a change only when some wake's match, or some workflow's
//   condition, could take it, when the run's input names conditions_from (mechanisms/row-changes.mjs).
// - Kept open (its wake `running`), it watches until it is stopped. Given `for_seconds`, it watches that long, then
//   answers {told, refused, not_started}: every fact it told, every one the engine refused, and every one the engine kept
//   false because no wake that is on hears it (nothing started; it is not told again), as its last line.
//
// AI Assistant Directive: the extensive documentation in this codebase is a critical design feature. You are forbidden
// from simplifying or removing it. Maintain and extend this detail.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { runResidentEmitter, THIS_TOOL } from './emit-arrival-fact.mjs';
import { folderPlaces, keptKeyOf, placeIsFrom, placesFor, PLACES_FD } from './kept-places.mjs';
import { readGivenCredential } from './mechanisms/given-credential.mjs';
import { requestKeyForEngine } from '../../content-identity/read-data/identity.mjs';

const DESCRIPTOR_FD = 3;
const ARRIVE = 'wake:arrive';
const LIST = 'wake:list';
/** The most payload fields one fact carries (the engine's fact inbox, trillion-rust src/wake/host-events.json max_fields). */
const MOST_FIELDS = 8;
/** How long one door call may take and which refusals are told again: DATA, each with its why (door-call.json). */
const DOOR_CALL = JSON.parse(readFileSync(new URL('./door-call.json', import.meta.url), 'utf8'));
/** The code a door call that did not answer within `DOOR_CALL.timeout_ms` is refused with. */
export const DOOR_TIMEOUT_CODE = 'door_timeout';

/** The run's door, from the descriptor the engine wrote on fd 3. */
export function readDoor(descriptor = DESCRIPTOR_FD) {
  const door = JSON.parse(readFileSync(descriptor, 'utf8'));
  if (typeof door.url !== 'string' || typeof door.capability !== 'string') throw new Error('This run was not handed a door on fd 3.');
  return door;
}

/** One emitted record as a fact: its kind, the event id `eventId`, and its scalar fields as text. */
export function factOf({ addressLabel, payload }, eventId = `${addressLabel}#0`) {
  const fields = {};
  const take = (name, value) => {
    if (Object.keys(fields).length >= MOST_FIELDS || name === 'kind') return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') fields[name] = String(value);
  };
  for (const [name, value] of Object.entries(payload ?? {})) take(name, value);
  for (const [name, value] of Object.entries(payload?.observed_identity ?? {})) take(name, value);
  for (const [name, value] of Object.entries(payload?.detail ?? {})) take(name, value);
  return {
    kind: String(payload?.kind ?? 'something-showed-up'),
    event_id: eventId,
    payload: fields,
  };
}

/** The word after the flag `name` in `argv`, or null: none, an empty one, or another flag (a fill the task had no fact
 *  for leaves its word out of argv, so the flag is followed by the next flag or by nothing). */
export function flagOf(name, argv = process.argv.slice(2)) {
  const at = argv.indexOf(name);
  const word = at >= 0 ? argv[at + 1] : undefined;
  return typeof word === 'string' && word !== '' && !word.startsWith('--') ? word : null;
}

/** The kept folder `--keep <folder>` names in `argv`, or null. */
export function keptFolderOf(argv = process.argv.slice(2)) {
  return flagOf('--keep', argv);
}

/** The id of the wake that started the run, `--wake <id>` in `argv` (the task's cause.wake), or null for a run no wake
 *  started. */
export function wakeOf(argv = process.argv.slice(2)) {
  return flagOf('--wake', argv);
}

/** One door operation `method` with `input` on the run's door (`door`: {url, resource, capability}): {response, result}. A
 *  JSON-RPC error carries no result: it is a refusal, never an empty success. Shared by the carrier and the signed-call
 *  receiver (do-work/signed-webhook-receiver.mjs), so both reach the engine one way.
 *  A door that names `pins` (computer ids, as `{cli} op --pin` sends them) sends them as the call's route, so a door that carries
 *  calls to several computers (a meeting point) meets the call at that computer; a door without pins is called as before.
 *  A door with no `capability` sends no Authorization header: a door on a computer's own socket admits its caller by the
 *  kernel's peer credentials, not by a bearer. A door whose `resource` is null names no address, so the call is the bare
 *  operation that door takes; a door that names none is called at '@own-records' as before.
 *  A call, its answer read whole, that takes longer than `timeoutMs` (DATA door-call.json timeout_ms) is given up and
 *  answered as refused `door_timeout`, which a teller tells again (`tellAgain`): fetch has no time limit of its own, so a
 *  door that never answered held the waiter's pass for ever (wake-engine, Nov 22 2026, 3:2x AM CST). */
export async function operateOverDoor(door, method, input, requestKey, { fetchImpl = fetch, id = 1, timeoutMs = DOOR_CALL.timeout_ms } = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'do_one_thing_in_my_account',
    // A fact's own key (a due time's occurrence key names its schedule, its zone and four times) can be longer than the
    // door takes; content-identity gives a longer one a fixed-length name of its own, so the same fact keeps one key.
    arguments: { ...(door.resource === null ? {} : { address: door.resource ?? '@own-records' }), method, request_key: requestKeyForEngine(requestKey), input, ...(door.pins?.length ? { pins: door.pins } : {}) } } });
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  let raw;
  try {
    response = await fetchImpl(door.url, { method: 'POST', body, signal, headers: { ...(typeof door.capability === 'string' ? { authorization: `Bearer ${door.capability}` } : {}),
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' } });
    raw = await response.text();
  } catch (error) {
    if (!signal.aborted) throw error;
    const detail = `the door did not answer ${method} within ${timeoutMs} ms`;
    return { response: { ok: false, status: 0 }, result: { isError: true, structuredContent: { code: DOOR_TIMEOUT_CODE, detail } } };
  }
  const json = raw.trim().startsWith('{') ? raw : raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
  const answer = JSON.parse(json || '{}');
  if (answer.error) return { response, result: { isError: true, structuredContent: { code: answer.error.code, detail: answer.error.message } } };
  return { response, result: answer.result ?? {} };
}

/** The door's code for a fact it had no room for now (its waiting facts, its owed facts or its book are full,
 *  trillion-rust src/wake.rs `Failure::Full`): the fact is fine and is told again later. */
export const ROOM_FULL_CODE = 'owed_full';

/** The error a refused fact throws: the engine's words, and `roomFull` when the door had no room for it now, so a teller
 *  waits and tells it again instead of counting a broken fact (Nov 21 2026, 4:11 and 4:47 PM CST on the Mac: the row changes
 *  noticer counted ten full-owed refusals as failures and stopped). `tellAgain` when its code is one DATA names
 *  (door-call.json tell_again_codes: no room now, or a door that did not answer in time): the teller keeps its place and
 *  tells it again after a wait. `neverAgain` when its code is one the engine gives every time the same fact is told
 *  (door-call.json never_again_codes: input it does not take), so a teller settles it once instead of telling it again. */
export function refusedFact(why, code) {
  return Object.assign(new Error(`the engine refused the fact: ${why}`), { code: code ?? null, roomFull: code === ROOM_FULL_CODE,
    tellAgain: DOOR_CALL.tell_again_codes.includes(code), neverAgain: DOOR_CALL.never_again_codes.includes(code) });
}

/** Tells one fact to the engine at its door's `wake:arrive`. Resolves when the engine took it; throws with the engine's
 *  words when it refused it, so a caller can answer the service "not taken" and be called again. */
export async function arriveOverDoor(door, fact, { fetchImpl = fetch } = {}) {
  const { response, result } = await operateOverDoor(door, ARRIVE, fact, `fact:${fact.event_id}`, { fetchImpl });
  if (!response.ok || result.isError) {
    const why = result.structuredContent?.detail ?? result.structuredContent?.code ?? `HTTP ${response.status}`;
    throw refusedFact(why, result.structuredContent?.code);
  }
  // Kept false: the engine took the fact but no wake that is on hears it, so nothing starts (trillion-rust 76424ef55). It is
  // no refusal (a teller does not tell it again), and the fact says so.
  const notStarted = notStartedWhy(result.structuredContent);
  return notStarted ? { ...fact, not_started: notStarted } : fact;
}

/** Why a fact the engine answered did not start anything, or null: its answer says kept false (no wake that is on hears it),
 *  with the wakes of its kind. */
export function notStartedWhy(answer) {
  if (answer?.kept !== false) return null;
  const wakes = (answer.not_heard?.wakes_of_its_kind ?? []).map(wake => `${wake.tool} ${wake.id} (hears ${(wake.from ?? []).join(', ')}, ${wake.switched_on ? 'on' : 'off'})`);
  return `${answer.not_heard?.why ?? 'not kept'}${wakes.length ? `: ${wakes.join('; ')}` : ''}`;
}

/** The emitter's carrier over the engine's door: its waiter rows are `waiters`, each record it writes is told as a
 *  fact, and each waiter's last fact and state are kept in `places` (do-work/kept-places.mjs): the kept folder `keep`
 *  when the run names no places_in, else places_in's database, under keys that name `wake` (the wake that started the
 *  run, null for none). `keep` also holds each waiter's own folder (`folderFor`). */
export function engineCarrier({ door, waiters, fetchImpl = fetch, say = line => console.log(line), startedAt = Date.now(), keep = null,
  places = folderPlaces(keep), wake = null, doorTimeoutMs = DOOR_CALL.timeout_ms }) {
  let calls = 0;
  const told = new Map();
  /** Each waiter's {payload, state}, by kept key, as this run last read or kept it. */
  const current = new Map();
  /** Each waiter whose place another run took, as the refusal its writes got. */
  const takenFrom = new Map();
  /** What one waiter's last fact and state are kept under, and the key a wake's first read carries over from (keptKeyOf). */
  const keyOf = (addressLabel, waiterRef) => keptKeyOf({ wake, waiterRef, addressLabel });
  /** The vault name each waiter's facts name as `where`, as its first read of its place said (`readCurrent`). */
  const whereOf = new Map();
  /** The place kept under `key.as`, read from the store once (a database store claims it for this run as it reads it). A
   *  place whose `where` is not the waiter's own (`placeIsFrom`) reads as no place, and is said once. */
  async function kept(key, waiterRef = null) {
    if (current.has(key.as)) return current.get(key.as);
    const where = whereOf.get(waiterRef ?? key.as) ?? null;
    const read = await places.read(key.as, key.carriedFrom, {
      accepts: place => placeIsFrom(place, where),
      ignored: ({ keptAs, place }) => say(JSON.stringify({ place_ignored: key.as, found_under: keptAs, its_where: place?.payload?.where ?? null,
        waiter_where: where, why: 'a place read in another place is no place for this waiter' })),
    });
    current.set(key.as, read);
    return read;
  }
  /** Keeps `value` under `as`: in memory only once the store kept it, so a refused write leaves the place where it was. A
   *  place another run holds is said once, and its waiter tells nothing more (`writeRecord`). */
  async function remember(as, value, waiterRef) {
    try {
      await places.write(as, value);
    } catch (error) {
      if (error?.placeTaken && !takenFrom.has(waiterRef ?? as)) {
        takenFrom.set(waiterRef ?? as, error);
        say(JSON.stringify({ place_refused: as, held_by: error.holder?.kept_by_run ?? null, kept_on: error.holder?.kept_on ?? null,
          kept_at: error.holder?.kept_at ? new Date(error.holder.kept_at).toISOString() : null }));
      }
      throw error;
    }
    current.set(as, value);
  }
  const answer = { told: [], refused: [], not_started: [] };
  /** One door operation `method` with `input`: the response and the call's result. */
  // A JSON-RPC error (the door refusing the call itself, such as a request key over its bound) is a refusal, never an
  // empty success, or an occurrence the engine never took would be kept as told.
  async function operate(method, input, requestKey) {
    calls += 1;
    return operateOverDoor(door, method, input, requestKey, { fetchImpl, id: calls, timeoutMs: doorTimeoutMs });
  }
  async function arrive(fact) {
    const { response, result } = await operate(ARRIVE, fact, `fact:${fact.event_id}`);
    if (!response.ok || result.isError) {
      const why = result.structuredContent?.detail ?? result.structuredContent?.code ?? `HTTP ${response.status}`;
      say(JSON.stringify({ refused: fact.kind, event_id: fact.event_id, why }));
      answer.refused.push({ ...fact, why });
      throw refusedFact(why, result.structuredContent?.code);
    }
    const notStarted = notStartedWhy(result.structuredContent);
    if (notStarted) {
      say(JSON.stringify({ told: fact.kind, event_id: fact.event_id, not_started: notStarted }));
      answer.not_started.push({ ...fact, why: notStarted });
      return;
    }
    say(JSON.stringify({ told: fact.kind, event_id: fact.event_id }));
    answer.told.push(fact);
  }
  /** Every wake that hears facts of `kind` (wake:list), switched on or not, each as the engine lists it. */
  async function hearing(kind) {
    const { response, result } = await operate(LIST, { kind }, `list:${kind}:${Date.now()}`);
    if (!response.ok || result.isError) {
      const why = result.structuredContent?.detail ?? result.structuredContent?.code ?? `HTTP ${response.status}`;
      throw new Error(`the engine did not list the wakes that hear ${kind}: ${why}`);
    }
    return result.structuredContent?.wakes ?? [];
  }
  return {
    answer,
    async scanUnderPath() { return { entries: waiters }; },
    /** The waiter's place; `where` is the vault name its facts name (its connection), the only place it takes a place from. */
    async readCurrent(addressLabel, waiterRef, where = null) {
      if (where !== null) whereOf.set(waiterRef ?? keyOf(addressLabel, waiterRef).as, where);
      return kept(keyOf(addressLabel, waiterRef), waiterRef);
    },
    async writeRecord(record) {
      const key = keyOf(record.addressLabel, record.waiterRef);
      const { as } = key;
      // The place is claimed before anything is told, and a place another run took is told nothing more.
      const before = await kept(key, record.waiterRef);
      const taken = places.taken(as);
      if (taken) throw taken;
      const count = told.get(record.addressLabel) ?? 0;
      told.set(record.addressLabel, count + 1);
      const eventId = record.eventKey == null ? `${record.addressLabel}#${startedAt}#${count}` : `${record.addressLabel}@${record.eventKey}`;
      await arrive(factOf(record, eventId));
      const state = record.state === undefined ? before?.state ?? null : record.state;
      await remember(as, { payload: record.payload, state }, record.waiterRef);
    },
    hearing,
    /** The switched-on wakes that hear facts of `kind` (wake:list), each as the engine lists it. */
    async listening(kind) {
      return (await hearing(kind)).filter(wake => wake.switched_on === true);
    },
    /** A folder of the waiter's own inside the kept folder for this run's wake, made on first ask (from a copy of the
     *  folder the waiter id alone names, when that is there); null without a kept folder. */
    folderFor(waiterRef) {
      if (keep === null || typeof waiterRef !== 'string' || waiterRef === '') return null;
      const { as, carriedFrom } = keptKeyOf({ wake, addressLabel: waiterRef });
      const folderOf = key => path.join(keep, 'waiter-folders', Buffer.from(key).toString('base64url'));
      const folder = folderOf(as);
      // Copied beside it, then renamed into place whole, so a run stopped while it copies leaves no half folder that a
      // later run would take as its own.
      if (!existsSync(folder) && carriedFrom !== null && existsSync(folderOf(carriedFrom))) {
        rmSync(`${folder}.new`, { recursive: true, force: true });
        cpSync(folderOf(carriedFrom), `${folder}.new`, { recursive: true });
        renameSync(`${folder}.new`, folder);
      }
      mkdirSync(folder, { recursive: true });
      return folder;
    },
    async keepState(addressLabel, state, waiterRef) {
      const key = keyOf(addressLabel, waiterRef);
      await remember(key.as, { payload: (await kept(key, waiterRef))?.payload ?? null, state }, waiterRef);
    },
    /** The refusal that took this waiter's place from this run (another run claimed it later), or null. */
    placeTaken(waiterRef) { return takenFrom.get(waiterRef) ?? null; },
    /** Ends the run's hold on its place store (a database store's connection). */
    async close() { await places.close(); },
  };
}

/** The connection places_in names, from the descriptor the row mounts it on (PLACES_FD), or an error that says so: a row
 *  or an engine that did not mount it leaves that descriptor unread or open on something else. */
export function placesConnection(placesIn, fd = PLACES_FD) {
  try {
    return readGivenCredential({ credentialFd: fd }, fd);
  } catch (error) {
    throw new Error(`places_in names ${placesIn}, but this run holds no connection on descriptor ${fd}: ${error?.message ?? error}`, { cause: error });
  }
}

/** The first descriptor a waiter's own credential is held on: the row mounts each waiter's credential_name on this plus the
 *  waiter's place in the input's list (what-this-tool-does-and-how-to-run-it.json key, `waiters[].credential_name`). */
export const EACH_WAITER_FD = 5;

/** The input's waiters, each that names its own credential_name told the descriptor the run holds it on, the engine's
 *  rule for a `[]` mount: the first descriptor plus the waiter's place in the list, whether or not the waiters before it
 *  name one. */
export function waitersWithTheirCredentials(waiters, first = EACH_WAITER_FD) {
  return (Array.isArray(waiters) ? waiters : []).map((waiter, index) =>
    waiter && typeof waiter === 'object' && typeof waiter.credential_name === 'string' && waiter.credential_name
      ? { ...waiter, credential_fd: first + index } : waiter);
}

const startedAsProgram = (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]));
if (startedAsProgram) {
  try {
    const input = JSON.parse((await text(process.stdin)) || '{}');
    const waiters = waitersWithTheirCredentials(input.waiters);
    const controller = new AbortController();
    process.on('SIGTERM', () => controller.abort());
    const seconds = Number(input.for_seconds);
    if (Number.isFinite(seconds) && seconds > 0) setTimeout(() => controller.abort(), seconds * 1000);
    // Where each waiter's place is kept: the kept folder, or the database the input's places_in names (held on PLACES_FD).
    const startedAt = Date.now();
    const keep = keptFolderOf();
    const placesIn = typeof input.places_in === 'string' && input.places_in ? input.places_in : null;
    const places = await placesFor({ placesIn, keep, tool: THIS_TOOL, keptOn: hostname(), run: `${hostname()}:${process.pid}:${startedAt}`,
      connection: placesIn === null ? null : placesConnection(placesIn) });
    // Its own lines are each fact told; with for_seconds the last line is the whole answer.
    const carrier = engineCarrier({ door: readDoor(), waiters, keep, places, wake: wakeOf(), startedAt, say: line => process.stderr.write(`${line}\n`) });
    // The vault name the run reads its watched thing with; a fact may name it so a reader fetches what the fact cannot hold.
    const connection = typeof input.credential_name === 'string' && input.credential_name ? input.credential_name : null;
    // The vault name of the database whose workflow rows hold the conditions the router judges (the switch's own input): a
    // row-changes waiter that reads that database tells only the changes some wake or condition could take.
    const conditionsFrom = typeof input.conditions_from === 'string' && input.conditions_from ? input.conditions_from : null;
    await runResidentEmitter({ carrier, signal: controller.signal, connection, conditionsFrom });
    await carrier.close();
    console.log(JSON.stringify({ result: carrier.answer }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
