// Ported from the old app's test/related-reads-goals-only.test.mjs: similar earlier decisions are weighed on each
// decision's goal and method alone, read from the newest decisions' own fields, and only the few kept are read whole.
// The look back is bounded, a removed decision is never offered, and the asked decision is never similar to itself.
// The records are handed to the read by the caller (fixtures.mjs `run`): a test hands all of them, or the look back only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { similarDecisions } from '../read-data/similar-decisions.mjs';
import { memoryDoor, run } from './fixtures.mjs';

const { similar } = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));

const topics = ['pottery camp price', 'client email reply', 'upload speed fix', 'pricing page copy'];
const at = i => new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
const admit = (door, i, goal, extra = {}) => {
  const id = `decision-${i}`;
  door.records.set(id, { type: 'decision', value: {
    created_at: at(typeof i === 'number' ? i : 100000), method: { id: 'universal' },
    input: { goal, evidence: [{ ref: 'e', claim: 'A long piece of evidence. '.repeat(20) }], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    status: 'needs_decision', ...extra, method_id: (extra.method ?? { id: 'universal' }).id,
  } });
  return id;
};

// The records a caller hands for one similar-decisions read: the asked decision and the newest `look_back` decisions, and no other decision.
const lookBack = (store, asked) => ({
  all: () => {
    const decisions = store.all().filter(record => record.type === 'decision').sort((a, b) => (a.value.created_at < b.value.created_at ? 1 : -1));
    const kept = new Set([asked, ...decisions.slice(0, similar.look_back).map(record => record.id)]);
    return store.all().filter(record => record.type !== 'decision' || kept.has(record.id));
  },
  write: list => store.write(list),
});

test('similar decisions come from goals alone, closest first, and only the kept are read whole', async () => {
  const base = memoryDoor();
  for (let i = 0; i < 120; i += 1) admit(base, i, `Decide the ${topics[i % topics.length]} for week ${i}`);
  const id = admit(base, 'probe', 'Decide the pottery camp price for spring');

  const everything = await run(base, similarDecisions, { decision_id: id, limit: similar.most });
  const { similar_decisions: found } = await run(lookBack(base, id), similarDecisions, { decision_id: id, limit: similar.most });
  assert.equal(found.length, similar.most, 'every decision shares "decide" and the method, so the most are kept');
  assert.deepEqual(found, everything.similar_decisions, 'the answer is the same with only the look back handed in');
  assert.ok(found.slice(0, 30).every(item => item.goal.includes('pottery camp price')), 'the closest goals come first');
  assert.ok(found.every(item => Array.isArray(item.observed) && Array.isArray(item.reported)));
  assert.ok(!found.some(item => item.case_id === id), 'the asked decision is never similar to itself');

  const five = await run(base, similarDecisions, { decision_id: id, limit: 5 });
  assert.deepEqual(five.similar_decisions, found.slice(0, 5), 'five are the five closest of the same ranking');
});

test('a removed decision is never offered as similar', async () => {
  const base = memoryDoor();
  const gone = admit(base, 1, 'Decide the pottery camp price for summer');
  admit(base, 2, 'Decide the pottery camp price for autumn');
  const id = admit(base, 3, 'Decide the pottery camp price for spring');
  base.records.delete(gone);
  const { similar_decisions: found } = await run(base, similarDecisions, { decision_id: id, limit: 5 });
  assert.deepEqual(found.map(item => item.goal), ['Decide the pottery camp price for autumn']);
});

test('the look back is the newest decisions only, however many the person has', async () => {
  const base = memoryDoor();
  admit(base, 0, 'Decide the pottery camp price for winter');
  for (let i = 1; i <= similar.look_back; i += 1) admit(base, i, `Pick a lunch spot near office ${i}`);
  const id = admit(base, similar.look_back + 1, 'Decide the pottery camp price for spring');
  const everything = await run(base, similarDecisions, { decision_id: id });
  assert.deepEqual(everything.similar_decisions, [], 'the one match is older than the look back');
  const bounded = await run(lookBack(base, id), similarDecisions, { decision_id: id });
  assert.deepEqual(bounded, everything, 'handing only the look back gives the same answer');
});

test('a kept decision says what was chosen, what was next, its status and its results', async () => {
  const base = memoryDoor();
  admit(base, 1, 'Decide the pottery camp price for summer', {
    decision: { option_id: 'b', next_action: 'Email the parents the new price' }, decided_at: at(2), status: 'outcome_verified',
    outcome_checks: [{ result: 'failed', checked_at: at(3) }],
    reports: [{ result: 'failed', summary: 'Fewer sign-ups', reported_at: at(3) }],
  });
  admit(base, 2, 'Decide the pottery camp price for autumn', { method: { id: 'other-method' } });
  const id = admit(base, 4, 'Decide the pottery camp price for spring');
  const { similar_decisions: found } = await run(base, similarDecisions, { decision_id: id });
  assert.deepEqual(found[0], {
    case_id: 'decision-1', goal: 'Decide the pottery camp price for summer', method: 'universal', decision: 'B',
    next_action: 'Email the parents the new price', status: 'correction_needed', observed: [], reported: [{ result: 'failed', summary: 'Fewer sign-ups' }],
  });
  assert.equal(found[1].method, 'other-method', 'a different method scores lower but still shares the words');
  // The method is read from the method id, never its snapshot: the answer is the same without the snapshot handed in.
  const withoutSnapshots = {
    all: () => base.all().map(record => (record.type === 'decision'
      ? { ...record, value: Object.fromEntries(Object.entries(record.value).filter(([name]) => name !== 'method')) }
      : record)),
    write: list => base.write(list),
  };
  assert.deepEqual((await run(withoutSnapshots, similarDecisions, { decision_id: id })).similar_decisions, found);
});

test('a decision that is not named or not there is refused', async () => {
  const base = memoryDoor();
  assert.throws(() => run(base, similarDecisions, {}), /Name the decision/);
  assert.throws(() => run(base, similarDecisions, { decision_id: 'nope' }), /No decision has that id/);
});
