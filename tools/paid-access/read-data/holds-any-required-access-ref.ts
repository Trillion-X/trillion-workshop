// tools/paid-access/read-data/holds-any-required-access-ref.ts
//
// The one entitlement rule a paid thing is opened by: the buyer holds ANY of its required access refs, and a thing
// that requires none is open to everyone. Copied unchanged from bitfield-packages
// packages/access-scoped-content/read-data/resolve-viewer-access.ts (holdsAnyRequiredAccessRef), the package that
// owned the rule; only this function came, because nothing else there is about access.
//
// The held refs are worked out by `who-holds-access.mjs` in this folder, from the buyer's payment events, the offer
// rows and any grants the person wrote. Both the paid-file gate and the scope check use this one rule.

export function holdsAnyRequiredAccessRef(
  heldAccessRefs: readonly string[],
  requiredAccessRefs: readonly string[],
): boolean {
  if (requiredAccessRefs.length === 0) return true;
  const held = new Set(heldAccessRefs);
  return requiredAccessRefs.some((accessRef) => held.has(accessRef));
}
