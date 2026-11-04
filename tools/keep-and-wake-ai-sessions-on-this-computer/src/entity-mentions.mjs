// Resolve an arrival's words against this person's existing list rows. Source words remain in message.text.
// List titles and alias fields are data; no carrier, person, or list name is built into the matcher.
//
// The names are looked up in an index kept beside the rows, never found by reading the rows: one record per spelling
// (`entity-spelling:<hash>`: the rows that spelling names, at most `candidates_read` of them and how many there are),
// one per row (`entity-row:<row>`: the spellings it was indexed under, to take them back when it changes) and one per
// list (`entity-list:<list>`: how far its rows were indexed). Checking a message costs the spellings it could hold, one
// read by id, whatever the person keeps in their lists. src/lists.mjs indexes the rows it writes as it writes them;
// the rows a list already held are indexed `build_page` at a time, one step whenever words are checked, until every list
// is built (a name in a row not indexed yet is found once its step has come). Before this, every check read every row of
// every titled list (2026-10-08: the inbound road was one of the reads that kept the person's store out of memory).
// A spelling's row is read again before it is believed, so an index entry left by a row changed some other way names
// nothing. Which spellings exist at all is held in memory beside the store (`spelledOf`, the ids of every spelling
// record, read once by id alone and kept current by every write here), so a long transcript looks up only the spans
// that are someone's spelling: before it, every span of up to `longest_name_words` words was a lookup, about eight
// for every word said, nearly all of them for spellings nobody has (2026-10-10: receive:mentions read 37,000 to
// 80,000 rows for one long recording). The set may hold a spelling since taken back (its lookup then finds nothing),
// never miss one, so the names found are the same.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import bounds from './entity-mentions.json' with { type: 'json' };

const word = /[\p{L}\p{N}]+/gu;
const normalized = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().match(word)?.join(' ') ?? '';
const aliasField = field => /^(alias(?:es)?|nicknames?|also known as|aka)$/i.test(String(field.id ?? '').replace(/[_-]/g, ' '))
  || /^(alias(?:es)?|nicknames?|also known as|aka)$/i.test(String(field.label ?? ''));
const strings = value => Array.isArray(value) ? value.flatMap(strings) : typeof value === 'string' ? value.split(/[,;\n]/).map(part => part.trim()).filter(Boolean) : [];

const SPELLING = 'entity-spelling';
const ROW = 'entity-row';
const LIST = 'entity-list';
const spellingId = key => `${SPELLING}:${bytesToHex(blake3(new TextEncoder().encode(key))).slice(0, 32)}`;
const rowKeyId = recordId => `${ROW}:${recordId}`;
const stateId = slug => `${LIST}:${slug}`;
const by = { by: 'entity-index' };

// The id of every spelling record each store holds, read once by id alone (`spelling_ids_page` at a time) and added to
// by every spelling written here; none for a store that cannot list ids by type, which then looks every span up.
const spelled = new WeakMap();
function spelledOf(eeaf) {
  if (spelled.has(eeaf)) return spelled.get(eeaf);
  if (typeof eeaf.ids !== 'function') return null;
  const ids = new Set();
  for (let before; ;) {
    const page = eeaf.ids(SPELLING, { limit: bounds.spelling_ids_page, ...(before ? { before } : {}) });
    for (const id of page) ids.add(id);
    if (page.length < bounds.spelling_ids_page) break;
    before = page.at(-1);
  }
  spelled.set(eeaf, ids);
  return ids;
}

// Top-level fields of the records of `type` among `ids` ({ id → { ...fields } }); a store without field reads reads them whole.
function fieldsOf(eeaf, type, ids, names) {
  if (eeaf.fields?.fieldsOf) return eeaf.fields.fieldsOf(type, ids, names);
  return new Map(ids.map(id => [id, eeaf.read(id)]).filter(([, value]) => value));
}

