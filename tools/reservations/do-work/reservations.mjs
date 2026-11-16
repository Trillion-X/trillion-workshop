// tools/reservations/do-work/reservations.mjs
//
// The tool seam: each export is run by tools/records-door/do-work/run-an-export.mjs as fn(input). A capacity
// ledger is one `capacity-ledger` record the person's AI holds in their own records (id = ledger_id). Every step
// takes the ledger it was given (`input.ledger`), applies one pure step from capacity-ledger.ts and answers the
// next ledger; nothing is read from or kept in any store. Sending the same request again with the same ledger and
// key answers the same result, because every step is idempotent by its key.
//
// The run's clock is the time. A caller cannot choose `occurred_at`, so it cannot expire holds early or
// keep one alive: expiry is given as seconds from now.
import { openCapacityLedger, holdUnit, joinWaitlist, promoteWaitlist, releaseUnit, expireHolds, capacityLedgerProjection } from './capacity-ledger.ts';
import { decodeReservations, reservationsByStatus } from '../read-data/reservation-tracker.ts';

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

function load(input) {
  const ledger = input.ledger;
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger) || typeof ledger.ledger_id !== 'string') throw new Error('ledger is required: the capacity ledger you hold, as its record holds it. Open it first.');
  return ledger;
}

const counts = ledger => ({
  ledger_id: ledger.ledger_id,
  state: ledger.state,
  total: ledger.capacity_policy.total,
  confirmed: ledger.holds.filter(hold => hold.state === 'confirmed').length,
  waiting: ledger.waitlist_entries.filter(entry => entry.state === 'waiting').length,
});

export function openACapacityLedger(input) {
  const ledgerId = needText(input.ledger_id, 'ledger_id');
  const existing = input.ledger === undefined ? null : load(input);
  if (existing) return { already_open: true, ledger: existing, ...counts(existing) };
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
  return { already_open: false, ledger, ...counts(ledger) };
}

export function holdAUnit(input) {
  const before = load(input);
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
  return { ...result, ledger, ...counts(ledger) };
}

export function joinAWaitlist(input) {
  const before = load(input);
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
  return { waitlist_entry: result, ledger, ...counts(ledger) };
}

export function promoteFromTheWaitlist(input) {
  const before = load(input);
  const key = needText(input.idempotency_key, 'idempotency_key');
  const { ledger, result } = promoteWaitlist(before, {
    idempotency_key: key,
    occurred_at: instant(),
    ...(input.waitlist_entry_id ? { waitlist_entry_id: input.waitlist_entry_id } : {}),
    expires_at: expiryAt(input.expires_in_seconds, 'expires_in_seconds'),
  });
  return { promoted: Boolean(result.hold), ...result, ledger, ...counts(ledger) };
}

export function releaseAUnit(input) {
  const before = load(input);
  const key = needText(input.idempotency_key, 'idempotency_key');
  const { ledger, result } = releaseUnit(before, {
    idempotency_key: key,
    occurred_at: instant(),
    ...(input.hold_id ? { hold_id: input.hold_id } : {}),
    ...(input.subject_ref ? { subject_ref: input.subject_ref } : {}),
    ...(input.promote_next === false ? { promote_next: false } : {}),
    promoted_hold_expires_at: expiryAt(input.promoted_hold_expires_in_seconds, 'promoted_hold_expires_in_seconds'),
  });
  return { released: Boolean(result.released_hold), ...result, ledger, ...counts(ledger) };
}

export function expireOldHolds(input) {
  const before = load(input);
  const at = instant();
  const { ledger, result } = expireHolds(before, { occurred_at: at, ...(input.promote_next === false ? { promote_next: false } : {}) });
  return { ...result, ledger, ...counts(ledger) };
}

export function readACapacityLedger(input) {
  const ledger = load(input);
  return { projection: capacityLedgerProjection(ledger, input.title), ...counts(ledger) };
}

// The reservations given, grouped by status. `attention_order` lists the person's statuses, the ones that need them
// soonest first; any other status follows in the order seen.
export function sortReservationsByStatus(input) {
  if (!Array.isArray(input.reservations)) throw new Error('reservations is required: the reservation rows to group.');
  const reservations = decodeReservations(input.reservations);
  const order = Array.isArray(input.attention_order) ? input.attention_order.filter(status => typeof status === 'string') : [];
  const grouped = reservationsByStatus(reservations);
  const statuses = [...order.filter(status => status in grouped), ...Object.keys(grouped).filter(status => !order.includes(status))];
  return {
    count: reservations.length,
    groups: statuses.map(status => ({ status, needs_attention: order.includes(status), reservations: grouped[status] })),
    without_policy: reservations.filter(reservation => !reservation.policyRef).map(reservation => reservation.id),
  };
}
