import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { WAYS, copyCarrier, ensureProgram, keptKey, makeKey, installCarrier, pickArtifact, portFor, removeCarrier, renderClient, renderMeetingPoint, serveCarrier, valuesFor } from '../do-work/carry-a-computer.mjs';

const relayHost = { id: 'relay-example', hostname: 'relay.example.test', params: { control_port: 2333, ssh_port: 22, host_key: 'ssh-ed25519 AAAAEXAMPLE' } };
const way = id => WAYS.find(row => row.id === id);
const folder = t => { const dir = mkdtempSync(join(tmpdir(), 'carrier-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('the meeting-point port is a stable hash of the computer id into the configured range', () => {
  const range = { min: 20000, max: 59999 };
  assert.equal(portFor('computer-one', range), portFor('computer-one', range));
  const seen = new Set();
  for (let n = 0; n < 500; n++) { const port = portFor(`computer-${n}`, range); assert.ok(port >= 20000 && port <= 59999); seen.add(port); }
  assert.ok(seen.size > 450, 'ports spread over the range');
  assert.notEqual(portFor('computer-one', range, 'a'), portFor('computer-one', range, 'b'));
  assert.deepEqual([portFor('x', { min: 7, max: 7 })], [7]);
  assert.throws(() => portFor('bad id'), /letters/);
});

test('every shipped way row names its client, its files and its arguments, and no vendor appears in code', () => {
  for (const row of WAYS) {
    for (const key of ['id', 'transport_kind', 'relay_host_ref', 'client', 'params', 'order', 'requires_awake', 'install']) assert.ok(key in row, `${row.id} has ${key}`);
    const rendered = renderClient(row, valuesFor({ way: row, relay_host: relayHost, computer_id: 'computer-one', local_port: 8789, values: { certificate: 'CERTIFICATE port-1' } }), { secret: 'SECRET', dir: '/run/dir' });
    assert.ok(rendered.argv.length > 0);
    assert.ok(!rendered.argv.join(' ').includes('SECRET'), `${row.id} never puts the credential in an argument`);
  }
  const code = readFileSync(new URL('../do-work/carry-a-computer.mjs', import.meta.url), 'utf8');
  for (const name of WAYS.map(row => row.id).concat(['rathole', 'ssh', 'darwin', 'launchd', 'systemd', 'github'])) assert.ok(!new RegExp(`['"\`/]${name}[-'"\`/ ]`, 'i').test(code.replace(/\/\/.*$/gm, '')), `the runner names ${name}`);
});

test('the first row renders the client file and arguments for one computer, with the credential only in its private file', () => {
  const values = valuesFor({ way: way('rathole'), relay_host: relayHost, computer_id: 'computer-one', local_port: 8789 });
  const { files, argv } = renderClient(way('rathole'), values, { secret: 'TOKEN', dir: '/run/dir' });
  assert.deepEqual(argv, ['--client', '/run/dir/client.toml']);
  assert.match(files[0].text, /remote_addr = "relay\.example\.test:2333"/);
  assert.match(files[0].text, /token = "TOKEN"/);
  assert.match(files[0].text, /local_addr = "127\.0\.0\.1:8789"/);
  assert.equal(files[0].mode, 0o600);
  assert.equal(values.remote_port, portFor('computer-one'));
});

test('the frp row hands its token only in the client file and holds the host to the computers carried', () => {
  assert.equal(WAYS[0].id, 'frp');
  const values = valuesFor({ way: way('frp'), relay_host: relayHost, computer_id: 'computer-one', local_port: 8789 });
  const { files, argv } = renderClient(way('frp'), values, { secret: 'TOKEN', dir: '/run/dir' });
  assert.deepEqual(argv, ['-c', '/run/dir/frpc.toml']);
  assert.match(files[0].text, /auth\.token = "TOKEN"/);
  assert.match(files[0].text, new RegExp(`remotePort = ${portFor('computer-one')}\\n`));
  const host = renderMeetingPoint({ way: way('frp'), relay_host: relayHost, computers: [{ id: 'computer-one' }, { id: 'computer-two' }], values: { config_dir: '/etc/example', token: 'TOKEN' } });
  assert.match(host.steps[0].file.text, /proxyBindAddr = "127\.0\.0\.1"/);
  assert.ok(host.steps[0].file.text.includes(`allowPorts = [{ single = ${portFor('computer-one')} }, { single = ${portFor('computer-two')} }, ]`));
  assert.deepEqual(host.argv, ['-c', '/etc/example/frps.toml']);
  assert.match(host.program.artifacts[0].exe, /\/frps(\.exe)?$/);
  assert.match(way('frp').client.program.artifacts[0].exe, /\/frpc(\.exe)?$/);
});

test('the second row is a reverse forward bound to loopback on both sides, with the host key pinned', () => {
  const values = valuesFor({ way: way('ssh-reverse-forward'), relay_host: relayHost, computer_id: 'computer-one', local_port: 8789 });
  const { files, argv } = renderClient(way('ssh-reverse-forward'), values, { secret: 'KEY', dir: '/run/dir' });
  assert.ok(argv.includes('StrictHostKeyChecking=yes') && argv.includes('ExitOnForwardFailure=yes'));
  assert.ok(argv.includes(`127.0.0.1:${portFor('computer-one')}:127.0.0.1:8789`));
  assert.match(argv.at(-1), /^carry-[0-9a-f]{16}@relay\.example\.test$/);
  // Pinned under one alias: OpenSSH looks a port-22 host up by its bare name, so a `[host]:22` line never matches.
  assert.equal(files.find(file => file.name === 'known_hosts').text, 'meeting-point ssh-ed25519 AAAAEXAMPLE\n');
  assert.ok(argv.includes('HostKeyAlias=meeting-point'));
});

test('a synthetic way row runs with no code change', async t => {
  const state = folder(t);
  const synthetic = { id: 'synthetic-way', transport_kind: 'reverse_tunnel', relay_host_ref: 'relay-example', order: 1, requires_awake: true, install: { scope: 'user' }, params: {}, client: { program: { artifacts: [{ where: { platform: 'made-up' }, command: '/bin/made-up' }, { where: {}, command: '/bin/any' }] }, files: [{ name: 'c.conf', mode: '0600', text: 'to {host} for {computer_id} with {secret} on {local_port}\n' }], argv: ['--go', '{dir}/c.conf', 'port={remote_port}'] } };
  const config = { way: synthetic, relay_host: relayHost, computer_id: 'c-1', local_port: 9000 };
  const ran = [];
  const controller = new AbortController();
  const spawnImpl = (exe, argv) => {
    const dir = argv[1].replace(/\/c\.conf$/, '');
    ran.push({ exe, argv, file: readFileSync(argv[1], 'utf8'), dir });
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.kill = () => {};
    setImmediate(() => { child.stderr.write('connection refused\n'); child.emit('exit', 1); });
    return child;
  };
  const reports = [];
  await serveCarrier(config, { credential: async () => 'S3', state, have: { platform: 'plan9' }, spawnImpl, wait: async () => { if (ran.length === 2) controller.abort(); }, signal: controller.signal, report: row => reports.push(row) });
  assert.equal(ran.length, 2, 'it starts again after the client ends');
  assert.equal(ran[0].exe, '/bin/any');
  assert.equal(ran[0].file, `to relay.example.test for c-1 with S3 on 9000\n`);
  assert.deepEqual(ran[0].argv.slice(2), [`port=${portFor('c-1')}`]);
  assert.ok(!existsSync(ran[0].dir), 'the private folder is removed when the client ends');
  assert.equal(reports[0].said, 'connection refused');
});

test('while it carries, the computer is announced to the meeting point with its port, by the command the config names', async t => {
  const state = folder(t);
  const synthetic = { id: 'synthetic-way', transport_kind: 'reverse_tunnel', relay_host_ref: 'relay-example', order: 1, requires_awake: true, install: { scope: 'user' }, params: {}, client: { program: { artifacts: [{ where: {}, command: '/bin/any' }] }, files: [], argv: ['--go'] } };
  const config = { way: synthetic, relay_host: relayHost, computer_id: 'c-1', local_port: 9000, announce: { argv: ['/bin/announce', 'op', '@meeting', 'computers:announce', '{"port": {remote_port}}'], every_seconds: 0.05 } };
  const announced = [];
  const controller = new AbortController();
  const spawnImpl = (exe, argv) => {
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.kill = () => {};
    if (exe === '/bin/announce') { announced.push(argv); return child; }
    setTimeout(() => child.emit('exit', 0), 180);
    return child;
  };
  await serveCarrier(config, { credential: async () => 'S', state, spawnImpl, wait: async () => controller.abort(), signal: controller.signal });
  assert.ok(announced.length >= 3, `announced at once and again while carried (${announced.length})`);
  assert.deepEqual(announced[0], ['op', '@meeting', 'computers:announce', `{"port": ${portFor('c-1')}}`]);
  const after = announced.length;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(announced.length, after, 'no announcement once the carrier has ended');
});

test('a download is used only when it is the pinned bytes, and is kept by its BLAKE3', async t => {
  const state = folder(t);
  const bytes = new TextEncoder().encode('pretend archive');
  const program = { artifacts: [{ where: { platform: 'made-up' }, url: 'https://example.test/p.zip', blake3: bytesToHex(blake3(bytes)), size: bytes.length, extract: ['sh', '-c', 'echo built > "{dir}/prog"'], exe: 'prog' }] };
  const have = { platform: 'made-up', arch: 'x' };
  await assert.rejects(ensureProgram(program, { have, state, fetchBytes: async () => new TextEncoder().encode('tampered byte!') }), /not the pinned file/);
  let fetched = 0;
  const exe = await ensureProgram(program, { have, state, fetchBytes: async () => { fetched++; return bytes; } });
  assert.match(exe, new RegExp(`programs/${program.artifacts[0].blake3}/prog$`));
  assert.equal(readFileSync(exe, 'utf8'), 'built\n');
  assert.equal(await ensureProgram(program, { have, state, fetchBytes: async () => { throw new Error('must not fetch again'); } }), exe);
  assert.equal(fetched, 1);
  assert.throws(() => pickArtifact(program, { platform: 'other' }), /no build/);
});

test('shipped download pins are BLAKE3 hex of the sizes they name, one build per kind of computer', () => {
  const artifacts = way('rathole').client.program.artifacts;
  for (const artifact of artifacts) { assert.match(artifact.blake3, /^[0-9a-f]{64}$/); assert.ok(artifact.size > 0); assert.match(artifact.url, /^https:\/\//); }
  for (const have of [{ platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }, { platform: 'linux', arch: 'x64' }, { platform: 'linux', arch: 'arm64' }, { platform: 'win32', arch: 'x64' }]) assert.ok(pickArtifact(way('rathole').client.program, have));
});

test('the meeting point renders each carried computer once, refuses a shared port and takes a salt', () => {
  const computers = [{ id: 'computer-one', server_value: 'TOKEN-ONE' }, { id: 'computer-two', server_value: 'TOKEN-TWO' }];
  const rendered = renderMeetingPoint({ way: way('rathole'), relay_host: relayHost, computers, values: { config_dir: '/etc/example' } });
  const file = rendered.steps[0].file;
  assert.equal(file.mode, '0600');
  assert.match(file.text, /bind_addr = "0\.0\.0\.0:2333"/);
  for (const computer of computers) assert.ok(file.text.includes(`[server.services.${computer.id}]\ntoken = "${computer.server_value}"\nbind_addr = "127.0.0.1:${portFor(computer.id)}"`));
  assert.equal(file.path, '/etc/example/server.toml');
  assert.deepEqual(rendered.argv, ['--server', '/etc/example/server.toml']);
  assert.throws(() => renderMeetingPoint({ way: way('rathole'), relay_host: relayHost, computers }), /needs config_dir/);
  const narrow = { min: 5, max: 5 };
  assert.throws(() => renderMeetingPoint({ way: way('rathole'), relay_host: relayHost, computers, values: { config_dir: '/etc/example' }, ports: narrow }), /share port 5; give one a salt/);
  const ssh = renderMeetingPoint({ way: way('ssh-reverse-forward'), relay_host: relayHost, computers: [{ id: 'computer-one', server_value: 'ssh-rsa AAAAB3 example' }] });
  const entry = ssh.steps.find(step => step.file?.path.endsWith('.conf'));
  assert.match(entry.file.text, new RegExp(`PermitListen 127\\.0\\.0\\.1:${portFor('computer-one')}\\n`));
  assert.ok(ssh.steps.find(step => step.file?.path.endsWith('authorized_keys')).file.text.startsWith(`restrict,port-forwarding,permitlisten="127.0.0.1:${portFor('computer-one')}" ssh-rsa`));
  assert.ok(ssh.steps.at(-2).run.includes('-t'));
});

test('installing writes the init row for the computer it is on and loads it; removing undoes it', t => {
  const state = folder(t), home = folder(t);
  const calls = [];
  const run = (command, args) => { calls.push([command, ...args]); if (command === '/bin/launchctl' && args[0] === 'print') throw new Error('gone'); if (command === '/bin/launchctl' && args[0] === 'bootout') throw Object.assign(new Error('x'), { stderr: 'Could not find service' }); };
  const config = { label: 'example.carrier', way: way('rathole'), relay_host: relayHost, computer_id: 'computer-one', local_port: 8789, credential_command: ['/bin/example-vault', 'get'], init_values: { home } };
  const done = installCarrier(config, state, { have: { platform: 'darwin', arch: 'arm64' }, run, pause: () => {} });
  assert.equal(done.init, 'launchd-user-agent');
  assert.equal(done.port, portFor('computer-one'));
  const plist = readFileSync(`${home}/Library/LaunchAgents/example.carrier.plist`, 'utf8');
  assert.ok(plist.includes(`${state}/carrier/tools/carry-a-computer-to-a-meeting-point/do-work/carry-a-computer.mjs`));
  assert.ok(existsSync(`${state}/carrier/node_modules/@noble/hashes/blake3.js`));
  assert.ok(existsSync(`${state}/carrier/tools/start-a-computer/read-data/init-rows.json`));
  assert.deepEqual(calls.at(-1).slice(0, 3), ['/bin/launchctl', 'bootstrap', `gui/${process.getuid()}`]);
  const written = JSON.parse(readFileSync(`${state}/example.carrier.json`, 'utf8'));
  assert.equal(written.state, state);
  removeCarrier(config, state, { have: { platform: 'darwin', arch: 'arm64' }, run, pause: () => {} });
  assert.ok(!existsSync(`${home}/Library/LaunchAgents/example.carrier.plist`));
});

// The live proof (a real server and client on this computer, the client kept by a real launchd user agent) runs only when
// asked for: CARRIER_LIVE_PROOF=<the way's client program>, CARRIER_LIVE_SERVER=<its server program, when another file>,
// CARRIER_LIVE_WAY=<the way row id, rathole when left out>.
test('live: the launchd row keeps the carrier connected to a local server, and the carried port answers', { skip: !process.env.CARRIER_LIVE_PROOF || process.platform !== 'darwin' }, async t => {
  const client = process.env.CARRIER_LIVE_PROOF, server = process.env.CARRIER_LIVE_SERVER ?? client, liveWay = way(process.env.CARRIER_LIVE_WAY ?? 'rathole');
  const state = folder(t);
  const free = () => new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const [control, door] = [await free(), await free()];
  const echo = createServer(socket => socket.end('door-answer\n')).listen(door, '127.0.0.1');
  t.after(() => echo.close());
  const lane = 'carrierproof';
  const ports = { min: await free(), max: undefined }; ports.max = ports.min;
  const host = { id: 'local', hostname: '127.0.0.1', params: { control_port: control } };
  const rendered = renderMeetingPoint({ way: liveWay, relay_host: host, computers: [{ id: lane, server_value: 'a-synthetic-token' }], values: { config_dir: state, token: 'a-synthetic-token' }, ports });
  const written = rendered.steps[0].file;
  writeFileSync(written.path, written.text, { mode: 0o600 });
  const serverChild = spawn(server, rendered.argv, { stdio: 'ignore' });
  t.after(() => serverChild.kill());
  const vault = join(state, 'vault.sh'); writeFileSync(vault, '#!/bin/sh\nprintf %s a-synthetic-token >&3\n', { mode: 0o700 }); chmodSync(vault, 0o700);
  const label = `test.carrier.proof.${process.pid}`;
  const config = { label, way: { ...liveWay, client: { ...liveWay.client, program: { artifacts: [{ where: {}, command: client }] } } }, relay_host: host, computer_id: lane, local_port: door, credential_command: [vault], ports };
  const done = installCarrier(config, state);
  t.after(() => { try { removeCarrier(config, state); } catch {} });
  assert.equal(done.port, ports.min);
  let answer = '';
  for (let n = 0; n < 60 && !answer; n++) {
    answer = await new Promise(resolve => { const c = spawn('/usr/bin/nc', ['-w', '2', '127.0.0.1', String(ports.min)]); let out = ''; c.stdout.on('data', b => { out += b; }); c.on('exit', () => resolve(out)); });
    if (!answer) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(answer, 'door-answer\n');
  assert.equal(spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]).status, 0);
  removeCarrier(config, state);
  assert.notEqual(spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]).status, 0);
});

