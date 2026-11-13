// Personal Calendar tasks are records in the generic Lists owner, not a second task store.
import data from './calendar-tasks.json' with { type: 'json' };
import { timeZoneName, wallTimeOf } from '../run-work-later-or-on-a-repeat/do-work/wall-time.ts';
import { identityOf } from '../shared-code/src/typed-operation-contract.mjs';
import { zoneDrift } from '../run-work-later-or-on-a-repeat/do-work/zone-drift.ts';
import { checkedWorkingHours, quietHoursAnswer } from '../run-work-later-or-on-a-repeat/do-work/quiet-hours.ts';
import quietModes from '../run-work-later-or-on-a-repeat/do-work/quiet-hours.json' with { type: 'json' };
import { dayOverrideOf } from './parts/ui/show/schedule-calendar/schedule-planner.mjs';
import { classifyMessage } from './calendar-task-messages.mjs';

export class CalendarTasksError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
// Each item through `fn` in turn, never two at once: the order the list writes and reads were made in before they waited.
const inOrder = async (items, fn) => { const out = []; for (const [index, item] of items.entries()) out.push(await fn(item, index)); return out; };

/** @typedef {{ id: string, title: string, parent_id: string|null, collection_id: string|null, description: string, priority: string|null, labels: string[], duration_minutes: number, due: string|null, deadline_type: string|null, start_on: string|null, blocked_by: string[], pinned_until: string|null, auto_placed: boolean, starts_at: string|null, ends_at: string|null, recurrence?: object, source_id: string|null, source_url: string|null, status: string, may_move: boolean, may_cancel: boolean }} CalendarTask */

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validDue = value => typeof value === 'string' && (/^\d{4}-\d{2}-\d{2}$/.test(value)
  ? Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  : Number.isFinite(Date.parse(value)));
const instant = value => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const priorityField = data.list.fields.find(field => field.id === 'priority');
const priorities = priorityField?.choices ?? [];
const defaultPriority = priorityField?.starts ?? null;
const fieldOf = id => data.list.fields.find(field => field.id === id);
const deadlineTypes = fieldOf('deadline_type').choices;
const placers = fieldOf('placed_by').choices;
const smartLists = fieldOf('smart_list').choices;
const schedulingFields = ['minimum_duration_minutes', 'slice_of', 'deadline_type', 'start_on', 'blocked_by', 'pinned_until', 'snoozed_until', 'placed_by'];
const blockersMost = fieldOf('blocked_by').link_constraints.max_links;

function taskDetails(input) {
  const values = {};
  if (Object.hasOwn(input, 'recurrence')) values.recurrence = recurrenceValue(input.recurrence);
  if (Object.hasOwn(input, 'description')) {
    if (input.description !== null && typeof input.description !== 'string') throw new CalendarTasksError(data.words.bad_description);
    const description = input.description?.trim() ?? '';
    if (description.length > data.limits.description_chars) throw new CalendarTasksError(data.words.bad_description);
    values.description = description || null;
  }
  if (Object.hasOwn(input, 'priority')) {
    const priority = input.priority == null || input.priority === '' ? defaultPriority : input.priority;
    if (priority !== null && (typeof priority !== 'string' || !priorities.includes(priority))) throw new CalendarTasksError(data.words.bad_priority);
    values.priority = priority;
  }
  Object.assign(values, schedulingDetails(input));
  if (Object.hasOwn(input, 'time_spent_minutes')) {
    if (!Number.isSafeInteger(input.time_spent_minutes) || input.time_spent_minutes < 0 || input.time_spent_minutes > data.limits.time_spent_minutes) throw new CalendarTasksError(data.words.bad_time_spent);
    values.time_spent_minutes = input.time_spent_minutes || null;
  }
  if (Object.hasOwn(input, 'smart_list')) {
    if (input.smart_list !== null && input.smart_list !== '' && !smartLists.includes(input.smart_list)) throw new CalendarTasksError(data.words.bad_smart_list);
    values.smart_list = input.smart_list === '' ? null : input.smart_list;
  }
  if (Object.hasOwn(input, 'labels')) {
    if (!Array.isArray(input.labels) || input.labels.length > data.limits.labels_per_task) throw new CalendarTasksError(data.words.bad_labels);
    const labels = input.labels.map(label => typeof label === 'string' ? label.trim() : '');
    if (labels.some(label => !label || label.length > data.limits.label_chars)
      || new Set(labels.map(label => label.toLocaleLowerCase())).size !== labels.length) {
      throw new CalendarTasksError(data.words.bad_labels);
    }
    values.labels = labels.length ? labels : null;
  }
  return values;
}

// How the planner (parts/ui schedule-planner) is told to treat a task: the kind of deadline, the earliest start, what must
// end first, and the pin that holds an automatically placed task where a person put it. Every choice and limit is the
// list's own DATA (calendar-tasks.json fields), so a new deadline kind is a new choice row.
function schedulingDetails(input) {
  const values = {};
  if (Object.hasOwn(input, 'minimum_duration_minutes')) {
    const least = input.minimum_duration_minutes;
    if (least !== null && least !== '' && (!Number.isSafeInteger(least) || least < data.slices.least_minutes || least > data.limits.duration_minutes)) throw new CalendarTasksError(data.words.bad_minimum_duration);
    values.minimum_duration_minutes = least === '' ? null : least;
  }
  if (Object.hasOwn(input, 'deadline_type')) {
    if (input.deadline_type !== null && input.deadline_type !== '' && !deadlineTypes.includes(input.deadline_type)) {
      throw new CalendarTasksError(data.words.bad_deadline_type);
    }
    values.deadline_type = input.deadline_type === '' ? null : input.deadline_type;
  }
  for (const [field, words] of [['start_on', data.words.bad_start_on], ['pinned_until', data.words.bad_pinned_until], ['snoozed_until', data.words.bad_snoozed_until]]) {
    if (!Object.hasOwn(input, field)) continue;
    if (input[field] !== null && input[field] !== '' && !validDue(input[field])) throw new CalendarTasksError(words);
    values[field] = input[field] === '' ? null : input[field];
  }
  if (Object.hasOwn(input, 'blocked_by')) {
    const ids = input.blocked_by ?? [];
    if (!Array.isArray(ids) || ids.length > blockersMost || ids.some(id => !nonempty(id) || id.includes('/')) || new Set(ids).size !== ids.length) {
      throw new CalendarTasksError(data.words.bad_blocked_by);
    }
    values.blocked_by = ids.length ? ids : null;
  }
  if (Object.hasOwn(input, 'placed_by')) {
    if (input.placed_by !== null && input.placed_by !== '' && !placers.includes(input.placed_by)) throw new CalendarTasksError(data.words.bad_placed_by);
    values.placed_by = input.placed_by === '' ? null : input.placed_by;
  }
  return values;
}

function recurrenceValue(value) {
  if (value == null || value === '') return null;
  if (!object(value)) throw new CalendarTasksError('Choose a valid task repeat pattern.');
  const { frequencies, weekdays, next_todo_modes, max_interval, max_occurrences } = data.recurrence;
  const frequency = value.frequency;
  if (!frequencies.includes(frequency)) throw new CalendarTasksError('Choose a repeat interval.');
  const interval = Number(value.interval);
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > max_interval) throw new CalendarTasksError(`Repeat interval must be from 1 to ${max_interval}.`);
  if (!Array.isArray(value.weekdays) || value.weekdays.some(day => typeof day !== 'string' || !weekdays.includes(day))
    || new Set(value.weekdays).size !== value.weekdays.length) throw new CalendarTasksError('Choose valid repeat days.');
  if (frequency !== 'week' && value.weekdays.length) throw new CalendarTasksError('Choose repeat days only for a weekly task.');
  if (!object(value.ends)) throw new CalendarTasksError('Choose when this task repeat ends.');
  let ends;
  if (value.ends.kind === 'never') ends = { kind: 'never' };
  else if (value.ends.kind === 'date' && validDue(value.ends.value) && /^\d{4}-\d{2}-\d{2}$/.test(value.ends.value)) {
    ends = { kind: 'date', value: value.ends.value };
  } else if (value.ends.kind === 'count' && Number.isSafeInteger(value.ends.value) && value.ends.value >= 1 && value.ends.value <= max_occurrences) {
    ends = { kind: 'count', value: value.ends.value };
  } else throw new CalendarTasksError('Choose a valid repeat end date or occurrence count.');
  const nextTodo = value.nextTodo ?? next_todo_modes[0];
  if (!next_todo_modes.includes(nextTodo)) throw new CalendarTasksError('Choose when to create the next task.');
  const timeZone = timeZoneName(value.timeZone ?? 'UTC');
  if (!timeZone) throw new CalendarTasksError('Choose a time zone Trillion knows.');
  return { frequency, interval, weekdays: [...value.weekdays].sort((a, b) => weekdays.indexOf(a) - weekdays.indexOf(b)), ends, nextTodo, timeZone };
}

function storedRecurrence(value) {
  if (typeof value !== 'string' || !value) return null;
  try { return recurrenceValue(JSON.parse(value)); } catch { return null; }
}

async function activeRecurrence(lists, row) {
  const series = row.values.recurrence_series ?? row.id;
  const master = series === row.id ? row : await lists.row(data.list.id, series);
  const recurrence = storedRecurrence(master?.values?.recurrence);
  if (!recurrence) return null;
  const masterRevision = Number.isSafeInteger(master.values.recurrence_rule_revision) ? master.values.recurrence_rule_revision : 1;
  const rowRevision = Number.isSafeInteger(row.values.recurrence_rule_revision) ? row.values.recurrence_rule_revision : 1;
  return masterRevision === rowRevision ? recurrence : null;
}

const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const formatDate = value => `${String(value.getUTCFullYear()).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
const addDays = (value, days) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
};
const dateWeekday = value => new Date(`${value}T00:00:00.000Z`).getUTCDay();
const mondayOf = value => addDays(value, -((dateWeekday(value) + 6) % 7));
const daysBetween = (start, end) => Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000);

function localParts(instantValue, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantValue));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}:${value.second}` };
}

function localInstant(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = wanted;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const seen = localParts(guess, timeZone);
    const [seenYear, seenMonth, seenDay] = seen.date.split('-').map(Number);
    const [seenHour, seenMinute, seenSecond] = seen.time.split(':').map(Number);
    const seenAsUtc = Date.UTC(seenYear, seenMonth - 1, seenDay, seenHour, seenMinute, seenSecond);
    const correction = wanted - seenAsUtc;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess).toISOString();
}

function taskLocalDate(row, recurrence, now) {
  const timeZone = recurrence.timeZone;
  if (typeof row.values.due === 'string') {
    if (dateOnly(row.values.due)) return row.values.due;
    const time = Date.parse(row.values.due);
    if (Number.isFinite(time)) return localParts(time, timeZone).date;
  }
  if (typeof row.values.starts_at === 'string') {
    const time = Date.parse(row.values.starts_at);
    if (Number.isFinite(time)) return localParts(time, timeZone).date;
  }
  if (dateOnly(row.values.recurrence_anchor_date)) return row.values.recurrence_anchor_date;
  return localParts(now, timeZone).date;
}

function taskLocalTime(row, recurrence) {
  for (const field of ['due', 'starts_at']) {
    const value = row.values[field];
    if (typeof value !== 'string' || dateOnly(value)) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return localParts(time, recurrence.timeZone).time;
  }
  return '00:00:00';
}

