import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  machineProvider, nameProvider, providerClient, rentMachine, releaseMachine, readMachine, readPrice, pointName,
  forgetName, fingerprintOf,
} from '../do-work/rent-a-machine.mjs';
import { rentAMachine, startAPlace, placeConfig, readRequest } from '../do-work/start-a-place.mjs';

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
    port: 7199, name: { host_name: 'place.example.com' }, place_config: { report: { takes_new_accounts: true }, router: 'router.example.com:443' }, release_feed: null,
    config_from_release: [{ at: ['new_accounts', 'sign_in_ways'], file: 'data/new-accounts.json', key: 'sign_in_ways' }],
  }, { cents: 699, currency: 'EUR' }, run);
  assert.deepEqual(config, {
    report: { takes_new_accounts: true, reach: 'https://place.example.com', cost_per_month_cents: 699 }, router: 'router.example.com:443',
    listen: '127.0.0.1:7199', accounts: '/var/lib/place/accounts', place_key_file: '/var/lib/place/place.key', public_origin: 'https://place.example.com',
    new_accounts: { sign_in_ways: [{ way: 'passkey' }] },
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
  assert.match(commands.find(c => c.startsWith('sh -s')), /^sh -s -- 'place\.example\.com' '7199' 'engine' 'ENGINE_DATA' 'data' '\/var\/lib\/place\/releases'$/);
  assert.ok(commands.some(c => c.startsWith("install -d -m 0755 '/etc/place' && install -m 0644 /dev/stdin '/etc/place/product-settings.json'")), 'the product settings file is written');
  assert.ok(commands.some(c => c.startsWith("install -m 0644 /dev/stdin '/etc/systemd/system/place.service' && systemctl daemon-reload")), 'the unit is written');
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
  const without = await placeConfig({}, { port: 7199, name: { host_name: 'place.example.com' }, release_feed: null }, null, async () => '');
  assert.ok(!('release_feed' in without) && !('default_places' in without));
  const shipped = await placeConfig({}, { port: 7199, name: { host_name: 'place.example.com' } }, null, async () => '');
  assert.deepEqual(shipped.release_feed, {
    urls: ['https://engine-releases.gettrillion.ai/engine-releases/feed.json'],
    public_keys: ['d9e305a98d6a7001db6f493d17100a799050bf9ade9e3f1e9eb0d9c59d322fb9'],
    releases: '/var/lib/place/releases',
  }, 'a request that names no feed follows the shipped one');
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
  assert.deepEqual([adoptFolder(feed('/opt/place/releases/')), adoptFolder(feed('/opt/place/releases')), adoptFolder(feed({ keep: 3 })), adoptFolder({}), adoptFolder({ release_feed: null })], ['/opt/place/releases', '/opt/place/releases', null, '/var/lib/place/releases', null]);
  const script = readFileSync(new URL('../do-work/set-up-the-machine.sh', import.meta.url), 'utf8');
  assert.match(script, /ADOPT_DIR=\$\{6:-\}/);
  assert.match(script, /install -d -o place -g place -m 0755 "\$ADOPT_DIR"/);
  const { placeUnit } = await import('../do-work/start-a-place.mjs');
  const engine = { file: 'engine', data_env: 'ENGINE_DATA', data_dir: 'data' };
  assert.match(placeUnit({ hostName: 'p.example.com', engine, releases: '/opt/place/releases' }), /^ProtectSystem=strict\nReadWritePaths=\/var\/lib\/place \/opt\/place\/releases$/m);
  assert.match(placeUnit({ hostName: 'p.example.com', engine, releases: '/var/lib/place/releases' }), /^ReadWritePaths=\/var\/lib\/place$/m);
});

