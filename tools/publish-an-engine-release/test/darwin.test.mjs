// The Mac target, built by the feed's own builder: after its own target, publish cross-builds the same commit for
// aarch64-apple-darwin (the fake cargo's `zigbuild`), signs it Developer ID with the hardened runtime (a fake rcodesign
// whose signature info is modelled on rcodesign 0.29's), holds the signature to the requirement trillion-apps
// CarriedCode.checkRelease admits a release by, and adds its own entry to the same feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { untarGz } from '../../keep-and-wake-ai-sessions-on-this-computer/src/tar-gz.mjs';
import { settings, verifyEntry } from '../do-work/release-feed.mjs';
import { checkDeveloperId, darwinOf, makeKey, publish } from '../do-work/publish-an-engine-release.mjs';
import { builderConfig, checkRequest, developerIdentity, installBuilder, receiverUnit } from '../do-work/install-a-builder.mjs';
import { runPublish } from '../do-work/receive-pushes.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const PUBLISH = fileURLToPath(new URL('../do-work/publish-an-engine-release.mjs', import.meta.url));
const MAC = 'aarch64-apple-darwin', LINUX = 'x86_64-unknown-linux-gnu', ZIG = 'aarch64-unknown-linux-gnu', TEAM = 'ABCDE12345';
const identityCanary = 'p12-bytes-canary-0123456789', passwordCanary = 'p12-password-canary-9876543210';
const folder = () => mkdtempSync(join(tmpdir(), 'engine-release-darwin-'));
const BASE_TIME = 1_800_000_000;
const git = (cwd, ...args) => {
  const extra = typeof args.at(-1) === 'object' ? args.pop().env : {};
  const ran = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com', ...extra } });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
};

function repository(count) {
  const top = folder(), remote = join(top, 'remote.git'), work = join(top, 'checkout');
  mkdirSync(join(work, 'product'), { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'product', 'new-accounts.json'), '{"sign_in_ways":[]}\n');
  writeFileSync(join(work, 'Cargo.toml'), '[package]\nname = "made-up"\n');
  git(work, 'add', '.');
  const at = n => ({ env: { GIT_COMMITTER_DATE: `${BASE_TIME + n} +0000`, GIT_AUTHOR_DATE: `${BASE_TIME + n} +0000` } });
  git(work, 'commit', '-q', '-m', 'first', at(1));
  for (let i = 2; i <= count; i++) git(work, 'commit', '-q', '--allow-empty', '-m', `change ${i}`, at(i));
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');
  return { remote, commits: git(work, 'rev-list', '--reverse', '--first-parent', 'main').split('\n') };
}

// A builder with darwin in its config: its key, the credentials folder systemd would open (the identity and its
// password, canaries here), a made-up SDK, and the fakes. FAKE_* files tell what the build and rcodesign saw.
function builder(remote, darwin = {}) {
  const top = folder();
  const key = makeKey(join(top, 'key', 'release-signing.key'));
  const credentials = join(top, 'credentials'), sdk = join(top, 'MacOSX.sdk');
  mkdirSync(credentials, { mode: 0o700 });
  writeFileSync(join(credentials, settings.darwin.credentials.identity), identityCanary, { mode: 0o400 });
  writeFileSync(join(credentials, settings.darwin.credentials.password), passwordCanary, { mode: 0o400 });
  mkdirSync(sdk);
  writeFileSync(join(sdk, 'SDKSettings.json'), '{"Version":"14.5"}\n');
  const seen = { cargo: join(top, 'cargo-env'), zig: join(top, 'zig-env'), rcodesign: join(top, 'rcodesign-args') };
  Object.assign(process.env, { FAKE_CARGO_ENV: seen.cargo, FAKE_CARGO_ZIG_ENV: seen.zig, FAKE_RCODESIGN_ARGS: seen.rcodesign });
  const request = {
    repository: remote, branch: 'main', base_url: 'https://releases.example.com/engine-releases/',
    work_folder: join(top, 'work'), feed_folder: join(top, 'feed'), key_file: join(top, 'key', 'release-signing.key'),
    toolchain: { cargo: join(here, 'fake-cargo'), rustc: join(here, 'fake-rustc'), rcodesign: join(here, 'fake-rcodesign'), zig_python: '/opt/made-up/zig/bin/python3' },
    darwin: { targets: [MAC], team_id: TEAM, sdk_root: sdk, ...darwin },
  };
  return { top, key, request, credentials, sdk, seen };
}

