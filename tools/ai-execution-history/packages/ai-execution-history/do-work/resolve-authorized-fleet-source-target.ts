import {
  readTrustedRuntimePartition,
  sendRequestToBitfieldTarget,
  type BitfieldRuntimeContext,
} from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
  makeHashCodeHexFromBytes,
  type EngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';

type Row = Record<string, unknown>;
type Sender = (request: { target: string; payload: unknown }) => Promise<unknown>;

const PROVIDER_PROPERTY = 'prop:observed_content:source_descriptor';
const OBSERVER_CAPABILITY = 'package::file-glob-observer::capability::observe-file-glob';
const DECODER_CAPABILITY = 'package::jsonl-session-decoder::capability::decode-jsonl-session-events';
const EVIDENCE_POLICY_KIND = 'fleet-learning-source-evidence-policy/v1';
const HOLDER = 'fleet-learning:local';
const OPERATION = 'analyze-local-session';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const record = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Row : null;
const text = (value: unknown, max = 2048): string | null => typeof value === 'string'
  && value.trim() === value && value.length > 0 && value.length <= max ? value : null;
const ref = (value: unknown): string | null => {
  const candidate = text(value, 512);
  return candidate && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(candidate) && !candidate.includes('::')
    ? candidate : null;
};
const exactKeys = (value: Row, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error('The authorized local source contains an invalid value.');
  }
  return JSON.stringify(value) ?? 'null';
};
const equal = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

function bytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  const payload = record(reply)?.payload;
  if (payload !== undefined) return bytes(payload);
  throw new Error('The authorized local source owner returned no readable answer.');
}

function decodedReply(reply: unknown): Row {
  const direct = record(reply);
  if (direct && !Object.prototype.hasOwnProperty.call(direct, 'payload')) return direct;
  const parsed = record(JSON.parse(decoder.decode(bytes(reply))));
  if (!parsed) throw new Error('The authorized local source owner returned no readable answer.');
  return parsed;
}

async function current(
  partition: string,
  address: string,
  sender: Sender,
  addressMode: 'identity-text' | 'label-hash' = 'identity-text',
): Promise<EngineReadCurrentReply> {
  return decodeEngineReadCurrentReply(bytes(await sender(
    buildEngineReadCurrentRequestFromLabels(partition, address, { addressMode }),
  )));
}

function providerAddress(sourceRef: string): string {
  return `attribute_fact|${sourceRef}|${PROVIDER_PROPERTY}|type:observed_content`;
}

function permissionAddress(leaseRef: string): string {
  return `package::permission-lease::allowed-to::${encodeURIComponent(leaseRef)}`;
}

function providerRevision(row: Row, descriptor: Row): string {
  const { provider_revision: _declared, ...semanticDescriptor } = descriptor;
  return `provider-record:${makeHashCodeHexFromBytes(encoder.encode(canonical([
    row.table,
    row.property_id,
    row.subject_id,
    row.type_id,
    semanticDescriptor,
  ])))}`;
}

function safeSegments(value: unknown, label: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 32) {
    throw new Error(`${label} is invalid.`);
  }
  return value.map(segment => {
    if (typeof segment !== 'string' || !segment || segment.length > 255 || segment === '.' || segment === '..'
      || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
      throw new Error(`${label} is invalid.`);
    }
    return segment;
  });
}

function pathRule(value: unknown): Array<string | number> {
  if (!Array.isArray(value) || value.length > 16) throw new Error('The Fleet run projection is invalid.');
  return value.map(segment => {
    if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) return segment;
    if (typeof segment === 'string' && segment.length > 0 && segment.length <= 128
      && /^[A-Za-z0-9_.:-]+$/.test(segment)) return segment;
    throw new Error('The Fleet run projection is invalid.');
  });
}

