// tools/start-a-computer/test/render-layout.test.mjs
//
// The layout renderer on a synthetic computer: its files, its refusals and the comparison with what a computer runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { differences, renderLayout } from '../do-work/render-layout.mjs';

const SITE_BLOCK = '{SITE} {\n\thandle {\n\t\treverse_proxy 127.0.0.1:{PORT}\n\t}\n}';
const layout = {
  caddy: { site_hosts: ['place.example.test', 'www.example.test'], port: 7199 },
  units: [{
    unit: 'example-place.service', template: 'serve-place', description: 'Example place', user: 'example-place',
    releases: '/opt/example/releases', engine_file: 'example-engine', data_env: 'EXAMPLE_DATA_ROOT', data_dir: 'product',
    config: '/var/lib/example-place/place.json', launch_setting: 'EXAMPLE_SETTINGS',
    product_settings: '/var/lib/example-place/product-settings.json', writable: '/var/lib/example-place /opt/example/releases',
    drop_ins: ['nofile', 'product-settings'],
  }],
};

test('renders the Caddy site file once per name, with the port', () => {
  const [caddy] = renderLayout(layout, SITE_BLOCK);
  assert.equal(caddy.path, '/etc/caddy/Caddyfile');
  const block = host => `${SITE_BLOCK.replace('{SITE}', host).replace('{PORT}', '7199')}\n`;
  assert.equal(caddy.text, block('place.example.test') + block('www.example.test'));
});

test('renders the unit and its drop-ins from the template fields', () => {
  const files = renderLayout(layout, SITE_BLOCK);
  const unit = files.find(file => file.path === '/etc/systemd/system/example-place.service').text;
  assert.match(unit, /^Environment=EXAMPLE_SETTINGS=\/var\/lib\/example-place\/product-settings\.json$/m);
  assert.match(unit, /^ExecStart=\/bin\/sh -c 'R=\$\(readlink -f \/opt\/example\/releases\/current\) && exec env EXAMPLE_DATA_ROOT="\$R\/product" "\$R\/example-engine" serve \/var\/lib\/example-place\/place\.json'$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/example-place \/opt\/example\/releases$/m);
  assert.doesNotMatch(unit, /\{[a-z_]+\}/);
  const dropIns = files.filter(file => file.path.startsWith('/etc/systemd/system/example-place.service.d/')).map(file => file.path);
  assert.deepEqual(dropIns, ['/etc/systemd/system/example-place.service.d/nofile.conf', '/etc/systemd/system/example-place.service.d/product-settings.conf']);
});

test('refuses a template field the layout does not give', () => {
  const { config, ...withoutConfig } = layout.units[0];
  assert.throws(() => renderLayout({ ...layout, units: [withoutConfig] }, SITE_BLOCK), /needs config/);
});

test('refuses an unknown template or drop-in name', () => {
  assert.throws(() => renderLayout({ ...layout, units: [{ ...layout.units[0], template: 'nope' }] }, SITE_BLOCK), /unknown template/);
  assert.throws(() => renderLayout({ ...layout, units: [{ ...layout.units[0], drop_ins: ['nope'] }] }, SITE_BLOCK), /unknown drop-in/);
});

test('differences name a missing file and a changed file, and match when equal', () => {
  const rendered = renderLayout(layout, SITE_BLOCK);
  const live = Object.fromEntries(rendered.map(({ path, text }) => [path, text]));
  assert.deepEqual(differences(rendered, live), []);
  live['/etc/caddy/Caddyfile'] = 'changed';
  delete live['/etc/systemd/system/example-place.service'];
  assert.deepEqual(differences(rendered, live), [
    { path: '/etc/caddy/Caddyfile', reason: 'differs from the layout' },
    { path: '/etc/systemd/system/example-place.service', reason: 'missing on the computer' },
  ]);
});

// A computer whose layout row names the better-auth unit and route serves sign-in: the unit runs official Better Auth from
// the Workshop tool folder with its settings from the row, the secret by vault key only, and Caddy sends the auth paths to it.
const withSignIn = {
  caddy: { ...layout.caddy, routes: ['better-auth'], auth_port: 7201 },
  units: [...layout.units, {
    unit: 'example-sign-in.service', template: 'serve-better-auth', description: 'Example sign-in', user: 'example-sign-in',
    workshop: '/var/lib/example-sign-in/trillion-workshop', repository: 'https://github.com/Trillion-X/trillion-workshop.git',
    tool_folder: 'tools/better-auth-official', node_bin: '/opt/node/bin', settings_file: '/var/lib/example-sign-in/settings.json',
    settings: { port: 7201, base_url: 'https://place.example.test', issuer: 'https://place.example.test', database_path: '/var/lib/example-sign-in/auth.db' },
    secret_vault_key: 'example-better-auth-secret', secret_name: 'better-auth-secret', secret_file: '/etc/example-sign-in/better-auth-secret',
    writable: '/var/lib/example-sign-in',
  }],
};

