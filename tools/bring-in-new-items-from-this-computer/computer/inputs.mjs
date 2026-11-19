// computer/inputs.mjs
//
// Purpose
//   Every place the person's items come from, a store on a computer (notes, recordings, a chat database, a folder) or
//   a connected service (a mailbox, a notes service, a dictation service), is a row of the one account list `inputs`.
//   This module is how the reader reaches that list: it makes the list once with its starting rows (the `sources` of
//   computer-sources.json), reads the rows back as the places the reader looks at and reads, keeps the last rows it
//   saw so a Mac that cannot reach the account keeps reading what it read, and reads a connected service through the
//   `tool` reader: any Workshop tool the row names, run with the run the caller hands in.
//
// Nothing here reads or writes a store. The caller reads the list (its record and its rows) from the store the person
// keeps it in, hands it in, and keeps the writes that come back; the list is never reached through a door object.
//
// Non-negotiable invariants
//   1. Nothing here names a place or a service. A place is a row; a new kind of store is a leaf of READERS in
//      read-new-items.mjs; a new service is a row naming a tool, with no code.
//   2. The list is the original. computer-sources.json `sources` is only the starting rows, copied in once when the
//      list does not exist: a row the person later removed or changed is never put back (inputsWrites).
//   3. A row holds no secret. A service row names its connection by handle (`connection`), which the named tool's own
//      run resolves in the vault; the key never passes through a row or through this module.
//   4. A row the person set `reading: "No"` is still a place Connections lists, and is never read.
//   5. One read of the list serves every look within `inputs.every_seconds`; an unreachable account never stops a read.
import {readFileSync, writeFileSync, mkdirSync, renameSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CHILD_READERS, READERS, fill} from './read-new-items.mjs';

export const INPUTS_DEFINITION = fileURLToPath(new URL('./inputs-list.json', import.meta.url));
export const inputsDefinition = () => JSON.parse(readFileSync(INPUTS_DEFINITION, 'utf8'));

/** The rows the list starts with, from the places computer-sources.json lists: [{id, values}]. */
export const startersOf = rows => rows.sources.map(({id, ...values}) => ({id, values}));

/** A place as the reader knows it (`{id, ...fields}`) from its list row. */
export const sourceOfRow = ({id, values}) => ({id, ...values});

/**
 * The places to read, from the rows: a row's `read` route names its progress and where its arrivals come from, so two rows
 * with one route would share both: the first row reads it, the others are named in the log and left unread; a read
 * block with no route is left unread.
 */
export function readable(sources, log = () => {}) {
  const taken = new Map();
  return sources.filter(source => {
    if (!isRead(source)) return false;
    const route = source.read.route;
    if (typeof route !== 'string' || !route) { log(`Inputs: ${source.id} has a read block with no route, so it is not read`); return false; }
    if (taken.has(route)) { log(`Inputs: ${source.id} shares the route "${route}" with ${taken.get(route)}, so it is not read`); return false; }
    taken.set(route, source.id);
    return true;
  });
}

/** Whether the person has this place read: every row is read unless its `reading` says No. */
export const isRead = source => Boolean(source.read) && source.reading !== 'No';

const valueAt = (value, route) => String(route ?? '').split('.').filter(Boolean).reduce((held, key) => (held === null || held === undefined ? undefined : held[key]), value);

// Every string of a row's `input` is filled with the moment the read is from: {since} (ISO), {since_seconds}, {since_ms}.
// A string that is only a number's placeholder ({since_seconds}, {since_ms}) is that number, for a tool whose input is one.
const fillAll = (value, moment) => {
  if (typeof value === 'string') return /^\{since_(seconds|ms)\}$/.test(value) ? moment[value.slice(1, -1)] : fill(value, moment);
  if (Array.isArray(value)) return value.map(entry => fillAll(entry, moment));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fillAll(entry, moment)]));
  return value;
};

const TIMES = {
  iso: value => new Date(value),
  'unix-seconds': value => new Date(Number(value) * 1000),
  'unix-ms': value => new Date(Number(value)),
};

/**
 * The `tool` reader: (carrier, since) -> items, for a place that is a connected service. The row's read block says
 * `tool` (a Workshop tool id), `input` (its input, strings filled with {since}, {since_seconds}, {since_ms}; a string that is only {since_seconds} or {since_ms} is that number), `items`
 * (where in the answer the list of new things is; the answer itself when left out), `fields` ({source_id, at, title,
 * text}: where each is in one thing, dotted), `time` (iso, unix-seconds or unix-ms; iso by default), `text` (a template
 * over one thing's top-level values, in place of fields.text) and `most` (at most this many things a read).
 * run(tool, input) -> the tool's answer, or throws.
 */
