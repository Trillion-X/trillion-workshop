import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

const EVENT_SCHEMA = 'conversations.inbound-production-event/v1';
const CORRELATION_KIND = 'content-distribution.postreply-correlation';
const ROUTE_KIND = 'conversations.inbound-production-route';
const ENGINE_TARGET = 'engine.operation.label-addressed';

type Json = Record<string, unknown>;
export type CurrentReader = (address: string) => Promise<Json | null>;
export type CreateOnlyClaim = (address: string, payload: Json) => Promise<void>;

const record = (value: unknown, label: string): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Json;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
};
const oneOf = (value: unknown, allowed: string[], label: string): string => {
  const selected = text(value, label);
  if (!allowed.includes(selected)) throw new TypeError(`${label} is unsupported`);
  return selected;
};

const correlationAddress = (rc: string) => `package::content-distribution::postreply-correlation::${rc}`;
const routeAddress = (channel: string, eventKind: string) => `package::conversations::inbound-production-route::${channel}::${eventKind}`;
const consentAddress = (channel: string, sender: string) => `package::content-distribution::send-consent::${channel}::${sender}`;
const claimAddress = (providerRef: string, providerEventRef: string) => (
  `package::conversations::inbound-production-claim::${encodeURIComponent(providerRef)}::${encodeURIComponent(providerEventRef)}`
);

const renderReplyBody = (template: string, values: { cta_destination: string; correlation_token: string }) => {
  const tokens = [...template.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
  if (!tokens.includes('cta_destination') || !tokens.includes('correlation_token')) {
    throw new Error('reply template must include the action destination and correlation token');
  }
  if (tokens.some(token => !['cta_destination', 'correlation_token'].includes(token))) {
    throw new Error('reply template contains an unsupported field');
  }
  return template
    .replaceAll('{cta_destination}', values.cta_destination)
    .replaceAll('{correlation_token}', values.correlation_token);
};

export async function routeInboundProductionEventWithOwners(
  input: unknown,
  readCurrent: CurrentReader,
  createOnly: CreateOnlyClaim,
) {
  const event = record(input, 'inbound event');
  if (event.schema !== EVENT_SCHEMA) throw new TypeError(`schema must equal ${EVENT_SCHEMA}`);
  const inboundEventRef = text(event.inbound_event_ref, 'inbound_event_ref');
  const providerEventRef = text(event.provider_event_ref, 'provider_event_ref');
  const providerRef = text(event.provider_ref, 'provider_ref');
  const channel = text(event.channel, 'channel');
  const eventKind = oneOf(event.event_kind, ['comment', 'dm'], 'event_kind');
  const remoteObjectId = text(event.remote_object_id, 'remote_object_id');
  const senderRef = text(event.sender_ref, 'sender_ref');
  const observedAt = text(event.observed_at, 'observed_at');
  const signals = record(event.signals, 'signals');
  const rc = text(signals.rc, 'signals.rc');

  const [correlation, route, consent] = await Promise.all([
    readCurrent(correlationAddress(rc)),
    readCurrent(routeAddress(channel, eventKind)),
    readCurrent(consentAddress(channel, senderRef)),
  ]);
  if (!correlation || correlation.kind !== CORRELATION_KIND) throw new Error('inbound correlation not found');
  if (correlation.rc !== rc || correlation.provider_ref !== providerRef || correlation.remote_object_id !== remoteObjectId) {
    throw new Error('inbound event does not match the verified publication');
  }
  if (correlation.publication_readback_verified !== true || typeof correlation.publication_readback_ref !== 'string') {
    throw new Error('publication readback is not verified');
  }
  for (const field of ['source_ref', 'source_revision_ref', 'attempt_ref', 'artifact_ref', 'artifact_revision', 'result_ref', 'job_ref', 'job_revision', 'provider_ref', 'destination_resource_ref']) {
    text(correlation[field], `correlation.${field}`);
  }
  if (!route || route.kind !== ROUTE_KIND || route.channel !== channel || route.event_kind !== eventKind) {
    throw new Error('intended inbound route not found');
  }
  const followUpActionRef = text(route.follow_up_action_ref, 'route.follow_up_action_ref');
  const followUpDefinitionRef = text(route.follow_up_definition_ref, 'route.follow_up_definition_ref');
  const followUpDefinition = await readCurrent(followUpDefinitionRef);
  if (!followUpDefinition || followUpDefinition.kind !== 'action' || followUpDefinition.id !== followUpActionRef || followUpDefinition.is_active !== true) {
    throw new Error('intended follow-up action is not installed and active');
  }
  const destinationId = text(route.destination_id, 'route.destination_id');
  const responseChannel = text(route.response_channel, 'route.response_channel');
  const destinationRef = text(route.destination_ref, 'route.destination_ref');
  const responseProviderRef = text(route.provider_ref, 'route.provider_ref');
  const serviceVendor = text(route.service_vendor, 'route.service_vendor');
  const accountLabel = text(route.account_label, 'route.account_label');
  const resourceRef = text(route.resource_ref, 'route.resource_ref');
  const destination = await readCurrent(destinationRef);
  const capabilities = Array.isArray(destination?.capabilities) ? destination.capabilities : [];
  if (!destination
    || destination.kind !== 'generic.target-record'
    || destination.role !== 'destinations'
    || destination.destination_id !== destinationId
    || responseProviderRef !== providerRef
    || destination.service_vendor !== serviceVendor
    || destination.account_label !== accountLabel
    || destination.resource_ref !== resourceRef
    || correlation.destination_resource_ref !== resourceRef
    || !capabilities.includes('conversation-message')) {
    throw new Error('the selected response destination is not installed for this exact account and resource');
  }
  const replyBodyTemplate = text(route.reply_body_template, 'route.reply_body_template');
  const ctaDestination = text(correlation.cta_destination, 'correlation.cta_destination');
  const ctaCorrelationToken = text(correlation.cta_correlation_token, 'correlation.cta_correlation_token');
  if (ctaCorrelationToken !== rc) throw new Error('CTA correlation does not match the inbound publication');
  const replyBody = renderReplyBody(replyBodyTemplate, {
    cta_destination: ctaDestination,
    correlation_token: ctaCorrelationToken,
  });
  const responseAllowed = consent?.kind === 'content-distribution.send-consent' && consent.allowed === true;
  const optOut = consent?.allowed === false;
  const claim = {
    kind: 'conversations.inbound-production-claim',
    inbound_event_ref: inboundEventRef,
    provider_event_ref: providerEventRef,
    provider_ref: providerRef,
    remote_object_id: remoteObjectId,
    rc,
    attempt_ref: correlation.attempt_ref,
    artifact_ref: correlation.artifact_ref,
    result_ref: correlation.result_ref,
    job_ref: correlation.job_ref,
    publication_readback_ref: correlation.publication_readback_ref,
    observed_at: observedAt,
    response_allowed: responseAllowed,
    opt_out: optOut,
  };
  const deduplicationClaimRef = claimAddress(providerRef, providerEventRef);
  await createOnly(deduplicationClaimRef, claim);
  return {
    accepted: true,
    duplicate: false,
    follow_up_action_ref: followUpActionRef,
    follow_up_input: {
      intent_id: `inbound-response:${encodeURIComponent(providerRef)}:${encodeURIComponent(providerEventRef)}`,
      destination_id: destinationId,
      channel: responseChannel,
      recipient: senderRef,
      body: replyBody,
      requested_at: observedAt,
      reply_to_thread_ref: inboundEventRef,
      metadata: {
        recipient: senderRef,
        body: replyBody,
        provider_ref: responseProviderRef,
        service_vendor: serviceVendor,
        account_label: accountLabel,
        resource_ref: resourceRef,
        provider_event_ref: providerEventRef,
        remote_object_id: remoteObjectId,
        rc,
        result_ref: correlation.result_ref,
        job_ref: correlation.job_ref,
        job_revision: correlation.job_revision,
      },
    },
    response_allowed: responseAllowed,
    opt_out: optOut,
    correlation,
    event,
    claim_ref: deduplicationClaimRef,
  };
}

const decode = (value: unknown): Json => {
  if (value instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(value));
  if (value && typeof value === 'object' && (value as Json).payload instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode((value as Json).payload as Uint8Array));
  }
  return record(value, 'engine reply');
};