function extractionRule(value: unknown): Row | string {
  if (typeof value === 'string') {
    if (!text(value, 512)) throw new Error('The Fleet run projection is invalid.');
    return value;
  }
  const rule = record(value);
  if (!rule || Object.keys(rule).some(key => !['from', 'path', 'where', 'max_chars'].includes(key))) {
    throw new Error('The Fleet run projection is invalid.');
  }
  if (!['filename_stem', 'first', 'last', 'first_where', 'last_where', 'count'].includes(String(rule.from))) {
    throw new Error('The Fleet run projection is invalid.');
  }
  const result: Row = { from: rule.from };
  if (rule.path !== undefined) result.path = pathRule(rule.path);
  if (rule.max_chars !== undefined) {
    if (!Number.isSafeInteger(rule.max_chars) || Number(rule.max_chars) < 1 || Number(rule.max_chars) > 4096) {
      throw new Error('The Fleet run projection is invalid.');
    }
    result.max_chars = rule.max_chars;
  }
  if (rule.where !== undefined) {
    const where = record(rule.where);
    if (!where || !exactKeys(where, ['path', 'equals'])) throw new Error('The Fleet run projection is invalid.');
    result.where = { path: pathRule(where.path), equals: where.equals };
  }
  return result;
}

function runProjection(value: unknown): Row {
  const projection = record(value);
  if (!projection || !exactKeys(projection, ['id_namespace', 'launcher_ref', 'agent_ref', 'extract',
    'evidence_policy_ref', 'evidence_policy_revision'])) {
    throw new Error('The Fleet run projection is invalid.');
  }
  const idNamespace = ref(projection.id_namespace);
  const launcherRef = text(projection.launcher_ref, 512);
  const agentRef = text(projection.agent_ref, 512);
  const extract = record(projection.extract);
  const evidencePolicyRef = text(projection.evidence_policy_ref, 512);
  const evidencePolicyRevision = text(projection.evidence_policy_revision, 512);
  if (!idNamespace || !launcherRef || !agentRef || !extract
    || !evidencePolicyRef || !evidencePolicyRevision
    || Object.keys(extract).some(key => !['native_id', 'started_at', 'ended_at', 'objective', 'status', 'total_units'].includes(key))
    || !extract.native_id) throw new Error('The Fleet run projection is invalid.');
  return {
    id_namespace: idNamespace,
    launcher_ref: launcherRef,
    agent_ref: agentRef,
    evidence_policy_ref: evidencePolicyRef,
    evidence_policy_revision: evidencePolicyRevision,
    extract: Object.fromEntries(Object.entries(extract).map(([key, rule]) => [key, extractionRule(rule)])),
  };
}

function evidencePolicy(value: EngineReadCurrentReply, expectedRef: string, expectedRevision: string): {
  policy: Row;
  trust: { state: 'trusted'; score: number };
  payloadHash: Uint8Array;
} {
  if (!value.found || !value.payload || !value.payloadHash) {
    throw new Error('The local session evidence policy is missing.');
  }
  let policy: Row | null = null;
  try { policy = record(JSON.parse(decoder.decode(value.payload))); } catch { /* refused below */ }
  const trust = record(policy?.trust);
  const keys = ['kind', 'policy_ref', 'policy_revision', 'state', 'source_kind', 'acquisition_action_ref',
    'observer_capability_ref', 'decoder_capability_ref', 'trust'];
  if (!policy || !exactKeys(policy, keys) || policy.kind !== EVIDENCE_POLICY_KIND
    || policy.policy_ref !== expectedRef || policy.policy_revision !== expectedRevision || policy.state !== 'active'
    || policy.source_kind !== 'local-cli-session-log' || policy.acquisition_action_ref !== 'action:scan-local-files'
    || policy.observer_capability_ref !== OBSERVER_CAPABILITY || policy.decoder_capability_ref !== DECODER_CAPABILITY
    || !trust || !exactKeys(trust, ['state', 'score']) || trust.state !== 'trusted'
    || typeof trust.score !== 'number' || !Number.isFinite(trust.score) || trust.score < 0 || trust.score > 1) {
    throw new Error('The local session evidence policy is invalid or inactive.');
  }
  return { policy, trust: { state: 'trusted', score: trust.score }, payloadHash: value.payloadHash };
}