export const serviceReader = run => async (carrier, since) => {
  if (typeof carrier.tool !== 'string' || !carrier.tool) throw new Error(`the place ${carrier.route} names no tool to read`);
  const moment = {since: since.toISOString(), since_seconds: Math.floor(since.getTime() / 1000), since_ms: since.getTime()};
  const answer = await run(carrier.tool, fillAll(carrier.input ?? {}, moment));
  const list = carrier.items ? valueAt(answer, carrier.items) : answer;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(`${carrier.tool} answered no list at ${carrier.items ?? 'the top'}`);
  const toDate = TIMES[carrier.time ?? 'iso'];
  if (!toDate) throw new Error(`no time unit called ${carrier.time}: a row's time is one of ${Object.keys(TIMES).join(', ')}`);
  const fields = carrier.fields ?? {};
  const items = [];
  for (const thing of list.slice(0, carrier.most ?? list.length)) {
    const at = fields.at ? toDate(valueAt(thing, fields.at)) : new Date();
    const sourceId = valueAt(thing, fields.source_id ?? 'id');
    if (sourceId === undefined || sourceId === null || Number.isNaN(at.getTime())) continue;
    const scalars = Object.fromEntries(Object.entries(thing).filter(([, held]) => held === null || ['string', 'number', 'boolean'].includes(typeof held)));
    const text = carrier.text ? fill(carrier.text, scalars) : valueAt(thing, fields.text);
    if (!String(text ?? '').trim()) continue;
    items.push({...scalars, source_id: String(sourceId), at: at.toISOString(), title: fields.title ? valueAt(thing, fields.title) ?? null : null, text: String(text)});
  }
  return items;
};

/** The readers a look uses: each local leaf in its own child process, and the `tool` reader in this process. */
export const readersWith = extra => {
  const own = Object.fromEntries(Object.keys(READERS).map(name => [name, (carrier, since) => CHILD_READERS[name](carrier, since)]));
  return {...own, ...extra};
};

const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  writeFileSync(`${file}.next`, JSON.stringify(value, null, 1), {mode: 0o600});
  renameSync(`${file}.next`, file);
};

// The list's own value as the account keeps it: its definition with its row type (the record type of its rows).
const listValue = definition => {
  const {id: _id, ...value} = definition;
  return {row_type: definition.id, indexes: [], ...value};
};

/**
 * What the caller keeps, from the list as the caller read it (`held`: {list, rows}, list null when the list is not made
 * yet, rows [{id, values}]). The writes come in the order they must be kept: the list, then each starting row not there
 * yet, then the list marked seeded, so a first run cut off between them goes on from where it stopped, and a row the
 * person removed after the mark is never put back. Each write is a record of the shape a list is kept in ({id, type,
 * value, expected}, expected null when the record must be absent); a store refuses a write whose expected record has
 * moved. Returns { keep, sources }: the places once keep is kept, as the reader reads them.
 */
export function inputsWrites(held, rows, definition = inputsDefinition(), now = () => Date.now()) {
  const listId = `list:${definition.id}`, rowType = `record:${definition.id}`;
  const made = held.list ?? listValue(definition);
  const have = new Set(held.rows.map(row => row.id));
  const missing = held.list?.seeded ? [] : startersOf(rows).filter(row => !have.has(row.id));
  const keep = [];
  if (!held.list) keep.push({id: listId, type: 'list', value: made, expected: null});
  for (const row of missing) keep.push({id: `${rowType}:${row.id}`, type: rowType, value: row.values, expected: null});
  if (!held.list?.seeded) keep.push({id: listId, type: 'list', value: {...made, seeded: new Date(now()).toISOString()}, expected: {type: 'list', value: made}});
  return {keep, sources: [...held.rows, ...missing].map(sourceOfRow)};
}

/**
 * The places as the account's list holds them. `sources` and `carriers` are live arrays, changed in place at each
 * apply, so the readers that hold them see the list as it is now. Before the list has ever been read they hold the
 * last places this computer saw (cacheFile), else the starting rows.
 *
 * The caller reads the list and keeps what comes back, so this module never reaches a store:
 *   if (inputs.due()) { const {keep, sources} = inputs.take(held); await store.keep(keep); inputs.apply(sources); }
 * where held is {list, rows} as read, or null when the read failed (then take keeps nothing and apply does nothing).
 */
export function liveInputs({rows, definition = inputsDefinition(), cacheFile = null, everySeconds = rows.inputs?.every_seconds ?? 60, now = () => Date.now(), log = () => {}}) {
  const sources = [], carriers = [];
  let readAt = null, ready = false;
  const place = next => {
    sources.splice(0, sources.length, ...next);
    carriers.splice(0, carriers.length, ...readable(next, log).map(source => source.read));
  };
  place((cacheFile && readJson(cacheFile)?.sources) || rows.sources);
  return {
    sources, carriers,
    ready: () => ready,
    /** Whether the list is due for a read: once in every_seconds, or at once when forced. */
    due({force = false} = {}) { return force || readAt === null || now() - readAt >= everySeconds * 1000; },
    /** The list as the caller read it, or null when the read failed. Returns { keep, sources }, see inputsWrites. */
    take(held) {
      readAt = now();
      if (!held) {
        log('Inputs: the list could not be read, so the last rows go on being read');
        return {keep: [], sources: null};
      }
      return inputsWrites(held, rows, definition, now);
    },
    /** Makes these places the ones read, once the caller has kept what take returned (null leaves the last places). */
    apply(next) {
      if (!next) return;
      place(next);
      ready = true;
      if (cacheFile) writeJson(cacheFile, {sources: next, at: new Date(now()).toISOString()});
    },
  };
}
