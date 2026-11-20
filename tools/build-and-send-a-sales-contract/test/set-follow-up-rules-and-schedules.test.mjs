import test from 'node:test';
import assert from 'node:assert/strict';
import { setDealFollowUps } from '../read-data/set-follow-up-rules-and-schedules.mjs';

const fill = (steps, facts) => steps.map(step => ({ ...step, input: { ...step.input, label: step.input.label.replace('{contract_name}', () => facts.contract_name) } }));
const facts = { contract_name: 'Founder coaching' };

test('a rule and a schedule are each set by their own action, and the answer names each one', async () => {
  const calls = [];
  const setAction = async (action, args) => { calls.push([action, args]); return action === 'run-when-something-happens' ? { rule_id: 'rule_1' } : { schedule_id: 'sched_1' }; };
  const answer = await setDealFollowUps({
    checked: [
      { kind: 'rule', input: { label: 'Welcome: {contract_name}', when: {}, then: {} } },
      { kind: 'schedule', input: { label: 'Check-in', once_at: '2026-10-05T10:00:00Z', then: {} } },
    ],
    facts,
    fill,
    setAction,
  });
  assert.deepEqual(answer, { follow_ups: [
    { label: 'Welcome: Founder coaching', rule_id: 'rule_1' },
    { label: 'Check-in', schedule_id: 'sched_1', once_at: '2026-10-05T10:00:00Z' },
  ] });
  assert.deepEqual(calls.map(([action, args]) => [action, args.operation]), [['run-when-something-happens', 'set'], ['run-at-a-time', 'set']]);
});

test('a step the action refuses is reported with its reason, and the others still go', async () => {
  const setAction = async (action) => { if (action === 'run-at-a-time') throw new Error('The time has passed.'); return { rule_id: 'rule_2' }; };
  const answer = await setDealFollowUps({
    checked: [
      { kind: 'schedule', input: { label: 'Late', once_at: '2020-01-01T00:00:00Z', then: {} } },
      { kind: 'rule', input: { label: 'Paid', when: {}, then: {} } },
    ],
    facts,
    fill,
    setAction,
  });
  assert.deepEqual(answer.follow_ups, [
    { label: 'Late', refused: 'The time has passed.' },
    { label: 'Paid', rule_id: 'rule_2' },
  ]);
});

test('no checked steps sets nothing and answers with no list', async () => {
  assert.deepEqual(await setDealFollowUps({ checked: [], facts, fill, setAction: async () => { throw new Error('not called'); } }), {});
});
