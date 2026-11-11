import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, readlinkSync, chmodSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import {
  machineProvider, nameProvider, providerClient, rentMachine, releaseMachine, readMachine, readPrice, pointName,
  forgetName, fingerprintOf,
} from '../do-work/rent-a-machine.mjs';
import {
  rentAMachine, startAComputer as startAComputerRaw, computerConfig as computerConfigRaw, readRequest, updateAComputer as updateAComputerRaw, rollBackAComputer, productSettings, productSettingsOf, readProductData, startingRows,
  parseUnit, readLayout, copiesFor as copiesForRaw, copiesPolicy,
} from '../do-work/start-a-computer.mjs';

/* The GNU mv a Linux shell fixture needs (identical to the process-session test helper's, which is not part of this folder). */
/** Find an executable that identifies itself as GNU coreutils mv, regardless of its installed name. */
export function findGnuMove({ path = process.env.PATH ?? '', extraDirectories = ['/opt/homebrew/bin', '/usr/local/bin'] } = {}) {
  const directories = [...new Set([...path.split(delimiter), ...extraDirectories].filter(directory => directory && isAbsolute(directory)))];
  const checked = new Set();
  for (const directory of directories) {
    for (const name of ['mv', 'gmv']) {
      const candidate = join(directory, name);
      let executable;
      try {
        accessSync(candidate, constants.X_OK);
        executable = realpathSync(candidate);
      } catch { continue; }
      if (checked.has(executable)) continue;
      checked.add(executable);
      const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, LC_ALL: 'C' } });
      if (version.status === 0 && /^mv \(GNU coreutils\) \S+/m.test(version.stdout ?? '')) return executable;
    }
  }
  throw new Error('These Linux shell fixtures require genuine GNU coreutils mv. Install coreutils so mv or gmv is on PATH (or in a standard package bin folder); BSD mv is not a substitute.');
}

/** Expose the real target executable under its Linux command name in a fixture-owned PATH folder. */
export function linkGnuMove(folder, options) {
  const executable = findGnuMove(options), destination = join(folder, 'mv');
  if (existsSync(destination)) {
    if (realpathSync(destination) !== executable) throw new Error(`The fixture already owns a different mv at ${destination}.`);
  } else symlinkSync(executable, destination);
  return executable;
}

// Synthetic caller profile only; production identity and starting rows live in the caller's package.
const SEED_COPIES = { least_copy_keepers: 3, least_voters: 3, least_may_answer: 2, least_always_on: 0 };
const PRODUCT = { word: 'sample', new_accounts: {
  sign_in: { token_seconds: 120 }, sign_in_ways: { test_way: true },
  sign_in_words: { heading: 'Sign in to the sample' }, copies_rules: { rule: 'sample-rule' }, copies: SEED_COPIES,
} };
/** A product data manifest (computer/product-data.json's shape) and its files, written into `here`; identities are the BLAKE3 owner's. */
function writeProductData(here, settings, statics = []) {
  mkdirSync(here, { recursive: true });
  const write = (name, bytes) => { writeFileSync(join(here, name), bytes); return { file: name, identity: makeHashCodeHexFromBytes(bytes) }; };
  const manifest = {
    product_settings: write('product-settings.json', Buffer.from(`${JSON.stringify(settings, null, 2)}\n`)),
    static: statics.map(({ name, text }) => ({ name, ...write(`source-${name.replace(/\//g, '-')}`, Buffer.from(text)) })),
  };
  writeFileSync(join(here, 'product-data.json'), JSON.stringify(manifest));
  return join(here, 'product-data.json');
}
const PRODUCT_DATA = writeProductData(mkdtempSync(join(tmpdir(), 'start-a-computer-product-')), PRODUCT);
/** The bytes a computer's settings file gets from PRODUCT_DATA (the tool's own derivation, pinned here). */
const PRODUCT_BYTES = productSettingsOf(readProductData({ product_data: PRODUCT_DATA })).bytes;
const FEED = { urls: ['https://releases.example.test/feed.json'], public_keys: ['a'.repeat(64)], releases: '/opt/place/releases' };
const withProfile = request => ({ product_data: PRODUCT_DATA, release_feed: FEED, ...request });
const startAComputer = (request, ...deps) => startAComputerRaw(withProfile(request), ...deps);
const computerConfig = (machine, request, ...deps) => computerConfigRaw(machine, withProfile(request), ...deps);
const updateAComputer = (lease, request, ...deps) => updateAComputerRaw(lease, withProfile(request), ...deps);
const copiesFor = config => copiesForRaw(config, SEED_COPIES);

const canary = 'provider-credential-canary-0123456789';
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample0 someone@example.com';
const folder = () => mkdtempSync(join(tmpdir(), 'start-a-computer-'));
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
  const request = providerClient(hetzner, canary, { fetchImpl: provider(hetzner.base, { 'GET /servers?name=a-computer': { servers: [] } }) });
  assert.deepEqual(await request('GET', '/servers?name=a-computer'), { servers: [] });
  await assert.rejects(request('DELETE', '/volumes/7'), /operation was refused/);
  await assert.rejects(request('DELETE', '/servers/abc'), /operation was refused/);
  assert.throws(() => providerClient(hetzner, ''), /credential was refused/);
});

