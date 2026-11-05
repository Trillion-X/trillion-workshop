// src/place-lists.mjs
//
// Purpose: the places an account chooses among (where a list is kept) are rows of one of its own lists, never a file in
// Trillion's source. Each kind of places list (src/place-lists.json) is an ordinary list: the account's own rows are
// its own, and the default rows are what the default publishers published on the kind's shelf, shown beside them by
// the published-defaults row source. placeFor (src/placement.mjs) chooses among the rows the list answers now, so a
// person or an AI who edits a row changes the next choice with no deploy, and connecting a cloud or a device is adding
// a row.
//
// Non-Negotiable Invariants:
//   1. No place is named in source: a place is a row the account keeps or a published default row.
//   2. The rows are read through the caller's list owner, under the caller's request; a row whose implementation is not
//      installed here is never chosen (the caller filters by its installed implementations).
//   3. An own row with the same id as a default row is used instead of it; a default row is never written into the
//      account's records.
//   4. Reading is bounded: at most `most_places` rows, a page at a time.
//
//   PLACE_KINDS: kind id → { list, facts, parts, otherwise }
//   ensurePlaceList(lists, kindId, { actor }) → the list made once when missing, its rows from the published defaults
//   placesOf(lists, kindId) → Promise<{ places, jobs, otherwise, facts }>  (the shape placeFor reads)
//   publishedDefaultRows({ published }) → a row source: the default publishers' rows on the list's shelf
//   shelfOf(list) → the Marketplace shelf a list's rows are published on
//   publishableRows(list, rows) → [{ id, values }] ready to publish
import data from './place-lists.json' with { type: 'json' };

export const PLACE_KINDS = Object.freeze(Object.fromEntries(data.kinds.map(kind => [kind.id, kind])));
export const PLACES_ROW_SOURCE = data.row_source;
const kindOf = id => {
  const kind = PLACE_KINDS[id];
  if (!kind) throw new Error(`There is no kind of places list ${id}.`);
  return kind;
};
export const shelfOf = list => `${data.shelf_prefix}${list.row_type}`;
const placeId = rowId => String(rowId).includes('~') ? String(rowId).slice(String(rowId).indexOf('~') + 1) : String(rowId);

/** The kind's list, made once when it is missing; its default rows are read from the published shelf, never copied. */
export function ensurePlaceList(lists, kindId, { actor } = {}) {
  const { list } = kindOf(kindId);
  return lists.ensure({ ...list, row_sources: [{ source: PLACES_ROW_SOURCE }] }, { actor });
}

/** The places the kind's list answers now, in order, in the shape placeFor reads. */
export async function placesOf(lists, kindId) {
  const kind = kindOf(kindId);
  const rows = [];
  let cursor = null;
  do {
    const page = await lists.read(kind.list.id, { limit: Math.min(50, data.most_places), ...(cursor ? { cursor } : {}) });
    rows.push(...(page.rows ?? []));
    cursor = page.page?.complete === false ? page.page.next_cursor ?? null : null;
  } while (cursor && rows.length < data.most_places);
  // Invariant 3: an own row is used instead of a default row with the same id.
  const own = new Set(rows.filter(row => !String(row.id).includes('~')).map(row => row.id));
  const places = rows.filter(row => !String(row.id).includes('~') || !own.has(placeId(row.id))).slice(0, data.most_places)
    .map(row => ({ id: placeId(row.id), label: row.values?.label ?? placeId(row.id), implementation: row.values?.implementation ?? null,
      pays: row.values?.pays ?? null, keeps: Array.isArray(row.values?.keeps) ? row.values.keeps : [],
      next_part_at: row.values?.next_part_at ?? null, order: Number.isFinite(row.values?.order) ? row.values.order : Number.MAX_SAFE_INTEGER,
      ...(row.values?.when && typeof row.values.when === 'object' ? { when: row.values.when } : {}) }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { facts: kind.facts, otherwise: kind.otherwise, places,
    jobs: kind.parts.map(part => ({ ...part, can: places.filter(place => place.keeps.includes(part.part)).map(place => place.id) })) };
}

/** The published-defaults row source: the default publishers' published rows on the list's own shelf. */
export function publishedDefaultRows({ published }) {
  return async ({ list, row_ids }) => {
    const items = (await published(shelfOf(list))) ?? [];
    const rows = items.map(item => item.row).filter(row => row && typeof row.id === 'string' && row.values && typeof row.values === 'object')
      .filter(row => !row_ids || row_ids.includes(row.id)).slice(0, data.most_places);
    return { rows: rows.map(row => ({ id: row.id, values: row.values })), next_cursor: null };
  };
}

/** Rows of a list as they are published: their own ids and stored values, nothing read from elsewhere. */
export function publishableRows(list, rows) {
  const stored = new Set((list.fields ?? []).map(field => field.id));
  return rows.filter(row => !String(row.id).includes('~')).map(row => ({ id: row.id,
    values: Object.fromEntries(Object.entries(row.values ?? {}).filter(([field]) => stored.has(field))) }));
}
