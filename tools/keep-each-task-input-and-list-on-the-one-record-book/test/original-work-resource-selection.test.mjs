import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { originalWorkResourceSelection } from '../src/original-work-resource-selection.mjs';

const resources = [{ owner: 'person:7', resource: 'db-a' }, { owner: 'person:7', resource: 'db-b' }, { owner: 'person:7', resource: 'db-c' }];
const identities = [
  { kind: 'original-task', id: 'task:42' },
  { kind: 'input', id: 'input:42:customer-list' },
  { kind: 'list', id: 'list:customers:west' },
];
const fixture = (generation = 'g1', available = resources) => {
  const host = sqliteHost(':memory:');
  let current = generation;
  const selector = originalWorkResourceSelection({ sql: host.sql, transaction: host.transaction, owner: 'person:7', generation, currentGeneration: () => current, resources: available });
  return { host, selector, setGeneration: value => { current = value; } };
};

test('resolves stable original task/input/list identities to durable addressed affinity', t => {
  const a = fixture(), b = fixture();
  t.after(() => { a.host.db.close(); b.host.db.close(); });
  const first = a.selector.resolve({ identities, resources });
  const afterRestart = originalWorkResourceSelection({ sql: a.host.sql, transaction: a.host.transaction, owner: 'person:7', generation: 'g1', resources: [resources[2]] });
  assert.deepEqual(afterRestart.resolve({ identities, resources: [resources[2]] }).resource, first.resource);
  assert.deepEqual(b.selector.resolve({ identities, resources }).resource, first.resource);
  assert.equal(first.identities.length, 3);
  assert.equal(first.generation, 'g1');
});

test('callable work API selects original task, inputs, lists and explicit atomic relationships', t => {
  const { host, selector } = fixture();
  t.after(() => host.db.close());
  const result = selector.resolveWork({ task: 'task:work-1', inputs: ['input:a', 'input:b'], lists: ['list:customers'],
    relationships: [{ id: 'task:work-1/import:customers', identities: [{ kind: 'input', id: 'input:a' }, { kind: 'list', id: 'list:customers' }] }] });
  assert.deepEqual(result.relationships[0].owner, result.inputs[0].owner);
  assert.deepEqual(result.relationships[0].resource, result.inputs[0].resource);
  assert.deepEqual(result.relationships[0].resource, result.lists[0].resource);
  assert.equal(result.task.owner, 'person:7');
  assert.equal(result.generation, 'g1');
});

test('resolveWork rolls back all earlier affinity writes when a later relationship conflicts', t => {
  const host = sqliteHost(':memory:');
  t.after(() => host.db.close());
  let transactions = 0;
  const transaction = fn => { transactions++; return host.transaction(fn); };
  const selector = originalWorkResourceSelection({ sql: host.sql, transaction, owner: 'person:7', generation: 'g1', resources });
  selector.bind({ identities: [{ kind: 'input', id: 'already-a' }], resource: resources[0] });
  selector.bind({ identities: [{ kind: 'list', id: 'already-b' }], resource: resources[1] });
  transactions = 0;
  assert.throws(() => selector.resolveWork({ task: 'task:atomic', relationships: [
    { id: 'group:new-first', identities: [{ kind: 'input', id: 'new-first' }] },
    { id: 'group:conflict', identities: [{ kind: 'input', id: 'already-a' }, { kind: 'list', id: 'already-b' }] },
  ], resources }), error => error.code === 'resource_selection_conflict');
  assert.equal(transactions, 1);
  assert.equal(host.sql.exec("SELECT 1 FROM original_work_resource_groups WHERE group_json='\"group:new-first\"'").toArray().length, 0);
  assert.equal(host.sql.exec("SELECT 1 FROM original_work_resource_bindings WHERE identity_json=?", JSON.stringify({ kind: 'input', id: 'new-first' })).toArray().length, 0);
});

test('atomic relationship group selects one resource and never merges identities already split', t => {
  const { host, selector } = fixture();
  t.after(() => host.db.close());
  const group = 'task:42/customer-batch:9';
  const selected = selector.resolve({ identities, group, resources });
  assert.deepEqual(selector.resolve({ identities: [identities[1], { kind: 'list', id: 'list:customers:east' }], group, resources }).resource, selected.resource);

  const left = selector.resolve({ identities: [{ kind: 'input', id: 'input:left' }], resources });
  const right = resources.find(row => JSON.stringify(row) !== JSON.stringify(left.resource));
  selector.bind({ identities: [{ kind: 'list', id: 'list:foreign' }], resource: right });
  assert.throws(() => selector.resolve({ identities: [{ kind: 'input', id: 'input:left' }, { kind: 'list', id: 'list:foreign' }], group: 'merge:unsafe', resources }),
    error => error.code === 'resource_selection_conflict' && /explicit recovery/.test(error.message));
});

test('explicit binds are idempotent and reject any attempted move', t => {
  const { host, selector } = fixture();
  t.after(() => host.db.close());
  const first = selector.bind({ identities: [identities[0], identities[1]], group: 'atomic:42', resource: resources[0] });
  assert.equal(first.repeated, false);
  assert.equal(selector.bind({ identities: [identities[0], identities[1]], group: 'atomic:42', resource: resources[0] }).repeated, true);
  assert.throws(() => selector.bind({ identities: [identities[0]], resource: resources[1] }), error => error.code === 'resource_selection_conflict');
  assert.deepEqual(selector.resolve({ identities: [identities[0]], group: 'atomic:42', resources }).resource, resources[0]);
});

