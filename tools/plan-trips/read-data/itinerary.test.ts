// package-set://bitfield-studio/packages/itinerary/read-data/itinerary.test.ts

import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildItineraryOperations, daysForTrip, decodeItinerary, itemsForTripDay } from './itinerary.ts';

describe('itinerary package code', () => {
  it('decodes generic trip records and sorts days/items', () => {
    const itinerary = decodeItinerary({
      trips: [{ id: 'trip:1', name: 'Any trip', travelerRefs: ['traveler:1'] }],
      days: [
        { id: 'day:2', tripId: 'trip:1', sequence: 2, localDate: '2026-05-02' },
        { id: 'day:1', tripId: 'trip:1', sequence: 1, localDate: '2026-05-01' },
      ],
      items: [
        { id: 'item:b', tripDayId: 'day:1', kind: 'meal', title: 'Dinner', startsAt: '19:00' },
        { id: 'item:a', tripDayId: 'day:1', kind: 'travel', title: 'Train', startsAt: '09:00' },
      ],
    });

    expect(daysForTrip(itinerary, 'trip:1').map((day) => day.id)).toEqual(['day:1', 'day:2']);
    expect(itemsForTripDay(itinerary, 'day:1').map((item) => item.id)).toEqual(['item:a', 'item:b']);
  });

  it('accepts manifest snake_case fields and emits owner-produced operation records', () => {
    const itinerary = decodeItinerary({
      trips: [{ id: 'trip:1', name: 'Any trip', traveler_refs: ['traveler:1'], timezone_policy: 'local' }],
      days: [{ id: 'day:1', trip_id: 'trip:1', sequence: 1, local_date: '2026-05-01' }],
      items: [{
        id: 'item:flight',
        trip_day_id: 'day:1',
        kind: 'surprise-kind',
        title: 'Flight',
        starts_at: '08:20',
        reservation_ref: 'reservation:flight',
        task_refs: ['task:check-in'],
        dependency_refs: ['dependency:passport'],
      }],
    });

    const operations = buildItineraryOperations(itinerary, 'trip:1');
    expect(itinerary.trips[0]?.timezonePolicy).toBe('local');
    expect(operations.map((operation) => operation.id)).toContain('operation:itinerary:item:item:flight');
    expect(operations.find((operation) => operation.source.id === 'item:flight')?.kindDescriptor).toBe('itinerary.kind.surprise-kind');
    expect(operations.find((operation) => operation.source.id === 'item:flight')?.linkRefs).toContain('reservation:flight');
  });
});
