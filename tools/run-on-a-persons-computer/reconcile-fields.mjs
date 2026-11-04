// computer/reconcile-fields.mjs
//
// Purpose: when this Mac keeps something on the account (its agent card, a setting) it sends only what the account does
// not already hold. `reconcile(desired, held)` answers the fields that differ; a caller whose route takes the whole
// object sends it only when something differs, and one whose route takes a patch sends just the patch.
//
// Non-negotiable invariants
//   1. Equality is by content, never by key order or object identity: objects and arrays are compared deeply.
//   2. A field the account holds that this side does not name is left alone (it is not in the patch and not a change),
//      unless `exact` is set, which also lists them as `removed`.
//   3. What the account holds is only what it last accepted from this side (`held`); with nothing held, every field differs.
const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Array.isArray(a) ? [...a.keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])];
  if (Array.isArray(a) && a.length !== b.length) return false;
  return keys.every(key => same(a[key], b[key]));
};

/** → { patch: { field: value }, changed: [field], removed: [field], holds: boolean } */
export function reconcile(desired, held, { exact = false } = {}) {
  const patch = {};
  for (const [field, value] of Object.entries(desired ?? {})) if (!same(value, held?.[field])) patch[field] = value;
  const removed = exact ? Object.keys(held ?? {}).filter(field => !Object.hasOwn(desired ?? {}, field)) : [];
  const changed = [...Object.keys(patch), ...removed];
  return { patch, changed, removed, holds: changed.length === 0 };
}
