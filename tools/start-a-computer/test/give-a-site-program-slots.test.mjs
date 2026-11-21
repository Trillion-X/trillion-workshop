// tools/start-a-computer/test/give-a-site-program-slots.test.mjs
//
// A site's program becomes slots in two applies: start gives each slot its own socket in a folder of the slots' own and has the
// front door try every slot, then the old socket; retire removes the old unit and its socket. Each run changes only what is
// not yet so, and what the rows render is a slot unit per slot and the front door's socket list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { giveASiteProgramSlots } from '../do-work/give-a-site-program-slots.mjs';
import { renderWhatItRuns, withSlots } from '../do-work/render-what-a-computer-runs.mjs';

const site = 'place.example.test', old = `/run/sites/${site}/http.sock`;
const runs = {
  units: [
    { unit: 'place-site.service', template: 'tools/start-a-computer/read-data/unit-templates/serve-a-built-program.service', description: 'Example site',
      user: 'place-site', group: 'caddy', state: '/var/lib/place-site', builds: '/var/lib/place-site/builds', program: 'serve.cjs',
      interpreter: '/opt/node/bin/node', writable: '/var/lib/place-site', credentials: [], runtime_directory: `sites/${site}`,
      environment: `SOCKET=${old}`, check_command: `curl -sf --unix-socket ${old} http://${site}/ >/dev/null` },
    { unit: 'other-site.service', runtime_directory: 'sites/other.example.test', environment: 'SOCKET=/run/sites/other.example.test/http.sock' },
    { unit: 'caddy.service', site: { site_file: 'each-name-its-own-folder', site_sockets: { 'other.example.test': ['/run/x/http-a.sock'] } } },
  ],
  absent: ['/etc/kept-absent'],
};
const sock = slot => `/run/sites/${site}-slots/http-${slot}.sock`;

test('start gives each slot its own socket and check, and the front door every slot first, then the old socket', () => {
  const { runs: started, changed } = giveASiteProgramSlots(runs, { site });
  const unit = started.units[0];
  assert.deepEqual(unit.slots, {
    a: { environment: `SOCKET=${sock('a')}`, check_command: `curl -sf --unix-socket ${sock('a')} http://${site}/ >/dev/null` },
    b: { environment: `SOCKET=${sock('b')}`, check_command: `curl -sf --unix-socket ${sock('b')} http://${site}/ >/dev/null` },
  });
  assert.equal(unit.environment, undefined);
  assert.equal(unit.check_command, undefined);
  assert.equal(unit.runtime_directory, `sites/${site}-slots`);
  assert.equal(unit.runtime_preserve, 'yes');
  assert.deepEqual(started.units[2].site.site_sockets, { 'other.example.test': ['/run/x/http-a.sock'], [site]: [sock('a'), sock('b'), old] });
  assert.deepEqual(started.units[1], runs.units[1], 'another site is left alone');
  assert.deepEqual(started.absent, ['/etc/kept-absent']);
  assert.ok(changed.length >= 5);
  assert.equal(runs.units[0].slots, undefined, 'the given runs are not changed');
  assert.deepEqual(giveASiteProgramSlots(started, { site }).changed, [], 'a second start changes nothing');

  const files = new Map(renderWhatItRuns(withSlots({ units: [unit] })).map(file => [file.path, file.text]));
  assert.deepEqual([...files.keys()].sort(), ['/etc/systemd/system/place-site-a.service', '/etc/systemd/system/place-site-b.service']);
  assert.match(files.get('/etc/systemd/system/place-site-b.service'), new RegExp(`^Environment=SOCKET=${sock('b').replace(/\./g, '\\.')}$`, 'm'));
  assert.match(files.get('/etc/systemd/system/place-site-b.service'), /^RuntimeDirectoryPreserve=yes$/m);
});

test('retire, after start, removes the old unit and its socket; it needs start first', () => {
  const { runs: started } = giveASiteProgramSlots(runs, { site, slots: ['blue', 'green'] });
  const { runs: retired, changed } = giveASiteProgramSlots(started, { site, phase: 'retire' });
  assert.deepEqual(retired.units[2].site.site_sockets[site], [sock('blue'), sock('green')]);
  assert.deepEqual(retired.absent, ['/etc/kept-absent', '/etc/systemd/system/place-site.service']);
  assert.equal(changed.length, 2);
  assert.deepEqual(giveASiteProgramSlots(retired, { site, phase: 'retire' }).changed, [], 'a second retire changes nothing');
  assert.throws(() => giveASiteProgramSlots(runs, { site, phase: 'retire' }), /no slots yet/);
});

test('a site no one unit serves, a bad slot name or phase is refused', () => {
  assert.throws(() => giveASiteProgramSlots(runs, { site: 'missing.example.test' }), /0 units serve/);
  assert.throws(() => giveASiteProgramSlots(runs, { site, slots: ['a'] }), /two or more/);
  assert.throws(() => giveASiteProgramSlots(runs, { site, slots: ['a', 'A'] }), /small letters/);
  assert.throws(() => giveASiteProgramSlots(runs, { site, phase: 'later' }), /start or retire/);
  assert.throws(() => giveASiteProgramSlots({ ...runs, units: runs.units.slice(0, 2) }, { site }), /0 front doors/);
});

