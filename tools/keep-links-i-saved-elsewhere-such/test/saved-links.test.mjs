// Ported from old trillion test/saved-links.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The Arc and X page tests are the old ones over src/saved-links.mjs here. The Arc tool test runs
// the account action makeSavedLinks gives (actions()['save-browser-saved-items']) where the old one ran it through
// makeWorkshop over the shared rows; a refusal is a rejected action where the old Workshop answered it as a failed task. The
// MCP tools test reads src/saved-links-tools.mjs savedLinkTools, which the old src/tools.mjs makeTools listed. Left out: the
// shared-rows test and the two X bookmark tests (connect, poll on the alarm, a removed newest bookmark), which need the X
// and save tools as Workshop rows and the event rules; this tool's rows are kept, not wired
// (from-old-trillion/records/workshop-saved-links-tool-records.json, its README says so), and old scripts/workshop-rows.mjs
// runs nowhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBrowserFile, linksFromPage, makeSavedLinks } from '../src/saved-links.mjs';
import { savedLinkAnnotations, savedLinkTools } from '../src/saved-links-tools.mjs';
import settings from '../../shared-code/src/saved-links.json' with { type: 'json' };

const ARC = settings.browser_files['arc-sidebar'];
const X = settings.service_lists['x-bookmarks'];

// An Arc file in the shape Arc writes: lists that alternate a key and its value, two spaces, a nested folder, a split
// view, open tabs under Today, and favorites along the top.
const node = (id, parentID, extra) => [id, { id, parentID, childrenIds: [], createdAt: 800000000, ...extra }];
const tab = (id, parentID, title, url) => node(id, parentID, { title: null, data: { tab: { savedTitle: title, savedURL: url } } });
function arcFile() {
  const items = [
    node('work-pinned', null, { data: { itemContainer: {} }, childrenIds: ['design', 'split', 'docs'] }),
    node('design', 'work-pinned', { title: 'Design', data: { list: {} }, childrenIds: ['refs', 'mobbin'] }),
    node('refs', 'design', { title: 'References', data: { list: {} }, childrenIds: ['linear'] }),
    tab('linear', 'refs', 'Linear', 'https://linear.app'),
    tab('mobbin', 'design', 'Mobbin', 'https://mobbin.com'),
    node('split', 'work-pinned', { title: 'side by side', data: { splitView: {} }, childrenIds: ['left', 'right'] }),
    tab('left', 'split', 'Left page', 'https://example.com/left'),
    tab('right', 'split', 'Right page', 'https://example.com/right'),
    tab('docs', 'work-pinned', 'Docs', 'https://docs.example.com'),
    node('work-today', null, { data: { itemContainer: {} }, childrenIds: ['open'] }),
    tab('open', 'work-today', 'Just open', 'https://news.example.com'),
    node('home-pinned', null, { data: { itemContainer: {} }, childrenIds: ['recipes'] }),
    tab('recipes', 'home-pinned', 'Recipes', 'https://recipes.example.com'),
    node('favorites', null, { data: { itemContainer: { containerType: { topApps: {} } } }, childrenIds: ['mail'] }),
    tab('mail', 'favorites', 'Mail', 'https://mail.example.com'),
  ].flat();
  const spaces = [
    'space-work', { title: 'Work', containerIDs: ['pinned', 'work-pinned', 'unpinned', 'work-today'] },
    'space-home', { containerIDs: ['unpinned', 'nothing', 'pinned', 'home-pinned'] },
  ];
  return { version: 1, sidebar: { containers: [{ global: {} }, { items, spaces, topAppsContainerIDs: [{ default: true }, 'favorites'] }] } };
}

