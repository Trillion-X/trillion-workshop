// src/egress-disclosure.mjs
//
// PURPOSE
//   Keeps the list of what leaves the device per route kind (src/egress-disclosure.json) honest against the routes Trillion actually
//   walks (src/model-routes.json): every route kind in use must be disclosed, and a disclosed kind must exist.
//
import disclosure from './egress-disclosure.json' with { type: 'json' };

/** Every route kind that appears anywhere in a routes document. */
export function routeKindsIn(routes) {
  const kinds = new Set();
  const walk = node => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') { if (typeof node.kind === 'string') kinds.add(node.kind); Object.values(node).forEach(walk); }
  };
  walk(routes);
  return kinds;
}

/** { undisclosed, unused }: kinds sent through with no row, and rows for kinds nothing uses. */
export function checkDisclosure(routes, rows = disclosure.kinds) {
  const used = routeKindsIn(routes);
  const known = new Set(rows.map(row => row.kind));
  return { undisclosed: [...used].filter(kind => !known.has(kind)), unused: [...known].filter(kind => !used.has(kind)) };
}

/** What a route kind sends and where, for a screen or a page; null when it is not disclosed. */
export const disclosureOf = (kind, rows = disclosure.kinds) => rows.find(row => row.kind === kind) ?? null;
