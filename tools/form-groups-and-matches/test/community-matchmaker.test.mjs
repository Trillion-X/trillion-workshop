// A community pairs its members on its own cadence (read-data/matchmaker.mjs): each round hands every opted-in member's
// own AI a job, only cited scores form a match, both people say yes themselves, and the one-to-one opens only then.
// The original matchmaker's cases, on a made-up guild (test/community-fixtures.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ids } from '../read-data/matchmaker-records.mjs';
import { formGroups, matchingProblems, shortlistsFor } from '../read-data/matchmaker.mjs';
import { at, answersFor, C, consentShown, guild, HOUR, jobOf, jobs, MATCHING, proposedPair, say, saysYes, scoresFrom, START } from './community-fixtures.mjs';

const settingsOf = book => book.get(ids.community(C));
const rename = (book, person, name) => book.put(ids.member(C, person), 'match-member', { ...book.get(ids.member(C, person)), name });
const inGroup = (book, match) => Object.keys(book.get(match.space_id ?? '')?.members ?? {}).sort();
const matchRecord = (book, matchId) => book.get(ids.match(C, matchId));

test('the guild\'s settings are usable, and settings missing what the factors cite are refused', () => {
  const book = guild([]);
  assert.deepEqual(matchingProblems(settingsOf(book)), []);
  const thin = { ...settingsOf(book), matching: { ...MATCHING, questions: ['scope.project', 'scope.season'] } };
  assert.match(matchingProblems(thin).join(' '), /leaves out what the factors cite: need_fit \(need\)/);
  assert.ok(matchingProblems({ title: 'x', owner: 'y', created_at: 'z', matching: { cadence_label: '' } }).length >= 10);
  assert.match(matchingProblems({ ...settingsOf(book), matching: { ...MATCHING, consent: { ...MATCHING.consent, answer_hours: 0 } } }).join(' '), /consent.answer_hours/);
  assert.match(matchingProblems({ ...settingsOf(book), matching: { ...MATCHING, words: { ...MATCHING.words, ended: '' } } }).join(' '), /words leaves out: ended/);
  assert.throws(() => at(guild([], { matching: { posting_cap: 0 } }), START), /posting_cap/);
});

test('a member is paired automatically by default and can turn it off; a community can default to off', () => {
  const book = guild([['ana', 'Ana']]);
  let view = at(book, START).myMatching('ana');
  assert.equal(view.on, true);
  assert.equal(view.cadence_label, 'Each Monday');
  assert.equal(view.next_at, new Date(START - 24 * HOUR).toISOString(), 'a week after the guild began');
  assert.equal(say(book, START, 'ana', 'profile', { on: false }).on, false);
  assert.equal(at(book, START).myMatching('ana').on, false);
  const off = guild([['ben', 'Ben']], { matching: { default_on: false } });
  assert.equal(at(off, START).myMatching('ben').on, false);
  const contact = say(book, START, 'ana', 'profile', { answers: { offer: 'write to me at ana@example.com' } });
  assert.deepEqual([contact.ok, contact.error], [false, MATCHING.words.contact_in_profile]);
  assert.match(say(book, START, 'ana', 'profile', { answers: { 'not.a.question': 'x' } }).error, /not a guild question/);
  assert.match(say(book, START, 'stranger', 'profile', { answers: {} }).error, /Only a guild member/);
});