test('run as a program through a linked path, it edits the computer row file in place and prints each change', () => {
  const folder = mkdtempSync(join(tmpdir(), 'slots-'));
  const file = join(folder, 'computer.json'), linked = join(folder, 'linked.mjs');
  writeFileSync(file, JSON.stringify({ address: '192.0.2.9', runs }));
  symlinkSync(new URL('../do-work/give-a-site-program-slots.mjs', import.meta.url).pathname, linked);
  const said = execFileSync(process.execPath, [linked, file, site, 'start'], { encoding: 'utf8' });
  assert.match(said, /^start place\.example\.test: \n/);
  const row = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(row.address, '192.0.2.9');
  assert.deepEqual(Object.keys(row.runs.units[0].slots), ['a', 'b']);
  assert.match(execFileSync(process.execPath, [linked, file, site], { encoding: 'utf8' }), /nothing to change/);
});

// A unit that serves two names (its runtime_directory lists both folders, its SOCKET one socket per name): each slot listens on
// one socket per name, in the unit's order, and the front door sends each name to its own slots, then its old socket.
const two = 'example.com', twoOther = 'www.example.com';
const twoOld = `/run/sites/${two}/http.sock`, twoOtherOld = `/run/sites/${twoOther}/http.sock`;
const twoName = {
  units: [
    { unit: 'site-two.service', template: 'tools/start-a-computer/read-data/unit-templates/serve-a-built-program.service', description: 'Example site, two names',
      user: 'site-two', group: 'caddy', state: '/var/lib/site-two', builds: '/var/lib/site-two/builds', program: 'serve.cjs',
      interpreter: '/opt/node/bin/node', writable: '/var/lib/site-two', credentials: [], runtime_directory: `sites/${two} sites/${twoOther}`,
      environment: `SOCKET=${twoOld},${twoOtherOld}`, check_command: `curl -sf --unix-socket ${twoOld} http://${two}/ >/dev/null` },
    { unit: 'caddy.service', site: { site_file: 'each-name-its-own-folder', site_sockets: { 'other.example.com': ['/run/x/http-a.sock'] } } },
  ],
  absent: [],
};
const sockA = '/run/sites/example.com-slots/http-a.sock', sockB = '/run/sites/example.com-slots/http-b.sock';
const otherA = '/run/sites/example.com-slots/www.example.com-http-a.sock', otherB = '/run/sites/example.com-slots/www.example.com-http-b.sock';

test('a two-name unit: each slot gets one socket per name, the front door each name its slots then its old socket, and a second start changes nothing', () => {
  const { runs: started, changed } = giveASiteProgramSlots(twoName, { site: two });
  const unit = started.units[0];
  assert.deepEqual(unit.slots, {
    a: { environment: `SOCKET=${sockA},${otherA}`, check_command: `curl -sf --unix-socket ${sockA} http://${two}/ >/dev/null` },
    b: { environment: `SOCKET=${sockB},${otherB}`, check_command: `curl -sf --unix-socket ${sockB} http://${two}/ >/dev/null` },
  });
  assert.equal(unit.runtime_directory, 'sites/example.com-slots');
  assert.equal(unit.runtime_preserve, 'yes');
  assert.deepEqual(started.units[1].site.site_sockets, {
    'other.example.com': ['/run/x/http-a.sock'],
    [two]: [sockA, sockB, twoOld],
    [twoOther]: [otherA, otherB, twoOtherOld],
  });
  assert.ok(changed.length >= 6);
  assert.deepEqual(giveASiteProgramSlots(started, { site: two }).changed, [], 'a second start changes nothing');

  const files = new Map(renderWhatItRuns(withSlots({ units: [unit] })).map(file => [file.path, file.text]));
  assert.match(files.get('/etc/systemd/system/site-two-b.service'), /^Environment=SOCKET=\/run\/sites\/example\.com-slots\/http-b\.sock,\/run\/sites\/example\.com-slots\/www\.example\.com-http-b\.sock$/m);
});

test('a two-name unit: retire, after start, drops every name\'s old socket and puts the old unit in runs.absent', () => {
  const { runs: started } = giveASiteProgramSlots(twoName, { site: two });
  const { runs: retired, changed } = giveASiteProgramSlots(started, { site: two, phase: 'retire' });
  assert.deepEqual(retired.units[1].site.site_sockets, { 'other.example.com': ['/run/x/http-a.sock'], [two]: [sockA, sockB], [twoOther]: [otherA, otherB] });
  assert.deepEqual(retired.absent, ['/etc/systemd/system/site-two.service']);
  assert.equal(changed.length, 3);
  assert.deepEqual(giveASiteProgramSlots(retired, { site: two, phase: 'retire' }).changed, [], 'a second retire changes nothing');
});

test('a two-name unit whose environment names only one of its sockets is refused', () => {
  const short = structuredClone(twoName);
  short.units[0].environment = `SOCKET=${twoOld}`;
  assert.throws(() => giveASiteProgramSlots(short, { site: two }), /names no \/run\/sites\/www\.example\.com\/http\.sock/);
});
