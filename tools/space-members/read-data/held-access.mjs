// tools/space-members/read-data/held-access.mjs
//
// What each person holds, from the one place that works it out (tools/paid-access): the payment events, offers, grants,
// rules and lifecycle of the account are read ONCE from the records the caller handed in, and `heldBy(subject)` answers one
// person from them in memory, so listing a space's members costs the same as asking about one. The clock is the run's own.
// A record kind the caller did not hand in is not there, so nobody holds access through it: a join by access is refused,
// never admitted on evidence that was not given.
import { heldAccess, RECORD_TYPES } from '../../paid-access/read-data/who-holds-access.mjs';

const valuesOf = (records, type) => records.filter(record => record.type === type).map(record => record.value);

/** Whether any of a space's join rows asks what the person holds, so a space that asks nothing of access reads none. */
export const asksForAccess = space => (space.config?.join ?? []).some(row => typeof row?.access === 'string');

/** { heldBy(subject) => the access refs that person holds now }, over the access records handed in, read once. */
export function heldAccessReader(records, nowMs) {
  const paymentEvents = valuesOf(records, RECORD_TYPES.paymentEvent);
  const offers = valuesOf(records, RECORD_TYPES.offer);
  const grants = valuesOf(records, RECORD_TYPES.grant);
  const rules = valuesOf(records, RECORD_TYPES.rule);
  const lifecycles = valuesOf(records, RECORD_TYPES.lifecycle);
  return {
    heldBy: subject => heldAccess({ subject, nowMs, paymentEvents, offers, grants, rules: rules.length ? rules : undefined, lifecycle: lifecycles[0] }).held_access_refs,
  };
}

/** The access refs one person holds, read only when the space asks for access at all. */
export function heldAccessOf(records, space, subject, nowMs) {
  return asksForAccess(space) ? heldAccessReader(records, nowMs).heldBy(subject) : [];
}
