// tools/plan-tasks-and-todo-lists/task-moves.mjs
//
// Doing a task: giving it, taking it, handing it on, finishing it. A task is one record of kind calendar-task, the same
// row every task list shows (task-moves.json names the kind). Whoever may do it is the task's `assignees`, a list of
// record ids of anyone: a person, an AI, a workflow, anything that has a record. Nothing here asks what kind of thing an
// id names; an empty list means anyone may take it. A handoff (person to AI to person, or any other way) is a change of
// assignees, the `hand-on` move, and nothing else.
//
// No store is reached from here: the caller reads the records this call needs from wherever the tasks live (the
// tasks, the records of whoever may be named, and any consumer a finish checks) and hands them in as `input.records`
// ([{ id, type, value }]). Each exported function is one Workshop row, run by tools/workflows/do-work/run-a-function.mjs
// as fn({ input, task }):
//
//   seeWhoCanTakeWork -> { who: [{ id, type, value, live, seen_at, busy }] }        everyone handed in, live first
//   giveATask         -> { task_id, status: 'written' | 'already-there', task, keep? }  a new waiting task, once per key
//   seeTasks          -> { tasks: [task], more }                                     one task, or the newest that match
//   takeATask         -> { taken: task | null, tried, task_id?, reason?, task?, keep? } the first it may take, or one named
//   changeATask       -> { task_id, moved, from, to, reason?, task, keep? }          finish, fail, release, hand-on ... remove
//
// `keep` is the list of writes the caller must apply to its store, in order: [{ id, type, value, expected }], where
// expected is the record as it was read (null when the record must not exist) and a null value removes the record. The
// caller applies them in one transaction on its own store. A write whose expected value no longer holds is refused whole
// there, and the caller reads again and decides again: of two callers that read the same waiting task and both answer a
// take, the first applied wins and the second is refused whole and changes nothing. Nothing here locks, waits or keeps
// anything between runs.
//
// THE RULES ARE DATA. Which status a task may move to, on which action, for whom and after how long (the stale-take
// time) are rows of task-moves.json, checked by the shared stage engine (tools/move-records-through-declared-states:
// statesByKey, transitionsFrom, conditionHolds). A task's status is its one current state; its earlier states are the
// record's own version history in the caller's store, so no second copy of them is kept in the value.
import { readFileSync } from 'node:fs';
import { conditionHolds, statesByKey, transitionsFrom } from '../move-records-through-declared-states/do-work/move-records-through-declared-states.mjs';
import { makeHashCodeHexFromJson } from '../content-identity/read-data/identity.mjs';
import { makeJudge, ruleApplies, TEST_NAMES, valuesAt } from '../judge-words/do-work/judge-words.mjs';


const RULES = JSON.parse(readFileSync(new URL('./task-moves.json', import.meta.url), 'utf8'));
const CHANGED = 'original_command_conflict';
const REMOVE = 'remove';
const KEY = /^[A-Za-z0-9._:-]+$/;

// The rules, checked once: every state declared once, every transition between declared states and none out of a
// terminal one (the stage engine throws), every action named, every field source one this file knows.
export function taskRules(rules = RULES) {
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
      if (!['as', 'now', 'input', 'note', 'job'].includes(source?.from)) throw new Error(`${edge.action} sets ${field} from "${source?.from}", which is not as, now, input or note (or the current task).`);
      if (['input', 'note'].includes(source.from) && typeof source.field !== 'string') throw new Error(`${edge.action} sets ${field} from ${source.from} without naming its field.`);
    }
  }
  if (!rules.priorities.includes(rules.default_priority)) throw new Error(`The default priority "${rules.default_priority}" is not one of the priorities.`);
  return { ...rules, read_as: readAs, states, transitions, actions: [...new Set(transitions.map(edge => edge.action)), REMOVE] };
}

const RULED = taskRules();

// The declared state a stored status word means: itself, or what `read_as` maps it to.
export const stateOf = (status, rules = RULED) => rules.read_as[status] ?? status;
// Every stored word that means a declared state, so a listing by state finds the tasks written with either.
const wordsFor = (state, rules) => [state, ...Object.keys(rules.read_as).filter(word => rules.read_as[word] === state)];

