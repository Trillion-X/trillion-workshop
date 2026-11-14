// src/calendar-task-views.mjs
//
// PURPOSE
//   How the task tray beside the Calendar reads the tasks it is given, as pure functions over the rows of
//   src/workspace/calendar-task-tray.json: which list a task is in (the built-in lists are a test each, a person's own list is
//   a task's collection), how many each list holds, what the Display menu shows and in what order, how the words typed into
//   the new-todo field name a list and a time, which key does what, and how near a deadline is. It reads no clock and no
//   store: the caller passes `now`, so the same tasks and the same minute always give the same tray.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a list, a sort, a key or a word: they are rows of the tray DATA, passed in or defaulted from it.
//   2. A task is never changed here. Moving into a list answers the fields to write (`moveTarget`); the caller writes them
//      through the one task road (src/calendar-tasks.mjs).
//   3. A word typed after `@` that names neither a list nor a time stays in the title: nothing typed is dropped.

import tray from './workspace/calendar-task-tray.json' with { type: 'json' };

const DAY = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const pad = value => String(value).padStart(2, '0');

/** The local calendar day ("YYYY-MM-DD") of a date or a date and time, or null when it is neither. */
export function localDay(value) {
  if (typeof value !== 'string' || !value) return null;
  if (DATE_ONLY.test(value)) return value;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The instant a date or date and time means: a date alone is the start of that local day. */
export function localInstant(value) {
  if (typeof value !== 'string' || !value) return null;
  const at = DATE_ONLY.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  const time = at.getTime();
  return Number.isNaN(time) ? null : time;
}

/** Days from one local day to another (whole days, either sign). */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);

export const addDaysTo = (day, count) => new Date(Date.parse(`${day}T12:00:00Z`) + count * DAY).toISOString().slice(0, 10);

const isEmpty = value => value == null || value === '' || (Array.isArray(value) && value.length === 0);

/** One test of a built-in list's `match` against one task. */
function passes(task, test, today) {
  if (Array.isArray(test.all)) return test.all.every(inner => passes(task, inner, today));
  if (Array.isArray(test.any)) return test.any.some(inner => passes(task, inner, today));
  const value = task[test.field];
  if (test.empty === true) return isEmpty(value);
  if (test.not_empty === true) return !isEmpty(value);
  if (Object.hasOwn(test, 'is')) return value === test.is;
  if (Array.isArray(test.in)) return test.in.includes(value);
  if (test.today === true) return localDay(value) === today;
  if (test.today_or_before === true) { const day = localDay(value); return day !== null && day <= today; }
  return false;
}

/** Whether a task is snoozed at `now`: it has a snooze that has not yet passed. */
export function isSnoozed(task, now) {
  const until = localInstant(task.snoozed_until);
  return until !== null && until > now;
}

/** The built-in list rows, by id. */
export const builtinLists = (data = tray) => data.lists;

/** Whether a task belongs to a list: a built-in list's test, or a person's own list by the task's collection. */
export function inList(task, listId, { today, data = tray } = {}) {
  const builtin = data.lists.find(row => row.id === listId);
  if (builtin) return passes(task, builtin.match, today);
  return task.collection_id === listId;
}

/** The fields a task takes when it is moved into a list (built-in rows say them; a person's own list is its collection). */
export function moveTarget(listId, data = tray) {
  const builtin = data.lists.find(row => row.id === listId);
  if (!builtin) return { collection_id: listId, smart_list: null };
  return builtin.move_to ? { ...builtin.move_to } : null;
}

/** Tasks the tray offers under the Display menu's View choices: done and snoozed ones only when asked for. */
export function visibleTasks(tasks, display, { now }) {
  return tasks.filter(task => display.show_snoozed || !isSnoozed(task, now));
}

const compareText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base', numeric: true });

/** Tasks in the order a sort row says; `manual` (no field) keeps the order given, which is the person's own. */
export function sortTasks(tasks, sortId, data = tray) {
  const row = data.display.sort_by.find(entry => entry.id === sortId);
  if (!row?.field) return tasks;
  const direction = row.direction === 'desc' ? -1 : 1;
  return tasks.map((task, index) => ({ task, index })).sort((a, b) => {
    const left = a.task[row.field], right = b.task[row.field];
    const leftEmpty = isEmpty(left), rightEmpty = isEmpty(right);
    if (leftEmpty || rightEmpty) {
      if (leftEmpty && rightEmpty) return a.index - b.index;
      return (leftEmpty ? 1 : -1) * (row.empty_last ? 1 : -1);
    }
    const order = row.text ? compareText(left, right) : String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
    return order * direction || a.index - b.index;
  }).map(entry => entry.task);
}

