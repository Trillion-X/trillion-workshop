// tools/place-pursuits-on-a-life-map/do-work/place-pursuits-on-a-life-map.mjs
//
// tool:place-pursuits-on-a-life-map, run as a function (tools/records-door do-work/run-an-export.mjs): a person's
// pursuits placed on their own map of a full life, with the parts no pursuit touches, by src/life-map.mjs unchanged.
// The tool keeps nothing and reads nothing: the starter map, the person's own map rows and their pursuits are all
// its input (the caller's AI reads them from their lists). With no map_rows (omitted or null), nothing is placed: the starter map is
// offered, never read in its place.
//
//   placePursuitsOnALifeMap(input) -> { list_id, offered, areas?, missing?, missing_lines?, section? }
//   input: { settings: the starter map, pursuits: [{ title, areas }], map_rows?: the person's own map list rows
//            [{ id, title?, values }], section?: true (the Progress section too) }
import data from '../read-data/place-pursuits-on-a-life-map.json' with { type: 'json' };
import { lifeMap, lifeMapSection, missingLines, placeOnMap } from '../src/life-map.mjs';

const refuse = (code, words) => { throw Object.assign(new Error(words), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function placePursuitsOnALifeMap(input = {}) {
  const { pursuits, settings, map_rows: mapRows, section = false } = input ?? {};
  if (!Array.isArray(pursuits)) refuse('bad_pursuits', data.words.bad_pursuits);
  if (settings === undefined) refuse('no_settings', data.words.no_settings);
  if (!object(settings) || !Array.isArray(settings.areas) || !object(settings.list)) refuse('bad_settings', data.words.bad_settings);
  if (mapRows !== undefined && mapRows !== null && !Array.isArray(mapRows)) refuse('bad_map_rows', data.words.bad_map_rows);
  const has = Array.isArray(mapRows);
  const lists = () => ({ has: id => id === settings.list.id && has, read: () => ({ rows: mapRows }) });
  const map = lifeMap({ lists, made: { read: () => null, write: () => {} }, settings });
  const areas = map.areas();
  if (!areas) return { list_id: map.list_id, offered: true };
  const placed = placeOnMap(areas, pursuits, { list_id: map.list_id });
  return { ...placed, offered: false, missing_lines: missingLines(placed, settings), ...(section ? { section: lifeMapSection(placed, settings) } : {}) };
}
