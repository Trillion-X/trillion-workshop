// tools/start-a-computer/test/render-what-a-computer-runs.test.mjs
//
// The renderer of what a computer runs, on a synthetic computer: its files, its refusals and the comparison with what a computer runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { differences, renderWhatItRuns, withReach } from '../do-work/render-what-a-computer-runs.mjs';

const SITE_BLOCK = '{SITE} {\n\thandle {\n\t\treverse_proxy 127.0.0.1:{PORT}\n\t}\n}';
const runs = {
  caddy: { site_hosts: ['place.example.test', 'www.example.test'], port: 7199 },
  units: [{
    unit: 'example-place.service', template: 'serve-computer', description: 'Example place', user: 'example-place',
    releases: '/opt/example/releases', engine_file: 'example-engine', data_env: 'EXAMPLE_DATA_ROOT', data_dir: 'product',
    config: '/var/lib/example-place/place.json', launch_setting: 'EXAMPLE_SETTINGS',
    product_settings: '/var/lib/example-place/product-settings.json', writable: '/var/lib/example-place /opt/example/releases',
    drop_ins: ['nofile', 'product-settings'],
  }],
};

test('renders the Caddy site file once per name, with the port', () => {
  const [caddy] = renderWhatItRuns(runs, SITE_BLOCK);
  assert.equal(caddy.path, '/etc/caddy/Caddyfile');
  const block = host => `${SITE_BLOCK.replace('{SITE}', host).replace('{PORT}', '7199')}\n`;
  assert.equal(caddy.text, block('place.example.test') + block('www.example.test'));
});

test('renders the unit and its drop-ins from the template fields', () => {
  const files = renderWhatItRuns(runs, SITE_BLOCK);
  const unit = files.find(file => file.path === '/etc/systemd/system/example-place.service').text;
  assert.match(unit, /^Environment=EXAMPLE_SETTINGS=\/var\/lib\/example-place\/product-settings\.json$/m);
  assert.match(unit, /^ExecStart=\/bin\/sh -c 'R=\$\(readlink -f \/opt\/example\/releases\/current\) && exec env EXAMPLE_DATA_ROOT="\$R\/product" "\$R\/example-engine" serve \/var\/lib\/example-place\/place\.json'$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/example-place \/opt\/example\/releases$/m);
  assert.doesNotMatch(unit, /\{[a-z_]+\}/);
  const dropIns = files.filter(file => file.path.startsWith('/etc/systemd/system/example-place.service.d/')).map(file => file.path);
  assert.deepEqual(dropIns, ['/etc/systemd/system/example-place.service.d/nofile.conf', '/etc/systemd/system/example-place.service.d/product-settings.conf']);
});

test('refuses a template field the row does not give', () => {
  const { config, ...withoutConfig } = runs.units[0];
  assert.throws(() => renderWhatItRuns({ ...runs, units: [withoutConfig] }, SITE_BLOCK), /needs config/);
});

test('refuses an unknown template or drop-in name', () => {
  assert.throws(() => renderWhatItRuns({ ...runs, units: [{ ...runs.units[0], template: 'nope' }] }, SITE_BLOCK), /unknown template/);
  assert.throws(() => renderWhatItRuns({ ...runs, units: [{ ...runs.units[0], drop_ins: ['nope'] }] }, SITE_BLOCK), /unknown drop-in/);
});

test('differences name a missing file and a changed file, and match when equal', () => {
  const rendered = renderWhatItRuns(runs, SITE_BLOCK);
  const live = Object.fromEntries(rendered.map(({ path, text }) => [path, text]));
  assert.deepEqual(differences(rendered, live), []);
  live['/etc/caddy/Caddyfile'] = 'changed';
  delete live['/etc/systemd/system/example-place.service'];
  assert.deepEqual(differences(rendered, live), [
    { path: '/etc/caddy/Caddyfile', reason: 'differs from the computer row' },
    { path: '/etc/systemd/system/example-place.service', reason: 'missing on the computer' },
  ]);
});

