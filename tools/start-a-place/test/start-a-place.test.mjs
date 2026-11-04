import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, readlinkSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  machineProvider, nameProvider, providerClient, rentMachine, releaseMachine, readMachine, readPrice, pointName,
  forgetName, fingerprintOf,
} from '../do-work/rent-a-machine.mjs';
import {
  rentAMachine, startAPlace, placeConfig, readRequest, updateAComputer, rollBackAComputer, PRODUCT_SETTINGS, productSettings,
} from '../do-work/start-a-place.mjs';

const SETTINGS = JSON.parse(readFileSync(new URL('../read-data/settings.json', import.meta.url), 'utf8'));

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
    new_accounts: { sign_in_ways: [{ way: 'passkey' }] }, release_feed: SETTINGS.release_feed,
  });
  const behind = await placeConfig({}, { port: 7199, name: { host_name: 'place.example.com' }, public_origin: 'https://front.example.com' }, null, run);
  assert.deepEqual([behind.public_origin, behind.report.reach], ['https://front.example.com', 'https://place.example.com']);
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
    if (command.startsWith('install -o place') && command.endsWith('/var/lib/place/place.json')) assert.equal(JSON.parse(input).public_origin, 'https://place.example.com');
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
  assert.match(commands.find(c => c.startsWith('sh -s')), /^sh -s -- 'place\.example\.com' '7199' 'engine' 'ENGINE_DATA' 'data' 'PRODUCT_SETTINGS' '\/var\/lib\/place\/product-settings\.json' '\/opt\/place\/releases'$/);
  assert.ok(commands.find(c => c.includes("'place' 'id'")).includes("env PRODUCT_SETTINGS='/var/lib/place/product-settings.json' ENGINE_DATA="), 'the id command reads the product settings too');
  assert.ok(commands.some(c => c.includes('systemctl restart place.service')));
});

test('renting a machine leases it and waits for SSH, and sets nothing up on it', async () => {
  const here = folder(), commands = [];
  const run = async (_machine, command) => { commands.push(command); return command === 'uname -m' ? 'x86_64\n' : ''; };
  const answer = await rentAMachine({
    lease_file: join(here, 'lease.json'), machine: { provider: 'existing-machine', name: 'a-builder', placement: { address: '192.0.2.41' }, lifetime: 'service' },
    name: { host_name: 'releases.example.com' }, ssh: { known_hosts: join(here, 'known_hosts') },
  }, { run, wait: async () => {} });
  assert.deepEqual([answer.arch, answer.host_name, answer.lease.address, answer.price], ['x86_64', 'releases.example.com', '192.0.2.41', null]);
  assert.deepEqual(commands, ['uname -m']);
  assert.equal(JSON.parse(readFileSync(join(here, 'lease.json'), 'utf8')).address, '192.0.2.41', 'the lease is kept, so remove gives it back');
});

test('the place config carries the request\'s release feed and default places', async () => {
  const key = 'b'.repeat(64), id = 'e'.repeat(64);
  const release_feed = { urls: ['https://releases.example.com/engine-releases/feed.json'], public_keys: [key], releases: '/opt/place/releases' };
  const default_places = { holders: ['this-place', id], answering: ['this-place'] };
  const config = await placeConfig({}, { port: 7199, name: { host_name: 'place.example.com' }, release_feed, default_places }, null, async () => '');
  assert.deepEqual([config.release_feed, config.default_places], [release_feed, default_places]);
  const product = await placeConfig({}, { port: 7199, name: { host_name: 'place.example.com' } }, null, async () => '');
  assert.deepEqual(product.release_feed, SETTINGS.release_feed, 'a request that names no feed follows the product\'s');
  assert.ok(!('default_places' in product));
  const without = await placeConfig({}, { port: 7199, name: { host_name: 'place.example.com' }, release_feed: null }, null, async () => '');
  assert.ok(!('release_feed' in without));
  await assert.rejects(placeConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, release_feed: { ...release_feed, public_keys: ['short'] } }, null), /64 lowercase hex/);
  await assert.rejects(placeConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, release_feed: { ...release_feed, urls: ['http://insecure.example.com/feed.json'] } }, null), /https addresses/);
  await assert.rejects(placeConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, default_places: { answering: [id] } }, null), /holders must name/);
  for (const releases of ['/opt/place/../../etc', '/opt/place releases', '/opt/place/releases\nReadWritePaths=/']) {
    await assert.rejects(placeConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, release_feed: { ...release_feed, releases } }, null), /absolute path of letters/);
  }
});

