// tools/run-rules-and-schedules-by-themselves/src/automation-operations.mjs
//
// Purpose: the operations of tool:run-when-something-happens (kind rule) and tool:run-at-a-time (kind schedule): list,
// set, remove and run now, over the list of rules or schedules the host keeps. The shapes and the checks are the old
// owner's (src/automations.mjs in old Worker commit b6ae0ebf815f: checkedEvery at 307, whereCondition at 202,
// setRule at 814, setSchedule at 1087, runNow at 1181, removeRule at 885, removeSchedule at 1265).
//
// Non-Negotiable Invariants:
//   1. This module keeps nothing. The host passes the current items in and stores the items it gets back.
//   2. A set with only the id and enabled changes only enabled (per-rule and per-schedule off and on); everything else
//      is kept. An off item is kept but never runs; run now still runs it, as the old owner did.
//   3. A set or remove that names expected_set_at refuses when the item was set again since it was read (set_again).
//   4. Run now answers the item's then with the input laid over its own; it never runs the then itself.

import { removeAutomation, AutomationRemoveError } from './remove-automation.mjs';

export class AutomationError extends Error {
  constructor(reason, message) { super(message); this.name = 'AutomationError'; this.reason = reason; }
}

export const KINDS = Object.freeze({
  rule: Object.freeze({ idField: 'rule_id', listKey: 'rules' }),
  schedule: Object.freeze({ idField: 'schedule_id', listKey: 'schedules' }),
});
export const OPERATIONS = Object.freeze(['list', 'set', 'remove', 'run-now']);

