// tools/start-a-computer/test/workshop-feed.test.mjs
//
// A unit that runs from a Workshop clone follows the signed Workshop feed its row names: the computer's clone is behind when
// the feed's newest entry, signed by one of the row's keys, names another commit, and applying moves it there (restarting
// the unit only when its own tool folder changed). A pin in the row is followed instead. A file the row says is absent is
// reported while it is there and taken away by applying.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHostLayout, hostLayoutDifferences, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderLayout } from '../do-work/render-layout.mjs';
import { newSigningKey, publicKeyHex, signEntry } from '../../publish-an-engine-release/do-work/release-feed.mjs';

const key = newSigningKey(), stranger = newSigningKey();
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40), FORGED = 'c'.repeat(40), PINNED = 'd'.repeat(40);
const entry = (commit, sequence, by = key) => signEntry({ commit, sequence, target: 'workshop-tools', url: `https://feed.example.test/${commit}/workshop-tools.tar.gz`, content: `1f:${'0'.repeat(64)}`, bytes: 1, urgent: false }, by);
const feed = { releases: [entry(OLD, 1), entry(NEW, 2), entry(FORGED, 3, stranger)] };
const fetchImpl = async url => {
  assert.equal(url, 'https://feed.example.test/workshop-feed.json');
  return { ok: true, status: 200, json: async () => feed };
};

const unit = (extra = {}) => ({
  unit: 'example-sign-in.service', template: 'serve-better-auth', description: 'Example sign-in', user: 'example-sign-in',
  state: '/var/lib/example-sign-in', workshop: '/opt/example-workshop', repository: 'https://example.test/workshop.git',
  tool_folder: 'tools/better-auth-official', node_bin: '/opt/node/bin', settings_file: '/etc/example/settings.json', settings: { port: 8792 },
  secret_vault_key: 'example-secret', secret_name: 'example-secret', secret_file: '/etc/credstore.encrypted/example-secret', writable: '/var/lib/example-sign-in',
  workshop_feed: { urls: ['https://feed.example.test/workshop-feed.json'], public_keys: [publicKeyHex(key)], target: 'workshop-tools' },
  ...extra,
});
const layoutOf = (u, extra = {}) => ({ caddy: { site_hosts: ['place.example.test'], port: 7199, releases: '/opt/example/releases' }, units: [u], unmanaged: [], ...extra });

// A computer that runs the layout as rendered, whose clone is at `head` and whose tool folder tree is `trees[commit]`.
const computer = (layout, { head, trees = {}, files = {} }) => {
  const live = Object.fromEntries(renderLayout(layout, SITE_BLOCK).map(({ path, text }) => [path, text]));
  Object.assign(live, files, { [`${layout.units[0].node_bin}/node`]: 'node', [layout.units[0].secret_file]: 'sealed' });
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
    const removed = command.match(/^rm -f -- '([^']+)'$/);
    if (removed) delete live[removed[1]];
    if (command.includes('curl')) return '200';
    return '';
  };
  return { run, commands, state };
};
const machine = { address: '192.0.2.9', ssh: { known_hosts: '/dev/null' } };

test('a clone behind the feed\'s newest signed commit is a difference; an entry no key of the row signed is not followed', async () => {
  const layout = layoutOf(unit());
  const { run } = computer(layout, { head: OLD });
  assert.deepEqual(await hostLayoutDifferences(machine, layout, run, undefined, { fetchImpl }), [
    { path: '/opt/example-workshop', reason: `runs Workshop ${OLD}; its row follows ${NEW}` },
  ]);
  const current = computer(layout, { head: NEW });
  assert.deepEqual(await hostLayoutDifferences(machine, layout, current.run, undefined, { fetchImpl }), []);
});

test('applying moves the clone to the feed\'s commit as the unit\'s user and restarts the unit only when its tool folder changed', async () => {
  const layout = layoutOf(unit());
  const changed = computer(layout, { head: OLD, trees: { [OLD]: 'tree-1', [NEW]: 'tree-2' } });
  const answer = await applyHostLayout(machine, layout, changed.run, undefined, {}, { fetchImpl });
  assert.equal(changed.state.head, NEW);
  assert.ok(changed.commands.includes(`runuser -u 'example-sign-in' -- git -C '/opt/example-workshop' fetch -q --depth 1 origin '${NEW}' && runuser -u 'example-sign-in' -- git -C '/opt/example-workshop' checkout -q --detach '${NEW}'`));
  assert.deepEqual(answer.moved, [{ path: '/opt/example-workshop', from: OLD, to: NEW }]);
  assert.deepEqual(answer.restarted, ['example-sign-in.service']);
  const same = computer(layout, { head: OLD, trees: { [OLD]: 'tree-1', [NEW]: 'tree-1' } });
  const quiet = await applyHostLayout(machine, layout, same.run, undefined, {}, { fetchImpl });
  assert.equal(same.state.head, NEW);
  assert.deepEqual(quiet.restarted, [], 'a move that leaves the tool folder as it was restarts nothing');
});

test('a commit pinned in the row is followed instead of the feed', async () => {
  const layout = layoutOf(unit({ workshop_commit: PINNED }));
  const { run, state } = computer(layout, { head: NEW });
  assert.deepEqual(await hostLayoutDifferences(machine, layout, run, undefined, { fetchImpl: async () => { throw new Error('the feed is not read for a pin'); } }), [
    { path: '/opt/example-workshop', reason: `runs Workshop ${NEW}; its row follows ${PINNED}` },
  ]);
  await applyHostLayout(machine, layout, run, undefined, {}, { fetchImpl });
  assert.equal(state.head, PINNED);
});

test('a file the row says is absent is a difference while it is there, and applying takes it away', async () => {
  const layout = layoutOf(unit(), { absent: ['/etc/example/plain-secret'] });
  const { run, commands } = computer(layout, { head: NEW, files: { '/etc/example/plain-secret': 'x' } });
  assert.deepEqual(await hostLayoutDifferences(machine, layout, run, undefined, { fetchImpl }), [
    { path: '/etc/example/plain-secret', reason: 'present; the layout says absent' },
  ]);
  const answer = await applyHostLayout(machine, layout, run, undefined, {}, { fetchImpl });
  assert.deepEqual(answer.removed, ['/etc/example/plain-secret']);
  assert.ok(commands.includes("rm -f -- '/etc/example/plain-secret'"));
  assert.deepEqual(await hostLayoutDifferences(machine, layout, run, undefined, { fetchImpl }), []);
});
