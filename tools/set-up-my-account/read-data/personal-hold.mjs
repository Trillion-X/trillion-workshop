// src/personal-hold.mjs
// Whether an account's own setup and waiting holds apply to this viewer: the one rule src/setup-steps.mjs and the
// workspace's first script both ask, kept apart from setup's composer so the page can ask it before setup's DATA loads.

/** Personal setup and waiting holds belong to the account's owner. A public showcase is a throwaway workspace
 *  without the visitor's AI or devices, so it has no personal setup to finish. Both exemptions come from the
 *  authenticated viewer projection; missing or malformed showcase state keeps normal personal holds enabled. */
export function personalHoldApplies(viewer) {
  return !viewer?.looking && viewer?.throwaway !== true;
}