test('an Arc file becomes one list per space: pinned tabs with their folders, favorites, and never the open tabs', () => {
  const groups = decodeBrowserFile(arcFile(), ARC);
  assert.deepEqual(groups.map(group => group.group), ['Work', 'Space', 'Favorites'], 'a space with no title is named by the DATA');
  const work = groups[0].links;
  assert.deepEqual(work.map(link => [link.title, link.folder]), [
    ['Linear', ['Design', 'References']],
    ['Mobbin', ['Design']],
    ['Left page', []],
    ['Right page', []],
    ['Docs', []],
  ], 'a split view passes its tabs on to the folder it sits in');
  assert.ok(!work.some(link => link.url === 'https://news.example.com'));
  assert.equal(work[0].saved_at, new Date(Date.parse('2001-01-01T00:00:00Z') + 800000000 * 1000).toISOString());
  assert.deepEqual(groups[2].links.map(link => link.url), ['https://mail.example.com']);
});

test('one X page becomes links with each post\'s author and address; a post without an author still has an address', () => {
  const links = linksFromPage({
    data: [{ id: '19', text: 'Build the stomach', author_id: '7', created_at: '2026-09-01T00:00:00.000Z' }, { id: '18', text: 'No author here', author_id: '404' }],
    includes: { users: [{ id: '7', username: 'sam', name: 'Sam' }] },
  }, X);
  assert.deepEqual(links[0], { key: '19', url: 'https://x.com/sam/status/19', title: 'Build the stomach', author: 'sam', author_name: 'Sam', posted_at: '2026-09-01T00:00:00.000Z' });
  assert.equal(links[1].url, 'https://x.com/i/web/status/18');
});


// One account's files in memory and its saved-links actions.
function account() {
  const files = new Map();
  const savedLinks = makeSavedLinks({
    files: { read: async name => files.get(name) ?? null, write: async (name, text) => { files.set(name, text); return { identity: `1f:${'0'.repeat(64)}` }; } },
    run: async () => { throw new Error('no Workshop tool is run for a browser file'); },
    now: () => new Date('2026-09-29T10:00:00.000Z'),
  });
  return { files, actions: savedLinks.actions() };
}

test('the Arc tool reads a file already in the person\'s files and keeps one file per space; an unknown file changes nothing', async () => {
  const a = account();
  a.files.set('/Arc/StorableSidebar.json', JSON.stringify(arcFile()));
  const output = await a.actions['save-browser-saved-items']({ file: '/Arc/StorableSidebar.json' });
  assert.deepEqual(output, { saved_from: 'Arc', groups: [
    { group: 'Work', file: '/Saved links/Arc - Work.json', links: 5 },
    { group: 'Space', file: '/Saved links/Arc - Space.json', links: 1 },
    { group: 'Favorites', file: '/Saved links/Arc - Favorites.json', links: 1 },
  ], links: 7 });
  assert.deepEqual(JSON.parse(a.files.get('/Saved links/Arc - Work.json')).links[0], { title: 'Linear', url: 'https://linear.app', folder: ['Design', 'References'], saved_at: '2026-05-09T06:13:20.000Z' });

  a.files.set('/notes.json', JSON.stringify({ hello: 'world' }));
  await assert.rejects(a.actions['save-browser-saved-items']({ file: '/notes.json' }), /not a saved-items file Trillion can read/);
  assert.equal(a.files.size, 5);
});

test('any AI reaches every job as MCP tools that run the same Workshop tools', async () => {
  const calls = [];
  const tools = savedLinkTools(async (path, body) => { calls.push([path, body]); return { state: 'completed' }; });
  for (const [name, tool_id] of [['save_browser_saved_items', 'tool:save-browser-saved-items'], ['save_x_bookmarks', 'tool:save-x-bookmarks'], ['save_x_likes', 'tool:save-x-likes']]) {
    const tool = tools.find(item => item.name === name);
    assert.ok(savedLinkAnnotations[name], `${name} has its annotations`);
    await tool.run(name.startsWith('save_x_') ? {} : { file: '/Arc/StorableSidebar.json' });
    assert.equal(calls.at(-1)[0], '/tools/run');
    assert.equal(calls.at(-1)[1].tool_id, tool_id);
  }
});
