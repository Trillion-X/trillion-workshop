// src/workspace/process-result.ts
//
// PORTED FROM: bitfield-runtime-kit packages/js/src/protocol/process-result.ts, verbatim except where a content
// identity is checked: the runtime kit asked its WebAssembly slot protocol whether a multihash round-trips; Trillion
// has no slot protocol, so the same rule (a lowercase identity in canonical form) is checked by its written shape:
// lowercase multihash code-hex, or Trillion's own `1f:` BLAKE3 form. The board parts ported from bitfield-packages
// read a process's result through these functions (parts/group/do-work/request-board-output.ts), through
// #workspace-records (src/workspace/records.ts), which re-exports them.

// A content identity in canonical written form: lowercase multihash code-hex, or Trillion's `1f:` BLAKE3 identity.
const CANONICAL_IDENTITY = /^(?:[0-9a-f]{4,}|1f:[0-9a-f]{64})$/;

export type ProcessTerminationWireShape =
  | { kind: 'exited'; code: number }
  | { kind: 'signaled'; signal: number };

export interface ProcessCapturedFdWireShape {
  fd: number;
  bytes: string;
  content_hash: string;
  eof_observed: true;
}

/**
 * Cryptographic receipt bytes are emitted and validated by the Rust process
 * owner. This JS seam locks only the receipt discriminator/canonicalization and
 * deliberately keeps the owner proof opaque; it does not duplicate JCS,
 * receipt-checksum, executable-identity, or publication verification.
 */
export interface OpaqueProcessContainmentReceiptWireShape {
  schema: 'bitfield.process_containment_receipt.v1';
  checksum_canonicalization: 'rfc8785-jcs-omit-checksum-member';
  checksum: string;
  [field: string]: unknown;
}

/** Strict JSON wire shape after the Rust owner has validated the receipt. */
export interface ProcessResultWireShape {
  termination: ProcessTerminationWireShape;
  captured_fds: ProcessCapturedFdWireShape[];
  outputs: unknown[];
  collected_files: unknown[];
  immutable_publications: unknown[];
  duration_ms: number;
  containment_receipt: OpaqueProcessContainmentReceiptWireShape;
}

const PROCESS_RESULT_ALLOWED_FIELDS = new Set([
  'termination',
  'captured_fds',
  'outputs',
  'collected_files',
  'immutable_publications',
  'duration_ms',
  'containment_receipt',
]);

const PROCESS_RESULT_REQUIRED_FIELDS = [
  'termination',
  'captured_fds',
  'outputs',
  'collected_files',
  'immutable_publications',
  'duration_ms',
  'containment_receipt',
] as const;

const RECEIPT_SCHEMA = 'bitfield.process_containment_receipt.v1';
const RECEIPT_CANONICALIZATION = 'rfc8785-jcs-omit-checksum-member';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  field: string,
): void {
  const expected = new Set(fields);
  const observed = Object.keys(value);
  const unknown = observed.find((key) => !expected.has(key));
  const missing = fields.find((key) => !Object.hasOwn(value, key));
  if (unknown !== undefined) {
    throw new TypeError(`${field} contains unknown field: ${unknown}`);
  }
  if (missing !== undefined) {
    throw new TypeError(`${field} is missing field: ${missing}`);
  }
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
}

