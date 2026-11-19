import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCutover, changeCutover, dnsClient, keepHealthyRecords, probeHealthy } from '../do-work/portable-dns-cutover.mjs';
import { keptReceipts } from '../read-data/door-receipts.mjs';
import { DNS } from './door-world.mjs';

const c = { hostname: 'app.example.com', address: '192.0.2.4' }, zone = 'a1b2c3d4', account = 'acc00001', target = 'b0000001', TOKEN = 'PRIVATE_TEST_CANARY_TOKEN_12345';
const record = (id, host, value, extra = {}) => ({ id, kind: 'A', host, value, ttl: 300, proxied: false, ...extra });

// A made-up DNS provider answering from memory: zones, records (paged), guarded rules, and account links (bindings).
function world({ records, links = [] }) {
  const state = { records, links, rules: [{ id: 'r0000001', pattern: '*.example.com/*' }], writes: [], events: [], lose: null };
  const reply = (body, status = 200) => new Response(JSON.stringify({ ok: status < 300, ...body }), { status });
  const fetchImpl = async (url, init) => {
    const method = init.method, { pathname, searchParams } = new URL(url), path = pathname.replace('/v1', '');
    assert.equal(init.headers['x-dns-key'], TOKEN, 'the credential goes in the header the description names');
    const body = init.body && JSON.parse(init.body);
    let answer;
    if (path === '/zones') answer = reply({ items: searchParams.get('domain') === 'example.com' ? [{ id: zone, account }] : [] });
    else if (path === `/zones/${zone}/rules`) answer = reply({ items: structuredClone(state.rules) });
    else if (path === `/zones/${zone}/records` && method === 'GET') answer = reply({ items: state.records.slice((searchParams.get('page') - 1) * 2, searchParams.get('page') * 2).map(x => structuredClone(x)), pages: Math.ceil(state.records.length / 2) });
    else if (path === `/zones/${zone}/records` && method === 'POST') { state.events.push('create-address'); const made = { id: `c${String(state.records.length + 1).padStart(7, '0')}`, proxied: false, ...body }; state.records.unshift(made); state.writes.push(body); answer = reply({ item: structuredClone(made) }); }
    else if (path.startsWith(`/zones/${zone}/records/`) && method === 'PATCH') { const row = state.records.find(x => x.id === path.split('/').at(-1)); Object.assign(row, body); state.writes.push(body); answer = reply({ item: structuredClone(row) }); }
    else if (path.startsWith(`/zones/${zone}/records/`) && method === 'DELETE') { state.events.push('remove-address'); state.records.splice(state.records.findIndex(x => x.id === path.split('/').at(-1)), 1); answer = new Response(null, { status: 204 }); }
    else if (path === `/accounts/${account}/links` && method === 'GET') answer = reply({ items: structuredClone(state.links) });
    else if (path === `/accounts/${account}/links` && method === 'PUT') { state.events.push('restore-link'); state.links.unshift({ id: 'f0000002', stage: 'live', ...body }); state.records.unshift(record('d0000003', body.host, '100::', { kind: 'AAAA', ttl: 1, proxied: true, locked: true, link_id: 'f0000002' })); answer = reply({ item: state.links[0] }); }
    else if (path.startsWith(`/accounts/${account}/links/`) && method === 'DELETE') { state.events.push('remove-link'); state.links.splice(state.links.findIndex(x => x.id === path.split('/').at(-1)), 1); state.records.splice(state.records.findIndex(x => x.link_id), 1); answer = new Response('', { status: 200 }); }
    else answer = reply({ problem: 'not_found' }, 404);
    if (state.lose === method) { state.lose = null; throw Error('connection lost'); }
    return answer;
  };
  const client = (fetch = fetchImpl) => dnsClient(TOKEN, { provider: DNS, fetchImpl: fetch });
  return { state, fetchImpl, client };
}
const plain = () => world({ records: [record(target, c.hostname, 'old.example.com', { kind: 'CNAME', ttl: 1, proxied: true, note: 'keep' }), record('c0000000', 'example.com', 'unrelated', { kind: 'TXT' }), record('c0000009', 'mail.example.com', '192.0.2.99')] });
const file = () => ({ receipts: keptReceipts(), file: 'dns-cutover-test' });
const args = (w, f, extra = {}) => ({ request: w.client(), provider: DNS, ...f, ...extra });

