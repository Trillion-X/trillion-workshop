import test from 'node:test';
import assert from 'node:assert/strict';
import { yourRecordsStore } from '../src/your-records.mjs';
import { makeConfigurations } from '../src/configurations.mjs';

function memory() {
  const rows = new Map(), commits = [];
  return {
    rows, commits,
    read: id => structuredClone(rows.get(id)?.value ?? null),
    ids: (type, {limit = Infinity} = {}) => [...rows.values()].filter(row => row.type === type).map(row => row.id).sort().slice(0, limit),
    write(records, context) {
      commits.push(structuredClone({records, context}));
      for (const row of records) rows.set(row.id, structuredClone(row));
    },
  };
}
function fixture() {
  const eeaf = memory();
  const configurationOwner = scope => makeConfigurations({
    ...scope,
    owner: () => ({id: 'relay-real', name: 'Sam Example'}),
    fieldsForTarget: target => target === 'list:accounts' ? ['title', 'owner'] : null,
    now: () => 1791820800000,
  });
  const records = yourRecordsStore(eeaf, {configurationOwner});
  return {eeaf, records, configurationOwner};
}
const definition = extra => ({label: 'Caroline’s accounts', target: 'list:accounts',
  aspects: ['search'], settings: {search: 'Caroline'}, ...extra});
const row = (id, value) => ({type: 'configuration', id, value});

test('Workshop configuration outputs use the canonical owner, identity, metadata and list', () => {
  const {eeaf, records} = fixture();
  const kept = records.write([row('c1', definition({id: 'another-record', type: 'configuration',
    owner: {id: 'relay-spoof', name: 'Caroline'}, owner_name: 'Caroline', revision: 99,
    created_at: 'spoofed', updated_at: 'spoofed'}))], {tool_id: 'tool:accounts', task_id: 'task:one'});
  assert.deepEqual(kept, [{type: 'configuration', id: 'c1'}]);
  const saved = eeaf.read('record:configuration:c1');
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.owner, {id: 'relay-real', name: 'Sam Example'});
  assert.equal(saved.owner_name, 'Sam Example');
  assert.notEqual(saved.created_at, 'spoofed');
  assert.equal(saved.created_at, saved.updated_at);
  assert.equal(eeaf.read('record:configuration:another-record'), null);
  assert.deepEqual(saved.field_ids, ['title', 'owner']);
  assert.deepEqual(saved.settings, {search: 'Caroline'});
  assert.equal(new URL(saved.open_path, 'https://test').searchParams.get('configuration'), 'record:configuration:c1');
  assert.equal(eeaf.read('list:saved-configurations').row_type, 'configuration');
  assert.equal(eeaf.commits.length, 1);
  assert.deepEqual(eeaf.commits[0].context.actor, {by: 'tool:accounts', task_id: 'task:one'});
});

test('a generic output cannot blindly replace a configuration or bypass a newer revision', () => {
  const {eeaf, records, configurationOwner} = fixture();
  records.write([row('c1', definition())]);
  assert.throws(() => records.write([row('c1', {label: 'Blind overwrite', revision: 1})]), error => error.status === 409);
  assert.equal(eeaf.read('record:configuration:c1').revision, 1);
  records.write([row('c1', {label: 'Admitted update', expected_revision: 1})]);
  assert.equal(eeaf.read('record:configuration:c1').revision, 2);
  configurationOwner({eeaf}).save({id: 'c1', label: 'Another editor', expected_revision: 2});
  assert.throws(() => records.write([row('c1', {label: 'Stale output', expected_revision: 2})]), error => error.code === 'configuration_conflict');
  assert.equal(eeaf.read('record:configuration:c1').label, 'Another editor');
  assert.equal(eeaf.read('record:configuration:c1').revision, 3);
});

test('mixed record batches commit once and a late conflict leaves every earlier staged row untouched', () => {
  const {eeaf, records} = fixture();
  records.write([{type: 'customer', id: 'one', value: {name: 'Original'}}, row('c1', definition()), row('c2', definition())]);
  assert.equal(eeaf.commits.length, 1);
  const original = structuredClone([...eeaf.rows]);
  assert.throws(() => records.write([
    {type: 'customer', id: 'one', value: {name: 'Would change'}},
    row('c1', {label: 'Would also change', expected_revision: 1}),
    row('c2', {label: 'Conflict', expected_revision: 9}),
  ]), error => error.status === 409);
  assert.deepEqual([...eeaf.rows], original);
  assert.equal(eeaf.commits.length, 1);
  records.write([
    {type: 'customer', id: 'one', value: {name: 'Changed'}},
    row('c1', {label: 'Changed too', expected_revision: 1}),
  ]);
  assert.equal(eeaf.commits.length, 2);
  assert.equal(eeaf.read('record:customer:one').name, 'Changed');
  assert.equal(eeaf.read('record:configuration:c1').revision, 2);
});

test('configuration validation uses receiving fields and refuses unsafe definitions before any batch write', () => {
  const {eeaf, records} = fixture();
  const attempted = value => [{type: 'customer', id: 'one', value: {name: 'Would be new'}}, row('c1', value)];
  assert.throws(() => records.write(attempted(definition({field_ids: ['invented'], aspects: ['sort'],
    settings: {sort: [{field: 'invented', direction: 'asc'}]}}))), /Unknown view field/);
  assert.throws(() => records.write(attempted(definition({open_path: '//outside.test'}))), /Trillion screen/);
  assert.equal(eeaf.commits.length, 0);
  assert.equal(eeaf.rows.size, 0);
});

test('ordinary dotted and underscored record kinds retain replacement, read bounds and batch validation', () => {
  const {eeaf, records} = fixture();
  records.write([{type: 'app.contact', id: 'one', value: {name: 'First'}}, {type: 'customer_step', id: 'two', value: {step: 1}}]);
  records.write([{type: 'app.contact', id: 'one', value: {name: 'Replacement'}}]);
  assert.deepEqual(records.read(['app.contact']), [{name: 'Replacement'}]);
  assert.throws(() => records.read(['app.contact', 'customer_step'], {at_most: 1}), /more than 1/);
  assert.throws(() => records.write([{type: 'app.contact', id: 'one', value: {name: 'Invalid batch'}}, {type: 'customer_step', id: 'bad/id', value: {step: 2}}]), /without/);
  assert.equal(eeaf.commits.length, 2);
  assert.equal(eeaf.read('record:app.contact:one').name, 'Replacement');
});
