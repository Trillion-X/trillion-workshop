// packages/choose-per-observer/do-work/mirror-facts.ts
//
// Purpose: Outbound subscriber that mirrors observer facts to external endpoints
// via DATA-driven configuration (T9 Wave-3).
//
// Mirror records (DATA) specify: which fact paths to subscribe to, which venue
// to send them to, and how to map fields. A new pixel/tracker = a new mirror
// DATA record, zero code change.
//
// Dependencies: injected emit function (venue-agnostic), zero provider enum.

import type { ObserverFact } from '../read-data/score-candidates';

/**
 * Mirror configuration: which facts → which venue, field mappings.
 */
export interface MirrorRecord {
  subscribe_address: string;
  endpoint_venue_ref: string;
  field_map?: Record<string, string>;
  label?: string;
}

/**
 * Emit function signature: send event data to venue (injected for testability).
 */
export type EmitFn = (venueRef: string, eventData: Record<string, unknown>) => Promise<void>;

export { mapFactFields } from '../read-data/map-fact-fields';
import { mapFactFields } from '../read-data/map-fact-fields';

/**
 * Check if a fact matches the subscription address.
 * Since ObserverFact only has path (observer_id is context), we match by
 * extracting the path part from the subscription address.
 * Example: subscribeAddress "observer::obs-1::signal" → pathPattern "signal"
 * Fact path ["signal", "source"] matches if it starts with ["signal"].
 */
export function factMatches(fact: ObserverFact, subscribeAddress: string): boolean {
  const parts = subscribeAddress.split('::');
  if (parts.length < 3) return false; // observer::observer_id::path_segments

  const addressPathParts = parts.slice(2); // extract path after observer::obs-id::
  const factPathStr = fact.path.join('::');
  const addressPathStr = addressPathParts.join('::');

  return factPathStr === addressPathStr || factPathStr.startsWith(addressPathStr + '::');
}

/**
 * Mirror facts: filter by address, map fields, emit to venue.
 *
 * Note: facts passed in should have an observer_id available (typically
 * passed alongside or extracted from context). The factMatches function
 * uses the fact path only for prefix matching.
 *
 * @param facts            All observer facts.
 * @param mirrorRecords    DATA configurations.
 * @param emitFn           Injected emission function.
 */
export async function mirrorFacts(
  facts: ObserverFact[],
  mirrorRecords: MirrorRecord[],
  emitFn: EmitFn,
): Promise<void> {
  for (const mirror of mirrorRecords) {
    const matchingFacts = facts.filter((fact) => factMatches(fact, mirror.subscribe_address));

    for (const fact of matchingFacts) {
      const eventData = mapFactFields(fact, mirror.field_map);
      await emitFn(mirror.endpoint_venue_ref, eventData);

      console.log(
        `[choose-per-observer] mirrored path=${fact.path.join(':::')} venue=${mirror.endpoint_venue_ref}`,
      );
    }
  }
}
