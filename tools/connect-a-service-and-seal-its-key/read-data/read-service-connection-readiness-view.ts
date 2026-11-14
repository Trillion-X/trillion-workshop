// packages/service-connections/read-data/read-service-connection-readiness-view.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The package-local, ref-free projection the React surfaces render. It folds
// the live connection feed and the service catalog into one list of
// connection rows whose EXPORTED shape carries only what a human screen needs:
// identity, plain-language purpose, capability flags, and a derived display
// status. Decode-internal ref vocabulary (statusRef, proofRefs, blockerRefs,
// eventRefs, credentialHandle, credentialHandleRefs) stays inside the decode
// layer and never reaches a view-model field.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The exported view-model is REF-FREE (L098 translation boundary). Refs are
//    storage internals of read-service-connections; surfaces speak identity +
//    capability + purpose, never storage addresses.
// 2. Affordances are driven by capability FLAGS (canConnect/canRetry/canSend/
//    isPending), which the backend writes as the SSOT — never by re-deriving
//    state from provider identity or status strings (Physics vs Society / L090).
// 3. `status` is a DERIVED display tag computed from capability flags. It is a
//    presentation label, never branched on by any consumer to decide an action
//    and never inferred from the provider name.
//
// =============================================================================

import {
  decodeConnectionRows,
  type ServiceConnection,
} from '@/packages/service-connections/read-data/read-service-connections';
import {
  buildServiceConnectionDisplayList,
  type ServiceAuthConfig,
  type ServiceEnvironment,
  type ServiceConnectionStateEffects,
  type ServiceConversationSourceTemplate,
} from '@/packages/service-connections/read-data/read-service-connection-options';

/**
 * One connectable row, in the human screen's language. Every field is either
 * identity, a plain-language label, a capability flag, or a derived display
 * tag — there is no ref/address vocabulary here by construction.
 */
export interface ServiceConnectionReadinessView {
  /** Stable instance id (e.g. `service_connection:alpaca`). */
  id: string;
  /** Human service name ("Alpaca"). */
  serviceName: string;
  /** Vendor slug ("alpaca") — used only for catalog grouping/mark identity. */
  serviceVendor: string;
  /** Account identity for this instance ("work@example.com", "Personal"); '' = never set. */
  accountLabel: string;
  /** What connecting this service lets the user do, in their language. */
  purpose: string;
  /** Catalog grouping ("AI", "Payments", "Your services"; '' = ungrouped). */
  category: string;
  /** Service mark image ('' = render a monogram tile from the name). */
  logoUrl: string;
  /** Permission scopes this connection holds/requests. */
  scopes: string[];
  /** Derived display tag: 'pending' | 'error' | 'connected' | 'disconnected'. */
  status: string;
  /** ISO timestamp of the last successful connect ('' → null). Display only. */
  connectedAt: string | null;
  /** Backend-written capability SSOT. */
  canConnect: boolean;
  canSend: boolean;
  canRetry: boolean;
  isPending: boolean;
  /** Open, service-declared environment choices. Omitted for envless services. */
  environments?: ServiceEnvironment[];
  /** DATA-declared facts that follow this connection's lifecycle. */
  stateEffects?: ServiceConnectionStateEffects;
  conversationSourceTemplates?: ServiceConversationSourceTemplate[];
}

/**
 * Derive the human display tag from capability flags ALONE.
 *
 * connectedAt is intentionally NOT an input: disconnect-service.ts flips
 * `canSend` off but RETAINS `connectedAt` as history, so a populated
 * `connectedAt` does not mean "connected". Capability flags are the sole
 * connectedness SSOT — `canSend` is the dominant connectedness signal. The
 * timestamp rides the view as a display-only field (see `connectedAt` above).
 *
 * Precedence: in-flight work (pending) and a surfaced failure (error) outrank
 * the steady connected/disconnected split so the user always sees the most
 * actionable state.
 */
export function deriveReadinessStatus(flags: {
  isPending: boolean;
  canRetry: boolean;
  canSend: boolean;
}): string {
  if (flags.isPending) return 'pending';
  if (flags.canRetry) return 'error';
  if (flags.canSend) return 'connected';
  return 'disconnected';
}

/**
 * Project the live connection feed + service catalog into the ref-free
 * readiness view the surfaces render.
 *
 * Reuses `decodeConnectionRows` (the single feed decoder) and
 * `buildServiceConnectionDisplayList` (the single instance+catalog fold) so
 * there is one decode path and one catalog-merge path — this view only strips
 * refs and derives the display tag on top of them (no parallel SSOT).
 */
export function readServiceConnectionReadinessView(
  connectionsRaw: unknown,
  configs: ServiceAuthConfig[],
): ServiceConnectionReadinessView[] {
  const connections: ServiceConnection[] = decodeConnectionRows(connectionsRaw);

  // Surface the generic-fallback path: any live connection whose vendor has no
  // catalog config renders through the generic ("Your services") decoration.
  const configuredVendors = new Set(configs.map((config) => config.vendor));
  for (const connection of connections) {
    if (!configuredVendors.has(connection.serviceVendor)) {
      // eslint-disable-next-line no-console
      console.info(
        `[service-connections/readiness] generic fallback for vendor "${connection.serviceVendor}"`,
      );
    }
  }

  const rows = buildServiceConnectionDisplayList(connections, configs).map(
    (row): ServiceConnectionReadinessView => ({
      id: row.id,
      serviceName: row.serviceName,
      serviceVendor: row.serviceVendor,
      accountLabel: row.accountLabel,
      purpose: row.purpose,
      category: row.category,
      logoUrl: row.logoUrl,
      scopes: row.scopes,
      status: deriveReadinessStatus(row),
      connectedAt: row.connectedAt,
      canConnect: row.canConnect,
      canSend: row.canSend,
      canRetry: row.canRetry,
      isPending: row.isPending,
      ...(row.environments?.length ? { environments: row.environments } : {}),
      ...(row.stateEffects ? { stateEffects: row.stateEffects } : {}),
      ...(row.conversationSourceTemplates?.length
        ? { conversationSourceTemplates: row.conversationSourceTemplates }
        : {}),
    }),
  );

  // eslint-disable-next-line no-console
  console.info(
    `[service-connections/readiness] projected ${rows.length} rows from owner contract`,
  );

  return rows;
}
