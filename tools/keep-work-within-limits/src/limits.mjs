// src/limits.mjs
//
// PURPOSE
//   Caps that explain themselves. A cap's number stays in the DATA file of the owner that enforces it; src/limits.json says,
//   for each, what it caps, where it is enforced and why it exists. limitSaid turns a refusal into a sentence that names the
//   cap, its number and its reason, and unregisteredLimits finds numbers in `limits` blocks that nobody has explained.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file never holds a cap's value: the caller passes the value it just enforced (read from its own DATA), so the
//      sentence can never disagree with the check.
//   2. Pure: no storage, no clock. Words and reasons are src/limits.json.
//   3. A cap with no row is refused loudly in limitSaid (an unexplained cap is a defect to find), never given invented words.
//
import data from './limits.json' with { type: 'json' };

const ROWS = new Map(data.rows.map(row => [row.id, row]));
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** Every explained cap: { id, what, bound, unit, source, why, owner, path }. */
export const explainedLimits = () => data.rows.map(row => ({ ...row }));

/** The sentence for a refusal over cap `id` whose number is `value`; `have` (optional) is what was given. */
export function limitSaid(id, value, have) {
  const row = ROWS.get(id);
  if (!row) throw new Error(fill(data.words.unknown, { id }));
  return fill(data.words[row.bound], {
    what: row.what, value, unit: row.unit, why: row.why,
    have: have === undefined ? '' : fill(data.words.have, { have }),
  });
}

/**
 * The numbers inside `limits` objects of the given DATA files that have no row in src/limits.json.
 * `files` maps a repo path to its parsed JSON. Answers [{ owner, path }] sorted by owner then path.
 */
export function unregisteredLimits(files) {
  const known = new Set(data.rows.map(row => `${row.owner}\n${row.path.join('.')}`));
  const found = [];
  const walk = (owner, node, path) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      const here = [...path, key];
      if (key === 'limits' && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const [name, number] of Object.entries(child)) {
          if (typeof number === 'number' && !known.has(`${owner}\n${[...here, name].join('.')}`)) found.push({ owner, path: [...here, name] });
        }
      } else if (child && typeof child === 'object') walk(owner, child, here);
    }
  };
  for (const [owner, json] of Object.entries(files)) walk(owner, json, []);
  return found.sort((a, b) => a.owner.localeCompare(b.owner) || a.path.join('.').localeCompare(b.path.join('.')));
}
