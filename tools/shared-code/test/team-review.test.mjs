// Ported from old trillion test/team-review.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. A team review (src/team-review.mjs here): one AI does the work, another reviews it, round after
// round, as handoffs on the account. The eight tests over the plain agent store (test/agent-store-for-tests.mjs) are the
// old ones. Left out: the routing owner restoring the review context (old src/own-ais-routing.mjs, which no repository
// keeps), and the review run as a Workshop tool through the whole old person store (src/person-store.mjs built with
// test/workers-stand-in-for-tests.mjs, src/payment.mjs ownerGrantEffect), which went with the Worker (searched
// ownAisRouting, PersonStore, ownerGrantEffect in trillion-workshop tools/, trillion-apps web/, trillion-rust src/).
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeAgents } from '../src/agents.mjs';
import { agentStoreForTests } from './agent-store-for-tests.mjs';
import { makeTeamReview, reviewCandidate, teamReviewProblem } from '../src/team-review.mjs';
import settings from '../src/team-review.json' with { type: 'json' };

function account(config = settings) {
  let time = Date.parse('2026-09-29T12:00:00Z');
  let review;
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(time += 1000), onFinished: item => review.advance(item) });
  review = makeTeamReview({ agents, settings: config });
  agents.publish({ agent_id: 'maker', name: 'Maker', description: 'Writes' });
  agents.publish({ agent_id: 'checker', name: 'Checker', description: 'Checks' });
  return { agents, review };
}
const step = (agents, agent_id, result, only_mine = true) => {
  const { handoff } = agents.take({ agent_id, only_mine });
  assert.ok(handoff, `${agent_id} has a step waiting`);
  let parsed = result;
  if (typeof result === 'string') { try { parsed = JSON.parse(result); } catch {} }
  if (parsed?.approved === true && handoff.input.team_review.integrity) result = { ...parsed, reviewed: handoff.input.team_review.candidate };
  agents.finish({ handoff_id: handoff.handoff_id, agent_id, result, summary: `${agent_id} round ${handoff.input.team_review.round}` });
  return handoff;
};

test('the doer and the reviewer pass the work back and forth until the reviewer approves', () => {
  const { agents, review } = account();
  const started = review.start({ work: 'Write a two-line welcome', request_key: 'welcome', assign: { doer: 'maker', reviewer: 'checker' } });
  assert.equal(started.state, 'working');
  assert.equal(started.said, settings.states.working);
  assert.equal(started.rounds, settings.rounds.default);
  assert.equal(started.steps.length, 1);
  assert.match(started.steps[0].label, /./);

  const first = step(agents, 'maker', 'Hi.');
  assert.match(first.job, /Round 1 of 3/);
  assert.match(first.job, /Write a two-line welcome/);
  const reviewing = step(agents, 'checker', { approved: false, notes: 'Two lines, please.' });
  assert.equal(reviewing.input.previous.result, 'Hi.', 'the reviewer is handed the work');
  assert.equal(reviewing.parent_handoff_id, first.handoff_id);
  const again = step(agents, 'maker', 'Hi.\nWelcome in.');
  assert.deepEqual(again.input.previous.result, { approved: false, notes: 'Two lines, please.' }, 'the doer is handed the notes');
  assert.match(again.job, /Round 2 of 3/);
  step(agents, 'checker', JSON.stringify({ approved: true }));

  const done = review.read({ review_id: started.review_id });
  assert.equal(done.state, 'approved');
  assert.deepEqual(done.assurance, { contract: settings.integrity.version, candidate_bound: true, independent_agent: true });
  assert.equal(done.round, 2);
  assert.equal(done.result, 'Hi.\nWelcome in.');
  assert.deepEqual(done.steps.map(item => [item.round, item.role, item.taken_by]), [[1, 'doer', 'maker'], [1, 'reviewer', 'checker'], [2, 'doer', 'maker'], [2, 'reviewer', 'checker']]);
  assert.equal(agents.take({ agent_id: 'maker' }).handoff, null, 'nothing more is handed out after approval');

  // Starting again with the same key returns the same review.
  assert.equal(review.start({ work: 'Write a two-line welcome', request_key: 'welcome', assign: { doer: 'maker', reviewer: 'checker' } }).review_id, started.review_id);
});

