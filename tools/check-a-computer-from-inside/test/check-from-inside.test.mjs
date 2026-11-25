// tools/check-a-computer-from-inside: each disk past its line is one finding, an engine whose row names a person but holds
// none is held again on its own agent socket and told, a computer that does not answer is one finding, and a pretended
// reading makes the same findings without asking the engine anything. Every computer here is made up (192.0.2.x).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkFromInside, enginesOf, holdAgainScript, readScript, unitsOf } from '../do-work/check-from-inside.mjs';

const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMadeUpMadeUpMadeUpMadeUpMadeUpMadeUpMadeUp';
const OWNER = 'made-up-person_0001';
const engineUnit = { unit: 'engine-for-someone.service', user: 'engine-for-someone', program: 'the-engine',
  slots: { a: { health_listen: '127.0.0.1:7199' }, b: { health_listen: '127.0.0.1:7198' } },
  settings: { agent_socket: '/var/lib/engine-for-someone/agent.sock', persons: '/var/lib/engine-for-someone/persons', local_agents: [{ id: 'root', uid: 0, person: OWNER }] } };
const gatewayUnit = { unit: 'passes-requests.service', user: 'passes-requests', program: 'the-engine', health_listen: '127.0.0.1:7299', settings: { listen: '127.0.0.1:7299', persons: '/var/lib/passes-requests/persons' } };
// An engine run as a container: no program of its own in the row, its settings on the unit that hands it its key.
const containerUnit = { unit: 'engine-key.service', user: 'engine-in-a-box', command: '/bin/sleep infinity', ready_in_container: 'the-engine-1',
  settings: { listen: '127.0.0.1:7199', persons: '/var/lib/engine-in-a-box/persons', agent_socket: '/var/lib/engine-in-a-box/agent.sock', local_agents: [{ id: 'root', uid: 0, person: OWNER }] } };
const siteUnit = { unit: 'a-site.service', user: 'a-site', program: 'serve.mjs' };
const computer = (units, more = {}) => ({ name: 'made-up', address: '192.0.2.10', host_key: HOST_KEY, engine_program: 'the-engine', runs: { units }, row_read_at: new Date().toISOString(), ...more });

const DF = [
  'Filesystem     Type     1024-blocks        Used   Available Capacity Mounted on',
  '/dev/sda1      ext4     40000000000 20000000000 20000000000      50% /',
  'tmpfs          tmpfs     1000000000           0  1000000000       0% /run',
  '/dev/sda15     vfat       264281088      148992   264132096       1% /boot/efi',
].join('\n');
const ready = persons => JSON.stringify({ draining: false, persons, offers: [] });

