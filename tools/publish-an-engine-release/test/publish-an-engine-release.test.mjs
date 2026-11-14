import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { untarGz } from '../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';
import { addRelease, checkFeedTarget, feedStatusOf, newSigningKey, publicKeyHex, readFeed, roads, settings, signEntry, signedText, verifyEntry } from '../do-work/release-feed.mjs';
import { packageFilesByRow } from '../../../test-helpers/tool-row-imports.mjs';
import { runInProgress, archiveRelease, CREDENTIAL_HELPER, filesUnder, makeKey, packRelease, privateInput, publish, refuseUnreadableByOldReaders, runProgram } from '../do-work/publish-an-engine-release.mjs';
import { tarGz } from '../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';
import { attemptsOf, behindFeed, catchUp, countAttempt, makeQueue, makeReceiver, readDelivery, runPublish, signatureHolds } from '../do-work/receive-pushes.mjs';
import { builderConfig, installBuilder, receiverUnit, SHIPPED, shippedTarball } from '../do-work/install-a-builder.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const PUBLISH = fileURLToPath(new URL('../do-work/publish-an-engine-release.mjs', import.meta.url));
const canary = 'repository-token-canary-0123456789';
// Each file's mode, read from its ustar header.
const modesOf = (tar, modes = {}) => { for (let at = 0; tar[at]; at += 512 + Math.ceil(parseInt(tar.toString('latin1', at + 124, at + 135), 8) / 512) * 512) modes[tar.toString('latin1', at, at + 100).replace(/\0.*$/s, '')] = parseInt(tar.toString('latin1', at + 100, at + 107), 8); return modes; };
const folder = () => mkdtempSync(join(tmpdir(), 'publish-an-engine-release-'));
// A release's sequence is its commit's time in seconds; the made-up repository's commit n is made at BASE_TIME + n.
const BASE_TIME = 1_800_000_000;
const sh = (cwd, ...args) => {
  const extra = typeof args.at(-1) === 'object' ? args.pop().env : {};
  const ran = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com', ...extra } });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
};

// A made-up engine repository: a bare "remote" whose main has `count` commits, the first with product/ in it unless
// `product` is false.
function repository(count, { trailerAt, product = true } = {}) {
  const top = folder(), remote = join(top, 'remote.git'), work = join(top, 'checkout');
  mkdirSync(work);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(work, 'init', '-q', '-b', 'main');
  if (product) {
    mkdirSync(join(work, 'product'));
    writeFileSync(join(work, 'product', 'new-accounts.json'), '{"sign_in_ways":[]}\n');
  }
  writeFileSync(join(work, 'Cargo.toml'), '[package]\nname = "made-up"\n');
  // The Workshop's own data the tool-row walker reads at each commit: no system names, no npm packages.
  mkdirSync(join(work, 'test-helpers'));
  writeFileSync(join(work, 'test-helpers', 'tool-row-imports.json'), '{"provided_by_the_system":[]}\n');
  writeFileSync(join(work, 'package-lock.json'), '{"packages":{}}\n');
  sh(work, 'add', '.');
  // Commit n is made at second BASE_TIME + n, so its sequence (its commit time) is BASE_TIME + n.
  const at = n => ({ GIT_COMMITTER_DATE: `${BASE_TIME + n} +0000`, GIT_AUTHOR_DATE: `${BASE_TIME + n} +0000` });
  sh(work, 'commit', '-q', '-m', 'first', { env: at(1) });
  for (let i = 2; i <= count; i++) sh(work, 'commit', '-q', '--allow-empty', '-m', i === trailerAt ? `change ${i}\n\nRelease-Urgent: true` : `change ${i}`, { env: at(i) });
  sh(work, 'remote', 'add', 'origin', remote);
  sh(work, 'push', '-q', 'origin', 'main');
  const commits = sh(work, 'rev-list', '--reverse', '--first-parent', 'main').split('\n');
  return { top, remote, commits };
}

// A builder folder: its key (made once, 0400), the request publish reads, and fake cargo and rustc.
function builder(remote) {
  const top = folder(), envFile = join(top, 'cargo-env');
  const key = makeKey(join(top, 'key', 'release-signing.key'));
  const request = {
    repository: remote, branch: 'main', base_url: 'https://releases.example.com/engine-releases/',
    work_folder: join(top, 'work'), feed_folder: join(top, 'feed'), key_file: join(top, 'key', 'release-signing.key'),
    toolchain: { cargo: join(here, 'fake-cargo'), rustc: join(here, 'fake-rustc') },
  };
  process.env.FAKE_CARGO_ENV = envFile;
  return { top, key, request, envFile };
}

test('the signed text is the domain line and the six fields, one per line', () => {
  assert.equal(signedText({ commit: 'a'.repeat(40), sequence: 7, target: 'aarch64-unknown-linux-gnu', content: `1f:${'b'.repeat(64)}`, bytes: 12, urgent: false }),
    `trillion-engine-release-v1\n${'a'.repeat(40)}\n7\naarch64-unknown-linux-gnu\n1f:${'b'.repeat(64)}\n12\nfalse`);
});