test('the folder a feed adopts releases into is made writable for the place service, which runs with ProtectSystem=strict', async () => {
  const { adoptFolder } = await import('../do-work/start-a-place.mjs');
  const feed = releases => ({ release_feed: { urls: [], public_keys: [], releases } });
  assert.deepEqual([adoptFolder(feed('/opt/place/releases/')), adoptFolder(feed('/opt/place/releases')), adoptFolder(feed({ keep: 3 })), adoptFolder({}), adoptFolder({ release_feed: null })], ['/opt/place/releases', '/opt/place/releases', null, '/opt/place/releases', null]);
  const script = readFileSync(new URL('../do-work/set-up-the-machine.sh', import.meta.url), 'utf8');
  assert.match(script, /ADOPT_DIR=\$\{8:-\}/);
  assert.match(script, /^\[Service\]\nEnvironment=\$SETTINGS_ENV=\$SETTINGS_FILE$/m);
  assert.match(script, /install -d -o place -g place -m 0755 "\$ADOPT_DIR"/);
  assert.match(script, /^ProtectSystem=strict\nReadWritePaths=\$WRITABLE$/m);
});

test('a start writes both fields into the place config it installs, and a bad feed is refused before anything is rented', async () => {
  const here = folder(), written = [], setups = [];
  const run = async (_machine, command, input) => {
    if (command === 'uname -m') return 'x86_64\n';
    if (command.startsWith('sh -s')) setups.push(command);
    if (command === 'install -o place -g place -m 0600 /dev/stdin /var/lib/place/place.json') written.push(JSON.parse(input));
    if (command === `install -o place -g place -m 0600 /dev/stdin '${productSettings.file}'`) written.push(Buffer.from(input));
    return '';
  };
  const release_feed = { urls: ['https://releases.example.com/engine-releases/feed.json'], public_keys: ['a'.repeat(64)], releases: '/opt/place/releases' };
  const default_places = { holders: ['this-place'], answering: ['this-place'] };
  const request = {
    lease_file: join(here, 'lease.json'), machine: { provider: 'existing-machine', name: 'a-pi', placement: { address: '192.0.2.41' }, lifetime: 'service' },
    name: { host_name: 'place.example.com' }, ssh: { known_hosts: join(here, 'known_hosts') }, port: 7199,
    engine: { file: 'engine', data_env: 'ENGINE_DATA', data_dir: 'data', release_name: 'r1', release: { on_machine: '/opt/build/release' } },
    release_feed, default_places,
  };
  await startAPlace(request, { run, fetchImpl: async () => ({ status: 200 }), wait: async () => {} });
  assert.deepEqual(written[0], PRODUCT_SETTINGS, 'the product settings file is written byte for byte, before the config');
  assert.deepEqual([written[1].release_feed, written[1].default_places], [release_feed, default_places]);
  assert.match(setups[0], / 'data' 'PRODUCT_SETTINGS' '\/var\/lib\/place\/product-settings\.json' '\/opt\/place\/releases'$/, 'set-up is told the folder the engine adopts releases into');
  const lease = join(here, 'second-lease.json');
  await assert.rejects(startAPlace({ ...request, lease_file: lease, release_feed: { urls: [] } }, { run }), /release_feed/);
  assert.throws(() => readFileSync(lease), /ENOENT/);
});

