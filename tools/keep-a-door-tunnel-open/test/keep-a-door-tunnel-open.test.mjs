import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { connectionArguments, makeConnectionKey, pinHost, prepareConnectionHost, prepareFromRequest, serveConnection, connectionLaunchAgent, connectionLaunchArguments, installConnection, keyDescriptor } from '../do-work/keep-a-door-tunnel-open.mjs';
const config = { address: '192.0.2.34', user: 'tunnel-user', remotePort: 18789, localPort: 8789, knownHostsFile: '/private/known-hosts', adminKeyFile: '/private/admin-key', ssh_port: 22, admin_user: 'admin' };

test('connection confines both sides to loopback, pins its host and accepts no command or shell', () => {
  const args = connectionArguments(config);
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('127.0.0.1:18789:127.0.0.1:8789'));
  assert.equal(args.at(-1), 'tunnel-user@192.0.2.34');
  assert.ok(args.includes('/private/identity-public-key'));
  for (const changed of [{ address: 'host;false' }, { user: 'root;false' }, { remotePort: 0 }, { localPort: 65536 }]) assert.throws(() => connectionArguments({ ...config, ...changed }), /refused/);
});

test('first provider-bound host key is retained and never silently replaced', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-host-key-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = { ...config, knownHostsFile: join(dir, 'hosts') };
  let calls = 0;
  const run = () => { calls++; return `${c.address} ssh-ed25519 AAAATEST\n`; };
  pinHost(c, { run }); pinHost(c, { run: () => { throw new Error('must not rescan'); } });
  assert.equal(calls, 1);
  assert.equal(readFileSync(c.knownHostsFile, 'utf8'), `${c.address} ssh-ed25519 AAAATEST\n`);
});

test('host configuration restricts user, listen port, forwarding type and sessions', () => {
  const key = makeConnectionKey('synthetic-tunnel');
  assert.match(key.publicKey, / synthetic-tunnel$/);
  assert.throws(() => makeConnectionKey('two words'), /comment was refused/);
  let invocation;
  prepareConnectionHost(config, key.publicKey, { run: (command, args, options) => { invocation = { command, args, options }; return 'ready'; } });
  assert.equal(invocation.command, '/usr/bin/ssh');
  for (const text of ["service_user='tunnel-user'", "service_port='18789'", 'GatewayPorts no', 'AllowTcpForwarding remote', 'PermitOpen none', 'MaxSessions 0', 'ForceCommand /usr/bin/false']) assert.ok(invocation.options.input.includes(text));
  assert.ok(!invocation.options.input.includes(key.privateKey));
});

test('reconnect asks for the credential again and abort ends the active child', async () => {
  const key = makeConnectionKey('synthetic-tunnel'), stop = new AbortController();
  let reads = 0, starts = 0, killed = 0;
  const spawnImpl = () => {
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.stdio = [null, null, child.stderr, new PassThrough()];
    child.kill = () => { killed++; child.emit('exit', 0); };
    starts++;
    queueMicrotask(() => starts === 1 ? child.emit('exit', 255) : stop.abort());
    return child;
  };
  let adds = 0, closes = 0;
  await serveConnection(config, async () => { reads++; return key.privateKey; }, { spawnImpl, agentOwner: async () => ({ socket: '/private/agent.sock', add: () => { adds++; }, close: () => { closes++; } }), wait: async () => {}, signal: stop.signal });
  assert.equal(reads, 2); assert.equal(starts, 2); assert.equal(killed, 1);
  assert.equal(adds, 2); assert.equal(closes, 1);
});

test('a credential that is not an RSA key is refused before SSH starts', async () => {
  let starts = 0, closes = 0;
  await assert.rejects(serveConnection(config, async () => 'not a key', { spawnImpl: () => { starts++; }, agentOwner: async () => ({ socket: '/private/agent.sock', add: () => {}, close: () => { closes++; } }) }), /credential was refused/);
  assert.equal(starts, 0); assert.equal(closes, 1);
});

test('retained supervision names the source and credential home without copying a credential', () => {
  const programArguments = connectionLaunchArguments({ nodeExecutable: '/bin/node', script: '/source/connection.mjs', configFile: '/state/connection.json', credentialCommand: ['/bin/vault', 'read', 'synthetic-tunnel-key'] });
  const xml = connectionLaunchAgent({ label: 'example.door-tunnel', programArguments, environment: { EXAMPLE_SETTING: '/state' }, logFile: '/state/connection.log' });
  assert.match(xml, /KeepAlive/); assert.match(xml, /EXAMPLE_SETTING/); assert.match(xml, /ThrottleInterval/);
  assert.match(xml, /<string>synthetic-tunnel-key<\/string>/);
  assert.ok(!xml.includes('PRIVATE KEY')); assert.ok(!xml.includes('Bearer'));
  assert.ok(!connectionLaunchAgent({ label: 'example.door-tunnel', programArguments, logFile: '/state/connection.log' }).includes('EnvironmentVariables'));
  for (const bad of [{ nodeExecutable: 'node' }, { credentialCommand: [] }, { credentialCommand: ['vault'] }]) assert.throws(() => connectionLaunchArguments({ nodeExecutable: '/bin/node', script: '/s.mjs', configFile: '/c.json', credentialCommand: ['/bin/vault'], ...bad }), /refused/);
  assert.throws(() => connectionLaunchAgent({ label: 'Bad Label', programArguments, logFile: '/l' }), /refused/);
  assert.throws(() => connectionLaunchAgent({ label: 'example.door-tunnel', programArguments, environment: { 'bad-name': 'x' }, logFile: '/l' }), /refused/);
});

