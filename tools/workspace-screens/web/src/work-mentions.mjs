// What `@` offers in the message box: the person's own AIs, people in the space being written in, their spaces, files,
// workflows, automations, schedules and actions, and every kind of record they keep, read from their own store by the
// rows of src/mention-sources.json. Nothing here names a kind: each row says where its things are read, which fields
// name them, and how they look; a row with `kind_field` takes each thing's kind from the thing itself, so a kind of
// record nobody listed is offered the day it is first kept, looking as parts/screen-look/show/record-kind-appearance.json
// says (or as its fallback does, with the kind made readable).
//
// GET /work/api/mentions?space=<space_id>&q=<typed words>&kinds=<only these kinds, comma list>&initial=true
//   -> { kinds: { <kind>: { label, icon, colour, hands_off? } }, candidates: [{ kind, value, label, detail? }], unread: [row] }
// A row that needs a value the request does not carry (the space) is not read; a row that searches is read only once
// `search_from` characters were typed; a row whose read fails is listed in `unread` and the rest still answer.

import sources from './mention-sources.json' with { type: 'json' };
import appearance from 'trillion-workshop/tools/screen-look/show/record-kind-appearance.json' with { type: 'json' };

const json = (value, status = 200) => Response.json(value, { status });
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : '');
const MOST = 50;
const SEARCH_FROM = 2;

const nameOf = row => row.kind ?? row.source;
const declared = new Map(sources.kinds.filter(row => row.kind).map(row => [row.kind, row]));
const openRows = sources.kinds.filter(row => row.kind_field);
// A kind's own name, after the namespace it is kept under (`record:customer` reads "Customer").
const readable = kind => kind.slice(kind.lastIndexOf(':') + 1).replace(/[_-]+/g, ' ').replace(/^./, first => first.toUpperCase());

export const isWorkMentionsPath = path => path === '/work/api/mentions';

/** A kind that can be mentioned: its declaring row, or a kind a `kind_field` row admits (linked as itself); else null. */
export function mentionKind(kind) {
  if (typeof kind !== 'string') return null;
  if (declared.has(kind)) return declared.get(kind);
  const open = openRows.find(row => new RegExp(row.kind_pattern).test(kind));
  return open ? { ...open, kind, about: kind } : null;
}

/** How one kind looks, for the picker and the chips: its row's look, or its record appearance, or the fallback. */
export function mentionLook(kind) {
  const row = declared.get(kind);
  if (row) return { label: row.label, icon: row.icon, colour: row.colour, ...(row.hands_off ? { hands_off: true } : {}) };
  const styled = appearance.kinds[kind];
  return { label: styled?.label ?? readable(kind), icon: styled?.icon ?? appearance.fallback.icon, colour: styled?.tone ?? appearance.fallback.tone };
}

/** How each kind looks: every declared kind, and each other kind among `candidates`. */
export const mentionKinds = (candidates = []) => Object.fromEntries([...new Set([...declared.keys(), ...candidates.map(one => one.kind)])].map(kind => [kind, mentionLook(kind)]));

/** The rows of one source, read from the person's store (`ask(method, path, body)` answers JSON or throws). */
async function readKind(row, ask, values, query) {
  if (row.needs && !values[row.needs]) return [];
  if (row.search && query.length < (row.search_from ?? SEARCH_FROM)) return [];
  const filled = row.read.path.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(values[name] ?? ''));
  const typed = row.search && query ? { [row.search]: query } : {};
  const get = row.read.method === 'GET';
  const params = new URLSearchParams(get ? { ...row.read.query, ...typed } : {}).toString();
  const answer = await ask(row.read.method, params ? `${filled}?${params}` : filled, get ? undefined : { ...row.read.body, ...typed });
  const rows = Array.isArray(answer?.[row.rows]) ? answer[row.rows] : [];
  const pattern = row.kind_field ? new RegExp(row.kind_pattern) : null;
  return rows.flatMap(item => {
    const value = text(item?.[row.value]);
    const kind = row.kind ?? text(item?.[row.kind_field]);
    if (!value || !kind || (row.skip_when && item[row.skip_when] === true)) return [];
    // A kind another row names is that row's to offer; a kind outside the pattern is not offered at all.
    if (pattern && (declared.has(kind) || !pattern.test(kind))) return [];
    const detail = row.detail ? text(item[row.detail]) : '';
    return [{ kind, value, label: text(item[row.label_field]) || value, ...(detail ? { detail: detail.slice(0, 120) } : {}) }];
  }).slice(0, MOST);
}

export async function handleWorkMentions(request, { person, origin, url }) {
  if (request.method !== 'GET') return json({ error: 'Not found' }, 404);
  const ask = async (method, path, body) => {
    const response = await person.fetch(new Request(`https://person${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-trillion-origin': origin, 'x-trillion-app': 'Trillion' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response.json();
  };
  // `kinds` (a comma list) asks only those rows, so a caller that already holds the rest asks no more than it needs.
  const kinds = text(url.searchParams.get('kinds')).split(',').map(kind => kind.trim()).filter(Boolean);
  const selected = kinds.length ? sources.kinds.filter(row => kinds.includes(nameOf(row))) : sources.kinds;
  // The picker's first paint offers browsable things. Search sources join only after typing; resolvers that need the
  // complete current labels omit `initial`, and an explicit `kinds` request always expresses demand for those rows.
  const rows = !kinds.length && url.searchParams.get('initial') === 'true'
    ? selected.filter(row => !row.search)
    : selected;
  return json(await mentionsFrom(ask, { space: text(url.searchParams.get('space')) }, text(url.searchParams.get('q')).slice(0, 80), rows));
}

/**
 * The candidates `rows` (the sources' rows, or only those a caller can answer) offer, read through `ask(method, path,
 * body)`: the Worker asks the person's store; a page with the person's records on the device asks its copy for the
 * rows whose read it answers (src/workspace/mentions.ts). -> { kinds, candidates, unread }.
 */
export async function mentionsFrom(ask, values, query, rows = sources.kinds) {
  const read = await Promise.allSettled(rows.map(row => readKind(row, ask, values, query)));
  const seen = new Set();
  const candidates = read.flatMap(result => (result.status === 'fulfilled' ? result.value : [])).filter(one => {
    const key = `${one.kind}\u0000${one.value}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return {
    kinds: mentionKinds(candidates),
    candidates,
    unread: rows.filter((_, index) => read[index].status === 'rejected').map(nameOf),
  };
}

/** The sources' rows whose read a device's copy of the person's records answers (a read of `path`). */
export const mentionRowsReading = path => sources.kinds.filter(row => row.read.path === path);
