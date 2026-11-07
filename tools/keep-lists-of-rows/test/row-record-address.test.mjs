import test from 'node:test';
import assert from 'node:assert/strict';
import { rowRecordAddress } from '../read-data/row-record-address.mjs';

test('ordinary records retain their names and caller-provided template', () => {
  const address = rowRecordAddress({ row_type: 'task' });
  assert.equal(address.type, 'record:task');
  assert.equal(address.prefix, 'record:task:');
  assert.equal(address.recordId('one'), 'record:task:one');
  assert.equal(address.localId(address.recordId('one')), 'one');
  assert.deepEqual(address.query, { type: 'record:task' });
  assert.equal(rowRecordAddress({ row_type: 'task' }, 'kept:{row_type}').type, 'kept:task');
});

test('declared kinds and prefixes compose without naming any collection', () => {
  const address = rowRecordAddress({ row_type: 'logical-entry', row_records: { type: 'entry', prefix: 'entry:project:' } });
  assert.equal(address.type, 'entry');
  assert.equal(address.recordId('one'), 'entry:project:one');
  assert.equal(address.recordId('entry:project:one'), 'entry:project:entry:project:one');
  assert.deepEqual(address.query, { type: 'entry', prefix: 'entry:project:' });
  assert.equal(address.localId('entry:project:one'), 'one');
  assert.throws(() => address.localId('entry:other:one'), /outside/);
  assert.throws(() => address.localId('entry:project:'), /outside/);
});

test('a local id that repeats its prefix roundtrips without aliasing another row', () => {
  for (const list of [{ row_type: 'task' }, { row_records: { type: 'entry', prefix: 'entry:' } }]) {
    const a = rowRecordAddress(list), full = `${a.prefix}${a.prefix}one`;
    assert.equal(a.recordId(a.localId(full)), full);
  }
});

test('local identity bytes are retained instead of being normalized as metadata', () => {
  const a = rowRecordAddress({ row_type: 'task' });
  const local = '  item\twith space  ';
  assert.equal(a.recordId(local), `record:task:${local}`);
  assert.equal(a.localId(a.recordId(local)), local);
});

test('an invalid declaration fails instead of silently reading another kind', () => {
  for (const row_records of [null, [], {}, { type: 'entry' }, { prefix: 'entry:' },
    { type: '', prefix: 'entry:' }, { type: 'entry', prefix: '' },
    { type: ' entry', prefix: 'entry:' }, { type: 'entry', prefix: '\n' },
    { type: 'entry', prefix: 'entry:', other: true }]) {
    assert.throws(() => rowRecordAddress({ row_type: 'task', row_records }), TypeError);
  }
  assert.throws(() => rowRecordAddress({}), /row_type/);
});
