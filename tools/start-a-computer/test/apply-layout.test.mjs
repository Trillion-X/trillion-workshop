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
    if (command.startsWith('getent')) { if (Object.keys(live).length === 0) throw Object.assign(new Error('no such account'), { code: 3 }); return ''; }
    if (command.startsWith('test -e')) return '';
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
  assert.equal(commands.filter(({ command }) => command.startsWith('sh -s')).length, 0, 'an existing account is not set up again');
});

test('a unit\'s product settings file is declared from the product data, owned by its user, and only its unit restarts', async () => {
  const product = '{"word":"example"}\n';
  const withSettings = { ...layout, units: [{ ...layout.units[0], user: 'example-place', product_settings: '/var/lib/example-place/product-settings.json' }] };
  const matching = Object.fromEntries(renderLayout(withSettings, SITE_BLOCK, product).map(({ path, text }) => [path, text]));
  const same = computer(matching);
  assert.deepEqual(await applyHostLayout(machine, withSettings, same.run, product), { written: [], restarted: [] });

  const stale = { ...matching, '/var/lib/example-place/product-settings.json': '{"word":"older"}\n' };
  const { run, commands } = computer(stale);
  const { written, restarted } = await applyHostLayout(machine, withSettings, run, product);
  assert.deepEqual(written, ['/var/lib/example-place/product-settings.json']);
  assert.deepEqual(restarted, ['example-place.service']);
  assert.ok(commands.some(({ command, input }) => command === "install -m 0600 -o 'example-place' -g 'example-place' /dev/stdin '/var/lib/example-place/product-settings.json'" && input === product));
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

// A front door (caddy.front_door): its pinned Caddy is fetched by set-up when the machine lacks it, its site file is
// validated by that Caddy with the shared storage's environment, and Caddy restarts because its drop-in swaps the program.
test('a front door gets its pinned Caddy, is validated by it and restarts Caddy instead of only reloading it', async () => {
  const door = { ...layout, caddy: { ...layout.caddy, front_door: {
    storage_server_cert: '/etc/caddy/storage-server.crt', storage_env: '/etc/caddy/storage.env', ask_port: 9444,
    ask_path: '/origins/certificate', door_upstream: 'https://192.0.2.10:443', door_host: 'app.example.test',
    door_server_name: '{http.request.host}', door_hosts: ['app.example.test'] } } };
  const rendered = renderLayout(door, SITE_BLOCK);
  const live = Object.fromEntries(rendered.filter(({ path }) => !path.includes('caddy')).map(({ path, text }) => [path, text]));
  const base = computer(live);
  const run = async (machine_, command, input) => {
    if (command === 'uname -m') { base.commands.push({ command }); return 'x86_64\n'; }
    if (command.includes('sha256sum -c --status || exit 3')) { base.commands.push({ command }); throw Object.assign(new Error('not pinned'), { code: 3 }); }
    return base.run(machine_, command, input);
  };
  const { written, restarted } = await applyHostLayout(machine, door, run);
  assert.deepEqual(written, ['/etc/caddy/Caddyfile', '/etc/systemd/system/caddy.service.d/front-door.conf']);
  assert.deepEqual(restarted, ['caddy.service']);
  const setUp = base.commands.find(({ command }) => command.startsWith('sh -s'));
  assert.match(setUp.command, / '\/opt\/caddy\/2\.11\.9-redis\/caddy https:\/\/\S+-linux-amd64 eca5f1582fe35e8758a6f03df305427cc1848d908a810341ad1425ef87b2062f'$/);
  assert.ok(base.commands.some(({ command }) => command.startsWith("set -a && . '/etc/caddy/storage.env' && set +a && '/opt/caddy/2.11.9-redis/caddy' validate")));
  assert.ok(base.commands.some(({ command }) => command === "systemctl restart 'caddy.service'"));
  assert.ok(!base.commands.some(({ command }) => command === 'systemctl reload caddy'), 'a restart already loads the new site file');
});
