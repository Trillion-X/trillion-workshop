// The community matchmaker rows run as the container runs them, against the stand-in records door with exactly each
// row's rights: a round handed out, scores in, both yeses, the one-to-one made, and a job the door already holds
// never handed again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowOf, runRow } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { ids } from '../read-data/matchmaker-records.mjs';
import { answersFor, C, guild, START } from './community-fixtures.mjs';

const advance = rowOf(rows, 'tool:advance-a-community-matchmaker');
const answer = rowOf(rows, 'tool:answer-in-a-community');
const read = rowOf(rows, 'tool:read-my-community-matches');
const forget = rowOf(rows, 'tool:forget-a-person-in-a-community');
const check = rowOf(rows, 'tool:check-community-matching-settings');

// One row run over what the door holds now; what it holds afterwards is the next run's world.
async function step(world, row, input) {
  const run = await runRow(row, input, { records: world.records });
  assert.equal(run.status, 0, run.error);
  world.records = run.kept;
  return run.result;
}
const kept = (world, prefix) => world.records.filter(record => record.id.startsWith(prefix));
const jobFor = (world, person, start) => kept(world, ids.jobPrefix(C)).map(record => record.value).find(job => job.for === person && job.request_key.startsWith(start));
const scoresFrom = job => job.input.candidates.map(candidate => ({
  candidate_ref: candidate.candidate_ref,
  factors: Object.fromEntries(job.input.factors.map(factor => [factor, { score: 0.8, reason: `${candidate.name} fits ${factor}.`, you: job.input.you.claims.map(claim => claim.claim_ref), them: candidate.claims.map(claim => claim.claim_ref) }])),
}));

test('a guild\'s matchmaker runs through its rows: a round on the clock, scores, two yeses and the one-to-one', async () => {
  const book = guild([['ana', 'Ana'], ['ben', 'Ben']], { createdAt: START - 7 * 24 * 3600000 });
  const world = { records: book.list('') };
  for (const person of ['ana', 'ben']) await step(world, answer, { community_id: C, person, kind: 'profile', answers: answersFor('cabinet', `${person} built forty drawers`), now: START - 1000 });
  const ticked = await step(world, advance, { community_id: C, now: START });
  assert.equal(ticked.round.started.asked_to_score, 2);
  const roundId = ticked.round.started.round_id;
  for (const person of ['ana', 'ben']) {
    const result = await step(world, answer, { community_id: C, person, kind: 'scores', round_id: roundId, scores: scoresFrom(jobFor(world, person, 'match-score:')), now: START + 1000 });
    assert.equal(result.outcome.ok, true);
  }
  const [match] = (await step(world, read, { community_id: C, person: 'ana', now: START + 2000 })).matches;
  assert.equal(match.status, 'proposed');
  const refused = await step(world, answer, { community_id: C, person: 'ana', kind: 'answer', match_id: match.match_id, yes: true, consent: match.consent, now: START + 3000 });
  assert.deepEqual([refused.outcome.ok, refused.outcome.status], [false, 403], 'a yes without the person stamp is refused');
  for (const person of ['ana', 'ben']) {
    const shown = (await step(world, read, { community_id: C, person, now: START + 3000 })).matches[0];
    await step(world, answer, { community_id: C, person, kind: 'answer', match_id: match.match_id, yes: true, pressed_by: 'person', consent: shown.consent, now: START + 4000 });
  }
  const after = (await step(world, read, { community_id: C, person: 'ben', now: START + 5000 })).matches[0];
  assert.equal(after.status, 'waiting_for_ais');
  assert.ok(after.space_id?.startsWith('group:introduction:'));
  assert.equal(kept(world, 'group:introduction:').length, 1);
  assert.deepEqual(kept(world, ids.jobPrefix(C)).map(record => record.value.request_key.split(':')[0]).sort(), ['match-consent', 'match-consent', 'match-profile', 'match-score', 'match-score', 'match-topics', 'match-topics']);

  // An AI took Ana's topics job; a run that would hand it again leaves the door's copy as it is.
  const topics = kept(world, ids.jobPrefix(C)).find(record => record.value.for === 'ana' && record.value.request_key.startsWith('match-topics:'));
  topics.value = { ...topics.value, status: 'done', result: 'two topics' };
  await step(world, answer, { community_id: C, person: 'ana', kind: 'answer', match_id: match.match_id, yes: true, pressed_by: 'person', consent: after.consent, now: START + 6000 });
  assert.equal(kept(world, ids.jobPrefix(C)).find(record => record.id === topics.id).value.status, 'done');

  const gone = await step(world, forget, { community_id: C, person: 'ana', now: START + 7000 });
  assert.equal(gone.forgotten, 'ana');
  const held = JSON.stringify(world.records);
  assert.ok(!held.includes('"ana"') && !held.includes('Ana') && !held.includes('ana built'), 'nothing the door holds names her or keeps what she said, not even the score job Ben\'s AI was handed');
  assert.ok(held.includes('ben built'), 'Ben keeps his own');
});

test('the settings check names what is missing, and a community with none answers its own refusal', async () => {
  const ok = await runRow(check, { community: guild([]).get(ids.community(C)) });
  assert.deepEqual(ok.result, { usable: true, problems: [] });
  const none = await runRow(advance, { community_id: 'nobody-here' });
  assert.deepEqual([none.status, none.result.ok, none.result.status], [0, false, 404]);
});
