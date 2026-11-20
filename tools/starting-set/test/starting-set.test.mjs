// tools/starting-set/test/starting-set.test.mjs
//
// The starting set's own rows: every account rule and schedule has its own id, and every shipped default names the record
// it is laid under, with the Simple workspace type in use for every account. Ported from Trillion-X/trillion
// test/starting-catalog.test.mjs (the checks over the rows). The catalog files records.json and groups.json, and their
// checks, were retired on Nov 19 2026: their live items are rows of the toolkits table (README).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const startingRules = read('starting-rules.json');
const defaults = read('shipped-defaults.json');

test('every account rule and schedule has its own id', () => {
  const ids = startingRules.every_account.map(row => row.schedule_id ?? row.rule_id);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
  assert.equal(new Set(ids).size, ids.length);
});

test('every shipped default names its record once, and the show-rules default has the Simple workspace in use', () => {
  const rows = defaults.records.map(entry => entry.payload);
  assert.ok(rows.every(row => row.kind === 'shipped-default' && typeof row.record === 'string' && row.value && typeof row.value === 'object'));
  assert.equal(new Set(rows.map(row => row.record)).size, rows.length);
  const show = rows.find(row => row.record === 'show-rules');
  assert.deepEqual(show.value.in_use, ['simple-workspace']);
  const type = show.value.types.find(row => row.id === 'simple-workspace');
  assert.equal(type.label, 'Simple workspace');
  assert.deepEqual(type.rules.map(rule => rule.id), ['only-the-everyday-controls', 'only-the-everyday-screens',
    'everyday-destinations-together', 'one-container-one-tab', 'sidebar-on-the-left']);
  assert.deepEqual(show.merge, { by_id: ['types'], switched: [{ field: 'in_use', off_in: 'starting' }] });
});

test('nothing in the rows names a person', () => {
  for (const name of ['starting-rules.json', 'shipped-defaults.json']) {
    assert.doesNotMatch(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'), /[a-z0-9._-]+@(?!example\.)[a-z0-9-]+\.(?:com|org|net|io|me|co)\b/i, name);
  }
});
