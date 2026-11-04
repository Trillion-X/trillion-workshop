import { teamReviewProblem } from './team-review.mjs';
import { HANDOFF_RESULT_SOURCE, SOURCE_RESULT_JSON, SOURCE_RESULT_CONTENT, checkedResultSource, resultSourceCapability, serializedResultFor, preparedResultContentFor } from './handoff-result-source.mjs';
// Agents on one account that know about each other and hand work to one another.
//
// Any AI app signed in to the same account (a coding agent in a terminal, a chat app, a hosted job, a script with
// a personal key) publishes a card saying what it is and what it can do. Another agent finds it by the job in
// plain words and hands it work. Agents are clients, often asleep, so work is never pushed: a handoff waits in the
// account's own store until the agent it is addressed to (or any agent, when it names none) takes it, and the
// asker reads the result from wherever it is. An agent that gives a delivery address when it publishes is also sent
// an event when work is handed to it and when work it handed off is finished (src/agent-delivery.mjs), so it wakes
// on the event instead of asking again and again. The card follows the A2A Agent Card fields (name, description,
// skills), so an A2A-aware caller reads it as it is.
//
// Invariants
// - One writer: the account's own store, which runs one request at a time, so a handoff is taken by one agent.
// - The same request_key returns the same handoff; a different job or input under it is refused.
// - Work about one item (`once_per`: the identity of what it is about, such as a message id) is one handoff, whoever
//   hands it and however often: every hand-off naming the same once_per returns the first one, whatever its words,
//   so several rules, retried runs and rewrites of the same item never make a second job. Work that arrived from a
//   message or a button (input.arrived.message_id or asked_id) is about that item even when the hand-off names no
//   once_per (itemOf), so a person's own rule and Trillion's starting rule can never make two jobs for one message.
// - Work that came from a chat stays with that chat while its transcript grows or its owner sends heartbeats
//   (anyoneFrom); after a silence window any of the person's own AIs may take it, so no job waits for a closed chat.
//   Every card that owns the live chat may take it, the newest woken first, so two owners never block each other.
// - A card owns a chat only by proof (provenSource): messages are kept under that chat's id, or the card is reachable
//   and signs its own returns (a session its own carrier registers before its first message). A source no message
//   was ever kept under could never receive work, so it is refused with the chats that are kept, never accepted silently.
// - Only the agent that took a handoff can finish it, once; a taken handoff whose hold ran out can be taken again.
// - Nothing here names a harness, vendor, model or kind of job: all of that is the card's own data.
// - Work from a sender listed in src/ai-side-work.json is for the person's AIs only: it is taken, worked and finished like any
//   other, but the board, Home's card, the work feed and the notification read leave it out, and it tells the person nothing:
//   no notice is told when it is made, finished or stuck.
// - An ask whose asker waits for its answer in this same instance (in_memory: a model question Trillion puts to the
//   person's computer, src/agent-tool-runs.mjs) is the same handoff, kept only in memory: no delivery record, no notice
//   is told, and its take and finish write nothing. When the agent has a live stream its event goes straight down it;
//   otherwise the account's live connections are nudged (stream.nudge, src/live-screen.mjs), so a helper on the
//   person's computer hears of it and takes it by its id (2026-10-09: nine such questions were kept as jobs and withdrawn
//   untaken while the host's takes got busy answers; now they are kept in memory and the host's connection is nudged).
//   About forty such questions a minute on a busy account each
//   wrote a whole job, its delivery, its notice, its take, its finish and its ack, the store's largest writer on
//   2026-10-08. If the instance ends, its asker ended with it; a later take or finish of that id answers as for any
//   unknown job.
//
// The work lifecycle. A handoff is the one work record: its id never changes, and reassignment, retries and
// recovery all happen on that same record, never on a copy. Alongside the job it may carry the outcome wanted, the
// check that says it is done (success_condition), the handoffs it waits on (depends_on), a budget (max_attempts) and
// how firmly its agent was chosen (target: strict, the default, never hands it to anyone else; prefer_minutes lets it
// go to any AI once the preference runs out). Every write raises its revision.
// - Each take opens an attempt with a new generation (the fencing number) and a hold; a write naming an older
//   generation is refused, so an attempt whose hold ran out cannot finish or change work another attempt now holds.
//   Renewing a hold proves the holder is still there, not that the work moved.
// - Every unfinished handoff has exactly one next step (nextStepOf): a live attempt, a due review, handoffs it waits
//   on, or something in the way with a way out. reconcile(), the store's scheduler source, keeps that true: an
//   expired hold goes back to waiting (or is stopped when its attempts are spent), a preference that ran out lets any
//   AI take it, a strict agent that stopped taking work leaves the job stuck with its reason instead of passing it on,
//   waiting work is announced again with backoff a bounded number of times, and a row with no next step is repaired.
//   A wake reads at most RECONCILE_PAGE handoffs in total: due reviews (store.dueReviews) and at least one open
//   handoff after the mark the store keeps (store.reviewMark), wrapping to the start. The cost of a wake stays
//   bounded however much work is open, and the open-list cursor advances even when reviews stay due.
// - An effect (a payment, a post, a file written somewhere) has a stable effect_id apart from the attempt. It is
//   recorded as starting before it is done; if the attempt ends with it still starting, it becomes unknown, and an
//   unknown or done effect is never started again: someone checks the target and records what happened.
//
// Saved instructions are what a person (or any of their AIs) wants done with things they send: ready-made job words
// any client offers when handing work off, so nobody starts from a blank box. An account that saved none reads the
// starters it is given (DATA: records/saved-instruction-starters.json); saving a list replaces them for that account.
// The list is a tree the person arranges like any other list: a row is an instruction { id, label, words } or a folder
// { id, label, kind: 'folder' }, and either may sit in a folder (`folder`: that folder's id). Rows keep the order they
// are given in among their siblings, so moving one is saving the list in its new order. An instruction may also start a
// workflow on what is sent (`workflow: { workflow_id, input }`, src/share-destinations.mjs fills and starts it), so a
// method the account can run is one more row of the same list.
//
// store: each card and each handoff is kept as one current copy, and open work is read apart from finished work, so
// taking work costs what is open now, never the account's whole history:
//   { card(id), putCard(card) (keeping cardColumnsOf(card) beside it), cards() -> every card (screens and searches only),
//     cardIdsOf({ reader, takes_work }) -> the ids of the cards a reader published (only those taking work when
//     takes_work), takerIds() -> the ids of cards taking work for no one chat, cardsForSource(source_id) -> the cards
//     taking work for one chat, reachableCards() -> the cards with a delivery address, anyTaker() -> whether any card
//     takes work, each read from its column (cardQueriesOver answers them over a host's own cards()),
//     handoff(id), putHandoff(handoff) (keeping jobColumnsOf(handoff) beside it), openHandoffs({ after, limit }?) -> oldest
//     first (a page after the handoff named by after, or all), newestOpen(limit), heldBy(agent_id), openAddressedTo(agent_id),
//     unaddressedForSource(source_id), dependentsOf(handoff_id), pendingAddressedTo(agent_ids, limit) -> each the open
//     work with that one fact, read from its column; waitingCount(agent_id, { most? }) -> how many jobs wait for it by name (at most `most`);
//     openQueue({ to_agent, nowIso, after, limit }) -> a page of open work in the order it is taken (highest priority,
//     then oldest), after the handoff named by after: addressed to to_agent, or without it the work any agent may take
//     (addressed to nobody, or to an agent only preferred until before nowIso), or with `takeable` ({ source_id }) only the
//     part of it that agent may take now, from the facts takeFactsOf keeps (see takeable below);
//     takeable?: { ready() -> whether every open job has its take facts, step() -> gives the next few open jobs theirs,
//     lapsed({ to_agent, nowIso, limit }) -> at most limit open jobs for to_agent whose take_by has passed, from an
//     index on take_by, earliest() -> the earliest take_by of any open job, one key read, addressee({ from, after }) -> the
//     addressees holding open work with a take_by, one at a time }, which a store that keeps those facts offers; nextReviewAt(nowIso) -> the earliest review_at that
//     reviewOf keeps for open work whose waits_on are all finished ('' is nowIso), or null; dueReviews(nowIso, limit) -> at
//     most limit of that open work whose review_at has fallen due by nowIso ('' first, then oldest review_at), read from
//     the same review column, never open work whole; reviewMark() -> the handoff_id the reconciler's last slice of open
//     work ended at, or null, and putReviewMark(id | null), kept by the store between wakes; handedOnFrom(id),
//     handedOnFromMany(ids) -> Map<parent id, ordered children>, handedOnIdsFromMany(ids) -> Map<parent id, ordered child ids>,
//     handedOnMetadataFromMany(ids) -> Map<parent id, ordered child identity/time facts>, newestHandoffs(limit) (it,
//     fromMessage and handedOnFromMany take { taskMap: true } for only what the task map draws of each job),
//     finishedHandoffs({ before, limit }) -> finished work newest first, after the handoff named by before,
//     notificationWork({ limit, since, exclude_from }) -> eligible work by its notification event time, at most limit,
//     savedInstructions() -> list | null, putSavedInstructions(list),
//     deliverySecret(agent_id), putDeliverySecret(agent_id, secret), delivery(event_id), putDelivery(item),
//     dueDeliveries(nowIso) -> oldest first, deadDeliveries(agent_id), deliveriesFor(subject_id), waitingFor(agent_id),
//     nextDeliveryAt() }
import { handoffProjection, projectHandoff } from './handoff-projection.mjs';
import { MAX_RESEND_REQUESTS, deliverDue, deliveryAddress, deliveryHolds, eventFrom, handoffEvent, MAX_WAITING, newDeliverySecret, outward as deliveryOutward, reachabilityOf } from './agent-delivery.mjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import workSources from './work-sources.json' with { type: 'json' };
import provenance from './saved-instruction-provenance.json' with { type: 'json' };
import timeBudget from './work-time-budget.json' with { type: 'json' };
import { progressOfParts } from '../../keep-and-wake-ai-sessions-on-this-computer/src/work-progress.mjs';
import { seenAt } from './carried-connections.mjs';
// How long a job is held, how far renewing can stretch one attempt, and how long a capacity report lasts (DATA).
import workHolds from './work-holds.json' with { type: 'json' };
import agentSurface from './agent-surface.json' with { type: 'json' };
import ownAisSettings from './own-ais.json' with { type: 'json' };
import { needsOf } from './own-ais.mjs';
import aiSideWork from './ai-side-work.json' with { type: 'json' };
import { titleOf } from './work-title.mjs';
import { WorkFailure, effectOutcome, lockWhileUnknown } from './failure.mjs';
import { schemaProblems } from './typed-operation-contract.mjs';
import loopGuard from './agent-loop-guard.json' with { type: 'json' };

// An effect still in the way of finishing, withdrawing or closing work: one starting now, or one left unknown that the
// person has not released by speaking since (src/effect-outcomes.json). A released effect stays unknown in the record.
const unsettledEffect = effect => effect.state === 'starting' || (effect.state === 'unknown' && !effect.released_by_person);
// The unknown effect that leaves its holder only looking (lock_while_unknown), or null.
const lockingEffect = item => (lockWhileUnknown() ? Object.values(item.effects ?? {}).find(effect => effect.state === 'unknown' && !effect.released_by_person) ?? null : null);

export class AgentsError extends WorkFailure {
  constructor(message, next_call = null, options = {}) { super('request-refused', message, options); this.next_call = next_call; }
}

const MAX_CARDS = 20;
// The most characters a handoff's result_shape may take, a schema of what finishing it says.
const RESULT_SHAPE_MAX = 8000;
// The purpose of the default workflow an AI that takes work runs it through (take_work points at it as coordinate_with):
// whichever of Trillion's own workflows claims it in `default_for`.
const COORDINATE_PURPOSE = 'coordinate-work-with-cheapest-capable-agents';
const MAX_LISTED = 20;
const BOARD_PAGE = 50;
const MAX_BOARD_PAGE = 200;
// The most bytes of jobs one board page carries. A page whose jobs would pass it ends early and names where to read on
// (next_before), so 200 open jobs, each with its whole words, inputs and attempts, never come as one answer of megabytes.
const BOARD_PAGE_BYTES = 150_000;
// Where the finished work starts when a page ended inside the open work before any finished job was shown.
const FINISHED_FIRST = 'finished-first';
// The longest words of what came of a job on the rows the AI work screen draws.
const SCREEN_SUMMARY_MAX = 400;

/** How many of the first rows fit in `limit` bytes; the first always does, so a page is never empty. */
function rowsFitting(rows, limit = BOARD_PAGE_BYTES) {
  let bytes = 0;
  for (let index = 0; index < rows.length; index += 1) {
    bytes += JSON.stringify(rows[index]).length;
    if (bytes > limit && index) return index;
  }
  return rows.length;
}
// Work the person's own screens never list (src/ai-side-work.json).
const AI_SIDE_ONLY = new Set(aiSideWork.from_agents);
const forPerson = item => !AI_SIDE_ONLY.has(item.from_agent);
// The most of a job's own words Home's workstreams card is sent (board fields=home).
const HOME_JOB_CHARS = 240;
const MAX_INSTRUCTIONS = 200;
const INSTRUCTION_WORDS_MAX = 2000;
const INSTRUCTION_LABEL_MAX = 120;
const FOLDER = 'folder';
// At most this many jobs wait for one agent by name; beyond it the asker is told to pick another agent or hand the
// work to anyone (a named agent that never takes work cannot collect an endless pile).
const MAX_WAITING_FOR_ONE = 50;
// How many steers (later words to work already running) one job keeps.
const MAX_STEERS = 20;
// A full background queue still admits a few urgent jobs; they are taken first, and both limits stay finite.
const PRIORITY_WAITING_RESERVE = 5;
// In-memory asks (invariant above): an answered one is kept this long for its asker, and at most this many at once.
const ASK_KEPT_MS = 10 * 60_000;
const MAX_ASKS = 500;
// The longest an asker may say it waits for work to be taken (take_within_seconds): one day.
const MAX_TAKE_WITHIN_SECONDS = 86_400;
// Priority is 0 (when left out) to 9; higher is taken first, and equal priorities keep their order of arrival.
export const MAX_PRIORITY = 9;
// The events a helper takes in one pull, and the agents one stream carries (a socket holds at most 10 names).
export const MAX_PULLED = 50;
const MAX_STREAM_AGENTS = 10;
// Waiting work is looked at again after FIRST_REVIEW_MINUTES, then twice as long each time up to LAST_REVIEW_MINUTES;
// the agents that could take it are woken again at most MAX_WAKES times, after which only the review goes on.
const FIRST_REVIEW_MINUTES = 15;
const LAST_REVIEW_MINUTES = 6 * 60;
const MAX_WAKES = 5;
const MAX_ATTEMPTS = 20;
const MAX_ATTEMPTS_KEPT = 50;
const MAX_EFFECTS = 100;
const MAX_DEPENDS_ON = 20;
// Something in the way that Trillion itself found (not an AI), so Trillion also clears it when it is gone.
const BY_TRILLION = 'trillion';
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'some', 'can', 'any', 'you', 'its', 'are', 'what', 'who']);

const identity = value => `1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(value))))}`;
const words = value => [...new Set(String(value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 2 && !STOP.has(word)))];
const text = (value, label, max = 2000) => {
  if (typeof value !== 'string' || !value.trim()) throw new AgentsError(`${label} is needed.`);
  return value.trim().slice(0, max);
};
// The longest `said` an asker may give: the work as the person sees it (their notifications, AI work), never the job.
// Work handed off without one keeps the short title src/work-title.mjs derives from its job.
const SAID_MAX = 300;
// How many open handoffs one pass of titleOpenWork reads.
const TITLE_PAGE = 100;
const optionalText = (value, max = 2000) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The Workshop placements an agent runs tools for (`runs`), for example placement:caller-sandbox.
function runsFrom(runs) {
  if (!Array.isArray(runs) || runs.length > 20 || !runs.every(item => typeof item === 'string' && item.trim() && item.length <= 200)) throw new AgentsError('runs is a list of at most 20 placement ids this agent runs Marketplace tools for, for example placement:caller-sandbox.');
  return [...new Set(runs.map(item => item.trim()))];
}
const priorityOf = value => {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || value < 0 || value > MAX_PRIORITY) throw new AgentsError(`priority is a whole number from 0 to ${MAX_PRIORITY}; higher is taken first.`);
  return value;
};
// Highest priority first; equal priorities keep the order they came in (the store's own order).
const byPriority = items => items.map((item, index) => [item, index]).sort(([a, i], [b, j]) => (b.priority ?? 0) - (a.priority ?? 0) || i - j).map(([item]) => item);

function skillsFrom(skills) {
  if (skills === undefined) return [];
  if (!Array.isArray(skills)) throw new AgentsError('skills is a list: each a short phrase, or { id, name, description }.');
  return skills.slice(0, 50).map(skill => {
    if (typeof skill === 'string') return { name: text(skill, 'A skill', 200) };
    if (!object(skill)) throw new AgentsError('Each skill is a short phrase or { id, name, description }.');
    return { ...(optionalText(skill.id, 200) ? { id: optionalText(skill.id, 200) } : {}), name: text(skill.name, 'A skill\'s name', 200), ...(optionalText(skill.description) ? { description: optionalText(skill.description) } : {}) };
  });
}

const skillKey = skill => skill.id ?? skill.name;

// Where a job is: its state, except that open or taken work an AI said something is in the way of is stuck.
export const statusOf = handoff => (handoff.state === 'finished' && handoff.withdrawal ? 'withdrawn' : handoff.state !== 'finished' && handoff.in_the_way ? 'blocked' : handoff.state);

// The latest one attempt may hold its job, however often it renews the hold: its hold_minutes times longest_hold_times
// from when it was taken (DATA: work-holds.json). Renewing proves the AI is still there, not that the work moved.
const longestHoldOf = item => new Date(Date.parse(item.taken_at) + (item.hold_minutes ?? workHolds.default_hold_minutes) * workHolds.longest_hold_times * 60_000).toISOString();
// When a taken job's hold ends: when it runs out, or at the longest the attempt may be held, whichever comes first.
export const holdEndOf = item => (item.taken_at && longestHoldOf(item) < item.hold_until ? longestHoldOf(item) : item.hold_until);
// The one test of whether an attempt still holds its job; every reader of a hold asks this.
export const holding = (item, nowIso) => item.state === 'taken' && holdEndOf(item) > nowIso;
// Whether the holder is working on it: a held job with something in the way (said by its holder, or kept from a finish
// that was reopened as wrong) is stuck, not being worked on, so it takes none of the holder's slots.
const workingOn = (item, agent_id, nowIso) => item.taken_by === agent_id && holding(item, nowIso) && !item.in_the_way;

// The one next step of an unfinished handoff, or null when it has none (the reconciler repairs that). `waitingOn` is
// the handoffs it depends on that are not finished yet.
export function nextStepOf(handoff, { nowIso, waitingOn = [] }) {
  if (!handoff || handoff.state === 'finished') return null;
  if (holding(handoff, nowIso)) return { kind: 'attempt', agent_id: handoff.taken_by, generation: handoff.generation ?? 0, until: holdEndOf(handoff) };
  if (handoff.in_the_way) return { kind: 'blocked', reason: handoff.in_the_way, by: handoff.in_the_way_by ?? null, recovery: handoff.recovery ?? 'The AI that said it clears it with say_what_is_in_the_way null, or finishes the work.', ...(handoff.review_at ? { checked_again_at: handoff.review_at } : {}) };
  if (waitingOn.length) return { kind: 'dependency', on: waitingOn, resume: 'It can be taken when each of these is finished.' };
  if (handoff.state === 'taken') return { kind: 'due', at: holdEndOf(handoff), what: 'The hold ran out; it goes back to waiting.' };
  if (handoff.review_at) return { kind: 'due', at: handoff.review_at, what: 'Trillion looks at it again: who can take it, and whether to wake them.' };
  return null;
}

// When work that came from a chat, and is handed to no agent by name, may be taken by any of the person's own AIs:
// after the source has been silent for its configured window. The newest transcript row or source heartbeat is
// source_active_at; a carrier whose place has no resumable chat says 0 on the arrival. null for non-chat work.
// The item a piece of work is about: its once_per, else the message or button press it arrived from.
export const itemOf = ({ once_per = null, input = null } = {}) => once_per ?? input?.arrived?.message_id ?? input?.arrived?.asked_id ?? null;

// The handoff a request key names: the same key always names the same handoff, so a share kept under its request key
// can say which AI work it became (src/share-destinations.mjs).
export const handoffIdFor = request_key => `h_${identity(request_key).slice(3, 27)}`;

// What an arrival says about who the work waits for (anyoneFrom reads exactly these): a later hand of the same item
// never changes it (joined).
const OWNER_FACTS = ['source_id', 'chat_silence_minutes', 'chat_first_minutes'];

// Given the card of the AI a job is named to (null when it has none), work not pinned strict: true also opens once
// that AI has not been seen for DATA named_agent_unseen_minutes after the later of the hand-off and its last sighting,
// so nothing waits forever for an AI that never comes. Without a card (callers that only know the job) named work
// answers null as before.
export function anyoneFrom(handoff, card) {
  const arrived = handoff?.input?.arrived;
  if (handoff?.to_agent) {
    if (card === undefined || handoff.target?.strict === true || !handoff.handed_at) return null;
    const seen = [handoff.handed_at, card && seenAt(card)].map(value => (typeof value === 'string' ? Date.parse(value) : NaN)).filter(Number.isFinite);
    return new Date(Math.max(0, ...seen) + workSources.named_agent_unseen_minutes * 60_000).toISOString();
  }
  if (!arrived?.source_id || !handoff.handed_at) return null;
  const own = arrived.chat_silence_minutes ?? arrived.chat_first_minutes;
  const minutes = typeof own === 'number' && Number.isFinite(own) && own >= 0 ? own : workSources.chat_silence_minutes;
  // The newest kept time that reads as a time; a job whose times cannot be read waits for no chat (nothing waits
  // forever for a closed chat), so any AI may take it at once.
  const activeAt = [handoff.source_active_at, handoff.handed_at].map(value => (typeof value === 'string' ? Date.parse(value) : NaN)).find(Number.isFinite);
  return new Date(activeAt === undefined ? 0 : activeAt + minutes * 60_000).toISOString();
}

// The owner of a chat that is woken first when several cards own it: the one published last.
export const newestOwner = owners => owners.reduce((newest, card) => (!newest || String(card.published_at ?? '') > String(newest.published_at ?? '') ? card : newest), null);

/** Exact cards referenced by work, optionally including indexed owners of its source chats. */
export function workAgentCards(store, work, { sourceOwners = false } = {}) {
  const ids = new Set(work.flatMap(item => [item.from_agent, item.to_agent, item.taken_by, item.preferred_agent, item.in_the_way_by])
    .filter(id => typeof id === 'string' && id));
  const cards = new Map(store.cardsById([...ids]).map(card => [card.agent_id, card]));
  if (sourceOwners) {
    const sources = new Set(work.map(item => item.input?.arrived?.source_id).filter(source => typeof source === 'string' && source));
    for (const source of sources) for (const card of store.cardsForSource(source)) cards.set(card.agent_id, card);
  }
  return [...cards.values()];
}

// What a caller sees of a handoff: every field it can act on, nothing about storage.
const outward = (handoff, next_step) => handoff && ({
  handoff_id: handoff.handoff_id, state: handoff.state, status: statusOf(handoff), job: handoff.job, said: titleOf(handoff), input: handoff.input,
  to_agent: handoff.to_agent, from_agent: handoff.from_agent, case_id: handoff.case_id, parent_handoff_id: handoff.parent_handoff_id,
  handed_at: handoff.handed_at, priority: handoff.priority ?? 0, ...(handoff.source_active_at ? { source_active_at: handoff.source_active_at } : {}),
  taken_by: handoff.taken_by, taken_at: handoff.taken_at, hold_until: handoff.hold_until,
  finished_at: handoff.finished_at, result: handoff.result, summary: handoff.summary, notice: handoff.notice ?? null,
  take_by: handoff.take_by ?? null,
  in_the_way: handoff.in_the_way ?? null, in_the_way_by: handoff.in_the_way_by ?? null, in_the_way_at: handoff.in_the_way_at ?? null,
  corrections: handoff.corrections ?? [],
  ...(handoff.released_because !== undefined ? { released_because: handoff.released_because } : {}),
  ...(handoff.withdrawal ? { withdrawal: handoff.withdrawal } : {}),
  ...(handoff.state === 'open' && handoff.closing ? { closure: {
    by: handoff.closing.by, intent: handoff.closing.intent, started_at: handoff.closing.started_at,
    last_error: handoff.closing.last_error ?? null,
    retry: { path: '/handoffs/close-many', body: { by: handoff.closing.by,
      items: handoff.closing.group_admission?.items ?? [{ handoff_id: handoff.handoff_id, ...handoff.closing.intent }] } },
  } } : {}),
  revision: handoff.revision ?? 0, generation: handoff.generation ?? 0,
  outcome: handoff.outcome ?? null, success_condition: handoff.success_condition ?? null, ...(handoff.result_shape ? { result_shape: handoff.result_shape } : {}), ...(handoff.done_when_rule ? { done_when_rule: handoff.done_when_rule } : {}), depends_on: handoff.depends_on ?? [],
  max_attempts: handoff.max_attempts ?? MAX_ATTEMPTS, ...(handoff.time_budget_seconds ? { time_budget_seconds: handoff.time_budget_seconds, time_used_seconds: secondsUsed(handoff) } : {}), target: handoff.target ?? null, preferred_agent: handoff.preferred_agent ?? null,
  attempts: handoff.attempts ?? [], effects: Object.values(handoff.effects ?? {}),
  ...(handoff.steers?.length ? { steers: handoff.steers } : {}),
  ...(next_step !== undefined ? { next_step } : {}),
  ...(anyoneFrom(handoff) ? { anyone_from: anyoneFrom(handoff) } : {}),
  ...(handoff.input?.arrived?.source_id ? { source_return: handoff.source_return ?? { verified: false,
    source_id: handoff.input.arrived.source_id,
    note: 'No verified result from the original chat is recorded for this handoff.' } } : {}),
});

/** The seconds the attempts that ended have held a job. */
export const secondsUsed = handoff => Math.round((handoff.attempts ?? []).reduce((total, attempt) => (attempt.ended_at && attempt.taken_at ? total + Math.max(0, Date.parse(attempt.ended_at) - Date.parse(attempt.taken_at)) / 1000 : total), 0));

