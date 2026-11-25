// tools/start-a-computer/test/sign-in-host.test.mjs
//
// What a computer needs before its row's sign-in unit can start: the packages and the node release the set-up data names
// (settings.json `machine`), installed by set-up-the-machine.sh with stand-in programs, and the unit's secret, handed by
// vault name and sealed on the computer with systemd-creds, never written in a unit, a command line or an answer.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWhatItRuns, readRequest } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';

const SETTINGS = JSON.parse(readFileSync(new URL('../read-data/settings.json', import.meta.url), 'utf8'));
const SCRIPT = new URL('../do-work/set-up-the-machine.sh', import.meta.url).pathname;
const SECRET = 'made-up-secret-value-for-this-test-only';

const signInUnit = (root, extra = {}) => ({
  unit: 'example-sign-in.service', template: 'tools/better-auth-official/on-a-computer/serve-better-auth.service', description: 'Example sign-in', user: 'example-sign-in',
  state: `${root}/var/lib/example-sign-in`, workshop: `${root}/var/lib/example-sign-in/trillion-workshop`,
  repository: 'https://github.com/Trillion-X/trillion-workshop.git', tool_folder: 'tools/better-auth-official', workshop_commit: '7777777777777777777777777777777777777777',
  node_bin: `${root}/opt/node/bin`, settings_file: `${root}/var/lib/example-sign-in/settings.json`, settings: { port: 7201 },
  secret_vault_key: 'example-better-auth-secret', secret_name: 'better-auth-secret',
  secret_file: `${root}/etc/credstore.encrypted/better-auth-secret`,
  credentials: [{ vault_key: 'example-store', name: 'sign-in-store', file: `${root}/etc/credstore.encrypted/sign-in-store`, env: 'BETTER_AUTH_STORE_CONNECTION' }], writable: `${root}/var/lib/example-sign-in`, ...extra,
});

test('the set-up data names git and curl, and no node release: a computer row gives its own (apply-what-a-computer-runs tests it)', () => {
  const { packages, node } = SETTINGS.machine;
  for (const name of ['caddy', 'jq', 'ufw', 'git', 'curl']) assert.ok(packages.includes(name), `machine.packages names ${name}`);
  assert.equal(node, undefined);
  const script = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(script, /nodejs\.org|apt-get install -y -qq caddy/, 'the script names no package and no download address of its own');
});

// A machine made of stand-in programs under `root`: apt-get, useradd, id, install, ufw and uname record what they are asked;
// curl hands back the tarball the test made; tar, mkdir and jq are the real ones.
function standInMachine({ tarball, arch = 'x86_64' }) {
  const root = tempFolder(join(tmpdir(), 'set-up-machine-'));
  const bin = join(root, 'stand-in-bin'), log = join(root, 'calls.log');
  mkdirSync(bin);
  const program = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  for (const name of ['apt-get', 'useradd', 'install', 'ufw']) program(name, `echo "${name} $*" >> '${log}'`);
  program('id', 'exit 1');
  program('uname', `echo ${arch}`);
  program('curl', `echo "curl $*" >> '${log}'; while [ $# -gt 0 ]; do if [ "$1" = -o ]; then cp '${tarball}' "$2"; fi; shift; done`);
  // `sha256sum FILE` prints the digest; `sha256sum -c --status` reads "DIGEST  FILE" lines from stdin and exits 1 on a mismatch.
  program('sha256sum', `node -e 'const c=require("crypto"),f=require("fs");const sum=p=>c.createHash("sha256").update(f.readFileSync(p)).digest("hex");if(process.argv[1]==="-c"){const bad=f.readFileSync(0,"utf8").trim().split("\\n").some(l=>{const[h,p]=l.split(/  /);try{return sum(p)!==h}catch{return true}});process.exit(bad?1:0)}process.stdout.write(sum(process.argv[1])+"  "+process.argv[1]+"\\n")' -- "$@"`);
  return { root, bin, log };
}

