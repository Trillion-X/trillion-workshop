// tools/hand-work-to-ais/read-data/ai-work.mjs
//
// Work handed between a person's AIs, kept as their own records and nowhere else. A job is one record of kind ai-job,
// an AI one record of kind ai (read-data/ai-work.json names both). Every function here is one Workshop row, called by
// tools/records-door/do-work/run-an-export.mjs as fn({ input, task }, { door }):
//
//   seeMyAis      -> { ais: [{ id, value, live, seen_at, busy }] }                  the AIs, live first, then their order
//   handAJob      -> { job_id, status: 'written' | 'already-there', job }           a new waiting job, once per key
//   seeAiWork     -> { jobs: [job], more }                                          one job, or the newest that match
//   takeAJob      -> { taken: job | null, tried, job_id?, reason?, job? }           the first job it may take, or one named
//   moveAJob      -> { job_id, moved, from, to, reason?, job }                      finish, fail, release, stuck, ... remove
//
// THE ONE INVARIANT: every change of a job is ONE records:write of the whole job, conditioned on the value just read
// (`expected`, product/own-record-writes.json in the engine). The engine checks that condition inside the account's
// own transaction, so of two AIs that read the same waiting job and both try to take it, the first write wins and the
// second is refused whole (`original_command_conflict`) and changes nothing. A refused take tries the next job; a
// refused move answers `moved: false, reason: 'changed'` with the job as it is now, so the caller decides again on
// what is really there. Nothing here locks, waits or keeps anything between runs.
//
// THE RULES ARE DATA. Which status a job may move to, on which action, for whom and after how long (the stale-take
// time) are rows of read-data/ai-work.json, checked by the shared stage engine (tools/move-records-through-declared-
// states: statesByKey, transitionsFrom, conditionHolds). A job's status is its one current state; its earlier states
// are the record's own version history in the person's account, so no second copy of them is kept in the value.
import { readFileSync } from 'node:fs';
import { conditionHolds, statesByKey, transitionsFrom } from '../../move-records-through-declared-states/do-work/move-records-through-declared-states.mjs';

const RULES = JSON.parse(readFileSync(new URL('./ai-work.json', import.meta.url), 'utf8'));
const CHANGED = 'original_command_conflict';
const REMOVE = 'remove';
const KEY = /^[A-Za-z0-9._:-]+$/;

// The rules, checked once: every state declared once, every transition between declared states and none out of a
// terminal one (the stage engine throws), every action named, every field source one this file knows.
export function workRules(rules = RULES) {
  const states = statesByKey(rules.states);
  if (!states.has(rules.start)) throw new Error(`The start status "${rules.start}" is not a declared state.`);
  const transitions = transitionsFrom(rules.transitions, states);
  const readAs = rules.read_as ?? {};
  for (const [word, state] of Object.entries(readAs)) {
    if (states.has(word)) throw new Error(`read_as maps "${word}", which is already a declared state.`);
    if (!states.has(state)) throw new Error(`read_as maps "${word}" to "${state}", which is not a declared state.`);
  }
  for (const edge of transitions) {
    if (typeof edge.action !== 'string' || !edge.action || edge.action === REMOVE) throw new Error(`A transition needs an action other than "${REMOVE}": ${JSON.stringify(edge)}`);
    for (const [field, source] of Object.entries(edge.set ?? {})) {
      if (!['as', 'now', 'input', 'note'].includes(source?.from)) throw new Error(`${edge.action} sets ${field} from "${source?.from}", which is not as, now, input or note.`);
      if (['input', 'note'].includes(source.from) && typeof source.field !== 'string') throw new Error(`${edge.action} sets ${field} from ${source.from} without naming its field.`);
    }
  }
  return { ...rules, read_as: readAs, states, transitions, actions: [...new Set(transitions.map(edge => edge.action)), REMOVE] };
}

const RULED = workRules();

// The declared state a stored status word means: itself, or what `read_as` maps it to.
export const stateOf = (status, rules = RULED) => rules.read_as[status] ?? status;
// Every stored word that means a declared state, so a listing by state finds the jobs written with either.
const wordsFor = (state, rules) => [state, ...Object.keys(rules.read_as).filter(word => rules.read_as[word] === state)];