// What an asker may say about the work beyond the job: only what it said is kept, so a handoff that says none of it
// keeps the same request identity it always had.
function lifecycleFrom(input, to_agent) {
  const said = {};
  const outcome = optionalText(input.outcome, 2000);
  if (outcome) said.outcome = outcome;
  const success = optionalText(input.success_condition, 2000);
  if (success) said.success_condition = success;
  // What finishing it must say, as a JSON Schema over the result (its fields, or { outcome } for a text result) and
  // summary: the asker's own DATA, checked by finish with the same checker as a workflow step's submit.
  if (input.result_shape !== undefined) {
    if (!object(input.result_shape) || input.result_shape.type !== 'object' || JSON.stringify(input.result_shape).length > RESULT_SHAPE_MAX)
      throw new AgentsError(`result_shape is a JSON Schema with "type": "object" (at most ${RESULT_SHAPE_MAX} characters) for what finishing the work must say, such as its summary and the files that show it.`);
    said.result_shape = input.result_shape;
  }
  // A check of what is true now (src/done-when.mjs { over, match, tree, says }): the asker's own DATA, read fresh by
  // the door before the work may finish, so work whose files, records or connections are not there yet stays open.
  if (input.done_when_rule !== undefined) {
    if (!object(input.done_when_rule) || typeof input.done_when_rule.over !== 'string' || JSON.stringify(input.done_when_rule).length > RESULT_SHAPE_MAX)
      throw new AgentsError(`done_when_rule is a check of what is true now: { over, match, tree, says } (at most ${RESULT_SHAPE_MAX} characters).`);
    said.done_when_rule = input.done_when_rule;
  }
  if (input.depends_on !== undefined) {
    if (!Array.isArray(input.depends_on) || input.depends_on.length > MAX_DEPENDS_ON || !input.depends_on.every(id => typeof id === 'string' && id.trim()))
      throw new AgentsError(`depends_on is a list of at most ${MAX_DEPENDS_ON} handoff ids this work waits for.`);
    if (input.depends_on.length) said.depends_on = [...new Set(input.depends_on.map(id => id.trim()))];
  }
  if (input.max_attempts !== undefined) {
    if (!Number.isInteger(input.max_attempts) || input.max_attempts < 1 || input.max_attempts > MAX_ATTEMPTS) throw new AgentsError(`max_attempts is a whole number from 1 to ${MAX_ATTEMPTS}: how many times the work may be taken before Trillion stops it.`);
    said.max_attempts = input.max_attempts;
  }
  if (input.time_budget_seconds !== undefined) {
    if (!Number.isInteger(input.time_budget_seconds) || input.time_budget_seconds < 1 || input.time_budget_seconds > timeBudget.max_seconds) throw new AgentsError(`time_budget_seconds is a whole number from 1 to ${timeBudget.max_seconds}: the seconds its attempts may hold the job in all.`);
    said.time_budget_seconds = input.time_budget_seconds;
  }
  if (input.target !== undefined) {
    if (!to_agent) throw new AgentsError('target is how firmly to_agent was chosen, so it needs to_agent.');
    if (!object(input.target)) throw new AgentsError('target is { strict: true } (only this agent, the default) or { prefer_minutes } (this agent first, then any AI).');
    const minutes = input.target.prefer_minutes;
    if (input.target.strict === true && minutes === undefined) said.target = { strict: true };
    else if (input.target.strict !== true && Number.isFinite(minutes) && minutes >= 1 && minutes <= 7 * 24 * 60) said.target = { prefer_minutes: minutes };
    else throw new AgentsError('target is { strict: true } or { prefer_minutes } from 1 to 10080, not both.');
  }
  return said;
}

// When the reconciler next has something to do for one handoff, which a store keeps beside it so the next review is
// found from that alone, never by reading open work whole: review_at is the time ('' for now; null when nothing is due
// for it on its own: finished, or in the way of an AI's own making), and waits_on names the handoffs that must all be
// finished before it counts. A handoff held by an AI is looked at when its hold runs out, whatever it waits on.
export function reviewOf(item) {
  if (item.closing || item.state === 'finished' || (item.in_the_way && item.in_the_way_by !== BY_TRILLION)) return { review_at: null, waits_on: [] };
  if (item.state === 'taken') return { review_at: item.hold_until ? holdEndOf(item) : null, waits_on: [] };
  // A wall Trillion found that ends at no known time (no AI taking work, the one AI it is for gone, too many attempts)
  // is looked at again only when a card that could clear it changes (clearWalls), never on a timer: a review that
  // finds the same wall changes nothing, and rewriting the record every six hours to say so was most of a quiet
  // store's writes.
  if (item.in_the_way_by === BY_TRILLION && !item.review_at) return { review_at: null, waits_on: [] };
  return { review_at: item.review_at ?? '', waits_on: item.depends_on ?? [] };
}

// Everything a store keeps beside each handoff, as columns of their own: what the reconciler next does for it
// (reviewOf), the facts the calls that hand, take and finish work ask about one agent or one job (its state, who it
// is addressed to and held by, its priority, until when its addressee is only preferred, the chat it came from and the
// handoffs it depends on), and what one of the person's own AIs weighs to know when a job is due (src/own-ais-routing.mjs dueOf). A store answers those calls from these columns and indexes, never by reading every open job
// whole: on 2026-10-02 each hand_off, take_work and finish_work on Alex's store read all of his open work and held his
// store for 3-4 s. A store adds a column here by its name; JOB_COLUMNS is the list every store keeps.
export function jobColumnsOf(item) {
  const { review_at, waits_on } = reviewOf(item);
  return {
    review_at, waits_on: JSON.stringify(waits_on), state: item.state, to_agent: item.to_agent ?? null, taken_by: item.taken_by ?? null,
    priority: item.priority ?? 0, prefer_until: item.target?.strict === false ? item.target.prefer_until ?? null : null,
    source_id: item.input?.arrived?.source_id ?? null, depends_on: JSON.stringify(item.depends_on ?? []),
    in_the_way: item.in_the_way ? String(item.in_the_way) : null, blocked_kind: item.blocked_kind ?? null, hold_until: item.hold_until ?? null,
    generation: item.generation ?? 0, depth: item.input?.arrived?.depth ?? null, chat_first_minutes: item.input?.arrived?.chat_first_minutes ?? null,
  };
}
export const JOB_COLUMNS = Object.keys(jobColumnsOf({ state: 'open' }));
// The own-AI routing needs a job's timing facts, never its possibly large instructions or result.
// A table can pass its kept columns as `columns`; a record passes the whole item through jobColumnsOf.
export function scheduledHandoffOf(item, columns = jobColumnsOf(item)) {
  return {
    handoff_id: item.handoff_id, handed_at: item.handed_at, state: columns.state,
    to_agent: columns.to_agent, taken_by: columns.taken_by, priority: columns.priority,
    in_the_way: Boolean(columns.in_the_way), in_the_way_by: item.in_the_way_by ?? null,
    in_the_way_at: item.in_the_way_at ?? null, blocked_kind: columns.blocked_kind,
    hold_until: columns.hold_until, generation: columns.generation,
    input: { needs: needsOf(item), arrived: { from_person: item.input?.arrived?.from_person === true, source_id: columns.source_id, depth: columns.depth,
      chat_silence_minutes: item.input?.arrived?.chat_silence_minutes ?? null,
      chat_first_minutes: columns.chat_first_minutes } },
    source_active_at: item.source_active_at ?? null,
    target: columns.prefer_until ? { strict: false, prefer_until: columns.prefer_until } : null,
  };
}
// What one of the own AIs weighs to know when ONE open job is due (src/own-ais-routing.mjs dueOf), kept beside the job so
// the earliest due time is read from an index in due-time order and never from every open job: wake_from is a time the job
// can never be due before whatever the runner's settings say (its handed time, or for work a chat owns the time that
// chat last mattered), and the rest are the facts dueOf reads. Finished work has none (it is never due). A fact with no
// value is '' (silence -1), since an index entry exists only for values.
export function wakeFactsOf(item) {
  if (item.state === 'finished') return {};
  const arrived = item.input?.arrived;
  // Work the own AIs never take whatever time passes (deeper than max_depth; marked in the way by Trillion with a kind
  // it is not for, or by another AI) has no wake entry, only `wake_checked`: the clock walks entries to find the earliest
  // due, and work that is never due would be walked on every ask for as long as it stays open.
  // Addressed to an AI strictly, or preferred for one until a time that has not come: only a preferred job is indexed, at
  // the time its preference lapses, under no addressee (wake_to ''), so the routing reads it with the unaddressed work.
  const preferred = item.to_agent && item.target?.strict === false ? item.target.prefer_until : null;
  const parked = (arrived?.depth ?? 0) > ownAisSettings.max_depth
    || (item.to_agent && !preferred)
    || (item.in_the_way && !String(item.in_the_way_by ?? '').startsWith(ownAisSettings.agent_id_prefix) && !ownAisSettings.takes_when_marked.includes(item.blocked_kind));
  if (parked) return { wake_checked: 1 };
  const handedAt = Date.parse(item.handed_at);
  const activeAt = [item.source_active_at, item.handed_at].map(value => (typeof value === 'string' ? Date.parse(value) : NaN)).find(Number.isFinite);
  const owned = !item.to_agent && arrived?.source_id && activeAt !== undefined;
  const own = arrived?.chat_silence_minutes ?? arrived?.chat_first_minutes;
  // Work taken and held is never due before its hold ends (dueOf), so its wake entry sorts at that time: a walk in
  // due-time order stops before every job still held, instead of reading each one on every ask (2026-10-09: one store's
  // own-AI runs read ~43,000 rows each, every 25 s, walking work other AIs held). Taking or renewing a hold writes
  // the job, so the entry moves with it; an older entry keyed by its handed time stays a correct, earlier bound.
  const heldUntil = item.state === 'taken' && typeof item.hold_until === 'string' ? Date.parse(item.hold_until) : NaN;
  const preferUntil = preferred ? Date.parse(preferred) : NaN;
  const from = Number.isFinite(handedAt) ? Math.max(owned ? Math.max(handedAt, activeAt) : handedAt, Number.isFinite(heldUntil) ? heldUntil : 0, Number.isFinite(preferUntil) ? preferUntil : 0) : NaN;
  return {
    wake_checked: 1, wake_to: '', prefer_until: preferred ?? '',
    wake_from: Number.isFinite(from) ? new Date(from).toISOString() : '',
    generation: item.generation ?? 0, hold_until: item.hold_until ?? '', in_the_way: item.in_the_way ? 1 : 0,
    in_the_way_by: item.in_the_way_by ?? '', in_the_way_at: item.in_the_way_at ?? '', blocked_kind: item.blocked_kind ?? '',
    depth: arrived?.depth ?? '', active_at: typeof item.source_active_at === 'string' ? item.source_active_at : '',
    from_person: arrived?.from_person === true ? 1 : 0,
    silence: typeof own === 'number' && Number.isFinite(own) && own >= 0 ? own : -1,
  };
}
// What take asks of ONE job addressed to nobody, kept beside it for the same reason (src/agent-records.mjs takeable): the
// first job an agent may take is read from an index in the order it is taken, so the work it cannot take (stuck, waiting
// on other work, held, or a chat's still inside its silence window) is never walked and never read. `takes` says the
// facts are kept. A job take may offer (not closing, nothing in the way, not named to an agent, not waiting on work still
// open as of its last write: waits_open) has take_from, the time any agent may take it (its hold has ended, and for work a
// chat owns, its silence window has: anyoneFrom), and take_source / own_from for the owners of that chat, who may take it
// once its hold has ended, whatever the silence window. take_by is when the asker stops waiting, kept for open work only.
// A fact with no value is absent, since an index entry exists only for values. These are what the live checks in take
// start from, never a replacement: a job read for taking is checked again (available, belongsHere).
export function takeFactsOf(item) {
  if (item.state === 'finished') return {};
  const facts = { takes: 1, ...(item.state === 'open' && !item.closing && typeof item.take_by === 'string' ? { take_by: item.take_by } : {}) };
  if (item.to_agent || item.closing || item.in_the_way || item.waits_open) return facts;
  const source = item.input?.arrived?.source_id;
  const held = item.state === 'taken' && typeof holdEndOf(item) === 'string' ? holdEndOf(item) : '';
  const anyone = source ? anyoneFrom(item) ?? '' : '';
  return { ...facts, take_from: anyone > held ? anyone : held, ...(source ? { take_source: source, own_from: held } : {}) };
}
// Where ONE job waits in the account's own records for an agent that asks for its next job without naming one, when
// the job is kept in another of the account's work resources (src/agent-work-queue.mjs): the agent it is addressed to
// ('' for any agent) and from when a take may offer it (its hold has ended and, for work a chat owns, its silence
// window has: take_from in takeFactsOf), or null for work no such take offers (finished, closing, in the way, or
// waiting on work still open). A job read for taking is checked again by take where it is kept.
export function queueFactsOf(item) {
  if (item.state === 'finished' || item.closing || item.in_the_way || item.waits_open) return null;
  const held = item.state === 'taken' && typeof holdEndOf(item) === 'string' ? holdEndOf(item) : '';
  const anyone = !item.to_agent && item.input?.arrived?.source_id ? anyoneFrom(item) ?? '' : '';
  return { agent_id: item.to_agent ?? '', available_at: anyone > held ? anyone : held };
}
// The facts agent cards are found by, kept as their own columns beside each card for the same reason: an account
// gathers a card per chat that ever published (322 on Alex's store), and every hand-off, publish, take and review
// asked about them by reading every card whole.
export function cardColumnsOf(card) {
  return { reader: card.reader ?? null, takes_work: card.takes_work ? 1 : 0, source_id: card.source_id ?? null, reaches: card.delivery ? 1 : 0 };
}
export const CARD_COLUMNS = Object.keys(cardColumnsOf({}));
// The same questions answered over a host's own cards(), for a host whose cards are few (a space, a test).
export function cardQueriesOver(cards) {
  const where = test => cards().filter(test);
  return {
    cardIdsOf: ({ reader, takes_work = false }) => where(card => card.reader === reader && (!takes_work || card.takes_work)).map(card => card.agent_id),
    cardsById: ids => { const wanted = new Set(ids); return where(card => wanted.has(card.agent_id)); },
    takerIds: () => where(card => card.takes_work && !card.source_id).map(card => card.agent_id),
    cardsForSource: source => where(card => card.takes_work && card.source_id === source),
    reachableCards: () => where(card => card.delivery),
    anyTaker: () => cards().some(card => card.takes_work),
  };
}
// Other agent reads and deliveries page up to this many handoffs.
const REVIEW_PAGE = 100;
// How many jobs one look at the work any agent may take reads whole, and how many whose asker stopped waiting one take lets go of.
const TAKE_PAGE = 4;
const LAPSE_PAGE = 20;
// Reconciliation runs on the same PersonStore that grants public file bytes. Keep each synchronous review turn short;
// the cursor and due-review index carry the remaining work into subsequent alarms.
const RECONCILE_PAGE = 25;

// The starter instructions as rows `{ id, payload: { label, words, workflow?, folder? } }` or folders
// `{ id, payload: { kind: 'folder', label, folder? } }` (records/saved-instruction-starters.json) become the list shape
// every client reads, checked as a saved list is.
export const startersFrom = rows => instructionsFrom((rows?.records ?? rows ?? []).map(row => ({ id: row.id, ...row.payload })));

// Who wrote a saved instruction (src/saved-instruction-provenance.json): the writer's reader decides its class, a row
// keeps the origin it was first written with until its words, label, folder or workflow change, and with
// agent_rows_start_proposed an agent's row waits as `proposed` until the person writes it with proposed false. When the
// list written over is not known (a saved list not yet kept over starters an asynchronous provider has not given),
// nothing is held: the row only records its origin.
export function stampOrigins(rows, written, previous, reader, nowIso, rules = provenance, importedFrom = null) {
  const writerClass = rules.reader_classes.find(row => typeof reader === 'string' && reader.startsWith(row.reader_prefix))?.class ?? rules.default_class;
  const before = new Map((previous ?? []).map(row => [row.id, row]));
  const same = (a, b) => a && b && ['label', 'words', 'kind', 'folder'].every(key => (a[key] ?? null) === (b[key] ?? null)) && JSON.stringify(a.workflow ?? null) === JSON.stringify(b.workflow ?? null);
  // A row with no origin is the person's: only another class of writer is recorded.
  // A row brought in from somewhere (importedFrom) always says where, whoever brought it.
  const originOf = () => (writerClass === rules.default_class && !importedFrom ? {} : { origin: { class: writerClass, by: reader ?? null, at: nowIso, ...(importedFrom ? { imported_from: importedFrom } : {}) } });
  return rows.map((row, index) => {
    const { origin: _origin, proposed: _proposed, ...plain } = row;
    const earlier = before.get(row.id);
    const confirms = writerClass === rules.default_class && object(written[index]) && written[index].proposed === false;
    if (same(earlier, plain)) {
      if (confirms) return plain;
      return { ...plain, ...(earlier.origin ? { origin: earlier.origin } : {}), ...(earlier.proposed === true ? { proposed: true } : {}) };
    }
    const held = previous !== null && writerClass !== rules.default_class && rules.agent_rows_start_proposed === true;
    return { ...plain, ...originOf(), ...(held ? { proposed: true } : {}) };
  });
}

function instructionsFrom(list) {
  if (!Array.isArray(list)) throw new AgentsError('instructions is a list: each { label, words } and optionally id and folder, or a folder { label, kind: "folder" }.');
  if (list.length > MAX_INSTRUCTIONS) throw new AgentsError(`At most ${MAX_INSTRUCTIONS} saved instructions and folders.`);
  const seen = new Set();
  const rows = list.map(item => {
    if (!object(item)) throw new AgentsError('Each saved instruction is { label, words } and optionally id and folder; a folder is { label, kind: "folder" }.');
    const isFolder = item.kind === FOLDER;
    // Over its budget a row is refused saying exactly how much to take out, never cut short without telling anyone.
    for (const [field, most] of isFolder ? [['label', INSTRUCTION_LABEL_MAX]] : [['words', INSTRUCTION_WORDS_MAX], ['label', INSTRUCTION_LABEL_MAX]]) {
      const over = typeof item[field] === 'string' ? item[field].trim().length - most : 0;
      if (over > 0) throw new AgentsError(`${item.label ?? item.id ?? 'This saved instruction'}: ${field} is ${over} characters over its ${most}-character limit. Shorten it by ${over} and save again.`);
    }
    const said = isFolder ? null : text(item.words, 'words (what the AI should do with what is sent)', INSTRUCTION_WORDS_MAX);
    const label = isFolder ? text(item.label, 'label (the folder\'s name)', 120) : optionalText(item.label, 120) ?? said.slice(0, 120);
    let id = optionalText(item.id, 100) ?? (words(label).slice(0, 6).join('-') || identity(said ?? label).slice(3, 15));
    while (seen.has(id)) id = `${id}-${seen.size}`;
    seen.add(id);
    const folder = optionalText(item.folder, 100);
    const workflow = isFolder || item.workflow === undefined || item.workflow === null ? null : workflowOf(item.workflow, label);
    return { id, label, ...(isFolder ? { kind: FOLDER } : { words: said }), ...(workflow ? { workflow } : {}), ...(folder ? { folder } : {}) };
  });
  // A row sits in a folder of this list, and no folder sits inside itself.
  const folders = new Map(rows.filter(row => row.kind === FOLDER).map(row => [row.id, row]));
  for (const row of rows) {
    if (row.folder === undefined) continue;
    if (!folders.has(row.folder)) throw new AgentsError(`${row.label} is in the folder ${row.folder}, which is not a folder in this list.`);
    for (let at = row.folder, steps = 0; at !== undefined; at = folders.get(at)?.folder, steps += 1) {
      if (at === row.id || steps > folders.size) throw new AgentsError(`${row.label} cannot sit inside itself.`);
    }
  }
  return rows;
}

// The workflow an instruction starts: { workflow_id, input }, input an object whose values may be filled from what is
// sent ({ "fill": { "from": "share", "field": "words" } }); the workflow and its input are checked when something is
// sent with it, since the workflows an account can find change on their own.
function workflowOf(value, label) {
  if (!object(value) || !optionalText(value.workflow_id, 200) || (value.input !== undefined && !object(value.input))) {
    throw new AgentsError(`${label}: workflow is { workflow_id, input }, workflow_id from find_workflow and input an object.`);
  }
  return { workflow_id: value.workflow_id.trim(), ...(value.input ? { input: structuredClone(value.input) } : {}) };
}

/** The instructions of a saved list in the order a person reads its tree (each folder's own instructions, then the
 *  folders inside it, each in the order they are arranged), each with `folder` (its folder's id, or null). Folders are
 *  left out, so the first instruction is the first one at the top. */
export function instructionsInTreeOrder(list) {
  const children = new Map();
  for (const row of list) children.set(row.folder ?? null, [...(children.get(row.folder ?? null) ?? []), row]);
  const ordered = [];
  const walk = (folder, path) => {
    const rows = children.get(folder) ?? [];
    for (const row of rows) if (row.kind !== FOLDER && row.proposed !== true) ordered.push({ id: row.id, label: row.label, words: row.words, ...(row.workflow ? { workflow: row.workflow } : {}), folder: row.folder ?? null });
    for (const row of rows) if (row.kind === FOLDER && !path.has(row.id)) walk(row.id, new Set(path).add(row.id));
  };
  walk(null, new Set());
  return ordered;
}

/** The folders of a saved list, in their order, each { id, label, folder } (folder: the folder it sits in, or null). */
export const instructionFolders = list => list.filter(row => row.kind === FOLDER).map(row => ({ id: row.id, label: row.label, folder: row.folder ?? null }));