test('a start writes both fields into the place config it installs, and a bad feed is refused before anything is rented', async () => {
  const here = folder(), written = [], setups = [];
  const run = async (_machine, command, input) => {
    if (command === 'uname -m') return 'x86_64\n';
    if (command.startsWith('sh -s')) setups.push(command);
    if (command.startsWith('install -o place')) written.push(JSON.parse(input));
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
  assert.deepEqual([written[0].release_feed, written[0].default_places], [release_feed, default_places]);
  assert.match(setups[0], / 'data' '\/opt\/place\/releases'$/, 'set-up is told the folder the engine adopts releases into');
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

// ---- The product settings file, the unit that names it, and the update step on a made-up computer folder ----

const { productSettings, placeUnit, updateAComputer, rollBackAComputer } = await import('../do-work/start-a-place.mjs');
const { execFileSync, spawn: spawnChild } = await import('node:child_process');
const { mkdirSync, existsSync, chmodSync, statSync } = await import('node:fs');

test('the product settings are the values the engines on the computers compiled in, in the shape the engine reads', () => {
  const values = JSON.parse(productSettings());
  assert.deepEqual([values.word, values.site_host, values.app_host, values.brand_mark_path, values.restore_placeholder_owner],
    ['trillion', 'gettrillion.ai', 'app.gettrillion.ai', '/brand/current/mark.svg', 'trillion-local-owner']);
  // trillion-rust bac30d37 (the feed's newest) src/account_files/identity.json `sections`; a key starting `_` is a note.
  const declared = ['secret_home', 'root_credentials_folder', 'tools_source', 'hosting_app_report', 'carried_from'];
  const fields = ['word', 'site_host', 'app_host', 'brand_mark_path', 'restore_placeholder_owner'];
  assert.deepEqual(Object.keys(values).filter(key => !key.startsWith('_') && !fields.includes(key) && !declared.includes(key)), []);
  assert.deepEqual(values.secret_home.items, { account_key: '{word}-agent-work-key', device_key: '{word}-resource-connection-key' });
  assert.deepEqual([values.tools_source.repository, values.tools_source.branch, values.tools_source.first_start_commit], ['Trillion-X/trillion-workshop', 'main', '7588b8c8444db58708a6baa9587416039f809cc6']);
  assert.equal(values.carried_from.root_identity_context, 'trillion held values root identity');
  assert.ok(Buffer.byteLength(productSettings()) <= 65536);
  assert.throws(() => productSettings({ ...values, word: '' }), /need a word/);
  assert.throws(() => productSettings({ ...values, word: 'Trillion' }), /lowercase/);
});

test('the place unit names the product settings, prefers <releases>/current, and always restarts', () => {
  const unit = placeUnit({ hostName: 'place.example.com', engine: { file: 'trillion-local', data_env: 'PRODUCT_DATA_ROOT', data_dir: 'product' }, releases: '/var/lib/place/releases' });
  const exec = unit.match(/^ExecStart=(.*)$/m)[1];
  assert.match(exec, /PRODUCT_SETTINGS=\/etc\/place\/product-settings\.json /);
  assert.match(exec, /\[ -x \/var\/lib\/place\/releases\/current\/trillion-local \] && R=\$\$\(readlink -f \/var\/lib\/place\/releases\/current\)/);
  assert.match(exec, / serve \/var\/lib\/place\/place\.json'$/);
  assert.ok(!/(^|[^$])\$[^$]/.test(exec.replace(/\$\$/g, '')), 'every dollar is systemd\'s literal $$');
  assert.match(unit, /^Restart=always$/m, 'an engine from before trillion-rust #120 stops with code 0 after a switch');
  // The command the shell runs, with systemd's $$ read as $: it starts current when it is there, else /opt/place/current.
  const here = folder(), shell = exec.replace(/^\/bin\/sh -c '(.*)'$/, '$1').replace(/\$\$/g, '$').replaceAll('/var/lib/place/releases', `${here}/releases`).replaceAll('/opt/place/current', `${here}/installed`).replace('exec env', 'echo');
  mkdirSync(join(here, 'installed')); mkdirSync(join(here, 'releases', 'abc'), { recursive: true });
  assert.match(execFileSync('sh', ['-c', shell], { encoding: 'utf8' }), new RegExp(`/installed/trillion-local serve`));
  writeFileSync(join(here, 'releases', 'abc', 'trillion-local'), ''); chmodSync(join(here, 'releases', 'abc', 'trillion-local'), 0o755);
  execFileSync('ln', ['-s', 'abc', join(here, 'releases', 'current')]);
  assert.match(execFileSync('sh', ['-c', shell], { encoding: 'utf8' }), new RegExp(`PRODUCT_DATA_ROOT=${here}/releases/abc/product PRODUCT_SETTINGS=/etc/place/product-settings.json ${here}/releases/abc/trillion-local serve`));
  assert.throws(() => placeUnit({ hostName: 'p.example.com\nExecStartPre=/bin/x', engine: { file: 'e', data_env: 'E', data_dir: 'd' } }), /host name/);
  assert.throws(() => placeUnit({ hostName: 'p.example.com', engine: { file: 'e', data_env: 'E', data_dir: 'd' }, releases: '/var/lib/place/../x' }), /releases folder/);
});

/** A made-up computer: a folder standing for `/`, with a running place (config, unit, no product settings), and a bin
 * folder whose systemctl records each call and answers is-active from the file `active` holds, and whose chown accepts. */
function madeUpComputer() {
  const root = folder(), bin = join(root, '.bin');
  for (const dir of ['var/lib/place', 'etc/systemd/system', 'var/backups', '.bin']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'var/lib/place/place.json'), `${JSON.stringify({ listen: '127.0.0.1:7199', accounts: '/var/lib/place/accounts', report: { reach: 'https://place.example.com' } })}\n`);
  writeFileSync(join(root, 'etc/systemd/system/place.service'), '[Service]\nExecStart=/opt/place/current/engine serve /var/lib/place/place.json\n');
  writeFileSync(join(root, 'active'), 'yes');
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> "${root}/systemctl.calls"\nif [ "$1" = is-active ]; then [ "$(cat "${root}/active")" = yes ]; exit $?; fi\nif [ "$1" = restart ] && [ -e "${root}/etc/place/product-settings.json" ] && [ -e "${root}/fail-new" ]; then echo no > "${root}/active"; elif [ "$1" = restart ]; then echo yes > "${root}/active"; fi\n`);
  writeFileSync(join(bin, 'chown'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'systemctl'), 0o755); chmodSync(join(bin, 'chown'), 0o755);
  // `run` as ssh would run it, on the made-up computer: absolute paths in quotes are put under the folder, and the
  // update script gets PLACE_ROOT.
  const commands = [];
  const run = (_machine, command, input) => new Promise((resolve, reject) => {
    commands.push(command);
    const local = command.startsWith('sh -s') ? command : command.replace(/'\//g, `'${root}/`);
    const child = spawnChild('sh', ['-c', `cat | { ${local}
}`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLACE_ROOT: root } });
    let out = '', err = '';
    child.stdout.on('data', bytes => { out += bytes; });
    child.stderr.on('data', bytes => { err += bytes; });
    child.on('close', code => (code === 0 ? resolve(out) : reject(Object.assign(new Error(`exited ${code}: ${err.trim()}`), { code }))));
    child.stdin.end(input ?? '');
  });
  const lease = join(root, 'lease.json');
  writeFileSync(lease, JSON.stringify({ schema: 'place-lease/1', provider: 'existing-machine', name: 'made-up', state: 'running', address: '192.0.2.50', hostName: 'place.example.com' }));
  return { root, run, lease, commands };
}

