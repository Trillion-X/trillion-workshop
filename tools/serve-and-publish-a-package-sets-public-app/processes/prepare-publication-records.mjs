#!/usr/bin/env node

import { makeHashCodeHexFromBytes } from '@bitfield/slot-protocol';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_DEPLOYMENT_RESULT_BYTES = 8 * 1024;
const MAX_SHARE_URL_CHARS = 2048;
const EXACT_REF_FIELDS = new Set(['address', 'revision', 'object_hash']);

export class PublicationRecordPreparationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PublicationRecordPreparationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PublicationRecordPreparationError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value, label) {
  if (!isRecord(value)) fail('HPA_PUBLICATION_0001_RECORD_REQUIRED', `${label} must be an object.`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('HPA_PUBLICATION_0002_TEXT_REQUIRED', `${label} must be a non-empty string.`);
  }
  return value.trim();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function bytesFor(value) {
  return Buffer.from(`${JSON.stringify(canonical(value))}\n`);
}

function multihash(bytes) {
  return makeHashCodeHexFromBytes(bytes);
}

function canonicalMultihash(value, label) {
  const hash = text(value, label).toLowerCase();
  if (!/^1f:[0-9a-f]{64}$/.test(hash)) {
    fail('HPA_PUBLICATION_0003_MULTIHASH_INVALID', `${label} must be a canonical Runtime Kit multihash.`);
  }
  return hash;
}

function exactRef(value, label) {
  const ref = record(value, label);
  if (Object.keys(ref).some((key) => !EXACT_REF_FIELDS.has(key))) {
    fail('HPA_PUBLICATION_0004_EXACT_REF_FIELDS', `${label} contains an undeclared identity field.`);
  }
  return {
    address: text(ref.address, `${label}.address`),
    revision: text(ref.revision, `${label}.revision`),
    object_hash: canonicalMultihash(ref.object_hash, `${label}.object_hash`),
  };
}

function exactRefs(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('HPA_PUBLICATION_0005_EXACT_REFS_REQUIRED', `${label} must be a non-empty exact-ref array.`);
  }
  const refs = value.map((item, index) => exactRef(item, `${label}[${index}]`));
  if (new Set(refs.map((ref) => JSON.stringify(ref))).size !== refs.length) {
    fail('HPA_PUBLICATION_0006_EXACT_REF_DUPLICATE', `${label} contains a duplicate exact ref.`);
  }
  return refs;
}