// Each test sets only the FAKE_* it means; nothing one sets reaches the next.
const withFakes = async (values, work) => {
  const names = ['FAKE_RCODESIGN_TEAM', 'FAKE_RCODESIGN_FLAGS', 'FAKE_RCODESIGN_NOT_APPLE', 'FAKE_RCODESIGN_NO_DEVID', 'FAKE_CARGO_ZIG_FAIL'];
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
  try { return await work(); } finally { for (const name of names) delete process.env[name]; }
};
const feedOf = request => JSON.parse(readFileSync(join(request.feed_folder, 'feed.json'), 'utf8'));
const unpack = file => Object.fromEntries(untarGz(readFileSync(file), { withBytes: true }).map(({ name, bytes }) => [name, Buffer.from(bytes).toString('utf8')]));

test('one publish adds the Linux entry and a Developer ID signed darwin entry to the same feed, both verifying', () => withFakes({}, async () => {
  const { remote, commits } = repository(3);
  const { key, request, credentials, sdk, seen } = builder(remote);
  const answer = await publish(request, { credentials });
  assert.deepEqual([answer.commit, answer.target, answer.already_published], [commits[2], LINUX, false]);
  // The darwin road, then the zigbuild road, each its own entry in the same feed.
  assert.equal(answer.also.length, 2);
  const [mac, zigbuild] = answer.also;
  assert.deepEqual([mac.commit, mac.sequence, mac.target, mac.already_published, mac.error], [commits[2], BASE_TIME + 3, MAC, false, undefined]);
  assert.equal(mac.url, `https://releases.example.com/engine-releases/${commits[2]}/${MAC}.tar.gz`);
  assert.deepEqual([zigbuild.commit, zigbuild.target, zigbuild.already_published, zigbuild.error], [commits[2], ZIG, false, undefined]);

  const feed = feedOf(request);
  assert.deepEqual(feed.releases.map(entry => entry.target), [LINUX, MAC, ZIG], 'one feed, one entry per target');
  for (const entry of feed.releases) {
    assert.ok(verifyEntry(entry, key.public_key), entry.target);
    assert.deepEqual(Object.keys(entry), ['commit', 'sequence', 'target', 'url', 'content', 'bytes', 'urgent', 'signature']);
  }
  const files = unpack(join(request.feed_folder, commits[2], `${MAC}.tar.gz`));
  assert.deepEqual(Object.keys(files).sort(), ['product/new-accounts.json', 'trillion-local']);
  assert.ok(files['trillion-local'].includes(`trillion-local ${MAC} ${commits[2]} ${BASE_TIME + 3}`), files['trillion-local']);
  assert.match(files['trillion-local'], new RegExp(`# signed by fake rcodesign for ${TEAM}\\n$`), 'the signed program, not the built one');
  assert.doesNotMatch(unpack(join(request.feed_folder, commits[2], `${LINUX}.tar.gz`))['trillion-local'], /signed by fake rcodesign/);

  const zig = readFileSync(seen.zig, 'utf8');
  assert.match(zig, new RegExp(`^SDKROOT=${sdk}$`, 'm'));
  assert.match(zig, new RegExp(`^MACOSX_DEPLOYMENT_TARGET=${settings.darwin.deployment_target}$`, 'm'));
  assert.match(zig, /^CARGO_ZIGBUILD_PYTHON_PATH=\/opt\/made-up\/zig\/bin\/python3$/m);
  const args = readFileSync(seen.rcodesign, 'utf8').split('\n');
  assert.deepEqual(args.slice(0, 11), ['sign', '--p12-file', join(credentials, 'developer-id-p12'), '--p12-password-file', join(credentials, 'developer-id-p12-password'),
    '--code-signature-flags', 'runtime', '--timestamp-url', settings.darwin.timestamp_url, '--binary-identifier', 'trillion-local']);
  for (const text of [zig, readFileSync(seen.cargo, 'utf8'), args.join('\n'), readFileSync(join(request.work_folder, 'build.log'), 'utf8'), JSON.stringify(feed), JSON.stringify(answer)]) {
    for (const canary of [identityCanary, passwordCanary]) assert.ok(!text.includes(canary), 'no credential value in argv, a build, a log, the feed or the answer');
  }
  process.env.CREDENTIALS_DIRECTORY = credentials;
  try {
    const { remote: other } = repository(2);
    const again = builder(other);
    await publish(again.request);
    for (const file of [again.seen.cargo, again.seen.zig]) assert.doesNotMatch(readFileSync(file, 'utf8'), /^CREDENTIALS_DIRECTORY=/m, 'cargo never sees the credentials folder');
  } finally { delete process.env.CREDENTIALS_DIRECTORY; }

  const repeat = await publish(request, { credentials });
  assert.deepEqual([repeat.already_published, ...repeat.also.map(one => one.already_published)], [true, true, true], 'the same commit again changes nothing');
  assert.equal(feedOf(request).releases.length, 3);
}));

