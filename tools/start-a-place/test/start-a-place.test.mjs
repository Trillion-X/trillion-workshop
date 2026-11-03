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
    'https://someone@place.example.test', 'place.example.test', 'https://place.example.test#top']) {
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
});
