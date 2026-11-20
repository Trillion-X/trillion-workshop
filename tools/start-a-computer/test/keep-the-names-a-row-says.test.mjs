// A computer row's names (`runs.names`), kept answering with the row's address through the person's own DNS provider
// description: a missing name is made, a name already right is left alone, a record nobody marked is refused unless the row
// adopts it, differences reports a name that answers elsewhere, and a name whose provider key is not handed is refused before
// any request. A made-up DNS provider answers from memory (the door tool's test description); no network, no real domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepTheNames, namesOf } from '../do-work/start-a-computer.mjs';
import { DNS } from '../../move-the-public-door/test/door-world.mjs';

const TOKEN = 'PRIVATE_TEST_CANARY_TOKEN_12345', zone = 'a1b2c3d4', account = 'acc00001';
const folder = mkdtempSync(join(tmpdir(), 'names-'));
const providerFile = join(folder, 'dns.json');
writeFileSync(providerFile, JSON.stringify({ ...DNS, vault_key: 'dns-key' }));
const held = { 'dns-key': TOKEN };

function world(records) {
  const state = { records, events: [] };
  const reply = (body, status = 200) => new Response(JSON.stringify({ ok: status < 300, ...body }), { status });
  const fetchImpl = async (url, init) => {
    const method = init.method, { pathname, searchParams } = new URL(url), path = pathname.replace('/v1', '');
    assert.equal(init.headers['x-dns-key'], TOKEN);
    const body = init.body && JSON.parse(init.body);
    if (path === '/zones') return reply({ items: searchParams.get('domain') === 'example.com' ? [{ id: zone, account }] : [] });
    if (path === `/zones/${zone}/rules` || path === `/accounts/${account}/links`) return reply({ items: [] });
    if (path === `/zones/${zone}/records` && method === 'GET') return reply({ items: structuredClone(state.records), pages: 1 });
    if (path === `/zones/${zone}/records` && method === 'POST') { state.events.push(`add ${body.value}`); const made = { id: `c${String(state.records.length + 1).padStart(7, '0')}`, proxied: false, ...body }; state.records.push(made); return reply({ item: made }); }
    if (path.startsWith(`/zones/${zone}/records/`) && method === 'DELETE') { const id = path.split('/').at(-1); state.events.push(`remove ${state.records.find(x => x.id === id).value}`); state.records = state.records.filter(x => x.id !== id); return new Response(null, { status: 204 }); }
    return reply({ problem: 'not_found' }, 404);
  };
  return { state, fetchImpl };
}

const request = names => ({ computer_row: { name: 'someones-computer', address: '192.0.2.10', runs: { units: [], names } } });
const files = (extra = {}) => [{ host_name: 'files.example.com', provider: providerFile, ...extra }];
const owned = (id, value) => ({ id, kind: 'A', host: 'files.example.com', value, ttl: 60, proxied: false, note: `${DNS.lease_label_key} files.example.com` });

test('a name the row says is made at the row address, and a name already right is left alone', async () => {
  const w = world([{ id: 'c0000009', kind: 'TXT', host: 'example.com', value: 'unrelated', ttl: 300 }]);
  const kept = await keepTheNames(request(files()), { held, fetchImpl: w.fetchImpl, apply: true });
  assert.deepEqual(kept, [{ host_name: 'files.example.com', address: '192.0.2.10', added: ['192.0.2.10'], removed: [] }]);
  w.state.events.length = 0;
  const again = await keepTheNames(request(files()), { held, fetchImpl: w.fetchImpl, apply: true });
  assert.deepEqual([again[0].added, again[0].removed, w.state.events], [[], [], []]);
  assert.equal(w.state.records[0].value, 'unrelated', 'other records are kept');
});

test('a record nobody marked is refused unless the row adopts the name, and differences says where it answers', async () => {
  const handMade = { id: 'c0000001', kind: 'A', host: 'files.example.com', value: '192.0.2.10', ttl: 60, proxied: false };
  const w = world([handMade]);
  const read = await keepTheNames(request(files()), { held, fetchImpl: w.fetchImpl, apply: false });
  assert.deepEqual(read, [{ host_name: 'files.example.com', address: '192.0.2.10', answers: ['192.0.2.10'], matches: true }]);
  await assert.rejects(keepTheNames(request(files()), { held, fetchImpl: w.fetchImpl, apply: true }), /does not own/);
  const adopted = await keepTheNames(request(files({ adopt: true })), { held, fetchImpl: w.fetchImpl, apply: true });
  assert.deepEqual([adopted[0].added, adopted[0].removed, w.state.events], [[], [], []], 'the hand-made record is the row\'s now, unchanged');
  const elsewhere = world([owned('c0000088', '192.0.2.99')]);
  assert.deepEqual((await keepTheNames(request(files()), { held, fetchImpl: elsewhere.fetchImpl, apply: false }))[0].matches, false);
  const moved = await keepTheNames(request(files()), { held, fetchImpl: elsewhere.fetchImpl, apply: true });
  assert.deepEqual([moved[0].added, moved[0].removed, elsewhere.state.events], [['192.0.2.10'], ['192.0.2.99'], ['add 192.0.2.10', 'remove 192.0.2.99']], 'the new address is answered before the old one goes');
});

test('a name with no key handed, or with no provider, is refused before any request', async () => {
  const w = world([]);
  await assert.rejects(keepTheNames(request(files()), { held: {}, fetchImpl: w.fetchImpl, apply: true }), /vault name dns-key/);
  assert.throws(() => namesOf(request([{ host_name: 'files.example.com' }])), /DNS provider description/);
  assert.throws(() => namesOf(request([{ host_name: 'x.example.com', provider: 'tools/no-such-provider.json' }])), /does not exist/);
  assert.deepEqual(await keepTheNames(request(undefined), { held: {}, apply: true }), [], 'a row with no names keeps none');
});
