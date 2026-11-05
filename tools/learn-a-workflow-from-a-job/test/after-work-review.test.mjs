// test/after-work-review.test.mjs
// Finished work is followed by one review job for the AI that finished it, only when switched on, and a review is never reviewed (F-0156).
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { makeAfterWorkReview } from '../src/after-work-review.mjs';
import settings from '../src/after-work-review.json' with { type: 'json' };
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

function account(overrides) {
  const agents = makeAgents({ store: agentStoreForTests() });
  agents.publish({ agent_id: 'maker', name: 'Maker', description: 'Takes work', takes_work: true });
  const review = makeAfterWorkReview({ agents, settings: { ...settings, ...overrides } });
  const finish = key => {
    const { handoff } = agents.handOff({ request_key: key, job: 'Draft the launch note', to_agent: 'maker' });
    agents.take({ agent_id: 'maker', handoff_id: handoff.handoff_id });
    return agents.finish({ handoff_id: handoff.handoff_id, agent_id: 'maker', result: 'done' }).handoff;
  };
  return { agents, review, finish };
}

test('off by default: nothing is handed', () => {
  const { review, finish } = account({});
  assert.equal(review.review(finish('a')), null);
});

test('on: one review job for the finishing AI, once per job, never for a review', () => {
  const { review, finish } = account({ on: true });
  const finished = finish('b');
  const first = review.review(finished);
  assert.equal(first.handoff.to_agent, 'maker');
  assert.equal(first.handoff.parent_handoff_id, finished.handoff_id);
  assert.match(first.handoff.job, /Where it goes/);
  assert.match(first.handoff.job, /Draft the launch note/);
  const again = review.review(finished);
  assert.equal(again.handoff.handoff_id, first.handoff.handoff_id);
  assert.equal(review.review({ ...first.handoff, taken_by: 'maker', input: { after_work_review: finished.handoff_id } }), null);
  console.log('readback', first.handoff.job.slice(0, 160));
});
