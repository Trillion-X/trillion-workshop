// tools/browser-saved-items: the organizer run the way the engine runs the row (granted folder in argv, the request
// on standard input, the answer on the last line), on a made-up sidebar file for a bakery's saved tabs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const FILE = 'StorableSidebar.json';

function run(granted, input) {
  const ran = spawnSync('python3', ['-B', resolve(folder, 'do-work', 'organize-saved-browser-items.py'), granted], { input: JSON.stringify(input), encoding: 'utf8' });
  return { status: ran.status, answer: JSON.parse(ran.stdout.trim().split('\n').at(-1)) };
}

const tab = (id, parentID, savedTitle, savedURL) => [id, { id, parentID, childrenIds: [], title: null, data: { tab: { savedTitle, savedURL } } }];
const list = (id, parentID, name, childrenIds) => [id, { id, parentID, childrenIds, title: name, data: { list: {} } }];
const split = (id, parentID, childrenIds) => [id, { id, parentID, childrenIds, title: null, data: { splitView: {} } }];

// One space with a pinned area: a root folder holding four folders (two of them nested) and two tabs, tabs outside it,
// a split view, a mail tab on a skipped site, a note nobody covers, and one unpinned tab.
function sidebar() {
  const entries = [
    list('pinned-root', null, 'Pinned', ['kitchen', 't-wedding', 't-candles', 't-mail', 'sv', 't-list']),
    list('kitchen', 'pinned-root', 'Kitchen', ['f-a', 'f-c']),
    list('f-a', 'kitchen', 'Old A', ['f-b', 't-starter']),
    list('f-b', 'f-a', 'Old B', []),
    list('f-c', 'kitchen', 'Old C', ['f-d', 't-stands']),
    list('f-d', 'f-c', 'Old D', []),
    tab('t-starter', 'f-a', 'Sourdough starter guide', 'https://www.bread.example/starter'),
    tab('t-stands', 'f-c', 'Cake stand shop', 'https://stands.example/cakes'),
    tab('t-wedding', 'pinned-root', 'Wedding cake gallery', 'https://cakes.example/gallery'),
    tab('t-candles', 'pinned-root', 'Candles', 'https://party.example/candles'),
    tab('t-mail', 'pinned-root', 'Inbox about a wedding', 'https://mail.example/inbox'),
    split('sv', 'pinned-root', ['s-1', 's-2']),
    tab('s-1', 'sv', 'Birthday cake ideas', 'https://ideas.example/birthday'),
    tab('s-2', 'sv', 'Notes', 'https://notes.example/a'),
    tab('t-list', 'pinned-root', 'Shopping list', 'https://notes.example/list'),
    tab('t-unpinned', 'unpinned-root', 'Wedding venues', 'https://venues.example/wedding'),
  ];
  return {
    sidebar: { containers: [
      { global: true },
      { items: entries.flat(), spaces: ['space-1', { title: 'Shop', containerIDs: ['pinned', 'pinned-root', 'unpinned', 'unpinned-root'] }, 'space-2', { title: 'Home', containerIDs: ['pinned', 'x'] }] },
    ] },
    firebaseSyncState: { syncData: { items: entries.flatMap(([id, node]) => [id, { lastChangedDevice: 'device-1', lastChangeDate: 1, value: node }]) } },
  };
}

const RULES = {
  space: 'Shop', root_folder: 'KITCHEN',
  folders: { Cakes: ['Weddings', 'Birthdays'], Baking: [] },
  fallback: ['Baking'],
  skip_hosts: ['mail.example'],
  relevant_hosts: ['party.example', 'ideas.example'],
  relevant_words: ['wedding', 'birthday'],
  rules: [
    { put_in: ['Cakes', 'Weddings'], words: ['wedding'] },
    { put_in: ['Cakes', 'Birthdays'], hosts: ['party.example'], words: ['birthday'] },
  ],
};

