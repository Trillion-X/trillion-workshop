// tools/reservations/do-work/reservations.mjs
//
// The tool seam: each export is run by tools/records-door/do-work/run-an-export.mjs as fn(input, { door }).
// A capacity ledger is one `capacity-ledger` record in the person's own records (id = ledger_id). Every
// export reads it, applies one pure step from capacity-ledger.ts, writes the next ledger, and then reads it
// back to check the step is there. The records door has no compare-and-swap, so two writers on one ledger
// can still overwrite each other between that write and read; the read-back catches the common case and
// asks for the same request again, which is safe because every step is idempotent by its key.
//
// The run's clock is the time. A caller cannot choose `occurred_at`, so it cannot expire holds early or
// keep one alive: expiry is given as seconds from now.
import { openCapacityLedger, holdUnit, joinWaitlist, promoteWaitlist, releaseUnit, expireHolds, capacityLedgerProjection } from './capacity-ledger.ts';
import { decodeReservations, reservationsByStatus } from '../read-data/reservations.ts';

const KIND = 'capacity-ledger';
const RESERVATION_KIND = 'reservation';

const needText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value;
};
const instant = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString();
const expiryAt = (seconds, field) => {
  if (seconds === undefined) return undefined;
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error(`${field} must be a whole number of seconds, 1 or more.`);
  return instant(seconds);
};

async function load(door, ledgerId) {
  const ledger = await door.read(KIND, needText(ledgerId, 'ledger_id'));
  if (!ledger) throw new Error(`There is no capacity ledger "${ledgerId}". Open it first.`);
  return ledger;
}

const counts = ledger => ({
  ledger_id: ledger.ledger_id,
  state: ledger.state,
  total: ledger.capacity_policy.total,
  confirmed: ledger.holds.filter(hold => hold.state === 'confirmed').length,
  waiting: ledger.waitlist_entries.filter(entry => entry.state === 'waiting').length,
});

// Write the next ledger when a step changed it, and check the step is in the record afterwards.
async function keep(door, before, after, opKey, stepIsThere) {
  if (after === before) return;
  await door.write([{ id: after.ledger_id, type: KIND, value: after }], { key: `${after.ledger_id}:${after.sequence}:${opKey}` });
  if (!stepIsThere(await door.read(KIND, after.ledger_id))) {
    throw new Error('The ledger changed while this ran. Send the same request again with the same idempotency_key.');
  }
}

export async function openACapacityLedger(input, { door }) {
  const ledgerId = needText(input.ledger_id, 'ledger_id');
  const existing = await door.read(KIND, ledgerId);
  if (existing) return { already_open: true, ...counts(existing) };
  const ledger = openCapacityLedger({
    ledger_id: ledgerId,
    scope_ref: needText(input.scope_ref, 'scope_ref'),
    capacity_policy: {
      total: input.total,
      reserved_by_class: input.reserved_by_class ?? {},
      oversubscription_policy: input.oversubscription_policy ?? {},
      release_policy: input.release_policy ?? {},
      ...(input.policy_ref ? { policy_ref: input.policy_ref } : {}),
    },
  });
  await door.write([{ id: ledgerId, type: KIND, value: ledger }], { key: `${ledgerId}:open` });
  return { already_open: false, ...counts(ledger) };
}

export async function holdAUnit(input, { door }) {
  const before = await load(door, input.ledger_id);
  const key = needText(input.idempotency_key, 'idempotency_key');
  const { ledger, result } = holdUnit(before, {
    subject_ref: needText(input.subject_ref, 'subject_ref'),
    idempotency_key: key,
    occurred_at: instant(),
    ...(input.unit_class ? { unit_class: input.unit_class } : {}),
    ...(input.waitlist_reason ? { waitlist_reason: input.waitlist_reason } : {}),
    ...(input.promotion_policy ? { promotion_policy: input.promotion_policy } : {}),
    ...(input.notification_preference ? { notification_preference: input.notification_preference } : {}),
    expires_at: expiryAt(input.expires_in_seconds, 'expires_in_seconds'),
  });
  await keep(door, before, ledger, `hold:${key}`, now => now.holds.some(hold => hold.idempotency_key === key) || now.waitlist_entries.some(entry => entry.idempotency_key === key));
  return { ...result, ...counts(ledger) };
}