const updateRequest = here => ({ ssh: { known_hosts: join(here, 'known_hosts') }, engine: { file: 'trillion-local', data_env: 'PRODUCT_DATA_ROOT', data_dir: 'product' } });
const at = (root, path) => readFileSync(join(root, path), 'utf8');

test('updating a running computer writes the product settings, the unit and the feed, and keeps the old files', async () => {
  const { root, run, lease } = madeUpComputer(), before = at(root, 'var/lib/place/place.json'), beforeUnit = at(root, 'etc/systemd/system/place.service');
  const answer = await updateAComputer(lease, updateRequest(root), { run, settle: 0, stamp: 's1', fetchImpl: async () => ({ status: 200 }), wait: async () => {} });
  assert.deepEqual([answer.stamp, answer.backup, answer.sign_up_status], ['s1', '/var/backups/place/s1/old', 200]);
  assert.equal(at(root, 'etc/place/product-settings.json'), productSettings(), 'the product settings file is the shipped one, byte for byte');
  const config = JSON.parse(at(root, 'var/lib/place/place.json'));
  assert.deepEqual(config.release_feed.public_keys, ['d9e305a98d6a7001db6f493d17100a799050bf9ade9e3f1e9eb0d9c59d322fb9']);
  assert.deepEqual({ ...config, release_feed: undefined }, { ...JSON.parse(before), release_feed: undefined }, 'nothing else in the config changes');
  assert.equal((statSync(join(root, 'var/lib/place/place.json')).mode & 0o777), 0o600);
  assert.match(at(root, 'etc/systemd/system/place.service'), /PRODUCT_SETTINGS=\/etc\/place\/product-settings\.json/);
  assert.ok(existsSync(join(root, 'var/lib/place/releases')), 'the releases folder is made');
  assert.equal(at(root, 'var/backups/place/s1/old/place.json'), before);
  assert.equal(at(root, 'var/backups/place/s1/old/place.service'), beforeUnit);
  assert.ok(existsSync(join(root, 'var/backups/place/s1/old/product-settings.json.absent')), 'a file that was not there is kept as absent');
  assert.deepEqual(at(root, 'systemctl.calls').trim().split('\n'), ['daemon-reload', 'restart place.service', 'is-active --quiet place.service']);

  // Rolling it back by hand puts every old file back and removes the one that was not there.
  await rollBackAComputer(lease, updateRequest(root), 's1', { run, settle: 0 });
  assert.equal(at(root, 'var/lib/place/place.json'), before);
  assert.equal(at(root, 'etc/systemd/system/place.service'), beforeUnit);
  assert.ok(!existsSync(join(root, 'etc/place/product-settings.json')));
  await assert.rejects(updateAComputer(lease, updateRequest(root), { run, settle: 0, stamp: 's1', fetchImpl: async () => ({ status: 200 }), wait: async () => {} }), /applied once|rolled back/, 'a stamp is applied once');
});

