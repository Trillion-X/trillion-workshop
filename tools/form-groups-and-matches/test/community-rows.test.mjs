// The community matchmaker rows run as the container runs them, against the stand-in records door with exactly each
// row's rights: a round handed out, scores in, both yeses, the one-to-one made, and a job the door already holds
// never handed again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowOf, runRow } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import { ids } from '../read-data/matchmaker-records.mjs';
import { answersFor, C, guild, PAGE, START } from './community-fixtures.mjs';

const advance = rowOf(rows, 'tool:advance-a-community-matchmaker');
const answer = rowOf(rows, 'tool:answer-in-a-community');
const read = rowOf(rows, 'tool:read-my-community-matches');
const forget = rowOf(rows, 'tool:forget-a-person-in-a-community');
const check = rowOf(rows, 'tool:check-community-matching-settings');
// The answer row's standard input, as its stdin template fills it: the caller's input and the run's own task.
const asked = (input, task = {}) => ({ input, task });

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
  for (const person of ['ana', 'ben']) await step(world, answer, asked({ community_id: C, person, kind: 'profile', answers: answersFor('cabinet', `${person} built forty drawers`), now: START - 1000 }));
  const ticked = await step(world, advance, { community_id: C, now: START });
  assert.equal(ticked.round.started.asked_to_score, 2);
  const roundId = ticked.round.started.round_id;
  for (const person of ['ana', 'ben']) {
    const result = await step(world, answer, asked({ community_id: C, person, kind: 'scores', round_id: roundId, scores: scoresFrom(jobFor(world, person, 'match-score:')), now: START + 1000 }));
    assert.equal(result.outcome.ok, true);
  }
  const [match] = (await step(world, read, { community_id: C, person: 'ana', now: START + 2000 })).matches;
  assert.equal(match.status, 'proposed');
  const refused = await step(world, answer, asked({ community_id: C, person: 'ana', kind: 'answer', match_id: match.match_id, yes: true, consent: match.consent, now: START + 3000 }));
  assert.deepEqual([refused.outcome.ok, refused.outcome.status], [false, 403], 'a yes from a run no page started is refused');
  const claimed = await step(world, answer, asked({ community_id: C, person: 'ana', kind: 'answer', match_id: match.match_id, yes: true, consent: match.consent, origin: 'page', now: START + 3000 }));
  assert.equal(claimed.outcome.status, 403, 'an input naming the page is not the engine\'s stamp');
  for (const person of ['ana', 'ben']) {
    const shown = (await step(world, read, { community_id: C, person, now: START + 3000 })).matches[0];
    await step(world, answer, asked({ community_id: C, person, kind: 'answer', match_id: match.match_id, yes: true, consent: shown.consent, now: START + 4000 }, PAGE));
  }
  const after = (await step(world, read, { community_id: C, person: 'ben', now: START + 5000 })).matches[0];
  assert.equal(after.status, 'waiting_for_ais');
  assert.ok(after.space_id?.startsWith('group:introduction:'));
  assert.equal(kept(world, 'group:introduction:').length, 1);
  assert.deepEqual(kept(world, ids.jobPrefix(C)).map(record => record.value.request_key.split(':')[0]).sort(), ['match-consent', 'match-consent', 'match-profile', 'match-score', 'match-score', 'match-topics', 'match-topics']);

  // An AI took Ana's topics job; a run that would hand it again leaves the door's copy as it is.
  const topics = kept(world, ids.jobPrefix(C)).find(record => record.value.for === 'ana' && record.value.request_key.startsWith('match-topics:'));
  topics.value = { ...topics.value, status: 'done', result: 'two topics' };
  await step(world, answer, asked({ community_id: C, person: 'ana', kind: 'answer', match_id: match.match_id, yes: true, consent: after.consent, now: START + 6000 }, PAGE));
  assert.equal(kept(world, ids.jobPrefix(C)).find(record => record.id === topics.id).value.status, 'done');

  const gone = await step(world, forget, { community_id: C, person: 'ana', now: START + 7000 });
  assert.equal(gone.forgotten, 'ana');
  const held = JSON.stringify(world.records);
  assert.ok(!held.includes('"ana"') && !held.includes('Ana') && !held.includes('ana built'), 'nothing the door holds names her or keeps what she said, not even the score job Ben\'s AI was handed');
  assert.ok(held.includes('ben built'), 'Ben keeps his own');
});

// Through the community's grant the engine sets grant_person to the calling member (identity self): they answer and
// read only as themselves. The holder's own runs carry none.
test('a member calling through the grant answers and reads only as themselves', async () => {
  const book = guild([['ana', 'Ana'], ['ben', 'Ben']]);
  const world = { records: book.list('') };
  const posing = await runRow(answer, asked({ community_id: C, person: 'ben', grant_person: 'ana', kind: 'profile', on: false }), { records: world.records });
  assert.deepEqual([posing.status, posing.result.ok, posing.result.status], [0, false, 403]);
  assert.equal(posing.kept.find(record => record.id === ids.member(C, 'ben')).value.on, undefined, 'Ben\'s switch is untouched');
  const peeking = await runRow(read, { community_id: C, person: 'ben', grant_person: 'ana' }, { records: world.records });
  assert.deepEqual([peeking.result.ok, peeking.result.status, peeking.result.matches], [false, 403, undefined]);
  const own = await step(world, answer, asked({ community_id: C, person: 'ana', grant_person: 'ana', kind: 'profile', on: false, now: START }));
  assert.deepEqual([own.outcome.ok, own.outcome.on], [true, false]);
  assert.ok(!JSON.stringify(world.records).includes('grant_person'), 'the grant\'s person is never kept as an answer');
});

test('the settings check names what is missing, and a community with none answers its own refusal', async () => {
  const ok = await runRow(check, { community: guild([]).get(ids.community(C)) });
  assert.deepEqual(ok.result, { usable: true, problems: [] });
  const none = await runRow(advance, { community_id: 'nobody-here' });
  assert.deepEqual([none.status, none.result.ok, none.result.status], [0, false, 404]);
});
