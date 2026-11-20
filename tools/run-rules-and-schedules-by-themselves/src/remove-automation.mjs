// tools/run-rules-and-schedules-by-themselves/src/remove-automation.mjs
//
// Purpose: remove one rule or one schedule from a person's list of them, by its id, with the stale-edit guard the old
// owner had (src/automations.mjs removeRule and removeSchedule, old Worker commit b6ae0ebf815f). One function serves
// both kinds, so a rule and a schedule are removed the same way; the caller says which id field the list uses.
//
// Non-Negotiable Invariants:
//   1. Nothing is removed unless the id is on the list (AutomationRemoveError, "not_found").
//   2. When expected_set_at is given and the item's set_at differs, nothing is removed (AutomationRemoveError,
//      "set_again"): the person or AI read an older version and must read it again first.
//   3. The input list is never changed; the answer is a new list without the item, and the item removed.

export class AutomationRemoveError extends Error {
  constructor(reason, message) { super(message); this.name = 'AutomationRemoveError'; this.reason = reason; }
}

/**
 * items: [{ <idField>: string, set_at?: string, ... }]
 * Returns { items, removed } where items is the list without the removed item.
 */
export function removeAutomation({ items, idField, id, expected_set_at = undefined }) {
  const list = Array.isArray(items) ? items : [];
  const index = list.findIndex(item => item?.[idField] === id);
  if (index < 0) throw new AutomationRemoveError('not_found', `No ${idField} ${id} is set.`);
  const current = list[index];
  if (expected_set_at !== undefined && current.set_at !== expected_set_at) {
    throw new AutomationRemoveError('set_again', `${idField} ${id} was set again since you read it. Read it again, then remove it.`);
  }
  return { items: [...list.slice(0, index), ...list.slice(index + 1)], removed: current };
}