test('renting stores the key, makes the machine with this lease\'s label, and releases only what it owns', async () => {
  const file = join(folder(), 'lease.json'), calls = [];
  const fetchImpl = provider(hetzner.base, {
    'GET /servers?name=a-computer': { servers: [] },
    [`GET /ssh_keys?fingerprint=${encodeURIComponent(fingerprintOf(publicKey))}`]: { ssh_keys: [] },
    'POST /ssh_keys': body => ({ ssh_key: { id: 11, labels: body.labels } }),
    'POST /servers': body => ({ server: { id: 22, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.10' } } } }),
    'GET /servers/22': { server: { id: 22, status: 'running', labels: { 'place-lease': 'a-computer' }, public_net: { ipv4: { ip: '192.0.2.10' } } } },
    'DELETE /servers/22': {},
    'GET /ssh_keys/11': { ssh_key: { id: 11, labels: { 'place-lease': 'a-computer' } } },
    'DELETE /ssh_keys/11': {},
  }, calls);
  const request = providerClient(hetzner, canary, { fetchImpl });
  const lease = await rentMachine({ request, file, provider: hetzner, name: 'a-computer', publicKey, placement: { size: 'cax11' }, lifetime: 'service' });
  assert.deepEqual([lease.state, lease.serverId, lease.sshKeyId, lease.address, lease.serverType, lease.location], ['running', 22, 11, '192.0.2.10', 'cax11', 'hel1']);
  const made = calls.find(([key]) => key === 'POST /servers')[1];
  assert.deepEqual([made.server_type, made.ssh_keys, made.labels], ['cax11', [11], { 'place-lease': 'a-computer' }]);
  assert.deepEqual(await readMachine({ request, file, provider: hetzner }), { state: 'running', address: '192.0.2.10' });
  assert.equal((await releaseMachine({ request, file, provider: hetzner })).state, 'removed');
  assert.ok(calls.some(([key]) => key === 'DELETE /servers/22') && calls.some(([key]) => key === 'DELETE /ssh_keys/11'));
  assert.ok(!readFileSync(file, 'utf8').includes(canary));
});

test('a public key the provider already holds is used as it is and never removed', async () => {
  const file = join(folder(), 'lease.json'), calls = [];
  const fetchImpl = provider(hetzner.base, {
    'GET /servers?name=a-computer': { servers: [] },
    [`GET /ssh_keys?fingerprint=${encodeURIComponent(fingerprintOf(publicKey))}`]: { ssh_keys: [{ id: 5, labels: {} }] },
    'POST /servers': body => ({ server: { id: 23, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.11' } } } }),
    'GET /servers/23': { server: { id: 23, labels: { 'place-lease': 'a-computer' } } },
    'DELETE /servers/23': {},
  }, calls);
  const request = providerClient(hetzner, canary, { fetchImpl });
  const lease = await rentMachine({ request, file, provider: hetzner, name: 'a-computer', publicKey, lifetime: 'service' });
  assert.deepEqual([lease.sshKeyId, lease.sharedSshKeyId], [null, 5]);
  assert.deepEqual(calls.find(([key]) => key === 'POST /servers')[1].ssh_keys, [5]);
  await releaseMachine({ request, file, provider: hetzner });
  assert.ok(!calls.some(([key]) => key.startsWith('POST /ssh_keys') || key.startsWith('DELETE /ssh_keys')));
});

test('a machine someone else labelled is left untouched', async () => {
  const file = join(folder(), 'lease.json');
  writeFileSync(file, JSON.stringify({ schema: 'place-lease/1', provider: 'hetzner', name: 'a-computer', state: 'running', serverId: 30, sshKeyId: null }));
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
  writeFileSync(file, JSON.stringify({ schema: 'place-lease/1', provider: 'hetzner', name: 'a-computer', state: 'running', address: '192.0.2.10' }));
  const fetchImpl = provider(cloudflare.base, {
    'GET /zones?name=example.com': { result: [{ id: zone, name: 'example.com' }] },
    [`GET /zones/${zone}/dns_records?type=A&name=computer.example.com`]: { result: [] },
    [`POST /zones/${zone}/dns_records`]: body => ({ result: { id: record, ...body } }),
    [`GET /zones/${zone}/dns_records/${record}`]: { result: { id: record, comment: 'place-lease a-computer' } },
    [`DELETE /zones/${zone}/dns_records/${record}`]: { result: { id: record } },
  }, calls);
  const request = providerClient(cloudflare, canary, { fetchImpl });
  const lease = await pointName({ request, file, provider: cloudflare, zone: 'example.com', hostName: 'computer.example.com' });
  assert.deepEqual([lease.recordId, lease.hostName], [record, 'computer.example.com']);
  assert.deepEqual(calls.find(([key]) => key.startsWith('POST'))[1], { type: 'A', name: 'computer.example.com', content: '192.0.2.10', ttl: 60, proxied: false, comment: 'place-lease a-computer' });
  assert.equal((await forgetName({ request, file, provider: cloudflare })).recordId, null);
  assert.ok(calls.some(([key]) => key.startsWith('DELETE')));
});

test('the computer config takes the machine\'s own fields and values read from the release', async () => {
  const run = async (_machine, command) => {
    assert.equal(command, "cat '/opt/place/current/data/new-accounts.json'");
    return JSON.stringify({ sign_in_ways: [{ way: 'passkey' }] });
  };
  const config = await computerConfig({}, {
    port: 7199, name: { host_name: 'computer.example.com' }, place_config: { report: { takes_new_accounts: true }, router: 'router.example.com:443' },
    config_from_release: [{ at: ['new_accounts', 'sign_in_ways'], file: 'data/new-accounts.json', key: 'sign_in_ways' }],
  }, { cents: 699, currency: 'EUR' }, run);
  assert.deepEqual(config, {
    report: { takes_new_accounts: true, reach: 'https://computer.example.com', cost_per_month_cents: 699 }, router: 'router.example.com:443',
    listen: '127.0.0.1:7199', accounts: '/var/lib/place/accounts', place_key_file: '/var/lib/place/place.key', public_origin: 'https://computer.example.com',
    new_accounts: { ...PRODUCT.new_accounts, sign_in_ways: [{ way: 'passkey' }], copies: { least_copy_keepers: 1, least_voters: 1, least_may_answer: 1, least_always_on: 0 } }, release_feed: FEED,
  });
  const behind = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' }, public_origin: 'https://front.example.com' }, null, run);
  assert.deepEqual([behind.public_origin, behind.report.reach], ['https://front.example.com', 'https://computer.example.com']);
});

test('a request\'s paths are read relative to its own file', () => {
  const here = folder(), file = join(here, 'request.json');
  writeFileSync(file, JSON.stringify({ lease_file: 'lease.json', machine: { provider: 'existing-machine' }, ssh: { known_hosts: 'known_hosts' }, engine: { release: { tarball: 'r.tar.gz' } } }));
  const request = readRequest(file);
  assert.deepEqual([request.lease_file, request.ssh.known_hosts, request.engine.release.tarball], [join(here, 'lease.json'), join(here, 'known_hosts'), join(here, 'r.tar.gz')]);
});

test('starting a computer on an existing machine sets it up, installs the release, serves and reads it back', async () => {
  const here = folder(), commands = [];
  const run = async (_machine, command, input) => {
    commands.push(command);
    if (command === 'uname -m') return 'aarch64\n';
    if (command.startsWith('cat ')) return JSON.stringify({ sign_in_ways: [] });
    if (command.startsWith('install -o place') && command.endsWith('/var/lib/place/place.json')) assert.equal(JSON.parse(input).public_origin, 'https://computer.example.com');
    if (command.includes("'computer' 'id' '/var/lib/place/place.json'")) return 'f'.repeat(64);
    return '';
  };
  const answer = await startAComputer({
    lease_file: join(here, 'lease.json'), machine: { provider: 'existing-machine', name: 'a-pi', placement: { address: '192.0.2.40' }, lifetime: 'service' },
    name: { host_name: 'computer.example.com' }, ssh: { known_hosts: join(here, 'known_hosts') }, port: 7199,
    engine: { file: 'engine', data_env: 'ENGINE_DATA', data_dir: 'data', id_argv: ['computer', 'id'], release_name: 'r1', release: { on_machine: '/opt/build/release' } },
    config_from_release: [{ at: ['new_accounts', 'sign_in_ways'], file: 'data/new-accounts.json', key: 'sign_in_ways' }],
  }, { run, fetchImpl: async address => ({ status: address === 'https://computer.example.com/sign-up' ? 200 : 404 }), wait: async () => {} });
  assert.deepEqual([answer.arch, answer.place_id, answer.sign_up_status, answer.release, answer.price], ['aarch64', 'f'.repeat(64), 200, '/opt/place/releases/r1', null]);
  assert.match(commands.find(c => c.startsWith('sh -s')), /^sh -s -- 'computer\.example\.com' '7199' 'engine' 'ENGINE_DATA' 'data' 'PRODUCT_SETTINGS' '\/var\/lib\/place\/product-settings\.json' '\/opt\/place\/releases'$/);
  assert.ok(commands.find(c => c.includes("'computer' 'id'")).includes("env PRODUCT_SETTINGS='/var/lib/place/product-settings.json' ENGINE_DATA="), 'the id command reads the product settings too');
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

test('the computer config carries the request\'s release feed and default computers', async () => {
  const key = 'b'.repeat(64), id = 'e'.repeat(64);
  const release_feed = { urls: ['https://releases.example.com/engine-releases/feed.json'], public_keys: [key], releases: '/opt/place/releases' };
  const default_places = { holders: ['this-place', id], answering: ['this-place'] };
  const config = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' }, release_feed, default_places }, null, async () => '');
  assert.deepEqual([config.release_feed, config.default_places], [release_feed, default_places]);
  const fixture = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' }, place_config: { new_accounts: { copies: { least_copy_keepers: 3, least_voters: 3, least_may_answer: 2, least_always_on: 0 } } }, default_places: { holders: ['this-place'], answering: ['this-place'] } }, null, async () => '');
  assert.deepEqual(fixture.new_accounts.copies, { least_copy_keepers: 1, least_voters: 1, least_may_answer: 1, least_always_on: 0 }, 'a computer alone is never given copies it cannot meet');
  const product = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' } }, null, async () => '');
  assert.deepEqual(product.release_feed, FEED, 'a request that names no feed follows the product\'s');
  assert.ok(!('default_places' in product));
  const without = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' }, release_feed: null }, null, async () => '');
  assert.ok(!('release_feed' in without));
  await assert.rejects(computerConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, release_feed: { ...release_feed, public_keys: ['short'] } }, null), /64 lowercase hex/);
  await assert.rejects(computerConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, release_feed: { ...release_feed, urls: ['http://insecure.example.com/feed.json'] } }, null), /https addresses/);
  await assert.rejects(computerConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, default_places: { answering: [id] } }, null), /holders must name/);
  for (const releases of ['/opt/place/../../etc', '/opt/place releases', '/opt/place/releases\nReadWritePaths=/']) {
    await assert.rejects(computerConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, release_feed: { ...release_feed, releases } }, null), /absolute path of letters/);
  }
});

