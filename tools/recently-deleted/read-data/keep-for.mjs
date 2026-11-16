// tools/recently-deleted/read-data/keep-for.mjs
//
// How long Recently Deleted and Archived keep things: each state's DATA default (set-aside.json), replaced by the
// person's own choice where they made one. The choice is the person's setting record `setting:keep_for`, which their AI
// reads and gives as `keep_for` ({ <state>: days | null }); nothing is read from any store here.
import settings from './set-aside.json' with { type: 'json' };

/** tool:read-deleted-files-keep-for: each state with its days (null: until put back), its default and what happens when its time ends. */
export function readKeepFor(input) {
  const saved = input?.keep_for ?? {};
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('keep_for is the person\'s keep-for choice: { <state>: days or null }.');
  return {
    states: settings.states.map(state => ({
      id: state.id, label: state.label, after_days: Object.hasOwn(saved, state.id) ? saved[state.id] : state.after_days,
      default_after_days: state.after_days, when_due: state.when_due, due_words: state.due_words,
    })),
    choices: settings.keep_for_choices,
  };
}