// A computer whose runs row names the better-auth unit and route serves sign-in: the unit runs official Better Auth from
// the Workshop tool folder with its settings from the row, the secret by vault key only, and Caddy sends the auth paths to it.
const withSignIn = {
  caddy: { ...runs.caddy, routes: ['better-auth', 'better-auth-discovery'], auth_port: 7201 },
  units: [...runs.units, {
    unit: 'example-sign-in.service', template: 'serve-better-auth', description: 'Example sign-in', user: 'example-sign-in',
    workshop: '/var/lib/example-sign-in/trillion-workshop', repository: 'https://github.com/Trillion-X/trillion-workshop.git',
    tool_folder: 'tools/better-auth-official', node_bin: '/opt/node/bin', settings_file: '/var/lib/example-sign-in/settings.json',
    settings: { port: 7201, base_url: 'https://place.example.test', issuer: 'https://place.example.test', store: { credential: 'sign-in-store', env: 'BETTER_AUTH_STORE_CONNECTION' } },
    secret_vault_key: 'example-better-auth-secret', secret_name: 'better-auth-secret', secret_file: '/etc/example-sign-in/better-auth-secret',
    credentials: [
      { vault_key: 'example-store', name: 'sign-in-store', file: '/etc/credstore.encrypted/sign-in-store', env: 'BETTER_AUTH_STORE_CONNECTION' },
      { vault_key: 'example-sender-key', name: 'example-sender-key', file: '/etc/credstore.encrypted/example-sender-key' },
    ],
    writable: '/var/lib/example-sign-in',
  }],
};

