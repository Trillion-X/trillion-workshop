// tools/form-groups-and-matches/read-data/matchmaker.mjs
//
// A community's matchmaker: on the community's cadence it pairs its members, and nobody has to ask. Pure: it works on a
// book of the community's records (read-data/matchmaker-records.mjs) at one engine time and keeps every change in that
// book. The door seam is do-work/community-matchmaker.mjs.
//
// One round:
//   1. Each opted-in member whose profile is not complete gets a job for their own AI: answer the community's questions.
//   2. Each complete member gets a bounded shortlist of other members (an inverted index over their categories and
//      words, never every pair) and a job for their own AI: score each candidate on the contract's factors, citing
//      the claims each score rests on. Nothing here runs a model; scores come back as that member's answer.
//   3. When every asked AI answered, or at the round's deadline, the grounded scores form groups through the matching
//      leaves beside this file: match-evidence checks the citations, expected-value takes the exact product,
//      select-groups orders by it and gates the introduction on initiative and each person's switch.
//   4. Each group is proposed. Each person's AI puts it to them; only the person's own yes counts, an AI may say no.
//      Once everyone's yes holds for the introduction as it is shown now, the one-to-one group is made and each AI is
//      asked what to talk about first. A no passes it; a missed answer time expires it. An introduction nobody acted
//      on is followed up at the community's hours until its members talk.
//
// Everything a community chooses is its settings record's `matching` block (matchingProblems says what is missing):
// cadence, sizes, the evidence contract and the questions it asks, initiative, consent hours and words, follow-up
// hours, the words of every job, refusal and state, the contact pattern answers may not hold, the size limits, and
// experiments whose arms word the jobs. Nothing here names a community, a person or a factor.
//
// Non-negotiable invariants
//   1. No match forms without every factor of the contract scored in (0, 1] by a member's own AI and citing the
//      claims the contract requires; a missing or uncited factor is no justified match (the leaves decide).
//   2. Nothing is invented: a reason shown is an AI's cited rationale, a topic is what an AI suggested, a name is the
//      member's own record.
//   3. Work is bounded: each member's AI scores at most shortlist_size people per round, and building every shortlist
//      makes at most members x (tokens x posting_cap + posting_cap) comparisons.
//   4. Introductions are double opt-in. Matching on is only consent to be considered, read when the round closes. A
//      yes counts only while its answer carries the settings' person stamp and the consent of what that person is
//      shown now; a yes for something that changed stops counting and its person is asked again. Nobody shares a
//      group until every member's yes counts.
//   5. A matching answer is read by other members' AIs, so it may not hold the community's contact pattern.
//   6. The same people are never proposed twice in one community.
//   7. A match's state is read from its records (passed, expired, proposed, one_yes, waiting_for_ais, introduced,
//      talked), never stored beside them, so it cannot disagree with them.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { buildMatchProfile, deriveGroundedFactorEvidence, readContract } from './match-evidence.mjs';
import { buildCandidates, readPolicy } from './expected-value.mjs';
import { pairKey, selectGroups } from './select-groups.mjs';
import { addMember, ensureGroup, membersOf, removeMember } from './group-graph.mjs';
import { foldGroupRecords, groupRecordId, groupRecordWrites } from './group-records.mjs';
import { ids, KINDS } from './matchmaker-records.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
export const STATES = Object.freeze(['proposed', 'one_yes', 'waiting_for_ais', 'introduced', 'talked', 'passed', 'expired']);
export const JOBS = Object.freeze(['profile', 'score', 'consent', 'topics', 'follow_up']);
export const WORDS = Object.freeze(['not_a_member', 'owner_only', 'no_round', 'no_match', 'not_a_question', 'contact_in_profile', 'scores_shape', 'yes_or_no', 'ended', 'yes_on_page', 'changed', 'topics_shape', 'not_introduced', 'unknown_answer']);
export const LIMITS = Object.freeze(['answer_chars', 'list_items', 'list_item_chars', 'categories', 'category_chars', 'topics_per_call', 'topics_kept', 'reason_chars', 'follow_up_page', 'discover_page']);
/** The row a job's answer goes back through. */
export const ANSWER_TOOL = 'tool:answer-in-a-community';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const iso = ms => new Date(ms).toISOString();
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
const words = value => [...new Set(String(value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 3))];
const positive = value => Number.isFinite(value) && value > 0;
const whole = value => Number.isInteger(value) && value > 0;
const names = value => Array.isArray(value) && value.length > 0 && value.every(text) && new Set(value).size === value.length;

/** A refusal an answer gets back: the community's own words, an HTTP-like status, and what to do next when there is one. */
export class MatchRefusal extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra); }
}

// JSON with every object's keys in order, so the same value always has the same bytes; their identity is the one
// tools/content-identity gives, without its 1f: prefix.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
const identityOf = value => makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(value))).slice('1f:'.length);

// A yes counts for what its person was shown: the words, the people, what of them the yes shares, and when it ends.
const CONSENT_PARTS = ['text', 'recipients', 'shared', 'expires_at'];
/** The consent of an introduction as shown: one identity per part, joined, so a changed part can be named. */
export const consentOf = shown => CONSENT_PARTS.map(part => identityOf(shown[part] ?? null).slice(0, 32)).join('.');
/** The parts of what is shown now that differ from a consent given earlier; none while it still holds. */
export function changedSince(given, shown) {
  const was = typeof given === 'string' ? given.split('.') : [];
  const now = consentOf(shown).split('.');
  return CONSENT_PARTS.filter((_, index) => was[index] !== now[index]);
}

/** The expected-value policy a community's matches are formed by: the contract's factors and scope, and its own cut. */
export const policyOf = matching => ({ ...(object(matching.expected_value) ? matching.expected_value : {}), factors: matching.contract.factors, scope_fields: matching.contract.scope_fields });

