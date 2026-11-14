// Admitted owner target: converts one addressed field-descriptor record through
// the pure migration and commits it via the existing guarded engine batch door.

import { writeAddressedRecords, type AddressedWrite } from './record-writes';
import { migrateRawFieldDerivations } from './migrate-field-derivations';

type JsonObject = Record<string, unknown>;
type BatchWriter = (partitionLabel: string, writes: readonly AddressedWrite[]) => Promise<void>;

export interface MigrateFieldDerivationsTargetInput {
  partition_label: string;
  fields_ref: string;
  fields: unknown;
  path_labels: readonly string[];
  expected_current: { payload_hash_base64: string };
  prior_revision?: string;
  next_revision?: string;
}

export type MigrateFieldDerivationsTargetReply =
  | { ok: true; fields_ref: string; events: readonly unknown[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Remove only undefined object entries before an addressed write. Explicit
 * null/literal values survive; the engine receives canonical JSON-shaped data. */
function jsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => [key, jsonValue(entry)]));
}

function readRequest(input: unknown): MigrateFieldDerivationsTargetInput | null {
  if (!isRecord(input)) return null;
  const partition_label = nonEmptyString(input.partition_label);
  const fields_ref = nonEmptyString(input.fields_ref);
  const path_labels = Array.isArray(input.path_labels) && input.path_labels.every((entry) => typeof entry === 'string' && entry)
    ? input.path_labels as string[]
    : null;
  const expected = isRecord(input.expected_current) ? nonEmptyString(input.expected_current.payload_hash_base64) : null;
  if (!partition_label || !fields_ref || !isRecord(input.fields) || !path_labels || !expected) return null;
  return {
    partition_label,
    fields_ref,
    fields: input.fields,
    path_labels,
    expected_current: { payload_hash_base64: expected },
    ...(nonEmptyString(input.prior_revision) ? { prior_revision: nonEmptyString(input.prior_revision)! } : {}),
    ...(nonEmptyString(input.next_revision) ? { next_revision: nonEmptyString(input.next_revision)! } : {}),
  };
}

export async function migrateFieldDerivationsTarget(
  input: unknown,
  _context?: { packageData?: unknown },
  writer: BatchWriter = writeAddressedRecords,
): Promise<MigrateFieldDerivationsTargetReply> {
  const request = readRequest(input);
  if (!request) return { ok: false, error: 'invalid migration request' };
  const payloadHash = decodeBase64(request.expected_current.payload_hash_base64);
  if (!payloadHash) return { ok: false, error: 'invalid expected-current payload hash' };
  const result = migrateRawFieldDerivations(request.fields, {
    ...(request.prior_revision ? { prior: request.prior_revision } : {}),
    ...(request.next_revision ? { next: request.next_revision } : {}),
  });
  // Idempotence is a write-boundary property: a completed migration must not
  // emit another guarded write merely because its action was invoked again.
  if (result.events.length === 0) return { ok: true, fields_ref: request.fields_ref, events: [] };
  await writer(request.partition_label, [{
    addressLabel: request.fields_ref,
    pathLabels: request.path_labels,
    payload: jsonValue(result.payload),
    expectedCurrent: { payloadHash },
  }]);
  return { ok: true, fields_ref: request.fields_ref, events: result.events };
}
