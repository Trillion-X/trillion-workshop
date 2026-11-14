// tools/records-door: readMany learns the values of many ids in door calls that stay bounded (read-data/read-many.mjs).
// The door here is a counting stand-in that lists the way the engine's door does (greatest id first, `prefix`, `above`,
// `below`, pages of at most `pageRows` rows, a `next` while rows remain) and reads one id at a time. Every id and value
// is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readMany } from '../read-data/read-many.mjs';

const TYPE = 'record:made-up';
const PREFIX = 'record:made-up:row-';
const idOf = n => `${PREFIX}${n.toString(16).padStart(8, '0')}`;

// A made-up store of the rows `held` (numbers), and a door over it that counts its calls.
function doorOver(held, pageRows = 100) {
  const ids = [...new Set(held)].map(idOf).sort().reverse();
  const calls = { pages: 0, reads: 0 };
  return {
    calls,
    async *listPages({ type, prefix, above, below }) {
      assert.equal(type, TYPE);
      const inside = ids.filter(id => id.startsWith(prefix) && (above === undefined || id > above) && (below === undefined || id < below));
      for (let at = 0; ; at += pageRows) {
        calls.pages += 1;
        const records = inside.slice(at, at + pageRows).map(id => ({ id, type: TYPE, value: { id, made_up: id.slice(-8) } }));
        const next = at + pageRows < inside.length ? records.at(-1).id : null;
        yield { records, next };
        if (next === null) return;
      }
    },
    async read(type, id) {
      assert.equal(type, TYPE);
      calls.reads += 1;
      return ids.includes(id) ? { id, made_up: id.slice(-8) } : null;
    },
  };
}

const spread = (count, step) => Array.from({ length: count }, (_, at) => (at * step) % 0x7fffffff);

// What reading the ids one by one gives.
const oneByOne = async (door, asked) => new Map(await Promise.all(asked.map(async id => [id, await door.read(TYPE, id)])));

test('ids the store holds none of are settled by one page, however many are asked', async () => {
  const door = doorOver(spread(2000, 7919));
  const asked = spread(70_000, 104_729).map(n => idOf(n + 0x10000000));
  door.calls.reads = 0;
  const { values, pages, reads } = await readMany(door, asked, { type: TYPE, at_once: 8 });
  assert.equal(values.size, new Set(asked).size);
  assert.ok([...values.values()].every(value => value === null));
  assert.deepEqual([pages, reads, door.calls.pages, door.calls.reads], [1, 0, 1, 0]);
});

test('ids standing densely in a large store are read by page: calls far under one per id, values the same as read one by one', async t => {
  const store = spread(20_000, 15_485_863 % 1000 + 3);
  const door = doorOver(store, 100);
  const asked = store.filter((_, at) => at % 4 === 0).map(idOf).concat(spread(500, 99_991).map(n => idOf(n + 0x20000000)));
  const want = await oneByOne(doorOver(store), asked);
  const { values, pages, reads } = await readMany(door, asked, { type: TYPE, at_once: 8 });
  assert.deepEqual([...values].sort(), [...want].sort());
  assert.equal(door.calls.pages + door.calls.reads, pages + reads);
  assert.ok(pages + reads <= new Set(asked).size + 1, 'never more calls than ids plus one');
  assert.ok(pages + reads < new Set(asked).size / 10, `${pages} pages and ${reads} reads for ${new Set(asked).size} ids`);
  t.diagnostic(`${new Set(asked).size} ids in a store of ${store.length} rows: ${pages} pages and ${reads} reads`);
});

test('a few ids in a large store cost at most one page more than their reads', async () => {
  const store = spread(30_000, 7);
  const door = doorOver(store, 100);
  const asked = [idOf(store[100]), idOf(store[12_000]), idOf(0x30000000)];
  const { values, pages, reads } = await readMany(door, asked, { type: TYPE, at_once: 8 });
  assert.equal(values.size, 3);
  assert.equal(values.get(idOf(store[100])).id, idOf(store[100]));
  assert.equal(values.get(idOf(0x30000000)), null);
  assert.ok(pages <= 1 && pages + reads <= asked.length + 1, `${pages} pages, ${reads} reads`);
});

test('the answer is the same as one read each for any mix of held and absent ids, repeated ids counted once', async () => {
  for (const [held, askedCount, pageRows] of [[500, 40, 7], [3000, 1500, 50], [50, 50, 1], [10, 3, 100]]) {
    const store = spread(held, 7919);
    const asked = [...store.filter((_, at) => at % 2 === 0), ...spread(askedCount, 31)].slice(0, askedCount).map(idOf);
    asked.push(asked[0]);
    const { values } = await readMany(doorOver(store, pageRows), asked, { type: TYPE, at_once: 8 });
    assert.deepEqual([...values].sort(), [...await oneByOne(doorOver(store), [...new Set(asked)])].sort());
  }
});

test('no ids asks nothing, and a bad at_once is refused', async () => {
  const door = doorOver([1, 2, 3]);
  const { values, pages, reads } = await readMany(door, [], { type: TYPE, at_once: 8 });
  assert.deepEqual([values.size, pages, reads, door.calls.pages, door.calls.reads], [0, 0, 0, 0, 0]);
  await assert.rejects(readMany(door, [idOf(1)], { type: TYPE, at_once: 0 }), TypeError);
});