test('a round hands each member\'s own AI a job: missing answers to fill, or a bounded shortlist to score', () => {
  const book = guild([['ana', 'Ana'], ['ben', 'Ben'], ['cat', 'Cat']]);
  for (const [person, project] of [['ana', 'cabinet'], ['ben', 'chair'], ['cat', 'canoe']]) say(book, START, person, 'profile', { answers: answersFor(project, `made a ${project} last year`), categories: [project] });
  assert.match(say(book, START, 'ana', 'run-round').error, /Only the person who runs/);
  const round = say(book, START, 'keeper', 'run-round');
  assert.deepEqual([round.ok, round.asked_to_score, round.asked_for_profile], [true, 3, 1], 'the keeper, with no answers yet, is asked for them');
  const profileJob = jobOf(book, 'keeper', 'match-profile:');
  assert.equal(profileJob.input.questions.length, MATCHING.questions.length);
  assert.ok(jobs(book).every(job => job.status === 'waiting' && job.from === `community:${C}` && job.said && job.job), 'every job is the guild\'s own work, with its words');
  const anaJob = jobOf(book, 'ana', 'match-score:');
  assert.deepEqual(anaJob.input.candidates.map(candidate => candidate.name).sort(), ['Ben', 'Cat']);
  assert.ok(anaJob.input.candidates.every(candidate => candidate.claims.length && !/"(ben|cat)"/.test(JSON.stringify(candidate))), 'a shortlist carries claims and names, never a person\'s id');
  assert.ok(anaJob.input.candidates.every(candidate => candidate.claims.every(claim => claim.kind !== 'limits')), 'only claims a factor can cite are shown');
  assert.ok(anaJob.input.candidates.length <= MATCHING.shortlist_size);
  assert.deepEqual(anaJob.input.answer_with.arguments.kind, 'scores');
});

test('scores without cited evidence form no match', () => {
  const book = guild([['ana', 'Ana'], ['ben', 'Ben']]);
  for (const person of ['ana', 'ben']) say(book, START, person, 'profile', { answers: answersFor('cabinet', 'built forty drawers') });
  const { round_id: roundId } = say(book, START, 'keeper', 'run-round');
  const uncited = person => scoresFrom(jobOf(book, person, 'match-score:'), () => 0.9).map(row => ({ ...row, factors: { ...row.factors, timing: { score: 0.9, reason: 'Soon.', you: [], them: [] } } }));
  const answer = say(book, START, 'ana', 'scores', { round_id: roundId, scores: uncited('ana') });
  assert.equal(answer.scored[0].grounded, false);
  assert.match(answer.scored[0].why_not.join(' '), /timing/);
  const closed = say(book, START, 'ben', 'scores', { round_id: roundId, scores: uncited('ben') });
  assert.deepEqual([closed.round_closed, closed.matches_formed], [true, 0]);
  assert.deepEqual(at(book, START).myMatching('ana').matches, []);
});

test('cited scores form a pair; they are introduced in a one-to-one, their AIs suggest topics, and they talk', () => {
  const book = guild([['ana', 'Ana'], ['ben', 'Ben'], ['cat', 'Cat']]);
  for (const [person, project] of [['ana', 'cabinet'], ['ben', 'cabinet'], ['cat', 'canoe']]) say(book, START, person, 'profile', { answers: answersFor(project, `built a ${project} twice`) });
  const { round_id: roundId } = say(book, START, 'keeper', 'run-round');
  const high = name => (name === 'Cat' ? 0.4 : 0.9);
  for (const person of ['ana', 'ben']) say(book, START, person, 'scores', { round_id: roundId, scores: scoresFrom(jobOf(book, person, 'match-score:'), high) });
  const closed = say(book, START, 'cat', 'scores', { round_id: roundId, scores: scoresFrom(jobOf(book, 'cat', 'match-score:'), () => 0.5).slice(0, 1) });
  assert.equal(closed.matches_formed, 1);

  const [proposed] = at(book, START).myMatching('ana').matches;
  assert.deepEqual([proposed.status, proposed.says, proposed.space_id], ['proposed', MATCHING.state_words.proposed, null], 'a closed round only proposes');
  assert.deepEqual(jobs(book).filter(job => job.request_key.startsWith('match-consent:')).map(job => job.for).sort(), ['ana', 'ben'], 'each person is asked, through their own AI');
  const consentJob = jobOf(book, 'ana', 'match-consent:');
  assert.deepEqual(consentJob.input.show_with, { screen: `/guild/${C}` }, 'the AI shows the person the match on their own screen');
  assert.equal(consentJob.input.no_with.arguments.yes, false, 'and may only say no for them');
  assert.deepEqual(jobs(book).filter(job => job.request_key.startsWith('match-topics:')), [], 'no AI is asked about topics before both say yes');
  for (const person of ['ana', 'ben']) saysYes(book, START, proposed.match_id, person);
  const [match] = at(book, START).myMatching('ana').matches;
  assert.equal(match.with.name, 'Ben');
  assert.deepEqual([match.status, match.says], ['waiting_for_ais', MATCHING.state_words.waiting_for_ais]);
  assert.ok(match.why.length === 3 && match.why.every(reason => reason.includes('Ben has done')), 'each reason is the AI\'s own cited rationale');
  assert.deepEqual(at(book, START).myMatching('cat').matches, [], 'Cat is left for a later round');
  assert.deepEqual(inGroup(book, match), ['ana', 'ben'], 'the one-to-one holds both, and only them');

  assert.deepEqual(jobs(book).filter(job => job.request_key.startsWith('match-topics:')).map(job => job.for).sort(), ['ana', 'ben']);
  say(book, START, 'ana', 'topics', { match_id: match.match_id, topics: ['Which joints held last winter', 'Trading clamps'] });
  let mine = at(book, START).myMatching('ben').matches[0];
  assert.deepEqual([mine.status, mine.topics], ['introduced', ['Which joints held last winter', 'Trading clamps']]);
  for (const person of ['ana', 'ben']) say(book, START, person, 'wrote', { match_id: match.match_id });
  mine = at(book, START).myMatching('ben').matches[0];
  assert.deepEqual([mine.status, mine.says], ['talked', MATCHING.state_words.talked]);

  say(book, START + HOUR, 'keeper', 'run-round');
  assert.ok(!jobOf(book, 'ana', `match-score:${at(book, START + HOUR).myMatching('ana').waiting_for_your_scores[0]?.round_id ?? 'none'}`)?.input.candidates.some(candidate => candidate.name === 'Ben'), 'they are never asked about each other again');
});