/** The spellings one row is known by, { spelling → 'name' | 'alias' } (an alias that spells the title is the alias), none when its title is no name. */
function spellingsOfRow(list, values) {
  const title = values?.[list.title_field];
  if (typeof title !== 'string' || !normalized(title)) return new Map();
  const fields = (list.fields ?? []).filter(aliasField).map(field => field.id);
  const found = new Map();
  for (const [label, match] of [[title, 'name'], ...fields.flatMap(field => strings(values[field]).map(alias => [alias, 'alias']))]) {
    const key = normalized(label);
    if (key) found.set(key, match);
  }
  return found;
}

const nameOf = (list, values) => values?.[list.title_field];

/**
 * Brings the index to what `rows` now hold: `rows` is a Map of a row's record id to its values, or to null once removed.
 * Every spelling a row was indexed under that it no longer has is taken back, every spelling it has is put.
 */
export function indexEntityRows(eeaf, slug, list, rows) {
  const writes = entityIndexWrites(eeaf, slug, list, rows);
  if (writes.length) eeaf.write(writes, { actor: by, unwatched: true });
  entityIndexWritten(eeaf, writes);
}

/** The index records that bring it to what `rows` will hold, read before the rows are written, so src/lists.mjs writes
 *  them in the same write as the rows (one log row for a save, not two); entityIndexWritten(eeaf, writes) once kept. */
export function entityIndexWrites(eeaf, slug, list, rows) {
  if (!list?.title_field || !list?.row_type || !rows.size) return [];
  const recordIds = [...rows.keys()];
  const held = fieldsOf(eeaf, ROW, recordIds.map(rowKeyId), ['keys']);
  const before = new Map(recordIds.map(recordId => [recordId, new Set(JSON.parse(held.get(rowKeyId(recordId))?.keys ?? '[]'))]));
  const after = new Map(recordIds.map(recordId => [recordId, spellingsOfRow(list, rows.get(recordId))]));
  const keys = new Set([...before.values()].flatMap(set => [...set]).concat([...after.values()].flatMap(map => [...map.keys()])));
  const spellings = fieldsOf(eeaf, SPELLING, [...keys].map(spellingId), ['count', 'rows']);
  const changed = new Map();
  for (const key of keys) {
    const kept = spellings.get(spellingId(key));
    changed.set(key, { count: kept?.count ?? 0, entries: JSON.parse(kept?.rows ?? '[]') });
  }
  for (const recordId of recordIds) {
    const was = before.get(recordId);
    const now = after.get(recordId);
    for (const key of was) {
      const spelling = changed.get(key);
      if (now.has(key)) continue;
      spelling.entries = spelling.entries.filter(entry => entry.record_id !== recordId);
      spelling.count = Math.max(0, spelling.count - 1);
    }
    for (const [key, match] of now) {
      const spelling = changed.get(key);
      const entry = { record_id: recordId, list_id: slug, name: nameOf(list, rows.get(recordId)), match };
      const place = spelling.entries.findIndex(other => other.record_id === recordId);
      if (place >= 0) spelling.entries[place] = entry;
      else if (!was.has(key)) {
        spelling.count += 1;
        if (spelling.entries.length < bounds.candidates_read) spelling.entries.push(entry);
      }
    }
  }
  const writes = [];
  for (const [key, spelling] of changed) {
    writes.push({ id: spellingId(key), type: SPELLING, value: spelling.count > 0 ? { key, count: spelling.count, rows: JSON.stringify(spelling.entries) } : null });
  }
  for (const recordId of recordIds) {
    const now = [...after.get(recordId).keys()];
    if (now.length || before.get(recordId).size) writes.push({ id: rowKeyId(recordId), type: ROW, value: now.length ? { keys: JSON.stringify(now) } : null });
  }
  return writes;
}

/** The spellings just kept are known to exist (spelledOf). */
export function entityIndexWritten(eeaf, writes) {
  const known = spelled.get(eeaf);
  if (known) for (const write of writes) if (write.type === SPELLING && write.value) known.add(write.id);
}