test('exact existing record changes to the direct address; unrelated records, guarded lists and rollback fields survive', async () => {
  const w = plain(), f = file(); await prepareCutover(c, args(w, f));
  assert.equal((await changeCutover(c, args(w, f))).state, 'active');
  const [row] = w.state.records;
  assert.deepEqual([row.value, row.kind, row.proxied, row.note], [c.address, 'A', false, 'keep'], 'only the desired fields change; the rest of the record stays');
  await changeCutover(c, args(w, f)); assert.equal(w.state.writes.length, 1, 'a second activate sends nothing');
  await changeCutover(c, args(w, f, { rollback: true }));
  assert.deepEqual([row.kind, row.value, row.proxied, w.state.records[1].value], ['CNAME', 'old.example.com', true, 'unrelated']);
});

test('concurrent unrelated changes and target changes refuse before mutation', async () => {
  for (const index of [0, 1]) {
    const w = plain(), f = file(); await prepareCutover(c, args(w, f)); w.state.records[index].value = 'independent';
    await assert.rejects(changeCutover(c, args(w, f)), /changed/); assert.equal(w.state.writes.length, 0);
  }
  const w = plain(), f = file(); await prepareCutover(c, args(w, f)); w.state.rules.push({ id: 'r0000002', pattern: 'x/*' });
  await assert.rejects(changeCutover(c, args(w, f)), /guarded lists changed/);
});

test('a lost provider answer reconciles the desired record on retry without a duplicate mutation', async () => {
  const w = plain(), f = file(); await prepareCutover(c, args(w, f)); w.state.lose = 'PATCH';
  await assert.rejects(changeCutover(c, args(w, f)), /connection lost/);
  assert.equal((await f.receipts.read(f.file)).state, 'changing');
  assert.equal((await changeCutover(c, args(w, f))).state, 'active'); assert.equal(w.state.writes.length, 1);
});

test('provider errors and request guards cannot disclose the credential or perform an arbitrary mutation', async () => {
  const bad = dnsClient(TOKEN, { provider: DNS, fetchImpl: async () => new Response(JSON.stringify({ ok: false, problem: 'denied', message: TOKEN }), { status: 403 }) });
  await assert.rejects(bad('GET', '/zones?domain=example.com'), error => !String(error).includes(TOKEN) && /denied/.test(String(error)));
  await assert.rejects(bad('DELETE', `/arbitrary/${target}`), /refused/);
  await assert.rejects(bad('PATCH', '/zones/a1b2c3d4/records'), /refused/);
  assert.throws(() => dnsClient('short', { provider: DNS }), /credential was refused/);
});

function managedWorld() {
  const link = { id: 'f0000001', host: c.hostname, target: 'existing-target', stage: 'live' };
  const w = world({ records: [record(target, c.hostname, '100::', { kind: 'AAAA', ttl: 1, proxied: true, locked: true, link_id: link.id }), record('c0000000', 'example.com', 'unrelated', { kind: 'TXT' })], links: [link, { id: '1000000a', host: 'other.example.com', target: 'other-target', stage: 'live' }] });
  return { ...w, link };
}

