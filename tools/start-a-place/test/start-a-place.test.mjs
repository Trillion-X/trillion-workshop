<<<<<<< origin/main
// tools/start-a-place: the place config it writes is the engine's shape (trillion-rust src/native_entry/place.rs), its
// refusals are the engine's rules said before anything runs (an http origin, a listen that is not an IP and port,
// default_places that are not a valid places list), and the start runs the engine's two commands in order (`place id`,
// then `serve`) against a stand-in engine (test/fake-trillion-local), so no Rust build is needed. Every origin, folder
// and place id here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDefaultPlaces, planOf, placesFor, Refusal, settings, startAPlace } from '../do-work/start-a-place.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const fake = join(folder, 'test', 'fake-trillion-local');
const command = join(folder, 'do-work', 'start-a-place.mjs');
const row = JSON.parse(readFileSync(join(folder, 'tool-rows.json'), 'utf8')).records[0].payload;
const skip = process.platform === 'win32' ? 'the stand-in engine is a POSIX sh script' : false;

// Made-up place ids: 64 lowercase hex, as `trillion-local place id` prints.
const HERE = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const THIRD = 'c'.repeat(64);

// The fields the engine's PlaceConfig takes (deny_unknown_fields): every one required but access, router and
// default_places.
const REQUIRED = ['listen', 'accounts', 'place_key_file', 'public_origin', 'report', 'sign_in', 'sign_up', 'new_accounts'];
const OPTIONAL = ['access', 'router', 'default_places'];

const base = root => ({
  folder: join(root, 'place'),
  accounts: join(root, 'place', 'accounts'),
  listen: '127.0.0.1:7199',
  public_origin: 'https://place.example.test',
});

const refused = (fn, pattern) => assert.throws(fn, error => error instanceof Refusal && pattern.test(error.message));

test('the row runs on the person\'s computer and names the program that exists', () => {
  assert.equal(row.id, 'tool:start-a-place');
  assert.equal(row.invoke.kind, 'on-your-computer');
  assert.match(row.invoke.run, /^node tools\/start-a-place\/do-work\/start-a-place\.mjs < \{input\}$/);
  assert.ok(existsSync(command));
  assert.deepEqual(row.placements, ['placement:your-computer']);
  assert.equal(row.result_selector, '$.result');
});

test('the config is the engine\'s shape: its fields only, the place key in the folder, report values filled', () => {
  const root = mkdtempSync(join(tmpdir(), 'start-a-place-'));
  const { config, files } = planOf({ ...base(root), router: 'router.example.test:7443', access: { limits: { 'access:place-accounts': [{ quantity: 300 }] } } });
  for (const field of REQUIRED) assert.ok(field in config, `${field} is written`);
  for (const field of Object.keys(config)) assert.ok(REQUIRED.includes(field) || OPTIONAL.includes(field), `${field} is a config field`);
  assert.equal(config.place_key_file, join(root, 'place', 'place.key'));
  assert.equal(files.config, join(root, 'place', 'place.json'));
  assert.equal(config.router, 'router.example.test:7443');
  assert.deepEqual(config.report, { ...settings.report, reach: 'https://place.example.test' });
  assert.deepEqual(Object.keys(config.new_accounts).sort(), ['sign_in', 'sign_in_ways']);
  assert.ok(!('default_places' in config), 'default_places waits for this place\'s id');
});

test('the request\'s own report values win, and a report field the engine does not take is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'start-a-place-'));
  const { config } = planOf({ ...base(root), report: { storage: { bytes: 1_000_000 }, reach: 'https://reach.example.test', takes_new_accounts: true, always_on: true } });
  assert.deepEqual(config.report.storage, { bytes: 1_000_000 });
  assert.equal(config.report.reach, 'https://reach.example.test');
  assert.equal(config.report.takes_new_accounts, true);
  refused(() => planOf({ ...base(root), report: { colour: 'blue' } }), /report\.colour is not a report field/);
  refused(() => planOf({ ...base(root), report: { storage: { bytes: 0 } } }), /report\.storage/);
  refused(() => planOf({ ...base(root), report: { cost_per_month_cents: -1 } }), /cost_per_month_cents/);
});

