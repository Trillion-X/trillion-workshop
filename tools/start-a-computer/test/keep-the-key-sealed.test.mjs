// tools/start-a-computer/test/keep-the-key-sealed.test.mjs
//
// A unit that names key_sealed_file keeps its engine's computer key sealed by systemd and hands it over on descriptor 4: no
// readable key file. Its unit loads the sealed file and starts the engine through a shell that opens the credential on descriptor
// 4; an existing plain key is sealed as it is and removed only once the unit has started from the sealed one; a unit that names
// only key_file renders and applies as before. The machine is a stand-in that answers each command from a set of files.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWhatItRuns, runsDifferences } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';

const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };
const PLAIN = '/var/lib/example-place/computer.key', SEALED = '/etc/example-place/computer-key.cred';
const unit = (extra = {}) => ({
  unit: 'example-place.service', template: 'tools/keep-an-engine-on-a-computer/serve-computer-key-sealed.service', description: 'Example place', user: 'example-place',
  state: '/var/lib/example-place', builds: '/var/lib/example-place/builds', program: 'example-engine', key_sealed_file: SEALED,
  settings_file: '/etc/example-place/computer.json', settings: { listen: '127.0.0.1:7199', secrets: { unlock: { key_descriptor: 4 } } }, writable: '/var/lib/example-place',
  drop_ins: ['tools/start-a-computer/read-data/unit-templates/nofile.conf'], ...extra,
});
const runsOf = units => ({ health_listen: '127.0.0.1:7199', units, unmanaged: [] });

// A computer that runs its row as rendered (`live`) and holds the files in `files`; `commands` records every command in order.
const computer = (rows, files) => {
  const live = Object.fromEntries(renderWhatItRuns(rows).map(({ path, text }) => [path, text])), commands = [], held = new Set(files);
  const run = async (_machine, command) => {
    commands.push(command);
    const gone = () => Object.assign(new Error('absent'), { code: 3 });
    if (command.startsWith('if [ -f ')) { const path = command.match(/if \[ -f '([^']+)' \]/)[1]; if (live[path] === undefined) throw gone(); return live[path]; }
    if (command.startsWith('ufw status')) return 'Status: active\n\nTo Action From\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n';
    if (command.includes('curl')) return '200';
    const present = command.match(/^test -s '([^']+)' \|\| exit 3$/);
    if (present) { if (!held.has(present[1])) throw gone(); return ''; }
    if (command.includes('systemd-creds encrypt')) held.add(SEALED);
    if (command.includes('rm -f --')) held.delete(PLAIN);
    return '';
  };
  return { run, commands, held };
};
const index = (commands, pattern) => commands.findIndex(command => pattern.test(command));

test('a unit with a sealed key loads it with LoadCredentialEncrypted and starts the engine with the key on descriptor 4, naming no key file', () => {
  const text = renderWhatItRuns(runsOf([unit()])).find(({ path }) => path.endsWith('.service')).text;
  assert.ok(text.includes(`LoadCredentialEncrypted=computer-key:${SEALED}`));
  assert.ok(text.includes(`ExecStart=/bin/sh -c 'exec "$$0" "$$@" 4<"%d/computer-key"' /var/lib/example-place/builds/current/example-engine serve /etc/example-place/computer.json`));
  assert.doesNotMatch(text, /key_file|computer\.key/);
  const settings = renderWhatItRuns(runsOf([unit()])).find(({ path }) => path.endsWith('computer.json')).text;
  assert.deepEqual(JSON.parse(settings).secrets, { unlock: { key_descriptor: 4 } });
  assert.doesNotMatch(settings, /key_file/);
  const plain = renderWhatItRuns(runsOf([unit({ template: 'tools/keep-an-engine-on-a-computer/serve-computer.service', key_sealed_file: undefined, key_file: PLAIN })])).find(({ path }) => path.endsWith('.service')).text;
  assert.doesNotMatch(plain, /LoadCredentialEncrypted/);
});

test('the starter hands the credential to the engine on descriptor 4, and a missing credential stops it before the engine runs', () => {
  const dir = tempFolder(join(tmpdir(), 'key-starter-'));
  const text = renderWhatItRuns(runsOf([unit()])).find(({ path }) => path.endsWith('.service')).text;
  const exec = text.match(/^ExecStart=\/bin\/sh -c ('.*') \S+ serve \S+$/m)[1].replaceAll('$$', '$').replace('%d', dir);
  const engine = 'read -r key <&4; echo "engine read $key"';
  writeFileSync(join(dir, 'computer-key'), 'QUJD');
  const given = spawnSync('/bin/sh', ['-c', exec.slice(1, -1), '/bin/sh', '-c', engine], { encoding: 'utf8' });
  assert.equal(given.stdout.trim(), 'engine read QUJD');
  rmSync(join(dir, 'computer-key'));
  const refused = spawnSync('/bin/sh', ['-c', exec.slice(1, -1), '/bin/sh', '-c', engine], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, '', 'the engine never ran');
  assert.match(refused.stderr, /computer-key/);
  rmSync(dir, { recursive: true, force: true });
});

