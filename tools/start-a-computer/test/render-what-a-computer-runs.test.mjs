// tools/start-a-computer/test/render-what-a-computer-runs.test.mjs
//
// The renderer of what a computer runs, on a synthetic computer: its files, its refusals and the comparison with what a computer runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { differences, renderWhatItRuns, withPrepared } from '../do-work/render-what-a-computer-runs.mjs';

const SITE_BLOCK = '{SITE} {\n\thandle {\n\t\treverse_proxy 127.0.0.1:{PORT}\n\t}\n}';
const runs = {
  caddy: { site_hosts: ['place.example.test', 'www.example.test'], port: 7199 },
  units: [{
    unit: 'example-place.service', template: 'tools/start-a-computer/read-data/unit-templates/serve-computer.service', description: 'Example place', user: 'example-place',
    state: '/var/lib/example-place', builds: '/var/lib/example-place/builds', program: 'example-engine',
    settings_file: '/etc/example-place/computer.json', settings: { listen: '127.0.0.1:7199', persons: '/var/lib/example-place/persons' },
    writable: '/var/lib/example-place', drop_ins: ['tools/start-a-computer/read-data/unit-templates/nofile.conf'],
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
  assert.match(unit, /^ExecStart=\/var\/lib\/example-place\/builds\/current\/example-engine serve \/etc\/example-place\/computer\.json$/m);
  assert.match(unit, /^WorkingDirectory=\/var\/lib\/example-place$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/example-place$/m);
  assert.doesNotMatch(unit, /\{[a-z_]+\}/);
  const dropIns = files.filter(file => file.path.startsWith('/etc/systemd/system/example-place.service.d/')).map(file => file.path);
  assert.deepEqual(dropIns, ['/etc/systemd/system/example-place.service.d/nofile.conf']);
  const config = files.find(file => file.path === '/etc/example-place/computer.json').text;
  assert.deepEqual(JSON.parse(config), runs.units[0].settings, 'the computer config is the row\'s settings, as they are');
});

test('refuses a template field the row does not give', () => {
  const { program, ...withoutProgram } = runs.units[0];
  assert.throws(() => renderWhatItRuns({ ...runs, units: [withoutProgram] }, SITE_BLOCK), /needs program/);
});

test('a unit names its files by path: one that does not exist, one outside the Workshop, or none is refused', () => {
  const unit = runs.units[0];
  assert.throws(() => renderWhatItRuns({ ...runs, units: [{ ...unit, template: 'tools/nope/nope.service' }] }, SITE_BLOCK), /template names a file that does not exist: tools\/nope\/nope\.service/);
  assert.throws(() => renderWhatItRuns({ ...runs, units: [{ ...unit, template: '../../etc/passwd' }] }, SITE_BLOCK), /names a file outside the Workshop/);
  assert.throws(() => renderWhatItRuns({ ...runs, units: [{ ...unit, template: undefined }] }, SITE_BLOCK), /template names no file/);
  assert.throws(() => renderWhatItRuns({ ...runs, units: [{ ...unit, drop_ins: ['tools/nope/nope.conf'] }] }, SITE_BLOCK), /drop-in names a file that does not exist/);
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
  caddy: { ...runs.caddy, routes: ['better-auth', 'better-auth-discovery'], pools: { auth: { listen: ['127.0.0.1:7201'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s' } } },
  units: [...runs.units, {
    unit: 'example-sign-in.service', template: 'tools/start-a-computer/read-data/unit-templates/serve-better-auth.service', description: 'Example sign-in', user: 'example-sign-in',
    workshop: '/var/lib/example-sign-in/trillion-workshop', repository: 'https://github.com/Trillion-X/trillion-workshop.git',
    tool_folder: 'tools/better-auth-official', workshop_commit: '7777777777777777777777777777777777777777', node_bin: '/opt/node/bin', settings_file: '/var/lib/example-sign-in/settings.json',
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
  const W = '/var/lib/example-sign-in/trillion-workshop', PIN = '7'.repeat(40);
  assert.ok(unit.includes(`ExecStartPre=/bin/sh -c 'git -C ${W} fetch -q --depth 1 https://github.com/Trillion-X/trillion-workshop.git ${PIN} && git -C ${W} checkout -q --detach ${PIN}'`), 'the pinned commit is fetched into the copy that stays');
  assert.ok(unit.includes(`lock=$$(git -C ${W} rev-parse ${PIN}:tools/better-auth-official/package-lock.json)`), 'npm runs only when the pinned lock file is not the one installed');
  assert.ok(unit.includes(`echo "$$lock" > ${W}/.git/npm-lock-id`));
  assert.doesNotMatch(unit, /git clone/);
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
    assert.match(block, /^\thandle \/api\/auth\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:7201 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}$/m);
    assert.match(block, /^\thandle \/\.well-known\/oauth-authorization-server\* \{\n\t\treverse_proxy 127\.0\.0\.1:7201 \{\n\t\t\tlb_policy first\n[\s\S]*?\n\t\t\}\n\t\}$/m);
    assert.ok(block.indexOf('handle /api/auth/*') < block.indexOf('reverse_proxy 127.0.0.1:7199'), 'the auth routes sit inside the block, before the catch-all');
  }
});

test('a row without the route renders no auth routes; an unknown route or a route field the row omits is refused', () => {
  assert.doesNotMatch(renderWhatItRuns(runs, SITE_BLOCK)[0].text, /api\/auth/);
  assert.throws(() => renderWhatItRuns({ ...withSignIn, caddy: { ...withSignIn.caddy, routes: ['nope'] } }, SITE_BLOCK), /unknown route nope/);
  const { pools, ...noPort } = withSignIn.caddy;
  assert.throws(() => renderWhatItRuns({ ...withSignIn, caddy: noPort }, SITE_BLOCK), /caddy route better-auth needs auth_proxy/);
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

// A unit that names `prepare` is handed to its program's own module first, which knows its program: start-a-computer writes
// the files it answers beside the unit and joins the ports and routes it opens, and knows nothing else about it.
test('a unit that names prepare is made by its program\'s own module: its files, ports and routes', async () => {
  const unit = { ...runs.units[0], prepare: 'tools/start-a-computer/test/fixtures/prepare-example.mjs', greeting: 'hello' };
  const prepared = await withPrepared({ ...runs, units: [unit], machine: { firewall_allow: ['22/tcp'] } });
  assert.equal(prepared.units[0].prepare, undefined);
  assert.equal(prepared.units[0].greeting, undefined, 'the module takes the fields it reads');
  assert.deepEqual(prepared.machine.firewall_allow, ['22/tcp', '9000/tcp']);
  assert.deepEqual(prepared.caddy.routes, ['example-route']);
  const greeting = renderWhatItRuns({ ...prepared, caddy: runs.caddy }, SITE_BLOCK).find(file => file.path === '/etc/example-greeter/example-place.service.txt');
  assert.equal(greeting.text, 'hello\n');
  await assert.rejects(withPrepared({ ...runs, units: [{ ...unit, prepare: 'tools/nope/prepare.mjs' }] }), /prepare names a file that does not exist/);
  await assert.rejects(withPrepared({ ...runs, units: [{ ...unit, prepare: 'tools/start-a-computer/do-work/fill-fields.mjs' }] }), /exports no prepare/);
  await assert.rejects(withPrepared({ ...runs, units: [unit], machine: { firewall_allow: null } }), /firewall is kept by another program/);
});

test('an inner door is a loopback address Caddy holds for programs on this computer, sent to every slot of a pool', () => {
  const pools = { internal: { listen: ['127.0.0.1:8794', '127.0.0.1:8795'], health_uri: '/readyz', health_interval: '1s', try_duration: '5s' } };
  const [caddy] = renderWhatItRuns({ ...runs, caddy: { ...runs.caddy, pools, inner_doors: [{ listen: '127.0.0.1:8793', pool: 'internal' }] } }, SITE_BLOCK);
  assert.match(caddy.text, /\nhttp:\/\/:8793 \{\n\tbind 127\.0\.0\.1\n\treverse_proxy 127\.0\.0\.1:8794 127\.0\.0\.1:8795 \{\n\t\t\tlb_policy first\n/);
  assert.throws(() => renderWhatItRuns({ ...runs, caddy: { ...runs.caddy, pools, inner_doors: [{ listen: '0.0.0.0:8793', pool: 'internal' }] } }, SITE_BLOCK), /loopback address only/);
  assert.throws(() => renderWhatItRuns({ ...runs, caddy: { ...runs.caddy, pools, inner_doors: [{ listen: '127.0.0.1:8793', pool: 'none' }] } }, SITE_BLOCK), /names no pool/);
});
