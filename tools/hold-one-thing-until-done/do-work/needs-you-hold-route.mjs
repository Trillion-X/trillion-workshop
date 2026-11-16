// tools/hold-one-thing-until-done/do-work/needs-you-hold-route.mjs
//
// PURPOSE
//   The page routes GET and POST /work/api/needs-you-hold as one Workshop route tool (the engine's `@workshop-routes`
//   family runs this row for the page's account with { path, method, query, body, browser } and answers the page with
//   the result's { status, body }). Old trillion answered them at the account's own records, screens:needsYouHold and
//   screens:changeNeedsYouHold (src/worker.mjs:1100-1121 over src/native-waiting-account-owner.mjs needsYouHold, tag
//   old-trillion-before-worker-retire), with the decisions this folder keeps (read-data/needs-you-hold.mjs, which that
//   owner imported from here).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are read-data/needs-you-hold.mjs's, as old trillion called them: the read is holdView over the
//      person's waiting cards, their hold setting and their hold rules, answered with `said` and `words` the way old
//      needsYouHold filled them; a change is setAside, handBack, chooseStake, askOff or turnOn by the old `op` names
//      (aside, hand_back, stake, off, on), written, its jobs handed, and answered with the read after it.
//   2. Old statuses: a read that fails for any reason but a refusal answers 503 { error: 'Busy for a moment. Try
//      again.', busy: true }; a refusal with its own status keeps it; a change that fails answers 400 { error } (old
//      threw it as an uncaught error, which a route tool cannot do and still answer the page). Any other path or method
//      is 404 { error: 'Not found' }.
//   3. Every record read or written is one read-data/hold-rows.json names, or an `ai-job` (the person's AIs pick their
//      jobs up there, tools/hand-work-to-ais); the row's rights grant no more.
//   4. The hold setting is written with `expected` set to what was read; one changed meanwhile answers 409 { error }
//      and nothing is written. A job is written only while absent, under its `once_per`, so one is handed once.
//   5. Every read keeps what the hold holds now as the person's `setting:needs_you_held` ({ key, title }, or null when
//      nothing is held), written only when it changed, as old keepHeld did, so every AI's turn can be told it cheaply.
//   6. `seen` marks read the notices the held thing's own device runs told (each `hold.devices.when_held` run whose
//      input `key` names the thing), on this page's surface, `from: 'thing'`, with the moved tell owner's markRead over
//      the person's told-the-person records, as old needsYouHold did.
//
//   7. The cards are what old trillion's Waiting on you reader answered, over what the route can read: each section's
//      cards kept once (sameOnce) and weighed by the doer gate (read-data/waiting-weigh.mjs over tools/who-does-each-step
//      and the old DATA), so a card Trillion can do, or one with nothing to press, is left out of the person's view;
//      then the walk-away nudge's prepareForHold (read-data/waiting-nudge.mjs) hands what it weighs to the AIs, once per
//      card, and the hold is weighed over the rest, as old needsYouHold did.
//   8. A new thing held, or nothing held any more, starts the person's device tools (`hold.devices` when_held /
//      when_free) once for that change, through the run's door (`runs` on the row); one that fails is let go.
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
import { prepareProducedJob } from '../../hand-work-to-ais/read-data/ai-work.mjs';
import { readWaitingOnMe } from '../../what-is-waiting-on-me/read-data/waiting-records.mjs';
import { waitingSentence } from '../../what-is-waiting-on-me/read-data/waiting.mjs';
import tellRows from '../../tell-one-person-something-through-every-way-they/read-data/tell-the-person.json' with { type: 'json' };
import { makeTellThePerson } from '../../tell-one-person-something-through-every-way-they/read-data/tell-the-person.mjs';
import { randomUUID } from 'node:crypto';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : '');
const settingValue = value => (object(value) && object(value.value) ? value.value : null);
const CONFLICT = 'original_command_conflict';
const BUSY = { error: 'Busy for a moment. Try again.', busy: true };
const HELD = ROWS.held;
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const opensScreenOf = prefixes => (Array.isArray(prefixes) ? address => prefixes.some(prefix => address.startsWith(prefix)) : undefined);
const projectionOf = input => Object.fromEntries(['things', 'opens_screens', 'given'].filter(key => input[key] !== undefined).map(key => [key, input[key]]));
const TOLD = 'told-the-person';
const refusalStatus = error => (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : null);

class Refused extends Error { constructor(message, status) { super(message); this.status = status; } }

async function readSetting(door, row) {
  const held = await door.readRecord(row.type, row.id);
  return { held, value: settingValue(held?.value) };
}

