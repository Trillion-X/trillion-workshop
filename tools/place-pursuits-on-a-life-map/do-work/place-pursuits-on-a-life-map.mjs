// tools/place-pursuits-on-a-life-map/do-work/place-pursuits-on-a-life-map.mjs
//
// tool:place-pursuits-on-a-life-map, run as a function (tools/records-door do-work/run-an-export.mjs): a person's
// pursuits placed on their own map of a full life, with the parts no pursuit touches, by src/life-map.mjs unchanged.
// The starter map is handed in (`settings`), or read from the person's lists through their records door (its areas
// are the rows of one list, the rest one row of another: read-data/place-pursuits-on-a-life-map.json). The person's
// own map is their list (the starter map's list id); with none, nothing is placed: the starter map is offered, never
// read in its place. Their pursuits are handed in, or read from their pursuit records.
//
//   placePursuitsOnALifeMap(input, { door }) -> { list_id, offered, areas?, missing?, missing_lines?, section? }
//   input: { pursuits?: [{ title, areas }], settings?: the starter map, section?: true (the Progress section too) }
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';
import data from '../read-data/place-pursuits-on-a-life-map.json' with { type: 'json' };
import { lifeMap, lifeMapSection, missingLines, placeOnMap } from '../src/life-map.mjs';

const fill = (line, values) => line.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
const refuse = (code, words) => { throw Object.assign(new Error(words), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The starter map from the person's lists: the rows of its areas list, and the row with its list, reading and words. */
export async function starterMapFromLists(lists, door) {
  const { starter_areas: where, settings_row: about, words } = data;
  const rows = await lists.has(where.list) ? (await lists.read(where.list)).rows : [];
  if (!rows.length) refuse('no_starter', fill(words.no_starter, where));
  const rest = await door.read(`record:${about.row_type}`, `record:${about.row_type}:${about.row}`);
  if (!object(rest)) refuse('no_settings', fill(words.no_settings, about));
  return { ...rest, areas: rows.map(row => ({ id: row.id, ...row.values })) };
}

// The person's own map list read once, then served the way life-map.mjs reads lists: synchronously.
async function snapshot(lists, id) {
  const kept = await lists.has(id) ? await lists.read(id) : null;
  return () => ({ has: listId => listId === id && Boolean(kept), read: () => ({ rows: kept.rows }) });
}

export async function placePursuitsOnALifeMap(input = {}, { door } = {}) {
  const { pursuits: given, settings: handed, section = false } = input ?? {};
  if (given !== undefined && !Array.isArray(given)) refuse('bad_pursuits', data.words.bad_pursuits);
  const lists = listsOverDoor(door);
  const settings = handed ?? await starterMapFromLists(lists, door);
  if (!object(settings) || !Array.isArray(settings.areas) || !object(settings.list)) refuse('bad_settings', data.words.bad_settings);
  const map = lifeMap({ lists: await snapshot(lists, settings.list.id), made: { read: () => null, write: () => {} }, settings });
  const areas = map.areas();
  if (!areas) return { list_id: map.list_id, offered: true };
  let pursuits = given;
  if (!pursuits) {
    pursuits = [];
    for await (const record of door.list({ type: data.pursuits.type, fields: data.pursuits.fields })) pursuits.push(record.value ?? {});
  }
  const placed = placeOnMap(areas, pursuits, { list_id: map.list_id });
  return { ...placed, offered: false, missing_lines: missingLines(placed, settings), ...(section ? { section: lifeMapSection(placed, settings) } : {}) };
}
