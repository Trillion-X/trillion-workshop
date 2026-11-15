import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { readServiceUsage } from '../do-work/read-service-usage.mjs';
import shape from '../read-data/usage-reading.json' with { type: 'json' };

const account = 'a'.repeat(32);
const token = 'synthetic-held-token-never-returned';
const input = { connection_id: 'service_connection:cloudflare:one', since: '2026-02-01', until: '2026-02-28' };
const samples = () => Object.fromEntries(Object.entries(shape.datasets).map(([name, groups]) => [name,
  [Object.fromEntries(Object.entries(groups).map(([group, fields]) => [group,
    Object.fromEntries(fields.map((field, index) => [field, group === 'dimensions' ? 'read' : index + 7.5]))]))]]));
const reply = usage => ({ data: { viewer: { accounts: [usage] } } });
const readHeld = fd => ({ 4: token, 5: account })[fd];
const read = (body = reply(samples()), extra = {}) => readServiceUsage(input, { readHeld,
  fetchImpl: async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }), ...extra });

test('the actual reader sends the current declared provider query with selected account and inclusive UTC dates', async () => {
  const usage = samples(); let sent;
  const result = await read(reply(usage), { fetchImpl: async (url, init) => {
    sent = { url, init, body: JSON.parse(new TextDecoder().decode(init.body)) };
    return new Response(JSON.stringify(reply(usage)));
  } });
  assert.equal(result.state, 'read');
  assert.deepEqual(result.usage, usage);
  assert.equal(result.account_id, account);
  assert.deepEqual(result.period, { since: input.since, until: input.until, timezone: 'UTC', inclusive: true });
  assert.deepEqual(sent.body.variables, { a: account, s: input.since, u: input.until });
  assert.match(sent.body.query, /durableObjectsPeriodicGroups/);
  assert.match(sent.body.query, /date_geq: \$s, date_leq: \$u/);
  assert.equal(sent.url, 'https://api.cloudflare.com/client/v4/graphql');
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers.Authorization, `Bearer ${token}`);
  assert.equal(sent.init.redirect, 'manual');
  assert.match(result.said, /not an invoice/);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('a second selected connection uses its own held account, never caller account data', async () => {
  const other = 'b'.repeat(32); let variables;
  const result = await readServiceUsage({ ...input, connection_id: 'service_connection:cloudflare:two' }, {
    readHeld: fd => fd === 4 ? 'second-synthetic-token' : other,
    fetchImpl: async (_, init) => { variables = JSON.parse(new TextDecoder().decode(init.body)).variables; return new Response(JSON.stringify(reply(samples()))); }
  });
  assert.equal(result.connection_id, 'service_connection:cloudflare:two');
  assert.equal(variables.a, other);
  assert.equal(result.account_id, other);
});

test('invalid dates, reversed windows, another vendor and caller account overrides never open held pipes or send', async () => {
  const wrong = [null, {}, { ...input, since: '2026-02-30' }, { ...input, since: '2026-2-01' },
    { ...input, since: '2026-03-01' }, { ...input, connection_id: 'service_connection:other:one' },
    { ...input, connection_id: 'service_connection:cloudflare:' }, { ...input, connection_id: 'service_connection:cloudflare:one:two' },
    { ...input, account_id: 'c'.repeat(32) }];
  for (const value of wrong) {
    const result = await readServiceUsage(value, { readHeld() { assert.fail('must not read a credential'); }, fetchImpl() { assert.fail('must not send'); } });
    assert.equal(result.state, 'unread'); assert.equal(result.reason, 'invalid_scope');
  }
});

test('leap dates and a single UTC day are valid; empty lists and explicit zero remain distinct', async () => {
  const usage = samples(); usage.workers = []; usage.workers_ai[0].sum.totalNeurons = 0;
  const result = await readServiceUsage({ ...input, since: '2024-02-29', until: '2024-02-29' }, {
    readHeld, fetchImpl: async () => new Response(JSON.stringify(reply(usage))) });
  assert.equal(result.state, 'read'); assert.deepEqual(result.usage.workers, []);
  assert.equal(result.usage.workers_ai[0].sum.totalNeurons, 0);
});

test('GraphQL errors, including partial-data errors without messages, remain unread', async () => {
  for (const errors of [[{ message: token }], [{}], 'bad', {}]) {
    const result = await read({ ...reply(samples()), errors });
    assert.equal(result.state, 'unread'); assert.equal('usage' in result, false);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test('transport, HTTP failure, redirect and invalid JSON are unread without provider or exception text', async () => {
  for (const status of [301, 400, 403, 429, 500]) {
    const result = await read(null, { fetchImpl: async () => new Response(token, { status }) });
    assert.equal(result.state, 'unread'); assert.equal(JSON.stringify(result).includes(token), false);
  }
  assert.equal((await read('invalid-json')).state, 'unread');
  assert.equal((await read(null, { fetchImpl: async () => { throw new Error(token); } })).state, 'unread');
});

test('missing accounts and incomplete or invalid counters never become zero usage', async () => {
  const missing = [null, {}, { data: { viewer: { accounts: [] } } }, { data: { viewer: { accounts: [samples(), samples()] } } }];
  for (const body of missing) assert.equal((await read(body)).state, 'unread');
  for (const bad of [null, -1, '7', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const usage = samples(); usage.workers[0].sum.requests = bad;
    const result = await read(reply(usage));
    assert.equal(result.state, 'unread'); assert.equal('usage' in result, false);
  }
  const usage = samples(); delete usage.r2_storage;
  assert.equal((await read(reply(usage))).state, 'unread');
});

test('empty or unreadable selected account fields never fall back to an account', async () => {
  for (const fields of [{ 4: token, 5: '' }, { 4: '', 5: account }, { 4: token, 5: 'not-an-account' }]) {
    const result = await read(null, { readHeld: fd => fields[fd], fetchImpl() { assert.fail('must not send'); } });
    assert.equal(result.state, 'unread'); assert.equal(result.reason, 'connection_incomplete');
  }
  assert.equal((await read(null, { readHeld() { throw new Error(token); } })).reason, 'connection_unreadable');
});

test('only requested counters leave the boundary and categorical token echoes are unread', async () => {
  const usage = samples(); usage.access_token = token; usage.workers[0].private = token;
  const good = await read(reply(usage)); assert.equal(good.state, 'read'); assert.equal(JSON.stringify(good).includes(token), false);
  usage.kv_operations[0].dimensions.actionType = token;
  const bad = await read(reply(usage)); assert.equal(bad.state, 'unread'); assert.equal(JSON.stringify(bad).includes(token), false);
});

test('the real row selects per-connection fields on private pipes and declares its complete isolated import closure', async () => {
  const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url))).records[0].payload;
  assert.equal(row.id, 'tool:read-service-usage');
  assert.deepEqual(row.invoke.connection, { vendor: 'cloudflare', from_input: 'connection_id' });
  assert.deepEqual(row.invoke.credential_mounts, [{ field_id: 'api_token', fd: 4 }, { field_id: 'account_id', fd: 5 }]);
  assert.equal(row.invoke.records, undefined);
  const folder = mkdtempSync(join(tmpdir(), 'service-usage-closure-'));
  try {
    for (const entry of row.invoke.files.package_files) {
      const source = entry.package ? resolve('tools', entry.package) : resolve('node_modules', entry.module);
      for (const path of entry.paths) {
        const target = join(folder, entry.at, path);
        mkdirSync(dirname(target), { recursive: true }); cpSync(join(source, path), target, { recursive: true });
      }
    }
    // Actual descriptor command runs with its staged files and no live key or provider.
    const argv = row.invoke.argv.map(value => typeof value === 'string' && value.startsWith('/opt/') ? join(folder, value) : value);
    const probe = spawnSync(argv[0], argv.slice(1), { input: JSON.stringify({ ...input, since: '2026-02-30' }), encoding: 'utf8', cwd: folder,
      env: { PATH: process.env.PATH, HOME: folder }, timeout: 20000 });
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    assert.deepEqual(JSON.parse(probe.stdout.trim()), { result: { state: 'unread', reason: 'invalid_scope' } });
    const preload = join(folder, 'fake-provider.cjs');
    cpSync(new URL('./fake-provider.cjs', import.meta.url), preload);
    const success = await new Promise((fulfill, reject) => {
      const child = spawn(argv[0], ['--require', preload, ...argv.slice(1)], { cwd: folder,
        env: { PATH: process.env.PATH, HOME: folder, SYNTHETIC_PROVIDER_BODY: JSON.stringify(reply(samples())) },
        stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe', 'pipe'], timeout: 20000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      child.on('error', reject); child.on('close', status => fulfill({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify(input)); child.stdio[4].end(token); child.stdio[5].end(account);
    });
    assert.equal(success.status, 0, success.stderr || success.stdout);
    const result = JSON.parse(success.stdout.trim()).result;
    assert.equal(result.state, 'read'); assert.deepEqual(result.usage, samples());
    assert.equal(success.stdout.includes(token), false); assert.equal(success.stderr.includes(token), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
