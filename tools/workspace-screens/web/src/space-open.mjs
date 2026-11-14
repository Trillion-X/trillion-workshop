// src/space-open.mjs
// Purpose: open a space to everyone, or close it again, by changing only its own rules (src/space-open.json DATA).
// Invariants:
//   1. A space is open exactly when its rules let anyone read it (src/community.mjs openToEveryone reads the same rules).
//   2. A deny that holds always wins, so opening also excepts the open actions from the deny rules named in `denies`;
//      closing takes the allow rule and those exceptions away and leaves every other rule as it was.
//   3. Nothing here names a space, a person or a kind of space: another way of opening one is another DATA row.
import spaceOpen from './space-open.json' with { type: 'json' };

export const openChoices = spaceOpen.choices;

/** Whether these rules carry the open rule (the share sheet's Who else can open it). */
export const isOpenToEveryone = rules => (rules ?? []).some(rule => rule?.id === spaceOpen.allow.id);

// A rule as it is saved: without the words a rules read adds for people.
const savedRule = rule => Object.fromEntries(Object.entries(rule ?? {}).filter(([key]) => !spaceOpen.shown_only.includes(key)));

const withOpenActions = (rule, open) => {
  if (!spaceOpen.denies.includes(rule?.id) || !Array.isArray(rule.when?.rules)) return rule;
  return { ...rule, when: { ...rule.when, rules: rule.when.rules.map(part => {
    if (part?.field !== 'action' || part.operator !== 'is_none_of') return part;
    const kept = (part.params?.values ?? []).filter(value => !spaceOpen.actions.includes(value));
    return { ...part, params: { ...part.params, values: open ? [...kept, ...spaceOpen.actions] : kept } };
  }) } };
};

/** The same rules, opened to everyone or closed to members again. */
export const openedRules = (rules, open) => [
  ...(rules ?? []).filter(rule => rule?.id !== spaceOpen.allow.id).map(rule => withOpenActions(savedRule(rule), open)),
  ...(open ? [spaceOpen.allow] : []),
];
