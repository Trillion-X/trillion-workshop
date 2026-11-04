// packages/service-connections/do-work/connect-service.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Service connection write path. Raw credential bytes go to slot::credentials-vault
// first; durable connection metadata goes to the workflow owner action with only
// the opaque credential handle.
//
// Every engine call arrives through a `seams` argument (ServiceConnectionSeams
// below). Callers that pass none get `engineSeams` from engine-seams.ts, which
// makes the same vault, workflow, manifest and clock calls this file made
// before seams existed. A host with no engine passes its own seams and runs
// this same code.
//
// =============================================================================

type RuntimeContext = unknown;
import { engineSeams } from './engine-seams';
import {
  requireWrittenServiceConnectionFacts,
} from './workflow-actions';
import {
  ownerRecordEntityWrites,
  declaredStateEffectFacts,
  ownerRecordFact,
  ownerRecordStateFacts,
  type OwnerRecordWorkContract,
} from '../read-data/owner-record-work-contract';
import {
  deriveConnectionInstanceId,
} from '../read-data/read-service-connection-options';
import type {
  ServiceConversationSourceTemplate,
  ServiceAcquireDescriptor,
  ServiceConnectionTarget,
  ServiceCredentialSubmission,
  ServiceEnvironment,
  ServiceVerifyRequest,
} from '../read-data/read-service-connection-options';

const CONVERSATION_SOURCE_PROPERTY = 'prop:observed_content:conversation_source_descriptor';

/**
 * Everything the connect functions ask of their host. The engine route is
 * `engineSeams` (engine-seams.ts); any other host supplies these five.
 */
export type ServiceConnectionSeams = {
  /** The owner record work contract: fact properties, state facts, secret naming. */
  workContract(): OwnerRecordWorkContract;
  /** Store a value under a name and return a handle a check can place into a request. */
  createValue(name: string, value: string, options: { handleTtlSeconds: number }): Promise<string>;
  /** Store a value under a name. */
  writeValue(name: string, value: string): Promise<void>;
  /** Run the owner action for one operation and return its reply. */
  runOwnerAction(
    operation: string,
    input?: Record<string, unknown>,
    options?: { includeOutput?: boolean },
  ): Promise<unknown>;
  /** The trusted current time, in milliseconds. */
  nowMs(): number;
};

type SourceTemplateContext = {
  connection: ServiceConnectionTarget;
  credentialFieldSecretRefs: Record<string, string>;
};

function materializeTemplateValue(value: unknown, context: SourceTemplateContext): unknown {
  if (Array.isArray(value)) return value.map((item) => materializeTemplateValue(item, context));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const connectionField = typeof record.$connection === 'string' ? record.$connection : '';
  if (Object.keys(record).length === 1 && connectionField) {
    const resolved = context.connection[connectionField as keyof ServiceConnectionTarget];
    if (resolved === undefined) throw new Error(`Source template requests unavailable connection field: ${connectionField}`);
    return resolved;
  }
  const connectionAddress = record.$connection_address;
  if (Object.keys(record).length === 1 && connectionAddress && typeof connectionAddress === 'object') {
    const spec = connectionAddress as Record<string, unknown>;
    const prefix = typeof spec.prefix === 'string' ? spec.prefix : '';
    const field = typeof spec.field === 'string' ? spec.field : '';
    const resolved = field ? context.connection[field as keyof ServiceConnectionTarget] : undefined;
    if (!prefix || typeof resolved !== 'string' || !resolved) {
      throw new Error('Source template requests an unavailable connection address');
    }
    return `${prefix}${resolved}`;
  }
  const credentialField = typeof record.$credential_field_secret === 'string'
    ? record.$credential_field_secret
    : '';
  if (Object.keys(record).length === 1 && credentialField) {
    const resolved = context.credentialFieldSecretRefs[credentialField];
    if (!resolved) throw new Error(`Source template requests unavailable credential field: ${credentialField}`);
    return resolved;
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    materializeTemplateValue(item, context),
  ]));
}

