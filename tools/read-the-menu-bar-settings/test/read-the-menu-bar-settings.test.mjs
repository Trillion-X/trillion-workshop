// Tests for tool:read-the-menu-bar-settings. The rows are the shape of the menu bar item's own settings; the values are made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readTheMenuBarSettings } from '../do-work/read-the-menu-bar-settings.mjs';

const definitions = [
  { id: 'enabled', kind: 'switch', default: true },
  { id: 'meetings_within', kind: 'choice', default: '12', choices: [{ id: '0', title: 'Next (today only)' }, { id: '12', title: '12 hours' }, { id: '24', title: '24 hours' }] },
  { id: 'title_length', kind: 'range', default: 180, least: 40, most: 180, step: 10 },
];

test('with no answer every row shows its default', () => {
  const result = readTheMenuBarSettings({ definitions });
  assert.equal(result.held, false);
  assert.deepEqual(result.rows.map(row => [row.id, row.value]), [['enabled', true], ['meetings_within', '12'], ['title_length', 180]]);
  assert.deepEqual(result.rows[2], { id: 'title_length', kind: 'range', value: 180, least: 40, most: 180, step: 10 });
});

test('a host answer of the right shape is what the rows show', () => {
  const answer = { rows: [{ id: 'enabled', kind: 'switch', value: false }, { id: 'meetings_within', kind: 'choice', value: '24' }, { id: 'title_length', kind: 'range', value: 120 }] };
  const result = readTheMenuBarSettings({ definitions, answer });
  assert.equal(result.held, true);
  assert.deepEqual(result.rows.map(row => row.value), [false, '24', 120]);
});

test('an answer that is not the rows shape is no answer at all', () => {
  const wrongValue = { rows: [{ id: 'title_length', kind: 'range', value: 999 }] };
  const unknownRow = { rows: [{ id: 'other', kind: 'switch', value: true }] };
  assert.equal(readTheMenuBarSettings({ definitions, answer: wrongValue }).held, false);
  assert.equal(readTheMenuBarSettings({ definitions, answer: unknownRow }).held, false);
  assert.equal(readTheMenuBarSettings({ definitions, answer: { rows: [] } }).held, false);
});

test('a requested change is accepted when its row allows the value and refused otherwise', () => {
  assert.deepEqual(readTheMenuBarSettings({ definitions, set: { id: 'meetings_within', value: '0' } }).change, { id: 'meetings_within', value: '0', kind: 'choice' });
  assert.throws(() => readTheMenuBarSettings({ definitions, set: { id: 'meetings_within', value: '5' } }), /not a value/);
  assert.throws(() => readTheMenuBarSettings({ definitions, set: { id: 'title_length', value: 200 } }), /not a value/);
  assert.throws(() => readTheMenuBarSettings({ definitions, set: { id: 'enabled', value: 'yes' } }), /not a value/);
  assert.throws(() => readTheMenuBarSettings({ definitions, set: { id: 'nope', value: true } }), /no menu bar setting/);
});

test('a definition whose default its kind does not allow is refused', () => {
  assert.throws(() => readTheMenuBarSettings({ definitions: [{ id: 'x', kind: 'choice', default: 'z', choices: [{ id: 'a', title: 'A' }] }] }), /default/);
  assert.throws(() => readTheMenuBarSettings(['no']), /one JSON/);
});
