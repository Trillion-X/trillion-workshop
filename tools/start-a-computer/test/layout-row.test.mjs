// tools/start-a-computer/test/layout-row.test.mjs
//
// A computer runs the layout row the person keeps (record:host-layout:<computer> at @own-records): a request may name the
// row by id, and applying or comparing reads that row, never a file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyALayout, hostLayoutOf, layoutDifferences, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderLayout } from '../do-work/render-layout.mjs';

const ROW_ID = 'record:host-layout:example-computer';
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
const rows = { [ROW_ID]: row };
const readRow = async id => rows[id];
const request = { machine: { address: '192.0.2.9' }, ssh: { known_hosts: '/dev/null' }, host_layout: ROW_ID };

test('a request that names the layout row by id gets that row; a row given whole is used as it is', async () => {
  assert.deepEqual(await hostLayoutOf(request, readRow), row);
  assert.equal(await hostLayoutOf({ host_layout: row }, async () => { throw new Error('not read'); }), row);
});

test('an id of another kind, or a row that holds no layout, is refused', async () => {
  await assert.rejects(hostLayoutOf({ host_layout: 'record:note:x' }, readRow), /record:host-layout:<computer>/);
  await assert.rejects(hostLayoutOf({ host_layout: 'record:host-layout:missing' }, readRow), /record:host-layout:missing holds no layout/);
});

test('applying and comparing a computer read its row: a computer that runs it has no differences', async () => {
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
  assert.deepEqual(await layoutDifferences(request, { run, readRow }), { differences: [] });
  assert.deepEqual(await applyALayout(request, { run, readRow }), { written: [], restarted: [] });
  delete live['/etc/caddy/Caddyfile'];
  assert.deepEqual(await layoutDifferences(request, { run, readRow }), { differences: [{ path: '/etc/caddy/Caddyfile', reason: 'missing on the computer' }] });
});
