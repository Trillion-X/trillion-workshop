import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { decisionStore } from '../src/decision-store.mjs';
import { setRecordEngine } from '../src/record-engine.mjs';

test('a large decision moves by reading and yielding one list member at a time', () => {
  const host = sqliteHost(':memory:');
  setRecordEngine(host.sql, 'eeaf');
  const bounds = { rows: 300, bytes: 1024 * 1024 };
  const decisions = decisionStore(host.sql, { transaction: host.transaction, bounds });
  const calls = Array.from({ length: 160 }, (_, n) => ({ at: `c${n}`, step_id: 'scope', accepted: n % 2 === 0, reason: `reason ${n} ${'x'.repeat(9000)}`, problems: [`problem ${n}`] }));
  const record = { id: 'case:large', input: { goal: 'keep every answer', options: [] }, status: 'open', calls, guidance: [] };
  decisions.eeaf.write([{ id: record.id, type: 'decision', value: record }], { actor: { by: 'test' } });
  assert.throws(() => decisions.eeaf.read(record.id), /too large/);

  const move = decisions.move({ entities_per_batch: 20, bytes_per_batch: 8 * 1024, log_rows_per_batch: 500, switch_within_log_rows: 100, batches_per_step: 2, rest_seconds: 0, keep_days_after_switch: 0 });
  let steps = 0;
  while (decisions.eeaf.engine() === 'eeaf') {
    move.step();
    steps += 1;
    assert.ok(steps < 100, 'the move finishes');
  }

  const migrated = decisions.read({ cases: [record.id] }).cases[record.id];
  assert.equal(migrated.calls.length, calls.length);
  assert.equal(migrated.calls[159].reason, `reason 159 ${'x'.repeat(9000)}`);
  assert.deepEqual(migrated.calls[159].problems, ['problem 159'], 'the latest call payload survives the move');
});

test('a corrected migration attempt resumes from its verified persisted cursor', () => {
  const host = sqliteHost(':memory:');
  setRecordEngine(host.sql, 'eeaf');
  const decisions = decisionStore(host.sql, { transaction: host.transaction });
  decisions.eeaf.write(Array.from({ length: 24 }, (_, n) => ({ id: `note:${n}`, type: 'note', value: { text: `note ${n}` } })), { actor: { by: 'test' } });
  const settings = { entities_per_batch: 1000, bytes_per_batch: 64 * 1024, log_rows_per_batch: 50, switch_within_log_rows: 20, batches_per_step: 1, rest_seconds: 0, keep_days_after_switch: 0 };

  const attempt3 = decisions.move({ ...settings, attempt: 3 });
  attempt3.step();
  const prior = decisions.eeaf.logStore().loadProgress();
  assert.ok(prior.after > 0, 'attempt 3 has verified pages and a saved cursor');
  assert.equal(decisions.eeaf.logStore().typeOf('note:0'), 'note', 'the earlier copied record remains in the log');
  const state = JSON.parse(host.sql.exec("SELECT value FROM record_move WHERE key = 'state'").toArray()[0].value);
  host.sql.exec("UPDATE record_move SET value = ? WHERE key = 'state'", JSON.stringify({ ...state, phase: 'stopped', stopped_from: 'copy', stopped_at: new Date().toISOString(), failures: 3 }));
  decisions.eeaf.holdSealing(false);

  const queries = [];
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => { if (query.includes('FROM entity WHERE rowid > ?')) queries.push({ query, params }); return exec(query, ...params); };
  const attempt4 = decisions.move({ ...settings, attempt: 4 });
  attempt4.step();
  host.sql.exec = exec;

  const continued = queries.find(({ params }) => params[0] === prior.after);
  assert.ok(continued, 'the next entity page starts after the saved cursor');
  assert.equal(attempt4.state().attempt, 4);
  assert.equal(attempt4.state().phase, 'catch-up', 'the stopped copy continues from its cursor and enters catch-up at the end');
  assert.equal(decisions.eeaf.logStore().typeOf('note:0'), 'note', 'verified progress is retained across the attempt change');
});
