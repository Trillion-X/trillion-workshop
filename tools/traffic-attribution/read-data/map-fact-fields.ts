// tools/traffic-attribution/read-data/map-fact-fields.ts
//
// Purpose: the pure field mapper used by outbound mirrors. Given an observer
//   fact and an optional field_map (DATA), produce the event payload a venue
//   receives. No I/O, no provider vocabulary; the map IS the behavior.
//
// do-work/observe-traffic.ts maps each outbound venue's field_map with it.

/** The one field of an observer fact the mapper reads. */
export interface MappedFact {
  value: unknown;
}

/**
 * Map fact fields according to field_map.
 * If field_map is absent, returns fact.value as the payload.
 */
export function mapFactFields(fact: MappedFact, fieldMap?: Record<string, string>): Record<string, unknown> {
  if (!fieldMap) {
    return { value: fact.value };
  }

  const event: Record<string, unknown> = {};
  const value = fact.value;

  if (typeof value === 'object' && value !== null) {
    for (const [targetKey, sourceKey] of Object.entries(fieldMap)) {
      const val = (value as Record<string, unknown>)[sourceKey];
      event[targetKey] = val;
    }
  }

  return event;
}