function providerSource(currentValue: EngineReadCurrentReply, sourceRef: string): {
  descriptor: Row;
  scan: { base: string[]; sub_path?: string[]; glob: string };
  projection: Row;
  payloadHash: Uint8Array;
} {
  if (!currentValue.found || !currentValue.payload || !currentValue.payloadHash) {
    throw new Error('That local session source is not installed with a current revision.');
  }
  let row: Row | null = null;
  try { row = record(JSON.parse(decoder.decode(currentValue.payload))); } catch { /* refused below */ }
  if (!row || row.table !== 'attribute_fact' || row.property_id !== PROVIDER_PROPERTY
    || row.type_id !== 'type:observed_content' || row.subject_id !== sourceRef
    || typeof row.value_json !== 'string') throw new Error('That local session source is invalid.');
  let descriptor: Row | null = null;
  try { descriptor = record(JSON.parse(row.value_json)); } catch { /* refused below */ }
  if (!descriptor || descriptor.source_ref !== sourceRef
    || descriptor.observer_capability_ref !== OBSERVER_CAPABILITY
    || descriptor.decoder_capability_ref !== DECODER_CAPABILITY
    || descriptor.access_connection_ref !== 'connection:none') {
    throw new Error('That local session source is invalid.');
  }
  const declaredRevision = text(descriptor.provider_revision, 512);
  if (!declaredRevision || declaredRevision !== providerRevision(row, descriptor)) {
    throw new Error('That local session source revision is invalid.');
  }
  const provenance = record(descriptor.provenance);
  if (!provenance || provenance.source_kind !== 'local-cli-session-log'
    || provenance.raw_bytes_immutable !== true) throw new Error('That local session source is not private local session data.');
  const location = record(descriptor.location);
  const data = record(location?.data);
  if (!location || !data || Object.keys(location).some(key => !['kind', 'data'].includes(key))
    || (location.kind !== undefined && location.kind !== 'file-glob')
    || Object.keys(data).some(key => !['base', 'sub_path', 'glob', 'include_kinds'].includes(key))) {
    throw new Error('That local session source location is invalid.');
  }
  const base = safeSegments(data.base, 'The local source base', 1);
  const subPath = data.sub_path === undefined ? undefined : safeSegments(data.sub_path, 'The local source sub-path');
  const glob = text(data.glob, 512);
  if (base[0] !== '{home}' || !glob || glob.startsWith('/') || glob.includes('\0')
    || !Array.isArray(data.include_kinds) || !equal(data.include_kinds, ['file'])) {
    throw new Error('That local session source location is invalid.');
  }
  return {
    descriptor,
    scan: { base, ...(subPath ? { sub_path: subPath } : {}), glob },
    projection: runProjection(descriptor.fleet_run_projection),
    payloadHash: currentValue.payloadHash,
  };
}

function leaseValue(value: EngineReadCurrentReply): { lease: Row; payloadHash: Uint8Array } {
  if (!value.found || !value.payload || !value.payloadHash) {
    throw new Error('The local session analysis permission is missing.');
  }
  let lease: Row | null = null;
  try { lease = record(JSON.parse(decoder.decode(value.payload))); } catch { /* refused below */ }
  if (!lease) throw new Error('The local session analysis permission is invalid.');
  return { lease, payloadHash: value.payloadHash };
}

function expiryMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('The local session analysis permission expiry is invalid.');
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('The local session analysis permission expiry is invalid.');
  }
  return parsed;
}