test('nobody shares a group until both say yes; one yes waits, and the second makes the introduction once', () => {
  const { book, match } = proposedPair();
  assert.deepEqual([match.status, match.says], ['proposed', MATCHING.state_words.proposed]);
  assert.deepEqual(inGroup(book, matchRecord(book, match.match_id)), [], 'no group exists yet');
  assert.match(say(book, START, 'keeper', 'answer', { match_id: match.match_id, yes: true, pressed_by: 'person' }).error, /No match with that id/);
  assert.match(say(book, START, 'ana', 'answer', { match_id: match.match_id }).error, /yes is true/);
  assert.deepEqual(saysYes(book, START, match.match_id, 'ana'), { ok: true, match_id: match.match_id, status: 'one_yes', says: MATCHING.state_words.one_yes });
  assert.equal(saysYes(book, START, match.match_id, 'ana').status, 'one_yes', 'a retried yes changes nothing');
  const ben = at(book, START).myMatching('ben').matches[0];
  assert.deepEqual([ben.status, ben.answered, ben.space_id], ['one_yes', null, null], 'Ben still has to answer, and no group is open to him');
  const made = saysYes(book, START, match.match_id, 'ben');
  assert.deepEqual([made.status, made.space_id], ['waiting_for_ais', matchRecord(book, match.match_id).space_id]);
  assert.deepEqual(inGroup(book, matchRecord(book, match.match_id)), ['ana', 'ben']);
  const topics = () => jobs(book).filter(job => job.request_key.startsWith('match-topics:')).map(job => job.for).sort();
  assert.deepEqual(topics(), ['ana', 'ben']);
  assert.equal(saysYes(book, START, match.match_id, 'ben').status, 'waiting_for_ais', 'a retry after the introduction changes nothing');
  assert.deepEqual(topics(), ['ana', 'ben'], 'and asks no AI twice');
});

test('a yes without the person\'s own press is refused with their screen as the next call; their AI may say no', () => {
  const { book, match } = proposedPair();
  const refused = say(book, START, 'ana', 'answer', { match_id: match.match_id, yes: true, consent: consentShown(book, START, match.match_id, 'ana') });
  assert.deepEqual([refused.ok, refused.status, refused.error, refused.next_call], [false, 403, MATCHING.words.yes_on_page, { screen: `/guild/${C}` }]);
  assert.equal(at(book, START).myMatching('ana').matches[0].status, 'proposed', 'nothing moved');
  assert.equal(saysYes(book, START, match.match_id, 'ana').status, 'one_yes');
  assert.equal(say(book, START, 'ben', 'answer', { match_id: match.match_id, yes: false }).status, 'passed', 'Ben\'s AI says no for him');
});

