// tools/space-members/do-work/space-members.mjs
//
// The functions the membership rows run, one per job: `(input) => result`, run by do-work/space-members-run.mjs. `subject` is
// the person the caller verified; these tools trust their caller for it. A person joins, leaves and names themselves; whether
// anyone counts as a member now is the one reader's answer (read-data/member-now.mjs), asked again on every call. The run reads
// no store and writes none: the caller's AI reads the records the ask needs from its own store and hands them in as `records`
// ([{ id, type, value }]: the space's row, the member rows, and the payment events, offers, grants, rules and lifecycle a join by
// access reads), and each row a call would change comes back under `keep` ([{ id, type, value, expected }]) for the caller to
// store. A store refuses a keep whose `expected` record has moved since it was read.
import { KINDS, keepRow, prefixOf, readMember, readSpace, recordOf, recordsIn, refuse, rowId, rowsWithPrefix, words } from '../read-data/space-rows.mjs';
import { admission, howToJoin, joinRowProblems, memberNow, wordsFor } from '../read-data/member-now.mjs';
import { asksForAccess, heldAccessOf, heldAccessReader } from '../read-data/held-access.mjs';
import { joinsAs, memberTypesOf } from '../read-data/member-types.mjs';

const NAME_MOST = 80;
const TITLE_MOST = 120;
// The labels a space can start with here (DATA: tools/space-member-types). A community is joined by its own rules, not made here.
const MADE_LABELS = ['group', 'project', 'event', 'one-to-one', 'stay'];

/** The answer, with the rows a call would change under `keep` (none when it changes nothing). */
function answered(result, ...keeps) {
  const keep = keeps.filter(Boolean);
  return keep.length ? { ...result, keep } : result;
}

function subjectOf(input) {
  const subject = words(input?.subject);
  if (!subject) refuse('subject must name the person, the way the space and your access rules name them.');
  return subject;
}

/** tool:join-a-space: a person joins by a join row that holds for them now. A person already in is answered, not rewritten. */
export function joinASpace(input) {
  const records = recordsIn(input);
  const subject = subjectOf(input);
  const { id, value: space } = readSpace(records, input?.space);
  const handed = readMember(records, id, subject);
  const existing = handed?.value ?? null;
  const held = heldAccessOf(records, space, subject, Date.now());
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
  return answered({ space: id, subject, joined: true, state: 'member', member_type: value.member_type, how },
    keepRow('member', rowId('member', id, subject), value, handed));
}

/** tool:leave-a-space: a member goes. What they put there stays; the owner cannot leave without handing the space over. */
export function leaveASpace(input) {
  const records = recordsIn(input);
  const subject = subjectOf(input);
  const { id, value: space } = readSpace(records, input?.space);
  const handed = readMember(records, id, subject);
  const existing = handed?.value ?? null;
  if (!existing || existing.state !== 'member') return { space: id, subject, left: false, state: existing?.state ?? 'none' };
  if (subject === space.owner) refuse('The person who runs a space cannot leave it: hand it over first.');
  const value = { ...existing, state: 'left', ended_at: new Date(Date.now()).toISOString() };
  return answered({ space: id, subject, left: true, state: 'left' }, keepRow('member', rowId('member', id, subject), value, handed));
}

/** tool:create-a-space (the old create_membership): a person starts a shared space with themselves as its owner and first member.
 * The space row and the owner's member row come back under `keep`; nothing is read from a store. An id already in the records is refused. */
export function createASpace(input) {
  const records = recordsIn(input);
  const subject = subjectOf(input);
  const id = words(input?.space);
  if (!id) refuse('space must name the new space: its id, the last part of its record:space row id.');
  if (recordOf(records, KINDS.space, rowId('space', id))) refuse('A space with this id already exists; choose another id.');
  const title = words(input?.title)?.slice(0, TITLE_MOST);
  if (!title) refuse('title must say what the space is.');
  const label = input?.label === undefined ? 'group' : words(input.label);
  if (!MADE_LABELS.includes(label)) refuse(`label must be one of ${MADE_LABELS.join(', ')}.`);
  const join = input?.join === undefined ? [] : input.join;
  if (!Array.isArray(join)) refuse('join must be a list of join rows.');
  if (join.length) {
    const problems = joinRowProblems(join);
    if (problems.length) refuse(problems[0]);
  }
  const space = { title, owner: subject, label, config: { join } };
  const member = { space: id, subject, member_type: 'owner', state: 'member', how: 'owner', joined_at: new Date(Date.now()).toISOString() };
  return answered({ space: id, subject, created: true, label, state: 'member', member_type: member.member_type },
    keepRow('space', rowId('space', id), space, null), keepRow('member', rowId('member', id, subject), member, null));
}

/** tool:check-someone-is-in-a-space: the one answer to "is this person a member now", with how they came in and their type. */
export function checkSomeoneIsInASpace(input) {
  const records = recordsIn(input);
  const subject = subjectOf(input);
  const { id, value: space } = readSpace(records, input?.space);
  const member = readMember(records, id, subject)?.value ?? null;
  const now = memberNow({ space, subject, member, held_access_refs: heldAccessOf(records, space, subject, Date.now()) });
  return { space: id, subject, ...now, member_type: member?.member_type ?? null, how: member?.how ?? null };
}

/** tool:list-a-spaces-members: each person's name as they chose to show it and their type, with whether they count now. Never a contact. */
export function listASpacesMembers(input) {
  const records = recordsIn(input);
  const { id, value: space } = readSpace(records, input?.space);
  const requester = subjectOf(input);
  const reader = asksForAccess(space) ? heldAccessReader(records, Date.now()) : null;
  const heldBy = subject => (reader ? reader.heldBy(subject) : []);
  const rows = rowsWithPrefix(records, 'member', prefixOf('member', id));
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
export function chooseTheNameIShowInASpace(input) {
  const records = recordsIn(input);
  const subject = subjectOf(input);
  const name = words(input?.name);
  if (!name || name.length > NAME_MOST) refuse(`name needs 1 to ${NAME_MOST} characters.`);
  const { id, value: space } = readSpace(records, input?.space);
  const handed = readMember(records, id, subject);
  const existing = handed?.value ?? null;
  const now = memberNow({ space, subject, member: existing, held_access_refs: heldAccessOf(records, space, subject, Date.now()) });
  if (!now.member) refuse(now.reason);
  return answered({ space: id, subject, name }, keepRow('member', rowId('member', id, subject), { ...existing, name }, handed));
}
