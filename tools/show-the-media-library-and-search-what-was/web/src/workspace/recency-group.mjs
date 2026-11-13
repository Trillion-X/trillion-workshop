// src/workspace/recency-group.mjs
//
// PURPOSE
//   The recency group a row falls in on the Notes list (Today, Last week, Previous 30 days, Past). Boundaries and words
//   are DATA in note-list-menu.json; nothing here names a group.

import words from './note-list-menu.json' with { type: 'json' };
const recency = words.recency;

const DAY_MS = 86400000;

/** The recency group for a moment in time: the first group whose days reach back to it, else Past; undated when none. */
export function recencyGroup(at, now, data = recency) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return data.undated;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const daysAgo = Math.max(0, Math.ceil((startOfToday - at) / DAY_MS));
  return data.groups.find(group => daysAgo <= group.within_days)?.label ?? data.past;
}

/** The recency values as the list's tag values, in group order. */
export function recencyValues(data = recency) {
  return Object.fromEntries([...data.groups.map(group => group.label), data.past, data.undated].map(label => [label, { tone: 'neutral' }]));
}

