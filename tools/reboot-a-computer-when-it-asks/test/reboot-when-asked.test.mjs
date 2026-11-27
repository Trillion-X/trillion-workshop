// tools/reboot-a-computer-when-it-asks/test/reboot-when-asked.test.mjs
//
// Each script answered by a made-up computer (192.0.2.x): what it asks, whether it is busy, and how it comes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRead, readScript, rebootWhenAsked } from '../do-work/reboot-when-asked.mjs';

const HOST = { name: 'example-box', address: '192.0.2.9', host_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExampleEx' };
const MARK = '@@reboot-when-asked ';

const answer = ({ asks = false, packages = [], boot = 'boot-1', system = 'running', failed = [], containers = ['site-1', 'engine-1'], busy = [] } = {}) => [
  `${MARK}asks`, asks ? 'yes' : 'no', `${MARK}packages`, ...packages, `${MARK}boot`, boot, '58000.12', `${MARK}system`, system, `${MARK}failed`, ...failed,
  `${MARK}containers`, ...containers, ...busy.map(id => `${MARK}busy ${id}`), `${MARK}end`, ''].join('\n');

// A computer that answers `reads` in turn (the last one again once they run out); `asked` records each reboot request.
const computer = (...reads) => {
  const scripts = [], asked = [];
  let i = 0;
  const run = script => {
    scripts.push(script);
    if (script.startsWith('systemd-run')) { asked.push(script); return { status: 0, stdout: '', stderr: '' }; }
    const read = reads[Math.min(i++, reads.length - 1)];
    return typeof read === 'string' ? { status: 0, stdout: read, stderr: '' } : read;
  };
  return { run, scripts, asked };
};

let clock = 0;
const options = box => ({ run: box.run, now: () => clock, wait: async ms => { clock += ms; } });

test('the read script reads each part after its own mark and writes nothing', () => {
  const script = readScript();
  for (const part of ['asks', 'packages', 'boot', 'system', 'failed', 'containers', 'end']) assert.ok(script.includes(`${MARK}${part}`));
  assert.ok(!/(^|[ ;|&])(rm|shutdown|reboot|systemd-run|systemctl (stop|restart|reboot)|docker (stop|rm|restart|kill))( |$)/m.test(script), 'reading changes nothing');
  const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
  for (const { id } of settings.busy) assert.ok(script.includes(`echo '${MARK}busy ${id}'`));
});

test('a read parses what the computer said, and names each busy test by what it says', () => {
  const read = parseRead(answer({ asks: true, packages: ['linux-image-7.0.0-12-generic'], busy: ['package-manager'] }));
  assert.equal(read.asks, true);
  assert.deepEqual(read.packages, ['linux-image-7.0.0-12-generic']);
  assert.equal(read.boot_id, 'boot-1');
  assert.equal(read.uptime_seconds, 58000);
  assert.deepEqual(read.containers, ['site-1', 'engine-1']);
  assert.match(read.busy[0], /package manager/);
});

test('mode read only reads', async () => {
  const box = computer(answer({ asks: true }));
  const got = await rebootWhenAsked({ ...HOST }, options(box));
  assert.equal(got.read, true);
  assert.equal(got.rebooted, false);
  assert.equal(got.before.asks, true);
  assert.equal(box.asked.length, 0);
  assert.equal(box.scripts.length, 1);
});

test('a computer that does not ask is not rebooted, unless a proof run says even_if_not_asked', async () => {
  const quiet = computer(answer());
  const got = await rebootWhenAsked({ ...HOST, mode: 'reboot' }, options(quiet));
  assert.equal(got.rebooted, false);
  assert.match(got.why, /does not ask for a reboot/);
  assert.equal(quiet.asked.length, 0);
  const proof = computer(answer(), answer({ boot: 'boot-2' }));
  const proved = await rebootWhenAsked({ ...HOST, mode: 'reboot', even_if_not_asked: true }, options(proof));
  assert.equal(proved.rebooted, true);
  assert.equal(proof.asked.length, 1);
});

test('a computer that asks while busy is not rebooted, and says why', async () => {
  const box = computer(answer({ asks: true, busy: ['container-change'] }));
  const got = await rebootWhenAsked({ ...HOST, mode: 'reboot', even_if_not_asked: true }, options(box));
  assert.equal(got.rebooted, false);
  assert.match(got.why, /busy, so it is not rebooted now: a container build/);
  assert.equal(box.asked.length, 0);
});

test('a reboot is asked of systemd after the session, waits for a new boot, and reads every container back', async () => {
  const down = { status: 255, stdout: '', stderr: 'ssh: connect to host 192.0.2.9 port 22: Connection refused' };
  const box = computer(answer({ asks: true, packages: ['linux-image-x'] }), down, answer({ boot: 'boot-1' }), answer({ boot: 'boot-2', system: 'starting' }), answer({ boot: 'boot-2' }));
  clock = 0;
  const got = await rebootWhenAsked({ ...HOST, mode: 'reboot' }, options(box));
  assert.equal(got.rebooted, true);
  assert.match(box.asked[0], /^systemd-run --quiet --unit=reboot-when-asked --on-active=5 \/bin\/systemctl reboot/);
  assert.equal(got.after.boot_id, 'boot-2');
  assert.equal(got.after.system, 'running');
  assert.deepEqual(got.findings, []);
  assert.ok(got.back_after_seconds >= 35, 'it waited past the reboot before reading');
});

test('a computer that comes back degraded, still asking, or without a container is told', async () => {
  const box = computer(answer({ asks: true }), answer({ boot: 'boot-2', system: 'degraded', failed: ['cloud-init-hotplugd.service'], asks: true, containers: ['site-1'] }));
  const got = await rebootWhenAsked({ ...HOST, mode: 'reboot' }, options(box));
  assert.equal(got.rebooted, true);
  assert.deepEqual(got.findings.map(finding => [finding.kind, finding.level, finding.about]), [
    ['still-asks-for-a-reboot', 'warn', 'example-box'],
    ['degraded-after-reboot', 'alert', 'example-box'],
    ['container-not-back', 'alert', 'engine-1'],
  ]);
  assert.match(got.findings[1].said, /a failed systemd unit: cloud-init-hotplugd\.service/);
});

test('a computer that never comes back within wait_seconds is an alert', async () => {
  const down = { status: 255, stdout: '', stderr: 'Connection timed out' };
  const box = computer(answer({ asks: true }), down);
  clock = 0;
  const got = await rebootWhenAsked({ ...HOST, mode: 'reboot', wait_seconds: 120 }, options(box));
  assert.equal(got.rebooted, false);
  assert.match(got.why, /did not answer with a new boot and a started system within 120 s/);
  assert.equal(got.findings[0].kind, 'not-back-after-reboot');
});

test('a computer that does not answer, a refused address and a refused mode change nothing', async () => {
  const down = computer({ status: 255, stdout: '', stderr: 'Connection refused' });
  const got = await rebootWhenAsked({ ...HOST, mode: 'reboot' }, options(down));
  assert.equal(got.read, false);
  assert.match(got.why, /could not be read over SSH: Connection refused/);
  assert.equal(down.asked.length, 0);
  const box = computer(answer({ asks: true }));
  assert.match((await rebootWhenAsked({ ...HOST, address: "x'; reboot" }, options(box))).why, /address was refused/);
  assert.match((await rebootWhenAsked({ ...HOST, host_key: undefined }, options(box))).why, /host_key is missing/);
  assert.match((await rebootWhenAsked({ ...HOST, mode: 'now' }, options(box))).why, /mode is "read" or "reboot"/);
  assert.equal(box.scripts.length, 0);
});

test('the row mounts the administrator key, packs the SSH helper and names no host', () => {
  const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'));
  const { invoke, id } = rows.records[0].payload;
  assert.equal(id, 'tool:reboot-a-computer-when-it-asks');
  assert.deepEqual(invoke.key, [{ secret_name: 'server-administration-ssh-key', mount_path: '/run/held/server-administration-ssh-key' }]);
  assert.equal(invoke.run.at(-1), '/run/held/server-administration-ssh-key');
  assert.ok(invoke.files.package_files.some(item => item.package === 'administer-a-rented-host'));
  assert.ok(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(JSON.stringify(rows)), 'no address is written into the row');
});