function nextRecurrenceDate(currentDate, anchorDate, recurrence) {
  if (recurrence.frequency === 'day') return addDays(currentDate, recurrence.interval);
  if (recurrence.frequency === 'week') {
    if (!recurrence.weekdays.length) return addDays(currentDate, recurrence.interval * 7);
    const weekdayValues = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const anchorWeek = mondayOf(anchorDate);
    for (let offset = 1; offset <= recurrence.interval * 7 + 7; offset += 1) {
      const candidate = addDays(currentDate, offset);
      const weekIndex = Math.floor(daysBetween(anchorWeek, mondayOf(candidate)) / 7);
      const day = Object.entries(weekdayValues).find(([, number]) => number === dateWeekday(candidate))?.[0];
      if (weekIndex >= 0 && weekIndex % recurrence.interval === 0 && day && recurrence.weekdays.includes(day)) return candidate;
    }
    return null;
  }
  const anchor = new Date(`${anchorDate}T00:00:00.000Z`);
  const current = new Date(`${currentDate}T00:00:00.000Z`);
  const targetYear = recurrence.frequency === 'year' ? current.getUTCFullYear() + recurrence.interval : current.getUTCFullYear();
  const targetMonth = recurrence.frequency === 'month' ? current.getUTCMonth() + recurrence.interval : anchor.getUTCMonth();
  const first = new Date(Date.UTC(targetYear, targetMonth, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(anchor.getUTCDate(), lastDay));
  return formatDate(first);
}

function nextTaskValues(row, recurrence, now) {
  const series = row.values.recurrence_series ?? row.id;
  const index = Number.isSafeInteger(row.values.recurrence_index) && row.values.recurrence_index >= 1 ? row.values.recurrence_index : 1;
  const ruleRevision = Number.isSafeInteger(row.values.recurrence_rule_revision) && row.values.recurrence_rule_revision >= 1
    ? row.values.recurrence_rule_revision : 1;
  const nextIndex = index + 1;
  if (recurrence.ends.kind === 'count' && nextIndex > recurrence.ends.value) return null;
  const anchorDate = dateOnly(row.values.recurrence_anchor_date) ? row.values.recurrence_anchor_date : taskLocalDate(row, recurrence, now);
  const scheduledDate = taskLocalDate(row, recurrence, now);
  const completedDate = localParts(now, recurrence.timeZone).date;
  // Completing a future occurrence early must still advance beyond that
  // occurrence, rather than minting another task for the same day.
  const baseDate = recurrence.nextTodo === 'when_done' && completedDate > scheduledDate
    ? completedDate : scheduledDate;
  const nextDate = nextRecurrenceDate(baseDate, anchorDate, recurrence);
  if (!nextDate || (recurrence.ends.kind === 'date' && nextDate > recurrence.ends.value)) return null;
  const childId = ruleRevision === 1 ? `${series}-repeat-${nextIndex}` : `${series}-rule-${ruleRevision}-repeat-${nextIndex}`;
  if (childId.length > 200) throw new CalendarTasksError('This repeat series is too long to create another task.');
  const values = {
    title: row.values.title,
    description: row.values.description ?? '',
    priority: row.values.priority ?? defaultPriority,
    labels: row.values.labels ?? [],
    duration_minutes: row.values.duration_minutes,
    recurrence: row.values.recurrence,
    recurrence_series: series,
    recurrence_index: nextIndex,
    recurrence_rule_revision: ruleRevision,
    recurrence_anchor_date: anchorDate,
    ...(row.values.collection_id ? { collection_id: Array.isArray(row.values.collection_id) ? row.values.collection_id[0] : row.values.collection_id } : {}),
    ...(row.values.source_id ? { source_id: row.values.source_id } : {}),
    ...(row.values.source_url ? { source_url: row.values.source_url } : {}),
    ...(row.values.parent_id ? { parent_id: row.values.parent_id } : {}),
  };
  if (typeof row.values.due === 'string') {
    if (dateOnly(row.values.due)) values.due = nextDate;
    else {
      const dueAt = Date.parse(row.values.due);
      if (Number.isFinite(dueAt)) values.due = localInstant(nextDate, localParts(dueAt, recurrence.timeZone).time, recurrence.timeZone);
    }
  } else values.due = nextDate;
  if (typeof row.values.starts_at === 'string') {
    const startAt = Date.parse(row.values.starts_at);
    if (Number.isFinite(startAt)) {
      const nextStart = localInstant(nextDate, localParts(startAt, recurrence.timeZone).time, recurrence.timeZone);
      values.starts_at = nextStart;
      values.ends_at = new Date(Date.parse(nextStart) + row.values.duration_minutes * 60_000).toISOString();
    }
  }
  return { id: childId, values };
}

const recurrenceReadFields = data.list.fields.map(field => field.id);

/** Runs one bounded scheduler page, creating only date-based occurrences whose day has arrived. A store holding no task
 * list has no task to repeat: the page is finished and writes nothing. Making the list here put the built-in calendar
 * lists into every work resource the scheduler woke (133 of one account's 412 on 2026-10-20), and each then published the
 * same list ids to the account's one discovery index, which refuses a second owner of an id, so every list read waited. */
export async function runCalendarTaskRecurrencePage(lists, { cursor, now = Date.now(), limit = 50 } = {}) {
  if (!await lists.has(data.list.id)) return { next_cursor: null, complete: true, next_at: null, created: 0 };
  await ensureTaskList(lists);
  const rule = await statusRule(lists);
  const page = await lists.read(data.list.id, { only: recurrenceReadFields, limit, ...(cursor ? { cursor } : {}) });
  let nextAt = null;
  const writes = [];
  const atFor = (row, recurrence) => {
    if (!['on_day_when_done', 'on_day_even_if_open', 'direct_even_if_open'].includes(recurrence.nextTodo)) return null;
    const scheduledDate = taskLocalDate(row, recurrence, now);
    const anchorDate = dateOnly(row.values.recurrence_anchor_date) ? row.values.recurrence_anchor_date : scheduledDate;
    const nextDate = nextRecurrenceDate(scheduledDate, anchorDate, recurrence);
    if (!nextDate || (recurrence.ends.kind === 'date' && nextDate > recurrence.ends.value)) return null;
    const index = Number.isSafeInteger(row.values.recurrence_index) && row.values.recurrence_index >= 1 ? row.values.recurrence_index : 1;
    if (recurrence.ends.kind === 'count' && index + 1 > recurrence.ends.value) return null;
    if (recurrence.nextTodo === 'on_day_when_done' && !settledBy(rule, row)) return null;
    return Date.parse(localInstant(nextDate, taskLocalTime(row, recurrence), recurrence.timeZone));
  };
  for (const row of page.rows) {
    const recurrence = await activeRecurrence(lists, row);
    if (!recurrence) continue;
    const hasOwnDate = ['due', 'starts_at'].some(field => typeof row.values[field] === 'string' && Number.isFinite(Date.parse(row.values[field])));
    if (!hasOwnDate && !dateOnly(row.values.recurrence_anchor_date)) {
      const anchor = localParts(now, recurrence.timeZone).date;
      writes.push({ id: row.id, values: { recurrence_anchor_date: anchor } });
    }
    const candidateAt = atFor(row, recurrence);
    if (candidateAt === null) continue;
    const series = row.values.recurrence_series ?? row.id;
    const index = Number.isSafeInteger(row.values.recurrence_index) && row.values.recurrence_index >= 1 ? row.values.recurrence_index : 1;
    const ruleRevision = Number.isSafeInteger(row.values.recurrence_rule_revision) && row.values.recurrence_rule_revision >= 1
      ? row.values.recurrence_rule_revision : 1;
    const childId = ruleRevision === 1 ? `${series}-repeat-${index + 1}` : `${series}-rule-${ruleRevision}-repeat-${index + 1}`;
    if (await lists.row(data.list.id, childId)) continue;
    if (candidateAt <= now) {
      const child = nextTaskValues(row, recurrence, candidateAt);
      if (child) {
        writes.push(child);
        const childRecurrence = recurrence;
        const nextDate = dateOnly(child.values.due) ? child.values.due : taskLocalDate({ id: child.id, values: child.values }, recurrence, now);
        const anchorDate = dateOnly(child.values.recurrence_anchor_date) ? child.values.recurrence_anchor_date : nextDate;
        const afterDate = nextRecurrenceDate(nextDate, anchorDate, childRecurrence);
        if (childRecurrence.nextTodo !== 'on_day_when_done' && afterDate && !(childRecurrence.ends.kind === 'date' && afterDate > childRecurrence.ends.value)
          && !(childRecurrence.ends.kind === 'count' && index + 2 > childRecurrence.ends.value)) {
          const afterAt = Date.parse(localInstant(afterDate, taskLocalTime({ id: child.id, values: child.values }, childRecurrence), childRecurrence.timeZone));
          if (nextAt === null || afterAt < nextAt) nextAt = afterAt;
        }
      }
    } else if (nextAt === null || candidateAt < nextAt) nextAt = candidateAt;
  }
  if (writes.length) await lists.putRows(data.list.id, { rows: writes }, { actor: { by: 'calendar-recurrence' } });
  const complete = page.page.complete;
  const nextCursor = complete ? null : page.page.next_cursor;
  if (!complete && (!nextCursor || nextCursor === cursor)) throw new Error('The Calendar task recurrence page did not advance its cursor.');
  return { next_cursor: nextCursor, complete, next_at: nextAt, created: writes.length };
}

function provenance(input) {
  const values = {};
  if (Object.hasOwn(input, 'source_id')) {
    if (input.source_id !== null && input.source_id !== ''
      && (!nonempty(input.source_id) || input.source_id.trim().length > data.limits.source_id_chars)) {
      throw new CalendarTasksError('Source ID must be 500 characters or fewer.');
    }
    values.source_id = input.source_id === '' ? null : input.source_id?.trim() ?? null;
  }
  if (Object.hasOwn(input, 'source_url')) {
    if (input.source_url !== null && input.source_url !== '') {
      if (typeof input.source_url !== 'string' || input.source_url.length > data.limits.source_url_chars) {
        throw new CalendarTasksError('Source URL must be 2048 characters or fewer.');
      }
      let url;
      try { url = new URL(input.source_url); } catch { throw new CalendarTasksError('Source URL must be an HTTP or HTTPS link.'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new CalendarTasksError('Source URL must be an HTTP or HTTPS link.');
      values.source_url = url.href;
    } else values.source_url = null;
  }
  return values;
}
// The Status field is the person's DATA: its starting choice and the choices that settle a task come from the store's own
// definition of the field, read on every call. A task is settled when its status (a cleared status means the starting one) is in `settles`.
async function statusRule(lists) {
  const field = ((await lists.find(data.list.id))?.fields ?? []).find(item => item.id === 'status');
  if (!field || !Array.isArray(field.choices) || !field.choices.includes(field.starts) || !Array.isArray(field.settles)
    || !field.settles.length || !field.settles.every(choice => field.choices.includes(choice))) throw new CalendarTasksError(data.words.bad_status);
  return { choices: field.choices, starts: field.starts, settles: field.settles };
}
const settledBy = (rule, row) => rule.settles.includes(row.values.status ?? rule.starts);

const taskOf = (row, rule) => {
  const recurrence = storedRecurrence(row.values.recurrence);
  return {
    id: row.id,
    title: row.values.title,
    parent_id: Array.isArray(row.values.parent_id) ? row.values.parent_id[0] ?? null : row.values.parent_id ?? null,
    collection_id: Array.isArray(row.values.collection_id) ? row.values.collection_id[0] ?? null : row.values.collection_id ?? null,
    ...(row.values.duplicate_of ? { duplicate_of: Array.isArray(row.values.duplicate_of) ? row.values.duplicate_of[0] : row.values.duplicate_of } : {}),
    description: row.values.description ?? '',
    priority: row.values.priority ?? defaultPriority,
    labels: Array.isArray(row.values.labels) ? row.values.labels : [],
    duration_minutes: row.values.duration_minutes,
    due: row.values.due ?? null,
    minimum_duration_minutes: row.values.minimum_duration_minutes ?? null,
    slice_of: row.values.slice_of ?? null,
    deadline_type: row.values.deadline_type ?? null,
    start_on: row.values.start_on ?? null,
    blocked_by: Array.isArray(row.values.blocked_by) ? row.values.blocked_by : row.values.blocked_by ? [row.values.blocked_by] : [],
    pinned_until: row.values.pinned_until ?? null,
    snoozed_until: row.values.snoozed_until ?? null,
    created_at: row.values.created_at ?? null,
    time_spent_minutes: row.values.time_spent_minutes ?? 0,
    progress: row.values.progress ?? null,
    smart_list: row.values.smart_list ?? null,
    auto_placed: row.values.placed_by !== undefined && row.values.placed_by !== null,
    starts_at: row.values.starts_at ?? null,
    ends_at: row.values.ends_at ?? null,
    ...(recurrence ? { recurrence } : {}),
    source_id: row.values.source_id ?? null,
    source_url: row.values.source_url ?? null,
    status: row.values.status ?? rule.starts,
    may_move: !settledBy(rule, row),
    may_cancel: Boolean(row.values.starts_at) && !settledBy(rule, row),
  };
};

// The built-in calendar lists, the task list first (it links to the others), as calendar-tasks.json declares them.
const builtInLists = () => [data.list, data.collections, data.day_hours, data.working_hours];

/** True when every built-in calendar list this store holds is as the calendar made it: no row, no field the person added and
 * no saved view. Such lists in a store the calendar never reads were made only by the recurrence step (before 2026-10-20). */
export async function calendarListsUnused(lists) {
  const present = [];
  for (const shape of builtInLists()) if (await lists.has(shape.id)) present.push(shape);
  return present.length > 0 && (await inOrder(present, async shape => {
    const list = await lists.find(shape.id);
    const declared = new Set(shape.fields.map(field => field.id));
    return (await lists.read(shape.id, { limit: 1 })).rows.length === 0
      && (list.fields ?? []).every(field => declared.has(field.id)) && !(list.views ?? []).length;
  })).every(Boolean);
}

/** Removes the unused built-in calendar lists (calendarListsUnused) through the lists' own removal; a store holding any row,
 * field or view of them keeps every one. Answers how many lists were removed. */
export async function withdrawUnusedCalendarLists(lists) {
  if (!await calendarListsUnused(lists)) return 0;
  let removed = 0;
  for (const shape of builtInLists()) {
    if (!await lists.has(shape.id)) continue;
    await lists.save({ id: shape.id, remove: true }, { actor: { by: 'calendar' } });
    removed += 1;
  }
  return removed;
}

// Every built-in list is made when missing and, when a store holds an older shape of it, brought to the declared one: fields
// added (kept alongside any the person added), choices changed and the order index. This is how a field added to
// calendar-tasks.json reaches a store made before it.
// A choice field's choices, starts and settles are the person's DATA once the store holds them: the shipped shape only seeds
// the ones it lacks. Everything else about a field (kind, links, constraints, removal) is the shape's, so it reaches old stores.
const choiceDataKeys = ['choices', 'starts', 'settles'];
function keptChoiceData(field, saved) {
  if (field.kind !== 'choice' || saved?.kind !== 'choice') return field;
  return { ...field, ...Object.fromEntries(choiceDataKeys.filter(key => key in saved).map(key => [key, saved[key]])) };
}

async function upgradeList(lists, shape) {
  const current = await lists.find(shape.id);
  if (!current) return;
  const currentFields = current.fields ?? [];
  const currentById = new Map(currentFields.map(field => [field.id, field]));
  const known = new Set(shape.fields.map(field => field.id));
  const shaped = shape.fields.map(field => keptChoiceData(field, currentById.get(field.id)));
  const fields = [...shaped, ...currentFields.filter(field => !known.has(field.id))];
  const ordered = Boolean(shape.indexes);
  if (shaped.some(field => {
    const saved = currentById.get(field.id);
    return saved?.kind !== field.kind || saved?.links_to !== field.links_to
      || JSON.stringify(saved?.link_constraints ?? null) !== JSON.stringify(field.link_constraints ?? null)
      || choiceDataKeys.some(key => JSON.stringify(saved?.[key] ?? null) !== JSON.stringify(field[key] ?? null))
      || saved?.on_target_remove !== field.on_target_remove || saved?.pairs_with !== field.pairs_with
      || JSON.stringify(saved?.rollup ?? null) !== JSON.stringify(field.rollup ?? null) || JSON.stringify(saved?.derive ?? null) !== JSON.stringify(field.derive ?? null);
  }) || (ordered && (JSON.stringify(current.indexes ?? []) !== JSON.stringify(shape.indexes)
    || JSON.stringify(current.ordering ?? null) !== JSON.stringify(shape.ordering)))) {
    await lists.save({ ...current, id: shape.id, fields, ...(ordered ? { indexes: shape.indexes, ordering: shape.ordering } : {}) }, { actor: { by: 'calendar' } });
  }
}

async function ensureTaskList(lists) {
  await lists.ensure(data.collections, { actor: { by: 'calendar' } });
  await lists.ensure(data.day_hours, { actor: { by: 'calendar' } });
  await lists.ensure(data.working_hours, { actor: { by: 'calendar' } });
  await lists.ensure(data.list, { actor: { by: 'calendar' } });
  for (const shape of builtInLists()) await upgradeList(lists, shape);
}

export async function readCalendarTasks(lists, { from, to, cursor, collection_cursor, task_id, sort = 'date' } = {}) {
  await ensureTaskList(lists);
  if (!['date', 'manual'].includes(sort)) throw new CalendarTasksError('Choose date or manual task order.');
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > (sort === 'manual' ? 600 : 200) || cursor.includes('/'))) {
    throw new CalendarTasksError('The task page cursor is invalid.');
  }
  const start = from === undefined || from === null || from === '' ? null : Date.parse(from);
  const end = to === undefined || to === null || to === '' ? null : Date.parse(to);
  if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end)) || (start !== null && end !== null && end <= start)) {
    throw new CalendarTasksError('The calendar task date range is invalid.');
  }
  const rows = [];
  const page = await lists.read(data.list.id, {
    only: data.list.fields.map(field => field.id), limit: 50, ...(sort === 'manual' ? { order: true } : {}),
    ...(cursor ? { cursor } : {}),
  });
  rows.push(...page.rows);
  // A pane opened on an exact task must not silently show a new draft because
  // that row is beyond the first page. Relationships retain normal bounded paging.
  if (task_id !== undefined) {
    const selected = await taskRow(lists, task_id);
    if (!rows.some(row => row.id === selected.id)) rows.push(selected);
  }
  const complete = page.page.complete;
  const nextCursor = page.page.next_cursor;
  const rule = await statusRule(lists);
  const tasks = rows.map(row => taskOf(row, rule)).filter(task => {
    // Keep unscheduled work visible beside the calendar; show scheduled work only where it overlaps the requested span.
    if (!task.starts_at) return true;
    const taskStart = Date.parse(task.starts_at);
    const taskEnd = Date.parse(task.ends_at ?? task.starts_at);
    // An exact-task pane is a record view, so its selected row stays visible
    // even when its scheduled time falls outside the calendar's current range.
    return (task_id !== undefined && task.id === task_id)
      || ((start === null || taskEnd > start) && (end === null || taskStart < end));
  });
  if (sort !== 'manual') tasks.sort((a, b) => {
    if (!a.starts_at && b.starts_at) return -1;
    if (a.starts_at && !b.starts_at) return 1;
    return (Date.parse(a.starts_at ?? a.due ?? 0) || 0) - (Date.parse(b.starts_at ?? b.due ?? 0) || 0) || a.title.localeCompare(b.title);
  });
  const collectionPage = await readCalendarTaskCollections(lists, { cursor: collection_cursor });
  return {
    list_id: data.list.id, tasks, collections: collectionPage.collections,
    collections_page: collectionPage.page, page: { complete, next_cursor: nextCursor },
    day_hours: await readDayHours(lists, from, to),
    capacity: await capacityOf(lists),
    working_hours: workingHoursOf(await lists.row(data.working_hours.id, data.working_hours.row_id)),
    preferences: Object.fromEntries(await inOrder(preferenceNames, async name => [name, await preferenceOf(lists, name)])),
    ...(sort === 'manual' ? { ordering: page.ordering } : {}),
  };
}

