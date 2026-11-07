// tools/paid-access/read-data/access-grants.mjs
//
// Writing the grants that read-granted-access-refs.ts reads: the `access-grant` records a person keeps for people who
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
import { isDeepStrictEqual } from 'node:util';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { writeBatches } from '../../records-door/read-data/write-batches.mjs';
import { RECORD_TYPES } from './who-holds-access.mjs';

export const MOST_ITEMS = 256;
// Leave room below the door's 64 KiB message cap for the RPC wrapper and idempotency key.
const WRITE_ROWS = 100;
const WRITE_BYTES = 60_000;
const READ_AT_ONCE = 16;
const encoder = new TextEncoder();

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

async function inGroups(items, work) {
  const answers = [];
  for (let at = 0; at < items.length; at += READ_AT_ONCE) answers.push(...await Promise.all(items.slice(at, at + READ_AT_ONCE).map(work)));
  return answers;
}

/**
 * tool:grant-paid-access-to-people: writes one `access-grant` record per grant and per revoke, once. Answers how many it
 * wrote, how many were already there, and each item refused with its position in the request (revokes count on after the
 * grants) and why. A record that cannot be read or written throws; running the request again finishes it.
 */
export async function grantAccess(input, { door }) {
  const grants = input?.grants;
  const revokes = input?.revoke ?? [];
  if (!Array.isArray(grants) || grants.length > MOST_ITEMS) throw new Error(`grants must list at most ${MOST_ITEMS} grants.`);
  if (!Array.isArray(revokes) || revokes.length > MOST_ITEMS) throw new Error(`revoke, when given, must list at most ${MOST_ITEMS} revokes.`);
  if (grants.length === 0 && revokes.length === 0) throw new Error('list at least one grant or revoke.');

  const refused = [];
  const asked = new Map();
  let already = 0;
  const wanted = [...grants.map(item => ({ ...grantRow(item), kind: 'grant' })), ...revokes.map(item => ({ ...revokeRow(item), kind: 'revoke' }))];
  wanted.forEach((row, index) => {
    if (row.reason) { refused.push({ index, reason: row.reason }); return; }
    const same = asked.get(row.id);
    if (!same) asked.set(row.id, { ...row, index });
    else if (isDeepStrictEqual(same.value, row.value)) already += 1;
    else refused.push({ index, reason: `an earlier item in this request gives ${row.id} different terms` });
  });

  const rows = [...asked.values()];
  const held = await inGroups(rows, async row => ({
    existing: await door.read(RECORD_TYPES.grant, row.id),
    revoked: row.kind === 'grant' ? await door.read(RECORD_TYPES.grant, revokeId(row.subject, row.grantRef)) : null,
  }));
  const fresh = [];
  rows.forEach((row, at) => {
    const { existing, revoked } = held[at];
    if (revoked) refused.push({ index: row.index, reason: `${row.grantRef} was ended for ${row.subject} and stays ended; give this grant a new grant_ref` });
    else if (!existing) fresh.push(row);
    else if (isDeepStrictEqual(existing, row.value)) already += 1;
    else refused.push({ index: row.index, reason: `${row.id} is already kept with different terms; revoke ${row.grantRef} or give this grant a new grant_ref` });
  });

  const records = [];
  for (const row of fresh) {
    const record = { id: row.id, type: RECORD_TYPES.grant, value: row.value, expected: null };
    if (encoder.encode(JSON.stringify(record)).length > WRITE_BYTES) {
      refused.push({ index: row.index, reason: `this access-grant record exceeds the ${WRITE_BYTES}-byte write limit; shorten its subject, grant_ref or note` });
    } else records.push(record);
  }
  const batches = writeBatches(records, { rows: WRITE_ROWS, bytes: WRITE_BYTES });
  for (const batch of batches) {
    const key = `grant-paid-access:${makeHashCodeHexFromBytes(encoder.encode(JSON.stringify(batch)))}`;
    await door.write(batch, { key });
  }
  return { written: records.length, already, refused: refused.sort((left, right) => left.index - right.index) };
}