test('a plain key is sealed as it is, the unit restarts and answers its health, and only then is the plain file removed', async () => {
  const rows = runsOf([unit({ key_file: PLAIN })]);
  const { run, commands, held } = computer(rows, [PLAIN]);
  const found = await runsDifferences(machine, rows, run);
  assert.deepEqual(found.map(({ path }) => path), [SEALED, PLAIN]);
  commands.length = 0;
  const applied = await applyWhatItRuns(machine, rows, run);
  assert.deepEqual(applied.plain_keys_removed, [PLAIN]);
  assert.deepEqual(applied.restarted, ['example-place.service']);
  const seal = index(commands, /^install -d -m 0700 '\/etc\/example-place' && umask 077 && systemd-creds encrypt --name=computer-key '\/var\/lib\/example-place\/computer\.key' '\/etc\/example-place\/computer-key\.cred'$/);
  const restart = index(commands, /^systemctl restart 'example-place\.service'$/);
  const health = index(commands, /curl -s -o \/dev\/null/);
  const removal = index(commands, /rm -f -- '\/var\/lib\/example-place\/computer\.key'/);
  assert.ok(seal >= 0 && seal < restart && restart < health && health < removal, `order: ${[seal, restart, health, removal]}`);
  assert.match(commands[removal], /^\[ "\$\(systemd-creds decrypt --name=computer-key '\/etc\/example-place\/computer-key\.cred' -\)" = "\$\(cat '\/var\/lib\/example-place\/computer\.key'\)" \] && /);
  assert.ok(held.has(SEALED) && !held.has(PLAIN));
  assert.ok(!commands.some(command => /head -c 32/.test(command)), 'no new key is made while a plain one is held');
  assert.deepEqual(await runsDifferences(machine, rows, run), []);
});

test('a computer with no key yet seals a new random key without ever writing it in the clear, and set-up makes no plain file', async () => {
  const rows = runsOf([unit({ key_file: PLAIN })]);
  const { run, commands } = computer(rows, []);
  await applyWhatItRuns(machine, rows, run);
  assert.ok(commands.some(command => /^install -d -m 0700 '\/etc\/example-place' && umask 077 && head -c 32 \/dev\/urandom \| base64 -w0 \| systemd-creds encrypt --name=computer-key - '\/etc\/example-place\/computer-key\.cred'$/.test(command)));
  assert.ok(!commands.some(command => /rm -f --/.test(command)), 'no plain file to remove');
  assert.equal(commands.find(command => command.startsWith('sh -s')), undefined, 'the account and folders exist, so no set-up');
  const fresh = computer(rows, []);
  const noAccount = async (m, command, input) => { if (command.startsWith('getent')) throw Object.assign(new Error('absent'), { code: 3 }); return fresh.run(m, command, input); };
  await applyWhatItRuns(machine, rows, noAccount);
  const setUp = fresh.commands.find(command => command.startsWith('sh -s'));
  assert.ok(setUp, 'set-up runs for the new account');
  assert.doesNotMatch(setUp, /key_file/);
});

test('a plain key that is not the sealed key is kept, and the apply says so', async () => {
  const rows = runsOf([unit({ key_file: PLAIN })]);
  const { run, held } = computer(rows, [PLAIN, SEALED]);
  const different = async (m, command, input) => { if (command.includes('systemd-creds decrypt')) throw Object.assign(new Error('differ'), { code: 1 }); return run(m, command, input); };
  await assert.rejects(applyWhatItRuns(machine, rows, different), /sealed key is not the plain key .*computer\.key.* held: the plain file is kept/);
  assert.ok(held.has(PLAIN));
});

test('a computer that keeps its key sealed and holds no plain copy gets nothing written and nothing restarted', async () => {
  const rows = runsOf([unit()]);
  const { run, commands } = computer(rows, [SEALED]);
  assert.deepEqual(await applyWhatItRuns(machine, rows, run), { written: [], restarted: [] });
  assert.equal(commands.filter(command => /^(sh -s|install |cp |systemctl |rm )/.test(command)).length, 0);
});

test('a sealed unit whose settings still name its plain key file is refused', async () => {
  const rows = runsOf([unit({ key_file: PLAIN, settings: { listen: '127.0.0.1:7199', computer_key_file: PLAIN } })]);
  await assert.rejects(applyWhatItRuns(machine, rows, computer(rows, [PLAIN]).run), /settings still name the plain key_file/);
  const odd = runsOf([unit({ key_sealed_file: 'relative.cred' })]);
  await assert.rejects(runsDifferences(machine, odd, computer(odd, []).run), /key_sealed_file is an absolute path/);
});