test('the folder a feed adopts releases into is made writable for the `place` service, which runs with ProtectSystem=strict', async () => {
  const { adoptFolder } = await import('../do-work/start-a-computer.mjs');
  const feed = releases => ({ release_feed: { urls: [], public_keys: [], releases } });
  assert.deepEqual([adoptFolder(feed('/opt/place/releases/')), adoptFolder(feed('/opt/place/releases')), adoptFolder(feed({ keep: 3 })), adoptFolder({}), adoptFolder({ release_feed: null })], ['/opt/place/releases', '/opt/place/releases', null, null, null]);
  const script = readFileSync(new URL('../do-work/set-up-the-machine.sh', import.meta.url), 'utf8');
  assert.match(script, /ADOPT_DIR=\$\{8:-\}/);
  assert.match(script, /^\[Service\]\nEnvironment=\$SETTINGS_ENV=\$SETTINGS_FILE$/m);
  assert.match(script, /install -d -o place -g place -m 0755 "\$ADOPT_DIR"/);
  assert.match(script, /^ProtectSystem=strict\nReadWritePaths=\$WRITABLE$/m);
});

test('a start writes both fields into the computer config it installs, and a bad feed is refused before anything is rented', async () => {
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
    name: { host_name: 'computer.example.com' }, ssh: { known_hosts: join(here, 'known_hosts') }, port: 7199,
    engine: { file: 'engine', data_env: 'ENGINE_DATA', data_dir: 'data', release_name: 'r1', release: { on_machine: '/opt/build/release' } },
    release_feed, default_places,
  };
  await startAComputer(request, { run, fetchImpl: async () => ({ status: 200 }), wait: async () => {} });
  assert.deepEqual(written[0], PRODUCT_BYTES, 'the product settings file is written byte for byte, before the config');
  assert.deepEqual([written[1].release_feed, written[1].default_places], [release_feed, default_places]);
  assert.match(setups[0], / 'data' 'PRODUCT_SETTINGS' '\/var\/lib\/place\/product-settings\.json' '\/opt\/place\/releases'$/, 'set-up is told the folder the engine adopts releases into');
  const lease = join(here, 'second-lease.json');
  await assert.rejects(startAComputer({ ...request, lease_file: lease, release_feed: { urls: [] } }, { run }), /release_feed/);
  assert.throws(() => readFileSync(lease), /ENOENT/);
});