for (const [why, fakes, said] of [
  ['without the hardened runtime', { FAKE_RCODESIGN_FLAGS: 'ADHOC' }, /lacks the hardened runtime/],
  ['by another team', { FAKE_RCODESIGN_TEAM: 'ZZZZZ99999' }, /no certificate in its signature has the subject OU ABCDE12345/],
  ['not chaining to an Apple root', { FAKE_RCODESIGN_NOT_APPLE: '1' }, /does not chain to an Apple root/],
  ['without the Developer ID Application extension', { FAKE_RCODESIGN_NO_DEVID: '1' }, /no Developer ID Application extension \(1\.2\.840\.113635\.100\.6\.1\.13\)/],
  ['when the cross-build fails', { FAKE_CARGO_ZIG_FAIL: '1' }, /zigbuild .* exited 101: error: linking with `zig cc` failed/],
]) {
  test(`a darwin release ${why} is refused, and the Linux entry is still published`, () => withFakes(fakes, async () => {
    const { remote, commits } = repository(2);
    const { key, request, credentials } = builder(remote);
    const answer = await publish(request, { credentials });
    assert.equal(answer.target, LINUX);
    assert.equal(answer.also[0].target, MAC);
    assert.match(answer.also[0].error, said);
    const feed = feedOf(request);
    // The zigbuild road publishes too, unless the fake cross-build fails for it as well.
    const published = fakes.FAKE_CARGO_ZIG_FAIL ? [LINUX] : [LINUX, ZIG];
    assert.deepEqual(feed.releases.map(entry => [entry.commit, entry.target]), published.map(target => [commits[1], target]));
    for (const entry of feed.releases) assert.ok(verifyEntry(entry, key.public_key), entry.target);
  }));
}