// The stores whose every list is fully indexed, last time they were looked at: an arrival then costs no walk of the
// list records. A list made or changed (entityListChanged) or removed puts its store back to be looked at.
const settled = new WeakSet();

// Presentation changes preserve the index when the fields that supply spellings are unchanged.
const matchingSchema = list => JSON.stringify([list?.row_type ?? null, list?.title_field ?? null,
  [...new Set((list?.fields ?? []).filter(aliasField).map(field => field.id))].sort()]);

/** A list's definition changed (its title or alias fields, or it was just made): its rows are indexed again from the start. */
export function entityListChanged(eeaf, slug, before, after) {
  if (before && matchingSchema(before) === matchingSchema(after)) return;
  settled.delete(eeaf);
  eeaf.write([{ id: stateId(slug), type: LIST, value: { complete: false, before: '' } }], { actor: by, unwatched: true });
}

/** A list was removed: nothing of it is believed any more, and a list made again under its name is indexed from the start. */
export function entityListRemoved(eeaf, slug) {
  settled.delete(eeaf);
  if (eeaf.read(stateId(slug))) eeaf.write([{ id: stateId(slug), type: LIST, value: null }], { actor: by, unwatched: true });
}

/** One step of indexing for each list not fully indexed: its next `build_page` rows, newest first. */
function buildStep(eeaf) {
  if (typeof eeaf.ids !== 'function' || settled.has(eeaf)) return;
  const slugs = eeaf.ids('list').map(id => id.slice('list:'.length));
  if (!slugs.length) { settled.add(eeaf); return; }
  const states = fieldsOf(eeaf, LIST, slugs.map(stateId), ['complete', 'before']);
  let unfinished = false;
  for (const slug of slugs) {
    const state = states.get(stateId(slug));
    if (state?.complete === true) continue;
    const list = eeaf.read(`list:${slug}`);
    if (!list?.title_field || !list?.row_type) { eeaf.write([{ id: stateId(slug), type: LIST, value: { complete: true, before: '' } }], { actor: by, unwatched: true }); continue; }
    const ids = eeaf.ids(`record:${list.row_type}`, { limit: bounds.build_page, ...(state?.before ? { before: state.before } : {}) });
    indexEntityRows(eeaf, slug, list, new Map(ids.map(id => [id, eeaf.read(id)])));
    eeaf.write([{ id: stateId(slug), type: LIST, value: { complete: ids.length < bounds.build_page, before: ids.at(-1) ?? state?.before ?? '' } }], { actor: by, unwatched: true });
    if (ids.length >= bounds.build_page) unfinished = true;
  }
  if (!unfinished) settled.add(eeaf);
}

/** The one row each of `keys` names, { spelling → { id, kind, name, list_id, match } }; a spelling of no row or of several is left out. */
function namedRows(eeaf, keys) {
  const known = spelledOf(eeaf);
  if (known) keys = keys.filter(key => known.has(spellingId(key)));
  if (!keys.length) return new Map();
  const found = fieldsOf(eeaf, SPELLING, keys.map(spellingId), ['key', 'count', 'rows']);
  const lists = new Map();
  const named = new Map();
  for (const key of keys) {
    const kept = found.get(spellingId(key));
    if (!kept || kept.key !== key || kept.count !== 1) continue;
    const [entry, ...others] = JSON.parse(kept.rows ?? '[]');
    if (!entry || others.length) continue;
    if (!lists.has(entry.list_id)) lists.set(entry.list_id, eeaf.read(`list:${entry.list_id}`));
    const list = lists.get(entry.list_id);
    const values = list?.title_field && list?.row_type ? eeaf.read(entry.record_id) : null;
    const match = values ? spellingsOfRow(list, values).get(key) : undefined;
    if (match) named.set(key, { id: entry.record_id, kind: 'record', name: nameOf(list, values), list_id: entry.list_id, match });
  }
  return named;
}