/** Problems with a community's settings record, as plain sentences (empty when it can be used). */
export function matchingProblems(community) {
  const matching = community?.matching;
  if (!object(matching)) return ['matching is the community\'s matching settings: an object.'];
  const problems = [];
  if (!text(community.title)) problems.push('title names the community.');
  if (!text(community.owner)) problems.push('owner is the person who runs the community.');
  if (!Number.isFinite(Date.parse(community.created_at))) problems.push('created_at is when the community began.');
  for (const field of ['every_days', 'round_hours']) if (!positive(matching[field])) problems.push(`matching.${field} is a number above 0.`);
  for (const field of ['shortlist_size', 'posting_cap']) if (!whole(matching[field])) problems.push(`matching.${field} is a whole number above 0.`);
  if (!(Number.isInteger(matching.group_size) && matching.group_size >= 2)) problems.push('matching.group_size is a whole number, 2 or more.');
  if (!text(matching.cadence_label)) problems.push('matching.cadence_label says how often, in words.');
  if (typeof matching.default_on !== 'boolean') problems.push('matching.default_on is true or false.');
  let contract = null;
  try { contract = readContract(matching.contract); } catch (error) { problems.push(`matching.contract: ${error.message}`); }
  if (contract) {
    const byId = new Map(contract.questions.map(question => [question.question_id, question]));
    if (!names(matching.questions)) problems.push('matching.questions lists the contract questions a member\'s AI answers.');
    else {
      const unknown = matching.questions.filter(id => !byId.has(id));
      if (unknown.length) problems.push(`matching.questions has questions the contract does not hold: ${unknown.join(', ')}.`);
      const covered = new Set(matching.questions.flatMap(id => byId.get(id)?.claim_kinds ?? []));
      const missing = Object.entries(contract.citation_requirements).flatMap(([factor, rows]) => rows.filter(row => !row.any_of.some(kind => covered.has(kind))).map(row => `${factor} (${row.any_of.join(' or ')})`));
      if (missing.length) problems.push(`matching.questions leaves out what the factors cite: ${[...new Set(missing)].join('; ')}.`);
    }
    try { readPolicy(policyOf(matching)); } catch (error) { problems.push(`matching.expected_value: ${error.message}`); }
  }
  if (!text(matching.initiative?.required_level) || !Array.isArray(matching.initiative?.pre_authorized_levels)) problems.push('matching.initiative is { required_level, pre_authorized_levels }.');
  const consent = matching.consent;
  if (!positive(consent?.answer_hours)) problems.push('matching.consent.answer_hours is how many hours people have to answer an introduction, above 0.');
  if (!names(consent?.selection?.approved_values) || !names(consent?.selection?.veto_values)) problems.push('matching.consent.selection is { approved_values, veto_values }: what a person\'s switch says to be paired, and to stay out.');
  if (!text(consent?.yes_needs?.field) || consent?.yes_needs?.equals === undefined) problems.push('matching.consent.yes_needs is { field, equals }: the stamp an answer carries when the person pressed yes themselves.');
  if (!text(consent?.screen)) problems.push('matching.consent.screen is where a person presses yes, with {community_id}.');
  const hours = matching.follow_up_hours;
  if (!(Array.isArray(hours) && hours.every((value, index) => positive(value) && (index === 0 || value > hours[index - 1])))) problems.push('matching.follow_up_hours lists hours above 0, each later than the one before.');
  for (const job of JOBS) if (!text(matching.jobs?.[job]?.said) || !text(matching.jobs?.[job]?.job)) problems.push(`matching.jobs.${job} has its said and job words.`);
  const missingWords = WORDS.filter(word => !text(matching.words?.[word]));
  if (missingWords.length) problems.push(`matching.words leaves out: ${missingWords.join(', ')}.`);
  const unworded = STATES.filter(state => !text(matching.state_words?.[state]));
  if (unworded.length) problems.push(`matching.state_words leaves out: ${unworded.join(', ')}.`);
  let pattern = null;
  try { pattern = text(matching.contact_pattern) ? new RegExp(matching.contact_pattern, 'i') : null; } catch { pattern = null; }
  if (!pattern) problems.push('matching.contact_pattern is the pattern of contact details an answer may not hold.');
  const missingLimits = LIMITS.filter(limit => !whole(matching.limits?.[limit]));
  if (missingLimits.length) problems.push(`matching.limits are whole numbers above 0: ${missingLimits.join(', ')}.`);
  for (const side of ['offers', 'seeks']) if (!Array.isArray(matching.discover?.[side])) problems.push(`matching.discover.${side} lists the questions whose answers say what a member ${side === 'offers' ? 'offers' : 'seeks'}.`);
  if (matching.experiments !== undefined) problems.push(...experimentProblems(matching.experiments));
  return problems;
}

function experimentProblems(experiments) {
  if (!Array.isArray(experiments)) return ['matching.experiments is a list of { id, arms }.'];
  const problems = [];
  const worded = new Map();
  experiments.forEach((experiment, index) => {
    const at = `matching.experiments[${index}]`;
    if (!text(experiment?.id)) problems.push(`${at}.id names the experiment.`);
    if (experiments.filter(other => other?.id === experiment?.id).length > 1) problems.push(`${at}.id "${experiment?.id}" is used twice.`);
    if (!Array.isArray(experiment?.arms) || experiment.arms.length < 2) { problems.push(`${at}.arms lists two or more arms.`); return; }
    for (const arm of experiment.arms) {
      if (!text(arm?.id) || experiment.arms.filter(other => other?.id === arm?.id).length > 1) problems.push(`${at}: every arm has its own id.`);
      if (!positive(arm?.weight)) problems.push(`${at}: arm ${arm?.id} has a weight above 0.`);
      for (const [job, armWords] of Object.entries(arm?.jobs ?? {})) {
        if (!JOBS.includes(job)) { problems.push(`${at}: arm ${arm?.id} words a job the round does not hand: ${job}.`); continue; }
        if (!['job', 'said'].some(field => text(armWords?.[field]))) problems.push(`${at}: arm ${arm?.id} gives the ${job} job its job or said words.`);
        if (worded.has(job) && worded.get(job) !== experiment.id) problems.push(`${at}: the ${job} job is already worded by experiment ${worded.get(job)}.`);
        worded.set(job, experiment.id);
      }
    }
  });
  return problems;
}

// ---- profiles and scores ---------------------------------------------------------------------------------------

/** A member's answers as a profile of the contract, every claim named PREFIX/question id#kind. */
export function profileOf(answers, matching, prefix) {
  return buildMatchProfile({
    participant_ref: prefix,
    answer_facts: matching.questions.filter(id => answers?.[id] !== undefined).map(id => ({ question_id: id, answer_fact_ref: `${prefix}/${id}`, value: answers[id] })),
  }, matching.contract);
}

