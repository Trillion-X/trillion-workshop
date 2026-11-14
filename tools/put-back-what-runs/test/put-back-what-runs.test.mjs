// tools/put-back-what-runs/test/put-back-what-runs.test.mjs
//
// The one generic reconciler: a hand edit to a thing of the first declared owner (start-a-computer's host layout row) and of
// a second, synthetic owner (files in a folder) is reported as a finding row and put back by its owner, with no reconciler
// code naming either. Owners, things and the interval are DATA (declaration rows).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { reconcile, readDeclarations, dueOwners } from '../do-work/put-back-what-runs.mjs';
import * as computerOwner from '../../start-a-computer/do-work/start-a-computer.mjs';
import { renderLayout } from '../../start-a-computer/do-work/render-layout.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), 'put-back-'));
const NOW = new Date('2026-11-14T03:00:00Z');

// ---- the synthetic owner: files in a folder, rendered from its rows ----
const folderDeclaration = folder => ({
  owner: 'owner:files-in-a-folder', module: join(here, 'owner-of-files-in-a-folder.mjs'),
  differences: 'folderDifferences', put_back: 'putFolderBack', interval_seconds: 60,
  things: [{ thing: 'folder:example', args: [{ folder, rows: { 'a.txt': 'a from its row\n', 'b.txt': 'b from its row\n' } }] }],
});

test('a hand edit to a synthetic owner\'s thing is a finding row, and the owner puts it back', async () => {
  const folder = join(scratch(), 'served');
  mkdirSync(folder);
  writeFileSync(join(folder, 'a.txt'), 'a from its row\n');
  writeFileSync(join(folder, 'b.txt'), 'b edited by hand\n');
  writeFileSync(join(folder, 'c.txt'), 'placed by hand\n');
  const { findings, owners } = await reconcile([folderDeclaration(folder)], { now: NOW });
  assert.deepEqual(findings.map(row => [row.owner, row.thing, row.difference.name, row.difference.reason, row.put_back]), [
    ['owner:files-in-a-folder', 'folder:example', 'b.txt', 'changed', 'put back'],
    ['owner:files-in-a-folder', 'folder:example', 'c.txt', 'not in the rows', 'put back'],
  ]);
  assert.ok(findings.every(row => row.kind === 'what-runs-finding' && row.found_at === NOW.toISOString() && row.id.startsWith('finding:')));
  assert.equal(readFileSync(join(folder, 'b.txt'), 'utf8'), 'b from its row\n');
  assert.deepEqual(owners, [{ owner: 'owner:files-in-a-folder', things: 1, differences: 2, put_back: 2, still_different: 0, errors: 0 }]);
  // The next pass finds nothing: what runs is what the rows render.
  assert.deepEqual((await reconcile([folderDeclaration(folder)], { now: NOW })).findings, []);
});

test('an owner that declares no put_back is reported only, and nothing is changed', async () => {
  const folder = join(scratch(), 'served');
  mkdirSync(folder);
  writeFileSync(join(folder, 'a.txt'), 'a edited by hand\n');
  writeFileSync(join(folder, 'b.txt'), 'b from its row\n');
  const { put_back: _, ...reportOnly } = folderDeclaration(folder);
  const { findings } = await reconcile([reportOnly], { now: NOW });
  assert.deepEqual(findings.map(row => [row.difference.name, row.put_back]), [['a.txt', 'reported only: the owner declares no put_back']]);
  assert.equal(readFileSync(join(folder, 'a.txt'), 'utf8'), 'a edited by hand\n');
});

test('an owner whose put-back fails, or leaves a difference, says so in its finding rows', async () => {
  const folder = join(scratch(), 'served');
  const declaration = { ...folderDeclaration(folder), put_back: 'folderDifferences' }; // "puts back" by changing nothing
  mkdirSync(folder);
  writeFileSync(join(folder, 'a.txt'), 'edited\n');
  writeFileSync(join(folder, 'b.txt'), 'b from its row\n');
  const { findings, owners } = await reconcile([declaration], { now: NOW });
  assert.equal(findings[0].put_back, 'still different after put back');
  assert.equal(owners[0].still_different, 1);
});

