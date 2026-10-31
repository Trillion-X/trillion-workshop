// tools/person-profile/do-work/save-member-profile.mjs
//
// Read and save one member's profile record through the run's records door. Ported from bitfield-packages
// packages/person-profile/do-work/save-member-profile.ts: the old runtime's address read and write-batch are the
// door's read and write, and the browser cache that followed a save belongs to the screen, so it is not here.
//
// A profile is one record of type `member-profile` with id `member-profile:<who>`. A save keeps every field the record
// already holds (a role set elsewhere stays), changes only the fields it is given, writes once, then reads the record
// back and refuses to say it saved unless the changed fields read back as written.
export const PROFILE_TYPE = 'member-profile';
const PROFILE_KIND = 'person-profile.member-profile/v1';
const FIELDS = ['display_name', 'about', 'email'];
const idFor = who => `${PROFILE_TYPE}:${who}`;

function check(who) {
  if (typeof who !== 'string' || !who || who.length > 200) throw new Error('Profile identity is unavailable.');
}

async function readRecord(door, who) {
  const value = await door.read(PROFILE_TYPE, idFor(who));
  if (value === null || value === undefined) return null;
  if (value.kind !== PROFILE_KIND || value.actor_ref !== who) throw new Error('Saved profile is unavailable.');
  return value;
}

const fieldsOf = value => ({
  display_name: typeof value.display_name === 'string' ? value.display_name : '',
  about: typeof value.about === 'string' ? value.about : '',
  ...(typeof value.email === 'string' ? { email: value.email } : {}),
});

/** The profile's fields, or null when this person has none yet. */
export async function readMemberProfile({ who }, { door }) {
  check(who);
  const value = await readRecord(door, who);
  return { profile: value ? fieldsOf(value) : null };
}

/** Save the fields given (display_name, about, email) onto the profile; the rest of the record stays as it was. */
export async function saveMemberProfile({ who, fields }, { door }) {
  check(who);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Send fields: the profile fields to save.');
  const given = Object.keys(fields);
  const unknown = given.filter(name => !FIELDS.includes(name));
  if (unknown.length > 0) throw new Error(`Unknown profile field: ${unknown[0]}. The fields are ${FIELDS.join(', ')}.`);
  if (given.length === 0) throw new Error('Send at least one field to save.');
  if (given.some(name => typeof fields[name] !== 'string')) throw new Error('Each field to save is text.');
  const prior = await readRecord(door, who);
  const changed = Object.fromEntries(given.map(name => [name, fields[name].trim()]));
  const value = {
    ...prior,
    kind: PROFILE_KIND,
    actor_ref: who,
    updated_at: new Date().toISOString(),
    display_name: prior?.display_name ?? '',
    about: prior?.about ?? '',
    email: prior?.email ?? '',
    ...changed,
  };
  const receipt = await door.write([{ id: idFor(who), type: PROFILE_TYPE, value }], { key: `save-member-profile:${who}:${value.updated_at}` });
  if (receipt.write_count !== 1) throw new Error('Profile save was not confirmed.');
  const current = await readRecord(door, who);
  if (!current || Object.entries(changed).some(([name, text]) => (current[name] ?? '') !== text)) throw new Error('Profile save could not be verified.');
  return { saved: true, profile: fieldsOf(current) };
}
