// tools/start-a-computer/test/sealed-from-the-computers-vault.test.mjs
//
// A unit credential that says `held_on: "computer"` is held only in the vault of the engine on the computer it runs on: the
// apply never asks the vault of whoever applies for it (no descriptor 5 value, no held_value_reader name), and seals it on the
// computer from that computer's own vault, by the reader the row names once in `runs.vault_read`. The value goes from the reader
// into a shell variable and from there into systemd-creds: never into argv, a file, a log, the SSH channel or the answer.
// The shell parts run here in a real sh with stand-in programs; the apply runs against a made-up computer.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWhatItRuns, onComputerSeal, onComputerState, secretsOf, vaultReadOf } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';
import { heldNamesOf } from '../do-work/apply-a-computer-row.mjs';

const VALUE = 'made-up-door-key-for-this-test-only';
const READ = { user: 'example-engine', command: ['/opt/example/engine', 'secrets', '--through-engine', '/etc/example/computer.json', 'person-a', 'read', '{name}'], answers_on: 3 };

test('the reader is the row\'s command line with the vault name at {name}, run as its account, its answer descriptor piped by that account', () => {
  const readOf = vaultReadOf(READ);
  assert.equal(readOf('door-key'), "runuser -u 'example-engine' -- sh -c '\"$@\" 3>&1 >/dev/null | cat' sh '/opt/example/engine' 'secrets' '--through-engine' '/etc/example/computer.json' 'person-a' 'read' 'door-key'");
  assert.equal(vaultReadOf({ command: ['/opt/example/reader', '{name}'] })('door-key'), "'/opt/example/reader' 'door-key'", 'a reader that prints on standard output as root is run as it is');
  assert.equal(vaultReadOf({ command: ['/opt/example/reader', '{name}'], user: 'example-engine' })('it'), "runuser -u 'example-engine' -- '/opt/example/reader' 'it'");
});

test('a vault_read that is missing or unclear is refused in words', () => {
  for (const bad of [undefined, {}, { command: ['/opt/example/reader'] }, { command: ['{name}', 'x'] }, { command: ['/r', '{name}', '{name}'] },
    { command: ['/r', '{name}'], answers_on: 2 }, { command: ['/r', '{name}'], answers_on: 0 }, { command: ['/r', '{name}'], answers_on: '3' },
    { command: ['/r', '{name}'], user: 'Root; rm' }, { command: ['/r', ''] }]) {
    assert.throws(() => vaultReadOf(bad), /runs\.vault_read/, JSON.stringify(bad));
  }
});

test('held_on is "computer" or absent; any other word is refused by the credential\'s name', () => {
  const unit = credentials => ({ unit: 'example.service', credentials });
  assert.deepEqual(secretsOf(unit([{ vault_key: 'a', name: 'a', file: '/etc/credstore.encrypted/a', held_on: 'computer' }, { vault_key: 'b', name: 'b', file: '/etc/credstore.encrypted/b' }])).map(secret => secret.on_computer), [true, false]);
  assert.throws(() => secretsOf(unit([{ vault_key: 'a', name: 'a-name', file: '/x', held_on: 'gateway' }])), /a-name says held_on "gateway"/);
});

test('the applier\'s reader is never asked for a credential held on the computer', () => {
  const row = { runs: { units: [{ unit: 'u.service', credentials: [{ vault_key: 'here', name: 'h', file: '/x/h' }, { vault_key: 'there', name: 't', file: '/x/t', held_on: 'computer' }] }] } };
  assert.deepEqual(heldNamesOf(row), ['here']);
});

