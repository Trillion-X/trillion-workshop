// A made-up woodworkers' guild for the community matchmaker tests: its own three factors, two scope fields, six
// questions and every word it says. None of these names is in the code; the tests that use them prove it.
import { ids, KINDS, makeBook } from '../read-data/matchmaker-records.mjs';
import { openCommunity } from '../read-data/matchmaker.mjs';

export const C = 'guild';
export const HOUR = 3600000;
export const START = Date.parse('2031-03-03T09:00:00.000Z');

export const CONTRACT = {
  factors: ['need_fit', 'timing', 'can_do'],
  primitives: ['goal', 'ability', 'time'],
  scope_fields: ['project_ref', 'season_ref'],
  questions: [
    { question_id: 'scope.project', wording: 'Which project is this for?', claim_kinds: ['scope.project'], primitive_ids: ['goal'], scope_field: 'project_ref' },
    { question_id: 'scope.season', wording: 'Which season are you working in?', claim_kinds: ['scope.season'], primitive_ids: ['time'], scope_field: 'season_ref' },
    { question_id: 'need', wording: 'What is stuck?', claim_kinds: ['need'], primitive_ids: ['goal'] },
    { question_id: 'offer', wording: 'What have you made that shows what you can do?', claim_kinds: ['offer', 'proof'], primitive_ids: ['ability'] },
    { question_id: 'hours', wording: 'How many hours a week can you give?', claim_kinds: ['hours'], primitive_ids: ['time'] },
    { question_id: 'limits', wording: 'What must nobody do for you?', claim_kinds: ['limits'], primitive_ids: ['goal'] },
  ],
  citation_requirements: {
    need_fit: [{ side: 'subject', any_of: ['need'] }, { side: 'candidate', any_of: ['offer'] }],
    timing: [{ side: 'subject', any_of: ['scope.season'] }, { side: 'candidate', any_of: ['hours'] }],
    can_do: [{ side: 'candidate', any_of: ['proof'] }],
  },
  authority: [{ name: 'forbidden', claim_kind: 'limits', list: true }],
  forbidden_interventions: 'forbidden',
};

export const MATCHING = {
  every_days: 7, round_hours: 48, shortlist_size: 4, posting_cap: 50, group_size: 2, cadence_label: 'Each Monday', default_on: true,
  contract: CONTRACT, questions: CONTRACT.questions.map(question => question.question_id),
  initiative: { required_level: 'introduce', pre_authorized_levels: ['introduce'] },
  grouping: { modes: [{ type: 'pair', min_size: 2, max_size: 2 }] },
  consent: { answer_hours: 72, selection: { approved_values: ['on'], veto_values: ['off'] }, yes_needs: { field: 'origin', equals: 'page' }, screen: '/guild/{community_id}' },
  follow_up_hours: [48, 120, 240],
  jobs: {
    profile: { said: 'Tell {community} about {name}', job: 'Answer the questions of {community} ({community_id}) for {name}.' },
    score: { said: 'Score who {name} should meet', job: 'Score the shortlist of round {round_id} in {community}.' },
    consent: { said: 'Would {name} like to meet {other}?', job: 'Put the introduction to {other} to {name} before {answer_by}, because: {why}' },
    topics: { said: 'What could {name} and {other} talk about?', job: 'Suggest first topics for {name} and {other} in {space_id}.' },
    follow_up: { said: 'Help {name} meet {other}', job: '{name} met {other} {days} days ago in {space_id} and has not written yet.' },
  },
  words: {
    not_a_member: 'Only a guild member can do that.', owner_only: 'Only the person who runs the guild starts a round.', no_round: 'That round is closed or was not asked of you.',
    no_match: 'No match with that id is yours.', not_a_question: '"{question}" is not a guild question; it asks: {questions}.', contact_in_profile: 'An answer cannot hold an email address or phone number.',
    scores_shape: 'scores is a list of { candidate_ref, factors: { {factors} } }.', yes_or_no: 'yes is true to meet, or false for not this time.', ended: 'This introduction has ended.',
    yes_on_page: 'Only your person can say yes, on their own screen.', changed: 'This introduction changed since it was shown.', topics_shape: 'topics is a list of one to {most} short lines.',
    not_introduced: 'This match has no one-to-one yet.', unknown_answer: 'An answer is one of: {kinds}, from a person.',
  },
  state_words: {
    proposed: 'Proposed.', one_yes: 'Waiting for everyone.', waiting_for_ais: 'Introduced; topics coming.', introduced: 'Introduced with topics.',
    talked: 'You both wrote.', passed: 'Passed.', expired: 'Ended unanswered.',
  },
  contact_pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.]+|\\+?\\d[\\d ()-]{7,}\\d',
  limits: { answer_chars: 600, list_items: 10, list_item_chars: 200, categories: 8, category_chars: 40, topics_per_call: 6, topics_kept: 12, reason_chars: 400, follow_up_page: 100, discover_page: 500 },
  discover: { offers: ['offer'], seeks: ['need'] },
};

