// tools/recently-deleted/read-data/keep-for.mjs
//
// How long Recently Deleted and Archived keep things: each state's DATA default (set-aside.json), replaced by the
// person's own choice where they made one. The choice is the person's setting record `setting:keep_for`
// ({ value: { <state>: days | null } }), read through the run's records door (tools/records-door).
import settings from './set-aside.json' with { type: 'json' };

export const KEEP_FOR = { type: 'setting', id: 'setting:keep_for' };

/** tool:read-deleted-files-keep-for: each state with its days (null: until put back), its default and what happens when its time ends. */
export async function readKeepFor(_input, { door }) {
  const saved = (await door.read(KEEP_FOR.type, KEEP_FOR.id))?.value ?? {};
  return {
    states: settings.states.map(state => ({
      id: state.id, label: state.label, after_days: Object.hasOwn(saved, state.id) ? saved[state.id] : state.after_days,
      default_after_days: state.after_days, when_due: state.when_due, due_words: state.due_words,
    })),
    choices: settings.keep_for_choices,
  };
}