test('an update whose service does not come up is rolled back on the computer', async () => {
  const { root, run, lease } = madeUpComputer(), before = at(root, 'var/lib/place/place.json');
  writeFileSync(join(root, 'fail-new'), '');
  await assert.rejects(updateAComputer(lease, updateRequest(root), { run, settle: 0, stamp: 's2', fetchImpl: async () => ({ status: 200 }), wait: async () => {} }), error => error.rolled_back && /did not start and was rolled back/.test(error.message));
  assert.equal(at(root, 'var/lib/place/place.json'), before);
  assert.ok(!existsSync(join(root, 'etc/place/product-settings.json')));
  assert.equal(at(root, 'active').trim(), 'yes', 'the old files serve again');
});

test('an update whose sign-up page does not answer 200 is rolled back', async () => {
  const { root, run, lease, commands } = madeUpComputer(), before = at(root, 'var/lib/place/place.json');
  await assert.rejects(updateAComputer(lease, updateRequest(root), { run, settle: 0, stamp: 's3', tries: 2, fetchImpl: async () => ({ status: 502 }), wait: async () => {} }), /answered 502 after the update, so it was rolled back/);
  assert.equal(at(root, 'var/lib/place/place.json'), before);
  assert.ok(commands.at(-1).startsWith("sh -s -- rollback 's3' '/var/lib/place/place.json'"));
  await assert.rejects(updateAComputer(lease, { ...updateRequest(root), release_feed: null }, { run }), /writes the release feed/);
});
