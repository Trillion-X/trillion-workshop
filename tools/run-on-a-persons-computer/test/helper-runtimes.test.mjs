// test/helper-runtimes.test.mjs
//
// The Mac fetches a native helper on first use only as the bytes its manifest row pins (computer/helper-runtimes.mjs):
// BLAKE3 and a size cap, checked again on every use, one fetch for concurrent asks, atomic install, withdrawal honoured
// without an app release, staging of a gone process reaped, and the tool answers carry whether a retry can help.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashOf, helperSettings, makeHelperRuntimes } from '../helper-runtimes.mjs';

const BYTES = new TextEncoder().encode('#!/bin/sh\necho helper\n');
const row = (extra = {}) => ({ id: 'encoder', what: 'An encoder.', version: '1', url: 'https://example.invalid/encoder', blake3: hashOf(BYTES), size: 1000, file: 'encoder', executable: true, ...extra });
const mac = (helpers, fetchBytes) => {
  const home = mkdtempSync(join(tmpdir(), 'helpers-'));
  const settings = { ...helperSettings(), helpers };
  return { home, settings, manager: makeHelperRuntimes({ settings, home, fetchBytes, pid: process.pid }) };
};
const refusedWith = async (promise, status, retry, words) => {
  await assert.rejects(promise, error => { assert.equal(error.status, status); assert.equal(error.retry, retry); assert.match(error.message, words); return true; });
};

test('the shipped manifest fetches nothing on trust: it is data, and its words are complete', () => {
  const settings = helperSettings();
  assert.deepEqual(settings.helpers.map(row => row.id), ['model-server']);
  assert.equal(settings.helpers[0].unpinned, true);
  const listed = makeHelperRuntimes({ settings: { ...settings, helpers: settings.helpers.map(row => ({ ...row, adopt: [] })) }, home: mkdtempSync(join(tmpdir(), 'helpers-')) }).list().helpers;
  assert.deepEqual(listed.map(row => [row.id, row.installed, row.pinned]), [['model-server', false, false]], 'nothing is installed until it is asked for');
});

test('first use fetches, hashes, installs executable and atomically; the next use hashes the installed copy and fetches nothing', async () => {
  let fetches = 0;
  const { manager, settings, home } = mac([row()], async () => { fetches += 1; return { bytes: BYTES }; });
  const first = await manager.ensure({ id: 'encoder' });
  assert.equal(first.fetched, true);
  assert.equal(readFileSync(first.path, 'utf8'), new TextDecoder().decode(BYTES));
  assert.equal(statSync(first.path).mode & 0o111, 0o111);
  assert.ok(first.path.startsWith(join(home, settings.install_dir)));
  const again = await manager.ensure({ id: 'encoder' });
  assert.deepEqual([again.fetched, again.path], [false, first.path]);
  assert.equal(fetches, 1);
  assert.deepEqual(manager.list().helpers.map(({ id, installed, withdrawn }) => [id, installed, withdrawn]), [['encoder', true, false]]);
});

test('concurrent asks share one fetch', async () => {
  let fetches = 0;
  const { manager } = mac([row()], async () => { fetches += 1; await new Promise(resolve => setTimeout(resolve, 20)); return { bytes: BYTES }; });
  const paths = await Promise.all([1, 2, 3].map(() => manager.ensure({ id: 'encoder' })));
  assert.equal(fetches, 1);
  assert.equal(new Set(paths.map(item => item.path)).size, 1);
});

test('bytes that do not match the pinned hash, or are too big, are never installed', async () => {
  const wrong = mac([row()], async () => ({ bytes: new TextEncoder().encode('something else') }));
  await refusedWith(wrong.manager.ensure({ id: 'encoder' }), 403, false, /did not match its pinned hash/);
  assert.equal(existsSync(join(wrong.home, wrong.settings.install_dir, 'encoder', hashOf(BYTES))), false);
  const big = mac([row()], async () => ({ tooBig: true }));
  await refusedWith(big.manager.ensure({ id: 'encoder' }), 403, false, /larger than the 1000 bytes/);
  const down = mac([row()], async () => { throw new Error('connection reset'); });
  await refusedWith(down.manager.ensure({ id: 'encoder' }), 502, true, /could not be fetched: connection reset/);
});

