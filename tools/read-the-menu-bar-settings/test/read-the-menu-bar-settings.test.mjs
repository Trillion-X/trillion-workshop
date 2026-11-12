// Tests for tool:read-the-menu-bar-settings. The rows are the tool's own DATA (read-data/menu-bar-settings.json), the one
// source the Mac app and the web page read; the answers and changes below are made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { definitions, readTheMenuBarSettings } from '../do-work/read-the-menu-bar-settings.mjs';

test('the rows are the four menu bar settings, all usable', () => {
  assert.deepEqual(definitions.map(row => row.id), ['enabled', 'meetings_within', 'title_length', 'app_icon']);
});

test('with no answer every row shows its default', () => {
  const result = readTheMenuBarSettings({});
  assert.equal(result.held, false);
  assert.deepEqual(result.rows.map(row => [row.id, row.value]), [['enabled', true], ['meetings_within', '12'], ['title_length', 180], ['app_icon', 'black']]);
  assert.deepEqual(result.rows[2], { id: 'title_length', kind: 'range', value: 180, least: 40, most: 180, step: 10 });
});

test('a host answer of the right shape is what the rows show', () => {
  const answer = { rows: [{ id: 'enabled', kind: 'switch', value: false }, { id: 'meetings_within', kind: 'choice', value: '24' }, { id: 'title_length', kind: 'range', value: 120 }] };
  const result = readTheMenuBarSettings({ answer });
  assert.equal(result.held, true);
  assert.deepEqual(result.rows.map(row => row.value), [false, '24', 120, 'black']);
});

test('an answer that is not the rows shape is no answer at all', () => {
  const wrongValue = { rows: [{ id: 'title_length', kind: 'range', value: 999 }] };
  const unknownRow = { rows: [{ id: 'other', kind: 'switch', value: true }] };
  assert.equal(readTheMenuBarSettings({ answer: wrongValue }).held, false);
  assert.equal(readTheMenuBarSettings({ answer: unknownRow }).held, false);
  assert.equal(readTheMenuBarSettings({ answer: { rows: [] } }).held, false);
});

test('a requested change is accepted when its row allows the value and refused otherwise', () => {
  assert.deepEqual(readTheMenuBarSettings({ set: { id: 'meetings_within', value: '0' } }).change, { id: 'meetings_within', value: '0', kind: 'choice' });
  assert.throws(() => readTheMenuBarSettings({ set: { id: 'meetings_within', value: '5' } }), /not a value/);
  assert.throws(() => readTheMenuBarSettings({ set: { id: 'title_length', value: 200 } }), /not a value/);
  assert.throws(() => readTheMenuBarSettings({ set: { id: 'enabled', value: 'yes' } }), /not a value/);
  assert.throws(() => readTheMenuBarSettings({ set: { id: 'nope', value: true } }), /no menu bar setting/);
});

test('a request that is not one JSON object is refused', () => {
  assert.throws(() => readTheMenuBarSettings(['no']), /one JSON/);
});
