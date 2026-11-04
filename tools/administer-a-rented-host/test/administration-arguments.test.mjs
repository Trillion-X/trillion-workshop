// The administration SSH arguments: the caller's host, port and user, the one pinned key, and refusals that say what to
// fix. Every host here is synthetic (192.0.2.x, example.com).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { administrationArguments, checkedHost, knownHostsLine } from '../do-work/administration-arguments.mjs';

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
