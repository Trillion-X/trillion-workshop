// tools/space-members/read-data/space-rows.mjs
//
// The one owner of the rows a shared space keeps and how a change to one is kept: the record kinds, their ids, the records
// a run is handed, and the keep of one changed row. Every space tool (membership, invitations, posts, permissions, visibility,
// RSVPs, rewards) names its rows through this file, so an id is spelled once.
//
// An id is made from the parts that make the row unique and nothing else, so asking for the same thing twice finds the
// row it was handed and keeps nothing. A part is percent-encoded, so a subject such as an email address or a space name
// holding ":" cannot read as two parts.
//
// The run reads and writes no store. The caller reads the rows it needs from its own store and hands them in as records
// ({ id, type, value }); a row a run changes comes back under `keep` as { id, type, value, expected }, where `expected` is the
// record as it was handed in (null for a new row), so the store refuses the write when that row has moved since.
import { isDeepStrictEqual } from 'node:util';

export const KINDS = {
  space: 'record:space',
  member: 'record:space-member',
  invitation: 'record:space-invitation',
  item: 'record:space-item',
  reaction: 'record:space-reaction',
  rsvp: 'record:space-rsvp',
  fact: 'record:space-fact',
  claim: 'record:space-reward-claim',
  handover: 'record:space-handover',
};

const part = value => encodeURIComponent(String(value));

/** The id of the row of `kind` made from `parts`, in the order the contract names them. */
export const rowId = (kind, ...parts) => `${KINDS[kind]}:${parts.map(part).join(':')}`;

/** The id prefix every row of `kind` that starts with the same first part shares (every member of one space, say). */
export const prefixOf = (kind, first) => `${KINDS[kind]}:${part(first)}:`;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const words = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** One run's refusal in words a person's AI can read: thrown, so the container answers { error } and the run fails. */
export class SpaceRefusal extends Error {}
export const refuse = sentence => { throw new SpaceRefusal(sentence); };

/** The records a run is handed, each { id, type, value }; one that is not well formed is not there. */
export function recordsIn(input) {
  return (Array.isArray(input?.records) ? input.records : [])
    .filter(record => object(record) && typeof record.id === 'string' && typeof record.type === 'string' && object(record.value));
}

/** The record of one type and id among those handed in, or null. */
export const recordOf = (records, type, id) => records.find(record => record.type === type && record.id === id) ?? null;

/** The space's row, or a refusal that reveals nothing more than "no such space". */
export function readSpace(records, space) {
  const id = words(space);
  if (!id) refuse('space must name the space.');
  const record = recordOf(records, KINDS.space, rowId('space', id));
  if (!record) refuse('No space with that id.');
  return { id, value: record.value };
}

/** The member record (as it was handed in) of one person in one space, or null. */
export const readMember = (records, space, subject) => recordOf(records, KINDS.member, rowId('member', space, subject));

/**
 * The keep of one row a run changes: { id, type, value, expected }, where `expected` is the record as it was handed in
 * (`handed`, null when the row is new). A row that already holds this value keeps nothing: answers null.
 */
export function keepRow(kind, id, value, handed) {
  if (handed && isDeepStrictEqual(handed.value, value)) return null;
  return { id, type: KINDS[kind], value, expected: handed ? { id: handed.id, type: handed.type, value: handed.value } : null };
}

/** Every record of `kind` whose id starts with `prefix`, newest id first. */
export function rowsWithPrefix(records, kind, prefix) {
  return records.filter(record => record.type === KINDS[kind] && record.id.startsWith(prefix)).sort((a, b) => (a.id < b.id ? 1 : -1));
}