/** The grouping levels for a Group by choice (the shared record view's own GroupLevel rows). */
export function groupLevelsFor(groupId, data = tray) {
  return (data.display.group_by.find(row => row.id === groupId) ?? data.display.group_by[0]).levels.map(level => ({ ...level }));
}

/**
 * The grouping a Display holds: the levels a person picked in the shared record view's own Group by menu when they are none of
 * the rows, else the levels of its Group by row.
 */
export function levelsOf(display, data = tray) {
  return Array.isArray(display.group_levels) ? display.group_levels.map(level => ({ ...level })) : groupLevelsFor(display.group_by, data);
}

// Levels a person picked: a few rows each naming a field, nothing else read from the saved value.
const pickedLevels = value => Array.isArray(value) && value.length > 0 && value.length <= 3 && value.every(level => level && typeof level.field === 'string' && level.field)
  ? value.map(level => ({ field: level.field, ...(typeof level.bucket === 'string' ? { bucket: level.bucket } : {}) })) : null;

/** The Display choices a person's saved preference gives, each checked against the rows, the rest the defaults. */
export function displayFrom(saved, data = tray) {
  const defaults = data.display.defaults;
  const value = saved && typeof saved === 'object' ? saved : {};
  return {
    group_by: data.display.group_by.some(row => row.id === value.group_by) ? value.group_by : defaults.group_by,
    sort_by: data.display.sort_by.some(row => row.id === value.sort_by) ? value.sort_by : defaults.sort_by,
    ...(pickedLevels(value.group_levels) ? { group_levels: pickedLevels(value.group_levels) } : {}),
    ...Object.fromEntries(data.display.view.map(row => [row.id, typeof value[row.id] === 'boolean' ? value[row.id] : defaults[row.id]])),
  };
}

/**
 * The tabs above the tray: every built-in list, then each of the person's own lists that is not archived, each with how many
 * open tasks it holds. A task counts once per list it is in; snoozed ones count only when snoozed todos are shown.
 */
export function tabsFor({ tasks, collections, display, now, data = tray }) {
  const shown = visibleTasks(tasks.filter(task => task.status !== 'Done'), display, { now });
  const ctx = { today: nowDay(now), data };
  const countIn = id => shown.reduce((count, task) => count + (inList(task, id, ctx) ? 1 : 0), 0);
  return [
    ...data.lists.map(row => ({ id: row.id, label: row.label, icon: row.icon, builtin: true, count: countIn(row.id) })),
    ...collections.filter(collection => !collection.archived).map(collection => ({ id: collection.id, label: collection.title, color: collection.color ?? null, builtin: false, count: countIn(collection.id) })),
  ];
}

