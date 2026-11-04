// tools/starting-set/test/starting-set.test.mjs
//
// The starting set's own rows: every shipped component is in exactly one configuration or is core, a configuration holds
// at most 100, pinned rows are held, and every shipped default names the record it is laid under, with the Simple
// workspace type in use for every account. Ported from Trillion-X/trillion test/starting-catalog.test.mjs (the checks
// over the rows; the catalog reader and generator are not restored, README Gaps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const records = read('records.json');
const groups = read('groups.json');
const startingRules = read('starting-rules.json');
const defaults = read('shipped-defaults.json');

test('every shipped component is in exactly one configuration or is core', () => {
  const core = new Set(records.core);
  const held = new Map();
  for (const configuration of records.configurations) for (const item of configuration.components) {
    assert.ok(!held.has(item.id), `${item.id} is in two configurations`);
    held.set(item.id, configuration.slug);
  }
  for (const item of records.components) {
    assert.equal(held.has(item.id) !== core.has(item.id), true, `${item.id} must be in one configuration or be core, not both or neither`);
  }
  assert.equal(held.size + core.size, records.components.length);
  for (const id of records.pinned) assert.ok(held.has(id), `${id} is pinned but not in a configuration`);
});

test('a configuration holds at most 100 components and its slug is one of the groups', () => {
  for (const configuration of records.configurations) {
    assert.ok(configuration.components.length >= 1 && configuration.components.length <= 100, configuration.slug);
    const base = configuration.slug.replace(/-\d+$/, '');
    assert.ok(groups.configurations[base], `${configuration.slug} has no group`);
  }
  assert.equal(new Set(records.configurations.map(configuration => configuration.slug)).size, records.configurations.length);
  for (const slug of Object.keys(groups.configurations)) assert.match(slug, /^trillion-/);
});

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
  for (const name of ['records.json', 'groups.json', 'starting-rules.json', 'shipped-defaults.json']) {
    assert.doesNotMatch(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'), /[a-z0-9._-]+@(?!example\.)[a-z0-9-]+\.(?:com|org|net|io|me|co)\b/i, name);
  }
});
