// src/date-shift.mjs
//
// PURPOSE
//   One pure function that moves a plan of dated stages when its start or end moves, by a named strategy (shift, absorb,
//   distribute, accordion, shrink) and a lock mode (nothing, finished, started), and one consumer that moves the Calendar
//   tasks of a task list the same way, as values, through planTaskShift. Nothing here keeps dates; a
//   deadline moving never leaves a plan in an impossible shape because the invariants below refuse loudly.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure and blind (shiftStages): no clock, no storage, no task, plan or app named; strategies, lock modes and every
//      word are src/date-shift.json.
//   2. A locked stage never moves. Locked stages come first; a plan where unlocked work precedes locked work is refused.
//   3. After any strategy, every stage is at least one day long, stages are in order without overlap, and a locked stage is
//      byte-for-byte as given. A move that cannot keep this is refused with the reason, never repaired quietly.
//   4. `distribute` leaves no day of the window unallocated and no day shared.
//   5. Values in, values out: the plan is computed from the task rows the caller hands in and writes nothing. The caller
//      reads the tasks and writes each change (workflow:move-a-dated-plan), keeping its previous values as the undo.
//
import data from './date-shift.json' with { type: 'json' };

// A refusal names the problem in the person's words.
export class DateShiftError extends Error {}

const say = (key, values = {}) => data.words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const DAY = 86400000;
const DATE = /^\d{4}-\d{2}-\d{2}/;

/** A date (YYYY-MM-DD, or a longer ISO text that starts with one) as a whole day number, or null. */
export function dayOf(text) {
  if (typeof text !== 'string' || !DATE.test(text)) return null;
  const day = text.slice(0, 10);
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === day ? Math.round(at / DAY) : null;
}
export const dateOf = day => new Date(day * DAY).toISOString().slice(0, 10);

const lengthOf = stage => stage.end - stage.start + 1;
// `total` days shared by stages in the proportion of `weights`, each at least one, the remainder to the largest fractions.
function shares(weights, total) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const spare = total - weights.length;
  const raw = weights.map(weight => (weight / sum) * spare);
  const whole = raw.map(Math.floor);
  let left = spare - whole.reduce((a, b) => a + b, 0);
  const order = raw.map((value, at) => [value - Math.floor(value), at]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, at] of order) { if (left <= 0) break; whole[at] += 1; left -= 1; }
  return whole.map(days => days + 1);
}

// Each strategy takes the unlocked stages (in order) and the window they may fill, and answers their new { start, end }.
// `context` holds what the request moved: { oldStart, oldEnd, start, end } (start/end undefined when not moved).
const STRATEGIES = {
  shift(free, window, { oldStart, oldEnd, start, end }) {
    const byStart = start === undefined ? null : start - oldStart;
    const byEnd = end === undefined ? null : end - oldEnd;
    if (byStart !== null && byEnd !== null && byStart !== byEnd) throw new DateShiftError(say('shift_differs'));
    const delta = byStart ?? byEnd;
    return free.map(stage => ({ start: stage.start + delta, end: stage.end + delta }));
  },
  absorb(free, window, { start, end }) {
    const moved = free.map(stage => ({ start: stage.start, end: stage.end }));
    if (start !== undefined) moved[0].start = start;
    if (end !== undefined) moved[moved.length - 1].end = end;
    return moved;
  },
  distribute(free, window) {
    const days = window.end - window.start + 1;
    if (days < free.length) throw new DateShiftError(say('too_few_days', { days, count: free.length }));
    let at = window.start;
    return shares(free.map(lengthOf), days).map(length => { const stage = { start: at, end: at + length - 1 }; at += length; return stage; });
  },
  accordion(free, window) {
    const days = window.end - window.start + 1;
    const needed = free.reduce((sum, stage) => sum + lengthOf(stage), 0);
    if (needed > days) throw new DateShiftError(say('too_long', { needed, days }));
    const gaps = free.length - 1;
    const slack = days - needed;
    let at = window.start;
    return free.map((stage, index) => {
      const moved = { start: at, end: at + lengthOf(stage) - 1 };
      const gap = gaps === 0 ? 0 : Math.floor(slack / gaps) + (index < slack % gaps ? 1 : 0);
      at = moved.end + 1 + gap;
      return moved;
    });
  },
  shrink(free, window, { oldEnd, end }) {
    if (end !== undefined && end > oldEnd) throw new DateShiftError(say('shrink_only_shortens'));
    const moved = free.map(stage => ({ start: stage.start, end: stage.end }));
    let limit = window.end;
    for (let at = moved.length - 1; at >= 0; at -= 1) {
      moved[at].end = Math.min(moved[at].end, limit);
      moved[at].start = Math.min(moved[at].start, moved[at].end);
      limit = moved[at].start - 1;
    }
    if (moved[0].start < window.start) throw new DateShiftError(say('too_few_days', { days: window.end - window.start + 1, count: free.length }));
    return moved;
  },
};

const row = (rows, id) => rows.find(item => item.id === id);

/**
 * `stages` ([{ id, start, end, done?, started? }], days as whole day numbers or YYYY-MM-DD text) moved so the plan starts
 * on `start` and/or ends on `end`. Answers { stages: [{ id, start, end, moved }], moved: [ids], start, end } in day numbers,
 * or throws DateShiftError in plain words.
 */