test('public_origin must be https and bare', () => {
  const root = mkdtempSync(join(tmpdir(), 'start-a-place-'));
  refused(() => planOf({ ...base(root), public_origin: 'http://place.example.test' }), /must start with https:\/\//);
  for (const origin of ['https://place.example.test/', 'https://place.example.test/path', 'https://place.example.test?q=1',
    'https://user-64b71ee9@example.com', 'place.example.test', 'https://place.example.test#top']) {
    refused(() => planOf({ ...base(root), public_origin: origin }), /public_origin must/);
  }
  assert.equal(planOf({ ...base(root), public_origin: 'https://place.example.test:8443' }).config.public_origin, 'https://place.example.test:8443');
});

test('listen, router, folders and unknown fields are refused with what to send', () => {
  const root = mkdtempSync(join(tmpdir(), 'start-a-place-'));
  for (const listen of ['place.example.test:7199', '127.0.0.1', '127.0.0.1:0', '127.0.0.1:65536', '::1:7199']) {
    refused(() => planOf({ ...base(root), listen }), /listen must be an IP address/);
  }
  assert.equal(planOf({ ...base(root), listen: '[::]:7199' }).config.listen, '[::]:7199');
  refused(() => planOf({ ...base(root), router: 'router.example.test' }), /router must be host:port/);
  refused(() => planOf({ ...base(root), accounts: 'relative/accounts' }), /accounts must be an absolute path/);
  refused(() => planOf({ ...base(root), folder: `${root}/../elsewhere` }), /folder must be an absolute path/);
  refused(() => planOf({ ...base(root), colour: 'blue' }), /colour is not a field/);
  refused(() => planOf([]), /Send one JSON object/);
});

test('default_places is a valid places list: holders, answering among them, no repeats, 64-hex ids', () => {
  assert.deepEqual(checkDefaultPlaces({ holders: [HERE, OTHER], answering: [HERE] }), { holders: [HERE, OTHER], answering: [HERE], voters: [] });
  refused(() => checkDefaultPlaces({ holders: [], answering: [] }), /holders must name at least one place/);
  refused(() => checkDefaultPlaces({ answering: [HERE] }), /default_places must be/);
  refused(() => checkDefaultPlaces({ holders: [HERE], answering: [OTHER] }), /not among the holders/);
  refused(() => checkDefaultPlaces({ holders: [HERE, HERE], answering: [HERE] }), /names a{64} twice/);
  refused(() => checkDefaultPlaces({ holders: [HERE], answering: [HERE], voters: [OTHER, OTHER] }), /voters names b{64} twice/);
  refused(() => checkDefaultPlaces({ holders: ['A'.repeat(64)], answering: [] }), /not a place id/);
  refused(() => checkDefaultPlaces({ holders: ['a'.repeat(63)], answering: [] }), /not a place id/);
  refused(() => checkDefaultPlaces({ holders: [HERE], answering: [], extra: [] }), /default_places must be/);
  const many = Array.from({ length: settings.most_places + 1 }, (_, at) => at.toString(16).padStart(64, '0'));
  refused(() => checkDefaultPlaces({ holders: many, answering: [] }), /more than 16 places/);
});

test('the word for this place becomes its id, and this place must be among holders and answering', () => {
  const word = settings.this_place;
  assert.deepEqual(placesFor(checkDefaultPlaces({ holders: [word, OTHER], answering: [word], voters: [word, OTHER, THIRD] }), HERE),
    { holders: [HERE, OTHER], answering: [HERE], voters: [HERE, OTHER, THIRD] });
  refused(() => placesFor(checkDefaultPlaces({ holders: [OTHER, HERE], answering: [OTHER] }), HERE), /among both holders and answering/);
  refused(() => placesFor(checkDefaultPlaces({ holders: [OTHER], answering: [OTHER] }), HERE), /among both holders and answering/);
  refused(() => placesFor(checkDefaultPlaces({ holders: [word, HERE], answering: [word] }), HERE), /twice/);
});

// A run against the stand-in engine: the calls it saw, in order, and the config `serve` was given.
function standIn(root, extra = {}) {
  const calls = join(root, 'calls.txt');
  return { calls, env: { ...process.env, FAKE_TRILLION_CALLS: calls, FAKE_PLACE_ID: HERE, ...extra } };
}
const callsOf = path => readFileSync(path, 'utf8').trim().split('\n');
const stop = pid => { try { process.kill(pid, 'SIGTERM'); } catch {} };

test('the start makes the key, writes the config, asks the place id, then serves, in that order', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'start-a-place-'));
  const { calls, env } = standIn(root);
  const result = await startAPlace({ ...base(root), trillion_local: fake, router: 'router.example.test:7443',
    default_places: { holders: [settings.this_place, OTHER], answering: [settings.this_place], voters: [settings.this_place, OTHER, THIRD] } }, { env });
  try {
    const config = join(root, 'place', 'place.json');
    assert.deepEqual(callsOf(calls), [`place id ${config}`, `serve ${config}`]);
    assert.equal(result.place_id, HERE);
    assert.equal(result.started, true);
    assert.ok(Number.isInteger(result.pid));
    assert.equal(result.key_made, true);
    assert.ok(statSync(join(root, 'place', 'accounts')).isDirectory(), 'the accounts folder is made');

    const key = readFileSync(join(root, 'place', 'place.key'), 'utf8');
    assert.equal(Buffer.from(key, 'base64').length, settings.key_bytes);
    assert.equal(statSync(join(root, 'place', 'place.key')).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(result).includes(key), 'the key is never in the answer');

    const served = JSON.parse(readFileSync(`${calls}.serve.json`, 'utf8'));
    assert.deepEqual(served.default_places, { holders: [HERE, OTHER], answering: [HERE], voters: [HERE, OTHER, THIRD] });
    assert.equal(served.router, 'router.example.test:7443');
    for (const field of Object.keys(served)) assert.ok(REQUIRED.includes(field) || OPTIONAL.includes(field), `${field} is a config field`);
  } finally {
    stop(result.pid);
  }
});