test('a yes for an introduction that changed since it was shown is refused naming what changed, and an earlier yes is asked again', () => {
  const { book, match } = proposedPair();
  const anaSaw = consentShown(book, START, match.match_id, 'ana');
  const blank = say(book, START, 'ana', 'answer', { match_id: match.match_id, yes: true, pressed_by: 'person' });
  assert.deepEqual([blank.status, blank.changed.length], [409, 4], 'a yes with no consent is for nothing shown');
  rename(book, 'ben', 'Benjamin');
  const stale = say(book, START, 'ana', 'answer', { match_id: match.match_id, yes: true, pressed_by: 'person', consent: anaSaw });
  assert.deepEqual([stale.status, stale.error, stale.changed], [409, MATCHING.words.changed, ['recipients']], 'the person she would meet is named differently now');
  assert.equal(stale.consent, consentShown(book, START, match.match_id, 'ana'));
  assert.equal(at(book, START).myMatching('ana').matches[0].status, 'proposed', 'nothing moved');
  assert.equal(saysYes(book, START, match.match_id, 'ana').status, 'one_yes', 'her yes for what she sees now counts');

  rename(book, 'ana', 'Anabel');
  const asked = () => jobs(book).filter(job => job.for === 'ana' && job.request_key.startsWith(`match-consent:${match.match_id}:ana:`)).length;
  assert.equal(asked(), 1);
  assert.equal(saysYes(book, START, match.match_id, 'ben').status, 'one_yes');
  const ana = at(book, START).myMatching('ana').matches[0];
  assert.deepEqual([ana.status, ana.answered, ana.space_id], ['one_yes', null, null], 'her yes no longer holds and Meet shows again');
  assert.equal(asked(), 2, 'her AI is asked to put the changed introduction to her');
  assert.deepEqual(inGroup(book, matchRecord(book, match.match_id)), []);
  const made = saysYes(book, START, match.match_id, 'ana');
  assert.equal(made.status, 'waiting_for_ais', 'both said yes to the introduction as it is now');
  assert.deepEqual(inGroup(book, matchRecord(book, match.match_id)), ['ana', 'ben']);
});

test('a no ends the introduction for both before any group exists; a pass after it leaves the one-to-one', () => {
  const { book, match } = proposedPair();
  saysYes(book, START, match.match_id, 'ana');
  assert.deepEqual(say(book, START, 'ben', 'answer', { match_id: match.match_id, yes: false }), { ok: true, match_id: match.match_id, status: 'passed', says: MATCHING.state_words.passed });
  const ana = at(book, START).myMatching('ana').matches[0];
  assert.deepEqual([ana.status, ana.space_id], ['passed', null], 'Ana\'s yes never opens a group after Ben said no');
  const late = saysYes(book, START, match.match_id, 'ben');
  assert.deepEqual([late.status, late.error], [409, MATCHING.words.ended], 'a no cannot be turned into a yes');
  assert.equal(say(book, START, 'ben', 'answer', { match_id: match.match_id, yes: false }).status, 'passed', 'the same no again changes nothing');

  const second = proposedPair();
  for (const person of ['ana', 'ben']) saysYes(second.book, START, second.match.match_id, person);
  const record = matchRecord(second.book, second.match.match_id);
  assert.deepEqual(inGroup(second.book, record), ['ana', 'ben']);
  say(second.book, START, 'ana', 'answer', { match_id: second.match.match_id, yes: false });
  const after = at(second.book, START).myMatching('ana').matches[0];
  assert.deepEqual([after.status, after.says, after.space_id], ['passed', MATCHING.state_words.passed, null]);
  assert.deepEqual(inGroup(second.book, record), ['ben'], 'Ana left the one-to-one');
});

