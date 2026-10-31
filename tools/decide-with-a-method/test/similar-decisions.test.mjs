// Ported from the old app's test/related-reads-goals-only.test.mjs: similar earlier decisions are weighed on each
// decision's goal and method alone, read from the newest decisions' own fields, and only the few kept are read whole.
// The look back is bounded, a removed decision is never offered, and the asked decision is never similar to itself.
// The door here is an in-memory stand-in for the records door: its list keeps the door's order and its `fields`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { similarDecisions } from '../read-data/similar-decisions.mjs';

const { similar } = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));

function memoryDoor() {
  const records = new Map();
  const counts = { reads: 0, listed: 0, pages: [], listedFields: [] };
  return {
    records, counts,
    async read(type, id) { counts.reads += 1; const kept = records.get(id); return kept && kept.type === type ? structuredClone(kept.value) : null; },
    async *list({ type, order, reverse, fields, limit }) {
      assert.equal(order, similar.order);
      assert.equal(reverse, true);
      counts.pages.push(limit);
      counts.listedFields.push(fields ?? []);
      const rows = [...records.entries()].filter(([, kept]) => kept.type === type)
        .sort(([, a], [, b]) => (a.value.created_at < b.value.created_at ? 1 : -1));
      for (const [id, kept] of rows) {
        counts.listed += 1;
        yield { id, type, value: fields ? Object.fromEntries(fields.filter(name => name in kept.value).map(name => [name, kept.value[name]])) : kept.value };
      }
    },
  };
}

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

test('similar decisions come from goals alone, closest first, and only the kept are read whole', async () => {
  const door = memoryDoor();
  for (let i = 0; i < 120; i += 1) admit(door, i, `Decide the ${topics[i % topics.length]} for week ${i}`);
  const id = admit(door, 'probe', 'Decide the pottery camp price for spring');

  door.counts.reads = 0;
  const { similar_decisions: found } = await similarDecisions({ decision_id: id, limit: similar.most }, { door });
  assert.equal(found.length, similar.most, 'every decision shares "decide" and the method, so the most are kept');
  assert.ok(found.slice(0, 30).every(item => item.goal.includes('pottery camp price')), 'the closest goals come first');
  assert.ok(found.every(item => Array.isArray(item.observed) && Array.isArray(item.reported)));
  assert.ok(!found.some(item => item.case_id === id), 'the asked decision is never similar to itself');
  assert.equal(door.counts.reads, 1 + found.length, 'the asked decision and the kept ones are read whole, nothing else');

  door.counts.reads = 0;
  const five = await similarDecisions({ decision_id: id, limit: 5 }, { door });
  assert.equal(five.similar_decisions.length, 5);
  assert.ok(door.counts.reads <= 6, `read ${door.counts.reads} decisions whole for five similar ones`);
});

test('a removed decision is never offered as similar', async () => {
  const door = memoryDoor();
  const gone = admit(door, 1, 'Decide the pottery camp price for summer');
  admit(door, 2, 'Decide the pottery camp price for autumn');
  const id = admit(door, 3, 'Decide the pottery camp price for spring');
  door.records.delete(gone);
  const { similar_decisions: found } = await similarDecisions({ decision_id: id, limit: 5 }, { door });
  assert.deepEqual(found.map(item => item.goal), ['Decide the pottery camp price for autumn']);
});

test('the look back is the newest decisions only, however many the person has', async () => {
  const door = memoryDoor();
  admit(door, 0, 'Decide the pottery camp price for winter');
  for (let i = 1; i <= similar.look_back; i += 1) admit(door, i, `Pick a lunch spot near office ${i}`);
  const id = admit(door, similar.look_back + 1, 'Decide the pottery camp price for spring');
  const { similar_decisions: found } = await similarDecisions({ decision_id: id }, { door });
  assert.deepEqual(found, [], 'the one match is older than the look back');
  assert.ok(door.counts.listed <= similar.look_back, `listed ${door.counts.listed}`);
});

test('a kept decision says what was chosen, what was next, its status and its results', async () => {
  const door = memoryDoor();
  admit(door, 1, 'Decide the pottery camp price for summer', {
    decision: { option_id: 'b', next_action: 'Email the parents the new price' }, decided_at: at(2), status: 'outcome_verified',
    outcome_checks: [{ result: 'failed', checked_at: at(3) }],
    reports: [{ result: 'failed', summary: 'Fewer sign-ups', reported_at: at(3) }],
  });
  admit(door, 2, 'Decide the pottery camp price for autumn', { method: { id: 'other-method' } });
  const id = admit(door, 4, 'Decide the pottery camp price for spring');
  const { similar_decisions: found } = await similarDecisions({ decision_id: id }, { door });
  assert.deepEqual(found[0], {
    case_id: 'decision-1', goal: 'Decide the pottery camp price for summer', method: 'universal', decision: 'B',
    next_action: 'Email the parents the new price', status: 'correction_needed', observed: [], reported: [{ result: 'failed', summary: 'Fewer sign-ups' }],
  });
  assert.equal(found[1].method, 'other-method', 'a different method scores lower but still shares the words');
  assert.ok(door.counts.listedFields.every(fields => !fields.includes('method')), 'the list never carries a method snapshot');
});

test('a decision that is not named or not there is refused', async () => {
  const door = memoryDoor();
  await assert.rejects(similarDecisions({}, { door }), /Name the decision/);
  await assert.rejects(similarDecisions({ decision_id: 'nope' }, { door }), /No decision has that id/);
});
