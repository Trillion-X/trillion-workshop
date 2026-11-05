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
//
import ROWS from '../read-data/hold-rows.json' with { type: 'json' };
import { askOff, chooseStake, handBack, holdView, setAside, turnOn } from '../read-data/needs-you-hold.mjs';
import { answerOfRows } from './hold.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value.trim() : '');
const settingValue = value => (object(value) && object(value.value) ? value.value : null);
const CONFLICT = 'original_command_conflict';
const BUSY = { error: 'Busy for a moment. Try again.', busy: true };
// Who hands the hold's jobs to the person's AIs: old trillion handed them `from_agent: 'trillion-waiting'`.
const JOBS = { kind: 'ai-job', start: 'waiting', from: 'ai:trillion-waiting', priority: 5, key: /[^A-Za-z0-9._:-]/g };
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
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

async function cardsOf(door) {
  const rows = [];
  for await (const record of door.list({ type: ROWS.must_do.type, limit: ROWS.page_rows })) {
    rows.push(record);
    if (rows.length > ROWS.most_rows) throw new Error(`More than ${ROWS.most_rows} ${ROWS.must_do.type} rows: the hold reads at most that many.`);
  }
  return answerOfRows(rows);
}

/** The read, as old needsYouHold answered op read: the view, what it says and the words. */
async function read(door, now, rules) {
  const settings = rules ?? await rulesOf(door);
  const state = (await readSetting(door, ROWS.state)).value ?? {};
  const view = holdView(await cardsOf(door), state, settings, now);
  const said = view.held ? fill(settings.words?.held, { title: view.held.card.title ?? '' })
    : view.on ? settings.words?.free : fill(settings.words?.off, view);
  return { ...view, said, words: settings.words };
}

const CHANGES = {
  aside: (state, rules, body, now) => setAside(state, rules, { key: text(body.key), title: text(body.title), reason: text(body.reason) }, now),
  hand_back: (state, rules, body, now) => handBack(state, rules, { key: text(body.key), title: text(body.title), way: text(body.way), reason: text(body.reason) }, now),
  stake: (state, rules, body, now) => chooseStake(state, rules, { stake: text(body.stake), values: body.values ?? {} }, now),
  off: (state, rules, body, now) => askOff(state, rules, now),
  on: state => turnOn(state),
};

/** A job the change hands to the person's AIs, kept as an ai-job they take (tools/hand-work-to-ais), once per once_per. */
async function handOff(door, job, now) {
  const id = `${JOBS.kind}:${String(job.once_per ?? '').replace(JOBS.key, '-')}`;
  const value = { kind: JOBS.kind, status: JOBS.start, job: String(job.job ?? ''), to: null, from: JOBS.from, priority: JOBS.priority,
    sent_at: new Date(now).toISOString(), ...(job.said ? { label: String(job.said) } : {}), ...(object(job.input) ? { input: job.input } : {}) };
  try { await door.write([{ id, type: JOBS.kind, value, expected: null }], { key: `needs-you-hold-job:${id}` }); }
  catch (error) { if (error?.code !== CONFLICT) throw error; }
}

async function change(door, body, now) {
  if (body?.op === 'seen') return { seen: text(body.key) || null, read: [] };
  if (!body?.op || body.op === 'read') return read(door, now);
  const operation = CHANGES[body.op];
  if (!operation) throw new Error('Say what to do: read, aside, hand_back, stake, off or on.');
  const rules = await rulesOf(door);
  const { held, value } = await readSetting(door, ROWS.state);
  const { state, jobs = [], ...result } = operation(value ?? {}, rules, body, now);
  const next = JSON.parse(JSON.stringify(state));
  const expected = held ? { type: ROWS.state.type, value: held.value } : null;
  try {
    await door.write([{ id: ROWS.state.id, type: ROWS.state.type, value: { ...(object(held?.value) ? held.value : {}), value: next }, expected }],
      { key: `needs-you-hold-change:${body.op}:${now}` });
  } catch (error) {
    if (error?.code === CONFLICT) throw new Refused('The hold changed meanwhile. Read it again.', 409);
    throw error;
  }
  for (const job of jobs) await handOff(door, job, now);
  return { ...result, ...(await read(door, now, rules)) };
}

/** tool:answer-the-needs-you-hold-route */
export async function answerNeedsYouHoldRoute(input = {}, { door, now = () => Date.now() } = {}) {
  const path = String(input?.path ?? '');
  const method = String(input?.method ?? 'GET').toUpperCase();
  if (path !== '/needs-you-hold' || !['GET', 'POST'].includes(method)) return { status: 404, body: { error: 'Not found' } };
  if (method === 'GET') {
    try { return { status: 200, body: await read(door, now()) }; }
    catch (error) { const status = refusalStatus(error); return status === null ? { status: 503, body: BUSY } : { status, body: { error: error.message } }; }
  }
  try {
    const body = typeof input.body === 'string' ? JSON.parse(input.body || '{}') : object(input.body) ? input.body : {};
    return { status: 200, body: await change(door, body, now()) };
  } catch (error) {
    return { status: refusalStatus(error) ?? 400, body: { error: error.message } };
  }
}