test('a carrier the meeting point gives a port and a certificate asks first, then dials with them', async t => {
  const state = folder(t);
  const answer = { port: 31337, seconds: 120, certificate: 'CERTIFICATE port-31337' };
  const config = { way: way('ssh-certificate'), relay_host: relayHost, computer_id: 'mac-1', local_port: 9000, values: { public_key: 'ssh-ed25519 AAAAPUB carrier' },
    announce: { argv: ['/bin/announce', '{"computer_id": "{computer_id}", "public_key": "{public_key}", "salt": "{salt}", "carried": {carried}}'], every_seconds: 0.05, settle_seconds: 0.03, gives: { remote_port: 'port', certificate: 'certificate' } } };
  const asked = [], dialed = [], written = [];
  const controller = new AbortController();
  let answers = [null, answer, answer, null];
  const spawnImpl = (exe, argv, options) => {
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
    if (exe === '/bin/announce') {
      asked.push(argv);
      const given = answers.shift();
      setTimeout(() => { if (given) child.stdout.end(JSON.stringify(given)); else child.stdout.end(); child.emit('exit', given ? 0 : 1); }, 5);
      return child;
    }
    dialed.push(argv);
    const dir = argv[argv.indexOf('-i') + 1].replace(/\/identity$/, '');
    written.push(readFileSync(join(dir, 'identity-cert.pub'), 'utf8'));
    child.kill = () => { killed += 1; setTimeout(() => { child.emit('exit', 143); controller.abort(); }, 1); };
    return child;
  };
  let killed = 0;
  await serveCarrier(config, { credential: async () => 'PRIVATE', state, spawnImpl, wait: async () => {}, signal: controller.signal });
  assert.deepEqual(asked[0], ['{"computer_id": "mac-1", "public_key": "ssh-ed25519 AAAAPUB carrier", "salt": "", "carried": false}']);
  assert.deepEqual(asked[1], ['{"computer_id": "mac-1", "public_key": "ssh-ed25519 AAAAPUB carrier", "salt": "1", "carried": false}'], 'a refused try moves to another salt');
  assert.ok(asked[2][0].endsWith('"carried": true}'), 'carried is said only once the client held its port');
  assert.ok(killed >= 1, 'a refused renewal ends the client (nothing else stops it here)');
  assert.equal(dialed.length, 1, 'no dialing until the meeting point answered');
  assert.ok(dialed[0].includes('127.0.0.1:31337:127.0.0.1:9000'), 'the given port, not a local hash');
  assert.ok(dialed[0].includes(`carry@${relayHost.hostname}`));
  assert.equal(written[0], `${answer.certificate}\n`);
});

