// src/list-feed.mjs
//
// Purpose
//   Keeps one of a person's lists filled from a feed: any https address that answers JSON, RSS or Atom holding items (what
//   changed in a product, a shop's products, fixtures, a job board, a blog or a channel's feed). Each item the list does not hold yet becomes one row;
//   rows already there are left as the person last edited them. A picture, video or file an item names (an https
//   address, or a path on the feed's own site) is kept in the person's files and the row's media field names it, so a
//   shared copy of the list serves it (src/list-copy.mjs). A schedule or rule runs it by tool id
//   (tool:fill-a-list-from-a-feed), so the list keeps itself current.
//   Three things widen that, each only when asked: `update_existing` rewrites the fields a row already holds when the
//   feed now says something else (a price, a licence), `stamp` names a field that holds the time of the run on every row
//   written or confirmed (so a later pass can tell what the feed no longer lists), and `into: { dataset }` fills one of
//   the shared libraries (src/design-library.mjs) instead of a list: the same items go to that library in batches, each
//   with a stable id from its key, so an entry the feed repeats unchanged writes nothing. `fixed: { <field>: <value> }`
//   gives every row or entry the same value for a field (a source, a licence) and `key_prefix` goes in front of each id,
//   after the item's own id is made, so one schedule per feed can keep a shared list or library current without ids meeting.
//   `stamp_row: { list_id, row_id, field }` writes the time of a successful run into that one field of that one row of the
//   person's lists (one row written per run), so a list of sources shows when each was last read; a missing list, row or
//   field is refused before anything is read.
//
// Non-Negotiable Invariants
//   1. Nothing here names a feed, a list or a kind of field: which item field fills which list field is the caller's
//      `values` (declared selectors such as $.title), and whether a field holds a file is its kind row in src/lists.json.
//   2. A row is the item's key (`key`, a selector): the same item read again adds nothing and never overwrites an edit.
//   3. At most `most` new items (src/lists.json limits.feed_items_per_run when left out, never over rows_per_write) are
//      added per run, with their files, so one run stays small for the store that keeps it; `waiting` says how many new
//      items are left for the next run, oldest last, so a large first read finishes over a few runs.
//   4. An RSS or Atom feed is read by the Workshop's feed reader (trillion-workshop tools/watch-my-sources/read-data/feed-items.mjs) into rows of { id, title, link, published, summary }, so the
//      default `items` ($.rows) and `key` ($.id) work for it and `values` names those fields; an answer that is JSON is
//      read as it always was.
//   5. Only https addresses are read. A file that cannot be read leaves its field empty on that row, never the row out.
//   6. Without `update_existing` a row is never touched once it exists. With it, only the fields the feed fills are
//      compared and written, and only when they differ; a field the feed leaves empty is never cleared, and the files of
//      a row that exists are never read again.
//   7. A library is told nothing about its fields here: it checks each entry against its own declared fields and answers
//      with the entries it refused and why. A library keeps no pictures from a feed and holds no run time (`stamp`
//      needs a list), because a time on every entry would rewrite every entry on every run.
//
import data from './lists.json' with { type: 'json' };
import { FEED_ACCEPT, feedItems } from '../../watch-my-sources/read-data/feed-items.mjs';
import sharedDatasets from '../../show-one-shelf-of-everything-a-person-or-their-ai-can/from-an-older-version/records/shared-dataset-records.json' with { type: 'json' };
import { selectDeclaredValue } from '../../ui/read-data/declared-selector.ts';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

