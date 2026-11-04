// tools/save-a-web-page-as-a-clip/test/saved-pages.test.mjs
//
// The saved-pages module against an in-memory files store and a made-up capture tool: save, read, edit, refresh when due,
// a failed refresh that keeps the last good text, and removal. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import settings from '../src/saved-pages.json' with { type: 'json' };
import { makeSavedPages, pageAddress, pageKey, refreshHours, SavedPagesError } from '../src/saved-pages.mjs';

function memoryFiles() {
  const kept = new Map();
  const removed = [];
  return {
    kept, removed,
    read: async name => (kept.has(name) ? String(kept.get(name).body) : null),
    write: async (name, body, media_type) => { kept.set(name, { body, media_type }); },
    remove: async (name, state) => { kept.delete(name); removed.push({ name, state }); },
  };
}

function setup({ pages }) {
  const files = memoryFiles();
  const calls = [];
  let clock = new Date('2026-11-04T10:00:00Z');
  const run = async (tool_id, input, purpose) => {
    calls.push({ tool_id, input, purpose });
    const page = pages[input.url];
    if (page instanceof Error) throw page;
    return page;
  };
  const saved = makeSavedPages({ files, run, now: () => clock });
  return { files, calls, saved, tick: hours => { clock = new Date(clock.getTime() + hours * 3600000); } };
}

test('an address is its http(s) form without the fragment, and its key is a fixed-length BLAKE3 prefix', () => {
  assert.equal(pageAddress(' https://example.test/a#part '), 'https://example.test/a');
  assert.equal(pageAddress('ftp://example.test/a'), null);
  assert.equal(pageAddress('not an address'), null);
  const key = pageKey('https://example.test/a');
  assert.match(key, new RegExp(`^[0-9a-f]{${settings.key_chars}}$`));
  assert.equal(key, pageKey('https://example.test/a'));
  assert.notEqual(key, pageKey('https://example.test/b'));
});

test('a refresh policy is null or a whole number of hours in range', () => {
  assert.equal(refreshHours(null), null);
  assert.equal(refreshHours(24), 24);
  assert.throws(() => refreshHours(0), SavedPagesError);
  assert.throws(() => refreshHours(1.5), SavedPagesError);
  assert.throws(() => refreshHours(settings.refresh.max_every_hours + 1), SavedPagesError);
});

test('save keeps the page, its snapshot and an index row; saving again replaces the same record', async () => {
  const url = 'https://example.test/recipe';
  const { files, calls, saved } = setup({ pages: { [url]: { url, title: 'Bread', text: 'Flour, water, salt.', snapshot_base64: btoa('png-bytes'), snapshot_media_type: 'image/png' } } });
  const page = await saved.savePage({ url, refresh_every_hours: 24 });
  assert.equal(calls[0].tool_id, settings.capture.tool_id);
  assert.equal(page.title, 'Bread');
  assert.equal(page.state, 'ok');
  assert.equal(page.next_refresh_at, '2026-11-05T10:00:00.000Z');
  assert.equal(page.snapshot.media_type, 'image/png');
  assert.ok(files.kept.has(page.snapshot.file));
  await saved.savePage({ url, refresh_every_hours: 24 });
  const { pages } = await saved.readSavedPage();
  assert.equal(pages.length, 1);
  assert.equal(pages[0].key, page.key);
});

test('a tool that draws no picture saves the page without one and says so; a page with no text is refused', async () => {
  const plain = 'https://example.test/plain';
  const empty = 'https://example.test/empty';
  const { saved } = setup({ pages: { [plain]: { url: plain, title: 'Plain', text: 'Words only.' }, [empty]: { url: empty, title: 'Empty', text: '' } } });
  const page = await saved.savePage({ url: plain });
  assert.equal(page.snapshot, null);
  assert.equal(page.said, settings.words.no_snapshot);
  await assert.rejects(saved.savePage({ url: empty }), SavedPagesError);
  await assert.rejects(saved.savePage({ url: 'mailto:someone' }), SavedPagesError);
});

test('edit changes only the title and refresh policy', async () => {
  const url = 'https://example.test/notes';
  const { saved } = setup({ pages: { [url]: { url, title: 'Notes', text: 'Some notes.' } } });
  await saved.savePage({ url });
  const edited = await saved.editSavedPage({ url, title: 'My notes', refresh_every_hours: 2 });
  assert.equal(edited.title, 'My notes');
  assert.equal(edited.text, 'Some notes.');
  assert.equal(edited.refresh_every_hours, 2);
  assert.equal((await saved.readSavedPage()).pages[0].title, 'My notes');
});

test('refresh reads only the pages that are due; a failed refresh keeps the last good text and says why', async () => {
  const due = 'https://example.test/due';
  const never = 'https://example.test/never';
  const pages = { [due]: { url: due, title: 'Due', text: 'First text.' }, [never]: { url: never, title: 'Never', text: 'Kept.' } };
  const { saved, tick } = setup({ pages });
  await saved.savePage({ url: due, refresh_every_hours: 1 });
  await saved.savePage({ url: never });
  assert.equal((await saved.refreshPages()).due, 0);
  tick(2);
  pages[due] = { url: due, title: 'Due', text: 'Second text.' };
  const first = await saved.refreshPages();
  assert.deepEqual([first.due, first.total], [1, 2]);
  assert.equal((await saved.readSavedPage({ url: due })).text, 'Second text.');
  tick(2);
  pages[due] = new Error('the page did not load');
  await saved.refreshPages();
  const failed = await saved.readSavedPage({ url: due });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.text, 'Second text.');
  assert.equal(failed.last_error, 'the page did not load');
});

test('remove sets the page and its snapshot aside and takes it out of the index', async () => {
  const url = 'https://example.test/gone';
  const { files, saved } = setup({ pages: { [url]: { url, title: 'Gone', text: 'Soon gone.', snapshot_base64: btoa('jpg'), snapshot_media_type: 'image/jpeg' } } });
  const page = await saved.savePage({ url });
  const answer = await saved.removePage({ url });
  assert.equal(answer.kept_in, settings.removal);
  assert.deepEqual(files.removed.map(row => row.name).sort(), [page.file, page.snapshot.file].sort());
  assert.equal((await saved.readSavedPage()).pages.length, 0);
  await assert.rejects(saved.readSavedPage({ url }), SavedPagesError);
});

test('the actions name each step', async () => {
  const { saved } = setup({ pages: {} });
  assert.deepEqual(Object.keys(saved.actions()), ['save-page', 'read-saved-page', 'edit-saved-page', 'refresh-saved-pages', 'remove-saved-page']);
});
