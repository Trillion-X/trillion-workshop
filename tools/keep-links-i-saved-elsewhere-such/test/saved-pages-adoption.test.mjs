// F-0416 saved web pages, F-0833 URL provider registry, F-0835 video ingest normalisation: each over its real DATA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSavedLinks, findLinkProvider } from '../src/saved-links.mjs';
import { ingestDecision } from '../../make-a-video-playable-at-ingest/src/ingest-normalization.mjs';
import { fileTools } from '../../organize-my-files/src/file-tools.mjs';
import { savedLinkTools } from '../src/saved-links-tools.mjs';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
function harness() {
  const store = new Map();
  const removed = [];
  let clock = new Date('2026-10-19T10:00:00Z');
  let page = { url: 'https://example.com/a#frag', title: 'Alpha', text: 'First text', snapshot_base64: PNG, snapshot_media_type: 'image/png' };
  const links = makeSavedLinks({
    files: {
      read: async name => (store.has(name) ? (typeof store.get(name) === 'string' ? store.get(name) : null) : null),
      write: async (name, body) => { store.set(name, body); return { identity: name }; },
      remove: async (name, state) => { removed.push([name, state]); store.delete(name); },
    },
    run: async (tool, input) => { if (page instanceof Error) throw page; assert.equal(tool, 'tool:read-a-page-in-my-browser'); assert.ok(input.url); return page; },
    now: () => clock,
  });
  return { actions: links.actions(), store, removed, tick: ms => { clock = new Date(clock.getTime() + ms); }, setPage: next => { page = next; } };
}

test('F-0416 saved page: create, read, edit, scheduled refresh, failed refresh, delete', async () => {
  const h = harness();
  const saved = await h.actions['save-page']({ url: 'https://example.com/a#frag', refresh_every_hours: 2 });
  assert.equal(saved.url, 'https://example.com/a');
  assert.equal(saved.snapshot.media_type, 'image/png');
  assert.ok(h.store.get(saved.snapshot.file) instanceof Uint8Array);
  assert.equal(saved.last_refreshed_at, '2026-10-19T10:00:00.000Z');
  assert.equal(saved.next_refresh_at, '2026-10-19T12:00:00.000Z');
  assert.equal(saved.key.length, 32);

  assert.equal((await h.actions['read-saved-page']({ url: 'https://example.com/a' })).text, 'First text');
  assert.equal((await h.actions['read-saved-page']({})).pages.length, 1);

  const nothingDue = await h.actions['refresh-saved-pages']({});
  assert.equal(nothingDue.due, 0);

  h.tick(3 * 3600000);
  h.setPage({ url: 'https://example.com/a', title: 'Alpha 2', text: 'Second text' });
  const due = await h.actions['refresh-saved-pages']({});
  assert.equal(due.refreshed[0].last_refreshed_at, '2026-10-19T13:00:00.000Z');
  const reread = await h.actions['read-saved-page']({ key: saved.key });
  assert.deepEqual([reread.title, reread.text, reread.refresh_count, reread.snapshot.file], ['Alpha 2', 'Second text', 1, saved.snapshot.file]);

  h.tick(3 * 3600000);
  h.setPage(new Error('the page would not load'));
  const failed = await h.actions['refresh-saved-pages']({ key: saved.key });
  assert.equal(failed.refreshed[0].state, 'failed');
  const kept = await h.actions['read-saved-page']({ key: saved.key });
  assert.deepEqual([kept.text, kept.last_error], ['Second text', 'the page would not load']);

  const edited = await h.actions['edit-saved-page']({ key: saved.key, refresh_every_hours: null, title: 'Mine' });
  assert.deepEqual([edited.title, edited.refresh_every_hours, edited.next_refresh_at], ['Mine', null, null]);
  await assert.rejects(h.actions['edit-saved-page']({ key: saved.key, refresh_every_hours: 0 }), /whole number from 1 to 8760/);
  await assert.rejects(h.actions['save-page']({ url: 'ftp://x/y' }), /not an http or https address/);

  const gone = await h.actions['remove-saved-page']({ key: saved.key });
  assert.deepEqual(gone.kept_in, 'deleted');
  assert.equal(h.removed.length, 2);
  assert.equal((await h.actions['read-saved-page']({})).pages.length, 0);
  await assert.rejects(h.actions['read-saved-page']({ key: saved.key }), /There is no saved page/);
  console.log('READBACK F-0416', JSON.stringify({ saved: { key: saved.key, snapshot: saved.snapshot, next_refresh_at: saved.next_refresh_at }, after_refresh: { title: reread.title, last_refreshed_at: reread.last_refreshed_at }, failed: kept.last_error, removed_to: gone.kept_in }));
});