export class ListFeedError extends Error {
  constructor(message, next_call = null) { super(message); this.status = 400; this.next_call = next_call; }
}
const KINDS = new Map(data.field_kinds.map(row => [row.id, row]));
const selected = (value, selector) => {
  const found = selectDeclaredValue(value, selector);
  return found && typeof found === 'object' && 'selector_contract_error' in found ? undefined : found;
};
// A row id from an item's key: its own words, kept to what a row id may hold.
const rowIdOf = key => String(key).trim().replace(/[/\s]+/g, '-').slice(0, 200);
// An item's key as text, or null for an item with no key that can hold a row id.
const rawKeyOf = (item, key) => {
  const itemKey = selected(item, key);
  return itemKey === undefined || itemKey === null || itemKey === '' || !rowIdOf(itemKey) ? null : String(itemKey);
};
// The row id of each distinct key in one run: its own id, unless another key in the run makes the same one. Then the key
// whose id is its own text keeps it and each other key gets a hash of its text, so no item is dropped for sharing an id.
const rowIdsOf = keys => {
  const distinct = [...new Set(keys.map(key => String(key)))];
  const sharing = new Map();
  for (const raw of distinct) sharing.set(rowIdOf(raw), (sharing.get(rowIdOf(raw)) ?? 0) + 1);
  return new Map(distinct.map(raw => {
    const legacy = rowIdOf(raw);
    if (sharing.get(legacy) < 2 || raw === legacy) return [raw, legacy];
    return [raw, `${legacy.slice(0, 183)}.${makeHashCodeHexFromBytes(new TextEncoder().encode(raw)).slice(3).slice(0, 16)}`];
  }));
};
// The id of one item: `key_prefix` goes in front of the item's own id after that id is made, so the prefix keeps its own
// `:` and `/` and ids from different feeds cannot meet.
const idPrefixOf = prefix => {
  if (prefix === undefined) return '';
  if (typeof prefix !== 'string' || prefix.length > 100) throw new ListFeedError('key_prefix is a short text put in front of every id.');
  return prefix;
};
// Values written the same on every row or entry, like the source an item came from.
const fixedOf = fixed => {
  if (fixed === undefined) return {};
  if (!fixed || typeof fixed !== 'object' || Array.isArray(fixed)) throw new ListFeedError('fixed says a value for each field that is the same on every row, like { "licence": "MIT" }.');
  return Object.fromEntries(Object.entries(fixed).filter(([, value]) => value !== undefined && value !== null && value !== ''));
};
// What a list field keeps from an item value: a list of words becomes lines, everything else is kept as given.
const keptValue = value => (Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join('\n') : value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const httpsAddress = (value, base) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const url = new URL(value, base); return url.protocol === 'https:' ? url : null; } catch { return null; }
};

// What a feed answered: JSON as it always was, else an RSS or Atom feed read into rows (the Workshop's feed-items.mjs).
async function readFeedBody(answer, feedUrl) {
  const text = await answer.text();
  try { return JSON.parse(text); } catch {
    const parsed = feedItems(text, feedUrl.href);
    if (!parsed) throw new ListFeedError(`${feedUrl.host} did not answer a feed (RSS, Atom or JSON).`);
    return { rows: parsed.items };
  }
}

// An unavailable or changed source shape is not an empty collection. A top-level
// JSON array uses the default item location; an explicit selector must resolve.
function itemsOfFeed(body, selector) {
  const found = selectDeclaredValue(body, selector);
  if (Array.isArray(found)) return found;
  if (selector === '$.rows' && Array.isArray(body)) return body;
  throw new ListFeedError(`The feed did not return a list of items at ${selector}.`);
}

/**
 * lists: the person's lists (src/lists.mjs). keepFile({ name, size, open, media_type }) keeps bytes in their files and
 * returns { identity }. read(url) fetches.
 * library: the shared library (src/design-library.mjs makeSharedLibrary) for `into`; only `add` is used.
 * input: { list_id, feed, items?: selector to the items (default $.rows, else the answer itself when it is a list),
 *          key: selector to each item's identity, values: { <field id>: <selector> }, files_into?: a folder,
 *          update_existing?: boolean, stamp?: a field id of the list, fixed?: { <field id>: a value }, key_prefix?: text before each id, into?: { dataset: a shared library id } instead of list_id }
 * → { list_id, added: [row id], updated: [row id], waiting, read }
 *   or, with `into`: { dataset, added: [id], replaced: [id], unchanged, refused: [{ id, reason }], invalid: [{ id?, reason }], read, said }
 */
export async function fillListFromFeed(context, input = {}) {
  const { stamp_row: stampRow, ...rest } = input;
  if (stampRow === undefined) return fillFromFeed(context, rest);
  const { lists } = context;
  const { list_id: listId, row_id: rowId, field } = stampRow && typeof stampRow === 'object' ? stampRow : {};
  if (typeof listId !== 'string' || typeof rowId !== 'string' || typeof field !== 'string' || !listId || !rowId || !field) throw new ListFeedError('stamp_row says which row gets the time of the run: { "list_id": ..., "row_id": ..., "field": ... }.', { tool: 'list_lists', arguments: {} });
  let found;
  try { found = await lists.read(listId, { row_ids: [] }); } catch { throw new ListFeedError(`stamp_row names a list that does not exist: ${listId}.`, { tool: 'list_lists', arguments: {} }); }
  if (!found.list.fields.some(one => one.id === field)) throw new ListFeedError(`${found.list.label} has no field ${field} to hold the time. Its fields are ${found.list.fields.map(one => one.id).join(', ')}.`);
  if (!(await lists.read(listId, { row_ids: [rowId] })).rows.some(row => row.id === rowId)) throw new ListFeedError(`${found.list.label} has no row ${rowId} to stamp.`);
  const ranAt = new Date().toISOString();
  const result = await fillFromFeed(context, rest);
  await lists.putRows(listId, { rows: [{ id: rowId, values: { [field]: ranAt } }] }, { actor: { by: 'tool:fill-a-list-from-a-feed' } });
  return { ...result, stamped: { list_id: listId, row_id: rowId, field, at: ranAt } };
}

