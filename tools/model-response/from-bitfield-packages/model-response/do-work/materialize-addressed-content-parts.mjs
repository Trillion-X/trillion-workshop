#!/usr/bin/env node

import { blake3 } from '@noble/hashes/blake3.js';
import { readFileSync, writeFileSync } from 'node:fs';

export class AddressedContentMaterializationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'AddressedContentMaterializationError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new AddressedContentMaterializationError(code, message); };
// This is the owner-controlled materialization ceiling. Adapter admission happens
// before this process; this process never accepts an executor, credential, target,
// argv, script, or limit from a caller.
export const ADDRESSED_CONTENT_MATERIALIZATION_POLICY = Object.freeze({
  accepted_content_kinds: ['vision', 'audio', 'video', 'document'],
  content_kind_wire_types: {
    vision: 'image',
    audio: 'audio',
    video: 'video',
    document: 'document',
  },
  max_bytes: 20 * 1024 * 1024,
  max_inline_bytes: 20 * 1024 * 1024,
});
const record = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MR_CONTENT_0001_RECORD_REQUIRED', `${label} must be an object.`);
  return value;
};
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) fail('MR_CONTENT_0002_TEXT_REQUIRED', `${label} must be a non-empty string.`);
  return value.trim();
};
const positive = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) fail('MR_CONTENT_0003_BYTE_LENGTH_INVALID', `${label} must be a non-negative safe integer.`);
  return value;
};

function digest(bytes, declared, label) {
  const value = text(declared, label).toLowerCase();
  const hex = Buffer.from(blake3(new Uint8Array(bytes))).toString('hex');
  if (value === `1f:${hex}`) return value;
  fail('MR_CONTENT_0004_INTEGRITY_MISMATCH', `${label} does not match mounted bytes.`);
}

function mime(value, label) {
  const result = text(value, label).toLowerCase();
  if (!/^[a-z]+\/[a-z0-9!#$&^_.+-]+$/.test(result)) fail('MR_CONTENT_0005_MIME_INVALID', `${label} is not a MIME type.`);
  return result;
}

function supportedKinds(value) {
  if (!Array.isArray(value) || value.length === 0) fail('MR_CONTENT_0006_KINDS_REQUIRED', 'accepted_content_kinds must be a non-empty array.');
  return new Set(value.map((item, index) => text(item, `accepted_content_kinds.${index}`)));
}

function materializePart(value, index, policy, readFile) {
  const part = record(value, `parts.${index}`);
  const kind = text(part.kind, `parts.${index}.kind`);
  if (kind === 'text') return { type: 'text', text: text(part.text, `parts.${index}.text`) };
  if (kind !== 'addressed-content') fail('MR_CONTENT_0007_PART_KIND_UNSUPPORTED', `parts.${index}.kind is unsupported.`);
  const contentKind = text(part.content_kind, `parts.${index}.content_kind`);
  if (!policy.kinds.has(contentKind)) fail('MR_CONTENT_0008_CONTENT_KIND_DENIED', `parts.${index}.content_kind is not admitted.`);
  const wireType = text(policy.wireTypes[contentKind], `policy.content_kind_wire_types.${contentKind}`);
  const mountedPath = text(part.mounted_path, `parts.${index}.mounted_path`);
  let bytes;
  try {
    bytes = readFile(mountedPath);
  } catch {
    fail('MR_CONTENT_0016_MOUNTED_BYTES_MISSING', `parts.${index}.mounted_path cannot be read.`);
  }
  const size = positive(part.byte_length, `parts.${index}.byte_length`);
  if (bytes.length !== size) fail('MR_CONTENT_0009_SIZE_MISMATCH', `parts.${index}.byte_length does not match mounted bytes.`);
  if (bytes.length > policy.maxBytes) fail('MR_CONTENT_0010_SIZE_LIMIT_EXCEEDED', `parts.${index} exceeds max_bytes.`);
  const mimeType = mime(part.mime_type, `parts.${index}.mime_type`);
  const integrityHash = digest(bytes, part.integrity_hash, `parts.${index}.integrity_hash`);
  const delivery = record(part.delivery ?? { kind: 'inline-base64' }, `parts.${index}.delivery`);
  const deliveryKind = text(delivery.kind, `parts.${index}.delivery.kind`);
  if (deliveryKind === 'inline-base64') {
    if (bytes.length > policy.maxInlineBytes) fail('MR_CONTENT_0011_INLINE_LIMIT_EXCEEDED', `parts.${index} exceeds max_inline_bytes.`);
    return { type: wireType, content_kind: contentKind, address: text(part.address, `parts.${index}.address`), mime_type: mimeType, byte_length: bytes.length, integrity_hash: integrityHash, data: bytes.toString('base64') };
  }
  if (deliveryKind === 'file-recipe') {
    return { type: wireType, content_kind: contentKind, address: text(part.address, `parts.${index}.address`), mime_type: mimeType, byte_length: bytes.length, integrity_hash: integrityHash, file_recipe: record(delivery.recipe, `parts.${index}.delivery.recipe`) };
  }
  fail('MR_CONTENT_0012_DELIVERY_UNSUPPORTED', `parts.${index}.delivery.kind is unsupported.`);
}

/** Materializes only bytes already mounted by the declared ProcessDescriptor. */
export function materializeAddressedContentParts(input, { readFile = readFileSync } = {}) {
  const value = Array.isArray(input) ? { parts: input } : record(input, 'input');
  const policy = value.policy === undefined
    ? ADDRESSED_CONTENT_MATERIALIZATION_POLICY
    : record(value.policy, 'policy');
  const kinds = supportedKinds(policy.accepted_content_kinds);
  const wireTypes = record(policy.content_kind_wire_types, 'policy.content_kind_wire_types');
  const maxBytes = positive(policy.max_bytes, 'policy.max_bytes');
  const maxInlineBytes = positive(policy.max_inline_bytes ?? maxBytes, 'policy.max_inline_bytes');
  if (maxInlineBytes > maxBytes) fail('MR_CONTENT_0013_LIMIT_ORDER_INVALID', 'policy.max_inline_bytes cannot exceed policy.max_bytes.');
  if (!Array.isArray(value.parts)) fail('MR_CONTENT_0014_PARTS_REQUIRED', 'parts must be an array.');
  return { parts: value.parts.map((part, index) => materializePart(part, index, { kinds, wireTypes, maxBytes, maxInlineBytes }, readFile)) };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) fail('MR_CONTENT_0015_CLI_ARGS_REQUIRED', 'expected input and output paths.');
  writeFileSync(outputPath, JSON.stringify(materializeAddressedContentParts(JSON.parse(readFileSync(inputPath, 'utf8')))));
}