test('a publish builds, packs and signs the commit, and its entry verifies with the printed key', async () => {
  const { remote, commits } = repository(3, { trailerAt: 3 });
  const { key, request, envFile, top } = builder(remote);
  assert.equal(statSync(request.key_file).mode & 0o777, 0o400);
  assert.match(key.public_key, /^[0-9a-f]{64}$/);
  const answer = await publish(request, { token: canary });
  assert.deepEqual([answer.commit, answer.sequence, answer.target, answer.urgent, answer.already_published], [commits[2], BASE_TIME + 3, 'x86_64-unknown-linux-gnu', true, false]);
  assert.equal(answer.url, `https://releases.example.com/engine-releases/${commits[2]}/x86_64-unknown-linux-gnu.tar.gz`);
  assert.equal(answer.public_key, key.public_key);

  const feed = JSON.parse(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8'));
  assert.deepEqual(Object.keys(feed), ['releases']);
  const entry = feed.releases.find(one => one.target === 'x86_64-unknown-linux-gnu');
  assert.deepEqual(Object.keys(entry), ['commit', 'sequence', 'target', 'url', 'content', 'bytes', 'urgent', 'signature']);
  assert.match(entry.signature, /^[0-9a-f]{128}$/);
  assert.ok(verifyEntry(entry, key.public_key));
  assert.ok(!verifyEntry({ ...entry, sequence: 4 }, key.public_key), 'a changed field no longer verifies');
  assert.ok(!verifyEntry(entry, publicKeyHex(newSigningKey())), 'another key does not verify');

  const tarball = join(request.feed_folder, commits[2], 'x86_64-unknown-linux-gnu.tar.gz'), bytes = readFileSync(tarball);
  assert.equal(entry.bytes, bytes.length);
  assert.equal(entry.content, makeHashCodeHexFromBytes(new Uint8Array(bytes)));
  const unpacked = join(top, 'unpacked');
  for (const { name, bytes: body } of untarGz(bytes, { withBytes: true })) { mkdirSync(dirname(join(unpacked, name)), { recursive: true }); writeFileSync(join(unpacked, name), body, { mode: 0o755 }); }
  assert.deepEqual(readdirSync(unpacked).sort(), ['product', 'trillion-local']);
  assert.ok(existsSync(join(unpacked, 'product', 'bin', 'trillion-mcp-forwarder')), 'the forwarder is under product/bin');
  assert.ok(existsSync(join(unpacked, 'product', 'new-accounts.json')));
  assert.equal(spawnSync(join(unpacked, 'trillion-local'), { encoding: 'utf8' }).stdout.trim(), `trillion-local ${commits[2]} ${BASE_TIME + 3}`, 'built with the two release values');

  const seen = readFileSync(envFile, 'utf8');
  assert.match(seen, new RegExp(`TRILLION_RELEASE_COMMIT=${commits[2]}`));
  assert.match(seen, new RegExp(`TRILLION_RELEASE_SEQUENCE=${BASE_TIME + 3}`));
  for (const text of [seen, readFileSync(join(request.work_folder, 'build.log'), 'utf8'), JSON.stringify(feed), JSON.stringify(answer)]) assert.ok(!text.includes(canary));

  const again = await publish(request, { token: canary });
  assert.equal(again.already_published, true, 'the same commit again changes nothing');
  // One entry per road in release-roads.json: the host target and the zigbuild target.
  assert.equal(JSON.parse(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8')).releases.length, 2);
});

test('a commit with no product/ folder publishes a release that holds only the engine programs', async () => {
  const { remote, commits } = repository(2, { product: false });
  const { key, request } = builder(remote);
  const answer = await publish(request);
  assert.deepEqual([answer.commit, answer.sequence, answer.already_published], [commits[1], BASE_TIME + 2, false]);
  const [entry] = JSON.parse(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8')).releases.filter(one => one.target === 'x86_64-unknown-linux-gnu');
  assert.ok(verifyEntry(entry, key.public_key));
  const bytes = readFileSync(join(request.feed_folder, commits[1], 'x86_64-unknown-linux-gnu.tar.gz'));
  assert.deepEqual(untarGz(bytes).map(file => file.name), ['product/bin/trillion-mcp-forwarder', 'trillion-local']);
});

test('an engine publish also signs the forwarder it built into the forwarder feed, so the relay that follows that feed gets every landed fix', async () => {
  const { remote, commits } = repository(3);
  const { key, request } = builder(remote);
  const answer = await publish(request);
  assert.equal(answer.also_published.length, 1);
  const feed = JSON.parse(readFileSync(join(request.feed_folder, 'forwarder-feed.json'), 'utf8'));
  assert.deepEqual(feed.releases.map(one => [one.commit, one.sequence, one.target]), [[commits[2], BASE_TIME + 3, 'x86_64-unknown-linux-gnu']]);
  assert.ok(verifyEntry(feed.releases[0], key.public_key), 'signed with the engine key');
  assert.equal(feed.releases[0].url, `https://releases.example.com/engine-releases/forwarder/${commits[2]}/x86_64-unknown-linux-gnu.tar.gz`);
  const bytes = readFileSync(join(request.feed_folder, 'forwarder', commits[2], 'x86_64-unknown-linux-gnu.tar.gz'));
  assert.deepEqual(untarGz(bytes).map(file => file.name), ['trillion-mcp-forwarder'], 'the binary alone, at the root');
  assert.equal(feed.releases[0].content, makeHashCodeHexFromBytes(new Uint8Array(bytes)));
  const engine = JSON.parse(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8'));
  assert.ok(engine.releases.every(one => one.url.startsWith('https://releases.example.com/engine-releases/') && !one.url.includes('/forwarder/')), 'the engine feed names no forwarder body');
  // The same commit again signs nothing twice, in either feed.
  const again = await publish(request);
  assert.equal(again.already_published, true);
  assert.equal(JSON.parse(readFileSync(join(request.feed_folder, 'forwarder-feed.json'), 'utf8')).releases.length, 1);
});

test('the forwarder kind publishes its program alone at the root of its own feed, under its own folder, and the engine feed is untouched', async () => {
  const { remote, commits } = repository(2);
  const { key, request } = builder(remote);
  const answer = await publish({ ...request, kind: 'forwarder' });
  assert.equal(answer.url, `https://releases.example.com/engine-releases/forwarder/${commits[1]}/x86_64-unknown-linux-gnu.tar.gz`);
  assert.deepEqual([answer.commit, answer.sequence, answer.target, answer.already_published], [commits[1], BASE_TIME + 2, 'x86_64-unknown-linux-gnu', false]);

  const feed = JSON.parse(readFileSync(join(request.feed_folder, 'forwarder-feed.json'), 'utf8'));
  assert.equal(feed.releases.length, 1);
  assert.ok(verifyEntry(feed.releases[0], key.public_key), 'signed as the engine\'s entries are');
  assert.ok(!existsSync(join(request.feed_folder, 'feed.json')), 'the engine feed is not written by the forwarder kind');

  const bytes = readFileSync(join(request.feed_folder, 'forwarder', commits[1], 'x86_64-unknown-linux-gnu.tar.gz'));
  assert.deepEqual(untarGz(bytes).map(file => file.name), ['trillion-mcp-forwarder'], 'the binary alone, at the root');
  assert.equal(readFileSync(join(request.feed_folder, 'forwarder', commits[1], 'x86_64-unknown-linux-gnu.tar.gz')).length, feed.releases[0].bytes);
});

test('the mac-app kind is its own feed of basename releases, and the engine feed still takes the Mac triple', () => {
  const kind = settings.kinds.find(row => row.kind === 'mac-app');
  assert.deepEqual([kind.build, kind.target, kind.feed_file], [false, 'aarch64-apple-darwin', 'mac-app-feed.json']);
  assert.equal(kind.url_folder, undefined, 'the names are basenames: no folder');
  assert.doesNotThrow(() => checkFeedTarget('mac-app-feed.json', 'aarch64-apple-darwin'));
  assert.doesNotThrow(() => checkFeedTarget('feed.json', 'aarch64-apple-darwin'), 'the engine Mac road keeps its entries in the engine feed');
  assert.throws(() => checkFeedTarget('workshop-feed.json', 'aarch64-apple-darwin'), /belongs in mac-app-feed.json/);
  assert.throws(() => checkFeedTarget('mac-app-feed.json', 'x86_64-unknown-linux-gnu'), /engine target/);
});

test('a provided-files kind publishes the two files a request names, each checked and signed under its basename', async () => {
  const { remote, commits } = repository(2);
  const { key, request, top } = builder(remote);
  const dmgBytes = Buffer.from('synthetic disk image bytes'), recordBytes = Buffer.from('{"latestVersion":"1.0.1"}\n');
  const staged = join(top, 'staged');
  mkdirSync(staged);
  writeFileSync(join(staged, 'Trillion-1.0.1.dmg'), dmgBytes);
  writeFileSync(join(staged, 'Trillion-update.json'), recordBytes);
  const file = (name, bytes) => ({ name, path: join(staged, name), bytes: bytes.length, content: makeHashCodeHexFromBytes(new Uint8Array(bytes)) });
  const providing = { ...request, kind: 'mac-app', commit: commits[1], sequence: 2, files: [file('Trillion-1.0.1.dmg', dmgBytes), file('Trillion-update.json', recordBytes)] };
  const answer = await publish(providing);
  assert.deepEqual(answer.published.map(one => one.url), [`${request.base_url}Trillion-1.0.1.dmg`, `${request.base_url}Trillion-update.json`]);
  const feed = JSON.parse(readFileSync(join(request.feed_folder, 'mac-app-feed.json'), 'utf8'));
  assert.equal(feed.releases.length, 2, 'both files are entries of the one commit');
  for (const entry of feed.releases) {
    assert.ok(verifyEntry(entry, key.public_key), 'each entry is signed as the others are');
    assert.equal(entry.target, 'aarch64-apple-darwin');
  }
  assert.deepEqual(readFileSync(join(request.feed_folder, 'Trillion-1.0.1.dmg')), dmgBytes);
  assert.deepEqual(readFileSync(join(request.feed_folder, 'Trillion-update.json')), recordBytes);
  assert.ok(!existsSync(join(request.feed_folder, 'feed.json')), 'the engine feed is untouched');

  const again = await publish(providing);
  assert.ok(again.published.every(one => one.already_published === true), 'the same files again change nothing');

  await assert.rejects(publish({ ...providing, sequence: 3, files: [{ ...providing.files[0], content: `1f:${'0'.repeat(64)}` }] }), error => error.exit === 3 && /not the content/.test(error.message), 'a content the request does not state is refused');
  await assert.rejects(publish({ ...providing, sequence: 3, files: [{ ...providing.files[0], name: '../escape.dmg' }] }), error => error.exit === 2 && /basename/.test(error.message), 'a name with a folder is refused');
});

test('a provided-files request whose second file is wrong publishes nothing: the feed and the folder are unchanged', async () => {
  const { remote, commits } = repository(3);
  const { request } = builder(remote);
  const staged = join(folder(), 'staged');
  mkdirSync(staged);
  const good = Buffer.from('synthetic disk image bytes'), record = Buffer.from('{"latestVersion":"2.0.0"}\n');
  writeFileSync(join(staged, 'Trillion-2.0.0.dmg'), good);
  writeFileSync(join(staged, 'Trillion-update.json'), record);
  const file = (name, bytes) => ({ name, path: join(staged, name), bytes: bytes.length, content: makeHashCodeHexFromBytes(new Uint8Array(bytes)) });
  const wrong = { ...file('Trillion-update.json', record), content: `1f:${'0'.repeat(64)}` };
  await assert.rejects(publish({ ...request, kind: 'mac-app', commit: commits[2], sequence: 3, files: [file('Trillion-2.0.0.dmg', good), wrong] }), error => error.exit === 3);
  assert.ok(!existsSync(join(request.feed_folder, 'mac-app-feed.json')), 'the feed was not written');
  assert.ok(!existsSync(join(request.feed_folder, 'Trillion-2.0.0.dmg')), 'the first file was not stored either');
  assert.ok(!existsSync(join(request.feed_folder, 'Trillion-update.json')));
});

test('a release with an extra program at the root is refused before it is signed: old unpackers take only the program at the root', () => {
  const program = { name: 'trillion-local', bytes: Buffer.from('engine'), executable: true };
  const forwarder = { name: 'trillion-mcp-forwarder', bytes: Buffer.from('relay'), executable: true };
  assert.throws(() => refuseUnreadableByOldReaders(tarGz([program, forwarder])), error => error.exit === 3 && /trillion-mcp-forwarder/.test(error.message));
  assert.doesNotThrow(() => refuseUnreadableByOldReaders(tarGz([program, { ...forwarder, name: 'product/bin/trillion-mcp-forwarder' }])), 'the extra program under product/ is readable');
  assert.doesNotThrow(() => refuseUnreadableByOldReaders(tarGz([program])));
});

test('a release and the shipped files pack with no tar program: same bytes and executable bit back, no __pycache__ shipped', () => {
  const top = folder(), program = join(top, 'bin', 'trillion-local'), source = join(top, 'source'), file = join(top, 'release.tar.gz');
  mkdirSync(join(top, 'bin'));
  mkdirSync(join(source, 'product', 'deep', '__pycache__'), { recursive: true });
  writeFileSync(program, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 255]), { mode: 0o755 });
  writeFileSync(join(top, 'bin', 'trillion-mcp-forwarder'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 254]), { mode: 0o755 });
  for (const [name, text, mode] of [['deep/run.sh', '#!/bin/sh\n', 0o755], ['data.json', '{}\n', 0o644], ['deep/__pycache__/x.pyc', 'cache', 0o644]]) writeFileSync(join(source, 'product', name), text, { mode });
  const packed = packRelease({ program, source, file }), bytes = readFileSync(file);
  assert.deepEqual(packed, { content: makeHashCodeHexFromBytes(new Uint8Array(bytes)), bytes: bytes.length });
  const files = untarGz(bytes, { withBytes: true });
  assert.deepEqual(files.map(entry => entry.name), ['product/bin/trillion-mcp-forwarder', 'product/data.json', 'product/deep/__pycache__/x.pyc', 'product/deep/run.sh', 'trillion-local']);
  for (const entry of files) assert.deepEqual(Buffer.from(entry.bytes), readFileSync(entry.name.startsWith('trillion-') ? join(top, 'bin', entry.name) : entry.name.startsWith('product/bin/') ? join(top, 'bin', entry.name.slice('product/bin/'.length)) : join(source, entry.name)), entry.name);
  assert.deepEqual(modesOf(gunzipSync(bytes)), { 'product/data.json': 0o644, 'product/deep/__pycache__/x.pyc': 0o644, 'product/deep/run.sh': 0o755, 'trillion-local': 0o755, 'product/bin/trillion-mcp-forwarder': 0o755 });
  packRelease({ program, source, file: `${file}.again` });
  assert.deepEqual(readFileSync(`${file}.again`), bytes, 'the same files pack to the same bytes');

  assert.deepEqual(filesUnder(source, ['product'], ['__pycache__']).map(entry => entry.name), ['product/data.json', 'product/deep/run.sh']);
  const shipped = untarGz(shippedTarball()).map(entry => entry.name);
  for (const name of [...SHIPPED.filter(path => /\.m?js$/.test(path)), 'tools/publish-an-engine-release/do-work/publish-an-engine-release.mjs']) assert.ok(shipped.includes(name), name);
  assert.ok(!shipped.some(name => name.includes('__pycache__')));
});

test('a commit older than the feed\'s newest is refused before it is built', async () => {
  const { remote, commits } = repository(3);
  const { request, envFile } = builder(remote);
  await publish(request, { commit: commits[2] });
  writeFileSync(envFile, '');
  await assert.rejects(publish(request, { commit: commits[1] }), error => error.exit === 3 && new RegExp(`sequence ${BASE_TIME + 2}, older than the feed's newest`).test(error.message));
  assert.equal(readFileSync(envFile, 'utf8'), '', 'nothing was built');
  const feed = readFeed(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8'));
  assert.deepEqual(feed.releases.map(entry => entry.sequence), [BASE_TIME + 3, BASE_TIME + 3], 'one entry per road, both for the newest commit');
  await assert.rejects(publish(request, { commit: 'f'.repeat(40) }), /not on main's first-parent line/);
});

test('the feed keeps the newest 32 releases, and an older one leaves with its tar.gz', async () => {
  const { remote, commits } = repository(33);
  const { request } = builder(remote);
  const privateKey = readFileSync(request.key_file, 'utf8'), target = 'x86_64-unknown-linux-gnu';
  const seeded = commits.slice(0, 32).map((commit, at) => {
    mkdirSync(join(request.feed_folder, commit), { recursive: true });
    writeFileSync(join(request.feed_folder, commit, `${target}.tar.gz`), 'made-up');
    return signEntry({ commit, sequence: BASE_TIME + at + 1, target, url: `${request.base_url}${commit}/${target}.tar.gz`, content: `1f:${'c'.repeat(64)}`, bytes: 7, urgent: false }, privateKey);
  });
  writeFileSync(join(request.feed_folder, 'feed.json'), JSON.stringify({ releases: seeded }));
  const answer = await publish(request, {});
  assert.deepEqual([answer.sequence, answer.dropped, answer.releases_held], [BASE_TIME + 33, 1, 32]);
  const feed = readFeed(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8'));
  // The host road publishes first (its answer above), then the zigbuild road: each adds one entry and drops the oldest.
  assert.deepEqual(feed.releases.map(entry => entry.sequence), [...Array.from({ length: 31 }, (_, at) => BASE_TIME + at + 3), BASE_TIME + 33], 'newest last');
  assert.ok(!existsSync(join(request.feed_folder, commits[0])), 'the dropped release\'s tar.gz is gone');
  assert.ok(!existsSync(join(request.feed_folder, commits[1])), 'the second dropped release\'s tar.gz is gone');
  assert.ok(existsSync(join(request.feed_folder, commits[2], `${target}.tar.gz`)));
});

test('adding to a feed refuses an older sequence and another commit at the same one', () => {
  const key = newSigningKey(), entry = (n, commit = String(n % 10).repeat(40)) => signEntry({ commit, sequence: n, target: 'aarch64-unknown-linux-gnu', url: 'https://r.example.com/x.tar.gz', content: `1f:${'d'.repeat(64)}`, bytes: 1, urgent: false }, key);
  let feed = { releases: [] };
  for (let n = 1; n <= 40; n++) feed = addRelease(feed, entry(n, n.toString(16).padStart(40, '0'))).feed;
  assert.equal(feed.releases.length, 32);
  assert.equal(feed.releases.at(-1).sequence, 40);
  assert.throws(() => addRelease(feed, entry(39, 'e'.repeat(40))), /older than the feed's newest/);
  assert.throws(() => addRelease(feed, entry(40, 'e'.repeat(40))), /same sequence/);
  const other = addRelease(feed, signEntry({ ...entry(5), target: 'x86_64-unknown-linux-gnu' }, key));
  assert.ok(other.added, 'another target has its own newest');
});

test('an engine feed refuses a Workshop entry, and a Workshop feed refuses an engine target', () => {
  const key = newSigningKey();
  const entry = target => signEntry({ commit: '1'.repeat(40), sequence: 1, target, url: 'https://r.example.com/x.tar.gz', content: `1f:${'d'.repeat(64)}`, bytes: 1, urgent: false }, key);
  assert.throws(() => addRelease({ releases: [] }, entry('x86_64-unknown-linux-gnu'), settings.keep_releases, 'workshop-feed.json'), /is an engine target: it belongs in feed\.json/);
  assert.ok(addRelease({ releases: [] }, entry('workshop-tools'), settings.keep_releases, 'workshop-feed.json').added, 'the Workshop feed takes its own target');
  assert.ok(addRelease({ releases: [] }, entry('workshop-tools')).added, 'the engine feed takes the Workshop target only as its mirror');
  assert.throws(() => addRelease({ releases: [] }, entry('workshop-tools'), settings.keep_releases, 'other-feed.json'), /not a target of the other-feed\.json feed/);
  const mixed = JSON.stringify({ releases: [entry('x86_64-unknown-linux-gnu'), entry('workshop-tools')] });
  assert.equal(readFeed(mixed).releases.length, 2, 'the engine feed reads its mirrored Workshop entry');
  assert.throws(() => readFeed(JSON.stringify({ releases: [entry('x86_64-unknown-linux-gnu')] }), 'workshop-feed.json'), /is an engine target/, 'the Workshop feed refuses an engine entry on read');
});

test('the feed never holds more than keep entries, and a target whose builder is behind keeps its newest', () => {
  const key = newSigningKey(), slow = 'x86_64-unknown-linux-gnu', fast = 'aarch64-apple-darwin';
  const entry = (sequence, target) => signEntry({ commit: sequence.toString(16).padStart(40, '0'), sequence, target, url: 'https://r.example.com/x.tar.gz', content: `1f:${'d'.repeat(64)}`, bytes: 1, urgent: false }, key);
  let feed = addRelease({ releases: [] }, entry(1, slow)).feed;
  for (let sequence = 2; sequence <= 300; sequence++) {
    feed = addRelease(feed, entry(sequence, fast)).feed;
    assert.ok(feed.releases.length <= settings.keep_releases, `${feed.releases.length} entries at sequence ${sequence}`);
  }
  assert.equal(feed.releases.length, settings.keep_releases);
  assert.ok(feed.releases.some(one => one.target === slow && one.sequence === 1), 'the slow target\'s newest stays');
  assert.equal(feed.releases.filter(one => one.target === fast).at(-1).sequence, 300);
});

// The Workshop's tools tree: the same request with kind workshop-tools, in a work folder of its own.
const workshopOf = request => ({ ...request, kind: 'workshop-tools', work_folder: join(dirname(request.work_folder), 'workshop-work') });

test('the Workshop kind publishes the commit\'s git archive as one signed workshop-tools entry, built by nothing', async () => {
  const { remote, commits } = repository(2, { product: false });
  const { key, request, envFile, top } = builder(remote);
  writeFileSync(envFile, '');
  const workshop = workshopOf(request);
  const answer = await publish(workshop, { token: canary });
  assert.deepEqual([answer.commit, answer.sequence, answer.target, answer.urgent, answer.already_published], [commits[1], BASE_TIME + 2, 'workshop-tools', false, false]);
  assert.equal(answer.url, `https://releases.example.com/engine-releases/${commits[1]}/workshop-tools.tar.gz`);
  assert.equal(readFileSync(envFile, 'utf8'), '', 'nothing was built');

  const feed = readFeed(readFileSync(join(request.feed_folder, 'workshop-feed.json'), 'utf8'), 'workshop-feed.json');
  const entry = feed.releases.find(one => one.target === 'workshop-tools');
  assert.ok(verifyEntry(entry, key.public_key), 'the same check as an engine entry');
  assert.equal(existsSync(join(request.feed_folder, 'feed-status.json')), false, 'the engine\'s feed status is not written for the Workshop');
  const bytes = readFileSync(join(request.feed_folder, commits[1], 'workshop-tools.tar.gz'));
  assert.deepEqual([entry.bytes, entry.content], [bytes.length, makeHashCodeHexFromBytes(new Uint8Array(bytes))]);
  const tar = gunzipSync(bytes);
  assert.equal(bytes.readUInt32LE(4), 0, 'the gzip header carries no time, so the same commit packs to the same bytes');
  assert.ok(tar.includes(`comment=${commits[1]}`), 'git archive names the commit in its pax header, which install checks');
  assert.ok(tar.includes(`workshop-tools-${commits[1]}/Cargo.toml`), 'one top folder, which install strips');
  const packageFiles = untarGz(bytes, { withBytes: true }).find(file => file.name === `workshop-tools-${commits[1]}/package-files.json`);
  assert.deepEqual(JSON.parse(Buffer.from(packageFiles.bytes).toString('utf8')), packageFilesByRow({ repo: join(workshop.work_folder, 'source'), ref: commits[1] }), 'the walker\'s files for each tool row, at this commit');

  const again = join(top, 'again.tar.gz');
  await archiveRelease({ source: join(workshop.work_folder, 'source'), commit: commits[1], prefix: `workshop-tools-${commits[1]}`, file: again });
  assert.deepEqual(readFileSync(again), bytes, 'the same commit packs to the same bytes');
});

test('a Workshop commit older than the feed\'s newest workshop-tools entry is refused, and nothing changes', async () => {
  const { remote, commits } = repository(3, { product: false });
  const { request } = builder(remote);
  const workshop = workshopOf(request);
  await publish(workshop, { commit: commits[2] });
  await assert.rejects(publish(workshop, { commit: commits[1] }), error => error.exit === 3 && /older than the feed's newest/.test(error.message));
  const feed = readFeed(readFileSync(join(request.feed_folder, 'workshop-feed.json'), 'utf8'), 'workshop-feed.json');
  assert.deepEqual(feed.releases.map(entry => [entry.target, entry.sequence]), [['workshop-tools', BASE_TIME + 3]]);
  assert.deepEqual(readFeed(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8')).releases.map(entry => entry.target), ['workshop-tools'], 'the Workshop entry is mirrored into the engine feed');
});

test('a kind names a publish kind, and no Mac target is built for the Workshop', async () => {
  const { remote } = repository(1, { product: false });
  const { request } = builder(remote);
  await assert.rejects(publish({ ...request, kind: 'no-such-kind' }), error => error.exit === 2 && /not a publish kind/.test(error.message));
  await assert.rejects(publish({ ...workshopOf(request), darwin: { targets: ['aarch64-apple-darwin'], team_id: 'ABCDE12345' } }), error => error.exit === 2 && /builds no Mac targets/.test(error.message));
});

test('a signing key anyone else can read is refused', () => {
  const { remote } = repository(1);
  const { request } = builder(remote);
  chmodSync(request.key_file, 0o644);
  return assert.rejects(publish(request, {}), /may be read by others/);
});

test('the command reads the token on descriptor 3 and prints the entry on its last line', async () => {
  const { remote, commits } = repository(2);
  const { request, top } = builder(remote);
  const file = join(top, 'publish.json');
  writeFileSync(file, JSON.stringify(request));
  const ran = await new Promise(resolve => {
    const child = spawn(process.execPath, [PUBLISH, 'publish', file], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdio[3].end(canary);
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(!ran.stdout.includes(canary) && !ran.stderr.includes(canary));
  const last = JSON.parse(ran.stdout.trim().split('\n').at(-1));
  assert.deepEqual([last.commit, last.sequence], [commits[1], BASE_TIME + 2]);
  const refused = spawnSync(process.execPath, [PUBLISH, 'publish', file, '--commit', commits[0]], { encoding: 'utf8' });
  assert.equal(refused.status, 3);
  assert.match(JSON.parse(refused.stdout.trim().split('\n').at(-1)).error, /older/);
});

test('a descriptor the caller did not hand in is read as no token, whatever it holds', async () => {
  // With no descriptor 3 from the caller, that number can be Node's own event-loop descriptor (epoll, kqueue), which
  // fails to read differently on each system; a folder stands in for it here, since reading one fails on every system.
  const fd = openSync(folder(), 'r');
  try { assert.equal(await privateInput(fd), ''); } finally { closeSync(fd); }
});

test('a push delivery runs only when its signature holds and it is to the branch', async () => {
  const secret = 'push-secret-canary-9876543210', asked = [];
  const server = makeReceiver({ secret, branch: 'main', path: '/engine-release-push', queue: { ask: commit => asked.push(commit) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${server.address().port}/engine-release-push`;
  const send = (body, { event = 'push', signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } = {}) => fetch(at, { method: 'POST', body, headers: { 'x-github-event': event, 'x-hub-signature-256': signature, 'content-type': 'application/json' } });
  const push = ref => JSON.stringify({ ref, after: 'a'.repeat(40), repository: { full_name: 'owner/engine' } });
  try {
    assert.equal((await send(push('refs/heads/main'), { signature: `sha256=${'0'.repeat(64)}` })).status, 401);
    assert.equal((await send(push('refs/heads/side'))).status, 200);
    assert.equal((await send('{}', { event: 'ping' })).status, 200);
    const queued = await send(push('refs/heads/main'));
    assert.equal(queued.status, 202);
    assert.deepEqual(await queued.json(), { queued: 'a'.repeat(40) });
    assert.deepEqual(asked, ['a'.repeat(40)]);
    assert.equal((await fetch(at.replace('push', 'other'), { method: 'POST' })).status, 404);
  } finally { server.closeAllConnections(); server.close(); }
  assert.ok(!signatureHolds('', Buffer.from('x'), 'sha256=00'));
  assert.deepEqual(readDelivery('push', Buffer.from(JSON.stringify({ ref: 'refs/heads/main', deleted: true })), 'main'), { ignored: 'the branch was deleted' });
});

test('while a publish runs, only the newest asked commit waits', async () => {
  const ran = [];
  let release;
  const queue = makeQueue(commit => { ran.push(commit); return ran.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); });
  queue.ask('one');
  queue.ask('two');
  queue.ask('three');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ran, ['one']);
  release();
  while (queue.running()) await queue.running();
  assert.deepEqual(ran, ['one', 'three']);
});

test('the catch-up queues the branch tip only while a target of the feed is behind it, and stops after its attempts', async () => {
  const tip = 'c'.repeat(40), old = 'b'.repeat(40), state = folder();
  const feedWith = releases => ({ releases });
  const entry = (commit, target) => ({ commit, sequence: 1, target, url: `https://builder.example/${commit}/${target}.tar.gz`, content: `1f:${'d'.repeat(64)}`, bytes: 1, urgent: false, signature: 'e'.repeat(128) });
  assert.equal(behindFeed(feedWith([entry(tip, 'x86_64-unknown-linux-gnu'), entry(tip, 'aarch64-apple-darwin')]), tip, ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin']), false);
  assert.equal(behindFeed(feedWith([entry(tip, 'x86_64-unknown-linux-gnu'), entry(old, 'aarch64-apple-darwin')]), tip, ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin']), true);
  assert.equal(behindFeed(feedWith([]), tip, ['x86_64-unknown-linux-gnu']), true);
  assert.equal(countAttempt(state, tip), 1);
  assert.equal(countAttempt(state, tip), 2);
  assert.equal(attemptsOf(state, tip), 2);
  const asked = [];
  const queue = { running: () => null, ask: commit => asked.push(commit) };
  const token = '';
  const feedFile = join(folder(), 'feed.json');
  // A repository with its branch at `tip` and a feed holding an older release: the tip is queued.
  const repo = folder();
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'commit', '-q', '--allow-empty', '-m', 'one');
  const headCommit = sh(repo, 'rev-parse', 'HEAD');
  const url = `file://${repo}`;
  const target = 'x86_64-unknown-linux-gnu';
  writeFileSync(feedFile, JSON.stringify({ releases: [entry(old, target)] }));
  const logged = [];
  assert.equal(await catchUp({ repository: url, branch: 'main', feedFile, targets: [target], stateFolder: state, token, queue, log: line => logged.push(line) }), headCommit);
  assert.deepEqual(asked, [headCommit]);
  // The feed is at the tip: nothing is queued.
  writeFileSync(feedFile, JSON.stringify({ releases: [entry(headCommit, target)] }));
  assert.equal(await catchUp({ repository: url, branch: 'main', feedFile, targets: [target], stateFolder: state, token, queue, log: () => {} }), null);
  // A commit tried its full attempts waits for a push: nothing more is queued for it.
  writeFileSync(feedFile, JSON.stringify({ releases: [entry(old, target)] }));
  countAttempt(state, headCommit);
  countAttempt(state, headCommit);
  assert.equal(countAttempt(state, headCommit), 3);
  assert.equal(await catchUp({ repository: url, branch: 'main', feedFile, targets: [target], stateFolder: state, token, queue, log: () => {} }), null);
  // A run in progress is left to finish: the check answers nothing while the queue runs.
  assert.equal(await catchUp({ repository: url, branch: 'main', feedFile, targets: [target], stateFolder: state, token, queue: { running: () => Promise.resolve(), ask() {} }, log: () => {} }), null);
  assert.deepEqual(asked, [headCommit]);
  assert.equal(logged.length, 1);
});

test('every road in release-roads.json has a state for the commit: published, or a gap with its cause', () => {
  const commit = 'd'.repeat(40), other = 'e'.repeat(40);
  const entry = (target, c) => ({ commit: c, sequence: 1, target, url: 'https://x/y', content: `1f:${'a'.repeat(64)}`, bytes: 1, urgent: false, signature: 'b'.repeat(128) });
  const targets = roads.targets.map(row => row.triple);
  assert.ok(targets.length >= 3);
  const feed = { releases: [entry(targets[0], commit), entry(targets[1], other)] };
  const status = feedStatusOf(feed, commit, targets, { [targets[1]]: 'cargo zigbuild exited 1' });
  assert.equal(status.targets[targets[0]].state, 'published');
  assert.equal(status.targets[targets[1]].state, 'gap');
  assert.equal(status.targets[targets[1]].cause, 'cargo zigbuild exited 1');
  assert.equal(status.targets[targets[2]].state, 'gap');
  assert.equal(status.targets[targets[2]].cause, `no entry for ${commit} yet`);
});

test('install sets the builder up over SSH, and the token and secret travel only on standard input', async () => {
  const secret = 'push-secret-canary-9876543210', calls = [];
  const run = async (_machine, command, input) => {
    calls.push({ command, input: input?.pipe ? '<tarball>' : String(input ?? '') });
    if (command.includes(' make-key ')) return `${JSON.stringify({ public_key: 'a'.repeat(64), made: true })}\n`;
    if (command.includes('systemctl is-active')) return 'active\n';
    return '';
  };
  const request = { builder: { address: '192.0.2.50', host_name: 'releases.example.com' }, ssh: { known_hosts: '/x/known_hosts' }, repository: { url: 'https://github.com/owner/engine.git', branch: 'main' } };
  const answer = await installBuilder(request, { token: canary, secret, run, tarball: () => ({ pipe() {} }), fetchImpl: async () => ({ status: 200 }) });
  assert.deepEqual(answer, {
    public_key: 'a'.repeat(64), key_made: true, deploy_key: null, feed_url: 'https://releases.example.com/engine-releases/feed.json', receiver_active: true, feed_status: 200,
    webhook: { url: 'https://releases.example.com/engine-release-push', content_type: 'application/json', events: ['push'] },
    entries_url: 'https://releases.example.com/engine-release-entry', accept_entries_from: [],
  });
  for (const { command } of calls) for (const value of [canary, secret]) assert.ok(!command.includes(value), command);
  assert.equal(calls.find(call => call.command.includes('--name=push-secret')).input, secret);
  assert.equal(calls.find(call => call.command.includes('--name=repository-token')).input, canary);
  assert.match(calls[0].command, /^sh -s -- 'releases\.example\.com' '7311' '\/engine-releases\/' '\/engine-release-push' /);
  const config = JSON.parse(calls.find(call => call.command.includes(settings.on_builder.config_file)).input);
  assert.deepEqual(config, builderConfig(request));
  assert.ok(!JSON.stringify(config).includes(canary));
  const unit = calls.find(call => call.command.includes('/etc/systemd/system/')).input;
  assert.equal(unit, receiverUnit({ hasToken: true }));
  assert.match(unit, /3<"\$CREDENTIALS_DIRECTORY\/repository-token" 4<"\$CREDENTIALS_DIRECTORY\/push-secret"/);
  assert.match(receiverUnit({ hasToken: false }), /3<\/dev\/null/);
  await assert.rejects(installBuilder(request, { token: canary, secret: '', run }), /holds no push secret/);
  for (const path of SHIPPED) assert.ok(existsSync(join(here, '..', '..', '..', path)), path);
});

test('a repository reached over SSH needs no token: install makes the builder a read key and answers its public half', async () => {
  const calls = [], deployKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAmadeup user-369f4086@example.com';
  const run = async (_machine, command, input) => {
    calls.push({ command, input: input?.pipe ? '<tarball>' : String(input ?? '') });
    if (command.includes(' make-key ')) return `${JSON.stringify({ public_key: 'a'.repeat(64), made: false })}\n`;
    if (command.includes('ssh-keygen')) return `${deployKey}\n`;
    if (command.includes('systemctl is-active')) return 'active\n';
    return '';
  };
  const request = { builder: { address: '192.0.2.50', host_name: 'releases.example.com' }, ssh: { known_hosts: '/x/known_hosts' }, repository: { url: 'ssh://user-3de132cd@example.com/owner/engine.git', branch: 'main' } };
  const answer = await installBuilder(request, { secret: 'push-secret-canary', run, tarball: () => ({ pipe() {} }), fetchImpl: async () => ({ status: 200 }) });
  assert.equal(answer.deploy_key, deployKey);
  const keygen = calls.find(call => call.command.includes('ssh-keygen')).command;
  assert.match(keygen, new RegExp(`^runuser -u 'engine-builder' -- sh -c `));
  assert.ok(keygen.includes(settings.on_builder.repository_key_file) && keygen.includes('test -f'), 'an existing key is kept');
  const unit = calls.find(call => call.command.includes('/etc/systemd/system/')).input;
  assert.equal(unit, receiverUnit({ hasToken: false, sshKey: true }));
  assert.match(unit, new RegExp(`Environment="GIT_SSH_COMMAND=ssh -i ${settings.on_builder.repository_key_file} .*UserKnownHostsFile=${settings.on_builder.repository_known_hosts}"`));
  assert.match(unit, /3<\/dev\/null/);
  assert.ok(!receiverUnit({ hasToken: true }).includes('GIT_SSH_COMMAND'));
  assert.ok(calls.some(call => call.command.startsWith('rm -f') && call.command.includes('repository-token')), 'no token is kept');
});

test('git asks the credential helper, which answers the token from descriptor 3 and nothing else', async () => {
  const ran = await new Promise(resolve => {
    const child = spawn('git', ['-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`, 'credential', 'fill'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.on('close', status => resolve({ status, stdout }));
    child.stdin.end('protocol=https\nhost=example.com\n\n');
    child.stdio[3].end(canary);
  });
  assert.equal(ran.status, 0);
  assert.match(ran.stdout, new RegExp(`username=x-access-token\npassword=${canary}`));
  assert.ok(!CREDENTIAL_HELPER.includes(canary));
  await assert.rejects(runProgram('git', ['-C', folder(), 'status']), /exited 128/);
});

test('the receiver runs publish for a pushed commit and keeps how it went in last-run.json', async () => {
  const { remote, commits } = repository(2);
  const { request, top } = builder(remote);
  const configFile = join(top, 'publish.json'), stateFolder = join(top, 'state'), said = [];
  writeFileSync(configFile, JSON.stringify(request));
  const run = await runPublish({ configFile, token: canary, stateFolder, log: line => said.push(line) })(commits[1]);
  assert.equal(run.exit, 0, run.error);
  assert.equal(runInProgress(stateFolder), null, 'the run marker is gone once the run is over');
  assert.deepEqual([run.release.commit, run.release.sequence], [commits[1], BASE_TIME + 2]);
  const kept = readFileSync(join(stateFolder, 'last-run.json'), 'utf8');
  assert.deepEqual(JSON.parse(kept).release.signature, run.release.signature);
  const older = await runPublish({ configFile, token: canary, stateFolder, log: line => said.push(line) })(commits[0]);
  assert.equal(older.exit, 3);
  assert.match(older.error, /older than the feed's newest/);
  assert.ok(![kept, ...said].some(text => text.includes(canary)));
});
