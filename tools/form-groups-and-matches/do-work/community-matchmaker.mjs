// tools/form-groups-and-matches/do-work/community-matchmaker.mjs
//
// The commands of the community matchmaker rows over the run's records door (tools/records-door): each loads the
// community's records into a book (read-data/matchmaker-records.mjs), runs read-data/matchmaker.mjs at one time, and
// writes only what changed.
//
//   advanceCommunity     { community_id, now? }                          tool:advance-a-community-matchmaker
//   answerInCommunity    { community_id, person, kind, ...answer, now? } tool:answer-in-a-community
//   readCommunityMatches { community_id, person, now? }                  tool:read-my-community-matches
//   forgetInCommunity    { community_id, person, now? }                  tool:forget-a-person-in-a-community
//   checkCommunitySettings { community }                                tool:check-community-matching-settings (no door)
//
// What one run reads: the settings, every member, every round, every match and its answers, the asks of the rounds
// that still matter (the latest round and those of matches not yet ended), and the group of every introduced match.
// A view also reads every ask; erasure also reads every job. A job the door already holds is never written again.
import { randomUUID } from 'node:crypto';
import { ids, KINDS, makeBook } from '../read-data/matchmaker-records.mjs';
import { matchingProblems, MatchRefusal, openCommunity } from '../read-data/matchmaker.mjs';

// The door takes at most this many records in one write (the engine's cap when a row declares no most_writes).
const MOST_WRITES = 256;
const GROUP_KIND = 'group';
const text = value => typeof value === 'string' && value.trim().length > 0;

function timeOf(input) {
  const now = input?.now === undefined ? Date.now() : typeof input.now === 'number' ? input.now : Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error('now is the time to run at, in milliseconds or ISO words; left out, it is the time of the run.');
  return now;
}
function need(input, field, what) {
  if (!text(input?.[field])) throw new Error(`${field} must be text: ${what}.`);
  return input[field];
}

async function all(door, type, prefix) {
  const records = [];
  for await (const record of door.list({ type, prefix })) records.push(record);
  return records;
}

async function load(door, communityId, { everything = false } = {}) {
  const records = [];
  const settings = await door.read(KINDS.community, ids.community(communityId));
  if (settings !== null) records.push({ id: ids.community(communityId), type: KINDS.community, value: settings });
  records.push(...await all(door, KINDS.member, ids.memberPrefix(communityId)));
  const rounds = await all(door, KINDS.round, ids.roundPrefix(communityId));
  records.push(...rounds);
  const matches = await all(door, KINDS.match, ids.matchPrefix(communityId));
  records.push(...matches);
  records.push(...await all(door, KINDS.answer, ids.allAnswersPrefix(communityId)));
  if (everything) {
    records.push(...await all(door, KINDS.ask, ids.allAsksPrefix(communityId)));
    records.push(...await all(door, KINDS.job, ids.jobPrefix(communityId)));
  } else {
    const latest = [...rounds].sort((a, b) => (a.id < b.id ? 1 : -1))[0]?.value.round_id;
    const wanted = new Set([latest, ...matches.map(record => record.value.round_id)].filter(Boolean));
    for (const roundId of wanted) records.push(...await all(door, KINDS.ask, ids.askPrefix(communityId, roundId)));
  }
  for (const match of matches) {
    if (!match.value.introduced_at) continue;
    const group = await door.read(GROUP_KIND, match.value.space_id);
    if (group !== null) records.push({ id: match.value.space_id, type: GROUP_KIND, value: group });
  }
  return makeBook(records);
}

async function save(door, book, key) {
  const writes = [];
  for (const write of book.writes()) {
    // A job is handed once: a new one the door already holds (taken, done, or waiting) is left as it is. A job this run
    // read and changed (erasure taking a person out of it) is written.
    if (write.type === KINDS.job && write.value !== null && !book.loaded(write.id) && await door.read(KINDS.job, write.id) !== null) continue;
    writes.push(write);
  }
  for (let at = 0; at < writes.length; at += MOST_WRITES) await door.write(writes.slice(at, at + MOST_WRITES), { key: `${key}:${at / MOST_WRITES}` });
  return writes.length;
}

async function run(input, door, work, options) {
  const communityId = need(input, 'community_id', 'the community whose matchmaker runs');
  const now = timeOf(input);
  const book = await load(door, communityId, options);
  const community = openCommunity({ communityId, book, now });
  const result = work(community);
  const written = await save(door, book, text(input.request_key) ? input.request_key : `match:${communityId}:${now}:${randomUUID()}`);
  return { ...result, written };
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

/** The community's clock: a round started or closed when due, introductions whose yeses all hold made, follow-ups handed. */
export function advanceCommunity(input, { door }) {
  return run(input, door, community => community.tick()).catch(refusal);
}

/** One person's answer (profile, scores, answer, topics, wrote, run-round), applied now; then the clock. The row hands
 *  { input, task }: the run's task is the engine's, so a yes reads the person stamp there, never from the input. */
export function answerInCommunity({ input = {}, task = {} } = {}, { door }) {
  const person = need(input, 'person', 'who answers');
  if (notTheCaller(input, person)) return Promise.resolve(NOT_THE_CALLER);
  need(input, 'kind', 'which answer: profile, scores, answer, topics, wrote or run-round');
  return run(input, door, community => {
    const { community_id: _community, now: _now, request_key: _key, grant_person: _caller, ...answer } = input;
    const outcome = community.apply({ ...answer, person }, task);
    return { outcome, ...community.tick() };
  }).catch(refusal);
}

/** What one member reads: their matches, profile, owed score job and who shares a category with them. */
export function readCommunityMatches(input, { door }) {
  const person = need(input, 'person', 'the member reading');
  if (notTheCaller(input, person)) return Promise.resolve(NOT_THE_CALLER);
  return run(input, door, community => community.myMatching(person), { everything: true }).catch(refusal);
}

/** Erasure of one person from the community's matching records. */
export function forgetInCommunity(input, { door }) {
  const person = need(input, 'person', 'the person to forget');
  return run(input, door, community => community.forget(person), { everything: true }).catch(refusal);
}

/** What is missing or wrong in a community's settings before they are kept, as plain sentences; none when usable. */
export function checkCommunitySettings(input) {
  const problems = matchingProblems(input?.community);
  return { usable: problems.length === 0, problems };
}