/** Today's local day for an instant. */
export function nowDay(now) {
  const at = new Date(now);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

// ---- The words typed into the new-todo field ------------------------------------------------------------------------------

function clock(text, quick) {
  const named = quick.time_words[text];
  const source = named ?? text;
  const twelve = new RegExp(quick.pattern_12h).exec(source);
  if (twelve) {
    const hours = Number(twelve[1]), minutes = twelve[2] === undefined ? 0 : Number(twelve[2]);
    if (hours < 1 || hours > 12 || minutes > 59) return null;
    return ((hours % 12) + (twelve[3] === 'pm' ? 12 : 0)) * 60 + minutes;
  }
  const twentyFour = new RegExp(quick.pattern_24h).exec(source);
  if (twentyFour) {
    const hours = Number(twentyFour[1]), minutes = Number(twentyFour[2]);
    return hours > 23 || minutes > 59 ? null : hours * 60 + minutes;
  }
  return null;
}

const normalName = text => text.toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Reads the words typed into the new-todo field. Every word after `@` is tried as a day ("today", "tomorrow", a weekday), a
 * time ("2pm", "14:30", "noon") and then a list (its whole name, or the start of one name only); a word that is none of
 * them stays in the title. `lists` are `{ id, label }` (built-in and the person's own). Answers the title, the list
 * chosen (or null), and the local day and minute of the time chosen (or nulls); a time with no day is today, or tomorrow
 * when it has passed.
 */
export function parseQuickTask(text, { lists, now, data = tray }) {
  const quick = data.quick_add;
  const marker = quick.list_marker;
  const words = String(text).split(/(\s+)/);
  const today = nowDay(now);
  const at = new Date(now);
  const minuteNow = at.getHours() * 60 + at.getMinutes();
  let list = null, dayOffset = null, minute = null;
  const kept = [];
  for (const piece of words) {
    if (!piece.startsWith(marker) || piece.length === marker.length || /^\s/.test(piece)) { kept.push(piece); continue; }
    const body = piece.slice(marker.length).toLocaleLowerCase();
    const weekday = quick.weekdays.findIndex(names => names.includes(body));
    if (Object.hasOwn(quick.day_words, body) && dayOffset === null) { dayOffset = quick.day_words[body]; continue; }
    if (weekday >= 0 && dayOffset === null) {
      dayOffset = (weekday - at.getDay() + 7) % 7 || 7;
      continue;
    }
    const time = minute === null ? clock(body, quick) : null;
    if (time !== null) { minute = time; continue; }
    if (list === null) {
      const wanted = normalName(piece.slice(marker.length));
      const exact = lists.filter(row => normalName(row.label) === wanted);
      const prefix = exact.length ? exact : lists.filter(row => normalName(row.label).startsWith(wanted));
      if (prefix.length === 1) { list = prefix[0]; continue; }
    }
    kept.push(piece);
  }
  const title = kept.join('').replace(/\s+/g, ' ').trim();
  let day = null;
  if (dayOffset !== null || minute !== null) {
    const base = dayOffset ?? (minute !== null && minute <= minuteNow ? 1 : 0);
    day = addDaysTo(today, base);
    if (minute === null) minute = quick.default_hour * 60;
  }
  return { title, list, day, minute };
}

/** The instant (ISO) of a local day and minute of the day, in this device's time zone. */
export function instantOf(day, minute) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, Math.floor(minute / 60), minute % 60).toISOString();
}

// ---- Moving through tasks and lists ---------------------------------------------------------------------------------------
// (The keys that do it are rows of the one keymap, keymap.json scope `tasks`.)

/** The id after (or before) `current` in `ids`, staying at the end rather than wrapping; the first when none is current. */
export function stepId(ids, current, step) {
  if (!ids.length) return null;
  const at = ids.indexOf(current);
  if (at < 0) return step > 0 ? ids[0] : ids[ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, at + step))];
}

/** The id after (or before) `current` in `ids`, wrapping round: how the lists are walked. */
export function cycleId(ids, current, step) {
  if (!ids.length) return null;
  const at = ids.indexOf(current);
  return ids[((at < 0 ? 0 : at + step) % ids.length + ids.length) % ids.length];
}

/** The ids from `anchor` through `to` in `ids` order (the range Shift extends). */
export function rangeIds(ids, anchor, to) {
  const from = ids.indexOf(anchor), end = ids.indexOf(to);
  if (from < 0 || end < 0) return end < 0 ? [] : [to];
  return ids.slice(Math.min(from, end), Math.max(from, end) + 1);
}

// ---- Deadlines ------------------------------------------------------------------------------------------------------------

/** The tone a deadline is drawn in, from how many days away it is (the first `deadline_tones` row it fits). */
export function deadlineTone(due, today, data = tray) {
  const day = localDay(due);
  if (day === null) return null;
  const away = daysBetween(today, day);
  return data.deadline_tones.find(row => away <= row.within_days)?.tone ?? null;
}

/** The day a snooze choice means, counted from `today`: a number of days, or the next of a weekday. */
export function snoozeDay(choice, today) {
  if (Number.isInteger(choice.days)) return addDaysTo(today, choice.days);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDaysTo(today, (choice.weekday - weekday + 7) % 7 || 7);
}

/** A duration in minutes as words ("45 min", "2 h", "1 h 30 min"). */
export function durationWords(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The list a task shows under when tasks are grouped by list: its own list, else the built-in list its origin put it in, else the inbox. */
export const effectiveListId = task => task.collection_id || task.smart_list || 'inbox';