test('the launch command hands the configuration on standard input and the held value on the key descriptor, never in argv', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-launch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vault = join(dir, 'vault.sh'), reader = join(dir, 'reader.mjs'), configFile = join(dir, 'connection.json');
  // A made-up vault command: like the real one, it writes the value only to its descriptor 3.
  writeFileSync(vault, '#!/bin/sh\nprintf "held value for %s" "$1" >&3\necho "never seen" \n'); chmodSync(vault, 0o700);
  writeFileSync(reader, `import { readFileSync } from 'node:fs';\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input: readFileSync(0, 'utf8'), key: readFileSync(${keyDescriptor}, 'utf8') }));\n`);
  writeFileSync(configFile, '{"address":"192.0.2.34"}');
  const [command, ...args] = connectionLaunchArguments({ nodeExecutable: process.execPath, script: reader, configFile, credentialCommand: [vault, 'synthetic-tunnel-key'] });
  const ran = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), { argv: ['serve'], input: '{"address":"192.0.2.34"}', key: 'held value for synthetic-tunnel-key' });
});

test('install writes the agent beside its configuration and replaces the running one', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-install-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'connection.json');
  writeFileSync(configFile, JSON.stringify(config));
  const calls = [];
  const result = installConnection(configFile, { label: 'example.door-tunnel', credentialCommand: ['/bin/vault', 'read', 'synthetic-tunnel-key'], nodeExecutable: '/bin/node', uid: 501, home: dir, run:(command, args) => { calls.push([command, ...args]); if (args[0] === 'bootout') throw Object.assign(new Error('gone'), { stderr: 'Could not find service' }); } });
  assert.equal(result.definition, join(dir, 'Library/LaunchAgents/example.door-tunnel.plist'));
  assert.deepEqual(calls.map(call => call[1]), ['bootout', 'bootstrap']);
  const xml = readFileSync(result.definition, 'utf8');
  assert.ok(xml.includes(`<string>${join(dir, 'connection.log')}</string>`));
  assert.ok(xml.includes(`<string>${configFile}</string>`));
  assert.ok(xml.includes('<string>synthetic-tunnel-key</string>'));
  assert.ok(xml.includes('<key>Label</key><string>example.door-tunnel</string>'));
});

test('preparing a server reaches it through the run\'s proxy as the given administrator, with the request\'s host key pinned', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-prepare-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const adminKeyFile = join(dir, 'admin-key');
  writeFileSync(adminKeyFile, 'synthetic administration key');
  const { publicKey } = makeConnectionKey('synthetic-tunnel');
  const request = { address: '192.0.2.34', ssh_port: 2222, admin_user: 'admin', host_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample', user: 'tunnel-user', remotePort: 18789, localPort: 8789, publicKey };
  let invocation, pinned;
  const answer = prepareFromRequest(request, adminKeyFile, { proxy: 'http://127.0.0.1:40123', run: (command, args, options) => {
    invocation = { command, args, options };
    pinned = readFileSync(args.find(arg => arg.startsWith('UserKnownHostsFile=')).slice('UserKnownHostsFile='.length), 'utf8');
    return 'tunnel-host-prepared: tunnel-user may listen only on 127.0.0.1:18789\n';
  } });
  assert.deepEqual(answer, { prepared: true, said: 'tunnel-host-prepared: tunnel-user may listen only on 127.0.0.1:18789' });
  assert.equal(invocation.args[1], 'ProxyCommand=/usr/bin/nc -X connect -x 127.0.0.1:40123 %h %p');
  assert.deepEqual(invocation.args.slice(-3), ['admin@192.0.2.34', '/bin/sh', '-s']);
  assert.equal(pinned, `[192.0.2.34]:2222 ${request.host_key}\n`);
  assert.equal(readFileSync(adminKeyFile, 'utf8'), 'synthetic administration key\n');
  assert.throws(() => prepareFromRequest({ ...request, host_key: undefined }, adminKeyFile, { run: () => '' }), /host_key is missing/);
});