test('an installed copy that changed is removed and fetched again, never run', async () => {
  let fetches = 0;
  const { manager } = mac([row()], async () => { fetches += 1; return { bytes: BYTES }; });
  const { path } = await manager.ensure({ id: 'encoder' });
  writeFileSync(path, 'tampered');
  assert.equal(manager.list().helpers[0].installed, false, 'the list hashes the copy and does not call it installed');
  const second = await manager.ensure({ id: 'encoder' });
  assert.equal(second.fetched, true);
  assert.equal(fetches, 2);
  assert.equal(readFileSync(second.path, 'utf8'), new TextDecoder().decode(BYTES));
});

test('a row that is unpinned, insecure, for another chip or unknown is refused in words, and nothing is fetched', async () => {
  let fetches = 0;
  const fetchBytes = async () => { fetches += 1; return { bytes: BYTES }; };
  await refusedWith(mac([row({ blake3: undefined })], fetchBytes).manager.ensure({ id: 'encoder' }), 403, false, /no pinned hash and size/);
  await refusedWith(mac([row({ size: 0 })], fetchBytes).manager.ensure({ id: 'encoder' }), 403, false, /no pinned hash and size/);
  await refusedWith(mac([row({ url: 'http://example.invalid/x' })], fetchBytes).manager.ensure({ id: 'encoder' }), 403, false, /not offered over https/);
  await refusedWith(mac([row({ arch: 'not-this-chip' })], fetchBytes).manager.ensure({ id: 'encoder' }), 409, false, /for not-this-chip Macs/);
  await refusedWith(mac([row()], fetchBytes).manager.ensure({ id: 'nothing' }), 404, false, /no helper named nothing/);
  assert.equal(fetches, 0);
});

test('withdrawal is a data change: the next ask is refused and the installed copy is deleted', async () => {
  let clock = Date.parse('2026-10-19T00:00:00Z');
  const home = mkdtempSync(join(tmpdir(), 'helpers-'));
  const helpers = [row({ withdrawn_at: '2026-10-20T00:00:00Z' })];
  const manager = makeHelperRuntimes({ settings: { ...helperSettings(), helpers }, home, now: () => clock, fetchBytes: async () => ({ bytes: BYTES }) });
  const { path } = await manager.ensure({ id: 'encoder' });
  assert.ok(existsSync(path));
  clock = Date.parse('2026-10-21T00:00:00Z');
  await refusedWith(manager.ensure({ id: 'encoder' }), 403, false, /was withdrawn on 2026-10-20/);
  assert.equal(existsSync(path), false);
  assert.deepEqual(manager.list().helpers.map(({ withdrawn, installed }) => [withdrawn, installed]), [[true, false]]);
});

test('remove deletes the copy and keeps the row; staging left by a process that is gone is reaped, a live one is kept', async () => {
  const { manager, home, settings } = mac([row()], async () => ({ bytes: BYTES }));
  const { path } = await manager.ensure({ id: 'encoder' });
  manager.remove({ id: 'encoder' });
  assert.equal(existsSync(path), false);
  assert.equal(manager.list().helpers.length, 1);
  const folder = join(home, settings.install_dir, 'encoder');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.staging-2147483646-dead'), 'half');
  writeFileSync(join(folder, `.staging-${process.ppid}-alive`), 'half');
  await manager.ensure({ id: 'encoder' });
  assert.equal(existsSync(join(folder, '.staging-2147483646-dead')), false);
  assert.equal(existsSync(join(folder, `.staging-${process.ppid}-alive`)), true);
});

test('the network fetch itself refuses a body above the pinned size, by header and by length, and takes the pinned bytes', async () => {
  const real = globalThis.fetch;
  try {
    const home = mkdtempSync(join(tmpdir(), 'helpers-'));
    const manager = makeHelperRuntimes({ settings: { ...helperSettings(), helpers: [row({ size: BYTES.length })] }, home });
    globalThis.fetch = async () => new Response(BYTES, { headers: { 'content-length': String(BYTES.length + 5) } });
    await refusedWith(manager.ensure({ id: 'encoder' }), 403, false, /larger than/);
    globalThis.fetch = async () => new Response(new Uint8Array(BYTES.length + 1));
    await refusedWith(manager.ensure({ id: 'encoder' }), 403, false, /larger than/);
    globalThis.fetch = async () => new Response('no', { status: 404 });
    await refusedWith(manager.ensure({ id: 'encoder' }), 502, true, /answered 404/);
    globalThis.fetch = async () => new Response(BYTES);
    assert.equal((await manager.ensure({ id: 'encoder' })).fetched, true);
  } finally { globalThis.fetch = real; }
});