/** A made-up computer: answers each script with the df above and each listen's ready answer from `answers`. */
function computerAnswering(answers, { addStatus = '200', afterAdd = {}, folders = '', systemd = {} } = {}) {
  const scripts = [];
  let added = false;
  const run = script => {
    scripts.push(script);
    if (script.includes('/persons/add')) { added = true; return { status: 0, stdout: `${addStatus}\n`, stderr: '' }; }
    const now = added ? { ...answers, ...afterAdd } : answers;
    const lines = [];
    for (const line of script.split('\n')) {
      const mark = line.match(/^echo '@@(\w+)(?: (\d+))?(?: (\S+))?'$/);
      if (!mark) continue;
      lines.push(`@@${mark[1]}${mark[2] ? ` ${mark[2]}` : ''}${mark[3] ? ` ${mark[3]}` : ''}`);
      if (mark[1] === 'persons') lines.push(folders);
      if (mark[1] === 'df') lines.push(DF);
      if (mark[1] === 'units') for (const unitLine of script.split('\n').filter(item => /^echo 'unit /.test(item))) {
        const name = unitLine.slice("echo 'unit ".length, -1);
        const [load, active, result] = systemd[name] ?? ['loaded', 'inactive', 'success'];
        lines.push(`unit ${name}`, `Result=${result}`, `LoadState=${load}`, `ActiveState=${active}`);
      }
      if (mark[1] === 'ready') lines.push(now[mark[3]] ?? '');
    }
    return { status: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  };
  return { run, scripts };
}

test('an engine is read from its row: its slots, its agent socket and the persons it must hold', () => {
  const [engine, gateway] = enginesOf({ units: [engineUnit, gatewayUnit, siteUnit] });
  assert.deepEqual(engine, { unit: 'engine-for-someone.service', user: 'engine-for-someone', listens: ['127.0.0.1:7199', '127.0.0.1:7198'], persons_folder: '/var/lib/engine-for-someone/persons', container: null, socket: '/var/lib/engine-for-someone/agent.sock', owners: [OWNER] });
  assert.deepEqual(gateway.owners, [], 'an engine whose row names no local agent must hold no one');
  assert.equal(enginesOf({ units: [siteUnit] }).length, 0, 'a unit with no ready check is no engine');
  assert.equal(enginesOf({ units: [{ ...engineUnit, program: 'anything-else' }] }).length, 1, 'an engine is found by its ready check, whatever program it runs');
  assert.equal(enginesOf({ units: [{ ...engineUnit, settings: { ...engineUnit.settings, persons: undefined } }] }).length, 0, 'a listen address with no persons folder is no engine');
  assert.equal(enginesOf({ units: [{ ...gatewayUnit, health_listen: '0.0.0.0:7299', settings: { listen: '0.0.0.0:7299', persons: '/p' } }] }).length, 0, 'only a loopback address is asked');
});

test('a disk under its warning line and an engine that holds its person are no finding', async () => {
  const { run } = computerAnswering({ '127.0.0.1:7198': ready(1) });
  const seen = await checkFromInside(computer([engineUnit]), { run });
  assert.equal(seen.checked, true);
  assert.deepEqual(seen.disks.map(disk => [disk.mount, disk.used_pct]), [['/', 50], ['/boot/efi', 0.1]], 'memory filesystems are left out');
  assert.equal(seen.engines[0].persons, 1);
  assert.deepEqual(seen.findings, []);
});

test('a disk pretended 86% full warns and one pretended 93% full alerts, each saying it was pretended', async () => {
  const { run } = computerAnswering({ '127.0.0.1:7198': ready(1) });
  const warned = await checkFromInside(computer([engineUnit], { pretend: { disks: { '/': 86 } } }), { run });
  assert.deepEqual(warned.findings.map(finding => [finding.kind, finding.level, finding.about, finding.pretend]), [['disk-filling', 'warn', '/', true]]);
  const alerted = await checkFromInside(computer([engineUnit], { pretend: { disks: { '/': 93 } } }), { run });
  assert.deepEqual(alerted.findings.map(finding => [finding.kind, finding.level, finding.pretend]), [['disk-nearly-full', 'alert', true]]);
  assert.match(alerted.findings[0].said, /93% full/);
  const own = await checkFromInside(computer([engineUnit], { warn_used_pct: 40, alert_used_pct: 60 }), { run });
  assert.deepEqual(own.findings.map(finding => finding.kind), ['disk-filling'], 'the caller\'s own lines replace the settings');
});

test('an engine that holds no one is held again as its own user on its own socket, then read again and told', async () => {
  const { run, scripts } = computerAnswering({ '127.0.0.1:7198': ready(0) }, { afterAdd: { '127.0.0.1:7198': ready(1) } });
  const seen = await checkFromInside(computer([engineUnit]), { run });
  const add = scripts.find(script => script.includes('/persons/add'));
  assert.match(add, /^runuser -u engine-for-someone -- curl /);
  assert.match(add, /--unix-socket \/var\/lib\/engine-for-someone\/agent\.sock -X POST/);
  assert.ok(add.includes(`--data '{"person":"${OWNER}"}'`));
  assert.deepEqual(seen.engines[0].held_again, { person: OWNER, status: '200', persons: 1 });
  assert.deepEqual(seen.findings.map(finding => [finding.kind, finding.level]), [['engine-held-no-person', 'warn']]);
  assert.match(seen.findings[0].said, /held again .* now holds 1/);
});

test('an engine that stays empty after it is held again is an alert', async () => {
  const { run } = computerAnswering({ '127.0.0.1:7198': ready(0) }, { addStatus: '403' });
  const seen = await checkFromInside(computer([engineUnit]), { run });
  assert.deepEqual(seen.findings.map(finding => [finding.kind, finding.level]), [['engine-held-no-person', 'alert']]);
  assert.match(seen.findings[0].said, /answered 403/);
});

test('a pretended empty engine is told as an alert and its engine is never asked to hold anyone', async () => {
  const { run, scripts } = computerAnswering({ '127.0.0.1:7198': ready(1) });
  const seen = await checkFromInside(computer([engineUnit], { pretend: { engines: { 'engine-for-someone.service': 0 } } }), { run });
  assert.equal(scripts.some(script => script.includes('/persons/add')), false);
  assert.deepEqual(seen.findings.map(finding => [finding.kind, finding.level, finding.pretend]), [['engine-held-no-person', 'alert', true]]);
});

test('with hold_again false an empty engine is only told', async () => {
  const { run, scripts } = computerAnswering({ '127.0.0.1:7198': ready(0) });
  const seen = await checkFromInside(computer([engineUnit], { hold_again: false }), { run });
  assert.equal(scripts.some(script => script.includes('/persons/add')), false);
  assert.deepEqual(seen.findings.map(finding => finding.level), ['alert']);
});

test('an engine whose row names no person may hold none, and an engine that answers on no address is an alert', async () => {
  const quiet = computerAnswering({ '127.0.0.1:7299': ready(0) });
  assert.deepEqual((await checkFromInside(computer([gatewayUnit]), { run: quiet.run })).findings, []);
  const silent = computerAnswering({});
  const seen = await checkFromInside(computer([engineUnit]), { run: silent.run });
  assert.deepEqual(seen.findings.map(finding => [finding.kind, finding.level]), [['engine-not-answering', 'alert']]);
});

test('a computer with no engine is read for its disks alone', async () => {
  const { run, scripts } = computerAnswering({});
  const seen = await checkFromInside(computer([siteUnit], { pretend: { disks: { '/': 93 } } }), { run });
  assert.equal(scripts[0].includes('@@ready'), false);
  assert.deepEqual(seen.engines, []);
  assert.deepEqual(seen.findings.map(finding => finding.kind), ['disk-nearly-full']);
});

test('a computer that does not answer is one alert, and one with no usable address is not checked', async () => {
  const lost = await checkFromInside(computer([engineUnit]), { run: () => ({ status: 255, stdout: '', stderr: 'ssh: connect to host 192.0.2.10 port 22: Operation timed out\n' }) });
  assert.equal(lost.checked, false);
  assert.deepEqual(lost.findings.map(finding => [finding.kind, finding.level, finding.about]), [['unreachable', 'alert', '192.0.2.10']]);
  assert.match(lost.findings[0].said, /timed out/);
  const pretended = await checkFromInside(computer([engineUnit], { pretend: { unreachable: true } }), { run: () => assert.fail('a pretended lost computer is not asked') });
  assert.deepEqual(pretended.findings.map(finding => [finding.kind, finding.pretend]), [['unreachable', true]]);
  const given = await checkFromInside(computer([engineUnit], { address: 'none: given back' }), { run: () => assert.fail('not asked') });
  assert.deepEqual([given.checked, given.findings], [false, []]);
  const keyless = await checkFromInside(computer([engineUnit], { host_key: undefined }), { run: () => assert.fail('not asked') });
  assert.match(keyless.why, /host_key is missing/);
});

test('every unit the row runs is asked of systemd: a failed run, a stopped timer and a missing unit are findings', async () => {
  const backup = { unit: 'a-backup.service', user: 'postgres' };
  const timer = { unit: 'a-backup.timer', runs: 'a-backup.service' };
  const watch = { unit: 'a-watch.path' };
  const gone = { unit: 'a-gone.service' };
  const units = [engineUnit, siteUnit, backup, timer, watch, gone];
  assert.deepEqual(unitsOf({ units }), ['a-site.service', 'a-backup.service', 'a-backup.timer', 'a-watch.path', 'a-gone.service'], 'a unit run in slots is read as its engine');
  const { run, scripts } = computerAnswering({ '127.0.0.1:7198': ready(1) }, { systemd: {
    'a-site.service': ['loaded', 'active', 'success'], 'a-backup.service': ['loaded', 'failed', 'exit-code'],
    'a-backup.timer': ['loaded', 'inactive', 'success'], 'a-watch.path': ['loaded', 'active', 'success'], 'a-gone.service': ['not-found', 'inactive', 'success'] } });
  const seen = await checkFromInside(computer(units), { run });
  assert.match(scripts[0], /^systemctl show -p LoadState -p ActiveState -p Result 'a-backup\.service' 2>\/dev\/null$/m);
  assert.deepEqual(seen.units.find(unit => unit.unit === 'a-backup.service'), { unit: 'a-backup.service', load: 'loaded', active: 'failed', result: 'exit-code' });
  assert.deepEqual(seen.findings.map(finding => [finding.kind, finding.level, finding.about]), [
    ['unit-failed', 'alert', 'a-backup.service'], ['unit-not-running', 'alert', 'a-backup.timer'], ['unit-missing', 'warn', 'a-gone.service']]);
  assert.match(seen.findings[0].said, /a-backup\.service last ended in exit-code, not success/);
  const pretended = await checkFromInside(computer([siteUnit], { pretend: { units: { 'a-site.service': 'exit-code' } } }), { run });
  assert.deepEqual(pretended.findings.map(finding => [finding.kind, finding.about, finding.pretend]), [['unit-failed', 'a-site.service', true]]);
  assert.throws(() => readScript([], ['a unit; rm -rf /']), /A unit name was refused/);
});

test('only the row\'s runs as read now are checked: no units list, or a row read too long ago, is not checked at all', async () => {
  const notAsked = { run: () => assert.fail('a computer is not asked without the row\'s units as read now') };
  for (const runs of [undefined, {}, { units: null }, { units: 'a-site.service' }]) {
    const seen = await checkFromInside({ ...computer([]), runs }, notAsked);
    assert.deepEqual([seen.checked, seen.findings], [false, []]);
    assert.match(seen.why, /runs\.units was not given/);
  }
  // Nov 25 2026: a copy of a row read 44 minutes before its check named five units another apply had removed.
  const stale = await checkFromInside(computer([siteUnit], { row_read_at: new Date(Date.now() - 44 * 60_000).toISOString() }), notAsked);
  assert.equal(stale.checked, false);
  assert.match(stale.why, /read 26\d\d s before this check, more than 300 s/);
  const later = await checkFromInside(computer([siteUnit], { row_read_at: new Date(Date.now() + 10 * 60_000).toISOString() }), notAsked);
  assert.match(later.why, /is after this check began/);
  const garbled = await checkFromInside(computer([siteUnit], { row_read_at: 'this morning' }), notAsked);
  assert.match(garbled.why, /row_read_at was refused/);
  const untold = await checkFromInside(computer([siteUnit], { row_read_at: undefined }), notAsked);
  assert.match(untold.why, /row_read_at was not given/);
});

test('a row read just now is checked unit by unit, and the units asked are answered with it', async () => {
  const readAt = new Date(Date.now() - 5_000).toISOString();
  const { run } = computerAnswering({}, { systemd: { 'a-site.service': ['loaded', 'active', 'success'], 'a-dropped.service': ['not-found', 'inactive', 'success'] } });
  const seen = await checkFromInside(computer([siteUnit, { unit: 'a-dropped.service' }], { row_read_at: readAt }), { run });
  assert.equal(seen.checked, true);
  assert.equal(seen.row_read_at, readAt);
  assert.deepEqual(seen.units_asked, ['a-site.service', 'a-dropped.service']);
  assert.deepEqual(seen.findings.map(finding => [finding.kind, finding.about]), [['unit-missing', 'a-dropped.service']]);
  const none = await checkFromInside(computer([]), { run: computerAnswering({}).run });
  assert.deepEqual([none.checked, none.units_asked], [true, []], 'a computer that runs no unit is checked for its disks');
});

test('nothing outside its shape is written into a command', () => {
  assert.throws(() => holdAgainScript({ unit: 'x.service', user: 'engine', socket: '/tmp/a.sock; reboot' }, OWNER), /cannot be asked/);
  assert.throws(() => holdAgainScript({ unit: 'x.service', user: 'engine', socket: '/tmp/a.sock' }, "a'b"), /cannot be asked/);
  assert.throws(() => readScript([{ unit: 'x', listens: ['127.0.0.1:1; rm -rf /'] }]), /was refused/);
});

test('the row runs this script with the held key at the path its argument names, and packs the SSH helper beside it', () => {
  const { records } = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
  const row = records.map(record => record.payload).find(payload => payload.id === 'tool:check-a-computer-from-inside');
  const { argv, credential_mounts: mounts, files } = row.invoke;
  assert.equal(argv[1], '/opt/check-a-computer-from-inside/do-work/check-from-inside.mjs');
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].mount_path, argv[2], 'the key file the script reads is the one mounted');
  const packed = Object.fromEntries(files.package_files.map(item => [item.package, item.at]));
  assert.equal(packed['check-a-computer-from-inside'], '/opt/check-a-computer-from-inside');
  assert.equal(packed['administer-a-rented-host'], '/opt/administer-a-rented-host', 'the helper is imported as ../../administer-a-rented-host');
});