test('F-0416 a tool that draws no snapshot saves title and text and says so', async () => {
  const h = harness();
  h.setPage({ url: 'https://example.com/b', title: 'Beta', text: 'Body' });
  const saved = await h.actions['save-page']({ url: 'https://example.com/b' });
  assert.equal(saved.snapshot, null);
  assert.match(saved.said, /draws no snapshot picture/);
  assert.equal(saved.next_refresh_at, null);
});

test('F-0833 provider registry is keyed by host and names credentials, never values', () => {
  const found = findLinkProvider('https://mobile.twitter.com/someone/status/1');
  assert.equal(found.provider, 'x');
  assert.deepEqual(found.lists.map(list => list.tool), ['save_x_bookmarks', 'save_x_likes']);
  assert.deepEqual(found.auth.credential_names, ['x-sign-in-client-id', 'x-sign-in-client-secret']);
  assert.equal(found.auth.token_exchange, 'server');
  assert.doesNotMatch(JSON.stringify(found), /secret":|client_secret"\s*:\s*"[A-Za-z0-9]{8}/);
  assert.throws(() => findLinkProvider('https://notx.com/a'), /No registered provider handles https:\/\/notx\.com\/a\. Registered: X\./);
  assert.throws(() => findLinkProvider('not a url'), /No registered provider handles/);
  assert.throws(() => findLinkProvider(''), /Give url/);
  console.log('READBACK F-0833', JSON.stringify(found));
});

test('F-0835 video ingest: one playable format, supported list and reason in the words', async () => {
  const mov = ingestDecision({ name: '/clips/take 1.mov', media_type: 'video/quicktime', byte_length: 1e6 });
  assert.equal(mov.action, 'convert');
  assert.equal(mov.plan.output_name, '/clips/take 1.mp4');
  assert.ok(mov.plan.args.includes('libx264') && mov.plan.args.includes('{input}'));
  const gif = ingestDecision({ name: 'loop.gif', media_type: 'image/gif', byte_length: 10 });
  assert.ok(gif.plan.args.includes('-an'));
  assert.equal(ingestDecision({ name: 'a.bin', media_type: 'application/octet-stream', byte_length: 5 }).action, 'keep');
  assert.equal(ingestDecision({ name: 'a.webm', media_type: '', byte_length: 5 }).action, 'convert');
  assert.equal(ingestDecision({ name: 'a.mp4', media_type: 'video/mp4' }).action, 'keep');
  assert.equal(ingestDecision({ name: 'a.txt', media_type: 'text/plain' }).said, null);
  const huge = ingestDecision({ name: 'big.avi', media_type: 'video/x-msvideo', byte_length: 5 * 1024 ** 3 });
  assert.equal(huge.action, 'keep');
  assert.match(huge.said, /5120 MiB, more than the 4096 MiB one conversion takes/);
  const odd = ingestDecision({ name: 'a.ogv', media_type: 'video/ogg', byte_length: 5 });
  assert.match(odd.said, /video\/ogg is not a video type Trillion converts.*Converts: QuickTime MOV, WebM, AVI/);

  const calls = [];
  const finish = fileTools(async (path, body) => { calls.push(path); return { identity: '1f:' + 'a'.repeat(64), names: ['/clips/take 1.mov'], media_type: 'video/quicktime', byte_length: 2e6 }; }).find(tool => tool.name === 'finish_file_upload');
  const finished = await finish.run({ upload: 'u1' });
  assert.equal(finished.ingest.action, 'convert');
  assert.equal(finished.ingest.plan.to, 'video/mp4');
  console.log('READBACK F-0835', JSON.stringify({ finish_file_upload: finished.ingest, too_big: huge.said, unlisted: odd.said }));
});

test('the page and provider tools are listed with their words', () => {
  const names = savedLinkTools(() => {}).map(tool => tool.name);
  for (const name of ['save_page', 'read_saved_page', 'edit_saved_page', 'refresh_saved_pages', 'remove_saved_page', 'find_link_provider']) assert.ok(names.includes(name), name);
});