test('an install keeps a receipt; blocked content is turned off with its reason by recheck and restored to what it was when unblocked', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helpers-'));
  const settings = { ...helperSettings(), helpers: [row({ signer: 'Example Maker (ABCDE12345)' }), row({ id: 'second', file: 'second', blake3: hashOf(new TextEncoder().encode('other')), url: 'https://example.invalid/second' })] };
  const bytes = { encoder: BYTES, second: new TextEncoder().encode('other') };
  const manager = makeHelperRuntimes({ settings, home, now: () => Date.parse('2026-10-19T09:00:00Z'), fetchBytes: async url => ({ bytes: url.endsWith('second') ? bytes.second : BYTES }) });
  const { path } = await manager.ensure({ id: 'encoder' });
  await manager.ensure({ id: 'second' });
  const receipt = JSON.parse(readFileSync(join(path, '..', 'receipt.json'), 'utf8'));
  assert.deepEqual([receipt.blake3, receipt.signer, receipt.source, receipt.size, receipt.installed_at], [hashOf(BYTES), 'Example Maker (ABCDE12345)', 'https://example.invalid/encoder', BYTES.length, '2026-10-19T09:00:00.000Z']);
  // The person turned `second` off before any block.
  manager.setEnabled({ id: 'second', enabled: false });
  settings.blocked = [{ blake3: hashOf(BYTES), reason: 'withdrawn by its maker' }, { blake3: hashOf(bytes.second), reason: 'known bad' }];
  assert.deepEqual([manager.recheck().turned_off, manager.recheck().turned_off], [2, 0], 'a second recheck changes nothing');
  await refusedWith(manager.ensure({ id: 'encoder' }), 403, false, /turned off: withdrawn by its maker/);
  assert.deepEqual(manager.list().helpers.map(item => [item.id, item.enabled]), [['encoder', false], ['second', false]]);
  assert.throws(() => manager.setEnabled({ id: 'encoder', enabled: true }), /withdrawn by its maker/, 'a block is not undone by turning the helper on');
  settings.blocked = [];
  assert.equal(manager.recheck().restored, 2);
  assert.equal((await manager.ensure({ id: 'encoder' })).fetched, false, 'the helper that was on is on again, with its installed copy');
  await refusedWith(manager.ensure({ id: 'second' }), 403, false, /was turned off/);
  assert.equal(manager.setEnabled({ id: 'second', enabled: true }).enabled, true);
  assert.equal((await manager.ensure({ id: 'second' })).fetched, false);
});

test('a published helper list is used only when a trusted key signed it, and only for a strictly newer version', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { manifestSettings } = await import('../signed-manifest.mjs');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const rules = { ...manifestSettings(), keys: [{ id: 'publisher', public_key: raw }] };
  const entry = (version, bytes = BYTES) => ({ id: 'encoder', version, url: 'https://example.invalid/e', size: 1000, blake3: hashOf(bytes), file: 'encoder', executable: true });
  const listOf = entries => JSON.stringify({ entries });
  const signed = text => sign(null, Buffer.from(text), privateKey).toString('base64');
  const published = { text: listOf([entry('2')]) };
  const follow = { url: 'https://list.invalid/helpers.json', signature_url: 'https://list.invalid/helpers.sig', channel: 'stable' };
  const home = mkdtempSync(join(tmpdir(), 'helpers-'));
  const make = (extra = {}) => makeHelperRuntimes({ settings: { ...helperSettings(), helpers: [row({ version: '1' })], manifest: follow }, home, manifestRules: rules,
    fetchText: async url => (url.endsWith('.sig') ? (extra.signature ?? signed(published.text)) : published.text), fetchBytes: async () => ({ bytes: BYTES }), ...extra });
  assert.match((await make().refresh()).said, /Took 1 newer helper/);
  assert.equal(make().list().helpers.find(item => item.id === 'encoder').version, '2');
  published.text = listOf([entry('1')]);
  assert.deepEqual((await make().refresh()).applied, [], 'an older list never moves a helper back');
  assert.equal(make().list().helpers[0].version, '2');
  published.text = listOf([entry('3')]);
  await assert.rejects(make({ signature: signed('something else') }).refresh(), /does not match any publisher/);
  assert.equal(make().list().helpers[0].version, '2', 'a list whose signature does not verify changes nothing');
  assert.equal((await make({ settings: { ...helperSettings(), helpers: [] } }).refresh()).applied.length, 0, 'no list is followed: nothing is fetched');
  assert.deepEqual((await make().refresh()).applied, ['encoder']);
  assert.equal(make().list().helpers[0].version, '3');
});

