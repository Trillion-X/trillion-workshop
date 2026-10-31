/**
 * A finite pool of interchangeable units, held by idempotent holds, with an
 * ordered queue when the pool is exhausted and automatic promotion on release.
 *
 * That is seats, rooms, appointment slots, class places, quota, licences,
 * parking bays and rate-limit tokens. None of those names appear below: a
 * caller's word for a kind of unit is a `unit_class`.
 *
 * Every function takes a ledger and returns the next ledger. Nothing is kept
 * in memory between calls, so the ledger record is the whole truth:
 *
 *   - Idempotency is READ FROM THE RECORD. A hold carries the key that made
 *     it, so a repeated key finds its own earlier hold, across restarts and
 *     across workers, because both read the same record.
 *   - Time is an input, never an ambient clock. A function that reads a clock
 *     cannot be replayed.
 *   - `reserved_by_class` is DATA, one entry per named class. A class that is
 *     not named draws on the unreserved remainder, so a caller can invent a
 *     class with no change here.
 */

import type { Reservation } from '../read-data/reservations.ts';

export type LedgerState = string;
export type UnitClass = string;

/**
 * These two are closed on purpose, and closing them is not the enum defect this
 * file just removed. `unit_class` is an open set because a caller invents its
 * own names; a lifecycle is not, because every transition below is produced by a
 * function here. The rule is that a variant must have a producer: `withdrawn`
 * was carried in the previous shape and no code ever set it, so it is gone. If
 * withdrawing from a waitlist is wanted, the operation and the state arrive
 * together, never the state alone.
 */
export type HoldState = 'confirmed' | 'released' | 'expired';
export type WaitlistState = 'waiting' | 'promoted';

/**
 * `reserved_by_class` is DATA: one entry per named class, whatever the caller
 * calls them. The previous shape had a `reserved_seats` and a `guest_seats`
 * FIELD, so a fourth class meant editing this interface, the capacity check and
 * the constructor's arithmetic. Worse, the class union ended in `| string`, so a
 * name outside the three did not error, it silently consumed general capacity.
 * A lookup cannot do that: an unnamed class draws on the unreserved remainder,
 * and adding a named one is a DATA entry with no code change anywhere.
 */
export interface CapacityPolicy {
  total: number;
  reserved_by_class: Record<string, number>;
  oversubscription_policy: Record<string, unknown>;
  release_policy: Record<string, unknown>;
  policy_ref?: string;
}

export interface CapacityHold {
  hold_id: string;
  subject_ref: string;
  unit_class: UnitClass;
  state: HoldState;
  expires_at?: string;
  idempotency_key: string;
  held_at: string;
  released_at?: string;
  promoted_from_waitlist_entry_id?: string;
}

export interface WaitlistEntry {
  waitlist_entry_id: string;
  subject_ref: string;
  unit_class: UnitClass;
  rank: number;
  reason: string;
  promotion_policy: Record<string, unknown>;
  notification_preference: Record<string, unknown>;
  idempotency_key: string;
  state: WaitlistState;
  joined_at: string;
  promoted_at?: string;
  promoted_hold_id?: string;
}

export interface CapacityLedgerRecord {
  ledger_id: string;
  scope_ref: string;
  capacity_policy: CapacityPolicy;
  holds: CapacityHold[];
  waitlist_entries: WaitlistEntry[];
  state: LedgerState;
  sequence: number;
}

export interface OpenCapacityLedgerInput {
  ledger_id: string;
  scope_ref: string;
  capacity_policy: CapacityPolicy;
  state?: LedgerState;
}

export interface HoldUnitInput {
  subject_ref: string;
  idempotency_key: string;
  occurred_at: string;
  unit_class?: UnitClass;
  expires_at?: string;
  waitlist_reason?: string;
  promotion_policy?: Record<string, unknown>;
  notification_preference?: Record<string, unknown>;
}

export interface JoinWaitlistInput {
  subject_ref: string;
  idempotency_key: string;
  occurred_at: string;
  reason: string;
  unit_class?: UnitClass;
  promotion_policy?: Record<string, unknown>;
  notification_preference?: Record<string, unknown>;
}