export function conversationSourceDescriptorFacts(input: {
  templates?: readonly ServiceConversationSourceTemplate[];
  connection: ServiceConnectionTarget;
  credentialFieldSecretRefs?: Record<string, string>;
  active: boolean;
}) {
  return (input.templates ?? []).map((template) => {
    const descriptor = input.active
      ? materializeTemplateValue(template.descriptor, {
          connection: input.connection,
          credentialFieldSecretRefs: input.credentialFieldSecretRefs ?? {},
        })
      : [];
    return {
      address: `attribute_fact|${template.sourceRef}|${CONVERSATION_SOURCE_PROPERTY}|type:observed_content`,
      path: ['current-item', 'published-record'],
      payload: {
        property_id: CONVERSATION_SOURCE_PROPERTY,
        subject_id: template.sourceRef,
        table: 'attribute_fact' as const,
        type_id: 'type:observed_content',
        value_json: JSON.stringify(input.active ? [descriptor] : descriptor),
      },
    };
  });
}

function utf8Hex(value: string): string {
  return Array.from(new TextEncoder().encode(value))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function buildServiceConnectionSecretName(
  connection: ServiceConnectionTarget,
  contract: OwnerRecordWorkContract = engineSeams().workContract(),
): string {
  return `${contract.secret.name_prefix}-${utf8Hex(connection.id)}`;
}

/**
 * One vault secret per credential field. This is the canonical consumer
 * surface: downstream workflows mint fresh short-TTL handles per field name
 * and inject each value independently (header/query placement), which is the
 * only shape that works for providers requiring multiple credentials.
 */
export function buildServiceConnectionFieldSecretName(
  connectionId: string,
  fieldId: string,
  contract: OwnerRecordWorkContract = engineSeams().workContract(),
): string {
  return `${contract.secret.name_prefix}-${utf8Hex(connectionId)}-field-${utf8Hex(fieldId)}`;
}

export function serializeServiceCredentialSubmission(
  credential: ServiceCredentialSubmission,
): string {
  return JSON.stringify({
    service_vendor: credential.serviceVendor,
    service_name: credential.serviceName,
    fields: credential.fields.map((field) => ({
      id: field.id,
      label: field.label,
      value: field.value,
      ...(field.secret === true ? { secret: true } : {}),
    })),
  });
}

/**
 * Run the service-declared credential check through the workflow-owned verify
 * action (http-client resolves the per-field handles). Returns the HTTP
 * status; throws with a plain-language cause on a non-2xx outcome.
 */
async function verifyServiceCredential(
  verifyRequest: ServiceVerifyRequest,
  connectionId: string,
  fieldValueById: Map<string, string>,
  environment: ResolvedConnectionEnvironment | null,
  seams: ServiceConnectionSeams,
  plainFields: Record<string, string>,
): Promise<void> {
  const contract = seams.workContract();
  const injections = [];
  for (const injection of verifyRequest.injections) {
    const value = fieldValueById.get(injection.fieldId);
    if (!value) continue; // skippable field not provided — endpoint will judge
    const handle = await seams.createValue(
      buildServiceConnectionFieldSecretName(connectionId, injection.fieldId, contract),
      value,
      { handleTtlSeconds: contract.secret.verification_handle_ttl_seconds },
    );
    injections.push({ handle, placement: injection.placement });
  }

  const reply = await seams.runOwnerAction(
    'verify-external-request',
    {
      verify_request: {
        url: verifyRequest.url,
        method: verifyRequest.method,
        headers: verifyRequest.headers,
        // http-client CallExternalRequest.body accepts an inline byte array or
        // a CAS blob_ref. Credential verification is intentionally small, so
        // inline bytes preserve the canonical typed wire shape.
        body: verifyRequest.body
          ? Array.from(new TextEncoder().encode(verifyRequest.body))
          : null,
        credential_injections: injections,
        timeout_ms: verifyRequest.timeoutMs,
      },
      credentials: plainFields,
      ...(environment
        ? {
          environment_id: environment.id,
          environment_addresses: environment.baseAddresses,
        }
        : {}),
    },
    { includeOutput: true },
  );

  // Reply shape mirrors the proven chat connect path: the action's return
  // value arrives under `output` (workflowOutputFromReply precedent).
  const record = reply && typeof reply === 'object' ? (reply as Record<string, unknown>) : {};
  const output = record.output && typeof record.output === 'object'
    ? (record.output as Record<string, unknown>)
    : record;
  const statusCode = Number(output.status_code ?? NaN);
  // Surface the service's own rejection detail (e.g. OpenAI's
  // "Incorrect API key provided: sk-...XYZ") so the user can see the real
  // reason instead of a generic message. The http-client body arrives as a
  // byte array; decode it and pull a human message out of the JSON if present.
  const serviceDetail = ((): string => {
    try {
      const raw = output.body;
      const bytes = Array.isArray(raw) ? Uint8Array.from(raw as number[]) : null;
      if (!bytes) return '';
      const text = new TextDecoder().decode(bytes).trim();
      if (!text) return '';
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string };
        const msg = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
        return typeof msg === 'string' ? msg : text.slice(0, 300);
      } catch {
        return text.slice(0, 300);
      }
    } catch {
      return '';
    }
  })();
  const withDetail = (base: string) => (serviceDetail ? `${base} (${serviceDetail})` : base);
  if (!Number.isFinite(statusCode)) {
    throw new Error('The service did not answer the connection check. Try again.');
  }
  if (statusCode === 401 || statusCode === 403) {
    throw new Error(withDetail('That key was rejected by the service. Check it and try again.'));
  }
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(withDetail(`The connection check failed (the service answered ${statusCode}). Try again.`));
  }
}