// `addressed(said, handoff)` lets a host that keeps agents somewhere other than one account (a space,
// src/spaces.mjs) say where a handoff event points, for example its own tools in next_call; it returns the event's
// `said` shape (src/agent-delivery.mjs eventFrom).
// `tell({ moment, handoff, for_reader, from_reader })` hears each handoff an AI should be told about on its next reply
// (never work from a sender listed in src/ai-side-work.json):
// moment waiting (addressed to the agent's reader), waiting_for_anyone (no agent named) or finished (to the reader that
// handed it off). A reader is the text the host names the calling app or key with; a card keeps the reader that last
// published or took work as it, so work for an AI that is asleep can wait for that AI. The handoff is kept before
// `tell` runs, and a failure in `tell` never undoes it.
// `onFinished(handoff)` hears every handoff that finishes, after it is kept, and may hand on more work through the
// returned handOff (src/team-review.mjs advances a review this way); a failure there never undoes the finish.
// onWithdrawn hears terminal withdrawal separately so consumers can stop without invoking success hooks.
// checkFinish is the host owner's synchronous final-write check for work backed by another durable queue.
// `stream` is the store's live socket for agents on the stream route: send(agent_id, event) hands an event to the
// helper holding that agent's stream (false when none is open) and live(agent_id) says whether one answers now.
// nudge() tells the account's live connections that an in-memory ask waits for a taker, with no event and no write.
// `onConnected(card)` hears a card published by an agent that was not present (its first card, or its first after being
// away), after the card is kept; a computer connecting runs the samples the account's tools owe it there
// (src/workshop.mjs settleOwedSamples). A failure there never undoes the publish.
export function makeAgents({ store, stream = { send: () => false, live: () => false }, starters = [], now = () => new Date(), addressed = said => said, tell = () => {}, onFinished = () => {}, onWithdrawn = () => {}, onConnected = () => {}, checkFinish = () => {}, canTake = () => true, listed = () => true }) {
  const at = () => now().toISOString();
  const card = id => store.card(id);
  // In-memory asks by id, and the ids of the events that announced them (ack answers those without a delivery record).
  const asks = new Map();
  const askEvents = new Set();
  const handoff = (id, projection = null) => asks.has(id) ? projectHandoff(asks.get(id), handoffProjection(projection)) : store.handoff(id, { projection });
  // Whether an agent can be reached right now, from the route it published and, for the stream route, its socket.
  const reach = agent => reachabilityOf(agent, now(), stream.live(agent.agent_id));
  const told = said => { try { tell(said); } catch (error) { console.error('handoff notice', error); } };
  // The work and the events that announce it are kept in one storage transaction when the store offers one.
  const together = fn => (store.transaction ? store.transaction(fn) : fn());
  // Every write of a handoff goes through here, so its revision rises by one each time.
  // Work that waits on work still open says so (waits_open) with each write, so take leaves it out of what it reads
  // (takeFactsOf); the writes that finish or reopen the work it waits on write it again (releaseDependents).
  const withWaits = ({ waits_open: _waits, ...item }) => (item.state !== 'finished' && item.depends_on?.length && waitingOnOf(item).length ? { ...item, waits_open: 1 } : item);
  const put = (item, onReviewDue) => {
    const kept = { ...withWaits(item), revision: (item.revision ?? 0) + 1 };
    if (kept.in_memory) keepAsk(kept);
    else {
      store.putHandoff(kept);
      // Report only the review this write can introduce. The host already has
      // an alarm for existing work; a take must not rediscover the whole account.
      const review = onReviewDue && reviewOf(kept);
      if (review && review.review_at !== null && !(kept.waits_open && review.waits_on.length)) {
        const due = review.review_at === '' ? now().getTime() : Date.parse(review.review_at);
        if (Number.isFinite(due)) onReviewDue(due);
      }
    }
    return kept;
  };
  // Answered asks stay a few minutes for their asker to read, and the map never holds more than MAX_ASKS.
  function keepAsk(item) {
    asks.set(item.handoff_id, item);
    const old = new Date(now().getTime() - ASK_KEPT_MS).toISOString();
    for (const [id, ask] of asks) if (asks.size > MAX_ASKS || (ask.state === 'finished' && ask.finished_at < old)) asks.delete(id);
  }
  const openAsksFor = agent_id => [...asks.values()].filter(item => item.to_agent === agent_id && item.state === 'open');
  // What an agent holds, its in-memory asks included, so they count toward what it said it can work on at once.
  // What an agent holds for counting its slots (capacityFor): from the store's summary of it when it has one, so no job is read.
  const heldLoad = agent_id => [...(store.heldLoad?.(agent_id) ?? store.heldBy(agent_id)), ...[...asks.values()].filter(item => item.state === 'taken' && item.taken_by === agent_id)];
  const heldBy = agent_id => [...store.heldBy(agent_id), ...[...asks.values()].filter(item => item.state === 'taken' && item.taken_by === agent_id)];
  const waitingOnOf = item => (item.depends_on ?? []).filter(id => { const dependency = handoff(id); return dependency?.state !== 'finished' || dependency.withdrawal; });
  // Work its asker stops waiting for at take_by and that nobody took by then is of no use to anyone: the queue never
  // hands it out or counts it, and finishes it as not taken in time the first time it meets it (a take, or a hand to
  // the same agent that finds its queue full), so a computer never spends its time on answers nobody reads.
  const lapsed = (item, nowIso) => !item.closing && item.state === 'open' && typeof item.take_by === 'string' && item.take_by <= nowIso;
  // Work that waited on a job that finished can go now: it is due for review at once, and the review wakes who can take it.
  const releaseDependents = id => {
    for (const next of store.dependentsOf(id)) if (!waitingOnOf(next).length) put({ ...next, review_at: at(), wakes: 0 });
  };
  const withdrawn = item => put({ ...item, state: 'finished', finished_at: at(), result: { withdrawn_by: item.from_agent ?? null, not_taken_by: item.take_by },
    summary: 'Not taken before its asker stopped waiting, so withdrawn.', review_at: null });
  const lapse = item => {
    const kept = withdrawn(item);
    releaseDependents(item.handoff_id);
    return kept;
  };
  // Several at once: the work waiting on any of them is found and read once, not once for each (a take lets go of up to
  // LAPSE_PAGE jobs, and finding the work that waits on one reads every job that waits on anything).
  const dependentsOfAny = ids => (store.dependentsOfAny ? store.dependentsOfAny(ids) : ids.flatMap(id => store.dependentsOf(id)));
  const lapseAll = (items, onReviewDue) => {
    items.forEach(withdrawn);
    for (const next of items.length ? dependentsOfAny(items.map(item => item.handoff_id)) : []) if (!waitingOnOf(next).length) put({ ...next, review_at: at(), wakes: 0 }, onReviewDue);
  };
  const view = item => item && outward(item, nextStepOf(item, { nowIso: at(), waitingOn: waitingOnOf(item) }));
  const minutesFrom = minutes => new Date(now().getTime() + minutes * 60_000).toISOString();
  const reviewAfter = wakes => minutesFrom(Math.min(FIRST_REVIEW_MINUTES * 2 ** wakes, LAST_REVIEW_MINUTES));
  const earliest = (...times) => times.filter(Boolean).sort()[0] ?? null;
  // A write from an attempt that is no longer the current one is refused (the fencing check).
  const fenced = (current, generation) => {
    if (generation === undefined || generation === null) return;
    if (!Number.isInteger(generation)) throw new AgentsError('generation is the whole number take_work returned with this job.');
    if (generation !== (current.generation ?? 0)) throw new AgentsError(`${current.handoff_id} is on attempt ${current.generation ?? 0}; attempt ${generation} is no longer current, so its write is refused.`, { tool: 'read_handoff', arguments: { handoff_id: current.handoff_id } });
  };
  // The reader that took a handoff is immutable attempt evidence, unlike card.reader, which can be changed by a later
  // publish or take. Old/internal claims have no reader evidence: keep their reader-less call contract, but never
  // assign a newly authenticated reader to such a claim after the fact.
  const claimReader = current => {
    const attempt = [...(current.attempts ?? [])].reverse().find(item => item.generation === current.generation);
    return attempt && Object.hasOwn(attempt, 'claim_reader')
      ? { recorded: true, reader: attempt.claim_reader }
      : { recorded: false, reader: null };
  };
  const assertClaimReader = (current, reader) => {
    const claim = claimReader(current);
    if (claim.recorded) {
      if (typeof claim.reader !== 'string' || !claim.reader || reader !== claim.reader)
        throw new AgentsError(`${current.handoff_id} is held by a different authenticated reader; the claim can only be renewed or completed by the reader that took attempt ${current.generation}.`);
      return;
    }
    if (reader !== null && reader !== undefined && reader !== '')
      throw new AgentsError(`${current.handoff_id} has no authenticated reader recorded for attempt ${current.generation}; its legacy reader-less claim cannot be assigned to this reader. Take it again under the authenticated reader before writing.`);
  };
  // Authenticated source access may repair a finished legacy inline result or retry its exact persisted receipt.
  // This is evidence for those read/representation paths only; ordinary writes keep assertClaimReader's strict rule.
  const legacySourceAdmission = (current, input) => {
    if (claimReader(current).recorded || current.state !== 'finished' || asks.has(current.handoff_id)) return false;
    if (store.legacyResultRecovery?.(current.handoff_id)) return true;
    const prior = current.result_source_receipt;
    if (!prior || !input.result_source) return false;
    const source = checkedResultSource(input.result_source);
    const receiptFields = ['agent_id', 'byte_length', 'format', 'generation', 'identity'];
    if (Object.keys(prior).sort().join('\0') !== receiptFields.join('\0')) return false;
    return prior.identity === source.identity && prior.byte_length === source.byte_length && prior.format === source.format
      && prior.generation === input.generation && prior.generation === (current.generation ?? 0)
      && prior.agent_id === input.agent_id && prior.agent_id === current.taken_by;
  };
  // Trillion's own reason the work is stuck, with how it gets going again.
  // review_at is when the wall ends, or null when it ends at no known time (reviewOf).
  const blockedBy = (item, kind, reason, recovery, review_at = null) => ({ ...item, in_the_way: reason, in_the_way_by: BY_TRILLION, in_the_way_at: at(), recovery, blocked_kind: kind, review_at });
  const unblocked = item => ({ ...item, in_the_way: null, in_the_way_by: null, in_the_way_at: null, recovery: null, blocked_kind: null });
  const endAttempt = (item, ended) => ({
    ...item,
    attempts: (item.attempts ?? []).map(attempt => (attempt.generation === item.generation && !attempt.ended ? { ...attempt, ended, ended_at: at() } : attempt)),
    effects: ended === 'finished' ? item.effects : Object.fromEntries(Object.entries(item.effects ?? {}).map(([id, effect]) => [id, effect.state === 'starting' ? { ...effect, state: 'unknown', unknown_since: at() } : effect])),
  });

  function capacityClaim(input) {
    if (!object(input)) throw new AgentsError('capacity must contain max_concurrent and optionally ttl_minutes.');
    const max = input.max_concurrent;
    const minutes = input.ttl_minutes === undefined ? workHolds.capacity_report_minutes : input.ttl_minutes;
    if (!Number.isInteger(max) || max < 0 || max > 20) throw new AgentsError('max_concurrent must be a whole number from 0 to 20.');
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new AgentsError('ttl_minutes must be from 1 to 1440.');
    return { max_concurrent: max, reported_at: at(), expires_at: new Date(now().getTime() + minutes * 60_000).toISOString() };
  }

  // What an agent is working on counts toward what it said it can do at once; a hold that ran out or reached the
  // longest one attempt may have, and work it said something is in the way of, do not. An expired report says nothing
  // any more (stale): the agent is not shown as ready, and the number it gave no longer holds it back.
  function capacityFor(agent, open, nowIso) {
    const claim = agent.capacity_claim;
    const in_progress = open.filter(item => workingOn(item, agent.agent_id, nowIso)).length;
    const status = !agent.takes_work ? 'paused' : !claim ? 'unknown' : claim.expires_at <= nowIso ? 'stale' : claim.max_concurrent <= in_progress ? 'full' : 'available';
    return { status, max_concurrent: claim?.max_concurrent ?? null, in_progress, available_slots: status === 'available' ? claim.max_concurrent - in_progress : 0, reported_at: claim?.reported_at ?? null, expires_at: claim?.expires_at ?? null };
  }

  // An event waits in the store before anything is sent; the same event for the same receiver is kept once.
  function keep(said, held) {
    const event = eventFrom(said, at());
    const earlier = store.delivery(event.event_id);
    if (earlier) return { item: earlier, repeated: true };
    // Only an agent with an address is posted to (next_at); one on the stream route is sent the event down its socket
    // at once, and it waits here, with no send time, until its helper says what happened (ack) or asks again (pull).
    // A caller that already holds the receiver's card passes it, so a fan-out reads each card once.
    const receiver = held === undefined ? card(said.to_agent) : held;
    const item = { event_id: event.event_id, agent_id: said.to_agent, event, said: identity(said), state: 'waiting', attempts: 0, next_at: receiver?.delivery?.url ? event.occurred_at : null, created_at: event.occurred_at };
    store.putDelivery(item);
    if (receiver?.delivery?.stream) stream.send(said.to_agent, event);
    return { item, repeated: false };
  }
  // One batched card read for the whole fan-out, then each card is passed on so keep does not read it again.
  function enqueue(type, item, receivers, key = item.handoff_id) {
    const ids = [...new Set(receivers)].filter(Boolean);
    const cards = new Map(store.cardsById(ids).map(card => [card.agent_id, card]));
    for (const agent_id of ids) if (cards.get(agent_id)?.delivery) keep(addressed(handoffEvent(type, item, agent_id, key), item), cards.get(agent_id));
  }
  // Work from a live chat wakes the cards that own that chat (none yet: it waits through the silence window). General
  // unaddressed work belongs on general receivers, and so does a chat's work once that window ends.
  const receiversForOpen = item => item.to_agent ? [item.to_agent] : item.input?.arrived?.source_id && !openToAnyone(item, at())
    ? store.cardsForSource(item.input.arrived.source_id).map(card => card.agent_id)
    : store.takerIds().filter(agent_id => agent_id !== item.from_agent);
  // Source-linked work whose chat has been silent for its whole window, and work named to an AI not seen for its
  // whole window (cardOf says who that AI is): any of the person's AIs may take it.
  const openToAnyone = (item, nowIso, cardOf = card) => item.to_agent
    // Transcript activity can keep a source live after its card was last seen. The independent named-agent timeout
    // must not release source-managed work before its own renewed preference ends.
    ? !(item.target?.strict === false && !item.asked?.to_agent && item.input?.arrived?.source_id
      && anyoneFrom({ ...item, to_agent: null }) > nowIso)
      && anyoneFrom(item, item.target?.strict === true ? undefined : cardOf(item.to_agent) ?? null) <= nowIso
    : Boolean(item.input?.arrived?.source_id) && anyoneFrom(item) <= nowIso;

  const idOnly = (value, label) => {
    if (value === undefined) return {};
    if (!object(value) || Object.keys(value).length > 20) throw new AgentsError(`${label} is an object of at most 20 names, each an id as text.`);
    return Object.fromEntries(Object.entries(value).map(([name, id]) => {
      if (!/^[a-z0-9_]{1,60}$/.test(name) || typeof id !== 'string' || !id.trim() || id.length > 200) throw new AgentsError(`${label}.${name} must be an id: text of at most 200 characters, under a lower-case name.`);
      return [name, id];
    }));
  };

  // Any owner's event to one reachable agent: a run of a tool on that agent's computer, its result, anything later.
  function sendEvent(input = {}) {
    const type = text(input.type, 'type (what happened, for example tool.run.requested)', 100);
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(type)) throw new AgentsError('type is lower-case words joined by dots, dashes or underscores.');
    const to_agent = text(input.to_agent, 'to_agent (the agent to wake)', 200);
    const receiver = card(to_agent);
    if (!receiver) throw new AgentsError(`No agent ${to_agent} has published on this account.`, { tool: 'find_agents', arguments: {} });
    // An agent with no route (a chat app on the web) is sent nothing: it reads its work the next time it connects.
    if (!receiver.delivery) return { event: null, delivery: null, receiver: reach(receiver) };
    const from_agent = optionalText(input.from_agent, 200);
    if (from_agent && !card(from_agent)) throw new AgentsError(`from_agent ${from_agent} has not published on this account.`);
    const next = input.next_call === undefined ? null : object(input.next_call) ? { tool: text(input.next_call.tool, 'next_call.tool', 100), arguments: idOnly(input.next_call.arguments ?? {}, 'next_call.arguments') } : (() => { throw new AgentsError('next_call is { tool, arguments }.'); })();
    const said = { type, key: text(input.idempotency_key, 'idempotency_key (any unique text; the same key sends the event once)', 200), to_agent, from_agent, subject_id: text(input.subject_id, 'subject_id (the id the event is about, for example a run id)', 200), summary: optionalText(input.summary, 300), refs: idOnly(input.refs, 'refs'), next_call: next };
    const waiting = store.waitingFor(to_agent, MAX_WAITING);
    if (!store.delivery(eventFrom(said, at()).event_id) && waiting >= MAX_WAITING) throw new AgentsError(`${to_agent} already has at least ${MAX_WAITING} events waiting to be delivered. It can report itself present when it is back.`);
    const { item, repeated } = keep(said, receiver);
    if (repeated && item.said !== identity(said)) throw new AgentsError(`idempotency_key ${said.key} already sent a different event (${item.event_id}). Use a new key for a new event.`);
    return { event: item.event, delivery: deliveryOutward(item), receiver: reach(receiver), ...(repeated ? { repeated: true } : {}) };
  }

  // One event to every agent that can be reached, except the one that caused it (from_agent) and any already holding
  // MAX_WAITING undelivered events: what every agent should hear at once, such as a decision the person made.
  // `said` is the event without to_agent; returns how many agents it went to.
  // One event to every agent that says it runs tools for this placement (its card's `runs`) and can be reached: a run
  // of a tool that lives on the person's own computer goes to whatever runs tools there. Returns how many it went to.
  // A snapshot of the same capped recipient counts; hosts whose legacy bridge or
  // small table store owns these counts retain its scalar method without bypassing it.
  const withDeliveryRoom = candidates => {
    const ids = [...new Set(candidates.map(agent => agent.agent_id))];
    const counts = typeof store.waitingForMany === 'function' ? store.waitingForMany(ids, MAX_WAITING)
      : new Map(ids.map(id => [id, store.waitingFor(id, MAX_WAITING)]));
    return candidates.filter(agent => counts.get(agent.agent_id) < MAX_WAITING);
  };
  function tellRunners({ placement, ...said }) {
    const receivers = withDeliveryRoom(store.reachableCards().filter(agent => (agent.runs ?? []).includes(placement)));
    for (const agent of receivers) keep({ ...said, to_agent: agent.agent_id }, agent);
    return { told: receivers.length };
  }

  function tellEveryone(said) {
    const receivers = withDeliveryRoom(store.reachableCards().filter(agent => agent.agent_id !== said.from_agent));
    for (const agent of receivers) keep({ ...said, to_agent: agent.agent_id }, agent);
    return { told: receivers.length };
  }

  // The events sent about one subject (a handoff, a run), or one event by id.
  function readEvents(input = {}) {
    const event_id = optionalText(input.event_id, 200);
    if (event_id) {
      const found = store.delivery(event_id);
      if (!found) throw new AgentsError(`No event ${event_id} on this account.`);
      return { events: [{ ...deliveryOutward(found), event: found.event }] };
    }
    const subject_id = text(input.subject_id, 'subject_id or event_id', 200);
    return { events: store.deliveriesFor(subject_id).map(found => ({ ...deliveryOutward(found), event: found.event })) };
  }

  function deliveryFrom(input, earlier, agent_id) {
    if (input.delivery === undefined) return { delivery: earlier?.delivery ?? null, secret: input.rotate_delivery_secret && earlier?.delivery ? newDeliverySecret() : null };
    if (input.delivery === null) return { delivery: null, secret: null };
    // The stream socket uses account auth. A source-bound helper also needs its
    // own one-time secret to attest that a returned answer is in its transcript.
    if (object(input.delivery) && input.delivery.stream === true) return {
      delivery: { stream: true, since: earlier?.delivery?.stream ? earlier.delivery.since : at() },
      secret: input.rotate_delivery_secret === true || !store.deliverySecret(agent_id) ? newDeliverySecret() : null,
    };
    const url = object(input.delivery) ? deliveryAddress(input.delivery.url) : null;
    if (!url) throw new AgentsError('delivery is { url } with a public https address this agent answers on, { stream: true } when a helper on its computer holds Trillion\'s live connection for it, or null to stop events.');
    const fresh = !earlier?.delivery || earlier.delivery.url !== url || input.rotate_delivery_secret === true || !store.deliverySecret(agent_id);
    return { delivery: { url, since: fresh ? at() : earlier.delivery.since }, secret: fresh ? newDeliverySecret() : null };
  }

  // sources (from the host): { kept(source_id) -> whether any message is kept under that chat, recent() -> the newest
  // chats kept, each { conversation_id, app, at } }. A host without messages (a space, a test) passes none.
  function provenSource(source_id, delivery, sources) {
    if (!source_id || !sources || delivery || sources.kept(source_id)) return;
    const recent = sources.recent();
    throw new AgentsError(`No message is kept under source_id ${source_id}, so no work could ever come from it. source_id is the conversation_id this chat records its messages under (record_messages)${recent.length ? `; the chats kept most recently are ${recent.map(chat => `${chat.conversation_id} (${chat.app}, ${chat.at})`).join(', ')}` : ''}. Record this turn under your own conversation_id first, then publish with that id.`,
      recent.length ? { tool: 'read_messages', arguments: { limit: 5 } } : { tool: 'record_messages', arguments: { messages: '(this turn, under this chat\'s conversation_id)' } });
  }

  function publish(input = {}, { reader = null, sources = null } = {}) {
    const name = text(input.name, 'name (what this agent is called)', 200);
    const agent_id = optionalText(input.agent_id, 200) ?? (words(name).join('-') || identity(name).slice(3, 15));
    const earlier = card(agent_id);
    const { delivery, secret } = deliveryFrom(input, earlier, agent_id);
    const published = {
      agent_id, name,
      // Who or what takes work as this card: an AI unless it says otherwise (a person, a team, anything that takes work).
      kind: optionalText(input.kind, 40) ?? earlier?.kind ?? 'ai',
      // A card that may take any waiting work it names, wherever the work came from (the person's own card).
      takes_any_by_name: input.takes_any_by_name === undefined ? (earlier?.takes_any_by_name ?? false) : input.takes_any_by_name === true,
      description: text(input.description, 'description (what this agent does, in plain words)'),
      skills: skillsFrom(input.skills),
      harness: optionalText(input.harness, 200) ?? 'unknown',
      model: optionalText(input.model, 200) ?? 'unknown',
      where: optionalText(input.where, 500) ?? 'unknown',
      source_id: input.source_id === undefined ? (earlier?.source_id ?? null) : optionalText(input.source_id, 500),
      takes_work: input.takes_work !== false,
      runs: input.runs === undefined ? (earlier?.runs ?? []) : runsFrom(input.runs),
      capacity_claim: input.capacity === undefined ? (earlier?.capacity_claim ?? null) : capacityClaim(input.capacity),
      first_published_at: earlier?.first_published_at ?? at(),
      published_at: at(),
      finished: earlier?.finished ?? 0,
      delivery,
      reader: reader ?? earlier?.reader ?? null,
      last_seen_at: earlier?.last_seen_at ?? null,
      last_delivered_at: earlier?.last_delivered_at ?? null,
      last_undelivered_at: earlier?.last_undelivered_at ?? null,
      delivered: earlier?.delivered ?? 0,
    };
    // Two layers (DATA: agent-surface.json): the card's first publication approves its skills; later skills wait for approval.
    if (agentSurface.approve_widening && earlier) {
      const approved = new Set(earlier.skills.map(skillKey));
      published.pending_skills = published.skills.filter(skill => !approved.has(skillKey(skill)));
      published.skills = published.skills.filter(skill => approved.has(skillKey(skill)));
      if (!published.pending_skills.length) delete published.pending_skills;
    }
    provenSource(published.takes_work ? published.source_id : null, delivery, sources);
    if (secret) store.putDeliverySecret(agent_id, secret);
    const hadTaker = !published.takes_work || store.anyTaker();
    const arrived = published.takes_work && (!earlier || !reachabilityOf(earlier, now()).present);
    store.putCard(published);
    if (published.takes_work && published.source_id) sourceActive({ source_id: published.source_id, active_at: published.published_at });
    clearWalls(published, earlier, hadTaker);
    // A chat can register after its messages arrived. Keep each handoff's ID and claim history while naming the
    // owner that just published, the newest, while the source stays active; every other owner may still take it.
    if (published.takes_work && published.source_id) {
      for (const item of store.unaddressedForSource(published.source_id)) {
        if (item.state === 'open' && !item.to_agent && item.input?.arrived?.source_id === published.source_id) {
          addressOpen({ handoff_id: item.handoff_id, source_id: published.source_id, to_agent: agent_id });
        }
      }
    }
    // Work may have arrived while this agent had no address. Wake it for the open jobs it can take now.
    if (delivery && published.takes_work && (!earlier?.delivery || !earlier.takes_work)) {
      for (const item of store.openAddressedTo(agent_id)) {
        if (item.state === 'open' && item.to_agent === agent_id && item.from_agent !== agent_id) {
          enqueue('handoff.created', item, [agent_id], `${item.handoff_id}:ready:${published.published_at}`);
        }
      }
    }
    if (arrived) { try { onConnected(published); } catch (error) { console.error('a connected agent was not heard', error); } }
    const capacity = capacityFor(published, heldLoad(agent_id), at());
    return { agent: published, ...(secret ? { delivery_secret: secret, delivery_note: 'Keep this secret in memory only; it is shown once. Each event is signed with it (trillion-signature). Publish again with rotate_delivery_secret true for a new one.' } : {}), ...(['available', 'unknown'].includes(capacity.status) ? { next_call: { tool: 'take_work', arguments: { agent_id } } } : {}) };
  }

  function setCapacity(input = {}, { onReviewDue = () => {} } = {}) {
    const agent_id = text(input.agent_id, 'agent_id (the agent reporting capacity)', 200);
    const agent = card(agent_id);
    if (!agent) throw new AgentsError(`Publish ${agent_id} first, so others can see what this agent does.`, { tool: 'publish_agent', arguments: { agent_id, name: '(this agent)', description: '(what it does)' } });
    const updated = { ...agent, capacity_claim: capacityClaim(input), published_at: at() };
    store.putCard(updated);
    if (updated.takes_work && updated.source_id) sourceActive({ source_id: updated.source_id, active_at: updated.published_at });
    clearWalls(updated, agent, true, onReviewDue);
    return { agent: { ...updated, capacity: capacityFor(updated, heldLoad(agent_id), at()) } };
  }

  // Approves or rejects the skills a card published beyond its approved surface. The agent's own key cannot do it.
  function decideSurface(input = {}, { reader = null } = {}) {
    const agent_id = text(input.agent_id, 'agent_id (the agent whose new skills are decided)', 200);
    const agent = card(agent_id);
    const words = agentSurface.words;
    const fillIn = (line, values) => line.replace(/\{(\w+)\}/g, (_, name) => values[name]);
    if (!agent?.pending_skills?.length) throw new AgentsError(fillIn(words.nothing_pending, { agent: agent_id }));
    if (typeof input.approve !== 'boolean') throw new AgentsError('approve is true to let the agent offer the pending skills, or false to refuse them.');
    if (reader && agent.reader === reader) throw new AgentsError(fillIn(words.own_key, { agent: agent_id }));
    const names = agent.pending_skills.map(skill => skill.name).join(', ');
    const { pending_skills, ...rest } = agent;
    const updated = input.approve ? { ...rest, skills: [...agent.skills, ...pending_skills], published_at: at() } : rest;
    store.putCard(updated);
    return { agent: updated, said: fillIn(input.approve ? words.approved : words.rejected, { agent: agent_id, skills: names }) };
  }

  // Internal readers may narrow cards before capacity and waiting-work reads. A
  // computer-carried connection only needs cards that advertise its skills;
  // evaluating every chat on the account made one Connections read fan out to
  // hundreds of held-work and waiting-work queries.
  function find(input = {}, { keepCard = () => true, includeWaiting = true } = {}) {
    const wanted = words(input.job);
    const limit = Math.min(Math.max(Number(input.limit) || MAX_CARDS, 1), MAX_CARDS);
    const nowIso = at();
    // agent_id names one card: describing one agent reads that card, never every card.
    // A search lists only the cards the account still lists (`listed`: a retired agent's card is kept, never offered).
    const cards = (typeof input.agent_id === 'string' ? [store.card(input.agent_id)].filter(Boolean) : store.cards().filter(listed)).filter(keepCard);
    const matching = cards.map(agent => {
      const own = new Set(words([agent.name, agent.description, agent.harness, agent.model, ...agent.skills.flatMap(skill => [skill.name, skill.description])].join(' ')));
      const matched = wanted.filter(word => own.has(word)).length;
      return { agent, score: wanted.length ? matched / wanted.length : 1 };
    }).filter(item => !wanted.length || item.score > 0);
    // A narrow search is cheaper by one card's index; a wide search avoids
    // reopening the held and pending indexes once for every card.
    const loads = matching.length >= 8 ? store.boardAgentLoads?.(matching.map(item => item.agent.agent_id), { includeWaiting }) : null;
    const scored = matching
      .map(item => ({ ...item, capacity: capacityFor(item.agent, loads ? loads.held.get(item.agent.agent_id) ?? [] : store.heldBy(item.agent.agent_id), nowIso) }))
      .sort((left, right) => right.score - left.score || Number(right.capacity.status === 'available') - Number(left.capacity.status === 'available') || right.agent.finished - left.agent.finished || right.agent.published_at.localeCompare(left.agent.published_at));
    const agents = (input.all === true ? scored : scored.slice(0, limit)).map(({ agent, capacity, score }) => ({
      ...agent, capacity, ready_now: capacity.status === 'available', match: Number(score.toFixed(2)),
      ...(includeWaiting ? { waiting_for_it: loads ? loads.waiting.get(agent.agent_id) ?? 0 : store.waitingCount(agent.agent_id) } : {}),
      next_call: { tool: 'hand_off', arguments: { to_agent: agent.agent_id, job: input.job ?? '(the job, in plain words)', request_key: '(any unique text)' } },
    }));
    return agents.length ? { job: input.job ?? null, agents }
      : { job: input.job ?? null, agents: [], note: 'No agent on this account has said it does this. Any agent can still take it: hand it off without to_agent.', next_call: { tool: 'hand_off', arguments: { job: input.job ?? '(the job)', request_key: '(any unique text)' } } };
  }

  // A later hand for an item whose job nobody has taken yet adds what it knows to that job, and the item stays one job:
  // its words, so what was learned about the item since (a recording's transcript) reaches whoever takes it; the
  // higher of the two priorities and the decision it belongs to, so whatever handed the item first with less (a rule of
  // the person's own, at a low priority and with no decision) cannot keep the person's own words below the line the
  // watchers of their work read (src/keep-running.mjs, src/own-ais-routing.mjs); and the facts about the item that the
  // first hand did not say. Who the work waits for (its source chat and that chat's silence, OWNER_FACTS) stays as the
  // first hand set it. Once the job is taken or finished, the words it was taken with stand.
  function joined(earlier, { job, priority, case_id, input }) {
    if (earlier.state !== 'open' || earlier.taken_by) return earlier;
    const words = earlier.job.includes(job) ? earlier.job : `${earlier.job}\n\n${job}`;
    const raised = Math.max(earlier.priority ?? 0, priority);
    const decision = earlier.case_id ?? case_id;
    const known = earlier.input?.arrived ?? {};
    const learned = Object.fromEntries(Object.entries(object(input?.arrived) ? input.arrived : {})
      .filter(([key, value]) => value !== undefined && value !== null && known[key] == null && !OWNER_FACTS.includes(key)));
    const learnedMore = Object.keys(learned).length > 0;
    if (words === earlier.job && raised === (earlier.priority ?? 0) && decision === earlier.case_id && !learnedMore) return earlier;
    const kept = learnedMore ? { ...(earlier.input ?? {}), arrived: { ...known, ...learned } } : earlier.input;
    return put({ ...earlier, job: words, priority: raised, case_id: decision, input: kept, asked: { ...earlier.asked, job: words, case_id: decision, input: kept } });
  }

  // A source heartbeat or newly recorded transcript row extends every still-waiting job from that source. The
  // activity timestamp is the row's own time, so importing old history cannot make a closed chat look live.
  function sourceActive(input = {}) {
    const source_id = text(input.source_id, 'source_id (the conversation that is active)', 500);
    const saidAt = input.active_at ?? at();
    if (typeof saidAt !== 'string' || Number.isNaN(Date.parse(saidAt))) throw new AgentsError('active_at must be a date and time.');
    const active_at = new Date(saidAt).toISOString();
    // person_said_at: when the person's own latest message in this conversation was said (none when only others spoke).
    if (input.person_said_at !== undefined && (typeof input.person_said_at !== 'string' || Number.isNaN(Date.parse(input.person_said_at)))) throw new AgentsError('person_said_at must be a date and time.');
    const person_said_at = input.person_said_at === undefined ? null : new Date(input.person_said_at).toISOString();
    const preferred = newestOwner(store.cardsForSource(source_id));
    const updated = [];
    together(() => {
      for (let current of store.openForSource(source_id)) {
        // The person's own next message in the conversation the work came from releases an effect left unknown since
        // (src/effect-outcomes.json): the holder may act again, and the effect itself is still never started blindly.
        if (person_said_at && current.input?.arrived?.source_id === source_id && lockingEffect(current)) {
          const effects = Object.fromEntries(Object.entries(current.effects).map(([id, effect]) => [id,
            effect.state === 'unknown' && !effect.released_by_person && (effect.unknown_since ?? '') < person_said_at ? { ...effect, released_by_person: person_said_at } : effect]));
          if (Object.keys(effects).some(id => effects[id] !== current.effects[id])) {
            current = put({ ...current, effects });
            updated.push(current.handoff_id);
          }
        }
        if (current.state !== 'open' || current.input?.arrived?.source_id !== source_id) continue;
        if (current.asked?.to_agent || (current.to_agent && current.target?.strict !== false)) continue;
        const earlier = current.source_active_at ?? current.handed_at;
        const newer = !earlier || earlier < active_at;
        const sameTimeRepair = earlier === active_at && ((!current.to_agent && preferred)
          || (current.in_the_way_by === BY_TRILLION && current.blocked_kind === 'source'));
        if (!newer && !sameTimeRepair) continue;
        let item = { ...current, source_active_at: newer ? active_at : earlier };
        const prefer_until = anyoneFrom({ ...item, to_agent: null });
        let wake = null;
        if (item.to_agent && item.target?.strict === false) {
          item = { ...item, target: { ...item.target, prefer_until }, review_at: prefer_until };
        } else if (!item.to_agent && preferred) {
          item = { ...item, to_agent: preferred.agent_id, target: { strict: false, prefer_until }, review_at: prefer_until, wakes: 0 };
          wake = preferred.agent_id;
        } else if (!item.to_agent) {
          item = { ...item, review_at: prefer_until };
        }
        if (item.in_the_way_by === BY_TRILLION && item.blocked_kind === 'source') {
          item = { ...unblocked(item), review_at: prefer_until, wakes: 0 };
          wake ??= preferred?.agent_id ?? null;
        }
        const kept = put(item);
        updated.push(kept.handoff_id);
        if (wake) enqueue('handoff.created', kept, [wake], `${kept.handoff_id}:source-active:${active_at}`);
      }
    });
    return { source_id, active_at, handoff_ids: updated };
  }

  const sentRecently = new Map();
  // A steer is a later word to work already running: it is kept on that job (never a second job), in order, for its holder
  // to read with the job; a repeat of the same request_key is one steer. Only unfinished, unwithdrawn work can be steered.
  function steerJob(input) {
    const handoff_id = text(input.steer_handoff_id, 'steer_handoff_id (the job to steer)', 200);
    const request_key = text(input.request_key, 'request_key (any unique text, so a repeat is one steer)', 500);
    const earlier = handoff(handoff_id);
    if (!earlier) throw new AgentsError(`steer_handoff_id ${handoff_id} is not a handoff on this account.`);
    if (earlier.state === 'finished' || earlier.withdrawal) throw new AgentsError('This work is over, so it cannot be steered. Hand off a new job instead.', { tool: 'hand_off', arguments: { job: input.job } });
    const steers = earlier.steers ?? [];
    if (steers.some(steer => steer.request_key === request_key)) return { handoff: view(earlier), steered: true, repeated: true };
    if (steers.length >= MAX_STEERS) throw new AgentsError(`This work already has ${MAX_STEERS} steers. Wait for it to read them.`);
    const steer = { request_key, job: text(input.job, 'job (the steer, in plain words)', 8000), from_agent: optionalText(input.from_agent, 200), at: at() };
    return { handoff: view(put({ ...earlier, steers: [...steers, steer] })), steered: true };
  }

  function handOff(input = {}, { reader = null } = {}) {
    if (input.steer_handoff_id !== undefined) return steerJob(input);
    const once_per = optionalText(itemOf({ once_per: input.once_per, input: object(input.input) ? input.input : null }), 500);
    const request_key = once_per ? `once-per:${once_per}` : text(input.request_key, 'request_key (any unique text, so a repeat returns the same handoff)', 500);
    const job = text(input.job, 'job (what needs doing, in plain words)', 8000);
    if (input.input !== undefined && !object(input.input)) throw new AgentsError('input, when given, is an object.');
    const to_agent = optionalText(input.to_agent, 200);
    if (to_agent && !card(to_agent)) throw new AgentsError(`No agent ${to_agent} has published on this account.`, { tool: 'find_agents', arguments: { job } });
    const asked = { job, input: input.input ?? null, to_agent, from_agent: optionalText(input.from_agent, 200), case_id: optionalText(input.case_id, 500), parent_handoff_id: optionalText(input.parent_handoff_id, 200), ...lifecycleFrom(input, to_agent) };
    const handoff_id = handoffIdFor(request_key);
    const earlier = handoff(handoff_id);
    if (earlier && once_per) return { handoff: view(joined(earlier, { job, priority: priorityOf(input.priority), case_id: asked.case_id, input: asked.input })), repeated: true };
    if (earlier) {
      if (identity(earlier.asked) !== identity(asked)) throw new AgentsError(`request_key ${request_key} already handed off different work (${earlier.handoff_id}). Use a new request_key for new work.`, { tool: 'read_handoff', arguments: { handoff_id: earlier.handoff_id } });
      return { handoff: view(earlier), repeated: true };
    }
    const priority = priorityOf(input.priority);
    const within = input.take_within_seconds;
    if (within !== undefined && !(Number.isFinite(within) && within > 0 && within <= MAX_TAKE_WITHIN_SECONDS))
      throw new AgentsError(`take_within_seconds is how long the asker waits for the work to be taken, from 1 to ${MAX_TAKE_WITHIN_SECONDS}.`);
    const waitingLimit = MAX_WAITING_FOR_ONE + (priority >= 6 ? PRIORITY_WAITING_RESERVE : 0);
    if (to_agent && store.waitingCount(to_agent, { most: waitingLimit }) >= waitingLimit && !lapseWaiting(to_agent, waitingLimit))
      throw new AgentsError(`${to_agent} already has ${waitingLimit} jobs waiting for it. Hand this one to another agent, or to whichever agent takes it first (leave out to_agent).`, { tool: 'find_agents', arguments: { job } });
    if (asked.parent_handoff_id && !handoff(asked.parent_handoff_id)) throw new AgentsError(`parent_handoff_id ${asked.parent_handoff_id} is not a handoff on this account.`);
    if (asked.parent_handoff_id && handoff(asked.parent_handoff_id)?.withdrawal) throw new AgentsError('This parent work was withdrawn. A new request must be handed off explicitly without attaching work to it.', { tool: 'read_handoff', arguments: { handoff_id: asked.parent_handoff_id } });
    // The same two agents passing one chain of work back and forth is a loop: refused past the guard's repeats (src/agent-loop-guard.json).
    if (loopGuard.max_repeats > 0 && asked.parent_handoff_id && asked.from_agent && to_agent) {
      let repeats = 0;
      for (let id = asked.parent_handoff_id, step = 0; id && step < loopGuard.walk; step += 1) {
        const link = handoff(id);
        if (!link) break;
        if (link.from_agent === asked.from_agent && link.to_agent === to_agent) repeats += 1;
        id = link.parent_handoff_id;
      }
      if (repeats >= loopGuard.max_repeats) throw new AgentsError(loopGuard.words.replace('{from}', asked.from_agent).replace('{to}', to_agent).replace('{count}', String(repeats)));
    }
    // One agent flooding the account is refused past the guard's per-minute cap (off unless src/agent-loop-guard.json rate.per_minute is set).
    if (loopGuard.rate.per_minute > 0 && asked.from_agent) {
      const nowMs = now().getTime();
      const recent = (sentRecently.get(asked.from_agent) ?? []).filter(at => nowMs - at < 60_000);
      if (recent.length >= loopGuard.rate.per_minute) throw new AgentsError(loopGuard.rate.words.replace('{from}', asked.from_agent).replace('{count}', String(recent.length)));
      sentRecently.set(asked.from_agent, [...recent, nowMs]);
    }
    for (const id of asked.depends_on ?? []) {
      const dependency = handoff(id);
      if (!dependency) throw new AgentsError(`depends_on ${id} is not a handoff on this account.`);
      if (dependency.withdrawal) throw new AgentsError('A withdrawn handoff cannot provide the required result. Create a new prerequisite explicitly before depending on it.', { tool: 'read_handoff', arguments: { handoff_id: id } });
    }
    const hold = Number(input.hold_minutes);
    const source = asked.input?.arrived?.source_id;
    const handedAt = at();
    const owners = !to_agent && typeof source === 'string' ? store.cardsForSource(source) : [];
    const addressedTo = to_agent ?? newestOwner(owners)?.agent_id ?? null;
    // A named agent is a strict choice unless the asker said it is only a preference for prefer_minutes.
    const prefer = asked.target?.prefer_minutes;
    // The chat it came from is preferred while its source stays active, so a closed chat never holds it forever.
    const sourceSilenceEnds = !to_agent && addressedTo ? anyoneFrom({ input: asked.input, handed_at: handedAt, source_active_at: handedAt }) : null;
    const target = addressedTo ? (prefer ? { strict: false, prefer_until: minutesFrom(prefer) } : sourceSilenceEnds ? { strict: false, prefer_until: sourceSilenceEnds } : { strict: true }) : null;
    const waiting = (asked.depends_on ?? []).some(id => handoff(id).state !== 'finished');
    const created = { handoff_id, asked, ...asked, ...(once_per ? { once_per } : {}), ...(within !== undefined ? { take_by: new Date(now().getTime() + within * 1000).toISOString() } : {}), priority, to_agent: addressedTo, target, handed_by_reader: reader, notice: optionalText(input.notice, 300), said: titleOf({ said: optionalText(input.said, SAID_MAX), job }), hold_minutes: Number.isFinite(hold) && hold > 0 ? Math.min(hold, workHolds.longest_hold_minutes) : workHolds.default_hold_minutes, state: 'open', handed_at: handedAt, source_active_at: source ? handedAt : null, taken_by: null, taken_at: null, hold_until: null, finished_at: null, result: null, summary: null, result_source_receipt: null,
      // Nothing stands in its way yet: kept as null, so Home's home-open index (every path present) draws it from the key.
      in_the_way: null, revision: 0, generation: 0, attempts: [], effects: {}, wakes: 0, review_at: waiting ? null : earliest(reviewAfter(0), target?.prefer_until) };
    // An ask its asker waits for here is kept in memory only (invariant above). It goes down the agent's live stream when
    // one is listening; otherwise the account's live connections are nudged, and a helper takes it by its id.
    if (input.in_memory === true && to_agent && !waiting && !asked.parent_handoff_id) {
      const nowIso = at();
      for (const item of openAsksFor(to_agent)) if (lapsed(item, nowIso)) lapse(item);
      if (openAsksFor(to_agent).length >= waitingLimit) throw new AgentsError(`${to_agent} already has ${waitingLimit} questions waiting for it.`);
      const item = put({ ...created, in_memory: true, review_at: null });
      if (card(to_agent)?.delivery?.stream && stream.live(to_agent)) {
        const event = eventFrom(addressed(handoffEvent('handoff.created', item, to_agent, handoff_id), item), nowIso);
        askEvents.add(event.event_id);
        if (askEvents.size > MAX_ASKS) askEvents.delete(askEvents.values().next().value);
        stream.send(to_agent, event);
      } else stream.nudge?.(to_agent);
      return { handoff: view(item), next_call: { tool: 'read_handoff', arguments: { handoff_id } } };
    }
    // The work and the event announcing it are kept together: a crash between them cannot leave either alone.
    // A source chat's message goes to that chat first. If it has no registered owner yet, the open handoff waits for
    // that owner through the silence window instead of waking unrelated agents (anyoneFrom).
    const kept = together(() => {
      const item = put(created);
      if (!waiting) enqueue('handoff.created', item, receiversForOpen(item));
      return item;
    });
    const receiver = addressedTo ? card(addressedTo)?.reader : null;
    // Work for the person's AIs only (src/ai-side-work.json) tells the person nothing.
    const tells = forPerson(created);
    if (tells && !addressedTo && !source) told({ moment: 'waiting_for_anyone', handoff: view(kept), for_reader: null, from_reader: reader });
    else if (tells && receiver) told({ moment: 'waiting', handoff: view(kept), for_reader: receiver, from_reader: reader });
    return { handoff: view(kept), next_call: { tool: 'read_handoff', arguments: { handoff_id } } };
  }

  // Address source-linked work that arrived before its owning agent was known, preserving the original handoff ID.
  function addressOpen(input = {}) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const source_id = text(input.source_id, 'source_id', 500);
    const to_agent = text(input.to_agent, 'to_agent', 200);
    const agent = card(to_agent);
    if (!agent || !agent.takes_work) throw new AgentsError(`${to_agent} is not a published agent taking work.`);
    const current = handoff(handoff_id);
    if (!current) throw new AgentsError(`No handoff ${handoff_id} on this account.`);
    if (current.input?.arrived?.source_id !== source_id) throw new AgentsError(`${handoff_id} did not arrive from ${source_id}.`);
    if (current.to_agent === to_agent) return { handoff: view(current), repeated: true };
    if (current.state !== 'open' || current.to_agent) throw new AgentsError(`${handoff_id} is not open and waiting for an agent to be named.`);
    if (agent.source_id !== source_id) throw new AgentsError(`${to_agent} is not registered for ${source_id}.`);
    // Preferred for its live source: after a full silence window it goes back up for any of the person's AIs.
    const prefer_until = anyoneFrom(current);
    const addressed = { ...current, to_agent, target: { strict: false, prefer_until }, review_at: earliest(current.review_at, prefer_until) };
    put(addressed);
    enqueue('handoff.created', addressed, [to_agent], `${handoff_id}:address:${to_agent}`);
    return { handoff: view(addressed) };
  }

  // Addresses one open job to one of the person's own AIs for its short preference (src/own-ais-routing.mjs). A job whose
  // preference for an earlier AI has lapsed (it did not take it in time) may be addressed again, to the next one in order.
  function addressJob(input = {}) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const to_agent = text(input.to_agent, 'to_agent', 200);
    const prefer_until = text(input.prefer_until, 'prefer_until', 40);
    const agent = card(to_agent);
    if (!agent || !agent.takes_work) throw new AgentsError(`${to_agent} is not a published agent taking work.`);
    const current = handoff(handoff_id);
    if (!current) throw new AgentsError(`No handoff ${handoff_id} on this account.`);
    if (current.to_agent === to_agent) return { handoff: view(current), repeated: true };
    const lapsed = current.target?.strict === false && current.target.prefer_until <= at();
    if (current.state !== 'open' || (current.to_agent && !lapsed)) throw new AgentsError(`${handoff_id} is not open and waiting for an agent to be named.`);
    const addressed = { ...current, to_agent, target: { strict: false, prefer_until }, review_at: earliest(current.review_at, prefer_until),
      in_the_way: null, in_the_way_by: null, in_the_way_at: null, recovery: null, blocked_kind: null };
    put(addressed);
    enqueue('handoff.created', addressed, [to_agent], `${handoff_id}:address:${to_agent}:${current.generation}`);
    return { handoff: view(addressed) };
  }

  // Marks one open job no_taker: none of the person's own AIs can take it now, with the reason of each (src/own-ais-routing.mjs).
  // It is the reconciler's own no_taker mark (wallFor), so the reconciler wakes it when a taker publishes.
  function markNoTaker(input = {}) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const why = optionalText(input.why, 2000) ?? '';
    const current = handoff(handoff_id);
    if (!current || current.state !== 'open') return { handoff: current ? view(current) : null, repeated: true };
    if (current.in_the_way_by === BY_TRILLION && current.blocked_kind === 'no_taker' && current.in_the_way === why) return { handoff: view(current), repeated: true };
    const marked = { ...current, in_the_way: why, in_the_way_by: BY_TRILLION, in_the_way_at: at(), recovery: ownAisSettings.words.no_taker_recovery, blocked_kind: 'no_taker', review_at: null };
    put(marked);
    return { handoff: view(marked) };
  }

  // A full queue first lets go of the work in it whose asker stopped waiting; true when that made room.
  function lapseWaiting(agent_id, limit) {
    const nowIso = at();
    const gone = store.pendingAddressedTo([agent_id], limit).filter(item => lapsed(item, nowIso));
    if (gone.length) together(() => lapseAll(gone));
    return store.waitingCount(agent_id, { most: limit }) < limit;
  }

  // When the store need wake to let go of work whose asker stopped waiting, so it wakes for that and for nothing else:
  // the earliest take_by among open work (null when there is none), one read of the first entry of the index on take_by.
  // The scheduler keeps the answer (src/scheduler-memo.mjs) and asks again only after a handoff was written or this
  // source ran, so an arm (which every request makes) never pays for the question. Work taken since leaves it early,
  // which costs a wake that finds nothing. Until the take facts are complete (once they are, always) it is null, and a
  // store whose facts are not complete leaves lapsing to its takes.
  let factsReady = false;
  function nextLapseAt() {
    const takeable = store.takeable;
    if (!takeable || !(factsReady ||= takeable.ready())) return null;
    const by = Date.parse(takeable.earliest());
    return Number.isFinite(by) ? by : null;
  }

  // The same rule as a take's, for work nobody has come to take: lets go of at most `limit` open jobs whose take_by has
  // passed (lapsed above, nothing else), addressee by addressee through the index on take_by, looking at no more than
  // `addressees` of them. `from` is the addressee to start at (where the last sweep stopped); the answer names where the
  // next starts and says whether this one stopped with more to do, so a sweep costs the jobs it lets go of whatever
  // the store holds, and work whose take_by has not passed is never read.
  function sweepLapsed({ limit, addressees, from } = {}) {
    const takeable = store.takeable;
    const answer = { let_go: 0, from: undefined, more: false };
    if (!takeable || !(takeable.ready() || (takeable.step(), takeable.ready()))) return answer;
    const nowIso = at();
    let to = takeable.addressee({ from });
    for (let looked = 0; to !== undefined; looked += 1) {
      if (answer.let_go >= limit || looked >= addressees) return { ...answer, from: to, more: true };
      const entries = store.takeable.lapsed({ to_agent: to, nowIso, limit: limit - answer.let_go });
      const gone = entries.filter(item => lapsed(item, nowIso));
      if (gone.length) together(() => gone.forEach(lapse));
      answer.let_go += gone.length;
      // A full page that let some go may have more for the same addressee; anything else is finished with it.
      if (gone.length && entries.length === limit - (answer.let_go - gone.length)) return { ...answer, from: to, more: true };
      to = takeable.addressee({ after: to });
    }
    return answer;
  }

  // Review admission lives with the review owner and is checked by every actual take/finish route.
  const reviewProblem = (item, agent, result, deciding = false) => teamReviewProblem(item, {
    agent, candidate: item.input?.team_review?.candidate ? handoff(item.input.team_review.candidate.handoff_id) : null,
    cardFor: card, result, deciding,
  });
  // The scheduler asks only for this bounded selector of the one job already chosen as due. No children,
  // deliveries, job words or result are opened, and no queue row causes a separate broad handoff read.
  const reviewSelectionFor = handoff_id => {
    const at = handoff(handoff_id, { fields: ['input'] })?.input?.team_review;
    return at?.integrity && at.decides_field ? { integrity: { independent_actor: at.integrity.independent_actor },
      decides_field: at.decides_field, candidate: { agent_id: at.candidate?.agent_id } } : null;
  };
  const mayReview = (agent, item) => !reviewProblem(item, agent);
  const assertReview = (item, agent, result) => {
    const problem = reviewProblem(item, agent, result, true);
    if (problem) throw new AgentsError(problem, { tool: 'read_handoff', arguments: { handoff_id: item.handoff_id } });
  };

  // Oldest first: work addressed to this agent, then work addressed to nobody; a taken handoff whose hold has run
  // out counts as open again, so work an agent took and then lost is not stuck.
  function take(input = {}, { reader = null, onReviewDue } = {}) {
    const agent_id = text(input.agent_id, 'agent_id (the agent taking work, as published)', 200);
    const agent = card(agent_id);
    if (!agent) throw new AgentsError(`Publish ${agent_id} first, so the agent that handed the work can see who took it.`, { tool: 'publish_agent', arguments: { agent_id, name: '(this agent)', description: '(what it does)' } });
    // The AI taking work as this agent is where later work for it waits.
    if (reader && agent.reader !== reader) store.putCard({ ...agent, reader });
    const nowIso = at();
    const wanted = optionalText(input.handoff_id, 200);
    // A holder naming its exact active handoff extends its hold without a new wake, but never past the longest one
    // attempt may be held (holdEndOf): renewing shows the holder is there, not that the work moved, so work renewed
    // and never finished goes back up for any AI to take. An absent holder still expires normally.
    const current = wanted ? handoff(wanted) : null;
    if (current?.taken_by === agent_id && holding(current, nowIso)) {
      assertReview(current, agent, null);
      fenced(current, input.generation);
      assertClaimReader(current, reader);
      const hold_until = holdEndOf({ ...current, hold_until: minutesFrom(current.hold_minutes) });
      const generation = current.generation ?? 0;
      const renewed = put({ ...current, hold_until, attempts: (current.attempts ?? []).map(attempt => (attempt.generation === generation ? { ...attempt, hold_until } : attempt)) }, onReviewDue);
      const atLongest = hold_until === longestHoldOf(current);
      return { handoff: view(renewed), renewed: true, generation, hold_until,
        ...(!atLongest ? {} : { note: `${wanted} has been held since ${current.taken_at} and cannot be held past ${hold_until}. Finish it, say what is in the way, or release it before then; after that it goes back up for any AI to take.` }),
        next_call: { tool: 'finish_work', arguments: { handoff_id: wanted, agent_id, generation, result: '(what was done)' } } };
    }
    // Waiting work is available, and so is taken work whose hold ended; work still waiting for the handoffs it
    // depends on is not. Something in the way keeps work out of the automatic queue until it is taken by name.
    const available = item => !item.closing && (item.state === 'open' || (item.state === 'taken' && !holding(item, nowIso))) && !waitingOnOf(item).length;
    const queued = item => available(item) && !item.in_the_way && !lapsed(item, nowIso) && canTake(agent, item) && mayReview(agent, item);
    const capacity = capacityFor(agent, heldLoad(agent_id), nowIso);
    if (capacity.status === 'paused') return { handoff: null, capacity, note: `${agent_id} is published as not taking work. Publish it again with takes_work true to take work.` };
    // Full: the agent is told exactly which jobs it holds and the three ways to free a slot, never to report a bigger
    // number (raising it hides the jobs that hold it back).
    if (capacity.status === 'full') {
      const held = byPriority(heldBy(agent_id)).filter(item => workingOn(item, agent_id, nowIso)).map(item => {
        const generation = item.generation ?? 0;
        return { handoff_id: item.handoff_id, said: titleOf(item), taken_at: item.taken_at, hold_until: holdEndOf(item), generation,
          next_calls: [
            { tool: 'finish_work', arguments: { handoff_id: item.handoff_id, agent_id, generation, result: '(what was done)' } },
            { tool: 'say_what_is_in_the_way', arguments: { handoff_id: item.handoff_id, agent_id, generation, in_the_way: '(what stops it, in plain words)' } },
            { tool: 'release_work', arguments: { handoff_id: item.handoff_id, agent_id, generation, because: '(why it is given back)' } }] };
      });
      return { handoff: null, capacity, held,
        note: `${agent_id} holds ${held.length} ${held.length === 1 ? 'job' : 'jobs'}, as many as it said it can work on at once: ${held.map(item => item.handoff_id).join(', ')}. For each one, finish it with finish_work, say what is in the way with say_what_is_in_the_way, or give it back with release_work; then take_work again. A job nobody finishes goes back up for any AI to take when its hold ends.` };
    }
    // only_mine: work addressed to this agent and nothing else (a computer that runs its own tools never takes work
    // meant for whichever AI is free).
    const onlyMine = input.only_mine === true;
    // A preference that ran out lets any AI take the work, before the reconciler has even looked at it.
    const preferenceOver = item => item.target?.strict === false && item.target.prefer_until <= nowIso;
    // Every owner of the chat a job came from may take it, including one preferred for another owner of that chat.
    const ownsSource = item => Boolean(agent.source_id) && agent.takes_work && agent.source_id === item.input?.arrived?.source_id;
    const belongsHere = item => item.to_agent === agent_id
      || (item.to_agent && !onlyMine && (preferenceOver(item) || (item.target?.strict === false && ownsSource(item)) || openToAnyone(item, nowIso)))
      || (!item.to_agent && !onlyMine && (!item.input?.arrived?.source_id || ownsSource(item) || openToAnyone(item, nowIso)));
    // Work addressed to this agent first, then the open work any agent may take, a page at a time in the order it is
    // taken (highest priority, then oldest), stopping at the first that fits: never every open job at once.
    // A store that keeps the take facts (takeFactsOf) for every open job is read through them (until it does, a step of a few
    // a call, the open work is walked as before), and lets go of at most LAPSE_PAGE jobs in a take, the rest in the next
    // takes, so a take never costs more than that however much work was left to lapse.
    const indexed = !wanted && Boolean(store.takeable) && (store.takeable.ready() || (store.takeable.step(), store.takeable.ready()));
    let withdrawals = LAPSE_PAGE;
    const letGo = gone => {
      const some = indexed ? gone.slice(0, withdrawals) : gone;
      withdrawals -= some.length;
      if (some.length) together(() => lapseAll(some, onReviewDue));
      return some.length === gone.length;
    };
    const firstIn = (queue, fits, size = REVIEW_PAGE) => {
      for (let page = store.openQueue({ ...queue, nowIso, limit: size }); page.length; page = page.length < size ? [] : store.openQueue({ ...queue, nowIso, after: page.at(-1).handoff_id, limit: size })) {
        if (!letGo(page.filter(item => lapsed(item, nowIso)))) return undefined;
        const found = page.find(fits);
        if (found) return found;
      }
      return undefined;
    };
    // Then the work any agent may take comes from an index in the order it is taken, a few at a time, and the work whose
    // asker stopped waiting from another: so a take costs the job it takes, however much open work this agent cannot take.
    if (indexed) {
      for (const to_agent of onlyMine ? [agent_id] : [agent_id, '']) {
        if (withdrawals > 0) letGo(store.takeable.lapsed({ to_agent, nowIso, limit: withdrawals }).filter(item => lapsed(item, nowIso)));
      }
    }
    const anyone = indexed
      ? () => firstIn({ takeable: { source_id: agent.takes_work ? agent.source_id ?? '' : '' } }, item => queued(item) && belongsHere(item), TAKE_PAGE)
      : () => firstIn({}, item => queued(item) && belongsHere(item));
    const named = wanted ? handoff(wanted) : null;
    // An in-memory ask for this agent is offered in the same order as kept work: highest priority, then oldest.
    const ask = byPriority(openAsksFor(agent_id).filter(queued))[0];
    const kept = wanted ? undefined : firstIn({ to_agent: agent_id, ...(onlyMine ? { pointReads: true } : {}) }, queued, indexed ? TAKE_PAGE : REVIEW_PAGE);
    const askFirst = ask && (!kept || (ask.priority ?? 0) > (kept.priority ?? 0) || ((ask.priority ?? 0) === (kept.priority ?? 0) && ask.handed_at <= kept.handed_at));
    const chosen = wanted ? (named && named.state !== 'finished' && available(named) && !lapsed(named, nowIso) && canTake(agent, named) && mayReview(agent, named) && (agent.takes_any_by_name || belongsHere(named)) ? named : undefined)
      : (askFirst ? ask : kept) ?? (onlyMine ? undefined : anyone());
    if (!chosen) return { handoff: null, note: wanted ? `${wanted} is not waiting for ${agent_id}.` : 'Nothing is waiting for this agent right now.' };
    // A new attempt: the generation rises, so anything the earlier attempt still writes is refused.
    const expired = chosen.state === 'taken' ? endAttempt(chosen, 'expired') : chosen;
    const generation = (chosen.generation ?? 0) + 1;
    const hold_until = minutesFrom(chosen.hold_minutes);
    const attempt = { attempt_id: `${chosen.handoff_id}:${generation}`, agent_id, generation, taken_at: nowIso, hold_until, ended: null, ended_at: null,
      ...(typeof reader === 'string' && reader ? { claim_reader: reader } : {}) };
    // What was in the way belongs to the attempt that said it: it stays in that attempt's history, and the new attempt
    // starts with nothing in the way, so work a live AI holds never shows as blocked by an earlier one's note
    // (2026-10-11: h_390a showed blocked by a note from the day before while another AI worked it).
    const left = expired.in_the_way ? { in_the_way: String(expired.in_the_way), in_the_way_by: expired.in_the_way_by ?? null, in_the_way_at: expired.in_the_way_at ?? null } : null;
    const attempts = left ? (expired.attempts ?? []).map((past, index, all) => (index === all.length - 1 ? { ...past, left_in_the_way: left } : past)) : expired.attempts ?? [];
    const taken = put({ ...unblocked(expired), state: 'taken', taken_by: agent_id, taken_at: nowIso, hold_until, generation,
      attempts: [...attempts, attempt].slice(-MAX_ATTEMPTS_KEPT), review_at: null }, onReviewDue);
    const source_message_id = taken.input?.arrived?.message_id;
    return { handoff: view(taken), generation,
      coordinate_with: { tool: 'start_workflow', arguments: { purpose: COORDINATE_PURPOSE, request_key: chosen.handoff_id, input: { task: taken.job, ...(source_message_id ? { source_message_id } : {}) } } },
      next_call: { tool: 'finish_work', arguments: { handoff_id: chosen.handoff_id, agent_id, generation, result: '(what was done)' } } };
  }

  const RESULT_ADMISSION = { fields: ['generation', 'attempts', 'effects', 'result_source_receipt', 'finished_at', 'revision', 'input'] };
  function admitFinish(input = {}, projection = null, sourceFinish = false, reader = null, verifiedSourceAdmission = false) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const agent_id = text(input.agent_id, 'agent_id (the agent that took it)', 200);
    const current = sourceFinish ? (store.sourceFinish?.(handoff_id) ?? handoff(handoff_id)) : handoff(handoff_id, projection);
    if (!current) throw new AgentsError(`No handoff ${handoff_id} on this account.`);
    fenced(current, input.generation);
    if (current.taken_by !== agent_id || !['taken', 'finished'].includes(current.state))
      throw new AgentsError(`${handoff_id} is not taken by ${agent_id}; take it first.`, { tool: 'take_work', arguments: { agent_id, handoff_id } });
    if (!(verifiedSourceAdmission && legacySourceAdmission(current, input))) assertClaimReader(current, reader);
    const unsettled = Object.values(current.effects ?? {}).filter(unsettledEffect);
    if (unsettled.length) throw new AgentsError(`Effect ${unsettled[0].effect_id} is ${unsettled[0].state}: check its target and record it done or failed before finishing.`, { tool: 'record_effect', arguments: { handoff_id, agent_id, generation: current.generation ?? 0, effect_id: unsettled[0].effect_id, state: 'done' } });
    return current;
  }
  function admitResultSource(input = {}, { reader = null } = {}) {
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new AgentsError('result_source requires the exact taken generation.');
    return admitFinish(input, RESULT_ADMISSION, false, reader, true);
  }
  const sourceReceipt = (current, source, repeated = false) => ({
    handoff: { handoff_id: current.handoff_id, state: current.state, generation: current.generation ?? 0, finished_at: current.finished_at },
    result_source: { identity: source.identity, byte_length: source.byte_length, format: source.format },
    completion_receipt: true, ...(repeated ? { repeated: true } : {}),
  });
  function repeatedResultSource(input = {}, { reader = null } = {}) {
    const source = checkedResultSource(input.result_source), current = admitResultSource(input, { reader });
    const prior = current.result_source_receipt;
    if (current.state !== 'finished' || !prior) return null;
    if (prior.identity !== source.identity || prior.byte_length !== source.byte_length || prior.format !== source.format
        || prior.generation !== input.generation || prior.agent_id !== input.agent_id)
      throw new AgentsError(`${current.handoff_id} is already finished with another source result.`, { tool: 'read_handoff', arguments: { handoff_id: current.handoff_id } });
    return sourceReceipt(current, prior, true);
  }
  function resultSourceCapabilities(input = {}, { reader = null } = {}) {
    const current = admitResultSource(input, { reader }), capability = resultSourceCapability();
    const recovery = current.state === 'finished' && !current.result_source_receipt && !asks.has(current.handoff_id)
      ? store.legacyResultRecovery?.(current.handoff_id) : null;
    const historyRecovery = current.state === 'taken' && !asks.has(current.handoff_id)
      ? store.inlineHistoryRecovery?.(current.handoff_id) : null;
    const version = !asks.has(current.handoff_id) ? store.sourceAdmissionRecoveryVersion?.() : null;
    const bytes = input.result_byte_length;
    const expansion = version && Number.isSafeInteger(bytes) && bytes > HANDOFF_RESULT_SOURCE.prior_max_bytes && bytes <= capability.max_bytes
      ? { version, prior_max_bytes: HANDOFF_RESULT_SOURCE.prior_max_bytes, max_bytes: capability.max_bytes, result_byte_length: bytes } : null;
    return { ...capability,
      ...(recovery ? { legacy_result_recovery: { version: recovery } } : {}),
      ...(historyRecovery ? { inline_history_recovery: { version: historyRecovery } } : {}),
      ...(expansion ? { transport_limit_recovery: expansion } : {}) };
  }
  function prepareResultSource(input = {}, { reader = null } = {}) {
    const current = admitResultSource(input, { reader });
    if (current.state !== 'taken' || asks.has(current.handoff_id) || !store.inlineHistoryRecovery?.(current.handoff_id)) return false;
    together(() => {
      const admitted = admitResultSource(input, { reader });
      if (admitted.state !== 'taken') throw new AgentsError('The result lease changed during history recovery.');
      store.normalizeInlineHistory(current.handoff_id, { agent_id: input.agent_id, generation: input.generation, state: admitted.state, revision: admitted.revision ?? null });
    });
    return true;
  }
  function finish(input = {}, { reader = null, acceptedResultSource = null, acceptedResultJson = null, acceptedResultContent = null } = {}) {
    // Server-verified finished source retries start with narrow admission; never hydrate an oversized legacy answer.
    const verifiedSource = acceptedResultSource ? checkedResultSource(acceptedResultSource) : null;
    let current = verifiedSource ? admitResultSource(input, { reader }) : admitFinish(input, null, false, reader);
    const handoff_id = current.handoff_id, agent_id = text(input.agent_id, 'agent_id', 200);
    const result = input.result;
    if (result === undefined || result === null || (typeof result === 'string' && !result.trim())) throw new AgentsError('result is needed: what was done, as text or an object.');
    const summary = optionalText(input.summary, 2000);
    // Only the server's verified decoder sets this option; similarly named request fields are ignored.
    const result_source_receipt = verifiedSource ? { identity: verifiedSource.identity, byte_length: verifiedSource.byte_length, format: verifiedSource.format, generation: current.generation ?? 0, agent_id } : null;
    if (verifiedSource && current.state === 'finished' && !current.result_source_receipt && !asks.has(handoff_id)
        && store.legacyResultRecovery?.(handoff_id)) {
      return together(() => {
        // Namespace decode may yield. Recheck the exact generation, holder, finished state and settled effects here.
        const admitted = admitResultSource(input, { reader });
        if (admitted.state !== 'finished' || admitted.result_source_receipt || !store.legacyResultRecovery?.(handoff_id))
          throw new AgentsError('The result lease changed during recovery.');
        store.normalizeInlineHistory?.(handoff_id, { agent_id, generation: input.generation, state: admitted.state, revision: admitted.revision ?? null });
        if (!store.recoverLegacyResult(handoff_id, result, result_source_receipt, acceptedResultContent))
          throw new AgentsError('The finished result cannot be recovered by this owner.');
        return sourceReceipt(admitted, result_source_receipt, true);
      });
    }
    if (verifiedSource && current.state === 'taken' && !asks.has(handoff_id) && store.inlineHistoryRecovery?.(handoff_id)) {
      together(() => {
        const admitted = admitResultSource(input, { reader });
        if (admitted.state !== 'taken') throw new AgentsError('The result lease changed during history recovery.');
        store.normalizeInlineHistory(handoff_id, { agent_id, generation: input.generation, state: admitted.state, revision: admitted.revision ?? null });
      });
      // The lossless representation repair may remain if later semantic finish checks refuse; it establishes no finish.
      current = admitResultSource(input, { reader });
    }
    // Unsupported owners keep their full authoritative equality and ordinary finish behavior.
    if (verifiedSource) current = admitFinish(input, null, current.state === 'taken', reader);
    if (current.state === 'finished') {
      if (identity(current.result) === identity(result)) {
        if (!verifiedSource) return { handoff: view(current), repeated: true };
        // Legacy accepted inline/source results establish their immutable receipt only after full verified equality.
        const kept = current.result_source_receipt ? current : together(() => put({ ...current, result_source_receipt }));
        return sourceReceipt(kept, result_source_receipt, true);
      }
      throw new AgentsError(`${handoff_id} is already finished by ${current.taken_by}.`, { tool: 'read_handoff', arguments: { handoff_id } });
    }
    // A message or button is source work even when its carrier has no resumable chat.
    // All entry points use this owner: a web/chat receipt must not bypass the same
    // incomplete-result check enforced for a source-bound terminal session.
    let sourceLinked = false;
    const ancestors = new Set();
    for (let part = current; part && !ancestors.has(part.handoff_id); part = part.parent_handoff_id ? handoff(part.parent_handoff_id) : null) {
      ancestors.add(part.handoff_id);
      const arrived = part.input?.arrived;
      // Event batches, comments and calendar changes carry their source's label even when no single message id
      // names the arrival. A model transport receipt has tool_id/input instead and keeps its terminal-error shape.
      if (arrived?.source_id || arrived?.message_id || arrived?.asked_id || part.input?.source_id
        || (typeof arrived?.source === 'string' && arrived.source.trim())) { sourceLinked = true; break; }
    }
    const incomplete = value => /(?:^|[ _-])(?:wall|blocked|unverified|incomplete|pending|queued|waiting|working|running|delegated|handed[ _-]off)(?:$|[ _-])/i.test(String(value ?? ''));
    if (sourceLinked && object(result) && [result.state, result.status].some(incomplete))
      throw new AgentsError('This source-linked work is still waiting. Record what is in the way instead of finishing it.', { tool: 'say_what_is_in_the_way', arguments: { handoff_id, agent_id, in_the_way: '(the exact remaining obstacle)' } });
    if (sourceLinked) {
      // Older finished children may still have open descendants. Read the actual
      // parts, not just their parent's reported completion, before closing the job.
      const parts = [...store.handedOnFrom(handoff_id)], visited = new Set([handoff_id]);
      while (parts.length) {
        const part = parts.pop();
        if (visited.has(part.handoff_id)) continue;
        visited.add(part.handoff_id);
        if (part.state !== 'finished') throw new AgentsError('This source-linked work has unfinished parts. Read their results and complete the requested outcome before finishing the parent.',
          { tool: 'read_handoff', arguments: { handoff_id: part.handoff_id } });
        parts.push(...store.handedOnFrom(part.handoff_id));
      }
    }
    if (current.result_shape) {
      const problems = schemaProblems({ ...(object(result) ? result : { outcome: result }), ...(summary ? { summary } : {}) }, current.result_shape, 'result');
      if (problems.length) throw new AgentsError(`This work says what finishing it must include: ${problems.join('; ')}.`, { tool: 'read_handoff', arguments: { handoff_id } });
    }
    const finished = together(() => {
      assertReview(current, card(agent_id), result);
      checkFinish(current);
      const item = put({ ...endAttempt(current, 'finished'), state: 'finished', finished_at: at(), result,
        ...(verifiedSource && typeof acceptedResultJson === 'string' ? { [SOURCE_RESULT_JSON]: acceptedResultJson } : {}),
        ...(verifiedSource && acceptedResultContent ? { [SOURCE_RESULT_CONTENT]: acceptedResultContent } : {}),
        summary, result_source_receipt, review_at: null });
      enqueue('handoff.finished', item, [item.from_agent]);
      releaseDependents(handoff_id);
      return item;
    });
    const asker = finished.handed_by_reader ?? (finished.from_agent ? card(finished.from_agent)?.reader : null);
    if (asker && asker !== reader && forPerson(finished)) told({ moment: 'finished', handoff: view(finished), for_reader: asker, from_reader: reader });
    const agent = card(agent_id);
    if (agent && !finished.in_memory) store.putCard({ ...agent, finished: (agent.finished ?? 0) + 1 });
    // What follows finished work (a team review's next step, src/team-review.mjs) runs after it is kept, and a
    // failure there never undoes it.
    try { onFinished(view(finished)); } catch (error) { console.error('after finished work', error); }
    return verifiedSource ? sourceReceipt(finished, result_source_receipt) : { handoff: view(finished) };
  }

  // The source-bound receiver signs a report; the account checks the kept final AI message.
  // A handoff finish or HTTP delivery alone never establishes a result in the original chat.
  function confirmSourceReturn(input = {}, { raw, signature, message } = {}) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const agent_id = text(input.agent_id, 'agent_id', 200);
    const source_id = text(input.source_id, 'source_id', 500);
    const message_id = text(input.message_id, 'message_id', 300);
    const transcript_message_id = text(input.transcript_message_id, 'transcript_message_id', 300);
    const current = handoff(handoff_id);
    if (!current || current.state !== 'finished') throw new AgentsError('The handoff must have a finished work result before its source return can be verified.');
    if (current.input?.arrived?.source_id !== source_id || card(agent_id)?.source_id !== source_id
      || (current.to_agent !== agent_id && agent_id !== `session-${source_id.replace(':', '-')}`))
      throw new AgentsError('The handoff and source verifier must name the original chat.');
    const secret = store.deliverySecret(agent_id);
    if (!secret || typeof raw !== 'string' || !deliveryHolds(secret, signature, raw, Math.floor(now().getTime() / 1000)))
      throw new AgentsError('The source-bound receiver did not sign this result.');
    const outcome = typeof current.result === 'string' ? optionalText(current.result, 2000)
      : object(current.result) ? optionalText(current.result.outcome, 2000) : null;
    if (!outcome || (typeof current.result !== 'string' && !['completed', 'done'].includes(current.result.state)))
      throw new AgentsError('The finished work needs a completed state and a concrete outcome before its return can be verified.');
    if (message?.speaker !== 'ai' || message.conversation_id !== source_id || message.source_ref !== transcript_message_id
      || !message.text?.includes(handoff_id) || !message.text.includes(outcome)
      || !Number.isFinite(Date.parse(message.at)) || !Number.isFinite(Date.parse(message.recorded_at))
      || Date.parse(message.at) < Date.parse(current.finished_at)
      || Date.parse(message.recorded_at) < Date.parse(current.finished_at))
      throw new AgentsError('The original chat has no matching returned result message.');
    if (current.source_return?.verified) {
      if (current.source_return.message_id !== message_id || current.source_return.transcript_message_id !== transcript_message_id)
        throw new AgentsError('A different source result is already verified for this handoff.');
      return { handoff: view(current), repeated: true };
    }
    const verified = { ...current, source_return: { verified: true, source_id, message_id, transcript_message_id,
      verified_at: at(), outcome } };
    put(verified);
    return { handoff: view(verified) };
  }

  // Repair an incorrect finished state in place. Keep its result and who wrote it as
  // history; the same handoff becomes actionable again without creating a twin.
  function reopenIncorrectFinish(input = {}) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const evidence = text(input.evidence, 'evidence proving the finish was premature', 4000);
    const current = handoff(handoff_id);
    if (!current) throw new AgentsError(`No handoff ${handoff_id} on this account.`);
    if (current.withdrawal) throw new AgentsError('This work was explicitly withdrawn, not incorrectly completed. A new request must be handed off explicitly; this correction cannot resume it.');
    const withdrawnDependency = (current.depends_on ?? []).find(id => handoff(id)?.withdrawal);
    if (withdrawnDependency) throw new AgentsError('A required result was withdrawn. Create a new request with a valid prerequisite; this correction cannot resume it.', { tool: 'read_handoff', arguments: { handoff_id: withdrawnDependency } });
    if (current.state !== 'finished') {
      if (current.corrections?.at(-1)?.evidence === evidence) return { handoff: view(current), repeated: true };
      throw new AgentsError(`${handoff_id} is not finished.`, { tool: 'read_handoff', arguments: { handoff_id } });
    }
    const corrected = { ...current, state: 'open', taken_by: null, taken_at: null, hold_until: null,
      finished_at: null, result: null, summary: null, result_source_receipt: null,
      source_return: null,
      in_the_way: evidence, in_the_way_by: null, in_the_way_at: at(),
      corrections: [...(current.corrections ?? []), { corrected_at: at(), evidence,
        prior_finished_at: current.finished_at, prior_taken_by: current.taken_by,
        prior_result: current.result, prior_summary: current.summary }],
    };
    put(corrected);
    // Work that waited on it waits again, which each of them says with its next write.
    for (const next of store.dependentsOf(handoff_id)) put(next);
    if (corrected.to_agent) enqueue('handoff.created', corrected, [corrected.to_agent], `${handoff_id}:reopen:${corrected.corrections.length}`);
    return { handoff: view(corrected) };
  }

  // The AI holding a job, or the one it waits for, says what stands in the way of it (words), or that nothing does
  // (null). Work with something in the way is stuck until it is cleared or finished; the one who asked is told.
  function sayInTheWay(input = {}, { reader = null } = {}) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const agent_id = text(input.agent_id, 'agent_id (the agent holding the work, or the one it waits for)', 200);
    if (input.in_the_way !== null && typeof input.in_the_way !== 'string') throw new AgentsError('in_the_way is what stands in the way, in plain words, or null when nothing does any more.');
    const words = optionalText(input.in_the_way, 2000);
    const current = handoff(handoff_id);
    if (!current) throw new AgentsError(`No handoff ${handoff_id} on this account.`);
    if (current.state === 'finished') throw new AgentsError(`${handoff_id} is already finished.`, { tool: 'read_handoff', arguments: { handoff_id } });
    const holder = current.state === 'taken' ? current.taken_by : current.to_agent;
    if (holder !== agent_id) throw new AgentsError(`${handoff_id} is not held by or waiting for ${agent_id}; take it first.`, { tool: 'take_work', arguments: { agent_id, handoff_id } });
    if (current.state === 'taken') { fenced(current, input.generation); assertClaimReader(current, reader); }
    if ((current.in_the_way ?? null) === words) return { handoff: view(current), repeated: true };
    // Compatibility safety net for already-installed take-open-work helpers: their old claim-mode runner reports this
    // exact terminal state through say_what_is_in_the_way after its child exited. The run is over, so retaining its hold
    // can never advance the work. Release only that holder family and exact machine sentence; ordinary blockers from
    // every other agent keep their existing semantics. New helpers call release_work directly and never need this path.
    const endedUnfinished = current.state === 'taken' && agent_id.startsWith('take-open-work-')
      && /^The AI run for this job ended \(exit [-\d]+\) without finishing it; its words are in .+ on .+\.$/.test(words ?? '');
    if (endedUnfinished) {
      const released = put({ ...endAttempt(current, 'released'), state: 'open', taken_by: null, taken_at: null, hold_until: null,
        review_at: at(), wakes: 0, in_the_way: null, in_the_way_by: null, in_the_way_at: null, recovery: null, blocked_kind: null,
        released_because: words });
      return { handoff: view(released), released: true };
    }
    // Cleared work that nobody holds is due for review at once, so whoever can take it is woken again.
    const updated = put({ ...current, in_the_way: words, in_the_way_by: words ? agent_id : null, in_the_way_at: words ? at() : null, recovery: null, blocked_kind: null,
      ...(!words && current.state === 'open' ? { review_at: at(), wakes: 0 } : {}) });
    const asker = updated.handed_by_reader ?? (updated.from_agent ? card(updated.from_agent)?.reader : null);
    if (words && asker && asker !== reader && forPerson(updated)) told({ moment: 'stuck', handoff: view(updated), for_reader: asker, from_reader: reader });
    return { handoff: view(updated) };
  }

  // Closes waiting work nobody holds now, as `by` (src/close-many.mjs, after a helper sorted it): the same finished
  // record finish() keeps, with no attempt of its own. Closing it again changes nothing.
  // Work nobody has taken yet, withdrawn by the agent that handed it (a tool run whose computer did not answer in
  // time), so it is never taken later.
  function withdraw(input = {}, { only_if_idle = false } = {}) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const by = text(input.by, 'by (who handed it)', 200);
    const current = handoff(handoff_id);
    if (!current) throw new AgentsError(`No handoff ${handoff_id} on this account.`);
    if (current.state === 'finished') return { handoff: view(current), repeated: true };
    if (current.from_agent !== by) throw new AgentsError(`Only ${current.from_agent ?? 'who handed it'} can withdraw ${handoff_id}.`);
    // An internal queue may retire only its own idle carrier after its asks are gone. The same guard as public
    // withdrawal preserves effects, parts and dependents; naming a receiver or reserving closure also leaves it alone.
    if (only_if_idle && (current.to_agent || withdrawalProblem(current))) return { handoff: view(current), withdrawn: false };
    if (current.state !== 'open') throw new AgentsError(`${handoff_id} is already being worked on by ${current.taken_by}.`);
    const item = together(() => {
      const withdrawal = only_if_idle ? { by, reason: text(input.reason, 'reason', 2000), at: at(), revision: current.revision } : null;
      const kept = put({ ...current, state: 'finished', finished_at: at(),
        ...(withdrawal ? { withdrawal, result: { state: 'withdrawn', by, reason: withdrawal.reason } } : { result: input.result ?? null }),
        summary: optionalText(input.summary, 2000), review_at: null });
      if (withdrawal) enqueue('handoff.finished', kept, [kept.from_agent]);
      else releaseDependents(handoff_id);
      return kept;
    });
    if (only_if_idle) { try { onWithdrawn(view(item)); } catch (error) { console.error('after withdrawn work', error); } }
    return { handoff: view(item), ...(only_if_idle ? { withdrawn: true } : {}) };
  }

  function withdrawalProblem(current) {
    if (current.closing) return new AgentsError('This work has a reserved closure in progress. Retry that original close request before withdrawing it.');
    if (current.state !== 'open') return new AgentsError('Only waiting work can be withdrawn; taken or finished work is unchanged.', { tool: 'read_handoff', arguments: { handoff_id: current.handoff_id } });
    const unsettled = item => Object.values(item.effects ?? {}).find(unsettledEffect);
    const effect = unsettled(current);
    if (effect) return new AgentsError(`Effect ${effect.effect_id} is ${effect.state}; check its target and settle it before withdrawing this work.`);
    const parts = [...store.handedOnFrom(current.handoff_id)], visited = new Set([current.handoff_id]);
    while (parts.length) {
      const part = parts.pop();
      if (visited.has(part.handoff_id)) continue;
      visited.add(part.handoff_id);
      if (part.state !== 'finished' || unsettled(part)) return new AgentsError('This work has unfinished parts or unsettled effects. Resolve them individually before withdrawing the parent.', { tool: 'read_handoff', arguments: { handoff_id: part.handoff_id } });
      parts.push(...store.handedOnFrom(part.handoff_id));
    }
    const dependent = store.dependentsOf(current.handoff_id).find(item => item.state !== 'finished');
    if (dependent) return new AgentsError('Other unfinished work depends on this result. Resolve that dependency before withdrawing it.', { tool: 'read_handoff', arguments: { handoff_id: dependent.handoff_id } });
    return null;
  }

  // Public withdrawal is narrower than internal tool-timeout cleanup above. It stops only waiting work without unfinished parts;
  // it never claims the requested outcome happened, interrupts a holder, settles an effect or closes another job.
  // `person` is host context from the signed-in Work screen, never an input field or an MCP caller's claim.
  function withdrawWaiting(input = {}, { reader = null, person = false } = {}) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const reason = text(input.reason, 'reason (why this waiting work is no longer wanted)', 2000);
    const current = handoff(handoff_id);
    if (!current) throw new AgentsError(`No handoff ${handoff_id} on this account.`);
    const by = person ? 'you' : text(input.agent_id, 'agent_id (the agent that handed it)', 200);
    // The original authenticated reader is kept with the request. A newly published card with the same name is
    // not proof of ownership, and older internal jobs without this proof can be withdrawn only by the person.
    if (!person && (!reader || current.handed_by_reader !== reader || current.from_agent !== by))
      throw new AgentsError('Only the authenticated sender of this work, or the person in their Work screen, can withdraw it.');
    if (current.withdrawal) {
      if (current.withdrawal.by === by && current.withdrawal.reason === reason) return { handoff: view(current), repeated: true };
      throw new AgentsError('This work was already withdrawn with a different reason. Read its kept history.');
    }
    if (current.closing) throw new AgentsError('This work has a reserved closure in progress. Retry that original close request before withdrawing it.');
    if (current.state !== 'open') throw new AgentsError('Only waiting work can be withdrawn; taken or finished work is unchanged.', { tool: 'read_handoff', arguments: { handoff_id } });
    if (!Number.isInteger(input.revision) || input.revision !== current.revision)
      throw new AgentsError('This work changed since it was read. Read its current revision before withdrawing it.', { tool: 'read_handoff', arguments: { handoff_id } });
    const problem = withdrawalProblem(current);
    if (problem) throw problem;
    const item = together(() => {
      const withdrawal = { by, reason, at: at(), revision: current.revision };
      const kept = put({ ...current, state: 'finished', finished_at: withdrawal.at, withdrawal,
        result: { state: 'withdrawn', by, reason }, summary: `Withdrawn: ${reason}`, review_at: null,
        in_the_way: null, in_the_way_by: null, in_the_way_at: null, recovery: null, blocked_kind: null });
      enqueue('handoff.finished', kept, [kept.from_agent]);
      return kept;
    });
    // Wake only terminal-state consumers: withdrawal must not advance a review/decision success hook.
    try { onWithdrawn(view(item)); } catch (error) { console.error('after withdrawn work', error); }
    return { handoff: view(item) };
  }

  // The owner checks eligibility before asynchronous source decisions and again at final closure. A durable
  // reservation is unfinished work: it fences other takers and resumes only the same kept triage intent.
  const closingActive = new Map();
  function checkCloseWaiting(input = {}) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const current = handoff(handoff_id);
    if (!current) throw new AgentsError(`No handoff ${handoff_id} on this account.`);
    if (input.reservation_token && current.state !== 'open') throw new AgentsError('The closure reservation is no longer current. Nothing further may be decided.');
    if (current.state === 'finished') return { handoff: view(current), repeated: true };
    if (current.closing) {
      if (input.reservation_token !== current.closing.token || current.revision !== current.closing.revision || current.generation !== current.closing.generation)
        throw new AgentsError('This work has a reserved closure in progress or changed since it was reserved. Retry the original close request.');
    } else if (input.reservation_token) throw new AgentsError('The closure reservation is no longer current. Nothing further may be decided.');
    if (input.revision !== undefined && input.revision !== current.revision) throw new AgentsError('This work changed since it was read. Read it again before closing.');
    if (current.to_agent) throw new AgentsError(`${handoff_id} is handed to ${current.to_agent} by name, so only it closes it.`);
    if (holding(current, at())) throw new AgentsError(`${handoff_id} is being worked on by ${current.taken_by}.`);
    if (!['open', 'taken'].includes(current.state)) throw new AgentsError('This work is not eligible for waiting-work closure.');
    const unsettled = item => Object.values(item.effects ?? {}).some(unsettledEffect);
    if (unsettled(current)) throw new AgentsError('This work has unsettled effects. Check their targets before closing it.');
    const parts = [...store.handedOnFrom(handoff_id)], visited = new Set([handoff_id]);
    while (parts.length) {
      const part = parts.pop();
      if (visited.has(part.handoff_id)) continue;
      visited.add(part.handoff_id);
      if (part.state !== 'finished' || unsettled(part)) throw new AgentsError('This work has unfinished parts or unsettled effects. Resolve them before closing it.');
      parts.push(...store.handedOnFrom(part.handoff_id));
    }
    return { handoff: view(current) };
  }
  function reserveCloseWaiting(input = {}) {
    const by = text(input.by, 'by (who closes it)', 200);
    if (!object(input.intent)) throw new AgentsError('A closure needs its exact intended outcome and reason.');
    return together(() => {
      const existing = handoff(text(input.handoff_id, 'handoff_id', 200));
      if (existing?.closing && (existing.closing.by !== by || identity(existing.closing.intent) !== identity(input.intent)))
        throw new AgentsError('This work already has a different closure intent. The original close request must be resolved first.');
      if (existing?.closing && closingActive.get(existing.handoff_id) === existing.closing.token)
        throw new AgentsError('This exact closure is already running. Read it after that attempt finishes.');
      const checked = checkCloseWaiting({ ...input, ...(existing?.closing ? { reservation_token: existing.closing.token } : {}) });
      if (checked.repeated) return checked;
      const current = handoff(input.handoff_id), generation = (current.generation ?? 0) + 1;
      const token = identity([current.handoff_id, generation, at(), input.intent]);
      const closing = { by, intent: input.intent, token, generation, revision: (current.revision ?? 0) + 1,
        started_at: current.closing?.started_at ?? at(), attempted_at: at(), ...(current.closing?.digest_handoff_id ? { digest_handoff_id: current.closing.digest_handoff_id } : {}),
        ...(current.closing?.source_decision ? { source_decision: current.closing.source_decision } : {}),
        ...(current.closing?.group_admission ? { group_admission: current.closing.group_admission } : {}) };
      const item = put({ ...(current.state === 'taken' ? endAttempt(current, 'expired') : current), state: 'open',
        taken_by: null, taken_at: null, hold_until: null, generation, closing, review_at: null,
        in_the_way: 'The original close request is completing its source decision.', in_the_way_by: by, in_the_way_at: at(),
        recovery: 'Retry the same close-many item and reason to resume its kept intent; do not run this work in parallel.' });
      closingActive.set(item.handoff_id, token);
      return { handoff: view(item), reservation_token: token, digest_handoff_id: closing.digest_handoff_id ?? null, source_decision: closing.source_decision ?? null, group_admission: closing.group_admission ?? null };
    });
  }
  function checkCloseReservation(input = {}) {
    const current = handoff(input.handoff_id);
    if (!current?.closing || current.closing.token !== input.reservation_token) throw new AgentsError('The closure reservation is no longer current. Nothing further may be decided.');
    return checkCloseWaiting(input);
  }
  function keepCloseDigest(input = {}) {
    checkCloseReservation(input);
    const current = handoff(input.handoff_id);
    const digest = text(input.digest_handoff_id, 'digest_handoff_id', 200);
    if (!handoff(digest)) throw new AgentsError('The digest must already be kept on this account.');
    if (current.closing.digest_handoff_id && current.closing.digest_handoff_id !== digest) throw new AgentsError('The reserved closure already names another digest.');
    if (current.closing.digest_handoff_id === digest) return;
    put({ ...current, closing: { ...current.closing, revision: (current.revision ?? 0) + 1, digest_handoff_id: digest } });
  }
  // Keep exactly which source decision this closure began before calling the async decision owner. A retry may
  // finish that same decision's carried-out receipt; it must never carry out some other already-decided request.
  function keepCloseSource(input = {}) {
    checkCloseReservation(input);
    const field = input.source_decision ? 'source_decision' : 'group_admission';
    if (!object(input[field])) throw new AgentsError('The source closure needs its kept decision or admission intent.');
    const current = handoff(input.handoff_id), existing = current.closing[field];
    if (existing && identity(existing) !== identity(input[field])) throw new AgentsError('The reserved closure already names another source decision intent.');
    if (existing) return;
    put({ ...current, closing: { ...current.closing, revision: (current.revision ?? 0) + 1, [field]: input[field] } });
  }
  function closeWaitingFailed(input = {}) {
    if (closingActive.get(input.handoff_id) === input.reservation_token) closingActive.delete(input.handoff_id);
    const current = handoff(input.handoff_id);
    if (current?.state !== 'open' || !current.closing || current.closing.token !== input.reservation_token) return;
    put({ ...current, closing: { ...current.closing, revision: (current.revision ?? 0) + 1, last_error: optionalText(input.error, 600), failed_at: at() },
      in_the_way: 'The original close request did not finish its source decision. Retry the same item and reason.', review_at: null });
  }
  function closeWaiting(input = {}) {
    const by = text(input.by, 'by (who closes it)', 200);
    const checked = checkCloseWaiting(input);
    if (checked.repeated) return checked;
    const current = handoff(input.handoff_id);
    const finished = together(() => {
      assertReview(current, card(by), input.result);
      checkFinish(current);
      const { closing: _reservation, ...base } = current;
      const item = put({ ...(base.state === 'taken' ? endAttempt(base, 'expired') : base), state: 'finished', taken_by: by, finished_at: at(), hold_until: null,
        result: input.result ?? null, summary: optionalText(input.summary, 2000), review_at: null, in_the_way: null, in_the_way_by: null, in_the_way_at: null, recovery: null, blocked_kind: null });
      enqueue('handoff.finished', item, [item.from_agent]);
      releaseDependents(item.handoff_id);
      return item;
    });
    closingActive.delete(current.handoff_id);
    return { handoff: view(finished) };
  }

  // The AI holding a job gives it back at once (it cannot finish it now, for example because the account keeps
  // answering busy), instead of holding it until its hold runs out: the attempt ends as released and the work waits
  // for whoever can take it next.
  function release(input = {}, { reader = null } = {}) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const agent_id = text(input.agent_id, 'agent_id (the agent holding the work)', 200);
    const current = handoff(handoff_id);
    if (!current) throw new AgentsError(`No handoff ${handoff_id} on this account.`);
    if (current.state !== 'taken' || current.taken_by !== agent_id) throw new AgentsError(`${handoff_id} is not held by ${agent_id}.`, { tool: 'read_handoff', arguments: { handoff_id } });
    fenced(current, input.generation);
    assertClaimReader(current, reader);
    const released = put({ ...endAttempt(current, 'released'), state: 'open', taken_by: null, taken_at: null, hold_until: null, review_at: at(), wakes: 0,
      released_because: optionalText(input.because, 500) });
    return { handoff: view(released) };
  }

  // What a release whose call is gone did, read from the handoff it names (its readback): the attempt of that agent (at
  // that generation, else its latest) ended as released is the release, with the handoff as it is now; an attempt it
  // still holds is a release never made; anything else is unknown. Reads only.
  function releaseOutcome(input = {}) {
    const current = handoff(optionalText(input.handoff_id, 200) ?? '');
    const mine = (current?.attempts ?? []).filter(attempt => attempt.agent_id === input.agent_id
      && (input.generation === undefined || attempt.generation === input.generation)).at(-1);
    if (mine?.ended === 'released') return { state: 'committed', result: { handoff: view(current) } };
    if (mine && !mine.ended && current.state === 'taken' && current.taken_by === input.agent_id) return { state: 'aborted' };
    return { state: 'unknown' };
  }

  // What a source-return confirmation whose call is gone did: the verification kept for that message is the
  // confirmation; finished work with none kept was never confirmed (one write keeps it). Reads only.
  function sourceReturnOutcome(input = {}) {
    const current = handoff(optionalText(input.handoff_id, 200) ?? '');
    const kept = current?.source_return;
    if (kept?.verified && kept.message_id === input.message_id && kept.transcript_message_id === input.transcript_message_id)
      return { state: 'committed', result: { handoff: view(current) } };
    if (current?.state === 'finished' && !kept) return { state: 'aborted' };
    return { state: 'unknown' };
  }

  // The cards a reader (the sign-in an AI came in as) takes work as, and the work one card holds now.
  const cardsOfReader = reader => store.cardIdsOf({ reader });
  const heldIds = agent_id => store.heldBy(agent_id).filter(item => holding(item, at())).map(item => item.handoff_id);
  // The work that arrived from one kept message or one button press (its arrival names the message or the press's
  // asked_id), oldest first, with every part handed on from it, each once: the whole job a message or a press started.
  function fromMessage(message_id) {
    const jobs = [];
    const seen = new Set();
    const add = item => { if (item && !seen.has(item.handoff_id) && jobs.length < 50) { seen.add(item.handoff_id); jobs.push(item); store.handedOnFrom(item.handoff_id).forEach(add); } };
    store.fromMessage(message_id).forEach(add);
    return jobs.map(view);
  }
  // One job with every part handed on from it.
  function withParts(handoff_id) {
    const jobs = [];
    const seen = new Set();
    const add = item => { if (item && !seen.has(item.handoff_id) && jobs.length < 50) { seen.add(item.handoff_id); jobs.push(item); store.handedOnFrom(item.handoff_id).forEach(add); } };
    add(handoff(handoff_id));
    return jobs.map(view);
  }

  function read(input = {}) {
    const handoff_id = optionalText(input.handoff_id, 200);
    if (handoff_id) {
      const found = handoff(handoff_id);
      if (!found) throw new AgentsError(`No handoff ${handoff_id} on this account.`);
      const handed_on = store.handedOnFrom(handoff_id).map(view);
      return { handoff: view(found), handed_on, progress: progressOfParts(handed_on), deliveries: store.deliveriesFor(handoff_id).map(deliveryOutward) };
    }
    const handoffs = store.newestHandoffs(MAX_LISTED).map(view);
    return { handoffs };
  }

  // A connecting MCP client sees work addressed to its authenticated reader before it calls any tool.
  // Keep the handshake small; read_handoff carries the full job and input.
  function pendingForReader(reader) {
    if (!reader) return [];
    // The MCP handshake needs only a few titles. A busy account can have thousands
    // of open jobs with large inputs; never materialize all of them to greet one AI. A store that keeps the reader of each
    // waiting job answers with one range of that index, however many cards the reader has published (716 on one large store).
    const kept = store.pendingForReader?.(reader, MAX_LISTED);
    let pending = kept;
    if (!kept) {
      const ids = new Set(store.cardIdsOf({ reader, takes_work: true }));
      if (!ids.size) return [];
      pending = store.pendingAddressedTo([...ids], MAX_LISTED).filter(item => ids.has(item.to_agent));
    }
    return byPriority(pending).filter(item => item.state === 'open').slice(0, MAX_LISTED)
      .map(item => ({ handoff_id: item.handoff_id, title: item.job.slice(0, 160), from: item.from_agent, created_at: item.handed_at }));
  }

  // The account's work for a person's own screen: the newest work still open, up to MAX_BOARD_PAGE jobs (waiting, or
  // taken and being worked on), a page of finished work newest first (before names the last finished handoff of the page before), and
  // every published agent with its load. Each handoff keeps the reader that handed it and every child it handed on.
  function board(input = {}) {
    const limit = Math.min(Math.max(Number(input.limit) || BOARD_PAGE, 1), MAX_BOARD_PAGE);
    const before = optionalText(input.before, 700);
    let openCursor = null;
    if (before?.startsWith('open-work:')) {
      try { openCursor = JSON.parse(before.slice('open-work:'.length)); } catch { /* Invalid cursors name no page. */ }
      if (!Array.isArray(openCursor) || openCursor.length !== 2 || typeof openCursor[0] !== 'string' || openCursor[0].length > 200 || !(openCursor[1] === null || typeof openCursor[1] === 'string' && openCursor[1].length <= 200))
        return { work: [], agents: [], next_before: null };
    }
    const nativeIds=input.native_ids;
    if(nativeIds!==undefined&&(!Array.isArray(nativeIds)||nativeIds.length>100||nativeIds.some(id=>typeof id!=='string')))throw new Error('Read at most100 native work rows by identity.');
    const selected=nativeIds?.map(id=>handoff(id)).filter(Boolean);
    const nowIso = at();
    // summary: the AIs and no work, for a caller that counts or lists the AIs; no job is read, and no AI's load.
    if (input.summary) {
      return { work: [], agents: store.cards().map(agent => ({
        agent_id: agent.agent_id, name: agent.name, description: agent.description, harness: agent.harness ?? null, model: agent.model ?? null,
        reader: agent.reader ?? null, takes_work: agent.takes_work, finished: agent.finished ?? 0, last_seen_at: agent.last_seen_at ?? null,
      })), next_before: null };
    }
    // Ordinary reads use their declared/default page size before reading job
    // bodies and children. Home retains its compact grouping window, and exact
    // native selections retain their original selection contract. Older open
    // work stays reachable through the existing open-work cursor below.
    // parent: only the work handed on from that job, open and finished together, newest handed first (store.partsPage),
    // so a list over one job's parts reads one bounded page of its own index.
    const parent = selected ? null : optionalText(input.parent, 200);
    const openSize = input.fields === 'home' || selected ? MAX_BOARD_PAGE : limit;
    const openRows = parent ? [] : selected ? selected.filter(item=>item.state!=='finished') : openCursor ? store.newestOpen(openSize + 1, { before: openCursor[0] })
      : before ? [] : (input.fields === 'home' ? store.homeOpen?.(openSize) : null) ?? store.newestOpen(openSize + 1);
    const open = openRows.slice(0, openSize);
    const finished = parent ? store.partsPage(parent, { before: before === FINISHED_FIRST ? null : before, limit: limit + 1 })
      : selected ? input.fields==='home'?[]:selected.filter(item=>item.state==='finished') : openCursor ? [] : store.finishedHandoffs({ before: before === FINISHED_FIRST ? null : before, limit: limit + 1 });
    const page = finished.slice(0, limit);
    const nextFinished = openCursor ? openCursor[1] : finished.length > limit ? page.at(-1).handoff_id : null;
    // The same Show older cursor first walks the remaining open work, then resumes the finished page.
    // A bound must never make older open jobs unreachable. Home keeps its compact newest-work summary.
    let nextBefore = input.fields !== 'home' && openRows.length > openSize
      ? `open-work:${JSON.stringify([open.at(-1).handoff_id, nextFinished])}` : nextFinished;
    const visible = [...open, ...page].filter(forPerson);
    // Home's workstreams card draws a few words per job. The open jobs come from the store's home index (their state, what
    // stands in the way, the job each was handed on from and their words, from the keys alone), so no job is read whole
    // nor rebuilt (inputs, results, attempts, effects, next step, children), and the agents with their loads are not read.
    // The card titles a job by its `said`, which is never empty, so the job's own words are not sent.
    if (input.fields === 'home') {
      return { work: visible.map(item => ({
        handoff_id: item.handoff_id, status: statusOf(item), job: '', said: titleOf(item), in_the_way: item.in_the_way ?? null,
        parent_handoff_id: item.parent_handoff_id ?? null, handed_at: item.handed_at, finished_at: item.finished_at ?? null,
      })), agents: [], next_before: finished.length > limit ? page.at(-1).handoff_id : null };
    }
    const children = store.handedOnFromMany(visible.map(item => item.handoff_id));
    const handedOn = item => (children.get(item.handoff_id) ?? []).map(child => child.handoff_id);
    // rows: 'screen' is the AI work screen's rows: only what the screen draws (its short title, where each job is, who
    // has it, what is in the way, what came of it), never a job's whole words, inputs, results, attempts or effects.
    const rowOf = input.rows === 'screen' ? item => ({
      handoff_id: item.handoff_id, state: item.state, status: statusOf(item), job: '', said: titleOf(item),
      in_the_way: item.in_the_way ?? null, in_the_way_by: item.in_the_way_by ?? null, in_the_way_at: item.in_the_way_at ?? null,
      to_agent: item.to_agent, from_agent: item.from_agent, case_id: item.case_id, parent_handoff_id: item.parent_handoff_id,
      depends_on: item.depends_on ?? [], handed_at: item.handed_at, taken_by: item.taken_by, taken_at: item.taken_at, hold_until: item.hold_until,
      finished_at: item.finished_at, summary: typeof item.summary === 'string' && item.summary.length > SCREEN_SUMMARY_MAX ? `${item.summary.slice(0, SCREEN_SUMMARY_MAX - 1)}…` : item.summary,
      handed_by_reader: item.handed_by_reader ?? null, handed_on: handedOn(item),
    }) : item => ({ ...view(item), handed_by_reader: item.handed_by_reader ?? null, handed_on: handedOn(item) });
    // A job with parts says how many of them finished with a result, from the one read of the parts above
    // (src/work-progress.mjs); one without parts has nothing to count and says Not measured.
    const all = visible.map(item => ({ ...rowOf(item), progress: progressOfParts(children.get(item.handoff_id) ?? []) }));
    const keep = rowsFitting(all);
    const listed = all.slice(0, keep);
    // A page that ended early reads on from its last job: the rest of the open work, then the finished work (from its
    // newest when none was shown yet), or the rest of the finished page.
    if (keep < all.length) {
      const last = visible[keep - 1].handoff_id;
      const inOpen = open.some(item => item.handoff_id === last);
      nextBefore = inOpen ? `open-work:${JSON.stringify([last, openCursor ? openCursor[1] : FINISHED_FIRST])}`
        : openRows.length > openSize ? `open-work:${JSON.stringify([open.at(-1).handoff_id, last])}` : last;
    }
    const cards = input.agent_scope === 'work' ? cardsForWork(visible.slice(0, keep)) : store.cards();
    const loads = store.boardAgentLoads?.(cards.map(agent => agent.agent_id));
    const agents = cards.map(agent => ({
      agent_id: agent.agent_id, name: agent.name, description: agent.description, harness: agent.harness ?? null, model: agent.model ?? null,
      reader: agent.reader ?? null, takes_work: agent.takes_work, finished: agent.finished ?? 0, last_seen_at: agent.last_seen_at ?? null,
      capacity: capacityFor(agent, loads ? loads.held.get(agent.agent_id) ?? [] : store.heldBy(agent.agent_id), nowIso),
      waiting_for_it: loads ? loads.waiting.get(agent.agent_id) ?? 0 : store.waitingCount(agent.agent_id),
    }));
    return { work: listed, agents, next_before: selected?null:nextBefore, ...(selected?{native_selection:{pending:visible.slice(keep).map(item=>item.handoff_id)}}:{}) };
  }

  // The work something stands in the way of, newest handed first, at most `limit`, as the board draws a job. The store's
  // blocked index names them; while a store is still building it, the newest `size` open jobs are looked through instead
  // (the same page size, never the board's whole open page), so an older stuck job shows once the index is ready.
  function stuckWork({ limit = BOARD_PAGE, rows = null } = {}) {
    const size = Math.min(Math.max(Number(limit) || BOARD_PAGE, 1), MAX_BOARD_PAGE);
    const found = store.blockedOpen?.(size, rows === 'cards' ? { fields: ['said', 'state', 'in_the_way', 'handed_at', 'from_agent'], titleFallback: true } : undefined)
      ?? store.newestOpen(size, rows === 'cards' ? { fields: ['handoff_id', 'said', 'state', 'in_the_way', 'handed_at', 'from_agent'], titleFallback: true } : undefined)
        .filter(item => statusOf(item) === 'blocked');
    if (rows === 'cards') return { work: found.map(item => {
      // A legacy title is derived by the same owner, but only missing titles
      // need the full job. Cards never consume lifecycle/dependency/child data.
      const titled = typeof item.said === 'string' && item.said.trim() ? item
        : item.job !== undefined ? item : store.handoff(item.handoff_id) ?? item;
      return { handoff_id: item.handoff_id, status: statusOf(item), said: titleOf(titled),
        in_the_way: item.in_the_way ?? null, handed_at: item.handed_at, from_agent: item.from_agent ?? null };
    }) };
    const children = store.handedOnFromMany(found.map(item => item.handoff_id));
    return { work: found.map(item => ({ ...view(item), handed_by_reader: item.handed_by_reader ?? null, handed_on: (children.get(item.handoff_id) ?? []).map(child => child.handoff_id) })) };
  }

  // A feed needs recent work and who holds it, without the board's per-job child/status reads or each card's load.
  // Keep the board's open and finished bounds; a busy account must not materialize its entire open queue.
  function recentWork({ limit = BOARD_PAGE, states = ['open', 'taken', 'finished'], projection = null } = {}) {
    const selectedProjection = handoffProjection(projection);
    if (!Array.isArray(states) || states.some(state => !['open', 'taken', 'finished'].includes(state))) throw new Error('Recent work states must be open, taken or finished.');
    const selected = new Set(states);
    const finishedLimit = Math.min(Math.max(Number(limit) || BOARD_PAGE, 1), MAX_BOARD_PAGE);
    // Admit only the requested lanes before opening jobs. A finished-work tally
    // must not load the instructions and results of an unrelated open queue.
    const open = selected.has('open') || selected.has('taken') ? store.newestOpen(MAX_BOARD_PAGE, { projection: selectedProjection }) : [];
    const finished = selected.has('finished') ? store.finishedHandoffs({ limit: finishedLimit, projection: selectedProjection }) : [];
    const work = [...open, ...finished].filter(item => selected.has(item.state) && forPerson(item))
      .map(item => selectedProjection ? projectHandoff(item, selectedProjection) : ({ ...item, said: titleOf(item) }));
    return {
      work,
      agents: cardsForWork(work).map(({ agent_id, name, reader }) => ({ agent_id, name, reader })),
    };
  }

  // The notification policy supplies its own cap, finished-work window and excluded origins. Board pagination is
  // a different question: selecting its newest handoffs first can hide the result of older work that just finished.
  function notificationWork(options) {
    const work = store.notificationWork({ ...options, exclude_from: [...new Set([...(options?.exclude_from ?? []), ...AI_SIDE_ONLY])] }).map(item => ({ ...item, said: titleOf(item) }));
    return {
      work,
      agents: cardsForWork(work).map(({ agent_id, name, reader }) => ({ agent_id, name, reader })),
    };
  }

  // Work pages need names and loads only for the agents those jobs refer to. The full directory is a separate read.
  // Resolve exact card identities so unrelated published cards add neither reads nor bytes to a bounded work page.
  function cardsForWork(work) {
    return workAgentCards(store, work);
  }

  // The one mutation used by the scheduler's bounded historical duplicate fold. Re-read both jobs within its page
  // transaction: a holder is never closed, and a reference to a job that has finished is never written.
  function closeDuplicate({ handoff_id, kept_id, item: key, by }) {
    const duplicate = store.handoff(handoff_id);
    if (!duplicate || duplicate.state === 'finished' || handoff_id === kept_id) return null;
    const kept = store.handoff(kept_id);
    if (!kept || kept.state === 'finished' || itemOf(kept) !== key || itemOf(duplicate) !== key) return { stale: true };
    const nowIso = at();
    if (holding(duplicate, nowIso)) return null;
    put({ ...(duplicate.state === 'taken' ? endAttempt(duplicate, 'expired') : duplicate), state: 'finished', taken_by: by,
      finished_at: nowIso, hold_until: null, result: { kind: 'duplicate', duplicate_of: kept_id, item: key },
      summary: `The same work as ${kept_id}, which stays open.`, review_at: null });
    releaseDependents(handoff_id);
    return { handoff_id, duplicate_of: kept_id };
  }

  // Is the job of this item (its once_per or message id) still open and untaken: a late member may then join it.
  function openUntaken(key) {
    const handoff = store.handoff(handoffIdFor(`once-per:${key}`));
    return Boolean(handoff) && handoff.state === 'open' && !handoff.taken_by && !holding(handoff, at());
  }

  // May a later arrival with the same words join this item's job: its job is not handed out yet (the starting rule has not
  // run) or is open and untaken. A taken, held or finished job is someone's work: the same words again are a new request.
  function mergeable(key) {
    const handoff = store.handoff(handoffIdFor(`once-per:${key}`));
    return !handoff || (handoff.state === 'open' && !handoff.taken_by && !holding(handoff, at()));
  }

  // The still-open, untaken handoffs of these items (message ids, asked ids), other than the moment's own: what
  // gather_moment would fold (src/moments.mjs). A taken or held job is never listed.
  function openHandoffsFor(keys, moment_id) {
    const own = handoffIdFor(`once-per:${moment_id}`);
    const nowIso = at();
    return [...new Set(keys)].map(key => store.handoff(handoffIdFor(`once-per:${key}`)))
      .filter(handoff => handoff && handoff.handoff_id !== own && handoff.state === 'open' && !holding(handoff, nowIso));
  }

  // The open, untaken, unheld jobs handed between two times (ISO), at most `limit` ({ handoffs, more }): what gather_moment may fold in that no
  // arrival or asked record index leads to (jobs handed before the asked.at index existed).
  function openHandedBetween(after, to, limit = 500) {
    const nowIso = at();
    const raw = store.openHandedBetween(after, to, limit + 1);
    return { more: raw.length > limit, handoffs: raw.slice(0, limit).filter(handoff => handoff.state === 'open' && !handoff.taken_by && !holding(handoff, nowIso)) };
  }

  // gather_moment's fold: each member's open untaken handoff is finished as a duplicate of the moment's one handoff,
  // closeDuplicate style. A job already taken, held or finished is left alone. Returns the handoff ids closed.
  function foldIntoMoment({ keys, moment_id, handoff_id }) {
    const kept = store.handoff(handoff_id);
    if (!kept || kept.state === 'finished') return [];
    const closed = [];
    for (const duplicate of openHandoffsFor(keys, moment_id)) {
      const nowIso = at();
      put({ ...duplicate, state: 'finished', taken_by: 'moment', finished_at: nowIso, hold_until: null,
        result: { kind: 'duplicate', duplicate_of: handoff_id, item: itemOf(duplicate) },
        summary: `Part of the moment ${moment_id}, whose job is ${handoff_id}.`, review_at: null });
      releaseDependents(duplicate.handoff_id);
      closed.push(duplicate.handoff_id);
    }
    return closed;
  }

  // Open work handed off before every handoff kept a title is titled one page at a time (src/work-title.mjs), so the
  // record itself carries the words every surface shows. Returns how many were titled and where the next page starts
  // (null once every open handoff has been read).
  function titleOpenWork({ after = null, limit = TITLE_PAGE } = {}) {
    const page = store.openHandoffs({ after, limit });
    let titled = 0;
    for (const item of page) {
      if (typeof item.said === 'string' && item.said.trim()) continue;
      put({ ...item, said: titleOf(item) });
      titled += 1;
    }
    return { titled, after: page.length < limit ? null : page.at(-1).handoff_id };
  }

  // The open work a message opened, closed because the person never said it: `speaker`, when the correction named one,
  // is who it came from (peer, sdk diagnostic, generated context), kept in the result.
  function invalidateMessageSource(message_id, evidence, speaker = null) {
    const closed = [];
    const seen = new Set();
    // The message index answers this correction directly; other open work can be arbitrarily large.
    for (const item of store.fromMessage(message_id)) {
      if (seen.has(item.handoff_id) || item.state === 'finished' || item.input?.arrived?.message_id !== message_id) continue;
      seen.add(item.handoff_id);
      put({ ...item, state: 'finished', finished_at: at(),
        result: { kind: 'source_provenance_correction', message_id, ...(speaker ? { speaker } : {}), evidence },
        summary: 'The person never wrote this message, so its work is closed.' });
      releaseDependents(item.handoff_id);
      closed.push(item.handoff_id);
    }
    return closed;
  }

  // Without instructions: this account's saved list, or the starters when it saved none. With instructions: they
  // replace the account's list (an empty list keeps none). Explicit null resets
  // the private override. A starter provider is read only when no private list
  // exists; array supplies and private reads retain their synchronous contract.
  // add_instructions only adds: every saved instruction stays as it is, a row whose id or words are already saved is
  // skipped and named, and each added row records its origin (and imported_from) as the provenance rules say.
  function addInstructions(input, reader) {
    if (!Array.isArray(input.add_instructions) || !input.add_instructions.length) throw new AgentsError('add_instructions is a list of { label, words } rows to add; it never replaces or removes a saved instruction.');
    const imported = optionalText(input.imported_from, 100);
    const apply = existing => {
      const haveIds = new Set(existing.map(row => row.id));
      const haveWords = new Set(existing.filter(row => row.words).map(row => row.words));
      const skipped = [];
      const fresh = input.add_instructions.filter(row => {
        const id = object(row) ? optionalText(row.id, 100) : null;
        if (id && haveIds.has(id)) { skipped.push({ id, why: 'an instruction with this id is already saved' }); return false; }
        if (object(row) && typeof row.words === 'string' && haveWords.has(row.words.trim())) { skipped.push({ id: id ?? null, why: 'an instruction with these words is already saved' }); return false; }
        return true;
      });
      const merged = [...existing, ...fresh];
      const rows = stampOrigins(instructionsFrom(merged), merged, existing, reader, at(), provenance, imported);
      store.putSavedInstructions(rows);
      return { instructions: rows, from: 'saved', added: rows.slice(existing.length).map(row => row.id), skipped };
    };
    const saved = store.savedInstructions();
    if (saved !== null && saved !== undefined) return apply(saved);
    if (typeof starters !== 'function') return apply(instructionsFrom(starters));
    const rows = starters();
    return rows && typeof rows.then === 'function' ? Promise.resolve(rows).then(value => apply(instructionsFrom(value))) : apply(instructionsFrom(rows));
  }

  function instructions(input = {}, { reader = null } = {}) {
    if (input.add_instructions !== undefined) return addInstructions(input, reader);
    if (input.instructions !== undefined) {
      const earlier = store.savedInstructions();
      const baseline = earlier ?? (Array.isArray(starters) ? starters : typeof starters === 'function' ? (() => { const rows = starters(); return rows && typeof rows.then === 'function' ? null : instructionsFrom(rows); })() : []);
      store.putSavedInstructions(input.instructions === null ? null : stampOrigins(instructionsFrom(input.instructions), input.instructions, baseline, reader, at()));
    }
    const saved = store.savedInstructions();
    if(saved!==null&&saved!==undefined)return {instructions:saved,from:'saved'};
    if(typeof starters!=='function')return {instructions:structuredClone(starters),from:'starters'};
    const rows=starters();
    const ready=value=>{
      const current=store.savedInstructions();
      return current!==null&&current!==undefined?{instructions:current,from:'saved'}:{instructions:instructionsFrom(value),from:'starters'};
    };
    return rows&&typeof rows.then==='function'?Promise.resolve(rows).then(ready,error=>{
      const current=store.savedInstructions();
      if(current!==null&&current!==undefined)return {instructions:current,from:'saved'};
      throw error;
    }):ready(rows);
  }

  // The agent says it is present: when it was last seen, and its dead events are sent once more. It never returns
  // work; work reaches it only as an event, or when it asks take_work.
  function presence(input = {}) {
    const agent_id = text(input.agent_id, 'agent_id (the agent reporting it is present)', 200);
    const agent = card(agent_id);
    if (!agent) throw new AgentsError(`Publish ${agent_id} first.`, { tool: 'publish_agent', arguments: { agent_id, name: '(this agent)', description: '(what it does)' } });
    const nowIso = at();
    store.putCard({ ...agent, last_seen_at: nowIso });
    if (agent.takes_work && agent.source_id) sourceActive({ source_id: agent.source_id, active_at: nowIso });
    const dead = agent.delivery ? store.deadDeliveries(agent_id) : [];
    for (const item of dead) {
      store.putDelivery({ ...item, state: 'waiting', attempts: 0, next_at: agent.delivery.url ? nowIso : null });
      if (agent.delivery.stream) stream.send(agent_id, item.event);
    }
    return { agent_id, last_seen_at: nowIso, sending_again: dead.length };
  }

  // The stream route's two calls from the helper that holds it. pull: the events still waiting for the agents it hosts
  // (each must be on the stream route), oldest first, so nothing kept while it was away is lost. ack: what happened when
  // it handed one on, after its own one retry: delivered, or failed with the error kept (a dead letter, read with
  // read_agent_events and sent again when the agent reports itself present).
  function streamAgent(agent_id) {
    const agent = card(agent_id);
    if (!agent) throw new AgentsError(`No agent ${agent_id} has published on this account.`, { tool: 'find_agents', arguments: {} });
    if (!agent.delivery?.stream) throw new AgentsError(`${agent_id} is not on the stream route. Publish it with delivery { stream: true } first.`);
    return agent;
  }
  // The agents one stream may carry: those of these that are on the stream route, at most MAX_STREAM_AGENTS.
  const streamHosts = ids => [...new Set(ids)].filter(id => card(id)?.delivery?.stream).slice(0, MAX_STREAM_AGENTS);
  function pull(input = {}) {
    if (!Array.isArray(input.agent_ids) || !input.agent_ids.length || input.agent_ids.length > MAX_STREAM_AGENTS) throw new AgentsError(`agent_ids is a list of 1 to ${MAX_STREAM_AGENTS} agents this helper holds the stream for.`);
    return { events: input.agent_ids.flatMap(id => { streamAgent(text(id, 'Each agent id', 200)); return store.streamWaiting(id).map(item => item.event); }) };
  }
  function ack(input = {}) {
    const event_id = text(input.event_id, 'event_id', 200);
    const agent_id = text(input.agent_id, 'agent_id (the agent the event was for)', 200);
    if (typeof input.ok !== 'boolean') throw new AgentsError('ok is true when the event was handed on, false when it failed after the retry.');
    // An in-memory ask's event has no delivery record: its asker learns of a failure when the ask is not taken in time.
    if (askEvents.has(event_id)) { askEvents.delete(event_id); return { delivery: null, in_memory: true }; }
    const item = store.delivery(event_id);
    if (!item || item.agent_id !== agent_id) throw new AgentsError(`No event ${event_id} for ${agent_id} on this account.`);
    if (item.state !== 'waiting') return { delivery: deliveryOutward(item), repeated: true };
    const nowIso = at();
    const tries = Number.isInteger(input.attempts) && input.attempts > 0 ? Math.min(input.attempts, 10) : 1;
    const updated = { ...item, next_at: null, attempts: item.attempts + tries, last_attempt_at: nowIso,
      ...(input.ok ? { state: 'delivered', delivered_at: nowIso, last_error: null } : { state: 'dead', last_error: optionalText(input.error, 600) ?? 'The helper could not hand it on.' }) };
    store.putDelivery(updated);
    const agent = card(agent_id);
    if (agent) store.putCard({ ...agent, ...(input.ok ? { last_delivered_at: nowIso, delivered: (agent.delivered ?? 0) + 1 } : { last_undelivered_at: nowIso }) });
    return { delivery: deliveryOutward(updated) };
  }

  // The receiver of an event says it cannot use it and asks for it again: a receipt of kind `resend`, counted on the event.
  // The event goes back to waiting (a fresh run of attempts); past MAX_RESEND_REQUESTS it stays as it is and says so.
  function resend(input = {}) {
    const event_id = text(input.event_id, 'event_id', 200);
    const agent_id = text(input.agent_id, 'agent_id (the agent the event was for)', 200);
    const item = store.delivery(event_id);
    if (!item || item.agent_id !== agent_id) throw new AgentsError(`No event ${event_id} for ${agent_id} on this account.`);
    const requests = (item.resend_requests ?? 0) + 1;
    if (requests > MAX_RESEND_REQUESTS) return { delivery: deliveryOutward(item), refused: `This event was already asked for again ${MAX_RESEND_REQUESTS} times.` };
    const agent = card(agent_id);
    const nowIso = at();
    const updated = { ...item, state: 'waiting', attempts: 0, next_at: agent?.delivery?.url ? nowIso : null, last_error: null,
      resend_requests: requests, last_resend_at: nowIso, last_resend_reason: optionalText(input.reason, 300) ?? null };
    store.putDelivery(updated);
    if (agent?.delivery?.stream) stream.send(agent_id, item.event);
    return { delivery: deliveryOutward(updated) };
  }

  const deliver = send => deliverDue({ store, send, now });
  const nextDeliveryAt = () => store.nextDeliveryAt();

  // Whether an agent said, in a claim still current, that it can take no work.
  const saysNone = (agent, nowIso) => Boolean(agent?.capacity_claim && agent.capacity_claim.max_concurrent === 0 && agent.capacity_claim.expires_at > nowIso);

  // A card that can take work now may clear walls Trillion found (reviewOf), including a zero-capacity claim whose
  // expiry has not arrived: only the waiting work it could clear is looked at again, at once, and only when the card
  // could not take work before. A person's or agent's own blocker is left for its owner.
  function clearWalls(published, earlier, hadTaker, onReviewDue = () => {}) {
    const nowIso = at();
    if (!published.takes_work || saysNone(published, nowIso)) return;
    const quiet = item => item.state === 'open' && item.in_the_way_by === BY_TRILLION;
    const wake = item => { put({ ...item, review_at: nowIso }); onReviewDue(Date.parse(nowIso)); };
    if (!earlier?.takes_work || saysNone(earlier, nowIso)) {
      for (const item of store.openAddressedTo(published.agent_id)) if (quiet(item) && item.blocked_kind === 'target') wake(item);
    }
    if (hadTaker) return;
    for (let page = store.openHandoffs({ limit: REVIEW_PAGE }); page.length; page = page.length < REVIEW_PAGE ? [] : store.openHandoffs({ after: page.at(-1).handoff_id, limit: REVIEW_PAGE })) {
      for (const item of page) if (quiet(item) && item.blocked_kind === 'no_taker') wake(item);
    }
  }

  // Why nobody can take this waiting work right now, or null when someone can: { kind, reason, recovery }.
  function wallFor(item, cards, nowIso) {
    if (item.to_agent) {
      const agent = cards.get(item.to_agent);
      const saidNone = saysNone(agent, nowIso);
      if (!agent || !agent.takes_work || saidNone) return { kind: 'target', ...(saidNone && agent.takes_work ? { until: agent.capacity_claim.expires_at } : {}),
        reason: `${item.to_agent} ${!agent ? 'is no longer connected to this account' : !agent.takes_work ? 'has stopped taking work' : 'said it cannot take work right now'}, and this job is only for it.`,
        recovery: `It goes on as soon as ${item.to_agent} takes work again; or the person hands the job to another AI.` };
      return null;
    }
    const source = item.input?.arrived?.source_id;
    if (source) {
      const owners = cards.forSource(source);
      const from = anyoneFrom(item);
      if (!owners.length && from > nowIso) return { kind: 'source', until: from, reason: 'Waiting for the chat it came from to connect.', recovery: `It is given to that chat as soon as the chat connects with its source_id; from ${from} any of the person's AIs can take it.` };
      if (owners.length) return null;
    }
    if (!cards.anyTaker()) return { kind: 'no_taker', reason: 'No AI that takes work is connected to this account.', recovery: 'Any AI that connects and publishes itself taking work can take it.' };
    return null;
  }

  // The next time the reconciler has something to do: the earliest hold that runs out or review that falls due, or
  // now for any unfinished handoff with no next step at all.
  // Asked on every scheduler arm, so it reads what the store keeps beside each handoff (reviewOf), never open work whole.
  function nextReviewAt() {
    const next = store.nextReviewAt(at());
    return next === null ? null : Date.parse(next);
  }

  // The reconciler: run by the store's scheduler whenever nextReviewAt falls due, it keeps every unfinished handoff
  // with exactly one next step. A wake settles the work whose review is due and one slice of the open list after the
  // mark the last wake kept (wrapping to the start), each handoff once; the slice only moves on wakes that happen
  // anyway. Each handoff is settled in its own transaction, and one that throws never stops the others.
  function reconcile() {
    const nowIso = at();
    // What a review asks about cards, each read once per review: one card by id, the cards of one chat, whether any takes work.
    const one = new Map();
    const ofSource = new Map();
    let anyTaker = null;
    const cards = {
      get: id => (one.has(id) ? one.get(id) : one.set(id, store.card(id)).get(id)),
      forSource: source => (ofSource.has(source) ? ofSource.get(source) : ofSource.set(source, store.cardsForSource(source)).get(source)),
      anyTaker: () => (anyTaker ??= store.anyTaker()),
    };
    const done = { reopened: [], released: [], blocked: [], unblocked: [], woken: [], repaired: [], stopped: [], problems: [] };
    const settled = new Set();
    const visit = original => {
      if (settled.has(original.handoff_id)) return;
      settled.add(original.handoff_id);
      try { together(() => settle(original, nowIso, cards, done)); } catch (error) { done.problems.push({ handoff_id: original.handoff_id, error: String(error?.message ?? error).slice(0, 300) }); }
    };
    // Keep the total visited in this synchronous owner turn bounded, while always advancing the open-list cursor.
    const due = store.dueReviews(nowIso, RECONCILE_PAGE - 1);
    for (const original of due) visit(original);
    const openLimit = RECONCILE_PAGE - due.length;
    // One slice of the open list, read after the due work was settled so it sees what that changed.
    const mark = store.reviewMark();
    const tail = mark ? store.openHandoffs({ after: mark, limit: openLimit }) : [];
    const head = tail.length < openLimit ? store.openHandoffs({ limit: openLimit - tail.length }) : [];
    for (const original of [...tail, ...head]) visit(original);
    // The next wake goes on after this slice; when the slice reached the end of the open list and came back round
    // without filling up, or round to where it began, every open handoff was read and the next one starts at the beginning.
    const began = new Set([mark, tail[0]?.handoff_id].filter(Boolean));
    const ended = tail.length < openLimit && (head.length < openLimit - tail.length || head.some(item => began.has(item.handoff_id)));
    const next = ended ? null : (head.length ? head : tail).at(-1).handoff_id;
    if (next !== mark) together(() => store.putReviewMark(next));
    return done;
  }

  function settle(original, nowIso, cards, done) {
    if (original.closing) return;
    const id = original.handoff_id;
    let item = original;
    let changed = false;
    let announced = false;
    if (item.state === 'taken') {
      if (holding(item, nowIso)) return;
      // The hold ran out (or reached the longest one attempt may be held): the attempt ends, anything it had started becomes unknown, and the work waits again.
      item = { ...endAttempt(item, 'expired'), state: 'open', taken_by: null, taken_at: null, hold_until: null, wakes: 0, review_at: nowIso };
      changed = true;
      done.reopened.push(id);
      const tries = (item.attempts ?? []).length;
      if (tries >= (item.max_attempts ?? MAX_ATTEMPTS)) {
        put(blockedBy(item, 'attempts', `Taken ${tries} times and never finished.`, 'Take it again by its handoff_id, or hand the job to another AI.'));
        done.stopped.push(id);
        return;
      }
      const used = secondsUsed(item);
      if (item.time_budget_seconds && used >= item.time_budget_seconds) {
        put(blockedBy(item, timeBudget.stop_kind, timeBudget.words.stopped.replace('{used}', used).replace('{budget}', item.time_budget_seconds), timeBudget.words.recovery));
        done.stopped.push(id);
        return;
      }
      if (!waitingOnOf(item).length) {
        enqueue('handoff.created', item, receiversForOpen(item), `${id}:reopen:${original.hold_until}`);
        announced = true;
      }
    }
    // Something an AI said is in the way is that AI's to clear; its words are the next step.
    if (item.in_the_way && item.in_the_way_by !== BY_TRILLION) { if (changed) put(item); return; }
    if (waitingOnOf(item).length) {
      if (item.in_the_way_by === BY_TRILLION && !timeBudget.stays_stopped.includes(item.blocked_kind)) { item = unblocked(item); changed = true; }
      if (changed) put({ ...item, review_at: null });
      return;
    }
    // It said it waits on work that has finished since (by a writer that does not wake its dependents): saying so again
    // puts it back among the work a take reads.
    if (item.waits_open) changed = true;
    // Ran out of attempts: stays stopped until someone takes it by name; it is looked at again on its review.
    if (timeBudget.stays_stopped.includes(item.blocked_kind)) {
      if (changed || item.review_at) put({ ...item, review_at: null });
      return;
    }
    // A preference that ran out, a preferred agent that cannot take work, or a named agent unseen for its whole window
    // (never when the job is pinned strict: true), lets any AI take it (the same record).
    let wall = wallFor(item, cards, nowIso);
    if (item.to_agent && ((item.target?.strict === false && (item.target.prefer_until <= nowIso || wall)) || openToAnyone(item, nowIso, cards.get))) {
      item = { ...item, preferred_agent: item.to_agent, to_agent: null, target: null, review_at: nowIso, wakes: 0 };
      changed = true;
      done.released.push(id);
      wall = wallFor(item, cards, nowIso);
    }
    if (wall) {
      // A wait that ends at a known time (the source silence window, a capacity claim) is looked at again then; any other
      // wall only when a card changes (clearWalls). The same wall found again writes nothing.
      const review_at = wall.until ?? null;
      if (item.in_the_way !== wall.reason || item.in_the_way_by !== BY_TRILLION) { item = blockedBy(item, wall.kind, wall.reason, wall.recovery, review_at); changed = true; done.blocked.push(id); }
      else if (item.review_at !== review_at) { item = { ...item, review_at }; changed = true; }
      if (changed) put(item);
      return;
    }
    if (item.in_the_way_by === BY_TRILLION) { item = { ...unblocked(item), review_at: nowIso, wakes: 0 }; changed = true; done.unblocked.push(id); }
    if (!item.review_at || item.review_at <= nowIso) {
      if (!nextStepOf(original, { nowIso, waitingOn: [] })) done.repaired.push(id);
      const wakes = item.wakes ?? 0;
      if (!announced && wakes < MAX_WAKES) {
        enqueue('handoff.created', item, receiversForOpen(item), `${id}:review:${wakes}:${item.revision ?? 0}`);
        done.woken.push(id);
      }
      item = { ...item, wakes: Math.min(wakes + 1, MAX_WAKES), review_at: earliest(reviewAfter(wakes), item.target?.strict === false ? item.target.prefer_until : null) };
      changed = true;
    }
    if (changed) put(item);
  }

  // An effect the holder is about to cause, or has caused, outside Trillion. effect_id stays the same across
  // attempts, so the same payment, post or write is never started twice: starting answers proceed true only when it
  // has not been done, and an effect an ended attempt left starting is unknown until someone checks its target.
  function recordEffect(input = {}, { reader = null } = {}) {
    const handoff_id = text(input.handoff_id, 'handoff_id', 200);
    const agent_id = text(input.agent_id, 'agent_id (the agent holding the work)', 200);
    const effect_id = text(input.effect_id, 'effect_id (a name for this one effect that stays the same on every try, for example payment:invoice-42)', 200);
    const state = input.state;
    if (!['starting', 'done', 'failed'].includes(state)) throw new AgentsError('state is starting (about to do it), done (it happened) or failed (it did not happen).');
    if (!Number.isInteger(input.generation)) throw new AgentsError('generation is the whole number take_work returned with this job.');
    const current = handoff(handoff_id);
    if (!current) throw new AgentsError(`No handoff ${handoff_id} on this account.`);
    fenced(current, input.generation);
    if (current.taken_by !== agent_id || !holding(current, at())) throw new AgentsError(`${handoff_id} is not held by ${agent_id} now; take it again first.`, { tool: 'take_work', arguments: { agent_id, handoff_id } });
    assertClaimReader(current, reader);
    const receipt = input.receipt === undefined ? null : input.receipt;
    if (receipt !== null && JSON.stringify(receipt).length > 4000) throw new AgentsError('receipt is at most 4000 characters: the id or answer the target gave, never a secret.');
    const effects = current.effects ?? {};
    const earlier = effects[effect_id] ?? null;
    const saved = effect => ({ effect, handoff: view(put({ ...current, effects: { ...effects, [effect_id]: effect } })) });
    if (state === 'starting') {
      if (earlier?.state === 'done') return { proceed: false, effect: earlier, note: 'This effect is already done; it is not done again.' };
      if (earlier?.state === 'unknown') return { proceed: false, effect: earlier, note: 'An earlier attempt may have done this. Check the target, then record it done or failed; it is never started blindly again.' };
      if (earlier?.state === 'starting' && earlier.generation === current.generation) return { proceed: true, effect: earlier, repeated: true };
      if (earlier?.state === 'starting') return { proceed: false, ...saved({ ...earlier, state: 'unknown', unknown_since: at() }), note: 'An earlier attempt started this and never said how it ended. Check the target, then record it done or failed.' };
      // Another effect's outcome is unknown: the holder may only look until a receipt settles it or the person speaks.
      const locking = lockingEffect(current);
      if (locking) return { proceed: false, locked_by: locking.effect_id, effect: earlier, outcome: effectOutcome('unknown'), note: `${locking.effect_id} may have happened. Only reading is allowed: check its target and record it done or failed, or wait for the person's next message.` };
      if (!earlier && Object.keys(effects).length >= MAX_EFFECTS) throw new AgentsError(`A handoff keeps at most ${MAX_EFFECTS} effects.`);
      return { proceed: true, ...saved({ effect_id, target: optionalText(input.target, 500) ?? earlier?.target ?? null, state: 'starting', generation: current.generation, attempt_id: `${handoff_id}:${current.generation}`,
        started_at: at(), settled_at: null, receipt: null, tries: (earlier?.tries ?? 0) + 1 }) };
    }
    if (!earlier) throw new AgentsError(`Record ${effect_id} as starting before it happens, so a lost answer can never repeat it.`);
    if (earlier.state === state) return { effect: earlier, repeated: true };
    if (earlier.state === 'done') throw new AgentsError(`${effect_id} is already recorded done.`);
    if (earlier.state === 'unknown' && receipt === null) throw new AgentsError(`${effect_id} is unknown: give the receipt from checking its target (what the target says happened).`);
    // A failed receipt carries what may have happened and what must come next, narrowed by what the holder says.
    const outcome = state === 'failed' ? { outcome: effectOutcome('failed', { retryable: input.retryable, required_next: input.required_next, side_effect: input.side_effect }) } : {};
    return saved({ ...earlier, state, settled_at: at(), settled_by_generation: current.generation, receipt, ...outcome });
  }

  // A list shaped as instructions() would save it (ids given to those without), without saving: a caller that saves it
  // together with other choices (src/share-destinations.mjs) checks every part before writing any.
  const shapeInstructions = instructionsFrom;

  return { publish, pull, ack, resend, streamHosts, tellRunners, reach: agent_id => (card(agent_id) ? reach(card(agent_id)) : null), setCapacity, decideSurface, find, handOff, idFor: handoffIdFor, reviewSelectionFor, addressOpen, addressJob, markNoTaker, take, admitFinish, admitResultSource, repeatedResultSource, resultSourceCapabilities, prepareResultSource, finish, confirmSourceReturn, sourceReturnOutcome, reopenIncorrectFinish, sayInTheWay, release, releaseOutcome, checkCloseWaiting, reserveCloseWaiting, checkCloseReservation, keepCloseDigest, keepCloseSource, closeWaitingFailed, closeWaiting, withdraw, withdrawWaiting, closeDuplicate, openUntaken, sweepLapsed, nextLapseAt, mergeable, openHandedBetween, openHandoffsFor, foldIntoMoment, titleOpenWork, read, board, stuckWork, recentWork, notificationWork, pendingForReader, invalidateMessageSource, cardsOfReader, heldIds, fromMessage, withParts, cardOf: card, instructions, shapeInstructions, presence, sourceActive, sendEvent, tellEveryone, readEvents, deliver, nextDeliveryAt, nextReviewAt, reconcile, recordEffect };
}

