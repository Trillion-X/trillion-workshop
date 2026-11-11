// One feed holds every target: another builder (one per target it builds for) packs and signs its own release, and
// the feed's builder takes it (`accept`) into the same feed, signed again with its own key, so every follower's
// existing public keys take it. A target is data: these tests name made-up triples beside the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { addRelease, newSigningKey, publicKeyHex, readFeed, settings, signEntry, verifyEntry } from '../do-work/release-feed.mjs';
import { accept, makeKey, withFeedLock } from '../do-work/publish-an-engine-release.mjs';
import { contribute, entryHeader, packAndSign, readEntryHeader } from '../do-work/contribute-an-engine-release.mjs';
import { makeReceiver, makeTargetQueues, readOffer } from '../do-work/receive-pushes.mjs';
import { builderConfig, checkRequest } from '../do-work/install-a-builder.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'engine-release-targets-'));
// A release's sequence is its commit's time in seconds; the made-up repository's commit n is made at BASE_TIME + n.
const BASE_TIME = 1_800_000_000;
const git = (cwd, ...args) => {
  const extra = typeof args.at(-1) === 'object' ? args.pop().env : {};
  const ran = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com', ...extra } });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
};

// A made-up engine repository with `count` commits on main, pushed to a bare remote, and a checkout of it (the other
// builder's) with a built program in it.
function engine(count) {
  const top = folder(), remote = join(top, 'remote.git'), work = join(top, 'checkout');
  mkdirSync(join(work, 'product'), { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'product', 'new-accounts.json'), '{"sign_in_ways":[]}\n');
  git(work, 'add', '.');
  const at = n => ({ env: { GIT_COMMITTER_DATE: `${BASE_TIME + n} +0000`, GIT_AUTHOR_DATE: `${BASE_TIME + n} +0000` } });
  git(work, 'commit', '-q', '-m', 'first', at(1));
  for (let i = 2; i <= count; i++) git(work, 'commit', '-q', '--allow-empty', '-m', `change ${i}`, at(i));
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');
  const program = join(top, 'built', 'trillion-local');
  mkdirSync(join(top, 'built'));
  writeFileSync(program, '#!/bin/sh\necho made-up engine\n');
  chmodSync(program, 0o755);
  writeFileSync(join(top, 'built', 'trillion-mcp-forwarder'), '#!/bin/sh\necho made-up forwarder\n');
  chmodSync(join(top, 'built', 'trillion-mcp-forwarder'), 0o755);
  return { top, remote, work, program, commits: git(work, 'rev-list', '--reverse', '--first-parent', 'main').split('\n') };
}

// The feed's builder: its key and the config accept reads, accepting `accepted`.
function feedBuilder(remote, accepted) {
  const top = folder();
  const key = makeKey(join(top, 'key', 'release-signing.key'));
  return {
    key,
    config: {
      repository: remote, branch: 'main', base_url: 'https://releases.example.com/engine-releases/',
      work_folder: join(top, 'work'), feed_folder: join(top, 'feed'), key_file: join(top, 'key', 'release-signing.key'),
      accept_entries_from: accepted,
    },
  };
}

test('trimming the feed never drops a target\'s newest entry, whatever the other targets publish', () => {
  const key = newSigningKey();
  const entry = (n, target) => signEntry({ commit: n.toString(16).padStart(40, '0'), sequence: n, target, url: 'https://r.example.com/x.tar.gz', content: `1f:${'d'.repeat(64)}`, bytes: 1, urgent: false }, key);
  let feed = addRelease({ releases: [] }, entry(1, 'aarch64-apple-darwin')).feed;
  for (let n = 2; n <= 60; n++) feed = addRelease(feed, entry(n, n % 2 ? 'x86_64-unknown-linux-gnu' : 'riscv64gc-unknown-linux-gnu')).feed;
  assert.equal(feed.releases.length, settings.keep_releases);
  const targets = [...new Set(feed.releases.map(one => one.target))].sort();
  assert.deepEqual(targets, ['aarch64-apple-darwin', 'riscv64gc-unknown-linux-gnu', 'x86_64-unknown-linux-gnu']);
  assert.equal(feed.releases.find(one => one.target === 'aarch64-apple-darwin').sequence, 1, 'the lagging target keeps its one release');
  assert.equal(feed.releases.at(-1).sequence, 60);
});

