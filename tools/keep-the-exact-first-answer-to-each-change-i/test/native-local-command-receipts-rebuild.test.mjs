// A receipted write whose answer also shows what was read after it (src/native-local-command-receipts.mjs `rebuild`):
// the receipt keeps the write's own part, and a lost command is answered with that part and the same read made again,
// reading only. A write that answers nothing is kept, and answered, as null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { decisionStore, canonical, identityOf } from '../../keep-and-wake-ai-sessions-on-this-computer/src/decision-store.mjs';
import { nativeLocalCommandReceipts } from '../../shared-code/src/native-local-command-receipts.mjs';

function fixture(t) {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  const records = decisionStore(host.sql, { transaction: host.transaction }).eeaf;
  host.sql.exec('CREATE TABLE fixture_facts (entity TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const read = key => { const row = host.sql.exec('SELECT value FROM fixture_facts WHERE entity=?', key).toArray()[0]; return row ? JSON.parse(row.value) : null; };
  const write = (key, value) => host.sql.exec('INSERT INTO fixture_facts VALUES (?,?) ON CONFLICT(entity) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
  let context = null;
  const shown = { lists: ['Errands'] };
  let reads = 0;
  const captured = [];
  const receipts = nativeLocalCommandReceipts({ records, transaction: host.transaction, read, write, context: () => context, current: async () => {},
    captureResult: (c, result) => { captured.push([c.permit_id, result]); }, forget: key => host.sql.exec('DELETE FROM fixture_facts WHERE entity=?', key),
    operations: ['fixture:change', 'fixture:quiet'], requestOperations: ['fixture:request'], receiptPrefix: 'fixture-command',
    rebuild: { 'fixture:change': async kept => { reads++; return { ...kept, body: { lists: shown.lists, ...kept.body } }; } } });
  const as = (permit, input, extra = {}) => { context = { permit_id: permit, owner: 'account', resource: '@own-records', generation: 1, operation: 'fixture:request', input_identity: identityOf(canonical(input)), ...extra }; };
  return { receipts, as, read, write, shown, reads: () => reads, captured };
}

test('a lost change is answered with its kept part and the lists read again', async t => {
  const { receipts, as, write, shown, reads } = fixture(t);
  const input = { method: 'POST', path: '/fixture/change', body: {} };
  as('lost', input);
  assert.deepEqual(await receipts.reconcile(input), { state: 'aborted' }, 'no receipt: nothing was written');
  as('kept', input);
  const part = receipts.commit(() => { write('list:errands', { name: 'Errands' }); return { said: '1 change.' }; }, { operation: 'fixture:change' });
  assert.deepEqual(part, { said: '1 change.' });
  shown.lists = ['Errands', 'Later'];
  const decided = await receipts.reconcile(input);
  assert.equal(decided.state, 'committed');
  assert.deepEqual(decided.result.body, { lists: ['Errands', 'Later'], said: '1 change.' });
  assert.equal(reads(), 1);
});

test('a write that answers nothing is kept as null, never as erased', async t => {
  const { receipts, as, read, write, captured } = fixture(t);
  const input = { method: 'POST', path: '/fixture/quiet', body: {} };
  as('quiet', input);
  assert.equal(receipts.commit(() => { write('quiet', true); }, { operation: 'fixture:quiet' }), null);
  assert.equal(captured.length, 1);
  assert.equal(captured[0][1].body, null, 'the journal keeps the null answer');
  // The journal commits it in the same transaction and is the one receipt a retry is answered from: no copy is kept here.
  assert.equal(read('fixture-command:quiet'), null);
});

test('a command begun and lost before its commit is unknown, and its commit after the mark is kept', async t => {
  const { receipts, as, write } = fixture(t);
  const input = { method: 'POST', path: '/fixture/change', body: {} };
  as('begun', input);
  receipts.begin({ operation: 'fixture:change' });
  receipts.begin({ operation: 'fixture:change' });
  assert.deepEqual(await receipts.reconcile(input), { state: 'unknown' }, 'begun, not committed');
  assert.throws(() => receipts.begin({ operation: 'fixture:quiet' }), /different work/);
  receipts.commit(() => { write('list:later', { name: 'Later' }); return { said: 'kept' }; }, { operation: 'fixture:change' });
  assert.equal((await receipts.reconcile(input)).state, 'committed');
});

test('a session that keeps nothing keeps no receipt, and its lost command stays unknown', async t => {
  const { receipts, as, write } = fixture(t);
  const input = { method: 'POST', path: '/fixture/change', body: {} };
  as('session', input, { native_nonretaining: true });
  receipts.begin({ operation: 'fixture:change' });
  assert.deepEqual(receipts.commit(() => { write('list:session', { name: 'Session' }); return { said: 'once' }; }, { operation: 'fixture:change' }), { said: 'once' });
  assert.deepEqual(await receipts.reconcile(input), { state: 'unknown' });
});

// The journal is given an answer only when the receipt keeps all of it: a change whose answer is read after it would
// otherwise hand the journal its own part, and the command's whole answer would then differ from what was committed.
test('the journal is given a kept answer only when the receipt keeps the whole of it', async t => {
  const { receipts, as, write, captured } = fixture(t);
  as('partial', { method: 'POST', path: '/fixture/change', body: {} });
  receipts.commit(() => { write('list:a', { name: 'A' }); return { said: 'part' }; }, { operation: 'fixture:change' });
  assert.deepEqual(captured, [], 'a change answered with a read after it leaves the journal its own answer');
  as('whole', { method: 'POST', path: '/fixture/quiet', body: {} });
  receipts.commit(() => { write('quiet', true); return { said: 'all' }; }, { operation: 'fixture:quiet', headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  assert.deepEqual(captured, [['whole', { native_response: true, status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: { said: 'all' } }]]);
});

test('a route whose own answer is not an HTTP envelope keeps that answer as it is', async t => {
  const { receipts, as, read, write, captured } = fixture(t);
  const input = { method: 'POST', path: '/fixture/quiet', body: {} };
  as('raw', input);
  receipts.begin({ operation: 'fixture:quiet' });
  assert.deepEqual(receipts.commit(() => { write('raw', true); return { archived: true }; }, { operation: 'fixture:quiet', raw: true }), { archived: true });
  assert.deepEqual(captured, [['raw', { archived: true }]], 'the journal is given the same answer the route returns');
  assert.equal(read('fixture-command:raw'), null, 'its begun mark is forgotten: the journal is the one receipt');
});