const decodeBase64Json = (value: string): Json => {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return record(JSON.parse(new TextDecoder().decode(bytes)), 'current owner payload');
};

export async function routeInboundProductionEvent(input: unknown) {
  const readCurrent: CurrentReader = async address => {
    const reply = decode(await sendRequestToBitfieldTarget({
      target: ENGINE_TARGET,
      payload: { operation_label: 'engine.operation.read-current', address_label: address, address_mode: 'identity_text' },
    }));
    if (reply.found !== true) return null;
    if (reply.payload && typeof reply.payload === 'object') return reply.payload as Json;
    if (typeof reply.payload_base64 === 'string' && reply.payload_base64 !== '') return decodeBase64Json(reply.payload_base64);
    if (typeof reply.value_json === 'string') return JSON.parse(reply.value_json);
    throw new Error(`current owner payload missing: ${address}`);
  };
  const createOnly: CreateOnlyClaim = async (address, payload) => {
    await sendRequestToBitfieldTarget({
      target: ENGINE_TARGET,
      payload: {
        operation_label: 'engine.operation.write-batch',
        writes: [{
          address_label: address,
          address_mode: 'identity_text',
          path_labels: ['current-item', 'published-record'],
          expected_current: { payload_hash_base64: null },
          payload,
        }],
      },
    });
  };
  return routeInboundProductionEventWithOwners(input, readCurrent, createOnly);
}
