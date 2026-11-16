// tools/place-pursuits-on-a-life-map/do-work/place-pursuits-on-a-life-map.mjs
//
// tool:place-pursuits-on-a-life-map, run as a function (tools/records-door do-work/run-an-export.mjs): a person's
// pursuits placed on their own map of a full life, with the parts no pursuit touches, by src/life-map.mjs unchanged.
// The starter map is the run's input `settings`; the tool reads no setting itself. The person's own map is their list
// (the starter map's list id, read-data/place-pursuits-on-a-life-map.json); with none, nothing is placed: the starter
// map is offered, never read in its place. Their pursuits are handed in, or read from their pursuit records.
//
//   placePursuitsOnALifeMap(input, { door }) -> { list_id, offered, areas?, missing?, missing_lines?, section? }
//   input: { settings: the starter map, pursuits?: [{ title, areas }], section?: true (the Progress section too) }
import { listsOverDoor } from '../../records-door/read-data/lists-door.mjs';
import data from '../read-data/place-pursuits-on-a-life-map.json' with { type: 'json' };
import { lifeMap, lifeMapSection, missingLines, placeOnMap } from '../src/life-map.mjs';

const refuse = (code, words) => { throw Object.assign(new Error(words), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The person's own map list read once, then served the way life-map.mjs reads lists: synchronously.
async function snapshot(lists, id) {
  const kept = await lists.has(id) ? await lists.read(id) : null;
  return () => ({ has: listId => listId === id && Boolean(kept), read: () => ({ rows: kept.rows }) });
}

export async function placePursuitsOnALifeMap(input = {}, { door } = {}) {
  const { pursuits: given, settings, section = false } = input ?? {};
  if (given !== undefined && !Array.isArray(given)) refuse('bad_pursuits', data.words.bad_pursuits);
  if (settings === undefined) refuse('no_settings', data.words.no_settings);
  const lists = listsOverDoor(door);
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
