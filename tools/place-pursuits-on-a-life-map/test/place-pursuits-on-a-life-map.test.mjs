// The life map on a made-up starter map: the module reads the map its caller hands in, makes a person's own map list
// from it only when they choose it, places pursuits and names the parts nothing touches; the tool takes the starter
// map as input and reads the person's own map from the rows its caller hands in; the row runs with exactly its rights.
// Every area and word here is invented for the test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { rowOf, answerOf } from '../../../test-helpers/run-a-row.mjs';
import { placePursuitsOnALifeMap } from '../do-work/place-pursuits-on-a-life-map.mjs';
import { keptAreas, lifeMap, lifeMapSection, lifeMapSettings, missingLines, placeOnMap, starterAreas, useLifeMapSettings } from '../src/life-map.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const areas = [
  { id: 'garden', part_of: null, label: 'Garden', means: 'everything that grows' },
  { id: 'beds', part_of: 'garden', label: 'Beds', means: 'what is planted', sides: ['sun', 'shade'] },
  { id: 'paths', part_of: 'garden', label: 'Paths', means: 'how you walk through', optional: true },
  { id: 'compost', part_of: 'garden', label: 'Compost', means: 'what feeds the soil' },
  { id: 'notes', part_of: 'garden', label: 'Notes', means: 'kept for judging only', shown: false },
];
const rest = {
  list: { id: 'your-map', label: 'Your map', icon: 'Map', about: 'The parts of your garden.', title_field: 'area', fields: [{ id: 'area', label: 'Area', kind: 'text' }, { id: 'part_of', label: 'Part of', kind: 'link', links_to: 'your-map' }, { id: 'means', label: 'What it means', kind: 'long-text' }] },
  words: { heading: 'Your garden', body: 'Where your work grows.', missing_heading: 'Untended', missing_one: 'Nothing you do tends your {label}.', nothing_missing: 'Every bed is tended.', touched_by: '{count} pursuits', touched_by_one: '1 pursuit', untouched: 'Untended', optional: 'Optional', columns: { area: 'Area', part_of: 'Part of', pursuits: 'Pursuits', means: 'Means' }, change_map: 'Change your garden' },
};
const starter = () => ({ ...rest, areas });
const pursuits = [{ title: 'Grow beans', areas: ['beds', 'nowhere'] }, { title: 'Walk daily', areas: ['paths'] }];

// Lists kept in memory the way life-map.mjs reads them (synchronously): has, read, save and putRows.
function syncLists() {
  const kept = new Map();
  const api = {
    has: id => kept.has(id),
    read: id => ({ rows: [...kept.get(id).rows.values()] }),
    save: list => { kept.set(list.id, { list, rows: kept.get(list.id)?.rows ?? new Map() }); },
    putRows: (id, { rows: given }) => { for (const row of given) kept.get(id).rows.set(row.id, row); },
  };
  return () => api;
}

test('the module reads the starter map its caller hands in; a person\'s own map is made only when they choose it', () => {
  useLifeMapSettings(starter());
  assert.deepEqual(lifeMapSettings, starter());
  assert.deepEqual(starterAreas().map(area => area.id), ['garden', 'beds', 'paths', 'compost'], 'a row with shown false only shapes the judgement');
  let made = null;
  const map = lifeMap({ lists: syncLists(), made: { read: () => made, write: value => { made = value; } } });
  assert.equal(map.areas(), null, 'no map before they choose one');
  assert.equal(map.offered(), true);
  assert.equal(map.ensure(), 'your-map');
  const own = map.areas();
  assert.deepEqual(own.map(area => area.id), ['garden', 'beds', 'paths', 'compost']);
  const placed = placeOnMap(own, pursuits);
  assert.deepEqual(placed.areas.find(area => area.id === 'beds').pursuits, ['Grow beans']);
  assert.deepEqual(placed.missing.map(area => area.id), ['compost'], 'a leaf no pursuit names that is not optional');
  assert.deepEqual(missingLines(placed), ['Nothing you do tends your compost.']);
  assert.deepEqual(keptAreas(['beds', 'nowhere', 'beds'], own), ['beds']);
  assert.equal(lifeMapSection(placed).rows[0].id, 'area-compost', 'the missing parts first');
});

// The person's own map rows, as the caller's AI reads them from their list, and their pursuits.
const mapRows = [
  { id: 'beds', values: { area: 'My beds', means: 'what I planted' } },
  { id: 'herbs', values: { area: 'Herbs', means: 'what I cook with' } },
];
const own = [{ title: 'Grow beans', areas: ['beds'] }];

test('the tool places the pursuits on the map rows handed in; with no map it only offers one', async () => {
  const placed = await placePursuitsOnALifeMap({ pursuits: own, map_rows: mapRows, settings: starter() });
  assert.equal(placed.offered, false);
  assert.deepEqual(placed.areas.map(area => [area.id, area.pursuits]), [['beds', ['Grow beans']], ['herbs', []]]);
  assert.deepEqual(placed.missing_lines, ['Nothing you do tends your herbs.']);
  const offered = await placePursuitsOnALifeMap({ pursuits, settings: starter() });
  assert.deepEqual(offered, { list_id: 'your-map', offered: true });
  const withSection = await placePursuitsOnALifeMap({ pursuits, map_rows: mapRows, section: true, settings: starter() });
  assert.equal(withSection.section.heading, 'Your garden');
});

test('the answer holds the whole result, with the section, and uses no door', async () => {
  const placed = await placePursuitsOnALifeMap({ pursuits: own, map_rows: mapRows, settings: starter(), section: true });
  assert.deepEqual(placed.missing.map(area => area.id), ['herbs']);
  assert.equal(placed.section.rows[0].id, 'area-herbs');
});

test('refusals say what is missing and what to hand in', async () => {
  await assert.rejects(placePursuitsOnALifeMap({ pursuits }), /Hand in settings: the starter map/);
  await assert.rejects(placePursuitsOnALifeMap({ settings: starter() }), /pursuits is a list/);
  await assert.rejects(placePursuitsOnALifeMap({ pursuits: 'beans', settings: starter() }), /pursuits is a list/);
  await assert.rejects(placePursuitsOnALifeMap({ pursuits, settings: { areas: [] } }), /settings is the starter map/);
  await assert.rejects(placePursuitsOnALifeMap({ pursuits, settings: starter(), map_rows: 'beds' }), /map_rows is the list/);
});

test('the row runs with no door, and its answer holds the result', async () => {
  const row = rowOf(rows, 'tool:place-pursuits-on-a-life-map');
  assert.equal(row.invoke.records, undefined);
  const made = await answerOf(row, { settings: starter(), pursuits: own, map_rows: mapRows }, { records: [] });
  assert.equal(made.status, 0, JSON.stringify(made.error));
  assert.deepEqual(made.result.missing.map(area => area.id), ['herbs']);
  assert.deepEqual(made.kept, []);
  const verify = row.verify[0];
  const sample = await answerOf(row, verify.input, { records: [] });
  assert.equal(sample.status, 0, JSON.stringify(sample.error));
  assert.match(JSON.stringify(sample.result.list_id), new RegExp(verify.contains));
});
