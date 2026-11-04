// src/introduction-states.mjs
//
// The one introduction lifecycle: its states, the sentence each shows both people, and the moves allowed between them
// (src/introduction-states.json). A community's matches (src/community-matching.mjs) and the Network's requests
// (src/network.mjs, src/network-first-matches.mjs) move and word their states only through this owner.
import data from './introduction-states.json' with { type: 'json' };

export const INTRODUCTION_STATES = Object.freeze(Object.keys(data.states));
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');

/** The new state `to`, when an introduction in `from` may move there; a 409 refusal otherwise. */
export function moveIntroduction(from, to) {
  if (!data.states[from]?.next.includes(to)) throw Object.assign(new Error(fill(data.words.cannot_move, { from, to })), { status: 409 });
  return to;
}

/** A state as every view shows it: its id and the sentence both people read. */
export function introductionView(state) {
  const known = data.states[state];
  if (!known) throw new TypeError(`${state} is not an introduction state.`);
  return { status: state, says: known.says };
}
