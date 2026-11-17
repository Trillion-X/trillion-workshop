// tools/start-a-computer/test/apply-what-a-computer-runs.test.mjs
//
// Applying what a computer's row says it runs to a computer that matches it (nothing written, nothing restarted) and to a fresh one
// (set up, then every file the row renders written, and its units started).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWhatItRuns, runsDifferences, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';

const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };
const runs = {
  caddy: { site_hosts: ['place.example.test'], port: 7199 },
  units: [{
    unit: 'example-place.service', template: 'serve-computer', description: 'Example place', user: 'example-place',
    state: '/var/lib/example-place', builds: '/var/lib/example-place/builds', program: 'example-engine',
    settings_file: '/etc/example-place/computer.json', settings: { listen: '127.0.0.1:7199' }, writable: '/var/lib/example-place',
    drop_ins: ['nofile'],
  }],
  unmanaged: [],
};

// A computer that runs its row as rendered (`live`), or nothing yet (`live` empty). `commands` records every command.
const computer = live => {
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input });
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    if (command.includes('curl')) return '200';
    if (command.startsWith('if [ -d ')) return '';
    if (command.startsWith('getent')) { if (Object.keys(live).length === 0) throw Object.assign(new Error('no such account'), { code: 3 }); return ''; }
    if (command.startsWith('test -e')) return '';
    return '';
  };
  return { run, commands };
};

test('a computer that already runs its row gets nothing written, no set-up, and nothing restarted', async () => {
  const live = Object.fromEntries(renderWhatItRuns(runs, SITE_BLOCK).map(({ path, text }) => [path, text]));
  const { run, commands } = computer(live);
  assert.deepEqual(await applyWhatItRuns(machine, runs, run), { written: [], restarted: [] });
  assert.equal(commands.filter(({ command }) => /^(sh -s|install |cp |systemctl |caddy )/.test(command)).length, 0);
});

