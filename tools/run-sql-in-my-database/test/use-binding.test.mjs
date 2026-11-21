import test from 'node:test';
import assert from 'node:assert/strict';
import { runSql, shapeOf } from '../do-work/run-sql.mjs';

// A client that records each statement it is sent and answers one empty row set, so the order of BEGIN, the ticket's claim,
// the statement, COMMIT or ROLLBACK can be read back without a server. test/use-tickets.test.mjs runs the same on a real one.
const recordingClient = (sent, { failOn } = {}) => ({
  async query({ text, values = [] }) {
    sent.push({ text, values });
    if (failOn && text.includes(failOn)) throw new Error(`refused: ${failOn}`);
    return { fields: [{ name: 'n' }], rows: [{ n: 1 }], rowCount: 1 };
  },
  async end() {},
});
const connect = sent => async () => recordingClient(sent);
const connection = 'postgres://reader:made-up-pw@127.0.0.1:5432/proofs';
const ticket = 'aa.made-up-ticket';

test('a run handed a use ticket claims it inside the statement\'s own transaction, before the statement', async () => {
  const sent = [];
  const answer = await runSql({
    connection,
    ticket,
    connect: connect(sent),
    input: { database: 'proofs', sql: 'select n from clip', use: { purpose: 'publish', surface: 'social/instagram' } },
  });
  assert.deepEqual(sent.map(s => s.text), ['BEGIN', 'SELECT * FROM use_binding.claim_use($1)', 'select n from clip', 'COMMIT']);
  assert.deepEqual(sent[1].values, [ticket], 'the ticket is a bound value, never statement text');
  assert.deepEqual(answer, { columns: ['n'], rows: [{ n: 1 }], row_count: 1 });
});

test('a statement without a use runs as before, with no transaction of its own', async () => {
  const sent = [];
  await runSql({ connection, connect: connect(sent), input: { sql: 'select 1' } });
  assert.deepEqual(sent.map(s => s.text), ['select 1']);
});

test('a refused statement rolls its claim back', async () => {
  const sent = [];
  const failing = async () => recordingClient(sent, { failOn: 'select boom' });
  await assert.rejects(runSql({ connection, ticket, connect: failing, input: { sql: 'select boom', use: { purpose: 'publish', surface: '' } } }));
  assert.deepEqual(sent.map(s => s.text).slice(-2), ['select boom', 'ROLLBACK']);
  assert.ok(!sent.some(s => s.text === 'COMMIT'));
});

test('a use with no ticket is refused before any connection: only the engine binds a use', async () => {
  const sent = [];
  await assert.rejects(runSql({ connection, connect: connect(sent), input: { sql: 'select 1', use: { purpose: 'coach/review', surface: '' } } }), /bound only by the engine's ticket/);
  assert.deepEqual(sent, []);
});

test('a use must be exactly purpose and surface as text', () => {
  const bad = [
    { purpose: 'publish' },
    { purpose: 'publish', surface: 3 },
    { purpose: 'publish', surface: '', extra: 'x' },
    'publish',
    null,
  ];
  for (const use of bad) {
    assert.throws(() => shapeOf({ sql: 'select 1', use }), /use must be/);
  }
  assert.deepEqual(shapeOf({ sql: 'select 1', use: { purpose: 'manage', surface: '' } }).use, { purpose: 'manage', surface: '' });
  assert.equal(shapeOf({ sql: 'select 1' }).use, undefined);
});

test('a name the request gives as an object or a number is refused in plain words; null is absent', () => {
  assert.throws(() => shapeOf({ sql: 'select 1', database: { name: 'shop_for_who_runs_it' } }), /database must be a name, as text\./);
  assert.throws(() => shapeOf({ sql: 'select 1', credential_name: { held: 'x' } }), /credential_name must be a name, as text\./);
  assert.throws(() => shapeOf({ recipe: { name: 'own-database', action: 'drop' }, role_credential_name: 7 }), /role_credential_name must be a name, as text\./);
  assert.throws(() => shapeOf({ sql: 'select 1', value_credential_name: ['x'] }), /value_credential_name must be a name, as text\./);
  assert.deepEqual(shapeOf({ sql: 'select 1', database: null, credential_name: null }).sql, 'select 1');
});