async function rulesOf(door) {
  const { value } = await readSetting(door, ROWS.rules);
  if (!value) throw new Error(`No hold rules: write them to ${ROWS.rules.id} as { value: { ... } }.`);
  return value;
}

async function cardsOf(door, input = {}) {
  if (input.things !== undefined) return input.things;
  return readWaitingOnMe({}, { door });
}

// The doer gate (old src/who-does-it.mjs over src/who-does-it.json): who does each waiting thing.
const weigh = input => whoDoesEachStep({ ...WHO, ...input });
// The Waiting on you DATA under the person's own hold rules (old src/waiting-on-you.json, its `hold` the person's row).
const settingsOf = (rules, input = {}) => ({ ...WAITING, ...(input.things?.finishes ? { finishes: input.things.finishes } : {}), hold: { ...WAITING.hold, ...rules } });

/** What old trillion's Waiting on you reader answered, over what the route can read (the person's Waiting on you rows):
 *  each section's cards with the same thing said twice kept once (sameOnce), and every card the doer gate sends to the
 *  AIs left out of the person's view (old reader's `sift`, src/native-waiting-account-owner.mjs reader). */
async function waitingAnswer(door, settings, input = {}) {
  const answer = await cardsOf(door, input);
  if (!object(answer) || !Array.isArray(answer.sections)) throw new Error('things must be { sections: [{ id, cards: [...] }] }.');
  const opensScreen = opensScreenOf(input.opens_screens);
  const decided = weighCards(answer.sections.map(section => ({ section, cards: sameOnce(section.cards ?? []) })), {
    settings: answer.finishes ? { ...settings, finishes: answer.finishes } : settings, weigh, given: input.given ?? {}, ...(opensScreen ? { opensScreen } : {}),
  });
  return { ...answer, toAis: [...(answer.toAis ?? []), ...decided.toAis], sections: decided.rows.map(row => ({ ...row.section,
    total: row.cards.length === row.section.cards?.length ? row.section.total ?? row.cards.length : row.cards.length, cards: row.cards })) };
}

/** The page/AI feed shares this existing doer gate and actual AI-work publication with the hold. */
export async function readWaitingFeed(input = {}, { door, rules, now = Date.now() } = {}) {
  const ownRules = rules ?? input.rules ?? (await readSetting(door, ROWS.rules)).value ?? {};
  const answer = await waitingAnswer(door, settingsOf(ownRules, input), input);
  for (const item of inOrder(answer.toAis)) if (item.handOff) await handOff(door, item.handOff, now);
  const cards = answer.sections.flatMap(section => section.cards);
  return { ...answer, cards, count: cards.length, published: true,
    ...(answer.sources ? { said: waitingSentence(cards.length, answer.sources) } : {}) };
}

/** The read, as old needsYouHold answered op read: the view, what it says and the words. */
export async function read(door, now, rules, input = {}) {
  const settings = rules ?? await rulesOf(door);
  const state = input.state !== undefined ? input.state : (await readSetting(door, ROWS.state)).value ?? {};
  const waiting = settingsOf(settings, input);
  const answer = await readWaitingFeed(input, { door, rules: settings, now });
  if (answer.finishes) waiting.finishes = answer.finishes;
  // The doer gate's work must be published before its cards leave the human view.
  const opensScreen = opensScreenOf(input.opens_screens);
  // The walk-away nudge's prepareForHold (old src/waiting-nudge.mjs): what waited long enough and Trillion can do is
  // handed to the AIs, once per card, and the hold is weighed over the rest.
  const nudge = makeWaitingNudge({ read: async () => answer, tell: async () => null, weigh, handOff: job => handOff(door, job, now),
    kept: { read: () => null, write: () => {} }, alongside: async () => null, settings: waiting, now: () => now, ...(opensScreen ? { opensScreen } : {}) });
  const prepared = await nudge.prepareForHold(answer, settings.after_minutes);
  let view = holdView(withoutHanded(answer, prepared.handed), state, settings, now, { opensScreen });
  if (input.covered) view = { ...view, held: null, ranked: [] };
  const waitingSources = input.things !== undefined ? { from: 'caller', complete: input.things.complete === true }
    : { from: 'configured-sources', ...answer.waiting_sources };
  // An incomplete empty read cannot prove that the persisted held thing or its device lock is free.
  if (view.held || view.on === false || waitingSources.complete === true) await keepHeld(door, view.held, settings, now);
  const said = view.held ? fill(settings.words?.held, { title: view.held.card.title ?? '' })
    : view.on ? answer.complete === false ? answer.said : settings.words?.free : fill(settings.words?.off, view);
  return { ...view, said, words: settings.words, waiting_sources: waitingSources };
}

