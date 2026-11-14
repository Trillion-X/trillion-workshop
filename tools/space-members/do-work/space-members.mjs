// tools/space-members/do-work/space-members.mjs
//
// The functions the membership rows run, one per job, through the records-door command:
//   node /opt/records-door/do-work/run-an-export.mjs /opt/space-members/do-work/space-members.mjs <function> < input.json
// Each is `(input, { door }) => result`. `subject` is the person the door verified; these tools trust their caller for it.
// A person joins, leaves and names themselves; whether anyone counts as a member now is the one reader's answer
// (read-data/member-now.mjs), asked again on every call.
import { keepRow, prefixOf, readMember, readSpace, refuse, rowId, rowsWithPrefix, words } from '../read-data/space-rows.mjs';
import { admission, howToJoin, memberNow, wordsFor } from '../read-data/member-now.mjs';
import { heldAccessOf, heldAccessReader, asksForAccess } from '../read-data/held-access.mjs';
import { joinsAs, memberTypesOf } from '../read-data/member-types.mjs';

const NAME_MOST = 80;

function subjectOf(input) {
  const subject = words(input?.subject);
  if (!subject) refuse('subject must name the person, the way the space and your access rules name them.');
  return subject;
}

/** tool:join-a-space: a person joins by a join row that holds for them now. A person already in is answered, not rewritten. */
export async function joinASpace(input, { door }) {
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
  return { space: id, subject, joined: true, state: 'member', member_type: value.member_type, how };
}

/** tool:leave-a-space: a member goes. What they put there stays; the owner cannot leave without handing the space over. */
export async function leaveASpace(input, { door }) {
  const subject = subjectOf(input);
  const { id, value: space } = await readSpace(door, input?.space);
  const existing = await readMember(door, id, subject);
  if (!existing || existing.state !== 'member') return { space: id, subject, left: false, state: existing?.state ?? 'none' };
  if (subject === space.owner) refuse('The person who runs a space cannot leave it: hand it over first.');
  await keepRow(door, 'member', rowId('member', id, subject), { ...existing, state: 'left', ended_at: new Date(Date.now()).toISOString() }, existing);
  return { space: id, subject, left: true, state: 'left' };
}

/** tool:check-someone-is-in-a-space: the one answer to "is this person a member now", with how they came in and their type. */
export async function checkSomeoneIsInASpace(input, { door }) {
  const subject = subjectOf(input);
  const { id, value: space } = await readSpace(door, input?.space);
  const member = await readMember(door, id, subject);
  const now = memberNow({ space, subject, member, held_access_refs: await heldAccessOf(door, space, subject, Date.now()) });
  return { space: id, subject, ...now, member_type: member?.member_type ?? null, how: member?.how ?? null };
}

/** tool:list-a-spaces-members: each person's name as they chose to show it and their type, with whether they count now. Never a contact. */
export async function listASpacesMembers(input, { door }) {
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
export async function chooseTheNameIShowInASpace(input, { door }) {
  const subject = subjectOf(input);
  const name = words(input?.name);
  if (!name || name.length > NAME_MOST) refuse(`name needs 1 to ${NAME_MOST} characters.`);
  const { id, value: space } = await readSpace(door, input?.space);
  const existing = await readMember(door, id, subject);
  const now = memberNow({ space, subject, member: existing, held_access_refs: await heldAccessOf(door, space, subject, Date.now()) });
  if (!now.member) refuse(now.reason);
  await keepRow(door, 'member', rowId('member', id, subject), { ...existing, name }, existing);
  return { space: id, subject, name };
}
