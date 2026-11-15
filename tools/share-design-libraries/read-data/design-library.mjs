// src/design-library.mjs
//
// PURPOSE
//   Libraries every Trillion account shares for free. Any connected AI adds what it studied (a screen on Mobbin, a
//   component on 21st.dev, a live app or site) and every account's AI searches all of it before it designs. Which
//   libraries exist and what an entry of each holds is DATA (records/shared-dataset-records.json): a second library
//   (landing pages, recipes, anything) is one more row there, never a change here.
//
//   add(input)      { dataset, fields, image? } -> the entry's id, whether it replaced the contributor's earlier one
//                   { dataset, entries: [{ id?, <field>: <value>, ... }] } (up to limits.max_bulk_entries) -> each entry's
//                   id and status (added, replaced, unchanged, refused or invalid with its reason) and the counts; every
//                   entry is checked exactly like a single one and the valid ones are kept in ONE pool call
//   search(input)   { dataset?, query?, filters?, who?: everyone | mine, offset?, limit? } -> { rows, total, offset, limit, datasets }
//   remove(input)   { id } -> removes an entry only the account that added it may remove
//
//   A library whose DATA row says found_by "words" is found by the words asked (a word index in the pool, title
//   weighing most) and its entries are never embedded; every other library is found by meaning. A search naming a
//   library uses that library's way. A search with a query and no library named asks both ways and lists the
//   meaning-found rows first, then the words-found rows, as one list that pages by offset and limit.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a library or a field: ids, fields, required fields, the title, what meaning is read from,
//      what makes a second entry replace the first, and which field allows a picture are the library's DATA row.
//   2. A picture from another library is never kept. A picture is kept only when the library says which field allows
//      one and that field is true for this entry (the AI captured it itself from a public app or page); otherwise the
//      entry keeps the source link and the AI's own observations. Kept bytes are the account's own files under their BLAKE3
//      identity (src/files-by-identity.mjs) and are checked to be a picture by their first bytes, never by what they claim.
//   3. Who added an entry is kept as the account's opaque maker identity in the pool; a reader sees only "You" or a
//      short member code made from it, never the identity, an email or a name. Only that account can remove it.
//   4. Search reuses the pool's embedding model and its one similarity (src/pool.mjs): meaning plus the words asked as
//      written; a library found by its words uses the pool's word index. Nothing here splits words or compares vectors.
//   5. Every refusal says, in plain words, what to change.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';
import { failureOf } from '../../shared-code/src/failure.mjs';

export class LibraryRefusal extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const hexOf = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text)).slice(3);
const listWords = items => (items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items.at(-1)}` : items[0] ?? '');
const fieldIdShape = /^[a-z0-9_]+$/;
const given = value => value !== undefined && value !== null && value !== '';
// What a library's DATA row says when it is found by the words asked (src/pool.mjs keeps the same word).
const FOUND_BY_WORDS = 'words';
const entryIdShape = /^[A-Za-z0-9_.:\/-]{1,200}$/;
// What the pool says of each entry of a bulk add, in the order the counts are said.
const BULK_STATUSES = ['added', 'replaced', 'unchanged', 'refused', 'invalid'];

// One value checked against its field's schema (a JSON Schema fragment from DATA), returned as kept.
function checkedValue(name, schema, value) {
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new LibraryRefusal(`${name} must be true or false.`);
    return value;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new LibraryRefusal(`${name} must be a list.`);
    if (schema.maxItems && value.length > schema.maxItems) throw new LibraryRefusal(`${name} holds at most ${schema.maxItems} items.`);
    return [...new Set(value.map(item => checkedValue(`Each item of ${name}`, schema.items ?? { type: 'string' }, item)))];
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim()) throw new LibraryRefusal(`${name} must be words.`);
    const text = value.trim();
    if (schema.maxLength && text.length > schema.maxLength) throw new LibraryRefusal(`${name} is ${text.length} characters; at most ${schema.maxLength} are kept.`);
    if (schema.enum) {
      const member = schema.enum.find(item => item.toLowerCase() === text.toLowerCase());
      if (!member) throw new LibraryRefusal(`${name} must be ${listWords(schema.enum)}.`);
      return member;
    }
    if (schema.format === 'uri') {
      let url;
      try { url = new URL(text); } catch { throw new LibraryRefusal(`${name} must be a link starting with https://.`); }
      if (!['https:', 'http:'].includes(url.protocol)) throw new LibraryRefusal(`${name} must be a link starting with https://.`);
      return url.toString();
    }
    return text;
  }
  throw new Error(`The library's field ${name} has a kind of value this cannot read (${schema.type}).`);
}