export interface PromoteWaitlistInput {
  idempotency_key: string;
  occurred_at: string;
  waitlist_entry_id?: string;
  expires_at?: string;
}

export interface ReleaseUnitInput {
  idempotency_key: string;
  occurred_at: string;
  hold_id?: string;
  subject_ref?: string;
  promote_next?: boolean;
  promoted_hold_expires_at?: string;
}

export type HoldUnitOutcome =
  | { outcome: 'held'; hold: CapacityHold }
  | { outcome: 'waitlisted'; waitlist_entry: WaitlistEntry };

export interface ReleaseUnitOutcome {
  released_hold?: CapacityHold;
  promoted_hold?: CapacityHold;
  promoted_waitlist_entry?: WaitlistEntry;
}

export interface LedgerTransition<T> {
  ledger: CapacityLedgerRecord;
  result: T;
}

const DEFAULT_UNIT_CLASS = 'general';

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
}

function requireUnitCount(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
}

function clonePolicy(policy: CapacityPolicy): CapacityPolicy {
  return {
    ...policy,
    reserved_by_class: { ...policy.reserved_by_class },
    oversubscription_policy: { ...policy.oversubscription_policy },
    release_policy: { ...policy.release_policy },
  };
}

function cloneLedger(ledger: CapacityLedgerRecord): CapacityLedgerRecord {
  return {
    ...ledger,
    capacity_policy: clonePolicy(ledger.capacity_policy),
    holds: ledger.holds.map((hold) => ({ ...hold })),
    waitlist_entries: ledger.waitlist_entries.map((entry) => ({
      ...entry,
      promotion_policy: { ...entry.promotion_policy },
      notification_preference: { ...entry.notification_preference },
    })),
  };
}

export function openCapacityLedger(input: OpenCapacityLedgerInput): CapacityLedgerRecord {
  requireNonEmpty(input.ledger_id, 'ledger_id');
  requireNonEmpty(input.scope_ref, 'scope_ref');
  requireUnitCount(input.capacity_policy.total, 'capacity_policy.total');

  let reservedTotal = 0;
  for (const [unitClass, count] of Object.entries(input.capacity_policy.reserved_by_class)) {
    requireUnitCount(count, `capacity_policy.reserved_by_class.${unitClass}`);
    reservedTotal += count;
  }
  if (reservedTotal > input.capacity_policy.total) {
    throw new Error('reserved_by_class totals cannot exceed capacity_policy.total');
  }

  return {
    ledger_id: input.ledger_id,
    scope_ref: input.scope_ref,
    capacity_policy: clonePolicy(input.capacity_policy),
    holds: [],
    waitlist_entries: [],
    state: input.state ?? 'open',
    sequence: 0,
  };
}

export function readCapacityLedger(ledger: CapacityLedgerRecord): CapacityLedgerRecord {
  return cloneLedger(ledger);
}

export function capacityLedgerProjection(
  ledger: CapacityLedgerRecord,
  title = ledger.scope_ref,
): Reservation {
  return {
    id: ledger.scope_ref,
    kind: 'capacity-ledger',
    title,
    status: ledger.state,
    taskRefs: [],
    partyRefs: confirmedHolds(ledger).map((hold) => hold.subject_ref),
    ...(ledger.capacity_policy.policy_ref ? { policyRef: ledger.capacity_policy.policy_ref } : {}),
  };
}

function confirmedHolds(ledger: CapacityLedgerRecord): CapacityHold[] {
  return ledger.holds.filter((hold) => hold.state === 'confirmed');
}

function waitingEntries(ledger: CapacityLedgerRecord): WaitlistEntry[] {
  return ledger.waitlist_entries
    .filter((entry) => entry.state === 'waiting')
    .sort((left, right) => left.rank - right.rank);
}

/**
 * A lookup, not a branch per named class. An unnamed class draws on the
 * remainder left after every reservation, so a caller may invent a class name
 * and get correct arithmetic without this file learning the name.
 */
