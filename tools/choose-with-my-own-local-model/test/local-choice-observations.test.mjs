import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { localChoiceObservations } from '../src/local-choice-observations.mjs';

function harness(limit = 20) {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...args) {
    if (!args.length && query.startsWith('CREATE')) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    if (query.startsWith('SELECT')) return { toArray: () => statement.all(...args) };
    statement.run(...args);
    return { toArray: () => [] };
  } };
  return { db, owner: localChoiceObservations(sql, { limit }) };
}

test('records real calls, including timeout and unavailable routes, without keeping input or output', async () => {
  const { db, owner } = harness();
  const answer = await owner.run({ task: 'classify', surface: 'worker', deadline_ms: 100,
    decide: () => ({ model: 'device-model', private_answer: 'secret' }) });
  assert.equal(answer.private_answer, 'secret');
  assert.equal(await owner.run({ task: 'classify', surface: 'worker', deadline_ms: 100, decide: () => null }), null);
  assert.equal(await owner.run({ task: 'classify', surface: 'worker', deadline_ms: 1,
    decide: () => new Promise(resolve => setTimeout(() => resolve('late'), 15)) }), null);
  const summary = owner.summary();
  assert.deepEqual(summary.coverage[0].requests, 3);
  assert.deepEqual([summary.coverage[0].answers, summary.coverage[0].unavailable, summary.coverage[0].timeouts], [1, 1, 1]);
  assert.deepEqual(Object.keys(db.prepare('SELECT * FROM local_choice_observations LIMIT 1').get()).sort(),
    ['at', 'elapsed_ms', 'model', 'outcome', 'reason', 'seq', 'surface', 'task'].sort());
});

test('keeps a bounded window and calculates p95 from answered calls only', () => {
  const { owner } = harness(3);
  for (const elapsed_ms of [1, 3, 7, 11]) owner.observe({ task: 'score', surface: 'mcp', outcome: 'answered', elapsed_ms });
  owner.observe({ task: 'score', surface: 'mcp', outcome: 'error', elapsed_ms: 999, reason: 'route-error' });
  const result = owner.summary();
  assert.equal(result.window, 3);
  assert.deepEqual([result.coverage[0].requests, result.coverage[0].answers, result.coverage[0].errors, result.coverage[0].p95_answer_ms], [3, 2, 1, 11]);
});
