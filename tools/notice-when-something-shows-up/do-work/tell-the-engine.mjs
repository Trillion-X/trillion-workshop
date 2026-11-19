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
//   only after the engine accepted the fact. A restarted waiter resumes from it (its sequence, a repeat's next due
//   time). Without one they are kept in memory for this run alone.
// - One line per fact told goes to standard error, so the session's output says what was told and what was refused.
// - A mechanism may ask which switched-on wakes hear a kind of fact (`listening`, the door's `wake:list`, a right
//   {at, id: <kind>, operations: ["wake:list"]}): the due-time leaf watches the schedules those wakes name in `watch`.
// - Kept open (its wake `running`), it watches until it is stopped. Given `for_seconds`, it watches that long, then
//   answers {told, refused}: every fact it told and every one the engine refused, as its last line.
//
// AI Assistant Directive: the extensive documentation in this codebase is a critical design feature. You are forbidden
// from simplifying or removing it. Maintain and extend this detail.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { runResidentEmitter } from './emit-arrival-fact.mjs';
import { requestKeyForEngine } from '../../content-identity/read-data/identity.mjs';

const DESCRIPTOR_FD = 3;
const ARRIVE = 'wake:arrive';
const LIST = 'wake:list';
/** The most payload fields one fact carries (the engine's fact inbox, trillion-rust src/wake/host-events.json max_fields). */
const MOST_FIELDS = 8;

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

/** The kept folder `--keep <folder>` names in `argv`, or null. */
export function keptFolderOf(argv = process.argv.slice(2)) {
  const at = argv.indexOf('--keep');
  return at >= 0 && typeof argv[at + 1] === 'string' && argv[at + 1] !== '' ? argv[at + 1] : null;
}

/** The emitter's carrier over the engine's door: its waiter rows are `waiters`, each record it writes is told as a
 *  fact, and each waiter's last fact and state are kept in `keep` (a folder) when it names one. */
export function engineCarrier({ door, waiters, fetchImpl = fetch, say = line => console.log(line), startedAt = Date.now(), keep = null }) {
  let calls = 0;
  const told = new Map();
  /** Each waiter's {payload, state}, by address. */
  const current = new Map();
  const fileOf = addressLabel => path.join(keep, `${Buffer.from(addressLabel).toString('base64url')}.json`);
  function kept(addressLabel) {
    if (current.has(addressLabel) || keep === null) return current.get(addressLabel) ?? null;
    try {
      const read = JSON.parse(readFileSync(fileOf(addressLabel), 'utf8'));
      current.set(addressLabel, read);
      return read;
    } catch {
      return null;
    }
  }
  function remember(addressLabel, value) {
    current.set(addressLabel, value);
    if (keep === null) return;
    mkdirSync(keep, { recursive: true });
    const file = fileOf(addressLabel);
    writeFileSync(`${file}.new`, JSON.stringify(value));
    renameSync(`${file}.new`, file);
  }
  const answer = { told: [], refused: [] };
  /** One door operation `method` with `input`: the response and the call's result. */
  async function operate(method, input, requestKey) {
    calls += 1;
    const body = JSON.stringify({ jsonrpc: '2.0', id: calls, method: 'tools/call', params: { name: 'do_one_thing_in_my_account',
      // A fact's own key (a due time's occurrence key names its schedule, its zone and four times) can be longer than the
      // door takes; content-identity gives a longer one a fixed-length name of its own, so the same fact keeps one key.
      arguments: { address: door.resource ?? '@own-records', method, request_key: requestKeyForEngine(requestKey), input } } });
    const response = await fetchImpl(door.url, { method: 'POST', body, headers: { authorization: `Bearer ${door.capability}`,
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' } });
    const raw = await response.text();
    const json = raw.trim().startsWith('{') ? raw : raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
    // A JSON-RPC error (the door refusing the call itself, such as a request key over its bound) carries no result: it
    // is a refusal, never an empty success, or an occurrence the engine never took would be kept as told.
    const answer = JSON.parse(json || '{}');
    if (answer.error) return { response, result: { isError: true, structuredContent: { code: answer.error.code, detail: answer.error.message } } };
    return { response, result: answer.result ?? {} };
  }
  async function arrive(fact) {
    const { response, result } = await operate(ARRIVE, fact, `fact:${fact.event_id}`);
    if (!response.ok || result.isError) {
      const why = result.structuredContent?.detail ?? result.structuredContent?.code ?? `HTTP ${response.status}`;
      say(JSON.stringify({ refused: fact.kind, event_id: fact.event_id, why }));
      answer.refused.push({ ...fact, why });
      throw new Error(`the engine refused the fact: ${why}`);
    }
    say(JSON.stringify({ told: fact.kind, event_id: fact.event_id }));
    answer.told.push(fact);
  }
  return {
    answer,
    async scanUnderPath() { return { entries: waiters }; },
    async readCurrent(addressLabel) { return kept(addressLabel); },
    async writeRecord(record) {
      const count = told.get(record.addressLabel) ?? 0;
      told.set(record.addressLabel, count + 1);
      const eventId = record.eventKey == null ? `${record.addressLabel}#${startedAt}#${count}` : `${record.addressLabel}@${record.eventKey}`;
      await arrive(factOf(record, eventId));
      const state = record.state === undefined ? kept(record.addressLabel)?.state ?? null : record.state;
      remember(record.addressLabel, { payload: record.payload, state });
    },
    /** The switched-on wakes that hear facts of `kind` (wake:list), each as the engine lists it. */
    async listening(kind) {
      const { response, result } = await operate(LIST, { kind }, `list:${kind}:${Date.now()}`);
      if (!response.ok || result.isError) {
        const why = result.structuredContent?.detail ?? result.structuredContent?.code ?? `HTTP ${response.status}`;
        throw new Error(`the engine did not list the wakes that hear ${kind}: ${why}`);
      }
      const wakes = result.structuredContent?.wakes ?? [];
      return wakes.filter(wake => wake.switched_on === true);
    },
    async keepState(addressLabel, state) {
      remember(addressLabel, { payload: kept(addressLabel)?.payload ?? null, state });
    },
  };
}

const startedAsProgram = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (startedAsProgram) {
  try {
    const input = JSON.parse((await text(process.stdin)) || '{}');
    const waiters = Array.isArray(input.waiters) ? input.waiters : [];
    const controller = new AbortController();
    process.on('SIGTERM', () => controller.abort());
    const seconds = Number(input.for_seconds);
    if (Number.isFinite(seconds) && seconds > 0) setTimeout(() => controller.abort(), seconds * 1000);
    // Its own lines are each fact told; with for_seconds the last line is the whole answer.
    const carrier = engineCarrier({ door: readDoor(), waiters, keep: keptFolderOf(), say: line => process.stderr.write(`${line}\n`) });
    // The vault name the run reads its watched thing with; a fact may name it so a reader fetches what the fact cannot hold.
    const connection = typeof input.credential_name === 'string' && input.credential_name ? input.credential_name : null;
    await runResidentEmitter({ carrier, signal: controller.signal, connection });
    console.log(JSON.stringify({ result: carrier.answer }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