function hasCapacity(ledger: CapacityLedgerRecord, unitClass: UnitClass): boolean {
  const held = confirmedHolds(ledger);
  if (held.length >= ledger.capacity_policy.total) return false;
  const usedForClass = held.filter((hold) => hold.unit_class === unitClass).length;
  const reserved = ledger.capacity_policy.reserved_by_class[unitClass];
  if (typeof reserved === 'number') return usedForClass < reserved;
  const reservedTotal = Object.values(ledger.capacity_policy.reserved_by_class)
    .reduce((sum, count) => sum + count, 0);
  const usedUnreserved = held.filter((hold) => !Object.prototype.hasOwnProperty.call(
    ledger.capacity_policy.reserved_by_class, hold.unit_class,
  )).length;
  return usedUnreserved < ledger.capacity_policy.total - reservedTotal;
}

/**
 * Idempotency read from the record rather than from process memory. The hold or
 * the waitlist entry carries the key that created it, so the durable ledger IS
 * the dedupe index and a restart cannot forget.
 */
function holdForKey(ledger: CapacityLedgerRecord, key: string): CapacityHold | undefined {
  return ledger.holds.find((hold) => hold.idempotency_key === key);
}

function waitlistEntryForKey(ledger: CapacityLedgerRecord, key: string): WaitlistEntry | undefined {
  return ledger.waitlist_entries.find((entry) => entry.idempotency_key === key);
}

function nextId(ledger: CapacityLedgerRecord, kind: string): { id: string; sequence: number } {
  const sequence = ledger.sequence + 1;
  return { id: `${ledger.ledger_id}:${kind}:${sequence}`, sequence };
}

function refreshState(ledger: CapacityLedgerRecord): CapacityLedgerRecord {
  if (ledger.state === 'closed' || ledger.state === 'superseded') return ledger;
  if (waitingEntries(ledger).length > 0) return { ...ledger, state: 'waitlist_open' };
  const state = confirmedHolds(ledger).length >= ledger.capacity_policy.total ? 'full' : 'open';
  return { ...ledger, state };
}

function appendWaitlistEntry(
  ledger: CapacityLedgerRecord,
  input: JoinWaitlistInput,
): LedgerTransition<WaitlistEntry> {
  requireNonEmpty(input.subject_ref, 'subject_ref');
  requireNonEmpty(input.idempotency_key, 'idempotency_key');
  const existing = waitlistEntryForKey(ledger, input.idempotency_key);
  if (existing) return { ledger, result: existing };

  const { id, sequence } = nextId(ledger, 'waitlist');
  const entry: WaitlistEntry = {
    waitlist_entry_id: id,
    subject_ref: input.subject_ref,
    unit_class: input.unit_class ?? DEFAULT_UNIT_CLASS,
    rank: waitingEntries(ledger).length + 1,
    reason: input.reason,
    promotion_policy: { ...(input.promotion_policy ?? {}) },
    notification_preference: { ...(input.notification_preference ?? {}) },
    idempotency_key: input.idempotency_key,
    state: 'waiting',
    joined_at: input.occurred_at,
  };
  const next = refreshState({
    ...ledger,
    sequence,
    waitlist_entries: [...ledger.waitlist_entries, entry],
  });
  return { ledger: next, result: entry };
}

function appendHold(
  ledger: CapacityLedgerRecord,
  subjectRef: string,
  unitClass: UnitClass,
  idempotencyKey: string,
  occurredAt: string,
  expiresAt?: string,
  promotedFrom?: string,
): LedgerTransition<CapacityHold> {
  const { id, sequence } = nextId(ledger, 'hold');
  const hold: CapacityHold = {
    hold_id: id,
    subject_ref: subjectRef,
    unit_class: unitClass,
    state: 'confirmed',
    idempotency_key: idempotencyKey,
    held_at: occurredAt,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(promotedFrom ? { promoted_from_waitlist_entry_id: promotedFrom } : {}),
  };
  const next = refreshState({ ...ledger, sequence, holds: [...ledger.holds, hold] });
  return { ledger: next, result: hold };
}