export type ConnectServiceOutcome = {
  /** true = the service accepted the credential; false = saved without a check */
  verified: boolean;
  /**
   * true = the submission carried a secret but NO validation passed, so the
   * connection was written SAVED-BUT-NOT-USABLE (write-stopped, canSend:false).
   * This is the honest anti-fake-connect outcome: a stored secret is not proof
   * the credential works. false = either a validation passed or nothing secret
   * was collected, so the connection is genuinely usable.
   */
  savedUnverified: boolean;
  /** Present after interactive sign-in so the dialog can name the connected account. */
  accountLabel?: string;
};

type ResolvedConnectionEnvironment = {
  id: string;
  baseAddresses: Record<string, string>;
};

function resolveConnectionEnvironment(
  environments: readonly ServiceEnvironment[] | undefined,
  environmentId: string | null | undefined,
): ResolvedConnectionEnvironment | null {
  if (!environments?.length) return null;
  const chosen = environmentId
    ? environments.find((environment) => environment.id === environmentId)
    : environments.find((environment) => environment.default === true) ?? environments[0];
  if (!chosen) {
    throw new Error('The selected service environment is not available anymore. Pick another one and try again.');
  }
  return {
    id: chosen.id,
    baseAddresses: { ...chosen.baseAddresses },
  };
}

async function writeConnectedServiceFacts(input: {
  connection: ServiceConnectionTarget;
  credentialHandleRefs: string[];
  credentialFieldSecretRefs: Record<string, string>;
  environment: ResolvedConnectionEnvironment | null;
  /**
   * Which connection lifecycle state to write. `write-ready` = usable/Connected
   * (canSend:true); `write-stopped` = saved but NOT usable (canSend:false). The
   * credential facts are written either way (the connector still needs them),
   * but only a passing validation earns `write-ready`.
   */
  stateKey: 'write-ready' | 'write-stopped';
  /**
   * When the connection was established, as the VALUE, taken from the request the
   * engine recorded rather than from this machine's clock. A durable fact about a
   * moment must replay to the same moment.
   */
  connectedAtMs: number;
}, seams: ServiceConnectionSeams): Promise<void> {
  const id = input.connection.id;
  const contract = seams.workContract();
  const fact = (fieldKey: string, value: unknown) =>
    ownerRecordFact(contract, id, fieldKey, value);
  const environmentFacts = input.environment
    ? [
      fact('environmentRef', input.environment.id),
      fact('environmentAddresses', input.environment.baseAddresses),
    ]
    : [];

  // Durable connection truth: write the owner facts through the owner write-door.
  // The published feed's columns project prop:connection_state:* facts
  // (status_ref, capability booleans, connected_at, scope_refs, *_refs) —
  // every column the publish action declares must have a matching fact, or
  // consumers read the connection as unusable.
  const accountLabelFacts = input.connection.accountLabel
    ? [fact('accountLabel', input.connection.accountLabel)]
    : [];
  const resourceRefFacts = input.connection.resourceRefs?.length
    ? [fact('resourceRefs', input.connection.resourceRefs)]
    : [];
  const facts = [
    ...ownerRecordEntityWrites(contract, id),
    fact('serviceName', input.connection.serviceName),
    ...accountLabelFacts,
    ...resourceRefFacts,
    fact('serviceVendor', input.connection.serviceVendor),
    fact('scopes', input.connection.scopes),
    fact('grantScopes', input.connection.grantScopes ?? []),
    fact('grantScopesKnown', input.connection.grantScopesKnown === true),
    fact('connectedAt', new Date(input.connectedAtMs).toISOString()),
    fact('credentialHandleRefs', input.credentialHandleRefs),
    ...ownerRecordStateFacts(contract, id, input.stateKey),
    ...declaredStateEffectFacts(input.connection.stateEffects?.[
      input.stateKey === 'write-ready' ? 'ready' : 'stopped'
    ]),
    ...conversationSourceDescriptorFacts({
      templates: input.connection.conversationSourceTemplates,
      connection: input.connection,
      credentialFieldSecretRefs: input.credentialFieldSecretRefs,
      active: input.stateKey === 'write-ready',
    }),
    ...environmentFacts,
    fact('credentialFieldSecretRefs', input.credentialFieldSecretRefs),
  ];
  const reply = await seams.runOwnerAction(
    'write-facts',
    { facts },
    { includeOutput: true },
  );
  requireWrittenServiceConnectionFacts(reply, facts.length);
  // The published feed re-projects REACTIVELY: writing these
  // prop:connection_state:* facts fires the on-change trigger
  // (trigger:publish-service-connections-on-change), which re-runs
  // publish-service-connections and advances the subscribed value address.
  // No caller-side publish — the fact write IS the reactive cause.
}