function words(value, name, most) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be words.`);
  if (value.length > most) throw new Error(`${name} is ${value.length} characters; at most ${most}.`);
  return value;
}

// What a task asks for, as words: its outcome, else its description when that is words, else its title. This is the
// one place that reads it.
const isWords = value => typeof value === 'string' && value.trim() !== '';
export const requestedOutcome = task => [task.outcome, task.description, task.title].find(isWords);

// Whoever is named is named by their record's id, in whatever form the store gives it: nothing here reads its kind.
function recordId(value, name, rules) {
  words(value, name, rules.limits.id_chars);
  return value;
}

function taskId(value, rules) {
  words(value, 'id', rules.limits.id_chars);
  return value;
}

// A list of record ids, each once; empty means anyone may take the task.
function assigneesOf(value, rules) {
  if (!Array.isArray(value) || value.length > rules.most_assignees) throw new Error(`assignees must be a list of up to ${rules.most_assignees} record ids (empty: anyone).`);
  const seen = new Set();
  for (const id of value) {
    recordId(id, 'assignee', rules);
    if (seen.has(id)) throw new Error(`${id} is named twice in assignees.`);
    seen.add(id);
  }
  return value;
}

function priorityOf(value, rules) {
  if (!rules.priorities.includes(value)) throw new Error(`priority must be one of ${rules.priorities.join(', ')}.`);
  return value;
}

// Each named id must be a record the caller handed in, whatever kind it is.
function named(store, ids, name) {
  for (const id of ids) if (!store.has(id)) throw new Error(`${id} is not among the records handed in; ${name} names someone (or something) the store holds.`);
}

const nowOf = context => (context.now ? context.now() : new Date());
const shown = (id, value) => (value ? { id, ...value } : null);
const isChanged = error => error?.code === CHANGED;
const conflict = () => Object.assign(new Error('The record changed since it was read; the caller reads again and decides again.'), { code: CHANGED });
const MOST_RECORDS = 20000;

// The records the caller read, as this one call sees them. A write is proposed onto this snapshot, so later reads in the
// same call see it, and is answered in `keep` for the caller to apply conditioned on the value it was read at.
export function snapshotOf(records = []) {
  if (!Array.isArray(records) || records.length > MOST_RECORDS) throw new Error(`records must be a list of up to ${MOST_RECORDS} { id, type, value } records the caller read.`);
  const held = new Map();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || typeof record.type !== 'string' || held.has(record.id)) throw new Error('Each record needs a unique id and a type.');
    held.set(record.id, { id: record.id, type: record.type, value: record.value ?? null });
  }
  const keep = [];
  return {
    keep,
    // The value of the record `id` of `type`, or null.
    find(type, id) {
      const record = held.get(id);
      return record && record.type === type ? record.value : null;
    },
    // Whether a record `id` of any type was handed in.
    has: id => held.get(id)?.value != null,
    // Records of `type` (any type when absent, every type but `not`) whose value holds every `where` field equal.
    select({ type, not, where = {} } = {}) {
      const found = [];
      for (const record of held.values()) {
        if (type !== undefined && record.type !== type) continue;
        if (not !== undefined && record.type === not) continue;
        if (!Object.entries(where).every(([field, want]) => record.value?.[field] === want)) continue;
        found.push({ id: record.id, type: record.type, value: record.value });
      }
      return found;
    },
    // Each write, if the record is still as `expected` says (null: absent). A null value removes the record.
    propose(writes) {
      for (const { id, type, value, expected } of writes) {
        const current = held.get(id) ?? null;
        if (expected === null || expected === undefined) { if (current) throw conflict(); }
        else if (!current || current.type !== expected.type || makeHashCodeHexFromJson(current.value) !== makeHashCodeHexFromJson(expected.value)) throw conflict();
        if (value === null) held.delete(id);
        else held.set(id, { id, type, value });
        keep.push({ id, type, value, expected: expected ?? null });
      }
    },
  };
}

// Each exported row runs over the records its input carries, and answers the writes it proposed as `keep`.
const served = run => async (args = {}, context = {}) => {
  const store = snapshotOf(args.input?.records);
  // Only the clock and the snapshot are passed on: the context's own getters (the run's parent actions) are not read here.
  const answer = await run(args, { now: context.now, store });
  return store.keep.length ? { ...answer, keep: [...store.keep] } : answer;
};

const assigned = task => (Array.isArray(task.assignees) ? task.assignees : []);

// What the conditions of the rules are judged on, for one caller and one task at one time.
export function signalsOf(task, as, now, rules = RULED) {
  const signals = {
    is_taker: task.taken_by === as,
    is_sender: task.sent_by === as,
    is_assignee: assigned(task).includes(as),
    addressed_to_me: assigned(task).length === 0 || assigned(task).includes(as),
    terminal: rules.states.get(stateOf(task.status, rules))?.terminal === true,
    is_continuation_owner: task.continuation?.owner === as,
    is_releaser: task.released?.by === as,
    resume_due: !task.continuation || Date.parse(task.continuation.after) <= now.getTime(),
  };
  const taken = Date.parse(task.taken_at ?? '');
  if (Number.isFinite(taken)) signals.taken_minutes = (now.getTime() - taken) / 60000;
  return signals;
}

// The declared move of `action` from the task's status that holds for this caller now, or why there is none.
export function moveFor(task, action, as, now, rules = RULED) {
  if (!rules.actions.includes(action)) throw new Error(`action must be one of ${rules.actions.join(', ')}.`);
  const signals = signalsOf(task, as, now, rules);
  if (action === REMOVE) {
    return conditionHolds(rules.remove_when, signals) ? { edge: null } : { refused: `${as} may not remove a task that is ${task.status}: only whoever gave it may, or anyone once it is finished.` };
  }
  const status = stateOf(task.status, rules);
  const edges = rules.transitions.filter(edge => edge.action === action && edge.from === status);
  if (!edges.length) return { refused: `A task that is ${task.status} cannot be given "${action}".` };
  const edge = edges.find(one => conditionHolds(one.when, signals));
  if (!edge) {
    const who = [task.taken_by && `taken by ${task.taken_by}`, task.sent_by && `given by ${task.sent_by}`, assigned(task).length && `assigned to ${assigned(task).join(', ')}`].filter(Boolean).join(', ');
    return { refused: `The rule for "${action}" on a task that is ${task.status} does not hold for ${as} (the task is ${who || 'open to anyone'}).` };
  }
  return { edge };
}

// The whole task after a move: the declared fields cleared, then set, and the status the move goes to.
export function movedTask(task, edge, as, input, now, rules = RULED) {
  if (edge.needs_any && !edge.needs_any.some(field => Object.hasOwn(input, field))) throw new Error(`"${edge.action}" needs one of ${edge.needs_any.join(', ')}.`);
  const next = { ...task };
  for (const field of edge.clear ?? []) delete next[field];
  for (const [field, source] of Object.entries(edge.set ?? {})) {
    const given = source.field === undefined ? undefined : input[source.field];
    if (given === undefined || (given === null && !source.nullable)) {
      if (source.required) throw new Error(`"${edge.action}" needs ${source.field}.`);
      if (source.from === 'input') continue;
    } else {
      if (source.format === 'check') checkOutcome(given, task, now, rules);
      else if (source.format === 'continuation') checkContinuation(given, now, rules);
      else if (source.format === 'source') sourceOf(given, rules);
      else if (source.format === 'obligations') obligationsOf(given, rules);
      else if (source.format === 'assignees') assigneesOf(given, rules);
      else if (source.format === 'priority') priorityOf(given, rules);
      else if (source.format === 'acceptance') { /* judged below against the task as this edge saves it */ }
      else words(given, source.field, source.most_chars ?? rules.limits.words_chars);
      if (source.preserve_existing && task[field] != null && makeHashCodeHexFromJson(task[field]) !== makeHashCodeHexFromJson(given)) {
        throw new Error(`"${edge.action}" cannot replace the saved ${field}.`);
      }
    }
    if (source.from === 'as') next[field] = as;
    else if (source.from === 'now') next[field] = now.toISOString();
    else if (source.from === 'job') next[field] = task[source.field];
    else if (source.from === 'input') next[field] = given;
    else next[field] = { by: as, at: now.toISOString(), words: given ?? null };
  }
  // A move that leaves the task in the state it is in keeps the word it was stored with; any other writes the state.
  if (stateOf(task.status, rules) !== edge.to) next.status = edge.to;
  // An acceptance binds the task as it is saved: an outcome or obligation only in this call's input is not saved by this edge.
  for (const [field, source] of Object.entries(edge.set ?? {})) {
    if (source.format === 'acceptance' && input[source.field] != null) acceptanceOf(next[field], next, rules);
  }
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
function acceptanceOf(value, task, rules) {
  if (!object(value) || value.outcome !== requestedOutcome(task) || !object(value.target)) throw new Error('acceptance must bind the saved outcome to an actual record target and checks.');
  words(value.target.type, 'acceptance.target.type', rules.limits.id_chars);
  words(value.target.id, 'acceptance.target.id', rules.limits.id_chars);
  const expected = new Set(['outcome', ...(task.obligations ?? []).map(part => part.id)]);
  if (!Array.isArray(value.rules) || value.rules.length !== expected.size) throw new Error('acceptance.rules must check the outcome and each obligation.');
  for (const rule of value.rules) {
    if (!object(rule) || !expected.delete(rule.id) || typeof rule.path !== 'string' || rule.ask || rule.at_most || rule.kinds || rule.when || !TEST_NAMES.some(name => rule[name] !== undefined && rule[name] !== false)) throw new Error('Each acceptance rule must directly check its saved part against consumer data.');
    makeJudge([rule]);
  }
  return value;
}

// A rule whose path selects nothing on its target could never hold at finish; the plan names the fields the target has.
async function acceptancePathsResolve(store, acceptance) {
  const observed = await store.find(acceptance.target.type, acceptance.target.id);
  if (observed === null || observed === undefined) return;
  const silent = acceptance.rules.filter(rule => !valuesAt(observed, rule.path).length);
  if (!silent.length) return;
  const fields = object(observed) ? Object.keys(observed) : [];
  throw new Error(`acceptance rule path ${silent.map(rule => `"${rule.path}"`).join(', ')} selects nothing on ${acceptance.target.type} ${acceptance.target.id}; its fields are ${fields.join(', ') || '(none)'}.`);
}

async function checkedConsumer(store, task, input, now, rules) {
  if (!task.acceptance) throw new Error('This task has no saved acceptance to finish against. Whoever took it saves one with action plan (the plan move with an acceptance: the outcome as the task asks for it, the record that shows it, and the rules that record must meet), then finishes.');
  const acceptance = acceptanceOf(task.acceptance, task, rules);
  if (makeHashCodeHexFromJson(input.check?.target ?? null) !== makeHashCodeHexFromJson(acceptance.target)) throw new Error('check.target must be the saved acceptance target; use tool:finish-a-task for its scoped read.');
  const observed = await store.find(acceptance.target.type, acceptance.target.id);
  if (observed === null || observed === undefined) throw new Error('The requested consumer record is unavailable; the task remains unfinished.');
  const item = { value: observed };
  if (!acceptance.rules.every(rule => ruleApplies(rule, item))) throw new Error('Every saved acceptance rule must apply to the observed consumer.');
  const findings = makeJudge(acceptance.rules)([item]);
  if (findings.length) throw new Error(`The requested outcome is not checked: ${JSON.stringify(findings)}`);
  return { ...input.check, checked_at: now.toISOString(), consumer: { ...acceptance.target, identity: makeHashCodeHexFromJson(observed) }, acceptance_identity: makeHashCodeHexFromJson(acceptance), taken_at: task.taken_at };
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

// This contract preserves an accountable observation, not a semantic oracle. Whoever finishes must actually inspect
// the requested consumer; a path, commit, exit code or an asserted observation is not independently verified here.
export function checkOutcome(check, task, now, rules = RULED) {
  if (!object(check)) throw new Error('finish needs check: the requested outcome, checked_at and observed consumer evidence.');
  if (check.outcome !== requestedOutcome(task)) throw new Error('check.outcome must match the task\'s saved requested outcome.');
  const checked = timestamp(check.checked_at, 'check.checked_at');
  if (checked > now.getTime() || checked < Date.parse(task.taken_at ?? task.sent_at ?? '')) throw new Error('check.checked_at must be during this take, not before it or in the future.');
  evidenceOf(check.evidence, 'check', rules);
  const obligations = task.obligations ?? [];
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
  recordId(value.owner, 'continuation.owner', rules);
  words(value.action, 'continuation.action', rules.limits.words_chars);
  words(value.reason, 'continuation.reason', rules.limits.words_chars);
  const after = timestamp(value.after, 'continuation.after');
  if (after < now.getTime() || after > now.getTime() + rules.completion.max_resume_minutes * 60000) throw new Error(`continuation.after must be now or within ${rules.completion.max_resume_minutes} minutes for owned review.`);
  return value;
}

const readTask = (store, id, rules) => store.find(rules.task_kind, id);

// One conditional write of the task's next value (null removes it). False when the task changed since it was read.
// The write is proposed onto this call's snapshot and answered in `keep`, conditioned on `before`: the caller applies
// it to the store, where a task that changed meanwhile refuses it whole.
async function writeIfUnchanged(store, id, before, after, rules) {
  try {
    store.propose([{ id, type: rules.task_kind, value: after, expected: { type: rules.task_kind, value: before } }]);
    return true;
  } catch (error) {
    if (isChanged(error)) return false;
    throw error;
  }
}

// The identity a move's replay receipt is matched on: the same request key names the same write.
// The records the caller reads for this call are not part of the request: a retry reads them again, and they may differ.
const withoutRecords = ({ records: _records, ...given }) => given;
const writeKey = (run, id, action) => (typeof run.request_key === 'string' && run.request_key ? `${run.request_key}:${action}:${id}` : undefined);
// Progress notes replace last_move, but do not replace the request that acquired the current claim. This receipt
// stays on that task through its release; the outer tool-run journal owns replay after a different claim or terminal
// state, so the next-task lookup never needs an unbounded history scan.
const takeReplay = (task, key) => key && (task.take_request?.key === key ? task.take_request : task.last_move?.key === key ? task.last_move : null);

async function moveRead(store, id, before, action, as, input, now, run, rules) {
  const key = writeKey(run, id, action);
  const signature = key ? makeHashCodeHexFromJson({ action, as, input: withoutRecords(input) }) : null;
  const replay = action === 'take' ? takeReplay(before, key) : key && before.last_move?.key === key ? before.last_move : null;
  const taken = rules.transitions.find(edge => edge.action === 'take').to;
  if (replay) {
    if (replay.signature !== signature) throw new Error('The same move request key cannot name different input.');
    if (action === 'take') {
      // A next-task candidate came from a listing that may already be stale. Replay ownership only from an exact
      // current read of the same claim, never from that earlier listing or from the store's own history.
      const current = await readTask(store, id, rules);
      const held = current && takeReplay(current, key);
      if (!held || !Number.isFinite(Date.parse(held.taken_at)) || stateOf(current.status, rules) !== taken || current.taken_by !== as || held.taken_at !== current.taken_at) {
        return { task_id: id, moved: false, from: replay.from, to: null, reason: current ? 'changed' : 'gone', task: shown(id, current), replayed: true };
      }
      return { task_id: id, moved: true, from: held.from, to: current.status, task: shown(id, current), replayed: true };
    }
    return { task_id: id, moved: true, from: replay.from, to: before.status, task: shown(id, before), replayed: true };
  }
  const { edge, refused } = moveFor(before, action, as, now, rules);
  if (refused) throw new Error(refused);
  if (rules.holder_actions.includes(action) && before.taken_by === as && input.taken_at !== before.taken_at) throw new Error('taken_at must name this exact current claim; an old run may not move a newer take.');
  if (action === 'wait' && stateOf(before.status, rules) === rules.start && before.released?.by === as && input.taken_at !== before.released_taken_at) throw new Error('taken_at must name the claim that released this task.');
  const after = edge ? movedTask(before, edge, as, input, now, rules) : null;
  if (action === 'edit' && after.acceptance) acceptanceOf(after.acceptance, after, rules);
  if (after && edge?.set?.acceptance && input.acceptance != null) await acceptancePathsResolve(store, after.acceptance);
  const checked = action === 'finish' ? await checkedConsumer(store, before, input, now, rules) : null;
  if (checked) after.check = checked;
  if (input.continuation) named(store, [input.continuation.owner], 'continuation.owner');
  if (edge?.set?.assignees && Array.isArray(input.assignees)) named(store, input.assignees, 'assignees');
  if (after && key) after.last_move = { key, signature, from: before.status };
  else if (after) delete after.last_move;
  if (after && action === 'take') {
    if (key) after.take_request = { key, signature, from: before.status, taken_at: after.taken_at };
    else delete after.take_request;
  }
  if (await writeIfUnchanged(store, id, before, after, rules)) {
    return { task_id: id, moved: true, from: before.status, to: after?.status ?? null, task: shown(id, after) };
  }
  const current = await readTask(store, id, rules);
  return { task_id: id, moved: false, from: before.status, to: null, reason: current ? 'changed' : 'gone', task: shown(id, current) };
}

// Every record the query names, at most `most` of them.
function listed(store, query, most) {
  return store.select(query).slice(0, most);
}

// Every task in one declared state, whichever stored word it was written with, at most `most` of them.
function listedIn(store, state, query, most, rules) {
  const found = [];
  for (const status of wordsFor(state, rules)) {
    if (found.length >= most) break;
    found.push(...listed(store, { ...query, type: rules.task_kind, where: { ...query.where, status } }, most - found.length));
  }
  return found;
}

async function seeWhoCanTakeWorkRun({ input = {} } = {}, context) {
  const rules = RULED;
  const { store } = context;
  const now = nowOf(context);
  const needs = input.can ?? [];
  if (!Array.isArray(needs) || needs.some(word => typeof word !== 'string' || !word)) throw new Error('can must be a list of words, such as ["code"].');
  const busy = new Map();
  const taken = rules.transitions.find(edge => edge.action === 'take').to;
  for (const task of listedIn(store, taken, {}, rules.most_tasks_read, rules)) {
    const taker = task.value?.taken_by;
    if (typeof taker === 'string') busy.set(taker, (busy.get(taker) ?? 0) + 1);
  }
  // Everyone handed in that is not a task, whatever kind of record it is. Each whole stored value comes back as it is:
  // what a screen or a command names it by is worked out from those cells by its own formula. Only liveness
  // and busyness are added.
  const who = listed(store, { not: rules.task_kind }, rules.most_people_read).map(({ id, type, value }) => {
    const held = value ?? {};
    const seen = Date.parse(held.live?.seen_at ?? '');
    const minutes = typeof held.live?.minutes === 'number' ? held.live.minutes : rules.live_minutes_default;
    return {
      id, type, value: held,
      live: Number.isFinite(seen) && now.getTime() - seen <= minutes * 60000,
      seen_at: Number.isFinite(seen) ? new Date(seen).toISOString() : null,
      busy: busy.get(id) ?? 0,
    };
  }).filter(one => {
    const can = Array.isArray(one.value.can) ? one.value.can : [];
    return needs.every(word => can.includes(word) || can.includes('any')) && (!input.live_only || one.live);
  });
  const order = one => (typeof one.value.order === 'number' ? one.value.order : Number.MAX_SAFE_INTEGER);
  who.sort((a, b) => Number(b.live) - Number(a.live) || order(a) - order(b) || (a.id < b.id ? -1 : 1));
  return { who };
}

// A new task's own fields, checked: the words, who may do it, and how urgent it is.
function newTask(input, sentBy, producer, now, rules) {
  const description = input.description === undefined ? undefined : words(input.description, 'description', rules.limits.description_chars);
  const title = input.title !== undefined ? words(input.title, 'title', rules.limits.title_chars)
    : description !== undefined ? description.trim().split('\n')[0].slice(0, rules.limits.title_chars) : undefined;
  if (title === undefined) throw new Error('A task needs a title or a description.');
  const value = { title, status: rules.start, assignees: assigneesOf(input.assignees ?? [], rules), sent_by: sentBy, priority: priorityOf(input.priority ?? rules.default_priority, rules), sent_at: now.toISOString() };
  if (description !== undefined) value.description = description;
  if (producer) { value.producer = producer; value.source = producer; }
  else if (input.source !== undefined) value.source = sourceOf(input.source, rules);
  if (input.outcome !== undefined) value.outcome = words(input.outcome, 'outcome', rules.limits.words_chars);
  if (input.obligations !== undefined) value.obligations = obligationsOf(input.obligations, rules);
  if (input.acceptance !== undefined) value.acceptance = acceptanceOf(input.acceptance, value, rules);
  return value;
}

const keyOf = (key, rules) => {
  if (typeof key !== 'string' || !KEY.test(key) || key.length > rules.limits.id_chars) {
    throw new Error('key must be letters, digits, dot, colon, dash or underscore: the same key gives the same task once.');
  }
  return key;
};
const newTaskId = (key, rules) => `record:${rules.task_kind}:${key}`;

async function giveATaskRun({ input = {}, task: run = {} } = {}, context) {
  const rules = RULED;
  const { store } = context;
  const now = nowOf(context);
  const sentBy = recordId(input.as, 'as', rules);
  const key = keyOf(input.key ?? run.request_key, rules);
  const value = newTask(input, sentBy, null, now, rules);
  named(store, value.assignees, 'assignees');
  const id = newTaskId(key, rules);
  // The condition of absence: a task already at this id is answered, not written again. The same task given again (same
  // key, same words, same assignees) is answered its receipt as written; a different task under the same key is already-there.
  const there = await readTask(store, id, rules);
  if (there) {
    const { sent_at: _was, ...was } = there;
    const { sent_at: _now, ...now_ } = value;
    const status = makeHashCodeHexFromJson(was) === makeHashCodeHexFromJson(now_) ? 'written' : 'already-there';
    return { task_id: id, status, task: shown(id, there) };
  }
  store.propose([{ id, type: rules.task_kind, value, expected: null }]);
  return { task_id: id, status: 'written', task: shown(id, value) };
}

// A task a hold, a workflow or a message makes keeps its actual origin: its source is the producer, and nobody is
// named as the giver. Its owner includes this absence-conditioned write in the same transaction as the source
// transition, and reuses the stable key.
export function prepareProducedTask(input, now = new Date()) {
  const rules = RULED;
  const key = keyOf(input.key, rules);
  const source = sourceOf(input.source, rules);
  const value = newTask(input, null, source, now, rules);
  if (input.source_task !== undefined) value.source_task = words(input.source_task, 'source_task', rules.limits.words_chars);
  if (input.input !== undefined) {
    if (!object(input.input)) throw new Error('A produced task input is an object.');
    value.input = input.input;
  }
  return { id: newTaskId(key, rules), type: rules.task_kind, value, expected: null };
}

async function seeTasksRun({ input = {} } = {}, context) {
  const rules = RULED;
  const { store } = context;
  if (input.id !== undefined) {
    const id = taskId(input.id, rules);
    const task = await readTask(store, id, rules);
    if (!task) throw new Error(`No task ${id} is among the records handed in.`);
    return { tasks: [shown(id, task)], more: false };
  }
  const where = {};
  let state;
  if (input.status !== undefined) {
    state = stateOf(input.status, rules);
    if (!rules.states.has(state)) throw new Error(`status must be one of ${[...rules.states.keys()].join(', ')}.`);
  }
  for (const field of ['sent_by', 'taken_by']) if (input[field] !== undefined) where[field] = recordId(input[field], field, rules);
  const assignee = input.assignee === undefined ? undefined : recordId(input.assignee, 'assignee', rules);
  const limit = input.limit ?? rules.tasks_shown.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > rules.tasks_shown.most) throw new Error(`limit must be a whole number from 1 to ${rules.tasks_shown.most}.`);
  const found = (state === undefined
    ? listed(store, { type: rules.task_kind, where }, rules.most_tasks_read)
    : listedIn(store, state, { where }, rules.most_tasks_read, rules))
    .filter(record => assignee === undefined || assigned(record.value ?? {}).includes(assignee));
  found.sort((a, b) => String(b.value?.sent_at ?? '').localeCompare(String(a.value?.sent_at ?? '')) || (a.id < b.id ? 1 : -1));
  return { tasks: found.slice(0, limit).map(record => shown(record.id, record.value)), more: found.length > limit };
}

// Compare two tasks by the declared take order: the task to take first sorts first. A row with `rank` sorts by the
// value's place in that list; a value not in it sorts last.
function takeOrder(rules) {
  const place = (row, value) => { const at = row.rank.indexOf(value); return at < 0 ? row.rank.length : at; };
  return (a, b) => {
    for (const row of rules.take_order) {
      const left = a.value[row.field] ?? row.missing;
      const right = b.value[row.field] ?? row.missing;
      if (left === right) continue;
      if (row.rank) { const by = place(row, left) - place(row, right); if (by) return by; continue; }
      const before = left < right ? -1 : 1;
      return row.direction === 'descending' ? -before : before;
    }
    return a.id < b.id ? -1 : 1;
  };
}

async function takeATaskRun({ input = {}, task: run = {} } = {}, context) {
  const rules = RULED;
  const { store } = context;
  const now = nowOf(context);
  const as = recordId(input.as, 'as', rules);
  if (input.id !== undefined) {
    const id = taskId(input.id, rules);
    const task = await readTask(store, id, rules);
    if (!task) throw new Error(`No task ${id} is among the records handed in.`);
    const answer = await moveRead(store, id, task, 'take', as, input, now, run, rules);
    return answer.moved
      ? { taken: answer.task, tried: 1 }
      : { taken: null, tried: 1, task_id: id, reason: answer.reason, task: answer.task };
  }
  // Every task a take may move: the statuses the take rows leave from, then only those whose rule holds for this caller.
  const candidates = [];
  for (const status of new Set(rules.transitions.filter(edge => edge.action === 'take').map(edge => edge.from))) {
    for (const record of listedIn(store, status, {}, rules.most_tasks_read, rules)) {
      if (!record.value || (input.only_mine && !assigned(record.value).includes(as))) continue;
      const key = writeKey(run, record.id, 'take');
      if (takeReplay(record.value, key) || moveFor(record.value, 'take', as, now, rules).edge) candidates.push(record);
    }
  }
  // An already-held result of this exact request wins before newly arrived work. Otherwise a higher-priority
  // arrival could make the same logical take acquire a second task while its first claim is still held.
  const replayOf = record => Boolean(takeReplay(record.value, writeKey(run, record.id, 'take')));
  const order = takeOrder(rules);
  candidates.sort((a, b) => Number(replayOf(b)) - Number(replayOf(a)) || order(a, b));
  let tried = 0;
  for (const { id, value } of candidates.slice(0, rules.take_tries)) {
    tried += 1;
    const answer = await moveRead(store, id, value, 'take', as, input, now, run, rules);
    if (answer.moved) return { taken: answer.task, tried };
    if (answer.replayed) return { taken: null, tried, task_id: id, reason: answer.reason, task: answer.task };
  }
  return { taken: null, tried };
}

async function changeATaskRun({ input = {}, task: run = {} } = {}, context) {
  const rules = RULED;
  const { store } = context;
  const now = nowOf(context);
  const as = recordId(input.as, 'as', rules);
  const id = taskId(input.id, rules);
  if (typeof input.action !== 'string') throw new Error(`action must be one of ${rules.actions.join(', ')}.`);
  const task = await readTask(store, id, rules);
  if (!task) throw new Error(`No task ${id} is among the records handed in.`);
  return moveRead(store, id, task, input.action, as, input, now, run, rules);
}

// A finish row is its own descriptor so it can grant only the saved target's exact kind/id, intersected with the
// caller's authority by the engine. It uses the same move, ownership, attempt fence and CAS as every other action.
export const seeWhoCanTakeWork = served(seeWhoCanTakeWorkRun);
export const giveATask = served(giveATaskRun);
export const seeTasks = served(seeTasksRun);
export const takeATask = served(takeATaskRun);
export const changeATask = served(changeATaskRun);
export const finishATask = ({ input = {}, task = {} } = {}, context) => changeATask({ input: { ...input, action: 'finish' }, task }, context);
