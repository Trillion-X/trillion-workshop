// tools/start-a-computer/test/plan-an-apply.test.mjs
//
// The plan of an apply: the apply's own steps run through readsOnly, so the computer is read and never changed, and the answer says
// which files the apply would write, which units it would restart and what it would remove, with every changing command held back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computerRowPlan, plannedFrom, readsOnly } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';

const runs = {
  health_listen: '127.0.0.1:7199',
  units: [{
    unit: 'example-place.service', template: 'tools/keep-an-engine-on-a-computer/serve-computer.service', description: 'Example place', user: 'example-place',
    state: '/var/lib/example-place', builds: '/var/lib/example-place/builds', program: 'example-engine',
    settings_file: '/etc/example-place/computer.json', settings: { listen: '127.0.0.1:7199' }, writable: '/var/lib/example-place',
  }, {
    unit: 'example-other.service', template: 'tools/keep-an-engine-on-a-computer/serve-computer.service', description: 'Example other', user: 'example-other',
    state: '/var/lib/example-other', builds: '/var/lib/example-other/builds', program: 'example-engine',
    settings_file: '/etc/example-other/computer.json', settings: { listen: '127.0.0.1:7198' }, writable: '/var/lib/example-other',
  }],
  unmanaged: [],
};
const request = { machine: { address: '192.0.2.9', name: 'example' }, ssh: { known_hosts: '/dev/null' }, computer_row: { name: 'example', address: '192.0.2.9', runs } };

// A computer that answers reads from `live` and records every command it is sent.
const computer = live => {
  const sent = [];
  const run = async (_machine, command, input) => {
    sent.push(command);
    if (command.includes('sha256sum')) return String(input ?? '').split('\n').filter(path => path && live[path] !== undefined).map(path => `${createHash('sha256').update(live[path]).digest('hex')}  ${path}\n`).join('');
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    // A set-up computer's firewall admits the ports set-up's settings name.
    if (command.startsWith('ufw status')) return `Status: active\n\nTo Action From\n${['22/tcp', '80/tcp', '443/tcp'].map(port => `${port}                     ALLOW       Anywhere`).join('\n')}\n`;
    return '';
  };
  return { run, sent };
};
const CHANGING = /^(sh -s|install |cp |mv |rm |systemctl (restart|enable|daemon-reload|disable)|while IFS= read -r p; do rm)/;

test('a computer that runs its row as rendered plans nothing and is sent only reads', async () => {
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  const { run, sent } = computer(live);
  const plan = await computerRowPlan(request, { run });
  assert.deepEqual(plan, { written: [], restarted: [], removed: [], not_run: [] });
  assert.equal(sent.filter(command => CHANGING.test(command)).length, 0);
});

test('a file that differs is planned as written and its unit as restarted, the other unit untouched, and nothing changing is sent', async () => {
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  live['/etc/systemd/system/example-place.service'] = 'an older unit\n';
  const { run, sent } = computer(live);
  const plan = await computerRowPlan(request, { run });
  assert.deepEqual(plan.written, ['/etc/systemd/system/example-place.service']);
  assert.deepEqual(plan.restarted, ['example-place.service']);
  assert.deepEqual(plan.removed, []);
  assert.ok(plan.not_run.some(command => command.startsWith("cp -p '/etc/systemd/system/example-place.service'")), 'the backup copy is held back');
  assert.ok(!plan.not_run.some(command => command.includes('example-other')), 'the unit whose files match is in no changing command');
  assert.equal(sent.filter(command => CHANGING.test(command)).length, 0, 'the computer was sent no changing command');
});

test('readsOnly sends the apply\'s reads and holds back every write, redirect, download and restart', async () => {
  const { run, sent } = computer({ '/etc/example': 'x\n' });
  const reads = readsOnly(run);
  for (const command of ["if [ -f '/etc/example' ]; then cat '/etc/example'; else exit 3; fi", "test -x '/usr/bin/node'", "systemctl is-active --quiet 'example.service' || exit 3", "dpkg -s 'curl' >/dev/null 2>&1 || exit 3"]) await reads.run(null, command);
  for (const command of ["cat > '/etc/example'", "test -d /x && rm -rf -- '/x'", "systemctl restart 'example.service'", "if [ -f '/a' ]; then curl -fsS https://example.test; fi", "cp -p '/a' '/b'", 'sh -s -- {}']) assert.equal(await reads.run(null, command), '');
  assert.equal(sent.length, 4);
  assert.equal(reads.notRun.length, 6);
});

test('plannedFrom reads the files, units and removals from held-back commands', () => {
  assert.deepEqual(plannedFrom([
    "install -d -m 0755 '/etc/x' && t=$(mktemp '/etc/x/.write.XXXXXX') && cat > \"$t\" && chmod 0644 \"$t\" && chown root:root \"$t\" && mv -f \"$t\" '/etc/x/a.conf'",
    "systemctl restart 'a.service'", "systemctl enable --now 'b.service' >/dev/null 2>&1", "rm -rf -- '/etc/old'", "systemctl restart 'a.service'",
  ]), { written: ['/etc/x/a.conf'], restarted: ['a.service', 'b.service'], removed: ['/etc/old'] });
});