test('a row that names the better-auth unit renders it, its settings file and the Caddy routes to it', () => {
  const files = renderWhatItRuns(withSignIn, SITE_BLOCK);
  const unit = files.find(file => file.path === '/etc/systemd/system/example-sign-in.service').text;
  assert.doesNotMatch(unit, /\{[a-z_]+\}/);
  assert.match(unit, /^LoadCredentialEncrypted=better-auth-secret:\/etc\/example-sign-in\/better-auth-secret$/m);
  assert.match(unit, /^# BETTER_AUTH_SECRET is the value held under the vault name example-better-auth-secret:/m);
  assert.match(unit, /^Environment=BETTER_AUTH_SETTINGS=\/var\/lib\/example-sign-in\/settings\.json$/m);
  assert.match(unit, /^ExecStartPre=\/bin\/sh -c 'cd \/var\/lib\/example-sign-in\/trillion-workshop\/tools\/better-auth-official && npm ci --omit=dev --no-audit --no-fund'$/m);
  assert.match(unit, /exec node server\.mjs'$/m);
  assert.match(unit, /^LoadCredentialEncrypted=sign-in-store:\/etc\/credstore\.encrypted\/sign-in-store$/m);
  assert.match(unit, /^LoadCredentialEncrypted=example-sender-key:\/etc\/credstore\.encrypted\/example-sender-key$/m);
  assert.match(unit, / BETTER_AUTH_STORE_CONNECTION="\$\(cat "\$CREDENTIALS_DIRECTORY\/sign-in-store"\)" && export BETTER_AUTH_STORE_CONNECTION && exec node/, 'a credential that names an env is handed in it');
  assert.doesNotMatch(unit, /example-sender-key"\)/, 'a credential with no env is read by the server from its credentials folder');
  const settings = files.find(file => file.path === '/var/lib/example-sign-in/settings.json');
  assert.deepEqual(JSON.parse(settings.text), withSignIn.units[1].settings);
  const [caddy] = files;
  for (const host of withSignIn.caddy.site_hosts) {
    const block = caddy.text.slice(caddy.text.indexOf(`${host} {`));
    assert.match(block, /^\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:7201\n\t\}$/m);
    assert.match(block, /^\thandle \/\.well-known\/oauth-authorization-server\* \{\n\t\treverse_proxy 127\.0\.0\.1:7201\n\t\}$/m);
    assert.ok(block.indexOf('handle /api/auth/*') < block.indexOf('reverse_proxy 127.0.0.1:7199'), 'the auth routes sit inside the block, before the catch-all');
  }
});

test('a row without the route renders no auth routes; an unknown route or a route field the row omits is refused', () => {
  assert.doesNotMatch(renderWhatItRuns(runs, SITE_BLOCK)[0].text, /api\/auth/);
  assert.throws(() => renderWhatItRuns({ ...withSignIn, caddy: { ...withSignIn.caddy, routes: ['nope'] } }, SITE_BLOCK), /unknown route nope/);
  const { auth_port, ...noPort } = withSignIn.caddy;
  assert.throws(() => renderWhatItRuns({ ...withSignIn, caddy: noPort }, SITE_BLOCK), /caddy route better-auth needs auth_port/);
  const { secret_file, ...noSecret } = withSignIn.units[1];
  assert.throws(() => renderWhatItRuns({ ...withSignIn, units: [runs.units[0], noSecret] }, SITE_BLOCK), /needs secret_file/);
  const { settings_file, ...noSettingsFile } = withSignIn.units[1];
  assert.throws(() => renderWhatItRuns({ ...withSignIn, units: [runs.units[0], noSettingsFile] }, SITE_BLOCK), /needs settings_file/);
});

// A front door: shared certificate storage, an on-demand ask that only the door's own answer can make true, the row's
// own sites unchanged, and every other name carried to the door with its own Host and TLS name.
test('a front door renders its storage, its ask, its own sites, its door hosts and the on-demand catch-all', () => {
  const door = { storage_server_cert: '/etc/caddy/storage-server.crt', storage_env: '/etc/caddy/storage.env', ask_port: 9444,
    ask_path: '/origins/certificate', door_upstream: 'https://192.0.2.10:443', door_host: 'app.example.test',
    door_server_name: '{http.request.host}', door_hosts: ['app.example.test'], binary: '/opt/example/caddy' };
  const files = renderWhatItRuns({ ...runs, caddy: { ...runs.caddy, front_door: door } }, SITE_BLOCK);
  const caddy = files[0].text;
  assert.match(caddy, /^\{\n\tadmin localhost:2019\n\tstorage redis \{/);
  assert.match(caddy, /\tpassword \{\$CADDY_STORAGE_PASSWORD\}\n/, 'the storage password is read from the environment, never written here');
  assert.match(caddy, /\ton_demand_tls \{\n\t\task http:\/\/127\.0\.0\.1:9444\/origins\/certificate\n\t\}/);
  assert.match(caddy, /\nhttp:\/\/127\.0\.0\.1:9444 \{\n\tbind 127\.0\.0\.1\n\t@ask path \/origins\/certificate\n/);
  const block = host => `${SITE_BLOCK.replace('{SITE}', host).replace('{PORT}', '7199')}`;
  assert.ok(caddy.includes(block('place.example.test')) && caddy.includes(block('www.example.test')), 'the runs sites are unchanged');
  assert.match(caddy, /\napp\.example\.test \{\n\treverse_proxy https:\/\/192\.0\.2\.10:443 \{\n\t\theader_up Host \{http\.request\.host\}\n/);
  assert.match(caddy, /\nhttps:\/\/ \{\n\ttls \{\n\t\ton_demand\n\t\}\n\treverse_proxy https:\/\/192\.0\.2\.10:443 \{[\s\S]*tls_server_name \{http\.request\.host\}/);
  assert.doesNotMatch(caddy, /\{[a-z_]+\}/, 'every field is filled');
  const dropIn = files.find(file => file.path === '/etc/systemd/system/caddy.service.d/front-door.conf').text;
  assert.match(dropIn, /^EnvironmentFile=\/etc\/caddy\/storage\.env$/m);
  assert.match(dropIn, /^ExecStart=\/opt\/example\/caddy run --config \/etc\/caddy\/Caddyfile$/m);
  const { door_upstream, ...missing } = door;
  assert.throws(() => renderWhatItRuns({ ...runs, caddy: { ...runs.caddy, front_door: missing } }, SITE_BLOCK), /caddy\.front_door needs door_upstream/);
});

// A computer that serves the public door runs the program its signed feed gives, from the unit's own releases folder.
const withDoor = {
  caddy: runs.caddy,
  units: [...runs.units, {
    unit: 'example-door.service', template: 'serve-door', description: 'Example door', user: 'example-door',
    releases: '/opt/example-door/releases', door_file: 'example-door',
    environment: ['DOOR_LISTEN=127.0.0.1:9445', 'DOOR_PUBLIC_HOST=place.example.test'],
  }],
};

test('a row that names the door renders its unit from its releases folder, with its environment', () => {
  const door = renderWhatItRuns(withDoor, SITE_BLOCK).find(file => file.path === '/etc/systemd/system/example-door.service').text;
  assert.doesNotMatch(door, /\{[a-z_]+\}/);
  assert.match(door, /^Environment=DOOR_LISTEN=127\.0\.0\.1:9445 DOOR_PUBLIC_HOST=place\.example\.test$/m);
  assert.match(door, /^ExecStart=\/bin\/sh -c 'exec "\$\(readlink -f \/opt\/example-door\/releases\/current\)\/example-door"'$/m);
  assert.match(door, /^User=example-door$/m);
});

// A computer that runs a database server: its settings file of lines, its backup, restore test and role scripts, and the
// timers that run them, all from the row.
const database = {
  caddy: runs.caddy,
  units: [{
    unit: 'example-database.service', template: 'serve-postgres', description: 'Example database', user: 'postgres',
    state: '/var/lib/postgresql', data_dir: '/var/lib/postgresql/18/example', program_bin: '/usr/lib/postgresql/18/bin',
    settings_file: '/etc/example-database/postgresql.conf', settings_lines: ["listen_addresses = '127.0.0.1'", "archive_command = 'wal-g wal-push %p'"],
    environment: ['PGDATA=/var/lib/postgresql/18/example', 'WALG_S3_PREFIX=s3://example-bucket/postgres'], writable: '/var/lib/postgresql',
    secret_name: 'example-store', secret_file: '/etc/credstore.encrypted/example-database', secret_vault_key: 'example-store-env',
    check_command: 'pg_isready -q',
  }, {
    unit: 'example-database-backup.service', template: 'run-a-script', description: 'Example database backup', user: 'postgres',
    state: '/var/lib/postgresql', after: 'example-database.service', script: 'back-up-postgres', script_file: '/usr/local/lib/example-database/back-up.sh',
    program_bin: '/usr/lib/postgresql/18/bin', environment: ['PGDATA=/var/lib/postgresql/18/example', 'SECRET_NAME=example-store'], writable: '/var/lib/postgresql',
    secret_name: 'example-store', secret_file: '/etc/credstore.encrypted/example-database-backup', secret_vault_key: 'example-store-env',
  }, {
    unit: 'example-database-backup.timer', template: 'run-on-a-timer', description: 'Example database backup, daily', user: 'postgres',
    state: '/var/lib/postgresql', runs: 'example-database-backup.service', on_calendar: 'daily',
  }],
};

test('a database unit, a script unit and a timer render from their fields, and the script and settings lines are written', () => {
  const files = renderWhatItRuns(database, SITE_BLOCK);
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

// A database unit's reach: the listen line and an access file holding only its entries' rows, and the ports and routes an
// entry opens.
const reachServer = { ...database.units[0], settings_lines: ["unix_socket_directories = '/run/postgresql'"] };
const reach = [
  { for: 'the computer\'s own jobs', hba: [{ type: 'local', database: 'all', user: 'all', method: 'peer' }] },
  { for: 'tool:run-sql-in-my-database', listen: '127.0.0.1', credential: 'example-connection', hba: [{ type: 'host', database: 'p_example', user: 'all', address: '127.0.0.1/32', method: 'scram-sha-256' }] },
];
const reachRow = { caddy: runs.caddy, units: [reachServer] };

test('a database unit without reach renders only its own settings lines and no access file', () => {
  const expanded = withReach(reachRow);
  assert.deepEqual(expanded.units, [reachServer]);
  assert.ok(!renderWhatItRuns(expanded, SITE_BLOCK).some(file => file.path.endsWith('pg_hba.conf')));
});

test('reach renders the listen line and an access file holding only what its entries say', () => {
  const files = renderWhatItRuns(withReach({ ...reachRow, units: [{ ...reachServer, reach, hba_file: '/etc/example-database/pg_hba.conf' }] }), SITE_BLOCK);
  const text = path => files.find(file => file.path === path)?.text;
  assert.equal(text('/etc/example-database/postgresql.conf'), "unix_socket_directories = '/run/postgresql'\nlisten_addresses = '127.0.0.1'\nhba_file = '/etc/example-database/pg_hba.conf'\n");
  assert.equal(text('/etc/example-database/pg_hba.conf'), 'local all all peer\nhost p_example all 127.0.0.1/32 scram-sha-256\n');
  const none = renderWhatItRuns(withReach({ ...reachRow, units: [{ ...reachServer, reach: [], hba_file: '/etc/example-database/pg_hba.conf' }] }), SITE_BLOCK);
  assert.equal(none.find(file => file.path === '/etc/example-database/pg_hba.conf').text, '', 'no entry, nobody connects');
  assert.match(none.find(file => file.path === '/etc/example-database/postgresql.conf').text, /^listen_addresses = ''$/m, 'no entry listens, no network listener');
});

test('a reach entry that opens a port adds it to the firewall and its Caddy routes, and is refused where another program keeps the firewall', () => {
  const opened = { for: 'an AI that opens TCP', listen: '0.0.0.0', firewall_allow: ['5432/tcp'], routes: ['example-route'], hba: [{ type: 'hostssl', database: 'p_example', user: 'p_example_share', address: '0.0.0.0/0', method: 'scram-sha-256' }] };
  const expanded = withReach({ ...reachRow, units: [{ ...reachServer, reach: [opened], hba_file: '/etc/example-database/pg_hba.conf' }], machine: { firewall_allow: ['22/tcp'] } });
  assert.deepEqual(expanded.machine.firewall_allow, ['22/tcp', '5432/tcp']);
  assert.deepEqual(expanded.caddy.routes, ['example-route']);
  assert.throws(() => withReach({ ...reachRow, units: [{ ...reachServer, reach: [opened], hba_file: '/etc/example-database/pg_hba.conf' }], machine: { firewall_allow: null } }), /firewall is kept by another program/);
});

test('reach refuses a missing access file, a typed listen line and a word that would add a line', () => {
  assert.throws(() => withReach({ ...reachRow, units: [{ ...reachServer, reach }] }), /needs hba_file/);
  assert.throws(() => withReach({ ...reachRow, units: [{ ...reachServer, reach, hba_file: '/etc/x', settings_lines: ["listen_addresses = '*'"] }] }), /must not set listen_addresses/);
  assert.throws(() => withReach({ ...reachRow, units: [{ ...reachServer, reach: [{ hba: [{ type: 'host', database: 'all\nhost', user: 'all', address: '0.0.0.0/0', method: 'trust' }] }], hba_file: '/etc/x' }] }), /each one word/);
});

test('a unit that names an unknown script is refused', () => {
  const [server, job] = database.units;
  assert.throws(() => renderWhatItRuns({ ...database, units: [server, { ...job, script: 'nope' }] }, SITE_BLOCK), /unknown script nope/);
});

test('every script the Workshop keeps for units is valid shell', async () => {
  const { readdirSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const folder = new URL('../read-data/scripts/', import.meta.url);
  const names = readdirSync(folder).filter(name => name.endsWith('.sh'));
  assert.ok(names.length >= 3);
  for (const name of names) assert.equal(spawnSync('sh', ['-n', new URL(name, folder).pathname]).status, 0, name);
});
