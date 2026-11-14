import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { readTrustedRuntimeEntropyHex } from '@bitfield/runtime-kit/internal/owner-surface';
import { Buffer } from 'node:buffer';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  makeHashCodeHexFromBytes,
} from '@bitfield/runtime-kit/protocol';

const MAX_TEXT = 4096;
const MAX_INPUT_BYTES = 256 * 1024;
const EXACT_REF_FIELDS = ['address', 'revision', 'object_hash'] as const;

type RecordValue = Record<string, unknown>;
type ExactRef = { address: string; revision: string; object_hash: string };
type CurrentObservation = { address: string; object_hash: string };
type Sender = typeof sendRequestToBitfieldTarget;
// The runner sends `runtime` AND `packageData`. This type named only the second,
// which is a fact about the type rather than about the producer, and reading a
// consumer's type instead of the producer is how correct targets get judged wrong.
// `runtime.ambient` is where the engine puts the facts a package may not reach for
// itself, and it is passed through opaquely here because this file reads it only
// through the kit's own readers.
type TargetContext = { packageData?: { things?: unknown[] }; runtime?: { ambient?: Record<string, unknown> } };

export class SelectedPublicationError extends Error {
  constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); }
}

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).byteLength > MAX_TEXT) {
    throw new SelectedPublicationError('INVALID_VALUE', label);
  }
  return value.trim();
}

function credentialKey(value: unknown, label: string): string {
  const key = text(value, label);
  if (key.length > 255 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new SelectedPublicationError('CREDENTIAL_KEY_INVALID', label);
  }
  return key;
}

function trustedKey(value: unknown, expectedKeyId: string, label: string): string {
  const key = text(value, label);
  const separator = key.indexOf(':');
  if (separator <= 0 || separator !== key.lastIndexOf(':')) {
    throw new SelectedPublicationError('TRUSTED_KEY_INVALID', label);
  }
  const keyId = key.slice(0, separator);
  const publicKey = key.slice(separator + 1);
  if (keyId !== expectedKeyId || !/^[0-9a-f]{64}$/i.test(publicKey)) {
    throw new SelectedPublicationError('TRUSTED_KEY_INVALID', label);
  }
  return `${keyId}:${publicKey.toLowerCase()}`;
}

function only(value: RecordValue, fields: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new SelectedPublicationError('UNTRUSTED_FIELD', label);
  }
}

function exactRef(value: unknown, label: string): ExactRef {
  if (!isRecord(value)) throw new SelectedPublicationError('EXACT_REF_REQUIRED', label);
  only(value, EXACT_REF_FIELDS, label);
  return {
    address: text(value.address, `${label}.address`),
    revision: text(value.revision, `${label}.revision`),
    object_hash: text(value.object_hash, `${label}.object_hash`),
  };
}

function identityFromRecord(value: RecordValue, label: string): ExactRef {
  return {
    address: text(value.address, `${label}.address`),
    revision: text(value.revision, `${label}.revision`),
    // Object identity is the Engine reply's CAS multihash; a payload cannot
    // truthfully self-assert the hash of bytes that contain that assertion.
    object_hash: typeof value.object_hash === 'string' ? value.object_hash : '',
  };
}

function canonicalMultihash(value: string, label: string): string {
  if (!/^1f:[0-9a-f]{64}$/i.test(value)) throw new SelectedPublicationError('MULTIHASH_INVALID', label);
  return value.toLowerCase();
}

function uuid(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw new SelectedPublicationError('PUBLICATION_REQUEST_KEY_INVALID', label);
  return result;
}

/**
 * An identity for THIS request, drawn from the entropy the runtime supplied.
 *
 * This was `crypto.randomUUID()`, which reaches past the engine for entropy the
 * runtime already draws and hands in. The build guard refuses that reach, and the
 * refusal is not bookkeeping: a target that mints its own randomness cannot be
 * replayed, so the same log produces a different key on a second run. That is
 * exactly wrong for a value whose whole job is to make a retry recognisable, and
 * this package's retry path depends on a stored key still meaning the same
 * request.
 *
 * The reader throws when the runtime supplied nothing rather than falling back to
 * a local generator, which is the point: a substituted source of entropy is
 * indistinguishable from a trusted one afterwards, so there is no safe fallback to
 * offer.
 *
 * The shape stays a UUID because the retry path validates STORED keys with the
 * same `uuid` checker, so changing the shape would reject every key already
 * written. The two reserved nibbles are set so the result is a well formed
 * randomly drawn UUID rather than something merely shaped like one.
 */
function requestScopedKey(context: TargetContext | undefined, label: string): string {
  const drawn = readTrustedRuntimeEntropyHex(context).slice(0, 32).split('');
  drawn[12] = '4';
  drawn[16] = '89ab'[parseInt(drawn[16], 16) % 4];
  const hex = drawn.join('');
  return uuid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    label,
  );
}