test('the requirement is checked clause by clause on rcodesign\'s own output shape', () => {
  const info = spawnSync(join(here, 'fake-rcodesign'), ['print-signature-info', '/x/trillion-local'], { encoding: 'utf8', env: { ...process.env, FAKE_RCODESIGN_TEAM: TEAM } }).stdout;
  checkDeveloperId(info, TEAM);
  assert.throws(() => checkDeveloperId(info.replace(`team_name: ${TEAM}`, 'team_name: ZZZZZ99999'), TEAM), /code directory's team is ZZZZZ99999/);
  assert.throws(() => checkDeveloperId(info.replace(/^ {10}team_name: .*\n/m, ''), TEAM), /team is none/);
  assert.throws(() => checkDeveloperId(info.replace('identifier: trillion-local', 'identifier: something-else'), TEAM), /identifier is not trillion-local/);
  assert.throws(() => checkDeveloperId(info.replace('signature_verifies: true', 'signature_verifies: false'), TEAM), /CMS signature does not verify/);
  assert.throws(() => checkDeveloperId('- path: /x\n', TEAM), /no code directory/);
  // The Developer ID extension on another certificate than the leaf does not count.
  const moved = info.replace('            - Developer ID Application\n', '            - Mac Developer\n').replace('is_apple_intermediate_ca: true\n', 'is_apple_intermediate_ca: true\n            apple_code_signing_extensions:\n            - Developer ID Application\n');
  assert.throws(() => checkDeveloperId(moved, TEAM), /no Developer ID Application extension/);
});

test('the check reads real rcodesign output: the engine cross-built for aarch64-apple-darwin and signed with a self-signed Developer ID certificate is refused for its chain alone', () => {
  // rcodesign 0.29.0's print-signature-info of trillion-rust 646fb83d, cross-built on Linux with cargo zigbuild and
  // signed `--code-signature-flags runtime --binary-identifier trillion-local` with a certificate from
  // `rcodesign generate-self-signed-certificate --profile developer-id-application --team-id ABCDE12345` (2026-11-06).
  // It has the hardened runtime, the identifier, the leaf's OU and the Developer ID extension; it is not Apple-issued,
  // so it does not chain to an Apple root and rcodesign wrote no team into its code directory.
  const real = readFileSync(join(here, 'rcodesign-0.29-self-signed-engine.yaml'), 'utf8');
  assert.throws(() => checkDeveloperId(real, TEAM), /its leaf certificate does not chain to an Apple root/);
  assert.throws(() => checkDeveloperId(real, 'MFD7KJQZ8M'), /no certificate in its signature has the subject OU MFD7KJQZ8M/);
  const appleIssued = real.replace('chains_to_apple_root_ca: false', 'chains_to_apple_root_ca: true').replace('identifier: trillion-local', `identifier: trillion-local\n          team_name: ${TEAM}`);
  checkDeveloperId(appleIssued, TEAM);
});

test('an older darwin sequence is refused for darwin alone, and a darwin target added later is built for a commit Linux already has', () => withFakes({}, async () => {
  const { remote, commits } = repository(3);
  const { request, credentials } = builder(remote);
  const linuxOnly = { ...request, darwin: undefined };
  await publish(linuxOnly, { commit: commits[1] });
  const answer = await publish(request, { commit: commits[1], credentials });
  assert.deepEqual([answer.already_published, answer.also[0].already_published, answer.also[0].target], [true, false, MAC], 'Linux had it; darwin is built now');
  await publish(request, { commit: commits[2], credentials });
  const feed = feedOf(request);
  // Each commit's roads in the order they publish: Linux, then the zigbuild road, then darwin (darwin is added later for commit 2).
  assert.deepEqual(feed.releases.map(entry => [entry.sequence, entry.target]), [[BASE_TIME + 2, LINUX], [BASE_TIME + 2, ZIG], [BASE_TIME + 2, MAC], [BASE_TIME + 3, LINUX], [BASE_TIME + 3, MAC], [BASE_TIME + 3, ZIG]]);
  await assert.rejects(publish(request, { commit: commits[0], credentials }), error => error.exit === 3, 'an older commit is refused before anything is built');
}));

test('with no credentials folder the darwin entry says what is missing; the Linux entry is published', () => withFakes({}, async () => {
  const { remote } = repository(2);
  const { request } = builder(remote);
  delete process.env.CREDENTIALS_DIRECTORY;
  const answer = await publish(request, { credentials: undefined });
  assert.equal(answer.already_published, false);
  assert.match(answer.also[0].error, /No Developer ID identity for aarch64-apple-darwin: publish reads it from the receiver service's credentials/);
  assert.deepEqual(feedOf(request).releases.map(entry => entry.target), [LINUX, ZIG]);
}));

test('the command exits 4 when a darwin target failed, and the receiver keeps both the release and the error', () => withFakes({ FAKE_RCODESIGN_NOT_APPLE: '1' }, async () => {
  const { remote, commits } = repository(2);
  const { request, credentials, top } = builder(remote);
  const configFile = join(top, 'publish.json');
  writeFileSync(configFile, JSON.stringify(request));
  const ran = await new Promise(resolve => {
    const child = spawn(process.execPath, [PUBLISH, 'publish', configFile], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, CREDENTIALS_DIRECTORY: credentials } });
    let out = '', err = '';
    child.stdout.on('data', bytes => { out += bytes; });
    child.stderr.on('data', bytes => { err += bytes; });
    child.stdio[3].end('');
    child.on('close', code => resolve({ code, out, err }));
  });
  assert.equal(ran.code, 4, ran.err);
  const printed = JSON.parse(ran.out.trim().split('\n').at(-1));
  assert.deepEqual([printed.commit, printed.target], [commits[1], LINUX]);
  assert.match(ran.err, /^aarch64-apple-darwin: .*does not chain to an Apple root/m);

  const state = join(top, 'state');
  process.env.CREDENTIALS_DIRECTORY = credentials;
  try {
    const run = await runPublish({ configFile, token: '', stateFolder: state, log: () => {} })(commits[1]);
    assert.equal(run.exit, 4);
    assert.equal(run.release.target, LINUX);
    assert.match(run.error, /^aarch64-apple-darwin: .*does not chain to an Apple root/);
    assert.deepEqual(JSON.parse(readFileSync(join(state, 'last-run.json'), 'utf8')), run);
  } finally { delete process.env.CREDENTIALS_DIRECTORY; }
}));

