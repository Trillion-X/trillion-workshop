// src/list-people.mjs
//
// Purpose: people sent from a source (a Mac's Contacts through computer/sync-contacts.zsh, or any program or AI with a
// personal key) kept as rows of one of the person's lists, through the lists owner (src/lists.mjs), each person once:
// matched by a shared phone number or email, else by a name only one row and one person have, else the row that
// source made for them, else added; a source's own row folds into the person's other row once one is found.
//
//   POST /lists/<list>/people   { list_label?, source: { id, label }, people: [{ key, name?, phones?, emails?,
//                                 organization?, job_title? }] }
//                               → { list_id, added, updated, unchanged, folded, fields }
//
// Non-Negotiable Invariants:
//   1. Rows go in only through the lists owner's putRows, so a row here is the same record the Lists screen shows and
//      every list tool reads; nothing keeps a second copy of anyone.
//   2. Which list fields a person's values fill, and how each merges, are DATA (src/list-people.json). A list that
//      already has a matching field (same id or name, a name it is also known by, or the same kind for kinds only one
//      field would hold, such as a phone) is filled there; only a field it lacks is added, so no near-duplicate appears.
//   3. A list that does not exist is made with the label the source sends; an existing list keeps its label and rows.
//   4. Only changed values are written (trillion-workshop: tools/person-list/do-work/merge-people.mjs), so a repeated sync writes nothing.
//
// Security: the person's own store, reached with their own key; the source names only itself and the list, never
// another person's records.
//
import settings from './list-people.json' with { type: 'json' };
import listsData from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { ListsError } from '../../keep-lists-of-rows/lists.mjs';
import { mergePeople } from '../../person-list/do-work/merge-people.mjs';

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VALUE_OF_KIND = new Map(listsData.field_kinds.map(kind => [kind.id, kind.value]));
const TAKES_WORDS = new Set(['text', 'texts']);
const { limits } = settings;

const say = (key, values = {}) => new ListsError(settings.words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? '')));
const slug = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const clip = value => (typeof value === 'string' ? value.trim().slice(0, limits.text_chars) : undefined);
const clips = value => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).map(clip).filter(Boolean).slice(0, limits.values_per_person);

/** One person as sent, cleaned: the values the fills read, each clipped; refused without a key. */
function personOf(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw say('bad_people', { limit: limits.people_per_request });
  const key = clip(typeof raw.key === 'number' ? String(raw.key) : raw.key);
  if (!key) throw say('bad_person', { index });
  const person = { key };
  for (const fill of settings.fills) {
    if (fill.merge === 'union') continue;
    person[fill.from] = fill.merge === 'keys' ? clips(raw[fill.from]) : clip(raw[fill.from]);
  }
  return person;
}

/** The list field each fill lands in: the list's own matching field, or a field the list does not have yet. */
export function fieldsFor(list) {
  const fields = list?.fields ?? [];
  const taken = new Set();
  return settings.fills.map(fill => {
    const names = new Set([fill.field.id, fill.field.label, ...(fill.also_named ?? [])].map(slug));
    const titled = fill.title && list?.title_field ? fields.find(field => field.id === list.title_field) : null;
    // Only a field that holds words can take a person's values; a number or a link to other rows never matches.
    const open = field => !taken.has(field.id) && TAKES_WORDS.has(VALUE_OF_KIND.get(field.kind ?? 'text'));
    const found = titled
      ?? fields.find(field => open(field) && (names.has(slug(field.id)) || names.has(slug(field.label))))
      ?? (fill.same_kind ? fields.find(field => open(field) && field.kind === fill.field.kind) : null);
    // A field the list lacks takes the first id no field of the list already has.
    const ids = new Set(fields.map(item => item.id));
    let free = fill.field.id;
    for (let at = 2; ids.has(free); at += 1) free = `${fill.field.id}_${at}`;
    const field = found ?? { ...fill.field, id: free };
    taken.add(field.id);
    return { fill, field, adding: !found };
  });
}

/**
 * eeaf:  the person's EEAF store (rows are read there, as the lists owner reads them)
 * lists: makeLists over the same store
 */
export async function keepPeopleInList({ eeaf, lists }, listId, input, { actor } = {}) {
  const source = input?.source;
  if (!source || !NAME.test(String(source.id ?? '')) || typeof source.label !== 'string' || !source.label.trim()) throw say('bad_source');
  if (!Array.isArray(input.people) || input.people.length > limits.people_per_request) throw say('bad_people', { limit: limits.people_per_request });
  const people = input.people.map(personOf);
  const sourceNamed = { id: source.id, label: source.label.trim().slice(0, limits.text_chars) };

  const listKey = String(listId ?? '').replace(new RegExp(`^${listsData.record_type}:`), '');
  if (!NAME.test(listKey)) throw new ListsError(listsData.words.bad_id.replace('{id}', JSON.stringify(listId)));
  let list = eeaf.read(`${listsData.record_type}:${listKey}`);
  if (!list) {
    if (typeof input.list_label !== 'string' || !input.list_label.trim()) throw say('needs_label', { list_id: listKey });
    const planned = fieldsFor(null);
    list = (await lists.save({ id: listKey, label: input.list_label.trim(), fields: planned.map(item => item.field), title_field: planned.find(item => item.fill.title).field.id }, { actor })).list;
  }
  const planned = fieldsFor(list);
  if (planned.some(item => item.adding)) {
    list = (await lists.save({ id: listKey, fields: [...list.fields, ...planned.filter(item => item.adding).map(item => item.field)] }, { actor })).list;
  }

  const prefix = `record:${list.row_type}:`;
  const rows = eeaf.ids(`record:${list.row_type}`).map(id => ({ id: id.slice(prefix.length), values: eeaf.read(id) })).filter(row => row.values);
  const fills = planned.map(({ fill, field }) => ({ ...fill, field_id: field.id, as_list: VALUE_OF_KIND.get(field.kind ?? 'text') === 'texts' }));
  const merged = mergePeople({ rows, fills, source: sourceNamed, people });
  // Rows are kept first and folded rows removed last, so a write that fails part way can leave a duplicate but never
  // loses anyone.
  const operations = [...merged.writes.map(row => ({ row })), ...merged.removes.map(remove => ({ remove }))];
  for (let at = 0; at < operations.length; at += listsData.limits.rows_per_write) {
    const chunk = operations.slice(at, at + listsData.limits.rows_per_write);
    await lists.putRows(listKey, { rows: chunk.filter(item => item.row).map(item => item.row), remove: chunk.filter(item => item.remove).map(item => item.remove) }, { actor });
  }
  return { list_id: listKey, list_label: list.label, added: merged.added, updated: merged.updated, unchanged: merged.unchanged, folded: merged.removes.length, fields: planned.map(item => item.field.id) };
}

export const isListPeoplePath = path => /^\/lists\/[^/]+\/people$/.test(path);

// POST /lists/<list>/people from the person's store; the actor is the app that asked.
export async function handleListPeopleRequest(owners, request) {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 });
  try {
    const raw = await request.text();
    if (raw.length > limits.body_bytes) throw say('too_large', { limit: limits.people_per_request });
    const listId = decodeURIComponent(path.split('/')[2]);
    return Response.json(await keepPeopleInList(owners, listId, JSON.parse(raw || '{}'), { actor: { by: request.headers.get('x-trillion-app') || 'list-people' } }));
  } catch (error) {
    const known = error instanceof ListsError || error instanceof SyntaxError;
    return Response.json({ error: error.message }, { status: known ? 400 : 500 });
  }
}
