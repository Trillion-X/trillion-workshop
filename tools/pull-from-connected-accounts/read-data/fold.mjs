// tools/pull-from-connected-accounts/read-data/fold.mjs
//
// The one fold every service's pulled messages and saved items go through: put what arrived into what is already held,
// once per identity, in order. Pure: nothing is read or written here and nothing passed in is changed. What differs
// between services is the policy a source description names, never code:
//
//   key        pointers tried in order for an item's identity; signature pointers build one when none is there
//   order      pointers tried in order for the value to sort by; none means keep arrival order
//   conflict   { keep: "held" }                          the copy already held wins
//              { newer: { by: [pointers], strict } }     the copy with the later edit stamp wins; a tie goes to the
//                                                        arriving copy unless strict
//              { merge: true }                           fields of both, the arriving ones winning
import { at, isThere } from './pointer.mjs';

const NUMBER = /^-?\d+(\.\d+)?$/;
const SIGNATURE_WORDS = 120;

const below = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** -1, 0 or 1. Numbers and number-like text compare as numbers at any length (ids can pass 2^53), anything else as text. */
export function compareValues(left, right) {
  const a = String(left);
  const b = String(right);
  if (!NUMBER.test(a) || !NUMBER.test(b)) return below(a, b);
  const negative = text => text.startsWith('-');
  if (negative(a) !== negative(b)) return negative(a) ? -1 : 1;
  const [aWhole, aFraction = ''] = a.replace(/^-/, '').split('.');
  const [bWhole, bFraction = ''] = b.replace(/^-/, '').split('.');
  const whole = Math.max(aWhole.length, bWhole.length);
  const fraction = Math.max(aFraction.length, bFraction.length);
  const order = below(aWhole.padStart(whole, '0') + aFraction.padEnd(fraction, '0'), bWhole.padStart(whole, '0') + bFraction.padEnd(fraction, '0'));
  return negative(a) ? -order : order;
}

const firstThere = (item, pointers = []) => pointers.map(pointer => at(item, pointer)).find(isThere);

/** An item's identity: the first key pointer that is there, else a signature of the signature pointers, else nothing. */
export function identityOf(item, { key = [], signature = [] } = {}) {
  const found = firstThere(item, key);
  if (found !== undefined) return String(found);
  if (!signature.length) return undefined;
  return `sig:${signature.map(pointer => String(at(item, pointer) ?? '').slice(0, SIGNATURE_WORDS)).join('|')}`;
}

const isItem = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function stampOf(item, by) {
  const stamp = firstThere(item, by);
  return stamp === undefined ? '' : stamp;
}

function winner(held, arriving, conflict) {
  if (conflict.merge) return { ...held, ...arriving };
  if (conflict.newer) {
    const { by, strict = false } = conflict.newer;
    const order = compareValues(stampOf(arriving, by), stampOf(held, by));
    return (strict ? order > 0 : order >= 0) ? arriving : held;
  }
  return held;
}

/**
 * Fold `arriving` into `held`. Returns { items, added, changed, skipped }: the new list, how many identities were new, how
 * many held copies were replaced by a different one, and how many arriving objects had no identity and were left out.
 * Entries that are not objects are ignored.
 */
export function foldItems(held, arriving, policy) {
  const conflict = policy.conflict ?? { keep: 'held' };
  const items = held.filter(isItem).map(item => structuredClone(item));
  const place = new Map();
  items.forEach((item, index) => { const id = identityOf(item, policy); if (id !== undefined) place.set(id, index); });
  let added = 0;
  let changed = 0;
  let skipped = 0;
  for (const item of arriving) {
    if (!isItem(item)) continue;
    const id = identityOf(item, policy);
    if (id === undefined) { skipped += 1; continue; }
    if (place.has(id)) {
      const held = items[place.get(id)];
      const kept = winner(held, structuredClone(item), conflict);
      if (kept !== held) { items[place.get(id)] = kept; if (JSON.stringify(kept) !== JSON.stringify(held)) changed += 1; }
    } else {
      place.set(id, items.length);
      items.push(structuredClone(item));
      added += 1;
    }
  }
  const order = policy.order ?? [];
  if (order.length) {
    // An item sorts by the first order pointer it has; one with none sorts after all that do (the sort is stable).
    const rank = item => order.findIndex(pointer => isThere(at(item, pointer)));
    items.sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      const [ta, tb] = [ra < 0 ? order.length : ra, rb < 0 ? order.length : rb];
      if (ta !== tb) return ta - tb;
      return ta === order.length ? 0 : compareValues(at(a, order[ta]), at(b, order[tb]));
    });
  }
  return { items, added, changed, skipped };
}