test('darwin in a config is checked: only the Mac targets this builder builds, and the app\'s team', () => {
  const base = { repository: 'x', branch: 'main', base_url: 'https://r.example.com/engine-releases/' };
  assert.equal(darwinOf(base, '/run/credentials/x'), null);
  assert.throws(() => darwinOf({ ...base, darwin: { targets: ['x86_64-pc-windows-gnu'], team_id: TEAM } }), /darwin.targets must list Mac targets/);
  assert.throws(() => darwinOf({ ...base, darwin: { targets: [MAC], team_id: 'nope' } }), /darwin.team_id must be the Mac app's Developer ID team/);
  assert.deepEqual(darwinOf({ ...base, darwin: { targets: [MAC], team_id: TEAM } }, ''), { targets: [MAC], team_id: TEAM, sdk: settings.darwin.sdk_folder, credentials: null });
});

test('install sets the darwin builds up, and the identity and its password travel only on standard input', async () => {
  const top = folder(), sdkFile = join(top, 'MacOSX14.5.sdk.tar.xz');
  writeFileSync(sdkFile, 'made-up sdk bytes');
  const p12 = Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.from(identityCanary.repeat(4))]);
  const calls = [];
  const run = async (_machine, command, input) => {
    calls.push({ command, input: input?.pipe ? '<stream>' : Buffer.isBuffer(input) ? input : String(input ?? '') });
    if (command.includes(' make-key ')) return `${JSON.stringify({ public_key: 'a'.repeat(64), made: false })}\n`;
    if (command.includes('systemctl is-active')) return 'active\n';
    return '';
  };
  const request = { builder: { address: '192.0.2.50', host_name: 'releases.example.com' }, ssh: { known_hosts: '/x/known_hosts' }, repository: { url: 'https://github.com/owner/engine.git', branch: 'main' }, darwin: { team_id: TEAM, sdk: sdkFile } };
  const answer = await installBuilder(request, { token: 'tok', secret: 'sec', identity: p12.toString('base64'), identityPassword: passwordCanary, run, tarball: () => ({ pipe() {} }), sdk: () => ({ pipe() {} }), fetchImpl: async () => ({ status: 200 }) });
  assert.deepEqual(answer.darwin, { targets: [MAC], team_id: TEAM });
  for (const { command } of calls) for (const value of [identityCanary, passwordCanary, p12.toString('base64')]) assert.ok(!command.includes(value), command);
  const encrypted = name => calls.find(call => call.command.includes(`--name='${name}'`));
  assert.deepEqual(encrypted('developer-id-p12').input, p12, 'the .p12 bytes, decoded, on standard input');
  assert.equal(encrypted('developer-id-p12-password').input, passwordCanary);
  assert.match(encrypted('developer-id-p12').command, /^umask 077 && systemd-creds encrypt --name='developer-id-p12' - '\/etc\/credstore\.encrypted\/engine-release-receiver-developer-id-p12'$/);
  const setup = calls.find(call => call.command.startsWith('sh -s -- \'engine-builder\''));
  assert.match(setup.command, new RegExp(`'${settings.darwin.zig_wheel.version}' '${settings.darwin.zig_wheel.sha256.x86_64}' '${settings.darwin.zig_wheel.sha256.aarch64}' '${settings.darwin.cargo_zigbuild}' '${settings.darwin.apple_codesign}' '${MAC}'$`));
  assert.match(String(setup.input), /cargo install --locked --quiet apple-codesign --version "=\$APPLE_CODESIGN" --bin rcodesign/);
  const sdk = calls.find(call => call.command.includes(`${settings.darwin.sdk_folder}.new`));
  assert.equal(sdk.input, '<stream>');
  assert.match(sdk.command, /tar -C .* --strip-components=1 --no-same-owner -xJf - && test -f .*SDKSettings\.json/);
  const config = JSON.parse(calls.find(call => call.command.includes(settings.on_builder.config_file)).input);
  assert.deepEqual(config, builderConfig(request));
  assert.deepEqual(config.darwin, { targets: [MAC], team_id: TEAM, sdk_root: settings.darwin.sdk_folder });
  assert.equal(config.toolchain.rcodesign, '/var/lib/engine-builder/.cargo/bin/rcodesign');
  const unit = calls.find(call => call.command.includes('/etc/systemd/system/')).input;
  assert.equal(unit, receiverUnit({ hasToken: true, darwin: true }));
  assert.match(unit, /^LoadCredentialEncrypted=developer-id-p12:\/etc\/credstore\.encrypted\/engine-release-receiver-developer-id-p12$/m);
  assert.match(unit, /^LoadCredentialEncrypted=developer-id-p12-password:\/etc\/credstore\.encrypted\/engine-release-receiver-developer-id-p12-password$/m);
  assert.ok(!receiverUnit({ hasToken: true }).includes('developer-id'), 'a builder without darwin opens no identity');

  await assert.rejects(installBuilder(request, { token: 'tok', secret: 'sec', identityPassword: passwordCanary, run }), /hand its \.p12 as base64 on descriptor 5/);
  await assert.rejects(installBuilder(request, { token: 'tok', secret: 'sec', identity: p12.toString('base64'), run }), /password on descriptor 6/);
  assert.throws(() => developerIdentity('not base64!', 'pw'), /not base64/);
  assert.throws(() => developerIdentity(Buffer.alloc(100, 1).toString('base64'), 'pw'), /not a PKCS#12 file/);
  assert.throws(() => checkRequest({ ...request, darwin: { team_id: TEAM, sdk: '/x/sdk.zip' } }), /darwin.sdk must name a macOS SDK packed as \.tar\.xz/);
  assert.throws(() => checkRequest({ ...request, darwin: { team_id: 'x', sdk: sdkFile } }), /darwin.team_id/);

  const without = [];
  await installBuilder({ ...request, darwin: undefined }, { token: 'tok', secret: 'sec', run: async (machine, command, input) => { without.push(command); return run(machine, command, input); }, tarball: () => ({ pipe() {} }), fetchImpl: async () => ({ status: 200 }) });
  assert.ok(without.some(command => command.startsWith('rm -f') && command.includes('developer-id-p12')), 'a builder installed again without darwin keeps no identity');
});