type DirectServiceConnectionInput = {
  connection: ServiceConnectionTarget;
  credential: ServiceCredentialSubmission;
  /** Service-declared credential check; null = none declared (honest "saved") */
  verifyRequest?: ServiceVerifyRequest | null;
  /** Open service environment id chosen by the UI; omitted uses the catalog default. */
  environmentId?: string | null;
  /** Catalog environment rows; UI may pass these directly during chooser rollout. */
  environments?: readonly ServiceEnvironment[];
};

type InteractiveServiceConnectionInput = {
  connection: ServiceConnectionTarget;
  acquire: ServiceAcquireDescriptor;
  existingConnectionIds?: string[];
  environmentId?: string | null;
  environments?: readonly ServiceEnvironment[];
};

export async function connectService(
  input: DirectServiceConnectionInput | InteractiveServiceConnectionInput,
  context?: RuntimeContext,
  seams: ServiceConnectionSeams = engineSeams(context),
): Promise<ConnectServiceOutcome> {
  // Package targets expose one connect verb. Interactive acquisition runs and
  // seals inside this owner, so no caller can invent an opaque handle and mark
  // an account ready. Direct collection keeps the established path below.
  if ('acquire' in input) {
    const reply = await seams.runOwnerAction(
      'acquire-credential',
      { acquire: input.acquire },
      { includeOutput: true },
    );
    const record = reply && typeof reply === 'object' ? reply as Record<string, unknown> : {};
    const result = record.output && typeof record.output === 'object' && !Array.isArray(record.output)
      ? record.output as Record<string, unknown>
      : record;
    const accountLabel = typeof result.account_label === 'string' ? result.account_label : '';
    const credentialHandleRef = typeof result.credential_handle_ref === 'string' ? result.credential_handle_ref : '';
    const resourceRefs = Array.isArray(result.resource_refs)
      ? result.resource_refs.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [];
    if (!accountLabel || !credentialHandleRef) {
      throw new Error('Sign-in finished without an account name or usable access. Nothing was connected.');
    }
    const id = deriveConnectionInstanceId(
      input.connection.serviceVendor,
      accountLabel,
      new Set(input.existingConnectionIds ?? []),
    );
    await connectServiceWithCredentialHandle({
      connection: { ...input.connection, id, accountLabel, resourceRefs },
      credentialHandleRef,
      environmentId: input.environmentId,
      environments: input.environments,
    }, context, seams);
    return { verified: true, savedUnverified: false, accountLabel };
  }
  // Trim surrounding whitespace/newlines from every submitted credential value —
  // a pasted API key with a trailing newline authenticates as "Bearer sk-...\n"
  // and is rejected by the service. Keys/tokens never carry surrounding
  // whitespace, so trimming is always correct. Applies to BOTH the stored secret
  // and the verify injection (both read from input.credential.fields).
  input = {
    ...input,
    credential: {
      ...input.credential,
      fields: input.credential.fields.map((field) => ({
        ...field,
        value: typeof field.value === 'string' ? field.value.trim() : field.value,
      })),
    },
  };
  const contract = seams.workContract();
  const credentialHandle = await seams.createValue(
    buildServiceConnectionSecretName(input.connection, contract),
    serializeServiceCredentialSubmission(input.credential),
    { handleTtlSeconds: contract.secret.submission_handle_ttl_seconds },
  );

  // Canonical per-field secrets: each field value is its own vault secret so
  // downstream workflows can mint per-field handles for http-client injection.
  const fieldSecretRefs: Record<string, string> = {};
  for (const field of input.credential.fields) {
    const secretName = buildServiceConnectionFieldSecretName(input.connection.id, field.id, contract);
    await seams.writeValue(secretName, field.value);
    fieldSecretRefs[field.id] = secretName;
  }

  // Honest connect: when the record declares a check, the credential must pass
  // it BEFORE any connected fact is written. A thrown error surfaces in the
  // dialog; nothing below runs, no fake Connected state exists.
  const verifyRequest = input.verifyRequest ?? null;
  const environment = resolveConnectionEnvironment(
    input.environments ?? input.connection.environments,
    input.environmentId,
  );
  if (verifyRequest) {
    await verifyServiceCredential(
      verifyRequest,
      input.connection.id,
      new Map(input.credential.fields.map((field) => [field.id, field.value])),
      environment,
      seams,
      // The fields the service explicitly marks not secret (a shop or site address) reach the check as
      // `credentials`, so a check whose address depends on them binds `input.credentials`.
      // A secret value never enters the check's input; it is placed only through its handle.
      Object.fromEntries(input.credential.fields
        .filter((field) => field.secret === false)
        .map((field) => [field.id, field.value])),
    );
  }
  // ===========================================================================
  // VALIDATION-GATED CONNECT (kills the fake-connect category — L063).
  // ---------------------------------------------------------------------------
  // "Connected" (write-ready / canSend:true) is EARNED, never assumed. The
  // self-describing gate: a submission that carried ANY secret credential field
  // MUST have had a validation pass first (a stored password/token is not proof
  // it works — that is exactly what let Instagram flip to Connected instantly).
  //
  //   - verify passed          -> write-ready  (genuinely usable)
  //   - no secret collected    -> write-ready  (nothing to prove; e.g. a public
  //                               feed or a non-secret handle)
  //   - secret collected, no
  //     passing validation     -> write-stopped (SAVED but NOT usable, honest)
  //
  // The credential facts are written either way, so a later validation path
  // (an HTTP-verified token) can promote the same
  // connection to write-ready without re-collecting the secret. No service name
  // is enumerated here — the discriminant is the field's own `secret` flag.
  const collectedSecret = input.credential.fields.some((field) => field.secret === true);
  const validationPassed = Boolean(verifyRequest);
  const savedUnverified = collectedSecret && !validationPassed;

  void credentialHandle;
  await writeConnectedServiceFacts({
    connection: input.connection,
    credentialHandleRefs: Object.values(fieldSecretRefs),
    credentialFieldSecretRefs: fieldSecretRefs,
    environment,
    stateKey: savedUnverified ? 'write-stopped' : 'write-ready',
    connectedAtMs: seams.nowMs(),
  }, seams);

  return { verified: validationPassed, savedUnverified };
}

export async function connectServiceWithCredentialHandle(input: {
  connection: ServiceConnectionTarget;
  credentialHandleRef: string;
  environmentId?: string | null;
  environments?: readonly ServiceEnvironment[];
}, context?: RuntimeContext, seams: ServiceConnectionSeams = engineSeams(context)): Promise<ConnectServiceOutcome> {
  const environment = resolveConnectionEnvironment(
    input.environments ?? input.connection.environments,
    input.environmentId,
  );
  // Acquire path: the interactive process already sealed a working credential in
  // the vault and handed back only the opaque handle — the acquisition IS the
  // validation, so this connection is genuinely usable (write-ready).
  await writeConnectedServiceFacts({
    connection: input.connection,
    credentialHandleRefs: [input.credentialHandleRef],
    credentialFieldSecretRefs: {},
    environment,
    stateKey: 'write-ready',
    connectedAtMs: seams.nowMs(),
  }, seams);
  return { verified: false, savedUnverified: false };
}
