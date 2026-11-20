// tools/recently-deleted-and-storage/read-data/when-due.mjs
//
// The arithmetic of Recently Deleted and Archived over the DATA in ../namespace-set-aside.json: how many days a state
// keeps things (the state's default, replaced by the person's own keep-for), when an item is due, and an item as the
// person sees it (days left, what happens when its time ends). Pure: it reads nothing and keeps nothing. Both producers
// of set-aside items use it (do-work/account-archive.mjs and do-work/recently-deleted-actions.mjs), so a state's rules
// are written once.
import states from '../namespace-set-aside.json' with { type: 'json' };

export const DAY = 86400000;
export const fail = (code, message) => Object.assign(new Error(message), { code });
export const stateOf = id => states.states.find(row => row.id === id) ?? (() => { throw fail('bad_state', 'Choose a declared archive state.'); })();

/** Days a state keeps things for this person: their keep-for choice where they made one, else the state's default (null: until put back). */
export function daysFor(item, keep) { return Object.hasOwn(keep, item.state) ? keep[item.state] : stateOf(item.state).after_days; }

/** When the item's time ends, epoch ms, or null (kept until put back, or not yet set aside). */
export function due(item, keep) {
  const days = daysFor(item, keep);
  return days === null || !Number.isFinite(item.entered_at_ms) ? null : item.entered_at_ms + days * DAY;
}

/** The item with the days it keeps, when it is due and how many days are left. */
export function shown(item, keep, now) {
  const at = due(item, keep);
  return { ...item, after_days: daysFor(item, keep), due_at: at === null ? null : new Date(at).toISOString(),
    days_left: at === null ? null : Math.max(0, Math.ceil((at - now) / DAY)), state_label: stateOf(item.state).label };
}

/** Whole days 0 to max_days, or null (until put back): what a keep-for choice may hold. */
export function checkDays(days) {
  if (days !== null && (!Number.isInteger(days) || days < 0 || days > states.max_days)) throw fail('bad_keep_for', 'Choose a whole allowed day count, or null.');
  return days;
}

/** The keep-for answer: each state with the days now in force, its default and what happens when its time ends, and the usual choices. */
export function keepForAnswer(keep) {
  return {
    states: states.states.map(state => ({
      id: state.id, label: state.label, after_days: Object.hasOwn(keep, state.id) ? keep[state.id] : state.after_days,
      default_after_days: state.after_days, when_due: state.when_due, due_words: state.due_words,
    })),
    choices: states.keep_for_choices,
  };
}