// What a picture sent as `data:<type>;base64,<bytes>` (or bare base64) is, by its first bytes, and its bytes.
function pictureOf(image, rules) {
  if (typeof image !== 'string' || !image.trim()) throw new LibraryRefusal('image must be the picture as base64 text, such as data:image/png;base64,...');
  const encoded = image.trim().replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
  if (Math.floor(encoded.length * 3 / 4) > rules.max_bytes) throw new LibraryRefusal(`The picture is larger than ${Math.round(rules.max_bytes / 1048576)} MB. Send a smaller one.`);
  let binary;
  try { binary = atob(encoded); } catch { throw new LibraryRefusal('image could not be read as base64 text.'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const starts = ({ offset, hex }) => bytesToHex(bytes.subarray(offset, offset + hex.length / 2)) === hex;
  const type = rules.types.find(row => row.signature.every(starts));
  if (!type) throw new LibraryRefusal(`The picture must be ${listWords(rules.types.map(row => row.content_type.replace('image/', '').toUpperCase()))}.`);
  return { bytes, content_type: type.content_type, ref: makeHashCodeHexFromBytes(bytes) };
}

/**
 * pool:    { addLibraryEntry, addLibraryEntries, libraryEntries, removeLibraryEntry } (src/pool.mjs)
 * bytes:   () => { put(ref, bytes) }, this account's files readable by identity (src/files-by-identity.mjs), reached
 *          only when a picture is kept. A removed entry's picture stays one of the account's files: the same bytes may
 *          also be another entry's picture.
 * maker:   this account's opaque maker identity
 * records: the libraries' DATA (records/shared-dataset-records.json)
 */
export function makeSharedLibrary({ pool, bytes, maker, records, fileAddress }) {
  if (!records?.datasets || !maker || typeof fileAddress !== 'function') throw new Error('Supply the current library rows, admitted maker and file-address owner.');
  const datasetOf = id => {
    if (typeof id !== 'string' || !id.trim()) throw new LibraryRefusal(`dataset is needed: ${listWords(records.datasets.map(row => row.id))}.`);
    const row = records.datasets.find(item => item.id === id.trim());
    if (!row) throw new LibraryRefusal(`There is no shared library called ${id}. The libraries are ${listWords(records.datasets.map(item => item.id))}.`, 404);
    return row;
  };

  const fieldsOf = (dataset, sent) => {
    if (!sent || typeof sent !== 'object' || Array.isArray(sent)) throw new LibraryRefusal(`fields is needed: ${Object.keys(dataset.fields).join(', ')}.`);
    const unknown = Object.keys(sent).filter(name => !dataset.fields[name]);
    if (unknown.length) throw new LibraryRefusal(`${dataset.label} has no ${listWords(unknown)}. Its fields are ${Object.keys(dataset.fields).join(', ')}.`);
    const missing = (dataset.required ?? []).filter(name => !given(sent[name]));
    if (missing.length) throw new LibraryRefusal(`${dataset.label} needs ${listWords(missing)}.`);
    return Object.fromEntries(Object.entries(sent).filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => [name, checkedValue(name, dataset.fields[name], value)]));
  };

  // What an entry is found by: its meaning fields under their titles, one per line.
  const meaningOf = (dataset, fields) => dataset.meaning_from.filter(name => fields[name] !== undefined)
    .map(name => `${dataset.fields[name].title ?? name}: ${[fields[name]].flat().join(', ')}`).join('\n');

  // One contributor's second entry for the same thing (the library's one_entry_per fields) replaces their first.
  const entryId = (dataset, fields) => {
    const key = dataset.one_entry_per ?? [];
    const same = key.length && key.every(name => fields[name] !== undefined);
    return `lib_${same ? hexOf(JSON.stringify([dataset.id, maker, key.map(name => fields[name])])).slice(0, 32) : bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
  };

  const addedBy = entryMaker => (entryMaker === maker ? records.added_by.yours
    : records.added_by.others.replace('{code}', hexOf(`shared-library-member:${entryMaker}`).slice(0, 4).toUpperCase()));

  const listed = row => {
    const dataset = records.datasets.find(item => item.id === row.dataset);
    return {
      id: row.id,
      dataset: row.dataset,
      title: row.fields[dataset?.title_field] ?? null,
      fields: row.fields,
      image_url: row.image_ref ? fileAddress(row.image_ref) : null,
      ...(row.image_ref ? { image_type: row.image_type } : {}),
      added_by: addedBy(row.maker),
      yours: row.maker === maker,
      added_at: row.added_at,
      ...(row.similarity !== undefined ? { similarity: row.similarity } : {}),
    };
  };

  // A filter per field a library has; a field no library has is refused.
  const filtersOf = (dataset, sent) => {
    if (!given(sent)) return [];
    if (typeof sent !== 'object' || Array.isArray(sent)) throw new LibraryRefusal('filters must be { field: value }.');
    return Object.entries(sent).filter(([, value]) => given(value)).map(([name, value]) => {
      const schema = (dataset ? [dataset] : records.datasets).map(row => row.fields[name]).find(Boolean);
      if (!schema || !fieldIdShape.test(name)) throw new LibraryRefusal(`No shared library has a field called ${name}.`);
      if (schema.type === 'boolean') {
        const truth = value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
        if (truth === null) throw new LibraryRefusal(`${name} filters by true or false.`);
        return { field: name, many: false, value: truth ? '1' : '0' };
      }
      return { field: name, many: schema.type === 'array', value: String(value).trim().toLowerCase() };
    });
  };

  const whole = (value, name, fallback, max) => {
    if (!given(value)) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || (max !== undefined && number > max)) throw new LibraryRefusal(`${name} must be a whole number${max !== undefined ? ` from 0 to ${max}` : ' from 0'}.`);
    return number;
  };

  // How a library is found, from its DATA row; the pool keeps a words-found entry's title for its word index.
  const foundByWords = dataset => dataset?.found_by === FOUND_BY_WORDS;
  const titleOf = (dataset, fields) => (foundByWords(dataset) && typeof fields[dataset.title_field] === 'string' ? fields[dataset.title_field] : null);

  // Many entries, each `{ id?, <field>: <value> }`: each checked as a single one is, the valid ones kept in one pool call.
  async function addMany(input) {
    const dataset = datasetOf(input.dataset);
    if (input.fields !== undefined) throw new LibraryRefusal('Send fields for one entry or entries for many, not both.');
    const most = records.limits.max_bulk_entries;
    if (!Array.isArray(input.entries) || !input.entries.length) throw new LibraryRefusal(`entries is a list of 1 to ${most} entries, each with the library's fields.`);
    if (input.entries.length > most) throw new LibraryRefusal(`entries holds ${input.entries.length}; at most ${most} are kept in one call. Send the rest in another call.`);
    const results = [], valid = [], at = [];
    input.entries.forEach((sent, index) => {
      try {
        if (!sent || typeof sent !== 'object' || Array.isArray(sent)) throw new LibraryRefusal(`Entry ${index + 1} must be { field: value }.`);
        const { id: sentId, ...sentFields } = sent;
        if (given(sentId) && (typeof sentId !== 'string' || !entryIdShape.test(sentId))) throw new LibraryRefusal('id is letters, numbers and - _ . : / only, up to 200 characters.');
        const fields = fieldsOf(dataset, sentFields);
        const id = given(sentId) ? sentId : entryId(dataset, fields);
        valid.push({ id, dataset: dataset.id, maker, fields, meaning: meaningOf(dataset, fields), title: titleOf(dataset, fields), by_words: foundByWords(dataset) });
        at.push(results.length);
        results.push(null);
      } catch (error) {
        if (!(error instanceof LibraryRefusal)) throw error;
        results.push({ index, ...(given(sent?.id) ? { id: sent.id } : {}), status: 'invalid', reason: error.message });
      }
    });
    const kept = valid.length ? await pool.addLibraryEntries(valid) : [];
    kept.forEach((result, position) => { results[at[position]] = { index: at[position], id: result.id, status: result.status, ...(result.reason ? { reason: result.reason } : {}) }; });
    const counts = Object.fromEntries(BULK_STATUSES.map(status => [status, results.filter(result => result.status === status).length]));
    return { dataset: dataset.id, entries: results, counts, said: `${dataset.label}: ${listWords(BULK_STATUSES.filter(status => counts[status]).map(status => `${counts[status]} ${status}`)) || 'nothing to add'}.` };
  }

  // The pool asked the way a library is found: one library by its own way, no library named by both ways.
  async function ask(dataset, query, filters, offset, limit, who) {
    const rules = { query, filters, ...(who === 'mine' ? { maker } : {}), min_similarity: records.search.min_similarity, words_bonus: records.search.words_bonus };
    if (dataset) return pool.libraryEntries({ ...rules, dataset: dataset.id, offset, limit, by_words: foundByWords(dataset) });
    const ways = [records.datasets.some(row => !foundByWords(row)) || !query, records.datasets.some(foundByWords) && Boolean(query)];
    if (!ways[1]) return pool.libraryEntries({ ...rules, dataset: null, offset, limit });
    // Each way answers its best offset + limit, so the one list pages by offset and limit whatever mix it holds.
    const [byMeaning, byWords] = await Promise.all([ways[0] ? pool.libraryEntries({ ...rules, dataset: null, offset: 0, limit: offset + limit }) : { total: 0, rows: [] },
      pool.libraryEntries({ ...rules, dataset: null, offset: 0, limit: offset + limit, by_words: true })]);
    return { total: byMeaning.total + byWords.total, rows: [...byMeaning.rows, ...byWords.rows].slice(offset, offset + limit),
      ...(byMeaning.matched_by_words ? { matched_by_words: byMeaning.matched_by_words } : {}) };
  }

  return {
    async add(input = {}) {
      if (input.entries !== undefined) return addMany(input);
      const dataset = datasetOf(input.dataset);
      const fields = fieldsOf(dataset, input.fields);
      let picture = null;
      if (given(input.image)) {
        const allowedBy = dataset.image?.kept_only_when;
        if (!allowedBy) throw new LibraryRefusal(`${dataset.label} keeps no pictures. Leave image out.`);
        if (fields[allowedBy] !== true) throw new LibraryRefusal(`A picture is kept only when you captured it yourself from a public app or page (${allowedBy}: true). A picture from another library, such as Mobbin, is never kept: leave image out and the link and your observations are kept.`);
        picture = pictureOf(input.image, records.image);
        await bytes().put(picture.ref, picture.bytes);
      }
      const id = entryId(dataset, fields);
      const kept = await pool.addLibraryEntry({ id, dataset: dataset.id, maker, fields, meaning: meaningOf(dataset, fields), title: titleOf(dataset, fields),
        by_words: foundByWords(dataset), image_ref: picture?.ref ?? null, image_type: picture?.content_type ?? null });
      return {
        id,
        dataset: dataset.id,
        replaced: kept.replaced,
        added_at: kept.added_at,
        image_url: picture ? fileAddress(picture.ref) : null,
        said: kept.replaced ? `Your earlier entry for this in ${dataset.label} was replaced. Every Trillion account can find it.` : `Added to ${dataset.label}. Every Trillion account can find it now.`,
      };
    },

    async search(input = {}) {
      const dataset = given(input.dataset) ? datasetOf(input.dataset) : null;
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (query.length > records.limits.max_query_characters) throw new LibraryRefusal(`query is ${query.length} characters; at most ${records.limits.max_query_characters} are read.`);
      const offset = whole(input.offset, 'offset', 0);
      const limit = Math.max(1, whole(input.limit, 'limit', records.limits.default_limit, records.limits.max_limit));
      const who = input.who ?? 'everyone';
      if (!['everyone', 'mine'].includes(who)) throw new LibraryRefusal('Choose everyone or mine for who.');
      const found = await ask(dataset, query, filtersOf(dataset, input.filters), offset, limit, who);
      return {
        rows: found.rows.map(listed),
        total: found.total,
        ...(found.matched_by_words ? { matched_by_words: found.matched_by_words } : {}),
        offset,
        limit,
        datasets: records.datasets.map(row => ({
          id: row.id,
          label: row.label,
          description: row.description,
          title_field: row.title_field,
          fields: Object.entries(row.fields).map(([id, schema]) => ({ id, label: schema.title ?? id, type: schema.type, ...(schema.enum ? { choices: schema.enum } : {}) })),
        })),
      };
    },

    async remove(input = {}) {
      if (typeof input.id !== 'string' || !input.id.trim()) throw new LibraryRefusal('id is needed: the id add_to_shared_library returned, or one of your rows from search_shared_library.');
      const removed = await pool.removeLibraryEntry({ id: input.id.trim(), maker });
      if (!removed.removed) throw new LibraryRefusal('None of your entries has that id. Only the account that added an entry can remove it.', 404);
      return { removed: true, id: input.id.trim() };
    },
  };
}

// Current publication is read afresh for every operation. No bundled library content is a fallback.
export function makeMarketplaceSharedLibrary({ readRecords, current = async () => {}, ...supplies }) {
  if (typeof readRecords !== 'function') throw new Error('Supply the current library row owner.');
  return Object.fromEntries(['add', 'search', 'remove'].map(operation => [operation, async (...args) => {
    const records = await readRecords();
    await current();
    return makeSharedLibrary({ ...supplies, records })[operation](...args);
  }]));
}

// The person-store routes the MCP tools and the web app reach.
//   GET  /shared-library?dataset=&q=&who=&offset=&limit=&<field>=<value>   search (any other parameter filters by a field)
//   POST /shared-library/search   { dataset?, query?, filters?, who?, offset?, limit? }
//   POST /shared-library          { dataset, fields, image? } or { dataset, entries: [{ id?, <field>: <value> }] }
//   POST /shared-library/remove   { id }
const SEARCH_PARAMETERS = new Set(['dataset', 'q', 'offset', 'limit', 'who']);

export async function handleSharedLibraryRequest(library, request) {
  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/shared-library') {
      const filters = Object.fromEntries([...url.searchParams].filter(([name]) => !SEARCH_PARAMETERS.has(name)));
      return Response.json(await library.search({ dataset: url.searchParams.get('dataset'), query: url.searchParams.get('q') ?? '', offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit'), who: url.searchParams.get('who') ?? 'everyone', filters }));
    }
    if (request.method === 'POST') {
      const body = await request.json().catch(() => { throw new LibraryRefusal('The request could not be read.'); });
      if (url.pathname === '/shared-library') return Response.json(await library.add(body));
      if (url.pathname === '/shared-library/search') return Response.json(await library.search(body));
      if (url.pathname === '/shared-library/remove') return Response.json(await library.remove(body));
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    // Busy, interrupted or out-of-budget is the shared HTTP failure owner's to answer, never a refusal here.
    if (failureOf(error).tries_again_later) throw error;
    return Response.json({ error: error.message }, { status: error instanceof LibraryRefusal ? error.status : 502 });
  }
}

const libraryList = records => records.datasets.map(row => `${row.id} (${row.label}: ${row.description}) with fields ${Object.entries(row.fields)
  .map(([id, schema]) => `${id}${(row.required ?? []).includes(id) ? ' (needed)' : ''}: ${schema.description ?? schema.title}${schema.enum ? ` One of ${schema.enum.join(', ')}.` : ''}`).join(' ')}`).join('; ');

export const sharedLibraryTools = (call, records) => [
  { name: 'add_to_shared_library', description: `Adds what you studied to a library every Trillion account shares for free, so every person's AI finds it when it designs. Whenever you study a screen (on Mobbin, 21st.dev, or a live app or site), add your own observations here. The libraries: ${libraryList(records)}. Never send a picture you did not capture yourself: a picture from another library (Mobbin and the like) is refused, and its link plus your observations are what is kept. A picture you captured yourself from a public app or page goes in image as data:image/png;base64,... with captured_by_contributor true. Adding the same thing again (same ${listWords([...new Set(records.datasets.flatMap(row => row.one_entry_per ?? []))])}) replaces your earlier entry. Returns the entry's id; remove_from_shared_library takes it back. To add many at once, send entries instead of fields: up to ${records.limits.max_bulk_entries} in one call, each entry the library's fields (and an id of your own if you want one), each checked on its own; the answer gives every entry's id and whether it was added, replaced, unchanged (already there exactly so, nothing written), refused or invalid with the reason, and a count of each. Entries carry no pictures.`,
    inputSchema: { type: 'object', required: ['dataset'], properties: {
      dataset: { type: 'string', enum: records.datasets.map(row => row.id) },
      fields: { type: 'object', description: 'The library\'s fields, as listed above, for one entry. Send this or entries.' },
      entries: { type: 'array', minItems: 1, maxItems: records.limits.max_bulk_entries, description: `Many entries in one call (at most ${records.limits.max_bulk_entries}): each is { id?, <field>: <value>, ... } with the library's fields. Send this or fields.`, items: { type: 'object' } },
      image: { type: 'string', description: 'Only a picture you captured yourself: data:image/png;base64,... (PNG, JPEG, GIF or WebP).' },
    } },
    run: input => call('/shared-library', input ?? {}) },
  { name: 'search_shared_library', description: `Searches the libraries every Trillion account shares (${records.datasets.map(row => `${row.id}: ${row.label}`).join(', ')}) by meaning and by the words you give. Search here before you design a screen, and build on what others' AIs already studied. Leave query out for the newest entries. filters narrows by a field, such as { "platform": "ios" } or { "patterns": "bottom sheet" }. Returns rows (each with id, dataset, title, fields, image_url when its contributor captured a picture, added_by and whether it is yours), total, and the libraries with their fields. Page with offset and limit (at most ${records.limits.max_limit}). It changes nothing.`,
    inputSchema: { type: 'object', properties: {
      dataset: { type: 'string', enum: records.datasets.map(row => row.id) },
      query: { type: 'string' },
      who: { type: 'string', enum: ['everyone', 'mine'], description: 'Choose mine to count and page only this account’s contributions.' },
      filters: { type: 'object', additionalProperties: { type: ['string', 'boolean'] } },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: records.limits.max_limit },
    } },
    run: input => call('/shared-library/search', input ?? {}) },
  { name: 'remove_from_shared_library', description: 'Removes one of your own entries from a shared library, so no account finds it any more. Only the account that added an entry can remove it. id is what add_to_shared_library returned, or a row of search_shared_library marked yours.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: input => call('/shared-library/remove', input ?? {}) },
];

export const sharedLibraryAnnotations = {
  add_to_shared_library: { title: 'Add to the shared library', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  search_shared_library: { title: 'Search the shared library', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  remove_from_shared_library: { title: 'Remove my entry from the shared library', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};
