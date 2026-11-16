// test/checklist-kept-once.test.mjs
//
// A step's checklist (the checks its question asked) is kept once under its identity and linked from every step that
// was asked it, so answering a step writes the answer, not its checks again. On 2026-10-05 a guide call on a store
// still on the decomposed tables wrote about 2,700 rows for one outcome step, 63% of them the 26 checks copied in.
// Every reader still sees the checklist as the list it was given: a decision kept apart, one kept whole, the store's
// read of every decision, and a store moved to the log engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { decisionStore, identityOf } from '../src/decision-store.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';

// The Trillion address these tests talk to is the one the caller gives; no address is built in.
process.env.TRILLION_ORIGIN ??= 'https://app.example.com';

const CHECKS = Array.from({ length: 26 }, (_, n) => ({ id: `check-${n}`, check: `The answer handles case ${n} in its own words`, kind: 'reason', source: { method: 'universal', step: 'outcome' } }));
const answer = { evidence_refs: ['e1'], desired_result: 'loaves left at closing', checklist: Object.fromEntries(CHECKS.map(row => [row.id, { handled: true }])) };

// Counts the statements that write, and opens the store on the decomposed tables when asked.
function opened({ decomposed }) {
  const host = sqliteHost(':memory:');
  let writes = 0;
  const sql = { ...host.sql, exec: (query, ...binds) => { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) writes += 1; return host.sql.exec(query, ...binds); } };
  if (decomposed) eeafStore(sql, { transaction: host.transaction, hash: identityOf }).write([{ id: 'old:1', type: 'old', value: { a: 1 } }], { actor: { by: 'test' } });
  const store = decisionStore(sql, { transaction: host.transaction });
  return { store, host, writes: () => { const n = writes; writes = 0; return n; } };
}

const root = id => ({ id, method: { id: 'universal' }, created_at: new Date().toISOString(), input: { goal: 'Price the sourdough', options: [] }, status: 'open', answered_steps: [], call_count: 0 });
const step = (step_id, checklist) => ({ step_id, answer, ...(checklist ? { checklist } : {}), answered_at: new Date().toISOString() });

for (const decomposed of [true, false]) {
  test(`a checklist answered again writes no copy of its checks (${decomposed ? 'decomposed tables' : 'log engine'})`, () => {
    const { store, writes } = opened({ decomposed });
    store.write({ cases: { 'case:a': root('case:a'), 'case:b': root('case:b'), 'case:c': root('case:c') } });
    store.addStep('case:a', store.readStep('case:a', null).record, step('outcome', CHECKS));
    const first = writes();
    store.addStep('case:b', store.readStep('case:b', null).record, step('outcome', CHECKS));
    const withChecks = writes();
    store.addStep('case:c', store.readStep('case:c', null).record, step('outcome'));
    const without = writes();
    // The same checks a second time cost what one link costs, never 26 checks' rows again.
    assert.ok(withChecks <= without + 10, `with checks ${withChecks}, without ${without}`);
    if (decomposed) assert.ok(first > without + 100, `the checks are kept the first time: ${first} against ${without}`);
    for (const id of ['case:a', 'case:b']) {
      assert.deepEqual(store.readStep(id, 'outcome').replay.checklist, CHECKS);
      assert.deepEqual(store.read({ cases: [id] }).cases[id].guidance[0].checklist, CHECKS);
    }
    assert.equal(store.read({ cases: ['case:c'] }).cases['case:c'].guidance[0].checklist, undefined);
  });
}

test('a decision kept whole keeps its checklist once too, and reads it as a list', () => {
  const { store } = opened({ decomposed: true });
  const { answered_steps, call_count, ...whole } = root('case:whole');
  store.eeaf.write([{ id: 'case:whole', type: 'decision', value: { ...whole, guidance: [step('scope', CHECKS)], calls: [] } }], { actor: { by: 'test' } });
  assert.deepEqual(store.readStep('case:whole', 'scope').replay.checklist, CHECKS);
  store.addStep('case:whole', store.readStep('case:whole', null).record, step('outcome', CHECKS));
  const read = store.read({ cases: ['case:whole'] }).cases['case:whole'];
  assert.deepEqual(read.guidance.map(entry => entry.checklist), [CHECKS, CHECKS]);
  assert.deepEqual(store.readStep('case:whole', 'outcome').replay.checklist, CHECKS);
});

