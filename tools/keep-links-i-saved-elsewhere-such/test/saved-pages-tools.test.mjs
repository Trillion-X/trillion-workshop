// tools/keep-links-i-saved-elsewhere-such/test/saved-pages-tools.test.mjs
//
// The saved-page tools (do-work/saved-pages.mjs) against a fake host: an in-memory Files right (find_file, read_file,
// write_file_start, write_file_piece, write_file_finish) and a made-up capture tool. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { savePage, readSavedPage, editSavedPage, refreshSavedPages, findLinkProvider } from '../do-work/saved-pages.mjs';

function fakeHost({ pages = {}, filesRight = true } = {}) {
  const store = new Map();
  const uploads = new Map();
  const calls = [];
  const host = {
    store, calls,
    async files(op, args) {
      calls.push(op);
      if (!filesRight) throw Object.assign(new Error('This run has no files right.'), { code: 'no_files' });
      if (op === 'find_file') {
        if (!store.has(args.name_or_identity)) throw Object.assign(new Error('not found'), { code: 'not_found' });
        return { names: [args.name_or_identity] };
      }
      if (op === 'read_file') {
        const bytes = store.get(args.name_or_identity);
        const piece = bytes.subarray(args.offset, args.offset + args.length);
        return { content: piece.toString('base64'), encoding: 'base64', byte_length: bytes.length, bytes_returned: piece.length };
      }
      if (op === 'write_file_start') { uploads.set(args.upload_id, { name: args.name, parts: [] }); return { next_offset: 0 }; }
      if (op === 'write_file_piece') { uploads.get(args.upload_id).parts.push(Buffer.from(args.content_base64, 'base64')); return {}; }
      if (op === 'write_file_finish') {
        const up = uploads.get(args.upload_id);
        store.set(up.name, Buffer.concat(up.parts));
        return { name: up.name, state: 'written' };
      }
      throw new Error(`unexpected files operation ${op}`);
    },
    async run(tool, input) {
      calls.push(tool);
      assert.equal(tool, 'tool:read-a-page-in-my-browser');
      const page = pages[input.url];
      if (page instanceof Error) throw page;
      return page;
    },
  };
  return host;
}

const PAGE = { url: 'https://example.com/a', title: 'Alpha', text: 'First text' };

test('save, read, and list a saved page through the Files right', async () => {
  const host = fakeHost({ pages: { [PAGE.url]: PAGE } });
  const saved = await savePage({ url: 'https://example.com/a#frag', refresh_every_hours: 2 }, host);
  assert.equal(saved.url, PAGE.url);
  assert.equal(saved.state, 'ok');
  assert.ok([...host.store.keys()].some(name => name.startsWith('/Saved pages/')));
  assert.equal((await readSavedPage({ url: PAGE.url }, host)).text, 'First text');
  assert.equal((await readSavedPage({}, host)).pages.length, 1);
});

test('a read of a page never saved says so by name', async () => {
  const host = fakeHost();
  await assert.rejects(readSavedPage({ url: 'https://example.com/never' }, host), /There is no saved page/);
});

test('a host without the Files right is refused with its own code, never answered as an empty list', async () => {
  const host = fakeHost({ filesRight: false });
  await assert.rejects(readSavedPage({}, host), { code: 'no_files' });
});

test('a failed refresh keeps the last good text and records why', async () => {
  const pages = { [PAGE.url]: PAGE };
  const host = fakeHost({ pages });
  await savePage({ url: PAGE.url, refresh_every_hours: 1 }, host);
  pages[PAGE.url] = new Error('the page did not load');
  const refreshed = await refreshSavedPages({ url: PAGE.url }, host);
  assert.equal(refreshed.refreshed[0].state, 'failed');
  const kept = await readSavedPage({ url: PAGE.url }, host);
  assert.equal(kept.text, 'First text');
  assert.match(kept.last_error, /did not load/);
});

test('editing the refresh policy keeps the page and its text', async () => {
  const host = fakeHost({ pages: { [PAGE.url]: PAGE } });
  await savePage({ url: PAGE.url }, host);
  const edited = await editSavedPage({ url: PAGE.url, refresh_every_hours: 6 }, host);
  assert.equal(edited.refresh_every_hours, 6);
  assert.equal(edited.text, 'First text');
});

test('find-link-provider names the provider of a known address and refuses an unknown one', async () => {
  const found = await findLinkProvider({ url: 'https://x.com/someone/status/1' });
  assert.equal(found.provider, 'x');
  assert.equal(found.label, 'X');
  await assert.rejects(findLinkProvider({ url: 'https://no-such-provider.invalid/x' }), /no-such-provider/);
  await assert.rejects(findLinkProvider({}));
});
