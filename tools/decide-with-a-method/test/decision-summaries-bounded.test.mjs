// Ported from old trillion test/decision-summaries-bounded.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. engine.summaries (src/engine.mjs over src/decision-store.mjs) is
// tool:see-my-decisions (read-data/work-screen.mjs summariesOf: only the pursuits the page's decisions cite are read);
// engine.get, ownOf and contentOf of a laid-apart decision are readDecision and laidTogether
// (read-data/decision-records.mjs), the layout the old test's last case was written in. SQL statements and rows are
// records crossed at the door (old-engine-for-tests.mjs `counting`), on one in-memory door instead of two record
// engines. The screen also reads one bounded page of pursuits for its tree (work-screen.json `limit`), the same at 100
// and 400 pursuits. A laid-apart root has no call log, so "no calls" is that the read has none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, inputIdentity, laidTogether, readDecision } from '../read-data/decision-records.mjs';
import { seeMyDecisions } from '../read-data/work-screen.mjs';
import { memoryDoor } from './fixtures.mjs';
import { counting } from './old-engine-for-tests.mjs';

const at = '2026-10-08T12:00:00Z';
const decision = n => ({
  id: `case:s${n}`, source_id: 'synthetic:summaries', created_at: `2026-10-08T12:00:0${n}Z`, status: 'needs_outcome',
  input: { goal: `Choose ${n}`, evidence: [{ ref: 'a', claim: 'b' }], options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] },
  method: { id: 'universal' }, guidance: [{ step_id: 'scope', answer: { switches: {} }, answered_at: at }],
  cited_pursuits: { [`pursuit:${String(n).padStart(5, '0')}`]: { ref: 'cited' } },
});

function seed(pursuits) {
  const door = memoryDoor();
  for (const n of [0, 1, 2]) door.put(`case:s${n}`, 'decision', decision(n));
  for (let n = 0; n < pursuits; n += 1) {
    const key = `pursuit:${String(n).padStart(5, '0')}`;
    door.put(key, 'pursuit', { id: key, title: `Pursuit ${n}`, status: 'active', notes: 'x'.repeat(300) });
  }
  return door;
}

test('cold decision summaries read the cited pursuits, not every pursuit, as pursuits quadruple', async () => {
  const samples = [];
  for (const pursuits of [100, 400]) {
    const door = counting(seed(pursuits));
    const { summaries } = await seeMyDecisions({ native_collection_page: true }, { door });
    assert.equal(summaries.length, 3);
    assert.deepEqual(summaries.map(item => item.pursuits.map(p => p.title)).sort(), [['Pursuit 0'], ['Pursuit 1'], ['Pursuit 2']]);
    const { reads, listed } = door.take();
    samples.push({ pursuits, reads: reads.length, rows: listed.length });
  }
  assert.ok(samples[1].reads <= Math.max(samples[0].reads * 1.5, samples[0].reads + 6), JSON.stringify(samples));
  assert.ok(samples[1].rows <= Math.max(samples[0].rows * 1.5, samples[0].rows + 6), JSON.stringify(samples));
});

const laidId = 'source:bGFpZC1hcGFydA';
const pad = (n, digits) => String(n).padStart(digits, '0');
const laidMethod = { id: 'careful', steps: [{ id: 'scope' }, { id: 'outcome' }] };
const laidInput = { goal: 'Choose where it goes', options: [{ id: 'x', label: 'Place X' }, { id: 'y', label: 'Place Y' }] };
const laidEvidence = Array.from({ length: 400 }, (_, n) => ({ ref: `fact-${n}`, claim: `Claim ${n} ${'w'.repeat(200)}`, added_at: at }));
const laidStep = { step_id: 'outcome', answer: { why: 'because' }, answered_at: at, checklist: { checks: Array.from({ length: 60 }, (_, n) => ({ id: `check-${n}`, question: `Question ${n}?` })) }, verdicts: { given: [{ check: 'check-1', meets: true }] } };
const startedWith = inputIdentity(JSON.parse(canonical({ ...laidInput, evidence: laidEvidence })));
const methodIdentity = inputIdentity(laidMethod);