export async function readCalendarTaskCollections(lists, { cursor } = {}) {
  await ensureTaskList(lists);
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 600 || cursor.includes('/'))) {
    throw new CalendarTasksError('The task list page cursor is invalid.');
  }
  const page = await lists.read(data.collections.id, {
    only: data.collections.fields.map(field => field.id), limit: 50, order: true,
    ...(cursor ? { cursor } : {}),
  });
  return {
    collections: page.rows.map(collectionOf),
    page: { complete: page.page.complete, next_cursor: page.page.next_cursor },
  };
}

function requestKeyOf(value) {
  if (!nonempty(value) || value.trim().length > 160 || value.includes('/')) throw new CalendarTasksError(data.words.bad_key);
  return value.trim();
}

async function taskRow(lists, taskId) {
  if (!nonempty(taskId)) throw new CalendarTasksError(data.words.bad_task);
  const row = await lists.row(data.list.id, taskId);
  if (!row) throw new CalendarTasksError(data.words.bad_task);
  return row;
}

async function checkedCollection(lists, collectionId) {
  if (collectionId == null || collectionId === '') return null;
  if (!nonempty(collectionId) || collectionId.includes('/') || !await lists.row(data.collections.id, collectionId)) {
    throw new CalendarTasksError('Choose a task list that still exists.');
  }
  return collectionId;
}

// A list's settings are the fields of calendar-tasks.json `collections` that name an `api` kind. The kind says how a value
// the caller gives is checked and stored, and how a stored one is answered, so a new setting is a new field row.
const schemaTypes = {
  text: value => nonempty(value) && value.length <= data.limits.title_chars && !value.includes('/'),
  minute: value => Number.isSafeInteger(value) && value >= 0 && value <= 1440,
  weekdays: value => Array.isArray(value) && value.length <= 7 && new Set(value).size === value.length && value.every(day => Number.isSafeInteger(day) && day >= 0 && day <= 6),
};
const collectionApi = {
  title: {
    write: (_field, value) => {
      const title = typeof value === 'string' ? value.trim() : '';
      if (!title || title.length > data.limits.title_chars) throw new CalendarTasksError(data.words.bad_collection);
      return title;
    },
    read: (_field, stored) => stored ?? '',
  },
  choice: {
    write: (field, value) => {
      if (value !== null && !field.choices.includes(value)) throw new CalendarTasksError(data.words.bad_collection_field);
      return value;
    },
    read: (_field, stored) => stored ?? null,
  },
  flag: {
    write: (_field, value) => {
      if (value !== null && typeof value !== 'boolean') throw new CalendarTasksError(data.words.bad_collection_field);
      return value ? 'yes' : null;
    },
    read: (_field, stored) => stored === 'yes',
  },
  yes_no: {
    write: (_field, value) => {
      if (value !== null && typeof value !== 'boolean') throw new CalendarTasksError(data.words.bad_collection_field);
      return value === null ? null : value ? 'yes' : 'no';
    },
    read: (_field, stored) => (stored === 'yes' ? true : stored === 'no' ? false : null),
  },
  json: {
    write: (field, value) => {
      if (value === null) return null;
      const bad = () => new CalendarTasksError(data.words.bad_collection_field);
      if (!object(value)) throw bad();
      const wanted = Object.entries(field.schema).map(([key, type]) => ({ key: key.replace(/\?$/, ''), type, optional: key.endsWith('?') }));
      if (Object.keys(value).some(key => !wanted.some(row => row.key === key))) throw bad();
      const kept = {};
      for (const { key, type, optional } of wanted) {
        if (value[key] === undefined || value[key] === null) { if (optional) continue; throw bad(); }
        if (!schemaTypes[type](value[key])) throw bad();
        kept[key] = type === 'weekdays' ? [...value[key]].sort((a, b) => a - b) : value[key];
      }
      const [low, high] = field.ordered ?? [];
      if (low && kept[low] >= kept[high]) throw bad();
      return JSON.stringify(kept);
    },
    read: (_field, stored) => { try { return stored ? JSON.parse(stored) : null; } catch { return null; } },
  },
};
const collectionApiFields = data.collections.fields.filter(field => field.api);

