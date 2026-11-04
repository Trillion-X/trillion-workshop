//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Lexicographic fractional indexing: arbitrary-precision order keys that never
// exhaust under repeated bisection. Pure math, zero imports, zero I/O — leaf-
// extractable the moment a second consumer is confirmed.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Keys are non-empty strings over ORDER_ALPHABET; plain string `<` IS the
//    comparator (the alphabet is ASCII-monotonic: digits < upper < lower).
// 2. A key never ends in '0' — so appending any non-'0' digit always produces
//    a strictly greater key, and the midpoint algorithm stays total.
// 3. keyBetween(a, b) returns k with a < k < b for every valid input pair.
// 4. Allocation is deterministic. A descriptor sequence is ordered by the
//    tuple `(fractional key, descriptor identity)`, so two concurrent members
//    can share the same fractional key without ambiguous or unstable order.
//
// =============================================================================

export const ORDER_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const DIGIT_COUNT = ORDER_ALPHABET.length; // 62
const ZERO = ORDER_ALPHABET[0];

/** True when a value is a valid fractional order key (read-side tolerance:
 *  legacy numbers and arbitrary strings simply fail this check). */
export function isOrderKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value[value.length - 1] === ZERO) return false;
  for (const char of value) {
    if (!ORDER_ALPHABET.includes(char)) return false;
  }
  return true;
}

function digitIndex(char: string): number {
  const index = ORDER_ALPHABET.indexOf(char);
  if (index < 0) throw new Error(`fractional-order: invalid digit "${char}"`);
  return index;
}

/** Midpoint of the open interval (a, b) where a/b are digit strings read as
 *  fractions in [0, 1); '' = lower bound, null b = upper bound. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`fractional-order: "${a}" >= "${b}"`);
  if (a.slice(-1) === ZERO || (b !== null && b.slice(-1) === ZERO)) {
    throw new Error('fractional-order: trailing-zero key rejected');
  }
  if (b !== null) {
    let shared = 0;
    while ((a[shared] ?? ZERO) === b[shared]) shared += 1;
    if (shared > 0) return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
  }
  const digitA = a ? digitIndex(a[0]) : 0;
  const digitB = b !== null ? digitIndex(b[0]) : DIGIT_COUNT;
  if (digitB - digitA > 1) {
    return ORDER_ALPHABET[Math.round(0.5 * (digitA + digitB))];
  }
  if (b !== null && b.length > 1) {
    return b.slice(0, 1);
  }
  return ORDER_ALPHABET[digitA] + midpoint(a.slice(1), null);
}

/** Shortest key strictly between a and b. Descriptor identity is the
 * deterministic tie-breaker at the owning sequence fold. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !isOrderKey(a)) throw new Error(`fractional-order: invalid lower key "${a}"`);
  if (b !== null && !isOrderKey(b)) throw new Error(`fractional-order: invalid upper key "${b}"`);
  return midpoint(a ?? '', b);
}

/** `count` evenly spaced, strictly increasing keys — used by migrate-by-touch
 *  to rewrite a legacy sequence in one batch. Single digits for count <= 61. */
export function spreadKeys(count: number): readonly string[] {
  if (count <= 0) return [];
  if (count <= DIGIT_COUNT - 1) {
    const keys: string[] = [];
    for (let index = 0; index < count; index += 1) {
      keys.push(ORDER_ALPHABET[1 + Math.floor((index * (DIGIT_COUNT - 1)) / count)]);
    }
    return keys;
  }
  let width = 1;
  let capacity = DIGIT_COUNT - 1;
  while (capacity < count) {
    width += 1;
    capacity *= DIGIT_COUNT;
  }
  const keys: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let value = Math.floor((index * capacity) / count);
    const last = ORDER_ALPHABET[1 + (value % (DIGIT_COUNT - 1))];
    value = Math.floor(value / (DIGIT_COUNT - 1));
    let rest = '';
    for (let position = 0; position < width - 1; position += 1) {
      rest = ORDER_ALPHABET[value % DIGIT_COUNT] + rest;
      value = Math.floor(value / DIGIT_COUNT);
    }
    keys.push(rest + last);
  }
  return keys;
}
