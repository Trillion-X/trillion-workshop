import test from 'node:test';
import assert from 'node:assert/strict';
import { runSql, shapeOf } from '../do-work/run-sql.mjs';

// A client that records each statement it is sent and answers one empty row set, so the order of BEGIN, the use binding,
// the statement, COMMIT or ROLLBACK can be read back without a server.
const recordingClient = (sent, { failOn } = {}) => ({
  async query({ text, values = [] }) {
    sent.push({ text, values });
    if (failOn && text.includes(failOn)) throw new Error(`refused: ${failOn}`);
    return { fields: [{ name: 'n' }], rows: [{ n: 1 }], rowCount: 1 };
  },
  async end() {},
});
const connect = sent => async () => recordingClient(sent);
const connection = 'postgres://owner:made-up-pw@127.0.0.1:5432/proofs';

test('a use binds run_use.purpose and run_use.surface inside one transaction before the statement', async () => {
  const sent = [];
  const answer = await runSql({
    connection,
    connect: connect(sent),
    input: { sql: 'select n from clip', use: { purpose: 'publish', surface: 'social/instagram' } },
  });
  assert.deepEqual(sent.map(s => s.text), [
    'BEGIN',
    "SELECT set_config('run_use.purpose', $1, true), set_config('run_use.surface', $2, true)",
    'select n from clip',
    'COMMIT',
  ]);
  assert.deepEqual(sent[1].values, ['publish', 'social/instagram']);
  assert.deepEqual(answer, { columns: ['n'], rows: [{ n: 1 }], row_count: 1 });
});

test('a statement without a use runs as before, with no transaction of its own', async () => {
  const sent = [];
  await runSql({ connection, connect: connect(sent), input: { sql: 'select 1' } });
  assert.deepEqual(sent.map(s => s.text), ['select 1']);
});

test('a refused statement rolls its use back', async () => {
  const sent = [];
  const failing = async () => recordingClient(sent, { failOn: 'select boom' });
  await assert.rejects(runSql({ connection, connect: failing, input: { sql: 'select boom', use: { purpose: 'publish', surface: '' } } }));
  assert.deepEqual(sent.map(s => s.text).slice(-2), ['select boom', 'ROLLBACK']);
  assert.ok(!sent.some(s => s.text === 'COMMIT'));
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