function collectionOf(row) {
  return { id: row.id, ...Object.fromEntries(collectionApiFields.map(field => [field.id, collectionApi[field.api].read(field, row.values[field.id])])) };
}

/** The stored values for the settings the input names (null clears one); a setting not named is left as it is. */
function collectionValues(input) {
  const values = {};
  for (const field of collectionApiFields) {
    if (!Object.hasOwn(input, field.id)) continue;
    const given = input[field.id] === '' ? null : input[field.id];
    values[field.id] = collectionApi[field.api].write(field, given === undefined ? null : given);
  }
  return values;
}

/** The reorder that puts a list back between its neighbours, or null when its place is past the first page of lists. */
async function collectionReorderUndo(lists, id) {
  const page = await lists.read(data.collections.id, { only: ['title'], limit: 200, order: true });
  const ids = page.rows.map(row => row.id);
  const at = ids.indexOf(id);
  if (at < 0) return null;
  if (at > 0) return { action: 'reorder_collection', collection_id: id, anchor_id: ids[at - 1], placement: 'after' };
  return ids.length > 1 ? { action: 'reorder_collection', collection_id: id, anchor_id: ids[1], placement: 'before' } : null;
}

/** The input that puts the named settings of a list back to what the row held. */
const collectionRestore = (row, names) => Object.fromEntries(names.map(name => [name, collectionOf(row)[name]]));

function editableFields(input) {
  const values = { ...provenance(input), ...taskDetails(input) };
  if (Object.hasOwn(values, 'recurrence') && values.recurrence !== null) values.recurrence = JSON.stringify(values.recurrence);
  if (Object.hasOwn(input, 'title')) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > data.limits.title_chars) throw new CalendarTasksError(data.words.bad_title);
    values.title = title;
  }
  if (Object.hasOwn(input, 'parent_id')) values.parent_id = input.parent_id == null || input.parent_id === '' ? null : input.parent_id;
  if (Object.hasOwn(input, 'collection_id')) values.collection_id = input.collection_id == null || input.collection_id === '' ? null : input.collection_id;
  if (Object.hasOwn(input, 'duration_minutes')) {
    if (!Number.isSafeInteger(input.duration_minutes) || input.duration_minutes < 1 || input.duration_minutes > data.limits.duration_minutes) {
      throw new CalendarTasksError(data.words.bad_duration);
    }
    values.duration_minutes = input.duration_minutes;
  }
  if (Object.hasOwn(input, 'due')) {
    if (input.due !== null && input.due !== '' && !validDue(input.due)) throw new CalendarTasksError(data.words.bad_due);
    values.due = input.due === '' ? null : input.due;
  }
  if (!Object.keys(values).length) throw new CalendarTasksError('Change the task title, description, priority, labels, duration, due date, repeat rule or source.');
  return values;
}

const parentIdOf = row => Array.isArray(row?.values?.parent_id)
  ? row.values.parent_id[0] ?? null : row?.values?.parent_id ?? null;

async function checkedParent(lists, parentId, childId = null) {
  if (parentId == null || parentId === '') return null;
  if (!nonempty(parentId) || parentId.includes('/')) throw new CalendarTasksError('Choose a parent task from Calendar tasks.');
  let currentId = parentId;
  const seen = new Set();
  while (currentId) {
    if (currentId === childId) throw new CalendarTasksError('A task cannot be its own ancestor.');
    if (seen.has(currentId)) throw new CalendarTasksError('The task parent chain already contains a cycle.');
    seen.add(currentId);
    const row = await lists.row(data.list.id, currentId);
    if (!row) throw new CalendarTasksError(data.words.bad_parent);
    currentId = parentIdOf(row);
  }
  return parentId;
}

// ---- Undo, restore and rollover ---------------------------------------------------------------------------------------
// Every change answers with `undo`: the one `restore` action that puts the changed fields back while they are still as
// the change left them. Rollover and restore build theirs the same way, from the rows before and after.
const unrestorable = new Set(data.undo.excluded_fields);
const restorableFields = data.list.fields.map(field => field.id).filter(id => !unrestorable.has(id));
const stored = value => value === undefined ? null : value;
const same = (left, right) => JSON.stringify(stored(left)) === JSON.stringify(stored(right));

function undoFor(changes) {
  const rows = [];
  for (const { id, before, after } of changes) {
    if (!before && !after) continue;
    // Something outside the restorable fields changed (a repeat rule, the list order): this change cannot be taken back honestly.
    if (before && after && [...unrestorable].some(field => !same(before.values[field], after.values[field]))) return null;
    if (!before) rows.push({ task_id: id, remove: true });
    else if (!after) {
      if ([...unrestorable].some(field => field !== 'manual_order' && stored(before.values[field]) !== null)) return null;
      rows.push({ task_id: id, create: Object.fromEntries(restorableFields.filter(field => stored(before.values[field]) !== null).map(field => [field, before.values[field]])) });
    } else {
      const changed = restorableFields.filter(field => !same(before.values[field], after.values[field]));
      if (changed.length) rows.push({ task_id: id, values: Object.fromEntries(changed.map(field => [field, stored(before.values[field])])), expected: Object.fromEntries(changed.map(field => [field, stored(after.values[field])])) });
    }
  }
  return rows.length && rows.length <= data.undo.most_rows ? { action: 'restore', rows } : null;
}

// Checked values to write for a set of restorable fields, through the validators every other change uses.
// A task is settled only when the work it is linked to is finished.
//  - A task linked to a Workshop workflow (source_id "workflow:<slug>") needs that workflow's latest run verdict to have
//    passed. The run judge writes the verdict as the capability-check row capability-check:workflow-run-<slug> in the list
//    everything-still-working; its state is the verdict. No row, or any state but passed, refuses.
//  - A task a lane-job link row names (the launcher's link row: data.job_link.link, value {job, task}) needs every job those
//    rows name for it to be done with a result (data.job_link). The jobs come from options.jobs, the owner's reader of the person's
//    job records, and the keys of the jobs the link rows name for this task from options.jobsOfTask. The task's description is not
//    read: the link row is the only link. A caller with no jobsOfTask reader (a test, never the owner) sees no link.
const WORKFLOW_VERDICT_LIST = 'everything-still-working';
async function refuseUnlessLinkedWorkIsFinished(lists, row, options = {}) {
  const link = row?.values?.source_id;
  if (typeof link === 'string' && link.startsWith('workflow:')) {
    const slug = link.slice('workflow:'.length);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new CalendarTasksError(`This task names workflow ${slug}, which is not a workflow name.`);
    const verdict = (await lists.row(WORKFLOW_VERDICT_LIST, `capability-check:workflow-run-${slug}`))?.values;
    if (verdict?.state !== 'passed') {
      throw new CalendarTasksError(`This task is linked to workflow ${slug}, and its latest run verdict is ${verdict?.state ?? 'missing'}, not passed. Run the workflow's check before marking it done.`);
    }
  }
  const named = typeof options.jobsOfTask === 'function' ? [...new Set(await options.jobsOfTask(row.id))] : [];
  for (const key of named) {
    if (typeof options.jobs !== 'function') throw new CalendarTasksError(`This task is linked to ${data.job_link.record_type}:${key}, and this owner cannot read the job, so it cannot say the job is finished.`);
    const job = await options.jobs(key);
    const result = job?.[data.job_link.result_field];
    if (job?.status !== data.job_link.settled_status || typeof result !== 'string' || !result.trim()) {
      throw new CalendarTasksError(`This task is linked to ${data.job_link.record_type}:${key}, and that job is ${job ? `${job.status ?? 'without a status'}${job.status === data.job_link.settled_status ? ' but has no result' : ''}` : 'not found'}. Finish the job with a result before marking the task done.`);
    }
  }
}

async function restoreValues(lists, taskId, given, options) {
  const rule = await statusRule(lists);
  if (!object(given) || !Object.keys(given).length) throw new CalendarTasksError(data.words.bad_restore);
  const values = {};
  const input = {};
  for (const [field, value] of Object.entries(given)) {
    if (!restorableFields.includes(field)) throw new CalendarTasksError(data.words.bad_restore);
    if (['starts_at', 'ends_at'].includes(field)) {
      if (value !== null && !instant(value)) throw new CalendarTasksError(field === 'starts_at' ? data.words.bad_start : data.words.bad_end);
      values[field] = value === null ? null : instant(value);
    } else if (field === 'status') {
      if (value !== null && !rule.choices.includes(value)) throw new CalendarTasksError(data.words.bad_restore);
      // A task that was settled is reopened by clearing the status, as the reopen action does; the starting status is the cleared one.
      if (rule.settles.includes(value)) await refuseUnlessLinkedWorkIsFinished(lists, await lists.row(data.list.id, taskId), options);
      values.status = value === rule.starts ? null : value;
    } else if (field === 'collection_id') values.collection_id = await checkedCollection(lists, value);
    else if (field === 'parent_id') values.parent_id = await checkedParent(lists, value, taskId);
    else if (field === 'duplicate_of') {
      if (value !== null && (!nonempty(value) || value.includes('/'))) throw new CalendarTasksError(data.words.bad_restore);
      values.duplicate_of = value;
    } else input[field] = field === 'labels' && value === null ? [] : value;
  }
  if (Object.keys(input).length) Object.assign(values, editableFields(input));
  return values;
}

async function restoreTasks(lists, input, options) {
  const rule = await statusRule(lists);
  const rows = input.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > data.undo.most_rows) throw new CalendarTasksError(data.words.bad_restore);
  const plan = [];
  const changes = [];
  for (const entry of rows) {
    if (!object(entry) || !nonempty(entry.task_id) || entry.task_id.includes('/')) throw new CalendarTasksError(data.words.bad_restore);
    const row = await lists.row(data.list.id, entry.task_id);
    if (entry.remove === true) {
      if (!row) throw new CalendarTasksError(data.words.restore_changed);
      plan.push({ remove: row.id });
      changes.push({ id: row.id, before: row, after: null });
    } else if (object(entry.create)) {
      if (row || !entry.task_id.startsWith('calendar-')) throw new CalendarTasksError(data.words.restore_changed);
      if (!nonempty(entry.create.title) || !Number.isSafeInteger(entry.create.duration_minutes)) throw new CalendarTasksError(data.words.bad_restore);
      plan.push({ row: { id: entry.task_id, values: await restoreValues(lists, entry.task_id, entry.create, options) } });
      changes.push({ id: entry.task_id, before: null, after: { id: entry.task_id, values: entry.create } });
    } else {
      if (!row || !object(entry.expected) || !object(entry.values)
        || Object.keys(entry.expected).length !== Object.keys(entry.values).length
        || Object.keys(entry.values).some(field => !Object.hasOwn(entry.expected, field))) throw new CalendarTasksError(data.words.restore_changed);
      // Compared as stored: a list that holds links answers them as lists.
      const now = field => {
        const value = row.values[field];
        return Array.isArray(value) && ['parent_id', 'collection_id', 'duplicate_of'].includes(field) ? value[0] ?? null : value;
      };
      if (Object.keys(entry.expected).some(field => !same(now(field), entry.expected[field]))) throw new CalendarTasksError(data.words.restore_changed);
      const values = await restoreValues(lists, row.id, entry.values, options);
      plan.push({ row: { id: row.id, values } });
      changes.push({ id: row.id, before: row, after: { id: row.id, values: { ...row.values, ...values } } });
    }
  }
  // One write for all of them: either every task is put back or none is.
  const saved = await lists.putRows(data.list.id, { rows: plan.filter(step => step.row).map(step => step.row), remove: plan.filter(step => step.remove).map(step => step.remove) }, { actor: { by: 'calendar' } });
  const after = new Map(saved.kept.map(row => [row.id, row]));
  // The way back from a restore is the restore of what it replaced.
  const undo = undoFor(changes.map(change => ({ id: change.id, before: change.before, after: after.get(change.id) ?? null })));
  return { restored: changes.length, tasks: changes.filter(change => after.has(change.id)).map(change => taskOf(after.get(change.id), rule)), ...(undo ? { undo } : {}) };
}

