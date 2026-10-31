// tool:keep-who-is-connected and tool:request-a-connection-action run as the container runs them, against the fake
// records door with exactly the rows' rights. Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const keep = rowOf(rows, 'tool:keep-who-is-connected');
const ask = rowOf(rows, 'tool:request-a-connection-action');
const how = {
  record_selectors: [{
    id: 'introductions',
    match: { method: 'json-field-equals', params: { path: ['type'], value: 'introduction' } },
    connection: {
      identity: { method: 'json-path', params: { path: ['id'] } },
      endpoints: [
        { role: 'introducer', value: { method: 'json-path', params: { path: ['by'] } } },
        { role: 'introduced', value: { method: 'json-path', params: { path: ['to'] } } },
      ],
      attributes: [{ name: 'at', value: { method: 'json-path', params: { path: ['at'] } } }],
    },
  }],
};
const connection = (n, value) => ({ id: `connection:${n}`, type: 'connection', value: { type: 'introduction', id: `intro:${n}`, at: '2026-01-01', ...value } });
const records = [
  connection(1, { by: 'person:ana', to: 'person:ben' }),
  connection(2, { by: 'person:ben', to: 'company:acme' }),
  { id: 'connection:3', type: 'connection', value: { type: 'note', id: 'note:3' } },
  connection(4, { by: '', to: '' }),
];

test('the map of who is connected is kept as one record per person or company and per connection', async () => {
  const ran = await runRow(keep, { how }, { records });
  assert.equal(ran.status, 0, ran.error);
  assert.deepEqual(
    [ran.result.node_count, ran.result.connection_count, ran.result.kept_count],
    [3, 2, 5],
  );
  assert.ok(ran.result.issues.some(issue => issue.code === 'connection-has-no-endpoints'));
  const kept = ran.kept.filter(record => record.type !== 'connection');
  assert.deepEqual(kept.map(record => record.id).sort(), [
    'graph-connection:intro:1', 'graph-connection:intro:2', 'graph-node:company:acme', 'graph-node:person:ana', 'graph-node:person:ben',
  ]);
  const ben = kept.find(record => record.id === 'graph-node:person:ben');
  assert.deepEqual(ben.value, { id: 'person:ben', attributes: ben.value.attributes });
  const first = kept.find(record => record.id === 'graph-connection:intro:1');
  assert.deepEqual(first.value.endpoints.map(end => [end.role, end.node_id]), [['introducer', 'person:ana'], ['introduced', 'person:ben']]);
});

test('the map row only lists connection records and writes the two map kinds', () => {
  assert.deepEqual(keep.invoke.records.rights, [
    { kind: 'connection', operations: ['records:list'] },
    { kind: 'graph-node', prefix: 'graph-node:', operations: ['records:write'] },
    { kind: 'graph-connection', prefix: 'graph-connection:', operations: ['records:write'] },
  ]);
});

test('without a way to read connections nothing is kept and the run says what to give', async () => {
  const ran = await runRow(keep, {}, { records });
  assert.equal(ran.status, 1);
  assert.match(ran.error, /how\.record_selectors/);
  assert.equal(ran.kept.filter(record => record.type !== 'connection').length, 0);
});

test('an action request is kept under its correlation id with the input read through the mapping', async () => {
  const ran = await runRow(ask, {
    action: { id: 'record', target: 'target:example', input_mapping: { note: { method: 'json-path', params: { path: ['note'] } } } },
    input: { note: 'example data', ignored: true },
    correlation_id: 'corr:1',
  });
  assert.equal(ran.status, 0, ran.error);
  assert.equal(ran.result.request_id, 'connection-action-request:corr:1');
  const [kept] = ran.kept;
  assert.equal(kept.id, 'connection-action-request:corr:1');
  assert.deepEqual(kept.value.payload.input, { note: 'example data' });
  assert.equal(kept.value.target, 'target:example');
});

test('an action with no target is answered as unavailable and nothing is kept', async () => {
  const ran = await runRow(ask, { action: { id: 'record' }, input: {} });
  assert.equal(ran.status, 0, ran.error);
  assert.deepEqual(ran.result, { available: false, reason: 'missing-target' });
  assert.equal(ran.kept.length, 0);
});

test('the request row can only write connection-action-request records', () => {
  assert.deepEqual(ask.invoke.records.rights, [{ kind: 'connection-action-request', prefix: 'connection-action-request:', operations: ['records:write'] }]);
});
