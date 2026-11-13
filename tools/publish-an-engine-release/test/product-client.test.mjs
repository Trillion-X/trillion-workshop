// A release carries the web client its commit pins: the builder fetches the pinned commit of the client repository, builds it
// once per pin with the pin's own build, lays it at product/<into> of every target's release, and signs no release without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { getPriority, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { untarGz } from '../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';
import { readFeed, settings, verifyEntry } from '../do-work/release-feed.mjs';
import { buildArguments, checkProductPin, makeKey, publish } from '../do-work/publish-an-engine-release.mjs';
import { builderConfig, checkRequest, installBuilder, receiverUnit } from '../do-work/install-a-builder.mjs';
import { gitSshCommand, overSsh } from '../do-work/git-ssh.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const folder = () => mkdtempSync(join(tmpdir(), 'engine-release-client-'));
const BASE_TIME = 1_800_000_000;
const git = (cwd, ...args) => {
  const extra = typeof args.at(-1) === 'object' ? args.pop().env : {};
  const ran = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com', ...extra } });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
};
const at = n => ({ env: { GIT_COMMITTER_DATE: `${BASE_TIME + n} +0000`, GIT_AUTHOR_DATE: `${BASE_TIME + n} +0000` } });

// A made-up client repository: its build script lays the folder a release carries (a selection naming the commit, a built file,
// and whether the engine checkout sat beside the client's) and counts its runs in the file FAKE_CLIENT_COUNTER names.
function clientRepository({ failing = false } = {}) {
  const top = folder(), remote = join(top, 'remote.git'), work = join(top, 'checkout');
  mkdirSync(join(work, 'scripts'), { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'scripts', 'build.mjs'), `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const args = process.argv.slice(2), at = name => args[args.indexOf(name) + 1];
fs.appendFileSync(process.env.FAKE_CLIENT_COUNTER, 'built\\n');
if (${JSON.stringify(failing)}) { console.error('the client build did not pass'); process.exit(1); }
const out = at('--out');
fs.mkdirSync(path.join(out, 'built'), { recursive: true });
fs.writeFileSync(path.join(out, 'frontend-selection.json'), at('--commit'));
fs.writeFileSync(path.join(out, 'built', 'index.js'), 'client');
fs.writeFileSync(path.join(out, 'niceness.txt'), String(os.getPriority()));
fs.writeFileSync(path.join(out, 'engine-beside.txt'), String(fs.existsSync(path.join(at('--checkout'), '..', 'made-up-engine', 'Cargo.toml'))));
`);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'client', at(1));
  const first = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'changed.txt'), 'a later client commit');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'later client', at(2));
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');
  return { top, remote, commit: first, later: git(work, 'rev-parse', 'HEAD') };
}

const pinOf = (client, extra = {}) => ({ repository: client.remote, commit: client.commit, into: 'local-workspace', checkout_folder: 'made-up-client', engine_folder: 'made-up-engine',
  build: ['node', 'scripts/build.mjs', '--checkout', '{checkout}', '--commit', '{commit}', '--out', '{out}'], ...extra });

// A made-up engine repository whose main has one commit per entry of `commits`, each a map of file -> text (null deletes).
function engineRepository(commits) {
  const top = folder(), remote = join(top, 'remote.git'), work = join(top, 'checkout');
  mkdirSync(work);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(work, 'init', '-q', '-b', 'main');
  mkdirSync(join(work, 'test-helpers'));
  writeFileSync(join(work, 'test-helpers', 'tool-row-imports.json'), '{"provided_by_the_system":[]}\n');
  writeFileSync(join(work, 'package-lock.json'), '{"packages":{}}\n');
  writeFileSync(join(work, 'Cargo.toml'), '[package]\nname = "made-up"\n');
  git(work, 'remote', 'add', 'origin', remote);
  commits.forEach((files, index) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, name)), { recursive: true });
      writeFileSync(join(work, name), text);
    }
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '--allow-empty', '-m', `change ${index + 1}`, at(index + 2));
  });
  git(work, 'push', '-q', 'origin', 'main');
  return { top, remote, commits: git(work, 'rev-list', '--reverse', '--first-parent', 'main').split('\n') };
}

function builder(remote, product) {
  const top = folder();
  makeKey(join(top, 'key', 'release-signing.key'));
  process.env.FAKE_CARGO_ENV = join(top, 'cargo-env');
  process.env.FAKE_CLIENT_COUNTER = join(top, 'client-builds');
  writeFileSync(process.env.FAKE_CLIENT_COUNTER, '');
  return { top, request: {
    repository: remote, branch: 'main', base_url: 'https://releases.example.com/engine-releases/',
    work_folder: join(top, 'work'), feed_folder: join(top, 'feed'), key_file: join(top, 'key', 'release-signing.key'),
    toolchain: { cargo: join(here, 'fake-cargo'), rustc: join(here, 'fake-rustc') },
    ...(product ? { product_client: { repository: product } } : {}),
  } };
}