export function holdUnit(
  ledger: CapacityLedgerRecord,
  input: HoldUnitInput,
): LedgerTransition<HoldUnitOutcome> {
  requireNonEmpty(input.subject_ref, 'subject_ref');
  requireNonEmpty(input.idempotency_key, 'idempotency_key');

  const priorHold = holdForKey(ledger, input.idempotency_key);
  if (priorHold) return { ledger, result: { outcome: 'held', hold: priorHold } };
  const priorEntry = waitlistEntryForKey(ledger, input.idempotency_key);
  if (priorEntry) return { ledger, result: { outcome: 'waitlisted', waitlist_entry: priorEntry } };

  const unitClass = input.unit_class ?? DEFAULT_UNIT_CLASS;
  if (hasCapacity(ledger, unitClass)) {
    const held = appendHold(
      ledger,
      input.subject_ref,
      unitClass,
      input.idempotency_key,
      input.occurred_at,
      input.expires_at,
    );
    return { ledger: held.ledger, result: { outcome: 'held', hold: held.result } };
  }

  const waitlisted = appendWaitlistEntry(ledger, {
    subject_ref: input.subject_ref,
    idempotency_key: input.idempotency_key,
    occurred_at: input.occurred_at,
    unit_class: unitClass,
    reason: input.waitlist_reason ?? 'capacity_full',
    promotion_policy: input.promotion_policy,
    notification_preference: input.notification_preference,
  });
  return {
    ledger: waitlisted.ledger,
    result: { outcome: 'waitlisted', waitlist_entry: waitlisted.result },
  };
}

export function joinWaitlist(
  ledger: CapacityLedgerRecord,
  input: JoinWaitlistInput,
): LedgerTransition<WaitlistEntry> {
  return appendWaitlistEntry(ledger, input);
}

export interface ExpireHoldsInput {
  occurred_at: string;
  promote_next?: boolean;
}

/**
 * Every hold could carry an `expires_at` and nothing read it, so a pool could
 * hand out a unit until a date and then keep counting it as held for ever. A
 * field with no consumer is the same defect as a DATA gate the engine never
 * reads: it looks like a capability and is decoration.
 *
 * Expiry is an OPERATION rather than a check hidden inside the capacity count,
 * because the log has to see the release. A hold that quietly stopped counting
 * would make two readers of the same record disagree about how full the pool is,
 * depending on when each one looked.
 */
export function expireHolds(
  ledger: CapacityLedgerRecord,
  input: ExpireHoldsInput,
): LedgerTransition<{ expired_holds: CapacityHold[]; promoted_holds: CapacityHold[] }> {
  const due = ledger.holds.filter((hold) => (
    hold.state === 'confirmed'
    && typeof hold.expires_at === 'string'
    && hold.expires_at <= input.occurred_at
  ));
  if (due.length === 0) return { ledger, result: { expired_holds: [], promoted_holds: [] } };

  const expiredById = new Map(due.map((hold) => [
    hold.hold_id,
    { ...hold, state: 'expired' as const, released_at: input.occurred_at },
  ]));
  let next = refreshState({
    ...ledger,
    holds: ledger.holds.map((hold) => expiredById.get(hold.hold_id) ?? hold),
  });

  const promoted: CapacityHold[] = [];
  if (input.promote_next !== false) {
    // One promotion per freed unit, and no more: promoteNext returns undefined
    // as soon as capacity or the queue runs out, which is the loop's bound.
    for (const expired of expiredById.values()) {
      const promotion = promoteNext(next, undefined, input.occurred_at, undefined, `expiry:${expired.hold_id}`);
      if (!promotion) break;
      next = promotion.ledger;
      promoted.push(promotion.result.hold);
    }
  }

  return {
    ledger: next,
    result: { expired_holds: [...expiredById.values()], promoted_holds: promoted },
  };
}

