// tools/start-a-computer/test/apply-layout.test.mjs
//
// Applying a computer's layout row to a computer that matches it (nothing written, nothing restarted) and to a fresh one
// (set up, then every file the row renders written, and its units started).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHostLayout, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderLayout } from '../do-work/render-layout.mjs';

const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };
const layout = {
  caddy: { site_hosts: ['place.example.test'], port: 7199, releases: '/opt/example/releases' },
  units: [{
    unit: 'example-place.service', template: 'serve-place', description: 'Example place', user: 'example-place',
    releases: '/opt/example/releases', engine_file: 'example-engine', data_env: 'EXAMPLE_DATA_ROOT', data_dir: 'product',
    config: '/var/lib/example-place/place.json', launch_setting: 'EXAMPLE_SETTINGS',
    product_settings: '/var/lib/example-place/product-settings.json', writable: ['/var/lib/example-place', '/opt/example/releases'],
    drop_ins: ['nofile'],
  }],
  unmanaged: [],
};

// A computer that runs the layout as rendered (`live`), or nothing yet (`live` empty). `commands` records every command.
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
    if (command.startsWith('getent') || command.startsWith('test -e')) return '';
    return '';
  };
  return { run, commands };
};

test('a computer that already runs its layout gets nothing written, no set-up, and nothing restarted', async () => {
  const live = Object.fromEntries(renderLayout(layout, SITE_BLOCK).map(({ path, text }) => [path, text]));
  const { run, commands } = computer(live);
  assert.deepEqual(await applyHostLayout(machine, layout, run), { written: [], restarted: [] });
  assert.equal(commands.filter(({ command }) => /^(sh -s|install |cp |systemctl |caddy )/.test(command)).length, 0);
});

test('a fresh computer is set up from the row, then gets every file the row renders, and its unit started', async () => {
  const { run, commands } = computer({});
  const { written, restarted } = await applyHostLayout(machine, layout, run);
  const rendered = renderLayout(layout, SITE_BLOCK).map(({ path }) => path);
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
  const rendered = renderLayout(layout, SITE_BLOCK);
  const live = Object.fromEntries(rendered.map(({ path, text }) => [path, text]));
  live['/etc/systemd/system/example-place.service'] = 'an older unit\n';
  const { run, commands } = computer(live);
  const { written, restarted } = await applyHostLayout(machine, layout, run);
  assert.deepEqual(written, ['/etc/systemd/system/example-place.service']);
  assert.deepEqual(restarted, ['example-place.service']);
  assert.ok(commands.some(({ command }) => /^cp -p '\/etc\/systemd\/system\/example-place\.service' '\/etc\/systemd\/system\/example-place\.service\.bak-/.test(command)));
  assert.equal(commands.filter(({ command }) => command.startsWith('sh -s')).length, 1);
});

test('a restarted unit must answer its health row on the machine, or the apply fails', async () => {
  const live = { '/etc/systemd/system/example-place.service': 'an older unit\n' };
  const healthy = async (_m, command) => {
    if (command.startsWith('if [ -f ')) { const p = command.match(/if \[ -f '([^']+)' \]/)[1]; if (live[p] === undefined) throw Object.assign(new Error('absent'), { code: 3 }); return live[p]; }
    if (command.includes('curl')) return '200';
    return '';
  };
  const ok = await applyHostLayout(machine, layout, healthy);
  assert.deepEqual(ok.booted, ['example-place.service']);
  const crashing = async (m, command) => command.includes('curl') ? '000' : healthy(m, command);
  await assert.rejects(applyHostLayout(machine, layout, crashing), /example-place\.service answered nothing on \/readyz, not 200/);
});