function words(value, name, most) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be words.`);
  if (value.length > most) throw new Error(`${name} is ${value.length} characters; at most ${most}.`);
  return value;
}

function aiId(value, name, rules) {
  words(value, name, rules.limits.id_chars);
  if (!value.startsWith(`${rules.ai_kind}:`)) throw new Error(`${name} must be an AI's record id, ${rules.ai_kind}:<name>; seeMyAis lists them.`);
  return value;
}

function jobId(value, rules) {
  words(value, 'id', rules.limits.id_chars);
  if (!value.startsWith(`${rules.job_kind}:`)) throw new Error(`id must be a job's record id, ${rules.job_kind}:<key>; seeAiWork lists them.`);
  return value;
}

const nowOf = context => (context.now ? context.now() : new Date());
const shown = (id, value) => (value ? { id, ...Object.fromEntries(Object.entries(value).filter(([field]) => field !== 'kind')) } : null);
const isChanged = error => error?.code === CHANGED;

// What the conditions of the rules are judged on, for one caller and one job at one time.
export function signalsOf(job, as, now, rules = RULED) {
  const signals = {
    is_taker: job.taker === as,
    is_sender: job.from === as,
    addressed_to_me: job.to === null || job.to === undefined || job.to === as,
    terminal: rules.states.get(stateOf(job.status, rules))?.terminal === true,
  };
  const taken = Date.parse(job.taken_at ?? '');
  if (Number.isFinite(taken)) signals.taken_minutes = (now.getTime() - taken) / 60000;
  return signals;
}

// The declared move of `action` from the job's status that holds for this caller now, or why there is none.
export function moveFor(job, action, as, now, rules = RULED) {
  if (!rules.actions.includes(action)) throw new Error(`action must be one of ${rules.actions.join(', ')}.`);
  const signals = signalsOf(job, as, now, rules);
  if (action === REMOVE) {
    return conditionHolds(rules.remove_when, signals) ? { edge: null } : { refused: `${as} may not remove a job that is ${job.status}: only its sender may, or anyone once it is finished.` };
  }
  const status = stateOf(job.status, rules);
  const edges = rules.transitions.filter(edge => edge.action === action && edge.from === status);
  if (!edges.length) return { refused: `A job that is ${job.status} cannot be given "${action}".` };
  const edge = edges.find(one => conditionHolds(one.when, signals));
  if (!edge) {
    const who = [job.taker && `taken by ${job.taker}`, job.from && `sent by ${job.from}`, job.to && `addressed to ${job.to}`].filter(Boolean).join(', ');
    return { refused: `The rule for "${action}" on a job that is ${job.status} does not hold for ${as} (the job is ${who || 'addressed to any AI'}).` };
  }
  return { edge };
}

// The whole job after a move: the declared fields cleared, then set, and the status the move goes to.
export function movedJob(job, edge, as, input, now, rules = RULED) {
  const next = { ...job };
  for (const field of edge.clear ?? []) delete next[field];
  for (const [field, source] of Object.entries(edge.set ?? {})) {
    const given = source.field === undefined ? undefined : input[source.field];
    if (given === undefined || given === null) {
      if (source.required) throw new Error(`"${edge.action}" needs ${source.field}.`);
      if (source.from === 'input') continue;
    } else {
      words(given, source.field, source.most_chars ?? rules.limits.words_chars);
    }
    if (source.from === 'as') next[field] = as;
    else if (source.from === 'now') next[field] = now.toISOString();
    else if (source.from === 'input') next[field] = given;
    else next[field] = { by: as, at: now.toISOString(), words: given ?? null };
  }
  // A move that leaves the job in the state it is in keeps the word it was stored with; any other writes the state.
  if (stateOf(job.status, rules) !== edge.to) next.status = edge.to;
  return next;
}

const readJob = (door, id, rules) => door.read(rules.job_kind, id);

// One conditional write of the job's next value (null removes it). False when the job changed since it was read.
async function writeIfUnchanged(door, id, before, after, key, rules) {
  try {
    await door.write([{ id, type: rules.job_kind, value: after, expected: { type: rules.job_kind, value: before } }], { key });
    return true;
  } catch (error) {
    if (isChanged(error)) return false;
    throw error;
  }
}

// A retried run (the same request key) sends the same write key, so the door answers the receipt it already kept.
const writeKey = (task, id, action) => (typeof task.request_key === 'string' && task.request_key ? `${task.request_key}:${action}:${id}` : undefined);

