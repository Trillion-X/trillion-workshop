// tools/hold-one-thing-until-done/do-work/hold.mjs
//
// PURPOSE
//   The two rows of this tool, run by tools/records-door/do-work/run-an-export.mjs: seeWhatHoldsMe answers whether the
//   required-setup cover stands and which one must-do row the hold shows; changeWhatHoldsMe sets the held row aside,
//   hands it back, chooses the stake, asks for the hold to turn off or turns it on, as one write of the person's hold
//   setting conditioned on the value just read.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are the moved code's (read-data/needs-you-hold.mjs, read-data/required-cover.mjs); this file only
//      reads the person's rows into their shapes and writes the setting back.
//   2. Every record read or written is one read-data/hold-rows.json names, and the row's rights grant only those.
//   3. A change writes the whole setting with `expected` set to what was read; a setting changed meanwhile answers
//      `{ changed: false, conflict: true }` and writes nothing. The request key makes the same change safe to send again.
//   4. Nothing is sent from here: the jobs a change hands to the person's AIs are answered for the caller to hand.
//   5. The cover fails closed: no gate key still covers (DEFAULT_COVER_KEY), and rows that decide nothing answer
//      `covered: null`, never false.
//
import ROWS from '../read-data/hold-rows.json' with { type: 'json' };
import { askOff, chooseStake, handBack, holdView, setAside, turnOn } from '../read-data/needs-you-hold.mjs';
import { requiredCover, requiredCoverOfRows } from '../read-data/required-cover.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const settingValue = value => (object(value) && object(value.value) ? value.value : null);
const nowOf = input => {
  if (input.now === undefined) return Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return at;
};

async function readSetting(door, row) {
  const held = await door.readRecord(row.type, row.id);
  return { held, value: settingValue(held?.value) };
}

async function rulesOf(input, door) {
  if (input.rules !== undefined) {
    if (!object(input.rules)) throw new Error('rules must be an object: the hold rules (after_minutes, aside, hand_back, off, rank, words).');
    return input.rules;
  }
  const { value } = await readSetting(door, ROWS.rules);
  if (!value) throw new Error(`No hold rules: write them to ${ROWS.rules.id} as { value: { ... } }, or send rules with the request.`);
  return value;
}

async function rowsOf(door, kind) {
  const rows = [];
  for await (const record of door.list({ type: kind.type, limit: ROWS.page_rows })) {
    rows.push(record);
    if (rows.length > ROWS.most_rows) throw new Error(`More than ${ROWS.most_rows} ${kind.type} rows: the hold reads at most that many.`);
  }
  return rows;
}

const isDone = (value, kind) => kind.done_values.includes(value?.[kind.done_field]);

/** The person's must-do rows as the hold's answer: one section holding a card per row not done yet. */
export function answerOfRows(records, section = {}) {
  const kind = ROWS.must_do;
  const cards = records.filter(record => object(record?.value) && !isDone(record.value, kind)).map(record => ({
    id: record.id,
    // A row names another it waits on by the other's row id; the hold reads `${source}:${name}` as that row's record id.
    source: kind.type,
    ...Object.fromEntries(Object.entries(kind.card).flatMap(([field, from]) => (record.value[from] === undefined ? [] : [[field, record.value[from]]]))),
  }));
  return { sections: [{ ...section, id: section.id ?? kind.section, total: cards.length, cards }] };
}

const opensScreenOf = prefixes => (Array.isArray(prefixes) ? address => prefixes.some(prefix => address.startsWith(prefix)) : undefined);

/** tool:see-what-holds-me */
export async function seeWhatHoldsMe(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const now = nowOf(input);
  const rules = await rulesOf(input, door);
  const gate = input.gate !== undefined ? input.gate : (await readSetting(door, ROWS.gate)).value;
  let cover;
  if (input.setup !== undefined) cover = requiredCover(input.setup, gate);
  else {
    const steps = ROWS.setup_steps;
    const rows = (await rowsOf(door, steps)).filter(record => object(record.value))
      .map(record => ({ required: record.value[steps.required_field] === true, done: isDone(record.value, steps) }));
    cover = requiredCoverOfRows(rows, gate);
  }
  const answer = input.things !== undefined ? input.things : answerOfRows(await rowsOf(door, ROWS.must_do), input.section);
  if (!object(answer) || !Array.isArray(answer.sections)) throw new Error('things must be { sections: [{ id, cards: [...] }] }.');
  const state = input.state !== undefined ? input.state : (await readSetting(door, ROWS.state)).value ?? {};
  // While the cover stands, setup is the one thing: the hold waits behind it, as the page's lock does.
  const hold = holdView(answer, state, rules, now, { opensScreen: opensScreenOf(input.opens_screens) });
  return { cover, hold: cover.covered === true ? { ...hold, held: null, ranked: [] } : hold };
}

const CHANGES = {
  'set-aside': (state, rules, input, now) => setAside(state, rules, input, now),
  'hand-back': (state, rules, input, now) => handBack(state, rules, input, now),
  'choose-stake': (state, rules, input, now) => chooseStake(state, rules, input, now),
  'turn-off': (state, rules, input, now) => askOff(state, rules, now),
  'turn-on': state => turnOn(state),
};

/** tool:change-what-holds-me */
export async function changeWhatHoldsMe(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const change = CHANGES[input.change];
  if (!change) throw new Error(`change must be one of: ${Object.keys(CHANGES).join(', ')}.`);
  if (typeof input.request_key !== 'string' || !input.request_key.trim()) throw new Error('request_key names this change, so sending it again changes nothing twice.');
  const now = nowOf(input);
  const rules = await rulesOf(input, door);
  const { held, value } = await readSetting(door, ROWS.state);
  if (held && !object(held.value)) throw new Error(`${ROWS.state.id} is not an object: write it as { value: { ... } } before changing the hold.`);
  const { state, jobs = [], ...rest } = change(value ?? {}, rules, input, now);
  // JSON keeps no undefined: the state written is the state the next read sees.
  const next = JSON.parse(JSON.stringify(state));
  const expected = held ? { type: ROWS.state.type, value: held.value } : null;
  try {
    await door.write([{ id: ROWS.state.id, type: ROWS.state.type, value: { ...(object(held?.value) ? held.value : {}), value: next }, expected }], { key: input.request_key });
  } catch (error) {
    if (error?.code === 'original_command_conflict') return { changed: false, conflict: true, jobs: [] };
    throw error;
  }
  return { changed: true, ...rest, jobs, state: next };
}