export const answersFor = (project, offer) => ({
  'scope.project': project, 'scope.season': 'this spring', need: `finish the ${project} joints`, offer, hours: 'three hours a week', limits: ['no glue-ups for me'],
});

/** A guild book: the settings and each [id, name] as a member; the owner is `keeper`, a member with no answers. */
export function guild(people, { matching = {}, createdAt = START - 8 * 24 * HOUR } = {}) {
  const records = [{ id: ids.community(C), type: KINDS.community, value: { title: 'Oak Guild', owner: 'keeper', created_at: new Date(createdAt).toISOString(), matching: { ...MATCHING, ...matching } } }];
  for (const [person, name] of [['keeper', 'Keeper'], ...people]) records.push({ id: ids.member(C, person), type: KINDS.member, value: { person, name, state: 'member', answers: {}, categories: [] } });
  return makeBook(records);
}

/** The matchmaker over the book at `now`. */
export const at = (book, now) => openCommunity({ communityId: C, book, now });
/** One answer from `person` at `now`; `task` is the run's task as the engine wrote it. */
export const say = (book, now, person, kind, extra = {}, task = {}) => at(book, now).apply({ person, kind, ...extra }, task);
/** The task of a run the person started on their own page: the engine's stamp (tool-runs.json page_origin). */
export const PAGE = Object.freeze({ origin: 'page' });
export const jobs = book => book.list(ids.jobPrefix(C)).map(record => record.value);
export const jobOf = (book, person, start) => jobs(book).find(job => job.for === person && job.request_key.startsWith(start));

/** Scores one AI gives from the job it was handed: every factor cites every claim of both sides. */
export const scoresFrom = (job, value) => job.input.candidates.map(candidate => ({
  candidate_ref: candidate.candidate_ref,
  factors: Object.fromEntries(job.input.factors.map(factor => [factor, { score: value(candidate.name), reason: `${candidate.name} has done what you need for ${factor}.`, you: job.input.you.claims.map(claim => claim.claim_ref), them: candidate.claims.map(claim => claim.claim_ref) }])),
}));

/** The consent a person is shown for a match now, from their own view. */
export const consentShown = (book, now, matchId, person) => at(book, now).myMatching(person).matches.find(match => match.match_id === matchId).consent;
/** A person's own yes, pressed on their own screen, for the introduction as it shows it to them. */
export const saysYes = (book, now, matchId, person) => say(book, now, person, 'answer', { match_id: matchId, yes: true, consent: consentShown(book, now, matchId, person) }, PAGE);

/** Ana and Ben with answers, a round, and both AIs' scores in: one proposed match. */
export function proposedPair({ matching } = {}) {
  const book = guild([['ana', 'Ana'], ['ben', 'Ben']], { matching });
  for (const person of ['ana', 'ben']) say(book, START, person, 'profile', { answers: answersFor('cabinet', 'built forty dovetailed drawers') });
  const { round_id: roundId } = say(book, START, 'keeper', 'run-round');
  for (const person of ['ana', 'ben']) say(book, START, person, 'scores', { round_id: roundId, scores: scoresFrom(jobOf(book, person, 'match-score:'), () => 0.8) });
  const [match] = at(book, START).myMatching('ana').matches;
  return { book, roundId, match };
}