test('each person folder of an engine is measured with its largest files, and nothing is written', async () => {
  const unit = { ...engineUnit, settings: { ...engineUnit.settings, persons: '/var/lib/engine-for-someone/persons/' } };
  const folders = [`folder ${OWNER} 10737418240`, `file ${OWNER} 1360000000 tool-runs.sqlite`, `file ${OWNER} 52000000 kept/a file with spaces.bin`, 'folder other-person 4096'].join('\n');
  const { run, scripts } = computerAnswering({ '127.0.0.1:7198': ready(1) }, { folders });
  const seen = await checkFromInside(computer([unit]), { run });
  assert.match(scripts[0], /for d in \/var\/lib\/engine-for-someone\/persons\/\*\/; do .*du -sb .*find "\$d" -xdev -type f -printf .*head -5/);
  assert.doesNotMatch(scripts[0], /\brm\b|[^2]>|\bmv\b|\btruncate\b/, 'the read writes nothing (only errors go to /dev/null)');
  assert.deepEqual(seen.engines[0].person_folders, [
    { person: OWNER, bytes: 10737418240, largest: [{ path: 'tool-runs.sqlite', bytes: 1360000000 }, { path: 'kept/a file with spaces.bin', bytes: 52000000 }] },
    { person: 'other-person', bytes: 4096, largest: [] },
  ]);
  assert.deepEqual(seen.findings, [], 'a folder size is a reading, not a finding');
  assert.equal(seen.engines.length, 1);
  assert.equal((await checkFromInside(computer([engineUnit]), { run })).engines[0].person_folders.length, 2, 'a persons folder named with no trailing slash is measured the same');
});