test('the sign-up check answers the way a browser does and its passkey signs what it says', async () => {
  const { checkASignUp, softwarePasskey, assertion } = await import('../do-work/check-a-sign-up.mjs');
  const { createVerify, createPublicKey } = await import('node:crypto');
  const origin = 'https://front.example', address = 'c'.repeat(64), seen = [];
  let withRouteCookie = true;
  const fetchImpl = async (url, request) => {
    const path = url.slice(origin.length), body = request.body && JSON.parse(request.body);
    seen.push([request.method, path, request.headers.origin ?? null, request.headers.cookie ?? null]);
    const answer = (status, json, cookie) => ({ status, headers: { get: name => (name === 'set-cookie' ? cookie ?? null : null) }, text: async () => JSON.stringify(json ?? {}) });
    if (path === '/sign-up') return answer(200);
    if (path === '/sign-up/options') return answer(200, { options: { challenge: 'up-1', rp: { id: 'example' } } }, withRouteCookie ? '__Secure-sign-up-computer=second.example:443; Path=/sign-up; Secure; HttpOnly; SameSite=Strict' : undefined);
    if (path === '/sign-up/finish') {
      assert.equal(request.headers.cookie, withRouteCookie ? '__Secure-sign-up-computer=second.example:443' : undefined);
      const client = JSON.parse(Buffer.from(body.response.clientDataJSON, 'base64url'));
      assert.deepEqual([client.type, client.challenge, client.origin], ['webauthn.create', 'up-1', origin]);
      assert.equal(body.response.publicKeyAlgorithm, -7);
      return answer(200, { address });
    }
    if (path === `/a/${address}/passkey/options`) return answer(200, { challenge: 'in-1', rpId: 'example' }, `ceremony=once; Path=/a/${address}/passkey; Secure; HttpOnly`);
    if (path === `/a/${address}/passkey/finish`) {
      assert.equal(request.headers.cookie, 'ceremony=once');
      return answer(200, { ok: true }, `session=s1; Path=/; Secure; HttpOnly, __Host-account-address=${address}; Expires=Tue, 19 Jan 2038 03:14:07 GMT; Path=/; Secure; HttpOnly`);
    }
    if (path === `/a/${address}/sign-in/security`) return answer(request.headers.cookie === `session=s1; __Host-account-address=${address}` ? 200 : 303);
    return answer(404);
  };
  const answer = await checkASignUp(origin, { fetchImpl });
  assert.equal(answer.address, address);
  assert.equal(answer.signed_in_read, true);
  assert.deepEqual(answer.steps.map(step => step.status), [200, 200, 200, 200, 200, 200, 303]);
  assert.ok(seen.filter(([method]) => method === 'POST').every(([, , sent]) => sent === origin));
  assert.ok(!JSON.stringify(answer).includes('s1'));
  assert.ok(!JSON.stringify(answer).includes('second.example'));
  withRouteCookie = false;
  assert.equal((await checkASignUp(origin, { fetchImpl })).signed_in_read, true, 'direct computer signup also works without an affinity cookie');

  // The assertion is a valid ES256 signature over authenticatorData || SHA-256(clientDataJSON).
  const passkey = softwarePasskey();
  const signed = assertion(passkey, { challenge: 'c', rpId: 'example' }, origin);
  const auth = Buffer.from(signed.response.authenticatorData, 'base64url'), client = Buffer.from(signed.response.clientDataJSON, 'base64url');
  const { createHash } = await import('node:crypto');
  const verify = createVerify('sha256').update(Buffer.concat([auth, createHash('sha256').update(client).digest()]));
  assert.ok(verify.verify(createPublicKey({ key: passkey.spki, format: 'der', type: 'spki' }), Buffer.from(signed.response.signature, 'base64url')));
  await assert.rejects(checkASignUp('https://front.example/path', { fetchImpl }), /ORIGIN is https:\/\/host/);
});