test('the switches are one versioned document: each says what produced it, a layout change keeps a backup, a newer file is refused untouched', async () => {
  const { existsSync, readFileSync: read, writeFileSync: write } = await import('node:fs');
  const { manager, home, settings } = mac([row({ blake3: hashOf(BYTES) })], async () => ({ bytes: BYTES }));
  manager.setEnabled({ id: 'encoder', enabled: false });
  const file = join(home, settings.install_dir, settings.state_file);
  const doc = JSON.parse(read(file, 'utf8'));
  assert.equal(doc.version, 1);
  assert.deepEqual([doc.entries.encoder.value.enabled, doc.entries.encoder.evidence], [false, 'the person turned it off']);
  manager.setEnabled({ id: 'encoder', enabled: true });
  assert.deepEqual(JSON.parse(read(file, 'utf8')).entries, {});
  write(file, JSON.stringify({ version: 9, entries: {} }));
  await assert.rejects(async () => manager.setEnabled({ id: 'encoder', enabled: false }), /newer than this program understands/);
  assert.equal(JSON.parse(read(file, 'utf8')).version, 9, 'the newer file was left as it was');
  assert.equal(existsSync(`${file}.next`), false);
});

// A signed app bundle is checked before it is moved into place: the helper row's `verify` runs on the unpacked entry with the
// real codesign, and a bundle changed after it was signed leaves the install folder as it was. Real ditto and codesign (macOS).
const macOnly = { skip: process.platform !== 'darwin' && 'needs ditto and codesign' };
function signedZip(tamper) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  const app = join(dir, 'Tool.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>tool</string><key>CFBundleIdentifier</key><string>test.tool</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  writeFileSync(join(app, 'Contents', 'MacOS', 'tool'), '#!/bin/sh\necho real\n', { mode: 0o755 });
  execFileSync('codesign', ['--force', '--sign', '-', app]);
  if (tamper) writeFileSync(join(app, 'Contents', 'MacOS', 'tool'), '#!/bin/sh\necho changed after signing\n', { mode: 0o755 });
  const zip = join(dir, 'tool.zip');
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip]);
  return readFileSync(zip);
}
const bundleRow = bytes => ({ id: 'tool', what: 'A signed tool.', version: '1', url: 'https://example.invalid/tool.zip', blake3: hashOf(bytes), size: bytes.length + 10, archive: 'zip', entry: 'Tool.app', verify: [['codesign', '--verify', '--deep', '--strict', '{app}']] });

test('a signed bundle that passes its verify row is moved into place', macOnly, async () => {
  const bytes = signedZip(false);
  const { manager } = mac([bundleRow(bytes)], async () => ({ bytes }));
  const done = await manager.ensure({ id: 'tool' });
  assert.equal(readFileSync(join(done.path, 'Contents', 'MacOS', 'tool'), 'utf8'), '#!/bin/sh\necho real\n');
});

test('a bundle changed after it was signed fails its verify row, is not installed, and leaves no staging behind', macOnly, async () => {
  const bytes = signedZip(true);
  const { manager, home, settings } = mac([bundleRow(bytes)], async () => ({ bytes }));
  await refusedWith(manager.ensure({ id: 'tool' }), 403, false, /did not pass its check/);
  const folder = join(home, settings.install_dir, 'tool');
  const left = existsSync(folder) ? readdirSync(folder, { recursive: true }) : [];
  assert.deepEqual(left.filter(name => /Tool\.app|\.staging-/.test(String(name))), [], 'nothing of the bundle or its staging stays');
  assert.equal(existsSync(join(folder, hashOf(bytes), 'Tool.app')), false);
});

test('the shipped model-server row verifies the app\'s signature before anything is moved in', () => {
  const server = helperSettings().helpers.find(item => item.id === 'model-server');
  assert.deepEqual(server.verify, [['codesign', '--verify', '--deep', '--strict', '{app}']]);
});
