// tools/hold-one-thing-until-done/do-work/needs-you-hold-route.mjs
//
// PURPOSE
//   The page routes GET and POST /work/api/needs-you-hold as one Workshop route tool (the engine runs this row for the
//   page's account with { path, method, query, body, browser, stored } and answers the page with the result's { status,
//   body }). Old trillion answered them at the account's own records, screens:needsYouHold and
//   screens:changeNeedsYouHold (src/worker.mjs:1100-1121 over src/native-waiting-account-owner.mjs needsYouHold, tag
//   old-trillion-before-worker-retire), with the decisions this folder keeps (read-data/needs-you-hold.mjs, which that
//   owner imported from here).
//   The route reads no store and writes none: the person's records it works from come in as `stored.records` (each
//   { id, type, value }, the kinds the row's `stored` lists), and what it would keep comes back as `keep` (rows
//   { id, type, value, expected }: expected is the record as it was handed in, or null for a new one, so a store
//   refuses a row whose record moved), with the device tool runs it would start as `runs` (started only after every
//   `keep` row is written).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are read-data/needs-you-hold.mjs's, as old trillion called them: the read is holdView over the
//      person's waiting cards, their hold setting and their hold rules, answered with `said` and `words` the way old
//      needsYouHold filled them; a change is setAside, handBack, chooseStake, askOff or turnOn by the old `op` names
//      (aside, hand_back, stake, off, on), kept as the next setting with its jobs, and answered with the read after it.
//   2. Old statuses: a read that fails answers 503 { error: 'Busy for a moment. Try again.', busy: true }; a change that
//      fails answers 400 { error } (old threw it as an uncaught error, which a route tool cannot do and still answer the
//      page). Any other path or method is 404 { error: 'Not found' }. A failed request keeps and runs nothing.
//   3. Every record read is one read-data/hold-rows.json names (given in `stored.records`), or a `calendar-task` (the person's
//      AIs pick their tasks up there, tools/plan-tasks-and-todo-lists); the row's rights grant no more.
//   4. The hold setting is kept with `expected` set to what was read; a caller whose store refuses it answers 409 and
//      nothing is kept. A job is kept only while absent (expected null), under its `once_per`, so one is handed once.
//   5. Every read keeps what the hold holds now as the person's `setting:needs_you_held` ({ key, title }, or null when
//      nothing is held), kept only when it changed, as old keepHeld did, so every AI's turn can be told it cheaply.
//   6. `seen` marks read the notices the held thing's own device runs told (each `hold.devices.when_held` run whose
//      input `key` names the thing), on this page's surface, `from: 'thing'`, with the moved tell owner's markRead over
//      the person's told-the-person records, as old needsYouHold did.
//   7. The cards are what old trillion's Waiting on you reader answered, over what the route can read: each section's
//      cards kept once (sameOnce) and weighed by the doer gate (read-data/waiting-weigh.mjs over tools/who-does-each-step
//      and the old DATA), so a card Trillion can do, or one with nothing to press, is left out of the person's view;
//      then the walk-away nudge's prepareForHold (read-data/waiting-nudge.mjs) hands what it weighs to the AIs, once per
//      card, and the hold is weighed over the rest, as old needsYouHold did.
//   8. A new thing held, or nothing held any more, runs the person's device tools (`hold.devices` when_held / when_free)
//      once for that change: each is answered in `runs` with its key, and the caller starts it through its own run path.
//
// NOT HERE (each needs what is not a record; see README.md)
//   - Of old trillion's Waiting on you answer only the person's own rows (the asks section) are read: the other
//     sections' sources are not the person's records (see README.md), so the route is not a whole port yet.
//
import ROWS from '../read-data/hold-rows.json' with { type: 'json' };
import WAITING from '../read-data/waiting-on-you.json' with { type: 'json' };
import { askOff, chooseStake, handBack, heldInput, holdView, setAside, turnOn, withoutHanded } from '../read-data/needs-you-hold.mjs';
import { makeWaitingNudge } from '../read-data/waiting-nudge.mjs';
import { inOrder, sameOnce, weighCards } from '../read-data/waiting-weigh.mjs';
import { whoDoesEachStep } from '../../who-does-each-step/read-data/who-does.mjs';
import WHO from '../../shared-code/src/who-does-it.json' with { type: 'json' };
import { prepareProducedTask } from '../../plan-tasks-and-todo-lists/task-moves.mjs';
import { readWaitingOnMe } from '../../what-is-waiting-on-me/read-data/waiting-records.mjs';
import { waitingSentence } from '../../what-is-waiting-on-me/read-data/waiting.mjs';
import tellRows from '../../tell-one-person-something-through-every-way-they/read-data/tell-the-person.json' with { type: 'json' };
import { makeTellThePerson } from '../../tell-one-person-something-through-every-way-they/read-data/tell-the-person.mjs';
import { randomUUID } from 'node:crypto';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : '');
const settingValue = value => (object(value) && object(value.value) ? value.value : null);
const BUSY = { error: 'Busy for a moment. Try again.', busy: true };
const HELD = ROWS.held;
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const opensScreenOf = prefixes => (Array.isArray(prefixes) ? address => prefixes.some(prefix => address.startsWith(prefix)) : undefined);
const projectionOf = input => Object.fromEntries(['things', 'opens_screens', 'given', 'pages'].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
const TOLD = 'told-the-person';

// The person's records the caller handed in (`stored.records`), each checked to be { id, type, value }.
function recordsOf(input) {
  const records = input.stored?.records ?? [];
  if (!Array.isArray(records) || !records.every(record => object(record) && typeof record.id === 'string' && typeof record.type === 'string')) {
    throw new Error('stored.records must be the person\'s records, each { id, type, value }.');
  }
  return records;
}

// The handed-in records as a store answers them: one record by id, and a list by type.
function storeOf(records) {
  const byId = new Map(records.map(record => [record.id, record]));
  return { records, get: id => byId.get(id) ?? null, list: type => records.filter(record => record.type === type) };
}

// What this run keeps and starts, in the order it was made: a row once (by id), a run once (by key).
function ledger() {
  const keep = [];
  const runs = [];
  return {
    keep,
    runs,
    put(row) { if (!keep.some(item => item.id === row.id)) keep.push(row); },
    start(run) { if (!runs.some(item => item.key === run.key)) runs.push(run); },
  };
}

function readSetting(store, row) {
  const held = store.get(row.id);
  return { held, value: settingValue(held?.value) };
}

function rulesOf(store) {
  const { value } = readSetting(store, ROWS.rules);
  if (!value) throw new Error(`No hold rules: give them as ${ROWS.rules.id} in stored.records as { value: { ... } }.`);
  return value;
}

// The Waiting on you cards: the caller's full answer (`things`) when given, else the sources the handed-in records answer.
function cardsOf(store, input = {}) {
  if (input.things !== undefined) return input.things;
  return readWaitingOnMe({ stored: store.records, ...(input.pages !== undefined ? { pages: input.pages } : {}) });
}

// The doer gate (old src/who-does-it.mjs over src/who-does-it.json): who does each waiting thing.
const weigh = input => whoDoesEachStep({ ...WHO, ...input });
// The Waiting on you DATA under the person's own hold rules (old src/waiting-on-you.json, its `hold` the person's row).
const settingsOf = (rules, input = {}) => ({ ...WAITING, ...(input.things?.finishes ? { finishes: input.things.finishes } : {}), hold: { ...WAITING.hold, ...rules } });

/** What old trillion's Waiting on you reader answered, over what the route can read: each section's cards with the same
 *  thing said twice kept once (sameOnce), and every card the doer gate sends to the AIs left out of the person's view
 *  (old reader's `sift`, src/native-waiting-account-owner.mjs reader). */
function waitingAnswer(store, settings, input = {}) {
  const answer = cardsOf(store, input);
  if (!object(answer) || !Array.isArray(answer.sections)) throw new Error('things must be { sections: [{ id, cards: [...] }] }.');
  const opensScreen = opensScreenOf(input.opens_screens);
  const decided = weighCards(answer.sections.map(section => ({ section, cards: sameOnce(section.cards ?? []) })), {
    settings: answer.finishes ? { ...settings, finishes: answer.finishes } : settings, weigh, given: input.given ?? {}, ...(opensScreen ? { opensScreen } : {}),
  });
  return { ...answer, toAis: [...(answer.toAis ?? []), ...decided.toAis], sections: decided.rows.map(row => ({ ...row.section,
    total: row.cards.length === row.section.cards?.length ? row.section.total ?? row.cards.length : row.cards.length, cards: row.cards })) };
}

/** The page/AI feed shares this existing doer gate and actual AI-work publication with the hold. */
export function readWaitingFeed(input = {}, { store, made, rules, now = Date.now() } = {}) {
  const ownRules = rules ?? input.rules ?? readSetting(store, ROWS.rules).value ?? {};
  const answer = waitingAnswer(store, settingsOf(ownRules, input), input);
  for (const item of inOrder(answer.toAis)) if (item.handOff) handOff(store, made, item.handOff, now);
  const cards = answer.sections.flatMap(section => section.cards);
  return { ...answer, cards, count: cards.length, published: true,
    ...(answer.sources ? { said: waitingSentence(cards.length, answer.sources) } : {}) };
}

/** The read, as old needsYouHold answered op read: the view, what it says and the words. */
export async function read(store, now, rules, input = {}, made = ledger()) {
  const settings = rules ?? rulesOf(store);
  const state = input.state !== undefined ? input.state : readSetting(store, ROWS.state).value ?? {};
  const waiting = settingsOf(settings, input);
  const answer = readWaitingFeed(input, { store, made, rules: settings, now });
  if (answer.finishes) waiting.finishes = answer.finishes;
  // The doer gate's work must be kept before its cards leave the human view.
  const opensScreen = opensScreenOf(input.opens_screens);
  // The walk-away nudge's prepareForHold (old src/waiting-nudge.mjs): what waited long enough and Trillion can do is
  // handed to the AIs, once per card, and the hold is weighed over the rest.
  const nudge = makeWaitingNudge({ read: async () => answer, tell: async () => null, weigh, handOff: job => handOff(store, made, job, now),
    kept: { read: () => null, write: () => {} }, alongside: async () => null, settings: waiting, now: () => now, ...(opensScreen ? { opensScreen } : {}) });
  const prepared = await nudge.prepareForHold(answer, settings.after_minutes);
  let view = holdView(withoutHanded(answer, prepared.handed), state, settings, now, { opensScreen });
  if (input.covered) view = { ...view, held: null, ranked: [] };
  const waitingSources = input.things !== undefined ? { from: 'caller', complete: input.things.complete === true }
    : { from: 'configured-sources', ...answer.waiting_sources };
  // An incomplete empty read cannot prove that the persisted held thing or its device lock is free.
  if (view.held || view.on === false || waitingSources.complete === true) keepHeld(store, made, view.held, settings, now);
  const said = view.held ? fill(settings.words?.held, { title: view.held.card.title ?? '' })
    : view.on ? answer.complete === false ? answer.said : settings.words?.free : fill(settings.words?.off, view);
  return { ...view, said, words: settings.words, waiting_sources: waitingSources };
}

/** What the hold holds now, kept as setting:needs_you_held when it changed, and a new thing held, or nothing held any
 *  more, starts the person's own devices (`hold.devices`, the rules' `devices`) once for that change (old keepHeld). Each
 *  device is answered in `runs` with the input filled with the held thing; the caller starts it after the kept row. */
function keepHeld(store, made, held, rules, now) {
  const heldFact = held ? { key: held.key, title: held.card.title ?? '' } : null;
  const kept = store.get(HELD.id);
  const before = object(kept?.value) ? kept.value.value ?? null : null;
  if ((before?.key ?? null) === (heldFact?.key ?? null) && (before?.title ?? null) === (heldFact?.title ?? null)) return;
  // A repeated held/free cycle, or a deleted and recreated setting, is a new transition even when its values match
  // an old cycle. Keep its identity on this same setting; the kept row and its device runs share that exact identity.
  const transition = makeHashCodeHexFromJson({ record: HELD.id, before: kept?.value ?? null, after: heldFact, nonce: randomUUID() });
  const value = { ...(object(kept?.value) ? kept.value : {}), value: heldFact, held_transition: transition };
  made.put({ id: HELD.id, type: HELD.type, value, expected: kept ? { type: HELD.type, value: kept.value } : null });
  const runs = heldFact ? rules.devices?.when_held ?? [] : before ? rules.devices?.when_free ?? [] : [];
  for (const run of runs) {
    made.start({ tool_id: run.tool_id, input: heldInput(run.input, heldFact),
      key: `native-hold-devices:${run.tool_id}:${heldFact?.key ?? 'free'}:${transition}` });
  }
}

/** The person's kept notices as the moved tell owner's store reads and writes them (tools/tell-the-person's layout):
 *  the writes it makes come back as rows with their expected record. */
function noticesOf(store) {
  const held = new Map(store.list(TOLD).map(record => [record.id, record]));
  const head = held.get(TOLD)?.value ?? {};
  const legacy = Array.isArray(head.items);
  let notices = legacy ? head.items : (head.seqs ?? []).map(seq => held.get(`${TOLD}:${seq}`)?.value?.item).filter(Boolean);
  const writes = [];
  return {
    store: {
      choices: () => null,
      notices: () => notices,
      putNotices: list => {
        if (legacy) writes.splice(0, writes.length, { id: TOLD, type: TOLD, value: { ...head, items: list }, expected: { type: TOLD, value: held.get(TOLD).value } });
        else for (const item of list) {
          const record = held.get(`${TOLD}:${item.seq}`);
          if (!record || JSON.stringify(record.value?.item) === JSON.stringify(item)) continue;
          const at = writes.findIndex(write => write.id === record.id);
          const write = { id: record.id, type: TOLD, value: { ...record.value, item }, expected: { type: TOLD, value: record.value } };
          if (at >= 0) writes[at] = write; else writes.push(write);
        }
        notices = list;
      },
    },
    writes,
  };
}

/** seen: the notices the held thing's device runs told, marked read on this page's surface (old needsYouHold). */
function seen(store, made, body, now) {
  const key = text(body.key);
  if (!key) return { seen: null, read: [] };
  const rules = rulesOf(store);
  const keys = (rules.devices?.when_held ?? []).map(run => heldInput(run.input, { key, title: '' })?.key)
    .filter((notice, index) => typeof notice === 'string' && notice !== rules.devices.when_held[index].input?.key);
  if (!keys.length) return { seen: key, read: [] };
  const kept = noticesOf(store);
  const tell = makeTellThePerson({ rows: tellRows, store: kept.store, senders: {}, now: () => new Date(now) });
  const on = { here: true, ...(text(body.device_id) ? { device_id: text(body.device_id) } : {}), from: 'thing' };
  const read = keys.map(notice => tell.markRead({ key: notice, on }));
  for (const row of kept.writes) made.put(row);
  return { seen: key, read };
}

/** A hold task is kept once: a task already among the records handed in is left as it is (and must name the same source). */
function holdJobRows(store, jobs, now) {
  const rows = [];
  for (const job of jobs) {
    if (!job.job?.trim()) continue;
    if (typeof job.once_per !== 'string' || !job.once_per) throw new Error('A hold task needs its stable once_per source.');
    const source = { kind: 'record', ref: job.input?.card_id ?? ROWS.state.id };
    const record = prepareProducedTask({ key: `hold-${makeHashCodeHexFromJson({ source, source_job: job.once_per })}`, description: job.job,
      source, source_task: job.once_per, ...(object(job.input) ? { input: job.input } : {}),
      ...(job.said ? { title: job.said } : {}) }, new Date(now));
    const before = store.get(record.id);
    if (before) {
      if (JSON.stringify(before.value?.producer) !== JSON.stringify(record.value.producer) || before.value?.source_task !== job.once_per) throw new Error('A hold task key names a different source.');
      continue;
    }
    rows.push({ ...record, expected: null });
  }
  return rows;
}

function handOff(store, made, job, now) {
  for (const row of holdJobRows(store, [job], now)) made.put(row);
}

const HOLD_CHANGES = {
  'set-aside': (state, rules, input, now) => setAside(state, rules, input, now),
  'hand-back': (state, rules, input, now) => handBack(state, rules, input, now),
  'choose-stake': (state, rules, input, now) => chooseStake(state, rules, input, now),
  'turn-off': (state, rules, input, now) => askOff(state, rules, now),
  'turn-on': state => turnOn(state),
};

/** One change of the hold setting, kept with its jobs: the setting is conditioned on the setting just read. */
function changeWhatHoldsMe(input, store, made) {
  const operation = HOLD_CHANGES[input.change];
  const now = Date.parse(input.now);
  const rules = rulesOf(store);
  const { held, value } = readSetting(store, ROWS.state);
  if (held && !object(held.value)) throw new Error(`${ROWS.state.id} is not an object: give it as { value: { ... } } before changing the hold.`);
  const { state, jobs = [], ...rest } = operation(value ?? {}, rules, input, now);
  // JSON keeps no undefined: the state kept is the state the next read sees.
  const next = JSON.parse(JSON.stringify(state));
  made.put({ id: ROWS.state.id, type: ROWS.state.type, value: { ...(object(held?.value) ? held.value : {}), value: next },
    expected: held ? { type: ROWS.state.type, value: held.value } : null });
  for (const row of holdJobRows(store, jobs, now)) made.put(row);
  return { answer: rest, state: next };
}

const CHANGES = { aside: 'set-aside', hand_back: 'hand-back', stake: 'choose-stake', off: 'turn-off', on: 'turn-on' };

async function change(store, made, body, now, input = {}) {
  if (body?.op === 'seen') return seen(store, made, body, now);
  if (!body?.op || body.op === 'read') return read(store, now, undefined, projectionOf({ ...input, ...body }), made);
  const operation = CHANGES[body.op];
  if (!operation) throw new Error('Say what to do: read, aside, hand_back, stake, off or on.');
  const fields = Object.fromEntries(['key', 'title', 'reason', 'way', 'stake', 'values'].filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  const { answer, state } = changeWhatHoldsMe({ ...fields, change: operation, now: new Date(now).toISOString() }, store, made);
  // The read after the change is over the setting the change keeps, which the store does not hold yet.
  return { ...answer, ...(await read(store, now, undefined, { ...projectionOf({ ...input, ...body }), state }, made)) };
}

/** tool:answer-the-needs-you-hold-route */
export async function answerNeedsYouHoldRoute(input = {}, { now = () => Date.now() } = {}) {
  const path = String(input?.path ?? '');
  const method = String(input?.method ?? 'GET').toUpperCase();
  if (path !== '/needs-you-hold' || !['GET', 'POST'].includes(method)) return { status: 404, body: { error: 'Not found' } };
  let records;
  try { records = recordsOf(input); }
  catch (error) { return { status: 400, body: { error: error.message } }; }
  const store = storeOf(records);
  const made = ledger();
  if (method === 'GET') {
    try { return { status: 200, body: await read(store, now(), undefined, projectionOf(input), made), keep: made.keep, runs: made.runs }; }
    catch { return { status: 503, body: BUSY }; }
  }
  try {
    const body = typeof input.body === 'string' ? JSON.parse(input.body || '{}') : object(input.body) ? input.body : {};
    return { status: 200, body: await change(store, made, body, now(), input), keep: made.keep, runs: made.runs };
  } catch (error) {
    return { status: 400, body: { error: error.message } };
  }
}