function fakeNodeTarball() {
  const at = tempFolder(join(tmpdir(), 'fake-node-'));
  const top = join(at, 'node-v0-linux-x64', 'bin');
  mkdirSync(top, { recursive: true });
  writeFileSync(join(top, 'node'), '#!/bin/sh\necho v24.0.0-stand-in\n');
  chmodSync(join(top, 'node'), 0o755);
  const tarball = join(at, 'node.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', at, 'node-v0-linux-x64']).status, 0);
  return { tarball, sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex') };
}

const setUp = (machine, runs, data) => spawnSync('sh', [SCRIPT, JSON.stringify(runs), JSON.stringify(data)], {
  env: { PATH: `${machine.bin}:${process.env.PATH}` }, encoding: 'utf8',
});

test('set-up installs the packages the set-up data names and the node release for the machine kind into the unit\'s node folder', () => {
  const { tarball, sha256 } = fakeNodeTarball();
  const machine = standInMachine({ tarball });
  const data = { packages: ['caddy', 'jq', 'ufw', 'git', 'curl'], node: { version: 'v24.0.0', files: { x86_64: { url: 'https://releases.example.test/node-x64.tar.gz', sha256 } } } };
  const runs = { units: [signInUnit(machine.root)] };
  const ran = setUp(machine, runs, data);
  assert.equal(ran.status, 0, ran.stderr);
  const calls = readFileSync(machine.log, 'utf8');
  assert.match(calls, /^apt-get install -y -qq -o Dpkg::Options::=--force-confold caddy jq ufw git curl$/m);
  assert.match(calls, /^curl -fsSL -o \S+ https:\/\/releases\.example\.test\/node-x64\.tar\.gz$/m);
  assert.match(calls, /^useradd --system --home-dir \S+\/var\/lib\/example-sign-in /m, 'a unit with no engine config is set up from its state folder');
  assert.equal(spawnSync(join(machine.root, 'opt/node/bin/node'), { encoding: 'utf8' }).stdout.trim(), 'v24.0.0-stand-in');
  // A second set-up finds node in place and downloads nothing.
  writeFileSync(machine.log, '');
  assert.equal(setUp(machine, runs, data).status, 0);
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

test('a unit that names uid is made with that user id, and an account that already has another id is refused, not changed', () => {
  const { tarball, sha256 } = fakeNodeTarball();
  const data = { packages: ['git'], node: { version: 'v24.0.0', files: { x86_64: { url: 'https://releases.example.test/node-x64.tar.gz', sha256 } } } };
  const machine = standInMachine({ tarball });
  const ran = setUp(machine, { units: [signInUnit(machine.root, { uid: 1104 })] }, data);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(readFileSync(machine.log, 'utf8'), /^useradd --system --uid 1104 --home-dir \S+\/var\/lib\/example-sign-in /m);
  // The same account already made with another id: set-up refuses before it makes anything.
  const other = standInMachine({ tarball });
  writeFileSync(join(other.bin, 'id'), '#!/bin/sh\necho 997\n');
  chmodSync(join(other.bin, 'id'), 0o755);
  const refused = setUp(other, { units: [signInUnit(other.root, { uid: 1104 })] }, data);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /has uid 997 on this computer, not the row's 1104/);
  assert.doesNotMatch(readFileSync(other.log, 'utf8'), /^useradd /m);
  const bad = setUp(standInMachine({ tarball }), { units: [signInUnit(machine.root, { uid: 'root' })] }, data);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /names uid root, which is not a number/);
});

// A computer whose sealed credentials and files are kept in `live`; `commands` records every command and what reached its stdin.
const computer = (live, { accounts = true } = {}) => {
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input: input === undefined ? undefined : String(input) });
    // A set-up computer's firewall admits the settings' ports.
    if (command.startsWith('ufw status')) return 'Status: active\n\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n';
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
const runsFor = unit => ({ health_listen: '127.0.0.1:7199', health: { host: 'place.example.test' }, units: [unit], unmanaged: [] });

test('the sign-in unit loads its secret sealed for the computer, by the name the row gives, and holds no value', () => {
  const unit = signInUnit('');
  const text = renderWhatItRuns(runsFor(unit)).find(file => file.path === '/etc/systemd/system/example-sign-in.service').text;
  assert.match(text, /^LoadCredentialEncrypted=better-auth-secret:\/etc\/credstore\.encrypted\/better-auth-secret$/m);
  assert.match(text, /"\$CREDENTIALS_DIRECTORY\/better-auth-secret"/);
  assert.doesNotMatch(text, /^LoadCredential=/m);
});