const WHERE_TESTS = ['equals', 'one_of', 'starts_with', 'contains', 'present'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MIN_STEP_MINUTES = 5;
const WITHIN_DAY = { minute: { minutes: 1, most: 1440 }, hour: { minutes: 60, most: 24 } };
const AT = /^([01]\d|2[0-3]):[0-5]\d$/;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim() !== '';
const fail = (reason, message) => { throw new AutomationError(reason, message); };

function checkedThen(then) {
  if (!object(then)) fail('then', 'then names what runs: { tool_id, input } or { workflow_id, input }.');
  const names = ['tool_id', 'workflow_id'].filter(name => then[name] !== undefined);
  if (names.length !== 1 || !nonempty(then[names[0]])) fail('then', 'then names one of tool_id or workflow_id.');
  if (then.input !== undefined && !object(then.input)) fail('then', 'then.input must be an object.');
  return { [names[0]]: then[names[0]].trim(), input: then.input ?? {} };
}

function checkedWhere(where, at) {
  if (!object(where) || !nonempty(where.field)) fail('when', `when.where[${at}] needs field (a field of the record, like "text") and one test.`);
  const tests = WHERE_TESTS.filter(name => where[name] !== undefined);
  if (tests.length !== 1) fail('when', `when.where[${at}] needs exactly one of ${WHERE_TESTS.join(', ')}.`);
  if (where.not !== undefined && where.not !== true) fail('when', `when.where[${at}].not must be true.`);
  const [name] = tests;
  if (name === 'one_of' && (!Array.isArray(where.one_of) || !where.one_of.length)) fail('when', `when.where[${at}].one_of must list the values.`);
  if ((name === 'starts_with' || name === 'contains') && !nonempty(where[name])) fail('when', `when.where[${at}].${name} must be text.`);
  if (name === 'present' && where.present !== true) fail('when', `when.where[${at}].present must be true.`);
  return { ...where };
}

function checkedWhen(when) {
  if (!object(when)) fail('when', 'when says what sets the rule off: { recorded, where } or { space_id, kind, where } or { source_id, event, words }.');
  const shapes = [
    nonempty(when.recorded),
    nonempty(when.space_id),
    nonempty(when.source_id) && nonempty(when.event),
  ].filter(Boolean).length;
  if (shapes !== 1) fail('when', 'when needs exactly one of: recorded (a kind of record), space_id, or source_id with event.');
  const where = Array.isArray(when.where) ? when.where.map((test, index) => checkedWhere(test, index)) : undefined;
  if (when.where !== undefined && !where) fail('when', 'when.where must be a list of tests.');
  return { ...(nonempty(when.recorded) ? { recorded: when.recorded.trim() } : {}), ...(nonempty(when.space_id) ? { space_id: when.space_id.trim() } : {}),
    ...(nonempty(when.source_id) ? { source_id: when.source_id.trim(), event: when.event.trim(), ...(Array.isArray(when.words) ? { words: when.words } : {}) } : {}),
    ...(nonempty(when.kind) ? { kind: when.kind.trim() } : {}), ...(where ? { where } : {}) };
}

function checkedEvery(every) {
  if (!object(every)) fail('every', 'every must be { unit: "minute", "hour", "day" or "week", interval, at, time_zone, on }.');
  const unit = every.unit ?? (every.on ? 'week' : 'day');
  const within = WITHIN_DAY[unit];
  if (!within && unit !== 'day' && unit !== 'week') fail('every', 'every.unit must be "minute", "hour", "day" or "week".');
  const at = every.at ?? (within ? '00:00' : undefined);
  if (!AT.test(String(at ?? ''))) fail('every', 'every.at must be a local time like "09:00" (24-hour).');
  if (!nonempty(every.time_zone)) fail('every', 'every.time_zone must name a time zone, like "America/New_York".');
  try { new Intl.DateTimeFormat('en-US', { timeZone: every.time_zone }); } catch { fail('every', `${every.time_zone} is not a time zone this system knows.`); }
  const interval = every.interval ?? 1;
  if (within) {
    if (!Number.isInteger(interval) || interval < 1 || interval > within.most) fail('every', `every.interval must be a whole number from 1 to ${within.most} for every ${unit}.`);
    if (interval * within.minutes < MIN_STEP_MINUTES) fail('every', `A schedule runs at most every ${MIN_STEP_MINUTES} minutes.`);
    if (every.on !== undefined) fail('every', 'every.on is for a week.');
    return { unit, interval, at, time_zone: every.time_zone.trim() };
  }
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) fail('every', 'every.interval must be a whole number from 1 to 52.');
  if (unit === 'week') {
    const on = Array.isArray(every.on) ? every.on : [];
    const days = [...new Set(on.map(day => (Number.isInteger(day) ? day : WEEKDAYS.indexOf(String(day).toLowerCase()))))].sort();
    if (!days.length || days.some(day => day < 0 || day > 6)) fail('every', `every.on must list days: ${WEEKDAYS.join(', ')}.`);
    return { unit, interval, at, time_zone: every.time_zone.trim(), on: days.map(day => WEEKDAYS[day]) };
  }
  return { unit, interval, at, time_zone: every.time_zone.trim() };
}

function checkedSchedule(input) {
  const repeats = input.every !== undefined;
  const once = input.once_at !== undefined;
  if (repeats === once) fail('every', 'A schedule needs exactly one of every (repeats) or once_at (one time).');
  const timing = repeats ? { every: checkedEvery(input.every) } : { once_at: onceAt(input.once_at) };
  if (input.overlap !== undefined && input.overlap !== 'allow' && input.overlap !== 'wait') fail('overlap', 'overlap must be "allow" or "wait".');
  if (input.only_if_changed !== undefined && (!object(input.only_if_changed) || !nonempty(input.only_if_changed.tool_id))) {
    fail('only_if_changed', 'only_if_changed is { tool_id, input }: a read-only tool to run first.');
  }
  return {
    ...timing,
    then: checkedThen(input.then),
    ...(input.starts_on !== undefined ? { starts_on: String(input.starts_on) } : {}),
    ...(input.overlap !== undefined ? { overlap: input.overlap } : {}),
    ...(input.only_if_changed !== undefined ? { only_if_changed: { tool_id: input.only_if_changed.tool_id.trim(), input: input.only_if_changed.input ?? {} } } : {}),
  };
}

