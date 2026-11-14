// packages/chat/read-data/build-addressed-participant-rows.ts
//
// Generic producer for the addressed-exchange participant feed. A participant
// (model, agent, human, service) is an addressed endpoint reached through a
// way-to-reach adapter. The reader (decodeAddressedParticipantsFeed) already
// consumes a flat feed of { subject_id, property_id, value } rows with zero
// per-provider code; this turns self-describing endpoint DATA into that feed.
//
// No provider/model/vendor/transport branch lives here. Every per-endpoint
// difference is DATA. Adding a participant is one entry in the endpoint DATA,
// zero code change here. `launch` present => process-session adapter (native
// CLI). `ownerTarget` present => envelope-target adapter (cloud/service/agent).

export interface ReachableEndpoint {
  ref: string;
  label: string;
  mark?: {
    iconName?: string;
    logoUrl?: string;
    text?: string;
    background?: string;
    foreground?: string;
    border?: string;
  };
  requiresAuth?: boolean;
  models?: Array<{ id: string; label: string; isDefault?: boolean }>;
  accounts?: Array<{ id: string; label: string; configDir: string }>;
  launch?: unknown;
  ownerTarget?: string;
  serviceConnectionRefs?: string[];
  metadata?: Record<string, unknown>;
}

export interface AddressedParticipantFeedRow {
  subject_id: string;
  property_id: string;
  value: unknown;
}

const P = 'prop:addressed_participant:';
const W = 'prop:addressed_way_to_reach:';

function rowsForEndpoint(endpoint: ReachableEndpoint): AddressedParticipantFeedRow[] {
  const ref = endpoint.ref;
  const wayRef = `${ref}-way`;
  const rows: AddressedParticipantFeedRow[] = [];

  const participant = (property: string, value: unknown) => {
    if (value === undefined || value === null) return;
    rows.push({ subject_id: ref, property_id: `${P}${property}`, value });
  };
  const way = (property: string, value: unknown) => {
    if (value === undefined || value === null) return;
    rows.push({ subject_id: wayRef, property_id: `${W}${property}`, value });
  };

  participant('participant_ref', ref);
  participant('label', endpoint.label);
  participant('default_way_to_reach_ref', wayRef);
  if (endpoint.requiresAuth !== undefined) participant('requires_auth', endpoint.requiresAuth);
  if (endpoint.models && endpoint.models.length > 0) participant('models', endpoint.models);
  if (endpoint.accounts && endpoint.accounts.length > 0) participant('accounts', endpoint.accounts);
  if (endpoint.serviceConnectionRefs && endpoint.serviceConnectionRefs.length > 0) {
    participant('source_refs', endpoint.serviceConnectionRefs);
  }

  const metadata: Record<string, unknown> = { ...(endpoint.metadata ?? {}) };
  if (endpoint.mark) {
    if (endpoint.mark.iconName !== undefined) metadata.iconName = endpoint.mark.iconName;
    if (endpoint.mark.logoUrl !== undefined) metadata.logoUrl = endpoint.mark.logoUrl;
    if (endpoint.mark.text !== undefined) metadata.markText = endpoint.mark.text;
    if (endpoint.mark.background !== undefined) metadata.markBackground = endpoint.mark.background;
    if (endpoint.mark.foreground !== undefined) metadata.markForeground = endpoint.mark.foreground;
    if (endpoint.mark.border !== undefined) metadata.markBorder = endpoint.mark.border;
  }
  if (Object.keys(metadata).length > 0) participant('metadata', metadata);

  way('way_ref', wayRef);
  way('participant_ref', ref);
  way('label', endpoint.label);
  if (endpoint.serviceConnectionRefs && endpoint.serviceConnectionRefs.length > 0) {
    way('service_connection_refs', endpoint.serviceConnectionRefs);
  }
  if (endpoint.launch !== undefined && endpoint.launch !== null) {
    way('adapter', { kind: 'process-session', launch: endpoint.launch, requiresAuth: endpoint.requiresAuth ?? false });
  } else if (endpoint.ownerTarget) {
    way('adapter', {
      kind: 'addressed-exchange',
      ownerTargetRef: endpoint.ownerTarget,
      requiresAuth: endpoint.requiresAuth ?? false,
      ...(endpoint.serviceConnectionRefs ? { serviceConnectionRefs: endpoint.serviceConnectionRefs } : {}),
    });
  }

  return rows;
}

export function buildAddressedParticipantRows(
  endpoints: readonly ReachableEndpoint[],
): AddressedParticipantFeedRow[] {
  return endpoints.flatMap(rowsForEndpoint);
}