test('a computer without the secret gets the value held under its vault name sealed by systemd-creds, never in a command line or the answer', async () => {
  const unit = signInUnit('');
  const runs = runsFor(unit);
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  live[`${unit.node_bin}/node`] = 'node';
  const { run, commands } = computer(live);
  const answer = await applyWhatItRuns(machine, runs, run, { 'example-better-auth-secret': SECRET, 'example-store': 'made-up-store-connection' });
  const sealed = commands.find(({ command }) => command.includes('systemd-creds encrypt'));
  assert.ok(sealed, 'the secret is sealed on the computer');
  assert.equal(sealed.command, "install -d -m 0700 '/etc/credstore.encrypted' && umask 077 && systemd-creds encrypt --name='better-auth-secret' - '/etc/credstore.encrypted/better-auth-secret'");
  assert.equal(sealed.input, SECRET, 'the value travels only on the SSH channel\'s standard input');
  assert.ok(commands.every(({ command }) => !command.includes(SECRET)), 'no command line carries the value');
  assert.ok(!JSON.stringify(answer).includes(SECRET), 'the answer carries no value');
  assert.deepEqual(answer.sealed, ['better-auth-secret', 'sign-in-store']);
  assert.ok(answer.restarted.includes('example-sign-in.service'), 'a unit whose secret was just sealed is restarted to load it');
});

test('a computer that already holds the sealed secret is sent nothing; one without it and no value handed is refused by vault name', async () => {
  const unit = signInUnit('');
  const runs = runsFor(unit);
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  live[`${unit.node_bin}/node`] = 'node';
  live[unit.secret_file] = 'sealed';
  live[unit.credentials[0].file] = 'sealed';
  const held = computer({ ...live });
  assert.deepEqual(await applyWhatItRuns(machine, runs, held.run, {}), { written: [], restarted: [] });
  assert.ok(held.commands.every(({ command }) => !command.includes('systemd-creds')));
  delete live[unit.secret_file];
  const missing = computer(live);
  await assert.rejects(applyWhatItRuns(machine, runs, missing.run, {}), /example-better-auth-secret.*descriptor 5/);
  assert.ok(missing.commands.every(({ command }) => !/systemd-creds|systemctl (restart|enable)/.test(command)));
});

