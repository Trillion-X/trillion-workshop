// The keep-list writer (records-door): one transaction, a refused expected value writes nothing, a removal, and the table made once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeKeepList, KeepRefused } from '../do-work/write-keep-list.mjs';

const KEEP_TABLE = 'decision_records';

// A fake pg client: the table is a Map of "type|id" → value; BEGIN takes a copy and ROLLBACK puts it back.
function fakeClient(seed = []) {
  let table = new Map(seed.map(({ id, type, value }) => [`${type}|${id}`, value]));
  let saved = null;
  const log = [];
  const client = {
    log,
    get table() { return table; },
    async query(text, values = []) {
      log.push(text.split(/\s+/).slice(0, 3).join(' '));
      if (text.startsWith('CREATE TABLE IF NOT EXISTS decision_records')) return { rows: [] };
      if (text === 'BEGIN') { saved = new Map(table); return { rows: [] }; }
      if (text === 'COMMIT') { saved = null; return { rows: [] }; }
      if (text === 'ROLLBACK') { table = saved; saved = null; return { rows: [] }; }
      if (text.startsWith(`SELECT value FROM ${KEEP_TABLE} `)) {
        const value = table.get(`${values[1]}|${values[0]}`);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (text.startsWith(`INSERT INTO ${KEEP_TABLE} `)) { table.set(`${values[1]}|${values[0]}`, JSON.parse(values[2])); return { rows: [] }; }
      if (text.startsWith(`DELETE FROM ${KEEP_TABLE} `)) { table.delete(`${values[1]}|${values[0]}`); return { rows: [] }; }
      throw new Error(`unexpected statement: ${text}`);
    },
  };
  return client;
}

const decision = { id: 'source:one', type: 'decision', value: { status: 'needs_outcome' }, expected: null };
const evidence = { id: 'source:one:0000', type: 'decision-evidence', value: { ref: 'e1' }, expected: null };

test('a keep list is written in one transaction and the table is made once', async () => {
  const client = fakeClient();
  const answer = await writeKeepList([decision, evidence], client, { table: KEEP_TABLE });
  assert.equal(answer.written, 2);
  assert.deepEqual(client.table.get('decision|source:one'), { status: 'needs_outcome' });
  assert.deepEqual(client.table.get('decision-evidence|source:one:0000'), { ref: 'e1' });
  assert.deepEqual(client.log.filter(line => line.startsWith('BEGIN') || line.startsWith('COMMIT')), ['BEGIN', 'COMMIT']);
});

test('a record whose expected value moved refuses the whole list and writes nothing', async () => {
  const client = fakeClient([{ id: 'source:one', type: 'decision', value: { status: 'ended' } }]);
  await assert.rejects(writeKeepList([evidence, decision], client, { table: KEEP_TABLE }), KeepRefused);
  assert.equal(client.table.has('decision-evidence|source:one:0000'), false, 'the other record is not written either');
  assert.deepEqual(client.table.get('decision|source:one'), { status: 'ended' }, 'the moved record is left as it was');
  assert.ok(client.log.includes('ROLLBACK'));
});

test('a null value removes the record it names, when the expected value is what the database holds', async () => {
  const client = fakeClient([{ id: 'source:one', type: 'decision', value: { status: 'needs_outcome' } }]);
  await writeKeepList([{ id: 'source:one', type: 'decision', value: null, expected: { status: 'needs_outcome' } }], client, { table: KEEP_TABLE });
  assert.equal(client.table.has('decision|source:one'), false);
});

test('a keep list that is not a list is refused before anything is run', async () => {
  const client = fakeClient();
  await assert.rejects(writeKeepList(undefined, client, { table: KEEP_TABLE }), KeepRefused);
  await assert.rejects(writeKeepList([evidence], client, { table: 'x; drop table y' }), KeepRefused, 'a table name that is not a plain identifier is refused');
  assert.equal(client.log.length, 0);
});