// A sh with stand-ins: the engine writes the value it holds (a file only the test reads, absent: holds none) on descriptor 3 and
// refuses a standard output in its place; runuser runs the rest as given; systemd-creds seals by prefixing and records its argv.
function standIns() {
  const root = tempFolder(join(tmpdir(), 'computer-vault-'));
  const bin = join(root, 'bin'), argv = join(root, 'argv.log'), holds = join(root, 'held'), sealed = join(root, 'credstore', 'door');
  mkdirSync(bin);
  const program = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${argv}'\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  program('engine', `[ -p /dev/fd/3 ] || [ -S /dev/fd/3 ] || { echo 'descriptor 3 is not a pipe' >&2; exit 1; }
[ -f '${holds}' ] || { echo 'not held' >&2; exit 1; }
printf '%s' "$(cat '${holds}')" >&3`);
  program('runuser', 'while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  program('systemd-creds', `case "$1" in
encrypt) out="$4"; { printf 'sealed:'; cat; } > "$out" ;;
decrypt) sed 's/^sealed://' "$3" ;;
esac`);
  const readOf = vaultReadOf({ ...READ, command: [join(bin, 'engine'), 'read', '{name}'] });
  const secret = { unit: 'example.service', secret_vault_key: 'door-key', secret_name: 'door', secret_file: sealed, on_computer: true };
  const sh = command => spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
  return { holds, sealed, argv, readOf, secret, sh, hold: value => writeFileSync(holds, value) };
}

test('the seal reads the computer\'s own vault into a shell variable and seals that value; no argv carries it', () => {
  const at = standIns();
  at.hold(VALUE);
  const sealed = at.sh(onComputerSeal(at.readOf, at.secret));
  assert.equal(sealed.status, 0, sealed.stderr);
  assert.equal(readFileSync(at.sealed, 'utf8'), `sealed:${VALUE}`, 'the sealed file holds exactly the value the vault holds');
  assert.ok(!readFileSync(at.argv, 'utf8').includes(VALUE), 'no program\'s argv carried the value');
  assert.ok(!onComputerSeal(at.readOf, at.secret).includes(VALUE));
  assert.ok(!sealed.stdout.includes(VALUE) && !sealed.stderr.includes(VALUE), 'nothing printed carries it');
});

test('a vault that answers nothing seals nothing and exits 4', () => {
  const at = standIns();
  const sealed = at.sh(onComputerSeal(at.readOf, at.secret));
  assert.equal(sealed.status, 4);
  assert.equal(existsSync(at.sealed), false);
});

test('the state: absent file is sealed (3), or refused when the vault holds nothing (4); a held file is kept when the same or unread (0), sealed again when it differs (3)', () => {
  const at = standIns();
  const state = () => at.sh(onComputerState(at.readOf, at.secret)).status;
  assert.equal(state(), 4, 'no file, nothing held');
  at.hold(VALUE);
  assert.equal(state(), 3, 'no file, a value held');
  assert.equal(at.sh(onComputerSeal(at.readOf, at.secret)).status, 0);
  assert.equal(state(), 0, 'the sealed file opens to the held value');
  at.hold('a-newer-made-up-value');
  assert.equal(state(), 3, 'the vault is the original: a changed value is sealed again');
  writeFileSync(at.holds, '');
  assert.equal(state(), 0, 'a vault that answers nothing leaves the sealed file the unit runs on');
  assert.ok(!readFileSync(at.argv, 'utf8').includes(VALUE));
});

// The apply against a made-up computer: `codes` is the exit of the held-on-computer state command per sealed file.
const unit = { unit: 'example-site.service', template: 'tools/start-a-computer/read-data/unit-templates/serve-a-built-program.service', description: 'Example site program',
  user: 'example-site', group: 'example-web', state: '/var/lib/example-site', builds: '/var/lib/example-site/builds', program: 'serve.mjs', interpreter: '/opt/node/bin/node',
  runtime_directory: 'sites/place.example.com', environment: ['SOCKET=/run/sites/place.example.com/http.sock'], writable: '/var/lib/example-site',
  credentials: [{ vault_key: 'door-key', name: 'door', file: '/etc/credstore.encrypted/example-door', env: 'DOOR_KEY', held_on: 'computer' }] };
const runsWith = extra => ({ health_listen: '127.0.0.1:7199', health: { host: 'place.example.com' }, units: [unit], unmanaged: [], vault_read: READ, ...extra });
const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };
const computer = (live, code) => {
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input: input === undefined ? undefined : String(input) });
    if (command.startsWith('ufw status')) return 'Status: active\n\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n';
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    if (command.startsWith('test -')) {
      const path = command.match(/^test -[sxd] '([^']+)'/)?.[1];
      if (path && live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return '';
    }
    if (command.startsWith('v=$(') && code) throw Object.assign(new Error('state'), { code });
    if (command.includes('systemd-creds encrypt')) live[command.match(/ - '([^']+)'; }$/)?.[1] ?? command.match(/ - '([^']+)'$/)[1]] = 'sealed';
    if (command.includes('curl')) return '200';
    return '';
  };
  return { run, commands };
};
const liveOf = runs => ({ ...Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text])), [unit.state]: 'folder', [unit.builds]: 'folder' });

test('an apply seals a credential held on the computer from the computer\'s vault, with nothing handed and nothing on the channel', async () => {
  const runs = runsWith();
  const live = liveOf(runs);
  const { run, commands } = computer(live, 3);
  const answer = await applyWhatItRuns(machine, runs, run, { 'door-key': VALUE });
  const seal = commands.find(({ command }) => command.includes('systemd-creds encrypt'));
  assert.equal(seal.command, onComputerSeal(vaultReadOf(READ), secretsOf(unit)[0]));
  assert.match(seal.command, /runuser -u 'example-engine' -- .*'read' 'door-key'.*systemd-creds encrypt --name='door' - '\/etc\/credstore\.encrypted\/example-door'; }$/);
  assert.equal(seal.input, undefined, 'no value travels on the SSH channel: a value handed under the same name is not used');
  assert.ok(commands.every(({ command, input }) => !command.includes(VALUE) && !(input ?? '').includes(VALUE)));
  assert.ok(!JSON.stringify(answer).includes(VALUE));
  assert.ok(answer.restarted.includes('example-site.service'), 'the unit restarts to load what was sealed');
});

test('a held file the computer\'s vault still opens to is kept: nothing is sealed', async () => {
  const runs = runsWith();
  const live = { ...liveOf(runs), [unit.credentials[0].file]: 'sealed' };
  const { run, commands } = computer(live, 0);
  await applyWhatItRuns(machine, runs, run, {});
  assert.ok(commands.every(({ command }) => !command.includes('systemd-creds encrypt')));
});

test('a vault that holds nothing for an absent file is refused by name before anything changes; a row with no vault_read is refused', async () => {
  const runs = runsWith();
  const refusedRun = computer(liveOf(runs), 4);
  await assert.rejects(applyWhatItRuns(machine, runs, refusedRun.run, {}), /door-key in the computer's own vault/);
  assert.ok(refusedRun.commands.every(({ command }) => !/systemd-creds encrypt|sh -s --|systemctl (restart|enable)/.test(command)));
  const bare = runsWith({ vault_read: undefined });
  const none = computer(liveOf(bare), 3);
  await assert.rejects(applyWhatItRuns(machine, bare, none.run, {}), /runs\.vault_read/);
  assert.ok(none.commands.every(({ command }) => !command.includes('systemd-creds')));
});