// Made-up computer folders under `root`, laid out two ways: the way set-up-the-machine.sh lays a machine out, and the
// way the running computers were laid out by hand (another release folder, state folder and unit name). The update
// is told neither: it reads each from the unit.
const ME = userInfo().username;
const LAYOUTS = {
  'start-a-computer': { base: '/opt/place', state: '/var/lib/place', unit: 'place.service', release: '/opt/place/releases/old' },
  'by hand': { base: '/opt/trillion', state: '/srv/trillion/state', unit: 'trillion-place.service', release: '/opt/trillion/releases/old-engine' },
};
const unitOf = l => `[Unit]
Description=A computer that keeps accounts (computer.example.com)

[Service]
Type=simple
User=${ME}
WorkingDirectory=${l.state}
ExecStart=/bin/sh -c 'R=$(readlink -f ${l.base}/current) && exec env PRODUCT_DATA_ROOT="$R/product" "$R/trillion-local" serve ${l.state}/place.json'
ProtectSystem=strict
ReadWritePaths=${l.state}

[Install]
WantedBy=multi-user.target
`;
const THREE = { least_copy_keepers: 3, least_voters: 3, least_may_answer: 2, least_always_on: 0 };
const OLD_CONFIG = `${JSON.stringify({ listen: '127.0.0.1:7199', accounts: '/x/accounts', public_origin: 'https://computer.example.com', new_accounts: { copies: THREE, copies_rules: { rule: 'kept as it is' } } }, null, 1)}\n`;

// The release binary is the fake engine: the bootstrap asks it for its target, fetches the newest release and switches to it.
const fakeEngine = readFileSync(new URL('./fake-trillion-local', import.meta.url));

