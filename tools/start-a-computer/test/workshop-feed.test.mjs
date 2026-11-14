// tools/start-a-computer/test/workshop-feed.test.mjs
//
// A unit that runs from a Workshop clone follows the signed Workshop feed its row names: the computer's clone is behind when
// the feed's newest entry, signed by one of the row's keys, names another commit, and applying moves it there (restarting
// the unit only when its own tool folder changed). A pin in the row is followed instead. A file the row says is absent is
// reported while it is there and taken away by applying. An engine unit follows the signed engine release feed its config
// names: its first release comes from that feed, checked by signature, byte count and content identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHostLayout, hostLayoutDifferences, SITE_BLOCK } from '../do-work/start-a-computer.mjs';
import { renderLayout } from '../do-work/render-layout.mjs';
import { newSigningKey, publicKeyHex, signEntry } from 'trillion-workshop/tools/publish-an-engine-release/do-work/release-feed.mjs';

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

// An engine unit follows the signed engine release feed its own config names (`settings.release_feed`): its config is the
// row's settings with the product data's starting account rows under them, its first release is the feed's newest entry
// for the machine's target that a key of the config signed (byte count and BLAKE3 content identity checked on the machine,
// switched by the release's own `release switch`), and it starts and answers its own health row.
const engineFeedUrl = 'https://releases.example.test/engine-releases/feed.json';
const engine = {
  unit: 'example-engine.service', template: 'serve-computer', description: 'Example engine', user: 'example-engine',
  releases: '/opt/example-engine/releases', engine_file: 'example-local', data_env: 'EXAMPLE_DATA_ROOT', data_dir: 'product',
  config: '/var/lib/example-engine/computer.json', launch_setting: 'EXAMPLE_SETTINGS',
  product_settings: '/var/lib/example-engine/product-settings.json', writable: ['/var/lib/example-engine', '/opt/example-engine/releases'],
  key_file: '/var/lib/example-engine/computer.key', folders: ['/var/lib/example-engine/accounts'],
  health: { path: '/readyz', status: 200 }, health_listen: '127.0.0.1:7199',
  settings: {
    listen: '127.0.0.1:7199', accounts: '/var/lib/example-engine/accounts', place_key_file: '/var/lib/example-engine/computer.key',
    public_origin: 'https://computer.example.test', report: { reach: 'https://computer.example.test' },
    new_accounts: { copies: { least_copy_keepers: 1, least_voters: 1, least_may_answer: 1, least_always_on: 0 } },
    release_feed: { urls: [engineFeedUrl], public_keys: [publicKeyHex(key)], releases: '/opt/example-engine/releases' },
  },
};
const engineLayout = { caddy: { site_hosts: ['computer.example.test'], port: 7199, releases: '/opt/example-engine/releases' }, units: [engine], unmanaged: [], machine: { firewall_allow: null } };
const product = `${JSON.stringify({ new_accounts: { sign_in: { word: 'example' }, copies: { least_copy_keepers: 3, least_voters: 3, least_may_answer: 2, least_always_on: 0 } } }, null, 2)}\n`;
const release = (commit, sequence, extra = {}, by = key) => signEntry({ commit, sequence, target: 'x86_64-unknown-linux-gnu', url: `https://releases.example.test/engine-releases/${commit}/x86_64-unknown-linux-gnu.tar.gz`, content: `1f:${'b'.repeat(64)}`, bytes: 1234, urgent: false, ...extra }, by);
const engineFeed = releases => async url => (url === engineFeedUrl ? { ok: true, json: async () => ({ releases }) } : { ok: false });

// A fresh machine: nothing at any path, no account, no current release. `commands` records every command and its input.
const freshMachine = () => {
  const commands = [];
  const run = async (_machine, command, input) => {
    commands.push({ command, input });
    if (command.startsWith('if [ -f ') || command.startsWith('getent') || command.endsWith('|| exit 3')) throw Object.assign(new Error('absent'), { code: 3 });
    if (command === 'echo "$(uname -s) $(uname -m)"') return 'Linux x86_64\n';
    if (command.includes('curl -s -o /dev/null')) return '200';
    return '';
  };
  return { run, commands };
};

