// tools/start-a-computer/test/apply-what-a-computer-runs.test.mjs
//
// Applying what a computer's row says it runs to a computer that matches it (nothing written, nothing restarted) and to a fresh one
// (set up, then every file the row renders written, and its units started).
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { applyARow, checkApplyProtocol, engineProbeOf, startApplyProbe } from '../do-work/apply-a-computer-row.mjs';
import { applyAComputerRow, applyWhatItRuns, computerRowApplyExit, computerRowApplyFailure, computerRowApplyReceipt, readRequest, runsDifferences } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns, withSlots } from '../do-work/render-what-a-computer-runs.mjs';
import { checkScopedEngine, engineScopeForEdit, startAComputer } from '../do-work/start-a-computer.mjs';
import { blake3 } from '@noble/hashes/blake3.js';

const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };
const runs = {
  health_listen: '127.0.0.1:7199',
  units: [{
    unit: 'example-place.service', template: 'tools/keep-an-engine-on-a-computer/serve-computer.service', description: 'Example place', user: 'example-place',
    state: '/var/lib/example-place', builds: '/var/lib/example-place/builds', program: 'example-engine',
    settings_file: '/etc/example-place/computer.json', settings: { listen: '127.0.0.1:7199' }, writable: '/var/lib/example-place',
    drop_ins: ['tools/start-a-computer/read-data/unit-templates/nofile.conf'],
  }],
  unmanaged: [],
};

// A computer that runs its row as rendered (`live`), or nothing yet (`live` empty). `commands` records every command.
// The one command that reads a folder a unit owns whole (files-in-one-go.mjs): each named file that exists, with its SHA-256.
const hashesOf = (live, input) => String(input ?? '').split('\n').filter(path => path && live[path] !== undefined)
  .map(path => `${createHash('sha256').update(live[path]).digest('hex')}  ${path}\n`).join('');

const computer = live => {
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input });
    if (command.includes('sha256sum')) return hashesOf(live, input);
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    // A set-up computer's firewall admits the ports the settings name; a fresh one has none.
    if (command.startsWith('ufw status')) return Object.keys(live).length ? `Status: active\n\nTo Action From\n${(live.firewall ?? ['22/tcp', '80/tcp', '443/tcp']).map(port => `${port}                     ALLOW       Anywhere`).join('\n')}\n` : '';
    if (command.includes('curl')) return '200';
    if (command.startsWith('if [ -d ')) return '';
    if (command.startsWith('getent')) { if (Object.keys(live).length === 0) throw Object.assign(new Error('no such account'), { code: 3 }); return ''; }
    if (command.startsWith('test -e')) return '';
    return '';
  };
  return { run, commands };
};

test('a computer that already runs its row gets nothing written, no set-up, and nothing restarted', async () => {
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  const { run, commands } = computer(live);
  assert.deepEqual(await applyWhatItRuns(machine, runs, run), { written: [], restarted: [] });
  assert.equal(commands.filter(({ command }) => /^(sh -s|install |cp |systemctl )/.test(command)).length, 0);
});

test('a fresh computer is set up from the row, then gets every file the row renders, and its unit started', async () => {
  const { run, commands } = computer({});
  const { written, restarted } = await applyWhatItRuns(machine, runs, run);
  const rendered = renderWhatItRuns(runs).map(({ path }) => path);
  assert.deepEqual(written, rendered);
  assert.deepEqual(restarted, ['example-place.service']);
  const setUp = commands.findIndex(({ command }) => command.startsWith('sh -s'));
  const firstWrite = commands.findIndex(({ command }) => command.startsWith('install -m 0644') || command.startsWith('install -d -m 0755'));
  assert.ok(setUp >= 0 && setUp < firstWrite, 'set-up runs before anything is written');
  // Set-up is handed only what it makes of each unit (account, folders, node), never the unit's files or pages.
  assert.match(commands[setUp].command, /^sh -s -- '\{"units":\[\{"unit":"example-place.service","user":"example-place","state":"\/var\/lib\/example-place"/);
  assert.ok(!commands[setUp].command.includes('health_listen') && !commands[setUp].command.includes('[Unit]'));
  assert.ok(commands.some(({ command }) => command === 'systemctl daemon-reload'));
  assert.ok(commands.some(({ command }) => command.includes('systemctl enable') && command.includes('example-place.service')));
});

test('a file that differs keeps its previous bytes beside it until its unit passes, and only that file is written', async () => {
  const rendered = renderWhatItRuns(runs);
  const live = Object.fromEntries(rendered.map(({ path, text }) => [path, text]));
  live['/etc/systemd/system/example-place.service'] = 'an older unit\n';
  const { run, commands } = computer(live);
  const { written, restarted } = await applyWhatItRuns(machine, runs, run);
  assert.deepEqual(written, ['/etc/systemd/system/example-place.service']);
  assert.deepEqual(restarted, ['example-place.service']);
  const copy = commands.findIndex(({ command }) => /^cp -p '\/etc\/systemd\/system\/example-place\.service' '\/etc\/systemd\/system\/example-place\.service\.bak-/.test(command));
  assert.ok(copy >= 0, 'the previous unit file is kept beside it while the apply runs');
  assert.equal(commands.filter(({ command }) => command.startsWith('sh -s')).length, 0, 'an existing account is not set up again');
  // Once the restarted unit passed its boot check, the copy goes: it was the apply's rollback, and no row names it.
  const restart = commands.findIndex(({ command }) => command === "systemctl restart 'example-place.service'");
  const drop = commands.findIndex(({ command }) => command.startsWith('while IFS= read -r p; do rm -f'));
  assert.ok(restart > copy && drop > restart, 'the copy is removed only after the restart and its boot check');
  assert.match(commands[drop].input, /^\/etc\/systemd\/system\/example-place\.service\.bak-[^\n]+\n$/);
  assert.ok(!commands.some(({ command }) => command.startsWith('mv -f ') && command.includes('.bak-')), 'nothing is rolled back');
});

test('an apply whose restarted unit fails its boot check moves each kept copy back over its file and restarts the unit on it', async () => {
  const rendered = renderWhatItRuns(runs);
  const live = Object.fromEntries(rendered.map(({ path, text }) => [path, text]));
  live['/etc/systemd/system/example-place.service'] = 'an older unit\n';
  const base = computer(live);
  // The unit answers 500 after its restart with the new file, so its boot check fails.
  const run = async (m, command, input) => command.includes('curl') ? (base.commands.push({ command }), '500') : base.run(m, command, input);
  const failure = await applyWhatItRuns(machine, runs, run, {}, { wait: async () => {} }).then(() => null, error => error);
  assert.ok(failure, 'the apply fails');
  assert.match(failure.message, /example-place\.service answered 500/);
  const { commands } = base;
  const copy = commands.find(({ command }) => command.startsWith('cp -p ')).command.match(/ '([^']+\.bak-[^']+)'$/)[1];
  const back = commands.findIndex(({ command }) => command === `mv -f '${copy}' '/etc/systemd/system/example-place.service'`);
  assert.ok(back >= 0, 'the kept copy is moved back over the unit file, so the copy is gone too');
  const after = commands.slice(back + 1).map(({ command }) => command);
  assert.ok(after.includes('systemctl daemon-reload'), 'systemd reads the unit file that came back');
  assert.ok(after.includes("systemctl restart 'example-place.service'"), 'the unit restarts on its previous file');
  assert.ok(!commands.some(({ command }) => command.startsWith('while IFS= read -r p; do rm -f')), 'a failed apply removes no copy: the rollback used it');
  assert.deepEqual(failure.rolled_back, { restored: ['/etc/systemd/system/example-place.service'], restarted: ['example-place.service'] });
  assert.equal(computerRowApplyFailure(failure).rolled_back, failure.rolled_back, 'the failed apply\'s receipt names what was put back');
});

// A unit with a `source` runs the program built from that commit on the computer: the computer fetches the commit itself from
// the row's repository address, builds it there and makes it `current`. A private repository's key is the vault's value under
// the row's `credential`, handed only on the build's standard input.
const SOURCE_COMMIT = 'c'.repeat(40);
const built = { ...runs, units: [{ ...runs.units[0], source: { repository: 'https://git.example.test/example-engine.git', commit: SOURCE_COMMIT,
  build: ['cargo', 'build', '--release'], output: '{builds}/target/release/example-engine', environment: ['HOME={state}', 'CARGO_TARGET_DIR={builds}/target', 'BUILT_COMMIT={commit}'] } }] };
const { source } = built.units[0];
const keyed = { ...runs, units: [{ ...runs.units[0], source: { ...source, repository: 'git@example.com:example/engine.git', credential: 'example-engine-read-key', host_keys: ['example.com ssh-ed25519 AAAAexample'] } }] };
const building = live => {
  const base = computer(live);
  const run = async (m, command, input) => {
    if (command.startsWith('readlink ')) { base.commands.push({ command }); return 'b'.repeat(40); }
    if (command.startsWith('sh -c ')) { base.commands.push({ command, input }); return `${SOURCE_COMMIT}\n`; }
    return base.run(m, command, input);
  };
  return { run, commands: base.commands };
};
const sourceSent = command => JSON.parse(command.match(/ sh '(\{.*\})'$/s)[1]);

test('a unit behind its source commit is fetched and built by the computer itself, made current and restarted', async () => {
  const live = Object.fromEntries(renderWhatItRuns(built).map(({ path, text }) => [path, text]));
  const { run, commands } = building(live);
  assert.deepEqual(await runsDifferences(machine, built, run), [{ path: '/var/lib/example-place/builds/current', reason: `runs ${'b'.repeat(40)}; its row builds ${SOURCE_COMMIT}` }]);
  const answer = await applyWhatItRuns(machine, built, run);
  assert.deepEqual(answer.built, [{ unit: 'example-place.service', from: 'b'.repeat(40), commit: SOURCE_COMMIT }]);
  assert.deepEqual(answer.restarted, ['example-place.service']);
  const build = commands.find(({ command }) => command.startsWith('sh -c '));
  const sent = sourceSent(build.command);
  assert.equal(sent.repository, 'https://git.example.test/example-engine.git', 'the computer is told where to fetch, never handed a tree');
  assert.equal(sent.keyed, false);
  assert.equal(sent.output, '/var/lib/example-place/builds/target/release/example-engine');
  assert.match(build.command, new RegExp(`"environment":\\["HOME=/var/lib/example-place","CARGO_TARGET_DIR=/var/lib/example-place/builds/target","BUILT_COMMIT=${SOURCE_COMMIT}"\\]`));
  assert.equal(build.input, '');
  assert.ok(commands.some(({ command }) => command === "systemctl restart 'example-place.service'"));
});

test('a unit whose current build is its row\'s but which is not running it is restarted, and one running it is left alone', async () => {
  const live = Object.fromEntries(renderWhatItRuns(built).map(({ path, text }) => [path, text]));
  for (const [running, restarted] of [[false, ['example-place.service']], [true, []]]) {
    const base = computer(live);
    const run = async (m, command, input) => {
      if (command.startsWith('readlink ')) return SOURCE_COMMIT;
      if (command.startsWith('pid=$(systemctl show')) { if (running) return ''; throw Object.assign(new Error('not running current'), { code: 3 }); }
      return base.run(m, command, input);
    };
    if (!running) assert.deepEqual(await runsDifferences(machine, built, run), [{ path: 'example-place.service', reason: 'is not running /var/lib/example-place/builds/current, the build its row names' }]);
    const answer = await applyWhatItRuns(machine, built, run);
    assert.deepEqual(answer.restarted, restarted);
    assert.equal(base.commands.some(({ command }) => command.startsWith('sh -c ')), false, 'nothing is built again');
  }
});

test('a program run by an interpreter runs current\'s build when its process started after current last moved, not when its executable is the program', async () => {
  const interpreted = { ...built, units: built.units.map(unit => ({ ...unit, interpreter: '/opt/node/bin/node' })) };
  const asked = [];
  const base = computer(Object.fromEntries(renderWhatItRuns(interpreted).map(({ path, text }) => [path, text])));
  const run = async (m, command, input) => {
    if (command.startsWith('readlink ')) return SOURCE_COMMIT;
    if (command.startsWith('pid=$(systemctl show')) { asked.push(command); return ''; }
    return base.run(m, command, input);
  };
  assert.deepEqual(await runsDifferences(machine, interpreted, run), []);
  // The process's start is now minus its elapsed seconds, never /proc/<pid>'s own time (procfs sets that at first lookup).
  assert.match(asked[0], /\$\(date \+%s\) - \$\(ps -o etimes= -p "\$pid"\) \)\)" -ge "\$\(stat -c %Z '\/var\/lib\/example-place\/builds\/current'\)/);
  assert.ok(!asked[0].includes('stat -c %Y /proc/'), 'the process start is not read from /proc/<pid>\'s own time');
  assert.ok(!asked[0].includes('/proc/$pid/exe'), 'the interpreter is never compared with the program');
});