function laidApart() {
  const text = JSON.stringify(laidStep);
  const cut = Math.floor(text.length / 2);
  const step = `decision-step:${laidId}:001`;
  return [
    { id: laidId, type: 'decision', value: {
      id: laidId, source_id: 'laid-apart', created_at: at, status: 'needs_outcome', input: { goal: laidInput.goal }, method_id: 'careful',
      method_identity: methodIdentity, input_identity: startedWith, call_count: 3,
      decision: { option_id: 'x', next_action: 'Do it', success_measure: 'It is done' }, decided_at: at,
      counts: { options: 2, evidence: laidEvidence.length, answered_steps: 2, reports: 1, carried_out: 1, cited_pursuits: 1 },
    } },
    ...laidInput.options.map((option, n) => ({ id: `decision-option:${laidId}:${pad(n, 3)}`, type: 'decision-option', value: option })),
    ...laidEvidence.map((item, n) => ({ id: `decision-evidence:${laidId}:${pad(n, 4)}`, type: 'decision-evidence', value: item })),
    { id: `decision-answered-step:${laidId}:000`, type: 'decision-answered-step', value: { step_id: 'scope', answered_at: at, version: 1, needs_recheck: false } },
    { id: `decision-answered-step:${laidId}:001`, type: 'decision-answered-step', value: { step_id: 'outcome', answered_at: at, version: 2, needs_recheck: true } },
    { id: `decision-step:${laidId}:000`, type: 'decision-step', value: { step_id: 'scope', answer: { switches: {} }, answered_at: at } },
    { id: step, type: 'decision-step', value: { step_id: 'outcome', kept_in_parts: 2 } },
    { id: `${step}:part:000`, type: 'decision-part', value: { of: step, at: 0, text: text.slice(0, cut) } },
    { id: `${step}:part:001`, type: 'decision-part', value: { of: step, at: 1, text: text.slice(cut) } },
    { id: `decision-report:${laidId}:0000`, type: 'decision-report', value: { result: 'worked', summary: 'It held', reported_at: at } },
    { id: `decision-carried-out:${laidId}:0000`, type: 'decision-carried-out', value: { done: 'did it', decision_generation: 1 } },
    { id: `decision-cited-pursuit:${laidId}:0000`, type: 'decision-cited-pursuit', value: { ref: 'pursuit:00001', said: 'Pursuit one: now a; should be b' } },
    { id: `decision-method:${methodIdentity}`, type: 'decision-method', value: { method: laidMethod } },
  ];
}

test('a laid-apart decision with more than 64 KiB of evidence reads whole', async () => {
  assert.ok(laidEvidence.reduce((sum, item) => sum + JSON.stringify(item).length, 0) > 65536);
  const door = memoryDoor();
  for (const { id, type, value } of laidApart()) door.put(id, type, value);

  const record = await readDecision(door, laidId, ['outcome']);
  assert.equal(record.input.evidence.length, 400);
  assert.deepEqual(record.input.options, laidInput.options);
  assert.equal(record.method.id, 'careful');
  assert.equal(record.counts, undefined);
  assert.deepEqual(record.guidance.map(step => step.step_id), ['scope', 'outcome']);
  assert.equal(record.guidance[1].checklist.length, 60, 'the step kept in parts reads whole with its checklist');
  assert.deepEqual(record.guidance[1].verdicts, [{ check: 'check-1', meets: true }]);
  assert.equal(record.guidance[1].needs_recheck, true);
  assert.equal(record.guidance[1].version, 2);
  assert.equal(record.reports.length, 1);
  assert.equal(record.carried_out.length, 1);
  assert.deepEqual(record.cited_pursuits, { 'pursuit:00001': 'Pursuit one: now a; should be b' });
  assert.equal((record.calls ?? []).length, 0);
  assert.equal(record.input_identity, startedWith);

  const { record: own } = await laidTogether(door, laidId, door.value(laidId), ['evidence'], { method: true });
  assert.equal(own.method.id, 'careful');
  assert.equal(own.input.evidence.length, 400);
  const content = await readDecision(door, laidId);
  assert.deepEqual(content.guidance.map(step => step.step_id), ['scope', 'outcome']);
  const [summary] = (await seeMyDecisions({ native_collection_page: true }, { door })).summaries;
  assert.equal(summary.method, 'careful');
  assert.equal(summary.decided, true);
  assert.equal(summary.carried_out, true);
  assert.equal(summary.decision, 'Place X');
});