test('an engine unit\'s config is the row\'s settings with the product\'s starting account rows under the row\'s own', () => {
  const config = JSON.parse(renderLayout(engineLayout, SITE_BLOCK, product).find(({ path }) => path === engine.config).text);
  assert.equal(config.listen, '127.0.0.1:7199');
  assert.deepEqual(config.new_accounts.sign_in, { word: 'example' });
  assert.deepEqual(config.new_accounts.copies, engine.settings.new_accounts.copies, 'the row\'s copies win over the product\'s');
  assert.deepEqual(config.release_feed, engine.settings.release_feed);
  assert.throws(() => renderLayout(engineLayout, SITE_BLOCK), /needs the product data for its new_accounts/);
  assert.throws(() => renderLayout({ ...engineLayout, units: [{ ...engine, releases: '/opt/another/releases' }] }, SITE_BLOCK, product), /release_feed\.releases must be the unit's releases/);
});

test('a fresh computer gets its engine\'s first release from the signed feed, then its config, then the engine starts', async () => {
  const { run, commands } = freshMachine();
  const newest = release('e'.repeat(40), 7);
  const answer = await applyHostLayout(machine, engineLayout, run, product, {}, { fetchImpl: engineFeed([release('f'.repeat(40), 3), release('1'.repeat(40), 99, { target: 'aarch64-unknown-linux-gnu' }), newest]) });
  assert.deepEqual(answer.released, [{ unit: 'example-engine.service', commit: 'e'.repeat(40) }], 'the newest signed entry for the machine\'s own target');
  assert.deepEqual(answer.restarted, ['example-engine.service']);
  assert.deepEqual(answer.booted, ['example-engine.service']);
  const setUp = commands.find(({ command }) => command.startsWith('sh -s'));
  assert.match(setUp.command, /"firewall_allow":null/, 'the row\'s machine fields are over the set-up data');
  assert.match(setUp.command, /"b3sum"/);
  const fetched = commands.find(({ command }) => command.startsWith("runuser -u 'example-engine' -- sh -c"));
  assert.ok(commands.indexOf(setUp) < commands.indexOf(fetched), 'set-up makes the user and folders before the release comes');
  assert.match(fetched.command, /curl -fsSL --max-time 900 -o '\\''\/opt\/example-engine\/releases\/e{40}\.tar\.gz\.part'\\'' '\\''https:\/\/releases\.example\.test\//);
  assert.match(fetched.command, /stat -c %s .* != '\\''1234'\\''/);
  assert.match(fetched.command, /b3sum --no-names .* != '\\''1f:b{64}'\\''/);
  assert.match(fetched.command, /example-local'\\'' release switch '\\''\/opt\/example-engine\/releases'\\'' '\\''e{40}'\\''/);
  assert.deepEqual(JSON.parse(fetched.input), newest, 'the signed entry is the release\'s release.json');
  const config = commands.find(({ command }) => command.endsWith(`/dev/stdin '${engine.config}'`));
  assert.match(config.command, /^install -m 0600 -o 'example-engine' -g 'example-engine'/, 'the engine config is its user\'s and private');
  assert.ok(commands.some(({ command }) => command === "systemctl enable --now 'example-engine.service' >/dev/null 2>&1"));
  assert.ok(commands.some(({ command }) => command.includes("'http://127.0.0.1:7199/readyz'")), 'the engine answers its own health row');
});

test('a feed entry no key of the engine config signed gives no release, and nothing starts', async () => {
  const { run, commands } = freshMachine();
  await assert.rejects(applyHostLayout(machine, engineLayout, run, product, {}, { fetchImpl: engineFeed([release('e'.repeat(40), 9, {}, stranger)]) }), /no feed in its release_feed answered a x86_64-unknown-linux-gnu entry one of its keys signed/);
  assert.ok(!commands.some(({ command }) => command.startsWith('systemctl')));
});

test('differences names an engine unit with no current release', async () => {
  const live = Object.fromEntries(renderLayout(engineLayout, SITE_BLOCK, product).map(({ path, text }) => [path, text]));
  const run = async (_machine, command) => {
    if (command.startsWith('if [ -f ')) return live[command.match(/if \[ -f '([^']+)' \]/)[1]];
    if (command.startsWith('test -e')) throw Object.assign(new Error('absent'), { code: 3 });
    return '';
  };
  assert.deepEqual(await hostLayoutDifferences(machine, engineLayout, run, product), [{ path: '/opt/example-engine/releases/current', reason: 'no release yet; its signed feed gives the first' }]);
});