function onceAt(value) {
  if (!nonempty(value) || !/(Z|[+-]\d\d:\d\d)$/.test(value) || Number.isNaN(Date.parse(value))) fail('once_at', 'once_at is one time with its zone, like "2026-10-01T09:00:00-04:00".');
  return value.trim();
}

function checkedRule(input) {
  return { when: checkedWhen(input.when), then: checkedThen(input.then) };
}

/** Builds the item a set would keep, from its input and what is kept now (undefined when new). */
function itemFor(kind, input, existing, now) {
  const { idField } = KINDS[kind];
  const id = input[idField] ?? existing?.[idField];
  if (!nonempty(id)) fail('id', `${idField} is needed to set a ${kind} (read the list first to change one).`);
  const enabled = input.enabled ?? existing?.enabled ?? true;
  if (typeof enabled !== 'boolean') fail('enabled', 'enabled must be true or false.');
  const label = input.label ?? existing?.label;
  const shape = kind === 'rule' ? checkedRule(input) : checkedSchedule(input);
  return { [idField]: id.trim(), ...(label !== undefined ? { label: String(label) } : {}), ...shape, enabled, set_at: now };
}

function setItem({ kind, input, items, now }) {
  const { idField } = KINDS[kind];
  const id = input[idField];
  const existing = nonempty(id) ? items.find(item => item[idField] === id) : undefined;
  if (existing && input.expected_set_at !== undefined && existing.set_at !== input.expected_set_at) {
    fail('set_again', `${idField} ${id} was set again since you read it. Read it again, then set it.`);
  }
  const onlyToggle = existing !== undefined && Object.keys(input).every(name => [idField, 'enabled', 'expected_set_at'].includes(name));
  if (onlyToggle) {
    if (typeof input.enabled !== 'boolean') fail('enabled', 'enabled must be true or false.');
    const saved = { ...existing, enabled: input.enabled, set_at: now };
    return { items: items.map(item => (item === existing ? saved : item)), saved };
  }
  const saved = itemFor(kind, input, existing, now);
  const next = existing ? items.map(item => (item === existing ? saved : item)) : [...items, saved];
  return { items: next, saved };
}

function runNow({ kind, input, items }) {
  const { idField } = KINDS[kind];
  const id = input[idField];
  const item = items.find(entry => entry[idField] === id);
  if (!item) fail('not_found', `No ${idField} ${id} is set.`);
  const laid = object(input.input) ? input.input : {};
  return { dispatch: { ...(item.then.tool_id !== undefined ? { tool_id: item.then.tool_id } : { workflow_id: item.then.workflow_id }), input: { ...item.then.input, ...laid } } };
}

/**
 * One operation over the host's list of items of one kind.
 * Returns { items, answer }: items is the list the host should keep; answer is what the tool says.
 */
export function runAutomationOperation({ kind, operation = 'list', input = {}, items = [], now = new Date().toISOString() }) {
  if (!Object.hasOwn(KINDS, kind)) fail('kind', 'kind is rule or schedule.');
  const list = Array.isArray(items) ? items : [];
  const { idField, listKey } = KINDS[kind];
  if (operation === 'list') return { items: list, answer: { [listKey]: list } };
  if (operation === 'set') {
    const { items: next, saved } = setItem({ kind, input, items: list, now });
    return { items: next, answer: { saved } };
  }
  if (operation === 'remove') {
    try {
      const { items: next, removed } = removeAutomation({ items: list, idField, id: input[idField], expected_set_at: input.expected_set_at });
      return { items: next, answer: { removed } };
    } catch (error) {
      if (error instanceof AutomationRemoveError) fail(error.reason, error.message);
      throw error;
    }
  }
  if (operation === 'run-now') return { items: list, answer: runNow({ kind, input, items: list }) };
  return fail('operation', `Choose an operation: ${OPERATIONS.join(', ')}; not ${operation}.`);
}