async function openTasks(lists, wanted) {
  const rule = await statusRule(lists);
  if (wanted !== undefined) {
    if (!Array.isArray(wanted) || !wanted.length || wanted.length > data.rollover.most_tasks) throw new CalendarTasksError(data.words.bad_rollover);
    return inOrder(wanted, async id => await taskRow(lists, id));
  }
  const rows = [];
  let cursor;
  do {
    const page = await lists.read(data.list.id, { only: data.list.fields.map(field => field.id), limit: 50, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows.filter(row => !settledBy(rule, row)));
    cursor = page.page.complete ? undefined : page.page.next_cursor;
    if (rows.length > data.rollover.most_tasks) throw new CalendarTasksError(data.words.rollover_too_many);
  } while (cursor);
  return rows;
}

async function rolloverTasks(lists, input) {
  const rule = await statusRule(lists);
  if (!dateOnly(input.today) || !timeZoneName(input.time_zone)) throw new CalendarTasksError(data.words.bad_rollover);
  const zone = timeZoneName(input.time_zone);
  const today = input.today;
  const reasons = data.rollover.skip_reasons;
  const carried = [];
  const skipped = [];
  const writes = [];
  const changes = [];
  for (const row of await openTasks(lists, input.task_ids)) {
    const skip = reason => skipped.push({ task_id: row.id, reason });
    if (settledBy(rule, row)) { skip(reasons.done); continue; }
    if (row.values.recurrence || row.values.recurrence_series) { skip(reasons.repeats); continue; }
    const values = {};
    const missed = row.values.starts_at && wallTimeOf(Date.parse(row.values.starts_at), zone).date < today;
    if (missed) Object.assign(values, { starts_at: null, ends_at: null, pinned_until: null, placed_by: null });
    const due = row.values.due;
    if (dateOnly(due) && due < today) values.due = today;
    else if (due && !dateOnly(due) && Number.isFinite(Date.parse(due)) && wallTimeOf(Date.parse(due), zone).date < today && !missed) { skip(reasons.timed_due); continue; }
    if (!Object.keys(values).length) { skip(reasons.nothing_to_carry); continue; }
    writes.push({ id: row.id, values });
    changes.push({ id: row.id, before: row });
    carried.push({ task_id: row.id, title: row.values.title, cleared_block: Boolean(missed), ...(values.due ? { due_from: due, due_to: values.due } : {}) });
  }
  if (!writes.length) return { carried, skipped };
  const saved = await lists.putRows(data.list.id, { rows: writes }, { actor: { by: 'calendar' } });
  const after = new Map(saved.kept.map(row => [row.id, row]));
  const undo = undoFor(changes.map(change => ({ id: change.id, before: change.before, after: after.get(change.id) ?? null })));
  return { carried, skipped, ...(undo ? { undo } : {}) };
}

// ---- Day hours --------------------------------------------------------------------------------------------------------
// A one-day change to the standing working hours, kept as a row the planner subtracts (parts/ui schedule-planner
// `day_overrides`), so a late start or a blocked afternoon never edits the schedule the person keeps.
const dayHoursId = day => `calendar-day-${day}`;
const dayHoursOf = row => {
  const { day, off, start_minute, end_minute, blocks } = row.values;
  return { day, ...(off ? { off: true } : {}), ...(start_minute != null ? { start_minute } : {}), ...(end_minute != null ? { end_minute } : {}),
    ...(blocks ? { blocks: JSON.parse(blocks) } : {}) };
};
async function readDayHours(lists, from, to) {
  const lower = from ? new Date(Date.parse(from) - 86_400_000).toISOString().slice(0, 10) : null;
  const upper = to ? new Date(Date.parse(to) + 86_400_000).toISOString().slice(0, 10) : null;
  const rows = [];
  let cursor;
  do {
    const page = await lists.read(data.day_hours.id, { only: data.day_hours.fields.map(field => field.id), limit: 50, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows);
    cursor = page.page.complete ? undefined : page.page.next_cursor;
    if (rows.length > data.day_hours.most_rows) throw new CalendarTasksError(data.words.bad_day_hours);
  } while (cursor);
  return rows.filter(row => (!lower || row.values.day >= lower) && (!upper || row.values.day <= upper)).map(dayHoursOf).sort((a, b) => a.day.localeCompare(b.day));
}
async function setDayHours(lists, input) {
  let override;
  try { override = dayOverrideOf({ day: input.day, off: input.off, start_minute: input.start_minute, end_minute: input.end_minute, blocks: input.blocks }); }
  catch { throw new CalendarTasksError(data.words.bad_day_hours); }
  if (!override.off && input.start_minute == null && input.end_minute == null && !override.blocks.length) throw new CalendarTasksError(data.words.bad_day_hours);
  const id = dayHoursId(override.day);
  const before = await lists.row(data.day_hours.id, id);
  const values = { day: override.day, off: override.off ? 'yes' : null, start_minute: input.start_minute ?? null, end_minute: input.end_minute ?? null,
    blocks: override.blocks.length ? JSON.stringify(override.blocks) : null };
  const saved = await lists.putRows(data.day_hours.id, { rows: [{ id, values }] }, { actor: { by: 'calendar' } });
  return { day_hours: dayHoursOf(saved.kept[0]), undo: before ? { action: 'set_day_hours', ...dayHoursOf(before) } : { action: 'clear_day_hours', day: override.day } };
}
async function clearDayHours(lists, input) {
  if (!dateOnly(input.day)) throw new CalendarTasksError(data.words.bad_day_hours);
  const row = await lists.row(data.day_hours.id, dayHoursId(input.day));
  if (!row) return { day: input.day, removed: false };
  await lists.putRows(data.day_hours.id, { remove: [row.id] }, { actor: { by: 'calendar' } });
  return { day: input.day, removed: true, undo: { action: 'set_day_hours', ...dayHoursOf(row) } };
}

// ---- Working hours and quiet hours --------------------------------------------------------------------------------------
// The person's standing working hours and what a sender is told outside them (parts/timed-action quiet-hours.ts).
const workingHoursOf = row => row?.values?.start && row.values.end && row.values.time_zone ? {
  start: row.values.start, end: row.values.end, time_zone: row.values.time_zone,
  ...(Array.isArray(row.values.weekdays) && row.values.weekdays.length ? { weekdays: row.values.weekdays.map(Number) } : {}),
  mode: row.values.mode || quietModes.default_mode,
} : null;
async function setWorkingHours(lists, input) {
  const mode = input.mode ?? quietModes.default_mode;
  let checked;
  try {
    if (!Object.hasOwn(quietModes.modes, mode)) throw new TypeError('mode');
    checked = checkedWorkingHours({ start: input.start, end: input.end, time_zone: input.time_zone, ...(input.weekdays === undefined ? {} : { weekdays: input.weekdays }) });
  } catch { throw new CalendarTasksError(data.words.bad_working_hours); }
  const before = await lists.row(data.working_hours.id, data.working_hours.row_id);
  const saved = await lists.putRows(data.working_hours.id, { rows: [{ id: data.working_hours.row_id, values: { start: checked.start, end: checked.end, time_zone: checked.time_zone, weekdays: input.weekdays === undefined ? null : checked.weekdays.map(String), mode } }] }, { actor: { by: 'calendar' } });
  return { working_hours: workingHoursOf(saved.kept[0]), undo: workingHoursOf(before) ? { action: 'set_working_hours', ...workingHoursOf(before) } : { action: 'clear_working_hours' } };
}
async function clearWorkingHours(lists) {
  const row = await lists.row(data.working_hours.id, data.working_hours.row_id);
  if (!row || !workingHoursOf(row)) return { removed: false };
  // The row also keeps the planning choices and the daily limit, so only the hours and what happens outside them go.
  await lists.putRows(data.working_hours.id, { rows: [{ id: row.id, values: { start: null, end: null, time_zone: null, weekdays: null, mode: null } }] }, { actor: { by: 'calendar' } });
  return { removed: true, undo: { action: 'set_working_hours', ...workingHoursOf(row) } };
}
// What writing to this person right now should tell the sender: a notice, and whether to send without a push.
async function quietHours(lists, input, now) {
  const hours = workingHoursOf(await lists.row(data.working_hours.id, data.working_hours.row_id));
  const at = input.at === undefined ? now() : Date.parse(input.at);
  if (!Number.isFinite(at)) throw new CalendarTasksError(data.words.bad_working_hours);
  const dismissed = input.dismissed_period_start_ms ?? null;
  if (dismissed !== null && !Number.isFinite(dismissed)) throw new CalendarTasksError(data.words.bad_working_hours);
  return quietHoursAnswer(hours, at, hours?.mode, dismissed);
}

// A task too long for any one free stretch, placed in slices (the planner's `chunk_index`/`chunk_count` proposals): each
// slice is a task of its own, a child of the task, placed by the planner, so one slice can be moved, pinned or finished
// without replanning the rest. The task keeps its whole length; the planner leaves it alone while its slices are open.
async function scheduleSlices(lists, input) {
  const rule = await statusRule(lists);
  const row = await taskRow(lists, input.task_id);
  if (settledBy(rule, row)) throw new CalendarTasksError('A completed task cannot be scheduled.');
  const times = input.slices;
  if (!Array.isArray(times) || times.length < 2 || times.length > data.slices.most) throw new CalendarTasksError(data.words.bad_slices);
  const slices = times.map(slice => ({ start: instant(slice?.start), end: instant(slice?.end) }));
  if (slices.some((slice, index) => !slice.start || !slice.end || Date.parse(slice.end) <= Date.parse(slice.start) || (index > 0 && Date.parse(slice.start) < Date.parse(slices[index - 1].end)))) throw new CalendarTasksError(data.words.bad_slices);
  const made = await inOrder(slices, async (slice, index) => {
    const id = `${row.id}-slice-${index + 1}`;
    const values = {
      title: `${row.values.title} (${index + 1}/${slices.length})`, duration_minutes: Math.round((Date.parse(slice.end) - Date.parse(slice.start)) / 60_000),
      starts_at: slice.start, ends_at: slice.end, placed_by: placers[0], slice_of: row.id, parent_id: row.id,
      ...Object.fromEntries(['priority', 'labels', 'collection_id', 'due', 'deadline_type', 'description'].filter(field => row.values[field] != null && row.values[field] !== '').map(field => [field, field === 'collection_id' && Array.isArray(row.values[field]) ? row.values[field][0] : row.values[field]])),
    };
    return { id, values, existing: await lists.row(data.list.id, id) };
  });
  const fresh = made.filter(slice => !slice.existing);
  if (made.some(slice => slice.existing && (slice.existing.values.starts_at !== slice.values.starts_at || slice.existing.values.ends_at !== slice.values.ends_at))) {
    throw new CalendarTasksError('These slices already exist at different times. Read the task again.');
  }
  const saved = fresh.length ? await lists.putRows(data.list.id, { rows: fresh.map(({ id, values }) => ({ id, values })) }, { actor: { by: 'calendar' } }) : { kept: [] };
  const kept = new Map(saved.kept.map(entry => [entry.id, entry]));
  const undo = undoFor(fresh.map(slice => ({ id: slice.id, before: null, after: kept.get(slice.id) ?? null })));
  return { tasks: made.map(slice => taskOf(kept.get(slice.id) ?? slice.existing, rule)), kept: fresh.length === 0, ...(undo ? { undo } : {}) };
}

// The zone plans are kept in is the working hours' time zone; a device showing another zone is asked about once.
async function planningZone(lists) {
  const row = await lists.row(data.working_hours.id, data.working_hours.row_id);
  return row ? { row, zone: row.values.time_zone, asked: Array.isArray(row.values.asked_zones) ? row.values.asked_zones : [] } : null;
}
async function zoneDriftAnswer(lists, input) {
  let zone;
  try { zone = timeZoneName(input.device_zone); } catch { zone = null; }
  if (!zone) throw new CalendarTasksError(data.words.bad_zone_drift);
  const planning = await planningZone(lists);
  // With no working hours there is no planning zone yet, so there is nothing to have drifted from.
  return planning ? zoneDrift(planning.zone, zone, planning.asked) : { planning_zone: null, device_zone: zone, drifted: false, ask: false };
}
async function answerZoneDrift(lists, input) {
  const answer = await zoneDriftAnswer(lists, input);
  const planning = await planningZone(lists);
  if (!planning || typeof input.move !== 'boolean') throw new CalendarTasksError(data.words.bad_zone_drift);
  const values = input.move ? { time_zone: answer.device_zone, asked_zones: [...new Set([...planning.asked, answer.device_zone])] } : { asked_zones: [...new Set([...planning.asked, answer.device_zone])] };
  const saved = await lists.putRows(data.working_hours.id, { rows: [{ id: planning.row.id, values }] }, { actor: { by: 'calendar' } });
  return { working_hours: workingHoursOf(saved.kept[0]), moved: input.move,
    undo: { action: 'set_working_hours', ...workingHoursOf(planning.row) } };
}

// ---- Pulling a calendar event into the tasks ----------------------------------------------------------------------------
// An event becomes a scheduled task that carries its source id, so pulling it again finds that task instead of making a
// second one. Which events are not offered is the meeting_filters list in calendar-tasks.json.
const filterRows = data.meeting_filters.rows;
function filterHit(row, event) {
  const value = event[row.field];
  if (value === undefined || value === null || value === '') return false;
  if (Object.hasOwn(row, 'is')) return [row.is].flat().includes(value);
  if (Object.hasOwn(row, 'at_most')) return Number(value) <= row.at_most;
  if (Object.hasOwn(row, 'more_than')) return Number(value) > row.more_than;
  if (Object.hasOwn(row, 'matches')) return new RegExp(row.matches, 'i').test(String(value));
  return false;
}
async function taskFromEvent(lists, input, now = () => Date.now()) {
  const rule = await statusRule(lists);
  const event = input.event;
  if (!object(event) || !nonempty(event.id) || !nonempty(event.source) || !nonempty(event.title) || !instant(event.starts_at) || !instant(event.ends_at)
    || Date.parse(event.ends_at) <= Date.parse(event.starts_at)) throw new CalendarTasksError(data.words.bad_event);
  const named = input.filters;
  if (named !== undefined && (!Array.isArray(named) || named.some(id => !filterRows.some(row => row.id === id)))) throw new CalendarTasksError(data.words.bad_filters);
  const active = filterRows.filter(row => named === undefined ? row.default === true : named.includes(row.id));
  const refused = active.filter(row => filterHit(row, event)).map(row => row.id);
  if (refused.length) return { pulled: false, refused };
  const minutes = Math.round((Date.parse(event.ends_at) - Date.parse(event.starts_at)) / 60_000);
  if (minutes < 1 || minutes > data.limits.duration_minutes) return { pulled: false, refused: ['longer_than_a_day'] };
  const source = `${event.source}:${event.id}`;
  const id = `calendar-event-${identityOf({ calendar_event: source }).slice(0, 32)}`;
  const existing = await lists.row(data.list.id, id);
  if (existing) return { pulled: true, kept: true, task: taskOf(existing, rule) };
  const url = object(event) && typeof event.url === 'string' ? provenance({ source_url: event.url }).source_url : null;
  const values = { title: event.title.trim().slice(0, data.limits.title_chars), duration_minutes: minutes, starts_at: instant(event.starts_at), ends_at: instant(event.ends_at), source_id: source, smart_list: 'calendar', created_at: new Date(now()).toISOString(), ...(url ? { source_url: url } : {}) };
  const saved = await lists.putRows(data.list.id, { rows: [{ id, values }] }, { actor: { by: 'calendar' } });
  const undo = undoFor([{ id, before: null, after: saved.kept[0] }]);
  return { pulled: true, kept: false, task: taskOf(saved.kept[0], rule), ...(undo ? { undo } : {}) };
}

// ---- A task for any other thing a person works from (a message, a document) ---------------------------------------------
// The thing names itself by a source id; the first ask makes its task and every later ask finds that same task, so a
// message's priority, time and deadline all land on one row however many times it is opened.
const sourceTaskId = source => `calendar-source-${identityOf({ calendar_source: source }).slice(0, 32)}`;
async function taskFromSource(lists, input, now = () => Date.now()) {
  const rule = await statusRule(lists);
  if (!nonempty(input.source_id) || input.source_id.trim().length > data.limits.source_id_chars || !nonempty(input.title)) throw new CalendarTasksError(data.words.bad_source);
  const source = input.source_id.trim();
  const id = sourceTaskId(source);
  const existing = await lists.row(data.list.id, id);
  if (existing) return { kept: true, task: taskOf(existing, rule) };
  const minutes = input.duration_minutes ?? data.from_source.default_minutes;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > data.limits.duration_minutes) throw new CalendarTasksError(data.words.bad_duration);
  const values = { title: input.title.trim().slice(0, data.limits.title_chars), duration_minutes: minutes, source_id: source, priority: defaultPriority, created_at: new Date(now()).toISOString(), ...provenance({ source_url: input.source_url ?? null }) };
  const saved = await lists.putRows(data.list.id, { rows: [{ id, values }] }, { actor: { by: 'calendar' } });
  return { kept: false, task: taskOf(saved.kept[0], rule) };
}

/** The task already made for a source id, or null: a read that never makes one. */
export async function findSourceTask(lists, sourceId) {
  const rule = await statusRule(lists);
  const row = await lists.row(data.list.id, sourceTaskId(String(sourceId).trim()));
  return row ? taskOf(row, rule) : null;
}

// ---- Turning mail into todos --------------------------------------------------------------------------------------------
// A message becomes a task that carries its source id (the one from_source makes, so a message turned into a todo by hand and
// one imported are the same task). Which built-in list it
// belongs to is the email_split rows (calendar-task-messages.mjs). If the task was deleted, importing the message again makes
// it again: only a task that still exists is kept, nothing remembers a deletion.
async function messageTask(lists, message, split, now) {
  const bad = () => new CalendarTasksError(data.words.bad_message);
  if (!object(message) || !nonempty(message.id) || message.id.length > data.limits.source_id_chars - 5) throw bad();
  if (message.subject !== undefined && message.subject !== null && typeof message.subject !== 'string') throw bad();
  const sourceId = `gmail:${message.id.trim()}`;
  const id = sourceTaskId(sourceId);
  const existing = await lists.row(data.list.id, id);
  if (existing) return { row: existing, kept: true };
  let url = null;
  if (typeof message.url === 'string' && message.url) { try { url = provenance({ source_url: message.url }).source_url; } catch { url = null; } }
  const title = (message.subject ?? '').trim().slice(0, data.limits.title_chars) || data.email_split.untitled;
  const values = { title, duration_minutes: data.email_split.task_minutes, source_id: sourceId, smart_list: split ? classifyMessage(message) : 'email', created_at: new Date(now()).toISOString(), ...(url ? { source_url: url } : {}) };
  return { row: { id, values }, kept: false };
}
async function messageTasks(lists, messages, now = () => Date.now()) {
  const rule = await statusRule(lists);
  const split = await preferenceOf(lists, 'email_split_contents');
  const made = await inOrder(messages, async message => await messageTask(lists, message, split, now));
  const fresh = [...new Map(made.filter(entry => !entry.kept).map(entry => [entry.row.id, entry])).values()];
  const saved = fresh.length ? await lists.putRows(data.list.id, { rows: fresh.map(entry => ({ id: entry.row.id, values: entry.row.values })) }, { actor: { by: 'calendar' } }) : { kept: [] };
  const savedById = new Map(saved.kept.map(row => [row.id, row]));
  const tasks = made.map(entry => taskOf(savedById.get(entry.row.id) ?? entry.row, rule));
  const undo = undoFor(fresh.map(entry => ({ id: entry.row.id, before: null, after: savedById.get(entry.row.id) ?? null })));
  return { imported: fresh.length, kept: made.length - fresh.length, tasks, ...(undo ? { undo } : {}) };
}
async function importMessages(lists, input, now) {
  const messages = input.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > data.email_split.most_messages) throw new CalendarTasksError(data.words.bad_messages);
  if (!await preferenceOf(lists, 'email_todos')) return { imported: 0, kept: 0, tasks: [], disabled: true };
  return await messageTasks(lists, messages, now);
}