test('a managed binding cutover keeps the other bindings and records and puts the original binding back', async () => {
  const w = managedWorld(), f = file(), receipt = await prepareCutover(c, args(w, f));
  assert.deepEqual([receipt.mode, receipt.originalBinding.target], ['managed-binding', 'existing-target']);
  await changeCutover(c, args(w, f)); assert.deepEqual(w.state.events, ['remove-link', 'create-address']);
  assert.equal(w.state.links[0].host, 'other.example.com'); assert.equal(w.state.records[0].proxied, false);
  await changeCutover(c, args(w, f, { rollback: true }));
  assert.deepEqual(w.state.events, ['remove-link', 'create-address', 'remove-address', 'restore-link']);
  assert.deepEqual([w.state.links[0].target, w.state.links[1].host], ['existing-target', 'other.example.com']);
});

test('a lost binding removal retries from the observed state, and an independent binding edit refuses', async () => {
  const w = managedWorld(), f = file(); await prepareCutover(c, args(w, f)); w.state.lose = 'DELETE';
  await assert.rejects(changeCutover(c, args(w, f)), /connection lost/);
  await changeCutover(c, args(w, f)); assert.deepEqual(w.state.events, ['remove-link', 'create-address']);
  w.state.links[0].target = 'independent';
  await assert.rejects(changeCutover(c, args(w, f, { rollback: true })), /Unrelated/);
  assert.deepEqual(w.state.events, ['remove-link', 'create-address']);
});

test('an empty successful delete is accepted only for a delete; anything else empty is not JSON', async () => {
  let body = '', status = 200;
  const request = dnsClient(TOKEN, { provider: DNS, fetchImpl: async () => new Response(body, { status }) });
  assert.deepEqual(await request('DELETE', `/accounts/${account}/links/${'f'.repeat(8)}`), {});
  await assert.rejects(request('GET', `/accounts/${account}/links`), /without JSON/);
  body = 'invalid nonempty JSON';
  await assert.rejects(request('DELETE', `/accounts/${account}/links/${'f'.repeat(8)}`), /without JSON/);
  body = ''; status = 201;
  await assert.rejects(request('DELETE', `/accounts/${account}/links/${'f'.repeat(8)}`), /without JSON/);
});

const member = (id, address) => record(id, c.hostname, address, { ttl: 30, note: 'dns-owner app.example.com' });
const front = [{ address: '192.0.2.10' }, { address: '192.0.2.11' }, { address: '192.0.2.12' }];
const healthyWhen = ok => async candidate => ok.includes(candidate.address);

test('health-checked records: the name answers with exactly the healthy computers, adds first, never empty', async () => {
  const w = world({ records: [member('c0000001', '192.0.2.10'), member('c0000002', '192.0.2.99'), record('c0000000', 'example.com', 'unrelated', { kind: 'TXT' })] });
  const answer = await keepHealthyRecords({ hostname: c.hostname, candidates: front, check: healthyWhen(['192.0.2.11', '192.0.2.10']), request: w.client(), provider: DNS });
  assert.deepEqual([answer.healthy, answer.unhealthy, answer.added.map(x => x.address), answer.removed.map(x => x.address)], [['192.0.2.10', '192.0.2.11'], ['192.0.2.12'], ['192.0.2.11'], ['192.0.2.99']]);
  assert.deepEqual(w.state.events, ['create-address', 'remove-address'], 'the new address is made before the old one goes');
  assert.deepEqual(w.state.records.filter(x => x.host === c.hostname).map(x => x.value).sort(), ['192.0.2.10', '192.0.2.11']);
  assert.equal(w.state.records.at(-1).value, 'unrelated');
  w.state.events.length = 0;
  await keepHealthyRecords({ hostname: c.hostname, candidates: front, check: healthyWhen(['192.0.2.10', '192.0.2.11']), request: w.client(), provider: DNS });
  assert.deepEqual(w.state.events, [], 'a name already right is left alone');
});

