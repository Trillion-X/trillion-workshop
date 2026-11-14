// packages/choose-per-observer/read-data/map-fact-fields.ts
//
// Purpose: the pure field mapper used by outbound mirrors. Given an observer
//   fact and an optional field_map (DATA), produce the event payload a venue
//   receives. No I/O, no provider vocabulary; the map IS the behavior.
//
// Lives in read-data (the package's declared public-source dir) because other
// packages (traffic-attribution) compose it. do-work/mirror-facts.ts re-exports
// it so its existing callers and tests keep one import path.

import type { ObserverFact } from './score-candidates';

/**
 * Map fact fields according to field_map.
 * If field_map is absent, returns fact.value as the payload.
 */
export function mapFactFields(fact: ObserverFact, fieldMap?: Record<string, string>): Record<string, unknown> {
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