export function promoteWaitlist(
  ledger: CapacityLedgerRecord,
  input: PromoteWaitlistInput,
): LedgerTransition<{ hold?: CapacityHold; waitlist_entry?: WaitlistEntry }> {
  requireNonEmpty(input.idempotency_key, 'idempotency_key');
  const promoted = promoteNext(ledger, input.waitlist_entry_id, input.occurred_at, input.expires_at, input.idempotency_key);
  if (!promoted) return { ledger, result: {} };
  return {
    ledger: promoted.ledger,
    result: { hold: promoted.result.hold, waitlist_entry: promoted.result.waitlist_entry },
  };
}

function promoteNext(
  ledger: CapacityLedgerRecord,
  waitlistEntryId: string | undefined,
  occurredAt: string,
  expiresAt: string | undefined,
  idempotencyKey: string,
): LedgerTransition<{ hold: CapacityHold; waitlist_entry: WaitlistEntry }> | undefined {
  const entry = waitlistEntryId
    ? ledger.waitlist_entries.find((candidate) => candidate.waitlist_entry_id === waitlistEntryId && candidate.state === 'waiting')
    : waitingEntries(ledger).find((candidate) => hasCapacity(ledger, candidate.unit_class));
  if (!entry || !hasCapacity(ledger, entry.unit_class)) return undefined;

  const held = appendHold(
    ledger,
    entry.subject_ref,
    entry.unit_class,
    idempotencyKey || `promote:${entry.idempotency_key}`,
    occurredAt,
    expiresAt,
    entry.waitlist_entry_id,
  );
  const promotedEntry: WaitlistEntry = {
    ...entry,
    state: 'promoted',
    promoted_at: occurredAt,
    promoted_hold_id: held.result.hold_id,
  };
  const withPromotion = held.ledger.waitlist_entries.map((candidate) => (
    candidate.waitlist_entry_id === entry.waitlist_entry_id ? promotedEntry : candidate
  ));
  const renumbered = normalizeWaitlistRanks({ ...held.ledger, waitlist_entries: withPromotion });
  return {
    ledger: refreshState(renumbered),
    result: { hold: held.result, waitlist_entry: promotedEntry },
  };
}

function normalizeWaitlistRanks(ledger: CapacityLedgerRecord): CapacityLedgerRecord {
  const ordered = waitingEntries(ledger);
  const rankById = new Map(ordered.map((entry, index) => [entry.waitlist_entry_id, index + 1]));
  return {
    ...ledger,
    waitlist_entries: ledger.waitlist_entries.map((entry) => {
      const rank = rankById.get(entry.waitlist_entry_id);
      return typeof rank === 'number' ? { ...entry, rank } : entry;
    }),
  };
}

export function releaseUnit(
  ledger: CapacityLedgerRecord,
  input: ReleaseUnitInput,
): LedgerTransition<ReleaseUnitOutcome> {
  requireNonEmpty(input.idempotency_key, 'idempotency_key');
  if (!input.hold_id && !input.subject_ref) throw new Error('hold_id or subject_ref is required');

  const target = ledger.holds.find((candidate) => (
    candidate.state === 'confirmed'
    && (input.hold_id ? candidate.hold_id === input.hold_id : candidate.subject_ref === input.subject_ref)
  ));
  if (!target) return { ledger, result: {} };

  const released: CapacityHold = { ...target, state: 'released', released_at: input.occurred_at };
  const afterRelease = refreshState({
    ...ledger,
    holds: ledger.holds.map((candidate) => (candidate.hold_id === target.hold_id ? released : candidate)),
  });

  if (input.promote_next === false) {
    return { ledger: afterRelease, result: { released_hold: released } };
  }

  const promoted = promoteNext(
    afterRelease,
    undefined,
    input.occurred_at,
    input.promoted_hold_expires_at,
    `promotion:${input.idempotency_key}`,
  );
  if (!promoted) return { ledger: afterRelease, result: { released_hold: released } };
  return {
    ledger: promoted.ledger,
    result: {
      released_hold: released,
      promoted_hold: promoted.result.hold,
      promoted_waitlist_entry: promoted.result.waitlist_entry,
    },
  };
}