test('health-checked records refuse when nothing is healthy, and leave records this set does not own', async () => {
  const w = world({ records: [member('c0000001', '192.0.2.10')] });
  await assert.rejects(keepHealthyRecords({ hostname: c.hostname, candidates: front, check: healthyWhen([]), request: w.client(), provider: DNS }), /No front-door computer is healthy/);
  assert.deepEqual(w.state.events, []);
  const other = world({ records: [record('c0000003', c.hostname, '192.0.2.77')] });
  await assert.rejects(keepHealthyRecords({ hostname: c.hostname, candidates: front, check: healthyWhen(['192.0.2.10']), request: other.client(), provider: DNS }), /does not own/);
  assert.deepEqual(other.state.events, []);
  const taken = await keepHealthyRecords({ hostname: c.hostname, candidates: front, check: healthyWhen(['192.0.2.10']), request: other.client(), provider: DNS, adopt: true });
  assert.deepEqual([taken.added.length, taken.removed.map(x => x.address)], [1, ['192.0.2.77']]);
  await assert.rejects(keepHealthyRecords({ hostname: c.hostname, candidates: [{ address: 'not-an-address' }], check: healthyWhen([]), request: other.client(), provider: DNS }), /public IPv4/);
});

test('a health probe asks the address for the name and is healthy only on HTTP 200', async () => {
  const asked = [];
  const fake = status => (options, onResponse) => {
    asked.push(options);
    return { on() {}, end: () => onResponse({ statusCode: status, resume() {} }), destroy() {} };
  };
  assert.equal(await probeHealthy({ hostname: c.hostname, address: '192.0.2.10', path: '/readyz', requestImpl: fake(200) }), true);
  assert.equal(await probeHealthy({ hostname: c.hostname, address: '192.0.2.10', requestImpl: fake(503) }), false);
  assert.deepEqual([asked[0].host, asked[0].servername, asked[0].headers.host, asked[0].path], ['192.0.2.10', c.hostname, c.hostname, '/readyz']);
});

test('the tool\'s code, rows, kits and README name no DNS or hosting vendor of the person\'s', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const here = new URL('../', import.meta.url), read = path => readFileSync(new URL(path, here), 'utf8');
  const files = ['tool-rows.json', 'README.md', ...['do-work', 'read-data', 'kits'].flatMap(dir => readdirSync(new URL(`${dir}/`, here)).map(name => `${dir}/${name}`))];
  for (const path of files) assert.doesNotMatch(read(path), /hetzner|cloudflare|points_a_name|dns_provider/i, path);
});

test('a name with no address record is placed new: one record is made, nothing else changes, and rollback removes it', async () => {
  const w = world({ records: [record('c0000000', 'example.com', 'unrelated', { kind: 'TXT' }), record('c0000009', 'mail.example.com', '192.0.2.99')] }), f = file();
  const placed = { hostname: 'files.example.com', address: '192.0.2.7' };
  assert.equal((await prepareCutover(placed, args(w, f))).mode, 'new-record');
  w.state.lose = 'POST';
  await assert.rejects(changeCutover(placed, args(w, f)), /connection lost/);
  assert.equal((await changeCutover(placed, args(w, f))).state, 'active', 'a lost answer is found by readback, not made twice');
  const mine = w.state.records.filter(x => x.host === placed.hostname);
  assert.deepEqual([mine.length, mine[0].value, w.state.writes.length], [1, placed.address, 1]);
  assert.equal((await changeCutover(placed, args(w, f))).state, 'active', 'activating again changes nothing');
  assert.equal(w.state.writes.length, 1);
  await changeCutover(placed, args(w, f, { rollback: true }));
  assert.deepEqual(w.state.records.map(x => x.id).sort(), ['c0000000', 'c0000009']);
});

test('a placed name refuses when unrelated records change before it is made', async () => {
  const w = world({ records: [record('c0000000', 'example.com', 'unrelated', { kind: 'TXT' })] }), f = file();
  const placed = { hostname: 'files.example.com', address: '192.0.2.7' };
  await prepareCutover(placed, args(w, f)); w.state.records[0].value = 'independent';
  await assert.rejects(changeCutover(placed, args(w, f)), /Unrelated DNS records/); assert.equal(w.state.writes.length, 0);
});
