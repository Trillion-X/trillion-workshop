// tools/keep-a-postgres-database-on-a-computer/test/a-database-unit.test.mjs
//
// PostgreSQL on a computer, rendered by start-a-computer from a row that names this folder's files: the server unit, its
// scripts and timers, and its `reach` made into the listen line, the access file and the ports by this folder's
// own prepare-a-database-unit.mjs (moved from start-a-computer's render test, Nov 18 2026, K2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWhatItRuns, withPrepared } from '../../start-a-computer/do-work/render-what-a-computer-runs.mjs';

const MODULE = 'tools/keep-a-postgres-database-on-a-computer/prepare-a-database-unit.mjs';
/** A row whose units are handed to this folder's prepare first, as a computer row names it. */
const prepared = row => ({ ...row, units: row.units.map(unit => ({ ...unit, prepare: MODULE })) });

// A computer that runs a database server: its settings file of lines, its backup, restore test and role scripts, and the
// timers that run them, all from the row.
const database = {
  units: [{
    unit: 'example-database.service', template: 'tools/keep-a-postgres-database-on-a-computer/serve-postgres.service', description: 'Example database', user: 'postgres',
    state: '/var/lib/postgresql', data_dir: '/var/lib/postgresql/18/example', program_bin: '/usr/lib/postgresql/18/bin',
    settings_file: '/etc/example-database/postgresql.conf', settings_lines: ["listen_addresses = '127.0.0.1'", "archive_command = 'wal-g wal-push %p'"],
    environment: ['PGDATA=/var/lib/postgresql/18/example', 'WALG_S3_PREFIX=s3://example-bucket/postgres'], writable: '/var/lib/postgresql',
    secret_name: 'example-store', secret_file: '/etc/credstore.encrypted/example-database', secret_vault_key: 'example-store-env',
    check_command: 'pg_isready -q',
  }, {
    unit: 'example-database-backup.service', template: 'tools/start-a-computer/read-data/unit-templates/run-a-script.service', description: 'Example database backup', user: 'postgres',
    state: '/var/lib/postgresql', after: 'example-database.service', script: 'tools/keep-a-postgres-database-on-a-computer/scripts/back-up-postgres.sh', script_file: '/usr/local/lib/example-database/back-up.sh',
    program_bin: '/usr/lib/postgresql/18/bin', environment: ['PGDATA=/var/lib/postgresql/18/example', 'SECRET_NAME=example-store'], writable: '/var/lib/postgresql',
    secret_name: 'example-store', secret_file: '/etc/credstore.encrypted/example-database-backup', secret_vault_key: 'example-store-env',
  }, {
    unit: 'example-database-backup.timer', template: 'tools/start-a-computer/read-data/unit-templates/run-on-a-timer.timer', description: 'Example database backup, daily', user: 'postgres',
    state: '/var/lib/postgresql', runs: 'example-database-backup.service', on_calendar: 'daily',
  }],
};

