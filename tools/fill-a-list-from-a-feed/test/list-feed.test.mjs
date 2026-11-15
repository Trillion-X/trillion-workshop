import assert from 'node:assert/strict';
import test from 'node:test';
import { fillListFromFeed, listFeedActions } from '../read-data/list-feed.mjs';

function records() {
  const data = new Map();
  const calls = [];
  return {
    data, calls,
    async read(type, id) { calls.push(['read', type, id]); return structuredClone(data.get(id) ?? null); },
    async write(rows) {
      calls.push(['write', rows]);
      for (const row of rows) assert.deepEqual(row.expected, data.has(row.id) ? { type: row.type, value: data.get(row.id) } : null);
      for (const row of rows) data.set(row.id, structuredClone(row.value));
      return { written: rows.length };
    },
    async files(method, input) {
      calls.push(['files', method, input]);
      if (method === 'write_file_start') return { next_offset: 0 };
      if (method === 'write_file_finish') return { identity: `1f:${'a'.repeat(64)}` };
      return {};
    },
  };
}
const fields = [
  { id: 'title', kind: 'text' }, { id: 'picture', kind: 'file' },
  { id: 'note', kind: 'text' }, { id: 'seen', kind: 'date' }, { id: 'source', kind: 'text' },
];
const input = { list_id: 'news', feed: 'https://feeds.example/news', values: { title: '$.title', picture: '$.picture' } };
const withList = () => {
  const door = records();
  door.data.set('list:news', { label: 'News', row_type: 'news', fields });
  return door;
};

test('lists door preserves edits, downloads media once and patches only nonempty changed fields', async () => {
  const door = withList();
  let items = [{ id: 'a', title: 'First', picture: '/one.png' }, { id: 'b', title: 'Second' }];
  const read = async url => String(url).endsWith('/one.png')
    ? new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/png' } }) : Response.json(items);
  const run = listFeedActions({ door, read })['fill-a-list-from-a-feed'];
  assert.deepEqual((await run(input)).added, ['a', 'b']);
  assert.equal(door.data.get('record:news:a').picture, '/Lists/News/a-one.png');
  assert.equal(door.calls.find(call => call[0] === 'files' && call[1] === 'write_file_piece')[2].content_base64, 'AQID');
  door.data.set('record:news:a', { ...door.data.get('record:news:a'), title: 'Edited', note: 'Keep mine' });
  items = [{ id: 'a', title: 'Changed', picture: '/other.png' }, { id: 'b', title: '' }];
  assert.deepEqual((await run(input)).added, []);
  assert.equal(door.data.get('record:news:a').title, 'Edited');
  const updated = await run({ ...input, update_existing: true, stamp: 'seen' });
  assert.deepEqual(updated.updated, ['a']);
  assert.equal(door.data.get('record:news:a').title, 'Changed');
  assert.equal(door.data.get('record:news:a').note, 'Keep mine');
  assert.equal(door.data.get('record:news:b').title, 'Second');
  assert.equal(door.data.get('record:news:a').seen, door.data.get('record:news:b').seen);
  assert.equal(door.calls.filter(call => call[0] === 'files' && call[1] === 'write_file_start').length, 1);
});

test('held rows are read by candidate id and colliding source keys retain stable distinct ids', async () => {
  const door = withList();
  door.data.set('record:news:old', { title: 'Do not replace' });
  const run = listFeedActions({ door, read: async () => Response.json({ rows: [{ id: 'old', title: 'New' }, { id: 'a/b', title: 'Slash' }, { id: 'a-b', title: 'Dash' }, { id: 'a/b', title: 'Duplicate' }] }) })['fill-a-list-from-a-feed'];
  const first = await run({ ...input, most: 1, fixed: { source: 'feed' } });
  assert.equal(first.added.length, 1);
  assert.equal(first.waiting, 1);
  assert.match(first.added[0], /^a-b\.[a-f0-9]{16}$/);
  assert.deepEqual((await run({ ...input, most: 1 })).added, ['a-b']);
  assert.equal(door.data.get('record:news:old').title, 'Do not replace');
});

test('RSS uses canonical reader; success stamp is an awaited conditional write', async () => {
  const door = withList();
  door.data.set('record:news:source', { title: 'Source' });
  const run = listFeedActions({ door, read: async () => new Response('<rss><channel><item><guid>g1</guid><title>First &amp; best</title></item></channel></rss>') })['fill-a-list-from-a-feed'];
  const result = await run({ ...input, stamp_row: { list_id: 'news', row_id: 'source', field: 'seen' } });
  assert.equal(door.data.get('record:news:g1').title, 'First & best');
  assert.equal(door.data.get('record:news:source').seen, result.stamped.at);
});

test('bad stamp, shape, insecure feed and unknown fields refuse without row writes', async () => {
  const door = withList();
  let reads = 0;
  const run = listFeedActions({ door, read: async () => { reads++; return Response.json({ unavailable: true }); } })['fill-a-list-from-a-feed'];
  await assert.rejects(run({ ...input, stamp_row: { list_id: 'news', row_id: 'missing', field: 'seen' } }), /no row/);
  assert.equal(reads, 0);
  await assert.rejects(run({ ...input, feed: 'http://feeds.example' }), /https/);
  await assert.rejects(run({ ...input, values: { nowhere: '$.title' } }), /no field/);
  assert.equal(reads, 0);
  await assert.rejects(run(input), /did not return a list/);
  assert.equal(door.calls.filter(call => call[0] === 'write').length, 0);
});

test('library path retains batching and most excludes unchanged entries', async () => {
  const calls = [];
  const context = {
    read: async () => Response.json({ rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
    library: { async add({ entries }) { calls.push(entries); return { entries: entries.map(entry => ({ id: entry.id, status: entry.id === 'a' ? 'unchanged' : 'added' })) }; } },
  };
  const result = await fillListFromFeed(context, { feed: input.feed, into: { dataset: 'examples' }, values: { title: '$.id' }, most: 1, fixed: { licence: 'MIT' } });
  assert.deepEqual(result.added, ['b']);
  assert.equal(result.unchanged, 1);
  assert.equal(result.waiting, 1);
  assert.equal(calls[0][0].licence, 'MIT');
  await assert.rejects(fillListFromFeed(context, { feed: input.feed, into: { dataset: 'examples' }, values: { title: '$.id' }, stamp: 'seen' }), /needs a list/);
});

test('write rejection never reports added or saves a successful-run stamp', async () => {
  const door = withList();
  door.data.set('record:news:source', { title: 'Source' });
  door.write = async () => { throw Object.assign(new Error('changed meanwhile'), { code: 'original_command_conflict' }); };
  const run = listFeedActions({ door, read: async () => Response.json([{ id: 'a', title: 'New' }]) })['fill-a-list-from-a-feed'];
  await assert.rejects(run({ ...input, stamp_row: { list_id: 'news', row_id: 'source', field: 'seen' } }), /changed meanwhile/);
  assert.equal(door.data.get('record:news:source').seen, undefined);
});