function madeUpComputer(l, { units = [] } = {}) {
  const root = folder(), bin = join(root, 'fake-bin');
  for (const dir of [l.state, 'etc/systemd/system', l.release, 'opt/build/new', 'fake-bin']) mkdirSync(join(root, dir), { recursive: true });
  linkGnuMove(bin);
  writeFileSync(join(root, l.state, 'place.json'), OLD_CONFIG);
  writeFileSync(join(root, 'etc/systemd/system', l.unit), unitOf(l));
  for (const [name, text] of units) writeFileSync(join(root, 'etc/systemd/system', name), text);
  for (const dir of [l.release, 'opt/build/new']) { writeFileSync(join(root, dir, 'trillion-local'), fakeEngine); chmodSync(join(root, dir, 'trillion-local'), 0o755); }
  symlinkSync(l.release, join(root, l.base, 'current'));
  // systemctl: each call is written down; the service is not active when releases/current names FAKE_REFUSED_RELEASE.
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> "$ROOT/systemctl.calls"\nif [ "$1" = is-active ] && [ "$(readlink "$ROOT${l.base}/releases/current")" = "\${FAKE_REFUSED_RELEASE:-none}" ]; then exit 3; fi\nexit 0\n`);
  chmodSync(join(bin, 'systemctl'), 0o755);
  const lease = join(root, 'lease.json');
  writeFileSync(lease, JSON.stringify({ schema: 'place-lease/1', provider: 'existing-machine', name: 'a-computer', address: '192.0.2.50', adopted: true, hostName: 'computer.example.com' }));
  return { root, lease, file: path => join(root, path) };
}

// `run` on the made-up computer: each command runs here, in sh, with the fake systemctl first on the PATH. Its input
// is read from a file, as ssh hands a pipe: Node's own stdin pipe is a socket, which /dev/stdin cannot open.
const runHere = (root, env = {}) => async (_machine, command, input) => {
  const engineEnv = { FAKE_TRILLION_CALLS: join(root, 'engine.calls'), FAKE_RELEASE_COMMIT: 'new', FAKE_TARGET: 'x86_64-unknown-linux-gnu', FAKE_FETCH_COMMIT: 'new' };
  let bytes = input ?? '';
  if (input?.pipe) { const parts = []; for await (const part of input) parts.push(part); bytes = Buffer.concat(parts); }
  const stdin = join(root, 'stdin'); writeFileSync(stdin, bytes);
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', `${command} < '${stdin}'`], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...engineEnv, ...env, ROOT: root, PATH: `${join(root, 'fake-bin')}:${process.env.PATH}` } });
    let out = '', err = '';
    child.stdout.on('data', part => { out += part; });
    child.stderr.on('data', part => { err += part; });
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`exited ${code}: ${err.trim()}`))));
  });
};

const updateRequest = { product_data: PRODUCT_DATA, release_feed: { ...FEED, releases: { keep: 3 } }, ssh: { known_hosts: '/dev/null' }, name: { host_name: 'computer.example.com' }, engine: { file: 'trillion-local', release_name: 'new', release: { on_machine: '/opt/build/new' } } };
const asHere = (root, extra = {}) => ({ root, settle: 0, wait: async () => {}, tries: 1, fetchImpl: async () => ({ status: 200 }), ...extra });
const read = (file, path) => readFileSync(file(path), 'utf8');

for (const [kind, l] of Object.entries(LAYOUTS)) {
  test(`an update reads a ${kind} computer's own layout and gives it the product settings, the feed, a copies policy it can meet and the release, keeping a backup`, async () => {
    const { root, lease, file } = madeUpComputer(l);
    const answer = await updateAComputer(lease, updateRequest, { ...asHere(root), run: runHere(root), now: new Date('2026-11-04T17:15:00Z') });
    const backup = `${l.state}/backups/update-2026-11-04T17-15-00-000Z`, releases = `${l.base}/releases`;
    assert.deepEqual(answer, {
      layout: { unit: l.unit, config: `${l.state}/place.json`, current: `${l.base}/current`, state: l.state, releases },
      release: `${releases}/new`, backup, product_settings: `${l.state}/product-settings.json`,
      release_feed: { urls: FEED.urls, releases }, copies: { least_copy_keepers: 1, least_voters: 1, least_may_answer: 1, least_always_on: 0 }, sign_up_status: 200,
    });
    assert.deepEqual(readFileSync(file(`${l.state}/product-settings.json`)), PRODUCT_BYTES, 'byte for byte, in the computer\'s own state folder');
    const config = JSON.parse(read(file, `${l.state}/place.json`)), old = JSON.parse(OLD_CONFIG);
    assert.deepEqual(config, { ...old, new_accounts: { ...PRODUCT.new_accounts, ...old.new_accounts, copies: answer.copies }, release_feed: { ...FEED, releases } }, 'the feed adopts into this computer\'s own releases folder; only copies changes in new_accounts');
    const unit = read(file, `etc/systemd/system/${l.unit}`);
    assert.match(unit, new RegExp(`^\\[Service\\]\\nEnvironment=PRODUCT_SETTINGS=${l.state}/product-settings\\.json\\nLimitNOFILE=1048576\\nType=simple$`, 'm'));
    assert.match(unit, new RegExp(`^ReadWritePaths=${l.state} ${releases}$`, 'm'));
    assert.equal(readlinkSync(file(`${releases}/current`)), `${releases}/new`, 'the follower\'s own pointer, switched by the new release');
    assert.equal(readlinkSync(file(`${l.base}/current`)), l.release, 'the link the unit no longer starts from is left as it was');
    const kept = file(`${backup}/old`);
    assert.deepEqual([readFileSync(join(kept, 'place.json'), 'utf8'), readFileSync(join(kept, 'unit'), 'utf8'), readFileSync(join(kept, 'current.link'), 'utf8')], [OLD_CONFIG, unitOf(l), `${l.release}\n`]);
    assert.deepEqual(read(file, 'systemctl.calls').trim().split('\n'), ['daemon-reload', `restart ${l.unit}`, `is-active --quiet ${l.unit}`]);

    // A second update with no release keeps the one current names, and changes nothing more in the unit; a rollback
    // of the first puts back what was there, from the layout the backup kept.
    const second = await updateAComputer(lease, { ...updateRequest, engine: { file: 'trillion-local' } }, { ...asHere(root), run: runHere(root), now: new Date('2026-11-04T17:20:00Z') });
    assert.equal(second.release, `${releases}/new`);
    assert.equal(read(file, `etc/systemd/system/${l.unit}`), unit);
    const back = await rollBackAComputer(lease, updateRequest, answer.backup, { ...asHere(root), run: runHere(root) });
    assert.match(back.rolled_back, /^rolled-back /);
    assert.deepEqual([read(file, `${l.state}/place.json`), read(file, `etc/systemd/system/${l.unit}`), readlinkSync(file(`${l.base}/current`))], [OLD_CONFIG, unitOf(l), l.release]);
    assert.ok(!existsSync(file(`${l.state}/product-settings.json`)));
    assert.ok(!existsSync(file(`${releases}/current`)), 'a pointer the update created is removed by the rollback');
  });

  test(`a ${kind} computer's bootstrap rewrites its ExecStart to start the engine through releases/current, the link the follower switches`, async () => {
    const { root, lease, file } = madeUpComputer(l);
    await updateAComputer(lease, updateRequest, { ...asHere(root), run: runHere(root), now: new Date('2026-11-04T17:30:00Z') });
    const releases = `${l.base}/releases`;
    const exec = read(file, `etc/systemd/system/${l.unit}`).match(/^ExecStart=(.*)$/m)[1];
    assert.equal(exec, `/bin/sh -c 'R=$(readlink -f ${releases}/current) && exec env PRODUCT_DATA_ROOT="$R/product" "$R/trillion-local" serve ${l.state}/place.json'`);
    assert.equal(readlinkSync(file(`${releases}/current`)), `${releases}/new`);
  });

  test(`a ${kind} computer's update whose service does not stay active, or whose sign-up page does not answer, is put back`, async () => {
    for (const [env, extra, why] of [[{ FAKE_REFUSED_RELEASE: `${l.base}/releases/new` }, {}, /put back from .*not active/s], [{}, { fetchImpl: async () => ({ status: 502 }) }, /answered 502 after the update, so it was put back/]]) {
      const { root, lease, file } = madeUpComputer(l);
      await assert.rejects(updateAComputer(lease, updateRequest, { ...asHere(root, extra), run: runHere(root, env) }), why);
      assert.deepEqual([read(file, `${l.state}/place.json`), read(file, `etc/systemd/system/${l.unit}`), readlinkSync(file(`${l.base}/current`))], [OLD_CONFIG, unitOf(l), l.release]);
      assert.ok(!existsSync(file(`${l.state}/product-settings.json`)));
      assert.equal(readdirSync(file(`${l.state}/backups`)).length, 1);
    }
  });
}