test('the sign-up check answers the way a browser does and its passkey signs what it says', async () => {
  const { checkASignUp, softwarePasskey, assertion } = await import('../do-work/check-a-sign-up.mjs');
  const { createVerify, createPublicKey } = await import('node:crypto');
  const origin = 'https://front.example', address = 'c'.repeat(64), seen = [];
  const fetchImpl = async (url, request) => {
    const path = url.slice(origin.length), body = request.body && JSON.parse(request.body);
    seen.push([request.method, path, request.headers.origin ?? null, request.headers.cookie ?? null]);
    const answer = (status, json, cookie) => ({ status, headers: { get: name => (name === 'set-cookie' ? cookie ?? null : null) }, text: async () => JSON.stringify(json ?? {}) });
    if (path === '/sign-up') return answer(200);
    if (path === '/sign-up/options') return answer(200, { options: { challenge: 'up-1', rp: { id: 'example' } } });
    if (path === '/sign-up/finish') {
      const client = JSON.parse(Buffer.from(body.response.clientDataJSON, 'base64url'));
      assert.deepEqual([client.type, client.challenge, client.origin], ['webauthn.create', 'up-1', origin]);
      assert.equal(body.response.publicKeyAlgorithm, -7);
      return answer(200, { address });
    }
    if (path === `/a/${address}/passkey/options`) return answer(200, { challenge: 'in-1', rpId: 'example' });
    if (path === `/a/${address}/passkey/finish`) return answer(200, { ok: true }, 'session=s1; Path=/; Secure; HttpOnly');
    if (path === `/a/${address}/sign-in/security`) return answer(request.headers.cookie === 'session=s1' ? 200 : 303);
    return answer(404);
  };
  const answer = await checkASignUp(origin, { fetchImpl });
  assert.equal(answer.address, address);
  assert.equal(answer.signed_in_read, true);
  assert.deepEqual(answer.steps.map(step => step.status), [200, 200, 200, 200, 200, 200, 303]);
  assert.ok(seen.filter(([method]) => method === 'POST').every(([, , sent]) => sent === origin));
  assert.ok(!JSON.stringify(answer).includes('s1'));

  // The assertion is a valid ES256 signature over authenticatorData || SHA-256(clientDataJSON).
  const passkey = softwarePasskey();
  const signed = assertion(passkey, { challenge: 'c', rpId: 'example' }, origin);
  const auth = Buffer.from(signed.response.authenticatorData, 'base64url'), client = Buffer.from(signed.response.clientDataJSON, 'base64url');
  const { createHash } = await import('node:crypto');
  const verify = createVerify('sha256').update(Buffer.concat([auth, createHash('sha256').update(client).digest()]));
  assert.ok(verify.verify(createPublicKey({ key: passkey.spki, format: 'der', type: 'spki' }), Buffer.from(signed.response.signature, 'base64url')));
  await assert.rejects(checkASignUp('https://front.example/path', { fetchImpl }), /ORIGIN is https:\/\/host/);
});

// The sections trillion-rust bac30d37 (feed sequence 691) declares in src/account_files/identity.json; it refuses a
// product settings file with any other.
const DECLARED = ['secret_home', 'root_credentials_folder', 'tools_source', 'hosting_app_report', 'carried_from'];
const IDENTITY = ['word', 'site_host', 'app_host', 'brand_mark_path', 'restore_placeholder_owner'];

test('the product settings are the identity the engines compiled in, with only the sections the feed\'s engine declares', () => {
  const settings = JSON.parse(PRODUCT_SETTINGS);
  assert.ok(PRODUCT_SETTINGS.length <= 65536);
  assert.deepEqual(IDENTITY.map(key => settings[key]), ['trillion', 'gettrillion.ai', 'app.gettrillion.ai', '/brand/current/mark.svg', 'trillion-local-owner']);
  assert.deepEqual(Object.keys(settings).filter(key => !key.startsWith('_') && !IDENTITY.includes(key)), DECLARED);
  assert.deepEqual([settings.tools_source.repository, settings.tools_source.first_start_commit], ['Trillion-X/trillion-workshop', 'afb89f527283d36b195ac9d67f193132fbbdad25']);
  assert.deepEqual(settings.secret_home.items, { account_key: '{word}-agent-work-key', device_key: '{word}-resource-connection-key' });
  assert.deepEqual([productSettings.launch_setting, productSettings.file], ['PRODUCT_SETTINGS', '/var/lib/place/product-settings.json']);
  assert.deepEqual(SETTINGS.release_feed.public_keys, ['d9e305a98d6a7001db6f493d17100a799050bf9ade9e3f1e9eb0d9c59d322fb9']);
  assert.deepEqual(SETTINGS.release_feed.urls, ['https://engine-releases.gettrillion.ai/engine-releases/feed.json']);
});

