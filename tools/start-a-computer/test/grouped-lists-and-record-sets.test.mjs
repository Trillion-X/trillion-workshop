// The names step's grouped lists and record sets, against a made-up provider world on example.com only: a grouped list expands to one row per
// value, a names entry's record sets are made and removed by compare (its address record untouched), and a provider whose create writes only
// address records is refused before any call. The flat (Namecheap) list is covered by the Namecheap tests, unchanged.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressesOfName, declaredSetsOf, keepRecordSets, recordSetsOf } from '../../move-the-public-door/do-work/portable-dns-cutover.mjs';

const hetzner = JSON.parse(readFileSync(new URL('../providers/hetzner-dns.json', import.meta.url), 'utf8'));
const namecheap = JSON.parse(readFileSync(new URL('../providers/namecheap.json', import.meta.url), 'utf8'));
const ZONE = 'example.com';

// A made-up Hetzner zone: record sets keyed by label and type, each holding its values. Every call is kept, with its body.
function hetznerWorld(sets) {
  const calls = [], store = new Map(sets.map(set => [`${set.name}|${set.type}`, { ...set, records: [...set.records] }]));
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    const [route, query = ''] = path.split('?');
    if (method === 'GET' && route === '/zones') return { zones: query === `name=${ZONE}` ? [{ id: 1, name: ZONE }] : [], meta: { pagination: { last_page: 1 } } };
    if (method === 'GET' && route === `/zones/${ZONE}/rrsets`) {
      return { rrsets: [...store.values()].map(set => ({ name: set.name, type: set.type, ttl: set.ttl, records: set.records.map(value => ({ value })) })), meta: { pagination: { last_page: 1 } } };
    }
    if (method === 'POST' && route === `/zones/${ZONE}/rrsets`) {
      store.set(`${body.name}|${body.type}`, { name: body.name, type: body.type, ttl: body.ttl, records: body.records.map(record => record.value) });
      return { rrset: { name: body.name, type: body.type } };
    }
    const action = /^\/zones\/example\.com\/rrsets\/([^/]+)\/([^/]+)\/actions\/(add_records|remove_records)$/.exec(route);
    if (method === 'POST' && action) {
      const key = `${decodeURIComponent(action[1])}|${decodeURIComponent(action[2])}`, set = store.get(key);
      const values = body.records.map(record => record.value);
      set.records = action[3] === 'add_records' ? [...set.records, ...values] : set.records.filter(value => !values.includes(value));
      return {};
    }
    throw new Error(`the made-up zone has no ${method} ${route}`);
  };
  return { calls, request, store };
}

test('a grouped list expands to one row per value, so the address names every value of its record set', async () => {
  const world = hetznerWorld([{ name: 'www', type: 'A', ttl: 60, records: ['192.0.2.10', '192.0.2.11'] }]);
  const addresses = await addressesOfName({ hostname: `www.${ZONE}`, request: world.request, provider: hetzner });
  assert.deepEqual(addresses, ['192.0.2.10', '192.0.2.11']);
});

test('record sets are made and removed by compare, the MX priority is written in front of its value, and the address record stays', async () => {
  const world = hetznerWorld([
    { name: '@', type: 'MX', ttl: 60, records: ['10 old.example.net.', '10 eforward1.example.net.'] },
    { name: '@', type: 'TXT', ttl: 60, records: ['"v=spf1 -all"'] },
    { name: '@', type: 'A', ttl: 60, records: ['192.0.2.10'] },
  ]);
  const declared = [
    { type: 'MX', value: 'eforward1.example.net.', priority: 10 },
    { type: 'MX', value: 'eforward2.example.net.', priority: 15 },
    { type: 'TXT', value: '"v=spf1 include:spf.example.net ~all"' },
  ];
  const kept = await keepRecordSets({ hostname: ZONE, declared, request: world.request, provider: hetzner });
  assert.deepEqual(kept.added, [{ type: 'MX', value: '15 eforward2.example.net.' }, { type: 'TXT', value: '"v=spf1 include:spf.example.net ~all"' }]);
  assert.deepEqual(kept.removed, [{ type: 'MX', value: '10 old.example.net.' }, { type: 'TXT', value: '"v=spf1 -all"' }]);
  assert.deepEqual(await recordSetsOf({ hostname: ZONE, declared, request: world.request, provider: hetzner }), declaredSetsOf(declared));
  assert.deepEqual(await addressesOfName({ hostname: ZONE, request: world.request, provider: hetzner }), ['192.0.2.10']);
});

test('a record set that does not exist yet is created with its own type, and one that exists is added to', async () => {
  const world = hetznerWorld([]);
  await keepRecordSets({ hostname: ZONE, declared: [{ type: 'MX', value: 'eforward1.example.net.', priority: 10 }], request: world.request, provider: hetzner });
  const created = world.calls.find(call => call.method === 'POST' && call.path === `/zones/${ZONE}/rrsets`);
  assert.equal(created.body.type, 'MX');
  assert.deepEqual(created.body.records, [{ value: '10 eforward1.example.net.' }]);
});

test('a provider whose create writes only address records is refused before any call is sent', async () => {
  const calls = [];
  const request = async (...call) => { calls.push(call); throw new Error('no call is expected'); };
  await assert.rejects(keepRecordSets({ hostname: ZONE, declared: [{ type: 'MX', value: 'eforward1.example.net.', priority: 10 }], request, provider: namecheap }), /creates only address records/);
  assert.equal(calls.length, 0);
});