/** Whether every question the community asks has an answer and the profile's scope is whole. */
export const profileComplete = (answers, matching) => matching.questions.every(id => (typeof answers?.[id] === 'string' ? answers[id].trim() : Array.isArray(answers?.[id]) && answers[id].length))
  && profileOf(answers, matching, 'you').status === 'grounded';

/** The claims of a profile another member's AI may read and cite: only the kinds a factor can cite. */
export function citableClaims(profile, matching) {
  const kinds = new Set(Object.values(matching.contract.citation_requirements).flatMap(rows => rows.flatMap(row => row.any_of)));
  return profile.claims.filter(claim => kinds.has(claim.claim_kind)).map(claim => ({ claim_ref: claim.claim_ref, kind: claim.claim_kind, says: claim.value }));
}

/**
 * One AI's scores for its shortlist checked against both profiles: per candidate the grounded factor bundle and the
 * rationales. scores [{ candidate_ref, factors: { factor: { score, reason, you: [claim_ref], them: [claim_ref] } } }].
 */
export function groundedScores({ ask, scores, matching, inferenceRef }) {
  const subject = profileOf(ask.answers, matching, 'you');
  return (Array.isArray(scores) ? scores : []).flatMap(row => {
    const candidate = ask.candidates.find(entry => entry.candidate_ref === row?.candidate_ref);
    if (!candidate) return [];
    const them = profileOf(candidate.answers, matching, candidate.candidate_ref);
    const claims = new Map([...subject.claims, ...them.claims].map(claim => [claim.claim_ref, claim]));
    const assessments = matching.contract.factors.map(factor => {
      const given = row.factors?.[factor];
      const you = Array.isArray(given?.you) ? given.you.map(String) : [];
      const theirs = Array.isArray(given?.them) ? given.them.map(String) : [];
      return {
        factor, score: Number(given?.score), rationale: text(given?.reason) ? given.reason.trim().slice(0, matching.limits.reason_chars) : '', inference_ref: inferenceRef,
        subject_claim_refs: you, candidate_claim_refs: theirs, evidence_refs: [...new Set([...you, ...theirs].flatMap(ref => claims.get(ref)?.evidence_refs ?? []))],
      };
    });
    const bundle = deriveGroundedFactorEvidence({ subject_profile: subject, candidate_profile: them, assessments }, matching.contract);
    return [{ person: candidate.person, scope: subject.scope, bundle, reasons: bundle.status === 'grounded' ? assessments.map(item => item.rationale) : [] }];
  });
}

/**
 * The groups a closed round forms, from each asked AI's grounded scores only: asks [{ round_id, person, answers,
 * candidates, scores }], consents { person: switch value }. Gives { groups: [{ members, reasons: { person: [reason] } }],
 * unmatched_details }.
 */
export function formGroups({ asks, matching, consents }) {
  const policy = policyOf(matching);
  const reasonsOf = new Map();
  const rows = asks.filter(ask => Array.isArray(ask.scores)).map(ask => {
    const graded = groundedScores({ ask, scores: ask.scores, matching, inferenceRef: `score:${ask.round_id}:${ask.person}` });
    for (const item of graded) if (item.reasons.length) reasonsOf.set(JSON.stringify([ask.person, item.person]), item.reasons);
    return { subject: ask.person, scope: profileOf(ask.answers, matching, 'you').scope, shortlist: graded.map(item => ({ participant: item.person, factor_evidence: item.bundle })) };
  });
  const built = buildCandidates(rows, { shortlist_size: matching.shortlist_size, expected_value: policy });
  const selected = selectGroups({
    candidates: built.candidates,
    pairing: { group_size: matching.group_size, exclusive_participation: true, exclusion: 'none', ...(matching.grouping ? { grouping: matching.grouping } : {}) },
    expected_value: policy,
    initiative: matching.initiative,
    consents,
    consent_policy: matching.consent.selection,
  });
  const reasonsFor = (person, other) => reasonsOf.get(JSON.stringify([person, other])) ?? reasonsOf.get(JSON.stringify([other, person])) ?? [];
  const groups = selected.ready_introductions.map(introduction => ({
    members: introduction.parties,
    reasons: Object.fromEntries(introduction.parties.map(person => [person, introduction.parties.filter(other => other !== person).flatMap(other => reasonsFor(person, other))])),
  }));
  return { groups, unmatched_details: [...built.rejections, ...selected.unmatched_details] };
}

/**
 * Every member's shortlist from an inverted index: each member's tokens are their categories (weight 100) and the
 * distinct words of their answers (weight 1); a token's posting list holds at most `postingCap` members, so building
 * every shortlist makes at most members x tokens x postingCap comparisons. A shortlist the overlap leaves short is
 * filled from the members after this one in order, at most postingCap steps. `seen` holds pairs never proposed again.
 */
export function shortlistsFor(ready, { size, postingCap, seen }) {
  const tokens = ready.map(member => {
    const kept = new Map((member.categories ?? []).map(category => [`c:${category}`, 100]));
    for (const word of words(Object.values(member.answers ?? {}).flat().join(' '))) if (!kept.has(`w:${word}`)) kept.set(`w:${word}`, 1);
    return kept;
  });
  const postings = new Map();
  tokens.forEach((kept, index) => {
    for (const token of kept.keys()) {
      const list = postings.get(token) ?? [];
      if (list.length < postingCap) { list.push(index); postings.set(token, list); }
    }
  });
  let comparisons = 0;
  const open = (index, other) => other !== index && !seen.has(pairKey(ready[index].person, ready[other].person));
  const shortlists = ready.map((member, index) => {
    const overlap = new Map();
    for (const [token, weight] of tokens[index]) {
      for (const other of postings.get(token)) {
        comparisons += 1;
        if (open(index, other)) overlap.set(other, (overlap.get(other) ?? 0) + weight);
      }
    }
    const chosen = [...overlap].sort((a, b) => b[1] - a[1] || ready[a[0]].person.localeCompare(ready[b[0]].person)).slice(0, size).map(([other]) => other);
    for (let step = 1; chosen.length < size && step < ready.length && step <= postingCap; step += 1) {
      comparisons += 1;
      const other = (index + step) % ready.length;
      if (open(index, other) && !chosen.includes(other)) chosen.push(other);
    }
    return chosen.map(other => ready[other]);
  });
  return { shortlists, comparisons };
}