// A made-up computer folder: what set-up-the-machine.sh made on a running computer before this update, under `root`.
const UNIT = `[Unit]
Description=A place that keeps accounts (place.example.com)

[Service]
Type=simple
User=place
ExecStart=/bin/sh -c 'R=$(readlink -f /opt/place/current) && exec env PRODUCT_DATA_ROOT="$R/product" "$R/trillion-local" serve /var/lib/place/place.json'
ProtectSystem=strict
ReadWritePaths=/var/lib/place

[Install]
WantedBy=multi-user.target
`;
const OLD_CONFIG = `${JSON.stringify({ listen: '127.0.0.1:7199', accounts: '/var/lib/place/accounts', public_origin: 'https://place.example.com' }, null, 1)}\n`;

function madeUpComputer() {
  const root = folder(), bin = join(root, 'fake-bin'), engine = '#!/bin/sh\nexit 0\n';
  for (const dir of ['var/lib/place', 'etc/systemd/system', 'opt/place/releases/old', 'opt/build/new', 'fake-bin']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'var/lib/place/place.json'), OLD_CONFIG);
  writeFileSync(join(root, 'etc/systemd/system/place.service'), UNIT);
  for (const dir of ['opt/place/releases/old', 'opt/build/new']) { writeFileSync(join(root, dir, 'trillion-local'), engine); chmodSync(join(root, dir, 'trillion-local'), 0o755); }
  symlinkSync('/opt/place/releases/old', join(root, 'opt/place/current'));
  // systemctl: each call is written down; the service is not active when /opt/place/current names FAKE_REFUSED_RELEASE.
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> "$ROOT/systemctl.calls"\nif [ "$1" = is-active ] && [ "$(readlink "$ROOT/opt/place/current")" = "\${FAKE_REFUSED_RELEASE:-none}" ]; then exit 3; fi\nexit 0\n`);
  chmodSync(join(bin, 'systemctl'), 0o755);
  const lease = join(root, 'lease.json');
  writeFileSync(lease, JSON.stringify({ schema: 'place-lease/1', provider: 'existing-machine', name: 'a-computer', address: '192.0.2.50', adopted: true, hostName: 'place.example.com' }));
  return { root, lease, file: path => join(root, path) };
}

// `run` on the made-up computer: each command runs here, in sh, with the fake systemctl first on the PATH. Its input
// is read from a file, as ssh hands a pipe: Node's own stdin pipe is a socket, which /dev/stdin cannot open.
const runHere = (root, env = {}) => async (_machine, command, input) => {
  let bytes = input ?? '';
  if (input?.pipe) { const parts = []; for await (const part of input) parts.push(part); bytes = Buffer.concat(parts); }
  const stdin = join(root, 'stdin'); writeFileSync(stdin, bytes);
  return runFrom(root, env, command, stdin);
};
const runFrom = (root, env, command, stdin) => new Promise((resolve, reject) => {
  const child = spawn('sh', ['-c', `${command} < '${stdin}'`], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, ROOT: root, PATH: `${join(root, 'fake-bin')}:${process.env.PATH}` } });
  let out = '', err = '';
  child.stdout.on('data', bytes => { out += bytes; });
  child.stderr.on('data', bytes => { err += bytes; });
  child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`exited ${code}: ${err.trim()}`))));
});

const updateRequest = { ssh: { known_hosts: '/dev/null' }, name: { host_name: 'place.example.com' }, engine: { file: 'trillion-local', release_name: 'new', release: { on_machine: '/opt/build/new' } } };
const asHere = (root, extra = {}) => ({ root, placeUser: userInfo().username, settle: 0, wait: async () => {}, tries: 1, fetchImpl: async () => ({ status: 200 }), ...extra });

test('an update gives a running computer the product settings, the feed and the release, keeping a backup', async () => {
  const { root, lease, file } = madeUpComputer();
  const answer = await updateAComputer(lease, updateRequest, { ...asHere(root), run: runHere(root), now: new Date('2026-11-04T17:15:00Z') });
  assert.deepEqual(answer, {
    release: '/opt/place/releases/new', backup: '/var/lib/place/backups/update-2026-11-04T17-15-00-000Z', product_settings: '/var/lib/place/product-settings.json',
    release_feed: SETTINGS.release_feed.urls, sign_up_status: 200,
  });
  assert.deepEqual(readFileSync(file('var/lib/place/product-settings.json')), PRODUCT_SETTINGS, 'byte for byte');
  const config = JSON.parse(readFileSync(file('var/lib/place/place.json'), 'utf8'));
  assert.deepEqual(config, { ...JSON.parse(OLD_CONFIG), release_feed: SETTINGS.release_feed }, 'only release_feed is added');
  const unit = readFileSync(file('etc/systemd/system/place.service'), 'utf8');
  assert.match(unit, /^\[Service\]\nEnvironment=PRODUCT_SETTINGS=\/var\/lib\/place\/product-settings\.json\nType=simple$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/place \/opt\/place\/releases$/m);
  assert.equal(readlinkSync(file('opt/place/current')), '/opt/place/releases/new');
  assert.ok(existsSync(file('opt/place/releases')));
  const kept = file('var/lib/place/backups/update-2026-11-04T17-15-00-000Z/old');
  assert.deepEqual([readFileSync(join(kept, 'place.json'), 'utf8'), readFileSync(join(kept, 'place.service'), 'utf8'), readFileSync(join(kept, 'current.link'), 'utf8')], [OLD_CONFIG, UNIT, '/opt/place/releases/old\n']);
  assert.ok(!existsSync(join(kept, 'product-settings.json')), 'there was none before');
  assert.deepEqual(readFileSync(file('systemctl.calls'), 'utf8').trim().split('\n'), ['daemon-reload', 'restart place.service', 'is-active --quiet place.service']);

  // A second update changes nothing more in the unit, and a rollback of the first puts back what was there.
  await updateAComputer(lease, updateRequest, { ...asHere(root), run: runHere(root), now: new Date('2026-11-04T17:20:00Z') });
  const again = readFileSync(file('etc/systemd/system/place.service'), 'utf8');
  assert.equal(again, unit);
  const back = await rollBackAComputer(lease, updateRequest, answer.backup, { ...asHere(root), run: runHere(root) });
  assert.match(back.rolled_back, /^rolled-back /);
  assert.deepEqual([readFileSync(file('var/lib/place/place.json'), 'utf8'), readFileSync(file('etc/systemd/system/place.service'), 'utf8'), readlinkSync(file('opt/place/current'))], [OLD_CONFIG, UNIT, '/opt/place/releases/old']);
  assert.ok(!existsSync(file('var/lib/place/product-settings.json')));
  await assert.rejects(rollBackAComputer(lease, updateRequest, '/etc', { ...asHere(root), run: runHere(root) }), /BACKUP is a folder an update answered/);
});

test('an update whose service does not stay active, or whose sign-up page does not answer, is put back', async () => {
  for (const [env, extra, why] of [[{ FAKE_REFUSED_RELEASE: '/opt/place/releases/new' }, {}, /put back from .*not active/s], [{}, { fetchImpl: async () => ({ status: 502 }) }, /answered 502 after the update, so it was put back/]]) {
    const { root, lease, file } = madeUpComputer();
    await assert.rejects(updateAComputer(lease, updateRequest, { ...asHere(root, extra), run: runHere(root, env) }), why);
    assert.deepEqual([readFileSync(file('var/lib/place/place.json'), 'utf8'), readFileSync(file('etc/systemd/system/place.service'), 'utf8'), readlinkSync(file('opt/place/current'))], [OLD_CONFIG, UNIT, '/opt/place/releases/old']);
    assert.ok(!existsSync(file('var/lib/place/product-settings.json')));
    assert.equal(readdirSync(file('var/lib/place/backups')).length, 1);
  }
  const { root, lease } = madeUpComputer();
  await assert.rejects(updateAComputer(lease, { ...updateRequest, release_feed: null }, { ...asHere(root), run: runHere(root) }), /An update needs a release_feed/);
});
