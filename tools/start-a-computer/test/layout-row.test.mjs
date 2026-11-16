// tools/start-a-computer/test/layout-row.test.mjs
//
// A computer runs the layout row its request hands in (request.host_layout, the row itself): this tool reads no store for it,
// and applying or comparing uses that row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyALayout, hostLayoutOf, layoutDifferences, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderLayout } from '../do-work/render-layout.mjs';

const row = {
  caddy: { site_hosts: ['place.example.test'], port: 7199, releases: '/opt/example/releases' },
  units: [{
    unit: 'example-place.service', template: 'serve-place', description: 'Example place', user: 'example-place',
    releases: '/opt/example/releases', engine_file: 'example-engine', data_env: 'EXAMPLE_DATA_ROOT', data_dir: 'product',
    config: '/var/lib/example-place/place.json', launch_setting: 'EXAMPLE_SETTINGS',
    product_settings: '/var/lib/example-place/product-settings.json', writable: '/var/lib/example-place', drop_ins: ['nofile'],
  }],
  unmanaged: [],
};
const request = { machine: { address: '192.0.2.9' }, ssh: { known_hosts: '/dev/null' }, host_layout: row };

test('a request gets the layout row it hands in, as it is', () => {
  assert.equal(hostLayoutOf(request), row);
});

test('a layout that is an id, a missing value, or a row with no units and caddy is refused', () => {
  for (const given of ['record:host-layout:example-computer', undefined, null, {}, { units: [] }, { caddy: {} }]) {
    assert.throws(() => hostLayoutOf({ host_layout: given }), /host_layout is the computer's layout row itself/);
  }
});

test('applying and comparing a computer use its row: a computer that runs it has no differences', async () => {
  const live = Object.fromEntries(renderLayout(row, SITE_BLOCK).map(({ path, text }) => [path, text]));
  const run = async (_machine, command) => {
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    if (command.startsWith('if [ -d ')) return 'nofile.conf\n';
    return '';
  };
  assert.deepEqual(await layoutDifferences(request, { run }), { differences: [] });
  assert.deepEqual(await applyALayout(request, { run }), { written: [], restarted: [] });
  delete live['/etc/caddy/Caddyfile'];
  assert.deepEqual(await layoutDifferences(request, { run }), { differences: [{ path: '/etc/caddy/Caddyfile', reason: 'missing on the computer' }] });
});
