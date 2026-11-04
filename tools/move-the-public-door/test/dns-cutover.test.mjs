import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCutover, changeCutover, dnsClient } from '../do-work/portable-dns-cutover.mjs';
import { dnsProvider } from '../read-data/public-door-rows.mjs';
import { doorReceipts } from '../read-data/door-receipts.mjs';
import { doorWorld, ROWS } from './door-world.mjs';
const c = { hostname: 'app.example.com', address: '192.0.2.4' }, zone = 'a'.repeat(32), target = 'b'.repeat(32);
// The Cloudflare row as the reader maps it, read from a list that holds only it.
const cloudflare = await dnsProvider('cloudflare', { list: async function* () { yield { id: 'record:service-connection:cloudflare', value: ROWS.cloudflare }; } });
function provider() {
  const records = [{ id: target, type: 'CNAME', name: c.hostname, content: 'old.example.com', ttl: 1, proxied: true, comment: 'keep', tags: [] }, { id: 'c'.repeat(32), type: 'TXT', name: 'example.com', content: 'unrelated', ttl: 300 }];
  const routes = [{ id: 'd'.repeat(32), pattern: '*.example.com/*', script: 'old' }], writes = [];
  return { records, writes, request: async (method, path, body) => {
    if (path.startsWith('zones?')) return { result: path.endsWith('name=example.com') ? [{ id: zone, account: {id: 'e'.repeat(32)} }] : [] };
    if (path.includes('workers/domains')) return {result: []};
    if (path.includes('workers/routes')) return { result: structuredClone(routes) };
    if (method === 'PATCH') { writes.push(structuredClone(body)); Object.assign(records[0], body); return { result: structuredClone(records[0]) }; }
    return { result: structuredClone(records), result_info: { total_pages: 1 } };
  } };
}
// Where a cutover's receipt is kept: one Public door receipts row of a fresh list.
async function file(t) { const { door } = await doorWorld(t); return { receipts: doorReceipts(door), file: 'dns-cutover-test' }; }
test('exact existing record changes to direct host; unrelated DNS, routes and rollback fields survive', async t => {
  const p = provider(), f = await file(t); await prepareCutover(c, { request: p.request, ...f });
  assert.equal((await changeCutover(c, { request: p.request, ...f })).state, 'active');
  assert.equal(p.records[0].content, c.address); assert.equal(p.records[0].proxied, false); assert.equal(p.records[0].comment, 'keep');
  await changeCutover(c, { request: p.request, ...f }); assert.equal(p.writes.length, 1);
  await changeCutover(c, { request: p.request, ...f, rollback: true });
  assert.equal(p.records[0].type, 'CNAME'); assert.equal(p.records[0].content, 'old.example.com'); assert.equal(p.records[0].proxied, true); assert.equal(p.records[1].content, 'unrelated');
});
test('concurrent unrelated changes and target changes refuse before mutation', async t => {
  for (const index of [0, 1]) { const p = provider(), f = await file(t); await prepareCutover(c, { request: p.request, ...f }); p.records[index].content = 'independent'; await assert.rejects(changeCutover(c, { request: p.request, ...f }), /changed/); assert.equal(p.writes.length, 0); }
});
test('lost provider answer reconciles desired record on retry without duplicate mutation', async t => {
  const p = provider(), f = await file(t); await prepareCutover(c, { request: p.request, ...f });
  const broken = async (...args) => { const answer = await p.request(...args); if (args[0] === 'PATCH') throw Error('connection lost'); return answer; };
  await assert.rejects(changeCutover(c, { request: broken, ...f }), /connection lost/);
  assert.equal((await f.receipts.read(f.file)).state, 'changing');
  assert.equal((await changeCutover(c, { request: p.request, ...f })).state, 'active'); assert.equal(p.writes.length, 1);
});
test('provider error and request guards cannot disclose credential or perform arbitrary mutation', async () => {
  const token = 'PRIVATE_TEST_CANARY_TOKEN_12345';
  const request = dnsClient(token, { provider: cloudflare, fetchImpl: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: token }] }), { status: 403 }) });
  await assert.rejects(request('GET', `zones?name=example.com`), e => !String(e).includes(token));
  await assert.rejects(request('DELETE', `arbitrary/${target}`), /refused/);
});
function managedProvider() {
  const p = provider();
  const old = {id: 'f'.repeat(40), hostname: c.hostname, service: 'existing-service', environment: 'production', zone_id: zone, enabled: true, previews_enabled: false};
  const domains = [structuredClone(old), {id: '1'.repeat(40), hostname: 'other.example.com', service: 'other-service', environment: 'production'}];
  p.records[0] = {id: target, type: 'AAAA', name: c.hostname, content: '100::', ttl: 1, proxied: true, meta: {read_only: true, origin_worker_id: old.id}};
  const initial = structuredClone(p.records[0]), originalRequest = p.request, events = [];
  return {...p, domains, events, request: async (method, path, body) => {
    if (path.includes('workers/domains')) {
      if (method === 'DELETE') {events.push('remove-domain'); domains.splice(0,1); p.records.splice(0,1); return {result: {}};}
      if (method === 'PUT') {events.push('restore-domain'); domains.unshift({...old, ...body}); p.records.unshift({...initial, id: '2'.repeat(32)}); return {result: domains[0]};}
      return {result: structuredClone(domains)};
    }
    if (method === 'POST') {events.push('create-address'); p.records.unshift({id:'3'.repeat(32), ...body}); return {result: structuredClone(p.records[0])};}
    if (method === 'DELETE') {events.push('remove-address'); p.records.splice(0,1); return {result: {}};}
    return originalRequest(method,path,body);
  }};
}
test('managed custom-domain cutover preserves other domains and routes and restores original binding', async t => {
  const p = managedProvider(), f = await file(t); const receipt = await prepareCutover(c,{request:p.request,...f});
  assert.equal(receipt.mode,'worker-domain'); assert.equal(receipt.originalDomain.service,'existing-service');
  await changeCutover(c,{request:p.request,...f}); assert.deepEqual(p.events,['remove-domain','create-address']);
  assert.equal(p.domains[0].hostname,'other.example.com'); assert.equal(p.records[0].proxied,false);
  await changeCutover(c,{request:p.request,...f,rollback:true});
  assert.deepEqual(p.events,['remove-domain','create-address','remove-address','restore-domain']);
  assert.equal(p.domains[0].service,'existing-service'); assert.equal(p.domains[1].hostname,'other.example.com'); assert.equal(p.records[0].content,'100::');
});
test('managed custom-domain lost deletion answer retries from observed state; independent domain edit refuses', async t => {
  const p = managedProvider(), f = await file(t); await prepareCutover(c,{request:p.request,...f}); let lost=true;
  const transport=async (...args)=>{const answer=await p.request(...args); if(lost && args[0]==='DELETE'){lost=false; throw Error('lost answer');}return answer;};
  await assert.rejects(changeCutover(c,{request:transport,...f}),/lost answer/);
  await changeCutover(c,{request:p.request,...f}); assert.deepEqual(p.events,['remove-domain','create-address']);
  p.domains[0].service='independent'; await assert.rejects(changeCutover(c,{request:p.request,...f,rollback:true}),/Unrelated/);
  assert.deepEqual(p.events,['remove-domain','create-address']);
});

test('empty successful Worker domain deletion still permits only the exact delete operation', async () => {
 let body = '', status = 200;
 const request = dnsClient('PRIVATE_TEST_CANARY_TOKEN_12345', {provider: cloudflare, fetchImpl: async () => new Response(body, {status})});
 assert.deepEqual(await request('DELETE', `accounts/${'a'.repeat(32)}/workers/domains/${'f'.repeat(40)}`), {success:true,result:null});
 await assert.rejects(request('GET',`accounts/${'a'.repeat(32)}/workers/domains`), /not JSON/);
 body = 'invalid nonempty JSON';
 await assert.rejects(request('DELETE',`accounts/${'a'.repeat(32)}/workers/domains/${'f'.repeat(40)}`), /not JSON/);
 body = ''; status = 201;
 await assert.rejects(request('DELETE',`accounts/${'a'.repeat(32)}/workers/domains/${'f'.repeat(40)}`), /not JSON/);
});