test('an introduction nobody finishes answering expires at its time, takes no answer after, and is not proposed again', () => {
  const { book, match } = proposedPair({ matching: { consent: { ...MATCHING.consent, answer_hours: 24 } } });
  const answerBy = Date.parse(match.answer_by);
  assert.equal(answerBy, START + 24 * HOUR, 'the guild\'s own answer time');
  saysYes(book, START, match.match_id, 'ana');
  assert.equal(at(book, answerBy - 1000).myMatching('ben').matches[0].status, 'one_yes');
  const shown = at(book, answerBy).myMatching('ben').matches[0];
  assert.deepEqual([shown.status, shown.says, shown.space_id], ['expired', MATCHING.state_words.expired, null]);
  const late = say(book, answerBy, 'ben', 'answer', { match_id: match.match_id, yes: true, pressed_by: 'person', consent: shown.consent });
  assert.deepEqual([late.status, late.error], [409, MATCHING.words.ended]);
  assert.equal(say(book, answerBy, 'ben', 'answer', { match_id: match.match_id, yes: false }).status, 'expired', 'a late no changes nothing');
  assert.equal(book.get(ids.answer(C, match.match_id, 'ben')), null);
  const next = say(book, answerBy, 'keeper', 'run-round');
  assert.ok(!jobOf(book, 'ana', `match-score:${next.round_id}`)?.input.candidates.some(candidate => candidate.name === 'Ben'), 'an expired introduction is not proposed again');
});

test('a person whose matching was turned off before the round closed is not proposed', () => {
  const book = guild([['ana', 'Ana'], ['ben', 'Ben']]);
  for (const person of ['ana', 'ben']) say(book, START, person, 'profile', { answers: answersFor('cabinet', 'built forty drawers') });
  const { round_id: roundId } = say(book, START, 'keeper', 'run-round');
  say(book, START, 'ana', 'scores', { round_id: roundId, scores: scoresFrom(jobOf(book, 'ana', 'match-score:'), () => 0.8) });
  say(book, START, 'ben', 'profile', { on: false });
  const closed = say(book, START, 'ben', 'scores', { round_id: roundId, scores: scoresFrom(jobOf(book, 'ben', 'match-score:'), () => 0.8) });
  assert.equal(closed.matches_formed, 0, 'turning matching off withdraws the consent to be considered');
  assert.equal(jobs(book).filter(job => job.request_key.startsWith('match-consent:')).length, 0);
});

test('the clock starts a round when due and pairs whoever answered once its time is up', () => {
  const book = guild([['ana', 'Ana'], ['ben', 'Ben']], { createdAt: START - 7 * 24 * HOUR });
  for (const person of ['ana', 'ben']) say(book, START - HOUR, person, 'profile', { answers: answersFor('cabinet', 'built forty drawers') });
  assert.deepEqual(at(book, START - HOUR).tick().round, null, 'nothing is due before the cadence');
  const started = at(book, START).tick();
  assert.equal(started.round.started.asked_to_score, 2);
  const roundId = started.round.started.round_id;
  assert.equal(started.next_at, new Date(START + MATCHING.round_hours * HOUR).toISOString(), 'the clock next wakes at the deadline');
  assert.equal(say(book, START, 'ana', 'scores', { round_id: roundId, scores: scoresFrom(jobOf(book, 'ana', 'match-score:'), () => 0.7) }).waiting_for, 1);
  assert.equal(at(book, START).myMatching('ben').waiting_for_your_scores.length, 1, 'Ben\'s AI can read the job it still owes');
  // The pull road: Ben's own waiting jobs come with his view, and the time to wake and pull again is the round's deadline.
  const pulled = at(book, START).myMatching('ben');
  assert.deepEqual(pulled.waiting_jobs.map(job => job.request_key), [`match-score:${roundId}:ben`]);
  assert.equal(pulled.waiting_jobs[0].input.round_id, roundId);
  assert.equal(pulled.wake_at, new Date(START + MATCHING.round_hours * HOUR).toISOString());
  assert.ok(!JSON.stringify(pulled.waiting_jobs).includes('"for"'), 'only his own jobs, without anyone else\'s');
  const closed = at(book, START + 49 * HOUR).tick();
  assert.deepEqual([closed.round.closed, closed.round.formed], [roundId, 1]);
  assert.equal(at(book, START + 49 * HOUR).myMatching('ben').matches[0].with.name, 'Ana');
  assert.match(say(book, START + 49 * HOUR, 'ben', 'scores', { round_id: roundId, scores: [] }).error, /closed or was not asked/);
});

