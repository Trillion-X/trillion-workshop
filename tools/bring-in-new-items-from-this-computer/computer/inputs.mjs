// computer/inputs.mjs
//
// Purpose
//   Every place the person's items come from, a store on a computer (notes, recordings, a chat database, a folder) or
//   a connected service (a mailbox, a notes service, a dictation service), is a row of the one account list `inputs`.
//   This module is how the reader reaches that list: it makes the list once with its starting rows (the `sources` of
//   computer-sources.json), reads the rows back as the places the reader looks at and reads, keeps the last rows it
//   saw so a Mac that cannot reach the account keeps reading what it read, and reads a connected service through the
//   `tool` reader: any Workshop tool the row names, run through the account's door.
//
// Non-negotiable invariants
//   1. Nothing here names a place or a service. A place is a row; a new kind of store is a leaf of READERS in
//      read-new-items.mjs; a new service is a row naming a tool, with no code.
//   2. The list is the original. computer-sources.json `sources` is only the starting rows, copied in once when the
//      list does not exist: a row the person later removed or changed is never put back (lists-door.mjs `ensure`).
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

/** run(tool, input) over the person's door: the tool's answer, or a throw saying why it did not finish. */
export const toolRunner = door => async (tool, input) => {
  const answer = await door.run(tool, input);
  if (answer?.exit_code || answer?.status >= 400) throw new Error(String(answer.error ?? answer.result?.error?.message ?? `${tool} did not finish`).slice(0, 300));
  return answer?.result ?? answer;
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

/**
 * The places as the account's list holds them. `sources` and `carriers` are live arrays, changed in place at each
 * refresh, so the readers that hold them see the list as it is now. Before the list has ever been read they hold the
 * last rows this computer saw (cacheFile), else the starting rows.
 *
 * lists: { find(id), ensure({id, starters, ...definition}), read(id) } over the person's records door (lists-door.mjs).
 * Returns { sources, carriers, refresh({force}) -> Promise<boolean> (true when the account's list was read), ready() }.
 */
export function liveInputs({lists, rows, definition = inputsDefinition(), cacheFile = null, everySeconds = rows.inputs?.every_seconds ?? 60, now = () => Date.now(), log = () => {}}) {
  const sources = [], carriers = [];
  let readAt = null, made = false, ready = false;
  const apply = next => {
    sources.splice(0, sources.length, ...next);
    carriers.splice(0, carriers.length, ...next.filter(isRead).map(source => source.read));
  };
  apply((cacheFile && readJson(cacheFile)?.sources) || rows.sources);
  return {
    sources, carriers,
    ready: () => ready,
    async refresh({force = false} = {}) {
      if (!force && readAt !== null && now() - readAt < everySeconds * 1000) return false;
      readAt = now();
      try {
        if (!made) { await lists.ensure({...definition, starters: startersOf(rows)}); made = true; }
        const {rows: held} = await lists.read(definition.id);
        const next = held.map(sourceOfRow);
        apply(next);
        ready = true;
        if (cacheFile) writeJson(cacheFile, {sources: next, at: new Date(now()).toISOString()});
        return true;
      } catch (error) {
        log(`Inputs: the list could not be read, so the last rows go on being read: ${String(error?.message ?? error).slice(0, 200)}`);
        return false;
      }
    },
  };
}
