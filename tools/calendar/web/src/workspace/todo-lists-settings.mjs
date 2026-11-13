// src/workspace/todo-lists-settings.mjs
//
// PURPOSE
//   The pure half of the Todos settings page (todo-lists-settings.tsx): which lists a filter shows, which are archived,
//   the one request each choice sends to /work/api/calendar/tasks, where a dragged list landed, and the times a list is
//   scheduled in. It reads and writes nothing; the page sends what these return.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A request names only what the person changed (the server takes a partial update); null clears a field.
//   2. A request that creates carries the caller's key so a retry never makes the list twice.
//   3. A list that is not writable (a read-only calendar) is never offered as a default calendar.

const DAY_MINUTES = 1440;

/** The lists whose name contains the words typed (case and accents aside); every list when nothing is typed. */
export function filterLists(lists, query) {
  const words = String(query ?? '').trim().toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  if (!words) return lists;
  return lists.filter(list => String(list.title ?? list.label ?? '').toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').includes(words));
}

/** `{ active, archived }`, each in the order given. */
export function splitArchived(lists) {
  return { active: lists.filter(list => !list.archived), archived: lists.filter(list => list.archived) };
}

export const createListRequest = ({ title, color = null, key }) => ({
  action: 'create_collection', title: String(title).trim(), ...(color ? { color } : {}), request_key: key,
});

export const updateListRequest = (id, patch) => ({ action: 'update_collection', collection_id: id, ...patch });

export const deleteListRequest = id => ({ action: 'delete_collection', collection_id: id });

/** The request that puts the list that moved from `before` (ids in order) to `after` where it landed, or null for no move. */
export function reorderRequest(before, after) {
  if (before.length !== after.length || before.every((id, index) => id === after[index])) return null;
  const moved = after.find((id, index) => {
    const rest = after.filter(other => other !== id);
    const original = before.filter(other => other !== id);
    return rest.every((other, at) => other === original[at]) && before.indexOf(id) !== index;
  });
  if (!moved) return null;
  const at = after.indexOf(moved);
  const next = after[at + 1];
  return { action: 'reorder_collection', collection_id: moved, anchor_id: next ?? after[at - 1], placement: next ? 'before' : 'after' };
}

/** "HH:MM" of a minute of the day. */
export const clockOf = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** The minute of the day of "HH:MM", or null when it is not a time. */
export function minuteOf(clock) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(clock ?? ''));
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[1]) < 24 && Number(match[2]) < 60 ? minute : null;
}

/** The preferred times to send for the clocks and days chosen, or null when they do not make a window (end after start). */
export function preferredTimes(start, end, weekdays) {
  const from = minuteOf(start), to = minuteOf(end);
  if (from === null || to === null || to <= from || to > DAY_MINUTES) return null;
  const days = [...new Set(weekdays)].filter(day => Number.isInteger(day) && day >= 0 && day <= 6).sort();
  return { start_minute: from, end_minute: to, ...(days.length && days.length < 7 ? { weekdays: days } : {}) };
}

/** Writable calendars by account, as `{ label, calendars: [{ value: 'source|connection|calendar', label, default_calendar }] }`. */
export function calendarGroups(accounts) {
  return (accounts ?? []).map(account => ({
    label: account.account_label,
    calendars: (account.calendars ?? []).filter(calendar => calendar.writable === true)
      .map(calendar => ({ id: calendar.id, label: calendar.summary, default_calendar: { source_id: account.source_id ?? account.connection_id, calendar_id: calendar.id } })),
  })).filter(group => group.calendars.length);
}

/** The scheduling choice of a list as one of 'inherit', 'on', 'off'. */
export const aiChoiceOf = list => (list.ai_scheduling === true ? 'on' : list.ai_scheduling === false ? 'off' : 'inherit');
export const aiValueOf = choice => (choice === 'on' ? true : choice === 'off' ? false : null);

/** The preference write for one email-todo setting. */
export const preferenceRequest = (name, value) => ({ action: 'set_preferences', [name]: value });
