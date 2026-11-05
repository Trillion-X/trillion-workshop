// The saved-configurations routes (tool:answer-the-configurations-page). The owner cases are old trillion's
// test/configurations-record-engine.test.mjs (tag old-trillion-before-worker-retire), ported: there they ran the owner on
// the real SQLite record engine; here on the run's records as the route reads them (recordsInMemory), which is the
// store the route gives the owner. The cases that tested the record engine itself (sealing, rollback) and the Lists and
// your-records adapters stay with those owners. Then the row runs as the container runs it, against the fake records
// door with exactly its rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { makeConfigurations } from '../../query-and-change-list-rows/src/configurations.mjs';
import { recordsInMemory } from '../do-work/answer-the-configurations-page.mjs';

const accounts = { id: 'list:accounts', type: 'list', value: { label: 'Accounts', row_type: 'accounts', fields: [{ id: 'title', label: 'Name', kind: 'text' }, { id: 'owner', label: 'Owner', kind: 'text' }] } };
function fixture(records = [accounts]) {
  const eeaf = recordsInMemory(records);
  const configurations = makeConfigurations({ eeaf, owner: () => ({ id: 'relay-real', name: 'Avery' }),
    fieldsForTarget: target => (target.startsWith('list:') ? eeaf.read(target)?.fields.map(field => field.id) ?? [] : null) });
  return { eeaf, configurations };
}
const definition = (id, extra = {}) => ({ id, label: `Configuration ${id}`, target: 'list:accounts',
  field_ids: ['title', 'owner'], aspects: ['search'], settings: { search: 'Caroline' }, ...extra });

test('configuration create, target cursors, exact reads and removals', () => {
  const { eeaf, configurations: c } = fixture();
  for (let n = 0; n < 8; n++) c.save(definition(`c${n}`, n % 2 ? { target: 'screen:connections', open_path: '/connections' } : {}));
  assert.equal(eeaf.written.get('record:configuration:c0').type, 'record:configuration');
  let before;
  const ids = [];
  do {
    const page = c.list({ target: 'list:accounts', limit: 2, before });
    ids.push(...page.configurations.map(row => row.id)); before = page.next_before;
  } while (before);
  assert.deepEqual(ids, ['record:configuration:c6', 'record:configuration:c4', 'record:configuration:c2', 'record:configuration:c0']);
  assert.equal(c.get('c0').label, 'Configuration c0');
  assert.equal(eeaf.read('list:saved-configurations').row_type, 'configuration', 'the first save makes the Saved configurations list');
  const edited = c.save({ id: 'c0', expected_revision: 1, label: 'Edited', target: 'screen:connections', open_path: '/connections' });
  assert.equal(edited.revision, 2);
  assert.ok(!c.list({ target: 'list:accounts' }).configurations.some(row => row.id === edited.id));
  assert.ok(c.list({ target: 'screen:connections' }).configurations.some(row => row.id === edited.id));
  const reopened = makeConfigurations({ eeaf: recordsInMemory([...eeaf.written.values()]) });
  assert.equal(reopened.get('c0').revision, 2);
  assert.throws(() => reopened.remove('c0', 1), error => error.status === 409);
  reopened.remove('c0', 2);
  assert.equal(reopened.get('c0'), null);
  assert.ok(!reopened.list({ target: 'screen:connections' }).configurations.some(row => row.id === edited.id));
});

test('managed list keeps navigation: a configuration opens on its screen with its identity', () => {
  const { configurations: c } = fixture();
  c.save(definition('c1'));
  assert.match(c.get('c1').open_path, /configuration=record%3Aconfiguration%3Ac1/);
});

test('strict configuration model survives a colliding user summary list without rewriting it', () => {
  const { eeaf, configurations: c } = fixture([accounts, { id: 'list:saved-configurations', type: 'list', value: { label: 'My unrelated list', row_type: 'unrelated' } }]);
  c.save(definition('c1'));
  assert.equal(eeaf.read('list:saved-configurations').row_type, 'unrelated');
  assert.equal(c.get('c1').revision, 1);
  assert.equal(c.list({ target: 'list:accounts' }).configurations.length, 1);
});