function home(t, document = sidebar()) {
  const root = mkdtempSync(join(tmpdir(), 'saved-items-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, FILE), JSON.stringify(document));
  return root;
}
const read = root => JSON.parse(readFileSync(join(root, FILE), 'utf8'));
const itemsOf = document => {
  const flat = document.sidebar.containers[1].items;
  return Object.fromEntries(flat.filter((_, index) => index % 2 === 0).map((id, index) => [id, flat[index * 2 + 1]]));
};

test('the row runs on the person\'s computer with only the change-a-folder grant and no internet', () => {
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoke.kind, 'computer');
  assert.deepEqual(rows[0].invoke.capabilities, ['change-a-folder']);
  assert.notEqual(rows[0].invoke.internet, true);
  assert.deepEqual(rows[0].invoke.argv.at(-1), { fill: { from: 'task', field: 'grants.change-a-folder.folder' } });
});

test('a report-only run says what would move and leaves the file as it was', t => {
  const root = home(t);
  const before = readFileSync(join(root, FILE), 'utf8');
  const { status, answer } = run(root, { file: FILE, rules: RULES });
  assert.equal(status, 0);
  const result = answer.result;
  assert.equal(result.applied, false);
  assert.equal(result.backup, null);
  assert.equal(result.tab_count, 8);
  assert.equal(result.organized_tab_count, 6);
  assert.equal(result.moved_from_outside_root, 4);
  assert.equal(result.kept_in_place_count, 2);
  assert.deepEqual(result.category_counts, { 'Baking': 2, 'Cakes / Birthdays': 3, 'Cakes / Weddings': 1 });
  const byId = Object.fromEntries(result.tabs.map(row => [row.id, row]));
  assert.deepEqual(byId['t-wedding'].category, ['Cakes', 'Weddings']);
  assert.equal(byId['t-wedding'].basis, 'covered_by_rules');
  assert.equal(byId['t-starter'].basis, 'already_in_root_folder');
  assert.deepEqual(byId['t-starter'].category, ['Baking', null]);
  assert.equal(byId['t-mail'].decision, 'keep_in_place', 'a skipped site is not touched even though its title says wedding');
  assert.equal(byId['t-mail'].basis, 'skipped_site');
  assert.equal(byId['t-list'].decision, 'keep_in_place');
  assert.equal(byId['s-2'].basis, 'moves_with_split_view', 'a tab no rule covers still moves with its split view, and the report says so');
  assert.deepEqual(byId['s-2'].category, ['Cakes', 'Birthdays']);
  assert.equal(byId['t-unpinned'], undefined, 'tabs outside the pinned area are not read');
  assert.equal(readFileSync(join(root, FILE), 'utf8'), before);
  assert.deepEqual(readdirSync(root), [FILE]);
});

test('apply makes the folders, keeps every tab and the split view, and leaves a backup that is the old file', t => {
  const root = home(t);
  const before = readFileSync(join(root, FILE), 'utf8');
  const { status, answer } = run(root, { file: FILE, rules: RULES, apply: true });
  assert.equal(status, 0);
  assert.equal(answer.result.applied, true);
  assert.match(answer.result.backup, /^StorableSidebar\.json\.before-organization-\d{8}-\d{6}$/);
  assert.equal(readFileSync(join(root, answer.result.backup), 'utf8'), before);

  const items = itemsOf(read(root));
  const titled = name => Object.values(items).find(node => node.title === name);
  const kids = node => node.childrenIds.slice().sort();
  assert.deepEqual(items.kitchen.childrenIds.map(id => items[id].title), ['Cakes', 'Baking']);
  assert.deepEqual(titled('Cakes').childrenIds.map(id => items[id].title), ['Weddings', 'Birthdays']);
  assert.deepEqual(kids(titled('Weddings')), ['t-wedding']);
  assert.deepEqual(kids(titled('Birthdays')), ['sv', 't-candles'], 'the split view moved whole, both tabs still inside it');
  assert.deepEqual(items.sv.childrenIds, ['s-1', 's-2']);
  assert.deepEqual(kids(titled('Baking')), ['t-stands', 't-starter']);
  assert.equal(items['t-wedding'].parentID, titled('Weddings').id);
  assert.deepEqual(items['pinned-root'].childrenIds, ['kitchen', 't-mail', 't-list'], 'what no rule covered stays where it was');
  assert.deepEqual(items['t-unpinned'].parentID, 'unpinned-root');
  assert.equal(Object.keys(items).length, 16, 'no item appeared or went');

  const synced = read(root).firebaseSyncState.syncData.items;
  const wrapper = synced[synced.indexOf('t-wedding') + 1];
  assert.equal(wrapper.value.parentID, titled('Weddings').id, 'the sync copy follows the item');
  assert.equal(wrapper.lastChangedDevice, 'device-1');
  assert.ok(wrapper.lastChangeDate > 700000000, 'stamped in the browser\'s own epoch');
  assert.equal(readdirSync(root).filter(name => name.endsWith('.tmp')).length, 0);
});

test('restore puts the backup back and keeps what it replaced', t => {
  const root = home(t);
  const before = readFileSync(join(root, FILE), 'utf8');
  const applied = run(root, { file: FILE, rules: RULES, apply: true }).answer.result;
  const organized = readFileSync(join(root, FILE), 'utf8');
  assert.notEqual(organized, before);
  const { status, answer } = run(root, { file: FILE, restore_from: applied.backup });
  assert.equal(status, 0);
  assert.equal(JSON.stringify(read(root)), JSON.stringify(JSON.parse(before)));
  assert.equal(readFileSync(join(root, answer.result.kept_current_as), 'utf8'), organized);
  assert.equal(readFileSync(join(root, applied.backup), 'utf8'), before, 'the backup itself is kept');
});

test('an organization that cannot be done honestly changes nothing and says what to fix', t => {
  const root = home(t);
  const before = readFileSync(join(root, FILE), 'utf8');
  const ask = rules => run(root, { file: FILE, rules, apply: true });
  assert.match(ask({ ...RULES, folders: { Cakes: ['Weddings'], Baking: [] }, rules: [] }).answer.error, /holds 4 folders but rules.folders needs exactly 3/);
  assert.match(ask({ ...RULES, space: 'Nowhere' }).answer.error, /no space titled/);
  assert.match(ask({ ...RULES, root_folder: 'Missing' }).answer.error, /exactly one folder titled/);
  assert.match(ask({ ...RULES, fallback: ['Cakes'] }).answer.error, /not a destination/);
  assert.match(ask({ ...RULES, rules: [{ put_in: ['Baking'] }] }).answer.error, /would cover every tab/);
  assert.match(ask({ ...RULES, rules: [{ put_in: ['Elsewhere'], words: ['x'] }] }).answer.error, /not a destination/);
  assert.match(ask({ ...RULES, relevant_words: 'wedding' }).answer.error, /list of non-empty text/);
  assert.equal(readFileSync(join(root, FILE), 'utf8'), before);
  assert.deepEqual(readdirSync(root), [FILE]);
});

test('something in the root folder that is not a folder, tab or split view stops the run', t => {
  const document = sidebar();
  const flat = document.sidebar.containers[1].items;
  flat.push('odd', { id: 'odd', parentID: 'kitchen', childrenIds: [], title: 'Odd', data: { easel: {} } });
  flat[flat.indexOf('kitchen') + 1].childrenIds.push('odd');
  const root = home(t, document);
  assert.match(run(root, { file: FILE, rules: RULES }).answer.error, /could not be kept/);
});

test('file names are plain names of regular files inside the granted folder', t => {
  const root = home(t);
  const outside = mkdtempSync(join(tmpdir(), 'saved-items-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, FILE), JSON.stringify(sidebar()));
  symlinkSync(join(outside, FILE), join(root, 'linked.json'));
  mkdirSync(join(root, 'inner'));
  for (const file of ['../' + FILE, join(outside, FILE), 'inner', 'linked.json', 'missing.json', '..', '']) {
    assert.match(run(root, { file, rules: RULES }).answer.error, /plain file name|not a regular file/, `refused: ${file}`);
  }
  assert.match(run(root, { file: FILE, restore_from: '../x' }).answer.error, /plain file name/);
  const notSidebar = join(root, 'other.json');
  writeFileSync(notSidebar, '{}');
  assert.match(run(root, { file: 'other.json', rules: RULES }).answer.error, /not a sidebar file/);
});