test('another builder\'s signed entry joins the one feed, signed again by the feed\'s builder', async () => {
  const { remote, work, program, commits } = engine(4);
  const theirs = newSigningKey();
  const { key, config } = feedBuilder(remote, [publicKeyHex(theirs)]);
  for (const target of ['aarch64-apple-darwin', 'aarch64-unknown-linux-gnu']) {
    const { entry, body } = await packAndSign({ source: work, program, target }, theirs);
    assert.deepEqual([entry.commit, entry.sequence, entry.target, entry.url], [commits[3], BASE_TIME + 4, target, undefined]);
    assert.ok(verifyEntry({ ...entry }, publicKeyHex(theirs)), 'signed by the other builder');
    const answer = await accept(config, { entry, body });
    assert.deepEqual([answer.already_published, answer.target, answer.url], [false, target, `https://releases.example.com/engine-releases/${commits[3]}/${target}.tar.gz`]);
    const names = gunzipSync(readFileSync(join(config.feed_folder, commits[3], `${target}.tar.gz`))).toString('latin1');
    assert.match(names, /trillion-local/);
    assert.match(names, /product\/new-accounts\.json/);
  }
  const feed = readFeed(readFileSync(join(config.feed_folder, 'feed.json'), 'utf8'));
  assert.deepEqual(feed.releases.map(one => one.target), ['aarch64-apple-darwin', 'aarch64-unknown-linux-gnu']);
  for (const one of feed.releases) {
    assert.ok(verifyEntry(one, key.public_key), 'every follower\'s existing key takes it');
    assert.ok(!verifyEntry(one, publicKeyHex(theirs)), 'the served signature is the feed builder\'s own');
  }
  const { entry, body } = await packAndSign({ source: work, program, target: 'aarch64-apple-darwin' }, theirs);
  assert.equal((await accept(config, { entry, body })).already_published, true, 'the same release again is answered, not added');
  assert.equal(readFeed(readFileSync(join(config.feed_folder, 'feed.json'), 'utf8')).releases.length, 2);
});