test('a fresh computer is set up from the row, then gets every file the row renders, and its unit started', async () => {
  const { run, commands } = computer({});
  const { written, restarted } = await applyWhatItRuns(machine, runs, run);
  const rendered = renderWhatItRuns(runs, SITE_BLOCK).map(({ path }) => path);
  assert.deepEqual(written, rendered);
  assert.deepEqual(restarted, ['example-place.service']);
  const setUp = commands.findIndex(({ command }) => command.startsWith('sh -s'));
  const firstWrite = commands.findIndex(({ command }) => command.startsWith('install -m 0644') || command.startsWith('install -d -m 0755'));
  assert.ok(setUp >= 0 && setUp < firstWrite, 'set-up runs before anything is written');
  assert.match(commands[setUp].command, /^sh -s -- '\{"caddy"/);
  const caddy = commands.find(({ command }) => command.includes('caddy validate'));
  assert.ok(caddy, 'the Caddy file is validated before it replaces the live one');
  assert.ok(commands.some(({ command }) => command === 'systemctl daemon-reload'));
  assert.ok(commands.some(({ command }) => command.includes('systemctl enable') && command.includes('example-place.service')));
  assert.ok(commands.some(({ command }) => command === 'systemctl reload caddy'));
});

test('a file that differs keeps its previous bytes beside it, and only that file is written', async () => {
  const rendered = renderWhatItRuns(runs, SITE_BLOCK);
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
  const live = Object.fromEntries(renderWhatItRuns(built, SITE_BLOCK).map(({ path, text }) => [path, text]));
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

test('a private repository is fetched with the key the vault holds under its credential name, sent only on standard input', async () => {
  const live = Object.fromEntries(renderWhatItRuns(keyed, SITE_BLOCK).map(({ path, text }) => [path, text]));
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

// A front door (caddy.front_door): its pinned Caddy is fetched by set-up when the machine lacks it, its site file is
// validated by that Caddy with the shared storage's environment, and Caddy restarts because its drop-in swaps the program.
test('a front door gets its pinned Caddy, is validated by it and restarts Caddy instead of only reloading it', async () => {
  const door = { ...runs, caddy: { ...runs.caddy, front_door: {
    storage_server_cert: '/etc/caddy/storage-server.crt', storage_env: '/etc/caddy/storage.env', ask_port: 9444,
    ask_path: '/origins/certificate', door_upstream: 'https://192.0.2.10:443', door_host: 'app.example.test',
    door_server_name: '{http.request.host}', door_hosts: ['app.example.test'],
    binary: '/opt/example/caddy',
    binary_files: { x86_64: { url: 'https://downloads.example.test/caddy-linux-amd64', sha256: 'e'.repeat(64) }, aarch64: { url: 'https://downloads.example.test/caddy-linux-arm64', sha256: 'f'.repeat(64) } } } } };
  const rendered = renderWhatItRuns(door, SITE_BLOCK);
  const live = Object.fromEntries(rendered.filter(({ path }) => !path.includes('caddy')).map(({ path, text }) => [path, text]));
  const base = computer(live);
  const run = async (machine_, command, input) => {
    if (command === 'uname -m') { base.commands.push({ command }); return 'x86_64\n'; }
    if (command.includes('sha256sum -c --status || exit 3')) { base.commands.push({ command }); throw Object.assign(new Error('not pinned'), { code: 3 }); }
    return base.run(machine_, command, input);
  };
  const { written, restarted } = await applyWhatItRuns(machine, door, run);
  assert.deepEqual(written, ['/etc/caddy/Caddyfile', '/etc/systemd/system/caddy.service.d/front-door.conf']);
  assert.deepEqual(restarted, ['caddy.service']);
  const setUp = base.commands.find(({ command }) => command.startsWith('sh -s'));
  assert.match(setUp.command, / '\/opt\/example\/caddy https:\/\/downloads\.example\.test\/caddy-linux-amd64 e{64}'$/);
  assert.ok(base.commands.some(({ command }) => command.startsWith("set -a && . '/etc/caddy/storage.env' && set +a && '/opt/example/caddy' validate")));
  assert.ok(base.commands.some(({ command }) => command === "systemctl restart 'caddy.service'"));
  assert.ok(!base.commands.some(({ command }) => command === 'systemctl reload caddy'), 'a restart already loads the new site file');
});

test('a front door whose row gives no address for the pinned Caddy is refused before anything is written', async () => {
  const door = { ...runs, caddy: { ...runs.caddy, front_door: {
    storage_server_cert: '/etc/caddy/storage-server.crt', storage_env: '/etc/caddy/storage.env', ask_port: 9444,
    ask_path: '/origins/certificate', door_upstream: 'https://192.0.2.10:443', door_host: 'app.example.test',
    door_server_name: '{http.request.host}', door_hosts: ['app.example.test'], binary: '/opt/example/caddy' } } };
  const base = computer({});
  const run = async (machine_, command, input) => (command === 'uname -m' ? 'x86_64\n' : base.run(machine_, command, input));
  await assert.rejects(applyWhatItRuns(machine, door, run), /gives no binary_files for x86_64/);
});

test('a unit\'s health row may name the Host its boot check asks for', async () => {
  const health = { path: '/.well-known/oauth-protected-resource/mcp', status: 200, host: 'place.example.test' };
  const withHost = { ...runs, units: [{ ...runs.units[0], health, health_listen: '127.0.0.1:9445' }] };
  const live = Object.fromEntries(renderWhatItRuns(runs, SITE_BLOCK).map(({ path, text }) => [path, text]));
  live['/etc/systemd/system/example-place.service'] = 'an older unit\n';
  const { run, commands } = computer(live);
  const { restarted } = await applyWhatItRuns(machine, withHost, run);
  assert.deepEqual(restarted, ['example-place.service']);
  assert.ok(commands.some(({ command }) => command.includes("curl") && command.includes("-H 'Host: place.example.test' 'http://127.0.0.1:9445/.well-known/oauth-protected-resource/mcp'")));
});

test('a user the row says is absent is a difference while the computer has it, and the apply removes it and reloads ssh for a removed drop-in', async () => {
  const gone = { caddy: { site_hosts: ['place.example.test'], port: 7199 }, units: [], unmanaged: [], absent: ['/etc/ssh/sshd_config.d/old-tunnel.conf'], absent_users: ['old-tunnel'] };
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
  const live = Object.fromEntries(renderWhatItRuns(data, SITE_BLOCK).map(({ path, text }) => [path, text]));
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
  const server = { unit: 'example-database.service', template: 'serve-postgres', description: 'Example database', user: 'postgres', state: '/var/lib/postgresql',
    data_dir: '/var/lib/postgresql/18/example', program_bin: '/usr/lib/postgresql/18/bin', settings_file: '/etc/example-database/postgresql.conf',
    settings_lines: [], environment: ['PGDATA=/var/lib/postgresql/18/example'], writable: '/var/lib/postgresql', check_command: 'pg_isready -q',
    secret_name: 'store', secret_vault_key: 'example-store', secret_file: '/etc/credstore.encrypted/example-database', hba_file: '/etc/example-database/pg_hba.conf',
    reach: [{ for: 'tool:run-sql-in-my-database', listen: '127.0.0.1', hba: [{ type: 'host', database: 'p_example', user: 'all', address: '127.0.0.1/32', method: 'scram-sha-256' }] }] };
  const role = name => ({ unit: `${name}.service`, template: 'run-a-script', description: name, user: 'postgres', state: '/var/lib/postgresql',
    after: 'example-database.service', script: 'set-up-postgres-role', script_file: '/usr/local/lib/example-database/set-up-postgres-role.sh',
    environment: ['SECRET_NAME=role'], program_bin: '/usr/lib/postgresql/18/bin', writable: '/var/lib/postgresql',
    secret_name: 'role', secret_vault_key: `${name}-connection`, secret_file: `/etc/credstore.encrypted/${name}`, check_command: `true ${name}` });
  const row = { caddy: runs.caddy, unmanaged: [], units: [server, role('example-owner'), role('example-share')] };
  const { withReach } = await import('../do-work/render-what-a-computer-runs.mjs');
  const live = Object.fromEntries(renderWhatItRuns(withReach(row), SITE_BLOCK).map(({ path, text }) => [path, text]));
  live['/etc/example-database/pg_hba.conf'] = 'host all all 0.0.0.0/0 trust\n';
  live['/usr/local/lib/example-database/set-up-postgres-role.sh'] = '# an older script\n';
  const { run, commands } = computer(live);
  const answer = await applyWhatItRuns(machine, row, async (m, command, input) => (command.startsWith('test -s ') ? '' : run(m, command, input)), {}, { wait: async () => {} });
  assert.deepEqual(answer.written, ['/etc/example-database/pg_hba.conf', '/usr/local/lib/example-database/set-up-postgres-role.sh']);
  assert.deepEqual(answer.restarted, ['example-database.service', 'example-owner.service', 'example-share.service']);
  assert.ok(commands.some(({ command }) => command === "systemctl restart 'example-database.service'"), 'the server that reads the access file restarts');
});
