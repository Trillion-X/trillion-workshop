// tools/revenue-ledger/read-data/read-payment-events.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Fold raw runtime rows into the `PaymentEvent[]` that `projectRevenue` consumes,
// and resolve the projection config row from the same rows. This is the read
// boundary between "whatever the runtime hands us" (opaque published rows) and
// the typed input the projection expects — the revenue counterpart to
// spaced-repetition's `readSpacedRepetitionState`.
//
// Generic + self-describing (L090): a row is a payment event iff its payload
// carries an `event_kind` string and an `event_id`. The reader names no specific
// event kind — which kinds count as revenue is the config's `event_role_map`
// DATA, not this code. Unknown providers/kinds flow through untouched.
//
// The one reader of payment events in the Workshop: tools/take-payments packs this file to read the same
// events into the access each buyer holds, so revenue and access never read a payment two ways.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type {
  PaymentEvent,
  RevenueProjectionConfig,
} from './revenue-types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Unwrap the row's payload (rows arrive as `{payload}`/`{value}` envelopes or
 *  bare objects), mirroring the other packages' read layers. */
function payloadFromRow(row: unknown): unknown {
  if (!isRecord(row)) return row;
  return row.payload ?? row.value ?? row;
}

/** A payload is a payment event iff it self-describes one: an `event_kind`
 *  string and an `event_id`. Everything else (configs, unrelated records) is
 *  skipped. The attributes bag is whatever else the payload carries. */
function asPaymentEvent(value: unknown): PaymentEvent | undefined {
  if (!isRecord(value)) return undefined;
  const eventKind = value.event_kind;
  const eventId = value.event_id;
  if (typeof eventKind !== 'string' || typeof eventId !== 'string') return undefined;
  const occurredAt = typeof value.occurred_at === 'string' ? value.occurred_at : '';
  const attributes = isRecord(value.attributes)
    ? value.attributes
    : // Fall back to the payload itself (minus the envelope keys) so flat event
      // payloads still expose their fields to the config-driven path resolver.
      stripEnvelopeKeys(value);
  return { event_id: eventId, occurred_at: occurredAt, event_kind: eventKind, attributes };
}

function stripEnvelopeKeys(value: Record<string, unknown>): Record<string, unknown> {
  const { event_id: _id, event_kind: _kind, occurred_at: _at, ...rest } = value;
  return rest;
}

/** Fold raw rows into the typed payment-event list `projectRevenue` consumes. */
export function readPaymentEvents(rows: unknown): PaymentEvent[] {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  return values
    .map(asPaymentEvent)
    .filter((event): event is PaymentEvent => event !== undefined);
}

/** Resolve the projection config from the same rows: the first payload whose
 *  `kind` is `revenue-projection-config`. Returns undefined when none is
 *  present (the caller renders the honest empty state rather than guess). */
export function readRevenueProjectionConfig(rows: unknown): RevenueProjectionConfig | undefined {
  const values = Array.isArray(rows) ? rows.map(payloadFromRow) : [];
  for (const value of values) {
    if (isRecord(value) && value.kind === 'revenue-projection-config') {
      return value as unknown as RevenueProjectionConfig;
    }
  }
  return undefined;
}