function sameRef(actual: ExactRef, expected: ExactRef, label: string): void {
  if (actual.address !== expected.address || actual.revision !== expected.revision || actual.object_hash !== expected.object_hash) {
    throw new SelectedPublicationError('STALE_OR_SUBSTITUTED_REF', label);
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactTargetMember(ref: ExactRef, records: ProjectionRecord[], label: string): ExactRef {
  const matches = records.flatMap((record) => record.authority.target_refs)
    .filter((candidate) => equalJson(candidate, ref));
  if (matches.length !== 1) {
    throw new SelectedPublicationError('ENTRY_PROJECTION_TARGET_INVALID', label);
  }
  return ref;
}

function descriptor(value: RecordValue, kind: string, fields: readonly string[], label: string): void {
  if (value.kind !== kind) throw new SelectedPublicationError('DESCRIPTOR_KIND_INVALID', label);
  only(value, ['kind', 'address', 'revision', 'object_hash', ...fields], label);
}

function exactRefList(value: unknown, label: string): ExactRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new SelectedPublicationError('EXACT_REF_LIST_REQUIRED', label);
  const refs = value.map((item, index) => exactRef(item, `${label}[${index}]`));
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.address}\u0000${ref.revision}\u0000${ref.object_hash}`;
    if (seen.has(key)) throw new SelectedPublicationError('DUPLICATE_ROOT_REF', label);
    seen.add(key);
  }
  return refs.sort((a, b) => `${a.address}\u0000${a.revision}\u0000${a.object_hash}`.localeCompare(`${b.address}\u0000${b.revision}\u0000${b.object_hash}`));
}

function exactRefArray(value: unknown, label: string, maximum = 256): ExactRef[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new SelectedPublicationError('EXACT_REF_ARRAY_REQUIRED', label);
  }
  const refs = value.map((item, index) => exactRef(item, `${label}[${index}]`));
  const identities = refs.map((ref) => JSON.stringify(ref));
  if (new Set(identities).size !== identities.length) {
    throw new SelectedPublicationError('DUPLICATE_EXACT_REF', label);
  }
  return refs;
}

function safePath(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new SelectedPublicationError('PROJECTION_PATH_INVALID', label);
  }
  return value.map((segment, index) => {
    const result = text(segment, `${label}[${index}]`);
    if (result === '.' || result === '..' || result.includes('/') || result.includes('\\') || result.includes('\0')) {
      throw new SelectedPublicationError('PROJECTION_PATH_INVALID', `${label}[${index}]`);
    }
    return result;
  });
}

function canonicalInlineBytes(value: unknown, label: string): { encoded: string; bytes: Uint8Array } {
  const encoded = text(value, label);
  if (encoded.length > MAX_INPUT_BYTES * 8) throw new SelectedPublicationError('PROJECTION_BYTES_TOO_LARGE', label);
  const decoded = Uint8Array.from(Buffer.from(encoded, 'base64'));
  if (Buffer.from(decoded).toString('base64') !== encoded) {
    throw new SelectedPublicationError('PROJECTION_BYTES_INVALID', label);
  }
  return { encoded, bytes: decoded };
}

type ProjectionFile = {
  path: string[];
  source: { kind: 'blob_ref'; hash: string } | { kind: 'inline'; bytes: string };
  integrity_hash: string;
  executable: boolean;
};

type ProjectionRecord = ExactRef & {
  kind_ref: string;
  dependency_refs: ExactRef[];
  projection_files: ProjectionFile[];
  browser_import_bindings: Array<{ specifier: string; path: string[] }>;
  authority: {
    data_refs: ExactRef[];
    subscription_refs: ExactRef[];
    target_refs: ExactRef[];
    navigation_refs: ExactRef[];
  };
  cycle_semantics_ref?: string;
};

function projectionFile(value: unknown, label: string): ProjectionFile {
  if (!isRecord(value)) throw new SelectedPublicationError('PROJECTION_FILE_INVALID', label);
  only(value, ['path', 'source', 'integrity_hash', 'executable'], label);
  if (!isRecord(value.source)) throw new SelectedPublicationError('PROJECTION_SOURCE_INVALID', `${label}.source`);
  const integrity_hash = canonicalMultihash(text(value.integrity_hash, `${label}.integrity_hash`), `${label}.integrity_hash`);
  let source: ProjectionFile['source'];
  if (value.source.kind === 'blob_ref') {
    only(value.source, ['kind', 'hash'], `${label}.source`);
    const hash = canonicalMultihash(text(value.source.hash, `${label}.source.hash`), `${label}.source.hash`);
    if (hash !== integrity_hash) throw new SelectedPublicationError('PROJECTION_SOURCE_HASH_MISMATCH', label);
    source = { kind: 'blob_ref', hash };
  } else if (value.source.kind === 'inline') {
    only(value.source, ['kind', 'bytes'], `${label}.source`);
    const inline = canonicalInlineBytes(value.source.bytes, `${label}.source.bytes`);
    if (makeHashCodeHexFromBytes(inline.bytes) !== integrity_hash) {
      throw new SelectedPublicationError('PROJECTION_SOURCE_HASH_MISMATCH', label);
    }
    source = { kind: 'inline', bytes: inline.encoded };
  } else {
    throw new SelectedPublicationError('PROJECTION_SOURCE_INVALID', `${label}.source.kind`);
  }
  return {
    path: safePath(value.path, `${label}.path`),
    source,
    integrity_hash,
    executable: value.executable === true,
  };
}

function projectionRecord(value: unknown, index: number): ProjectionRecord {
  const label = `materializer.records[${index}]`;
  if (!isRecord(value)) throw new SelectedPublicationError('PROJECTION_RECORD_INVALID', label);
  only(value, [
    'address', 'revision', 'object_hash', 'kind_ref', 'dependency_refs',
    'projection_files', 'browser_import_bindings', 'authority', 'cycle_semantics_ref',
  ], label);
  if (!Array.isArray(value.projection_files) || value.projection_files.length > 128) {
    throw new SelectedPublicationError('PROJECTION_FILES_INVALID', `${label}.projection_files`);
  }
  if (!Array.isArray(value.browser_import_bindings) || value.browser_import_bindings.length > 128) {
    throw new SelectedPublicationError('BROWSER_IMPORT_BINDINGS_INVALID', `${label}.browser_import_bindings`);
  }
  if (!isRecord(value.authority)) throw new SelectedPublicationError('PROJECTION_AUTHORITY_INVALID', `${label}.authority`);
  only(value.authority, ['data_refs', 'subscription_refs', 'target_refs', 'navigation_refs'], `${label}.authority`);
  const record: ProjectionRecord = {
    address: text(value.address, `${label}.address`),
    revision: text(value.revision, `${label}.revision`),
    object_hash: canonicalMultihash(text(value.object_hash, `${label}.object_hash`), `${label}.object_hash`),
    kind_ref: text(value.kind_ref, `${label}.kind_ref`),
    dependency_refs: exactRefArray(value.dependency_refs, `${label}.dependency_refs`),
    projection_files: value.projection_files.map((file, fileIndex) => projectionFile(file, `${label}.projection_files[${fileIndex}]`)),
    browser_import_bindings: value.browser_import_bindings.map((binding, bindingIndex) => {
      const bindingLabel = `${label}.browser_import_bindings[${bindingIndex}]`;
      if (!isRecord(binding)) throw new SelectedPublicationError('BROWSER_IMPORT_BINDING_INVALID', bindingLabel);
      only(binding, ['specifier', 'path'], bindingLabel);
      const specifier = text(binding.specifier, `${bindingLabel}.specifier`);
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes('\\') || specifier.includes('\0')) {
        throw new SelectedPublicationError('BROWSER_IMPORT_BINDING_INVALID', `${bindingLabel}.specifier`);
      }
      return { specifier, path: safePath(binding.path, `${bindingLabel}.path`) };
    }),
    authority: {
      data_refs: exactRefArray(value.authority.data_refs, `${label}.authority.data_refs`),
      subscription_refs: exactRefArray(value.authority.subscription_refs, `${label}.authority.subscription_refs`),
      target_refs: exactRefArray(value.authority.target_refs, `${label}.authority.target_refs`),
      navigation_refs: exactRefArray(value.authority.navigation_refs, `${label}.authority.navigation_refs`),
    },
  };
  if (value.cycle_semantics_ref !== undefined) {
    record.cycle_semantics_ref = text(value.cycle_semantics_ref, `${label}.cycle_semantics_ref`);
  }
  return record;
}

function projectionPayload(record: ProjectionRecord): RecordValue {
  return {
    kind_ref: record.kind_ref,
    dependency_refs: record.dependency_refs,
    projection_files: record.projection_files,
    browser_import_bindings: record.browser_import_bindings,
    authority: record.authority,
    ...(record.cycle_semantics_ref ? { cycle_semantics_ref: record.cycle_semantics_ref } : {}),
  };
}

function sourceObservations(value: unknown, label: string): Array<{ address: string; object_hash: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new SelectedPublicationError('SOURCE_OBSERVATIONS_INVALID', label);
  }
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!isRecord(item)) throw new SelectedPublicationError('SOURCE_OBSERVATION_INVALID', itemLabel);
    only(item, ['address', 'object_hash'], itemLabel);
    return {
      address: text(item.address, `${itemLabel}.address`),
      object_hash: canonicalMultihash(text(item.object_hash, `${itemLabel}.object_hash`), `${itemLabel}.object_hash`),
    };
  });
}

function opaqueMaterializerInput(value: unknown): RecordValue {
  if (!isRecord(value)) throw new SelectedPublicationError('MATERIALIZER_INPUT_INVALID', 'selection_materializer_input');
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_INPUT_BYTES) {
    throw new SelectedPublicationError('MATERIALIZER_INPUT_TOO_LARGE', 'selection_materializer_input');
  }
  return value;
}

function materializationProcessRecords(records: ProjectionRecord[]): { records: RecordValue[]; inputs: RecordValue[] } {
  const inputs: RecordValue[] = [];
  const mountedRecords = records.map((record, recordIndex) => ({
    ...record,
    projection_files: record.projection_files.map((file, fileIndex) => {
      const mount_path = `selected-projection-input-${recordIndex}-${fileIndex}`;
      inputs.push({
        mount_path,
        content_type: 'application/octet-stream',
        source: file.source,
      });
      return {
        path: file.path,
        mounted_path: mount_path,
        integrity_hash: file.integrity_hash,
        executable: file.executable,
      };
    }),
  }));
  return { records: mountedRecords, inputs };
}

function boundedOfferDraft(value: unknown): RecordValue {
  if (!isRecord(value)) throw new SelectedPublicationError('NEW_OFFER_INVALID', 'new_offer');
  only(value, ['label', 'summary', 'price_options'], 'new_offer');
  const label = text(value.label, 'new_offer.label');
  const summary = text(value.summary, 'new_offer.summary');
  if (label.length > 240 || summary.length > 2048 || !Array.isArray(value.price_options) || value.price_options.length === 0 || value.price_options.length > 16) {
    throw new SelectedPublicationError('NEW_OFFER_INVALID', 'new_offer.price_options');
  }
  const price_options = value.price_options.map((option, index) => {
    if (!isRecord(option)) {
      throw new SelectedPublicationError('NEW_OFFER_INVALID', `new_offer.price_options[${index}]`);
    }
    only(option, ['id', 'label', 'amount_cents', 'currency', 'payment_timing'], `new_offer.price_options[${index}]`);
    const id = text(option.id, `new_offer.price_options[${index}].id`);
    const optionLabel = text(option.label, `new_offer.price_options[${index}].label`);
    const currency = text(option.currency, `new_offer.price_options[${index}].currency`).toLowerCase();
    const payment_timing = text(option.payment_timing, `new_offer.price_options[${index}].payment_timing`);
    const amount_cents = option.amount_cents;
    if (id.length > 240 || optionLabel.length > 240 || currency.length !== 3
      || payment_timing.length > 120 || typeof amount_cents !== 'number'
      || !Number.isSafeInteger(amount_cents) || amount_cents < 0) {
      throw new SelectedPublicationError('NEW_OFFER_INVALID', `new_offer.price_options[${index}]`);
    }
    return { id, label: optionLabel, amount_cents, currency, payment_timing };
  });
  return { label, summary, price_options };
}

function readRecordReply(reply: unknown, label: string): { value: RecordValue; object_hash: string } {
  const decoded = decodeEngineReadCurrentReply(payloadFromReply(reply));
  if (!decoded.found || !decoded.payload || !decoded.contentHash) throw new SelectedPublicationError('CANONICAL_RECORD_MISSING', label);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded.payload)); }
  catch { throw new SelectedPublicationError('CANONICAL_RECORD_INVALID', label); }
  if (!isRecord(value)) throw new SelectedPublicationError('CANONICAL_RECORD_INVALID', label);
  return { value, object_hash: canonicalMultihash(decoded.contentHash, `${label}.content_hash`) };
}

function trustedPartition(context: TargetContext | undefined): string {
  const things = context?.packageData?.things;
  if (!Array.isArray(things)) throw new SelectedPublicationError('OWNER_BINDING_MISSING', 'publication-owner-binding');
  const source = things.find((thing) => isRecord(thing) && Array.isArray(thing.path)
    && thing.path.at(-1) === 'publication-owner-binding') as RecordValue | undefined;
  const encoded = source?.payload_base64;
  if (typeof encoded !== 'string' || !encoded) throw new SelectedPublicationError('OWNER_BINDING_MISSING', 'publication-owner-binding');
  let binding: unknown;
  try { binding = JSON.parse(new TextDecoder().decode(Uint8Array.from(Buffer.from(encoded, 'base64')))); }
  catch { throw new SelectedPublicationError('OWNER_BINDING_INVALID', 'publication-owner-binding'); }
  if (!isRecord(binding)) throw new SelectedPublicationError('OWNER_BINDING_INVALID', 'publication-owner-binding');
  return text(binding.partition_label, 'publication-owner-binding.partition_label');
}

function boundedRequest(value: unknown, fields: readonly string[]): RecordValue {
  if (!isRecord(value)) throw new SelectedPublicationError('REQUEST_INVALID', 'request must be an object');
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_INPUT_BYTES) {
    throw new SelectedPublicationError('REQUEST_TOO_LARGE', 'request');
  }
  only(value, fields, 'request');
  return value;
}

function payloadFromReply(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (isRecord(reply) && reply.payload instanceof Uint8Array) return reply.payload;
  throw new SelectedPublicationError('OWNER_READ_FAILED', 'engine reply lacks bytes');
}

async function readExact(partition: string, ref: ExactRef, sender: Sender): Promise<RecordValue> {
  canonicalMultihash(ref.object_hash, `${ref.address}.object_hash`);
  const reply = decodeEngineReadCurrentReply(payloadFromReply(await sender(
    buildEngineReadCurrentRequestFromLabels(partition, ref.address),
  )));
  if (!reply.found || !reply.payload) throw new SelectedPublicationError('CANONICAL_RECORD_MISSING', ref.address);
  let record: unknown;
  try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.payload)); }
  catch { throw new SelectedPublicationError('CANONICAL_RECORD_INVALID', ref.address); }
  if (!isRecord(record)) throw new SelectedPublicationError('CANONICAL_RECORD_INVALID', ref.address);
  const identity = identityFromRecord(record, `record:${ref.address}`);
  if (identity.address !== ref.address || identity.revision !== ref.revision) throw new SelectedPublicationError('STALE_OR_SUBSTITUTED_REF', `record:${ref.address}`);
  if (!reply.contentHash || canonicalMultihash(reply.contentHash, `record:${ref.address}.content_hash`) !== canonicalMultihash(ref.object_hash, `${ref.address}.object_hash`)) {
    throw new SelectedPublicationError('STALE_OR_SUBSTITUTED_REF', `record:${ref.address}.content_hash`);
  }
  return record;
}

async function readCurrentObservation(partition: string, address: unknown, label: string, sender: Sender): Promise<{ observation: CurrentObservation; value: RecordValue }> {
  const addressLabel = text(address, label);
  const reply = readRecordReply(await sender(buildEngineReadCurrentRequestFromLabels(partition, addressLabel)), label);
  return {
    observation: { address: addressLabel, object_hash: reply.object_hash },
    value: reply.value,
  };
}

async function readCurrentExact(partition: string, address: unknown, label: string, sender: Sender): Promise<{ ref: ExactRef; value: RecordValue }> {
  const current = await readCurrentObservation(partition, address, label, sender);
  const addressLabel = current.observation.address;
  const ref = identityFromRecord(current.value, label);
  if (ref.address !== addressLabel || !ref.revision) throw new SelectedPublicationError('CANONICAL_RECORD_INVALID', label);
  return { ref: { ...ref, object_hash: current.observation.object_hash }, value: current.value };
}

function nestedRef(record: RecordValue, field: string): ExactRef {
  return exactRef(record[field], field);
}

function deploymentRequest(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new SelectedPublicationError('DEPLOYMENT_REQUEST_INVALID', label);
  only(value, ['kind', 'schema', 'address', 'revision', 'object_hash', 'profile', 'parameters'], label);
  if (value.kind !== 'package-owned-deployment-request'
    || value.schema !== 'hosted-public-app.deployment-request/v2'
    || !isRecord(value.parameters)) {
    throw new SelectedPublicationError('DEPLOYMENT_REQUEST_INVALID', label);
  }
  const entries = Object.entries(value.parameters);
  if (entries.length > 16) throw new SelectedPublicationError('DEPLOYMENT_REQUEST_INVALID', `${label}.parameters`);
  const parameters = Object.fromEntries(entries.map(([key, parameterValue]) => [
    text(key, `${label}.parameters.key`),
    text(parameterValue, `${label}.parameters.${key}`),
  ]));
  return {
    kind: 'package-owned-deployment-request',
    schema: 'hosted-public-app.deployment-request/v2',
    profile: text(value.profile, `${label}.profile`),
    parameters,
  };
}

function publicationDeploymentProcess(request: RecordValue): RecordValue {
  return {
    argv: ['node', 'run-provider-deploy.mjs', '--request', JSON.stringify(request), '--site-root', 'site'],
    cwd: null,
    timeout_ms: 300_000,
    termination_grace_ms: 1_000,
    expected_termination: { kind: 'exited', code: 0 },
    env: {},
    inputs: [],
    input_trees: [],
    outputs: [{
      mount_path: 'deployment-result.json',
      content_type: 'application/json',
      storage: 'immutable_content',
    }],
    containment: { kind: 'descendant_effect_contained', pipe_eof_timeout_ms: 1_000, publications: [] },
    capture_fds: [2],
    collected_files: [],
  };
}

function publicationMaterializationProcess(closure: RecordValue): RecordValue {
  return {
    argv: [
      text(closure.binary, 'dependency.closure.binary'),
      'apply-from-source-archive-tree',
      '--source-archive', 'selected-source-archive.json',
      '--signed-closure-file', 'hosted-projection.signed-closure.json',
      '--trusted-key', trustedKey(
        closure.trusted_key,
        text(closure.key_id, 'dependency.closure.key_id'),
        'dependency.closure.trusted_key',
      ),
      '--signature-threshold', '1',
      '--projection-root', 'site',
      '--current-state-basis', 'current-state-basis.json',
      '--proof-output', 'apply-proof.json',
    ],
    cwd: null,
    timeout_ms: 300_000,
    termination_grace_ms: 1_000,
    expected_termination: { kind: 'exited', code: 0 },
    env: {},
    inputs: [],
    input_trees: [],
    outputs: [{
      mount_path: 'apply-proof.json',
      content_type: 'application/json',
      storage: 'inline',
    }],
    containment: { kind: 'leaf' },
    capture_fds: [1, 2],
    collected_files: [],
  };
}

/** Checkout owns offer vocabulary.  HPA only exact-reads and binds a canonical
 * offer to the selected intent; it never accepts seller-authored price JSON. */
function checkoutOffer(value: RecordValue, accessRef: string, route: string): RecordValue {
  descriptor(value, 'commercial-offer', ['id', 'label', 'summary', 'access_refs', 'post_purchase_route_path', 'price_options', 'sort_order'], 'offer_descriptor');
  const access_refs = Array.isArray(value.access_refs) ? value.access_refs.map((item, index) => text(item, `offer_descriptor.access_refs[${index}]`)) : [];
  if (access_refs.length !== 1 || access_refs[0] !== accessRef) throw new SelectedPublicationError('OFFER_ACCESS_SCOPE_INVALID', 'offer_descriptor.access_refs');
  const price_options = Array.isArray(value.price_options) ? value.price_options : [];
  if (!price_options.length || price_options.some((option) => !isRecord(option))) throw new SelectedPublicationError('OFFER_PRICE_OPTIONS_INVALID', 'offer_descriptor.price_options');
  return {
    kind: 'commercial-offer', id: text(value.id, 'offer_descriptor.id'), label: text(value.label, 'offer_descriptor.label'),
    summary: text(value.summary, 'offer_descriptor.summary'), access_refs: [accessRef],
    post_purchase_route_path: route, price_options, sort_order: typeof value.sort_order === 'number' && Number.isFinite(value.sort_order) ? value.sort_order : 0,
  };
}

/** Owner-only resolver. Browser data supplies no process/root/descriptor values. */
export async function resolveSelectedPublicationRequestTarget(input: unknown, context?: TargetContext, sender: Sender = sendRequestToBitfieldTarget): Promise<RecordValue> {
  const partition = trustedPartition(context);
  const request = boundedRequest(input, ['intent_ref', 'request_id', 'publication_request_ref']);
  const intentRef = exactRef(request.intent_ref, 'intent_ref');
  const requestId = text(request.request_id, 'request_id');
  const publicationRequestRef = exactRef(request.publication_request_ref, 'publication_request_ref');
  const publicationRequest = await readExact(partition, publicationRequestRef, sender);
  sameRef(nestedRef(publicationRequest, 'intent_ref'), intentRef, 'publication_request.intent_ref');
  if (uuid(publicationRequest.publication_request_key, 'publication_request.publication_request_key') !== requestId) {
    throw new SelectedPublicationError('PUBLICATION_REQUEST_CONFLICT', 'publication_request_key');
  }
  const intent = await readExact(partition, intentRef, sender);
  const selectionRef = nestedRef(intent, 'selection_ref');
  const selection = await readExact(partition, selectionRef, sender);
  const dependency = await readExact(partition, nestedRef(intent, 'dependency_ref'), sender);
  const materializerRef = nestedRef(dependency, 'materializer_ref');
  const policyRef = nestedRef(intent, 'access_policy_ref');
  const policy = await readExact(partition, policyRef, sender);
  const executionDescriptorRef = nestedRef(policy, 'execution_descriptor_ref');
  const executionDescriptor = await readExact(partition, executionDescriptorRef, sender);
  descriptor(executionDescriptor, 'selected-experience-publication-execution/v1', ['definition_id', 'definition_refs'], 'execution_descriptor');
  const definition_id = text(executionDescriptor.definition_id, 'execution_descriptor.definition_id');
  const definition_refs = Array.isArray(executionDescriptor.definition_refs)
    ? executionDescriptor.definition_refs.map((value, index) => text(value, `execution_descriptor.definition_refs[${index}]`))
    : [];
  if (!definition_refs.includes(definition_id)) throw new SelectedPublicationError('EXECUTION_DEFINITION_UNADMITTED', 'execution_descriptor.definition_id');

  const closure = isRecord(dependency.closure) ? dependency.closure : null;
  if (!closure) throw new SelectedPublicationError('DEPENDENCY_INVALID', 'closure');
  const deployment_request_ref = nestedRef(dependency, 'deployment_request_ref');
  const resolvedDeploymentRequest = deploymentRequest(
    await readExact(partition, deployment_request_ref, sender),
    'dependency.deployment_request',
  );
  const publication_process_steps = [
    {
      name: 'materialize',
      process: publicationMaterializationProcess(closure),
      workspace_bindings: { environment: [] },
      predecessor_outputs: [],
    },
    {
      name: 'deploy',
      process: publicationDeploymentProcess(resolvedDeploymentRequest),
      workspace_bindings: { environment: [] },
      predecessor_outputs: [],
    },
  ];
  for (const key of ['binary', 'key_id']) text(closure[key], `dependency.closure.${key}`);
  credentialKey(closure.credential_key, 'dependency.closure.credential_key');
  const publication = isRecord(intent.publication) ? intent.publication : null;
  if (!publication) throw new SelectedPublicationError('CANONICAL_PUBLICATION_INVALID', 'intent.publication');
  const publicationAddress = text(publication.address, 'intent.publication.address');
  const publicationRevision = text(publication.revision, 'intent.publication.revision');
  const accessRef = text(intent.access_ref, 'intent.access_ref');
  const rootRefs = Array.isArray(intent.root_refs) ? intent.root_refs.map((value, index) => exactRef(value, `intent.root_refs[${index}]`)) : null;
  if (!rootRefs?.length) throw new SelectedPublicationError('CANONICAL_PUBLICATION_INVALID', 'intent.root_refs');
  const entry_byte_path = safePath(intent.entry_byte_path, 'intent.entry_byte_path');
  if (!Array.isArray(selection.records) || selection.records.length === 0 || selection.records.length > 256) {
    throw new SelectedPublicationError('CANONICAL_PUBLICATION_INVALID', 'selection.records');
  }
  const projectionRecords = selection.records.map((record, index) => projectionRecord(record, index));
  const entryProjectionTargetRef = intent.entry_projection_target_ref === undefined
    ? undefined
    : exactTargetMember(
      exactRef(intent.entry_projection_target_ref, 'intent.entry_projection_target_ref'),
      projectionRecords,
      'intent.entry_projection_target_ref',
    );
  for (const root of rootRefs) {
    if (!projectionRecords.some((record) => equalJson(
      { address: record.address, revision: record.revision, object_hash: record.object_hash },
      root,
    ))) throw new SelectedPublicationError('CANONICAL_PUBLICATION_INVALID', `missing root record:${root.address}`);
  }
  const processProjection = materializationProcessRecords(projectionRecords);
  const resolvedPublication = {
    address: publicationAddress,
    revision: publicationRevision,
    access_ref: accessRef,
    root_refs: rootRefs,
    ...(entryProjectionTargetRef ? { entry_projection_target_ref: entryProjectionTargetRef } : {}),
    authority_manifest_address: `${publicationAddress}::authority-manifest`,
    sealed_closure_address: `${publicationAddress}::sealed-closure`,
    apply_proof_address: `${publicationAddress}::apply-proof`,
    policy_binding_address: `${publicationAddress}::policy-binding`,
    offer_address: `${publicationAddress}::offer`,
    route_address: `${publicationAddress}::route`,
    state_address: `${publicationAddress}::state`,
  };

  const persistedOffer = intent.offer_descriptor_ref === undefined ? null : exactRef(intent.offer_descriptor_ref, 'intent.offer_descriptor_ref');
  const postPurchase = intent.post_purchase_destination_ref === undefined ? null : await readExact(partition, nestedRef(intent, 'post_purchase_destination_ref'), sender);
  const route = postPurchase ? text(postPurchase.post_purchase_route_path, 'post_purchase_destination.post_purchase_route_path') : null;
  const commercialOffer = persistedOffer
    ? checkoutOffer(await readExact(partition, persistedOffer, sender), accessRef, route!)
    : (isRecord(intent.new_offer) ? intent.new_offer : null);
  const closureKeyId = text(closure.key_id, 'closure.key_id');
  return {
    request_id: requestId,
    publication_request_ref: publicationRequestRef,
    intent_ref: intentRef,
    publication_destination_ref: nestedRef(intent, 'publication_destination_ref'),
    access_policy_ref: policyRef,
    execution: { definition_id, definition_refs, offer_required: policy.offer_required === true },
    closure: {
      binary: text(closure.binary, 'closure.binary'),
      credential_key: credentialKey(closure.credential_key, 'closure.credential_key'),
      key_id: closureKeyId,
      trusted_key: trustedKey(closure.trusted_key, closureKeyId, 'closure.trusted_key'),
    },
    publication: resolvedPublication,
    publication_commit_input: {
      schema: 'hosted-experience-publication-commit-input/v1',
      request_id: requestId,
      intent_ref: intentRef,
      access_policy_ref: policyRef,
      publication: resolvedPublication,
    },
    reachability_records: {
      policy_binding: {
        kind: 'published-experience-policy-binding/v1', publication_request_key: requestId,
        policy_ref: policyRef, access_policy: policy,
      },
      ...(commercialOffer ? { offer: commercialOffer } : {}),
      // The static capsule action consumes this separately. The deploy-backed
      // action never reads it: its route comes only from deployment-result.json.
      route: {
        kind: 'published-experience-capsule-route/v1', publication_request_key: requestId,
        intent_ref: intentRef, publication_address: publicationAddress, available: true,
      },
      state: {
        kind: 'selected-experience-publication-state/v1', publication_request_key: requestId,
        state: 'published', intent_ref: intentRef,
      },
    },
    publication_process_steps,
    deployment_request_ref,
    deployment_request: resolvedDeploymentRequest,
    projection_process_inputs: processProjection.inputs,
    materialization_input: {
      schema: 'hosted-experience-materialization-input/v1',
      intent: { ...intent, ...intentRef, entry_byte_path },
      materializer: materializerRef,
      limits: dependency.limits ?? {},
      records: processProjection.records,
    },
  };
}

/**
 * Owner-side first boundary for seller publication. It persists a canonical
 * request before publication begins, so no browser idempotency identity can
 * choose an authority, carrier, route, process, or receipt.
 */
export async function normalizeSelectedExperiencePublicationTarget(input: unknown, context?: TargetContext, sender: Sender = sendRequestToBitfieldTarget): Promise<RecordValue> {
  const partition = trustedPartition(context);
  const request = boundedRequest(input, ['selection_materializer_descriptor_address', 'selection_materializer_input', 'materialization_id', 'policy_address', 'publication_destination_address', 'offer_descriptor_address', 'new_offer', 'post_purchase_destination_address', 'publication_request_ref']);
  if (request.offer_descriptor_address !== undefined && request.new_offer !== undefined) throw new SelectedPublicationError('OFFER_INGRESS_CONFLICT', 'offer_descriptor_address/new_offer');
  const materializer = await readCurrentObservation(partition, request.selection_materializer_descriptor_address, 'selection_materializer_descriptor_address', sender);
  if (materializer.value.kind !== 'package-target-descriptor') throw new SelectedPublicationError('MATERIALIZER_DESCRIPTOR_INVALID', 'selection_materializer_descriptor_address');
  const materializerTarget = text(materializer.value.target, 'selection_materializer_descriptor.target');
  const materialization_id = uuid(request.materialization_id, 'materialization_id');
  const materializerInput = opaqueMaterializerInput(request.selection_materializer_input);
  let materialized: unknown;
  try {
    materialized = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadFromReply(await sender({
      target: materializerTarget,
      payload: { ...materializerInput, partition_label: partition, materialization_id },
    } as never))));
  }
  catch { throw new SelectedPublicationError('MATERIALIZER_RESULT_INVALID', materializerTarget); }
  if (!isRecord(materialized)) throw new SelectedPublicationError('MATERIALIZER_RESULT_INVALID', materializerTarget);
  if (materialized.schema !== 'selection-materialization-result/v1') {
    throw new SelectedPublicationError('MATERIALIZER_RESULT_INVALID', 'materializer.schema');
  }
  const root_refs = exactRefList(materialized.root_refs, 'materializer.root_refs');
  if (!Array.isArray(materialized.records) || materialized.records.length === 0 || materialized.records.length > 256) {
    throw new SelectedPublicationError('MATERIALIZER_RESULT_INVALID', 'materializer.records');
  }
  const records = materialized.records
    .map((record, index) => projectionRecord(record, index))
    .sort((left, right) => JSON.stringify([left.address, left.revision, left.object_hash])
      .localeCompare(JSON.stringify([right.address, right.revision, right.object_hash])));
  const record_refs = records.map(({ address, revision, object_hash }) => ({ address, revision, object_hash }));
  const entry_byte_path = safePath(materialized.entry_byte_path, 'materializer.entry_byte_path');
  const authority_ref = exactRef(materialized.authority_ref, 'materializer.authority_ref');
  const entry_projection_target_ref = materialized.entry_projection_target_ref === undefined
    ? undefined
    : exactTargetMember(
      exactRef(materialized.entry_projection_target_ref, 'materializer.entry_projection_target_ref'),
      records,
      'materializer.entry_projection_target_ref',
    );
  only(materialized, ['schema', 'root_refs', 'records', 'entry_byte_path', 'entry_projection_target_ref', 'authority_ref'], 'materializer.result');
  const policy = await readCurrentExact(partition, request.policy_address, 'policy_address', sender);
  const destination = await readCurrentExact(partition, request.publication_destination_address, 'publication_destination_address', sender);
  const offer = request.offer_descriptor_address === undefined ? null : await readCurrentExact(partition, request.offer_descriptor_address, 'offer_descriptor_address', sender);
  const postPurchase = request.post_purchase_destination_address === undefined ? null : await readCurrentExact(partition, request.post_purchase_destination_address, 'post_purchase_destination_address', sender);
  const normalized = {
    materializer_descriptor_observation: materializer.observation,
    policy_ref: policy.ref,
    seller_authority_ref: authority_ref,
    publication_destination_ref: destination.ref,
    offer_descriptor_ref: offer?.ref ?? null,
    new_offer: request.new_offer === undefined ? null : boundedOfferDraft(request.new_offer),
    post_purchase_destination_ref: postPurchase?.ref ?? null,
  };
  const authority = await readExact(partition, normalized.seller_authority_ref, sender);
  descriptor(policy.value, 'selected-experience-publication-policy/v1', ['access_ref', 'execution_descriptor_ref', 'offer_required'], 'policy');
  descriptor(authority, 'selection-materialization-authority/v1', ['version', 'materialization_id', 'materializer', 'root_refs', 'record_refs', 'entry_byte_path', 'source_observations'], 'materializer_authority');
  if (authority.version !== 1) throw new SelectedPublicationError('MATERIALIZER_AUTHORITY_MISMATCH', 'materializer_authority.version');
  descriptor(destination.value, 'selected-experience-publication-destination/v1', ['dependency_ref', 'execution_descriptor_ref'], 'publication_destination');
  const selected_root_refs = root_refs;
  if (text(authority.materialization_id, 'materializer_authority.materialization_id') !== materialization_id) {
    throw new SelectedPublicationError('MATERIALIZATION_ID_MISMATCH', 'materializer_authority.materialization_id');
  }
  if (text(authority.materializer, 'materializer_authority.materializer') !== materializerTarget) {
    throw new SelectedPublicationError('MATERIALIZER_AUTHORITY_MISMATCH', 'materializer_authority.materializer');
  }
  sourceObservations(authority.source_observations, 'materializer_authority.source_observations');
  const authorizedRoots = exactRefList(authority.root_refs, 'materializer_authority.root_refs');
  const authorizedRecords = exactRefList(authority.record_refs, 'materializer_authority.record_refs');
  if (!equalJson(authorizedRoots, selected_root_refs)
    || !equalJson(authorizedRecords, record_refs)
    || !equalJson(safePath(authority.entry_byte_path, 'materializer_authority.entry_byte_path'), entry_byte_path)) {
    throw new SelectedPublicationError('MATERIALIZER_AUTHORITY_MISMATCH', 'projection closure');
  }
  if (!records.some((record) => record.projection_files.some((file) => equalJson(file.path, entry_byte_path)))) {
    throw new SelectedPublicationError('MATERIALIZER_RESULT_INVALID', 'entry_byte_path is not selected');
  }
  for (const record of records) {
    const persisted = await readExact(partition, {
      address: record.address,
      revision: record.revision,
      object_hash: record.object_hash,
    }, sender);
    for (const [field, expected] of Object.entries(projectionPayload(record))) {
      if (!equalJson(persisted[field], expected)) {
        throw new SelectedPublicationError('MATERIALIZER_RECORD_MISMATCH', `${record.address}.${field}`);
      }
    }
  }
  for (const root of selected_root_refs) {
    if (!authorizedRoots.some((allowed) => equalJson(allowed, root))) throw new SelectedPublicationError('SELLER_ROOT_UNAUTHORIZED', root.address);
    if (!record_refs.some((record) => equalJson(record, root))) throw new SelectedPublicationError('SELLER_ROOT_UNDECLARED', root.address);
  }
  if (!equalJson(policy.value.execution_descriptor_ref, destination.value.execution_descriptor_ref)) throw new SelectedPublicationError('EXECUTION_DESCRIPTOR_MISMATCH', 'policy/destination');
  const executionDescriptorRef = exactRef(policy.value.execution_descriptor_ref, 'policy.execution_descriptor_ref');
  const executionDescriptor = await readExact(partition, executionDescriptorRef, sender);
  descriptor(executionDescriptor, 'selected-experience-publication-execution/v1', ['definition_id', 'definition_refs'], 'execution_descriptor');
  const definition_id = text(executionDescriptor.definition_id, 'execution_descriptor.definition_id');
  const definition_refs = Array.isArray(executionDescriptor.definition_refs)
    ? executionDescriptor.definition_refs.map((value, index) => text(value, `execution_descriptor.definition_refs[${index}]`))
    : [];
  if (!definition_refs.includes(definition_id)) throw new SelectedPublicationError('EXECUTION_DEFINITION_UNADMITTED', 'execution_descriptor.definition_id');
  const offerRequired = policy.value.offer_required === true;
  if (offerRequired !== Boolean(normalized.offer_descriptor_ref || normalized.new_offer)) throw new SelectedPublicationError('OFFER_REQUIREMENT_MISMATCH', 'policy.offer_required');
  if (offerRequired && !postPurchase) throw new SelectedPublicationError('POST_PURCHASE_DESTINATION_REQUIRED', 'post_purchase_destination_ref');
  if (!offerRequired && (normalized.offer_descriptor_ref || normalized.new_offer || postPurchase)) throw new SelectedPublicationError('STATIC_PUBLICATION_COMMERCE_FORBIDDEN', 'offer/post_purchase');
  const route = postPurchase ? text(postPurchase.value.post_purchase_route_path, 'post_purchase_destination.post_purchase_route_path') : null;
  if (offer) checkoutOffer(offer.value, text(policy.value.access_ref, 'policy.access_ref'), route!);
  const normalizedWithRoots = {
    ...normalized,
    selected_root_refs,
    entry_byte_path,
    ...(entry_projection_target_ref ? { entry_projection_target_ref } : {}),
  };
  const retryRef = request.publication_request_ref === undefined ? null : exactRef(request.publication_request_ref, 'publication_request_ref');
  if (retryRef) {
    const stored = await readExact(partition, retryRef, sender);
    for (const [key, value] of Object.entries(normalizedWithRoots)) {
      if (!equalJson(stored[key], value)) throw new SelectedPublicationError('PUBLICATION_REQUEST_CONFLICT', key);
    }
    const key = uuid(stored.publication_request_key, 'publication_request_key');
    return { publication_request_ref: retryRef, publication_request_key: key, intent_ref: exactRef(stored.intent_ref, 'stored.intent_ref'), execution: { definition_id, definition_refs }, ...normalizedWithRoots, resumed: true };
  }

  const publication_request_key = requestScopedKey(context, 'generated.publication_request_key');
  const address = `package::hosted-public-app::publication-request::${publication_request_key}`;
  const selectionAddress = `package::hosted-public-app::selected-experience-selection::${publication_request_key}`;
  const intentAddress = `package::hosted-public-app::published-experience-intent::${publication_request_key}`;
  const selection = {
    kind: 'selected-experience-selection/v1',
    address: selectionAddress,
    revision: 'initial',
    root_refs: selected_root_refs,
    records,
    entry_byte_path,
    ...(entry_projection_target_ref ? { entry_projection_target_ref } : {}),
  };
  const selectionBytes = new TextEncoder().encode(JSON.stringify(selection));
  const selection_ref = { address: selectionAddress, revision: 'initial', object_hash: makeHashCodeHexFromBytes(selectionBytes) };
  const newOffer = normalized.new_offer ? { kind: 'commercial-offer', id: `hosted-public-app:${publication_request_key}`, ...normalized.new_offer, access_refs: [text(policy.value.access_ref, 'policy.access_ref')], post_purchase_route_path: route, sort_order: 0 } : null;
  const intent = { kind: 'published-experience-intent', address: intentAddress, revision: 'initial', selection_ref, publication_destination_ref: normalized.publication_destination_ref, ...(normalized.post_purchase_destination_ref ? { post_purchase_destination_ref: normalized.post_purchase_destination_ref } : {}), dependency_ref: exactRef(destination.value.dependency_ref, 'destination.dependency_ref'), access_policy_ref: normalized.policy_ref, access_ref: text(policy.value.access_ref, 'policy.access_ref'), ...(normalized.offer_descriptor_ref ? { offer_descriptor_ref: normalized.offer_descriptor_ref } : {}), ...(newOffer ? { new_offer: newOffer } : {}), root_refs: selected_root_refs, entry_byte_path, ...(entry_projection_target_ref ? { entry_projection_target_ref } : {}), publication: { address: `package::hosted-public-app::publication::${publication_request_key}`, revision: 'initial' } };
  const intentBytes = new TextEncoder().encode(JSON.stringify(intent));
  const intent_ref = { address: intentAddress, revision: 'initial', object_hash: makeHashCodeHexFromBytes(intentBytes) };
  const candidate = {
    kind: 'selected-experience-publication-request/v1',
    address,
    revision: 'initial',
    publication_request_key,
    intent_ref,
    ...normalizedWithRoots, selection_ref,
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(candidate));
  await sender(buildEngineWriteBatchRequestFromLabels([{ partitionLabel: partition, addressLabel: selectionAddress, pathLabels: ['current-item', 'published-record', 'selected-experience-selection'], payloadBytes: selectionBytes, expectedCurrent: { payloadHash: null } }, { partitionLabel: partition, addressLabel: intentAddress, pathLabels: ['current-item', 'published-record', 'published-experience-intent'], payloadBytes: intentBytes, expectedCurrent: { payloadHash: null } }, {
    partitionLabel: partition,
    addressLabel: address,
    pathLabels: ['current-item', 'published-record', 'selected-experience-publication-request'],
    payloadBytes,
    expectedCurrent: { payloadHash: null },
  }]));
  const selectionReadback = readRecordReply(await sender(buildEngineReadCurrentRequestFromLabels(partition, selectionAddress)), selectionAddress);
  if (!equalJson(selectionReadback.value, selection) || selectionReadback.object_hash !== selection_ref.object_hash) throw new SelectedPublicationError('SELECTION_READBACK_MISMATCH', selectionAddress);
  const intentReadback = readRecordReply(await sender(buildEngineReadCurrentRequestFromLabels(partition, intentAddress)), intentAddress);
  if (!equalJson(intentReadback.value, intent) || intentReadback.object_hash !== intent_ref.object_hash) {
    throw new SelectedPublicationError('PUBLICATION_INTENT_READBACK_MISMATCH', intentAddress);
  }
  const readback = readRecordReply(await sender(buildEngineReadCurrentRequestFromLabels(partition, address)), address);
  if (!equalJson(readback.value, candidate)) throw new SelectedPublicationError('PUBLICATION_REQUEST_READBACK_MISMATCH', address);
  return {
    publication_request_ref: { address, revision: candidate.revision, object_hash: readback.object_hash },
    publication_request_key,
    intent_ref,
    execution: { definition_id, definition_refs },
    ...normalizedWithRoots,
    resumed: false,
  };
}
