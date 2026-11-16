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
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { makeJudge, ruleApplies, TEST_NAMES } from '../../judge-words/do-work/judge-words.mjs';

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
      if (!['as', 'now', 'input', 'note', 'job'].includes(source?.from)) throw new Error(`${edge.action} sets ${field} from "${source?.from}", which is not as, now, input or note (or the current job).`);
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

// What a job asks for, as words: its outcome, else its job when that is words, else its label. A job whose `job` is a list
// (a workflow run, a lane of a step) names its outcome or its label; this is the one place that reads it.
const isWords = value => typeof value === 'string' && value.trim() !== '';
export const requestedOutcome = job => [job.outcome, job.job, job.label].find(isWords);

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
    is_continuation_owner: job.continuation?.owner === as,
    is_releaser: job.released?.by === as,
    resume_due: !job.continuation || Date.parse(job.continuation.after) <= now.getTime(),
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
  if (edge.needs_any && !edge.needs_any.some(field => Object.hasOwn(input, field))) throw new Error(`"${edge.action}" needs one of ${edge.needs_any.join(', ')}.`);
  const next = { ...job };
  for (const field of edge.clear ?? []) delete next[field];
  for (const [field, source] of Object.entries(edge.set ?? {})) {
    const given = source.field === undefined ? undefined : input[source.field];
    if (given === undefined || (given === null && !source.nullable)) {
      if (source.required) throw new Error(`"${edge.action}" needs ${source.field}.`);
      if (source.from === 'input') continue;
    } else {
      if (source.format === 'check') checkOutcome(given, job, now, rules);
      else if (source.format === 'continuation') checkContinuation(given, now, rules);
      else if (source.format === 'source') sourceOf(given, rules);
      else if (source.format === 'obligations') obligationsOf(given, rules);
      else if (source.format === 'ai-or-any') { if (given !== null) aiId(given, source.field, rules); }
      else if (source.format === 'priority') { if (!Number.isInteger(given) || given < 0 || given > 9) throw new Error('priority must be a whole number from 0 to 9.'); }
      else if (source.format === 'acceptance') acceptanceOf(given, { ...job, ...input }, rules);
      else words(given, source.field, source.most_chars ?? rules.limits.words_chars);
      if (source.preserve_existing && job[field] != null && makeHashCodeHexFromJson(job[field]) !== makeHashCodeHexFromJson(given)) {
        throw new Error(`"${edge.action}" cannot replace the saved ${field}.`);
      }
    }
    if (source.from === 'as') next[field] = as;
    else if (source.from === 'now') next[field] = now.toISOString();
    else if (source.from === 'job') next[field] = job[source.field];
    else if (source.from === 'input') next[field] = given;
    else next[field] = { by: as, at: now.toISOString(), words: given ?? null };
  }
  // A move that leaves the job in the state it is in keeps the word it was stored with; any other writes the state.
  if (stateOf(job.status, rules) !== edge.to) next.status = edge.to;
  return next;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function sourceOf(value, rules) {
  if (!object(value)) throw new Error('source needs kind and ref.');
  return { kind: words(value.kind, 'source.kind', rules.limits.id_chars), ref: words(value.ref, 'source.ref', rules.limits.words_chars) };
}
function obligationsOf(value, rules) {
  if (!Array.isArray(value) || !value.length || value.length > rules.completion.max_obligations) throw new Error('obligations must be a bounded nonempty list.');
  const ids = new Set();
  return value.map(part => {
    if (!object(part)) throw new Error('Each obligation needs id and outcome.');
    const id = words(part.id, 'obligation.id', rules.limits.id_chars);
    if (id === 'outcome') throw new Error('The obligation id outcome is reserved for the whole requested outcome.');
    if (ids.has(id)) throw new Error('Each obligation id must be unique.');
    ids.add(id);
    return { id, outcome: words(part.outcome, 'obligation.outcome', rules.limits.words_chars) };
  });
}
function acceptanceOf(value, job, rules) {
  if (!object(value) || value.outcome !== requestedOutcome(job) || !object(value.target)) throw new Error('acceptance must bind the saved outcome to an actual record target and checks.');
  words(value.target.type, 'acceptance.target.type', rules.limits.id_chars);
  words(value.target.id, 'acceptance.target.id', rules.limits.id_chars);
  const expected = new Set(['outcome', ...(job.obligations ?? []).map(part => part.id)]);
  if (!Array.isArray(value.rules) || value.rules.length !== expected.size) throw new Error('acceptance.rules must check the outcome and each obligation.');
  for (const rule of value.rules) {
    if (!object(rule) || !expected.delete(rule.id) || typeof rule.path !== 'string' || rule.ask || rule.at_most || rule.kinds || rule.when || !TEST_NAMES.some(name => rule[name] !== undefined && rule[name] !== false)) throw new Error('Each acceptance rule must directly check its saved part against consumer data.');
    makeJudge([rule]);
  }
  return value;
}