test('a private repository is fetched with the key the vault holds under its credential name, sent only on standard input', async () => {
  const live = Object.fromEntries(renderWhatItRuns(keyed).map(({ path, text }) => [path, text]));
  const { run, commands } = building(live);
  const KEY = 'made-up-private-key-text';
  await applyWhatItRuns(machine, keyed, run, { 'example-engine-read-key': KEY });
  const build = commands.find(({ command }) => command.startsWith('sh -c '));
  assert.equal(build.input, `${KEY}\n`);
  assert.ok(!commands.some(({ command }) => command.includes(KEY)), 'the key is in no command line');
  const sent = sourceSent(build.command);
  assert.deepEqual([sent.keyed, sent.host_keys, 'credential' in sent], [true, ['example.com ssh-ed25519 AAAAexample'], false]);
  await assert.rejects(applyWhatItRuns(machine, keyed, building(live).run, {}), /the key held under the vault name example-engine-read-key: hand it on descriptor 5/);
  const noHostKeys = { ...keyed, units: [{ ...keyed.units[0], source: { ...keyed.units[0].source, host_keys: [] } }] };
  await assert.rejects(applyWhatItRuns(machine, noHostKeys, building(live).run, { 'example-engine-read-key': KEY }), /needs host_keys/);
});

test('a restarted unit must answer its health row on the machine, or the apply fails', async () => {
  const live = { '/etc/systemd/system/example-place.service': 'an older unit\n' };
  const healthy = async (_m, command) => {
    if (command.startsWith('if [ -f ')) { const p = command.match(/if \[ -f '([^']+)' \]/)[1]; if (live[p] === undefined) throw Object.assign(new Error('absent'), { code: 3 }); return live[p]; }
    if (command.includes('curl')) return '200';
    return '';
  };
  const ok = await applyWhatItRuns(machine, runs, healthy);
  assert.deepEqual(ok.booted, ['example-place.service']);
  const crashing = async (m, command) => command.includes('curl') ? '000' : healthy(m, command);
  await assert.rejects(applyWhatItRuns(machine, runs, crashing, {}, { wait: async () => {} }), /example-place\.service answered nothing on \/readyz, not 200/);
});

// A file that names `check` replaces the live one only once that command passes on the new text, and one that names `then`
// is applied by those commands, after the units start, instead of restarting the unit that reads it.
test('a file with check is checked beside the live one before it replaces it, and one with then restarts nothing', async () => {
  const unit = { unit: 'example-web.service', user: 'example-web', prepare: 'tools/start-a-computer/test/fixtures/prepare-example.mjs', greeting: 'hello' };
  const row = { ...runs, units: [...runs.units, unit] };
  const { withPrepared } = await import('../do-work/render-what-a-computer-runs.mjs');
  const live = Object.fromEntries(renderWhatItRuns(await withPrepared(row)).map(({ path, text }) => [path, text]));
  live['/etc/example-greeter/site.conf'] = 'an older site\n';
  const { run, commands } = computer(live);
  const { written, restarted } = await applyWhatItRuns(machine, row, run);
  assert.deepEqual(written, ['/etc/example-greeter/site.conf']);
  assert.deepEqual(restarted, []);
  const write = commands.find(({ command }) => command.includes("site.conf.new'"));
  // Written through a temporary file and one rename, never `install /dev/stdin` (Ubuntu 26.04's uutils refuses an existing file).
  assert.doesNotMatch(write.command, /\/dev\/stdin/);
  assert.match(write.command, /t=\$\(mktemp '\/etc\/example-greeter\/\.write\.XXXXXX'\) && cat > "\$t" && chmod 0644 "\$t" && chown root:root "\$t" && mv -f "\$t" '\/etc\/example-greeter\/site\.conf\.new' && 'example-check' '--file' '\/etc\/example-greeter\/site\.conf\.new' >\/dev\/null && mv '\/etc\/example-greeter\/site\.conf\.new' '\/etc\/example-greeter\/site\.conf'$/);
  assert.equal(write.input, 'site\n');
  assert.ok(commands.some(({ command }) => command === "'systemctl' 'reload' 'example-web.service'"));
  assert.ok(!commands.some(({ command }) => command.startsWith('systemctl restart')));
});

test('a new drop-in on a unit restarts it, so a running unit starts with it', async () => {
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  delete live['/etc/systemd/system/example-place.service.d/nofile.conf'];
  const { run, commands } = computer(live);
  const { restarted } = await applyWhatItRuns(machine, runs, run);
  assert.deepEqual(restarted, ['example-place.service']);
  assert.ok(commands.some(({ command }) => command === "systemctl restart 'example-place.service'"));
});

test('a unit\'s health row may name the Host its boot check asks for', async () => {
  const health = { path: '/.well-known/oauth-protected-resource/mcp', status: 200, host: 'place.example.test' };
  const withHost = { ...runs, units: [{ ...runs.units[0], health, health_listen: '127.0.0.1:9445' }] };
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  live['/etc/systemd/system/example-place.service'] = 'an older unit\n';
  const { run, commands } = computer(live);
  const { restarted } = await applyWhatItRuns(machine, withHost, run);
  assert.deepEqual(restarted, ['example-place.service']);
  assert.ok(commands.some(({ command }) => command.includes("curl") && command.includes("-H 'Host: place.example.test' 'http://127.0.0.1:9445/.well-known/oauth-protected-resource/mcp'")));
});

test('a file the row writes and also lists in absent is refused before the computer is read', async () => {
  const commands = [];
  const run = async (_machine, command) => { commands.push(command); return ''; };
  const key = '/etc/credstore.encrypted/example-move-key';
  const both = { ...runs, units: [{ ...runs.units[0], credentials: [{ vault_key: 'example-move-key', name: 'move-key', file: key }] }], absent: [key] };
  await assert.rejects(runsDifferences(machine, both, run), /writes \/etc\/credstore\.encrypted\/example-move-key and lists it in runs\.absent/);
  await assert.rejects(applyWhatItRuns(machine, both, run), /lists it in runs\.absent/);
  await assert.rejects(runsDifferences(machine, { ...runs, absent: ['/etc/example-place/'] }, run), /writes \/etc\/example-place\/computer\.json/);
  assert.deepEqual(commands, []);
});

test('a user the row says is absent is a difference while the computer has it, and the apply removes it and reloads ssh for a removed drop-in', async () => {
  const gone = { health_listen: '127.0.0.1:7199', units: [], unmanaged: [], absent: ['/etc/ssh/sshd_config.d/old-tunnel.conf'], absent_users: ['old-tunnel'] };
  const commands = [];
  const run = async (_machine, command) => {
    commands.push(command);
    if (command.startsWith('if [ -f ')) throw Object.assign(new Error('absent'), { code: 3 });
    if (command.includes('curl')) return '200';
    return '';
  };
  const found = await runsDifferences({ address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } }, gone, run);
  assert.ok(found.some(item => item.path === 'user old-tunnel'));
  const answer = await applyWhatItRuns({ address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } }, gone, run);
  assert.deepEqual(answer.removed, ['/etc/ssh/sshd_config.d/old-tunnel.conf', 'user old-tunnel']);
  assert.ok(commands.includes("userdel -r 'old-tunnel'"));
  assert.ok(commands.includes('sshd -t && systemctl reload ssh'));
});