export function shiftStages(stages, { strategy = data.default_strategy, lock = data.default_lock, start, end } = {}) {
  const strategyRow = row(data.strategies, strategy);
  if (!strategyRow || !STRATEGIES[strategy]) throw new DateShiftError(say('unknown_strategy', { id: strategy, ids: data.strategies.map(item => item.id).join(', ') }));
  const lockRow = row(data.locks, lock);
  if (!lockRow) throw new DateShiftError(say('unknown_lock', { id: lock, ids: data.locks.map(item => item.id).join(', ') }));
  if (!Array.isArray(stages) || !stages.length) throw new DateShiftError(say('no_stages'));
  const asDay = (value, name) => {
    const day = typeof value === 'number' ? value : dayOf(value);
    if (!Number.isInteger(day)) throw new DateShiftError(say('bad_date', { name }));
    return day;
  };
  if (start === undefined && end === undefined) throw new DateShiftError(say('no_change'));
  const newStart = start === undefined ? undefined : asDay(start, 'The new start');
  const newEnd = end === undefined ? undefined : asDay(end, 'The new end');

  const ordered = stages.map(stage => {
    const from = typeof stage.start === 'number' ? stage.start : dayOf(stage.start);
    const to = typeof stage.end === 'number' ? stage.end : dayOf(stage.end);
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) throw new DateShiftError(say('bad_stage', { id: stage.id }));
    return { id: stage.id, start: from, end: to, locked: lockRow.flags.some(flag => stage[flag] === true) };
  }).sort((a, b) => a.start - b.start || a.end - b.end || String(a.id).localeCompare(String(b.id)));

  const firstFree = ordered.findIndex(stage => !stage.locked);
  if (firstFree === -1) throw new DateShiftError(say('nothing_to_move'));
  const strayed = ordered.slice(firstFree).find(stage => stage.locked);
  if (strayed) throw new DateShiftError(say('locked_gap', { id: ordered[firstFree].id }));
  const locked = ordered.slice(0, firstFree);
  const free = ordered.slice(firstFree);
  if (locked.length && newStart !== undefined && newStart !== ordered[0].start) throw new DateShiftError(say('start_locked'));

  const oldStart = ordered[0].start;
  const oldEnd = ordered[ordered.length - 1].end;
  const window = {
    start: newStart !== undefined && !locked.length ? newStart : free[0].start,
    end: newEnd ?? oldEnd,
  };
  const context = { oldStart: free[0].start, oldEnd, start: locked.length ? undefined : newStart, end: newEnd };
  const placed = STRATEGIES[strategy](free, window, context);

  const result = [...locked.map(stage => ({ ...stage, moved: false })), ...free.map((stage, at) => ({ id: stage.id, start: placed[at].start, end: placed[at].end, moved: placed[at].start !== stage.start || placed[at].end !== stage.end }))];
  for (let at = 0; at < result.length; at += 1) {
    const stage = result[at];
    if (stage.end < stage.start) throw new DateShiftError(say('collapses', { id: stage.id }));
    if (at > 0 && stage.start <= result[at - 1].end) {
      throw new DateShiftError(at - 1 < locked.length ? say('hits_locked', { date: dateOf(result[at - 1].end) }) : say('collapses', { id: stage.id }));
    }
  }
  if (strategy === 'distribute' && (free.length && (placed[0].start !== window.start || placed[placed.length - 1].end !== window.end))) {
    throw new DateShiftError(say('too_few_days', { days: window.end - window.start + 1, count: free.length }));
  }
  return {
    stages: result.map(({ id, start: from, end: to, moved }) => ({ id, start: from, end: to, moved })),
    moved: result.filter(stage => stage.moved).map(stage => stage.id),
    start: result[0].start,
    end: result[result.length - 1].end,
  };
}

/** The strategies and lock modes a person or AI may name, with what each does. */
export const shiftChoices = () => ({
  strategies: data.strategies.map(({ id, label, says }) => ({ id, label, says })),
  locks: data.locks.map(({ id, label }) => ({ id, label })),
  default_strategy: data.default_strategy,
  default_lock: data.default_lock,
});


/**
 * Plans the move of one plan's dated tasks, values in and values out: `tasks` are the plan's rows as the caller read them
 * ({ id, title, start_on, due, status }), and the input names the strategy, lock and window. Nothing is read or written here.
 * The answer names the stages that move, their new dates, and `changes`: one per moved task, with its new start_on and due and
 * its `previous` values, which the caller keeps as the undo. A due date that carries a time keeps its time of day.
 */
export function planTaskShift(tasks, input = {}, options = {}) {
  const today = dayOf(input.today ?? new Date((options.now ?? Date.now)()).toISOString());
  const dated = (Array.isArray(tasks) ? tasks : []).filter(task => dayOf(task.due) !== null);
  if (!dated.length) throw new DateShiftError(say('none_dated'));
  const byId = new Map(dated.map(task => [task.id, task]));
  const stages = dated.map(task => {
    const end = dayOf(task.due);
    const start = dayOf(task.start_on) ?? end;
    return { id: task.id, start: Math.min(start, end), end, done: task.status === 'Done', started: start <= today };
  });
  const plan = shiftStages(stages, { strategy: input.strategy, lock: input.lock, start: input.start, end: input.end });
  const shown = plan.stages.map(stage => ({ task_id: stage.id, title: byId.get(stage.id).title, start_on: dateOf(stage.start), due: dateOf(stage.end), moved: stage.moved }));
  const changes = plan.stages.filter(stage => stage.moved).map(stage => {
    const task = byId.get(stage.id);
    const dueTail = typeof task.due === 'string' && task.due.length > 10 ? task.due.slice(10) : '';
    return { task_id: stage.id, start_on: dateOf(stage.start), due: `${dateOf(stage.end)}${dueTail}`, previous: { start_on: task.start_on ?? null, due: task.due } };
  });
  return { dry_run: input.dry_run === true, moved: plan.moved, tasks: shown, start: dateOf(plan.start), end: dateOf(plan.end), changes };
}

/** The route path of the plan's choices (GET). Moving a plan is the workflow's job, not a route's. */
export const isDateShiftPath = path => path === '/calendar/task-shift';