async function moveRead(door, id, before, action, as, input, now, task, rules) {
  const { edge, refused } = moveFor(before, action, as, now, rules);
  if (refused) throw new Error(refused);
  const after = edge ? movedJob(before, edge, as, input, now, rules) : null;
  if (await writeIfUnchanged(door, id, before, after, writeKey(task, id, action), rules)) {
    return { job_id: id, moved: true, from: before.status, to: after?.status ?? null, job: shown(id, after) };
  }
  const current = await readJob(door, id, rules);
  return { job_id: id, moved: false, from: before.status, to: null, reason: current ? 'changed' : 'gone', job: shown(id, current) };
}

// Every record the query names, at most `most` of them.
async function listed(door, query, most) {
  const found = [];
  for await (const record of door.list(query)) {
    found.push(record);
    if (found.length >= most) break;
  }
  return found;
}

// Every job in one declared state, whichever stored word it was written with, at most `most` of them.
async function listedIn(door, state, query, most, rules) {
  const found = [];
  for (const status of wordsFor(state, rules)) {
    if (found.length >= most) break;
    found.push(...await listed(door, { ...query, type: rules.job_kind, where: { ...query.where, status } }, most - found.length));
  }
  return found;
}

export async function seeMyAis({ input = {} } = {}, context) {
  const rules = RULED;
  const { door } = context;
  const now = nowOf(context);
  const needs = input.can ?? [];
  if (!Array.isArray(needs) || needs.some(word => typeof word !== 'string' || !word)) throw new Error('can must be a list of words, such as ["code"].');
  const busy = new Map();
  for (const job of await listedIn(door, 'taken', { fields: ['taker'] }, rules.most_jobs_read, rules)) {
    const taker = job.value?.taker;
    if (typeof taker === 'string') busy.set(taker, (busy.get(taker) ?? 0) + 1);
  }
  // Each AI's whole stored value comes back as it is: what a screen or the trillion command names it by is worked out
  // from those cells by its own formula, never from a name kept here. Only liveness and busyness are added.
  const ais = (await listed(door, { type: rules.ai_kind }, rules.most_ais_read)).map(({ id, value }) => {
    const held = value ?? {};
    const seen = Date.parse(held.live?.seen_at ?? '');
    const minutes = typeof held.live?.minutes === 'number' ? held.live.minutes : rules.live_minutes_default;
    return {
      id, value: held,
      live: Number.isFinite(seen) && now.getTime() - seen <= minutes * 60000,
      seen_at: Number.isFinite(seen) ? new Date(seen).toISOString() : null,
      busy: busy.get(id) ?? 0,
    };
  }).filter(ai => {
    const can = Array.isArray(ai.value.can) ? ai.value.can : [];
    return needs.every(word => can.includes(word) || can.includes('any')) && (!input.live_only || ai.live);
  });
  const order = ai => (typeof ai.value.order === 'number' ? ai.value.order : Number.MAX_SAFE_INTEGER);
  ais.sort((a, b) => Number(b.live) - Number(a.live) || order(a) - order(b) || (a.id < b.id ? -1 : 1));
  return { ais };
}

export async function handAJob({ input = {}, task = {} } = {}, context) {
  const rules = RULED;
  const { door } = context;
  const now = nowOf(context);
  const from = aiId(input.as, 'as', rules);
  const job = words(input.job, 'job', rules.limits.job_chars);
  const key = input.key ?? task.request_key;
  if (typeof key !== 'string' || !KEY.test(key) || key.length > rules.limits.id_chars) {
    throw new Error('key must be letters, digits, dot, colon, dash or underscore: the same key sends the same job once.');
  }
  let to = null;
  if (input.to !== undefined && input.to !== null) {
    to = aiId(input.to, 'to', rules);
    if (!(await door.read(rules.ai_kind, to))) throw new Error(`No AI ${to} is among this person's AIs; seeMyAis lists them, or leave to out for any AI.`);
  }
  const priority = input.priority ?? rules.default_priority;
  if (!Number.isInteger(priority) || priority < 0 || priority > 9) throw new Error('priority must be a whole number from 0 to 9.');
  const value = { kind: rules.job_kind, status: rules.start, job, to, from, priority, sent_at: now.toISOString() };
  if (input.label !== undefined) value.label = words(input.label, 'label', rules.limits.words_chars);
  if (input.outcome !== undefined) value.outcome = words(input.outcome, 'outcome', rules.limits.words_chars);
  const id = `${rules.job_kind}:${key}`;
  // The write's own key is the run's: a retried run is answered the receipt it already has, while another run with the
  // same job key meets the job already there (the condition of absence), never a receipt that is not its own.
  try {
    await door.write([{ id, type: rules.job_kind, value, expected: null }], { key: writeKey(task, id, 'send') });
  } catch (error) {
    if (!isChanged(error)) throw error;
    return { job_id: id, status: 'already-there', job: shown(id, await readJob(door, id, rules)) };
  }
  return { job_id: id, status: 'written', job: shown(id, value) };
}

