// tools/paid-access/read-data/access-grants.mjs
//
// The values of the grants that read-granted-access-refs.ts reads (pure: values in, values out; the keeping is the store's,
// see workflow:keep-paid-access-grants): the `access-grant` records a person keeps for people who
// hold access by hand (a member who moved over from somewhere else, a gift, a pass with an end date) and the revokes
// that end one.
//
//   grant:  { kind: "license_access", subject, object: <access ref>, material: { grant_ref, valid_from_ms?, expires_at_ms? } }
//   revoke: { kind: "revoke", subject, material: { revokes_grant_ref } }
//
// A record's id comes from the subject and the grant's reference alone, so asking again for the same grant finds the
// record it wrote and writes nothing. A grant left without a `grant_ref` is named `grant:<access ref>`, so one person
// holds one such grant per access ref. The rules for a window are the reader's: both ends or neither, whole
// milliseconds, the end after the start; anything else the reader would never hold, so it is refused here with why.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const words = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const wholeMs = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const defaultGrantRef = accessRef => `grant:${accessRef}`;
export const grantId = (subject, grantRef) => `access-grant:${encodeURIComponent(subject)}:grant:${encodeURIComponent(grantRef)}`;
export const revokeId = (subject, grantRef) => `access-grant:${encodeURIComponent(subject)}:revoke:${encodeURIComponent(grantRef)}`;

function windowProblem({ valid_from_ms: from, expires_at_ms: to }) {
  if (from === undefined && to === undefined) return null;
  if (!wholeMs(from) || !wholeMs(to)) {
    return 'a grant with an end date needs both valid_from_ms and expires_at_ms, as whole milliseconds since 1970 (0 or more); with only one, or one that is not a whole number, it would never be held';
  }
  return to > from ? null : 'expires_at_ms must be after valid_from_ms; a window that ends before it starts would never be held';
}

/** One grant item as the record to write, or the reason it is refused. */
export function grantRow(item) {
  if (!object(item)) return { reason: 'a grant is an object: { subject, access_ref, grant_ref?, valid_from_ms?, expires_at_ms?, note? }' };
  const subject = words(item.subject);
  const accessRef = words(item.access_ref);
  if (!subject) return { reason: 'subject must name the person, the way your access rules name a buyer (for the starter rules, their email address)' };
  if (!accessRef) return { reason: 'access_ref must name the access given, like "access:course-a"' };
  if (item.grant_ref !== undefined && !words(item.grant_ref)) return { reason: 'grant_ref, when given, must be words that name this grant' };
  if (item.note !== undefined && typeof item.note !== 'string') return { reason: 'note, when given, must be text' };
  const problem = windowProblem(item);
  if (problem) return { reason: problem };
  const grantRef = words(item.grant_ref) ?? defaultGrantRef(accessRef);
  const material = { grant_ref: grantRef };
  if (item.valid_from_ms !== undefined) material.valid_from_ms = item.valid_from_ms;
  if (item.expires_at_ms !== undefined) material.expires_at_ms = item.expires_at_ms;
  const value = { kind: 'license_access', subject, object: accessRef, material };
  if (words(item.note)) value.note = item.note.trim();
  return { id: grantId(subject, grantRef), subject, grantRef, value };
}

/** One revoke item as the record to write, or the reason it is refused. */
export function revokeRow(item) {
  if (!object(item)) return { reason: 'a revoke is an object: { subject, grant_ref }' };
  const subject = words(item.subject);
  const grantRef = words(item.grant_ref);
  if (!subject) return { reason: 'subject must name the person the grant was given to' };
  if (!grantRef) return { reason: 'grant_ref must name the grant to end (a grant given without one is named "grant:" and its access ref)' };
  return { id: revokeId(subject, grantRef), subject, grantRef, value: { kind: 'revoke', subject, material: { revokes_grant_ref: grantRef } } };
}