/** Exact title or explicitly recorded alias, only when it names one row. No phone-number inference. */
export function resolveKnownEntities(eeaf, raw) {
  const text = String(raw ?? '');
  const tokens = [...text.matchAll(word)].map(found => ({ said: found[0], start: found.index, end: found.index + found[0].length }));
  if (!tokens.length) return { text, mentions: [] };
  buildStep(eeaf);
  const mentions = [];
  // The spellings the words could hold, looked up `words_per_read` words at a time (a long note is read in steps).
  const spans = new Map();
  for (let at = 0; at < tokens.length; at++) {
    for (let end = Math.min(tokens.length, at + bounds.longest_name_words); end > at; end--) spans.set(`${at}:${end}`, normalized(text.slice(tokens[at].start, tokens[end - 1].end)));
  }
  const named = new Map();
  // Remember misses and matches for this resolution only; the next arrival reads the current index.
  const checked = new Set();
  for (let from = 0; from < tokens.length; from += bounds.words_per_read) {
    const wanted = new Set();
    for (let at = from; at < Math.min(tokens.length, from + bounds.words_per_read); at++) {
      for (let end = Math.min(tokens.length, at + bounds.longest_name_words); end > at; end--) {
        const key = spans.get(`${at}:${end}`);
        if (key && !checked.has(key)) { checked.add(key); wanted.add(key); }
      }
    }
    if (wanted.size) for (const [key, row] of namedRows(eeaf, [...wanted])) named.set(key, row);
  }
  for (let at = 0; at < tokens.length;) {
    let found = null;
    for (let end = Math.min(tokens.length, at + bounds.longest_name_words); end > at; end--) {
      const candidate = named.get(spans.get(`${at}:${end}`));
      if (!candidate) continue;
      // A lone common title is too weak unless the row owner recorded it as an alias.
      if (end === at + 1 && candidate.match !== 'alias') continue;
      found = { start: tokens[at].start, end: tokens[end - 1].end, said: text.slice(tokens[at].start, tokens[end - 1].end), ...candidate };
      at = end;
      break;
    }
    if (found) mentions.push(found);
    else at++;
  }
  let corrected = text;
  for (const mention of [...mentions].reverse()) {
    if (mention.said !== mention.name) corrected = `${corrected.slice(0, mention.start)}${mention.name}${corrected.slice(mention.end)}`;
  }
  return { text: corrected, mentions };
}

/** Replaces only this resolver's projection and links; edits cannot leave stale entity links. */
export function resolveKeptMessage(eeaf, messageId) {
  const message = eeaf.read(messageId);
  if (!message || typeof message.text !== 'string') return null;
  const resolved = resolveKnownEntities(eeaf, message.text);
  const prior = message.entity_resolution;
  if (!resolved.mentions.length && !prior) return null;
  const about = (message.about ?? []).filter(link => link.via !== 'entity-ingest');
  const present = new Set(about.map(link => `${link.kind}\n${link.id}`));
  for (const mention of resolved.mentions) {
    const key = `${mention.kind}\n${mention.id}`;
    if (!present.has(key)) { about.push({ kind: mention.kind, id: mention.id, via: 'entity-ingest' }); present.add(key); }
  }
  const entity_resolution = resolved.mentions.length ? { text: resolved.text, mentions: resolved.mentions, source: 'known-list-row', version: 1 } : null;
  if (JSON.stringify(prior) !== JSON.stringify(entity_resolution) || JSON.stringify(message.about ?? []) !== JSON.stringify(about))
    eeaf.write([{ id: messageId, type: 'message', value: entity_resolution ? { ...message, about, entity_resolution } : { ...message, about, entity_resolution: undefined } }], { actor: { by: 'entity-ingest', app: message.app }, unwatched: true });
  return entity_resolution;
}
