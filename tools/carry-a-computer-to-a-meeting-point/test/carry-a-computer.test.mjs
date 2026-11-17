import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { WAYS, ensureProgram, installCarrier, pickArtifact, portFor, removeCarrier, renderClient, renderMeetingPoint, serveCarrier, valuesFor } from '../do-work/carry-a-computer.mjs';

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
    const rendered = renderClient(row, valuesFor({ way: row, relay_host: relayHost, computer_id: 'computer-one', local_port: 8789 }), { secret: 'SECRET', dir: '/run/dir' });
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
  assert.equal(files.find(file => file.name === 'known_hosts').text, '[relay.example.test]:22 ssh-ed25519 AAAAEXAMPLE\n');
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