test('the certificate meeting point is one user and one sshd file, the same for every computer, and sshd accepts it', t => {
  const rendered = renderMeetingPoint({ way: way('ssh-certificate'), relay_host: relayHost, computers: [], values: { ca_public_file: '/var/lib/example/meeting-ca.key.pub', port_min: 20000, port_max: 59999 } });
  const file = rendered.steps.find(step => step.file).file;
  assert.equal(file.path, '/etc/ssh/sshd_config.d/carry.conf');
  assert.match(file.text, /TrustedUserCAKeys \/var\/lib\/example\/meeting-ca\.key\.pub\n/);
  assert.match(file.text, /-ge 20000 \] && \[ "\$p" -le 59999/);
  assert.ok(rendered.steps[0].run.join(' ').includes('useradd --system --no-create-home --shell /usr/sbin/nologin carry'));
  const sshd = ['/usr/sbin/sshd'].find(path => existsSync(path));
  if (!sshd) return;
  const dir = folder(t);
  assert.equal(spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', join(dir, 'host')]).status, 0);
  writeFileSync(join(dir, 'sshd_config'), `HostKey ${join(dir, 'host')}\nUsePAM no\n${file.text.replace('AuthorizedPrincipalsCommandUser nobody', `AuthorizedPrincipalsCommandUser ${process.env.USER ?? 'nobody'}`)}`);
  const checked = spawnSync(sshd, ['-t', '-f', join(dir, 'sshd_config')], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('a way that makes its own key makes one in a private folder that is gone after', t => {
  const state = folder(t);
  const made = makeKey(way('ssh-certificate'), { state });
  const kept = join(state, 'kept'); writeFileSync(kept, made.private, { mode: 0o600 });
  assert.equal(spawnSync('ssh-keygen', ['-y', '-f', kept], { encoding: 'utf8' }).stdout.trim().split(' ').slice(0, 2).join(' '), made.public.split(' ').slice(0, 2).join(' '), 'the private key is the public key\'s');
  assert.match(made.public, /^ssh-ed25519 [A-Za-z0-9+/=]+ carrier$/);
  assert.deepEqual(spawnSync('ls', [join(state, 'run')], { encoding: 'utf8' }).stdout, '', 'nothing is left behind');
  assert.throws(() => makeKey(way('frp'), { state }), /makes no key/);
});

test('a carrier copy made again replaces an earlier copy whose files and folders are read-only', () => {
  const state = mkdtempSync(join(tmpdir(), 'carrier-copy-'));
  try {
    const entry = copyCarrier(state);
    const lock = path => spawnSync('chmod', ['-R', 'a-w', path]);
    lock(join(state, 'carrier'));
    assert.equal(copyCarrier(state), entry);
    assert.ok(existsSync(entry));
    assert.ok(!existsSync(join(state, 'carrier.next')) && !existsSync(join(state, 'carrier.before')));
  } finally {
    spawnSync('chmod', ['-R', 'u+w', state]);
    rmSync(state, { recursive: true, force: true });
  }
});

// A synthetic way that makes its key with a shell command (no ssh-keygen): the command counts its runs in <state>/runs, and
// the client's identity file is the credential it is given.
const keyedWay = {
  id: 'keyed-way', transport_kind: 'reverse_tunnel', relay_host_ref: 'relay-example', order: 1, requires_awake: true, install: { scope: 'user' }, params: {},
  key: { make: ['/bin/sh', '-c', 'echo made >> "$0/../runs"; echo PRIVATE > "$0/identity"; echo "ssh-ed25519 PUBLIC carrier" > "$0/identity.pub"', '{dir}'], private: 'identity', public: 'identity.pub' },
  client: { program: { artifacts: [{ where: {}, command: '/bin/any' }] }, files: [{ name: 'identity', mode: '0600', text: '{secret}\n' }], argv: ['-i', '{dir}/identity'] },
};
const keyedConfig = { way: keyedWay, relay_host: relayHost, computer_id: 'mac-1', local_port: 9000, values: { have: '{"doors":[]}' }, announce: { argv: ['/bin/announce', '{"public_key": "{public_key}", "carried": {carried}}'], every_seconds: 60 } };
const carriedOnce = () => { const controller = new AbortController(); return { signal: controller.signal, wait: async () => controller.abort() }; };
const clientAndAnnounce = (announced, dialed) => (exe, argv) => {
  const child = new EventEmitter(); child.stderr = new PassThrough(); child.kill = () => {};
  if (exe === '/bin/announce') { announced.push(argv[0]); return child; }
  dialed.push(readFileSync(argv[1], 'utf8'));
  setTimeout(() => child.emit('exit', 0), 5);
  return child;
};

test('with no credential_command, the carrier keeps its own key in its state folder: made once, read back at each start, announced by its public half', async t => {
  const state = folder(t);
  const announced = [], dialed = [];
  for (let start = 0; start < 2; start++) await serveCarrier(keyedConfig, { state, spawnImpl: clientAndAnnounce(announced, dialed), ...carriedOnce() });
  assert.equal(readFileSync(join(state, 'runs'), 'utf8'), 'made\n', 'the way\'s key.make ran once, on the first start');
  assert.equal(statSync(join(state, 'key')).mode & 0o777, 0o700, 'the key folder is private');
  for (const name of ['identity', 'identity.pub']) assert.equal(statSync(join(state, 'key', name)).mode & 0o777, 0o600, `${name} is 0600`);
  assert.deepEqual(dialed, ['PRIVATE\n', 'PRIVATE\n'], 'the private half is the credential at both starts');
  assert.deepEqual(announced.map(text => JSON.parse(text).public_key), ['ssh-ed25519 PUBLIC carrier', 'ssh-ed25519 PUBLIC carrier'], 'the public half is announced');
  assert.deepEqual(keptKey(keyedWay, { state }), { private: 'PRIVATE\n', public: 'ssh-ed25519 PUBLIC carrier' }, 'the same key is read back');
  assert.equal(readFileSync(join(state, 'runs'), 'utf8'), 'made\n', 'reading it back makes no new key');
  await assert.rejects(serveCarrier({ ...keyedConfig, way: way('frp') }, { state, ...carriedOnce() }), /makes no key/, 'a way that makes no key has none to keep');
});

test('with a credential (the Mac path, a credential_command), no key is made in the state folder and the config\'s public key is announced as given', async t => {
  const state = folder(t);
  const announced = [], dialed = [];
  const config = { ...keyedConfig, values: { public_key: 'ssh-ed25519 GIVEN carrier', have: '{"doors":[]}' } };
  await serveCarrier(config, { credential: async () => 'GIVEN', state, spawnImpl: clientAndAnnounce(announced, dialed), ...carriedOnce() });
  assert.equal(existsSync(join(state, 'key')), false, 'no key is kept here');
  assert.deepEqual(announced.map(text => JSON.parse(text)), [{ public_key: 'ssh-ed25519 GIVEN carrier', carried: true }]);
  assert.deepEqual(dialed, ['GIVEN\n']);
});
