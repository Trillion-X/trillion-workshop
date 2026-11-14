import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  applyCapacityLedgerOperation,
  capacityLedgerProjection,
  expireHolds,
  holdUnit,
  joinWaitlist,
  openCapacityLedger,
  releaseUnit,
  type CapacityLedgerRecord,
  type OpenCapacityLedgerInput,
} from './capacity-ledger.ts';

const AT = '2026-09-05T10:00:00.000Z';

function ledgerInput(total = 1): OpenCapacityLedgerInput {
  return {
    ledger_id: 'ledger:generic-occurrence',
    scope_ref: 'scope:generic-occurrence',
    capacity_policy: {
      total,
      reserved_by_class: {},
      oversubscription_policy: { mode: 'waitlist' },
      release_policy: { promote_next: true },
      policy_ref: 'policy:generic-capacity',
    },
  };
}

describe('capacity ledger', () => {
  it('shares the unreserved remainder across all unnamed classes', () => {
    const input = ledgerInput(3);
    input.capacity_policy.reserved_by_class = { reserved: 2 };
    let ledger = openCapacityLedger(input);
    const first = holdUnit(ledger, { subject_ref: 'a', unit_class: 'a', idempotency_key: 'a', occurred_at: AT });
    expect(first.result.outcome).toBe('held');
    const second = holdUnit(first.ledger, { subject_ref: 'b', unit_class: 'b', idempotency_key: 'b', occurred_at: AT });
    expect(second.result.outcome).toBe('waitlisted');
    ledger = second.ledger;
    for (const id of ['r1', 'r2']) {
      const result = holdUnit(ledger, { subject_ref: id, unit_class: 'reserved', idempotency_key: id, occurred_at: AT });
      expect(result.result.outcome).toBe('held');
      ledger = result.ledger;
    }
    expect(ledger.holds.filter((hold) => hold.state === 'confirmed')).toHaveLength(3);
  });
  it('gives the last unit to the first holder and orders the next on the waitlist', () => {
    const opened = openCapacityLedger(ledgerInput());
    const first = holdUnit(opened, { subject_ref: 'subject:first', idempotency_key: 'hold:first', occurred_at: AT });
    const second = holdUnit(first.ledger, { subject_ref: 'subject:second', idempotency_key: 'hold:second', occurred_at: AT });

    expect(first.result.outcome).toBe('held');
    expect(second.result.outcome).toBe('waitlisted');
    expect(second.ledger.holds.filter((hold) => hold.state === 'confirmed')).toHaveLength(1);
    expect(second.ledger.waitlist_entries.filter((entry) => entry.state === 'waiting')).toHaveLength(1);
    expect(second.ledger.waitlist_entries[0]?.rank).toBe(1);
  });

  it('recognises a repeated idempotency key ACROSS A RESTART, which an in-memory cache cannot', () => {
    // The previous shape kept results in a Map on the instance, so this exact
    // sequence double-held after any process restart. Round-tripping the record
    // through JSON is the restart: nothing survives except the durable ledger,
    // and the ledger is enough because the hold carries the key that made it.
    const opened = openCapacityLedger(ledgerInput(2));
    const first = holdUnit(opened, { subject_ref: 'subject:one', idempotency_key: 'hold:stable', occurred_at: AT });
    expect(first.result.outcome).toBe('held');

    const afterRestart = JSON.parse(JSON.stringify(first.ledger)) as CapacityLedgerRecord;
    const repeated = holdUnit(afterRestart, { subject_ref: 'subject:one', idempotency_key: 'hold:stable', occurred_at: AT });

    expect(repeated.result).toEqual(first.result);
    expect(repeated.ledger.holds).toHaveLength(1);
  });

  it('releases a unit and promotes the next ordered waitlist entry', () => {
    let ledger = openCapacityLedger(ledgerInput(2));
    const first = holdUnit(ledger, { subject_ref: 'subject:first', idempotency_key: 'hold:first', occurred_at: AT });
    ledger = first.ledger;
    ledger = holdUnit(ledger, { subject_ref: 'subject:second', idempotency_key: 'hold:second', occurred_at: AT }).ledger;
    ledger = holdUnit(ledger, { subject_ref: 'subject:next', idempotency_key: 'hold:next', occurred_at: AT }).ledger;
    if (first.result.outcome !== 'held') throw new Error('expected the first hold to succeed');

    const released = releaseUnit(ledger, {
      hold_id: first.result.hold.hold_id,
      idempotency_key: 'release:first',
      occurred_at: AT,
    });

    expect(released.result.promoted_hold?.subject_ref).toBe('subject:next');
    expect(released.ledger.holds.filter((hold) => hold.state === 'confirmed')).toHaveLength(2);
    expect(released.ledger.holds.filter((hold) => hold.state === 'released')).toHaveLength(1);
    expect(released.ledger.waitlist_entries.filter((entry) => entry.state === 'waiting')).toHaveLength(0);
    expect(released.ledger.waitlist_entries[0]?.state).toBe('promoted');
    expect(released.ledger.state).toBe('full');
  });

  it('lets an unnamed unit class draw on the remainder without touching reserved capacity', () => {
    // The previous shape branched on 'reserved' and 'guest' by name and typed the
    // union as `| string`, so a fourth name did not error, it silently consumed
    // general capacity. Here the classes are DATA and an unnamed one gets exactly
    // what is left after every reservation.
    const ledger = openCapacityLedger({
      ...ledgerInput(3),
      capacity_policy: { ...ledgerInput(3).capacity_policy, reserved_by_class: { accredited: 2 } },
    });

    const invented = holdUnit(ledger, {
      subject_ref: 'subject:walkup',
      idempotency_key: 'hold:walkup',
      occurred_at: AT,
      unit_class: 'a-class-this-file-has-never-heard-of',
    });
    expect(invented.result.outcome).toBe('held');

    // the remainder was 1, so a second unnamed holder waits even though two
    // accredited units are still free
    const secondWalkup = holdUnit(invented.ledger, {
      subject_ref: 'subject:walkup-two',
      idempotency_key: 'hold:walkup-two',
      occurred_at: AT,
      unit_class: 'a-class-this-file-has-never-heard-of',
    });
    expect(secondWalkup.result.outcome).toBe('waitlisted');

    const accredited = holdUnit(secondWalkup.ledger, {
      subject_ref: 'subject:accredited',
      idempotency_key: 'hold:accredited',
      occurred_at: AT,
      unit_class: 'accredited',
    });
    expect(accredited.result.outcome).toBe('held');
  });

  it('expires a hold whose expires_at has passed and promotes into the freed unit', () => {
    // expires_at was set on every hold and read by nothing, so a pool could hand
    // out a unit until a date and then count it as held for ever.
    let ledger = openCapacityLedger(ledgerInput(1));
    ledger = holdUnit(ledger, {
      subject_ref: 'subject:short-lived',
      idempotency_key: 'hold:short-lived',
      occurred_at: AT,
      expires_at: '2026-09-05T11:00:00.000Z',
    }).ledger;
    ledger = holdUnit(ledger, { subject_ref: 'subject:waiting', idempotency_key: 'hold:waiting', occurred_at: AT }).ledger;
    expect(ledger.holds.filter((hold) => hold.state === 'confirmed')).toHaveLength(1);

    const beforeExpiry = expireHolds(ledger, { occurred_at: '2026-09-05T10:59:59.000Z' });
    expect(beforeExpiry.result.expired_holds).toHaveLength(0);
    expect(beforeExpiry.ledger).toBe(ledger);

    const afterExpiry = expireHolds(ledger, { occurred_at: '2026-09-05T11:00:00.000Z' });
    expect(afterExpiry.result.expired_holds).toHaveLength(1);
    expect(afterExpiry.result.promoted_holds[0]?.subject_ref).toBe('subject:waiting');
    expect(afterExpiry.ledger.holds.filter((hold) => hold.state === 'expired')).toHaveLength(1);
    // the expired hold stops occupying the pool, so the promoted one fits
    expect(afterExpiry.ledger.holds.filter((hold) => hold.state === 'confirmed')).toHaveLength(1);
  });

  it('leaves a hold with no expires_at alone for ever', () => {
    let ledger = openCapacityLedger(ledgerInput(1));
    ledger = holdUnit(ledger, { subject_ref: 'subject:open-ended', idempotency_key: 'hold:open-ended', occurred_at: AT }).ledger;
    const swept = expireHolds(ledger, { occurred_at: '2099-01-01T00:00:00.000Z' });
    expect(swept.result.expired_holds).toHaveLength(0);
  });

  it('refuses an unknown operation by name instead of doing nothing', () => {
    const ledger = openCapacityLedger(ledgerInput());
    expect(() => applyCapacityLedgerOperation({ operation: 'confirm', ledger }))
      .toThrow(/no operation 'confirm'/);
    expect(() => applyCapacityLedgerOperation({ operation: 'confirm', ledger }))
      .toThrow(/expire, hold, join_waitlist, open, promote_waitlist, read, release/);
  });

  it('dispatches through the package target and reserves argument two for the runtime', () => {
    const opened = applyCapacityLedgerOperation({ operation: 'open', open: ledgerInput(1) });
    const held = applyCapacityLedgerOperation(
      { operation: 'hold', ledger: opened.ledger, hold: { subject_ref: 'subject:target', idempotency_key: 'hold:target', occurred_at: AT } },
      { runtime: 'context object that must not be read as options' },
    );
    expect((held.result as { outcome: string }).outcome).toBe('held');
    expect(held.ledger.holds).toHaveLength(1);
  });

  it('keeps operations valid when only generic DATA remains', () => {
    let ledger = openCapacityLedger({
      ...ledgerInput(),
      ledger_id: 'opaque-ledger',
      scope_ref: 'opaque-scope',
      capacity_policy: {
        ...ledgerInput().capacity_policy,
        oversubscription_policy: { descriptor_ref: 'descriptor:overflow' },
        release_policy: { descriptor_ref: 'descriptor:release' },
      },
      state: 'descriptor-defined-open',
    });

    ledger = holdUnit(ledger, { subject_ref: 'opaque-subject-a', idempotency_key: 'opaque-key-a', occurred_at: AT }).ledger;
    ledger = joinWaitlist(ledger, {
      subject_ref: 'opaque-subject-b',
      idempotency_key: 'opaque-key-b',
      occurred_at: AT,
      reason: 'descriptor-defined-reason',
      promotion_policy: { descriptor_ref: 'descriptor:promotion' },
      notification_preference: { descriptor_ref: 'descriptor:notification' },
    }).ledger;
    const released = releaseUnit(ledger, { subject_ref: 'opaque-subject-a', idempotency_key: 'opaque-release', occurred_at: AT });
    const projection = capacityLedgerProjection(released.ledger, 'Opaque occurrence');

    expect(released.result.promoted_hold?.subject_ref).toBe('opaque-subject-b');
    expect(projection.id).toBe('opaque-scope');
    expect(projection.partyRefs).toEqual(['opaque-subject-b']);
    expect(JSON.stringify(released.ledger)).not.toMatch(/Eth|Trillion|Gevity|Friday|Griffin/i);
  });
});
