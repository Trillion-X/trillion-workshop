// packages/business-event/do-work/map-to-business-event.ts
//
// =============================================================================
// PURPOSE — customer/source event -> canonical BusinessEvent (B01.W02 mapping)
// =============================================================================
//
// Any source record (a checkout reply, a page-view fact, a coaching-session
// record, a Stripe webhook payload, an owner action) becomes a canonical
// `BusinessEvent` by applying a DATA mapping rule. The mapper is BLIND: it never
// switches on the source's kind — it reads field paths the mapping names and
// assembles the event. Teaching the business a new moment is a new mapping DATA
// record (one row), never a code edit (L063/L069/enum-dissolution).
//
// WHY DATA field-paths (machine-readable, CLAUDE.md): a `FieldPath` is an ARRAY
// of keys (`['payment','amount']`), never a dotted string — a dumb reader walks
// it with zero string surgery. A `ValueSpec` is either a `literal` constant or a
// `path` into the source. Adding/retargeting a field is a DATA change.
//
// FAIL-CLOSED: a mapping whose required path resolves to nothing returns a
// structured error — never a malformed half-event. The only closed validation is
// `assurance` (the Physics trust property): an unknown assurance is rejected, so
// a money/access event can never silently claim the wrong trust level.
// =============================================================================

import type {
  BusinessEvent,
  EventAssurance,
  EventParty,
  EventProvenance,
  EventSource,
} from '../read-data/business-event-types';
import { type FieldPath, readPath } from '../read-data/field-path';

// `FieldPath` + `readPath` are the SSOT field-path primitive (read-data/field-path.ts),
// shared by the mapper, the ledger, and the funnel projection. Re-exported here so
// existing `BusinessEventMapping` consumers keep importing the type from one place.
export type { FieldPath };

/** A mapped value: a constant `literal`, or a `path` read from the source record. */
export type ValueSpec =
  | { readonly literal: string }
  | { readonly path: FieldPath };

/** How to build an EventParty from the source record (each field is a ValueSpec). */
export interface PartyMapping {
  readonly kind: ValueSpec;
  readonly id: ValueSpec;
  readonly label?: ValueSpec;
}

/**
 * The DATA rule that turns one shape of source record into a BusinessEvent. This
 * is Society configuration — a new source event type is a new mapping, never code.
 */
export interface BusinessEventMapping {
  /** Mapping id (for provenance/debugging). */
  readonly id: string;
  /** Where the event's own id comes from (a path, or a literal for singletons). */
  readonly eventId: ValueSpec;
  readonly kind: ValueSpec;
  readonly action: ValueSpec;
  readonly actor: PartyMapping;
  readonly object?: PartyMapping;
  readonly source: {
    readonly system: ValueSpec;
    readonly channel?: ValueSpec;
    readonly externalId?: ValueSpec;
  };
  readonly occurredAt: ValueSpec;
  readonly correlationId?: ValueSpec;
  readonly provenance: {
    readonly assurance: ValueSpec;
    readonly signedEventId?: ValueSpec;
    readonly decisionRight?: ValueSpec;
  };
  /** Which source fields carry verbatim into `attributes` (key -> source path). */
  readonly attributePaths?: Readonly<Record<string, FieldPath>>;
}

export type MapResult =
  | { readonly ok: true; readonly event: BusinessEvent }
  | { readonly ok: false; readonly reason: string };

const ASSURANCES: ReadonlySet<string> = new Set<EventAssurance>([
  'signed',
  'observed',
  'derived',
  'declared',
]);

/** Resolve a ValueSpec to a string, or undefined when an optional path misses. */
function resolve(record: unknown, spec: ValueSpec | undefined): string | undefined {
  if (!spec) return undefined;
  if ('literal' in spec) return spec.literal;
  const value = readPath(record, spec.path);
  if (value == null) return undefined;
  return typeof value === 'string' ? value : String(value);
}

/** Resolve a required string field, recording the field name on failure. */
function required(
  record: unknown,
  spec: ValueSpec,
  field: string,
  errors: string[],
): string {
  const value = resolve(record, spec);
  if (value == null || value === '') {
    errors.push(field);
    return '';
  }
  return value;
}

function buildParty(
  record: unknown,
  mapping: PartyMapping,
  field: string,
  errors: string[],
): EventParty {
  return {
    kind: required(record, mapping.kind, `${field}.kind`, errors),
    id: required(record, mapping.id, `${field}.id`, errors),
    ...(mapping.label ? { label: resolve(record, mapping.label) } : {}),
  };
}

/**
 * Apply a DATA mapping to a source record, producing a canonical BusinessEvent.
 * Pure + total: any input yields either a complete event or a structured error
 * naming the missing/invalid fields. The mapper never inspects the source's kind.
 */
export function mapToBusinessEvent(sourceRecord: unknown, mapping: BusinessEventMapping): MapResult {
  const errors: string[] = [];

  const id = required(sourceRecord, mapping.eventId, 'eventId', errors);
  const kind = required(sourceRecord, mapping.kind, 'kind', errors);
  const action = required(sourceRecord, mapping.action, 'action', errors);
  const occurredAt = required(sourceRecord, mapping.occurredAt, 'occurredAt', errors);
  const actor = buildParty(sourceRecord, mapping.actor, 'actor', errors);

  const assuranceRaw = required(sourceRecord, mapping.provenance.assurance, 'provenance.assurance', errors);
  if (assuranceRaw && !ASSURANCES.has(assuranceRaw)) {
    errors.push(`provenance.assurance(invalid:${assuranceRaw})`);
  }

  if (errors.length > 0) {
    return { ok: false, reason: `mapping ${mapping.id} could not resolve: ${errors.join(', ')}` };
  }

  const source: EventSource = {
    system: resolve(sourceRecord, mapping.source.system) ?? '',
    ...(mapping.source.channel ? { channel: resolve(sourceRecord, mapping.source.channel) } : {}),
    ...(mapping.source.externalId ? { externalId: resolve(sourceRecord, mapping.source.externalId) } : {}),
  };

  const provenance: EventProvenance = {
    assurance: assuranceRaw as EventAssurance,
    ...(mapping.provenance.signedEventId ? { signedEventId: resolve(sourceRecord, mapping.provenance.signedEventId) } : {}),
    ...(mapping.provenance.decisionRight ? { decisionRight: resolve(sourceRecord, mapping.provenance.decisionRight) } : {}),
  };

  const attributes: Record<string, unknown> = {};
  if (mapping.attributePaths) {
    for (const [key, path] of Object.entries(mapping.attributePaths)) {
      const value = readPath(sourceRecord, path);
      if (value !== undefined) attributes[key] = value;
    }
  }

  const event: BusinessEvent = {
    id,
    kind,
    action,
    actor,
    ...(mapping.object ? { object: buildParty(sourceRecord, mapping.object, 'object', errors) } : {}),
    source,
    occurredAt,
    ...(mapping.correlationId ? { correlationId: resolve(sourceRecord, mapping.correlationId) } : {}),
    provenance,
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
  };

  return { ok: true, event };
}
