// A model wait's model call can take longer than the alarm command that started its batch keeps its statements open
// (kept work drains for kept_work_drain_ms, then its scope refuses SQL). The batch's own statements run as their own
// measured steps, so a slow model call still writes its result, a replay writes nothing twice, and a crash after the
// claim retries once. These use a fake clock and a scope that closes the way the alarm's does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { modelWaits } from '../src/model-waits.mjs';

const settings = { first_seconds: 1, longest_seconds: 3600, batch: 10 };

// The book's SQL: a statement is refused once the scope that opened it has closed.
function scopedSql(host, state) {
  return { exec: (query, ...args) => { if (!state.open) throw new Error('no_active_measurement'); return host.sql.exec(query, ...args); } };
}
// A step opens its own scope for its statements, as a metered command does.
const ownScope = state => (purpose, work) => { const was = state.open; state.open = true; try { return work(); } finally { state.open = was; } };
const rowsOf = host => host.sql.exec('SELECT kind, key, claim_id FROM model_waits').toArray();

test('a model call of 6 seconds writes its result once, and its row is released when the work finishes', async () => {
  const host = sqliteHost(':memory:'), state = { open: true }, sql = scopedSql(host, state);
  let clock = 1_000_000, kept = null;
  const results = [];
  let finish;
  const waits = modelWaits(sql, { settings, now: () => clock, keepAlive: promise => { kept = promise; }, step: ownScope(state),
    run: { 'outcome-check': key => new Promise(resolve => { finish = () => { results.push(key); resolve(); }; }) } });
  waits.wait('outcome-check', 'case-1');
  clock += 2_000;
  assert.equal((await waits.runDue()).started, 1);
  await new Promise(resolve => setImmediate(resolve)); // the model call has started
  state.open = false; // the alarm command's scope has drained and closed
  clock += 6_000;     // the model call takes six seconds
  finish();
  await kept;
  assert.deepEqual(results, ['case-1'], 'the result was written once');
  assert.deepEqual(rowsOf(host), [], 'the row is released after its result');
});

test('a replay after the result writes nothing twice', async () => {
  const host = sqliteHost(':memory:'), state = { open: true }, sql = scopedSql(host, state);
  let clock = 1_000_000;
  const results = [];
  const waits = modelWaits(sql, { settings, now: () => clock, keepAlive: null, step: ownScope(state),
    run: { 'outcome-check': async key => { results.push(key); } } });
  waits.wait('outcome-check', 'case-2');
  clock += 2_000;
  await waits.runDue();
  clock += 3_600_000;
  await waits.runDue();
  assert.deepEqual(results, ['case-2'], 'the released row is never run again');
});

test('a crash after the claim retries once, at the lease time, and then the row is released', async () => {
  const host = sqliteHost(':memory:'), state = { open: true }, sql = scopedSql(host, state);
  let clock = 1_000_000;
  const crashed = modelWaits(sql, { settings, now: () => clock, keepAlive: null, step: ownScope(state),
    run: { 'outcome-check': () => new Promise(() => {}) } }); // the process dies inside the model call
  crashed.wait('outcome-check', 'case-3');
  clock += 2_000;
  crashed.runDue();
  await new Promise(resolve => setImmediate(resolve));
  const [claimed] = rowsOf(host);
  assert.ok(claimed.claim_id, 'the claim is kept on the row');
  // A restarted instance finds the row, not yet due at its new lease, and then retries it once.
  const results = [];
  const restarted = modelWaits(sql, { settings, now: () => clock, keepAlive: null, step: ownScope(state),
    run: { 'outcome-check': async key => { results.push(key); } } });
  await restarted.runDue();
  assert.deepEqual(results, [], 'the row is not retried before its lease time');
  clock += 3_600_000;
  await restarted.runDue();
  assert.deepEqual(results, ['case-3']);
  assert.deepEqual(rowsOf(host), []);
});
