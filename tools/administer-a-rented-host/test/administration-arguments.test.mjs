// The administration SSH arguments: the caller's host, port and user, the one pinned key, and refusals that say what to
// fix. Every host here is synthetic (192.0.2.x, example.com).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { administrationArguments, checkedHost, heldKeyFile, knownHostsLine, proxied } from '../do-work/administration-arguments.mjs';

const host = { address: '192.0.2.10', ssh_port: 2222, admin_user: 'builder', host_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample' };

test('the arguments reach the given user, address and port with only the given key and pinned host key', () => {
  const args = administrationArguments({ ...host, adminKeyFile: '/run/held/admin-key', knownHostsFile: '/tmp/x/known_hosts' });
  assert.equal(args.at(-1), 'builder@192.0.2.10');
  assert.deepEqual(args.slice(0, 5), ['-T', '-p', '2222', '-i', '/run/held/admin-key']);
  for (const option of ['IdentitiesOnly=yes', 'IdentityAgent=none', 'BatchMode=yes', 'StrictHostKeyChecking=yes', 'UserKnownHostsFile=/tmp/x/known_hosts', 'GlobalKnownHostsFile=/dev/null']) assert.ok(args.includes(option), option);
});

test('the known_hosts line names the port the way OpenSSH looks it up', () => {
  assert.equal(knownHostsLine(host), `[192.0.2.10]:2222 ${host.host_key}\n`);
  assert.equal(knownHostsLine({ ...host, address: 'build.example.com', ssh_port: 22 }), `build.example.com ${host.host_key}\n`);
});

test('a host that cannot be reached safely is refused, naming the field to fix', () => {
  const refused = (change, field) => assert.throws(() => checkedHost({ ...host, ...change }), new RegExp(field.replace('.', '\\.')));
  refused({ address: '192.0.2.300' }, 'host.address');
  refused({ address: 'build.example.com; rm -rf /' }, 'host.address');
  refused({ address: 'Build.Example.com' }, 'host.address');
  refused({ ssh_port: 0 }, 'host.ssh_port');
  refused({ ssh_port: '22' }, 'host.ssh_port');
  refused({ admin_user: 'root;id' }, 'host.admin_user');
  refused({ host_key: 'ssh-ed25519 AAAA\nevil' }, 'host.host_key');
  assert.throws(() => checkedHost(undefined), /host is missing/);
  assert.throws(() => administrationArguments({ ...host, knownHostsFile: '/k' }), /administration identity was refused/);
  assert.throws(() => administrationArguments({ ...host, adminKeyFile: '/k' }), /known-hosts file is missing/);
  assert.throws(() => knownHostsLine({ ...host, host_key: undefined }), /host_key is missing/);
  // A caller that pinned the host some other way (its own known_hosts file) need not give host_key.
  assert.equal(administrationArguments({ ...host, host_key: undefined, adminKeyFile: '/k', knownHostsFile: '/kh' }).at(-1), 'builder@192.0.2.10');
});

test('a run\'s proxy is reached through its CONNECT tunnel with a keepalive, and only a loopback http proxy is taken', () => {
  const args = { ...host, adminKeyFile: '/k', knownHostsFile: '/kh' };
  assert.deepEqual(administrationArguments({ ...args, proxy: 'http://127.0.0.1:40123' }).slice(0, 2), ['-o', 'ProxyCommand=/usr/bin/nc -X connect -x 127.0.0.1:40123 %h %p']);
  assert.deepEqual(administrationArguments({ ...args, proxy: null }).slice(0, 5), ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', '-T']);
  assert.equal(administrationArguments(args)[0], '-T');
  assert.ok(proxied(undefined).includes('ServerAliveInterval=30'));
  for (const refused of ['https://127.0.0.1:1', 'http://proxy.example.com:8080', 'http://127.0.0.1:1;touch']) assert.throws(() => proxied(refused), /proxy setting was refused/);
});

test('a held key file gets back the last newline ssh needs, once, in place', t => {
  const folder = mkdtempSync(join(tmpdir(), 'held-key-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'key');
  writeFileSync(file, 'synthetic key');
  assert.equal(heldKeyFile(file), file);
  heldKeyFile(file);
  assert.equal(readFileSync(file, 'utf8'), 'synthetic key\n');
});
