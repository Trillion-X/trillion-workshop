import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { untarGz } from '../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';
import { addRelease, newSigningKey, publicKeyHex, readFeed, settings, signEntry, signedText, verifyEntry } from '../do-work/release-feed.mjs';
import { CREDENTIAL_HELPER, filesUnder, makeKey, packRelease, publish, runProgram } from '../do-work/publish-an-engine-release.mjs';
import { makeQueue, makeReceiver, readDelivery, runPublish, signatureHolds } from '../do-work/receive-pushes.mjs';
import { builderConfig, installBuilder, receiverUnit, SHIPPED, shippedTarball } from '../do-work/install-a-builder.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const PUBLISH = fileURLToPath(new URL('../do-work/publish-an-engine-release.mjs', import.meta.url));
const canary = 'repository-token-canary-0123456789';
// Each file's mode, read from its ustar header.
function modesOf(gzipped) {
  const tar = gunzipSync(gzipped), modes = {};
  for (let at = 0; tar[at]; at += 512 + Math.ceil(parseInt(tar.toString('latin1', at + 124, at + 135), 8) / 512) * 512) modes[tar.toString('latin1', at, at + 100).replace(/\0.*$/s, '')] = parseInt(tar.toString('latin1', at + 100, at + 107), 8);
  return modes;
}
const folder = () => mkdtempSync(join(tmpdir(), 'publish-an-engine-release-'));
const sh = (cwd, ...args) => {
  const ran = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' } });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
};