// Planning choices kept on the working-hours row (calendar-tasks.json preferences).
const preferenceNames = Object.keys(data.preferences).filter(name => !name.startsWith('_'));
const preferenceOf = async (lists, name) => {
  const row = data.preferences[name];
  const saved = (await lists.row(data.working_hours.id, data.working_hours.row_id))?.values?.[name];
  if (row.kind === 'text') return typeof saved === 'string' ? saved : row.default;
  if (row.choices) return row.choices.includes(saved) ? saved : row.default;
  return saved === 'yes' ? true : saved === 'no' ? false : row.default;
};
const preferenceValueOk = (name, value) => {
  const row = data.preferences[name];
  if (row.kind === 'text') return typeof value === 'string' && value.trim().length <= row.most_chars;
  return row.choices ? row.choices.includes(value) : typeof value === 'boolean';
};
const preferenceStored = (name, value) => {
  const row = data.preferences[name];
  if (row.kind === 'text') return value.trim() || null;
  return row.choices ? value : value ? 'yes' : 'no';
};
// The most planned work in a day (parts/ui/show/schedule-calendar/schedule-planner.mjs `capacity`), kept on the working-hours row.
/** This person's standing working hours { start, end, time_zone, weekdays?, mode }, or null when not set (what a member's store lets a space-mate learn only as quiet or not, space-calendars.mjs). */
export const readWorkingHours = async lists => workingHoursOf(await lists.row(data.working_hours.id, data.working_hours.row_id));
/** Whether this person, at `atMs`, is outside their working hours and chose to be written to without a push (quiet-hours.json mode auto_silent). */
export async function silentAt(lists, atMs) {
  const hours = await readWorkingHours(lists);
  if (!hours || !Number.isFinite(atMs)) return false;
  try { return quietHoursAnswer(hours, atMs, hours.mode).send_silently; } catch { return false; }
}
const capacityOf = async lists => {
  try { return JSON.parse((await lists.row(data.working_hours.id, data.working_hours.row_id))?.values?.capacity ?? 'null'); } catch { return null; }
};
async function setCapacity(lists, input) {
  const ok = value => Number.isSafeInteger(value) && value >= 1 && value <= 1440;
  const weekdays = input.weekdays ?? {};
  const band = input.caution_band_minutes ?? 0;
  const none = input.default_minutes == null && !Object.keys(weekdays).length;
  if (!none && ((input.default_minutes != null && !ok(input.default_minutes)) || !Number.isSafeInteger(band) || band < 0 || band > 1440
    || !object(weekdays) || Object.entries(weekdays).some(([day, minutes]) => !/^[0-6]$/.test(day) || !ok(minutes)))) throw new CalendarTasksError(data.words.bad_capacity);
  const before = await capacityOf(lists);
  const next = none ? null : { default_minutes: input.default_minutes ?? null, caution_band_minutes: band, weekdays };
  await lists.putRows(data.working_hours.id, { rows: [{ id: data.working_hours.row_id, values: { capacity: next ? JSON.stringify(next) : null } }] }, { actor: { by: 'calendar' } });
  return { capacity: next, undo: { action: 'set_capacity', ...(before ?? {}) } };
}
async function setPreference(lists, input) {
  const named = preferenceNames.filter(name => Object.hasOwn(input, name));
  if (!named.length || named.some(name => !preferenceValueOk(name, input[name]))) throw new CalendarTasksError(data.words.bad_preference);
  const before = Object.fromEntries(await inOrder(named, async name => [name, await preferenceOf(lists, name)]));
  await lists.putRows(data.working_hours.id, { rows: [{ id: data.working_hours.row_id, values: Object.fromEntries(named.map(name => [name, preferenceStored(name, input[name])])) }] }, { actor: { by: 'calendar' } });
  return { preferences: Object.fromEntries(await inOrder(preferenceNames, async name => [name, await preferenceOf(lists, name)])), undo: { action: 'set_preferences', ...before } };
}
// Tasks the planner placed that a person's move now overlaps, and that nobody pinned: taken off the calendar so the
// planner can place them again when asked.
async function displacedBy(lists, moved, nowMs) {
  const start = Date.parse(moved.values.starts_at), end = Date.parse(moved.values.ends_at);
  const clear = { starts_at: null, ends_at: null, placed_by: null, pinned_until: null };
  const writes = [], changes = [];
  for (const row of await openTasks(lists)) {
    if (row.id === moved.id || !row.values.placed_by || !row.values.starts_at) continue;
    const pinned = row.values.pinned_until && Date.parse(row.values.pinned_until) > nowMs;
    const from = Date.parse(row.values.starts_at), to = Date.parse(row.values.ends_at ?? row.values.starts_at);
    if (pinned || !(from < end && start < to)) continue;
    writes.push({ id: row.id, values: clear });
    changes.push({ id: row.id, before: row });
  }
  if (!writes.length) return { displaced: [], changes: [] };
  const saved = await lists.putRows(data.list.id, { rows: writes }, { actor: { by: 'calendar' } });
  const after = new Map(saved.kept.map(row => [row.id, row]));
  return { displaced: changes.map(change => change.id), changes: changes.map(change => ({ ...change, after: after.get(change.id) ?? null })) };
}

