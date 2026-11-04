// PORTED FROM: bitfield-packages/packages/chat/read-data/read-addressed-exchange.ts @ e99ac5976
export interface AddressedExchangeEvent {
  eventRef: string;
  exchangeScopeRef: string;
  participantRef: string | null;
  sourceRefs: string[];
  correlationRefs: string[];
  payload: unknown;
  createdAt: string;
  evidenceRefs: string[];
}

export interface AddressedContextGrant {
  grantRef: string;
  exchangeScopeRef: string | null;
  participantRef: string | null;
  contextRef: string;
  label: string;
  capabilityRefs: string[];
  payload: unknown;
  evidenceRefs: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

export function decodeAddressedExchangeEvent(value: unknown): AddressedExchangeEvent | null {
  if (!isRecord(value)) return null;
  const eventRef = stringValue(value.eventRef) ?? stringValue(value.event_ref);
  const exchangeScopeRef =
    stringValue(value.exchangeScopeRef)
    ?? stringValue(value.exchange_scope_ref);
  if (!eventRef || !exchangeScopeRef) return null;
  return {
    eventRef,
    exchangeScopeRef,
    participantRef: stringValue(value.participantRef) ?? stringValue(value.participant_ref),
    sourceRefs: stringArray(value.sourceRefs ?? value.source_refs),
    correlationRefs: stringArray(value.correlationRefs ?? value.correlation_refs),
    payload: value.payload,
    createdAt: stringValue(value.createdAt) ?? stringValue(value.created_at) ?? '',
    evidenceRefs: stringArray(value.evidenceRefs ?? value.evidence_refs),
  };
}

export function decodeAddressedContextGrant(value: unknown): AddressedContextGrant | null {
  if (!isRecord(value)) return null;
  const grantRef = stringValue(value.grantRef) ?? stringValue(value.grant_ref);
  const contextRef = stringValue(value.contextRef) ?? stringValue(value.context_ref);
  if (!grantRef || !contextRef) return null;
  return {
    grantRef,
    exchangeScopeRef:
      stringValue(value.exchangeScopeRef)
      ?? stringValue(value.exchange_scope_ref),
    participantRef: stringValue(value.participantRef) ?? stringValue(value.participant_ref),
    contextRef,
    label: stringValue(value.label) ?? contextRef,
    capabilityRefs: stringArray(value.capabilityRefs ?? value.capability_refs),
    payload: value.payload,
    evidenceRefs: stringArray(value.evidenceRefs ?? value.evidence_refs),
  };
}

export function decodeAddressedContextGrantsFeed(
  raw: unknown,
  filter: {
    exchangeScopeRef?: string | null;
    participantRef?: string | null;
  } = {},
): AddressedContextGrant[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(decodeAddressedContextGrant)
    .filter((grant): grant is AddressedContextGrant => {
      if (!grant) return false;
      const exchangeScopeMatches = !filter.exchangeScopeRef
        || grant.exchangeScopeRef === null
        || grant.exchangeScopeRef === filter.exchangeScopeRef;
      const participantMatches = !filter.participantRef
        || grant.participantRef === null
        || grant.participantRef === filter.participantRef;
      return exchangeScopeMatches && participantMatches;
    });
}
