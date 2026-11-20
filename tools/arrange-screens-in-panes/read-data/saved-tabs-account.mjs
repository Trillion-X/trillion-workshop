// tools/arrange-screens-in-panes/read-data/saved-tabs-account.mjs
//
// The account a browser's saved tabs are kept under. The browser keeps them under one key per application, browser context and
// account. A host page that signs people in gives its signed-in identity (the arrangement's `accountRef` mount prop, which calls
// setHostAccountRef), so two people who use one browser never share saved tabs. A page with no host identity keeps the Bitfield
// account portal session's account, as before; with neither, the one shared account `anonymous` is used.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The host's identity wins over the portal session's: a host page never reads another person's tabs.
//   2. With no host identity the answer is what it was before this file existed (the portal session, else `anonymous`).

let hostRef = null;

/** The host page's signed-in identity for saved tabs, or null when the page gives none. */
export function setHostAccountRef(ref) {
  hostRef = typeof ref === 'string' && ref.trim() ? ref.trim() : null;
}

/** The host page's identity as last set, or null. */
export function hostAccountRef() {
  return hostRef;
}

/** The account a browser's saved tabs are kept under: the host's identity, else the portal session's, else `anonymous`. */
export function savedTabsAccountRef(hostIdentity, sessionAccount) {
  return hostIdentity ?? sessionAccount ?? 'anonymous';
}
