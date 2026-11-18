// tools/start-a-computer/test/workshop-pin.test.mjs
//
// A unit that runs from a Workshop copy runs the commit its row pins (`workshop_commit`): the pin is in the unit file, so a new
// pin is a changed unit, and the unit fetches that commit into its copy when it starts. A file, folder or unit the row says
// is absent is reported while it is there and taken away by applying.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWhatItRuns, runsDifferences } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';

const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);

const unit = (extra = {}) => ({
  unit: 'example-sign-in.service', template: 'tools/better-auth-official/on-a-computer/serve-better-auth.service', description: 'Example sign-in', user: 'example-sign-in',
  state: '/var/lib/example-sign-in', workshop: '/opt/example-workshop', repository: 'https://example.test/workshop.git',
  tool_folder: 'tools/better-auth-official', node_bin: '/opt/node/bin', settings_file: '/etc/example/settings.json', settings: { port: 8792 },
  secret_vault_key: 'example-secret', secret_name: 'example-secret', secret_file: '/etc/credstore.encrypted/example-secret',
  credentials: [{ vault_key: 'example-store', name: 'sign-in-store', file: '/etc/credstore.encrypted/sign-in-store', env: 'BETTER_AUTH_STORE_CONNECTION' }], writable: '/var/lib/example-sign-in',
  workshop_commit: NEW,
  ...extra,
});
const runsWith = (u, extra = {}) => ({ health_listen: '127.0.0.1:7199', units: [u], unmanaged: [], ...extra });

// A computer that runs its row as rendered, with `files` beside it.
const computer = (runs, { files = {} }) => {
  const live = Object.fromEntries(renderWhatItRuns(runs).map(({ path, text }) => [path, text]));
  Object.assign(live, files, { [`${runs.units[0].node_bin}/node`]: 'node', [runs.units[0].secret_file]: 'sealed', [runs.units[0].credentials[0].file]: 'sealed' });
  const commands = [];
  const run = async (_machine, command) => {
    commands.push(command);
    // A set-up computer's firewall admits the settings' ports.
    if (command.startsWith('ufw status')) return 'Status: active\n\n22/tcp ALLOW Anywhere\n80/tcp ALLOW Anywhere\n443/tcp ALLOW Anywhere\n';
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    const tested = command.match(/^test -[sxe] '([^']+)'/);
    if (tested) { if (live[tested[1]] === undefined) throw Object.assign(new Error('absent'), { code: 3 }); return ''; }
    const removed = command.match(/^rm -rf -- '([^']+)'$/);
    if (removed) delete live[removed[1]];
    if (command.includes('curl')) return '200';
    return '';
  };
  return { run, commands };
};
const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };

test('a new pin is a difference in the sign-in unit, and applying it restarts the unit, which fetches the pinned commit itself', async () => {
  const runs = runsWith(unit());
  const pinnedBefore = runsWith(unit({ workshop_commit: OLD }));
  const { run, commands } = computer(pinnedBefore, {});
  assert.deepEqual(await runsDifferences(machine, runs, run), [
    { path: '/etc/systemd/system/example-sign-in.service', reason: 'differs from the computer row' },
  ]);
  const answer = await applyWhatItRuns(machine, runs, run);
  assert.deepEqual(answer.written, ['/etc/systemd/system/example-sign-in.service']);
  assert.deepEqual(answer.restarted, ['example-sign-in.service']);
  assert.ok(!commands.some(command => /git -C .* (fetch|checkout)/.test(command)), 'the apply moves no clone: the unit fetches its pin at start');
  assert.deepEqual(await runsDifferences(machine, runs, computer(runs, {}).run), []);
  assert.throws(() => renderWhatItRuns(runsWith(unit({ workshop_commit: 'main' }))), /workshop_commit must be a full commit id/);
});

test('a file the row says is absent is a difference while it is there, and applying takes it away', async () => {
  const runs = runsWith(unit(), { absent: ['/etc/example/plain-secret'] });
  const { run, commands } = computer(runs, { files: { '/etc/example/plain-secret': 'x' } });
  assert.deepEqual(await runsDifferences(machine, runs, run), [
    { path: '/etc/example/plain-secret', reason: 'present; the computer row says absent' },
  ]);
  const answer = await applyWhatItRuns(machine, runs, run);
  assert.deepEqual(answer.removed, ['/etc/example/plain-secret']);
  assert.ok(commands.includes("rm -rf -- '/etc/example/plain-secret'"));
  assert.deepEqual(await runsDifferences(machine, runs, run), []);
});

test('a unit file the row says is absent is stopped and disabled, and its drop-ins go with it', async () => {
  const retired = '/etc/systemd/system/example-old-door.service';
  const runs = runsWith(unit(), { absent: [retired] });
  const { run, commands } = computer(runs, { files: { [retired]: '[Unit]\n' } });
  assert.deepEqual(await runsDifferences(machine, runs, run), [
    { path: retired, reason: 'present; the computer row says absent' },
  ]);
  const answer = await applyWhatItRuns(machine, runs, run);
  assert.deepEqual(answer.removed, [retired]);
  const at = command => commands.indexOf(command);
  const stopped = at("systemctl disable --now 'example-old-door.service' && rm -rf -- '/etc/systemd/system/example-old-door.service.d'");
  assert.ok(stopped >= 0, 'the unit is stopped and disabled, and its drop-ins removed');
  assert.ok(stopped < at(`rm -rf -- '${retired}'`) && at(`rm -rf -- '${retired}'`) < commands.lastIndexOf('systemctl daemon-reload'), 'then its file goes and systemd reads the units again');
});