export async function seeAiWork({ input = {} } = {}, context) {
  const rules = RULED;
  const { door } = context;
  if (input.id !== undefined) {
    const id = jobId(input.id, rules);
    const job = await readJob(door, id, rules);
    if (!job) throw new Error(`No job ${id} is in this person's records.`);
    return { jobs: [shown(id, job)], more: false };
  }
  const where = {};
  let state;
  if (input.status !== undefined) {
    state = stateOf(input.status, rules);
    if (!rules.states.has(state)) throw new Error(`status must be one of ${[...rules.states.keys()].join(', ')}.`);
  }
  for (const field of ['to', 'from', 'taker']) if (input[field] !== undefined) where[field] = aiId(input[field], field, rules);
  const limit = input.limit ?? rules.jobs_shown.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > rules.jobs_shown.most) throw new Error(`limit must be a whole number from 1 to ${rules.jobs_shown.most}.`);
  const found = state === undefined
    ? await listed(door, { type: rules.job_kind, ...(Object.keys(where).length ? { where } : {}) }, rules.most_jobs_read)
    : await listedIn(door, state, { where }, rules.most_jobs_read, rules);
  found.sort((a, b) => String(b.value?.sent_at ?? '').localeCompare(String(a.value?.sent_at ?? '')) || (a.id < b.id ? 1 : -1));
  return { jobs: found.slice(0, limit).map(record => shown(record.id, record.value)), more: found.length > limit };
}

// Compare two jobs by the declared take order: the job to take first sorts first.
function takeOrder(rules) {
  return (a, b) => {
    for (const { field, direction, missing } of rules.take_order) {
      const left = a.value[field] ?? missing;
      const right = b.value[field] ?? missing;
      if (left === right) continue;
      const before = left < right ? -1 : 1;
      return direction === 'descending' ? -before : before;
    }
    return a.id < b.id ? -1 : 1;
  };
}

export async function takeAJob({ input = {}, task = {} } = {}, context) {
  const rules = RULED;
  const { door } = context;
  const now = nowOf(context);
  const as = aiId(input.as, 'as', rules);
  if (input.id !== undefined) {
    const id = jobId(input.id, rules);
    const job = await readJob(door, id, rules);
    if (!job) throw new Error(`No job ${id} is in this person's records.`);
    const answer = await moveRead(door, id, job, 'take', as, input, now, task, rules);
    return answer.moved
      ? { taken: answer.job, tried: 1 }
      : { taken: null, tried: 1, job_id: id, reason: answer.reason, job: answer.job };
  }
  // Every job a take may move: the statuses the take rows leave from, then only those whose rule holds for this caller.
  const candidates = [];
  for (const status of new Set(rules.transitions.filter(edge => edge.action === 'take').map(edge => edge.from))) {
    for (const record of await listedIn(door, status, {}, rules.most_jobs_read, rules)) {
      if (!record.value || (input.only_mine && record.value.to !== as)) continue;
      if (moveFor(record.value, 'take', as, now, rules).edge) candidates.push(record);
    }
  }
  candidates.sort(takeOrder(rules));
  let tried = 0;
  for (const { id, value } of candidates.slice(0, rules.take_tries)) {
    tried += 1;
    const answer = await moveRead(door, id, value, 'take', as, input, now, task, rules);
    if (answer.moved) return { taken: answer.job, tried };
  }
  return { taken: null, tried };
}

export async function moveAJob({ input = {}, task = {} } = {}, context) {
  const rules = RULED;
  const { door } = context;
  const now = nowOf(context);
  const as = aiId(input.as, 'as', rules);
  const id = jobId(input.id, rules);
  if (typeof input.action !== 'string') throw new Error(`action must be one of ${rules.actions.join(', ')}.`);
  const job = await readJob(door, id, rules);
  if (!job) throw new Error(`No job ${id} is in this person's records.`);
  return moveRead(door, id, job, input.action, as, input, now, task, rules);
}