async function fillFromFeed({ lists, keepFile, library, read = fetch }, input) {
  const { list_id: listId, feed, items: itemsAt = '$.rows', key = '$.id', values = {}, files_into: folder, most, update_existing: updateExisting = false, stamp, into: library_, fixed: fixedInput, key_prefix: keyPrefix } = input;
  const fixed = fixedOf(fixedInput);
  const prefix = idPrefixOf(keyPrefix);
  const feedUrl = httpsAddress(feed);
  if (!feedUrl) throw new ListFeedError('feed is an https address that answers RSS, Atom or JSON.');
  if (!values || typeof values !== 'object' || !Object.keys(values).length) throw new ListFeedError('values says which item field fills which list field, like { "title": "$.title" }.');
  if (library_ !== undefined) return fillLibraryFromFeed({ library, read }, { feedUrl, itemsAt, key, values, most, stamp, into: library_, listId, fixed, prefix });
  if (typeof listId !== 'string' || !listId) throw new ListFeedError('list_id names one of this person\'s lists.', { tool: 'list_lists', arguments: {} });
  if (stamp !== undefined && typeof stamp !== 'string') throw new ListFeedError('stamp is the id of one of the list\'s fields.');
  if (prefix.includes('/')) throw new ListFeedError('A list row id cannot hold a slash, so key_prefix for a list cannot either.');
  const { list } = await lists.read(listId, { row_ids: [] });
  const fields = new Map(list.fields.map(field => [field.id, field]));
  if (stamp !== undefined && !fields.has(stamp)) throw new ListFeedError(`${list.label} has no field ${stamp} to hold the time. Its fields are ${list.fields.map(field => field.id).join(', ')}.`);
  const unknown = [...Object.keys(values), ...Object.keys(fixed)].filter(id => !fields.has(id));
  const mediaFixed = Object.keys(fixed).filter(id => KINDS.get(fields.get(id)?.kind)?.media);
  if (mediaFixed.length) throw new ListFeedError(`${mediaFixed.join(', ')} holds a file, so it is filled from the feed's own files and not with a fixed value.`);
  if (unknown.length) throw new ListFeedError(`${list.label} has no field ${unknown.join(', ')}. Its fields are ${list.fields.map(field => field.id).join(', ')}.`);
  const answer = await read(feedUrl, { headers: { accept: FEED_ACCEPT } });
  if (!answer.ok) throw new ListFeedError(`${feedUrl.host} answered ${answer.status} instead of the feed.`);
  const body = await readFeedBody(answer, feedUrl);
  const items = itemsOfFeed(body, itemsAt);
  const ids = rowIdsOf(items.map(item => rawKeyOf(item, key)).filter(raw => raw !== null));
  // Read only the feed's candidate ids, in bounded pages. Reading the list's
  // newest rows misses older held items and reimports them over a person's edit.
  const candidates = [...ids.values()].map(id => prefix + id);
  const held = new Map();
  for (let at = 0; at < candidates.length; at += data.limits.rows_per_read) {
    for (const row of (await lists.read(listId, { row_ids: candidates.slice(at, at + data.limits.rows_per_read) })).rows) held.set(row.id, row.values);
  }
  const seen = new Set();
  const fresh = [], again = [];
  for (const item of items) {
    const raw = rawKeyOf(item, key);
    if (raw === null) continue;
    const id = prefix + ids.get(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    (held.has(id) ? again : fresh).push({ id, item });
  }
  const ranAt = new Date().toISOString();
  const perRun = Number.isInteger(most) && most > 0 ? Math.min(most, data.limits.rows_per_write) : data.limits.feed_items_per_run;
  const now = fresh.slice(0, perRun);
  const into = (typeof folder === 'string' && folder.startsWith('/') ? folder : `/Lists/${list.label}`).replace(/\/+$/, '');
  const written = [];
  for (const { id, item } of now) {
    const row = { ...Object.fromEntries(Object.entries(fixed).map(([fieldId, value]) => [fieldId, keptValue(value)])) };
    for (const [fieldId, selector] of Object.entries(values)) {
      const value = selected(item, selector);
      if (value === undefined || value === null || value === '') continue;
      if (!KINDS.get(fields.get(fieldId).kind)?.media) { row[fieldId] = keptValue(value); continue; }
      const address = httpsAddress(value, feedUrl);
      if (!address) continue;
      const file = await read(address).catch(() => null);
      if (!file?.ok || !file.body) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!bytes.byteLength) continue;
      const name = `${into}/${id}-${decodeURIComponent(address.pathname.split('/').pop() || fieldId)}`;
      await keepFile({ name, size: bytes.byteLength, open: async () => [bytes], media_type: file.headers.get('content-type') || null });
      row[fieldId] = name;
    }
    written.push({ id, values: stamp ? { ...row, [stamp]: ranAt } : row });
  }
  // Rows already there: left alone, unless the feed is asked to keep them current and/or the run is stamped on them.
  const changed = [];
  if (updateExisting || stamp) {
    for (const { id, item } of again) {
      const have = held.get(id) ?? {};
      const row = {};
      if (updateExisting) {
        for (const [fieldId, value] of Object.entries(fixed)) {
          const kept = keptValue(value);
          if (JSON.stringify(kept) !== JSON.stringify(have[fieldId])) row[fieldId] = kept;
        }
        for (const [fieldId, selector] of Object.entries(values)) {
          if (KINDS.get(fields.get(fieldId).kind)?.media) continue;
          const value = selected(item, selector);
          if (value === undefined || value === null || value === '') continue;
          const kept = keptValue(value);
          if (JSON.stringify(kept) !== JSON.stringify(have[fieldId])) row[fieldId] = kept;
        }
      }
      if (!Object.keys(row).length && !stamp) continue;
      changed.push({ id, values: stamp ? { ...row, [stamp]: ranAt } : row, edited: Object.keys(row).length > 0 });
    }
  }
  const actor = { by: 'tool:fill-a-list-from-a-feed' };
  if (written.length) await lists.putRows(listId, { rows: written }, { actor });
  for (let at = 0; at < changed.length; at += data.limits.rows_per_write) {
    await lists.putRows(listId, { rows: changed.slice(at, at + data.limits.rows_per_write).map(({ id, values: row }) => ({ id, values: row })) }, { actor });
  }
  return { list_id: listId, added: written.map(row => row.id), updated: changed.filter(row => row.edited).map(row => row.id), waiting: fresh.length - now.length, read: items.length };
}