test('an engine in a container is found by its ready check and asked inside that container\'s network', async () => {
  const [engine] = enginesOf({ units: [containerUnit, siteUnit] });
  assert.deepEqual(engine.container, { name: 'the-engine-1' });
  const { run, scripts } = computerAnswering({ '127.0.0.1:7199': ready(1) });
  const seen = await checkFromInside(computer([containerUnit], { engine_program: undefined }), { run });
  assert.match(scripts[0], /nsenter -t "\$\(docker inspect -f '\{\{\.State\.Pid\}\}' 'the-engine-1' 2>\/dev\/null\)" -n curl -s -m 5 http:\/\/127\.0\.0\.1:7199\/readyz/);
  assert.deepEqual([seen.engines[0].unit, seen.engines[0].persons], ['engine-key.service', 1]);
  assert.deepEqual(seen.findings, []);
  assert.equal(enginesOf({ units: [{ ...containerUnit, ready_in_container: "x'; reboot" }] })[0].container, null, 'a container name outside its shape is never written into a command');
  const byLabels = { ...containerUnit, ready_in_container: { compose_project: 'the-engine', service: 'engine' } };
  const labelled = computerAnswering({ '127.0.0.1:7199': ready(1) });
  const found = await checkFromInside(computer([byLabels], { engine_program: undefined }), { run: labelled.run });
  assert.ok(labelled.scripts[0].includes(`nsenter -t "$(docker inspect -f '{{.State.Pid}}' "$(docker ps -q --filter 'label=com.docker.compose.project=the-engine' --filter 'label=com.docker.compose.service=engine' | head -1)" 2>/dev/null)" -n curl`), 'a compose project and service find the container by its labels');
  assert.equal(found.engines[0].persons, 1);
  assert.equal(enginesOf({ units: [{ ...containerUnit, ready_in_container: { compose_project: "p'x", service: 'engine' } }] })[0].container, null, 'a label outside its shape is never written into a command');
});