test('a layout that names the better-auth unit renders it, its settings file and the Caddy routes to it', () => {
  const files = renderLayout(withSignIn, SITE_BLOCK);
  const unit = files.find(file => file.path === '/etc/systemd/system/example-sign-in.service').text;
  assert.doesNotMatch(unit, /\{[a-z_]+\}/);
  assert.match(unit, /^LoadCredentialEncrypted=better-auth-secret:\/etc\/example-sign-in\/better-auth-secret$/m);
  assert.match(unit, /^# BETTER_AUTH_SECRET is the value held under the vault name example-better-auth-secret:/m);
  assert.match(unit, /^Environment=BETTER_AUTH_SETTINGS=\/var\/lib\/example-sign-in\/settings\.json$/m);
  assert.match(unit, /^ExecStartPre=\/bin\/sh -c 'cd \/var\/lib\/example-sign-in\/trillion-workshop\/tools\/better-auth-official && npm ci --no-audit --no-fund'$/m);
  assert.match(unit, /exec node server\.mjs'$/m);
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

test('a layout without the route renders no auth routes; an unknown route or a route field the row omits is refused', () => {
  assert.doesNotMatch(renderLayout(layout, SITE_BLOCK)[0].text, /api\/auth/);
  assert.throws(() => renderLayout({ ...withSignIn, caddy: { ...withSignIn.caddy, routes: ['nope'] } }, SITE_BLOCK), /unknown route nope/);
  const { auth_port, ...noPort } = withSignIn.caddy;
  assert.throws(() => renderLayout({ ...withSignIn, caddy: noPort }, SITE_BLOCK), /caddy route better-auth needs auth_port/);
  const { secret_file, ...noSecret } = withSignIn.units[1];
  assert.throws(() => renderLayout({ ...withSignIn, units: [layout.units[0], noSecret] }, SITE_BLOCK), /needs secret_file/);
  const { settings_file, ...noSettingsFile } = withSignIn.units[1];
  assert.throws(() => renderLayout({ ...withSignIn, units: [layout.units[0], noSettingsFile] }, SITE_BLOCK), /needs settings_file/);
});

// A front door: shared certificate storage, an on-demand ask that only the door's own answer can make true, the layout's
// own sites unchanged, and every other name carried to the door with its own Host and TLS name.
test('a front door renders its storage, its ask, its own sites, its door hosts and the on-demand catch-all', () => {
  const door = { storage_server_cert: '/etc/caddy/storage-server.crt', storage_env: '/etc/caddy/storage.env', ask_port: 9444,
    ask_path: '/origins/certificate', door_upstream: 'https://192.0.2.10:443', door_host: 'app.example.test',
    door_server_name: '{http.request.host}', door_hosts: ['app.example.test'] };
  const files = renderLayout({ ...layout, caddy: { ...layout.caddy, front_door: door } }, SITE_BLOCK);
  const caddy = files[0].text;
  assert.match(caddy, /^\{\n\tadmin localhost:2019\n\tstorage redis \{/);
  assert.match(caddy, /\tpassword \{\$CADDY_STORAGE_PASSWORD\}\n/, 'the storage password is read from the environment, never written here');
  assert.match(caddy, /\ton_demand_tls \{\n\t\task http:\/\/127\.0\.0\.1:9444\/origins\/certificate\n\t\}/);
  assert.match(caddy, /\nhttp:\/\/127\.0\.0\.1:9444 \{\n\tbind 127\.0\.0\.1\n\t@ask path \/origins\/certificate\n/);
  const block = host => `${SITE_BLOCK.replace('{SITE}', host).replace('{PORT}', '7199')}`;
  assert.ok(caddy.includes(block('place.example.test')) && caddy.includes(block('www.example.test')), 'the layout sites are unchanged');
  assert.match(caddy, /\napp\.example\.test \{\n\treverse_proxy https:\/\/192\.0\.2\.10:443 \{\n\t\theader_up Host \{http\.request\.host\}\n/);
  assert.match(caddy, /\nhttps:\/\/ \{\n\ttls \{\n\t\ton_demand\n\t\}\n\treverse_proxy https:\/\/192\.0\.2\.10:443 \{[\s\S]*tls_server_name \{http\.request\.host\}/);
  assert.doesNotMatch(caddy, /\{[a-z_]+\}/, 'every field is filled');
  const dropIn = files.find(file => file.path === '/etc/systemd/system/caddy.service.d/front-door.conf').text;
  assert.match(dropIn, /^EnvironmentFile=\/etc\/caddy\/storage\.env$/m);
  assert.match(dropIn, /^ExecStart=\/opt\/caddy\/2\.11\.9-redis\/caddy run --config \/etc\/caddy\/Caddyfile$/m);
  const { door_upstream, ...missing } = door;
  assert.throws(() => renderLayout({ ...layout, caddy: { ...layout.caddy, front_door: missing } }, SITE_BLOCK), /caddy\.front_door needs door_upstream/);
});