test('tombstones cannot be rebound and generation changes require a new selector scope', t => {
  const { host, selector, setGeneration } = fixture();
  t.after(() => host.db.close());
  selector.resolve({ identities: [identities[0]], resources });
  const tombstone = selector.tombstone({ identities: [identities[0]], reason: 'source erased' });
  assert.equal(tombstone.tombstoned, 1);
  assert.throws(() => selector.resolve({ identities: [identities[0]], resources }), error => error.code === 'resource_selection_tombstoned');
  setGeneration('g2');
  assert.throws(() => selector.resolve({ identities: [identities[0]], resources }), error => error.code === 'resource_selection_generation_changed');
  const next = originalWorkResourceSelection({ sql: host.sql, transaction: host.transaction, owner: 'person:7', generation: 'g2', currentGeneration: () => 'g2', resources });
  assert.equal(next.resolve({ identities: [identities[0]], resources }).generation, 'g2');
});

test('unknown identity and group tombstones prevent a delayed first resolution', t => {
  const { host, selector } = fixture();
  t.after(() => host.db.close());
  selector.tombstone({ identities: [{ kind: 'input', id: 'late-input' }], group: 'late-group', reason: 'erasure arrived first' });
  assert.throws(() => selector.resolve({ identities: [{ kind: 'input', id: 'late-input' }], resources }), error => error.code === 'resource_selection_tombstoned');
  assert.throws(() => selector.resolve({ identities: [{ kind: 'input', id: 'another-late-input' }], group: 'late-group', resources }), error => error.code === 'resource_selection_tombstoned');
});

test('private original-work selection rejects cross-owner resources', t => {
  const { host, selector } = fixture();
  t.after(() => host.db.close());
  assert.throws(() => selector.resolve({ identities: [identities[0]], resources: [{ owner: 'other-account', resource: 'foreign-db' }] }), error => error.code === 'resource_selection_owner_mismatch');
  assert.throws(() => selector.bind({ identities: [identities[0]], resource: { owner: 'other-account', resource: 'foreign-db' } }), error => error.code === 'resource_selection_owner_mismatch');
});

test('lookup mode refuses unbound legacy identities while preserving explicit existing bindings', t => {
  const { host, selector } = fixture();
  t.after(() => host.db.close());
  assert.throws(() => selector.resolve({ identities: [identities[0]], resources, create: false }), error => error.code === 'resource_selection_unbound');
  selector.bind({ identities: [identities[0]], resource: resources[0] });
  assert.deepEqual(selector.resolve({ identities: [identities[0]], resources: [resources[2]], create: false }).resource, resources[0]);
  assert.throws(() => selector.resolveWork({ task: 'task:known', inputs: ['input:new'], resources, create: false }), error => error.code === 'resource_selection_unbound');
  assert.equal(host.sql.exec('SELECT COUNT(*) AS n FROM original_work_resource_bindings').toArray()[0].n, 1);
});

test('indexed chooser receives deterministic affinity key and selects a single addressed resource', t => {
  const host = sqliteHost(':memory:');
  t.after(() => host.db.close());
  const keys = [];
  const selector = originalWorkResourceSelection({ sql: host.sql, transaction: host.transaction, owner: 'person:7', generation: 'g1',
    selectResource: key => { keys.push(key); return resources[1]; } });
  const result = selector.resolve({ identities: [identities[0]] });
  assert.deepEqual(result.resource, resources[1]);
  assert.equal(keys.length, 1);
  assert.equal(keys[0][0], 'person:7');
  assert.equal(keys[0][1], 'g1');
  assert.equal(keys[0][2].length, 1);
});

test('existing bindings resolve without consulting a candidate pool or indexed chooser', t => {
  const host = sqliteHost(':memory:');
  t.after(() => host.db.close());
  const initial = originalWorkResourceSelection({ sql: host.sql, transaction: host.transaction, owner: 'person:7', generation: 'g1', resources });
  const bound = initial.bind({ identities: [identities[0]], group: 'existing-group', resource: resources[2] });
  const selector = originalWorkResourceSelection({ sql: host.sql, transaction: host.transaction, owner: 'person:7', generation: 'g1',
    selectResource: () => { throw new Error('chooser must not run for existing affinity'); } });
  assert.deepEqual(selector.resolve({ identities: [identities[0]], group: 'existing-group' }).resource, bound.resource);
});

test('selection input bounds refuse oversized identity and task arrays', t => {
  const { host, selector } = fixture();
  t.after(() => host.db.close());
  const oversized = Array.from({ length: 1001 }, (_, index) => ({ kind: 'input', id: `input:${index}` }));
  assert.throws(() => selector.resolve({ identities: oversized, resources }), /at most 1000/);
  assert.throws(() => selector.resolveWork({ task: 'task:bounded', inputs: Array.from({ length: 1001 }, (_, index) => `input:${index}`), resources }), /at most 1000/);
  assert.equal(host.sql.exec('SELECT COUNT(*) AS n FROM original_work_resource_bindings').toArray()[0].n, 0);
});

test('tombstoning a relationship group closes late resolution for unbound members', t => {
  const { host, selector } = fixture();
  t.after(() => host.db.close());
  selector.resolve({ identities: [identities[0]], group: 'erased:group', resources });
  selector.tombstone({ group: 'erased:group', reason: 'relationship removed' });
  assert.throws(() => selector.resolve({ identities: [{ kind: 'input', id: 'late-child' }], group: 'erased:group', resources }), error => error.code === 'resource_selection_tombstoned');
});