const ROUTES = { '/handoffs/result-source-capability': 'resultSourceCapabilities', '/agents/publish': 'publish', '/agents/capacity': 'setCapacity', '/agents/surface': 'decideSurface', '/agents/find': 'find', '/handoffs': 'handOff', '/handoffs/address': 'addressOpen', '/handoffs/take': 'take', '/handoffs/finish': 'finish', '/handoffs/confirm-source-return': 'confirmSourceReturn', '/handoffs/reopen-incorrect-finish': 'reopenIncorrectFinish', '/handoffs/in-the-way': 'sayInTheWay', '/handoffs/release': 'release', '/handoffs/withdraw-waiting': 'withdrawWaiting', '/handoffs/effect': 'recordEffect', '/handoffs/read': 'read', '/agents/instructions': 'instructions', '/agents/presence': 'presence', '/agents/events': 'sendEvent', '/agents/events/read': 'readEvents', '/agents/events/pull': 'pull', '/agents/events/ack': 'ack', '/agents/events/resend': 'resend' };
export const isAgentsPath = pathname => Object.hasOwn(ROUTES, pathname);

// Work that names a done_when_rule is refused when the rule is written (the owner's plain words for what it may name) and
// cannot finish while the rule's current read does not pass: a check that is not yet true, cannot be made or failed keeps
// the work open and says why. `doneWhen` is the owner's { refusal(rule), check(rule, { fresh }) } (src/done-when.mjs).
async function gateOnDoneWhen(agents, doneWhen, verb, input) {
  if (verb === 'handOff' && input.done_when_rule !== undefined && object(input.done_when_rule)) {
    const refused = await doneWhen.refusal(input.done_when_rule);
    if (refused) throw new AgentsError(`done_when_rule: ${refused}`);
  }
  if (verb !== 'finish') return;
  const id = optionalText(input.handoff_id, 200);
  const rule = id ? agents.read({ handoff_id: id }).handoff.done_when_rule : null;
  if (!rule) return;
  const check = await doneWhen.check(rule, { fresh: true });
  if (check.state !== 'done') throw new AgentsError(`This work is not done yet by its own check (${check.state}): ${check.words}`, { tool: 'read_handoff', arguments: { handoff_id: id } });
}