const row = rowOf(rows, 'tool:answer-the-configurations-page');
const route = (path, method = 'GET', body = {}, query = {}) => ({ path, method, query, body, browser: { user_agent: 'sample', origin: 'https://app.example', visitor: 'visitor-sample' } });

test('the page saves, reads, lists, updates at its revision, copies and removes configurations as own records', async () => {
  const saved = await answerOf(row, route('/configurations', 'POST', definition('c1')), { records: [accounts] });
  assert.equal(saved.status, 0, saved.error);
  assert.equal(saved.result.status, 200, JSON.stringify(saved.result));
  const one = saved.result.body.configuration;
  assert.equal(one.id, 'record:configuration:c1');
  assert.deepEqual(one.field_ids, ['title', 'owner'], 'a list target\'s fields come from its list record');
  assert.equal(one.owner_name, 'You');
  assert.deepEqual(saved.kept.map(record => record.id).sort(), ['list:accounts', 'list:saved-configurations', 'record:configuration:c1']);

  const read = await answerOf(row, route('/configurations/c1'), { records: saved.kept });
  assert.deepEqual(read.result, { status: 200, body: { configuration: one } });
  const missing = await answerOf(row, route('/configurations/nowhere'), { records: saved.kept });
  assert.deepEqual(missing.result, { status: 404, body: { error: 'This configuration is no longer available.', code: 'configuration_not_found' } });

  const listed = await answerOf(row, route('/configurations', 'GET', {}, { target: 'list:accounts' }), { records: saved.kept });
  assert.deepEqual(listed.result.body, { configurations: [one], next_before: null });
  const badLimit = await answerOf(row, route('/configurations', 'GET', {}, { limit: '0' }), { records: saved.kept });
  assert.equal(badLimit.result.status, 400);

  const stale = await answerOf(row, route('/configurations/c1', 'POST', { label: 'Old editor', expected_revision: 0 }), { records: saved.kept });
  assert.equal(stale.result.status, 409);
  assert.equal(stale.result.body.code, 'configuration_conflict');
  assert.deepEqual(stale.kept, saved.kept, 'a refused change writes nothing');

  const renamed = await answerOf(row, route('/configurations/c1', 'POST', { label: 'Renamed', expected_revision: 1 }), { records: saved.kept });
  assert.equal(renamed.result.body.configuration.revision, 2);
  const copied = await answerOf(row, route('/configurations/c1/duplicate', 'POST', {}), { records: renamed.kept });
  assert.equal(copied.result.body.configuration.label, 'Renamed copy');
  assert.equal(copied.result.body.configuration.copied_from, 'record:configuration:c1');

  const removed = await answerOf(row, route('/configurations/c1', 'POST', { remove: true, expected_revision: 2 }), { records: renamed.kept });
  assert.deepEqual(removed.result, { status: 200, body: { removed: 'record:configuration:c1' } });
  assert.ok(!removed.kept.some(record => record.id === 'record:configuration:c1'));
});

test('configurations shared with this account answer the old handler\'s unavailable, never a made-up list', async () => {
  const shared = await answerOf(row, route('/configurations', 'GET', {}, { visibility: 'shared' }));
  assert.deepEqual(shared.result, { status: 503, body: { error: 'Saved configurations are temporarily unavailable. Try again.', code: 'configuration_unavailable' } });
  assert.equal((await answerOf(row, route('/configurations/shared/some-code'))).result.status, 503);
});

test('the row lists and writes only configurations and reads only lists', () => {
  assert.deepEqual(row.invoke.records.rights, [
    { kind: 'record:configuration', operations: ['records:list', 'records:write'] },
    { kind: 'list', id: 'list:saved-configurations', operations: ['records:read', 'records:write'] },
    { kind: 'list', prefix: 'list:', operations: ['records:read'] },
  ]);
  assert.equal(row.invoke.internet, false);
});
