// tools/conversations/test/held-door.test.mjs: the run's door, which answers from the values the caller hands in and keeps
// what it writes back for the caller. A run is complete only when nothing it reads is missing; an incomplete run writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heldDoor, canonicalQuery } from '../read-data/held-door.mjs';
import { runHeld, splitGiven } from '../do-work/run-held.mjs';

test('a read of a record that was not handed in is a need, and the run answers it as absent', async () => {
  const held = heldDoor({ records: [{ id: 'a', type: 'message', value: { text: 'x' } }] });
  assert.deepEqual(await held.door.read('message', 'a'), { text: 'x' });
  assert.equal(await held.door.read('message', 'missing'), null);
  assert.deepEqual(held.needs().records, [{ id: 'missing', type: 'message' }]);
});

test('a write is kept for the caller and seen by the run\'s later reads', async () => {
  const held = heldDoor({});
  await held.door.write([{ id: 'r1', type: 'record:x', value: { n: 1 } }]);
  assert.deepEqual(await held.door.read('record:x', 'r1'), { n: 1 });
  assert.deepEqual(held.keep(), [{ id: 'r1', type: 'record:x', value: { n: 1 } }]);
});

test('an expected version that does not match refuses the write as a conflict, and nothing is kept', async () => {
  const held = heldDoor({ records: [{ id: 'r1', type: 'record:x', value: { n: 1 } }] });
  await assert.rejects(held.door.write([{ id: 'r1', type: 'record:x', value: { n: 2 }, expected: { type: 'record:x', value: { n: 9 } } }]), /not what this write expected/);
  assert.deepEqual(held.keep(), []);
});

test('a list the run asks for is a need until it is handed in, then its answer is the caller\'s rows plus the run\'s writes', async () => {
  const query = { type: 'record:x', fields: ['n'] };
  const asked = heldDoor({});
  assert.deepEqual([...await asked.door.list(query)], []);
  assert.deepEqual(asked.needs().lists, [query]);
  const held = heldDoor({ queries: [{ query, records: [{ id: 'r1', type: 'record:x', value: { n: 1 } }] }] });
  await held.door.write([{ id: 'r2', type: 'record:x', value: { n: 2 } }]);
  const seen = [];
  for await (const record of held.door.list(query)) seen.push(record.id);
  assert.deepEqual(seen, ['r2', 'r1'], 'greatest id first, the run\'s own write included');
  assert.equal(canonicalQuery({ b: 1, a: [{ d: 2, c: 1 }] }), canonicalQuery({ a: [{ c: 1, d: 2 }], b: 1 }));
});

test('a file the run looks for is found by its name or its identity, and a missing one is a need', async () => {
  const held = heldDoor({ files: { '/notes/a.txt': { text: 'hello' } } });
  const found = await held.door.files('find_file', { name_or_identity: '/notes/a.txt' });
  assert.equal(found.byte_length, 5);
  await assert.rejects(held.door.files('find_file', { name_or_identity: '/notes/b.txt' }), /No file named/);
  assert.deepEqual(held.needs().files, ['/notes/b.txt']);
});

test('a file written in pieces is kept whole, once finished', async () => {
  const held = heldDoor({});
  await held.door.files('write_file_start', { upload_id: 'u', name: '/messages/a.bin' });
  await held.door.files('write_file_piece', { upload_id: 'u', name: '/messages/a.bin', offset: 0, content_base64: Buffer.from('ab').toString('base64') });
  await held.door.files('write_file_piece', { upload_id: 'u', name: '/messages/a.bin', offset: 2, content_base64: Buffer.from('cd').toString('base64') });
  await held.door.files('write_file_finish', { upload_id: 'u', name: '/messages/a.bin' });
  assert.deepEqual(held.keep(), [{ file: '/messages/a.bin', base64: Buffer.from('abcd').toString('base64') }]);
});

test('runHeld answers the needs and keeps nothing while incomplete, and the writes once complete', async () => {
  const fn = async (input, { door }) => {
    const value = await door.read('record:x', input.id);
    if (value === null) return { ok: false };
    await door.write([{ id: 'out', type: 'record:y', value: { seen: value.n } }]);
    return { ok: true };
  };
  const asked = await runHeld(fn, { id: 'r1', stored: {} });
  assert.equal(asked.complete, false);
  assert.deepEqual(asked.needs.records, [{ id: 'r1', type: 'record:x' }]);
  const done = await runHeld(fn, { id: 'r1', stored: { records: [{ id: 'r1', type: 'record:x', value: { n: 7 } }] } });
  assert.equal(done.complete, true);
  assert.deepEqual(done.keep, [{ id: 'out', type: 'record:y', value: { seen: 7 } }]);
  assert.equal(done.ok, true);
});

test('the run\'s values are taken from the top of the input or from the one field the row put them in', () => {
  assert.deepEqual(splitGiven({ stored: { records: [] }, input: { a: 1 } }).stored, { records: [] });
  assert.deepEqual(splitGiven({ task: { stored: { records: [1] } }, input: { a: 1 } }).stored, { records: [1] });
});
