// tools/space-members/do-work/space-members.mjs
//
// The functions the membership rows run, one per job, through the records-door command:
//   node /opt/records-door/do-work/run-an-export.mjs /opt/space-members/do-work/space-members.mjs <function> < input.json
// Each is `(input) => result`. `subject` is the person the caller verified; these tools trust their caller for it.
// A person joins, leaves and names themselves; whether anyone counts as a member now is the one reader's answer
// (read-data/member-now.mjs), asked again on every call. The run reads no store and keeps nothing: the caller's AI reads
// the records the ask needs from a store and hands them in as `records` ([{ id, type, value }]: the space's row, the
// member rows, and the payment events, offers, grants, rules and lifecycle a join by access reads), and what a call
// would store comes back as `keep` ([{ id, type, value }], the whole row), for the caller to store.
import { keepRow, object, prefixOf, readMember, readSpace, refuse, rowId, rowsWithPrefix, words } from '../read-data/space-rows.mjs';
import { admission, howToJoin, memberNow, wordsFor } from '../read-data/member-now.mjs';
import { heldAccessOf, heldAccessReader, asksForAccess } from '../read-data/held-access.mjs';
import { joinsAs, memberTypesOf } from '../read-data/member-types.mjs';

const NAME_MOST = 80;

/** The records handed in, as the readers in read-data reach them, and the rows a call would keep (never stored here). */
function recordsFrom(input) {
  const records = (Array.isArray(input?.records) ? input.records : []).filter(record => object(record) && typeof record.id === 'string' && typeof record.type === 'string' && object(record.value));
  const keep = [];
  const door = {
    async read(type, id) { return records.find(record => record.type === type && record.id === id)?.value ?? null; },
    async *list({ type, prefix } = {}) {
      for (const record of records.filter(one => one.type === type && (!prefix || one.id.startsWith(prefix))).sort((a, b) => (a.id < b.id ? 1 : -1))) yield record;
    },
    async write(items) { for (const { id, type, value } of items) keep.push({ id, type, value }); },
  };
  return { door, keep };
}

const answered = (result, keep) => (keep.length ? { ...result, keep } : result);

function subjectOf(input) {
  const subject = words(input?.subject);
  if (!subject) refuse('subject must name the person, the way the space and your access rules name them.');
  return subject;
}

/** tool:join-a-space: a person joins by a join row that holds for them now. A person already in is answered, not rewritten. */
export async function joinASpace(input) {
  const { door, keep } = recordsFrom(input);
  const subject = subjectOf(input);
  const { id, value: space } = await readSpace(door, input?.space);
  const existing = await readMember(door, id, subject);
  const held = await heldAccessOf(door, space, subject, Date.now());
  const now = memberNow({ space, subject, member: existing, held_access_refs: held });
  if (now.member) return { space: id, subject, joined: false, state: now.state, member_type: existing.member_type, how: existing.how };
  if (existing?.state === 'removed') refuse(wordsFor(space, 'removed'));
  const { admitted, how } = admission(space, { invited: false, held_access: held });
  if (!admitted) refuse(wordsFor(space, 'refused', { how: howToJoin(space) }));
  const name = input?.name === undefined ? existing?.name : words(input.name)?.slice(0, NAME_MOST);
  const value = {
    space: id, subject, member_type: joinsAs(space), state: 'member', how,
    joined_at: new Date(Date.now()).toISOString(), ...(name ? { name } : {}),
  };
  await keepRow(door, 'member', rowId('member', id, subject), value, existing);
  return answered({ space: id, subject, joined: true, state: 'member', member_type: value.member_type, how }, keep);
}

/** tool:leave-a-space: a member goes. What they put there stays; the owner cannot leave without handing the space over. */
export async function leaveASpace(input) {
  const { door, keep } = recordsFrom(input);
  const subject = subjectOf(input);
  const { id, value: space } = await readSpace(door, input?.space);
  const existing = await readMember(door, id, subject);
  if (!existing || existing.state !== 'member') return { space: id, subject, left: false, state: existing?.state ?? 'none' };
  if (subject === space.owner) refuse('The person who runs a space cannot leave it: hand it over first.');
  await keepRow(door, 'member', rowId('member', id, subject), { ...existing, state: 'left', ended_at: new Date(Date.now()).toISOString() }, existing);
  return answered({ space: id, subject, left: true, state: 'left' }, keep);
}

/** tool:check-someone-is-in-a-space: the one answer to "is this person a member now", with how they came in and their type. */
export async function checkSomeoneIsInASpace(input) {
  const { door } = recordsFrom(input);
  const subject = subjectOf(input);
  const { id, value: space } = await readSpace(door, input?.space);
  const member = await readMember(door, id, subject);
  const now = memberNow({ space, subject, member, held_access_refs: await heldAccessOf(door, space, subject, Date.now()) });
  return { space: id, subject, ...now, member_type: member?.member_type ?? null, how: member?.how ?? null };
}

/** tool:list-a-spaces-members: each person's name as they chose to show it and their type, with whether they count now. Never a contact. */
export async function listASpacesMembers(input) {
  const { door } = recordsFrom(input);
  const { id, value: space } = await readSpace(door, input?.space);
  const requester = subjectOf(input);
  const reader = asksForAccess(space) ? await heldAccessReader(door, Date.now()) : null;
  const heldBy = subject => (reader ? reader.heldBy(subject) : []);
  const rows = await rowsWithPrefix(door, 'member', prefixOf('member', id));
  const mine = rows.find(row => row.value.subject === requester)?.value ?? null;
  if (!memberNow({ space, subject: requester, member: mine, held_access_refs: heldBy(requester) }).member) refuse(wordsFor(space, 'refused', { how: howToJoin(space) }));
  const types = new Map(memberTypesOf(space).map(type => [type.id, type.label]));
  const members = rows.map(row => ({ row: row.value, now: memberNow({ space, subject: row.value.subject, member: row.value, held_access_refs: heldBy(row.value.subject) }) }))
    .filter(({ now }) => now.member || input?.include_ended === true)
    .map(({ row, now }) => ({
      member_id: row.subject, name: row.name ?? null, member_type: row.member_type,
      member_type_label: types.get(row.member_type) ?? row.member_type, state: now.state, joined_at: row.joined_at,
    }));
  return { space: id, members };
}

/** tool:choose-the-name-i-show-in-a-space: the name other members read for them in this space. */
export async function chooseTheNameIShowInASpace(input) {
  const { door, keep } = recordsFrom(input);
  const subject = subjectOf(input);
  const name = words(input?.name);
  if (!name || name.length > NAME_MOST) refuse(`name needs 1 to ${NAME_MOST} characters.`);
  const { id, value: space } = await readSpace(door, input?.space);
  const existing = await readMember(door, id, subject);
  const now = memberNow({ space, subject, member: existing, held_access_refs: await heldAccessOf(door, space, subject, Date.now()) });
  if (!now.member) refuse(now.reason);
  await keepRow(door, 'member', rowId('member', id, subject), { ...existing, name }, existing);
  return answered({ space: id, subject, name }, keep);
}
