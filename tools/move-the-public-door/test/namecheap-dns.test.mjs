// The DNS client against the Namecheap provider description (tools/start-a-computer/providers/namecheap.json), which is sent
// through the engine's call of Namecheap's MCP server (transport "engine"; no credential held). The rules under test: a name
// is kept on the row's address alone; a record nobody owns (its address is not a candidate) is never removed or rewritten, and
// is refused unless the row adopts the name; removal sends the record body (Namecheap keeps no ids); only tools the description
// declares are sent; a refusal names the tool, never the answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addressesOfName, dnsClient, keepHealthyRecords } from '../do-work/portable-dns-cutover.mjs';
import { namecheapWorld as world, provider, zone, host, ROW, OLD } from './namecheap-world.mjs';

const txt = (name, value) => ({ type: 'TXT', name, value, ttl: 300 });
const aRecord = (name, address) => ({ type: 'A', name, address, ttl: 60 });

test('the zone is found by its exact name; records read back with full names, a page at a time', async () => {
  const pad = Array.from({ length: 100 }, (_, n) => txt(`pad${n}`, 'x'));
  const w = world([...pad, aRecord('files', OLD)]);
  assert.deepEqual(await addressesOfName({ hostname: host, request: w.client(), provider }), [OLD]);
  assert.equal(w.state.calls.filter(name => name === 'dns_records_get').length, 2, 'a full page is followed by the next, skip and take counted');
  assert.equal(w.state.calls.filter(name => name === 'domains_list').length, 2, 'the longest suffix is looked up first, then the zone');
});

test('a name is made at the row address as a relative record, and a name already right is left alone', async () => {
  const w = world([txt('@', 'v=spf1 -all')]);
  const kept = await keepHealthyRecords({ hostname: host, candidates: [{ address: ROW }], check: () => true, request: w.client(), provider });
  assert.deepEqual([kept.added.map(x => x.address), kept.removed], [[ROW], []]);
  assert.deepEqual(w.state.saves, [[{ type: 'A', name: 'files', address: ROW, ttl: 60 }]]);
  assert.deepEqual(w.state.records[0], txt('@', 'v=spf1 -all'), 'other records of the zone are kept as they were');
  w.state.saves.length = 0;
  const again = await keepHealthyRecords({ hostname: host, candidates: [{ address: ROW }], check: () => true, request: w.client(), provider });
  assert.deepEqual([again.added, again.removed, w.state.saves, w.state.deletes], [[], [], [], []]);
});

test('the zone apex is written as @', async () => {
  const w = world([]);
  await keepHealthyRecords({ hostname: zone, candidates: [{ address: ROW }], check: () => true, request: w.client(), provider });
  assert.deepEqual(w.state.saves, [[{ type: 'A', name: '@', address: ROW, ttl: 60 }]]);
});

test('a record at the name that the row does not own is refused and left alone, unless the row adopts the name', async () => {
  const w = world([aRecord('files', OLD), txt('files', 'keep me')]);
  await assert.rejects(keepHealthyRecords({ hostname: host, candidates: [{ address: ROW }], check: () => true, request: w.client(), provider }), /does not own/);
  assert.deepEqual([w.state.saves, w.state.deletes, w.state.records.length], [[], [], 2]);
  const adopted = await keepHealthyRecords({ hostname: host, candidates: [{ address: ROW }], check: () => true, request: w.client(), provider, adopt: true });
  assert.deepEqual(adopted.removed.map(x => x.content), [OLD]);
  assert.deepEqual(w.state.deletes, [[{ type: 'A', name: 'files', address: OLD }]], 'removal sends the record body, the name as the zone names it');
  assert.deepEqual(w.state.records.map(x => [x.type, x.name]), [['TXT', 'files'], ['A', 'files']], 'the other record of the name stays; the row address is the only address');
});

test('the description sends only the tools it declares, and a refusal names the tool, never the answer', async () => {
  const w = world([]);
  const request = w.client();
  await assert.rejects(request('POST', '', { name: 'dns_records_set_all', arguments: {} }), /operation was refused/);
  await assert.rejects(request('GET', '', { name: 'domains_list' }), /operation was refused/);
  assert.deepEqual(w.state.calls, [], 'nothing undeclared is sent');
  const refusing = dnsClient(null, { provider, call: async () => ({ result: { isError: true, content: [{ type: 'text', text: 'echoed-secret-text' }] } }) });
  await assert.rejects(refusing('POST', '', { name: 'domains_list', arguments: { domain: zone } }), error => /refused domains_list\./.test(error.message) && !/echoed-secret-text/.test(error.message));
  const failing = dnsClient(null, { provider, call: async () => { throw Error('echoed-secret-text'); } });
  await assert.rejects(failing('POST', '', { name: 'domains_list', arguments: { domain: zone } }), error => /did not answer domains_list\./.test(error.message) && !/echoed-secret-text/.test(error.message));
});

test('a text answer is read as its JSON, and an engine provider with no engine call is refused', async () => {
  const w = world([aRecord('files', ROW)], { text: true });
  assert.deepEqual(await addressesOfName({ hostname: host, request: w.client(), provider }), [ROW]);
  assert.throws(() => dnsClient(null, { provider }), /needs the engine call/);
});

