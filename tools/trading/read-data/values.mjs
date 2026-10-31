// tools/trading/read-data/values.mjs
//
// The small readers every trading file shares: an object or list or nothing, a number from a number or decimal text,
// a dotted path into an answer, and JSON text in the exact forms the identity and the broker bodies use.
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const objectOf = value => (isObject(value) ? value : {});
export const listOf = value => (Array.isArray(value) ? value : []);
export const missing = value => value === undefined || value === null || value === '';

/** A number, or a decimal written as text; anything else (booleans included) is null. */
export function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const read = Number(value.trim());
  return Number.isFinite(read) ? read : null;
}

/** The value at a dotted path through objects ("order.status"), or null; a path that is not text reads nothing. */
export function atPath(root, dotted) {
  if (typeof dotted !== 'string' || dotted === '') return null;
  let at = root;
  for (const part of dotted.split('.')) {
    if (!isObject(at) || !Object.hasOwn(at, part)) return null;
    at = at[part];
  }
  return at === undefined ? null : at;
}

// Every character past ASCII written as \uXXXX, one per UTF-16 unit, so the text is the same on every system.
const ascii = text => text.replace(/[^\x00-\x7f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Compact JSON ("," and ":"), keys in their own order, every character past ASCII escaped: a broker body. */
export const asciiJson = value => ascii(JSON.stringify(value));

/** Compact JSON with every object's keys sorted, every character past ASCII escaped: the text an identity is of. */
export function canonicalJson(value) {
  const sorted = item => {
    if (Array.isArray(item)) return item.map(sorted);
    if (!isObject(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])]));
  };
  return asciiJson(sorted(value));
}
