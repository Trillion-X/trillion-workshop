// tools/start-a-computer/test/sign-in-host.test.mjs
//
// What a computer needs before its layout's sign-in unit can start: the packages and the node release the set-up data names
// (settings.json `machine`), installed by set-up-the-machine.sh with stand-in programs, and the unit's secret, handed by
// vault name and sealed on the computer with systemd-creds, never written in a unit, a command line or an answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHostLayout, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderLayout } from '../do-work/render-layout.mjs';

const SETTINGS = JSON.parse(readFileSync(new URL('../read-data/settings.json', import.meta.url), 'utf8'));
const SCRIPT = new URL('../do-work/set-up-the-machine.sh', import.meta.url).pathname;
const SECRET = 'made-up-secret-value-for-this-test-only';

const signInUnit = (root, extra = {}) => ({
  unit: 'example-sign-in.service', template: 'serve-better-auth', description: 'Example sign-in', user: 'example-sign-in',
  state: `${root}/var/lib/example-sign-in`, workshop: `${root}/var/lib/example-sign-in/trillion-workshop`,
  repository: 'https://github.com/Trillion-X/trillion-workshop.git', tool_folder: 'tools/better-auth-official',
  node_bin: `${root}/opt/node/bin`, settings_file: `${root}/var/lib/example-sign-in/settings.json`, settings: { port: 7201 },
  secret_vault_key: 'example-better-auth-secret', secret_name: 'better-auth-secret',
  secret_file: `${root}/etc/credstore.encrypted/better-auth-secret`, writable: `${root}/var/lib/example-sign-in`, ...extra,
});

test('the set-up data names git, curl and a node release of 22.13 or newer for each machine kind, by address and sha256', () => {
  const { packages, node } = SETTINGS.machine;
  for (const name of ['caddy', 'jq', 'ufw', 'git', 'curl']) assert.ok(packages.includes(name), `machine.packages names ${name}`);
  const [major, minor] = node.version.replace(/^v/, '').split('.').map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 13), `node ${node.version} is 22.13 or newer`);
  for (const arch of ['x86_64', 'aarch64']) {
    assert.match(node.files[arch].url, /^https:\/\//);
    assert.match(node.files[arch].sha256, /^[0-9a-f]{64}$/);
  }
  const script = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(script, /nodejs\.org|apt-get install -y -qq caddy/, 'the script names no package and no download address of its own');
});

// A machine made of stand-in programs under `root`: apt-get, useradd, id, install, ufw and uname record what they are asked;
// curl hands back the tarball the test made; tar, mkdir and jq are the real ones.
function standInMachine({ tarball, arch = 'x86_64' }) {
  const root = mkdtempSync(join(tmpdir(), 'set-up-machine-'));
  const bin = join(root, 'stand-in-bin'), log = join(root, 'calls.log');
  mkdirSync(bin);
  const program = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  for (const name of ['apt-get', 'useradd', 'install', 'ufw']) program(name, `echo "${name} $*" >> '${log}'`);
  program('id', 'exit 1');
  program('uname', `echo ${arch}`);
  program('curl', `echo "curl $*" >> '${log}'; while [ $# -gt 0 ]; do if [ "$1" = -o ]; then cp '${tarball}' "$2"; fi; shift; done`);
  program('sha256sum', `node -e 'const c=require("crypto");process.stdout.write(c.createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex")+"  "+process.argv[1]+"\\n")' "$1"`);
  return { root, bin, log };
}

function fakeNodeTarball() {
  const at = mkdtempSync(join(tmpdir(), 'fake-node-'));
  const top = join(at, 'node-v0-linux-x64', 'bin');
  mkdirSync(top, { recursive: true });
  writeFileSync(join(top, 'node'), '#!/bin/sh\necho v24.0.0-stand-in\n');
  chmodSync(join(top, 'node'), 0o755);
  const tarball = join(at, 'node.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', at, 'node-v0-linux-x64']).status, 0);
  return { tarball, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') };
}

const setUp = (machine, layout, data) => spawnSync('sh', [SCRIPT, JSON.stringify(layout), JSON.stringify(data)], {
  env: { PATH: `${machine.bin}:${process.env.PATH}` }, encoding: 'utf8',
});

test('set-up installs the packages the set-up data names and the node release for the machine kind into the unit\'s node folder', () => {
  const { tarball, sha256 } = fakeNodeTarball();
  const machine = standInMachine({ tarball });
  const data = { packages: ['caddy', 'jq', 'ufw', 'git', 'curl'], node: { version: 'v24.0.0', files: { x86_64: { url: 'https://releases.example.test/node-x64.tar.gz', sha256 } } } };
  const layout = { units: [signInUnit(machine.root)] };
  const ran = setUp(machine, layout, data);
  assert.equal(ran.status, 0, ran.stderr);
  const calls = readFileSync(machine.log, 'utf8');
  assert.match(calls, /^apt-get install -y -qq caddy jq ufw git curl$/m);
  assert.match(calls, /^curl -fsSL -o \S+ https:\/\/releases\.example\.test\/node-x64\.tar\.gz$/m);
  assert.match(calls, /^useradd --system --home-dir \S+\/var\/lib\/example-sign-in /m, 'a unit with no engine config is set up from its state folder');
  assert.equal(spawnSync(join(machine.root, 'opt/node/bin/node'), { encoding: 'utf8' }).stdout.trim(), 'v24.0.0-stand-in');
  // A second set-up finds node in place and downloads nothing.
  writeFileSync(machine.log, '');
  assert.equal(setUp(machine, layout, data).status, 0);
  assert.doesNotMatch(readFileSync(machine.log, 'utf8'), /^curl /m);
});

