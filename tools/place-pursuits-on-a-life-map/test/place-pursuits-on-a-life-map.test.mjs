// The life map on a made-up starter map: the module reads the map its caller hands in, makes a person's own map list
// from it only when they choose it, places pursuits and names the parts nothing touches; the tool reads the starter
// map and the person's own map from their lists through their records door; the row runs with exactly its rights.
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

// The person's records: the starter map's areas list and its settings row, and optionally their own map list.
const records = ({ own = true } = {}) => [
  { id: 'list:life-map-areas', type: 'list', value: { label: 'Life map areas', row_type: 'life-map-area', title_field: 'label', indexes: [] } },
  ...areas.map(({ id, ...values }) => ({ id: `record:life-map-area:${id}`, type: 'record:life-map-area', value: values })),
  { id: 'record:content-setting:life-map', type: 'record:content-setting', value: rest },
  ...(own ? [
    { id: 'list:your-map', type: 'list', value: { label: 'Your map', row_type: 'your-map', title_field: 'area', indexes: [] } },
    { id: 'record:your-map:beds', type: 'record:your-map', value: { area: 'My beds', means: 'what I planted' } },
    { id: 'record:your-map:herbs', type: 'record:your-map', value: { area: 'Herbs', means: 'what I cook with' } },
  ] : []),
  { id: 'pursuit:one', type: 'pursuit', value: { title: 'Grow beans', areas: ['beds'] } },
];
function memoryDoor(list) {
  const kept = new Map(list.map(record => [record.id, record]));
  return {
    async read(type, id) { const held = kept.get(id); return held?.type === type ? structuredClone(held.value) : null; },
    async *list({ type }) { for (const id of [...kept.keys()].filter(id => kept.get(id).type === type).sort().reverse()) yield structuredClone(kept.get(id)); },
    async write() { throw new Error('this tool writes nothing'); },
  };
}

test('the tool places pursuits on the person\'s own map, read through their door; with no map it only offers one', async () => {
  const placed = await placePursuitsOnALifeMap({}, { door: memoryDoor(records()) });
  assert.equal(placed.offered, false);
  assert.deepEqual(placed.areas.map(area => [area.id, area.pursuits]), [['beds', ['Grow beans']], ['herbs', []]]);
  assert.deepEqual(placed.missing_lines, ['Nothing you do tends your herbs.']);
  const offered = await placePursuitsOnALifeMap({ pursuits }, { door: memoryDoor(records({ own: false })) });
  assert.deepEqual(offered, { list_id: 'your-map', offered: true });
  const withSection = await placePursuitsOnALifeMap({ pursuits, section: true, settings: starter() }, { door: memoryDoor(records()) });
  assert.equal(withSection.section.heading, 'Your garden');
});

test('refusals say what is missing and what to hand in', async () => {
  await assert.rejects(placePursuitsOnALifeMap({}, { door: memoryDoor([]) }), /no starter map in your lists yet: the list life-map-areas holds no areas/);
  await assert.rejects(placePursuitsOnALifeMap({}, { door: memoryDoor(records().filter(record => record.type !== 'record:content-setting')) }), /its row life-map \(the map list, the reading and the words\) is missing/);
  await assert.rejects(placePursuitsOnALifeMap({ pursuits: 'beans' }, { door: memoryDoor(records()) }), /pursuits is a list/);
  await assert.rejects(placePursuitsOnALifeMap({ settings: { areas: [] } }, { door: memoryDoor(records()) }), /settings is the starter map/);
});

test('the row runs through the records door with exactly its rights', async () => {
  const row = rowOf(rows, 'tool:place-pursuits-on-a-life-map');
  const made = await answerOf(row, {}, { records: records() });
  assert.equal(made.status, 0, JSON.stringify(made.error));
  assert.deepEqual(made.result.missing.map(area => area.id), ['herbs']);
  const verify = row.verify[0];
  const sample = await answerOf(row, verify.input, { records: [] });
  assert.equal(sample.status, 0, JSON.stringify(sample.error));
  assert.match(JSON.stringify(sample.result.list_id), new RegExp(verify.contains));
});