async function checkedConsumer(door, job, input, now, rules) {
  const acceptance = acceptanceOf(job.acceptance, job, rules);
  if (makeHashCodeHexFromJson(input.check?.target ?? null) !== makeHashCodeHexFromJson(acceptance.target)) throw new Error('check.target must be the saved acceptance target; use tool:finish-an-ai-job for its scoped read.');
  const observed = await door.read(acceptance.target.type, acceptance.target.id);
  if (observed === null || observed === undefined) throw new Error('The requested consumer record is unavailable; the job remains unfinished.');
  const item = { value: observed };
  if (!acceptance.rules.every(rule => ruleApplies(rule, item))) throw new Error('Every saved acceptance rule must apply to the observed consumer.');
  const findings = makeJudge(acceptance.rules)([item]);
  if (findings.length) throw new Error(`The requested outcome is not checked: ${JSON.stringify(findings)}`);
  return { ...input.check, checked_at: now.toISOString(), consumer: { ...acceptance.target, identity: makeHashCodeHexFromJson(observed) }, acceptance_identity: makeHashCodeHexFromJson(acceptance), taken_at: job.taken_at };
}
function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp.`);
  return Date.parse(value);
}

function evidenceOf(evidence, name, rules) {
  if (!Array.isArray(evidence) || !evidence.length || evidence.length > rules.completion.max_evidence) throw new Error(`${name} needs observed evidence (1 to ${rules.completion.max_evidence} entries).`);
  for (const item of evidence) {
    if (!object(item)) throw new Error(`${name} evidence needs a ref and observation.`);
    words(item.ref, `${name}.ref`, rules.limits.words_chars);
    words(item.observation, `${name}.observation`, rules.limits.result_chars);
  }
}

// This contract preserves an accountable observation, not a semantic oracle. The executing AI must actually inspect
// the requested consumer; a path, commit, exit code or an asserted observation is not independently verified here.
export function checkOutcome(check, job, now, rules = RULED) {
  if (!object(check)) throw new Error('finish needs check: the requested outcome, checked_at and observed consumer evidence.');
  if (check.outcome !== requestedOutcome(job)) throw new Error('check.outcome must match the job\'s saved requested outcome.');
  const checked = timestamp(check.checked_at, 'check.checked_at');
  if (checked > now.getTime() || checked < Date.parse(job.taken_at ?? job.sent_at ?? '')) throw new Error('check.checked_at must be during this take, not before it or in the future.');
  evidenceOf(check.evidence, 'check', rules);
  const obligations = job.obligations ?? [];
  const checkedParts = check.obligations ?? [];
  if (!Array.isArray(checkedParts) || checkedParts.length !== obligations.length) throw new Error('check.obligations must cover every saved obligation exactly once.');
  const ids = new Set();
  for (const part of checkedParts) {
    const expected = obligations.find(one => one.id === part?.id);
    if (!expected || ids.has(part.id) || part.outcome !== expected.outcome) throw new Error('check.obligations must match each saved id and outcome exactly once.');
    ids.add(part.id);
    evidenceOf(part.evidence, `check.obligations.${part.id}`, rules);
  }
  return check;
}

export function checkContinuation(value, now, rules = RULED) {
  if (!object(value)) throw new Error('continuation needs an owner, action, after and reason.');
  aiId(value.owner, 'continuation.owner', rules);
  words(value.action, 'continuation.action', rules.limits.words_chars);
  words(value.reason, 'continuation.reason', rules.limits.words_chars);
  const after = timestamp(value.after, 'continuation.after');
  if (after < now.getTime() || after > now.getTime() + rules.completion.max_resume_minutes * 60000) throw new Error(`continuation.after must be now or within ${rules.completion.max_resume_minutes} minutes for owned review.`);
  return value;
}

const readJob = (door, id, rules) => door.read(rules.job_kind, id);

// One conditional write of the job's next value (null removes it). False when the job changed since it was read.
async function writeIfUnchanged(door, id, before, after, key, rules) {
  try {
    await door.write([{ id, type: rules.job_kind, value: after, expected: { type: rules.job_kind, value: before } }], { key });
    // A retried write may replay an old door receipt after this job moved again. Only the current persisted value can
    // establish that this attempted transition owns the job now. Never launch an effect from a historical receipt.
    const current = await readJob(door, id, rules);
    return makeHashCodeHexFromJson(current ?? null) === makeHashCodeHexFromJson(after ?? null);
  } catch (error) {
    if (isChanged(error)) return false;
    throw error;
  }
}

// A retried run (the same request key) sends the same write key, so the door answers the receipt it already kept.
const writeKey = (task, id, action) => (typeof task.request_key === 'string' && task.request_key ? `${task.request_key}:${action}:${id}` : undefined);
// Progress notes replace last_move, but do not replace the request that acquired the current claim. This receipt
// stays on that job through its release; the outer tool-run journal owns replay after a different claim or terminal
// state, so the next-job lookup never needs an unbounded history scan.
const takeReplay = (job, key) => key && (job.take_request?.key === key ? job.take_request : job.last_move?.key === key ? job.last_move : null);

async function moveRead(door, id, before, action, as, input, now, task, rules) {
  const key = writeKey(task, id, action);
  const signature = key ? makeHashCodeHexFromJson({ action, as, input }) : null;
  const replay = action === 'take' ? takeReplay(before, key) : key && before.last_move?.key === key ? before.last_move : null;
  if (replay) {
    if (replay.signature !== signature) throw new Error('The same move request key cannot name different input.');
    if (action === 'take') {
      // A next-job candidate came from a listing that may already be stale. Replay ownership only from an exact
      // current read of the same claim, never from that earlier listing or from the door's historical receipt.
      const current = await readJob(door, id, rules);
      const held = current && takeReplay(current, key);
      if (!held || !Number.isFinite(Date.parse(held.taken_at)) || stateOf(current.status, rules) !== 'taken' || current.taker !== as || held.taken_at !== current.taken_at) {
        return { job_id: id, moved: false, from: replay.from, to: null, reason: current ? 'changed' : 'gone', job: shown(id, current), replayed: true };
      }
      return { job_id: id, moved: true, from: held.from, to: current.status, job: shown(id, current), replayed: true };
    }
    return { job_id: id, moved: true, from: replay.from, to: before.status, job: shown(id, before), replayed: true };
  }
  const { edge, refused } = moveFor(before, action, as, now, rules);
  if (refused) throw new Error(refused);
  if (rules.holder_actions.includes(action) && before.taker === as && input.taken_at !== before.taken_at) throw new Error('taken_at must name this exact current claim; an old run may not move a newer take.');
  if (action === 'wait' && before.status === 'waiting' && before.released?.by === as && input.taken_at !== before.released_taken_at) throw new Error('taken_at must name the claim that released this job.');
  const after = edge ? movedJob(before, edge, as, input, now, rules) : null;
  if (action === 'edit' && after.acceptance) acceptanceOf(after.acceptance, after, rules);
  const checked = action === 'finish' ? await checkedConsumer(door, before, input, now, rules) : null;
  if (checked) after.check = checked;
  if (input.continuation && !(await door.read(rules.ai_kind, input.continuation.owner))) throw new Error('continuation.owner must be one of this person\'s existing AIs.');
  if (action === 'edit' && input.to && !(await door.read(rules.ai_kind, input.to))) throw new Error('to must name one of this person\'s existing AIs.');
  if (after && key) after.last_move = { key, signature, from: before.status };
  else if (after) delete after.last_move;
  if (after && action === 'take') {
    if (key) after.take_request = { key, signature, from: before.status, taken_at: after.taken_at };
    else delete after.take_request;
  }
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
  if (input.source !== undefined) value.source = sourceOf(input.source, rules);
  if (input.obligations !== undefined) value.obligations = obligationsOf(input.obligations, rules);
  if (input.acceptance !== undefined) value.acceptance = acceptanceOf(input.acceptance, value, rules);
  const id = `${rules.job_kind}:${key}`;
  // The write's own key is the run's: a retried run is answered the receipt it already has, while another run with the
  // same job key meets the job already there (the condition of absence), never a receipt that is not its own.
  try {
    await door.write([{ id, type: rules.job_kind, value, expected: null }], { key: writeKey(task, id, 'send') });
  } catch (error) {
    if (!isChanged(error)) throw error;
    return { job_id: id, status: 'already-there', job: shown(id, await readJob(door, id, rules)) };
  }
  const current = await readJob(door, id, rules);
  return { job_id: id, status: current ? 'written' : 'gone', job: shown(id, current) };
}

// System producers preserve their actual record origin. A hold/workflow is not a fictional AI. Its action owner
// includes this absence-conditioned job in the same transaction as the source transition, and reuses the stable key.
export function prepareProducedJob(input, now = new Date()) {
  const rules = RULED;
  if (typeof input.key !== 'string' || !KEY.test(input.key) || input.key.length > rules.limits.id_chars) throw new Error('A produced job needs a stable key.');
  const source = sourceOf(input.source, rules);
  const priority = input.priority ?? rules.default_priority;
  if (!Number.isInteger(priority) || priority < 0 || priority > 9) throw new Error('priority must be a whole number from 0 to 9.');
  const value = { kind: rules.job_kind, status: rules.start, job: words(input.job, 'job', rules.limits.job_chars), to: null, from: null, producer: source, source, priority, sent_at: now.toISOString() };
  if (input.source_job !== undefined) value.source_job = words(input.source_job, 'source_job', rules.limits.words_chars);
  if (input.input !== undefined) {
    if (!object(input.input)) throw new Error('A produced job input is an object.');
    value.input = input.input;
  }
  for (const field of ['outcome', 'label']) if (input[field] !== undefined) value[field] = words(input[field], field, rules.limits.words_chars);
  if (input.obligations !== undefined) value.obligations = obligationsOf(input.obligations, rules);
  if (input.acceptance !== undefined) value.acceptance = acceptanceOf(input.acceptance, value, rules);
  return { id: `${rules.job_kind}:${input.key}`, type: rules.job_kind, value, expected: null };
}

// A distinct descriptor grants only the saved target's exact kind/id, intersected with the caller's authority by the
// engine. It uses the same move, ownership, attempt fence and CAS as every other action; it is not another lifecycle.
export const finishAJob = ({ input = {}, task = {} } = {}, context) => moveAJob({ input: { ...input, action: 'finish' }, task }, context);

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
      const key = writeKey(task, record.id, 'take');
      if (takeReplay(record.value, key) || moveFor(record.value, 'take', as, now, rules).edge) candidates.push(record);
    }
  }
  // An already-held result of this exact request wins before newly arrived work. Otherwise a higher-priority
  // arrival could make the same logical take acquire a second job while its first claim is still held.
  const replayOf = record => {
    const key = writeKey(task, record.id, 'take');
    return Boolean(takeReplay(record.value, key));
  };
  const order = takeOrder(rules);
  candidates.sort((a, b) => Number(replayOf(b)) - Number(replayOf(a)) || order(a, b));
  let tried = 0;
  for (const { id, value } of candidates.slice(0, rules.take_tries)) {
    tried += 1;
    const answer = await moveRead(door, id, value, 'take', as, input, now, task, rules);
    if (answer.moved) return { taken: answer.job, tried };
    if (answer.replayed) return { taken: null, tried, job_id: id, reason: answer.reason, job: answer.job };
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
