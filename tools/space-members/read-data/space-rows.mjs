// tools/space-members/read-data/space-rows.mjs
//
// The one owner of the rows a shared space keeps and how they are written: the record kinds, their ids, and a write that
// creates or replaces one row and answers whether anything changed. Every space tool (membership, invitations, posts,
// permissions, visibility, RSVPs, rewards) names its rows through this file, so an id is spelled once.
//
// An id is made from the parts that make the row unique and nothing else, so asking for the same thing twice finds the
// row it wrote and writes nothing. A part is percent-encoded, so a subject such as an email address or a space name
// holding ":" cannot read as two parts.
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
};

const part = value => encodeURIComponent(String(value));

/** The id of the row of `kind` made from `parts`, in the order the contract names them. */
export const rowId = (kind, ...parts) => `${KINDS[kind]}:${parts.map(part).join(':')}`;

/** The id prefix every row of `kind` that starts with the same first part shares (every member of one space, say). */
export const prefixOf = (kind, first) => `${KINDS[kind]}:${part(first)}:`;

export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const words = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** One run's refusal in words a person's AI can read: thrown, so the container answers { error } and the run fails. */
export class SpaceRefusal extends Error {}
export const refuse = sentence => { throw new SpaceRefusal(sentence); };

/** The space's row value, or a refusal that reveals nothing more than "no such space". */
export async function readSpace(door, space) {
  const id = words(space);
  if (!id) refuse('space must name the space.');
  const value = await door.read(KINDS.space, rowId('space', id));
  if (!value) refuse('No space with that id.');
  return { id, value };
}

/** The member row of one person in one space, or null. */
export const readMember = (door, space, subject) => door.read(KINDS.member, rowId('member', space, subject));

/**
 * Creates the row, or replaces it when it exists, in one compare-and-set write: a row changed by another run since it was
 * read is refused by the door, never overwritten. Answers { written, value }; a row that already holds this value is not
 * written again.
 */
export async function keepRow(door, kind, id, value, existing) {
  const held = existing === undefined ? await door.read(KINDS[kind], id) : existing;
  if (held && isDeepStrictEqual(held, value)) return { written: false, value };
  await door.write([{ id, type: KINDS[kind], value, expected: held ? { type: KINDS[kind], value: held } : null }]);
  return { written: true, value };
}

/** Every row of `kind` whose id starts with `prefix`, with its value, in the door's order. */
export async function rowsWithPrefix(door, kind, prefix) {
  const rows = [];
  for await (const record of door.list({ type: KINDS[kind], prefix })) rows.push(record);
  return rows;
}