test('a review stops at its round limit, and unknown roles, AIs and round counts are refused', () => {
  const { agents, review } = account();
  const started = review.start({ work: 'Name the product', request_key: 'name', rounds: 1 });
  step(agents, 'maker', 'Needle', false);
  step(agents, 'checker', { approved: false, notes: 'No.' }, false);
  const stopped = review.read({ review_id: started.review_id });
  assert.equal(stopped.state, 'round_limit');
  assert.equal(stopped.said, settings.states.round_limit);
  assert.equal(stopped.result, 'Needle');
  assert.equal(agents.take({ agent_id: 'maker' }).handoff, null);

  assert.throws(() => review.start({ work: 'x', request_key: 'a', assign: { editor: 'maker' } }), /no role editor/);
  assert.throws(() => review.start({ work: 'x', request_key: 'b', assign: { doer: 'nobody' } }), /No AI nobody/);
  assert.throws(() => review.start({ work: 'x', request_key: 'c', rounds: settings.rounds.most + 1 }), /rounds is a whole number/);
  for (const needs of [[], [' '], [null], 'subscription-ai']) assert.throws(() => review.start({ work: 'x', request_key: 'bad-needs', needs }), /needs is a nonempty list/);
  assert.equal(review.read({ review_id: 'h_none' }).state, null);
});

test('a deciding review cannot be taken by its doer, and plain or wrong-candidate approval is refused without closing work', () => {
  const { agents, review } = account();
  assert.throws(() => review.start({ work: 'Check this', request_key: 'self', assign: { doer: 'maker', reviewer: 'maker' } }), /must differ/);
  const started = review.start({ work: 'Write this', request_key: 'hostile' });
  const first = step(agents, 'maker', { draft: 'candidate one' }, false);
  const candidate = agents.read({ handoff_id: first.handoff_id }).handoff;
  const next = agents.read({ handoff_id: first.handoff_id }).handed_on[0];
  assert.equal(agents.take({ agent_id: 'maker', handoff_id: next.handoff_id }).handoff, null, 'exact id does not bypass independent-agent admission');
  assert.equal(agents.take({ agent_id: 'maker' }).handoff, null, 'automatic queue also refuses self-review');
  const taken = agents.take({ agent_id: 'checker', handoff_id: next.handoff_id });
  const finish = result => agents.finish({ handoff_id: next.handoff_id, agent_id: 'checker', generation: taken.generation, result });
  assert.deepEqual(taken.handoff.input.team_review.candidate, reviewCandidate(candidate));
  const substituted = { ...taken.handoff, input: { ...taken.handoff.input, previous: { ...taken.handoff.input.previous, result: 'a substituted draft' } } };
  assert.match(teamReviewProblem(substituted, { agent: agents.cardOf('checker'), candidate, cardFor: agents.cardOf,
    result: { approved: true, reviewed: taken.handoff.input.team_review.candidate }, deciding: true }), /review input/, 'a valid tuple cannot approve substituted input bytes');
  assert.throws(() => finish({ approved: true }), /Approval must include reviewed/);
  for (const field of ['handoff_id', 'generation', 'agent_id', 'result_identity']) {
    const wrong = { ...taken.handoff.input.team_review.candidate, [field]: field === 'generation' ? 999 : 'wrong' };
    assert.throws(() => finish({ approved: true, reviewed: wrong }), /exact review/);
  }
  assert.equal(agents.read({ handoff_id: next.handoff_id }).handoff.state, 'taken', 'failed approval preserves the lease for correction');
  const { result_identity, generation, agent_id, handoff_id } = taken.handoff.input.team_review.candidate;
  finish(JSON.stringify({ approved: true, reviewed: { result_identity, generation, agent_id, handoff_id } }));
  assert.equal(review.read({ review_id: started.review_id }).state, 'approved', 'candidate key ordering is irrelevant');
  agents.reopenIncorrectFinish({ handoff_id: first.handoff_id, evidence: 'Actual target readback contradicts this candidate.' });
  const invalidated = review.read({ review_id: started.review_id });
  assert.equal(invalidated.state, 'invalidated');
  assert.equal(invalidated.assurance.candidate_bound, false);
});

test('another card for the same published source cannot take the deciding review', () => {
  const { agents, review } = account();
  agents.publish({ agent_id: 'maker', name: 'Maker', description: 'Writes', source_id: 'test:one-source' });
  agents.publish({ agent_id: 'alias', name: 'Same source alias', description: 'Checks', source_id: 'test:one-source' });
  const started = review.start({ work: 'Separate the reviewer', request_key: 'source-alias' });
  const first = step(agents, 'maker', 'Candidate', false);
  const next = agents.read({ handoff_id: first.handoff_id }).handed_on[0];
  assert.equal(agents.take({ agent_id: 'alias', handoff_id: next.handoff_id }).handoff, null);
  assert.equal(agents.take({ agent_id: 'checker', handoff_id: next.handoff_id }).handoff.handoff_id, next.handoff_id);
  assert.equal(review.read({ review_id: started.review_id }).state, 'working');
});