// The same items sent to a shared library: one entry per item (id from its key), in batches the library takes at once.
// The library keeps what is new, replaces what changed, and writes nothing for an entry it already holds as sent.
async function fillLibraryFromFeed({ library, read }, { feedUrl, itemsAt, key, values, most, stamp, into, listId, fixed, prefix }) {
  const dataset = into && typeof into === 'object' ? into.dataset : undefined;
  if (typeof dataset !== 'string' || !dataset) throw new ListFeedError('into is { "dataset": the id of a shared library }.');
  if (listId !== undefined) throw new ListFeedError('Send list_id to fill a list or into to fill a shared library, not both.');
  if (stamp !== undefined) throw new ListFeedError('stamp needs a list: a time on every library entry would rewrite every entry on every run.');
  if (!library) throw new ListFeedError('The shared libraries are not reachable from here.');
  const answer = await read(feedUrl, { headers: { accept: FEED_ACCEPT } });
  if (!answer.ok) throw new ListFeedError(`${feedUrl.host} answered ${answer.status} instead of the feed.`);
  const body = await readFeedBody(answer, feedUrl);
  const items = itemsOfFeed(body, itemsAt);
  const ids = rowIdsOf(items.map(item => rawKeyOf(item, key)).filter(raw => raw !== null));
  const seen = new Set();
  const entries = [];
  for (const item of items) {
    const raw = rawKeyOf(item, key);
    if (raw === null) continue;
    const id = prefix + ids.get(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = { id, ...fixed };
    for (const [fieldId, selector] of Object.entries(values)) {
      const value = selected(item, selector);
      if (value !== undefined && value !== null && value !== '') entry[fieldId] = value;
    }
    entries.push(entry);
  }
  const limited = Number.isInteger(most) && most > 0;
  const batch = sharedDatasets.limits.max_bulk_entries;
  const kept = { added: [], replaced: [], unchanged: 0, refused: [], invalid: [] };
  const written = () => kept.added.length + kept.replaced.length;
  let sent = 0;
  // With `most`, entries go in order a batch at a time until `most` are written; entries the library already holds
  // (unchanged) do not count, so a later run reaches the entries after them.
  while (sent < entries.length && (!limited || written() < most)) {
    const part = entries.slice(sent, sent + (limited ? Math.min(batch, most - written()) : batch));
    const answered = await library.add({ dataset, entries: part });
    sent += part.length;
    for (const result of answered.entries) {
      if (result.status === 'added') kept.added.push(result.id);
      else if (result.status === 'replaced') kept.replaced.push(result.id);
      else if (result.status === 'unchanged') kept.unchanged += 1;
      else if (result.status === 'refused') kept.refused.push({ id: result.id, reason: result.reason });
      else kept.invalid.push({ ...(result.id ? { id: result.id } : {}), reason: result.reason });
    }
  }
  return { dataset, ...kept, waiting: entries.length - sent, read: items.length,
    said: `${dataset}: ${kept.added.length} added, ${kept.replaced.length} replaced, ${kept.unchanged} unchanged${kept.refused.length ? `, ${kept.refused.length} refused` : ''}${kept.invalid.length ? `, ${kept.invalid.length} not valid` : ''}.` };
}

// The person's list and its rows are the records the caller gives in `stored.records` (the list's record, and the rows of
// its kind, read by the caller from the person's own store). Nothing is read from or written to a store here: every row
// and file the run makes is answered in `keep`, for the caller to keep where the person keeps it, and later reads in the
// same run see it. A kept row carries `expected` (the record as it was given, or null), so the caller's write is
// conditional and refuses a row it changed meanwhile.
export function givenLists(records = []) {
  const held = new Map((Array.isArray(records) ? records : []).map(record => [record.id, structuredClone(record)]));
  const keep = [];
  const asGiven = new Map();
  const listOf = id => {
    const record = held.get(`list:${id}`);
    return record?.type === 'list' && object(record.value) ? { id, ...structuredClone(record.value) } : null;
  };
  const recordOf = (found, rowId) => `record:${found.row_type}:${rowId}`;
  return {
    keep,
    async read(id, { row_ids: rowIds = [] } = {}) {
      const found = listOf(id);
      if (!found) throw new ListFeedError(`There is no list ${id} in the records given to this run.`);
      const rows = [];
      for (const rowId of rowIds) {
        const record = held.get(recordOf(found, rowId));
        if (record && record.type === `record:${found.row_type}`) rows.push({ id: rowId, values: structuredClone(record.value) });
      }
      return { list: found, rows };
    },
    // Each row's values merged over what it holds now (a null takes the field out), answered in keep.
    async putRows(id, { rows }) {
      const found = listOf(id);
      if (!found) throw new ListFeedError(`There is no list ${id} in the records given to this run.`);
      for (const row of rows) {
        const recordId = recordOf(found, row.id);
        const type = `record:${found.row_type}`;
        if (!asGiven.has(recordId)) asGiven.set(recordId, held.get(recordId) ?? null);
        const value = { ...(held.get(recordId)?.value ?? {}) };
        for (const [field, given] of Object.entries(row.values ?? {})) {
          if (given === null || given === undefined) delete value[field];
          else value[field] = given;
        }
        held.set(recordId, { id: recordId, type, value });
        // expected: the record as the run was given it, so the caller writes only if the store still holds that.
        const was = asGiven.get(recordId);
        keep.push({ id: recordId, type, value, expected: was ? { type: was.type, value: was.value } : null });
      }
      return { written: rows.length, kept: rows.map(row => ({ id: row.id })) };
    },
    async keepFile(file) {
      const bytes = Buffer.concat((await file.open()).map(part => Buffer.from(part)));
      keep.push({ file: file.name, base64: bytes.toString('base64') });
      return { identity: makeHashCodeHexFromBytes(bytes) };
    },
  };
}

/**
 * The installed tool row's function: input is the run's input with `stored` (the records the caller gives). Answers the
 * fill's result plus `keep`. A shared-library host supplies its own admitted add owner through `library`; absent means
 * refused, never a fallback to records.
 */
export async function fillAListFromFeed(input = {}, { library, read = fetch } = {}) {
  const { stored = {}, ...rest } = input ?? {};
  const lists = givenLists(stored?.records);
  const result = await fillListFromFeed({ lists, keepFile: lists.keepFile, library, read }, rest);
  return { ...result, keep: lists.keep };
}