/** The arm of each experiment one member is on: a sticky draw over the arms' weights. { experiment id: arm }. */
export function armsOf(communityId, person, experiments = []) {
  return Object.fromEntries(experiments.map(experiment => {
    const total = experiment.arms.reduce((sum, arm) => sum + arm.weight, 0);
    let at = (parseInt(identityOf(`${communityId}:${experiment.id}:${person}`).slice(0, 12), 16) / 16 ** 12) * total;
    const arm = experiment.arms.find(candidate => (at -= candidate.weight) < 0) ?? experiment.arms.at(-1);
    return [experiment.id, arm];
  }));
}

// ---- the community ---------------------------------------------------------------------------------------------

/**
 * One community's matchmaker over a book of its records at engine time `now` (milliseconds). Every change is kept in
 * the book; book.writes() is what to write. Refuses a community whose settings are missing or not usable.
 */
export function openCommunity({ communityId, book, now }) {
  const community = book.get(ids.community(communityId));
  if (!community) throw new MatchRefusal(`No community ${communityId} keeps matching settings here.`, { status: 404 });
  const problems = matchingProblems(community);
  if (problems.length) throw new MatchRefusal(`The community's matching settings are not usable: ${problems.join(' ')}`, { status: 422 });
  const matching = community.matching;
  const c = communityId;
  const say = (word, values = {}) => fill(matching.words[word], values);
  const values = extra => ({ community: community.title, community_id: c, ...extra });
  const contact = new RegExp(matching.contact_pattern, 'i');

  const members = () => book.list(ids.memberPrefix(c)).map(record => record.value).filter(member => member.state === 'member');
  const member = person => book.get(ids.member(c, person));
  const nameOf = person => member(person)?.name ?? person;
  const matchingOn = person => {
    const on = member(person)?.on;
    return on === true || on === false ? on : matching.default_on;
  };
  const rounds = () => book.list(ids.roundPrefix(c)).map(record => record.value);
  const openRound = () => rounds().filter(round => !round.closed_at).at(-1) ?? null;
  const asksOf = roundId => book.list(ids.askPrefix(c, roundId)).map(record => record.value);
  const matches = () => book.list(ids.matchPrefix(c)).map(record => record.value);
  const answersOf = match => Object.fromEntries(book.list(ids.answerPrefix(c, match.match_id)).map(record => [record.value.person, record.value]));

  // ---- jobs ----
  const jobWords = (arms, job, filled) => {
    const worded = Object.values(arms).find(arm => arm.jobs?.[job])?.jobs[job] ?? {};
    return { said: fill(worded.said ?? matching.jobs[job].said, filled), job: fill(worded.job ?? matching.jobs[job].job, filled) };
  };
  const askedArms = (roundId, person) => {
    const asked = book.get(ids.ask(c, roundId, person))?.arms ?? {};
    return Object.fromEntries((matching.experiments ?? []).map(experiment => [experiment.id, experiment.arms.find(arm => arm.id === asked[experiment.id])]).filter(([, arm]) => arm));
  };
  // One job for one person's own AI, once per request key: a job kept under that key is never handed again (the seam
  // also drops a write of a job the door already holds).
  const handToAi = (person, jobText, requestKey, input) => {
    const id = ids.job(c, requestKey);
    if (book.has(id)) return false;
    book.put(id, KINDS.job, { status: 'waiting', for: person, said: jobText.said, job: jobText.job, input, from: `community:${c}`, request_key: requestKey, at: iso(now) });
    return true;
  };
  const answerWith = extra => ({ tool: ANSWER_TOOL, arguments: { community_id: c, ...extra } });

  // ---- the one-to-one group ----
  const spaceRef = matchId => ({ family: 'introduction', parts: { community: c, match: matchId } });
  const spaceGraph = match => foldGroupRecords(book.has(match.space_id) ? [{ id: match.space_id, value: book.get(match.space_id) }] : []).graph;
  const inSpace = (match, person) => membersOf(spaceGraph(match), spaceRef(match.match_id)).some(entry => entry.memberId === person);
  const writeSpace = (before, after) => { for (const write of groupRecordWrites(before, after)) write.value === null ? book.remove(write.id) : book.put(write.id, write.type, write.value); };

  // ---- consent and state ----
  const shownTo = (match, person) => ({
    text: { community: community.title, why: match.reasons[person] ?? [] },
    recipients: match.members.filter(other => other !== person).map(other => ({ person: other, name: nameOf(other) })),
    shared: { name: nameOf(person) },
    expires_at: match.answer_by,
  });
  // A yes counts while it was pressed by the person and is for what they are shown now.
  const yesHolds = (match, answer) => answer?.yes === true && answer.by_person === true && changedSince(answer.consent, shownTo(match, answer.person)).length === 0;
  const everyoneYes = (match, answers) => match.members.every(person => yesHolds(match, answers[person]));
  /** A match's state, read from its records at this time. */
  function stateOf(match, answers = answersOf(match)) {
    if (match.members.some(person => answers[person]?.yes === false)) return 'passed';
    if (!match.introduced_at) {
      if (Date.parse(match.answer_by) <= now) return 'expired';
      if (everyoneYes(match, answers)) return 'waiting_for_ais';
      return match.members.some(person => yesHolds(match, answers[person])) ? 'one_yes' : 'proposed';
    }
    if (match.members.every(person => answers[person]?.wrote === true)) return 'talked';
    return match.members.some(person => answers[person]?.topics?.length) ? 'introduced' : 'waiting_for_ais';
  }
  const view = state => ({ status: state, says: matching.state_words[state] });
  const claimsOf = (person, prefix) => citableClaims(profileOf(member(person)?.answers ?? {}, matching, prefix), matching);
  const askConsent = (match, person) => {
    const others = match.members.filter(other => other !== person);
    handToAi(person, jobWords(askedArms(match.round_id, person), 'consent', values({ match_id: match.match_id, name: nameOf(person), other: others.map(nameOf).join(', '), why: (match.reasons[person] ?? []).join(' '), answer_by: match.answer_by })),
      `match-consent:${match.match_id}:${person}:${consentOf(shownTo(match, person))}`,
      { community_id: c, match_id: match.match_id, answer_by: match.answer_by, them: others.map(other => ({ name: nameOf(other), claims: claimsOf(other, 'them') })), why: match.reasons[person] ?? [],
        show_with: { screen: fill(matching.consent.screen, { community_id: c }) }, no_with: answerWith({ kind: 'answer', match_id: match.match_id, yes: false }) });
  };

  // ---- rounds ----
  const seenPairs = () => {
    const seen = new Set();
    for (const match of matches()) for (const a of match.members) for (const b of match.members) if (a < b) seen.add(pairKey(a, b));
    return seen;
  };
  const nextRoundAt = () => Date.parse(rounds().at(-1)?.started_at ?? community.created_at) + matching.every_days * DAY;

  function startRound() {
    const roundId = ids.roundIdAt(now);
    if (book.has(ids.round(c, roundId))) return { round_id: roundId, asked_to_score: 0, asked_for_profile: 0, deadline_at: null };
    const deadline = iso(now + matching.round_hours * HOUR);
    book.put(ids.round(c, roundId), KINDS.round, { round_id: roundId, started_at: iso(now), deadline_at: deadline, closed_at: null, formed: null });
    const inRound = members().filter(entry => matchingOn(entry.person)).map(entry => ({ ...entry, answers: entry.answers ?? {}, complete: profileComplete(entry.answers ?? {}, matching) }));
    const ready = inRound.filter(entry => entry.complete);
    const { shortlists } = shortlistsFor(ready, { size: matching.shortlist_size, postingCap: matching.posting_cap, seen: seenPairs() });
    const byQuestion = new Map(matching.contract.questions.map(question => [question.question_id, question]));
    let asked = 0;
    let askedForProfile = 0;
    for (const entry of inRound.filter(item => !item.complete)) {
      const missing = matching.questions.filter(id => entry.answers[id] === undefined);
      if (handToAi(entry.person, jobWords(armsOf(c, entry.person, matching.experiments), 'profile', values({ round_id: roundId, name: entry.name })), `match-profile:${roundId}:${entry.person}`,
        { community_id: c, questions: missing.map(id => ({ question_id: id, question: byQuestion.get(id).wording ?? null })), answer_with: answerWith({ kind: 'profile' }) })) askedForProfile += 1;
    }
    const template = Object.fromEntries(matching.contract.factors.map(factor => [factor, { score: '(above 0, at most 1)', reason: '(one sentence)', you: ['(claim_ref)'], them: ['(claim_ref)'] }]));
    ready.forEach((entry, index) => {
      if (!shortlists[index].length) return;
      const arms = armsOf(c, entry.person, matching.experiments);
      const ask = {
        round_id: roundId, person: entry.person, answers: entry.answers, scores: null, answered_at: null,
        candidates: shortlists[index].map((other, at) => ({ candidate_ref: `c${at + 1}`, person: other.person, answers: other.answers })),
        arms: Object.fromEntries(Object.entries(arms).map(([experiment, arm]) => [experiment, arm.id])),
      };
      book.put(ids.ask(c, roundId, entry.person), KINDS.ask, ask);
      handToAi(entry.person, jobWords(arms, 'score', values({ round_id: roundId, name: entry.name })), `match-score:${roundId}:${entry.person}`, {
        community_id: c, round_id: roundId, factors: matching.contract.factors,
        you: { name: entry.name, claims: citableClaims(profileOf(entry.answers, matching, 'you'), matching) },
        candidates: ask.candidates.map(candidate => ({ candidate_ref: candidate.candidate_ref, name: nameOf(candidate.person), claims: citableClaims(profileOf(candidate.answers, matching, candidate.candidate_ref), matching) })),
        answer_with: answerWith({ kind: 'scores', round_id: roundId, scores: [{ candidate_ref: 'c1', factors: template }] }),
      });
      asked += 1;
    });
    if (!asked) closeRound(book.get(ids.round(c, roundId)));
    return { round_id: roundId, asked_to_score: asked, asked_for_profile: askedForProfile, deadline_at: asked ? deadline : null };
  }

  function closeRound(round) {
    if (!round || round.closed_at) return { formed: 0 };
    const asks = asksOf(round.round_id);
    const people = [...new Set(asks.flatMap(ask => [ask.person, ...ask.candidates.map(candidate => candidate.person)]))];
    // Each person is paired only while their own matching is on, read now, not when they were asked.
    const [onValue] = matching.consent.selection.approved_values;
    const [offValue] = matching.consent.selection.veto_values;
    const consents = Object.fromEntries(people.map(person => [person, member(person)?.state === 'member' && matchingOn(person) ? onValue : offValue]));
    const { groups } = formGroups({ asks, matching, consents });
    groups.forEach((group, index) => introduce(round, group, ids.matchId(round.round_id, index + 1)));
    book.put(ids.round(c, round.round_id), KINDS.round, { ...round, closed_at: iso(now), formed: groups.length });
    return { formed: groups.length };
  }

  // The match is proposed and kept with the id of the group it will open; each person's AI puts it to them.
  function introduce(round, group, matchId) {
    if (book.has(ids.match(c, matchId))) return;
    const match = {
      match_id: matchId, round_id: round.round_id, members: group.members, reasons: group.reasons, created_at: iso(now),
      answer_by: iso(now + matching.consent.answer_hours * HOUR), space_id: groupRecordId(spaceRef(matchId)), introduced_at: null, followed_up: 0,
    };
    book.put(ids.match(c, matchId), KINDS.match, match);
    for (const person of match.members) askConsent(match, person);
  }

  // Everyone's yes holds: the one-to-one holds the people, and each person's AI is asked what to talk about first.
  // Safe to run again: the group gains only who is missing and no AI is asked twice.
  function makeIntroduction(match) {
    const ref = spaceRef(match.match_id);
    const before = spaceGraph(match);
    let after = ensureGroup(before, ref);
    for (const person of match.members) if (!membersOf(after, ref).some(entry => entry.memberId === person)) after = addMember(after, ref, { family: 'person', parts: { id: person } }, { memberId: person });
    writeSpace(before, after);
    book.put(ids.match(c, match.match_id), KINDS.match, { ...match, introduced_at: iso(now) });
    for (const person of match.members) {
      const others = match.members.filter(other => other !== person);
      handToAi(person, jobWords(askedArms(match.round_id, person), 'topics', values({ match_id: match.match_id, space_id: match.space_id, name: nameOf(person), other: others.map(nameOf).join(', '), why: (match.reasons[person] ?? []).join(' ') })),
        `match-topics:${match.match_id}:${person}`,
        { community_id: c, match_id: match.match_id, space_id: match.space_id, you: claimsOf(person, 'you'), them: others.map(other => ({ name: nameOf(other), claims: claimsOf(other, 'them') })), why: match.reasons[person] ?? [], answer_with: answerWith({ kind: 'topics', match_id: match.match_id }) });
    }
  }

  // ---- answers ----
  const ownMatch = (person, matchId) => {
    const match = book.get(ids.match(c, String(matchId ?? '')));
    if (!match || !match.members.includes(person)) throw new MatchRefusal(say('no_match'), { status: 404 });
    return match;
  };
  const ownAnswer = (match, person) => book.get(ids.answer(c, match.match_id, person)) ?? { person, yes: null, by_person: false, consent: null, at: null, topics: [], wrote: false };
  const putAnswer = (match, answer) => book.put(ids.answer(c, match.match_id, answer.person), KINDS.answer, answer);
  const clean = value => (Array.isArray(value)
    ? value.map(item => String(item).trim().slice(0, matching.limits.list_item_chars)).filter(Boolean).slice(0, matching.limits.list_items)
    : String(value ?? '').trim().slice(0, matching.limits.answer_chars));

  function setMatching(person, { on, answers, categories }) {
    const kept = member(person);
    if (kept?.state !== 'member') throw new MatchRefusal(say('not_a_member'), { status: 403 });
    const next = { ...kept, answers: { ...(kept.answers ?? {}) }, categories: [...(kept.categories ?? [])] };
    for (const [question, value] of Object.entries(object(answers) ? answers : {})) {
      if (!matching.questions.includes(question)) throw new MatchRefusal(say('not_a_question', { question, questions: matching.questions.join(', ') }), { status: 400 });
      const cleaned = clean(value);
      if (contact.test(JSON.stringify(cleaned))) throw new MatchRefusal(say('contact_in_profile'), { status: 400 });
      if (Array.isArray(cleaned) ? cleaned.length : cleaned) next.answers[question] = cleaned; else delete next.answers[question];
    }
    if (Array.isArray(categories)) {
      next.categories = [...new Set(categories.map(item => String(item).trim().toLowerCase().slice(0, matching.limits.category_chars)).filter(Boolean))].slice(0, matching.limits.categories);
      if (contact.test(next.categories.join(' '))) throw new MatchRefusal(say('contact_in_profile'), { status: 400 });
    }
    if (typeof on === 'boolean') next.on = on;
    next.changed_at = iso(now);
    book.put(ids.member(c, person), KINDS.member, next);
    return { on: matchingOn(person), profile_complete: profileComplete(next.answers, matching), missing: matching.questions.filter(question => next.answers[question] === undefined), categories: next.categories };
  }

  function submitScores(person, { round_id: roundId, scores }) {
    const round = book.get(ids.round(c, String(roundId ?? '')));
    const ask = round && !round.closed_at ? book.get(ids.ask(c, round.round_id, person)) : null;
    if (!ask) throw new MatchRefusal(say('no_round'), { status: 409 });
    if (!Array.isArray(scores)) throw new MatchRefusal(say('scores_shape', { factors: matching.contract.factors.join(', ') }), { status: 400 });
    const graded = groundedScores({ ask, scores, matching, inferenceRef: `score:${round.round_id}:${person}` });
    book.put(ids.ask(c, round.round_id, person), KINDS.ask, { ...ask, scores, answered_at: iso(now) });
    const waiting = asksOf(round.round_id).filter(entry => !entry.answered_at).length;
    const closed = waiting ? null : closeRound(round);
    return {
      round_id: round.round_id,
      scored: graded.map(item => ({
        candidate_ref: ask.candidates.find(candidate => candidate.person === item.person)?.candidate_ref, grounded: item.bundle.status === 'grounded',
        ...(item.bundle.status === 'grounded' ? {} : { why_not: Object.entries(item.bundle.factors).filter(([, factor]) => factor.status !== 'grounded').map(([factor, entry]) => `${factor}: ${entry.reasons.join(', ')}`) }),
      })),
      ...(closed ? { round_closed: true, matches_formed: closed.formed } : { waiting_for: waiting }),
    };
  }

  // A person's own answer to an introduction, kept in their own answer record. A yes needs the person stamp and the
  // consent of what they are shown now; once every member's yes holds the one-to-one is made, and a member whose
  // earlier yes no longer holds is asked again. A no, from the person or their AI, passes it for everyone and takes
  // the person out of the group. An ended introduction takes no yes; the same answer again changes nothing.
  function answerMatch(person, answer) {
    const { match_id: matchId, yes, consent } = answer;
    if (typeof yes !== 'boolean') throw new MatchRefusal(say('yes_or_no'), { status: 400 });
    const match = ownMatch(person, matchId);
    const byPerson = answer[matching.consent.yes_needs.field] === matching.consent.yes_needs.equals;
    if (yes && !byPerson) throw new MatchRefusal(say('yes_on_page'), { status: 403, next_call: { screen: fill(matching.consent.screen, { community_id: c }) } });
    const state = stateOf(match);
    const mine = ownAnswer(match, person);
    if (!yes) {
      if (state === 'expired') return { match_id: match.match_id, ...view(state) };
      if (mine.yes !== false) putAnswer(match, { ...mine, yes: false, by_person: byPerson, consent: null, at: iso(now) });
      if (inSpace(match, person)) { const before = spaceGraph(match); writeSpace(before, removeMember(before, spaceRef(match.match_id), person)); }
      return { match_id: match.match_id, ...view('passed') };
    }
    if (state === 'passed' || state === 'expired') throw new MatchRefusal(say('ended'), { status: 409 });
    if (!match.introduced_at) {
      const changed = changedSince(consent, shownTo(match, person));
      if (changed.length) throw new MatchRefusal(say('changed'), { status: 409, changed, consent: consentOf(shownTo(match, person)) });
      putAnswer(match, { ...mine, yes: true, by_person: true, consent, at: iso(now) });
      const answers = answersOf(match);
      for (const other of match.members) if (other !== person && answers[other]?.yes === true && !yesHolds(match, answers[other])) askConsent(match, other);
      if (!everyoneYes(match, answers)) return { match_id: match.match_id, ...view('one_yes') };
      makeIntroduction(match);
    } else makeIntroduction(match);
    return { match_id: match.match_id, ...view(stateOf(book.get(ids.match(c, match.match_id)))), space_id: match.space_id };
  }

  function suggestTopics(person, { match_id: matchId, topics }) {
    const match = ownMatch(person, matchId);
    if (!match.introduced_at || stateOf(match) === 'passed') throw new MatchRefusal(say('not_introduced'), { status: 409 });
    const given = (Array.isArray(topics) ? topics : []).map(topic => String(topic ?? '').trim().slice(0, matching.limits.list_item_chars)).filter(Boolean).slice(0, matching.limits.topics_per_call);
    if (!given.length) throw new MatchRefusal(say('topics_shape', { most: matching.limits.topics_per_call }), { status: 400 });
    const mine = ownAnswer(match, person);
    putAnswer(match, { ...mine, topics: [...new Set([...(mine.topics ?? []), ...given])].slice(0, matching.limits.topics_kept) });
    return { match_id: match.match_id, topics: topicsOf(match) };
  }
  const topicsOf = (match, answers = answersOf(match)) => [...new Set(match.members.flatMap(person => answers[person]?.topics ?? []))].slice(0, matching.limits.topics_kept);

  // A person says they wrote in their one-to-one; once every member did, the match has talked.
  function wrote(person, { match_id: matchId }) {
    const match = ownMatch(person, matchId);
    if (!match.introduced_at || !inSpace(match, person)) throw new MatchRefusal(say('not_introduced'), { status: 409 });
    putAnswer(match, { ...ownAnswer(match, person), wrote: true });
    return { match_id: match.match_id, ...view(stateOf(match)) };
  }

  function runRound(person) {
    if (person !== community.owner) throw new MatchRefusal(say('owner_only'), { status: 403 });
    const open = openRound();
    if (open) closeRound(open);
    return startRound();
  }

  const ANSWERS = { profile: setMatching, scores: submitScores, answer: answerMatch, topics: suggestTopics, wrote, 'run-round': runRound };
  /** One answer from `person`: { ok: true, ... } or { ok: false, error, status, ... } in the community's own words. */
  function apply(answer) {
    try {
      const handler = Object.hasOwn(ANSWERS, answer?.kind) ? ANSWERS[answer.kind] : null;
      if (!handler || !text(answer?.person)) throw new MatchRefusal(say('unknown_answer', { kinds: Object.keys(ANSWERS).join(', ') }), { status: 400 });
      return { ok: true, ...handler(answer.person, answer) };
    } catch (error) {
      if (!(error instanceof MatchRefusal)) throw error;
      const { message, status, next_call: nextCall, changed, consent } = error;
      return { ok: false, error: message, status, ...(nextCall ? { next_call: nextCall } : {}), ...(changed ? { changed } : {}), ...(consent ? { consent } : {}) };
    }
  }

  // ---- the clock ----
  const followUpRows = () => matches().filter(match => match.introduced_at && match.followed_up < matching.follow_up_hours.length && stateOf(match) !== 'passed')
    .sort((a, b) => a.introduced_at.localeCompare(b.introduced_at)).slice(0, matching.limits.follow_up_page);
  function followUpDue() {
    const hours = matching.follow_up_hours;
    for (const match of followUpRows()) {
      if (Date.parse(match.introduced_at) + hours[match.followed_up] * HOUR > now) continue;
      if (stateOf(match) === 'talked') { book.put(ids.match(c, match.match_id), KINDS.match, { ...match, followed_up: hours.length }); continue; }
      for (const person of match.members.filter(entry => inSpace(match, entry))) {
        const others = match.members.filter(other => other !== person);
        handToAi(person, jobWords(askedArms(match.round_id, person), 'follow_up', values({ match_id: match.match_id, space_id: match.space_id, name: nameOf(person), other: others.map(nameOf).join(', '), why: (match.reasons[person] ?? []).join(' '), days: String(Math.max(1, Math.round((now - Date.parse(match.introduced_at)) / DAY))) })),
          `match-follow:${match.match_id}:${person}:${match.followed_up}`,
          { community_id: c, match_id: match.match_id, space_id: match.space_id, step: match.followed_up + 1, of: hours.length, topics: topicsOf(match), why: match.reasons[person] ?? [], no_with: answerWith({ kind: 'answer', match_id: match.match_id, yes: false }) });
      }
      book.put(ids.match(c, match.match_id), KINDS.match, { ...match, followed_up: match.followed_up + 1 });
    }
  }

  /**
   * The community's clock: close a round at its deadline or start the next one when due, make any introduction whose
   * yeses all hold (two last yeses given at once each see only their own), and follow up. Gives what it did.
   */
  function tick() {
    const open = openRound();
    let round = null;
    if (open && Date.parse(open.deadline_at) <= now) round = { closed: open.round_id, ...closeRound(open) };
    else if (!open && nextRoundAt() <= now) round = { started: startRound() };
    for (const match of matches()) if (!match.introduced_at && stateOf(match) === 'waiting_for_ais') makeIntroduction(match);
    followUpDue();
    return { round, next_at: nextAt() };
  }

  /** When the clock next has something to do: the open round's deadline or the next round, and the next follow-up. */
  function nextAt() {
    const open = openRound();
    const times = [open ? Date.parse(open.deadline_at) : nextRoundAt()];
    for (const match of followUpRows()) times.push(Date.parse(match.introduced_at) + matching.follow_up_hours[match.followed_up] * HOUR);
    return iso(Math.min(...times));
  }

  // ---- views ----
  function experimentsView() {
    return (matching.experiments ?? []).map(experiment => {
      const counts = new Map(experiment.arms.map(arm => [arm.id, { introduced: 0, talked: 0 }]));
      const events = [];
      for (const match of matches().filter(row => row.introduced_at)) {
        const answers = answersOf(match);
        const talked = match.members.every(person => answers[person]?.wrote === true);
        for (const person of match.members) {
          const arm = book.get(ids.ask(c, match.round_id, person))?.arms?.[experiment.id];
          if (!counts.has(arm)) continue;
          counts.get(arm).introduced += 1;
          if (talked) counts.get(arm).talked += 1;
          events.push({ event: 'shown', subject_id: `${match.match_id}:${person}`, arm }, ...(talked ? [{ event: 'converted', subject_id: `${match.match_id}:${person}`, arm }] : []));
        }
      }
      return { experiment_id: experiment.id, arms: experiment.arms.map(arm => ({ arm_id: arm.id, weight: arm.weight, ...counts.get(arm.id) })), events };
    });
  }

  function matchesView(person) {
    return matches().filter(row => row.members.includes(person)).reverse().map(row => {
      const answers = answersOf(row);
      const others = row.members.filter(other => other !== person);
      return {
        match_id: row.match_id, ...view(stateOf(row, answers)), answered: yesHolds(row, answers[person]) ? 'yes' : answers[person]?.yes === false ? 'no' : null,
        answer_by: row.answer_by, consent: consentOf(shownTo(row, person)), with: { name: nameOf(others[0]) }, ...(others.length > 1 ? { people: others.map(other => ({ name: nameOf(other) })) } : {}),
        why: row.reasons[person] ?? [], topics: topicsOf(row, answers), space_id: inSpace(row, person) ? row.space_id : null,
      };
    });
  }

  // Fellow members who share a category with this one: their name, the categories shared, what they offer and seek.
  function discoverFor(person) {
    const mine = member(person)?.categories ?? [];
    if (!mine.length) return [];
    const said = (entry, questions) => questions.flatMap(id => [].concat(entry.answers?.[id] ?? []));
    return members().filter(entry => entry.person !== person).slice(0, matching.limits.discover_page).map(entry => {
      const shared = mine.filter(category => (entry.categories ?? []).includes(category));
      return shared.length ? { person: entry.person, name: entry.name, shared, offers: said(entry, matching.discover.offers), seeks: said(entry, matching.discover.seeks) } : null;
    }).filter(Boolean).sort((a, b) => b.shared.length - a.shared.length);
  }

  /** What one member (or their AI) reads: their matches, their profile, any score job still owed, and who shares a category. */
  function myMatching(person) {
    const kept = member(person);
    if (kept?.state !== 'member') throw new MatchRefusal(say('not_a_member'), { status: 403 });
    const open = openRound();
    const ask = open ? book.get(ids.ask(c, open.round_id, person)) : null;
    const byQuestion = new Map(matching.contract.questions.map(question => [question.question_id, question]));
    return {
      on: matchingOn(person), cadence_label: matching.cadence_label, next_at: iso(open ? Date.parse(open.deadline_at) : nextRoundAt()), matches: matchesView(person),
      ...(person === community.owner && matching.experiments?.length ? { experiments: experimentsView() } : {}),
      profile: { answers: kept.answers ?? {}, categories: kept.categories ?? [], complete: profileComplete(kept.answers ?? {}, matching), missing: matching.questions.filter(id => kept.answers?.[id] === undefined).map(id => ({ question_id: id, question: byQuestion.get(id).wording ?? null })) },
      waiting_for_your_scores: ask && !ask.answered_at ? [{
        round_id: open.round_id, answer_by: open.deadline_at, you: citableClaims(profileOf(ask.answers, matching, 'you'), matching),
        candidates: ask.candidates.map(candidate => ({ candidate_ref: candidate.candidate_ref, name: nameOf(candidate.person), claims: citableClaims(profileOf(candidate.answers, matching, candidate.candidate_ref), matching) })),
      }] : [],
      discover: discoverFor(person),
      // The pull road: this person's waiting jobs, and when the community's clock next acts, so the member side wakes
      // then and pulls once. Nothing is ever written into another person's account.
      waiting_jobs: book.list(ids.jobPrefix(c)).map(record => record.value).filter(job => job.for === person && job.status === 'waiting').map(({ request_key: requestKey, said, job, input }) => ({ request_key: requestKey, said, job, input })),
      wake_at: nextAt(),
    };
  }

  // Erasure: what this person told matchmaking, every match that names them with its group, answers and jobs, their
  // round asks and jobs, and their place and scores on other members' shortlists and score jobs go. The others keep
  // their own asks and jobs.
  function forget(person) {
    book.remove(ids.member(c, person));
    const gone = new Set();
    for (const record of book.list(ids.matchPrefix(c))) {
      if (!record.value.members.includes(person)) continue;
      gone.add(record.value.match_id);
      book.remove(record.id);
      book.remove(record.value.space_id);
      for (const answer of book.list(ids.answerPrefix(c, record.value.match_id))) book.remove(answer.id);
    }
    const scrubbed = new Map();
    for (const record of book.list(ids.allAsksPrefix(c))) {
      if (record.value.person === person) { book.remove(record.id); continue; }
      const refs = new Set(record.value.candidates.filter(candidate => candidate.person === person).map(candidate => candidate.candidate_ref));
      if (!refs.size) continue;
      scrubbed.set(`match-score:${record.value.round_id}:${record.value.person}`, refs);
      book.put(record.id, KINDS.ask, { ...record.value, candidates: record.value.candidates.filter(candidate => candidate.person !== person), scores: Array.isArray(record.value.scores) ? record.value.scores.filter(score => !refs.has(score?.candidate_ref)) : record.value.scores });
    }
    for (const record of book.list(ids.jobPrefix(c))) {
      const job = record.value;
      if (job.for === person || gone.has(job.input?.match_id)) { book.remove(record.id); continue; }
      const refs = scrubbed.get(job.request_key);
      if (refs) book.put(record.id, KINDS.job, { ...job, input: { ...job.input, candidates: job.input.candidates.filter(candidate => !refs.has(candidate.candidate_ref)) } });
    }
    return { forgotten: person };
  }

  return { community, matching, apply, tick, nextAt, myMatching, forget, stateOf, nextRoundAt };
}
