// tools/start-a-computer/test/keep-the-layout.test.mjs
//
// A computer changes only from its layout row. A row that names keep_layout renders a timer at the row's interval, its
// service and script, and the list of every file the row renders; the script, run on a folder standing in for the computer,
// writes a difference row for each hand edit, missing file and undeclared drop-in before it puts the row's bytes back, and
// reloads only what changed. A computer that matches its row is left untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyHostLayout, hostLayoutDifferences, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { KEEP, renderLayout } from '../do-work/render-layout.mjs';

const SCRIPT = new URL('../do-work/keep-the-layout.sh', import.meta.url).pathname;
const layout = {
  caddy: { site_hosts: ['place.example.test'], port: 7199, releases: '/opt/example/releases', routes: ['better-auth'], auth_port: 7201 },
  units: [
    {
      unit: 'example-place.service', template: 'serve-place', description: 'Example place', user: 'example-place',
      releases: '/opt/example/releases', engine_file: 'example-engine', data_env: 'EXAMPLE_DATA_ROOT', data_dir: 'product',
      config: '/var/lib/example-place/place.json', launch_setting: 'EXAMPLE_SETTINGS',
      product_settings: '/var/lib/example-place/product-settings.json', writable: ['/var/lib/example-place'], drop_ins: ['nofile'],
    },
    {
      unit: 'example-sign-in.service', template: 'serve-better-auth', description: 'Example sign-in', user: 'example-sign-in',
      state: '/var/lib/example-sign-in', workshop: '/var/lib/example-sign-in/trillion-workshop',
      repository: 'https://github.com/Trillion-X/trillion-workshop.git', tool_folder: 'tools/better-auth-official',
      node_bin: '/opt/node/bin', settings_file: '/etc/example-sign-in/settings.json', settings: { port: 7201 },
      secret_vault_key: 'example-better-auth-secret', secret_name: 'better-auth-secret',
      secret_file: '/etc/credstore.encrypted/better-auth-secret', writable: '/var/lib/example-sign-in',
    },
  ],
  unmanaged: [],
  keep_layout: { every: '2min' },
};
const product = '{"word":"example"}\n';

test('a kept layout renders the timer at the row\'s interval, its service and script, and last the list of every file', () => {
  const files = renderLayout(layout, SITE_BLOCK, product);
  const paths = files.map(({ path }) => path);
  assert.deepEqual(paths.slice(-4), ['/etc/systemd/system/keep-the-layout.service', '/etc/systemd/system/keep-the-layout.timer', KEEP.script, KEEP.manifest]);
  const timer = files.find(({ path }) => path.endsWith('keep-the-layout.timer')).text;
  assert.match(timer, /^OnUnitActiveSec=2min$/m);
  assert.match(files.find(({ path }) => path.endsWith('keep-the-layout.service')).text, new RegExp(`^ExecStart=/bin/sh ${KEEP.script}$`, 'm'));
  const list = JSON.parse(files.at(-1).text);
  assert.deepEqual(list.files.map(({ path }) => path), paths.slice(0, -1), 'the list names every rendered file but itself');
  const settings = list.files.find(({ path }) => path === '/var/lib/example-place/product-settings.json');
  assert.deepEqual([settings.mode, settings.owner, settings.unit], ['0600', 'example-place', 'example-place.service']);
  assert.equal(list.files.find(({ path }) => path === '/etc/example-sign-in/settings.json').unit, 'example-sign-in.service');
  assert.equal(list.files.find(({ path }) => path === '/etc/caddy/Caddyfile').validate, 'caddy');
  assert.deepEqual(list.units.map(({ unit }) => unit), ['example-place.service', 'example-sign-in.service', 'caddy.service']);
  assert.throws(() => renderLayout({ ...layout, keep_layout: { every: 'often' } }, SITE_BLOCK), /keep_layout\.every needs an interval/);
  const { keep_layout: _, ...plain } = layout;
  assert.ok(!renderLayout(plain, SITE_BLOCK).some(({ path }) => path.includes('keep-the-layout')), 'a row without keep_layout keeps nothing');
});