test('set-up refuses a node download whose sha256 is not the one the set-up data names, and installs nothing', () => {
  const { tarball } = fakeNodeTarball();
  const machine = standInMachine({ tarball });
  const data = { packages: ['git'], node: { version: 'v24.0.0', files: { x86_64: { url: 'https://releases.example.test/node-x64.tar.gz', sha256: '0'.repeat(64) } } } };
  const ran = setUp(machine, { units: [signInUnit(machine.root)] }, data);
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /does not match its sha256/);
  assert.equal(existsSync(join(machine.root, 'opt/node/bin/node')), false);
  const other = standInMachine({ tarball, arch: 'riscv64' });
  const none = setUp(other, { units: [signInUnit(other.root)] }, data);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no node release for riscv64/);
});

// A computer whose sealed credentials and files are kept in `live`; `commands` records every command and what reached its stdin.
const computer = (live, { accounts = true } = {}) => {
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input: input === undefined ? undefined : String(input) });
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    if (command.startsWith('test -s ') || command.startsWith('test -x ')) {
      const path = command.match(/^test -[sx] '([^']+)'/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return '';
    }
    if (command.startsWith('getent')) { if (!accounts) throw Object.assign(new Error('no such account'), { code: 3 }); return ''; }
    if (command.includes('systemd-creds encrypt')) live[command.match(/ - '([^']+)'$/)[1]] = 'sealed';
    if (command.includes('curl')) return '200';
    return '';
  };
  return { run, commands };
};

const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };
const layoutFor = unit => ({ caddy: { site_hosts: ['place.example.test'], port: 7199, releases: '/opt/example/releases', routes: ['better-auth'], auth_port: 7201 }, units: [unit], unmanaged: [] });

test('the sign-in unit loads its secret sealed for the computer, by the name the layout gives, and holds no value', () => {
  const unit = signInUnit('');
  const text = renderLayout(layoutFor(unit), SITE_BLOCK).find(file => file.path === '/etc/systemd/system/example-sign-in.service').text;
  assert.match(text, /^LoadCredentialEncrypted=better-auth-secret:\/etc\/credstore\.encrypted\/better-auth-secret$/m);
  assert.match(text, /"\$CREDENTIALS_DIRECTORY\/better-auth-secret"/);
  assert.doesNotMatch(text, /^LoadCredential=/m);
});

test('a computer without the secret gets the value held under its vault name sealed by systemd-creds, never in a command line or the answer', async () => {
  const unit = signInUnit('');
  const layout = layoutFor(unit);
  const live = Object.fromEntries(renderLayout(layout, SITE_BLOCK).map(({ path, text }) => [path, text]));
  live[`${unit.node_bin}/node`] = 'node';
  const { run, commands } = computer(live);
  const answer = await applyHostLayout(machine, layout, run, undefined, { 'example-better-auth-secret': SECRET });
  const sealed = commands.find(({ command }) => command.includes('systemd-creds encrypt'));
  assert.ok(sealed, 'the secret is sealed on the computer');
  assert.equal(sealed.command, "install -d -m 0700 '/etc/credstore.encrypted' && umask 077 && systemd-creds encrypt --name='better-auth-secret' - '/etc/credstore.encrypted/better-auth-secret'");
  assert.equal(sealed.input, SECRET, 'the value travels only on the SSH channel\'s standard input');
  assert.ok(commands.every(({ command }) => !command.includes(SECRET)), 'no command line carries the value');
  assert.ok(!JSON.stringify(answer).includes(SECRET), 'the answer carries no value');
  assert.deepEqual(answer.sealed, ['better-auth-secret']);
  assert.ok(answer.restarted.includes('example-sign-in.service'), 'a unit whose secret was just sealed is restarted to load it');
});

test('a computer that already holds the sealed secret is sent nothing; one without it and no value handed is refused by vault name', async () => {
  const unit = signInUnit('');
  const layout = layoutFor(unit);
  const live = Object.fromEntries(renderLayout(layout, SITE_BLOCK).map(({ path, text }) => [path, text]));
  live[`${unit.node_bin}/node`] = 'node';
  live[unit.secret_file] = 'sealed';
  const held = computer({ ...live });
  assert.deepEqual(await applyHostLayout(machine, layout, held.run, undefined, {}), { written: [], restarted: [] });
  assert.ok(held.commands.every(({ command }) => !command.includes('systemd-creds')));
  delete live[unit.secret_file];
  const missing = computer(live);
  await assert.rejects(applyHostLayout(machine, layout, missing.run, undefined, {}), /example-better-auth-secret.*descriptor 5/);
  assert.ok(missing.commands.every(({ command }) => !/systemd-creds|systemctl (restart|enable)/.test(command)));
});

test('a computer whose sign-in unit\'s node is missing is set up again even when its accounts exist', async () => {
  const unit = signInUnit('');
  const layout = layoutFor(unit);
  const live = Object.fromEntries(renderLayout(layout, SITE_BLOCK).map(({ path, text }) => [path, text]));
  live[unit.secret_file] = 'sealed';
  const { run, commands } = computer(live);
  await applyHostLayout(machine, layout, run, undefined, {});
  const setUp = commands.find(({ command }) => command.startsWith('sh -s -- '));
  assert.ok(setUp, 'set-up runs to install node');
  const quoted = `'${JSON.stringify(SETTINGS.machine).replace(/'/g, `'\\''`)}'`;
  assert.ok(setUp.command.endsWith(` ${quoted}`), 'set-up is handed the set-up data from settings.json');
});