/** What the hold holds now, kept as setting:needs_you_held when it changed, and a new thing held, or nothing held any
 *  more, runs the person's own devices (`hold.devices`, the rules' `devices`) once for that change (old keepHeld). Each
 *  run is another Workshop tool started through this run's door (`runs` on the row); one that fails is let go, as old
 *  trillion's shop.run(...).catch(() => null) did. */
async function keepHeld(door, held, rules, now) {
  const heldFact = held ? { key: held.key, title: held.card.title ?? '' } : null;
  const kept = await door.readRecord(HELD.type, HELD.id);
  const before = object(kept?.value) ? kept.value.value ?? null : null;
  if ((before?.key ?? null) === (heldFact?.key ?? null) && (before?.title ?? null) === (heldFact?.title ?? null)) return;
  // A repeated held/free cycle, or a deleted and recreated setting, is a new transition even when its values match
  // an old cycle. Keep its identity on this same setting; write receipts and device runs share that exact identity.
  const transition = makeHashCodeHexFromJson({ record: HELD.id, before: kept?.value ?? null, after: heldFact, nonce: randomUUID() });
  const value = { ...(object(kept?.value) ? kept.value : {}), value: heldFact, held_transition: transition };
  try {
    await door.write([{ id: HELD.id, type: HELD.type, value,
      expected: kept ? { type: HELD.type, value: kept.value } : null }], { key: `needs-you-held:${transition}` });
  } catch (error) {
    if (error?.code !== CONFLICT) throw error;
    throw new Refused('The held thing changed before this transition could be saved. Read it again.', 409);
  }
  const confirmed = await door.readRecord(HELD.type, HELD.id);
  if (!confirmed || makeHashCodeHexFromJson(confirmed.value) !== makeHashCodeHexFromJson(value)) {
    throw new Refused('The held thing changed before its device actions could be confirmed. Read it again.', 409);
  }
  const runs = heldFact ? rules.devices?.when_held ?? [] : before ? rules.devices?.when_free ?? [] : [];
  for (const run of runs) {
    await door.run(run.tool_id, heldInput(run.input, heldFact),
      { key: `native-hold-devices:${run.tool_id}:${heldFact?.key ?? 'free'}:${transition}` }).catch(() => null);
  }
}

