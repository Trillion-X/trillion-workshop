// The rows, run the way the engine runs them: the files each row packs, its argv and its filled standard input, and the
// records door on the row's descriptor with exactly the row's rights (test-helpers/run-a-row.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { serviceConnectionsType } from '../read-data/public-door-rows.mjs';
import { ROWS } from './door-world.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const records = Object.entries(ROWS).map(([name, value]) => ({ id: `${serviceConnectionsType}:${name}`, type: serviceConnectionsType, value }));

test('where the door runs is read from the Service connections rows the row may list, and nothing is written', async () => {
  const ran = await answerOf(rowOf(rows, 'tool:see-where-the-public-door-runs'), {}, { records });
  assert.equal(ran.status, 0);
  assert.deepEqual([ran.result.current.hosting_provider, ran.result.current.dns_provider], ['hetzner', 'cloudflare']);
  assert.deepEqual(ran.result.hosting_providers.map(r => r.id), ['fly', 'hetzner', 'own-box']);
  assert.ok(ran.calls.every(call => call.method === 'records:list'));
});

test('a row that needs a held value refuses, naming the mount, when the run was handed none', async () => {
  const ran = await answerOf(rowOf(rows, 'tool:cut-a-hostname-over-to-a-new-address'), { action: 'prepare', cutover: 'dns-cutover-door-two', hostname: 'door.example.com', address: '192.0.2.4' }, { records, held: { 'cloudflare-api-token': '' } });
  assert.equal(ran.status, 1);
  assert.match(ran.error, /no held value named cloudflare-api-token/);
  assert.ok(!ran.kept.some(record => record.type === 'record:public-door-receipt'), 'no receipt is kept for a cutover that never started');
});

test('every row that takes a held value mounts it under the variable its vault name names, and no row prints one', () => {
  for (const { payload } of rows.records) {
    for (const mount of payload.invoke.credential_mounts ?? []) assert.equal(mount.env, mount.secret_name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), payload.id);
    assert.ok(!payload.invoke.credential_mounts?.some(mount => mount.fd !== undefined || mount.mount_path !== undefined), `${payload.id} hands its key only in its own environment`);
  }
});
