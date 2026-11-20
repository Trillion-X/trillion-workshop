import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapAreaOfRow, mapAreas, keptAreas, placeOnMap, mapForReading } from '../src/life-map.mjs';

// Made-up map rows (the person's own map is whatever form their store keeps; these are the shape the caller hands in).
const rows = [
  { id: 'body', title: 'Body', values: { area: 'Body', means: 'Health and energy', optional: 'No' } },
  { id: 'sleep', title: 'Sleep', values: { area: 'Sleep', part_of: ['body'], means: 'Rest', optional: 'No' } },
  { id: 'money', title: 'Money', values: { area: 'Money', means: 'Cash and debts', sides: 'inside / outside', optional: 'No' } },
  { id: 'hobby', title: 'Hobby', values: { area: 'Hobby', means: 'Play', optional: 'Yes' } },
  { id: 'orphan', title: 'Orphan', values: { area: 'Orphan', part_of: ['gone'], means: 'Parent not on the map', optional: 'No' } },
];

test('a map row becomes an area: its id, label, parent link, meaning, sides and optional flag come from the row', () => {
  assert.deepEqual(mapAreaOfRow(rows[2]), { id: 'money', label: 'Money', part_of: null, means: 'Cash and debts', sides: ['inside', 'outside'], optional: false });
  assert.deepEqual(mapAreaOfRow({ id: 'x', title: 'Title only', values: {} }), { id: 'x', label: 'Title only', part_of: null, means: '', optional: false });
  assert.equal(mapAreaOfRow(rows[3]).optional, true);
});

test('areas come in tree order: each area is followed by the areas part of it; a parent that is not on the map is placed at the top', () => {
  const areas = mapAreas(rows);
  assert.deepEqual(areas.map(area => area.id), ['body', 'sleep', 'hobby', 'money', 'orphan']);
  assert.equal(areas.find(area => area.id === 'orphan').part_of, null, 'an unknown parent is dropped to the top, never the row');
});

test('a loop of areas part of each other is kept as areas of their own, never dropped', () => {
  const loop = [
    { id: 'a', title: 'A', values: { area: 'A', part_of: ['b'] } },
    { id: 'b', title: 'B', values: { area: 'B', part_of: ['a'] } },
  ];
  const areas = mapAreas(loop);
  assert.deepEqual(areas.map(area => area.id).sort(), ['a', 'b']);
  assert.ok(areas.every(area => area.part_of === null));
});

test('keptAreas keeps only the ids of the map, once each, and nothing when the value is not a list', () => {
  const areas = mapAreas(rows);
  assert.deepEqual(keptAreas(['body', 'nowhere', 'body', 'money'], areas), ['body', 'money']);
  assert.deepEqual(keptAreas('body', areas), []);
  assert.deepEqual(keptAreas(undefined, areas), []);
});

test('placeOnMap puts each pursuit on the areas it names, and reports the leaf areas no pursuit names as missing', () => {
  const areas = mapAreas(rows);
  const placed = placeOnMap(areas, [
    { title: 'Run a bakery', areas: ['money', 'body'] },
    { title: 'Learn guitar', areas: ['hobby'] },
  ], { list_id: 'your-map' });
  assert.equal(placed.list_id, 'your-map');
  assert.deepEqual(placed.areas.find(area => area.id === 'money').pursuits, ['Run a bakery']);
  assert.deepEqual(placed.areas.find(area => area.id === 'body').pursuits, ['Run a bakery']);
  assert.deepEqual(placed.missing, [
    { id: 'sleep', label: 'Sleep', part_of: 'body' },
    { id: 'orphan', label: 'Orphan', part_of: null },
  ], 'sleep is a leaf nobody names; body is a parent so it is not missing; hobby is optional');
  assert.throws(() => placeOnMap(areas, [], {}), TypeError, 'the map list id is required');
});

test('mapForReading hands a reading each area id, label, meaning and parent, and nothing else', () => {
  const reading = mapForReading(mapAreas(rows));
  assert.deepEqual(reading[0], { id: 'body', label: 'Body', means: 'Health and energy' });
  assert.deepEqual(reading[1], { id: 'sleep', label: 'Sleep', means: 'Rest', part_of: 'body' });
  assert.equal(Object.keys(reading[2]).includes('optional'), false);
});