function assertUnsignedInteger(value: unknown, field: string, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${field} must be an exact unsigned integer`);
  }
}

function assertContentHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value !== value.toLowerCase()) {
    throw new TypeError(`${field} must be a lowercase multihash code-hex identity`);
  }
  if (!CANONICAL_IDENTITY.test(value)) {
    throw new TypeError(`${field} must be a lowercase multihash code-hex identity`);
  }
}

function decodeTermination(value: unknown, field: string): ProcessTerminationWireShape {
  assertRecord(value, field);
  if (value.kind === 'exited') {
    assertExactFields(value, ['kind', 'code'], field);
    assertUnsignedInteger(value.code, `${field}.code`, 255);
    return { kind: 'exited', code: value.code };
  }
  if (value.kind === 'signaled') {
    assertExactFields(value, ['kind', 'signal'], field);
    assertUnsignedInteger(value.signal, `${field}.signal`, 255);
    if (value.signal === 0) {
      throw new TypeError(`${field}.signal must be nonzero`);
    }
    return { kind: 'signaled', signal: value.signal };
  }
  throw new TypeError(`${field} must be an exact exited or signaled termination`);
}

function decodeCanonicalBase64(value: unknown, field: string): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new TypeError(`${field} must be canonical padded base64 text`);
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const encoded = btoa(binary);
  if (encoded !== value) {
    throw new TypeError(`${field} must be canonical padded base64 text`);
  }
  return bytes;
}

function decodeCapturedFd(value: unknown, index: number): ProcessCapturedFdWireShape {
  const field = `process_result.captured_fds[${index}]`;
  assertRecord(value, field);
  assertExactFields(value, ['fd', 'bytes', 'content_hash', 'eof_observed'], field);
  assertUnsignedInteger(value.fd, `${field}.fd`, 65_535);
  decodeCanonicalBase64(value.bytes, `${field}.bytes`);
  assertContentHash(value.content_hash, `${field}.content_hash`);
  if (value.eof_observed !== true) {
    throw new TypeError(`${field}.eof_observed must be true`);
  }
  return value as unknown as ProcessCapturedFdWireShape;
}

function assertOrderedUniqueFds(captures: readonly { fd: number }[], field: string): void {
  for (let index = 1; index < captures.length; index += 1) {
    if (captures[index - 1].fd >= captures[index].fd) {
      throw new TypeError(`${field} must be strictly ordered by unique fd`);
    }
  }
}

function decodeOpaqueReceipt(value: unknown): OpaqueProcessContainmentReceiptWireShape {
  const field = 'process_result.containment_receipt';
  assertRecord(value, field);
  if (value.schema !== RECEIPT_SCHEMA) {
    throw new TypeError(`${field}.schema must equal ${RECEIPT_SCHEMA}`);
  }
  if (value.checksum_canonicalization !== RECEIPT_CANONICALIZATION) {
    throw new TypeError(
      `${field}.checksum_canonicalization must equal ${RECEIPT_CANONICALIZATION}`,
    );
  }
  assertContentHash(value.checksum, `${field}.checksum`);
  return value as OpaqueProcessContainmentReceiptWireShape;
}

/**
 * Decode the strict `execution_types::ProcessResult` JSON wire shape.
 *
 * Receipt and capture hashes are proof evidence validated by the Rust owner,
 * not recomputed here. Every canonical owner field is required; this boundary
 * carries no reader-side compatibility defaults.
 */
export function decodeProcessResultWireShape(payload: Uint8Array): ProcessResultWireShape {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch (error) {
    throw new TypeError(`process result is not UTF-8 JSON: ${String(error)}`);
  }
  assertRecord(decoded, 'process_result');
  const unknown = Object.keys(decoded).find((key) => !PROCESS_RESULT_ALLOWED_FIELDS.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`process_result contains unknown field: ${unknown}`);
  }
  const missing = PROCESS_RESULT_REQUIRED_FIELDS.find((key) => !Object.hasOwn(decoded, key));
  if (missing !== undefined) {
    throw new TypeError(`process_result is missing field: ${missing}`);
  }

  const termination = decodeTermination(decoded.termination, 'process_result.termination');
  assertArray(decoded.captured_fds, 'process_result.captured_fds');
  const capturedFds = decoded.captured_fds.map(decodeCapturedFd);
  assertOrderedUniqueFds(capturedFds, 'process_result.captured_fds');
  for (const key of ['collected_files', 'immutable_publications'] as const) {
    assertArray(decoded[key], `process_result.${key}`);
  }
  assertArray(decoded.outputs, 'process_result.outputs');
  assertUnsignedInteger(decoded.duration_ms, 'process_result.duration_ms', Number.MAX_SAFE_INTEGER);
  const containmentReceipt = decodeOpaqueReceipt(decoded.containment_receipt);

  return {
    termination,
    captured_fds: capturedFds,
    outputs: decoded.outputs,
    collected_files: decoded.collected_files,
    immutable_publications: decoded.immutable_publications,
    duration_ms: decoded.duration_ms,
    containment_receipt: containmentReceipt,
  };
}

/** Return the exact native exit code, or `null` for signal termination. */
export function processExitedCode(result: ProcessResultWireShape): number | null {
  return result.termination.kind === 'exited' ? result.termination.code : null;
}

export function processTerminationText(result: ProcessResultWireShape): string {
  return result.termination.kind === 'exited'
    ? `exited:${result.termination.code}`
    : `signaled:${result.termination.signal}`;
}

/** Decode one captured fd after the Rust owner has validated its proof evidence. */
export function capturedProcessFdBytes(result: ProcessResultWireShape, fd: number): Uint8Array {
  assertUnsignedInteger(fd, 'fd', 65_535);
  const matches = result.captured_fds.filter((capture) => capture.fd === fd);
  if (matches.length !== 1) {
    throw new TypeError(`process result must contain exactly one capture for fd ${fd}`);
  }
  const [capture] = matches;
  if (capture.eof_observed !== true) {
    throw new TypeError(`process result capture for fd ${fd} lacks EOF evidence`);
  }
  assertContentHash(capture.content_hash, `process result capture for fd ${fd}.content_hash`);
  return decodeCanonicalBase64(capture.bytes, `process result capture for fd ${fd}`);
}

export function capturedProcessFdText(result: ProcessResultWireShape, fd: number): string {
  return new TextDecoder().decode(capturedProcessFdBytes(result, fd));
}