const buildsOf = () => readFileSync(process.env.FAKE_CLIENT_COUNTER, 'utf8').split('\n').filter(Boolean).length;
const filesOf = (request, commit, target) => Object.fromEntries(untarGz(readFileSync(join(request.feed_folder, commit, `${target}.tar.gz`)), { withBytes: true }).map(file => [file.name, Buffer.from(file.bytes).toString('utf8')]));
const pinFile = pin => ({ 'product-client.json': `${JSON.stringify(pin)}\n` });

test('every target of a release carries the client its commit pins under product/<into>, built once', async () => {
  const client = clientRepository();
  const { remote, commits } = engineRepository([pinFile(pinOf(client))]);
  const { request } = builder(remote, client.remote);
  const answer = await publish(request);
  const feed = readFeed(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8'));
  assert.ok(feed.releases.length >= 2, 'the host and the zigbuild road were published');
  for (const entry of feed.releases) {
    assert.ok(verifyEntry(entry, answer.public_key));
    const files = filesOf(request, commits[0], entry.target);
    assert.equal(files['product/local-workspace/frontend-selection.json'], client.commit, `${entry.target} carries the pinned client`);
    assert.equal(files['product/local-workspace/built/index.js'], 'client');
    // `nice` adds the pin's priority to the test's own and stops at the system's largest (19 or 20); a test already there has no room to lower.
    assert.ok(Number(files['product/local-workspace/niceness.txt']) > getPriority() || getPriority() >= 19, 'the client build ran at a lower priority than the program that started it');
    assert.equal(files['product/local-workspace/engine-beside.txt'], 'true', 'the engine checkout sat beside the client checkout');
    assert.ok(files['trillion-local'] !== undefined);
  }
  assert.equal(buildsOf(), 1, 'one build served every target');
  assert.equal(existsSync(join(request.work_folder, 'source', 'product')), false, 'the client is packed, never written into the engine checkout');
});

test('a later release with the same pin reuses the built client, and a changed pin builds the new one', async () => {
  const client = clientRepository();
  const { remote, commits } = engineRepository([pinFile(pinOf(client)), { 'notes.txt': 'engine change' }, pinFile(pinOf(client, { commit: client.later }))]);
  const { request } = builder(remote, client.remote);
  await publish(request, { commit: commits[0] });
  await publish(request, { commit: commits[1] });
  assert.equal(buildsOf(), 1, 'the second release has the same pin');
  assert.equal(filesOf(request, commits[1], 'x86_64-unknown-linux-gnu')['product/local-workspace/frontend-selection.json'], client.commit);
  await publish(request, { commit: commits[2] });
  assert.equal(buildsOf(), 2, 'the changed pin built its client');
  assert.equal(filesOf(request, commits[2], 'x86_64-unknown-linux-gnu')['product/local-workspace/frontend-selection.json'], client.later);
  assert.equal(filesOf(request, commits[1], 'x86_64-unknown-linux-gnu')['product/local-workspace/frontend-selection.json'], client.commit, 'the older release keeps its own client');
});

test('a commit with no pin file carries no client, and a builder that reads no client repository publishes it unchanged', async () => {
  const { remote, commits } = engineRepository([{ 'notes.txt': 'engine only' }]);
  const { request } = builder(remote, null);
  await publish(request);
  assert.deepEqual(Object.keys(filesOf(request, commits[0], 'x86_64-unknown-linux-gnu')).sort(), ['product/bin/trillion-mcp-forwarder', 'trillion-local']);
  assert.equal(buildsOf(), 0);
});

test('a failing client build, a pin for another repository and a builder with no client repository each publish nothing', async () => {
  const failing = clientRepository({ failing: true });
  const pins = [
    [failing, pinOf(failing), failing.remote, /did not pass|exited 1/],
    [failing, pinOf(failing, { repository: 'ssh://git@example.com/other.git' }), failing.remote, /not the one this builder reads/],
    [failing, pinOf(failing), null, /names no product_client\.repository/],
  ];
  for (const [, pin, allowed, message] of pins) {
    const { remote } = engineRepository([pinFile(pin)]);
    const { request } = builder(remote, allowed);
    await assert.rejects(publish(request), message);
    assert.equal(existsSync(join(request.feed_folder, 'feed.json')), false, 'nothing was added to the feed');
  }
});

test('a commit that holds its own product/<into> and pins a client for it is refused', async () => {
  const client = clientRepository();
  const { remote } = engineRepository([{ ...pinFile(pinOf(client)), 'product/local-workspace/frontend-selection.json': 'its own' }]);
  const { request } = builder(remote, client.remote);
  await assert.rejects(publish(request), /holds one or the other/);
});

test('a pin is checked field by field: its repository, commit, folders and build', () => {
  const good = { repository: 'ssh://git@example.com/client.git', commit: 'a'.repeat(40), into: 'local-workspace', checkout_folder: 'client', engine_folder: 'engine', build: ['node', 'x.mjs', '--out', '{out}'] };
  assert.equal(checkProductPin(good, good.repository), good);
  for (const [change, message] of [
    [{ repository: 'https://example.com/other.git' }, /not the one this builder reads/],
    [{ commit: 'abc' }, /full lowercase hex/],
    [{ into: '../x' }, /into must be one plain folder name/],
    [{ checkout_folder: 'a/b' }, /checkout_folder must be one plain/],
    [{ engine_folder: 'client' }, /must differ/],
    [{ build: [] }, /build must be/],
    [{ build: ['sh', '-c', '{out}'] }, /not one of node/],
    [{ build: ['node', '{elsewhere}', '{out}'] }, /placeholder other than/],
    [{ build: ['node', 'x.mjs'] }, /must name \{out\}/],
    [{ extra: 1 }, /unknown field extra/],
  ]) assert.throws(() => checkProductPin({ ...good, ...change }, good.repository), message);
  assert.throws(() => checkProductPin(null, good.repository), /must be a JSON object/);
  assert.deepEqual(buildArguments(good, { checkout: '/c', commit: good.commit, out: '/o' }), ['node', 'x.mjs', '--out', '/o']);
});

test('install asks for the client repository once, makes its own key for it and writes it into the builder config', () => {
  const request = { builder: { address: '203.0.113.5', host_name: 'releases.example.com' }, ssh: { known_hosts: '/k' }, repository: { url: 'ssh://git@example.com/engine.git', branch: 'main' },
    product_client: { repository: 'ssh://git@example.com/client.git' } };
  assert.equal(checkRequest(request), request);
  assert.deepEqual(builderConfig(request).product_client, { repository: 'ssh://git@example.com/client.git' });
  assert.equal(builderConfig({ ...request, product_client: undefined }).product_client, undefined);
  assert.throws(() => checkRequest({ ...request, product_client: { repository: 'file:///x' } }), /product_client\.repository/);
  assert.ok(overSsh(request.product_client.repository));
  assert.match(gitSshCommand(settings.on_builder.product_key_file), new RegExp(`-i ${settings.on_builder.product_key_file} -o IdentitiesOnly=yes`));
  assert.notEqual(settings.on_builder.product_key_file, settings.on_builder.repository_key_file, 'a deploy key belongs to one repository');
});

test('install makes the web client repository its own read key, apart from the engine repository\'s, and answers its public half', async () => {
  const calls = [], keys = { engine: 'ssh-ed25519 AAAAengine', client: 'ssh-ed25519 AAAAclient' };
  const run = async (_machine, command, input) => {
    calls.push({ command, input: input?.pipe ? '<tarball>' : String(input ?? '') });
    if (command.includes(' make-key ')) return `${JSON.stringify({ public_key: 'a'.repeat(64), made: false })}\n`;
    if (command.includes('ssh-keygen')) return `${command.includes(settings.on_builder.product_key_file) ? keys.client : keys.engine}\n`;
    if (command.includes('systemctl is-active')) return 'active\n';
    return '';
  };
  const request = { builder: { address: '192.0.2.50', host_name: 'releases.example.com' }, ssh: { known_hosts: '/x/known_hosts' }, repository: { url: 'ssh://git@example.com/owner/engine.git', branch: 'main' },
    product_client: { repository: 'ssh://git@example.com/owner/client.git' } };
  const answer = await installBuilder(request, { secret: 'push-secret-canary', run, tarball: () => ({ pipe() {} }), fetchImpl: async () => ({ status: 200 }) });
  assert.deepEqual([answer.deploy_key, answer.product_deploy_key], [keys.engine, keys.client]);
  const keygens = calls.filter(call => call.command.includes('ssh-keygen')).map(call => call.command);
  assert.equal(keygens.length, 2);
  assert.ok(keygens.every(command => command.includes('test -f')), 'an existing key is kept');
  const config = JSON.parse(calls.find(call => call.command.includes(settings.on_builder.config_file)).input);
  assert.deepEqual(config.product_client, { repository: request.product_client.repository });
  assert.equal(calls.find(call => call.command.includes('/etc/systemd/system/')).input, receiverUnit({ hasToken: false, sshKey: true }), 'the receiver\'s default key stays the engine repository\'s');
});