// A made-up engine repository: a bare "remote" whose main has `count` commits, the first with product/ in it.
function repository(count, { trailerAt } = {}) {
  const top = folder(), remote = join(top, 'remote.git'), work = join(top, 'checkout');
  mkdirSync(work);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(work, 'init', '-q', '-b', 'main');
  mkdirSync(join(work, 'product'));
  writeFileSync(join(work, 'product', 'new-accounts.json'), '{"sign_in_ways":[]}\n');
  writeFileSync(join(work, 'Cargo.toml'), '[package]\nname = "made-up"\n');
  sh(work, 'add', '.');
  sh(work, 'commit', '-q', '-m', 'first');
  for (let i = 2; i <= count; i++) sh(work, 'commit', '-q', '--allow-empty', '-m', i === trailerAt ? `change ${i}\n\nRelease-Urgent: true` : `change ${i}`);
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
  assert.deepEqual([answer.commit, answer.sequence, answer.target, answer.urgent, answer.already_published], [commits[2], 3, 'x86_64-unknown-linux-gnu', true, false]);
  assert.equal(answer.url, `https://releases.example.com/engine-releases/${commits[2]}/x86_64-unknown-linux-gnu.tar.gz`);
  assert.equal(answer.public_key, key.public_key);

  const feed = JSON.parse(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8'));
  assert.deepEqual(Object.keys(feed), ['releases']);
  const [entry] = feed.releases;
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
  assert.ok(existsSync(join(unpacked, 'product', 'new-accounts.json')));
  assert.equal(spawnSync(join(unpacked, 'trillion-local'), { encoding: 'utf8' }).stdout.trim(), `trillion-local ${commits[2]} 3`, 'built with the two release values');

  const seen = readFileSync(envFile, 'utf8');
  assert.match(seen, new RegExp(`TRILLION_RELEASE_COMMIT=${commits[2]}`));
  assert.match(seen, /TRILLION_RELEASE_SEQUENCE=3/);
  for (const text of [seen, readFileSync(join(request.work_folder, 'build.log'), 'utf8'), JSON.stringify(feed), JSON.stringify(answer)]) assert.ok(!text.includes(canary));

  const again = await publish(request, { token: canary });
  assert.equal(again.already_published, true, 'the same commit again changes nothing');
  assert.equal(JSON.parse(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8')).releases.length, 1);
});

test('a release and the shipped files pack with no tar program: same bytes and executable bit back, no __pycache__ shipped', () => {
  const top = folder(), program = join(top, 'bin', 'trillion-local'), source = join(top, 'source'), file = join(top, 'release.tar.gz');
  mkdirSync(join(top, 'bin'));
  mkdirSync(join(source, 'product', 'deep', '__pycache__'), { recursive: true });
  writeFileSync(program, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 255]), { mode: 0o755 });
  writeFileSync(join(source, 'product', 'deep', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(source, 'product', 'data.json'), '{}\n', { mode: 0o644 });
  writeFileSync(join(source, 'product', 'deep', '__pycache__', 'x.pyc'), 'cache');
  const packed = packRelease({ program, source, file }), bytes = readFileSync(file);
  assert.deepEqual(packed, { content: makeHashCodeHexFromBytes(new Uint8Array(bytes)), bytes: bytes.length });
  const files = untarGz(bytes, { withBytes: true });
  assert.deepEqual(files.map(entry => entry.name), ['product/data.json', 'product/deep/__pycache__/x.pyc', 'product/deep/run.sh', 'trillion-local']);
  for (const entry of files) assert.deepEqual(Buffer.from(entry.bytes), readFileSync(entry.name === 'trillion-local' ? program : join(source, entry.name)), entry.name);
  assert.deepEqual(modesOf(bytes), { 'product/data.json': 0o644, 'product/deep/__pycache__/x.pyc': 0o644, 'product/deep/run.sh': 0o755, 'trillion-local': 0o755 });
  packRelease({ program, source, file: `${file}.again` });
  assert.deepEqual(readFileSync(`${file}.again`), bytes, 'the same files pack to the same bytes');

  assert.deepEqual(filesUnder(source, ['product'], ['__pycache__']).map(entry => entry.name), ['product/data.json', 'product/deep/run.sh']);
  const shipped = untarGz(shippedTarball()).map(entry => entry.name);
  for (const name of SHIPPED.filter(path => /\.m?js$/.test(path))) assert.ok(shipped.includes(name), name);
  assert.ok(shipped.includes('tools/publish-an-engine-release/do-work/publish-an-engine-release.mjs'));
  assert.ok(!shipped.some(name => name.includes('__pycache__')));
});

test('a commit older than the feed\'s newest is refused before it is built', async () => {
  const { remote, commits } = repository(3);
  const { request, envFile } = builder(remote);
  await publish(request, { commit: commits[2] });
  writeFileSync(envFile, '');
  await assert.rejects(publish(request, { commit: commits[1] }), error => error.exit === 3 && /sequence 2, older than the feed's newest/.test(error.message));
  assert.equal(readFileSync(envFile, 'utf8'), '', 'nothing was built');
  const feed = readFeed(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8'));
  assert.deepEqual(feed.releases.map(entry => entry.sequence), [3]);
  await assert.rejects(publish(request, { commit: 'f'.repeat(40) }), /not on main's first-parent line/);
});

test('the feed keeps the newest 32 releases, and an older one leaves with its tar.gz', async () => {
  const { remote, commits } = repository(33);
  const { request } = builder(remote);
  const privateKey = readFileSync(request.key_file, 'utf8'), target = 'x86_64-unknown-linux-gnu';
  const seeded = commits.slice(0, 32).map((commit, at) => {
    mkdirSync(join(request.feed_folder, commit), { recursive: true });
    writeFileSync(join(request.feed_folder, commit, `${target}.tar.gz`), 'made-up');
    return signEntry({ commit, sequence: at + 1, target, url: `${request.base_url}${commit}/${target}.tar.gz`, content: `1f:${'c'.repeat(64)}`, bytes: 7, urgent: false }, privateKey);
  });
  writeFileSync(join(request.feed_folder, 'feed.json'), JSON.stringify({ releases: seeded }));
  const answer = await publish(request, {});
  assert.deepEqual([answer.sequence, answer.dropped, answer.releases_held], [33, 1, 32]);
  const feed = readFeed(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8'));
  assert.deepEqual(feed.releases.map(entry => entry.sequence), Array.from({ length: 32 }, (_, at) => at + 2), 'newest last');
  assert.ok(!existsSync(join(request.feed_folder, commits[0])), 'the dropped release\'s tar.gz is gone');
  assert.ok(existsSync(join(request.feed_folder, commits[1], `${target}.tar.gz`)));
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
  assert.deepEqual([last.commit, last.sequence], [commits[1], 2]);
  const refused = spawnSync(process.execPath, [PUBLISH, 'publish', file, '--commit', commits[0]], { encoding: 'utf8' });
  assert.equal(refused.status, 3);
  assert.match(JSON.parse(refused.stdout.trim().split('\n').at(-1)).error, /older/);
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
    public_key: 'a'.repeat(64), key_made: true, feed_url: 'https://releases.example.com/engine-releases/feed.json', receiver_active: true, feed_status: 200,
    webhook: { url: 'https://releases.example.com/engine-release-push', content_type: 'application/json', events: ['push'] },
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
  assert.deepEqual([run.release.commit, run.release.sequence], [commits[1], 2]);
  const kept = readFileSync(join(stateFolder, 'last-run.json'), 'utf8');
  assert.deepEqual(JSON.parse(kept).release.signature, run.release.signature);
  const older = await runPublish({ configFile, token: canary, stateFolder, log: line => said.push(line) })(commits[0]);
  assert.equal(older.exit, 3);
  assert.match(older.error, /older than the feed's newest/);
  assert.ok(![kept, ...said].some(text => text.includes(canary)));
});
