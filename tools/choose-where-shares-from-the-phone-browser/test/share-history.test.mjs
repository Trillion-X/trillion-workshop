import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptKeptShares, filesText, keptShare, sharesSent } from '../read-data/share-history.mjs';
import { SHARES_PATH } from '../read-data/share-destinations.mjs';

// All names, folders and words here are synthetic.
const folder = '/Shared from iPhone/key-1';
const shareJson = JSON.stringify({ items: [{ kind: 'text', text: 'A made-up note.' }], own_words: 'Kept', received_at: '2026-11-20T12:00:00.000Z' });

test('a kept folder becomes one share row: its share.json items and the files beside it that it does not name', () => {
  const row = keptShare(folder, 'iPhone', {
    source: JSON.parse(shareJson),
    files: [
      { name: `${folder}/share.json`, identity: 'id-json', media_type: 'application/json', modified_at_ms: 1 },
      { name: `${folder}/12-photo.jpg`, identity: 'id-photo', media_type: 'image/jpeg', modified_at_ms: 2 },
    ],
  });
  assert.equal(row.kept_in, folder);
  assert.equal(row.from, 'iPhone');
  assert.equal(row.at, '2026-11-20T12:00:00.000Z');
  assert.equal(row.own_words, 'Kept');
  assert.deepEqual(row.items.map(item => item.kind), ['text', 'image']);
  assert.deepEqual(row.items[1], { kind: 'image', name: 'photo.jpg', file: 'id-photo' });
});

test('a kept folder with nothing to show is no row', () => {
  assert.equal(keptShare(folder, 'iPhone', { source: null, files: [{ name: `${folder}/share.json`, identity: 'x' }] }), null);
});

test('adoption sends only the folders the list has not seen, and adds their rows', async () => {
  const posted = [];
  const person = {
    namespaceChildFolders: async () => [`${folder}`],
    namespaceListNames: async () => ({ names: [{ name: `${folder}/share.json`, identity: 'id-json', media_type: 'application/json', modified_at_ms: 3 }] }),
    fetch: async request => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json() : null;
      posted.push({ path, body });
      if (path === `${SHARES_PATH}/unknown`) return Response.json({ folders: body.folders });
      if (path === `${SHARES_PATH}/adopt`) return Response.json({ adopted: body.shares.length });
      return Response.json({ shares: [] });
    },
  };
  const adopted = await adoptKeptShares({ person, readText: async () => shareJson });
  assert.equal(adopted, 2);
  const unknown = posted.find(call => call.path === `${SHARES_PATH}/unknown`);
  assert.ok(unknown.body.folders.includes(folder));
  const adopt = posted.find(call => call.path === `${SHARES_PATH}/adopt`);
  assert.equal(adopt.body.shares[0].kept_in, folder);
});

test('the share list reads kept shares in on its first page only; a later page reads the list as it is', async () => {
  let childReads = 0;
  const person = {
    namespaceChildFolders: async () => { childReads += 1; return []; },
    namespaceListNames: async () => ({ names: [] }),
    fetch: async request => Response.json({ shares: [], path: new URL(request.url).pathname + new URL(request.url).search }),
  };
  const first = await sharesSent({ person, readText: async () => null, search: '' });
  assert.equal(childReads, 2);
  assert.equal(first.path, SHARES_PATH);
  const later = await sharesSent({ person, readText: async () => null, search: 'before=2026-11-20' });
  assert.equal(childReads, 2);
  assert.equal(later.path, `${SHARES_PATH}?before=2026-11-20`);
});

test('a kept file is read through the namespace contents owner passed in, as utf-8 text only', async () => {
  const seen = [];
  const handle = async (request) => { seen.push(JSON.parse(await request.text()).name); return Response.json({ encoding: 'utf-8', content: 'kept words' }); };
  const read = filesText(handle, {}, 'user-1', 'https://account.example')('/Shared from iPhone/key-1/share.json');
  assert.equal(await read, 'kept words');
  assert.deepEqual(seen, ['/Shared from iPhone/key-1/share.json']);
  const binary = filesText(async () => Response.json({ encoding: 'base64', content: 'AAAA' }), {}, 'user-1', 'https://account.example');
  assert.equal(await binary('/Shared from iPhone/key-1/photo.jpg'), null);
});