test('a database unit, a script unit and a timer render from their fields, and the script and settings lines are written', async () => {
  const files = renderWhatItRuns(database);
  const text = path => files.find(file => file.path === path)?.text;
  for (const { path, text: body } of files) if (path.startsWith('/etc/systemd/system/')) assert.doesNotMatch(body, /\{[a-z_]+\}/, path);
  const server = text('/etc/systemd/system/example-database.service');
  assert.match(server, /^LoadCredentialEncrypted=example-store:\/etc\/credstore\.encrypted\/example-database$/m);
  assert.match(server, /^Environment=PGDATA=\/var\/lib\/postgresql\/18\/example WALG_S3_PREFIX=s3:\/\/example-bucket\/postgres$/m);
  assert.match(server, /exec postgres -D \/var\/lib\/postgresql\/18\/example -c config_file=\/etc\/example-database\/postgresql\.conf'$/m);
  assert.equal(text('/etc/example-database/postgresql.conf'), "listen_addresses = '127.0.0.1'\narchive_command = 'wal-g wal-push %p'\n");
  const job = text('/etc/systemd/system/example-database-backup.service');
  assert.match(job, /^Type=oneshot$/m);
  assert.match(job, /^After=network-online\.target example-database\.service$/m);
  assert.match(job, /^ExecStart=\/bin\/sh \/usr\/local\/lib\/example-database\/back-up\.sh$/m);
  assert.match(text('/usr/local/lib/example-database/back-up.sh'), /^wal-g backup-push "\$PGDATA"$/m);
  const timer = text('/etc/systemd/system/example-database-backup.timer');
  assert.match(timer, /^OnCalendar=daily$/m);
  assert.match(timer, /^Unit=example-database-backup\.service$/m);
});

// A database server that reads the front door's certificate: each file it names in files_read_at_start is copied into its
// credentials folder at start, and a path unit restarts it when the certificate is replaced.
test('files read at start render as LoadCredential lines, and a watched file restarts the unit that reads it', async () => {
  const server = { ...database.units[0], files_read_at_start: [{ name: 'tls.crt', file: '/var/lib/example-door/example.test.crt' }, { name: 'tls.key', file: '/var/lib/example-door/example.test.key' }] };
  const watch = { unit: 'example-certificate.path', template: 'tools/start-a-computer/read-data/unit-templates/watch-a-file.path', description: 'Example certificate', user: 'root', watch: '/var/lib/example-door/example.test.crt', runs: 'example-certificate.service' };
  const restart = { unit: 'example-certificate.service', template: 'tools/start-a-computer/read-data/unit-templates/restart-a-unit.service', description: 'Example database reads its new certificate', user: 'root', restarts: 'example-database.service' };
  const files = renderWhatItRuns({ ...database, units: [server, watch, restart] });
  const text = path => files.find(file => file.path === path)?.text;
  for (const { path, text: body } of files) if (path.startsWith('/etc/systemd/system/')) assert.doesNotMatch(body, /\{[a-z_]+\}/, path);
  const unit = text('/etc/systemd/system/example-database.service');
  assert.match(unit, /^LoadCredentialEncrypted=example-store:\/etc\/credstore\.encrypted\/example-database\nLoadCredential=tls\.crt:\/var\/lib\/example-door\/example\.test\.crt\nLoadCredential=tls\.key:\/var\/lib\/example-door\/example\.test\.key$/m);
  assert.match(text('/etc/systemd/system/example-certificate.path'), /^PathChanged=\/var\/lib\/example-door\/example\.test\.crt\nUnit=example-certificate\.service$/m);
  assert.match(text('/etc/systemd/system/example-certificate.service'), /^ExecStart=\/bin\/systemctl try-restart example-database\.service$/m);
  assert.doesNotMatch(renderWhatItRuns(database).find(file => file.path === '/etc/systemd/system/example-database.service').text, /^LoadCredential=/m, 'a server that names none loads none');
  assert.throws(() => renderWhatItRuns({ ...database, units: [{ ...server, files_read_at_start: [{ name: 'tls.key', file: 'relative/key' }] }] }), /files_read_at_start need a name and an absolute file/);
});

// A database unit's reach: the listen line and an access file holding only its entries' rows, and the ports an
// entry opens.
const reachServer = { ...database.units[0], settings_lines: ["unix_socket_directories = '/run/postgresql'"] };
const reach = [
  { for: 'the computer\'s own jobs', hba: [{ type: 'local', database: 'all', user: 'all', method: 'peer' }] },
  { for: 'tool:run-sql-in-my-database', listen: '127.0.0.1', credential: 'example-connection', hba: [{ type: 'host', database: 'p_example', user: 'all', address: '127.0.0.1/32', method: 'scram-sha-256' }] },
];
const reachRow = { units: [reachServer] };

test('a database unit without reach renders only its own settings lines and no access file', async () => {
  const expanded = await withPrepared(prepared(reachRow));
  assert.deepEqual(expanded.units, [reachServer]);
  assert.ok(!renderWhatItRuns(expanded).some(file => file.path.endsWith('pg_hba.conf')));
});

test('reach renders the listen line and an access file holding only what its entries say', async () => {
  const files = renderWhatItRuns(await withPrepared(prepared({ ...reachRow, units: [{ ...reachServer, reach, hba_file: '/etc/example-database/pg_hba.conf' }] })));
  const text = path => files.find(file => file.path === path)?.text;
  assert.equal(text('/etc/example-database/postgresql.conf'), "unix_socket_directories = '/run/postgresql'\nlisten_addresses = '127.0.0.1'\nhba_file = '/etc/example-database/pg_hba.conf'\n");
  assert.equal(text('/etc/example-database/pg_hba.conf'), 'local all all peer\nhost p_example all 127.0.0.1/32 scram-sha-256\n');
  // The access file is applied by a reload, never a restart: it names its own `then` (start-a-computer restarts nothing for it).
  const hbaFile = (await withPrepared(prepared({ ...reachRow, units: [{ ...reachServer, reach, hba_file: '/etc/example-database/pg_hba.conf' }] }))).units[0].files.find(file => file.path === '/etc/example-database/pg_hba.conf');
  assert.deepEqual(hbaFile.then, [['systemctl', 'try-reload-or-restart', reachServer.unit]]);
  const none = renderWhatItRuns(await withPrepared(prepared({ ...reachRow, units: [{ ...reachServer, reach: [], hba_file: '/etc/example-database/pg_hba.conf' }] })));
  assert.equal(none.find(file => file.path === '/etc/example-database/pg_hba.conf').text, '', 'no entry, nobody connects');
  assert.match(none.find(file => file.path === '/etc/example-database/postgresql.conf').text, /^listen_addresses = ''$/m, 'no entry listens, no network listener');
});

test('a reach entry that opens a port adds it to the firewall, and is refused where another program keeps the firewall', async () => {
  const opened = { for: 'an AI that opens TCP', listen: '0.0.0.0', firewall_allow: ['5432/tcp'], hba: [{ type: 'hostssl', database: 'p_example', user: 'p_example_share', address: '0.0.0.0/0', method: 'scram-sha-256' }] };
  const expanded = await withPrepared(prepared({ ...reachRow, units: [{ ...reachServer, reach: [opened], hba_file: '/etc/example-database/pg_hba.conf' }], machine: { firewall_allow: ['22/tcp'] } }));
  assert.deepEqual(expanded.machine.firewall_allow, ['22/tcp', '5432/tcp']);
  await assert.rejects(withPrepared(prepared({ ...reachRow, units: [{ ...reachServer, reach: [opened], hba_file: '/etc/example-database/pg_hba.conf' }], machine: { firewall_allow: null } })), /firewall is kept by another program/);
});

test('reach refuses a missing access file, a typed listen line and a word that would add a line', async () => {
  await assert.rejects(withPrepared(prepared({ ...reachRow, units: [{ ...reachServer, reach }] })), /needs hba_file/);
  await assert.rejects(withPrepared(prepared({ ...reachRow, units: [{ ...reachServer, reach, hba_file: '/etc/x', settings_lines: ["listen_addresses = '*'"] }] })), /must not set listen_addresses/);
  await assert.rejects(withPrepared(prepared({ ...reachRow, units: [{ ...reachServer, reach: [{ hba: [{ type: 'host', database: 'all\nhost', user: 'all', address: '0.0.0.0/0', method: 'trust' }] }], hba_file: '/etc/x' }] })), /each one word/);
});

test('a unit that names a script that does not exist is refused', async () => {
  const [server, job] = database.units;
  assert.throws(() => renderWhatItRuns({ ...database, units: [server, { ...job, script: 'tools/nope/nope.sh' }] }), /script names a file that does not exist: tools\/nope\/nope\.sh/);
});

test('every script this folder keeps is valid shell', async () => {
  const { readdirSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const folder = new URL('../scripts/', import.meta.url);
  const names = readdirSync(folder).filter(name => name.endsWith('.sh'));
  assert.ok(names.length >= 3);
  for (const name of names) assert.equal(spawnSync('sh', ['-n', new URL(name, folder).pathname]).status, 0, name);
});
