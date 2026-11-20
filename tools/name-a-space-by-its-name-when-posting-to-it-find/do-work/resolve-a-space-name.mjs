// tools/name-a-space-by-its-name-when-posting-to-it-find/do-work/resolve-a-space-name.mjs
//
// Purpose
//   A space named by its name instead of its id. An AI told "post this in Popcorn" should not need a list call to learn the
//   id first: the member's own spaces turn the name into the id, and a name that fits none or several of them is refused
//   with every space's name and id, so the next call is right. Ported from src/space-names.mjs at 289270b644 (spaceNamed,
//   looksLikeSpaceId). Pure: the caller passes the member's current spaces (newest first) and the wording row.
//
// Non-negotiable invariants
//   1. Only the spaces given (the member's own current spaces, already inside the sign-in's reach) are matched; a name never
//      opens a space the id would not.
//   2. A name matches one space or none: the space whose title is the name (any case, outer spaces ignored), else the one
//      space whose title holds it. Several matches are refused, never guessed.
//   3. The words of a refusal are the wording row's (`none`, `several`, `no_spaces`, `one_space`), never written here.

/** Whether `given` has the shape of an id the Network makes (a lower-case word, "_", then lower-case letters and digits). */
export const looksLikeSpaceId = given => /^[a-z]+_[0-9a-z]+$/.test(String(given ?? ''));

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/**
 * The id of the one space `name` names.
 * @param {{name: string, spaces: Array<{id: string, title: string}>, within?: 'all' | string[], words: object}} args
 * @returns {{space_id: string}} the one space; throws an Error with the wording row's refusal otherwise
 */
export function spaceNamed({ name, spaces, within = 'all', words }) {
  const wanted = String(name ?? '').trim().toLowerCase();
  const mine = spaces.filter(row => within === 'all' || within.includes(row.id));
  const titled = row => String(row.title ?? '').trim().toLowerCase();
  const exact = mine.filter(row => titled(row) === wanted);
  const found = exact.length || !wanted ? exact : mine.filter(row => titled(row).includes(wanted));
  if (found.length === 1) return { space_id: found[0].id };
  const list = rows => rows.map(row => fill(words.one_space, { title: row.title, space_id: row.id })).join(', ') || words.no_spaces;
  throw new Error(found.length ? fill(words.several, { name, spaces: list(found) }) : fill(words.none, { name, spaces: list(mine) }));
}
