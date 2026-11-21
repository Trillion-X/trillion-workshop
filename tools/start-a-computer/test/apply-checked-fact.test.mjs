// tools/start-a-computer/test/apply-checked-fact.test.mjs
//
// The apply-checked fact of each restarted unit: its window, its check's result and the access log's error answers in that window
// (route, status, ip_hash, time; never a raw address). A failed apply still carries its fact on the error it throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyWhatItRuns } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };
const SETTINGS = '/etc/example-place/computer.json';
const runs = {
  health_listen: '127.0.0.1:7199',
  access_log_unit: 'caddy',
  units: [{
    unit: 'example-place.service', template: 'tools/keep-an-engine-on-a-computer/serve-computer.service', description: 'Example place', user: 'example-place',
    state: '/var/lib/example-place', builds: '/var/lib/example-place/builds', program: 'example-engine',
    settings_file: SETTINGS, settings: { listen: '127.0.0.1:7199' }, writable: '/var/lib/example-place',
    drop_ins: ['tools/start-a-computer/read-data/unit-templates/nofile.conf'], commit: 'abc1234',
  }],
  unmanaged: [],
};

// A computer that runs its row except the unit's settings file, so the apply rewrites it and restarts the unit. `curl` answers each
// health try in turn (the last answer repeats); `journal` is what the access log's unit prints, or `journalFails` makes it unreadable.
const JOURNAL = [
  JSON.stringify({ ts: 1795263000.5, status: 200, request: { uri: '/', remote_ip: '198.51.100.4' } }),
  JSON.stringify({ ts: 1795263001.25, status: 503, request: { uri: '/target/members.list?page=2', remote_ip: '203.0.113.7' } }),
  'not a log line',
].join('\n');
const hashesOf = (live, input) => String(input ?? '').split('\n').filter(path => path && live[path] !== undefined)
  .map(path => `${createHash('sha256').update(live[path]).digest('hex')}  ${path}\n`).join('');

function computer({ curl = ['200'], journalFails = false, live } = {}) {
  let tries = 0;
  const run = async (_machine, command, input) => {
    if (command.includes('journalctl')) {
      if (journalFails) throw Object.assign(new Error('On the machine, `journalctl` exited 1: Failed to open journal'), { code: 1 });
      return JOURNAL;
    }
    if (command.includes('sha256sum')) return hashesOf(live, input);
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    if (command.startsWith('ufw status')) return 'Status: active\n\nTo Action From\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n';
    if (command.includes('curl')) return curl[Math.min(tries++, curl.length - 1)];
    return '';
  };
  return run;
}

const liveRunning = () => Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
const liveWithOldSettings = () => ({ ...liveRunning(), [SETTINGS]: '{"listen":"old"}' });
const deps = { wait: async () => {}, computer: 'example-computer' };
const ipHash = ip => makeHashCodeHexFromBytes(new TextEncoder().encode(ip));

test('a clean apply records the unit as passed, with its window and the access log error answers in that window', async () => {
  const live = liveWithOldSettings();
  const { apply_checked } = await applyWhatItRuns(machine, runs, computer({ live }), {}, deps);
  assert.equal(apply_checked.length, 1);
  const [fact] = apply_checked;
  assert.equal(fact.computer, 'example-computer');
  assert.equal(fact.unit, 'example-place.service');
  assert.equal(fact.build, 'abc1234');
  assert.equal(fact.check, 'passed');
  assert.ok(Date.parse(fact.down_ended) >= Date.parse(fact.down_started));
  assert.equal(fact.journal_reachable, true);
  assert.deepEqual(fact.failures, [{ route: '/target/members.list', status: 503, ip_hash: ipHash('203.0.113.7'), at: new Date(1795263001.25 * 1000).toISOString() }]);
  assert.ok(!JSON.stringify(fact).includes('203.0.113.7'), 'the fact must hold no raw client address');
});

test('a down window: the check fails twice, then passes, and the unit is recorded as passed with its window', async () => {
  const live = liveWithOldSettings();
  const { apply_checked } = await applyWhatItRuns(machine, runs, computer({ live, curl: ['503', '503', '200'] }), {}, deps);
  assert.equal(apply_checked[0].check, 'passed');
  assert.equal(apply_checked[0].failures.length, 1);
});

test('a check that never passes throws, and the error still carries the failed fact with its window and the error answers', async () => {
  const live = liveWithOldSettings();
  const error = await applyWhatItRuns(machine, runs, computer({ live, curl: ['503'] }), {}, deps).then(() => null, error => error);
  assert.ok(error, 'the apply must throw');
  assert.match(error.message, /answered 503/);
  assert.equal(error.apply_checked.length, 1);
  assert.equal(error.apply_checked[0].check, 'failed');
  assert.match(error.apply_checked[0].reason, /answered 503/);
  assert.equal(error.apply_checked[0].journal_reachable, true);
  assert.equal(error.apply_checked[0].failures.length, 1);
});

test('no journal reachable: the fact says so and holds no failures, never reports them as none', async () => {
  const live = liveWithOldSettings();
  const { apply_checked } = await applyWhatItRuns(machine, runs, computer({ live, journalFails: true }), {}, deps);
  assert.equal(apply_checked[0].journal_reachable, false);
  assert.match(apply_checked[0].journal_reason, /journalctl/);
  assert.deepEqual(apply_checked[0].failures, []);
});

test('a computer row that names no access_log_unit says the journal was not named', async () => {
  const live = liveWithOldSettings();
  const rowWithoutLog = { ...runs };
  delete rowWithoutLog.access_log_unit;
  const { apply_checked } = await applyWhatItRuns(machine, rowWithoutLog, computer({ live }), {}, deps);
  assert.equal(apply_checked[0].journal_reachable, false);
  assert.equal(apply_checked[0].journal_reason, 'the computer row names no access_log_unit');
});