export async function joinAWaitlist(input, { door }) {
  const before = await load(door, input.ledger_id);
  const key = needText(input.idempotency_key, 'idempotency_key');
  const { ledger, result } = joinWaitlist(before, {
    subject_ref: needText(input.subject_ref, 'subject_ref'),
    idempotency_key: key,
    occurred_at: instant(),
    reason: needText(input.reason, 'reason'),
    ...(input.unit_class ? { unit_class: input.unit_class } : {}),
    ...(input.promotion_policy ? { promotion_policy: input.promotion_policy } : {}),
    ...(input.notification_preference ? { notification_preference: input.notification_preference } : {}),
  });
  await keep(door, before, ledger, `join:${key}`, now => now.waitlist_entries.some(entry => entry.idempotency_key === key));
  return { waitlist_entry: result, ...counts(ledger) };
}

export async function promoteFromTheWaitlist(input, { door }) {
  const before = await load(door, input.ledger_id);
  const key = needText(input.idempotency_key, 'idempotency_key');
  const { ledger, result } = promoteWaitlist(before, {
    idempotency_key: key,
    occurred_at: instant(),
    ...(input.waitlist_entry_id ? { waitlist_entry_id: input.waitlist_entry_id } : {}),
    expires_at: expiryAt(input.expires_in_seconds, 'expires_in_seconds'),
  });
  const promotedId = result.hold?.hold_id;
  await keep(door, before, ledger, `promote:${key}`, now => promotedId === undefined || now.holds.some(hold => hold.hold_id === promotedId));
  return { promoted: Boolean(result.hold), ...result, ...counts(ledger) };
}

export async function releaseAUnit(input, { door }) {
  const before = await load(door, input.ledger_id);
  const key = needText(input.idempotency_key, 'idempotency_key');
  const { ledger, result } = releaseUnit(before, {
    idempotency_key: key,
    occurred_at: instant(),
    ...(input.hold_id ? { hold_id: input.hold_id } : {}),
    ...(input.subject_ref ? { subject_ref: input.subject_ref } : {}),
    ...(input.promote_next === false ? { promote_next: false } : {}),
    promoted_hold_expires_at: expiryAt(input.promoted_hold_expires_in_seconds, 'promoted_hold_expires_in_seconds'),
  });
  const releasedId = result.released_hold?.hold_id;
  await keep(door, before, ledger, `release:${key}`, now => releasedId === undefined || now.holds.some(hold => hold.hold_id === releasedId && hold.state !== 'confirmed'));
  return { released: Boolean(result.released_hold), ...result, ...counts(ledger) };
}

export async function expireOldHolds(input, { door }) {
  const before = await load(door, input.ledger_id);
  const at = instant();
  const { ledger, result } = expireHolds(before, { occurred_at: at, ...(input.promote_next === false ? { promote_next: false } : {}) });
  const expiredIds = result.expired_holds.map(hold => hold.hold_id);
  await keep(door, before, ledger, `expire:${at}`, now => expiredIds.every(id => now.holds.some(hold => hold.hold_id === id && hold.state !== 'confirmed')));
  return { ...result, ...counts(ledger) };
}

export async function readACapacityLedger(input, { door }) {
  const ledger = await load(door, input.ledger_id);
  return { ledger, projection: capacityLedgerProjection(ledger, input.title), ...counts(ledger) };
}

// Reservations from the input, or from the person's own `reservation` records, grouped by status. `attention_order`
// lists the person's statuses, the ones that need them soonest first; any other status follows in the order seen.
export async function sortReservationsByStatus(input, context) {
  let source = input.reservations;
  if (source === undefined) {
    source = [];
    for await (const record of context.door.list({ type: RESERVATION_KIND })) if (record.value) source.push({ id: record.id, ...record.value });
  }
  const reservations = decodeReservations(source);
  const order = Array.isArray(input.attention_order) ? input.attention_order.filter(status => typeof status === 'string') : [];
  const grouped = reservationsByStatus(reservations);
  const statuses = [...order.filter(status => status in grouped), ...Object.keys(grouped).filter(status => !order.includes(status))];
  return {
    count: reservations.length,
    groups: statuses.map(status => ({ status, needs_attention: order.includes(status), reservations: grouped[status] })),
    without_policy: reservations.filter(reservation => !reservation.policyRef).map(reservation => reservation.id),
  };
}