function jsonBytes(value, label) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_INPUT_BYTES) {
    fail('HPA_PUBLICATION_0007_BYTES_INVALID', `${label} bytes are absent or over the bounded limit.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
  } catch {
    fail('HPA_PUBLICATION_0008_JSON_INVALID', `${label} must contain UTF-8 JSON.`);
  }
  return record(parsed, label);
}

/** The deploy provider owns producing this artifact. HPA owns the one generic
 * boundary that decides whether a provider result can become a buyer route. */
function deploymentResult(value) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_DEPLOYMENT_RESULT_BYTES) {
    fail('HPA_PUBLICATION_0017_DEPLOYMENT_RESULT_LIMIT', 'deployment result is absent or over the bounded limit.');
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
  } catch {
    fail('HPA_PUBLICATION_0018_DEPLOYMENT_RESULT_JSON', 'deployment result must contain UTF-8 JSON.');
  }
  record(parsed, 'deployment result');
  const keys = Object.keys(parsed).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['schema', 'share_url'])) {
    fail('HPA_PUBLICATION_0019_DEPLOYMENT_RESULT_FIELDS', 'deployment result has missing, extra, or duplicate semantic fields.');
  }
  if (parsed.schema !== 'publication-deployment-result/v1') {
    fail('HPA_PUBLICATION_0020_DEPLOYMENT_RESULT_SCHEMA', 'deployment result schema is not recognized.');
  }
  const share_url = text(parsed.share_url, 'deployment result.share_url');
  if (share_url.length > MAX_SHARE_URL_CHARS || share_url !== parsed.share_url) {
    fail('HPA_PUBLICATION_0021_SHARE_URL_INVALID', 'share_url is not canonical or exceeds the bounded limit.');
  }
  let url;
  try {
    url = new URL(share_url);
  } catch {
    fail('HPA_PUBLICATION_0021_SHARE_URL_INVALID', 'share_url is not an absolute URL.');
  }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || url.port !== ''
    || url.hostname === ''
    || url.href !== share_url
  ) {
    fail('HPA_PUBLICATION_0021_SHARE_URL_INVALID', 'share_url must be a canonical absolute HTTPS URL without userinfo, port, or fragment.');
  }
  return { schema: 'publication-deployment-result/v1', share_url };
}

function sameRef(left, right) {
  return left.address === right.address
    && left.revision === right.revision
    && left.object_hash === right.object_hash;
}

function artifactRecord(kind, address, revision, artifactBytes, artifact) {
  return {
    address,
    revision,
    kind,
    artifact_format: text(artifact.format, `${kind}.artifact_format`),
    artifact_multihash: multihash(artifactBytes),
    artifact_base64: Buffer.from(artifactBytes).toString('base64'),
  };
}

function preparedRecord(value) {
  const bytes = bytesFor(value);
  return {
    bytes,
    ref: {
      address: value.address,
      revision: value.revision,
      object_hash: multihash(bytes),
    },
  };
}

export function preparePublicationRecords(rawConfig, manifestBytes, signedClosureBytes, applyProofBytes, deploymentResultBytes) {
  const config = record(rawConfig, 'config');
  if (config.schema !== 'hosted-experience-publication-commit-input/v1') {
    fail('HPA_PUBLICATION_0009_SCHEMA_INVALID', 'config.schema is not recognized.');
  }
  const publication = record(config.publication, 'config.publication');
  const publicationAddress = text(publication.address, 'config.publication.address');
  const publicationRevision = text(publication.revision, 'config.publication.revision');
  const intentRef = exactRef(config.intent_ref, 'config.intent_ref');
  const accessPolicyRef = exactRef(config.access_policy_ref, 'config.access_policy_ref');
  const rootRefs = exactRefs(publication.root_refs, 'config.publication.root_refs');
  const accessRef = text(publication.access_ref, 'config.publication.access_ref');
  const entryProjectionTargetRef = publication.entry_projection_target_ref === undefined
    ? undefined
    : exactRef(publication.entry_projection_target_ref, 'config.publication.entry_projection_target_ref');

  const manifest = jsonBytes(manifestBytes, 'authority manifest');
  const manifestHash = canonicalMultihash(
    manifest.authority_manifest_object_hash,
    'authority_manifest_object_hash',
  );
  const manifestWithoutHash = { ...manifest };
  delete manifestWithoutHash.authority_manifest_object_hash;
  if (multihash(Buffer.from(JSON.stringify(canonical(manifestWithoutHash)))) !== manifestHash) {
    fail('HPA_PUBLICATION_0010_MANIFEST_HASH_MISMATCH', 'Logical authority manifest hash does not match its canonical fields.');
  }
  if (
    manifest.intent_address !== intentRef.address
    || manifest.intent_revision !== intentRef.revision
    || manifest.intent_object_hash !== intentRef.object_hash
    || manifest.access_ref !== accessRef
    || (entryProjectionTargetRef === undefined) !== (manifest.entry_projection_target_ref === undefined)
    || (entryProjectionTargetRef !== undefined && !sameRef(
      exactRef(manifest.entry_projection_target_ref, 'manifest.entry_projection_target_ref'),
      entryProjectionTargetRef,
    ))
    || !Array.isArray(manifest.root_refs)
    || manifest.root_refs.length !== rootRefs.length
    || manifest.root_refs.some((value, index) => !sameRef(exactRef(value, `manifest.root_refs[${index}]`), rootRefs[index]))
  ) {
    fail('HPA_PUBLICATION_0011_MANIFEST_AUTHORITY_MISMATCH', 'Logical manifest does not belong to the resolved intent.');
  }

  const signedClosure = jsonBytes(signedClosureBytes, 'signed closure');
  if (signedClosure.format !== 'bitfield.signed-sealed-closure') {
    fail('HPA_PUBLICATION_0012_SIGNED_CLOSURE_FORMAT', 'Signed closure format is not recognized.');
  }
  const applyProof = jsonBytes(applyProofBytes, 'apply proof');
  if (applyProof.format !== 'bitfield.sealed-closure') {
    fail('HPA_PUBLICATION_0013_APPLY_PROOF_FORMAT', 'Apply proof format is not recognized.');
  }
  const deployment = deploymentResult(deploymentResultBytes);

  const authorityManifest = preparedRecord({
    ...manifest,
    address: text(publication.authority_manifest_address, 'config.publication.authority_manifest_address'),
    revision: publicationRevision,
    kind: 'experience-authority-manifest',
  });
  const sealedClosure = preparedRecord(artifactRecord(
    'runtime-kit-signed-sealed-closure-artifact',
    text(publication.sealed_closure_address, 'config.publication.sealed_closure_address'),
    publicationRevision,
    signedClosureBytes,
    signedClosure,
  ));
  const applyProofRecord = preparedRecord(artifactRecord(
    'runtime-kit-applied-sealed-closure-proof-artifact',
    text(publication.apply_proof_address, 'config.publication.apply_proof_address'),
    publicationRevision,
    applyProofBytes,
    applyProof,
  ));
  const route = preparedRecord({
    address: text(publication.route_address, 'config.publication.route_address'),
    revision: publicationRevision,
    kind: 'published-experience-route/v1',
    request_id: text(config.request_id, 'config.request_id'),
    publication_address: publicationAddress,
    share_url: deployment.share_url,
  });
  const publicationRecord = preparedRecord({
    address: publicationAddress,
    revision: publicationRevision,
    kind: 'published-experience-publication',
    status: 'active',
    request_id: text(config.request_id, 'config.request_id'),
    intent_ref: intentRef,
    authority_manifest_ref: authorityManifest.ref,
    access_policy_ref: accessPolicyRef,
    access_ref: accessRef,
    root_refs: rootRefs,
    ...(entryProjectionTargetRef ? { entry_projection_target_ref: entryProjectionTargetRef } : {}),
    sealed_closure_ref: sealedClosure.ref,
    signed_closure_multihash: signedClosureBytes.length === 0 ? '' : multihash(signedClosureBytes),
    apply_proof_ref: applyProofRecord.ref,
    apply_proof_multihash: applyProofBytes.length === 0 ? '' : multihash(applyProofBytes),
    route_ref: route.ref,
  });

  return {
    authorityManifest,
    sealedClosure,
    applyProof: applyProofRecord,
    route,
    publication: publicationRecord,
  };
}

function args(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      fail('HPA_PUBLICATION_0014_ARGUMENT_INVALID', `Invalid argument near ${key ?? '<end>'}.`);
    }
    if (parsed[key.slice(2)] !== undefined) {
      fail('HPA_PUBLICATION_0015_ARGUMENT_DUPLICATE', `${key} was supplied twice.`);
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function readBounded(file, label) {
  const bytes = readFileSync(file);
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    fail('HPA_PUBLICATION_0016_INPUT_LIMIT', `${label} exceeds ${MAX_INPUT_BYTES} bytes.`);
  }
  return bytes;
}

function main() {
  const values = args(process.argv.slice(2));
  const configBytes = readBounded(values['config-file'], 'config');
  const prepared = preparePublicationRecords(
    JSON.parse(configBytes.toString('utf8')),
    readBounded(values['authority-manifest-file'], 'authority manifest'),
    readBounded(values['signed-closure-file'], 'signed closure'),
    readBounded(values['apply-proof-file'], 'apply proof'),
    readBounded(values['deployment-result-file'], 'deployment result'),
  );
  for (const [key, outputFlag] of [
    ['authorityManifest', 'authority-manifest-record-output'],
    ['sealedClosure', 'sealed-closure-record-output'],
    ['applyProof', 'apply-proof-record-output'],
    ['route', 'route-record-output'],
    ['publication', 'publication-record-output'],
  ]) {
    const output = text(values[outputFlag], `--${outputFlag}`);
    writeFileSync(path.resolve(output), prepared[key].bytes);
  }
  process.stdout.write(`${JSON.stringify({
    schema: 'hosted-experience-publication-commit-result/v1',
    authority_manifest_ref: prepared.authorityManifest.ref,
    sealed_closure_ref: prepared.sealedClosure.ref,
    apply_proof_ref: prepared.applyProof.ref,
    route_ref: prepared.route.ref,
    publication_ref: prepared.publication.ref,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