function validLease(lease: Row, expected: {
  leaseRef: string;
  userRef: string;
  boundContext: Row;
}, nowMs?: number): void {
  if (lease.kind !== 'permission_lease' || lease.lease_ref !== expected.leaseRef
    || lease.subject_ref !== expected.userRef || lease.holder !== HOLDER || lease.revoked !== false
    || !Array.isArray(lease.allowed_operation_refs) || !equal(lease.allowed_operation_refs, [OPERATION])
    || !text(lease.allowed_by_decision_proof, 2048) || !equal(lease.bound_context, expected.boundContext)) {
    throw new Error('The local session analysis permission is missing, revoked, or out of scope.');
  }
  const expiry = expiryMs(lease.expires_at);
  if (expiry !== null && (nowMs === undefined || nowMs >= expiry)) {
    throw new Error('The local session analysis permission has expired.');
  }
}

function sameHash(left: Uint8Array | null | undefined, right: Uint8Array | null | undefined): boolean {
  return Boolean(left && right && left.length === right.length && left.every((value, index) => value === right[index]));
}

function base64(bytesValue: Uint8Array): string {
  let binary = '';
  for (const byte of bytesValue) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function authorizationTime(value: unknown): {
  nowMs: number;
  observationRef: string;
  observationHashBase64: string;
} {
  const time = decodedReply(value);
  const observationRef = text(time.observation_ref, 512);
  const observationHash = text(time.observation_hash, 512);
  if (!Number.isSafeInteger(time.now_ms) || Number(time.now_ms) < 0 || !observationRef || !observationHash) {
    throw new Error('Authorization time is invalid.');
  }
  let observationHashBase64: string;
  try { observationHashBase64 = base64(makeMultihashEncodedBytesFromCodeHex(observationHash)); }
  catch { throw new Error('Authorization time is invalid.'); }
  return { nowMs: Number(time.now_ms), observationRef, observationHashBase64 };
}

async function resolveAuthorizedFleetSource(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
) {
  const request = record(input);
  if (!request || Object.keys(request).some(key => !['source', 'since', 'limit'].includes(key))) {
    throw new Error('The authorized local source request is invalid.');
  }
  const source = record(request.source);
  const sourceKeys = ['kind', 'installation_ref', 'source_ref', 'user_ref', 'permission_lease_ref',
    'provider_record_ref', 'provider_revision', 'permission'];
  const permission = record(source?.permission);
  const sourceRef = ref(source?.source_ref);
  const userRef = ref(source?.user_ref);
  const leaseRef = ref(source?.permission_lease_ref);
  const providerRecordRef = text(source?.provider_record_ref, 512);
  const providerRevisionRef = text(source?.provider_revision, 512);
  if (!source || !exactKeys(source, sourceKeys) || source.kind !== 'fleet-learning-source-descriptor'
    || !sourceRef || !userRef || !leaseRef || !providerRecordRef || !providerRevisionRef
    || !permission || !exactKeys(permission, ['state', 'operations']) || permission.state !== 'active'
    || !equal(permission.operations, [OPERATION])) throw new Error('The authorized local source descriptor is invalid.');
  if (request.since !== undefined && (!text(request.since, 128) || !Number.isFinite(Date.parse(String(request.since))))) {
    throw new Error('The local session start time is invalid.');
  }
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit)
    || Number(request.limit) < 1 || Number(request.limit) > 512)) throw new Error('The local session limit is invalid.');

  const partition = readTrustedRuntimePartition(context);
  const installationRef = `installation:${partition}`;
  const exactProviderAddress = providerAddress(sourceRef);
  if (source.installation_ref !== installationRef || providerRecordRef !== exactProviderAddress) {
    throw new Error('The authorized local source belongs to a different installation or provider.');
  }
  const firstProviderCurrent = await current(partition, exactProviderAddress, sender);
  const provider = providerSource(firstProviderCurrent, sourceRef);
  if (provider.descriptor.provider_revision !== providerRevisionRef) {
    throw new Error('The authorized local source provider changed after consent.');
  }
  const boundContext = {
    installation_ref: installationRef,
    source_ref: sourceRef,
    user_ref: userRef,
    provider_record_ref: exactProviderAddress,
    provider_revision: providerRevisionRef,
  };
  const policyRef = String(provider.projection.evidence_policy_ref);
  const policyRevision = String(provider.projection.evidence_policy_revision);
  const firstPolicyCurrent = await current(partition, policyRef, sender);
  const policy = evidencePolicy(firstPolicyCurrent, policyRef, policyRevision);
  const exactPermissionAddress = permissionAddress(leaseRef);
  const firstLeaseCurrent = await current(partition, exactPermissionAddress, sender, 'label-hash');
  const firstLease = leaseValue(firstLeaseCurrent);
  const firstTime = authorizationTime(await sender({
    target: 'permission-lease.read-authorization-time',
    payload: { request_ref: `fleet-learning:resolve:${leaseRef}` },
  }));
  validLease(firstLease.lease, { leaseRef, userRef, boundContext }, firstTime.nowMs);

  const [finalProviderCurrent, finalPolicyCurrent, finalLeaseCurrent] = await Promise.all([
    current(partition, exactProviderAddress, sender),
    current(partition, policyRef, sender),
    current(partition, exactPermissionAddress, sender, 'label-hash'),
  ]);
  const finalLease = leaseValue(finalLeaseCurrent);
  if (!sameHash(firstProviderCurrent.payloadHash, finalProviderCurrent.payloadHash)
    || !sameHash(firstPolicyCurrent.payloadHash, finalPolicyCurrent.payloadHash)
    || !sameHash(firstLease.payloadHash, finalLease.payloadHash)
    || !equal(firstLease.lease, finalLease.lease)) {
    throw new Error('The local session provider, evidence policy, or permission changed during authorization.');
  }
  providerSource(finalProviderCurrent, sourceRef);
  evidencePolicy(finalPolicyCurrent, policyRef, policyRevision);
  const finalTime = authorizationTime(await sender({
    target: 'permission-lease.read-authorization-time',
    payload: { request_ref: `fleet-learning:resolve-final:${leaseRef}` },
  }));
  if (finalTime.nowMs < firstTime.nowMs) throw new Error('Authorization time moved backwards.');
  validLease(finalLease.lease, { leaseRef, userRef, boundContext }, finalTime.nowMs);

  const sourceConfig = {
    source_ref: sourceRef,
    installation_ref: installationRef,
    user_ref: userRef,
    provider_record_ref: exactProviderAddress,
    provider_revision: providerRevisionRef,
    decoder_capability_ref: DECODER_CAPABILITY,
    ...provider.projection,
    trust: policy.trust,
    permission: { state: 'active', scopes: [OPERATION] },
  };
  return {
    authorized: true,
    scan: provider.scan,
    ingest_config: {
      partition_label: partition,
      source: sourceConfig,
      ...(request.since !== undefined ? { since: request.since } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    },
    authority_preconditions: [
      { address_label: exactProviderAddress, address_mode: 'identity_text',
        expected_current: { payload_hash_base64: base64(finalProviderCurrent.payloadHash!) } },
      { address_label: policyRef, address_mode: 'identity_text',
        expected_current: { payload_hash_base64: base64(finalPolicyCurrent.payloadHash!) } },
      { address_label: exactPermissionAddress, address_mode: 'label_hash',
        expected_current: { payload_hash_base64: base64(finalLease.payloadHash) } },
      { address_label: finalTime.observationRef, address_mode: 'identity_text',
        expected_current: { payload_hash_base64: finalTime.observationHashBase64 } },
    ],
  };
}

export async function resolveAuthorizedFleetSourceTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
) {
  const authorization = await resolveAuthorizedFleetSource(input, context, sender);
  const source = record(authorization.ingest_config.source);
  return {
    authorized: true,
    source_ref: source?.source_ref,
    provider_revision: source?.provider_revision,
  };
}

function runAddressToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

type SourceRevision = {
  observedModifiedUnixNanos: bigint;
  artifactSetSha256: string;
};

function validateAuthorizedRunPayload(payload: Row, source: Row, addressLabel: string): SourceRevision {
  const allowedKeys = ['kind', 'id', 'label', 'agent_ref', 'started_at', 'ended_at', 'status', 'objective',
    'launch', 'cost', 'metrics', 'trust', 'correlation_refs', 'provenance'];
  if (Object.keys(payload).some(key => !allowedKeys.includes(key)) || payload.kind !== 'ai-execution-run') {
    throw new Error('The authorized Fleet run payload is invalid.');
  }
  const launch = record(payload.launch);
  const provenance = record(payload.provenance);
  const objective = payload.objective === undefined ? null : record(payload.objective);
  const cost = payload.cost === undefined ? null : record(payload.cost);
  const metrics = payload.metrics === undefined ? null : record(payload.metrics);
  const nativeSessionRef = text(launch?.native_session_ref, 512);
  const idNamespace = ref(source.id_namespace);
  const stableId = idNamespace && nativeSessionRef ? `${idNamespace}:${nativeSessionRef}` : null;
  const sourceRevision = record(provenance?.source_revision);
  const observedModifiedUnixNanos = text(sourceRevision?.observed_modified_unix_nanos, 32);
  const artifactSetSha256 = text(sourceRevision?.artifact_set_sha256, 64);
  const provenanceKeys = ['producer_ref', 'decoder_capability_ref', 'source_evidence_policy_ref',
    'source_evidence_policy_revision', 'source_ref', 'source_artifact_count', 'source_permission_state',
    'source_revision', 'installation_ref', 'user_ref', 'ingested_at'];
  if (!launch || !exactKeys(launch, ['launcher_ref', 'native_session_ref']) || !provenance
    || !exactKeys(provenance, provenanceKeys) || !stableId || payload.id !== `ai-execution-run:${stableId}`
    || addressLabel !== `package::ai-execution-history::run::${runAddressToken(stableId)}`
    || !text(payload.label, 512)
    || launch.launcher_ref !== source.launcher_ref
    || (source.agent_ref !== undefined && payload.agent_ref !== source.agent_ref)
    || provenance.producer_ref !== 'capability:ingest-session-artifacts'
    || provenance.decoder_capability_ref !== source.decoder_capability_ref
    || provenance.source_evidence_policy_ref !== source.evidence_policy_ref
    || provenance.source_evidence_policy_revision !== source.evidence_policy_revision
    || provenance.source_ref !== source.source_ref
    || provenance.source_permission_state !== 'active'
    || provenance.installation_ref !== source.installation_ref
    || provenance.user_ref !== source.user_ref
    || !Number.isSafeInteger(provenance.source_artifact_count) || Number(provenance.source_artifact_count) < 1
    || !sourceRevision || !exactKeys(sourceRevision,
      ['scheme', 'observed_modified_unix_nanos', 'artifact_set_sha256'])
    || sourceRevision.scheme !== 'acquired-session-artifacts-v1'
    || !observedModifiedUnixNanos || !/^\d{1,20}$/.test(observedModifiedUnixNanos)
    || !artifactSetSha256 || !/^[0-9a-f]{64}$/.test(artifactSetSha256)
    || !text(provenance.ingested_at, 128) || !Number.isFinite(Date.parse(String(provenance.ingested_at)))
    || (payload.objective !== undefined && (!objective || !exactKeys(objective, ['snapshot_text'])
      || !text(objective.snapshot_text, 240)))
    || (payload.cost !== undefined && (!cost || !exactKeys(cost, ['total_units'])
      || !Number.isSafeInteger(cost.total_units) || Number(cost.total_units) < 0))
    || (payload.metrics !== undefined && (!metrics || Object.values(metrics)
      .some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)))
    || (payload.correlation_refs !== undefined && !equal(payload.correlation_refs, source.correlation_refs))
    || !equal(payload.trust, source.trust)) {
    throw new Error('The authorized Fleet run does not match its current source evidence.');
  }
  const observed = BigInt(observedModifiedUnixNanos);
  if (observed < 0n || BigInt(Date.parse(String(provenance.ingested_at))) !== observed / 1_000_000n) {
    throw new Error('The authorized Fleet run source revision is invalid.');
  }
  return { observedModifiedUnixNanos: observed, artifactSetSha256 };
}