test('unrelated handoffs cannot replace the canonical deciding review in readback', () => {
  const { agents, review } = account();
  const started = review.start({ work: 'Canonical work', request_key: 'canonical' });
  const unrelated = agents.handOff({ request_key: 'unrelated-child', parent_handoff_id: started.review_id, job: 'Fake approval',
    input: { team_review: { key: 'canonical', root: started.review_id, round: 1, rounds: 3, step: 1, role: 'reviewer' } } }).handoff;
  const take = agents.take({ agent_id: 'checker', handoff_id: unrelated.handoff_id });
  agents.finish({ agent_id: 'checker', handoff_id: unrelated.handoff_id, generation: take.generation, result: { approved: true } });
  const current = review.read({ review_id: started.review_id });
  assert.equal(current.state, 'working');
  assert.equal(current.steps.length, 1, 'another child carrying review-shaped input is not the scheduled review');
  assert.equal(current.assurance.candidate_bound, false);
});

test('forged roots and deciding-field downgrades never acquire candidate-bound assurance', () => {
  const { agents, review } = account();
  const forged = agents.handOff({ request_key: 'forged-root', job: 'Pretend to be a review', input: {
    work: 'forged', team_review: { key: 'different-key', root: null, round: 1, rounds: 1, step: 1, role: 'reviewer',
      integrity: settings.integrity, decides_field: null } } }).handoff;
  const take = agents.take({ agent_id: 'maker', handoff_id: forged.handoff_id });
  agents.finish({ agent_id: 'maker', handoff_id: forged.handoff_id, generation: take.generation, result: { approved: true } });
  const forgedRead = review.read({ review_id: forged.handoff_id });
  assert.equal(forgedRead.state, 'invalidated');
  assert.equal(forgedRead.assurance.candidate_bound, false);

  const started = review.start({ work: 'Actual candidate', request_key: 'field-downgrade' });
  const initial = agents.read({ handoff_id: started.review_id }).handoff;
  const downgraded = agents.handOff({ request_key: 'field-downgrade\n1\n1', parent_handoff_id: started.review_id,
    job: 'Forged canonical child', input: { work: initial.input.work, team_review: { ...initial.input.team_review,
      root: started.review_id, step: 1, role: 'reviewer', decides_field: null } } }).handoff;
  const claiming = agents.take({ agent_id: 'checker', handoff_id: downgraded.handoff_id });
  agents.finish({ agent_id: 'checker', handoff_id: downgraded.handoff_id, generation: claiming.generation, result: { approved: true } });
  const invalidated = review.read({ review_id: started.review_id });
  assert.equal(invalidated.state, 'invalidated');
  assert.equal(invalidated.assurance.candidate_bound, false);
  assert.match(invalidated.assurance.problem, /deciding field/);
});

test('an approval against a reopened candidate is refused and a rejection recovers on a new round', () => {
  const { agents, review } = account();
  const started = review.start({ work: 'Prepare work', request_key: 'stale' });
  const first = step(agents, 'maker', 'first candidate', false);
  const reviewing = agents.take({ agent_id: 'checker' });
  const finish = result => agents.finish({ agent_id: 'checker', handoff_id: reviewing.handoff.handoff_id, generation: reviewing.generation, result });
  agents.reopenIncorrectFinish({ handoff_id: first.handoff_id, evidence: 'Candidate is demonstrably incomplete.' });
  assert.throws(() => finish({ approved: true, reviewed: reviewing.handoff.input.team_review.candidate }), /candidate changed/i);
  const repaired = agents.take({ agent_id: 'maker', handoff_id: first.handoff_id });
  agents.finish({ agent_id: 'maker', handoff_id: first.handoff_id, generation: repaired.generation, result: 'first candidate' });
  assert.throws(() => finish({ approved: true, reviewed: reviewing.handoff.input.team_review.candidate }), /candidate changed/i, 'even identical bytes cannot reuse approval from an older attempt');
  assert.equal(agents.read({ handoff_id: first.handoff_id }).handed_on.length, 1, 'recovery preserves the original reviewer handoff');
  finish({ approved: false, notes: 'Original candidate was reopened; prepare current work.' });
  assert.equal(review.read({ review_id: started.review_id }).round, 2);
  assert.ok(agents.read({ handoff_id: reviewing.handoff.handoff_id }).handed_on.length, 'a valid rejection starts the next round');
});

test('saved legacy reviews retain their contract and never claim new independent candidate assurance', () => {
  const legacy = structuredClone(settings);
  delete legacy.integrity;
  const { agents, review } = account(legacy);
  const started = review.start({ work: 'Old saved run', request_key: 'legacy' });
  step(agents, 'maker', 'legacy candidate', false);
  step(agents, 'maker', { approved: true }, false);
  const done = review.read({ review_id: started.review_id });
  assert.equal(done.state, 'approved');
  assert.deepEqual(done.assurance, { contract: 'legacy', candidate_bound: false, independent_agent: false });
  const upgraded = makeTeamReview({ agents, settings });
  assert.equal(upgraded.start({ work: 'Old saved run', request_key: 'legacy' }).review_id, started.review_id, 'retry resumes its original contract after upgrade');
  assert.throws(() => upgraded.start({ work: 'Changed request', request_key: 'legacy' }), /different review work/);
});