test('two last yeses given at once each see only their own; the clock makes the introduction', () => {
  const { book, match } = proposedPair();
  const [anaConsent, benConsent] = ['ana', 'ben'].map(person => consentShown(book, START, match.match_id, person));
  // Each answer writes only its own record; put both as two runs at once would leave them.
  for (const [person, consent] of [['ana', anaConsent], ['ben', benConsent]]) {
    book.put(ids.answer(C, match.match_id, person), 'match-answer', { person, yes: true, by_person: true, consent, at: new Date(START).toISOString(), topics: [], wrote: false });
  }
  assert.equal(matchRecord(book, match.match_id).introduced_at, null);
  at(book, START + 1000).tick();
  assert.equal(matchRecord(book, match.match_id).introduced_at, new Date(START + 1000).toISOString());
  assert.deepEqual(inGroup(book, matchRecord(book, match.match_id)), ['ana', 'ben']);
});

test('discover lists fellow members sharing a category, with what they offer and seek', () => {
  const book = guild([['ana', 'Ana'], ['ben', 'Ben'], ['cat', 'Cat']]);
  say(book, START, 'ana', 'profile', { categories: ['Cabinets', 'chairs'] });
  say(book, START, 'ben', 'profile', { answers: { offer: 'hand-cut dovetails' }, categories: ['cabinets'] });
  say(book, START, 'cat', 'profile', { categories: ['canoes'] });
  const [row, ...rest] = at(book, START).myMatching('ana').discover;
  assert.equal(rest.length, 0);
  assert.deepEqual([row.name, row.shared, row.offers], ['Ben', ['cabinets'], ['hand-cut dovetails']]);
});

test('equal scores at the boundary pick nobody instead of guessing; a switch off is never selected', () => {
  const answers = answersFor('cabinet', 'built forty drawers');
  const ask = { round_id: 'r', person: 'ana', answers, candidates: [{ candidate_ref: 'c1', person: 'ben', answers }, { candidate_ref: 'c2', person: 'cat', answers }] };
  const kinds = { 'scope.project': ['scope.project'], 'scope.season': ['scope.season'], need: ['need'], offer: ['offer', 'proof'], hours: ['hours'], limits: ['limits'] };
  const cite = prefix => Object.keys(answers).flatMap(id => kinds[id].map(kind => `${prefix}/${id}#${kind}`));
  const row = ref => ({ candidate_ref: ref, factors: Object.fromEntries(MATCHING.contract.factors.map(factor => [factor, { score: 0.6, reason: 'Fits.', you: cite('you'), them: cite(ref) }])) });
  const consents = { ana: 'on', ben: 'on', cat: 'on' };
  const tied = formGroups({ asks: [{ ...ask, scores: [row('c1'), row('c2')] }], matching: MATCHING, consents });
  assert.equal(tied.groups.length, 0);
  assert.ok(tied.unmatched_details.some(detail => detail.reason === 'indistinguishable_expected_value'));
  assert.deepEqual(formGroups({ asks: [{ ...ask, scores: [row('c1')] }], matching: MATCHING, consents }).groups.map(group => group.members), [['ana', 'ben']]);
  assert.deepEqual(formGroups({ asks: [{ ...ask, scores: [row('c1')] }], matching: MATCHING, consents: { ...consents, ben: 'off' } }).groups, [], 'a person whose matching is off is never selected');
});

const wordingTest = {
  id: 'introduction-words',
  arms: ['plain', 'warm', 'short'].map(id => ({ id, weight: 1, jobs: { topics: { job: `${id}: suggest what {name} and {other} could talk about in {community}, because {why}.` } } })),
};