test('the layout is read from the unit, a request\'s layout row wins, and an unclear computer is refused rather than guessed', async () => {
  assert.deepEqual(parseUnit(unitOf(LAYOUTS['by hand'])), { config: '/srv/trillion/state/place.json', current: '/opt/trillion/current', state: '/srv/trillion/state', owner: ME });
  assert.deepEqual(parseUnit("[Service]\nExecStart=/opt/x/current/engine serve '/etc/x/place.json'\n"), { config: '/etc/x/place.json', current: '/opt/x/current', state: '/etc/x', owner: 'root' });
  const l = LAYOUTS['by hand'];
  const two = madeUpComputer(l, { units: [['other-place.service', unitOf(LAYOUTS['start-a-computer'])]] });
  await assert.rejects(readLayout({}, {}, runHere(two.root), two.root), /Found trillion-place\.service, other-place\.service|Found other-place\.service, trillion-place\.service/);
  const named = await readLayout({}, { layout: { unit: l.unit } }, runHere(two.root), two.root);
  assert.deepEqual([named.unit, named.state, named.releases, named.release_dir], [l.unit, l.state, '/opt/trillion/releases', l.release]);
  const row = await readLayout({}, { layout: { unit: l.unit, state: '/srv/elsewhere', releases: '/srv/releases' } }, runHere(two.root), two.root);
  assert.deepEqual([row.state, row.releases], ['/srv/elsewhere', '/srv/releases']);
  const none = madeUpComputer(l);
  rmSync(none.file(`etc/systemd/system/${l.unit}`));
  await assert.rejects(readLayout({}, {}, runHere(none.root), none.root), /Found no unit/);
  await assert.rejects(readLayout({}, { layout: { units: 'x' } }, runHere(none.root), none.root), /layout takes/);
});

test('a new account\'s copies are what its computers can meet', () => {
  assert.deepEqual(copiesFor({}), { least_copy_keepers: 1, least_voters: 1, least_may_answer: 1, least_always_on: 0 });
  assert.deepEqual(copiesFor({ default_places: { holders: ['this-place', 'e'.repeat(64)] } }), { least_copy_keepers: 2, least_voters: 2, least_may_answer: 2, least_always_on: 0 });
  assert.deepEqual(copiesFor({ default_places: { holders: ['a', 'b', 'c', 'd', 'e'] } }), THREE);
  assert.throws(() => copiesPolicy({ ...THREE, least_copy_keepers: 0 }), /at least 1/);
  assert.throws(() => copiesPolicy({ ...THREE, least_may_answer: 4 }), /no more than/);
  assert.throws(() => copiesPolicy({ ...THREE, least_voters: 1025 }), /0 to 1024/);
  assert.throws(() => copiesPolicy({ ...THREE, least_always_on: 3 }), /least_always_on/);
  assert.throws(() => copiesPolicy({ ...THREE, least_voters: Number.MAX_SAFE_INTEGER + 1 }), /whole number/);
});

test('product data is required, identity-checked, bounded and resolved relative to the request file', async () => {
  const here = folder(), file = join(here, 'request.json');
  const manifest = writeProductData(join(here, 'computer'), PRODUCT);
  writeFileSync(file, JSON.stringify({ product_data: 'computer/product-data.json' }));
  const request = readRequest(file);
  assert.equal(request.product_data, manifest);
  assert.equal(productSettingsOf(readProductData(request)).bytes.toString(), PRODUCT_BYTES.toString());
  assert.deepEqual(productSettingsOf(readProductData({ product_data: PRODUCT_DATA })).data, PRODUCT);
  assert.throws(() => readProductData({}), /product_data/);
  const badIdentity = JSON.parse(readFileSync(manifest, 'utf8'));
  badIdentity.product_settings.identity = '1f:' + '0'.repeat(64);
  writeFileSync(manifest, JSON.stringify(badIdentity));
  assert.throws(() => readProductData({ product_data: manifest }), /not the product data its manifest names/);
  for (const key of ['sign_in', 'sign_in_ways', 'sign_in_words', 'copies_rules']) {
    const bad = structuredClone(PRODUCT); delete bad.new_accounts[key];
    assert.throws(() => productSettingsOf(readProductData({ product_data: writeProductData(folder(), bad) })), new RegExp(key));
  }
  assert.throws(() => productSettingsOf(readProductData({ product_data: writeProductData(folder(), { ...PRODUCT, text: 'x'.repeat(131072) }) })), /byte limit/);
  let remoteCalls = 0;
  await assert.rejects(startAComputerRaw({}, { run: async () => { remoteCalls++; } }), /product_data/);
  await assert.rejects(updateAComputerRaw('/no/lease', {}, { run: async () => { remoteCalls++; } }), /product_data/);
  assert.equal(remoteCalls, 0);
});

