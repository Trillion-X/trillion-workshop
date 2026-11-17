// tools/start-a-computer/test/workshop-pin.test.mjs
//
// A unit that runs from a Workshop clone runs the commit its row pins (`workshop_commit`): the computer's clone is behind
// when it is at another commit, and applying moves it there (restarting the unit only when its own tool folder changed). A
// file, folder or unit the row says is absent is reported while it is there and taken away by applying.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWhatItRuns, runsDifferences, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderWhatItRuns } from '../do-work/render-what-a-computer-runs.mjs';

const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);

const unit = (extra = {}) => ({
  unit: 'example-sign-in.service', template: 'serve-better-auth', description: 'Example sign-in', user: 'example-sign-in',
  state: '/var/lib/example-sign-in', workshop: '/opt/example-workshop', repository: 'https://example.test/workshop.git',
  tool_folder: 'tools/better-auth-official', node_bin: '/opt/node/bin', settings_file: '/etc/example/settings.json', settings: { port: 8792 },
  secret_vault_key: 'example-secret', secret_name: 'example-secret', secret_file: '/etc/credstore.encrypted/example-secret',
  credentials: [{ vault_key: 'example-store', name: 'sign-in-store', file: '/etc/credstore.encrypted/sign-in-store', env: 'BETTER_AUTH_STORE_CONNECTION' }], writable: '/var/lib/example-sign-in',
  workshop_commit: NEW,
  ...extra,
});
const runsWith = (u, extra = {}) => ({ caddy: { site_hosts: ['place.example.test'], port: 7199 }, units: [u], unmanaged: [], ...extra });

// A computer that runs its row as rendered, whose clone is at `head` and whose tool folder tree is `trees[commit]`.
const computer = (runs, { head, trees = {}, files = {} }) => {
  const live = Object.fromEntries(renderWhatItRuns(runs, SITE_BLOCK).map(({ path, text }) => [path, text]));
  Object.assign(live, files, { [`${runs.units[0].node_bin}/node`]: 'node', [runs.units[0].secret_file]: 'sealed', [runs.units[0].credentials[0].file]: 'sealed' });
  const commands = [];
  const state = { head };
  const run = async (_machine, command) => {
    commands.push(command);
    if (command.startsWith('if [ -f ')) {
      const path = command.match(/if \[ -f '([^']+)' \]/)[1];
      if (live[path] === undefined) throw Object.assign(new Error('absent'), { code: 3 });
      return live[path];
    }
    const tested = command.match(/^test -[sxe] '([^']+)'/);
    if (tested) { if (live[tested[1]] === undefined) throw Object.assign(new Error('absent'), { code: 3 }); return ''; }
    if (command.includes('rev-parse HEAD')) return `${state.head}\n`;
    const tree = command.match(/rev-parse '([0-9a-f]{40}):([^']+)'/);
    if (tree) return `${trees[tree[1]] ?? 'tree-same'}\n`;
    const moved = command.match(/checkout -q --detach '([0-9a-f]{40})'/);
    if (moved) state.head = moved[1];
    const removed = command.match(/^rm -rf -- '([^']+)'$/);
    if (removed) delete live[removed[1]];
    if (command.includes('curl')) return '200';
    return '';
  };
  return { run, commands, state };
};
const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };

test('a clone at another commit than its row pins is a difference, and one at the pin is not', async () => {
  const runs = runsWith(unit());
  const { run } = computer(runs, { head: OLD });
  assert.deepEqual(await runsDifferences(machine, runs, run), [
    { path: '/opt/example-workshop', reason: `runs Workshop ${OLD}; its row follows ${NEW}` },
  ]);
  const current = computer(runs, { head: NEW });
  assert.deepEqual(await runsDifferences(machine, runs, current.run), []);
  await assert.rejects(runsDifferences(machine, runsWith(unit({ workshop_commit: 'main' })), run), /workshop_commit must be a full commit id/);
});

test('applying moves the clone to the pinned commit as the unit\'s user and restarts the unit only when its tool folder changed', async () => {
  const runs = runsWith(unit());
  const changed = computer(runs, { head: OLD, trees: { [OLD]: 'tree-1', [NEW]: 'tree-2' } });
  const answer = await applyWhatItRuns(machine, runs, changed.run);
  assert.equal(changed.state.head, NEW);
  assert.ok(changed.commands.includes(`runuser -u 'example-sign-in' -- git -C '/opt/example-workshop' fetch -q --depth 1 origin '${NEW}' && runuser -u 'example-sign-in' -- git -C '/opt/example-workshop' checkout -q --detach '${NEW}'`));
  assert.deepEqual(answer.moved, [{ path: '/opt/example-workshop', from: OLD, to: NEW }]);
  assert.deepEqual(answer.restarted, ['example-sign-in.service']);
  const same = computer(runs, { head: OLD, trees: { [OLD]: 'tree-1', [NEW]: 'tree-1' } });
  const quiet = await applyWhatItRuns(machine, runs, same.run);
  assert.equal(same.state.head, NEW);
  assert.deepEqual(quiet.restarted, [], 'a move that leaves the tool folder as it was restarts nothing');
});

test('a file the row says is absent is a difference while it is there, and applying takes it away', async () => {
  const runs = runsWith(unit(), { absent: ['/etc/example/plain-secret'] });
  const { run, commands } = computer(runs, { head: NEW, files: { '/etc/example/plain-secret': 'x' } });
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
  const { run, commands } = computer(runs, { head: NEW, files: { [retired]: '[Unit]\n' } });
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
