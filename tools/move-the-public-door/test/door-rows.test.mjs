// The rows, run the way the engine runs them: the files each row packs, its argv and its filled standard input
// (test-helpers/run-a-row.mjs). The three rows that act on a provider are handed no records door: they take the Service
// connections rows (and the lease or receipt an earlier answer gave) as input and answer the lease or receipt they make.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { ROWS, connectionValues, DNS } from './door-world.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const sample = id => rowOf(rows, id).verify[0];
const records = Object.entries(ROWS).map(([name, value]) => ({ id: `record:service-connection:${name}`, type: 'record:service-connection', value }));

test('where the door runs is read from the Service connections rows the row may list, and nothing is written', async () => {
  const ran = await answerOf(rowOf(rows, 'tool:see-where-the-public-door-runs'), {}, { records });
  assert.equal(ran.status, 0);
  assert.deepEqual([ran.result.current.hosting_provider, ran.result.current.hostname], ['example-cloud', 'door.example.com']);
  assert.deepEqual(ran.result.hosting_providers.map(r => r.id), ['example-cloud', 'no-public-address', 'own-box']);
  assert.ok(ran.calls.every(call => call.method === 'records:list'));
});

test('the rows that act on a provider declare no records door', () => {
  for (const id of ['tool:rent-a-host-for-the-public-door', 'tool:release-a-host-of-the-public-door', 'tool:cut-a-hostname-over-to-a-new-address']) {
    const row = rowOf(rows, id);
    assert.equal(row.invoke.records, undefined, id);
    assert.ok(row.input_schema.required.some(key => ['connections', 'dns'].includes(key)), `${id} takes the rows it needs as input`);
    assert.ok(!/Public door receipts/.test(row.description), `${id} no longer names a receipts list`);
  }
});

test('a row that needs a held value refuses, naming the mount, when the run was handed none', async () => {
  const ran = await answerOf(rowOf(rows, 'tool:cut-a-hostname-over-to-a-new-address'), { action: 'prepare', hostname: 'door.example.com', address: '192.0.2.4', dns: DNS }, { held: { 'example-dns-token': '' } });
  assert.equal(ran.status, 1);
  assert.match(ran.error, /no held value named example-dns-token/);
  assert.deepEqual([ran.kept, ran.calls], [[], []], 'no records door was handed to the run');
});

test('rent answers the lease it makes and keeps nothing; the answered lease reused as input is answered again untouched', async () => {
  const row = rowOf(rows, 'tool:rent-a-host-for-the-public-door'), { input, replies } = sample('tool:rent-a-host-for-the-public-door');
  const ran = await answerOf(row, input, { replies });
  assert.equal(ran.status, 0);
  assert.deepEqual([ran.result.state, ran.result.provider, ran.result.address, ran.result.serverId, ran.result.sshKeyId], ['running', 'example-cloud', '198.51.100.24', 4711, 2323]);
  assert.deepEqual([ran.kept, ran.calls], [[], []]);
  const again = await answerOf(row, { ...input, lease: ran.result }, { replies: [] });
  assert.equal(again.status, 0);
  assert.deepEqual([again.result.reused, again.result.serverId], [true, 4711]);
});

test('release answers the removed lease from the lease handed in and keeps nothing', async () => {
  const { input, replies } = sample('tool:release-a-host-of-the-public-door');
  const ran = await answerOf(rowOf(rows, 'tool:release-a-host-of-the-public-door'), input, { replies });
  assert.equal(ran.status, 0);
  assert.deepEqual([ran.result.state, ran.result.serverId, ran.result.sshKeyId, typeof ran.result.removedAt], ['removed', 4711, 2323, 'number']);
  assert.deepEqual([ran.kept, ran.calls], [[], []]);
});

test('cut prepare answers the receipt, and status reads it back from the receipt handed in, with no provider call', async () => {
  const row = rowOf(rows, 'tool:cut-a-hostname-over-to-a-new-address'), { input, replies } = sample('tool:cut-a-hostname-over-to-a-new-address');
  const prepared = await answerOf(row, input, { replies });
  assert.equal(prepared.status, 0);
  assert.deepEqual([prepared.result.state, prepared.result.receipt.state, prepared.result.receipt.hostname], ['prepared', 'prepared', 'door.example.com']);
  assert.deepEqual([prepared.kept, prepared.calls], [[], []]);
  const status = await answerOf(row, { ...input, action: 'status', receipt: prepared.result.receipt }, { replies: [] });
  assert.equal(status.status, 0);
  assert.deepEqual([status.result.state, status.result.original.value], ['prepared', '192.0.2.10']);
});

test('every row that takes a held value mounts it under the variable its vault name names, and no row prints one', () => {
  for (const { payload } of rows.records) {
    for (const mount of payload.invoke.credential_mounts ?? []) assert.equal(mount.env, mount.secret_name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), payload.id);
    assert.ok(!payload.invoke.credential_mounts?.some(mount => mount.fd !== undefined || mount.mount_path !== undefined), `${payload.id} hands its key only in its own environment`);
  }
});