// `shapeHandOff(input)` lets the host give a hand-off what only it knows before it is kept (src/share-destinations.mjs:
// a share from the person's own share sheet speaks with their voice).
// `onReviewDue(at)` names work a capacity change made due, so the host can arm that time without scanning other jobs.
// `seeInput(input)` lets the host notice what a request names before it runs (src/person-store.mjs counts former ids).
export async function handleAgentsRequest(agents, request, { messageOf = () => null, shapeHandOff = input => input, sources = null, onReviewDue = () => {}, seeInput = () => {}, resolveResultSource = null, checkResultSourceAccess = null, doneWhen = null } = {}) {
  const verb = ROUTES[new URL(request.url).pathname];
  if (request.method !== 'POST' || !verb) return Response.json({ error: 'Not found' }, { status: 404 });
  try {
    const raw = await request.text();
    if (raw.length > 1_000_000) throw Object.assign(new AgentsError('Request too large'), { result_transport_code: 'request_too_large' });
    // The reader the host named the calling app or key with (src/worker.mjs readerOf), so work can wait for that AI.
    let input;
    try { input = JSON.parse(raw || '{}'); }
    catch (cause) { throw new AgentsError('Give valid JSON for this action.', null, { cause }); }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new AgentsError('Give a JSON object for this action.');
    if (verb === 'finish' && Object.hasOwn(input, 'result_source')) {
      if (Object.hasOwn(input, 'result') || !resolveResultSource) throw new AgentsError('Give exactly one supported result transport.');
      const source = checkedResultSource(input.result_source);
      const reader = request.headers.get('x-trillion-reader') || null;
      const repeated = agents.repeatedResultSource(input, { reader });
      if (repeated && checkResultSourceAccess) {
        await checkResultSourceAccess(source, () => agents.admitResultSource(input, { reader }));
        // The access check may yield; re-admit before accepting its receipt.
        const checked = agents.repeatedResultSource(input, { reader });
        if (!checked) throw new AgentsError('The result lease changed during admission.');
        seeInput(input); return Response.json(checked);
      }
      input.result = await resolveResultSource(source, () => agents.admitResultSource(input, { reader }), () => agents.prepareResultSource(input, { reader }));
      const acceptedResultJson = serializedResultFor(input.result);
      const acceptedResultContent = preparedResultContentFor(input.result);
      delete input.result_source;
      seeInput(input);
      return Response.json(await agents.finish(input, { reader, acceptedResultSource: source, acceptedResultJson, acceptedResultContent }));
    }
    if (doneWhen) await gateOnDoneWhen(agents, doneWhen, verb, input);
    seeInput(input);
    if (verb === 'confirmSourceReturn') return Response.json(agents.confirmSourceReturn(input, {
      raw, signature: request.headers.get('trillion-source-signature'), message: messageOf(input.message_id),
    }));
    return Response.json(await agents[verb](verb === 'handOff' ? shapeHandOff(input) : input, { reader: request.headers.get('x-trillion-reader') || null, sources, onReviewDue }));
  } catch (error) {
    if (error.result_source_refusal === true && error.status === 402) return Response.json(error.withheld, { status: 402 });
    const resultTransportCode = error.result_transport_code ?? (error.code === 'record_too_large' ? 'record_read_too_large' : null);
    // Domain/transport validation remains a bad request. Backend, rights and platform failures
    // retain their original cause for the host's shared HTTP/MCP failure owner.
    const domainRefusal = error instanceof WorkFailure && error.failure_code === 'request-refused';
    if (!domainRefusal && !resultTransportCode) throw error;
    return Response.json({ error: error.message, ...(domainRefusal ? { failure_code: error.failure_code } : {}), ...(resultTransportCode ? { result_transport_code: resultTransportCode } : {}), ...(error.next_call ? { next_call: error.next_call } : {}) }, { status: 400 });
  }
}

