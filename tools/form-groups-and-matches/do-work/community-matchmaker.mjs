// tools/form-groups-and-matches/do-work/community-matchmaker.mjs
//
// The commands of the community matchmaker rows. A command reads and keeps nothing: the caller's AI reads the community's
// records from a store and hands them in as `records` ([{ id, type, value }]); each command loads them into a book
// (read-data/matchmaker-records.mjs), runs read-data/matchmaker.mjs at one time, and answers `write`, the records that
// changed ({ id, type, value, expected }: value null removes one, expected is the record as it was handed in, null for a new
// one) for the AI to put in the store.
//
//   advanceCommunity     { community_id, records, now? }                          tool:advance-a-community-matchmaker
//   answerInCommunity    { community_id, records, person, kind, ...answer, now? } tool:answer-in-a-community
//   readCommunityMatches { community_id, records, person, now? }                  tool:read-my-community-matches
//   forgetInCommunity    { community_id, records, person, now? }                  tool:forget-a-person-in-a-community
//   checkCommunitySettings { community }                                          tool:check-community-matching-settings
//
// What one run needs: the settings, every member, every round, every match and its answers, the asks of the rounds that
// still matter (the latest round and those of matches not yet ended), and the group of every introduced match. A view also
// needs every ask; erasure also needs every job. Records handed in beyond that are not used. A job the caller already holds
// (it is among the records handed in) is never answered as a write again, unless the run read it and changed it (erasure
// taking a person out of it).
import { ids, KINDS, makeBook } from '../read-data/matchmaker-records.mjs';
import { matchingProblems, MatchRefusal, openCommunity } from '../read-data/matchmaker.mjs';

const GROUP_KIND = 'group';
const text = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function timeOf(input) {
  const now = input?.now === undefined ? Date.now() : typeof input.now === 'number' ? input.now : Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error('now is the time to run at, in milliseconds or ISO words; left out, it is the time of the run.');
  return now;
}
function need(input, field, what) {
  if (!text(input?.[field])) throw new Error(`${field} must be text: ${what}.`);
  return input[field];
}

// The records handed in (none when left out), each checked to be { id, type, value }.
function handedIn(input) {
  const records = input?.records ?? [];
  if (!Array.isArray(records) || !records.every(record => object(record) && typeof record.id === 'string' && typeof record.type === 'string')) {
    throw new Error('records must be the community\'s records read from the person\'s records, each { id, type, value }.');
  }
  return records.filter(record => record.value !== null && record.value !== undefined);
}

// The records one run needs, picked from those handed in as the matchmaker has always read them.
function load(records, communityId, { everything = false } = {}) {
  const of = (type, prefix) => records.filter(record => record.type === type && record.id.startsWith(prefix));
  const picked = [];
  picked.push(...of(KINDS.community, ids.community(communityId)).filter(record => record.id === ids.community(communityId)));
  picked.push(...of(KINDS.member, ids.memberPrefix(communityId)));
  const rounds = of(KINDS.round, ids.roundPrefix(communityId));
  picked.push(...rounds);
  const matches = of(KINDS.match, ids.matchPrefix(communityId));
  picked.push(...matches);
  picked.push(...of(KINDS.answer, ids.allAnswersPrefix(communityId)));
  if (everything) {
    picked.push(...of(KINDS.ask, ids.allAsksPrefix(communityId)));
    picked.push(...of(KINDS.job, ids.jobPrefix(communityId)));
  } else {
    const latest = [...rounds].sort((a, b) => (a.id < b.id ? 1 : -1))[0]?.value.round_id;
    const wanted = new Set([latest, ...matches.map(record => record.value.round_id)].filter(Boolean));
    for (const roundId of wanted) picked.push(...of(KINDS.ask, ids.askPrefix(communityId, roundId)));
  }
  for (const match of matches) {
    if (!match.value.introduced_at) continue;
    const group = records.find(record => record.type === GROUP_KIND && record.id === match.value.space_id);
    if (group) picked.push(group);
  }
  return makeBook(picked);
}

// The changed records as conditional writes: each expects the record as it was handed in (null when it was not), and a new
// job the caller already holds is left as it is.
function writesOf(book, records) {
  const held = new Map(records.map(record => [record.id, record]));
  const writes = [];
  for (const write of book.writes()) {
    if (write.type === KINDS.job && write.value !== null && !book.loaded(write.id) && held.has(write.id)) continue;
    const before = held.get(write.id);
    writes.push({ ...write, expected: before ? { type: before.type, value: before.value } : null });
  }
  return writes;
}

function run(input, work, options) {
  const communityId = need(input, 'community_id', 'the community whose matchmaker runs');
  const now = timeOf(input);
  const records = handedIn(input);
  const book = load(records, communityId, options);
  const community = openCommunity({ communityId, book, now });
  const result = work(community);
  const write = writesOf(book, records);
  return { ...result, written: write.length, write };
}

// A member calling through a grant at the holder's door is named by the engine: with identity self it sets
// input.grant_person to the grant's principal for them (overriding any value sent), so that person may answer and read
// only as themselves. A run of the holder's own (no grant) carries no grant_person.
const NOT_THE_CALLER = { ok: false, error: 'A member may answer and read only as themselves: person must be the grant\'s person.', status: 403 };
const notTheCaller = (input, person) => input.grant_person !== undefined && input.grant_person !== person;

// A refusal is an answer the caller reads, in the community's own words: { ok: false, error, status }.
const refusal = error => {
  if (error instanceof MatchRefusal) return { ok: false, error: error.message, status: error.status };
  throw error;
};
const refusing = work => { try { return work(); } catch (error) { return refusal(error); } };

/** The community's clock: a round started or closed when due, introductions whose yeses all hold made, follow-ups handed. */
export function advanceCommunity(input) {
  return refusing(() => run(input, community => community.tick()));
}

/** One person's answer (profile, scores, answer, topics, wrote, run-round), applied now; then the clock. The row hands
 *  { input, task }: the run's task is the engine's, so a yes reads the person stamp there, never from the input. */
export function answerInCommunity({ input = {}, task = {} } = {}) {
  const person = need(input, 'person', 'who answers');
  if (notTheCaller(input, person)) return NOT_THE_CALLER;
  need(input, 'kind', 'which answer: profile, scores, answer, topics, wrote or run-round');
  return refusing(() => run(input, community => {
    const { community_id: _community, now: _now, records: _records, grant_person: _caller, ...answer } = input;
    const outcome = community.apply({ ...answer, person }, task);
    return { outcome, ...community.tick() };
  }));
}

/** What one member reads: their matches, profile, owed score job and who shares a category with them. */
export function readCommunityMatches(input) {
  const person = need(input, 'person', 'the member reading');
  if (notTheCaller(input, person)) return NOT_THE_CALLER;
  return refusing(() => run(input, community => community.myMatching(person), { everything: true }));
}

/** Erasure of one person from the community's matching records: the writes that remove them. */
export function forgetInCommunity(input) {
  const person = need(input, 'person', 'the person to forget');
  return refusing(() => run(input, community => community.forget(person), { everything: true }));
}

/** What is missing or wrong in a community's settings before they are kept, as plain sentences; none when usable. */
export function checkCommunitySettings(input) {
  const problems = matchingProblems(input?.community);
  return { usable: problems.length === 0, problems };
}
