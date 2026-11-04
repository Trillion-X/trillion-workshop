// test/eeaf-read-many.test.mjs
// A page of records was read one by one, four statements for each (entity, facts, parts, list members). readMany(ids)
// finds the rows of many records by four statements in all, over their id ranges. These tests hold that it answers
// exactly what read(id) answers for each id, costs the same four statements however many records it is given, and
// leaves a record that read(id) would refuse (past the bounds) or read apart (a value too long for a batch) to read(id).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { eeafStore, RecordTooLarge } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';

function counted() {
  const host = sqliteHost(':memory:');
  let statements = 0;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (...args) => { statements += 1; return exec(...args); };
  return { ...host, statements: () => statements };
}
const hash = text => `h:${text}`;
const record = index => ({ id: `note:${String(index).padStart(4, '0')}`, type: 'note', value: {
  title: `Note ${index}`, tags: ['a', 'b'].map(name => ({ name: `${name}${index}` })), body: { text: `Words ${index}`, marks: [{ at: index }, { at: index + 1 }] }, ...(index % 4 === 0 ? { empty: {} } : {}),
} });

test('readMany answers what read answers for each id, and four statements however many records it is given', () => {
  const { sql, transaction, statements } = counted();
  const writer = eeafStore(sql, { transaction, hash });
  writer.write(Array.from({ length: 60 }, (_, index) => record(index)));
  writer.write([{ id: 'note:gone', type: 'note', value: { title: 'x' } }]);
  writer.write([{ id: 'note:gone', type: 'note', value: null }]);
  const ids = [...Array.from({ length: 60 }, (_, index) => record(index).id), 'note:gone', 'note:never'];

  const alone = eeafStore(sql, { transaction, hash });
  const expected = new Map(ids.map(id => [id, alone.read(id)]));

  const small = eeafStore(sql, { transaction, hash });
  const before = statements();
  small.readMany(ids.slice(0, 5));
  const five = statements() - before;
  const large = eeafStore(sql, { transaction, hash });
  const start = statements();
  const found = large.readMany(ids);
  const sixtyTwo = statements() - start;
  assert.deepEqual(found, expected);
  assert.equal(five, 4, 'five records cost four statements');
  assert.equal(sixtyTwo, 4, 'sixty-two records cost four statements');
  const again = statements();
  large.readMany(ids);
  assert.equal(statements(), again, 'records read are kept, so the next batch runs no statement');
  found.get('note:0001').title = 'changed by a caller';
  assert.equal(large.read('note:0001').title, 'Note 1', 'a copy handed out never changes what the store remembers');
});

test('a record past the bounds is refused by readMany as read refuses it, and one long value is read apart without refusing the others', () => {
  const { sql, transaction } = counted();
  const store = eeafStore(sql, { transaction, hash, bounds: { rows: 40, bytes: 2 * 1024 * 1024 } });
  store.write([
    ...Array.from({ length: 5 }, (_, index) => record(index)),
    { id: 'note:wide', type: 'note', value: { title: 'wide', items: Array.from({ length: 60 }, (_, index) => ({ n: index })) } },
  ]);
  const woken = () => eeafStore(sql, { transaction, hash, bounds: { rows: 40, bytes: 2 * 1024 * 1024 } });
  assert.throws(() => woken().read('note:wide'), RecordTooLarge);
  assert.throws(() => woken().readMany(['note:0000', 'note:wide', 'note:0001']), RecordTooLarge);
  const fine = woken().readMany(['note:0000', 'note:0001']);
  assert.deepEqual([...fine.keys()], ['note:0000', 'note:0001']);

  const long = eeafStore(sql, { transaction, hash });
  long.write([{ id: 'note:long', type: 'note', value: { title: 'long', body: 'y'.repeat(300 * 1024) } }]);
  const asked = eeafStore(sql, { transaction, hash }).readMany(['note:0000', 'note:long', 'note:0001']);
  assert.equal(asked.get('note:long').body.length, 300 * 1024);
  assert.equal(asked.get('note:0001').title, 'Note 1');
});