// ---- the first owner: start-a-computer, a host's layout row ----
const layout = {
  caddy: { site_hosts: ['place.example.test'], port: 7199, releases: '/opt/example/releases' },
  units: [{
    unit: 'example-place.service', template: 'serve-place', description: 'Example place', user: 'example-place',
    releases: '/opt/example/releases', engine_file: 'example-engine', data_env: 'EXAMPLE_DATA_ROOT', data_dir: 'product',
    config: '/var/lib/example-place/place.json', launch_setting: 'EXAMPLE_SETTINGS', writable: ['/var/lib/example-place'],
    product_settings: '/var/lib/example-place/product-settings.json',
    drop_ins: ['nofile'],
  }],
  unmanaged: [],
};
const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };

// A stand-in computer: its files in memory, and every command it ran.
const standInComputer = files => {
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push(command);
    let m;
    if ((m = command.match(/^if \[ -f '([^']+)' \]/))) { if (files[m[1]] === undefined) throw Object.assign(new Error('absent'), { code: 3 }); return files[m[1]]; }
    if ((m = command.match(/^if \[ -d '([^']+)' \]/))) return Object.keys(files).filter(path => path.startsWith(`${m[1]}/`) && path.endsWith('.conf')).map(path => path.slice(m[1].length + 1)).join('\n');
    if ((m = command.match(/install (?:-d -m 0755 '[^']+' && install )?-m 0\d+ -o \S+ -g \S+ \/dev\/stdin '([^']+)'$/))) { files[m[1]] = input; return ''; }
    if ((m = command.match(/^mv '([^']+)' '([^']+)'$/))) { files[m[2]] = files[m[1]]; delete files[m[1]]; return ''; }
    if ((m = command.match(/&& mv '([^']+)' '([^']+)'$/))) { files[m[2]] = files[m[1]]; delete files[m[1]]; return ''; }
    if ((m = command.match(/^cp -p '([^']+)' '([^']+)'$/))) { files[m[2]] = files[m[1]]; return ''; }
    if (command.includes('curl')) return '200';
    return '';
  };
  return { run, commands, files };
};
// The owner module as the reconciler loads it, with the stand-in computer in place of SSH.
const computerLoader = computer => async () => ({
  ...computerOwner,
  hostLayoutDifferences: (m, l) => computerOwner.hostLayoutDifferences(m, l, computer.run),
  applyHostLayout: (m, l) => computerOwner.applyHostLayout(m, l, computer.run),
});
const computerDeclaration = {
  owner: 'owner:start-a-computer', module: '../start-a-computer/do-work/start-a-computer.mjs',
  differences: 'hostLayoutDifferences', put_back: 'applyHostLayout', interval_seconds: 300,
  things: [{ thing: 'computer:example', args: [machine, layout] }],
};

test('a hand edit to a computer\'s Caddy file, and a unit drop-in placed by hand, are reported and put back from its layout row', async () => {
  const rendered = Object.fromEntries(renderLayout(layout, computerOwner.SITE_BLOCK).map(({ path, text }) => [path, text]));
  const computer = standInComputer({ ...rendered, '/etc/caddy/Caddyfile': 'edited by hand over ssh\n', '/etc/systemd/system/example-place.service.d/by-hand.conf': '[Service]\n' });
  const { findings, owners } = await reconcile([computerDeclaration], { now: NOW, load: computerLoader(computer), base: here });
  assert.deepEqual(findings.map(row => [row.owner, row.thing, row.difference.path, row.difference.reason, row.put_back]), [
    ['owner:start-a-computer', 'computer:example', '/etc/caddy/Caddyfile', 'differs from the layout', 'put back'],
    ['owner:start-a-computer', 'computer:example', '/etc/systemd/system/example-place.service.d/by-hand.conf', 'not in the layout', 'put back'],
  ]);
  assert.equal(computer.files['/etc/caddy/Caddyfile'], rendered['/etc/caddy/Caddyfile']);
  assert.equal(computer.files['/etc/systemd/system/example-place.service.d/by-hand.conf'], undefined, 'the undeclared drop-in no longer loads');
  assert.ok(Object.keys(computer.files).some(path => path.startsWith('/etc/caddy/Caddyfile.bak-')), 'the hand edit is kept beside it');
  assert.deepEqual(owners[0], { owner: 'owner:start-a-computer', things: 1, differences: 2, put_back: 2, still_different: 0, errors: 0 });
});

test('both owners in one pass, from one declarations file, with no reconciler code naming either', async () => {
  const dir = scratch(), folder = join(dir, 'served');
  mkdirSync(folder);
  writeFileSync(join(folder, 'a.txt'), 'by hand\n');
  const rendered = Object.fromEntries(renderLayout(layout, computerOwner.SITE_BLOCK).map(({ path, text }) => [path, text]));
  const computer = standInComputer({ ...rendered, '/etc/systemd/system/example-place.service': 'by hand\n' });
  const file = join(dir, 'owners.json');
  writeFileSync(file, JSON.stringify({ kind: 'what-runs-owners', owners: [{ ...computerDeclaration, module: join(here, '../../start-a-computer/do-work/start-a-computer.mjs') }, folderDeclaration(folder)] }));
  const declarations = readDeclarations(file);
  const real = async path => import(path);
  const load = async path => (path.endsWith('start-a-computer.mjs') ? computerLoader(computer)() : real(path));
  const { findings } = await reconcile(declarations, { now: NOW, load });
  assert.deepEqual(findings.map(row => [row.owner, row.put_back]).sort(), [
    ['owner:files-in-a-folder', 'put back'], ['owner:files-in-a-folder', 'put back'], ['owner:start-a-computer', 'put back'],
  ]);
});

test('a thing whose owner cannot read what runs is an error finding, not "no difference"', async () => {
  const failing = { run: async () => { throw Object.assign(new Error('ssh: connect to host 192.0.2.9 port 22: timed out'), { code: 255 }); } };
  const { findings, owners } = await reconcile([computerDeclaration], { now: NOW, load: computerLoader(failing), base: here });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].put_back, 'not read');
  assert.match(findings[0].error, /timed out/);
  assert.equal(owners[0].errors, 1);
});

test('declarations are refused when a field is missing, and a thing\'s row may live in its own file', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'layout.json'), JSON.stringify(layout));
  writeFileSync(join(dir, 'owners.json'), JSON.stringify({ kind: 'what-runs-owners', owners: [{ ...computerDeclaration, things: [{ thing: 'computer:example', args: [machine, { $file: 'layout.json' }] }] }] }));
  const [declaration] = readDeclarations(join(dir, 'owners.json'));
  assert.deepEqual(declaration.things[0].args[1], layout);
  assert.equal(declaration.module, join(dir, '../start-a-computer/do-work/start-a-computer.mjs'));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ kind: 'what-runs-owners', owners: [{ owner: 'owner:x', module: 'x.mjs', things: [] }] }));
  assert.throws(() => readDeclarations(join(dir, 'bad.json')), /owner:x needs differences/);
});

test('each owner is due on its own data interval', () => {
  const owners = [{ owner: 'owner:a', interval_seconds: 60 }, { owner: 'owner:b', interval_seconds: 600 }];
  const last = { 'owner:a': '2026-11-14T02:58:00Z', 'owner:b': '2026-11-14T02:58:00Z' };
  assert.deepEqual(dueOwners(owners, last, NOW).map(o => o.owner), ['owner:a']);
  assert.deepEqual(dueOwners(owners, {}, NOW).map(o => o.owner), ['owner:a', 'owner:b']);
});

test('the reconciler names no owner, host, file kind or thing', () => {
  const source = readFileSync(new URL('../do-work/put-back-what-runs.mjs', import.meta.url), 'utf8');
  for (const word of ['start-a-computer', 'caddy', 'Caddy', 'systemd', 'hostLayout', 'applyHostLayout', 'ssh', '/etc/', '.service', 'better-auth', 'folder:']) {
    assert.ok(!source.includes(word), `the reconciler names ${word}`);
  }
  assert.ok(!/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(source), 'the reconciler names an address');
});
