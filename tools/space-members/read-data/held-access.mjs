// tools/space-members/read-data/held-access.mjs
//
// What each person holds, from the one place that works it out (tools/paid-access): the payment events, offers, grants,
// rules and lifecycle of the account the run is for are read ONCE, and `heldBy(subject)` answers one person from them in
// memory, so listing a space's members costs the same reads as asking about one. The clock is the run's own. A record
// kind that cannot be read throws: a gate treats that as unavailable, never as "holds nothing".
import { heldAccess, RECORD_TYPES } from '../../paid-access/read-data/who-holds-access.mjs';

async function valuesOf(door, type) {
  const values = [];
  for await (const record of door.list({ type })) values.push(record.value);
  return values;
}

/** Whether any of a space's join rows asks what the person holds, so a space that asks nothing of access reads none. */
export const asksForAccess = space => (space.config?.join ?? []).some(row => typeof row?.access === 'string');

/** { heldBy(subject) => the access refs that person holds now }, over one read of the account's access records. */
export async function heldAccessReader(door, nowMs) {
  const [paymentEvents, offers, grants, rules, lifecycles] = await Promise.all([
    valuesOf(door, RECORD_TYPES.paymentEvent), valuesOf(door, RECORD_TYPES.offer), valuesOf(door, RECORD_TYPES.grant),
    valuesOf(door, RECORD_TYPES.rule), valuesOf(door, RECORD_TYPES.lifecycle),
  ]);
  return {
    heldBy: subject => heldAccess({ subject, nowMs, paymentEvents, offers, grants, rules: rules.length ? rules : undefined, lifecycle: lifecycles[0] }).held_access_refs,
  };
}

/** The access refs one person holds, read only when the space asks for access at all. */
export async function heldAccessOf(door, space, subject, nowMs) {
  return asksForAccess(space) ? (await heldAccessReader(door, nowMs)).heldBy(subject) : [];
}
