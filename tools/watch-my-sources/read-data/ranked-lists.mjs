// src/ranked-lists.mjs
//
// Purpose
//   A ranked list on a site (a best-seller list, a chart, a trending-products table) read as items with a rank, by the
//   reader row of src/watch-sources.json `rank_readers` that matches the list's address, and how one item moved between
//   two days. Nothing here names a site: how to read one is a row, so a second site is a new row.
//
// Non-Negotiable Invariants
//   1. A list is read by its reader row alone: its pages, where the items are (`from`, a way a page carries data, and a
//      path inside it), the paths to each item's id, rank, title and facts, the title pattern and the link template are
//      DATA. The ways a page carries data are the entries of FROM; a new one is a new entry, never a site's branch.
//   2. Nothing is guessed: an item without an id or a whole-number rank is left out; an item the list names no title for
//      is titled by its id; a page that does not hold the items answers null, so the caller reports a problem and never
//      takes a robot check or a changed page for an empty list.
//   3. No dependency and nothing run: data is found by pattern and parsed as JSON, entities decoded, references resolved.
//
// Shapes
//   rankReaderOf(address, rows) -> row | null
//   pagesOf(address, row) -> [url]
//   rankedItems(row, text) -> { items: [{ id, rank, title, link, facts }], dated: string | null } | null
//   movementOf(from, to, limits) -> 'entered' | 'climbed' | 'fell' | 'dropped' | null
//
import { decodeEntities, squash } from './feed-items.mjs';

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parsed = value => { try { return JSON.parse(value); } catch { return undefined; } };

// A Nuxt page payload (devalue's flat form): the array's first entry is the root and every value inside an object or
// array is the index of another entry; a negative index is undefined (or NaN, an infinity, -0); an entry that is an array
// led by a name ("ShallowReactive", "Ref", "Date", ...) wraps the value at its second entry.
function unflatten(flat) {
  if (!Array.isArray(flat) || !flat.length) return undefined;
  const special = { [-1]: undefined, [-2]: undefined, [-3]: Number.NaN, [-4]: Number.POSITIVE_INFINITY, [-5]: Number.NEGATIVE_INFINITY, [-6]: -0 };
  const made = new Map();
  const at = index => {
    if (!Number.isInteger(index) || index >= flat.length) return undefined;
    if (index < 0) return special[index];
    if (made.has(index)) return made.get(index);
    const value = flat[index];
    if (value === null || typeof value !== 'object') { made.set(index, value); return value; }
    if (Array.isArray(value) && typeof value[0] === 'string') {
      const inner = value[0] === 'Date' ? value[1] : at(value[1]);
      made.set(index, inner);
      return inner;
    }
    const out = Array.isArray(value) ? [] : {};
    made.set(index, out);
    for (const [key, ref] of Object.entries(value)) out[key] = at(ref);
    return out;
  };
  return at(0);
}

// The ways a page carries its data: each answers the data's root, or undefined.
const FROM = {
  'html-attribute-json': (text, items) => {
    const found = new RegExp(`\\s${escapeRegExp(items.attribute)}="([^"]*)"`).exec(text);
    return found ? parsed(decodeEntities(found[1])) : undefined;
  },
  'nuxt-payload': text => unflatten(parsed(text)),
};

// A path's value: each step a key, or { any: true } for the first child the rest of the path is found in.
function at(value, path) {
  if (!path.length) return value;
  if (value === null || typeof value !== 'object') return undefined;
  const [step, ...rest] = path;
  if (typeof step === 'object' && step?.any) {
    for (const child of Object.values(value)) {
      const found = at(child, rest);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return at(value[step], rest);
}

export function rankReaderOf(address, rows) {
  let url;
  try { url = new URL(address); } catch { return null; }
  return rows.find(row => row.match.hosts.includes(url.host) && row.match.path_contains.some(part => url.pathname.includes(part))) ?? null;
}

export function pagesOf(address, row) {
  return row.pages.map(page => {
    const url = new URL(address);
    if (page.append_path) url.pathname = `${url.pathname.replace(/\/+$/, '')}${page.append_path}`;
    for (const [name, value] of Object.entries(page.query ?? {})) url.searchParams.set(name, value);
    return url.href;
  });
}

export function rankedItems(row, text) {
  const { items } = row;
  const root = FROM[items.from]?.(text, items);
  const elements = root === undefined ? undefined : at(root, items.list_path);
  if (!Array.isArray(elements)) return null;
  const titles = new Map();
  if (row.titles) {
    for (const match of text.matchAll(new RegExp(row.titles.pattern, 'g'))) {
      const title = squash(decodeEntities(match.groups.title));
      if (title && !titles.has(match.groups.id)) titles.set(match.groups.id, title);
    }
  }
  const dated = items.dated_path ? at(root, items.dated_path) : null;
  return {
    dated: typeof dated === 'string' && dated ? dated : null,
    items: elements.flatMap((element, index) => {
      const id = at(element, items.id_path);
      const rank = items.rank_path ? Number(at(element, items.rank_path)) : index + 1;
      if (typeof id !== 'string' || !id || !Number.isSafeInteger(rank) || rank < 1) return [];
      const named = items.title_path ? at(element, items.title_path) : undefined;
      const title = (typeof named === 'string' && squash(decodeEntities(named))) || titles.get(id) || id;
      const facts = Object.fromEntries(Object.entries(items.facts ?? {}).flatMap(([field, path]) => {
        const value = at(element, path);
        return typeof value === 'string' || typeof value === 'number' ? [[field, String(value)]] : [];
      }));
      return [{ id, rank, title, link: row.link.replace('{id}', encodeURIComponent(id)), facts }];
    }),
  };
}

// From and to are ranks (null when off the list); a lower number is higher on the list.
export function movementOf(from, to, limits) {
  if (from === null && to === null) return null;
  if (from === null) return to <= limits.rank_new_at_most ? 'entered' : null;
  if (to === null) return 'dropped';
  const places = Math.abs(from - to);
  if (to < from && (places >= limits.rank_climbed_places || (places >= limits.rank_share_least_places && places / from >= limits.rank_climbed_share))) return 'climbed';
  if (to > from && (places >= limits.rank_fell_places || (places >= limits.rank_share_least_places && places / from >= limits.rank_fell_share))) return 'fell';
  return null;
}