function currentRunPayload(value: EngineReadCurrentReply): Row | null {
  if (!value.found) return null;
  if (!value.payload || !value.payloadHash) throw new Error('The current Fleet run has no atomic basis.');
  let payload: Row | null = null;
  try { payload = record(JSON.parse(decoder.decode(value.payload))); } catch { /* refused below */ }
  if (!payload) throw new Error('The current Fleet run is invalid.');
  return payload;
}

export async function writeAuthorizedFleetExecutionRunRecordTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
) {
  const request = record(input);
  if (!request || Object.keys(request).some(key => !['source', 'since', 'limit'].includes(key))) {
    throw new Error('The authorized Fleet ingestion request is invalid.');
  }
  const partition = readTrustedRuntimePartition(context);
  const initialAuthorization = await resolveAuthorizedFleetSource({
    source: request.source,
    ...(request.since !== undefined ? { since: request.since } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  }, context, sender);
  const scan = record(initialAuthorization.scan);
  if (!scan) throw new Error('The authorized local source scan is invalid.');
  const scanReply = decodedReply(await sender({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition', definition_id: 'action:scan-local-files',
      include_steps: false, include_output: true,
      input: { ...scan, include_bytes: true, limit: 512, max_total_bytes: 134217728, max_entries: 1000000 },
    },
  }));
  if (scanReply.status !== undefined && scanReply.status !== 'completed') {
    throw new Error('The authorized local source acquisition did not complete.');
  }
  const acquisition = record(scanReply.output) ?? scanReply;
  const acquiredFiles = acquisition && Array.isArray(acquisition.files) ? acquisition.files : null;
  if (!acquisition || !acquiredFiles || acquiredFiles.length > 512 || acquiredFiles.some(value => {
    const file = record(value);
    return !file || !text(file.path, 4096) || typeof file.bytes_base64 !== 'string'
      || file.bytes_base64.length > 179000000 || !Number.isSafeInteger(file.byte_length)
      || Number(file.byte_length) < 0 || typeof file.modified_unix_nanos !== 'number'
      || !Number.isFinite(file.modified_unix_nanos) || !Number.isInteger(file.modified_unix_nanos)
      || Number(file.modified_unix_nanos) < 0;
  })) throw new Error('The authorized local source acquisition is invalid.');
  const acquisitionRevision = makeHashCodeHexFromBytes(encoder.encode(canonical(acquisition)));
  const ingestConfig = {
    ...initialAuthorization.ingest_config,
    acquisition_revision: acquisitionRevision,
  };
  const deriveReply = decodedReply(await sender({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition', definition_id: 'action:derive-acquired-fleet-execution-runs',
      include_steps: false, include_output: true,
      input: { acquisition, ingest_config: ingestConfig },
    },
  }));
  if (deriveReply.status !== undefined && deriveReply.status !== 'completed') {
    throw new Error('The authorized local session decoder did not complete.');
  }
  const derived = record(deriveReply.output) ?? deriveReply;
  if (!derived || !Array.isArray(derived.writes) || derived.writes.length > 512
    || !Array.isArray(derived.rejections) || !Number.isSafeInteger(derived.artifact_count)
    || Number(derived.artifact_count) < 0) {
    throw new Error('The authorized local session decoder returned an invalid result.');
  }
  const initialSource = record(initialAuthorization.ingest_config.source);
  if (!initialSource) throw new Error('The authorized Fleet source is invalid.');
  const candidates = derived.writes.map(value => {
    const run = record(value);
    const addressLabel = text(run?.address_label, 512);
    const payload = record(run?.payload);
    if (!run || !exactKeys(run, ['partition_label', 'address_label', 'path_labels', 'payload',
      'expected_current', 'acquisition_revision']) || run.acquisition_revision !== acquisitionRevision
      || run.partition_label !== partition || !addressLabel || !payload
      || !equal(run.path_labels, ['current-item', 'ai-execution-run-index'])
      || run.expected_current !== 'read-current') {
      throw new Error('The authorized local session decoder returned an invalid run.');
    }
    const revision = validateAuthorizedRunPayload(payload, initialSource, addressLabel);
    return { addressLabel, payload, revision };
  });
  if (new Set(candidates.map(candidate => candidate.addressLabel)).size !== candidates.length) {
    throw new Error('The authorized local session decoder returned duplicate run identities.');
  }
  const currentValues = await Promise.all(candidates.map(candidate =>
    current(partition, candidate.addressLabel, sender, 'label-hash')));
  const finalAuthorization = await resolveAuthorizedFleetSource({
    source: request.source,
    ...(request.since !== undefined ? { since: request.since } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  }, context, sender);
  const finalSource = record(finalAuthorization.ingest_config.source);
  if (!finalSource || !equal(initialSource, finalSource)) {
    throw new Error('The authorized local source changed during acquisition.');
  }
  const writes: Row[] = [];
  let replayCount = 0;
  candidates.forEach((candidate, index) => {
    validateAuthorizedRunPayload(candidate.payload, finalSource, candidate.addressLabel);
    const before = currentValues[index];
    const existing = currentRunPayload(before);
    if (existing) {
      let previousRevision: SourceRevision | null = null;
      try { previousRevision = validateAuthorizedRunPayload(existing, finalSource, candidate.addressLabel); }
      catch {
        const candidateWithoutRevision = JSON.parse(JSON.stringify(candidate.payload)) as Row;
        const priorProvenance = record(candidateWithoutRevision.provenance);
        if (priorProvenance) delete priorProvenance.source_revision;
        if (!equal(existing, candidateWithoutRevision)) {
          throw new Error('The current Fleet run has no comparable authentic source revision.');
        }
      }
      if (previousRevision) {
        if (candidate.revision.observedModifiedUnixNanos < previousRevision.observedModifiedUnixNanos) {
          throw new Error('The acquired Fleet run is older than the current source revision.');
        }
        if (candidate.revision.observedModifiedUnixNanos === previousRevision.observedModifiedUnixNanos
          && candidate.revision.artifactSetSha256 !== previousRevision.artifactSetSha256) {
          throw new Error('The acquired Fleet run conflicts with the current source revision.');
        }
        if (equal(existing, candidate.payload)) {
          replayCount += 1;
          return;
        }
        if (candidate.revision.observedModifiedUnixNanos === previousRevision.observedModifiedUnixNanos) {
          throw new Error('The decoder changed output for unchanged authentic source bytes.');
        }
      }
    }
    writes.push({ address_label: candidate.addressLabel, address_mode: 'label_hash',
      path_labels: ['current-item', 'ai-execution-run-index'], payload: candidate.payload,
      expected_current: { payload_hash_base64: before.found ? base64(before.payloadHash!) : null } });
  });
  if (writes.length === 0) return { written: 0, replay: true, replay_count: replayCount,
    artifact_count: derived.artifact_count, rejections: derived.rejections };
  const writeResult = decodedReply(await sender({
    target: 'engine.operation.label-addressed',
    payload: {
      operation_label: 'engine.operation.write-batch',
      writes,
      preconditions: finalAuthorization.authority_preconditions,
    },
  }));
  return { ...writeResult, written: writes.length, replay: false, replay_count: replayCount,
    artifact_count: derived.artifact_count, rejections: derived.rejections };
}
