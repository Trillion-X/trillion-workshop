
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildReservationOperations, decodeReservations, reservationsByStatus } from './reservation-tracker.ts';

describe('reservation-tracker package code', () => {
  it('decodes reservations and groups them by status', () => {
    const reservations = decodeReservations([
      { id: 'r1', kind: 'lodging', title: 'Hotel', status: 'confirmed', confirmationCode: 'ABC' },
      { id: 'r2', kind: 'meal', title: 'Dinner', status: 'requested' },
    ]);

    const grouped = reservationsByStatus(reservations);
    expect(grouped.confirmed[0].confirmationCode).toBe('ABC');
    expect(grouped.requested).toHaveLength(1);
  });

  it('decodes manifest-style records and redacts sensitive values from operation display atoms', () => {
    const reservations = decodeReservations({
      reservations: [{
        id: 'reservation:flight',
        kind: 'transport',
        title: 'Outbound flight',
        status: 'changed',
        starts_at: '2026-06-03 08:20',
        provider_ref: 'provider:airline',
        confirmation_code: 'ABC123',
        itinerary_item_ref: 'item:flight',
        party_refs: ['traveler:owner'],
        policy_ref: 'policy:flight',
        cost: { amount: 250 },
      }],
    });

    const operations = buildReservationOperations(reservations);
    expect(reservations[0]?.policyRef).toBe('policy:flight');
    expect(operations[0]?.priority).toBe('critical');
    expect(operations[0]?.privacyClass).toBe('sensitive');
    expect(JSON.stringify(operations[0]?.display)).not.toContain('ABC123');
    expect(operations[0]?.candidateFactRefs).toEqual(['candidate:reservation:flight:change-review']);
  });
});
