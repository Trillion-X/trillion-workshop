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