test('a store moved to the log engine reads every checklist it kept', () => {
  const { store } = opened({ decomposed: true });
  store.write({ cases: { 'case:a': root('case:a') } });
  store.addStep('case:a', store.readStep('case:a', null).record, step('outcome', CHECKS));
  const move = store.move({ entities_per_batch: 7, bytes_per_batch: 64 * 1024, log_rows_per_batch: 50, switch_within_log_rows: 20, batches_per_step: 2, rest_seconds: 0, keep_days_after_switch: 0 });
  for (let steps = 0; store.eeaf.engine() === 'eeaf'; steps += 1) { move.step(); assert.ok(steps < 200, 'the move ends'); }
  assert.deepEqual(store.readStep('case:a', 'outcome').replay.checklist, CHECKS);
});

test('the existing store reads one immutable Workshop view despite orphan calls and a later root', () => {
  for (const decomposed of [false, true]) {
    const { store } = opened({ decomposed });
    const id = `case:immutable-reader-${decomposed}`;
    const logical = { step: `decision-step:${id}:000`, summary: `decision-answered-step:${id}:000`, call: `decision-call:${id}:000000` };
    // These are explicit DATA fixtures for this reader ABI. The actual writer/concurrent-publication controls live
    // with decision-records; this test does not implement another writer or pointer decoder.
    const accepted = { step_id: 'scope', answer, checklist: { checks: CHECKS }, answered_at: '2026-01-01T00:01:00Z', version: 1 };
    const summary = { step_id: 'scope', answered_at: accepted.answered_at, version: 1 };
    const call = { route: 'guide', step_id: 'scope', accepted: true, at: '2026-01-01T00:02:00Z' };
    const alternate = { ...accepted, answer: { desired_result: 'A later accepted root names another answer' } };
    const physical = (key, value) => `${key}:content:${identityOf(JSON.stringify(value))}`;
    const keys = { [logical.step]: physical(logical.step, accepted), [logical.summary]: physical(logical.summary, summary), [logical.call]: physical(logical.call, call) };
    const root = { id, source_id: id, input_identity: 'synthetic-input', input: { goal: 'Read one accepted view', evidence: [], options: [] },
      method: { id: 'universal' }, status: 'needs_decision', created_at: '2026-01-01T00:00:00Z', counts: { answered_steps: 1 }, call_count: 1, record_keys: keys };
    store.eeaf.write([
      { id: keys[logical.step], type: 'decision-step', value: accepted },
      { id: keys[logical.summary], type: 'decision-answered-step', value: summary },
      { id: keys[logical.call], type: 'decision-call', value: call },
      { id: logical.step, type: 'decision-step', value: alternate },
      { id: physical(logical.call, { ...call, accepted: false }), type: 'decision-call', value: { ...call, accepted: false } },
      { id, type: 'decision', value: root },
    ], { actor: { by: 'synthetic-fixture' } });
    const read = store.read({ cases: [id] }).cases[id];
    assert.deepEqual(read.guidance[0].answer, answer, 'a legacy logical slot cannot replace the root-selected value');
    assert.deepEqual(read.guidance[0].checklist, CHECKS);
    assert.equal(read.calls.length, 1);
    assert.equal(read.calls[0].accepted, true);
    assert.deepEqual(store.readStep(id, 'scope').replay.answer, answer);
    assert.equal(store.callsAt(id, 'scope').record.calls.length, 1, 'an orphan physical call is not counted as accepted');
    const view = store.contentOf(id, { acceptOwn: () => {
      const nextKey = physical(logical.step, alternate);
      store.eeaf.write([{ id: nextKey, type: 'decision-step', value: alternate },
        { id, type: 'decision', value: { ...root, record_keys: { ...keys, [logical.step]: nextKey } } }], { actor: { by: 'synthetic-new-root' } });
      return true;
    } });
    assert.deepEqual(view.guidance[0].answer, answer, 'the admitted content keeps its original loaded map');
    assert.deepEqual(store.readStep(id, 'scope').replay.answer, alternate.answer, 'a later read follows the later root');
  }
});