/** The person's kept notices as the moved tell owner's store reads and writes them (tools/tell-the-person's layout). */
async function noticesOverDoor(door) {
  const held = new Map();
  for await (const record of door.list({ type: TOLD })) held.set(record.id, record);
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
async function seen(door, body, now) {
  const key = text(body.key);
  if (!key) return { seen: null, read: [] };
  const rules = await rulesOf(door);
  const keys = (rules.devices?.when_held ?? []).map(run => heldInput(run.input, { key, title: '' })?.key)
    .filter((notice, index) => typeof notice === 'string' && notice !== rules.devices.when_held[index].input?.key);
  if (!keys.length) return { seen: key, read: [] };
  const kept = await noticesOverDoor(door);
  const tell = makeTellThePerson({ rows: tellRows, store: kept.store, senders: {}, now: () => new Date(now) });
  const on = { here: true, ...(text(body.device_id) ? { device_id: text(body.device_id) } : {}), from: 'thing' };
  const read = keys.map(notice => tell.markRead({ key: notice, on }));
  if (kept.writes.length) {
    try { await door.write(kept.writes, { key: `needs-you-hold-seen:${key}:${now}` }); }
    catch (error) { if (error?.code === CONFLICT) throw new Refused('The notices changed meanwhile. Try again.', 409); throw error; }
  }
  return { seen: key, read };
}

async function holdJobWrites(door, jobs, now) {
  const writes = [];
  for (const job of jobs) {
    if (!job.job?.trim()) continue;
    if (typeof job.once_per !== 'string' || !job.once_per) throw new Error('A hold job needs its stable once_per source.');
    const source = { kind: 'record', ref: job.input?.card_id ?? ROWS.state.id };
    const record = prepareProducedJob({ key: `hold-${makeHashCodeHexFromJson({ source, source_job: job.once_per })}`, job: job.job,
      source, source_job: job.once_per, ...(object(job.input) ? { input: job.input } : {}),
      ...(job.said ? { label: job.said } : {}) }, new Date(now));
    const before = await door.readRecord(record.type, record.id);
    if (before) {
      if (JSON.stringify(before.value?.producer) !== JSON.stringify(record.value.producer) || before.value?.source_job !== job.once_per) throw new Error('A hold job key names a different source.');
      continue;
    }
    writes.push(record);
  }
  return writes;
}

async function publishHoldJobs(door, jobs, now) {
  const writes = await holdJobWrites(door, jobs, now);
  if (!writes.length) return;
  try { await door.write(writes, { key: `hold-jobs:${makeHashCodeHexFromJson(writes.map(row => row.id))}` }); }
  catch (error) {
    if (error?.code !== CONFLICT) throw error;
    if ((await holdJobWrites(door, jobs, now)).length) throw error;
  }
}

const HOLD_CHANGES = {
  'set-aside': (state, rules, input, now) => setAside(state, rules, input, now),
  'hand-back': (state, rules, input, now) => handBack(state, rules, input, now),
  'choose-stake': (state, rules, input, now) => chooseStake(state, rules, input, now),
  'turn-off': (state, rules, input, now) => askOff(state, rules, now),
  'turn-on': state => turnOn(state),
};

/** One change of the hold setting, written with its jobs in one write conditioned on the setting just read. */
async function changeWhatHoldsMe(input, { door }) {
  const operation = HOLD_CHANGES[input.change];
  const now = Date.parse(input.now);
  const rules = await rulesOf(door);
  const { held, value } = await readSetting(door, ROWS.state);
  if (held && !object(held.value)) throw new Error(`${ROWS.state.id} is not an object: write it as { value: { ... } } before changing the hold.`);
  const { state, jobs = [], ...rest } = operation(value ?? {}, rules, input, now);
  // JSON keeps no undefined: the state written is the state the next read sees.
  const next = JSON.parse(JSON.stringify(state));
  const expected = held ? { type: ROWS.state.type, value: held.value } : null;
  try {
    const jobWrites = await holdJobWrites(door, jobs, now);
    await door.write([{ id: ROWS.state.id, type: ROWS.state.type, value: { ...(object(held?.value) ? held.value : {}), value: next }, expected }, ...jobWrites], { key: input.request_key });
  } catch (error) {
    if (error?.code === CONFLICT) return { changed: false, conflict: true, jobs: [] };
    throw error;
  }
  return { changed: true, ...rest, jobs, state: next, published: true };
}

const CHANGES = { aside: 'set-aside', hand_back: 'hand-back', stake: 'choose-stake', off: 'turn-off', on: 'turn-on' };

async function handOff(door, job, now) {
  return publishHoldJobs(door, [job], now);
}

async function change(door, body, now, input = {}) {
  if (body?.op === 'seen') return seen(door, body, now);
  if (!body?.op || body.op === 'read') return read(door, now, undefined, projectionOf({ ...input, ...body }));
  const operation = CHANGES[body.op];
  if (!operation) throw new Error('Say what to do: read, aside, hand_back, stake, off or on.');
  const fields = Object.fromEntries(['key', 'title', 'reason', 'way', 'stake', 'values'].filter(key => body[key] !== undefined).map(key => [key, body[key]]));
  const changed = await changeWhatHoldsMe({ ...fields, change: operation,
    request_key: body.request_key ?? `needs-you-hold-change:${body.op}:${now}`, now: new Date(now).toISOString() }, { door });
  if (changed.conflict) throw new Refused('The hold changed meanwhile. Read it again.', 409);
  const { changed: _, state, jobs, published, ...result } = changed;
  return { ...result, ...(await read(door, now, undefined, projectionOf({ ...input, ...body }))) };
}

/** tool:answer-the-needs-you-hold-route */
export async function answerNeedsYouHoldRoute(input = {}, { door, now = () => Date.now() } = {}) {
  const path = String(input?.path ?? '');
  const method = String(input?.method ?? 'GET').toUpperCase();
  if (path !== '/needs-you-hold' || !['GET', 'POST'].includes(method)) return { status: 404, body: { error: 'Not found' } };
  if (method === 'GET') {
    try { return { status: 200, body: await read(door, now(), undefined, projectionOf(input)) }; }
    catch (error) { const status = refusalStatus(error); return status === null ? { status: 503, body: BUSY } : { status, body: { error: error.message } }; }
  }
  try {
    const body = typeof input.body === 'string' ? JSON.parse(input.body || '{}') : object(input.body) ? input.body : {};
    return { status: 200, body: await change(door, body, now(), input) };
  } catch (error) {
    return { status: refusalStatus(error) ?? 400, body: { error: error.message } };
  }
}
