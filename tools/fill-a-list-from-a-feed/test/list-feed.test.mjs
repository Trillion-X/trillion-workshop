import assert from 'node:assert/strict';
import test from 'node:test';
import { fillAListFromFeed, fillListFromFeed } from '../read-data/list-feed.mjs';

const fields = [
  { id: 'title', kind: 'text' }, { id: 'picture', kind: 'file' },
  { id: 'note', kind: 'text' }, { id: 'seen', kind: 'date' }, { id: 'source', kind: 'text' },
];
const listRecord = { id: 'list:news', type: 'list', value: { label: 'News', row_type: 'news', fields } };
const input = { list_id: 'news', row_kind: 'record:news', feed: 'https://feeds.example/news', values: { title: '$.title', picture: '$.picture' } };

// What the caller does with a run's keep: rows are written where the person keeps them (value null removes), files kept by name.
function persist(records, keep) {
  const map = new Map(records.map(record => [record.id, structuredClone(record)]));
  for (const kept of keep) {
    if (kept.file !== undefined) continue;
    if (kept.value === null) map.delete(kept.id);
    else map.set(kept.id, { id: kept.id, type: kept.type, value: structuredClone(kept.value) });
  }
  return [...map.values()];
}
const rowOf = (records, id) => records.find(record => record.id === id)?.value;
const withRow = (records, id, value) => [...records.filter(record => record.id !== id), { id, type: 'record:news', value }];
const run = (records, extra, read) => fillAListFromFeed({ ...input, ...extra, stored: { records } }, { read });

test('lists given by the caller: edits are kept, media is kept once, only changed fields are patched', async () => {
  let items = [{ id: 'a', title: 'First', picture: '/one.png' }, { id: 'b', title: 'Second' }];
  let reads = 0;
  const read = async url => { reads++; return String(url).endsWith('/one.png')
    ? new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/png' } }) : Response.json(items); };
  const first = await run([listRecord], {}, read);
  assert.deepEqual(first.added, ['a', 'b']);
  const files = first.keep.filter(kept => kept.file !== undefined);
  assert.deepEqual(files, [{ file: '/Lists/News/a-one.png', base64: 'AQID' }]);
  let records = persist([listRecord], first.keep);
  assert.equal(rowOf(records, 'record:news:a').picture, '/Lists/News/a-one.png');
  records = withRow(records, 'record:news:a', { ...rowOf(records, 'record:news:a'), title: 'Edited', note: 'Keep mine' });
  items = [{ id: 'a', title: 'Changed', picture: '/other.png' }, { id: 'b', title: '' }];
  const second = await run(records, {}, read);
  assert.deepEqual(second.added, []);
  assert.equal(second.keep.length, 0);
  records = persist(records, second.keep);
  assert.equal(rowOf(records, 'record:news:a').title, 'Edited');
  const updated = await run(records, { update_existing: true, stamp: 'seen' }, read);
  assert.deepEqual(updated.updated, ['a']);
  records = persist(records, updated.keep);
  assert.equal(rowOf(records, 'record:news:a').title, 'Changed');
  assert.equal(rowOf(records, 'record:news:a').note, 'Keep mine');
  assert.equal(rowOf(records, 'record:news:b').title, 'Second');
  assert.equal(rowOf(records, 'record:news:a').seen, rowOf(records, 'record:news:b').seen);
  assert.equal(updated.keep.filter(kept => kept.file !== undefined).length, 0);
});

test('held rows are read by candidate id and colliding source keys keep stable distinct ids', async () => {
  const held = { id: 'record:news:old', type: 'record:news', value: { title: 'Do not replace' } };
  const read = async () => Response.json({ rows: [{ id: 'old', title: 'New' }, { id: 'a/b', title: 'Slash' }, { id: 'a-b', title: 'Dash' }, { id: 'a/b', title: 'Duplicate' }] });
  const first = await run([listRecord, held], { most: 1, fixed: { source: 'feed' } }, read);
  assert.equal(first.added.length, 1);
  assert.equal(first.waiting, 1);
  assert.match(first.added[0], /^a-b\.[a-f0-9]{16}$/);
  let records = persist([listRecord, held], first.keep);
  const second = await run(records, { most: 1 }, read);
  assert.deepEqual(second.added, ['a-b']);
  records = persist(records, second.keep);
  assert.equal(rowOf(records, 'record:news:old').title, 'Do not replace');
});

test('RSS uses the canonical reader; the success stamp is kept on its row with what it was given', async () => {
  const source = { id: 'record:news:source', type: 'record:news', value: { title: 'Source' } };
  const read = async () => new Response('<rss><channel><item><guid>g1</guid><title>First &amp; best</title></item></channel></rss>');
  const result = await run([listRecord, source], { stamp_row: { list_id: 'news', row_id: 'source', field: 'seen' } }, read);
  const records = persist([listRecord, source], result.keep);
  assert.equal(rowOf(records, 'record:news:g1').title, 'First & best');
  assert.equal(rowOf(records, 'record:news:source').seen, result.stamped.at);
  const stamp = result.keep.find(kept => kept.id === 'record:news:source');
  assert.deepEqual(stamp.expected, { type: 'record:news', value: { title: 'Source' } });
});

test('bad stamp, shape, insecure feed and unknown fields refuse without reading the feed or keeping rows', async () => {
  let reads = 0;
  const read = async () => { reads++; return Response.json({ unavailable: true }); };
  await assert.rejects(run([listRecord], { stamp_row: { list_id: 'news', row_id: 'missing', field: 'seen' } }, read), /no row/);
  assert.equal(reads, 0);
  await assert.rejects(run([listRecord], { feed: 'http://feeds.example' }, read), /https/);
  await assert.rejects(run([listRecord], { values: { nowhere: '$.title' } }, read), /no field/);
  assert.equal(reads, 0);
  await assert.rejects(run([listRecord], {}, read), /did not return a list/);
  await assert.rejects(run([], {}, read), /no list news/);
  assert.equal(reads, 1);
});

test('a kept row carries the record as it was given, so the caller writes only if the store still holds it', async () => {
  const held = { id: 'record:news:a', type: 'record:news', value: { title: 'Old' } };
  const result = await run([listRecord, held], { update_existing: true }, async () => Response.json([{ id: 'a', title: 'New' }]));
  assert.deepEqual(result.updated, ['a']);
  const kept = result.keep.find(row => row.id === 'record:news:a');
  assert.deepEqual(kept.expected, { type: 'record:news', value: { title: 'Old' } });
  assert.deepEqual(kept.value, { title: 'New' });
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

test('a library is refused when the run has no admitted library owner', async () => {
  await assert.rejects(fillAListFromFeed({ feed: input.feed, into: { dataset: 'examples' }, values: { title: '$.id' }, stored: {} }, { read: async () => Response.json([{ id: 'a' }]) }), /not reachable/);
});
