// tools/start-a-computer/test/apply-what-a-computer-runs.test.mjs
//
// Applying what a computer's row says it runs to a computer that matches it (nothing written, nothing restarted) and to a fresh one
// (set up, then every file the row renders written, and its units started).
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyARow } from '../do-work/apply-a-computer-row.mjs';
import { applyAComputerRow, applyWhatItRuns, computerRowApplyExit, computerRowApplyFailure, computerRowApplyReceipt, readRequest, runsDifferences } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';

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

test('a file that differs keeps its previous bytes beside it, and only that file is written', async () => {
  const rendered = renderWhatItRuns(runs);
  const live = Object.fromEntries(rendered.map(({ path, text }) => [path, text]));
  live['/etc/systemd/system/example-place.service'] = 'an older unit\n';
  const { run, commands } = computer(live);
  const { written, restarted } = await applyWhatItRuns(machine, runs, run);
  assert.deepEqual(written, ['/etc/systemd/system/example-place.service']);
  assert.deepEqual(restarted, ['example-place.service']);
  assert.ok(commands.some(({ command }) => /^cp -p '\/etc\/systemd\/system\/example-place\.service' '\/etc\/systemd\/system\/example-place\.service\.bak-/.test(command)));
  assert.equal(commands.filter(({ command }) => command.startsWith('sh -s')).length, 0, 'an existing account is not set up again');
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
  assert.match(write.command, /install -m 0644 -o root -g root \/dev\/stdin '\/etc\/example-greeter\/site\.conf\.new' && 'example-check' '--file' '\/etc\/example-greeter\/site\.conf\.new' >\/dev\/null && mv '\/etc\/example-greeter\/site\.conf\.new' '\/etc\/example-greeter\/site\.conf'$/);
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
test('a changed access file restarts its server, and a changed script reruns each job naming it', async () => {
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
  assert.deepEqual(answer.restarted, ['example-database.service', 'example-owner.service', 'example-share.service']);
  assert.ok(commands.some(({ command }) => command === "systemctl restart 'example-database.service'"), 'the server that reads the access file restarts');
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
const slotComputer = ({ active, links, answers = {}, memory = { available: 4096 * MiB, current: 1260 * MiB } }) => {
  const live = Object.fromEntries(renderWhatItRuns(slotted).map(({ path, text }) => [path, text]));
  const base = computer(live);
  const run = async (m, command, input) => {
    const activeAsked = command.match(/^systemctl is-active --quiet '([^']+)'/);
    if (activeAsked) { base.commands.push({ command }); if (active.includes(activeAsked[1])) return ''; throw Object.assign(new Error('inactive'), { code: 3 }); }
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