test('an apply that adds, keeps and removes the row own A records leaves every foreign record of the zone byte for byte', async () => {
  const NEW = '198.51.100.20', DOWN = '198.51.100.9';
  const foreign = [
    { type: 'MX', name: '@', exchange: 'mx1.example.net', preference: 10, ttl: 3600 },
    txt('@', 'v=spf1 include:example.net -all'),
    txt('default._domainkey', 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ'),
    txt('_dmarc', 'v=DMARC1; p=none; rua=mailto:dmarc@example.org'),
    aRecord('other', '10.0.0.1'),
  ];
  const w = world([aRecord('files', ROW), aRecord('files', DOWN), ...foreign]);
  const before = JSON.stringify(w.state.records.filter(row => !(row.type === 'A' && row.name === 'files')));
  const kept = await keepHealthyRecords({
    hostname: host, candidates: [{ address: ROW }, { address: NEW }, { address: DOWN }],
    check: candidate => candidate.address !== DOWN, request: w.client(), provider,
  });
  assert.deepEqual([kept.added.map(x => x.address), kept.removed.map(x => x.content)], [[NEW], [DOWN]], 'one own record added, one removed, the kept one untouched');
  assert.deepEqual(w.state.records.filter(row => row.name === 'files' && row.type === 'A').map(row => row.address).sort(), [NEW, ROW].sort());
  const after = JSON.stringify(w.state.records.filter(row => !(row.type === 'A' && row.name === 'files')));
  assert.equal(after, before, 'the MX, TXT and foreign A records are byte for byte as they were, in the same order');
  assert.deepEqual(foreign.map(row => JSON.stringify(row)), w.state.records.filter(row => !(row.type === 'A' && row.name === 'files')).map(row => JSON.stringify(row)));
  assert.ok(w.state.calls.every(name => ['domains_list', 'dns_records_get', 'dns_records_save', 'dns_records_delete'].includes(name)), 'only the per-record save and delete change the zone; setHosts is never sent');
});

const PARKING = '192.0.2.50', OTHER = '192.0.2.60', MAIL = 'mx1.example.net';
const mx = { type: 'MX', name: '@', exchange: MAIL, preference: 10, ttl: 3600 };
const cname = (name, cnameTarget) => ({ type: 'CNAME', name, cname: cnameTarget, ttl: 1800 });
const placement = (w, adopt) => keepHealthyRecords({ hostname: host, candidates: [{ address: ROW }], check: () => true, request: w.client(), provider, adopt });

test('adopt takes the name over: the parking A is removed, the row address is the only A, and the other records are untouched', async () => {
  const w = world([aRecord('files', PARKING), aRecord('other', OTHER), mx]);
  await assert.rejects(placement(w, false), /does not own/);
  assert.equal(w.state.deletes.length, 0, 'refused before any change');
  const adopted = await placement(w, true);
  assert.deepEqual([adopted.added.map(x => x.address), adopted.removed.map(x => x.content), adopted.unremovable], [[ROW], [PARKING], []]);
  assert.deepEqual(w.state.deletes, [[{ type: 'A', name: 'files', address: PARKING }]]);
  assert.deepEqual(w.state.records.map(x => [x.type, x.name, x.address ?? x.exchange]), [['A', 'other', OTHER], ['MX', '@', MAIL], ['A', 'files', ROW]]);
});

test('adopt removes a CNAME at the exact name, sent by its cname, and leaves a CNAME at another name', async () => {
  const w = world([cname('files', 'parking.example.net.'), cname('mail', 'mail.example.net.')]);
  await assert.rejects(placement(w, false), /does not own/);
  const adopted = await placement(w, true);
  assert.deepEqual([adopted.added.map(x => x.address), adopted.removed.map(x => x.content)], [[ROW], ['parking.example.net.']]);
  assert.deepEqual(w.state.deletes, [[{ type: 'CNAME', name: 'files', cname: 'parking.example.net.' }]]);
  assert.deepEqual(w.state.records.map(x => [x.type, x.name, x.address ?? x.cname]), [['CNAME', 'mail', 'mail.example.net.'], ['A', 'files', ROW]]);
});

test('a redirect record the typed list omits is reported unremovable on adopt, refused without it, and never sent to a delete', async () => {
  const w = world([], { omitted: [{ type: 'URL', name: 'files' }] });
  await assert.rejects(placement(w, false), /does not own/);
  const adopted = await placement(w, true);
  assert.deepEqual([adopted.added.map(x => x.address), adopted.removed, adopted.unremovable], [[ROW], [], [{ type: 'URL', host_name: host }]]);
  assert.deepEqual(w.state.deletes, [], 'the delete contract has no redirect type, so nothing is sent');
});

test('adopt where only the row address exists removes nothing', async () => {
  const w = world([aRecord('files', ROW), aRecord('other', OTHER), mx]);
  const adopted = await placement(w, true);
  assert.deepEqual([adopted.added, adopted.removed, adopted.unremovable, w.state.deletes, w.state.saves], [[], [], [], [], []]);
});