// Actions that change one task answer with the undo of exactly what changed.
const undoable = new Set(['schedule', 'unschedule', 'update', 'move', 'complete', 'reopen', 'delete', 'create', 'duplicate']);

// One repair to many tasks (calendar-tasks.json `bulk`): each task takes the repair's change through the same single-task
// road, so it passes the same checks; the answers' undo rows join into one undo. A task that cannot take it is listed.
async function bulkChange(lists, input, options) {
  const repair = data.bulk.repairs.find(row => row.id === input.repair);
  const ids = input.task_ids;
  if (!repair || !Array.isArray(ids) || !ids.length || ids.length > data.bulk.most_tasks || new Set(ids).size !== ids.length) throw new CalendarTasksError(data.words.bad_bulk);
  const changed = [];
  const refused = [];
  const rows = [];
  for (const id of ids) {
    try {
      const answer = await changeCalendarTask(lists, { ...repair.change, task_id: id }, options);
      changed.push(id);
      if (answer.undo) rows.push(...answer.undo.rows);
    } catch (error) {
      if (!(error instanceof CalendarTasksError)) throw error;
      refused.push({ task_id: id, reason: error.message });
    }
  }
  return { changed, refused, ...(rows.length ? { undo: { action: 'restore', rows } } : {}) };
}

export async function changeCalendarTask(lists, input, options = {}) {
  if (!object(input)) throw new CalendarTasksError(data.words.bad_action);
  if (input.action === 'restore') { await ensureTaskList(lists); return await restoreTasks(lists, input, options); }
  if (input.action === 'set_capacity') { await ensureTaskList(lists); return await setCapacity(lists, input); }
  if (input.action === 'bulk') { await ensureTaskList(lists); return await bulkChange(lists, input, options); }
  if (input.action === 'rollover') { await ensureTaskList(lists); return await rolloverTasks(lists, input); }
  if (input.action === 'set_day_hours') { await ensureTaskList(lists); return await setDayHours(lists, input); }
  if (input.action === 'schedule_slices') { await ensureTaskList(lists); return await scheduleSlices(lists, input); }
  if (input.action === 'set_working_hours') { await ensureTaskList(lists); return await setWorkingHours(lists, input); }
  if (input.action === 'clear_working_hours') { await ensureTaskList(lists); return await clearWorkingHours(lists); }
  if (input.action === 'set_preferences') { await ensureTaskList(lists); return await setPreference(lists, input); }
  if (input.action === 'import_messages') { await ensureTaskList(lists); return await importMessages(lists, input, options.now); }
  if (input.action === 'from_event') { await ensureTaskList(lists); return await taskFromEvent(lists, input, options.now); }
  if (input.action === 'from_source') { await ensureTaskList(lists); return await taskFromSource(lists, input, options.now); }
  if (input.action === 'find_source') { await ensureTaskList(lists); return { task: await findSourceTask(lists, input.source_id ?? '') }; }
  if (input.action === 'zone_drift') { await ensureTaskList(lists); return await zoneDriftAnswer(lists, input); }
  if (input.action === 'answer_zone_drift') { await ensureTaskList(lists); return await answerZoneDrift(lists, input); }
  if (input.action === 'quiet_hours') { await ensureTaskList(lists); return await quietHours(lists, input, options.now ?? Date.now); }
  if (input.action === 'clear_day_hours') { await ensureTaskList(lists); return await clearDayHours(lists, input); }
  const target = undoable.has(input.action) && nonempty(input.task_id) ? (await (await (await (await (await lists.row?.(data.list.id, input.task_id)))))) ?? null : null;
  const before = target ? { id: target.id, values: structuredClone(target.values) } : null;
  const result = await applyCalendarTask(lists, input, options);
  if (!undoable.has(input.action) || result.kept === true || result.next_task) return result;
  const afterRow = input.action === 'delete' ? null : await lists.row(data.list.id, result.task?.id ?? input.task_id);
  const own = { id: result.task?.id ?? input.task_id, before: input.action === 'create' || input.action === 'duplicate' ? null : before, after: afterRow ? { id: afterRow.id, values: structuredClone(afterRow.values) } : null };
  // A person scheduling a task over what the planner placed moves those out of the way, when they chose that.
  if (input.action === 'schedule' && input.placed_by === undefined && afterRow?.values?.starts_at && await preferenceOf(lists, 'refit_on_move')) {
    const moved = await displacedBy(lists, afterRow, (options.now ?? (() => Date.now()))());
    if (moved.displaced.length) {
      const undo = undoFor([own, ...moved.changes]);
      return { ...result, displaced: moved.displaced, ...(undo ? { undo } : {}) };
    }
  }
  const undo = undoFor([own]);
  return undo ? { ...result, undo } : result;
}