test('a computer whose sign-in unit\'s node is missing is set up again even when its accounts exist', async () => {
  const unit = signInUnit('');
  const runs = runsFor(unit);
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  live[unit.secret_file] = 'sealed';
  live[unit.credentials[0].file] = 'sealed';
  const { run, commands } = computer(live);
  await applyWhatItRuns(machine, runs, run, {});
  const setUp = commands.find(({ command }) => command.startsWith('sh -s -- '));
  assert.ok(setUp, 'set-up runs to install node');
  const quoted = `'${JSON.stringify(SETTINGS.machine).replace(/'/g, `'\\''`)}'`;
  assert.ok(setUp.command.endsWith(` ${quoted}`), 'set-up is handed the set-up data from settings.json');
});

// A machine can also need files written, package sources and programs fetched before its units run; every address, path and
// pinned digest is the row's own data.
test('set-up writes the files and package sources the data names and installs a pinned program only when it is not there', () => {
  const at = tempFolder(join(tmpdir(), 'fake-program-'));
  mkdirSync(join(at, 'pack'));
  writeFileSync(join(at, 'pack', 'tool-x'), '#!/bin/sh\necho tool\n');
  const tarball = join(at, 'tool.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', join(at, 'pack'), 'tool-x']).status, 0);
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const machine = standInMachine({ tarball });
  // This set-up writes real files: the stand-in install logs the call, then makes the folder, or copies the file or standard input.
  writeFileSync(join(machine.bin, 'install'), `#!/bin/sh
echo "install $*" >> '${machine.log}'
make=''; modes=''
for last; do :; done
while [ $# -gt 0 ]; do case "$1" in -d) make=1;; -m) shift;; -o|-g) shift;; *) args="$args $1";; esac; shift; done
set -- $args
if [ -n "$make" ]; then mkdir -p "$@"; elif [ "$1" = /dev/stdin ]; then cat > "$2"; else cp "$1" "$2"; fi
`);
  chmodSync(join(machine.bin, 'install'), 0o755);
  const data = {
    packages: ['git'],
    files: [{ path: `${machine.root}/etc/example/package.conf`, text: 'one = 1\n' }],
    apt_sources: [{ name: 'example', key_url: 'https://keys.example.test/example.asc', key_sha256: digest(tarball), line: 'deb https://packages.example.test stable main',
      key_file: `${machine.root}/etc/apt/keyrings/example.asc`, list_file: `${machine.root}/etc/apt/sources.list.d/example.list` }],
    downloads: [{ path: `${machine.root}/usr/local/bin/tool-x`, files: { x86_64: { url: 'https://tools.example.test/tool.tar.gz', sha256: digest(tarball), member: 'tool-x', binary_sha256: digest(join(at, 'pack', 'tool-x')) } } }],
  };
  const ran = setUp(machine, { units: [] }, data);
  assert.equal(ran.status, 0, ran.stderr);
  const calls = readFileSync(machine.log, 'utf8');
  assert.match(calls, /^curl -fsSL -o \S+example\.asc\.new https:\/\/keys\.example\.test\/example\.asc$/m);
  assert.match(calls, /^curl -fsSL -o \S+ https:\/\/tools\.example\.test\/tool\.tar\.gz$/m);
  assert.match(calls, /^install -m 0755 \S+\/tool-x \S+\/usr\/local\/bin\/tool-x$/m);
  assert.ok(calls.indexOf('example.asc.new') < calls.indexOf('apt-get update'), 'the source is in place before the package lists are read');
  assert.ok(calls.indexOf('apt-get install') < calls.indexOf('tool.tar.gz'), 'programs are fetched after the packages');
  // A program already there as the pinned bytes is not fetched again, and a key that is not the pinned one is refused.
  mkdirSync(join(machine.root, 'usr/local/bin'), { recursive: true });
  writeFileSync(join(machine.root, 'usr/local/bin/tool-x'), readFileSync(join(at, 'pack', 'tool-x')));
  writeFileSync(machine.log, '');
  assert.equal(setUp(machine, { units: [] }, { ...data, apt_sources: [] }).status, 0);
  assert.doesNotMatch(readFileSync(machine.log, 'utf8'), /tools\.example\.test/);
  // A file already there is written again through a temporary file and one rename, never `install /dev/stdin`, which Ubuntu
  // 26.04's coreutils (uutils 0.10.0) refuses with "No such file or directory" when the file exists (Nov 24 2026).
  assert.doesNotMatch(readFileSync(machine.log, 'utf8'), /\/dev\/stdin/);
  assert.equal(readFileSync(join(machine.root, 'etc/example/package.conf'), 'utf8'), 'one = 1\n');
  const wrong = setUp(machine, { units: [] }, { ...data, files: [], downloads: [], apt_sources: [{ ...data.apt_sources[0], key_sha256: '0'.repeat(64) }] });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /is not the pinned one/);
});

test('a unit\'s parts put a file the person keeps into its settings, read relative to the computer row\'s file', () => {
  const dir = tempFolder(join(tmpdir(), 'settings-parts-'));
  mkdirSync(join(dir, 'rows', 'providers'), { recursive: true });
  const sender = { name: 'Example sender', vault_key: 'example-sender-key', request: { url: 'https://mail.example.test/send', method: 'POST' } };
  writeFileSync(join(dir, 'rows', 'providers', 'example-sender.json'), JSON.stringify(sender));
  const unit = signInUnit('', { settings: { port: 7201, email: { from: 'Example <sign-in@example.test>' } }, parts: { '/settings/email/sender': { file: 'providers/example-sender.json' } } });
  writeFileSync(join(dir, 'rows', 'computer.json'), JSON.stringify({ name: 'example-computer', runs: runsFor(unit) }));
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ computer_row_file: 'rows/computer.json' }));
  const [read] = readRequest(join(dir, 'request.json')).computer_row.runs.units;
  assert.deepEqual(read.settings.email, { from: 'Example <sign-in@example.test>', sender });
  assert.equal(read.parts, undefined, 'the rendered settings carry the file, not its name');
  writeFileSync(join(dir, 'rows', 'computer.json'), JSON.stringify({ name: 'example-computer', runs: runsFor({ ...unit, settings: { port: 7201 } }) }));
  assert.throws(() => readRequest(join(dir, 'request.json')), /parts \/settings\/email\/sender: the unit holds nothing at \/settings\/email/);
});

test('a settings part puts any value of any file at any place in the settings, each by a JSON Pointer, and names no field itself', () => {
  const dir = tempFolder(join(tmpdir(), 'settings-parts-pointers-'));
  mkdirSync(join(dir, 'rows', 'mine'), { recursive: true });
  writeFileSync(join(dir, 'rows', 'mine', 'what-we-are.json'), JSON.stringify({ called: 'Acme', 'a/b': { '~x': 'escaped' }, look: { css: 'x'.repeat(50000) } }));
  const parts = { '/settings/doors/0/server_name': { file: 'mine/what-we-are.json', pointer: '/called' }, '/settings/doors/0/odd': { file: 'mine/what-we-are.json', pointer: '/a~1b/~0x' } };
  const engine = { unit: 'engine.service', settings: { doors: [{ id: 'front', accepts_hosts: ['acme.example.test'] }] }, parts };
  writeFileSync(join(dir, 'rows', 'computer.json'), JSON.stringify({ name: 'example-computer', runs: { units: [engine] } }));
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ computer_row_file: 'rows/computer.json' }));
  const [read] = readRequest(join(dir, 'request.json')).computer_row.runs.units;
  assert.deepEqual(read.settings.doors[0], { id: 'front', accepts_hosts: ['acme.example.test'], server_name: 'Acme', odd: 'escaped' });
  for (const [bad, said] of [[{ 'settings.doors.0.name': { file: 'mine/what-we-are.json' } }, /starts with \//], [{ '/settings/doors/0/x': { file: 'mine/what-we-are.json', pointer: '/missing' } }, /nothing is at \/missing/]]) {
    writeFileSync(join(dir, 'rows', 'computer.json'), JSON.stringify({ name: 'example-computer', runs: { units: [{ ...engine, parts: bad }] } }));
    assert.throws(() => readRequest(join(dir, 'request.json')), said);
  }
});

// The vault is the original: a credential the computer holds that differs from the value now handed is sealed again and its unit
// restarts, and one that matches is left alone.
test('a held credential whose handed value differs from the sealed one is sealed again, and a matching one is left', async () => {
  const unit = signInUnit('');
  const runs = runsFor(unit);
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  live[`${unit.node_bin}/node`] = 'node';
  live[unit.secret_file] = 'sealed';
  live[unit.credentials[0].file] = 'sealed';
  const base = computer({ ...live });
  const asked = [];
  const run = async (m, command, input) => {
    if (command.startsWith('test "$(systemd-creds decrypt')) {
      asked.push({ command, input });
      if (command.includes("--name='sign-in-store'")) throw Object.assign(new Error('differs'), { code: 3 });
      return '';
    }
    return base.run(m, command, input);
  };
  const answer = await applyWhatItRuns(machine, runs, run, { 'example-better-auth-secret': SECRET, 'example-store': 'rotated-store-connection' });
  assert.equal(asked.length, 2, 'each handed credential the computer holds is compared');
  assert.ok(asked.every(({ command }) => !command.includes(SECRET) && !command.includes('rotated-store-connection')), 'no command line carries a value');
  assert.deepEqual(answer.sealed, ['sign-in-store']);
  const sealed = base.commands.filter(({ command }) => command.includes('systemd-creds encrypt'));
  assert.equal(sealed.length, 1);
  assert.equal(sealed[0].input, 'rotated-store-connection');
  assert.ok(answer.restarted.includes('example-sign-in.service'), 'the unit that loads it restarts');
});
