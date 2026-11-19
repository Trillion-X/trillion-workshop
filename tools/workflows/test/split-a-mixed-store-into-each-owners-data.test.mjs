// Proof of workflow:split-a-mixed-store-into-each-owners-data (tools/workflows/recipes/split-a-mixed-store-into-each-owners-data.json):
// its statements, exactly as the recipe carries them, run on PGlite, a plain PostgreSQL: the ledger keeps where each part
// goes, a batch is written by its key and written again changes nothing, a part is moved only when its read-back count
// matches, and the answer says what waits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const recipe = JSON.parse(readFileSync(new URL('../recipes/split-a-mixed-store-into-each-owners-data.json', import.meta.url), 'utf8')).records[0].payload;
const sql = (stepId, name) => recipe.steps.find(step => step.id === stepId).sql.find(item => item.name === name).text;

test('a part is kept in the ledger before it moves, written by its key twice without a copy, and moved only when read back whole', async () => {
  const ledger = new PGlite();
  const owner = new PGlite();
  await ledger.exec(sql('render', 'row-moves'));
  await ledger.exec(sql('render', 'row-moves'));
  const keep = sql('sort', 'keep');
  const [{ id: payments }] = (await ledger.query(keep, ['old-store', 'payments', null, 'shop-management-database', 'payments', 'id', 'a buyer paid the shop'])).rows;
  const [{ id: notesMine }] = (await ledger.query(keep, ['old-store', 'notes', "kind = 'mine'", 'my-own-database', 'notes', 'id', 'the person wrote these'])).rows;
  const [{ id: notesShop }] = (await ledger.query(keep, ['old-store', 'notes', "kind = 'shop'", 'shop-management-database', 'notes', 'id', 'the shop keeps these'])).rows;
  await ledger.query(keep, ['old-store', 'cache', null, null, null, null, 'a copy the old app rebuilt; kept nowhere']);
  assert.equal(new Set([payments, notesMine, notesShop]).size, 3, 'one table split by a condition is two parts');
  const again = (await ledger.query(keep, ['old-store', 'payments', null, 'shop-management-database', 'payments', 'id', 'changed my mind on why'])).rows;
  assert.deepEqual(again.map(row => row.id), [payments], 'the same part kept again is the same ledger row');

  await owner.exec("CREATE TABLE payments (id text PRIMARY KEY, amount_cents integer, paid_at timestamptz)");
  const write = (await owner.query("SELECT format($1, 'payments', 'payments') AS text", [sql('move-each', 'write')])).rows[0].text;
  const batch = JSON.stringify([{ id: 'p1', amount_cents: '9900', paid_at: '2026-11-01T10:00:00Z' }, { id: 'p2', amount_cents: 300000, paid_at: '2026-11-02T10:00:00Z' }, { id: 'p3', amount_cents: 15000, paid_at: null }]);
  assert.equal((await owner.query(write, [batch])).affectedRows, 3);
  assert.equal((await owner.query(write, [batch])).affectedRows, 0, 'a batch written again writes nothing');
  assert.deepEqual((await owner.query('SELECT id, amount_cents FROM payments ORDER BY id')).rows, [{ id: 'p1', amount_cents: 9900 }, { id: 'p2', amount_cents: 300000 }, { id: 'p3', amount_cents: 15000 }], 'text from the source becomes the owner\'s own types');
  await ledger.query(sql('move-each', 'counted'), [payments, 3, 3]);
  await ledger.query(sql('move-each', 'counted'), [notesMine, 2, 2]);

  const readBack = sql('read-back', 'read-back');
  assert.deepEqual((await ledger.query(readBack, [payments, 3])).rows.map(row => [row.read_back_count, row.moved]), [[3, true]]);
  assert.deepEqual((await ledger.query(readBack, [notesMine, 1])).rows.map(row => [row.read_back_count, row.moved]), [[1, false]], 'a count short of what was read is not moved');
  assert.deepEqual((await ledger.query(keep, ['old-store', 'payments', null, 'my-own-database', 'payments', 'id', 'too late'])).rows, [], 'a moved part is not sent somewhere else');

  const said = (await ledger.query(sql('say', 'where-it-went'), ['old-store'])).rows.map(row => ({ ...row, parts: Number(row.parts), rows: Number(row.rows), waiting: Number(row.waiting) }));
  assert.deepEqual(said, [
    { owner: '(no owner)', parts: 1, rows: 0, waiting: 0 },
    { owner: 'my-own-database', parts: 1, rows: 1, waiting: 1 },
    { owner: 'shop-management-database', parts: 2, rows: 3, waiting: 1 }]);
});
