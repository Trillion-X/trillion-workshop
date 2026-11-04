// src/telemetry-gate.mjs
//
// Purpose: the one gate every telemetry sink reads before it sends or keeps anything about a page or an event. The
// decision is derived from the privacy class of the data being served (src/telemetry-privacy.json), never from the
// sink: a page in a space other people share, or a customer's records, sends less than a public page, whatever sink
// asks.
//
// Non-Negotiable Invariants:
//   1. Fails closed. A surface and path no route row names, and a declared class that is not a row, are the DATA's
//      `unknown_class`, which feeds no sink: not known yet means private.
//   2. When two sources name a class (the route and the handler's header), the more private one (higher rank) wins: a
//      handler can make a page more private, never less.
//   3. No class, sink or route is named in code: each is a row of src/telemetry-privacy.json.
//
//   classOf({ surface, path, declared }) → class id
//   sends(classId, sink) → boolean
//   pageSends({ surface, path, headers }, sink) → boolean (a served response's class, from its route and header)
import privacy from './telemetry-privacy.json' with { type: 'json' };

export const TELEMETRY_PRIVACY = privacy;
const CLASSES = new Map(privacy.classes.map(row => [row.id, row]));
const UNKNOWN = CLASSES.get(privacy.unknown_class);
const known = id => CLASSES.get(id) ?? UNKNOWN;
const pathOf = path => (typeof path === 'string' && path.startsWith('/') ? path.split(/[?#]/)[0] : '/');
const under = (path, prefix) => prefix === '/' || path === prefix || path.startsWith(`${prefix}/`);

/** The class of what a surface serves at a path: the longest route prefix that matches, made more private by a declared
 *  class (a handler's header) when that names a more private row. */
export function classOf({ surface, path, declared = null }) {
  const at = pathOf(path);
  const route = privacy.routes
    .filter(row => row.surface === surface && under(at, row.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  const fromRoute = route ? known(route.class) : UNKNOWN;
  if (declared == null || declared === '') return fromRoute.id;
  const fromHeader = known(declared);
  return (fromHeader.rank > fromRoute.rank ? fromHeader : fromRoute).id;
}

/** Whether a class may feed a sink. */
export const sends = (classId, sink) => known(classId).sinks.includes(sink);

/** Whether a served response may feed a sink, from its surface, path and the class its handler declared. */
export const pageSends = ({ surface, path, headers }, sink) =>
  sends(classOf({ surface, path, declared: headers?.get?.(privacy.header) ?? null }), sink);