test('a key already there is kept as it is, and start false asks the id without serving', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'start-a-place-'));
  mkdirSync(join(root, 'place'));
  writeFileSync(join(root, 'place', 'place.key'), 'bWFkZS11cCBrZXkgZm9yIGEgdGVzdCBvbmx5IDMyIGI=');
  const { calls, env } = standIn(root);
  const result = await startAPlace({ ...base(root), trillion_local: fake, start: false }, { env });
  assert.equal(result.key_made, false);
  assert.equal(result.started, false);
  assert.equal(readFileSync(join(root, 'place', 'place.key'), 'utf8'), 'bWFkZS11cCBrZXkgZm9yIGEgdGVzdCBvbmx5IDMyIGI=');
  assert.deepEqual(callsOf(calls), [`place id ${join(root, 'place', 'place.json')}`]);
});

test('defaults that leave this place out are refused before serve runs', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'start-a-place-'));
  const { calls, env } = standIn(root);
  await assert.rejects(startAPlace({ ...base(root), trillion_local: fake, default_places: { holders: [OTHER], answering: [OTHER] } }, { env }),
    /among both holders and answering/);
  assert.deepEqual(callsOf(calls).map(line => line.split(' ').slice(0, 2).join(' ')), ['place id']);
});

test('a place that stops at once, a refused place id and a missing program are told with what to do', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'start-a-place-'));
  await assert.rejects(startAPlace({ ...base(root), trillion_local: fake }, standIn(root, { FAKE_SERVE_FAIL: '1' })),
    /stopped right after it started \(exit 1\): .*stage config.*place\.log/);
  const again = mkdtempSync(join(tmpdir(), 'start-a-place-'));
  await assert.rejects(startAPlace({ ...base(again), trillion_local: fake }, standIn(again, { FAKE_ID_FAIL: '1' })), /place id` refused the config: place-key/);
  await assert.rejects(startAPlace({ ...base(again), trillion_local: join(again, 'nowhere') }, standIn(again)), /not a file this computer can run/);
  await assert.rejects(startAPlace(base(again), { env: { PATH: join(again, 'empty') } }), /No trillion-local was found/);
});

test('the command reads the request on standard input and prints { result } or { error } last', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'start-a-place-'));
  const { env } = standIn(root);
  const ran = spawnSync(process.execPath, [command], { input: JSON.stringify({ ...base(root), trillion_local: fake, start: false }), encoding: 'utf8', env });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(JSON.parse(ran.stdout.trim().split('\n').at(-1)).result.place_id, HERE);
  const bad = spawnSync(process.execPath, [command], { input: JSON.stringify({ ...base(root), public_origin: 'http://place.example.test' }), encoding: 'utf8', env });
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout.trim().split('\n').at(-1)).error, /https:\/\//);
=======
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  machineProvider, nameProvider, providerClient, rentMachine, releaseMachine, readMachine, readPrice, pointName,
  forgetName, fingerprintOf,
} from '../do-work/rent-a-machine.mjs';
import { startAPlace, placeConfig, readRequest } from '../do-work/start-a-place.mjs';

const canary = 'provider-credential-canary-0123456789';
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample0 someone@example.com';
const folder = () => mkdtempSync(join(tmpdir(), 'start-a-place-'));
const hetzner = machineProvider('hetzner'), existing = machineProvider('existing-machine'), cloudflare = nameProvider('cloudflare');

// A provider that answers from a table of `METHOD path` -> body (or a function of the request body).
function provider(base, table, calls = []) {
  return async (address, request) => {
    assert.ok(address.startsWith(base));
    assert.equal(request.headers.authorization, `Bearer ${canary}`);
    const key = `${request.method} ${address.slice(base.length)}`, body = request.body && JSON.parse(request.body);
    calls.push([key, body]);
    const answer = table[key];
    if (answer === undefined) return { status: 404, ok: false, json: async () => ({ error: { code: 'not_found' } }) };
    const value = typeof answer === 'function' ? answer(body) : answer;
    return { status: value.status ?? 200, ok: (value.status ?? 200) < 300, json: async () => value };
  };
}

test('the rows name every provider call and their credentials by vault handle only', () => {
  const rows = JSON.parse(readFileSync(new URL('../read-data/providers.json', import.meta.url), 'utf8'));
  for (const row of [...rows.machines, ...rows.names].filter(r => r.base)) {
    assert.match(row.vault_key, /^[a-z0-9-]+$/);
    for (const asked of Object.values(row.requests)) assert.ok(asked.url.startsWith(row.base), asked.url);
  }
  assert.equal(existing.base, null);
});

test('the client sends only the calls its row declares', async () => {
  const request = providerClient(hetzner, canary, { fetchImpl: provider(hetzner.base, { 'GET /servers?name=a-place': { servers: [] } }) });
  assert.deepEqual(await request('GET', '/servers?name=a-place'), { servers: [] });
  await assert.rejects(request('DELETE', '/volumes/7'), /operation was refused/);
  await assert.rejects(request('DELETE', '/servers/abc'), /operation was refused/);
  assert.throws(() => providerClient(hetzner, ''), /credential was refused/);
});

test('renting stores the key, makes the machine with this lease\'s label, and releases only what it owns', async () => {
  const file = join(folder(), 'lease.json'), calls = [];
  const fetchImpl = provider(hetzner.base, {
    'GET /servers?name=a-place': { servers: [] },
    [`GET /ssh_keys?fingerprint=${encodeURIComponent(fingerprintOf(publicKey))}`]: { ssh_keys: [] },
    'POST /ssh_keys': body => ({ ssh_key: { id: 11, labels: body.labels } }),
    'POST /servers': body => ({ server: { id: 22, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.10' } } } }),
    'GET /servers/22': { server: { id: 22, status: 'running', labels: { 'place-lease': 'a-place' }, public_net: { ipv4: { ip: '192.0.2.10' } } } },
    'DELETE /servers/22': {},
    'GET /ssh_keys/11': { ssh_key: { id: 11, labels: { 'place-lease': 'a-place' } } },
    'DELETE /ssh_keys/11': {},
  }, calls);
  const request = providerClient(hetzner, canary, { fetchImpl });
  const lease = await rentMachine({ request, file, provider: hetzner, name: 'a-place', publicKey, placement: { size: 'cax11' }, lifetime: 'service' });
  assert.deepEqual([lease.state, lease.serverId, lease.sshKeyId, lease.address, lease.serverType, lease.location], ['running', 22, 11, '192.0.2.10', 'cax11', 'hel1']);
  const made = calls.find(([key]) => key === 'POST /servers')[1];
  assert.deepEqual([made.server_type, made.ssh_keys, made.labels], ['cax11', [11], { 'place-lease': 'a-place' }]);
  assert.deepEqual(await readMachine({ request, file, provider: hetzner }), { state: 'running', address: '192.0.2.10' });
  assert.equal((await releaseMachine({ request, file, provider: hetzner })).state, 'removed');
  assert.ok(calls.some(([key]) => key === 'DELETE /servers/22') && calls.some(([key]) => key === 'DELETE /ssh_keys/11'));
  assert.ok(!readFileSync(file, 'utf8').includes(canary));
});

test('a public key the provider already holds is used as it is and never removed', async () => {
  const file = join(folder(), 'lease.json'), calls = [];
  const fetchImpl = provider(hetzner.base, {
    'GET /servers?name=a-place': { servers: [] },
    [`GET /ssh_keys?fingerprint=${encodeURIComponent(fingerprintOf(publicKey))}`]: { ssh_keys: [{ id: 5, labels: {} }] },
    'POST /servers': body => ({ server: { id: 23, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.11' } } } }),
    'GET /servers/23': { server: { id: 23, labels: { 'place-lease': 'a-place' } } },
    'DELETE /servers/23': {},
  }, calls);
  const request = providerClient(hetzner, canary, { fetchImpl });
  const lease = await rentMachine({ request, file, provider: hetzner, name: 'a-place', publicKey, lifetime: 'service' });
  assert.deepEqual([lease.sshKeyId, lease.sharedSshKeyId], [null, 5]);
  assert.deepEqual(calls.find(([key]) => key === 'POST /servers')[1].ssh_keys, [5]);
  await releaseMachine({ request, file, provider: hetzner });
  assert.ok(!calls.some(([key]) => key.startsWith('POST /ssh_keys') || key.startsWith('DELETE /ssh_keys')));
});

test('a machine someone else labelled is left untouched', async () => {
  const file = join(folder(), 'lease.json');
  writeFileSync(file, JSON.stringify({ schema: 'place-lease/1', provider: 'hetzner', name: 'a-place', state: 'running', serverId: 30, sshKeyId: null }));
  const request = providerClient(hetzner, canary, { fetchImpl: provider(hetzner.base, { 'GET /servers/30': { server: { id: 30, labels: { 'place-lease': 'another' } } } }) });
  await assert.rejects(releaseMachine({ request, file, provider: hetzner }), /no longer owned by this lease/);
});

test('an existing machine is adopted at its address and only forgotten on release', async () => {
  const file = join(folder(), 'lease.json');
  const lease = await rentMachine({ request: null, file, provider: existing, name: 'a-pi', placement: { address: '192.0.2.40' }, lifetime: 'service' });
  assert.deepEqual([lease.state, lease.adopted, lease.address], ['running', true, '192.0.2.40']);
  assert.equal(await readPrice({ request: null, provider: existing, placement: {} }), null);
  assert.deepEqual(await readPrice({ request: null, provider: existing, placement: { monthly_price_cents: 300 } }), { cents: 300, currency: null });
  assert.equal((await releaseMachine({ request: null, file, provider: existing })).state, 'removed');
  await assert.rejects(rentMachine({ request: null, file: join(folder(), 'l.json'), provider: existing, name: 'a-pi', placement: { address: 'not-an-address' }, lifetime: 'service' }), /configuration was refused/);
});

test('the price is the size\'s monthly price at the lease\'s location, in cents', async () => {
  const request = providerClient(hetzner, canary, { fetchImpl: provider(hetzner.base, { 'GET /server_types?name=cax11': { server_types: [{ prices: [
    { location: 'fsn1', price_monthly: { gross: '7.9900' } }, { location: 'hel1', price_monthly: { gross: '6.9900' } },
  ] }] } }) });
  assert.deepEqual(await readPrice({ request, provider: hetzner, placement: { size: 'cax11' } }), { cents: 699, currency: 'EUR' });
  await assert.rejects(readPrice({ request, provider: hetzner, placement: { size: 'cax11', location: 'ash' } }), /no monthly price/);
});

test('the public name points at the machine with this lease\'s mark, and only that record is removed', async () => {
  const file = join(folder(), 'lease.json'), zone = 'a'.repeat(32), record = 'b'.repeat(32), calls = [];
  writeFileSync(file, JSON.stringify({ schema: 'place-lease/1', provider: 'hetzner', name: 'a-place', state: 'running', address: '192.0.2.10' }));
  const fetchImpl = provider(cloudflare.base, {
    'GET /zones?name=example.com': { result: [{ id: zone, name: 'example.com' }] },
    [`GET /zones/${zone}/dns_records?type=A&name=place.example.com`]: { result: [] },
    [`POST /zones/${zone}/dns_records`]: body => ({ result: { id: record, ...body } }),
    [`GET /zones/${zone}/dns_records/${record}`]: { result: { id: record, comment: 'place-lease a-place' } },
    [`DELETE /zones/${zone}/dns_records/${record}`]: { result: { id: record } },
  }, calls);
  const request = providerClient(cloudflare, canary, { fetchImpl });
  const lease = await pointName({ request, file, provider: cloudflare, zone: 'example.com', hostName: 'place.example.com' });
  assert.deepEqual([lease.recordId, lease.hostName], [record, 'place.example.com']);
  assert.deepEqual(calls.find(([key]) => key.startsWith('POST'))[1], { type: 'A', name: 'place.example.com', content: '192.0.2.10', ttl: 60, proxied: false, comment: 'place-lease a-place' });
  assert.equal((await forgetName({ request, file, provider: cloudflare })).recordId, null);
  assert.ok(calls.some(([key]) => key.startsWith('DELETE')));
});

test('the place config takes the machine\'s own fields and values read from the release', async () => {
  const run = async (_machine, command) => {
    assert.equal(command, "cat '/opt/place/current/data/new-accounts.json'");
    return JSON.stringify({ sign_in_ways: [{ way: 'passkey' }] });
  };
  const config = await placeConfig({}, {
    port: 7199, name: { host_name: 'place.example.com' }, place_config: { report: { takes_new_accounts: true }, router: 'router.example.com:443' },
    config_from_release: [{ at: ['new_accounts', 'sign_in_ways'], file: 'data/new-accounts.json', key: 'sign_in_ways' }],
  }, { cents: 699, currency: 'EUR' }, run);
  assert.deepEqual(config, {
    report: { takes_new_accounts: true, reach: 'https://place.example.com', cost_per_month_cents: 699 }, router: 'router.example.com:443',
    listen: '127.0.0.1:7199', accounts: '/var/lib/place/accounts', place_key_file: '/var/lib/place/place.key', public_origin: 'https://place.example.com',
    new_accounts: { sign_in_ways: [{ way: 'passkey' }] },
  });
});

test('a request\'s paths are read relative to its own file', () => {
  const here = folder(), file = join(here, 'request.json');
  writeFileSync(file, JSON.stringify({ lease_file: 'lease.json', machine: { provider: 'existing-machine' }, ssh: { known_hosts: 'known_hosts' }, engine: { release: { tarball: 'r.tar.gz' } } }));
  const request = readRequest(file);
  assert.deepEqual([request.lease_file, request.ssh.known_hosts, request.engine.release.tarball], [join(here, 'lease.json'), join(here, 'known_hosts'), join(here, 'r.tar.gz')]);
});

test('starting a place on an existing machine sets it up, installs the release, serves and reads it back', async () => {
  const here = folder(), commands = [];
  const run = async (_machine, command, input) => {
    commands.push(command);
    if (command === 'uname -m') return 'aarch64\n';
    if (command.startsWith('cat ')) return JSON.stringify({ sign_in_ways: [] });
    if (command.startsWith('install -o place')) assert.equal(JSON.parse(input).public_origin, 'https://place.example.com');
    if (command.includes("'place' 'id' '/var/lib/place/place.json'")) return 'f'.repeat(64);
    return '';
  };
  const answer = await startAPlace({
    lease_file: join(here, 'lease.json'), machine: { provider: 'existing-machine', name: 'a-pi', placement: { address: '192.0.2.40' }, lifetime: 'service' },
    name: { host_name: 'place.example.com' }, ssh: { known_hosts: join(here, 'known_hosts') }, port: 7199,
    engine: { file: 'engine', data_env: 'ENGINE_DATA', data_dir: 'data', id_argv: ['place', 'id'], release_name: 'r1', release: { on_machine: '/opt/build/release' } },
    config_from_release: [{ at: ['new_accounts', 'sign_in_ways'], file: 'data/new-accounts.json', key: 'sign_in_ways' }],
  }, { run, fetchImpl: async address => ({ status: address === 'https://place.example.com/sign-up' ? 200 : 404 }), wait: async () => {} });
  assert.deepEqual([answer.arch, answer.place_id, answer.sign_up_status, answer.release, answer.price], ['aarch64', 'f'.repeat(64), 200, '/opt/place/releases/r1', null]);
  assert.match(commands.find(c => c.startsWith('sh -s')), /^sh -s -- 'place\.example\.com' '7199' 'engine' 'ENGINE_DATA' 'data'$/);
  assert.ok(commands.some(c => c.includes('systemctl restart place.service')));
>>>>>>> 8ccc2b84
});
