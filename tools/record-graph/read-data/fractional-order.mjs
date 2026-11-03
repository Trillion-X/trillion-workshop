// tools/record-graph/read-data/fractional-order.mjs
//
// Lexicographic fractional order keys that never run out under repeated bisection, carried unchanged from Trillion's
// parts/visual-database/do-work/fractional-order.ts (isOrderKey, keyBetween) so a relation's subject_order and
// object_order are the same keys the old relate wrote. Pure: no imports, no I/O.
//
//   1. Keys are non-empty strings over ORDER_ALPHABET; plain string `<` is the comparator.
//   2. A key never ends in '0', so the midpoint is always defined.
//   3. keyBetween(a, b) returns k with a < k < b (a null is open below, b null open above).

export const ORDER_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const DIGIT_COUNT = ORDER_ALPHABET.length;
const ZERO = ORDER_ALPHABET[0];

/** True when a value is a valid fractional order key (anything else simply fails). */
export function isOrderKey(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value[value.length - 1] === ZERO) return false;
  for (const char of value) if (!ORDER_ALPHABET.includes(char)) return false;
  return true;
}

function digitIndex(char) {
  const index = ORDER_ALPHABET.indexOf(char);
  if (index < 0) throw new Error(`fractional-order: invalid digit "${char}"`);
  return index;
}

function midpoint(a, b) {
  if (b !== null && a >= b) throw new Error(`fractional-order: "${a}" >= "${b}"`);
  if (a.slice(-1) === ZERO || (b !== null && b.slice(-1) === ZERO)) throw new Error('fractional-order: trailing-zero key rejected');
  if (b !== null) {
    let shared = 0;
    while ((a[shared] ?? ZERO) === b[shared]) shared += 1;
    if (shared > 0) return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
  }
  const digitA = a ? digitIndex(a[0]) : 0;
  const digitB = b !== null ? digitIndex(b[0]) : DIGIT_COUNT;
  if (digitB - digitA > 1) return ORDER_ALPHABET[Math.round(0.5 * (digitA + digitB))];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return ORDER_ALPHABET[digitA] + midpoint(a.slice(1), null);
}

/** The shortest key strictly between a and b. */
export function keyBetween(a, b) {
  if (a !== null && !isOrderKey(a)) throw new Error(`fractional-order: invalid lower key "${a}"`);
  if (b !== null && !isOrderKey(b)) throw new Error(`fractional-order: invalid upper key "${b}"`);
  return midpoint(a ?? '', b);
}