test('the page look names the static folder beside the settings file, and every static file must match its identity', () => {
  const here = folder();
  const manifest = writeProductData(here, { ...PRODUCT, page_look: { palette: [], static_root: 'left-alone' } }, [{ name: 'mark.svg', text: '<svg/>' }, { name: 'workspace/fonts.css', text: '' }]);
  const product = productSettingsOf(readProductData({ product_data: manifest }), '/var/lib/sample/product-settings.json');
  assert.equal(product.data.page_look.static_root, '/var/lib/sample/static');
  assert.deepEqual(product.statics.map(({ name, bytes }) => [name, bytes.toString()]), [['mark.svg', '<svg/>'], ['workspace/fonts.css', '']]);
  const tampered = JSON.parse(readFileSync(manifest, 'utf8'));
  tampered.static[0].identity = '1f:' + 'f'.repeat(64);
  writeFileSync(manifest, JSON.stringify(tampered));
  assert.throws(() => readProductData({ product_data: manifest }), /source-mark\.svg is not the product data/);
});

test('starting rows fill missing sign-in words and copy rules while retaining configured rows', async () => {
  const custom = { sign_in_words: { heading: 'Custom words' }, copies_rules: { rule: 'custom-rule' }, extra: { own: true } };
  const config = { new_accounts: custom, default_places: { holders: ['first', 'second'], answering: ['first'] } };
  const before = structuredClone(config), productBefore = structuredClone(PRODUCT);
  const rows = startingRows(config, { product_data: PRODUCT_DATA });
  assert.deepEqual(rows, { ...PRODUCT.new_accounts, ...custom, copies: { least_copy_keepers: 2, least_voters: 2, least_may_answer: 2, least_always_on: 0 } });
  assert.deepEqual(startingRows({}, { product_data: PRODUCT_DATA }).sign_in_words, PRODUCT.new_accounts.sign_in_words);
  rows.sign_in.token_seconds = 1; rows.extra.own = false;
  assert.deepEqual(PRODUCT, productBefore);
  assert.deepEqual(config, before);
  const withoutFeed = await computerConfigRaw({}, { product_data: PRODUCT_DATA, port: 7199, name: { host_name: 'sample.example.test' } }, null);
  assert.ok(!Object.hasOwn(withoutFeed, 'release_feed'), 'no compiled product feed is selected');
});

test('a start uses one exact file snapshot for remote settings and starting rows even if the caller file changes', async () => {
  const here = folder(), file = join(here, 'settings.json');
  const data = writeProductData(here, PRODUCT);
  let settingsWritten, configWritten;
  const request = {
    product_data: data, release_feed: null,
    lease_file: join(here, 'lease.json'), machine: { provider: 'existing-machine', name: 'sample', placement: { address: '192.0.2.44' }, lifetime: 'service' },
    name: { host_name: 'sample.example.test' }, ssh: { known_hosts: '/dev/null' }, port: 7199,
    engine: { file: 'engine', data_env: 'ENGINE_DATA', data_dir: 'data', release_name: 'r1', release: { on_machine: '/opt/build/release' } },
  };
  await startAComputerRaw(request, { wait: async () => {}, fetchImpl: async () => ({ status: 200 }), run: async (_machine, command, input) => {
    if (command === 'uname -m') { writeFileSync(join(here, 'product-settings.json'), '{}'); return 'aarch64'; }
    if (command.startsWith('install -o place') && command.includes("'product-settings.json'")) settingsWritten = Buffer.from(input);
    if (command === `install -o place -g place -m 0600 /dev/stdin '${productSettings.file}'`) settingsWritten = Buffer.from(input);
    if (command === 'install -o place -g place -m 0600 /dev/stdin /var/lib/place/place.json') configWritten = JSON.parse(input);
    return '';
  } });
  assert.equal(settingsWritten.toString(), PRODUCT_BYTES.toString());
  assert.deepEqual(configWritten.new_accounts, { ...PRODUCT.new_accounts, copies: copiesFor({}) });
});

test('an update fills a config with no account rows and rollback restores its previous settings bytes', async () => {
  const l = LAYOUTS['start-a-computer'], { root, lease, file } = madeUpComputer(l);
  const original = `${JSON.stringify({ listen: '127.0.0.1:7199', public_origin: 'https://sample.example.test' })}\n`;
  const oldSettings = '{"old_profile":true}\n';
  const exact = PRODUCT_BYTES.toString(), data = writeProductData(join(root, 'caller'), PRODUCT);
  writeFileSync(file(`${l.state}/place.json`), original);
  writeFileSync(file(`${l.state}/product-settings.json`), oldSettings);
  const actualRun = runHere(root);
  let changed = false;
  const run = async (...args) => {
    if (!changed) { changed = true; writeFileSync(join(root, 'caller', 'product-settings.json'), '{}'); }
    return actualRun(...args);
  };
  const answer = await updateAComputerRaw(lease, { ...updateRequest, product_data: data }, { ...asHere(root), run });
  assert.equal(read(file, `${l.state}/product-settings.json`), exact);
  const config = JSON.parse(read(file, `${l.state}/place.json`));
  assert.deepEqual(config.new_accounts, { ...PRODUCT.new_accounts, copies: copiesFor({}) });
  await rollBackAComputer(lease, updateRequest, answer.backup, { ...asHere(root), run: actualRun });
  assert.equal(read(file, `${l.state}/place.json`), original);
  assert.equal(read(file, `${l.state}/product-settings.json`), oldSettings);
});