test('accept refuses a key it does not take, a body that is not the entry\'s, a wrong sequence and an older commit', async () => {
  const { remote, work, program, commits } = engine(3);
  const theirs = newSigningKey(), stranger = newSigningKey();
  const { config } = feedBuilder(remote, [publicKeyHex(theirs)]);
  const target = 'aarch64-apple-darwin';
  const signed = await packAndSign({ source: work, program, target }, stranger);
  await assert.rejects(accept(config, signed), /release_signature_refused/);
  const good = await packAndSign({ source: work, program, target }, theirs);
  await assert.rejects(accept(config, { entry: good.entry, body: Buffer.concat([good.body, Buffer.from('x')]) }), /release_content_mismatch/);
  const lying = await packAndSign({ source: work, program, target, sequence: 9 }, theirs);
  await assert.rejects(accept(config, lying), new RegExp(`but it is ${BASE_TIME + 3}`));
  assert.ok(!existsSync(join(config.feed_folder, 'feed.json')), 'nothing refused reached the feed');
  await accept(config, good);
  git(work, 'checkout', '-q', commits[1]);
  const older = await packAndSign({ source: work, program, target }, theirs);
  await assert.rejects(accept(config, older), /older than the feed's newest/);
  await assert.rejects(accept({ ...config, accept_entries_from: [] }, good), /accepts no other builder's entries/);
});

test('contribute sends the tar.gz as the body and the signed entry in one header, and the key never in either', async () => {
  const { work, program, commits } = engine(2);
  const theirs = newSigningKey();
  let sent;
  const fetchImpl = async (url, options) => { sent = { url, ...options }; return new Response(JSON.stringify({ queued: commits[1] }), { status: 202 }); };
  const answer = await contribute({ source: work, program, target: 'aarch64-apple-darwin', entries_url: 'https://releases.example.com/engine-release-entry' }, theirs, { fetchImpl });
  assert.deepEqual([answer.commit, answer.sequence, answer.target, answer.builder.queued], [commits[1], BASE_TIME + 2, 'aarch64-apple-darwin', commits[1]]);
  const entry = readEntryHeader(sent.headers[settings.entry_header]);
  assert.ok(verifyEntry(entry, publicKeyHex(theirs)));
  assert.equal(sent.body.length, entry.bytes);
  const wire = JSON.stringify(sent.headers) + Buffer.from(sent.body).toString('latin1');
  assert.ok(!wire.includes(theirs.split('\n')[1]), 'no line of the private key is sent');
  await assert.rejects(contribute({ source: work, program, entries_url: 'http://plain.example.com/x' }, theirs, { fetchImpl }), /https/);
});

test('the receiver checks an entry\'s signature before it reads the body, and queues each target apart', async () => {
  const { work, program } = engine(2);
  const theirs = newSigningKey(), stranger = newSigningKey(), state = folder(), asked = [];
  const entries = { accepted: [publicKeyHex(theirs)], path: settings.entry_path, folder: join(state, 'entries'), queue: { ask: offer => asked.push(offer) } };
  const server = makeReceiver({ secret: 's', branch: 'main', path: settings.push_path, queue: { ask() {} }, entries });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${server.address().port}${settings.entry_path}`;
  const send = ({ entry, body }) => fetch(at, { method: 'POST', body, headers: { [settings.entry_header]: entryHeader(entry) } });
  try {
    assert.equal((await send(await packAndSign({ source: work, program, target: 'aarch64-apple-darwin' }, stranger))).status, 401);
    assert.equal((await fetch(at, { method: 'POST', body: 'x', headers: { [settings.entry_header]: 'not base64 json!' } })).status, 400);
    assert.equal(asked.length, 0);
    const good = await packAndSign({ source: work, program, target: 'aarch64-apple-darwin' }, theirs);
    const queued = await send(good);
    assert.equal(queued.status, 202);
    assert.deepEqual(await queued.json(), { queued: good.entry.commit, target: 'aarch64-apple-darwin' });
    assert.equal(asked.length, 1);
    assert.deepEqual(readFileSync(asked[0].bodyFile), good.body);
    assert.deepEqual(JSON.parse(readFileSync(asked[0].entryFile, 'utf8')), good.entry);
  } finally { server.closeAllConnections(); server.close(); }
  assert.equal(readOffer(entryHeader({ target: 'Not A Triple' }), entries.accepted).status, 400);
});

test('per-target queues: one target never waits behind another, and a replaced waiting entry\'s files leave', async () => {
  const state = folder(), ran = [], release = {};
  const offer = (target, n) => {
    const entryFile = join(state, `${target}-${n}.json`), bodyFile = join(state, `${target}-${n}.tar.gz`);
    writeFileSync(entryFile, '{}'); writeFileSync(bodyFile, 'x');
    return { target, commit: String(n), entryFile, bodyFile };
  };
  const queues = makeTargetQueues(one => { ran.push(`${one.target}:${one.commit}`); return new Promise(resolve => { release[`${one.target}:${one.commit}`] = resolve; }); });
  queues.ask(offer('aarch64-apple-darwin', 1));
  queues.ask(offer('aarch64-apple-darwin', 2));
  queues.ask(offer('aarch64-apple-darwin', 3));
  queues.ask(offer('aarch64-unknown-linux-gnu', 1));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ran, ['aarch64-apple-darwin:1', 'aarch64-unknown-linux-gnu:1']);
  assert.ok(!existsSync(join(state, 'aarch64-apple-darwin-2.tar.gz')), 'the replaced waiting entry is removed');
  assert.ok(existsSync(join(state, 'aarch64-apple-darwin-3.tar.gz')));
  release['aarch64-apple-darwin:1']();
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ran, ['aarch64-apple-darwin:1', 'aarch64-unknown-linux-gnu:1', 'aarch64-apple-darwin:3']);
});

test('the feed lock waits for a live holder and then runs', async () => {
  const feed = folder(), order = [];
  let let_go;
  const first = withFeedLock(feed, () => new Promise(resolve => { order.push('first'); let_go = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const second = withFeedLock(feed, async () => { order.push('second'); });
  setTimeout(() => let_go(), 250);
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
  assert.ok(!readdirSync(feed).includes('.publish.lock'));
});

test('install takes the other builders\' keys into the config, and refuses one that is not 64 hex', () => {
  const request = { builder: { address: '192.0.2.1', host_name: 'releases.example.com' }, ssh: { known_hosts: '/k' }, repository: { url: 'https://example.com/e.git', branch: 'main' } };
  const key = publicKeyHex(newSigningKey());
  const config = builderConfig(checkRequest({ ...request, accept_entries_from: [key] }));
  assert.deepEqual(config.accept_entries_from, [key]);
  assert.equal(config.receiver.entry_path, settings.entry_path);
  assert.deepEqual(builderConfig(checkRequest(request)).accept_entries_from, []);
  assert.throws(() => checkRequest({ ...request, accept_entries_from: ['ABC'] }), /64 lowercase hex/);
});