test('a community runs its introductions as a many-armed experiment: arms word the jobs and the keeper reads what each led to', () => {
  const matching = { experiments: [wordingTest] };
  const book = guild([], { matching });
  assert.deepEqual(matchingProblems(settingsOf(book)), []);
  assert.match(matchingProblems({ ...settingsOf(book), matching: { ...MATCHING, experiments: [{ id: 'one', arms: [wordingTest.arms[0]] }] } }).join(' '), /two or more arms/);
  assert.match(matchingProblems({ ...settingsOf(book), matching: { ...MATCHING, experiments: [{ id: 'x', arms: [{ id: 'a', weight: 1, jobs: { nothing: { job: 'x' } } }, { id: 'b', weight: 1 }] }] } }).join(' '), /job the round does not hand/);

  const { book: paired, match } = proposedPair({ matching });
  assert.equal(at(paired, START).myMatching('keeper').experiments[0].arms.reduce((sum, arm) => sum + arm.introduced, 0), 0, 'a proposal nobody said yes to introduced nobody');
  for (const person of ['ana', 'ben']) saysYes(paired, START, match.match_id, person);
  const topicJobs = jobs(paired).filter(job => job.request_key.startsWith('match-topics:'));
  assert.equal(topicJobs.length, 2);
  for (const job of topicJobs) assert.match(job.job, /^(plain|warm|short): suggest what (Ana|Ben) and (Ana|Ben) could talk about in Oak Guild/, 'each person\'s job is worded by their arm');
  let results = at(paired, START).myMatching('keeper').experiments[0];
  assert.deepEqual([results.experiment_id, results.arms.length, results.arms.reduce((sum, arm) => sum + arm.introduced, 0), results.arms.reduce((sum, arm) => sum + arm.talked, 0)], ['introduction-words', 3, 2, 0]);
  assert.equal(at(paired, START).myMatching('ana').experiments, undefined, 'only the keeper reads the results');
  for (const person of ['ana', 'ben']) say(paired, START, person, 'wrote', { match_id: match.match_id });
  results = at(paired, START).myMatching('keeper').experiments[0];
  assert.equal(results.arms.reduce((sum, arm) => sum + arm.talked, 0), 2, 'a match whose people talked counts for both arms');
  assert.equal(results.events.filter(event => event.event === 'converted').length, 2, 'and gives the experiment owner its converted events');
});

test('after a person is forgotten no match, ask, answer, job or shortlist names them or keeps what they said', () => {
  const book = guild([['ana', 'Ana'], ['ben', 'Ben'], ['cat', 'Cat']]);
  for (const [person, offer] of [['ana', 'ana-secret-offer'], ['ben', 'built forty drawers'], ['cat', 'built thirty drawers']]) say(book, START, person, 'profile', { answers: answersFor('cabinet', offer) });
  const { round_id: roundId } = say(book, START, 'keeper', 'run-round');
  for (const person of ['ana', 'ben', 'cat']) say(book, START, person, 'scores', { round_id: roundId, scores: scoresFrom(jobOf(book, person, 'match-score:'), name => (name === 'Cat' || person === 'cat' ? 0.3 : 0.9)) });
  assert.ok(book.list(ids.matchPrefix(C)).some(record => record.value.members.includes('ana')), 'ana was matched');
  say(book, START + HOUR, 'keeper', 'run-round');
  at(book, START + HOUR).forget('ana');
  const left = book.list('').filter(record => record.id !== ids.community(C)).map(record => JSON.stringify(record));
  assert.deepEqual(left.filter(row => row.includes('"ana"') || row.includes('ana-secret-offer') || row.includes(':ana')), [], 'nothing names ana or holds what she said');
  assert.ok(book.list(ids.allAsksPrefix(C)).some(record => record.value.person === 'cat'), 'the others keep their own asks');
});