async function applyCalendarTask(lists, input, options = {}) {
  const { now = () => Date.now() } = options;
  if (!object(input)) throw new CalendarTasksError(data.words.bad_action);
  await ensureTaskList(lists);
  const rule = await statusRule(lists);
  if (input.action === 'create_collection') {
    const values = collectionValues(input);
    if (!values.title) throw new CalendarTasksError(data.words.bad_collection);
    const id = `calendar-collection-${requestKeyOf(input.request_key)}`;
    const existing = await lists.row(data.collections.id, id);
    if (existing) {
      if (existing.values.title !== values.title) throw new CalendarTasksError('This request key already belongs to a different task list.');
      return { collection: collectionOf(existing), kept: true };
    }
    const saved = await lists.putRows(data.collections.id, { rows: [{ id, values }] }, { actor: { by: 'calendar' } });
    return { collection: collectionOf(saved.kept[0]), kept: false, undo: { action: 'delete_collection', collection_id: id } };
  }
  if (input.action === 'update_collection') {
    const collectionId = input.collection_id;
    if (!nonempty(collectionId)) throw new CalendarTasksError('Choose a task list to change.');
    const row = await lists.row(data.collections.id, collectionId);
    if (!row) throw new CalendarTasksError('That task list is no longer available.');
    const values = collectionValues(input);
    if (!Object.keys(values).length) throw new CalendarTasksError(data.words.bad_collection_field);
    const saved = await lists.putRows(data.collections.id, { rows: [{ id: row.id, values }] }, { actor: { by: 'calendar' } });
    return { collection: collectionOf(saved.kept[0]), undo: { action: 'update_collection', collection_id: row.id, ...collectionRestore(row, Object.keys(values)) } };
  }
  if (input.action === 'reorder_collection') {
    const { collection_id: collectionId, anchor_id: anchorId, placement } = input;
    if (!nonempty(collectionId) || !nonempty(anchorId) || collectionId === anchorId || !['before', 'after'].includes(placement)) throw new CalendarTasksError(data.words.bad_collection_order);
    const row = await lists.row(data.collections.id, collectionId);
    if (!row || !await lists.row(data.collections.id, anchorId)) throw new CalendarTasksError('That task list is no longer available.');
    const undo = await collectionReorderUndo(lists, row.id);
    const moved = await lists.moveRow(data.collections.id, { row_id: row.id, index: data.collections.ordering.index, anchor_id: anchorId, placement }, { actor: { by: 'calendar' } });
    return { collection: collectionOf(await lists.row(data.collections.id, row.id)), moved: moved.moved, ...(undo && moved.moved ? { undo } : {}) };
  }
  if (input.action === 'delete_collection') {
    const collectionId = input.collection_id;
    if (!nonempty(collectionId)) throw new CalendarTasksError('Choose a task list to delete.');
    const row = await lists.row(data.collections.id, collectionId);
    if (!row) throw new CalendarTasksError('That task list is no longer available.');
    await lists.putRows(data.collections.id, { remove: [row.id] }, { actor: { by: 'calendar' } });
    return { id: row.id, removed: true };
  }
  if (input.action === 'move') {
    const row = await taskRow(lists, input.task_id);
    if (!Object.hasOwn(input, 'collection_id')) throw new CalendarTasksError('Choose a task list or clear the current list.');
    const collectionId = await checkedCollection(lists, input.collection_id);
    const saved = await lists.putRows(data.list.id, { rows: [{ id: row.id, values: { collection_id: collectionId } }] }, { actor: { by: 'calendar' } });
    return { task: taskOf(saved.kept[0], rule) };
  }
  if (input.action === 'reorder') {
    const row = await taskRow(lists, input.task_id);
    const moved = await lists.moveRow(data.list.id, {
      row_id: row.id, index: data.list.ordering.index,
      anchor_id: input.anchor_id, placement: input.placement,
    }, { actor: { by: 'calendar' } });
    return { task: taskOf(await lists.row(data.list.id, row.id), rule), moved: moved.moved };
  }
  if (input.action === 'create') {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > data.limits.title_chars) throw new CalendarTasksError(data.words.bad_title);
    if (!Number.isSafeInteger(input.duration_minutes) || input.duration_minutes < 1 || input.duration_minutes > data.limits.duration_minutes) {
      throw new CalendarTasksError(data.words.bad_duration);
    }
    if (input.due !== undefined && input.due !== null && input.due !== '' && !validDue(input.due)) throw new CalendarTasksError(data.words.bad_due);
    const key = requestKeyOf(input.request_key);
    const id = `calendar-${key}`;
    const existing = await lists.row(data.list.id, id);
    const details = taskDetails(input);
    const values = {
      title, duration_minutes: input.duration_minutes, ...(input.due ? { due: input.due } : {}), created_at: new Date(now()).toISOString(),
      description: details.description ?? '', priority: details.priority ?? defaultPriority,
      labels: details.labels ?? [],
      ...provenance(input),
      ...schedulingDetails(input),
      ...(details.smart_list ? { smart_list: details.smart_list } : {}),
    };
    if (Object.hasOwn(input, 'collection_id')) values.collection_id = await checkedCollection(lists, input.collection_id);
    if (details.recurrence) {
      values.recurrence = JSON.stringify(details.recurrence);
      values.recurrence_series = id;
      values.recurrence_index = 1;
      values.recurrence_rule_revision = 1;
      values.recurrence_anchor_date = taskLocalDate({ id, values }, details.recurrence, now());
    }
    if (Object.hasOwn(input, 'parent_id')) values.parent_id = await checkedParent(lists, input.parent_id, id);
    if (existing) {
      if (existing.values.title !== title || existing.values.duration_minutes !== input.duration_minutes
        || (existing.values.due ?? null) !== (input.due ?? null)
        || (existing.values.description ?? '') !== values.description
        || (existing.values.priority ?? defaultPriority) !== values.priority
        || JSON.stringify(existing.values.labels ?? []) !== JSON.stringify(values.labels)
        || (existing.values.recurrence ?? null) !== (values.recurrence ?? null)
        || (existing.values.source_id ?? null) !== (values.source_id ?? null)
        || (existing.values.source_url ?? null) !== (values.source_url ?? null)
        || schedulingFields.some(field => JSON.stringify(existing.values[field] ?? null) !== JSON.stringify(values[field] ?? null))
        || parentIdOf(existing) !== (values.parent_id ?? null)) {
        throw new CalendarTasksError('This request key already belongs to a different task.');
      }
      const existingNext = details.recurrence?.nextTodo === 'direct_even_if_open'
        ? nextTaskValues(existing, details.recurrence, now()) : null;
      let nextRow = existingNext && await lists.row(data.list.id, existingNext.id);
      if (existingNext && !nextRow) nextRow = (await lists.putRows(data.list.id, { rows: [existingNext] }, { actor: { by: 'calendar' } })).kept[0];
      return { task: taskOf(existing, rule), ...(nextRow ? { next_task: taskOf(nextRow, rule) } : {}), kept: true };
    }
    const row = { id, values };
    const directNext = details.recurrence?.nextTodo === 'direct_even_if_open'
      ? nextTaskValues(row, details.recurrence, now()) : null;
    const saved = await lists.putRows(data.list.id, { rows: [row, ...(directNext ? [directNext] : [])] }, { actor: { by: 'calendar' } });
    return { task: taskOf(saved.kept.find(item => item.id === id), rule), ...(directNext ? { next_task: taskOf(saved.kept.find(item => item.id === directNext.id), rule) } : {}), kept: false };
  }
  if (input.action === 'duplicate') {
    const source = await taskRow(lists, input.task_id);
    const key = requestKeyOf(input.request_key);
    const id = `calendar-${key}`;
    const values = {
      title: source.values.title,
      description: source.values.description ?? '',
      priority: source.values.priority ?? defaultPriority,
      labels: Array.isArray(source.values.labels) ? [...source.values.labels] : [],
      duration_minutes: source.values.duration_minutes,
      duplicate_of: source.id, created_at: new Date(now()).toISOString(),
      ...(source.values.smart_list ? { smart_list: source.values.smart_list } : {}),
      ...(source.values.collection_id ? { collection_id: Array.isArray(source.values.collection_id) ? source.values.collection_id[0] : source.values.collection_id } : {}),
      ...(source.values.due ? { due: source.values.due } : {}),
      ...(parentIdOf(source) ? { parent_id: await checkedParent(lists, parentIdOf(source), id) } : {}),
    };
    const existing = await lists.row(data.list.id, id);
    if (existing) {
      if (existing.values.duplicate_of !== source.id) {
        throw new CalendarTasksError('This request key already belongs to a different task copy.');
      }
      return { task: taskOf(existing, rule), kept: true };
    }
    const saved = await lists.putRows(data.list.id, { rows: [{ id, values }] }, { actor: { by: 'calendar' } });
    return { task: taskOf(saved.kept[0], rule), kept: false };
  }
  if (input.action === 'schedule') {
    const row = await taskRow(lists, input.task_id);
    if (Object.hasOwn(input, 'expected_start') && (row.values.starts_at ?? null) !== input.expected_start) {
      throw new CalendarTasksError('This task already has a different time. Read it again before scheduling.');
    }
    if (settledBy(rule, row)) throw new CalendarTasksError('A completed task cannot be scheduled.');
    const start = instant(input.start);
    if (!start) throw new CalendarTasksError(data.words.bad_start);
    const end = input.end === undefined || input.end === null || input.end === ''
      ? new Date(Date.parse(start) + row.values.duration_minutes * 60_000).toISOString()
      : instant(input.end);
    if (!end || Date.parse(end) <= Date.parse(start)) throw new CalendarTasksError(data.words.bad_end);
    const durationMinutes = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60_000));
    // The planner placing a task marks it as the planner's; a person scheduling a task the planner placed moves it,
    // and that pins it where they put it until its time has passed (then the planner may take it back).
    const placedByPlanner = input.placed_by === placers[0];
    const values = { starts_at: start, ends_at: end, duration_minutes: durationMinutes };
    if (placedByPlanner) Object.assign(values, { placed_by: placers[0], pinned_until: null });
    else if (row.values.placed_by) values.pinned_until = end;
    const saved = await lists.putRows(data.list.id, { rows: [{ id: row.id, values }] }, { actor: { by: 'calendar' } });
    return { task: taskOf(saved.kept[0], rule) };
  }
  if (input.action === 'log_time') {
    const row = await taskRow(lists, input.task_id);
    const minutes = input.minutes;
    const total = (row.values.time_spent_minutes ?? 0) + minutes;
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > data.limits.duration_minutes || total > data.limits.time_spent_minutes) throw new CalendarTasksError(data.words.bad_time_spent);
    const saved = await lists.putRows(data.list.id, { rows: [{ id: row.id, values: { time_spent_minutes: total } }] }, { actor: { by: 'calendar' } });
    return { task: taskOf(saved.kept[0], rule) };
  }
  if (input.action === 'complete') {
    const row = await taskRow(lists, input.task_id);
    await refuseUnlessLinkedWorkIsFinished(lists, row, options);
    const recurrence = await activeRecurrence(lists, row);
    const next = recurrence && ['when_done', 'direct_even_if_open'].includes(recurrence.nextTodo)
      ? nextTaskValues(row, recurrence, now()) : null;
    const existingNext = next ? await lists.row(data.list.id, next.id) : null;
    const rows = [{ id: row.id, values: { status: rule.settles[0] } }, ...(next && !existingNext ? [next] : [])];
    const saved = await lists.putRows(data.list.id, { rows }, { actor: { by: 'calendar' } });
    const result = { task: taskOf(saved.kept[0], rule) };
    const nextRow = existingNext ?? (next ? saved.kept.find(item => item.id === next.id) : null);
    if (nextRow) result.next_task = taskOf(nextRow, rule);
    return result;
  }
  if (input.action === 'reopen') {
    const row = await taskRow(lists, input.task_id);
    const saved = await lists.putRows(data.list.id, { rows: [{ id: row.id, values: { status: null } }] }, { actor: { by: 'calendar' } });
    return { task: taskOf(saved.kept[0], rule) };
  }
  if (input.action === 'delete') {
    const row = await taskRow(lists, input.task_id);
    await lists.putRows(data.list.id, { remove: [row.id] }, { actor: { by: 'calendar' } });
    return { id: row.id, removed: true };
  }
  if (input.action === 'update') {
    const row = await taskRow(lists, input.task_id);
    const values = editableFields(input);
    if (Object.hasOwn(input, 'collection_id')) values.collection_id = await checkedCollection(lists, input.collection_id);
    let stopSeriesAt = null;
    if (Object.hasOwn(values, 'parent_id')) values.parent_id = await checkedParent(lists, values.parent_id, row.id);
    if (Object.hasOwn(values, 'recurrence')) {
      if (values.recurrence === null) {
        const series = row.values.recurrence_series ?? row.id;
        const master = series === row.id ? row : await lists.row(data.list.id, series);
        const nextRevision = (Number.isSafeInteger(master?.values?.recurrence_rule_revision) ? master.values.recurrence_rule_revision : 1) + 1;
        values.recurrence_series = series;
        values.recurrence_index = row.values.recurrence_index ?? 1;
        values.recurrence_rule_revision = nextRevision;
        values.recurrence_anchor_date = row.values.recurrence_anchor_date ?? master?.values?.recurrence_anchor_date ?? null;
        if (master && master.id !== row.id) stopSeriesAt = { id: master.id, values: { recurrence: null, recurrence_rule_revision: nextRevision } };
      } else {
        const recurrence = JSON.parse(values.recurrence);
        const priorSeries = row.values.recurrence_series ?? row.id;
        const forksSeries = priorSeries !== row.id;
        const series = forksSeries ? row.id : priorSeries;
        if (series.length + '-repeat-9999'.length > 200) throw new CalendarTasksError('This task ID is too long to repeat.');
        values.recurrence_series = series;
        values.recurrence_index = forksSeries ? 1 : row.values.recurrence_index ?? 1;
        values.recurrence_rule_revision = forksSeries ? 1 : values.recurrence === row.values.recurrence
          ? row.values.recurrence_rule_revision ?? 1
          : (row.values.recurrence_rule_revision ?? 0) + 1;
        if (`${series}-rule-${values.recurrence_rule_revision}-repeat-9999`.length > 200) throw new CalendarTasksError('This task ID is too long to repeat.');
        values.recurrence_anchor_date = row.values.recurrence_anchor_date
          ?? taskLocalDate({ id: row.id, values: { ...row.values, ...values } }, recurrence, now());
      }
    }
    const updated = { id: row.id, values: { ...row.values, ...values } };
    const recurrence = storedRecurrence(updated.values.recurrence);
    const directNext = Object.hasOwn(values, 'recurrence') && recurrence?.nextTodo === 'direct_even_if_open'
      ? nextTaskValues(updated, recurrence, now()) : null;
    const saved = await lists.putRows(data.list.id, { rows: [...(stopSeriesAt ? [stopSeriesAt] : []), { id: row.id, values }, ...(directNext ? [directNext] : [])] }, { actor: { by: 'calendar' } });
    return { task: taskOf(saved.kept.find(item => item.id === row.id), rule), ...(directNext ? { next_task: taskOf(saved.kept.find(item => item.id === directNext.id), rule) } : {}) };
  }
  if (input.action === 'unschedule') {
    const row = await taskRow(lists, input.task_id);
    if (settledBy(rule, row)) throw new CalendarTasksError('A completed task cannot be unscheduled.');
    const saved = await lists.putRows(data.list.id, { rows: [{ id: row.id, values: { starts_at: null, ends_at: null, pinned_until: null, placed_by: null } }] }, { actor: { by: 'calendar' } });
    return { task: taskOf(saved.kept[0], rule) };
  }
  throw new CalendarTasksError(data.words.bad_action);
}

export async function handleCalendarTasksRequest(lists, request, options) {
  try {
    if (request.method === 'GET') {
      const url = new URL(request.url);
      return Response.json(await readCalendarTasks(lists, {
        from: url.searchParams.get('from'), to: url.searchParams.get('to'),
        cursor: url.searchParams.get('cursor') ?? undefined,
        collection_cursor: url.searchParams.get('collection_cursor') ?? undefined,
        task_id: url.searchParams.get('task_id') ?? undefined,
        sort: url.searchParams.get('sort') ?? 'date',
      }));
    }
    if (request.method === 'POST') return Response.json(await changeCalendarTask(lists, await request.json().catch(() => null), options));
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  } catch (error) {
    return Response.json({ error: String(error?.message ?? error) }, { status: error instanceof CalendarTasksError ? 400 : 500 });
  }
}

export const isCalendarTasksPath = path => path === '/calendar/tasks';
