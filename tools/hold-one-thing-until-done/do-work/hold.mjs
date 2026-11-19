// tools/hold-one-thing-until-done/do-work/hold.mjs
//
// PURPOSE
//   The two rows of this tool, run by do-work/run-given.mjs with the input the request carries: seeWhatHoldsMe answers whether the
//   required-setup cover stands and which one must-do row the hold shows; changeWhatHoldsMe answers the hold setting after
//   the held row is set aside, handed back, given a stake, asked off or turned on. Both read and keep nothing: the
//   rows they work from come in with the request and what they make comes back in the answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The decisions are the moved code's (read-data/needs-you-hold.mjs, read-data/required-cover.mjs,
//      read-data/hold-answer.mjs); this file only checks the request and shapes the answer.
//   2. A change answers the whole next setting (`state`) and its jobs as calendar-task records (`jobs`); the caller keeps both.
//      A job's id is stable from its source and once_per, so a repeated trigger is one job.
//   3. The cover fails closed: no gate key still covers (DEFAULT_COVER_KEY), and rows that decide nothing answer
//      `covered: null`, never false.
//
import ROWS from '../read-data/hold-rows.json' with { type: 'json' };
import { askOff, chooseStake, handBack, setAside, turnOn } from '../read-data/needs-you-hold.mjs';
import { requiredCover, requiredCoverOfRows } from '../read-data/required-cover.mjs';
import { answerOfRows, holdAnswer, holdJobRecords } from '../read-data/hold-answer.mjs';

export { answerOfRows };

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const nowOf = input => {
  if (input.now === undefined) return Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return at;
};

function rulesOf(input) {
  if (!object(input.rules)) throw new Error('Send rules: the hold rules (after_minutes, aside, hand_back, off, rank, words) as an object.');
  return input.rules;
}

const isDone = (value, kind) => kind.done_values.includes(value?.[kind.done_field]);

/** tool:see-what-holds-me */
export async function seeWhatHoldsMe(input = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const now = nowOf(input);
  const rules = rulesOf(input);
  const gate = input.gate;
  let cover;
  if (input.setup !== undefined) cover = requiredCover(input.setup, gate);
  else {
    const steps = ROWS.setup_steps;
    const rows = (Array.isArray(input.setup_steps) ? input.setup_steps : []).filter(record => object(record?.value))
      .map(record => ({ required: record.value[steps.required_field] === true, done: isDone(record.value, steps) }));
    cover = requiredCoverOfRows(rows, gate);
  }
  const state = object(input.state) ? input.state : {};
  const { hold, ...made } = await holdAnswer({ ...input, covered: cover.covered === true }, { rules, state, now });
  return { cover, hold, ...made };
}

const CHANGES = {
  'set-aside': (state, rules, input, now) => setAside(state, rules, input, now),
  'hand-back': (state, rules, input, now) => handBack(state, rules, input, now),
  'choose-stake': (state, rules, input, now) => chooseStake(state, rules, input, now),
  'turn-off': (state, rules, input, now) => askOff(state, rules, now),
  'turn-on': state => turnOn(state),
};

/** tool:change-what-holds-me */
export function changeWhatHoldsMe(input = {}) {
  if (!object(input)) throw new Error('The request is one object.');
  const change = CHANGES[input.change];
  if (!change) throw new Error(`change must be one of: ${Object.keys(CHANGES).join(', ')}.`);
  const now = nowOf(input);
  const rules = rulesOf(input);
  if (input.state !== undefined && !object(input.state)) throw new Error('state is the hold setting as an object ({ on, off, aside, handed_back, ... }), as the caller last kept it.');
  const { state, jobs = [], ...rest } = change(input.state ?? {}, rules, input, now);
  // JSON keeps no undefined: the state answered is the state the next read sees.
  const next = JSON.parse(JSON.stringify(state));
  return { changed: true, ...rest, jobs: holdJobRecords(jobs, now), state: next };
}
