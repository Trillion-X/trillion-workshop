// src/change-from-elsewhere.mjs
//
// PURPOSE
//   Says whether a browser sent a change (any method but GET, HEAD or OPTIONS) from a page of another origin. Signed-in
//   roads refuse such a change once, at their entry (src/worker.mjs work()), instead of road by road. This matters because
//   customer sites are served on this service's own site (id.app.gettrillion.ai, and name.sites.gettrillion.ai until it forwards to name.trillion.run): the sign-in
//   cookie's SameSite=Lax rule treats those pages as the same site, so a script on any customer page would otherwise send
//   a signed-in visitor's cookie with every change it asks for.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a browser's own word refuses: Sec-Fetch-Site other than same-origin or none, or an Origin header naming
//      another origin. A program that is not a browser sends neither and is judged by its own key, as before.
//   2. Reading (GET, HEAD, OPTIONS) is never refused here; reads never change anything.
//
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True when `request` is a change a browser sent from a page whose origin is not `origin`. */
export function changeFromElsewhere(request, origin) {
  if (SAFE_METHODS.has(request.method)) return false;
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const from = request.headers.get('origin');
  return Boolean(from) && from !== origin;
}
