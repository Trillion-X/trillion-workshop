// packages/business-event/read-data/read-business-event-ledger.ts
//
// =============================================================================
// PURPOSE — read-models over the business-event spine (event ledger / activity)
// =============================================================================
//
// Pure projections from a `BusinessEventStream`. NONE of them re-defines an event
// or hardcodes a business label: a rollup dimension is a DATA field-path, and the
// journey view groups by `correlationId`. Adding a new breakdown (by channel, by
// cohort, by offer) is a DATA dimension, never a code branch (enum-dissolution).
//
// SSOT: these read ONLY the event stream; they never write or re-shape events.
// Performance: single O(n) pass per projection over the stream; group state is a
// flat map keyed by the resolved dimension value (P3/P4 — flat side-maps).
// =============================================================================

import type { BusinessEvent, BusinessEventStream } from './business-event-types';
import { type FieldPath, readPath } from './field-path';

/** A rollup dimension: a name + the machine-readable path whose value groups events. */
export interface LedgerDimension {
  readonly id: string;
  readonly path: FieldPath;
}

/** One group in a rollup: the resolved key + count + time span + member ids. */
export interface LedgerGroup {
  readonly key: string;
  readonly count: number;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
  readonly eventIds: readonly string[];
}

/** Resolve a dimension value to a group key; unresolved -> the explicit `(none)` bucket. */
function dimensionKey(event: BusinessEvent, dimension: LedgerDimension): string {
  const value = readPath(event, dimension.path);
  if (value == null || value === '') return '(none)';
  return typeof value === 'string' ? value : String(value);
}

/**
 * Group a stream by a DATA dimension. ONE O(n) pass; groups are sorted by count
 * desc then key asc (deterministic). Adding "by channel" vs "by kind" is choosing
 * a different `LedgerDimension` DATA value, not different code.
 */
export function foldBusinessEventLedger(
  events: BusinessEventStream,
  dimension: LedgerDimension,
): LedgerGroup[] {
  const groups = new Map<string, { count: number; first: string; last: string; ids: string[] }>();
  for (const event of events) {
    const key = dimensionKey(event, dimension);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { count: 1, first: event.occurredAt, last: event.occurredAt, ids: [event.id] });
    } else {
      existing.count += 1;
      existing.ids.push(event.id);
      if (event.occurredAt < existing.first) existing.first = event.occurredAt;
      if (event.occurredAt > existing.last) existing.last = event.occurredAt;
    }
  }
  return Array.from(groups.entries())
    .map(([key, g]) => ({ key, count: g.count, firstOccurredAt: g.first, lastOccurredAt: g.last, eventIds: g.ids }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** One correlation thread — all events of a journey, ordered by time. */
export interface CorrelationThread {
  readonly correlationId: string;
  readonly events: readonly BusinessEvent[];
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
}

/**
 * Reconstruct journeys: group events by `correlationId` (events without one fall
 * under `(uncorrelated)`), each thread time-ordered. This is how the ledger shows
 * "what happened across this checkout / session / run" — the OBSERVE half of the
 * loop, with no per-journey-type code.
 */
export function buildCorrelationThreads(events: BusinessEventStream): CorrelationThread[] {
  const threads = new Map<string, BusinessEvent[]>();
  for (const event of events) {
    const key = event.correlationId && event.correlationId !== '' ? event.correlationId : '(uncorrelated)';
    const bucket = threads.get(key);
    if (bucket) bucket.push(event);
    else threads.set(key, [event]);
  }
  return Array.from(threads.entries())
    .map(([correlationId, evs]) => {
      const ordered = [...evs].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
      return {
        correlationId,
        events: ordered,
        firstOccurredAt: ordered[0]?.occurredAt ?? '',
        lastOccurredAt: ordered[ordered.length - 1]?.occurredAt ?? '',
      };
    })
    .sort((a, b) => b.lastOccurredAt.localeCompare(a.lastOccurredAt));
}

/**
 * Integrity readout: how many events of each `kind` lack `signed` assurance. The
 * caller supplies which kinds DEMAND signing (DATA — e.g. finance/access kinds),
 * so no money/access label is hardcoded here. A non-empty result is a control
 * alarm (an unsigned money/access claim slipped into the ledger).
 */
export function unsignedSensitiveEvents(
  events: BusinessEventStream,
  kindsRequiringSignature: ReadonlySet<string>,
): BusinessEvent[] {
  return events.filter(
    (event) => kindsRequiringSignature.has(event.kind) && event.provenance.assurance !== 'signed',
  );
}