test('an introduction nobody acted on is followed up a bounded number of times, and never after the two talk', () => {
  const book = guild([['ana', 'Ana'], ['ben', 'Ben'], ['cat', 'Cat'], ['dan', 'Dan']]);
  for (const person of ['ana', 'ben', 'cat', 'dan']) say(book, START, person, 'profile', { answers: answersFor('cabinet', `${person} built forty drawers`) });
  const { round_id: roundId } = say(book, START, 'keeper', 'run-round');
  const pairs = { ana: 'Ben', ben: 'Ana', cat: 'Dan', dan: 'Cat' };
  for (const person of ['ana', 'ben', 'cat', 'dan']) say(book, START, person, 'scores', { round_id: roundId, scores: scoresFrom(jobOf(book, person, 'match-score:'), name => (name === pairs[person] ? 0.9 : 0.2)) });
  const matchOf = person => at(book, START).myMatching(person).matches[0];
  const [anaBen, catDan] = [matchOf('ana'), matchOf('cat')];
  assert.ok(anaBen && catDan && anaBen.match_id !== catDan.match_id);
  const hours = MATCHING.follow_up_hours;
  assert.equal(at(book, START).nextAt(), at(book, START).myMatching('ana').next_at, 'a proposal nobody said yes to is not followed up');
  for (const [match, people] of [[anaBen, ['ana', 'ben']], [catDan, ['cat', 'dan']]]) for (const person of people) saysYes(book, START, match.match_id, person);
  assert.equal(at(book, START).nextAt(), new Date(START + hours[0] * HOUR).toISOString(), 'the clock wakes for the first follow-up');
  const followUps = () => jobs(book).filter(job => job.request_key.startsWith('match-follow:'));
  at(book, START + hours[0] * HOUR + 1000).tick();
  assert.deepEqual(followUps().map(job => job.for).sort(), ['ana', 'ben', 'cat', 'dan']);
  const anaJob = followUps().find(job => job.for === 'ana');
  assert.match(anaJob.job, /Ana met Ben 2 days ago/);
  assert.equal(anaJob.input.space_id, matchRecord(book, anaBen.match_id).space_id);
  at(book, START + hours[0] * HOUR + 2000).tick();
  assert.equal(followUps().length, 4, 'one job per person per step');
  for (const person of ['ana', 'ben']) say(book, START + hours[0] * HOUR + 3000, person, 'wrote', { match_id: anaBen.match_id });
  say(book, START + hours[0] * HOUR + 3000, 'cat', 'answer', { match_id: catDan.match_id, yes: false });
  for (const step of hours.slice(1)) at(book, START + step * HOUR + 1000).tick();
  assert.equal(followUps().length, 4, 'neither match is followed up again');
});

test('follow-ups stop after the last step even when nobody acts', () => {
  const { book, match } = proposedPair();
  for (const person of ['ana', 'ben']) saysYes(book, START, match.match_id, person);
  const hours = MATCHING.follow_up_hours;
  for (const step of [...hours, hours.at(-1) * 2]) at(book, START + step * HOUR + 1000).tick();
  assert.equal(jobs(book).filter(job => job.request_key.startsWith('match-follow:')).length, hours.length * 2, 'each step once for each of the two, then no more');
});

test('the work is bounded: shortlists cost members x tokens x posting_cap comparisons at most, growing with members, never with pairs', () => {
  const guildOf = size => Array.from({ length: size }, (_, index) => ({ person: `p${index}`, categories: [`craft${index % 7}`], answers: answersFor(`project${index % 13}`, `made ${index % 11} chairs`) }));
  const postingCap = 20;
  const tokensOf = person => 1 + new Set(Object.values(person.answers).flat().join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 3)).size;
  const cost = size => {
    const people = guildOf(size);
    const { shortlists, comparisons } = shortlistsFor(people, { size: MATCHING.shortlist_size, postingCap, seen: new Set() });
    assert.ok(comparisons <= people.length * (Math.max(...people.map(tokensOf)) * postingCap + postingCap), `${comparisons} comparisons for ${size}`);
    assert.ok(shortlists.every((list, index) => list.length === MATCHING.shortlist_size && !list.some(other => other.person === people[index].person)));
    return comparisons;
  };
  const [small, big] = [cost(1000), cost(4000)];
  assert.ok(big <= small * 4.1, `four times the members cost ${big / small} times the work, not sixteen`);
  assert.ok(big < (4000 * 3999) / 2 / 5, 'a fifth of every pair at most, and the share falls as the guild grows');
});