// A unit that is not an HTTP server names the command that tells it is well; the apply asks it after the restart.
test('a unit with a check_command is booted when the command passes, and the apply fails when it never does', async () => {
  const withCheck = { ...runs, units: [{ ...runs.units[0], check_command: 'pg_isready -q' }] };
  const base = computer({});
  const asked = [];
  const passing = async (m, command, input) => { if (command === 'pg_isready -q') { asked.push(command); return ''; } return base.run(m, command, input); };
  const ok = await applyWhatItRuns(machine, withCheck, passing);
  assert.deepEqual(ok.booted, ['example-place.service']);
  assert.deepEqual(asked, ['pg_isready -q']);
  assert.ok(!base.commands.some(({ command }) => command.startsWith('curl')), 'no HTTP health request is made for it');
  const never = async (m, command, input) => { if (command === 'pg_isready -q') throw Object.assign(new Error('no response'), { code: 2 }); return computer({}).run(m, command, input); };
  await assert.rejects(applyWhatItRuns(machine, withCheck, never, {}, { wait: async () => {} }), /example-place\.service's check_command did not pass after the restart: no response/);
});

// A check that knows trying again cannot pass (the door refused the unit's rights) exits the stop-trying code: one try, no wait.
test('a check_command that exits the stop-trying code fails the apply at once, without its other tries', async () => {
  const withCheck = { ...runs, units: [{ ...runs.units[0], check_command: 'door-call' }] };
  let tries = 0;
  let waits = 0;
  const refused = async (m, command, input) => {
    if (command === 'door-call') { tries += 1; throw Object.assign(new Error('the door refused: current_workspace_rights_refused'), { code: 77 }); }
    return computer({}).run(m, command, input);
  };
  await assert.rejects(applyWhatItRuns(machine, withCheck, refused, {}, { wait: async () => { waits += 1; } }),
    /example-place\.service's check_command said trying again cannot pass \(exit 77\): the door refused: current_workspace_rights_refused/);
  assert.equal(tries, 1, 'asked once');
  assert.equal(waits, 0, 'no wait between tries');
  // Any other failing exit is still tried again, all 12 times.
  let others = 0;
  const failing = async (m, command, input) => {
    if (command === 'door-call') { others += 1; throw Object.assign(new Error('not yet'), { code: 1 }); }
    return computer({}).run(m, command, input);
  };
  await assert.rejects(applyWhatItRuns(machine, withCheck, failing, {}, { wait: async () => {} }), /did not pass after the restart: not yet/);
  assert.equal(others, 12);
});

test('a unit whose files a container reads restarts that container after it, with what joined its network, and waits for it', async () => {
  const inBox = { ...runs, units: [{ ...runs.units[0], check_command: 'key-is-there', ready_in_container: { compose_project: 'the-engine', service: 'engine' } }] };
  const live = Object.fromEntries(renderWhatItRuns(inBox).map(({ path, text }) => [path, text]));
  live['/etc/example-place/computer.json'] = '{"listen":"127.0.0.1:7199","older":true}\n';
  const base = computer(live);
  const answer = await applyWhatItRuns(machine, inBox, base.run, {}, { wait: async () => {} });
  const commands = base.commands.map(({ command }) => command);
  const unitRestart = commands.indexOf("systemctl restart 'example-place.service'");
  const boxRestart = commands.findIndex(command => command.includes('docker restart "$c"'));
  assert.ok(unitRestart >= 0 && boxRestart > unitRestart, 'the container restarts once its unit is back (its credentials are there again)');
  assert.match(commands[boxRestart], /--filter 'label=com\.docker\.compose\.project=the-engine' --filter 'label=com\.docker\.compose\.service=engine'/);
  assert.match(commands[boxRestart], /\{\{\.State\.Running\}\}.*\|\| exit 0/, 'a stopped container stays stopped');
  assert.match(commands[boxRestart], /\{\{\.HostConfig\.NetworkMode\}\}' "\$d"\)" = "container:\$id" \]; then docker restart "\$d"/, 'a container that joined its network restarts after it');
  const check = commands.indexOf('key-is-there');
  const ready = commands.findIndex(command => command.includes('.State.Health.Status'));
  assert.ok(check > boxRestart && ready > check, 'the boot check asks the unit, then waits for its container');
  assert.deepEqual(answer.containers_restarted, ['example-place.service']);
  assert.deepEqual(answer.booted, ['example-place.service']);
});

test('a container that never answers healthy fails the apply, and the rollback restarts it on the files put back', async () => {
  const inBox = { ...runs, units: [{ ...runs.units[0], check_command: 'key-is-there', ready_in_container: 'the-engine-1' }] };
  const live = Object.fromEntries(renderWhatItRuns(inBox).map(({ path, text }) => [path, text]));
  live['/etc/example-place/computer.json'] = '{"listen":"127.0.0.1:7199","older":true}\n';
  const base = computer(live);
  const run = async (m, command, input) => command.includes('.State.Health.Status') ? (base.commands.push({ command }), Promise.reject(Object.assign(new Error('starting'), { code: 3 }))) : base.run(m, command, input);
  const failure = await applyWhatItRuns(machine, inBox, run, {}, { wait: async () => {} }).then(() => null, error => error);
  assert.ok(failure, 'the apply fails');
  assert.match(failure.message, /example-place\.service's container did not pass after the restart: starting/);
  assert.equal(base.commands.filter(({ command }) => command.includes('.State.Health.Status')).length, 36, 'asked for its whole stop and start');
  const commands = base.commands.map(({ command }) => command);
  const back = commands.findIndex(command => command.startsWith('mv -f ') && command.endsWith(" '/etc/example-place/computer.json'"));
  assert.ok(back >= 0, 'the older config is put back');
  const after = commands.slice(back + 1);
  const unitAgain = after.indexOf("systemctl restart 'example-place.service'");
  assert.ok(unitAgain >= 0 && after.findIndex(command => command.startsWith("c='the-engine-1'; ") && command.includes('docker restart')) > unitAgain, 'its container restarts on the config put back');
});

test('a ready_in_container outside its shape restarts no container', async () => {
  for (const given of ["x'; reboot", { compose_project: "p'x", service: 'engine' }, { compose_project: 'p' }, 7]) {
    const inBox = { ...runs, units: [{ ...runs.units[0], check_command: 'key-is-there', ready_in_container: given }] };
    const live = Object.fromEntries(renderWhatItRuns(inBox).map(({ path, text }) => [path, text]));
    live['/etc/example-place/computer.json'] = '{"older":true}\n';
    const base = computer(live);
    const answer = await applyWhatItRuns(machine, inBox, base.run, {}, { wait: async () => {} });
    assert.ok(!base.commands.some(({ command }) => command.includes('docker')), `no docker command for ${JSON.stringify(given)}`);
    assert.equal(answer.containers_restarted, undefined);
  }
});

test('a machine file the row adds to a computer already set up is a difference, and the apply writes it and restarts nothing', async () => {
  // Nov 25 2026, 8:47 AM CST: 99-no-automatic-reboot was added to machine.files; the apply exited 0 with written [] because only
  // set-up writes machine files and set-up was not owed.
  const file = { path: '/etc/apt/apt.conf.d/99-no-automatic-reboot', text: 'Unattended-Upgrade::Automatic-Reboot "false";\n' };
  const withFile = { ...runs, machine: { files: [file] } };
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  const base = computer(live);
  assert.deepEqual(await runsDifferences(machine, withFile, base.run), [{ path: file.path, reason: 'missing on the computer' }]);
  const applied = computer(live);
  const answer = await applyWhatItRuns(machine, withFile, applied.run);
  assert.deepEqual(answer.written, [file.path]);
  assert.deepEqual(answer.restarted, [], 'no unit reads a machine file, so nothing restarts');
  assert.ok(applied.commands.some(({ command, input }) => command.endsWith(` '${file.path}'`) && input === file.text), 'the file is written with its text');
  // Once the computer has it, the row matches.
  const after = computer({ ...live, [file.path]: file.text });
  assert.deepEqual(await runsDifferences(machine, withFile, after.run), []);
  assert.throws(() => renderWhatItRuns({ ...runs, machine: { files: [{ path: 'relative', text: '' }] } }), /machine\.files takes \{ path, text \}/);
});

test('a JSON file that holds the same value in another key order is no difference and is not rewritten; a changed value is', async () => {
  const two = { ...runs, units: [{ ...runs.units[0], settings: { listen: '127.0.0.1:7199', persons: '/var/lib/example-place/persons' } }] };
  const rendered = renderWhatItRuns(two);
  const settings = rendered.find(({ path }) => path === '/etc/example-place/computer.json');
  const value = JSON.parse(settings.text);
  const reordered = `${JSON.stringify(Object.fromEntries(Object.entries(value).reverse()), null, 1)}\n`;
  assert.notEqual(reordered, settings.text, 'the live bytes differ');
  assert.deepEqual(Object.keys(JSON.parse(reordered)), Object.keys(value).reverse(), 'only the key order differs');
  const live = Object.fromEntries(rendered.map(({ path, text }) => [path, text]));
  const sameValue = computer({ ...live, [settings.path]: reordered });
  assert.deepEqual(await runsDifferences(machine, two, sameValue.run), []);
  assert.deepEqual(await applyWhatItRuns(machine, two, sameValue.run), { written: [], restarted: [] });
  const changed = computer({ ...live, [settings.path]: JSON.stringify({ ...value, listen: '127.0.0.1:7100' }) });
  assert.deepEqual(await runsDifferences(machine, two, changed.run), [{ path: settings.path, reason: 'differs from the computer row' }]);
  // A file that is not JSON is compared as bytes.
  const unitFile = rendered.find(({ path }) => path === '/etc/systemd/system/example-place.service');
  const spaced = computer({ ...live, [unitFile.path]: `${unitFile.text} ` });
  assert.deepEqual(await runsDifferences(machine, two, spaced.run), [{ path: unitFile.path, reason: 'differs from the computer row' }]);
});

test('a computer missing a package or program its row names is set up, and one that has them all is not', async () => {
  const data = { ...runs, machine: { packages: ['jq'], downloads: [{ path: '/usr/local/bin/example-tool' }] } };
  const live = Object.fromEntries(renderWhatItRuns(data).map(({ path, text }) => [path, text]));
  const changed = { ...data, units: [{ ...data.units[0], description: 'Example place again' }] };
  const lacking = computer(live);
  const run = (missing) => async (m, command, input) => {
    if (command.startsWith('dpkg -s') || command.startsWith('test -x')) { lacking.commands.push({ command }); if (missing(command)) throw Object.assign(new Error('missing'), { code: 3 }); return ''; }
    return lacking.run(m, command, input);
  };
  await applyWhatItRuns(machine, changed, run(command => command.includes('example-tool')));
  assert.ok(lacking.commands.some(({ command }) => command.startsWith('sh -s')), 'a missing program runs set-up');
  const had = computer(live);
  const complete = async (m, command, input) => { if (command.startsWith('dpkg -s') || command.startsWith('test -x')) return ''; return had.run(m, command, input); };
  await applyWhatItRuns(machine, changed, complete);
  assert.ok(!had.commands.some(({ command }) => command.startsWith('sh -s')), 'nothing missing, no set-up');
});

test('a program the row pins by its bytes is set up again when the bytes in place are not the pinned ones', async () => {
  const pinned = 'b'.repeat(64);
  const data = { ...runs, machine: { downloads: [{ path: '/usr/local/bin/example-tool', files: { x86_64: { url: 'https://downloads.example.test/t.tar.gz', sha256: 'c'.repeat(64), member: 't/example-tool', binary_sha256: pinned } } }] } };
  const live = Object.fromEntries(renderWhatItRuns(data).map(({ path, text }) => [path, text]));
  const changed = { ...data, units: [{ ...data.units[0], description: 'Example place again' }] };
  const onComputer = (bytes) => {
    const box = computer(live);
    const run = async (m, command, input) => {
      if (command.startsWith('test -x')) {
        box.commands.push({ command });
        const matches = command.includes(`= '${bytes}'`) || command.includes(`= ${bytes} `);
        assert.match(command, /sha256sum '\/usr\/local\/bin\/example-tool'/, 'the bytes in place are compared');
        if (!matches) throw Object.assign(new Error('other bytes'), { code: 3 });
        return '';
      }
      return box.run(m, command, input);
    };
    return { box, run };
  };
  const older = onComputer('d'.repeat(64));
  await applyWhatItRuns(machine, changed, older.run);
  assert.ok(older.box.commands.some(({ command }) => command.startsWith('sh -s')), 'an older release in place runs set-up, which installs the pinned one');
  const same = onComputer(pinned);
  await applyWhatItRuns(machine, changed, same.run);
  assert.ok(!same.box.commands.some(({ command }) => command.startsWith('sh -s')), 'the pinned bytes in place: no set-up');
});

test('the node release is the computer row\'s own data: a computer that names none is set up without node', async () => {
  const setUpOf = async row => {
    const { run, commands } = computer({});
    await applyWhatItRuns(machine, row, run);
    return commands.find(({ command }) => command.startsWith('sh -s')).command;
  };
  assert.doesNotMatch(await setUpOf(runs), /"node"|nodejs/, 'the tool pins no node release');
  const node = { version: 'v0.0.0', files: { x86_64: { url: 'https://downloads.example.test/node-x64.tar.gz', sha256: 'a'.repeat(64) } } };
  assert.match(await setUpOf({ ...runs, machine: { node } }), /"node":\{"version":"v0\.0\.0"/, 'a row that names one hands it to set-up');
});

// A database server with reach, and two role jobs that run one script. A changed access file restarts the server that reads
// it; a changed script runs again every job that names it, and is written once.
test('a changed access file reloads its server without a restart, and a changed script reruns each job naming it', async () => {
  const server = { unit: 'example-database.service', template: 'tools/keep-a-postgres-database-on-a-computer/serve-postgres.service', prepare: 'tools/keep-a-postgres-database-on-a-computer/prepare-a-database-unit.mjs', description: 'Example database', user: 'postgres', state: '/var/lib/postgresql',
    data_dir: '/var/lib/postgresql/18/example', program_bin: '/usr/lib/postgresql/18/bin', settings_file: '/etc/example-database/postgresql.conf',
    settings_lines: [], environment: ['PGDATA=/var/lib/postgresql/18/example'], writable: '/var/lib/postgresql', check_command: 'pg_isready -q',
    secret_name: 'store', secret_vault_key: 'example-store', secret_file: '/etc/credstore.encrypted/example-database', hba_file: '/etc/example-database/pg_hba.conf',
    reach: [{ for: 'tool:run-sql-in-my-database', listen: '127.0.0.1', hba: [{ type: 'host', database: 'p_example', user: 'all', address: '127.0.0.1/32', method: 'scram-sha-256' }] }] };
  const role = name => ({ unit: `${name}.service`, template: 'tools/start-a-computer/read-data/unit-templates/run-a-script.service', description: name, user: 'postgres', state: '/var/lib/postgresql',
    after: 'example-database.service', script: 'tools/keep-a-postgres-database-on-a-computer/scripts/set-up-postgres-role.sh', script_file: '/usr/local/lib/example-database/set-up-postgres-role.sh',
    environment: ['SECRET_NAME=role'], program_bin: '/usr/lib/postgresql/18/bin', writable: '/var/lib/postgresql',
    secret_name: 'role', secret_vault_key: `${name}-connection`, secret_file: `/etc/credstore.encrypted/${name}`, check_command: `true ${name}` });
  const row = { health_listen: runs.health_listen, unmanaged: [], units: [server, role('example-owner'), role('example-share')] };
  const { withPrepared } = await import('../do-work/render-what-a-computer-runs.mjs');
  const live = Object.fromEntries(renderWhatItRuns(await withPrepared(row)).map(({ path, text }) => [path, text]));
  live['/etc/example-database/pg_hba.conf'] = 'host all all 0.0.0.0/0 trust\n';
  live['/usr/local/lib/example-database/set-up-postgres-role.sh'] = '# an older script\n';
  const { run, commands } = computer(live);
  const answer = await applyWhatItRuns(machine, row, async (m, command, input) => (command.startsWith('test -s ') ? '' : run(m, command, input)), {}, { wait: async () => {} });
  assert.deepEqual(answer.written, ['/etc/example-database/pg_hba.conf', '/usr/local/lib/example-database/set-up-postgres-role.sh']);
  // Nov 25 2026: a restart for an hba line dropped every connection (6 s of 502 for a live site); a reload keeps them.
  assert.deepEqual(answer.restarted, ['example-owner.service', 'example-share.service']);
  assert.ok(!commands.some(({ command }) => command === "systemctl restart 'example-database.service'"), 'the server that reads the access file is not restarted');
  assert.ok(commands.some(({ command }) => command.includes('try-reload-or-restart') && command.includes('example-database.service')), 'the server reloads the access file');
});

// A path unit the row names is started when it is not active, like a timer, though nothing it renders changed.
test('a path unit that is not active is started, with nothing written', async () => {
  const row = { ...runs, units: [...runs.units, { unit: 'example-certificate.path', template: 'tools/start-a-computer/read-data/unit-templates/watch-a-file.path', description: 'Example certificate', user: 'root',
    watch: '/var/lib/example-door/example.test.crt', runs: 'example-certificate.service', check_command: 'systemctl is-active --quiet example-certificate.path' }] };
  const live = Object.fromEntries(renderWhatItRuns(row).map(({ path, text }) => [path, text]));
  const { run, commands } = computer(live);
  let started = false;
  const answer = await applyWhatItRuns(machine, row, async (m, command, input) => {
    if (command.startsWith("systemctl is-active --quiet 'example-certificate.path'") && !started) throw Object.assign(new Error('inactive'), { code: 3 });
    if (command.startsWith("systemctl enable --now 'example-certificate.path'")) started = true;
    return run(m, command, input);
  }, {}, { wait: async () => {} });
  assert.deepEqual(answer.written, []);
  assert.deepEqual(answer.restarted, ['example-certificate.path']);
  assert.ok(commands.some(({ command }) => command.startsWith("systemctl enable --now 'example-certificate.path'")));
});

// A unit with `slots` runs one slot at a time: a new release is built into the other slot's own link, started there, and only
// once it answers its boot check does the slot that ran stop (and finish what it holds); a release that never answers is
// stopped again and the slot that ran keeps serving (plan: a deploy never drops anything).
const slotted = { ...built, units: [{ ...built.units[0], stop_seconds: 170, health: { path: '/readyz', status: 200, host: 'place.example.test' }, health_listen: '127.0.0.1:7199',
  slots: { a: { 'settings.listen': '127.0.0.1:7199', health_listen: '127.0.0.1:7199' }, b: { 'settings.listen': '127.0.0.1:7198', health_listen: '127.0.0.1:7198' } } }] };
const MiB = 1024 ** 2;
// `memory` is what the computer reports: MemAvailable, and the MemoryCurrent every running slot shows (bytes); `kept` is the start
// peak a switch measured before (start-peak-bytes), and `peak` the MemoryPeak a new slot shows once it passes its checks.
const slotComputer = ({ active, links, answers = {}, memory = { available: 4096 * MiB, current: 1260 * MiB }, row = slotted, liveLinks = {} }) => {
  const live = Object.fromEntries(renderWhatItRuns(row).map(({ path, text }) => [path, text]));
  const base = computer(live);
  const run = async (m, command, input) => {
    const activeAsked = command.match(/^systemctl is-active --quiet '([^']+)'/);
    if (activeAsked) { base.commands.push({ command }); if (active.includes(activeAsked[1])) return ''; throw Object.assign(new Error('inactive'), { code: 3 }); }
    const liveLink = command.match(/^readlink -- '([^']+)' \|\| true$/);
    if (liveLink) { base.commands.push({ command }); return liveLinks[liveLink[1]] ?? ''; }
    const link = command.match(/^readlink '[^']+\/(current[^']*)'/);
    if (link) return links[link[1]] ?? '';
    if (command.startsWith('systemctl show -p MemoryCurrent')) { base.commands.push({ command }); return `${memory.current}\n`; }
    if (command.startsWith("awk '/^MemAvailable")) { base.commands.push({ command }); return `${memory.available}\n`; }
    if (command.startsWith('cat ') && command.includes('start-peak-bytes')) { base.commands.push({ command }); return memory.kept === undefined ? '' : `${memory.kept}\n`; }
    if (command.startsWith('systemctl show -p MemoryPeak')) { base.commands.push({ command }); return memory.peak === undefined ? '' : `${memory.peak}\n`; }
    if (command.startsWith('pid=$(systemctl show')) return '';
    if (command.startsWith('sh -c ')) { base.commands.push({ command, input }); return `${SOURCE_COMMIT}\n`; }
    const health = command.match(/^curl .*'http:\/\/([^/]+)\/readyz'/);
    if (health) { base.commands.push({ command }); return answers[health[1]] ?? '200'; }
    return base.run(m, command, input);
  };
  return { run, commands: base.commands };
};

test('slots render one unit each, with its own port, settings file, build link and the row\'s stop time', () => {
  const files = renderWhatItRuns(slotted);
  const unit = name => files.find(file => file.path === `/etc/systemd/system/${name}`)?.text;
  assert.equal(unit('example-place.service'), undefined, 'the slotted unit itself is never a unit');
  assert.match(unit('example-place-a.service'), /^ExecStart=\/var\/lib\/example-place\/builds\/current-a\/example-engine serve \/etc\/example-place\/computer-a\.json$/m);
  assert.match(unit('example-place-b.service'), /^ExecStart=\/var\/lib\/example-place\/builds\/current-b\/example-engine serve \/etc\/example-place\/computer-b\.json$/m);
  assert.match(unit('example-place-b.service'), /^KillMode=mixed\nTimeoutStopSec=170$/m);
  assert.equal(JSON.parse(files.find(file => file.path === '/etc/example-place/computer-b.json').text).listen, '127.0.0.1:7198');
  assert.match(renderWhatItRuns(runs).find(file => file.path === '/etc/systemd/system/example-place.service').text, /^TimeoutStopSec=30$/m, 'a unit with no stop time keeps the default');
  assert.throws(() => renderWhatItRuns({ ...slotted, units: [{ ...slotted.units[0], slots: { a: {} } }] }), /two or more slots/);
  assert.throws(() => renderWhatItRuns({ ...slotted, units: [{ ...slotted.units[0], slots: { a: { unit: 'x' }, b: {} } }] }), /not a value of the unit a slot may have/);
});

test('a new release starts in the other slot, and the slot that ran stops only once it answers', async () => {
  const { run, commands } = slotComputer({ active: ['example-place-a.service'], links: { 'current-a': 'b'.repeat(40) } });
  assert.deepEqual(await runsDifferences(machine, slotted, run), [{ path: 'example-place.service', reason: `example-place-a.service runs ${'b'.repeat(40)}; its row builds ${SOURCE_COMMIT}` }]);
  const answer = await applyWhatItRuns(machine, slotted, run);
  assert.deepEqual(answer.switched, [{ to: 'example-place-b.service', from: ['example-place-a.service'] }]);
  assert.deepEqual(answer.built, [{ unit: 'example-place-b.service', from: null, commit: SOURCE_COMMIT }]);
  assert.equal(sourceSent(commands.find(({ command }) => command.startsWith('sh -c ')).command).current, 'current-b');
  const at = text => commands.findIndex(({ command }) => command.startsWith(text));
  assert.ok(at("systemctl restart 'example-place-b.service'") >= 0);
  assert.ok(at("systemctl restart 'example-place-b.service'") < at("curl -s -o /dev/null -w '%{http_code}' -H 'Host: place.example.test' 'http://127.0.0.1:7198/readyz'"));
  assert.ok(at("curl -s -o /dev/null -w '%{http_code}' -H 'Host: place.example.test' 'http://127.0.0.1:7198/readyz'") < at("systemctl disable --now 'example-place-a.service'"), 'the slot that ran stops only after the new one answers');
  assert.ok(at("systemctl enable 'example-place-b.service'") >= 0, 'the new slot is the one that starts with the computer');
  assert.equal(at("systemctl restart 'example-place-a.service'"), -1, 'the slot that ran is never restarted');
});

test('a release that never answers is stopped again, and the slot that ran keeps serving', async () => {
  const { run, commands } = slotComputer({ active: ['example-place-a.service'], links: { 'current-a': 'b'.repeat(40) }, answers: { '127.0.0.1:7198': '502' } });
  await assert.rejects(applyWhatItRuns(machine, slotted, run, {}, { wait: async () => {} }), /example-place-b\.service answered 502 on \/readyz, not 200, after its restart\. Candidate stop succeeded; no incumbent retirement was requested for this unit\./);
  assert.ok(commands.some(({ command }) => command === "systemctl stop 'example-place-b.service'"));
  assert.equal(commands.some(({ command }) => command.includes("'example-place-a.service'") && /disable|stop|restart/.test(command)), false);
});

// `live_links`: a fixed path (an engine's agent socket, its settings file, its build link) points at the slot that runs, so a
// reader never reaches a stopped slot's file. Nov 24 2026, 8:06 PM CST: both slots of the always-on's engine bound one socket
// path, the retiring slot restarted after an out-of-memory kill and took that path from the serving slot, and every agent
// call on it was refused until the next switch.
const linked = { ...slotted, units: [{ ...slotted.units[0], live_links: { '/var/lib/example-place/agent.sock': '/var/lib/example-place/agent-{slot}.sock' },
  slots: { a: { ...slotted.units[0].slots.a, 'settings.agent_socket': '/var/lib/example-place/agent-a.sock' }, b: { ...slotted.units[0].slots.b, 'settings.agent_socket': '/var/lib/example-place/agent-b.sock' } } }] };
const pointed = (link, target) => `ln -sfn '${target}' '${link}.link-new' && mv -Tf '${link}.link-new' '${link}'`;

test('a switch points the live links at the new slot after it answers and before the slot that ran stops', async () => {
  const { run, commands } = slotComputer({ row: linked, active: ['example-place-a.service'], links: { 'current-a': 'b'.repeat(40) }, liveLinks: { '/var/lib/example-place/agent.sock': '/var/lib/example-place/agent-a.sock' } });
  const answer = await applyWhatItRuns(machine, linked, run);
  assert.deepEqual(answer.switched, [{ to: 'example-place-b.service', from: ['example-place-a.service'] }]);
  assert.deepEqual(answer.linked, ['/var/lib/example-place/agent.sock']);
  const at = text => commands.findIndex(({ command }) => command.startsWith(text));
  const move = at(pointed('/var/lib/example-place/agent.sock', '/var/lib/example-place/agent-b.sock'));
  assert.ok(move >= 0, 'the link moves to the new slot');
  assert.ok(at("curl -s -o /dev/null -w '%{http_code}' -H 'Host: place.example.test' 'http://127.0.0.1:7198/readyz'") < move, 'only after the new slot answers');
  assert.ok(move < at("systemctl disable --now 'example-place-a.service'"), 'before the slot that ran stops');
  assert.equal(commands.filter(({ command }) => command.startsWith('ln -sfn')).length, 1, 'once');
});

test('a live link off the running slot is a difference, and the apply points it back without a switch or a restart', async () => {
  const { run, commands } = slotComputer({ row: linked, active: ['example-place-a.service'], links: { 'current-a': SOURCE_COMMIT }, liveLinks: { '/var/lib/example-place/agent.sock': '/var/lib/example-place/agent-b.sock' } });
  assert.deepEqual((await runsDifferences(machine, linked, run)).filter(({ path }) => path === '/var/lib/example-place/agent.sock'),
    [{ path: '/var/lib/example-place/agent.sock', reason: 'points at /var/lib/example-place/agent-b.sock; the slot that runs, example-place-a.service, is at /var/lib/example-place/agent-a.sock' }]);
  const answer = await applyWhatItRuns(machine, linked, run);
  assert.deepEqual(answer.linked, ['/var/lib/example-place/agent.sock']);
  assert.equal(answer.switched, undefined);
  assert.deepEqual(answer.restarted, []);
  assert.ok(commands.some(({ command }) => command === pointed('/var/lib/example-place/agent.sock', '/var/lib/example-place/agent-a.sock')));
});

test('a live link that already points at the running slot changes nothing', async () => {
  const { run } = slotComputer({ row: linked, active: ['example-place-a.service'], links: { 'current-a': SOURCE_COMMIT }, liveLinks: { '/var/lib/example-place/agent.sock': '/var/lib/example-place/agent-a.sock' } });
  assert.deepEqual(await applyWhatItRuns(machine, linked, run), { written: [], restarted: [] });
});

test('live links map absolute paths to absolute paths that name the slot', () => {
  for (const bad of [{ 'agent.sock': '/x/agent-{slot}.sock' }, { '/x/agent.sock': '/x/agent-a.sock' }, ['/x'], null]) {
    assert.throws(() => renderWhatItRuns({ ...linked, units: [{ ...linked.units[0], live_links: bad }] }), /live_links maps absolute paths/);
  }
});

test('a new slot that answers but fails its switch_check_command is stopped again, and the slot that ran keeps serving', async () => {
  const checked = { ...slotted, units: [{ ...slotted.units[0], switch_check_command: 'check-kept {unit} {listen}', switch_check_seconds: 10 }] };
  const failing = slotComputer({ active: ['example-place-a.service'], links: { 'current-a': 'b'.repeat(40) } });
  const run = async (m, command, input) => {
    if (command.startsWith('check-kept ')) { failing.commands.push({ command }); throw Object.assign(new Error('2 kept sessions not running'), { code: 1 }); }
    return failing.run(m, command, input);
  };
  await assert.rejects(applyWhatItRuns(machine, checked, run, {}, { wait: async () => {} }), /example-place-b\.service's switch_check_command did not pass after the restart: 2 kept sessions not running Candidate stop succeeded; no incumbent retirement was requested for this unit\./);
  assert.equal(failing.commands.filter(({ command }) => command === 'check-kept example-place-b.service 127.0.0.1:7198').length, 2, 'tried every 5 s for switch_check_seconds');
  assert.ok(failing.commands.some(({ command }) => command === "systemctl stop 'example-place-b.service'"));
  assert.equal(failing.commands.some(({ command }) => command.includes("'example-place-a.service'") && /disable|stop|restart/.test(command)), false);
  const passing = slotComputer({ active: ['example-place-a.service'], links: { 'current-a': 'b'.repeat(40) } });
  const ok = async (m, command, input) => command.startsWith('check-kept ') ? (passing.commands.push({ command }), '') : passing.run(m, command, input);
  assert.deepEqual((await applyWhatItRuns(machine, checked, ok)).switched, [{ to: 'example-place-b.service', from: ['example-place-a.service'] }]);
  const at = text => passing.commands.findIndex(({ command }) => command.startsWith(text));
  assert.ok(at('check-kept ') < at("systemctl disable --now 'example-place-a.service'"), 'the slot that ran stops only after the check passed');
});

test('a provider refusal after a slot switch keeps the row and pages aligned with the running process', async t => {
  const oldCommit = 'b'.repeat(40);
  const incumbent = 'example-place-a.service', candidate = 'example-place-b.service';
  const host = 'place.example.test', tree = 'e'.repeat(40);
  const candidateProof = `check-release ${candidate} 127.0.0.1:7198`;
  const stopOldSlot = `systemctl disable --now '${incumbent}'`;
  for (const [scenario, expectedExit] of [['before switch', 1], ['retirement reply lost', 5], ['provider refuses', 4], ['ordinary reload reply lost', 1]]) {
    await t.test(scenario, async t => {
      const root = mkdtempSync(join(tmpdir(), 'row-slot-dns-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const pages = join(root, 'pages');
      for (const folder of [pages, join(root, oldCommit), join(root, SOURCE_COMMIT)]) mkdirSync(folder);
      const site = join(pages, host);
      symlinkSync(join(root, oldCommit), site);
      const original = { name: 'example-box', address: machine.address, runs: {
        ...slotted, rendered_from_workshop: oldCommit,
        units: [{ ...slotted.units[0], pages_hosts: [host], source: { ...slotted.units[0].source, commit: oldCommit },
          switch_check_command: 'check-release {unit} {listen}', switch_check_seconds: 5 }],
        names: [{ host_name: host, provider: 'tools/start-a-computer/providers/hetzner-dns.json' }],
      } };
      if (scenario === 'ordinary reload reply lost') original.runs.units[0].files = [
        { path: '/etc/example-place/reload.conf', text: 'new\n', then: [['example-reload']] },
      ];
      let row = structuredClone(original), writes = 0, dnsReads = 0, stoppedProbes = 0, receipt;
      const active = [incumbent], selected = { 'current-a': oldCommit };
      const pids = new Map([[incumbent, 101]]), enabled = new Set([incumbent]);
      const fixture = slotComputer({ active, links: selected });
      const remove = unit => {
        assert.ok(pids.delete(unit), `${unit} must have a live process to remove`);
        active.splice(active.indexOf(unit), 1);
      };
      const run = async (machine, command, input) => {
        if (command.startsWith('sh -c ')) {
          const sent = sourceSent(command);
          assert.equal(sent.current, 'current-b');
          assert.equal(sent.commit, SOURCE_COMMIT);
          selected['current-b'] = sent.commit;
        }
        if (command === `systemctl restart '${candidate}'`) { active.push(candidate); pids.set(candidate, 202); }
        if (command.startsWith('check-release ')) {
          assert.equal(command, candidateProof);
          assert.equal(pids.get(candidate), 202);
          assert.equal(selected['current-b'], SOURCE_COMMIT);
          if (scenario === 'before switch') throw new Error('candidate did not prove its release');
          return '';
        }
        if (command === `systemctl stop '${candidate}'`) remove(candidate);
        if (command.startsWith(`systemctl enable '${candidate}'`)) enabled.add(candidate);
        if (command.startsWith(stopOldSlot)) {
          remove(incumbent);
          enabled.delete(incumbent);
          if (scenario === 'retirement reply lost') throw new Error('retirement reply lost');
        }
        if (command === "'example-reload'") {
          assert.equal(scenario, 'ordinary reload reply lost');
          assert.deepEqual([...pids], [[candidate, 202]]);
          throw Object.assign(new Error('ordinary reload reply lost'), { code: 255 });
        }
        return fixture.run(machine, command, input);
      };
      let failure;
      const outcome = await applyARow({
        computer: row.name, workshop_commit: tree,
        edits: [{ at: 'runs.units[unit=example-place.service].source.commit', from: oldCommit, to: SOURCE_COMMIT }],
        links: { folder: pages, set: { [host]: join(root, SOURCE_COMMIT) } },
      }, {}, {
        targets: { machines: { [machine.address]: { ssh: { known_hosts: '/hosts', identity_file: '/key' }, pages_folder: pages } } },
        store: {
          read: async () => ({ computer: structuredClone(row), siteSetting: null }),
          write: async (_, value) => { writes++; row = structuredClone(value); return { read_back_equal: true }; },
        },
        isAncestor: async () => true, heldValues: async () => ({ 'hetzner-api-token': 'fixture-only-dns-token' }),
        runFolder: () => root, archive: async (_, folder) => mkdirSync(folder), checkApplyProtocol: async () => {},
        startProbe: async () => ({ stop: async () => { stoppedProbes++; return { started: new Date(0).toISOString(), stopped: new Date(1).toISOString(), sent: 1, ok: 1, failed: 0, retried: 0, slow: 0 }; } }),
        now: () => 0, sleep: async () => {},
        runApply: async ({ requestFile, held }) => {
          try {
            receipt = await applyAComputerRow(readRequest(requestFile), { run, held, fetchImpl: async () => {
              dnsReads++;
              assert.deepEqual([...pids], [[candidate, 202]], 'the provider is contacted only after retirement');
              return new Response('{"error":{"message":"fixture refused the DNS update"}}', { status: 403 });
            } });
            return { exit: computerRowApplyExit(receipt), receipt: computerRowApplyReceipt(receipt) };
          } catch (error) {
            assert.match(error.message, scenario === 'before switch' ? /Candidate stop succeeded/ : scenario === 'retirement reply lost' ? /did not confirm retire/ : /reply lost/);
            const exit = error.exit ?? 1, typed = computerRowApplyFailure(error);
            if (scenario === 'ordinary reload reply lost') {
              assert.equal(exit, 1);
              assert.equal(typed, undefined);
            }
            return { exit, receipt: typed };
          }
        },
      }).catch(error => { failure = error; });
      assert.equal(outcome?.code ?? failure?.exit, expectedExit);
      assert.equal(stoppedProbes, 1);
      if (scenario === 'before switch') {
        assert.deepEqual([...pids], [[incumbent, 101]]);
        assert.deepEqual([...enabled], [incumbent]);
        assert.equal(selected['current-a'], oldCommit);
        assert.deepEqual(row, original);
        assert.equal(outcome.summary.row_put_back, true);
        assert.equal(readlinkSync(site), join(root, oldCommit));
        assert.equal(writes, 2);
      } else {
        assert.deepEqual([...pids], [[candidate, 202]]);
        assert.deepEqual([...enabled], [candidate]);
        assert.equal(selected['current-b'], SOURCE_COMMIT);
        const expectedRow = structuredClone(original);
        expectedRow.runs.rendered_from_workshop = tree;
        expectedRow.runs.units[0].source.commit = SOURCE_COMMIT;
        assert.deepEqual(row, expectedRow);
        assert.equal(outcome?.summary.row_put_back, undefined);
        assert.equal(readlinkSync(site), join(root, SOURCE_COMMIT));
        assert.equal(writes, 1);
        if (scenario === 'ordinary reload reply lost') {
          assert.equal(failure?.apply_outcome, 'unknown_needs_readback');
          assert.equal(failure.child_exit, 1, failure.cause?.stack ?? failure.stack);
          assert.match(failure.message, /outcome is unknown/i);
        }
      }
      if (scenario === 'provider refuses') {
        assert.equal(dnsReads, 1);
        assert.deepEqual(receipt.switched, [{ to: candidate, from: [incumbent] }]);
        assert.match(receipt.names_unconfirmed, /403|refused/);
      } else {
        assert.equal(dnsReads, 0);
        if (scenario === 'retirement reply lost') assert.equal(outcome.summary.apply_outcome, 'slot_switch_unconfirmed');
      }
    });
  }
});

// A slot boots only when MemAvailable holds what it needs (the unit's start_headroom_bytes, else the running slot's MemoryCurrent)
// and settings.json slot_start.margin_bytes (256 MiB). A slot that does not fit is refused before anything stops.
const withHeadroom = start_headroom_bytes => ({ ...slotted, units: [{ ...slotted.units[0], start_headroom_bytes }] });
const bootsAt = memory => slotComputer({ active: ['example-place-a.service'], links: { 'current-a': 'b'.repeat(40) }, memory });

test('a new slot boots when MemAvailable holds its start headroom and the margin over it', async () => {
  const { run, commands } = bootsAt({ available: 1800 * MiB, current: 1260 * MiB });
  const answer = await applyWhatItRuns(machine, withHeadroom(1500 * MiB), run, {}, { wait: async () => {} });
  assert.deepEqual(answer.switched, [{ to: 'example-place-b.service', from: ['example-place-a.service'] }]);
  assert.ok(commands.some(({ command }) => command === "systemctl restart 'example-place-b.service'"));
});

test('a new slot that does not fit is refused, and the slot that runs keeps serving untouched', async () => {
  const { run, commands } = bootsAt({ available: 1700 * MiB, current: 1260 * MiB });
  const failure = await applyWhatItRuns(machine, withHeadroom(1500 * MiB), run, {}, { wait: async () => {} }).then(() => null, error => error);
  assert.equal(failure?.exit, 2, 'a refusal, as the other named refusals are');
  assert.match(failure.message, new RegExp(`^example-place-b\\.service was not started: it needs ${1756 * MiB} bytes of MemAvailable and the computer has ${1700 * MiB}\\. example-place-a\\.service kept serving\\.$`));
  const sent = text => commands.some(({ command }) => command.startsWith(text));
  assert.equal(sent("systemctl restart 'example-place-b.service'"), false, 'the new slot is not started');
  assert.equal(sent('curl '), false, 'the new slot is not asked');
  assert.equal(commands.some(({ command }) => command.includes("'example-place-a.service'") && /disable|stop|restart/.test(command)), false, 'the slot that runs is not stopped');
});

test('with no start_headroom_bytes, the running slot\'s MemoryCurrent is the headroom it needs', async () => {
  const short = bootsAt({ available: 1500 * MiB, current: 1260 * MiB });
  const failure = await applyWhatItRuns(machine, slotted, short.run, {}, { wait: async () => {} }).then(() => null, error => error);
  assert.match(failure.message, new RegExp(`needs ${(1260 + 256) * MiB} bytes of MemAvailable and the computer has ${1500 * MiB}\\.`));
  assert.ok(short.commands.some(({ command }) => command === "systemctl show -p MemoryCurrent --value 'example-place-a.service'"), 'the running slot\'s memory is read');
  const enough = bootsAt({ available: 1600 * MiB, current: 1260 * MiB });
  assert.deepEqual((await applyWhatItRuns(machine, slotted, enough.run, {}, { wait: async () => {} })).switched, [{ to: 'example-place-b.service', from: ['example-place-a.service'] }]);
});

test('the start peak the last switch measured is the headroom when it is more than the running slot uses', async () => {
  const short = bootsAt({ available: 1700 * MiB, current: 1260 * MiB, kept: 1500 * MiB });
  const failure = await applyWhatItRuns(machine, slotted, short.run, {}, { wait: async () => {} }).then(() => null, error => error);
  assert.match(failure?.message ?? '', new RegExp(`needs ${(1500 + 256) * MiB} bytes of MemAvailable and the computer has ${1700 * MiB}\\. example-place-a\\.service kept serving\\.$`));
  assert.equal(short.commands.some(({ command }) => command === "systemctl restart 'example-place-b.service'"), false, 'the new slot is not started');
  const smaller = bootsAt({ available: 1600 * MiB, current: 1260 * MiB, kept: 900 * MiB });
  assert.deepEqual((await applyWhatItRuns(machine, slotted, smaller.run, {}, { wait: async () => {} })).switched, [{ to: 'example-place-b.service', from: ['example-place-a.service'] }], 'a smaller kept peak leaves the running slot\'s memory as the need');
});

test('a switch that passes keeps the new slot\'s MemoryPeak as the start peak, and one the computer cannot report keeps nothing', async () => {
  const measured = bootsAt({ available: 4096 * MiB, current: 1260 * MiB, peak: 1320 * MiB });
  await applyWhatItRuns(machine, slotted, measured.run, {}, { wait: async () => {} });
  const at = text => measured.commands.findIndex(({ command }) => command.startsWith(text));
  const kept = measured.commands.find(({ command }) => command.startsWith("printf '%s\\n'") && command.includes('start-peak-bytes'));
  assert.equal(kept?.command, `printf '%s\\n' '${1320 * MiB}' > '/var/lib/example-place/start-peak-bytes'`);
  assert.ok(at("systemctl show -p MemoryPeak --value 'example-place-b.service'") > at("curl -s -o /dev/null -w '%{http_code}' -H 'Host: place.example.test' 'http://127.0.0.1:7198/readyz'"), 'read once the new slot answers');
  const silent = bootsAt({ available: 4096 * MiB, current: 1260 * MiB });
  assert.deepEqual((await applyWhatItRuns(machine, slotted, silent.run, {}, { wait: async () => {} })).switched, [{ to: 'example-place-b.service', from: ['example-place-a.service'] }]);
  assert.equal(silent.commands.some(({ command }) => command.includes('start-peak-bytes') && command.startsWith('printf')), false);
});

test('a unit without slots reads no memory and is applied as before', async () => {
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  const { run, commands } = computer(live);
  assert.deepEqual(await applyWhatItRuns(machine, runs, run), { written: [], restarted: [] });
  assert.equal(commands.some(({ command }) => command.includes('MemAvailable') || command.includes('MemoryCurrent')), false);
});

// A slot served on a unix socket has no TCP address to ask: its own check_command (a curl --unix-socket on its socket) is its
// boot check, and neither the unit nor the computer's row names health_listen (Nov 21 2026: a site's two slots, a socket each).
test('a socket-served slot boots on its own check_command, with no health_listen in its unit or its computer\'s row', async () => {
  const { health_listen: unitListen, ...unit } = slotted.units[0];
  const { health_listen: rowListen, ...row } = slotted;
  const socket = slot => `/run/sites/place.example.test/http-${slot}.sock`;
  const socketed = { ...row, units: [{ ...unit, slots: Object.fromEntries(['a', 'b'].map(slot => [slot, { 'settings.listen': `unix:${socket(slot)}`, check_command: `check-socket ${socket(slot)}` }])) }] };
  const served = slotComputer({ active: ['example-place-a.service'], links: { 'current-a': 'b'.repeat(40) } });
  const run = async (m, command, input) => {
    if (command.startsWith('check-socket ')) { served.commands.push({ command }); return ''; }
    return served.run(m, command, input);
  };
  const answer = await applyWhatItRuns(machine, socketed, run, {}, { wait: async () => {} });
  assert.deepEqual(answer.switched, [{ to: 'example-place-b.service', from: ['example-place-a.service'] }]);
  const at = text => served.commands.findIndex(({ command }) => command.startsWith(text));
  assert.ok(at(`check-socket ${socket('b')}`) > at("systemctl restart 'example-place-b.service'"), 'the new slot\'s socket is asked after its start');
  assert.ok(at("systemctl restart 'example-place-b.service'") >= 0);
  assert.ok(at(`check-socket ${socket('b')}`) < at("systemctl disable --now 'example-place-a.service'"), 'the slot that ran stops only once the new slot\'s socket answers');
  assert.equal(at(`check-socket ${socket('a')}`), -1, 'the slot that ran is not asked');
  assert.equal(served.commands.some(({ command }) => command.startsWith('curl ')), false, 'no TCP health is asked');
});

test('a slot that runs its row\'s release is left alone', async () => {
  const { run, commands } = slotComputer({ active: ['example-place-b.service'], links: { 'current-b': SOURCE_COMMIT } });
  assert.deepEqual(await runsDifferences(machine, slotted, run), []);
  assert.deepEqual(await applyWhatItRuns(machine, slotted, run), { written: [], restarted: [] });
  assert.equal(commands.some(({ command }) => /^systemctl (restart|disable|enable)/.test(command)), false);
});

test('a folder a unit owns whole keeps only the files the row renders: a stray is a difference and the apply removes it', async () => {
  const owner = { ...runs.units[0], owned_folders: ['/var/lib/example-pages'], files: [{ path: '/var/lib/example-pages/kept.html', text: 'kept\n', then: [] }] };
  const row = { ...runs, units: [owner] };
  const live = Object.fromEntries(renderWhatItRuns(row).map(({ path, text }) => [path, text]));
  const commands = [], removals = [];
  const run = async (_machine, command, input) => {
    commands.push(command);
    if (command.includes('rm -f')) removals.push(input);
    if (command.includes('sha256sum')) return hashesOf(live, input);
    if (command.startsWith('if [ -f ')) { const p = command.match(/if \[ -f '([^']+)' \]/)[1]; if (live[p] === undefined) throw Object.assign(new Error('absent'), { code: 3 }); return live[p]; }
    if (command.startsWith("if [ -d '/var/lib/example-pages' ]")) return '/var/lib/example-pages/kept.html\n/var/lib/example-pages/old/left.html\n';
    if (command.includes('curl')) return '200';
    if (command.startsWith('ufw status')) return 'Status: active\n\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n';
    return '';
  };
  const found = await runsDifferences(machine, row, run);
  assert.deepEqual(found.map(item => item.path), ['/var/lib/example-pages/old/left.html']);
  const answer = await applyWhatItRuns(machine, row, run);
  assert.deepEqual(answer.removed, ['/var/lib/example-pages/old/left.html']);
  const removal = commands.findIndex(command => command.startsWith('while IFS= read -r p; do rm -f'));
  assert.ok(removal >= 0, 'the strays go in one command');
  // Changed again: the new page is written before the stray it no longer names goes.
  live['/var/lib/example-pages/kept.html'] = 'old\n';
  commands.length = 0; removals.length = 0;
  await applyWhatItRuns(machine, row, run);
  const wrote = commands.findIndex(command => command.includes('tar -x -f - -C /'));
  const gone = commands.findIndex(command => command.startsWith('while IFS= read -r p; do rm -f'));
  assert.ok(wrote >= 0 && gone > wrote, `the stray goes after the new page is written (${wrote}, ${gone})`);
  assert.deepEqual(removals, ['/var/lib/example-pages/old/left.html\n'], 'only the stray, never a rendered file');
  assert.ok(!commands.some(command => command.includes("rm -rf -- '/var/lib/example-pages")), 'no stray goes one by one');
});

test('a port the row admits that the firewall does not is a difference, and the apply runs set-up, which admits it', async () => {
  const opened = { ...runs, machine: { firewall_allow: ['22/tcp', '5432/tcp'] } };
  const live = { ...Object.fromEntries(renderWhatItRuns(opened).map(({ path, text }) => [path, text])), firewall: ['22/tcp'] };
  const { run, commands } = computer(live);
  assert.deepEqual(await runsDifferences(machine, opened, run), [{ path: 'firewall 5432/tcp', reason: 'the computer row admits it; the firewall does not' }]);
  await applyWhatItRuns(machine, opened, run);
  const setUp = commands.find(({ command }) => command.startsWith('sh -s'));
  assert.ok(setUp, 'set-up ran');
  assert.match(setUp.command, /5432\/tcp/, 'with the row\'s firewall');
  const matched = computer({ ...live, firewall: ['22/tcp', '5432/tcp'] });
  assert.deepEqual(await runsDifferences(machine, opened, matched.run), []);
});

test('a changed file in a folder a unit owns whole keeps no copy beside it, so the next apply finds no stray', async () => {
  const owner = { ...runs.units[0], owned_folders: ['/var/lib/example-pages'], files: [{ path: '/var/lib/example-pages/kept.html', text: 'new\n', then: [] }] };
  const row = { ...runs, units: [owner] };
  const live = Object.fromEntries(renderWhatItRuns(row).map(({ path, text }) => [path, text]));
  live['/var/lib/example-pages/kept.html'] = 'old\n';
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push(command);
    if (command.includes('sha256sum')) return hashesOf(live, input);
    if (command.startsWith('if [ -f ')) { const p = command.match(/if \[ -f '([^']+)' \]/)[1]; if (live[p] === undefined) throw Object.assign(new Error('absent'), { code: 3 }); return live[p]; }
    if (command.startsWith("if [ -d '/var/lib/example-pages' ]")) return '/var/lib/example-pages/kept.html\n';
    if (command.includes('curl')) return '200';
    if (command.startsWith('ufw status')) return 'Status: active\n\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n';
    return '';
  };
  const answer = await applyWhatItRuns(machine, row, run);
  assert.deepEqual(answer.written, ['/var/lib/example-pages/kept.html']);
  assert.ok(!commands.some(command => command.startsWith("cp -p '/var/lib/example-pages/kept.html'")), 'no copy is kept in the owned folder');
});

test('a unit that runs a downloaded program is restarted when its process runs the file replaced under it, and left alone when it runs that file', async () => {
  const PROGRAM = '/usr/local/bin/x';
  const downloaded = { ...runs, machine: { downloads: [{ path: PROGRAM, install: true }] }, units: runs.units.map(unit => ({ ...unit, program: PROGRAM })) };
  const live = Object.fromEntries(renderWhatItRuns(downloaded).map(({ path, text }) => [path, text]));
  const stale = { path: 'example-place.service', reason: `is not running ${PROGRAM}, the program its row names` };
  for (const [exe, restarted] of [[`${PROGRAM} (deleted)`, ['example-place.service']], [PROGRAM, []]]) {
    const base = computer(live);
    const run = async (m, command, input) => {
      if (command.startsWith('pid=$(systemctl show') && command.includes('/proc/$pid/exe')) {
        assert.match(command, new RegExp(`readlink -f '${PROGRAM}'`), 'the running executable is compared with the file the row names');
        if (exe === PROGRAM) return '';
        throw Object.assign(new Error('another file runs'), { code: 3 });
      }
      return base.run(m, command, input);
    };
    assert.deepEqual(await runsDifferences(machine, downloaded, run), exe === PROGRAM ? [] : [stale]);
    assert.deepEqual((await applyWhatItRuns(machine, downloaded, run)).restarted, restarted);
  }
});


const scopeBuildMetadata = {
  repository: 'git@example.test:example/engine.git', build: ['make', 'example'], output: 'dist/example',
  credential: 'fixture-build-credential', host_keys: ['example.test ssh-ed25519 fixture-only'],
  environment: ['RELEASE_COMMIT={commit}'],
};

test('one pinned engine scope overlaps only its own slots and refuses unrelated writes', async t => {
  const digest = bytes => Buffer.from(blake3(bytes)).toString('hex');
  const oldBytes = Buffer.from('fixture rollback executable'), nextBytes = Buffer.from('fixture candidate executable');
  const old = { ...scopeBuildMetadata, commit: '1'.repeat(40), prebuilt: { blake3: digest(oldBytes) } };
  const next = { ...scopeBuildMetadata, commit: '2'.repeat(40), prebuilt: { blake3: digest(nextBytes) } };
  const lastWholeRender = '3'.repeat(40), renderer = '4'.repeat(40), name = 'example-box';
  const a = 'example-place-a.service', b = 'example-place-b.service';
  const invocationA = 'a'.repeat(32), invocationB = 'b'.repeat(32);
  const scope = { kind: 'engine-slot', unit: 'example-place.service', incumbent: { unit: a, pid: 101, invocation: invocationA } };
  const siteFile = 'brands/example.json';
  const siteSetting = { app_host: 'page.example.test', site_host: 'site.example.test', name: 'Example Workspace', cli: 'example' };
  const pointers = { app_host: '/app_host', site_host: '/site_host', server_name: '/name', command_word: '/cli' };
  const door = { accepts_hosts: [siteSetting.app_host] };
  const intake = Object.fromEntries(Object.entries(pointers).map(([field, pointer]) => [`/settings/doors/0/${field}`, { file: siteFile, pointer }]));
  const engine = { ...runs.units[0], settings: { ...runs.units[0].settings, doors: [door] }, parts: intake, source: old, slots: {
    a: { 'settings.listen': '127.0.0.1:7199', health_listen: '127.0.0.1:7199' },
    b: { 'settings.listen': '127.0.0.1:7198', health_listen: '127.0.0.1:7198' },
  } };
  const initial = { name, address: machine.address, runs: {
    ...runs, rendered_from_workshop: lastWholeRender, units: [engine,
      { unit: 'caddy.service', prepare: 'tools/keep-a-caddy-front-door-on-a-computer/prepare-a-caddy-site.mjs', site: { site_file: 'single-name-front-door', door_host: 'page.example.test', engine_paths: ['/.well-known/oauth-protected-resource'], engine_routes: ['tools/keep-an-engine-on-a-computer/caddy-route-engine.caddy'], pools: { engine: { listen: ['127.0.0.1:7199', '127.0.0.1:7198'] } } }, owned_folders: ['/var/lib/example-pages'], parts: { '/site/made_pages/0/arguments/1': { file: 'never/read/caddy.json' } } },
      { unit: 'sign-in.service', parts: { '/settings/site': { file: siteFile }, '/settings/email/sender': { file: 'never/read/sender.json' } } },
    ],
    names: [{ host_name: 'page.example.test', provider: 'never/ask/dns.json' }],
  } };
  const request = { computer: name, workshop_commit: renderer, scope, edits: [{ at: 'runs.units[unit=example-place.service].source', from: old, to: next }] };
  const hydratedDoor = { ...door, app_host: siteSetting.app_host, site_host: siteSetting.site_host, server_name: siteSetting.name, command_word: siteSetting.cli };
  const hydrated = { ...engine, settings: { ...engine.settings, doors: [hydratedDoor] } };
  delete hydrated.parts;
  const paths = Object.fromEntries(renderWhatItRuns(withSlots({ units: [hydrated] })).map(({ path, text }) => [path, text]));
  const file = source => `${engine.builds}/${source.commit}/${engine.program}`;
  for (const scenario of ['success', 'missing probe startup', 'final probe lost', 'bad initial readiness', 'lost retirement reply', 'old bytes drifted', 'unit files drifted', 'candidate link drifted', 'unretained rollback', 'unbound site part', 'non-door site pointer', 'missing site setting', 'unrelated edit', 'whole pin edit', 'page link', 'legacy archive', 'bad probe response', 'probe retry', 'missing probe sample', 'root-only route', 'wrong engine pool', 'wrong engine host', 'ambiguous front door']) {
    await t.test(scenario, async t => {
      const folder = mkdtempSync(join(tmpdir(), 'selected-engine-scope-'));
      t.after(() => rmSync(folder, { recursive: true, force: true }));
      const baseline = structuredClone(initial);
      if (scenario === 'unretained rollback') delete baseline.runs.units[0].source.prebuilt;
      if (scenario === 'unbound site part') baseline.runs.units[0].parts['/settings/doors/0/app_host'].file = 'brands/other.json';
      if (scenario === 'non-door site pointer') baseline.runs.units[0].parts['/settings/doors/0/app_host'].pointer = '/unrelated';
      if (scenario === 'root-only route') baseline.runs.units[1].site.engine_paths = ['/'];
      if (scenario === 'wrong engine pool') baseline.runs.units[1].site.pools.engine.listen = ['127.0.0.1:7199'];
      if (scenario === 'wrong engine host') baseline.runs.units[1].site.door_host = 'other.example.test';
      if (scenario === 'ambiguous front door') baseline.runs.units.push(structuredClone(baseline.runs.units[1]));
      let stored = structuredClone(baseline), writes = 0, probeStarted = false, probeStopped = false, requestsBeforeWrite = 0;
      const hits = [];
      let loopback;
      if (scenario === 'success') {
        const server = createServer((_, res) => { hits.push(Date.now()); res.end(JSON.stringify({ resource: 'https://page.example.test/mcp' })); });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        loopback = `http://127.0.0.1:${server.address().port}/`;
        t.after(() => { server.closeAllConnections(); return new Promise(done => server.close(done)); });
      }
      const states = {
        [a]: { pid: 101, invocation: invocationA, enabled: true, source: old },
        [b]: { pid: 0, invocation: '', enabled: false, source: next },
      };
      const commands = [];
      const run = async (_, command, input) => {
        commands.push(command);
        assert.doesNotMatch(command, /caddy|example-pages|\b(?:tar|install|useradd|userdel|build-from-source)\b/i, 'scope must not request a Caddy/page/account/artifact write');
        const named = /^systemctl show -p Id .* '([^']+)'$/.exec(command);
        if (named) {
          const unit = named[1], state = states[unit];
          assert.ok(state, 'only the selected slots can be inspected');
          const fragment = `/etc/systemd/system/${unit}`;
          return Object.entries({ Id: unit, LoadState: 'loaded', ActiveState: state.pid ? 'active' : 'inactive', SubState: state.pid ? 'running' : 'dead',
            UnitFileState: state.enabled ? 'enabled' : 'disabled', MainPID: state.pid, InvocationID: state.invocation,
            NeedDaemonReload: 'no', Job: 0, FragmentPath: fragment, DropInPaths: `${fragment}.d/nofile.conf`,
          }).map(([key, value]) => `${key}=${value}`).join('\n');
        }
        if (command.includes('sha256sum')) {
          const requested = input.trim().split('\n');
          assert.ok(requested.every(path => Object.hasOwn(paths, path)));
          const live = scenario === 'unit files drifted' ? { ...paths, [requested[0]]: 'drifted' } : paths;
          return hashesOf(live, input);
        }
        if (command === `readlink -- '${engine.builds}/current-a'`) return old.commit;
        if (command === `readlink -- '${engine.builds}/current-b'`) return scenario === 'candidate link drifted' ? old.commit : next.commit;
        if (command.startsWith('test -x ') && command.endsWith(`b3sum --no-names < '${file(old)}'`)) return digest(scenario === 'old bytes drifted' ? nextBytes : oldBytes);
        if (command.startsWith('test -x ') && command.endsWith(`b3sum --no-names < '${file(next)}'`)) return digest(nextBytes);
        if (command === 'readlink -f -- /proc/101/exe') { assert.equal(states[a].pid, 101); return file(old); }
        if (command === 'readlink -f -- /proc/202/exe') { assert.equal(states[b].pid, 202); return file(next); }
        if (command === `systemctl show -p MemoryCurrent --value '${a}'`) return '104857600';
        if (command.startsWith("awk '/^MemAvailable:")) return '1000000000';
        if (command === `cat '${engine.state}/start-peak-bytes' 2>/dev/null || true`) return '';
        if (command === `systemctl start '${b}'`) { assert.equal(states[a].pid, 101); assert.equal(states[b].pid, 0); states[b].pid = 202; states[b].invocation = invocationB; return ''; }
        if (command === "curl --fail --silent --max-time 5 'http://127.0.0.1:7198/readyz'") {
          assert.equal(states[a].pid, 101); assert.equal(states[b].pid, 202);
          return JSON.stringify({ release_commit: scenario === 'bad initial readiness' ? old.commit : next.commit, draining: false });
        }
        if (command === `systemctl stop '${b}'`) { states[b].pid = 0; return ''; }
        if (command === `systemctl enable '${b}' >/dev/null 2>&1`) { assert.equal(states[b].pid, 202); states[b].enabled = true; return ''; }
        if (command === `systemctl disable --now '${a}' >/dev/null 2>&1`) {
          assert.equal(states[b].enabled, true); states[a].pid = 0; states[a].enabled = false;
          if (scenario === 'lost retirement reply') throw Object.assign(new Error('fixture transport reply lost'), { code: 255 });
          return '';
        }
        assert.fail(`scope requested an undeclared command: ${command}`);
      };
      const deps = {
        store: { read: async () => ({ computer: structuredClone(stored), siteSetting: scenario === 'missing site setting' ? null : JSON.stringify(siteSetting) }),
          write: async (_, row) => {
            assert.equal(probeStarted, true);
            if (writes === 0 && loopback) { requestsBeforeWrite = hits.length; assert.ok(requestsBeforeWrite > 0); }
            writes++; stored = structuredClone(row); return { read_back_equal: true };
          } },
        targets: { machines: { [machine.address]: { ssh: { known_hosts: '/fixture-hosts', identity_file: '/fixture-id' }, pages_folder: '/do-not-read-pages' } }, probe: { startup_deadline_ms: 3000, stop_after_ms: 200 } },
        isAncestor: async () => true, heldValues: () => assert.fail('no held values for an engine scope'), addressesOf: () => assert.fail('no DNS'),
        startProbe: async args => {
          assert.deepEqual(args.urls, ['https://page.example.test/.well-known/oauth-protected-resource']);
          assert.equal(args.expectedResource, 'https://page.example.test/mcp');
          assert.equal(writes, 0);
          if (scenario === 'missing probe startup') return undefined;
          const probe = loopback ? await startApplyProbe({ ...args, urls: [loopback] }) : null;
          probeStarted = true;
          return { stop: async () => {
            probeStopped = true;
            assert.ok(writes > 0);
            if (probe) return probe.stop();
            if (scenario === 'final probe lost') return null;
            return { started: new Date(0).toISOString(), stopped: new Date(1).toISOString(), sent: 1, ok: ['bad probe response', 'probe retry'].includes(scenario) ? 0 : 1, failed: scenario === 'bad probe response' ? 1 : 0, retried: scenario === 'probe retry' ? 1 : 0, slow: 0, resource_checked: ['bad probe response', 'missing probe sample'].includes(scenario) ? 0 : 1 };
          } };
        }, now: Date.now, sleep: ms => loopback ? delay(ms) : Promise.resolve(),
        runFolder: () => folder,
        archive: async (_, tree) => {
          if (scenario === 'legacy archive') {
            const entry = join(tree, 'tools/start-a-computer/do-work/start-a-computer.mjs');
            mkdirSync(dirname(entry), { recursive: true });
            writeFileSync(entry, 'export const ROW_APPLY_RESULT_PROTOCOL = 1;');
          } else if (loopback) {
            const entry = join(tree, 'tools/start-a-computer/do-work/probe-while-applying.mjs');
            mkdirSync(dirname(entry), { recursive: true });
            symlinkSync(fileURLToPath(new URL('../do-work/probe-while-applying.mjs', import.meta.url)), entry);
          } else mkdirSync(tree);
        },
        checkApplyProtocol: scenario === 'legacy archive' ? checkApplyProtocol : async (_, asked) => {
          assert.equal(asked.unit, engine.unit);
          return { readRequest, checkScopedEngine: input => checkScopedEngine(input, { run }) };
        },
        runApply: async ({ requestFile, held }) => {
          assert.deepEqual(held, {});
          const input = readRequest(requestFile);
          assert.equal(input.pages_folder, undefined);
          assert.equal(input.computer_row.runs.rendered_from_workshop, lastWholeRender);
          assert.deepEqual(input.computer_row.runs.units[0].settings.doors[0], hydratedDoor);
          assert.equal(input.computer_row.runs.units[0].parts, undefined);
          assert.deepEqual(input.computer_row.runs.units.slice(1), initial.runs.units.slice(1));
          try {
            const answer = await applyAComputerRow(input, { run, wait: async () => {}, fetchImpl: () => assert.fail('no requests to providers') });
            return { exit: computerRowApplyExit(answer), receipt: computerRowApplyReceipt(answer) };
          } catch (error) { return { exit: error.exit ?? 1, receipt: computerRowApplyFailure(error) }; }
        },
      };
      const given = structuredClone(request);
      if (scenario === 'unretained rollback') given.edits[0].from = baseline.runs.units[0].source;
      if (scenario === 'page link') given.links = { folder: '/do-not-read-pages', set: {} };
      if (scenario === 'unrelated edit') given.edits.push({ at: 'runs.units[unit=caddy.service].prepare', to: 'another-page-maker.mjs' });
      if (scenario === 'whole pin edit') given.edits.push({ at: 'runs.rendered_from_workshop', to: renderer });
      if (['unrelated edit', 'whole pin edit', 'legacy archive', 'old bytes drifted', 'unit files drifted', 'candidate link drifted', 'unretained rollback', 'page link', 'unbound site part', 'non-door site pointer', 'missing site setting', 'missing probe startup', 'root-only route', 'wrong engine pool', 'wrong engine host', 'ambiguous front door'].includes(scenario)) {
        await assert.rejects(applyARow(given, {}, deps), /changes just the selected|does not support the requested engine scope|BLAKE3 pin|selected engine’s existing rendered files differ|does not select the required resident release|does not accept page links|may fill only the declared door fields|needs the owner’s site setting|probe did not confirm startup|engine probe needs one declared front door|engine probe host must be/);
        assert.deepEqual(stored, baseline); assert.equal(writes, 0); assert.equal(probeStarted, false);
        assert.equal(states[a].pid, 101); assert.equal(states[b].pid, 0);
        assert.ok(!commands.some(command => /^systemctl (?:start|stop|enable|disable) /.test(command)));
        return;
      }
      const { code, summary } = await applyARow(given, {}, deps);
      assert.equal(summary.unit, engine.unit);
      assert.equal(summary.renderer, renderer);
      assert.equal(summary.last_whole_render, lastWholeRender);
      assert.equal(probeStopped, true);
      assert.deepEqual(summary.probe.urls, ['https://page.example.test/.well-known/oauth-protected-resource']);
      if (scenario === 'bad initial readiness') {
        assert.equal(code, 1); assert.equal(summary.row_put_back, true);
        assert.deepEqual(stored, initial); assert.equal(writes, 2);
        assert.equal(states[a].pid, 101); assert.equal(states[b].pid, 0);
        assert.ok(!commands.some(command => command.startsWith('systemctl disable --now')));
      } else {
        const expected = structuredClone(initial);
        expected.runs.units[0].source = next;
        assert.deepEqual(stored, expected); assert.equal(writes, 1);
        assert.equal(states[b].pid, 202); assert.equal(states[a].pid, 0);
        const read = commands.findIndex(cmd => cmd.startsWith('curl --fail'));
        const retire = commands.findIndex(cmd => cmd.startsWith('systemctl disable --now'));
        assert.ok(read >= 0 && retire > read);
        if (scenario === 'lost retirement reply') {
          assert.equal(code, 5); assert.equal(summary.apply_outcome, 'slot_switch_unconfirmed');
          assert.equal(commands.length, retire + 1, 'no follow-up or undo after an unknown effect');
        } else {
          if (['final probe lost', 'bad probe response', 'probe retry', 'missing probe sample'].includes(scenario)) {
            assert.equal(code, 7); assert.equal(summary.apply_exit, 0); assert.equal(summary.probe_outcome, 'evidence_unconfirmed');
            assert.equal(summary.row_put_back, undefined);
          } else {
            assert.equal(code, 0);
            assert.ok(summary.probe.sent >= requestsBeforeWrite + 2, 'the native probe kept asking across the switch and after-apply wait');
          }
          assert.deepEqual([summary.engine_scope.incumbent.blake3, summary.engine_scope.candidate.blake3, summary.engine_scope.candidate.pid], [old.prebuilt.blake3, next.prebuilt.blake3, 202]);
        }
      }
    });
  }
});


test('a scoped request cannot fall through to ordinary start or apply', async () => {
  const noEffects = () => assert.fail('an unsupported scope reached a host or provider');
  await assert.rejects(startAComputer({ scope: { kind: 'engine-slot' } }, { run: noEffects, fetchImpl: noEffects }), /scope is not supported by start/);
  await assert.rejects(applyAComputerRow({ only_unit: 'example-place.service' }, { run: noEffects, fetchImpl: noEffects }), /unknown apply request field/);
});


test('the selected engine keeps the existing source metadata outside its two pins', async () => {
  const base = { ...runs.units[0], source: { ...scopeBuildMetadata, commit: '1'.repeat(40), prebuilt: { blake3: 'a'.repeat(64) } },
    slots: { a: { health_listen: '127.0.0.1:7199' }, b: { health_listen: '127.0.0.1:7198' } } };
  const scope = { kind: 'engine-slot', unit: base.unit, incumbent: { unit: 'example-place-a.service', pid: 101, invocation: 'a'.repeat(32) } };
  const before = { name: 'example-box', address: machine.address, runs: { units: [base] } };
  const patch = { commit: '2'.repeat(40), prebuilt: { blake3: 'b'.repeat(64) } };
  const proposed = structuredClone(before);
  Object.assign(proposed.runs.units[0].source, patch);
  assert.deepEqual(engineScopeForEdit(before, proposed, scope).rollback, base.source);
  assert.deepEqual(proposed.runs.units[0].source, { ...scopeBuildMetadata, ...patch });
  for (const field of Object.keys(scopeBuildMetadata)) {
    const stripped = structuredClone(proposed); delete stripped.runs.units[0].source[field];
    assert.throws(() => engineScopeForEdit(before, stripped, scope), /changes just the selected/);
    const edited = structuredClone(proposed); edited.runs.units[0].source[field] = 'unrelated edit';
    assert.throws(() => engineScopeForEdit(before, edited, scope), /changes just the selected/);
  }
  const missing = structuredClone(before); delete missing.runs.units[0].source.prebuilt;
  assert.throws(() => engineScopeForEdit(missing, proposed, scope), /needs a full commit and BLAKE3 pin/);
  const forged = { ...scope, rollback: { ...base.source, repository: 'https://other.example.test/engine.git' } };
  await assert.rejects(checkScopedEngine({ machine, ssh: machine.ssh, computer_row: proposed, scope: forged }, {
    run: () => assert.fail('the archived owner must check source metadata before contacting the host'),
  }), /cannot change source metadata/);
});


test('an engine probe never infers an engine route from the public root or an unrelated pool', () => {
  const engine = { unit: 'engine.service', settings: { doors: [{ accepts_hosts: ['engine.example.test'] }] }, slots: { a: { health_listen: '127.0.0.1:7101' }, b: { health_listen: '127.0.0.1:7102' } } };
  const site = { site_file: 'single-name-front-door', door_host: 'engine.example.test', engine_routes: ['tools/keep-an-engine-on-a-computer/caddy-route-engine.caddy'], engine_paths: ['/.well-known/oauth-protected-resource'], pools: { engine: { listen: ['127.0.0.1:7102', '127.0.0.1:7101'] } } };
  const front = { unit: 'caddy.service', prepare: 'tools/keep-a-caddy-front-door-on-a-computer/prepare-a-caddy-site.mjs', site };
  const row = { runs: { units: [engine, front] } }, scope = { unit: engine.unit };
  assert.deepEqual(engineProbeOf(row, scope), { url: 'https://engine.example.test/.well-known/oauth-protected-resource', expectedResource: 'https://engine.example.test/mcp' });
  for (const change of [r => { r.runs.units.pop(); }, r => { r.runs.units[1].site.engine_paths = ['/']; }, r => { r.runs.units[1].site.engine_routes = []; }, r => { r.runs.units[1].site.pools.engine.listen.pop(); }, r => { r.runs.units[1].site.door_host = 'wrong.example.test'; }, r => { r.runs.units.push(structuredClone(front)); }]) {
    const other = structuredClone(row); change(other);
    assert.throws(() => engineProbeOf(other, scope), /engine probe/);
  }
});

// Nov 25 2026, 11:04-11:23 AM CST: a row added a new unit beside a changed settings file of a running one; the new unit's check
// exited 77, and the rollback put back the settings file but left the new unit enabled with its files, so it restarted about 55
// times, and the receipt said nothing the row could be put back on. Now the rollback stops and disables what it newly enabled,
// removes what it newly wrote, restarts the unit whose file came back, and says `put_back`.
test('a failed boot check stops and removes what the apply newly made, and its receipt says the computer is put back', async () => {
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  const gateway = { unit: 'example-gateway.socket', user: 'root', check_command: 'gateway-check',
    files: [{ path: '/etc/systemd/system/example-gateway.socket', text: '[Socket]\nListenStream=127.0.0.1:8896\n\n[Install]\nWantedBy=sockets.target\n' },
      { path: '/etc/systemd/system/example-gateway.service', text: '[Service]\nExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:8897\n' }] };
  const grown = { ...runs, units: [{ ...runs.units[0], settings: { listen: '127.0.0.1:7199', readers: [1106] } }, gateway] };
  const base = computer(live);
  const run = async (m, command, input) => {
    if (command === 'gateway-check') { base.commands.push({ command }); throw Object.assign(new Error('restarted 3 times'), { code: 77 }); }
    return base.run(m, command, input);
  };
  const failure = await applyWhatItRuns(machine, grown, run, {}, { wait: async () => {} }).then(() => null, error => error);
  assert.ok(failure, 'the apply fails');
  assert.match(failure.message, /example-gateway\.socket's check_command said trying again cannot pass \(exit 77\)/);
  const commands = base.commands.map(({ command }) => command);
  const failed = commands.indexOf('gateway-check');
  const after = commands.slice(failed + 1);
  assert.ok(after.includes("systemctl disable --now 'example-gateway.socket' >/dev/null 2>&1"), 'the unit it enabled is stopped and disabled');
  assert.ok(after.includes("systemctl stop 'example-gateway.service'"), 'the unit whose file it made is stopped');
  const removal = base.commands.slice(failed + 1).find(({ command }) => command.startsWith('while IFS= read -r p; do rm -f'));
  assert.equal(removal.input, '/etc/systemd/system/example-gateway.socket\n/etc/systemd/system/example-gateway.service\n');
  assert.ok(after.indexOf("systemctl disable --now 'example-gateway.socket' >/dev/null 2>&1") < after.indexOf('while IFS= read -r p; do rm -f -- "$p"; done'), 'stopped before its file goes');
  assert.ok(after.includes('systemctl daemon-reload') && after.includes("systemctl restart 'example-place.service'"), 'the unit whose settings came back restarts on them');
  assert.deepEqual(failure.rolled_back, { restored: ['/etc/example-place/computer.json'], restarted: ['example-place.service'],
    removed: ['/etc/systemd/system/example-gateway.socket', '/etc/systemd/system/example-gateway.service'], stopped: ['example-gateway.socket', 'example-gateway.service'] });
  assert.equal(failure.machine_touched, true);
  const receipt = computerRowApplyFailure(failure, { ordinary: true });
  assert.equal(receipt.put_back, true);
  assert.equal(receipt.apply_not_started, undefined);
  assert.deepEqual(receipt.rolled_back, failure.rolled_back);
});

test('a rollback that could not do a step, or an apply that removed what a rollback cannot bring back, is not put back', async () => {
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  const grown = { ...runs, units: [{ ...runs.units[0], check_command: 'place-check', settings: { listen: '127.0.0.1:7199', readers: [1106] } }] };
  const base = computer(live);
  const run = async (m, command, input) => {
    if (command === 'place-check') throw Object.assign(new Error('no'), { code: 77 });
    if (command.startsWith('mv -f ') && command.includes('.bak-')) throw Object.assign(new Error('read-only file system'), { code: 1 });
    return base.run(m, command, input);
  };
  const failure = await applyWhatItRuns(machine, grown, run, {}, { wait: async () => {} }).then(() => null, error => error);
  assert.ok(failure.rolled_back.failed.length >= 1);
  assert.equal(failure.put_back, false);
  assert.equal(computerRowApplyFailure(failure, { ordinary: true }).put_back, undefined);
});

// Nov 25 2026, 11:15 AM CST: the corrected request added a unit the row already held, and the apply refused while rendering (two
// units render different text at one path) before it touched the computer; the receipt said nothing, so the row kept both copies.
test('a refusal before set-up changes nothing on the computer, and its receipt says the apply did not start', async () => {
  const twice = { ...runs, units: [runs.units[0], { ...runs.units[0], settings: { listen: '127.0.0.1:7200' } }] };
  const { run, commands } = computer({});
  const failure = await applyWhatItRuns(machine, twice, run).then(() => null, error => error);
  assert.match(failure.message, /two units render different text at \/etc\/example-place\/computer\.json/);
  assert.equal(failure.machine_touched, false);
  assert.ok(!commands.some(({ command }) => /^(sh -s|install |cp |mv |rm |systemctl (?:restart|enable|disable|stop|start))/.test(command)), 'nothing was changed');
  assert.deepEqual(computerRowApplyFailure(failure, { ordinary: true }), { apply_not_started: true, error: failure.message, row_apply_protocol: computerRowApplyReceipt({}).row_apply_protocol });
  assert.equal(computerRowApplyFailure(failure), undefined, 'a scoped engine apply keeps its own receipts');
  // A failure once set-up has begun is not one.
  const late = await applyWhatItRuns(machine, runs, async (m, command, input) => { if (command.startsWith('sh -s')) throw Object.assign(new Error('set-up failed'), { code: 1 }); return run(m, command, input); }).then(() => null, error => error);
  assert.equal(late.machine_touched, true);
  assert.equal(computerRowApplyFailure(late, { ordinary: true }), undefined);
});
