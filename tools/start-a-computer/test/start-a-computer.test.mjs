import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHashCodeHexFromBytes } from 'trillion-workshop/tools/content-identity/read-data/identity.mjs';
import {
  readProvider, providerClient, registerMachine, rentMachine, releaseMachine, readMachine, readPrice, pointName,
  forgetName, fingerprintOf, fileStore,
} from '../do-work/rent-a-machine.mjs';
import {
  rentAMachine, startAComputer as startAComputerRaw, computerConfig as computerConfigRaw, readRequest, productSettingsOf, readProductData, startingRows,
  copiesFor as copiesForRaw, copiesPolicy,
} from '../do-work/start-a-computer.mjs';

// Synthetic caller profile only; production identity and starting rows live in the caller's package.
const SEED_COPIES = { least_copy_keepers: 3, least_voters: 3, least_may_answer: 2, least_always_on: 0 };
const PRODUCT = { word: 'sample', app_host: 'app.example.com', new_accounts: {
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
const SETTINGS_FILE = '/var/lib/place/product-settings.json';
const PRODUCT_BYTES = productSettingsOf(readProductData({ product_data: PRODUCT_DATA }), SETTINGS_FILE).bytes;
const withProfile = request => ({ product_data: PRODUCT_DATA, product_settings_file: SETTINGS_FILE, ...request, place_config: { accounts: '/var/lib/place/accounts', computer_key_file: '/var/lib/place/place.key', ...request.place_config }, ...(request.engine && { engine: { releases: '/opt/place/releases', ...request.engine } }) });
const startAComputer = (request, ...deps) => startAComputerRaw(withProfile(request), ...deps);
const computerConfig = (machine, request, ...deps) => computerConfigRaw(machine, withProfile(request), ...deps);
const copiesFor = config => copiesForRaw(config, SEED_COPIES);

const canary = 'provider-credential-canary-0123456789';
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample0 someone@example.com';
const folder = () => mkdtempSync(join(tmpdir(), 'start-a-computer-'));

// Made-up provider descriptions (example.test answers nothing); the tool holds none, the person supplies one as a file.
const providerFile = name => fileURLToPath(new URL(`../made-up-providers/${name}.json`, import.meta.url));
const RENTED = providerFile('rented-machine'), ADOPTED = providerFile('adopted-machine'), RECORDS = providerFile('name-records');
const rented = readProvider(RENTED), adopted = readProvider(ADOPTED), records = readProvider(RECORDS);

// A provider that answers from a table of `METHOD path` -> body (or a function of the request body).
function provider(base, table, calls = []) {
  return async (address, request) => {
    assert.ok(address.startsWith(base));
    assert.equal(request.headers.authorization, `Bearer ${canary}`);
    const key = `${request.method} ${address.slice(base.length)}`, body = request.body && JSON.parse(request.body);
    calls.push([key, body]);
    const answer = table[key];
    if (answer === undefined) return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    const value = typeof answer === 'function' ? answer(body) : answer;
    return new Response(JSON.stringify(value), { status: value.status ?? 200 });
  };
}

// The computer row a start is given (request.computer_row): what it runs is the place unit, its Caddy name and nothing kept
// beside it.
const COMPUTER_ROW = { address: '192.0.2.41', name: 'example-computer', runs: {
  caddy: { site_hosts: ['computer.example.com'], port: 7199, releases: '/opt/place/releases' },
  units: [{
    unit: 'place.service', template: 'serve-computer', description: 'A computer that keeps accounts', user: 'place',
    releases: '/opt/place/releases', engine_file: 'engine', data_env: 'ENGINE_DATA', data_dir: 'data',
    config: '/var/lib/place/place.json', launch_setting: 'PRODUCT_SETTINGS', product_settings: '/var/lib/place/product-settings.json',
    writable: ['/var/lib/place', '/opt/place/releases'], drop_ins: ['nofile'],
  }],
  unmanaged: [],
} };

test('an install on a running place is judged by its health row, read from its own config, and a status by the public row', async () => {
  const { installOnAComputer, computerStatus } = await import('../do-work/start-a-computer.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'install-on-place-'));
  const leaseFile = join(dir, 'lease.json');
  writeFileSync(leaseFile, JSON.stringify({ schema: 'machine-lease/1', provider: 'adopted-machine', providerFile: ADOPTED, name: 'arm1', address: '192.0.2.9', adopted: true, hostName: 'place.example.com' }));
  const asked = [];
  const run = async (machine, command) => {
    if (command === 'cat /var/lib/place/place.json') return JSON.stringify({ listen: '127.0.0.1:7199' });
    return '';
  };
  const fetchImpl = async address => { asked.push(address); return { status: address === 'https://place.example.com/readyz' ? 200 : 404 }; };
  const engine = { file: 'trillion-local', releases: '/opt/place/releases', release_name: 'r2', release: { on_machine: '/opt/build/release' } };
  const answer = await installOnAComputer(leaseFile, { ssh: {}, engine, name: { host_name: 'place.example.com' }, computer_row: COMPUTER_ROW, product_settings_file: SETTINGS_FILE }, { fetchImpl, wait: async () => {}, tries: 1, run });
  assert.equal(answer.sign_up_status, 200);
  assert.deepEqual(asked, ['https://place.example.com/readyz']);
  asked.length = 0;
  const status = await computerStatus(leaseFile, { fetchImpl });
  assert.equal(status.sign_up_status, 200, 'a status asks the same public row');
  assert.deepEqual(asked, ['https://place.example.com/readyz']);
  rmSync(dir, { recursive: true, force: true });
});

test('a unit is an alert when it is not active or has restarted past the budget, read over SSH from its engine unit', async () => {
  const { unitVerdict, unitStatus } = await import('../do-work/start-a-computer.mjs');
  assert.equal(unitVerdict({ Id: 'place.service', ActiveState: 'active', SubState: 'running', NRestarts: '0' }, 5).alert, false);
  assert.equal(unitVerdict({ Id: 'place.service', ActiveState: 'active', SubState: 'running', NRestarts: '5' }, 5).alert, false, 'the budget is the most a unit may spend');
  assert.equal(unitVerdict({ Id: 'place.service', ActiveState: 'activating', SubState: 'auto-restart', NRestarts: '1' }, 5).alert, true, 'a unit not active is an alert');
  assert.equal(unitVerdict({ Id: 'place.service', ActiveState: 'active', SubState: 'running', NRestarts: '8849' }, 5).alert, true, 'past the budget');
  assert.throws(() => unitVerdict({ Id: 'place.service', ActiveState: 'active', NRestarts: 'many' }, 5), /restart count/);
  const dir = mkdtempSync(join(tmpdir(), 'unit-status-'));
  const leaseFile = join(dir, 'lease.json');
  writeFileSync(leaseFile, JSON.stringify({ schema: 'machine-lease/1', provider: 'adopted-machine', providerFile: ADOPTED, name: 'arm1', address: '192.0.2.9', adopted: true, hostName: 'place.example.com' }));
  const commands = [];
  const run = async (machine, command) => {
    commands.push(command);
    return 'Id=place.service\nActiveState=activating\nSubState=auto-restart\nNRestarts=8849\n';
  };
  const answer = await unitStatus(leaseFile, { ssh: {}, engine_unit: { unit: 'place.service' } }, { run });
  assert.deepEqual([answer.unit, answer.active, answer.nrestarts, answer.alert], ['place.service', 'activating', 8849, true]);
  assert.match(commands[0], /^systemctl show 'place\.service' -p Id -p ActiveState -p SubState -p NRestarts$/);
  await assert.rejects(unitStatus(leaseFile, { ssh: {}, engine_unit: { unit: 'place.service; reboot' } }, { run }), /engine_unit\.unit/);
  rmSync(dir, { recursive: true, force: true });
});

test('the descriptions name every provider call and their credentials by vault handle only', () => {
  for (const row of [rented, records, adopted].filter(r => r.base)) {
    assert.match(row.vault_key, /^[a-z0-9-]+$/);
    for (const asked of Object.values(row.requests)) assert.ok(asked.url.startsWith(row.base), asked.url);
  }
  assert.equal(adopted.base, null);
});

test('the client sends only the calls its description declares', async () => {
  const request = providerClient(rented, canary, { fetchImpl: provider(rented.base, { 'GET /servers?name=a-computer': { servers: [] } }) });
  assert.deepEqual(await request('GET', '/servers?name=a-computer'), { servers: [] });
  await assert.rejects(request('DELETE', '/volumes/7'), /operation was refused/);
  await assert.rejects(request('DELETE', '/servers/abc'), /operation was refused/);
  assert.throws(() => providerClient(rented, ''), /credential was refused/);
});

test('renting stores the key, makes the machine with this lease\'s label, and releases only what it owns', async () => {
  const file = join(folder(), 'lease.json'), calls = [];
  const fetchImpl = provider(rented.base, {
    'GET /servers?name=a-computer': { servers: [] },
    [`GET /ssh_keys?fingerprint=${encodeURIComponent(fingerprintOf(publicKey, rented.fingerprint))}`]: { ssh_keys: [] },
    'POST /ssh_keys': body => ({ ssh_key: { id: 11, labels: body.labels } }),
    'POST /servers': body => ({ server: { id: 22, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.10' } } } }),
    'GET /servers/22': { server: { id: 22, status: 'running', labels: { 'example-lease': 'a-computer' }, public_net: { ipv4: { ip: '192.0.2.10' } } } },
    'DELETE /servers/22': {},
    'GET /ssh_keys/11': { ssh_key: { id: 11, labels: { 'example-lease': 'a-computer' } } },
    'DELETE /ssh_keys/11': {},
  }, calls);
  const request = providerClient(rented, canary, { fetchImpl });
  const lease = await rentMachine({ request, store: fileStore(file), provider: rented, name: 'a-computer', publicKey, placement: { size: 'cax11' } });
  assert.deepEqual([lease.state, lease.serverId, lease.sshKeyId, lease.address, lease.serverType, lease.location], ['running', 22, 11, '192.0.2.10', 'cax11', 'hel1']);
  const made = calls.find(([key]) => key === 'POST /servers')[1];
  assert.deepEqual([made.server_type, made.ssh_keys, made.labels], ['cax11', [11], { 'example-lease': 'a-computer' }]);
  assert.deepEqual(await readMachine({ request, store: fileStore(file), provider: rented }), { state: 'running', address: '192.0.2.10' });
  assert.equal((await releaseMachine({ request, store: fileStore(file), provider: rented })).state, 'removed');
  assert.ok(calls.some(([key]) => key === 'DELETE /servers/22') && calls.some(([key]) => key === 'DELETE /ssh_keys/11'));
  assert.ok(!readFileSync(file, 'utf8').includes(canary));
});

test('a public key the provider already holds is used as it is and never removed', async () => {
  const file = join(folder(), 'lease.json'), calls = [];
  const fetchImpl = provider(rented.base, {
    'GET /servers?name=a-computer': { servers: [] },
    [`GET /ssh_keys?fingerprint=${encodeURIComponent(fingerprintOf(publicKey, rented.fingerprint))}`]: { ssh_keys: [{ id: 5, labels: {} }] },
    'POST /servers': body => ({ server: { id: 23, labels: body.labels, public_net: { ipv4: { ip: '192.0.2.11' } } } }),
    'GET /servers/23': { server: { id: 23, labels: { 'example-lease': 'a-computer' } } },
    'DELETE /servers/23': {},
  }, calls);
  const request = providerClient(rented, canary, { fetchImpl });
  const lease = await rentMachine({ request, store: fileStore(file), provider: rented, name: 'a-computer', publicKey });
  assert.deepEqual([lease.sshKeyId, lease.sharedSshKeyId], [null, 5]);
  assert.deepEqual(calls.find(([key]) => key === 'POST /servers')[1].ssh_keys, [5]);
  await releaseMachine({ request, store: fileStore(file), provider: rented });
  assert.ok(!calls.some(([key]) => key.startsWith('POST /ssh_keys') || key.startsWith('DELETE /ssh_keys')));
});

test('a machine someone else labelled is left untouched', async () => {
  const file = join(folder(), 'lease.json');
  writeFileSync(file, JSON.stringify({ schema: 'machine-lease/1', provider: 'rented-machine', name: 'a-computer', state: 'running', serverId: 30, sshKeyId: null }));
  const request = providerClient(rented, canary, { fetchImpl: provider(rented.base, { 'GET /servers/30': { server: { id: 30, labels: { 'example-lease': 'another' } } } }) });
  await assert.rejects(releaseMachine({ request, store: fileStore(file), provider: rented }), /no longer owned by this lease/);
});

test('a machine already run is adopted at its address and only forgotten on release', async () => {
  const file = join(folder(), 'lease.json');
  const lease = await rentMachine({ request: null, store: fileStore(file), provider: adopted, name: 'a-pi', placement: { address: '192.0.2.40' } });
  assert.deepEqual([lease.state, lease.adopted, lease.address], ['running', true, '192.0.2.40']);
  assert.equal(await readPrice({ request: null, provider: adopted, placement: {} }), null);
  assert.deepEqual(await readPrice({ request: null, provider: adopted, placement: { monthly_price_cents: 300 } }), { cents: 300, currency: null });
  assert.equal((await releaseMachine({ request: null, store: fileStore(file), provider: adopted })).state, 'removed');
  await assert.rejects(rentMachine({ request: null, store: fileStore(join(folder(), 'l.json')), provider: adopted, name: 'a-pi', placement: { address: 'not-an-address' } }), /configuration was refused/);
});

test('the price is the size\'s monthly price at the lease\'s location, in cents', async () => {
  const request = providerClient(rented, canary, { fetchImpl: provider(rented.base, { 'GET /server_types?name=cax11': { server_types: [{ prices: [
    { location: 'fsn1', price_monthly: { gross: '7.9900' } }, { location: 'hel1', price_monthly: { gross: '6.9900' } },
  ] }] } }) });
  assert.deepEqual(await readPrice({ request, provider: rented, placement: { size: 'cax11' } }), { cents: 699, currency: 'EUR' });
  await assert.rejects(readPrice({ request, provider: rented, placement: { size: 'cax11', location: 'ash' } }), /no monthly price/);
});

test('the public name points at the machine with this lease\'s mark, and only that record is removed', async () => {
  const file = join(folder(), 'lease.json'), zone = 'a'.repeat(32), record = 'b'.repeat(32), calls = [];
  writeFileSync(file, JSON.stringify({ schema: 'machine-lease/1', provider: 'rented-machine', name: 'a-computer', state: 'running', address: '192.0.2.10' }));
  const fetchImpl = provider(records.base, {
    'GET /zones?name=example.com': { result: [{ id: zone, name: 'example.com' }] },
    [`GET /zones/${zone}/dns_records?type=A&name=computer.example.com`]: { result: [] },
    [`POST /zones/${zone}/dns_records`]: body => ({ result: { id: record, ...body } }),
    [`GET /zones/${zone}/dns_records/${record}`]: { result: { id: record, comment: 'example-lease a-computer' } },
    [`DELETE /zones/${zone}/dns_records/${record}`]: { result: { id: record } },
  }, calls);
  const request = providerClient(records, canary, { fetchImpl });
  const lease = await pointName({ request, store: fileStore(file), provider: records, zone: 'example.com', hostName: 'computer.example.com' });
  assert.deepEqual([lease.recordId, lease.hostName], [record, 'computer.example.com']);
  assert.deepEqual(calls.find(([key]) => key.startsWith('POST'))[1], { type: 'A', name: 'computer.example.com', content: '192.0.2.10', ttl: 60, proxied: false, comment: 'example-lease a-computer' });
  assert.equal((await forgetName({ request, store: fileStore(file), provider: records })).recordId, null);
  assert.ok(calls.some(([key]) => key.startsWith('DELETE')));
});

test('the computer config takes the machine\'s own fields and values read from the release', async () => {
  const run = async (_machine, command) => {
    assert.equal(command, "cat '/opt/place/releases/current/data/new-accounts.json'");
    return JSON.stringify({ sign_in_ways: [{ way: 'passkey' }] });
  };
  const config = await computerConfig({}, {
    port: 7199, name: { host_name: 'computer.example.com' }, place_config: { report: { takes_new_accounts: true } }, engine: {},
    config_from_release: [{ at: ['new_accounts', 'sign_in_ways'], file: 'data/new-accounts.json', key: 'sign_in_ways' }],
  }, { cents: 699, currency: 'EUR' }, run);
  assert.deepEqual(config, {
    report: { takes_new_accounts: true, reach: 'https://computer.example.com', cost_per_month_cents: 699 }, router: 'app.example.com:443',
    listen: '127.0.0.1:7199', accounts: '/var/lib/place/accounts', computer_key_file: '/var/lib/place/place.key', public_origin: 'https://computer.example.com',
    new_accounts: { ...PRODUCT.new_accounts, sign_in_ways: [{ way: 'passkey' }], copies: { least_copy_keepers: 1, least_voters: 1, least_may_answer: 1, least_always_on: 0 } },
  });
  const behind = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' }, public_origin: 'https://front.example.com' }, null, run);
  assert.deepEqual([behind.public_origin, behind.report.reach], ['https://front.example.com', 'https://computer.example.com']);
});

test('a computer\'s router is the product settings app_host, and a request that names a router is refused', async () => {
  const run = async () => JSON.stringify({});
  const derived = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' } }, null, run);
  assert.equal(derived.router, `${PRODUCT.app_host}:443`);
  await assert.rejects(computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' }, place_config: { router: 'place.example.com:443' } }, null, run),
    /must not name a router/);
  await assert.rejects(computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' }, place_config: { router: '' } }, null, run),
    /must not name a router/);
});

test('a request\'s paths are read relative to its own file', () => {
  const here = folder(), file = join(here, 'request.json');
  writeFileSync(file, JSON.stringify({ lease_file: 'lease.json', machine: { provider: ADOPTED }, ssh: { known_hosts: 'known_hosts' }, engine: { release: { tarball: 'r.tar.gz' } } }));
  const request = readRequest(file);
  assert.deepEqual([request.lease_file, request.ssh.known_hosts, request.engine.release.tarball], [join(here, 'lease.json'), join(here, 'known_hosts'), join(here, 'r.tar.gz')]);
});

test('starting a computer on an adopted machine sets it up, installs the release, serves and reads it back', async () => {
  const here = folder(), commands = [];
  const run = async (_machine, command, input) => {
    commands.push(command);
    if (command === 'uname -m') return 'aarch64\n';
    if (command.includes('curl')) return '200';
    if (command.startsWith('getent passwd')) throw Object.assign(new Error('no such account'), { code: 3 });
    if (command.startsWith('cat ')) return JSON.stringify({ sign_in_ways: [] });
    if (command.startsWith('install -o place') && command.endsWith('/var/lib/place/place.json')) assert.equal(JSON.parse(input).public_origin, 'https://computer.example.com');
    if (command.includes("'computer' 'id' '/var/lib/place/place.json'")) return 'f'.repeat(64);
    return '';
  };
  const answer = await startAComputer({
    lease_file: join(here, 'lease.json'), machine: { provider: ADOPTED, name: 'a-pi', placement: { address: '192.0.2.40' } },
    name: { host_name: 'computer.example.com' }, ssh: { known_hosts: join(here, 'known_hosts') }, port: 7199, computer_row: COMPUTER_ROW,
    engine: { file: 'engine', data_env: 'ENGINE_DATA', data_dir: 'data', id_argv: ['computer', 'id'], release_name: 'r1', release: { on_machine: '/opt/build/release' } },
    config_from_release: [{ at: ['new_accounts', 'sign_in_ways'], file: 'data/new-accounts.json', key: 'sign_in_ways' }],
  }, { run, fetchImpl: async address => ({ status: address === 'https://computer.example.com/readyz' ? 200 : 404 }), wait: async () => {} });
  assert.deepEqual([answer.arch, answer.place_id, answer.sign_up_status, answer.release, answer.price], ['aarch64', 'f'.repeat(64), 200, '/opt/place/releases/r1', null]);
  assert.match(commands.find(c => c.startsWith('sh -s')), /^sh -s -- '\{"caddy"/);
  assert.ok(commands.some(c => c.includes('/etc/caddy/Caddyfile')), 'the Caddy file is written from the computer row');
  assert.ok(commands.find(c => c.includes("'computer' 'id'")).includes("env PRODUCT_SETTINGS='/var/lib/place/product-settings.json' ENGINE_DATA="), 'the id command reads the product settings too');
  assert.ok(commands.some(c => c.includes('systemctl restart place.service')));
});

test('renting a machine leases it and waits for SSH, and sets nothing up on it', async () => {
  const here = folder(), commands = [];
  const run = async (_machine, command) => { commands.push(command); return command === 'uname -m' ? 'x86_64\n' : ''; };
  const answer = await rentAMachine({
    lease_file: join(here, 'lease.json'), machine: { provider: ADOPTED, name: 'a-builder', placement: { address: '192.0.2.41' } },
    name: { host_name: 'releases.example.com' }, ssh: { known_hosts: join(here, 'known_hosts') },
  }, { run, wait: async () => {} });
  assert.deepEqual([answer.arch, answer.host_name, answer.lease.address, answer.price], ['x86_64', 'releases.example.com', '192.0.2.41', null]);
  assert.deepEqual(commands, ['uname -m']);
  assert.equal(JSON.parse(readFileSync(join(here, 'lease.json'), 'utf8')).address, '192.0.2.41', 'the lease is kept, so remove gives it back');
});

test('the place config names its unit from the computer row, and a request with no computer row names none', async () => {
  const runs = { units: [{ unit: 'place.service', user: 'place', product_settings: '/var/lib/place/product-settings.json' }, { unit: 'other.service', user: 'other', product_settings: '/var/lib/other/product-settings.json' }] };
  const config = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' }, computer_row: { runs } }, null, async () => '');
  assert.equal(config.unit, 'place.service');
  const bare = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' } }, null, async () => '');
  assert.equal('unit' in bare, false);
});

test('the computer config carries the request\'s default computers', async () => {
  const id = 'e'.repeat(64);
  const default_places = { holders: ['this-place', id], answering: ['this-place'] };
  const config = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' }, default_places }, null, async () => '');
  assert.deepEqual(config.default_places, default_places);
  const fixture = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' }, place_config: { new_accounts: { copies: { least_copy_keepers: 3, least_voters: 3, least_may_answer: 2, least_always_on: 0 } } }, default_places: { holders: ['this-place'], answering: ['this-place'] } }, null, async () => '');
  assert.deepEqual(fixture.new_accounts.copies, { least_copy_keepers: 1, least_voters: 1, least_may_answer: 1, least_always_on: 0 }, 'a computer alone is never given copies it cannot meet');
  const product = await computerConfig({}, { port: 7199, name: { host_name: 'computer.example.com' } }, null, async () => '');
  assert.ok(!('release_feed' in product), 'no engine config follows a feed');
  assert.ok(!('default_places' in product));
  await assert.rejects(computerConfig({}, { port: 7199, name: { host_name: 'p.example.com' }, default_places: { answering: [id] } }, null), /holders must name/);
});

test('the set-up script makes each unit\'s folders for the user the computer row names, and names no path of its own', async () => {
  const script = readFileSync(new URL('../do-work/set-up-the-machine.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /\/opt\/place|place\.service|\/var\/lib\/place/, 'the set-up script names no path the computer row does not give');
  assert.match(script, /printf '%s' "\$RUNS" \| jq -r '\.units\[\]/);
  assert.match(script, /install -d -o "\$user" -g "\$user" -m 0755 "\$releases"/);
});

test('a start writes the default computers into the computer config it installs', async () => {
  const here = folder(), written = [], setups = [];
  const run = async (_machine, command, input) => {
    if (command === 'uname -m') return 'x86_64\n';
    if (command.startsWith('sh -s')) { setups.push(command); return ''; }
    if (command.includes('curl')) return '200';
    if (command.startsWith('getent passwd')) throw Object.assign(new Error('no such account'), { code: 3 });
    if (command === 'install -o place -g place -m 0600 /dev/stdin /var/lib/place/place.json') written.push(JSON.parse(input));
    if (command === `install -o place -g place -m 0600 /dev/stdin '${SETTINGS_FILE}'`) written.push(Buffer.from(input));
    return '';
  };
  const default_places = { holders: ['this-place'], answering: ['this-place'] };
  const request = {
    computer_row: COMPUTER_ROW,
    lease_file: join(here, 'lease.json'), machine: { provider: ADOPTED, name: 'a-pi', placement: { address: '192.0.2.41' } },
    name: { host_name: 'computer.example.com' }, ssh: { known_hosts: join(here, 'known_hosts') }, port: 7199,
    engine: { file: 'engine', data_env: 'ENGINE_DATA', data_dir: 'data', release_name: 'r1', release: { on_machine: '/opt/build/release' } },
    default_places,
  };
  await startAComputer(request, { run, fetchImpl: async () => ({ status: 200 }), wait: async () => {} });
  assert.deepEqual(written[0], PRODUCT_BYTES, 'the product settings file is written byte for byte, before the config');
  assert.deepEqual(written[1].default_places, default_places);
  assert.match(setups[0], /^sh -s -- '\{"caddy"/, 'set-up is given what the computer row runs');
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

test('a new account\'s copies are what its computers can meet', () => {
  assert.deepEqual(copiesFor({}), { least_copy_keepers: 1, least_voters: 1, least_may_answer: 1, least_always_on: 0 });
  assert.deepEqual(copiesFor({ default_places: { holders: ['this-place', 'e'.repeat(64)] } }), { least_copy_keepers: 2, least_voters: 2, least_may_answer: 2, least_always_on: 0 });
  assert.deepEqual(copiesFor({ default_places: { holders: ['a', 'b', 'c', 'd', 'e'] } }), SEED_COPIES);
  assert.throws(() => copiesPolicy({ ...SEED_COPIES, least_copy_keepers: 0 }), /at least 1/);
  assert.throws(() => copiesPolicy({ ...SEED_COPIES, least_may_answer: 4 }), /no more than/);
  assert.throws(() => copiesPolicy({ ...SEED_COPIES, least_voters: 1025 }), /0 to 1024/);
  assert.throws(() => copiesPolicy({ ...SEED_COPIES, least_always_on: 3 }), /least_always_on/);
  assert.throws(() => copiesPolicy({ ...SEED_COPIES, least_voters: Number.MAX_SAFE_INTEGER + 1 }), /whole number/);
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

test('a static file may be a file of the Workshop, read from it and held to its identity', () => {
  const manifest = writeProductData(folder(), PRODUCT, [{ name: 'mark.svg', text: '<svg/>' }]);
  const file = 'tools/draw-trillions-app-icon-in-every-size-from/assets/favicon.svg';
  const bytes = readFileSync(new URL(`../../../${file}`, import.meta.url));
  const data = JSON.parse(readFileSync(manifest, 'utf8'));
  data.static = [{ name: 'favicon.svg', workshop: file, identity: makeHashCodeHexFromBytes(bytes) }];
  writeFileSync(manifest, JSON.stringify(data));
  assert.deepEqual(readProductData({ product_data: manifest }).statics.map(({ name, bytes: kept }) => [name, kept.equals(bytes)]), [['favicon.svg', true]]);
  data.static[0].identity = '1f:' + 'f'.repeat(64);
  writeFileSync(manifest, JSON.stringify(data));
  assert.throws(() => readProductData({ product_data: manifest }), /favicon\.svg is not the product data/);
  for (const bad of ['../README.md', 'tools/../README.md', '/etc/hosts', 'README.md']) {
    data.static = [{ name: 'x', workshop: bad, identity: data.static[0].identity }];
    writeFileSync(manifest, JSON.stringify(data));
    assert.throws(() => readProductData({ product_data: manifest }), /inside tools/);
  }
  data.static = [{ name: 'x', workshop: file, file: 'x', identity: data.static[0].identity }];
  writeFileSync(manifest, JSON.stringify(data));
  assert.throws(() => readProductData({ product_data: manifest }), /name a file or a Workshop file/);
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
  const withoutFeed = await computerConfigRaw({}, { product_data: PRODUCT_DATA, place_config: { accounts: '/var/lib/place/accounts', computer_key_file: '/var/lib/place/place.key' }, port: 7199, name: { host_name: 'sample.example.test' } }, null);
  assert.ok(!Object.hasOwn(withoutFeed, 'release_feed'), 'no compiled product feed is selected');
});

test('a start uses one exact file snapshot for remote settings and starting rows even if the caller file changes', async () => {
  const here = folder(), file = join(here, 'settings.json');
  const data = writeProductData(here, PRODUCT);
  let settingsWritten, configWritten;
  const request = {
    product_data: data, product_settings_file: SETTINGS_FILE,
    place_config: { accounts: '/var/lib/place/accounts', computer_key_file: '/var/lib/place/place.key' },
    computer_row: COMPUTER_ROW,
    lease_file: join(here, 'lease.json'), machine: { provider: ADOPTED, name: 'sample', placement: { address: '192.0.2.44' } },
    name: { host_name: 'sample.example.test' }, ssh: { known_hosts: '/dev/null' }, port: 7199,
    engine: { file: 'engine', releases: '/opt/place/releases', data_env: 'ENGINE_DATA', data_dir: 'data', release_name: 'r1', release: { on_machine: '/opt/build/release' } },
  };
  await startAComputerRaw(request, { wait: async () => {}, fetchImpl: async () => ({ status: 200 }), run: async (_machine, command, input) => {
    if (command === 'uname -m') { writeFileSync(join(here, 'product-settings.json'), '{}'); return 'aarch64'; }
    if (command.includes('curl')) return '200';
    if (command.startsWith('install -o place') && command.includes("'product-settings.json'")) settingsWritten = Buffer.from(input);
    if (command === `install -o place -g place -m 0600 /dev/stdin '${SETTINGS_FILE}'`) settingsWritten = Buffer.from(input);
    if (command === 'install -o place -g place -m 0600 /dev/stdin /var/lib/place/place.json') configWritten = JSON.parse(input);
    return '';
  } });
  assert.equal(settingsWritten.toString(), PRODUCT_BYTES.toString());
  assert.deepEqual(configWritten.new_accounts, { ...PRODUCT.new_accounts, copies: copiesFor({}) });
});

test('a second provider the tool has never seen rents, prices and gives back a machine with no code change', async () => {
  const file = join(folder(), 'lease.json'), described = join(folder(), 'another-cloud.json'), calls = [];
  writeFileSync(described, JSON.stringify({
    id: 'another-cloud', name: 'Another Cloud', base: 'https://compute.another.test/api', auth: { header: 'x-api-key', prefix: '' },
    vault_key: 'another-cloud-key', error_code_at: 'problem.kind', lease_label_key: 'cloud-owner',
    placement: { size: 's1', location: 'north', image: 'debian' }, fill: { plan: '{size}', tags: { '{lease_label_key}': '{name}' } },
    requests: {
      list: { url: 'https://compute.another.test/api/vms?label={name}', method: 'GET' },
      make: { url: 'https://compute.another.test/api/vms', method: 'POST', body_template: { label: '{name}', plan: '{plan}', zone: '{location}', os: '{image}', key: '{ssh_key_id}', tags: '{tags}' } },
      one: { url: 'https://compute.another.test/api/vms/{vm_id}', method: 'GET' },
      drop: { url: 'https://compute.another.test/api/vms/{vm_id}', method: 'DELETE' },
      keys: { url: 'https://compute.another.test/api/keys', method: 'POST', body_template: { title: '{key_name}', material: '{public_key}', tags: '{tags}' } },
      key_one: { url: 'https://compute.another.test/api/keys/{ssh_key_id}', method: 'GET' },
      key_drop: { url: 'https://compute.another.test/api/keys/{ssh_key_id}', method: 'DELETE' },
      cost: { url: 'https://compute.another.test/api/plans/{size}', method: 'GET' },
    },
    host: { find: 'list', list_at: 'items', create: 'make', created_at: 'vm', read: 'one', found_at: 'vm', remove: 'drop', id_is: 'vm_id', id_pattern: '^vm-[a-z0-9]+$', owner_at: 'tags.{lease_label_key}', address_at: 'net.v4', state_at: 'phase' },
    access_key: { create: 'keys', read: 'key_one', found_at: 'key', remove: 'key_drop', id_is: 'ssh_key_id', id_pattern: '^key-[a-z0-9]+$', id_at: 'key.id', owner_at: 'tags.{lease_label_key}' },
    price: { read: 'cost', list_at: 'plan.rates', location_at: 'zone', monthly_at: 'per_month', currency: 'USD' },
  }));
  const row = readProvider(described), headers = [];
  const answer = provider(row.base, {
    'GET /vms?label=a-computer': { items: [] },
    'POST /keys': body => ({ key: { id: 'key-1a', tags: body.tags } }),
    'POST /vms': body => ({ vm: { id: 'vm-9z', tags: body.tags, net: { v4: '192.0.2.77' } } }),
    'GET /vms/vm-9z': { vm: { id: 'vm-9z', phase: 'up', tags: { 'cloud-owner': 'a-computer' }, net: { v4: '192.0.2.77' } } },
    'DELETE /vms/vm-9z': {}, 'GET /keys/key-1a': { key: { id: 'key-1a', tags: { 'cloud-owner': 'a-computer' } } }, 'DELETE /keys/key-1a': {},
    'GET /plans/s1': { plan: { rates: [{ zone: 'north', per_month: '12.5' }] } },
  }, calls);
  const fetchImpl = async (address, init) => { headers.push(init.headers['x-api-key']); return answer(address, { ...init, headers: { authorization: `Bearer ${canary}` } }); };
  const request = providerClient(row, canary, { fetchImpl });
  const lease = await rentMachine({ request, store: fileStore(file), provider: row, name: 'a-computer', publicKey });
  assert.deepEqual([lease.provider, lease.providerFile, lease.state, lease.serverId, lease.sshKeyId, lease.address], ['another-cloud', described, 'running', 'vm-9z', 'key-1a', '192.0.2.77']);
  assert.deepEqual(calls.find(([key]) => key === 'POST /vms')[1], { label: 'a-computer', plan: 's1', zone: 'north', os: 'debian', key: 'key-1a', tags: { 'cloud-owner': 'a-computer' } });
  assert.deepEqual(await readPrice({ request, provider: row, placement: {} }), { cents: 1250, currency: 'USD' });
  assert.deepEqual(await readMachine({ request, store: fileStore(file) }), { state: 'up', address: '192.0.2.77' });
  assert.equal((await releaseMachine({ request, store: fileStore(file) })).state, 'removed');
  assert.deepEqual([...new Set(headers)], [canary]);
  assert.ok(calls.some(([key]) => key === 'DELETE /vms/vm-9z') && calls.some(([key]) => key === 'DELETE /keys/key-1a'));
});

test('a provider is the absolute path of a description with an id and a name', () => {
  assert.throws(() => readProvider('rented-machine'), /absolute path/);
  const file = join(folder(), 'nameless.json');
  writeFileSync(file, JSON.stringify({ base: 'https://x.example.test' }));
  assert.throws(() => readProvider(file), /needs an id and a name/);
});

test('the tool\'s own files name no provider', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const path of ['../do-work/rent-a-machine.mjs', '../do-work/start-a-computer.mjs', '../do-work/render-what-a-computer-runs.mjs', '../tool-rows.json', '../README.md']) assert.doesNotMatch(read(path), /hetzner|cloudflare|gettrillion/i, path);
  for (const path of ['../do-work/start-a-computer.mjs', '../do-work/rent-a-machine.mjs', '../do-work/render-what-a-computer-runs.mjs', '../do-work/set-up-the-machine.sh', '../do-work/cap-the-journal.sh']) {
    assert.doesNotMatch(read(path).split('\n').filter(line => !/^\s*(\/\/|#|\*|\/\*\*)/.test(line)).join('\n'), /\/var\/lib\/place|\/opt\/place|-u place\b|-o place\b|\bplace\.(service|json|key)\b|99-place/, `${path} holds no service user, folder or file of one product`);
  }
  assert.doesNotMatch(read('../read-data/settings.json'), /gettrillion|\bplace\b|caddy_front_door|nodejs\.org|https:\/\/[^"]*caddy/i, 'settings hold no host, product word or pinned download');
  assert.equal(existsSync(new URL('../read-data/providers.json', import.meta.url)), false);
});

const syntheticCloud = (extra = {}) => ({
  id: 'slow-cloud', name: 'Slow Cloud', base: 'https://slow.example.test/api', auth: { header: 'x-api-key', prefix: '' }, vault_key: 'slow-cloud-key', error_code_at: 'e',
  lease_label_key: 'owned-by', fingerprint: { hash: 'sha256', encoding: 'base64', prefix: 'SHA256:' }, async: { ready_when: 'up', every_ms: 7, tries: 3 },
  first_boot: { format: 'example-init' }, terms_url: 'https://terms.example.test/slow',
  placement: { size: 's', location: 'l', image: 'i' }, fill: { tags: { '{lease_label_key}': '{name}' } },
  requests: {
    list: { url: 'https://slow.example.test/api/vms?n={name}', method: 'GET' },
    make: { url: 'https://slow.example.test/api/vms', method: 'POST', body_template: { n: '{name}', key: '{fingerprint}', boot: '{first_boot}', tags: '{tags}' } },
    one: { url: 'https://slow.example.test/api/vms/{vm_id}', method: 'GET' },
    drop: { url: 'https://slow.example.test/api/vms/{vm_id}', method: 'DELETE' },
  },
  host: { find: 'list', list_at: 'items', create: 'make', created_at: 'vm', read: 'one', found_at: 'vm', remove: 'drop', id_is: 'vm_id', id_pattern: '^[0-9]+$', owner_at: 'tags.{lease_label_key}', address_at: 'ip', state_at: 'phase' },
  ...extra,
});
const describe = value => { const file = join(folder(), 'provider.json'); writeFileSync(file, JSON.stringify(value)); return readProvider(file); };

test('a provider that creates asynchronously is polled until its machine runs, takes first-boot text it names, and keys by its own fingerprint format', async () => {
  const row = describe(syntheticCloud()), file = join(folder(), 'lease.json'), calls = [], waits = [];
  let reads = 0;
  const answer = provider(row.base, {
    'GET /vms?n=a-computer': { items: [] },
    'POST /vms': body => ({ vm: { id: 5, tags: body.tags } }),
    'GET /vms/5': () => (++reads < 3 ? { vm: { id: 5, phase: 'building', tags: { 'owned-by': 'a-computer' } } } : { vm: { id: 5, phase: 'up', ip: '192.0.2.31', tags: { 'owned-by': 'a-computer' } } }),
  }, calls);
  const request = providerClient(row, canary, { fetchImpl: (address, init) => answer(address, { ...init, headers: { authorization: `Bearer ${canary}` } }) });
  const lease = await rentMachine({ request, store: fileStore(file), provider: row, name: 'a-computer', publicKey, firstBoot: { format: 'example-init', text: '#boot' }, wait: async ms => { waits.push(ms); } });
  assert.deepEqual([lease.state, lease.address, waits], ['running', '192.0.2.31', [7, 7]]);
  const made = calls.find(([key]) => key === 'POST /vms')[1];
  assert.deepEqual([made.boot, made.tags, made.key], ['#boot', { 'owned-by': 'a-computer' }, fingerprintOf(publicKey, row.fingerprint)]);
  assert.match(made.key, /^SHA256:[A-Za-z0-9+/]{43}$/);
  await assert.rejects(rentMachine({ request, store: fileStore(join(folder(), 'x.json')), provider: row, name: 'b-computer', publicKey, firstBoot: { format: 'another-format', text: 'x' } }), /first-boot text in that format/);
});

test('a machine that never reports ready is given back, and its deadline is any time in the future', async () => {
  const row = describe(syntheticCloud()), file = join(folder(), 'lease.json'), calls = [];
  const answer = provider(row.base, {
    'GET /vms?n=a-computer': { items: [] }, 'POST /vms': body => ({ vm: { id: 6, tags: body.tags } }),
    'GET /vms/6': { vm: { id: 6, phase: 'building', tags: { 'owned-by': 'a-computer' } } }, 'DELETE /vms/6': {},
  }, calls);
  const request = providerClient(row, canary, { fetchImpl: (address, init) => answer(address, { ...init, headers: { authorization: `Bearer ${canary}` } }) });
  await assert.rejects(rentMachine({ request, store: fileStore(file), provider: row, name: 'a-computer', publicKey, wait: async () => {} }), /did not report the machine ready/);
  assert.ok(calls.some(([key]) => key === 'DELETE /vms/6'));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).state, 'removed');
  await assert.rejects(rentMachine({ request: null, store: fileStore(join(folder(), 'y.json')), provider: adopted, name: 'a-pi', placement: { address: '192.0.2.40' }, expiresAt: 5, now: () => 10 }), /deadline is a time in the future/);
  assert.equal((await rentMachine({ request: null, store: fileStore(join(folder(), 'z.json')), provider: adopted, name: 'a-pi', placement: { address: '192.0.2.40' }, expiresAt: 20, now: () => 10 })).expiresAt, 20);
});

test('a machine nobody can reach gets a one-time line, waits, and is registered only by that token', async () => {
  const row = describe({ id: 'dial-out', name: 'A machine that dials out', pull: { line: 'run-the-registrar --lease {name} --token {token}' }, placement: { monthly_price_cents: 0 } });
  const file = join(folder(), 'lease.json');
  const first = await rentMachine({ request: null, store: fileStore(file), provider: row, name: 'a-phone', placement: {} });
  assert.deepEqual([first.state, first.address, first.adopted], ['waiting', null, true]);
  const token = /--token ([0-9a-f]{48})$/.exec(first.line)?.[1];
  assert.ok(token, 'the line carries the one-time token');
  assert.ok(!readFileSync(file, 'utf8').includes(token), 'the lease keeps only the token\'s hash');
  const again = await rentMachine({ request: null, store: fileStore(file), provider: row, name: 'a-phone', placement: {} });
  assert.notEqual(again.line, first.line, 'renting again while it waits makes a new line');
  await assert.rejects(registerMachine({ store: fileStore(file), token, address: '192.0.2.60' }), /refused/);
  await assert.rejects(registerMachine({ store: fileStore(file), token: 'x', address: '192.0.2.60' }), /refused/);
  const registered = await registerMachine({ store: fileStore(file), token: /--token ([0-9a-f]{48})$/.exec(again.line)[1], address: '192.0.2.60' });
  assert.deepEqual([registered.state, registered.address, registered.tokenHash], ['running', '192.0.2.60', null]);
  await assert.rejects(registerMachine({ store: fileStore(file), token, address: '192.0.2.60' }), /not waiting/);
  assert.equal((await releaseMachine({ request: null, store: fileStore(file), provider: row })).state, 'removed');
});

test('renting a machine nobody can reach answers its line and waits, with no SSH and no name pointed', async () => {
  const here = folder(), described = join(here, 'dial-out.json'), commands = [];
  writeFileSync(described, JSON.stringify({ id: 'dial-out', name: 'A machine that dials out', pull: { line: 'register {name} {token}' } }));
  const answer = await rentAMachine({ lease_file: join(here, 'lease.json'), machine: { provider: described, name: 'a-phone' }, name: { host_name: 'phone.example.com' }, ssh: { known_hosts: join(here, 'known_hosts') } },
    { run: async (_m, command) => { commands.push(command); return ''; }, wait: async () => {} });
  assert.deepEqual([answer.lease.state, answer.arch, answer.machine], ['waiting', null, null]);
  assert.match(answer.line, /^register a-phone [0-9a-f]{48}$/);
  assert.deepEqual(commands, []);
});