// The MCP tools, in the order an agent uses them. `call(path, body)` reaches the routes above.
export const agentTools = call => [
  { name: 'withdraw_waiting_work', description: 'Withdraws one waiting handoff that this authenticated sender handed off, keeping its history and reason. Read the current revision first. Only open work without unfinished parts, unresolved effects or unfinished dependents is eligible; this never cancels running work or claims its outcome happened. The signed-in person has the same action on the Work detail screen.', inputSchema: { type: 'object', additionalProperties: false, required: ['handoff_id', 'agent_id', 'revision', 'reason'], properties: { handoff_id: { type: 'string' }, agent_id: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 1, maxLength: 2000 } } }, run: input => call('/handoffs/withdraw-waiting', input) },
  { name: 'publish_agent', description: 'Says what this agent is and what it can do, so other agents on the same account can find it and hand it work. Publishing again with the same agent_id updates the card. Optional capacity states how many jobs this agent can work on at once and expires unless renewed. Optional delivery { url } is an https address this agent answers on: it is then sent a signed event (handoff.created) when work is handed to it and one (handoff.finished) when work it handed off is finished, so it can wait for events instead of asking. The answer carries delivery_secret once, to check each event\'s trillion-signature; keep it in memory only. delivery { stream: true } is for an agent on a computer the internet cannot reach: Trillion\'s helper on that computer (harness/wake-sessions.mjs) holds the live connection for it, each event is sent down it at once, and the agent counts as reachable only while that connection answers. runs lists the placements this agent runs Marketplace tools for (for example placement:caller-sandbox): a run of such a tool is sent to it as tool.run.requested. delivery null stops events; rotate_delivery_secret true makes a new secret.', inputSchema: { type: 'object', required: ['name', 'description'], properties: { agent_id: { type: 'string' }, delivery: { anyOf: [{ type: 'object', required: ['url'], properties: { url: { type: 'string' } } }, { type: 'object', required: ['stream'], properties: { stream: { const: true } } }, { type: 'null' }] }, rotate_delivery_secret: { type: 'boolean' }, runs: { type: 'array', maxItems: 20, items: { type: 'string' } }, name: { type: 'string' }, description: { type: 'string' }, skills: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', required: ['name'], properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } }] } }, harness: { type: 'string' }, model: { type: 'string' }, where: { type: 'string' }, source_id: { type: 'string' }, takes_work: { type: 'boolean' }, kind: { type: 'string', description: 'Who or what takes work as this card: ai when left out; a person or anything else that takes work says so' }, capacity: { type: 'object', required: ['max_concurrent'], properties: { max_concurrent: { type: 'integer', minimum: 0, maximum: 20 }, ttl_minutes: { type: 'number', minimum: 1, maximum: 1440 } } } } }, run: input => call('/agents/publish', input) },
  { name: 'set_agent_capacity', description: `Reports how many jobs a published agent can work on at once. This expires after ttl_minutes (${workHolds.capacity_report_minutes} by default); report it again when the agent is ready. Set max_concurrent to 0 when unavailable. No background process is started.`, inputSchema: { type: 'object', required: ['agent_id', 'max_concurrent'], properties: { agent_id: { type: 'string' }, max_concurrent: { type: 'integer', minimum: 0, maximum: 20 }, ttl_minutes: { type: 'number', minimum: 1, maximum: 1440 } } }, run: input => call('/agents/capacity', input) },
  { name: 'decide_agent_skills', description: 'Approves or refuses the skills a published agent offered beyond what it was approved for (its card shows them as pending_skills; this only applies when the account turned on approval of widening). approve true lets the agent offer them, false refuses them. The agent\'s own key cannot approve its own widening: use another AI of this account or the person\'s own screen.', inputSchema: { type: 'object', required: ['agent_id', 'approve'], properties: { agent_id: { type: 'string' }, approve: { type: 'boolean' } } }, run: input => call('/agents/surface', input) },
  { name: 'find_agents', description: 'Lists the agents on this account that match a job, with their stated capacity and whether they are ready now. Unknown or expired capacity is never presented as ready. Work can still be queued for an agent that is not ready.', inputSchema: { type: 'object', properties: { job: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } } }, run: input => call('/agents/find', input) },
  { name: 'hand_off', description: 'Hands a job to another agent on this account (to_agent from find_agents), or to whichever agent takes it first when to_agent is left out. The job waits until an agent takes it. request_key is any unique text; the same request_key returns the same handoff. Optional: input (an object), from_agent, case_id of the decision behind it, parent_handoff_id when passing on part of a job, hold_minutes an agent may hold it before others can take it, priority (0 to 9, higher is taken first; 0 when left out; at most 50 jobs wait for one agent by name), notice (a short line, at most 300 characters, sent in the event to an agent that can be reached; the job itself never is), said (the work as the person sees it on their notifications and AI work, at most 300 characters: their own words or a plain title such as "Draft the launch email", never a tool name, an id or instructions to an AI; the job itself is never shown to them), outcome (what should be true when it is done), success_condition (how anyone can check that), result_shape (a JSON Schema with type object of what finishing it must say, over the result\'s fields, or { outcome } for a text result, and summary: such as a required summary and before and after pictures with format namespace-file; finish_work refuses a result without them), done_when_rule (a check of what is true now, { over, match, tree, says }: finish_work is refused while it does not pass, so work stays open until the file, record or connection is there), depends_on (handoff ids it waits for), once_per (the identity of the item this work is about, such as a message id: every hand-off naming the same once_per is one job, so request_key may then be left out), max_attempts (how many times it may be taken before Trillion stops it), time_budget_seconds (the seconds its attempts may hold it in all; when they have used it Trillion stops it with blocked_kind time_budget until someone takes it by name), target ({ strict: true }, the default: only to_agent ever takes it, and it waits as stuck while to_agent cannot; or { prefer_minutes }: to_agent first, then any AI). take_within_seconds (how long the asker waits for it to be taken): work nobody took by then is finished as not taken in time and never handed out. steer_handoff_id (with job and a request_key) steers work already running instead of making a second job: the words are kept on that job as steers, in order, for whoever holds it to read with the job. Trillion keeps every unfinished job moving: a hold that runs out puts it back, waiting work is announced again, and anything that stops it shows as stuck with its reason.', inputSchema: { type: 'object', required: ['job'], properties: { job: { type: 'string' }, steer_handoff_id: { type: 'string' }, once_per: { type: 'string' }, notice: { type: 'string' }, said: { type: 'string' }, outcome: { type: 'string' }, success_condition: { type: 'string' }, result_shape: { type: 'object' }, done_when_rule: { type: 'object', description: 'A check of what is true now ({ over, match, tree, says }, as on a Waiting on you row): finish_work is refused while it does not pass' }, depends_on: { type: 'array', items: { type: 'string' }, maxItems: MAX_DEPENDS_ON }, max_attempts: { type: 'integer', minimum: 1, maximum: MAX_ATTEMPTS }, time_budget_seconds: { type: 'integer', minimum: 1, maximum: timeBudget.max_seconds }, target: { type: 'object', properties: { strict: { type: 'boolean' }, prefer_minutes: { type: 'number', minimum: 1, maximum: 10080 } } }, request_key: { type: 'string' }, to_agent: { type: 'string' }, input: { type: 'object' }, from_agent: { type: 'string' }, case_id: { type: 'string' }, parent_handoff_id: { type: 'string' }, hold_minutes: { type: 'number', minimum: 1 }, priority: { type: 'integer', minimum: 0, maximum: 9 }, take_within_seconds: { type: 'number', exclusiveMinimum: 0, maximum: 86400 } } }, run: input => call('/handoffs', input) },
  { name: 'address_open_work', description: 'Names the agent for existing open source-linked work that arrived before its owning agent was known. Requires the exact source_id kept on that handoff and preserves its original ID and replay identity.', inputSchema: { type: 'object', required: ['handoff_id', 'source_id', 'to_agent'], properties: { handoff_id: { type: 'string' }, source_id: { type: 'string' }, to_agent: { type: 'string' } } }, run: input => call('/handoffs/address', input) },
  { name: 'take_work', description: 'Call this when work may be waiting for this agent: the person or a reply points to a job, or this agent runs to do waiting work. Do the job it returns in the same turn. Takes the oldest job waiting for this agent (agent_id as published), or a job handed to any agent, or one handoff_id. only_mine true takes only work handed to this agent by name. Returns the job with its generation, or nothing when no work is waiting. Taking a job this agent already holds, by handoff_id, renews its hold, though never past a few times its hold from when it was taken: a job renewed and not finished goes back up for any AI to take. When this agent already holds as many jobs as it said it can work on at once, it gets back those jobs (held) with the calls that finish, unblock or give back each one. Pass the generation to finish_work, record_effect and say_what_is_in_the_way: a write from an attempt whose hold ran out and was taken again is refused.', inputSchema: { type: 'object', required: ['agent_id'], properties: { agent_id: { type: 'string' }, handoff_id: { type: 'string' }, only_mine: { type: 'boolean' }, generation: { type: 'integer', minimum: 0 } } }, run: async input => {
    // A decision nobody said was done is handed to one AI as one job by the keep-running sweep (src/keep-running.mjs);
    // listed to every AI that took work, it set every lane redoing what another had done or was still doing.
    return call('/handoffs/take', input);
  } },
  { name: 'finish_work', description: 'Records the result of a job this agent took: result (text or an object) and a summary. When read_handoff shows a result_shape, the result and summary must have what it requires (such as before and after pictures), or the work is not finished. The agent that handed it off reads it with read_handoff. For source-chat work, use result { state: "completed", outcome: "the concrete result" } and include the exact handoff ID and outcome in that chat\'s final reply. The source-bound receiver checks the later reply separately; finish_work alone never proves return. An effect still starting or unknown (record_effect) must be recorded done or failed first. To show the answer as cards wherever the job shows in Trillion (under the box it was sent from, on AI work), put them in result.show: one card or a list, each { title, text, icon, tone, value, unit, facts: [{ label, value }], chips: [{ label, kind, value, href }] }, where href is an address in Trillion such as /decisions/<case_id> or an https page.', inputSchema: { type: 'object', required: ['handoff_id', 'agent_id'], oneOf: [{ required: ['result'], not: { required: ['result_source'] } }, { required: ['result_source', 'generation'], not: { required: ['result'] } }], properties: { handoff_id: { type: 'string' }, agent_id: { type: 'string' }, generation: { type: 'integer', minimum: 0 }, result: {}, result_source: { type: 'object', required: ['identity', 'byte_length', 'format'], properties: { identity: { type: 'string' }, byte_length: { type: 'integer', minimum: 1, maximum: HANDOFF_RESULT_SOURCE.max_bytes }, format: { const: HANDOFF_RESULT_SOURCE.format } } }, summary: { type: 'string' } } }, run: input => call('/handoffs/finish', input) },
  { name: 'reopen_incorrect_finish', description: 'Corrects a handoff that was marked finished before its source-linked result was delivered or verified. Keeps the handoff ID and previous finish as audit history; requires concrete evidence of the mistaken finish.', inputSchema: { type: 'object', required: ['handoff_id', 'evidence'], properties: { handoff_id: { type: 'string' }, evidence: { type: 'string' } } }, run: input => call('/handoffs/reopen-incorrect-finish', input) },
  { name: 'say_what_is_in_the_way', description: 'Says what stands in the way of a job this agent took (or one waiting for it by name): in_the_way in plain words, for example "Needs the person to sign in to their bank". The job shows as stuck on the person\'s work screen and the one who asked is told. in_the_way null says nothing is in the way any more. Finishing the job clears it.', inputSchema: { type: 'object', required: ['handoff_id', 'agent_id', 'in_the_way'], properties: { handoff_id: { type: 'string' }, agent_id: { type: 'string' }, generation: { type: 'integer', minimum: 0 }, in_the_way: { type: ['string', 'null'] } } }, run: input => call('/handoffs/in-the-way', input) },
  { name: 'release_work', description: 'Gives back a job this agent took and cannot finish now (for example because Trillion keeps answering busy), so it waits for whoever can take it next at once instead of staying held until its hold runs out. because (optional) says why in plain words.', inputSchema: { type: 'object', required: ['handoff_id', 'agent_id'], properties: { handoff_id: { type: 'string' }, agent_id: { type: 'string' }, generation: { type: 'integer' }, because: { type: 'string' } } }, run: input => call('/handoffs/release', input) },
  { name: 'record_effect', description: 'Records an effect of a job this agent holds that reaches outside Trillion (a payment, a post, a message sent, a file written somewhere), so it is never done twice. effect_id names that one effect and stays the same on every try (for example payment:invoice-42). Call with state starting just before doing it: proceed true means go ahead; proceed false means it is already done, or an earlier attempt may have done it (unknown), so check the target instead of doing it again. Then call with state done or failed, and receipt (what the target answered, never a secret). An unknown effect is settled by checking its target and recording done or failed with the receipt; while one is unknown, starting any other effect answers proceed false (locked_by), so only look, until it is settled or the person writes again in the conversation the work came from. A failed effect keeps outcome { retryable, side_effect, required_next }; give retryable false, required_next or side_effect when the target said more. generation is the one take_work returned.', inputSchema: { type: 'object', required: ['handoff_id', 'agent_id', 'generation', 'effect_id', 'state'], properties: { handoff_id: { type: 'string' }, agent_id: { type: 'string' }, generation: { type: 'integer', minimum: 0 }, effect_id: { type: 'string' }, state: { type: 'string', enum: ['starting', 'done', 'failed'] }, target: { type: 'string' }, receipt: {}, retryable: { type: 'boolean' }, required_next: { type: 'string' }, side_effect: { type: 'string' } } }, run: input => call('/handoffs/effect', input) },
  { name: 'saved_instructions', description: 'The ready-made instructions this person picks from when they send something to their AIs (a page, a post, a file), for example "I have no clue what to do with this, figure out if it is valuable". Without instructions, returns their list (from: saved), or the current published starter list when they have saved none (from: starters). An empty list keeps none; instructions: null resets the private list to current starters. With instructions (each { label, words }, optionally id and folder; a folder is { label, kind: "folder" }, optionally id and folder), replaces their list and returns it: read it first, then add, change, rename, remove, reorder (rows keep the order given among the rows of their folder) or file rows in folders (folder: the id of a folder row in the same list). An instruction with workflow { workflow_id, input } (workflow_id from find_workflow; an input value { "fill": { "from": "share", "field": "words" } } is taken from what is sent: words, own_words, links or items) also starts that workflow on what is sent. When a handoff carries saved_instructions in its input (their ids), its job is the words of those instructions. Each row records its origin (class person or agent, who, when); a row an AI proposed (proposed: true, when this account asks AIs to propose) is left out of what the person picks from until the person keeps it.', inputSchema: { type: 'object', properties: { instructions: { type: ['array', 'null'], maxItems: MAX_INSTRUCTIONS, items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, words: { type: 'string', description: 'What the AI should do; every row but a folder has words' }, kind: { type: 'string', enum: ['folder'], description: 'folder for a folder row' }, folder: { type: 'string', description: 'The id of the folder row it sits in' }, workflow: { type: 'object', description: 'A workflow this instruction starts on what is sent: { workflow_id, input }', properties: { workflow_id: { type: 'string' }, input: { type: 'object' } } }, proposed: { type: 'boolean', description: 'false, written by the person, keeps a row an AI proposed' } } } }, add_instructions: { type: 'array', maxItems: MAX_INSTRUCTIONS, description: 'Rows to ADD ({ label, words }, optionally id, folder): every saved instruction stays as it is; a row whose id or words are already saved is skipped and named in skipped. Returns added and skipped.', items: { type: 'object' } }, imported_from: { type: 'string', description: 'Where add_instructions came from, such as ai-setups (read-ai-setups); each added row records it' } } }, run: input => call('/agents/instructions', input ?? {}) },
  { name: 'agent_presence', description: 'Says a published agent is present and can be reached at its delivery address. Events that could not be delivered to it are sent again. It never returns work: work arrives as an event, or with take_work.', inputSchema: { type: 'object', required: ['agent_id'], properties: { agent_id: { type: 'string' } } }, run: input => call('/agents/presence', input) },
  { name: 'send_agent_event', description: 'Wakes one agent on this account that published a delivery address, with a signed event of any type, for example tool.run.requested to the agent whose computer has the tool, and tool.run.finished back to the agent that asked. The event carries only ids (subject_id, refs, next_call arguments) and a summary of at most 300 characters: never inputs, results or file bytes, which the woken agent reads from wherever they live. The same idempotency_key sends the event once. The answer shows whether the receiver reported itself present lately; an event it cannot take now is tried again and then kept until it is present again. An agent with no delivery route is sent nothing: the answer says so (receiver.route next_connection), and it reads its work the next time it connects.', inputSchema: { type: 'object', required: ['type', 'to_agent', 'idempotency_key', 'subject_id'], properties: { type: { type: 'string' }, to_agent: { type: 'string' }, from_agent: { type: 'string' }, idempotency_key: { type: 'string' }, subject_id: { type: 'string' }, summary: { type: 'string', maxLength: 300 }, refs: { type: 'object', additionalProperties: { type: 'string' } }, next_call: { type: 'object', required: ['tool'], properties: { tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: { type: 'string' } } } } } }, run: input => call('/agents/events', input) },
  { name: 'resend_agent_event', description: 'Says this agent received an event but cannot use it (it could not read it, or a check failed) and asks for it to be sent again: the event goes back to waiting and is tried afresh, and the number of such requests is kept on it (resend_requests, at most 5; past that it stays as it is and the answer says so). reason is a few plain words.', inputSchema: { type: 'object', required: ['event_id', 'agent_id'], properties: { event_id: { type: 'string' }, agent_id: { type: 'string' }, reason: { type: 'string', maxLength: 300 } } }, run: input => call('/agents/events/resend', input) },
  { name: 'read_agent_events', description: 'The events sent about one subject_id (a handoff or a run), or one event_id: each with its receiver, whether it was delivered, is waiting to be tried again, or is dead, and how many attempts it took.', inputSchema: { type: 'object', properties: { subject_id: { type: 'string' }, event_id: { type: 'string' } } }, run: input => call('/agents/events/read', input ?? {}) },
  { name: 'read_handoff', description: 'Reads one handoff by handoff_id: its state, who took it, and its result, plus any parts handed on from it and the events sent about it (delivered, waiting to be tried again, or dead). Without handoff_id, lists this account\'s newest handoffs. Works from any AI app signed in to the same account.', inputSchema: { type: 'object', properties: { handoff_id: { type: 'string' } } }, run: input => call('/handoffs/read', input ?? {}) },
];

export const agentAnnotations = {
  withdraw_waiting_work: { title: 'Withdraw waiting work', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  publish_agent: { title: 'Say what this agent does', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_agent_capacity: { title: 'Report this agent’s capacity', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  decide_agent_skills: { title: 'Approve or refuse an agent\u2019s new skills', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  find_agents: { title: 'Find agents for a job', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  hand_off: { title: 'Hand a job to another agent', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  address_open_work: { title: 'Name the agent for waiting work', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  take_work: { title: 'Take waiting work', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  finish_work: { title: 'Finish taken work', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  reopen_incorrect_finish: { title: 'Correct an early finish', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  say_what_is_in_the_way: { title: 'Say what is in the way of work', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  release_work: { title: 'Give back work this AI cannot finish now', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  record_effect: { title: 'Record an effect so it is never done twice', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  saved_instructions: { title: 'Read or change saved instructions', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  agent_presence: { title: 'Say this agent is present', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  send_agent_event: { title: 'Wake an agent with an event', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  resend_agent_event: { title: 'Ask for an event to be sent again', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  read_agent_events: { title: 'Read the events sent about something', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  read_handoff: { title: 'Read a handoff', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