// A folder standing in for the computer, holding every file the row renders; systemctl, chown and caddy are stand-ins that
// record what they are asked (caddy validates unless CADDY_REFUSES is set).
function computer() {
  const root = mkdtempSync(join(tmpdir(), 'keep-the-layout-'));
  const bin = join(root, '.stand-in-bin'), log = join(root, '.calls.log');
  mkdirSync(bin);
  const program = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  program('systemctl', `echo "systemctl $*" >> '${log}'`);
  program('chown', `echo "chown $*" >> '${log}'`);
  program('caddy', `echo "caddy $*" >> '${log}'; [ -z "\${CADDY_REFUSES:-}" ]`);
  for (const { path, text } of renderLayout(layout, SITE_BLOCK, product)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const keep = (env = {}) => spawnSync('sh', [SCRIPT], { env: { PATH: `${bin}:${process.env.PATH}`, KEEP_ROOT: root, ...env }, encoding: 'utf8' });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  const rows = () => (existsSync(join(root, KEEP.rows)) ? readFileSync(join(root, KEEP.rows), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
  const at = path => join(root, path);
  return { root, keep, calls, rows, at };
}

test('a computer that matches its row gets no row, no write and nothing reloaded', () => {
  const host = computer();
  const ran = host.keep();
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(host.rows(), []);
  assert.deepEqual(host.calls(), []);
  rmSync(host.root, { recursive: true, force: true });
});

test('a hand edit is written as a row naming the file and what changed, then put back, and only its unit restarts', () => {
  const host = computer();
  const rendered = Object.fromEntries(renderLayout(layout, SITE_BLOCK, product).map(({ path, text }) => [path, text]));
  writeFileSync(host.at('/etc/caddy/Caddyfile'), `${rendered['/etc/caddy/Caddyfile']}hand.example.test {\n\trespond "hand edit"\n}\n`);
  writeFileSync(host.at('/etc/example-sign-in/settings.json'), '{ "port": 9999 }\n');
  rmSync(host.at('/etc/systemd/system/example-place.service.d/nofile.conf'));
  writeFileSync(host.at('/etc/systemd/system/example-place.service.d/override.conf'), '[Service]\nUser=root\n');
  const ran = host.keep();
  assert.equal(ran.status, 0, ran.stderr);

  const rows = host.rows();
  assert.deepEqual(rows.map(({ path, reason }) => [path, reason]).sort(), [
    ['/etc/caddy/Caddyfile', 'differs from the layout'],
    ['/etc/example-sign-in/settings.json', 'differs from the layout'],
    ['/etc/systemd/system/example-place.service.d/nofile.conf', 'missing on the computer'],
    ['/etc/systemd/system/example-place.service.d/override.conf', 'not in the layout'],
  ]);
  const caddyRow = rows.find(({ path }) => path === '/etc/caddy/Caddyfile');
  assert.match(caddyRow.changed, /^-\trespond "hand edit"$/m, 'the row shows the hand-edited line the row does not have');
  assert.match(rows.find(({ path }) => path.endsWith('settings.json')).changed, /^-\{ "port": 9999 \}$/m);
  assert.ok(rows.every(row => row.put_back === true && row.at));
  assert.equal(statSync(host.at(KEEP.rows)).mode & 0o777, 0o600, 'the rows are root\'s alone');

  for (const path of ['/etc/caddy/Caddyfile', '/etc/example-sign-in/settings.json', '/etc/systemd/system/example-place.service.d/nofile.conf']) {
    assert.equal(readFileSync(host.at(path), 'utf8'), rendered[path], `${path} is the row's bytes again`);
  }
  assert.ok(!existsSync(host.at('/etc/systemd/system/example-place.service.d/override.conf')), 'the undeclared drop-in is moved out');
  assert.ok(readdirSync(host.at(KEEP.held)).some(name => name.endsWith('example-place.service.d-override.conf')));
  assert.ok(readdirSync(host.at('/etc/caddy')).some(name => name.startsWith('Caddyfile.differed-')), 'the hand-edited bytes are kept beside it');

  const calls = host.calls();
  assert.equal(calls.filter(call => call === 'systemctl daemon-reload').length, 1);
  assert.deepEqual(calls.filter(call => call.startsWith('systemctl restart')).sort(), ['systemctl restart example-place.service', 'systemctl restart example-sign-in.service']);
  assert.ok(calls.includes('systemctl reload caddy'));
  assert.ok(calls.some(call => /^caddy validate --config \S+Caddyfile\.new --adapter caddyfile$/.test(call)), 'the Caddy file is validated before it replaces the live one');

  const again = host.keep();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(host.rows().length, 4, 'once put back, the next run finds nothing');
  rmSync(host.root, { recursive: true, force: true });
});

test('a row whose Caddy file does not validate is still written, and the live file is left as it is', () => {
  const host = computer();
  writeFileSync(host.at('/etc/caddy/Caddyfile'), 'hand.example.test {\n}\n');
  const ran = host.keep({ CADDY_REFUSES: '1' });
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /does not validate; left as it is/);
  assert.deepEqual(host.rows().map(({ path }) => path), ['/etc/caddy/Caddyfile']);
  assert.equal(readFileSync(host.at('/etc/caddy/Caddyfile'), 'utf8'), 'hand.example.test {\n}\n');
  assert.ok(!host.calls().some(call => call.startsWith('systemctl')));
  rmSync(host.root, { recursive: true, force: true });
});

test('applying a kept layout writes its list root-private and starts its timer; the operator\'s comparison sees Caddy drop-ins', async () => {
  const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };
  const rendered = renderLayout(layout, SITE_BLOCK);
  const live = Object.fromEntries(rendered.filter(({ path }) => !path.includes('keep-the-layout') && !path.startsWith('/etc/start-a-computer') && !path.startsWith('/usr/local')).map(({ path, text }) => [path, text]));
  const commands = [];
  const run = async (_m, command, input) => {
    commands.push({ command, input });
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    if (command.includes("if [ -d '/etc/systemd/system/caddy.service.d'")) return 'override.conf\n';
    if (command.includes('curl')) return '200';
    return '';
  };
  const { written, restarted } = await applyHostLayout(machine, layout, run);
  assert.deepEqual(written, ['/etc/systemd/system/keep-the-layout.service', '/etc/systemd/system/keep-the-layout.timer', KEEP.script, KEEP.manifest]);
  assert.deepEqual(restarted, ['keep-the-layout.timer']);
  assert.ok(commands.some(({ command }) => command === "systemctl enable --now 'keep-the-layout.timer' >/dev/null 2>&1"));
  assert.ok(commands.some(({ command }) => command.endsWith(`install -m 0600 -o 'root' -g 'root' /dev/stdin '${KEEP.manifest}'`)));
  const found = await hostLayoutDifferences(machine, layout, run);
  assert.ok(found.some(({ path, reason }) => path === '/etc/systemd/system/caddy.service.d/override.conf' && reason === 'not in the layout'));
});
