// tools/start-a-computer/test/tarball-release.test.mjs
//
// A unit whose release the request hands as a tarball on the caller's computer (`releases`: unit, commit, tarball) is behind
// when its releases folder's `current` is not that commit; applying the row unpacks the tarball beside the others as the unit's
// user, moves `current` to it with one rename and restarts the unit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHostLayout, hostLayoutDifferences, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderLayout } from '../do-work/render-layout.mjs';

const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
const engine = {
  unit: 'example-engine.service', template: 'serve-computer', description: 'Example engine', user: 'example-engine', state: '/var/lib/example-engine',
  releases: '/opt/example-engine/releases', engine_file: 'example-engine', data_env: 'EXAMPLE_DATA', data_dir: 'product', launch_setting: 'EXAMPLE_SETTINGS',
  config: '/var/lib/example-engine/computer.json', product_settings: '/var/lib/example-engine/product-settings.json', writable: '/var/lib/example-engine',
  settings: { listen: '127.0.0.1:7199' }, health: { path: '/readyz', status: 200 }, health_listen: '127.0.0.1:7199',
};
const layout = { caddy: { site_hosts: ['place.example.test'], port: 7199, releases: '/opt/example/releases' }, units: [engine], unmanaged: [] };
const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };
const folder = mkdtempSync(join(tmpdir(), 'release-'));
writeFileSync(join(folder, 'release.tar.gz'), 'not really a tarball');
const releases = [{ unit: 'example-engine.service', commit: NEW, tarball: join(folder, 'release.tar.gz') }];
const product = '{}';

const computer = current => {
  const live = Object.fromEntries(renderLayout(layout, SITE_BLOCK, product).map(({ path, text }) => [path, text]));
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input });
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    if (command.startsWith('readlink ')) return current ? `${current}\n` : '';
    if (command.includes('curl')) return '200';
    return '';
  };
  return { run, commands };
};

test('a unit whose current is not the commit the request hands is a difference, and one at that commit is not', async () => {
  assert.deepEqual(await hostLayoutDifferences(machine, layout, computer(OLD).run, product, { releases }),
    [{ path: '/opt/example-engine/releases/current', reason: `runs ${OLD}; the request gives ${NEW}` }]);
  assert.deepEqual(await hostLayoutDifferences(machine, layout, computer('').run, product, { releases }),
    [{ path: '/opt/example-engine/releases/current', reason: `runs no release; the request gives ${NEW}` }]);
  assert.deepEqual(await hostLayoutDifferences(machine, layout, computer(NEW).run, product, { releases }), []);
});

test('applying unpacks the tarball as the unit\'s user, moves current by one rename and restarts the unit', async () => {
  const { run, commands } = computer(OLD);
  const answer = await applyHostLayout(machine, layout, run, product, {}, { releases });
  assert.deepEqual(answer.released, [{ unit: 'example-engine.service', from: OLD, commit: NEW }]);
  assert.ok(answer.restarted.includes('example-engine.service'));
  const placed = commands.find(({ command }) => command.includes('tar -xzf -'));
  assert.match(placed.command, /^runuser -u 'example-engine' -- sh -c /);
  assert.match(placed.command, new RegExp(`/opt/example-engine/releases/${NEW}`));
  assert.ok(placed.command.includes("mv -T '\\''/opt/example-engine/releases/current.new'\\'' '\\''/opt/example-engine/releases/current'\\''"), 'one rename moves current');
  assert.ok(placed.input?.pipe, 'the tarball streams on the SSH channel');
});

test('a release row naming a unit the layout lacks, or no commit, is refused', async () => {
  await assert.rejects(hostLayoutDifferences(machine, layout, computer(OLD).run, product, { releases: [{ ...releases[0], unit: 'nope.service' }] }), /no unit of the layout with a releases folder/);
  await assert.rejects(hostLayoutDifferences(machine, layout, computer(OLD).run, product, { releases: [{ ...releases[0], commit: 'abc' }] }), /full commit id/);
});
