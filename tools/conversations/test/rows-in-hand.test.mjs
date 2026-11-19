// tools/conversations/test/rows-in-hand.test.mjs: the rows a run is handed (input.stored) are read in memory, what it writes
// comes back as keep with the value it expected, and a run that asks for what it was not handed answers needs and keeps nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsInHand, canonicalQuery, answering } from '../read-data/rows-in-hand.mjs';

test('a record handed in is read; one not handed is a need and reads as absent for the rest of the run', () => {
  const hand = rowsInHand({ records: [{ id: 'a', type: 'message', value: { text: 'x' } }] });
  assert.deepEqual(hand.valueOf('a', 'message'), { text: 'x' });
  assert.equal(hand.valueOf('missing', 'message'), null);
  assert.deepEqual(hand.needs().records, [{ id: 'missing', type: 'message' }]);
});

test('a kept record is seen by the run\'s later reads, and keeps the value it expected (the record as handed in, or null)', () => {
  const hand = rowsInHand({ records: [{ id: 'r1', type: 'record:x', value: { n: 1 } }] });
  hand.keepRecord({ id: 'r1', type: 'record:x', value: { n: 2 } });
  assert.deepEqual(hand.valueOf('r1', 'record:x'), { n: 2 });
  hand.keepRecord({ id: 'r2', type: 'record:x', value: { n: 3 } });
  assert.deepEqual(hand.keep(), [
    { id: 'r1', type: 'record:x', value: { n: 2 }, expected: { type: 'record:x', value: { n: 1 } } },
    { id: 'r2', type: 'record:x', value: { n: 3 }, expected: null },
  ]);
});

test('a list asked for is a need until it is handed in; then its answer is the rows handed in plus the run\'s writes of that type', () => {
  const query = { type: 'record:x', limit: 5 };
  assert.deepEqual(rowsInHand({}).rowsOf(query), []);
  const hand = rowsInHand({ queries: [{ query, records: [{ id: 'r1', type: 'record:x', value: { n: 1 } }] }] });
  hand.keepRecord({ id: 'r2', type: 'record:x', value: { n: 2 } });
  assert.deepEqual(hand.rowsOf(query).map(record => record.id), ['r2', 'r1']);
  assert.equal(canonicalQuery({ b: 1, a: [2] }), canonicalQuery({ a: [2], b: 1 }), 'the same query, whatever order its fields were written in');
});

test('a file asked for by name is a need; given, its bytes are read and a kept file is kept with the identity it replaced', () => {
  const hand = rowsInHand({ files: { '/notes/a.txt': { text: 'hello' } } });
  assert.equal(hand.bytesOf('/notes/b.txt'), null);
  assert.deepEqual(hand.needs().files, ['/notes/b.txt']);
  assert.equal(Buffer.from(hand.bytesOf('/notes/a.txt')).toString(), 'hello');
  hand.keepFile('/notes/a.txt', Buffer.from('bye'));
  const [kept] = hand.keep();
  assert.equal(kept.file, '/notes/a.txt');
  assert.equal(Buffer.from(kept.base64, 'base64').toString(), 'bye');
  assert.notEqual(kept.expected, null, 'the identity the run saw first');
});

test('answering keeps nothing and answers its needs while incomplete, and its keep once every read was handed in', async () => {
  const fn = async (request, context) => answering(request, context, hand => {
    const value = hand.valueOf(request.input.id, 'record:x');
    if (value === null && hand.needs().records.length) return null;
    hand.keepRecord({ id: 'out', type: 'record:y', value: { seen: value.n } });
    return { seen: value.n };
  });
  const asked = await fn({ input: { id: 'r1' } }, {});
  assert.deepEqual([asked.complete, asked.keep, asked.needs.records], [false, [], [{ id: 'r1', type: 'record:x' }]]);
  const done = await fn({ input: { id: 'r1', stored: { records: [{ id: 'r1', type: 'record:x', value: { n: 7 } }] } } }, {});
  assert.deepEqual([done.complete, done.seen, done.keep.map(item => item.id)], [true, 7, ['out']]);
});
