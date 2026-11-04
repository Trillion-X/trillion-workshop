// THE ONE mutation primitive for addressed records: durable engine write-batch
// plus independent current-value readback. Pure assembly lives in the sibling
// builder module so shared views can use it without importing this transport.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '#workspace-records';
import type { AddressedWrite, AddressedWritePrecondition } from './record-write-builders';
import { buildLabelAddressedWriteBatchRequest } from './record-write-builders';

export type { AddressedWrite, AddressedWritePrecondition } from './record-write-builders';
export * from './record-write-builders';
export { recordHistory, withRecordHistory } from './record-write-history';

type AddressedWriteRequest = Parameters<typeof sendRequestToBitfieldTarget>[0];
export type AddressedWriteSender = (request: AddressedWriteRequest) => Promise<unknown>;

export interface AddressedCurrentSnapshot {
  payload: unknown;
  payloadHash: Uint8Array;
}

export interface AddressedWritePorts {
  send: AddressedWriteSender;
  readCurrent: (
    partitionLabel: string,
    addressLabel: string,
  ) => Promise<AddressedCurrentSnapshot | null>;
}

function replyBytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) {
    return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  }
  if (reply && typeof reply === 'object' && 'payload' in reply) {
    return replyBytes((reply as { payload: unknown }).payload);
  }
  throw new Error('Current-value read reply did not contain bytes.');
}

export async function readAddressedCurrent(
  partitionLabel: string,
  addressLabel: string,
  sender: AddressedWriteSender = sendRequestToBitfieldTarget,
): Promise<AddressedCurrentSnapshot | null> {
  const current = decodeEngineReadCurrentReply(replyBytes(await sender(
    buildEngineReadCurrentRequestFromLabels(partitionLabel, addressLabel),
  )));
  if (!current.found || current.payload === null) return null;
  if (!current.payloadHash) {
    throw new Error('Current-value read did not include an exact payload hash.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(current.payload));
  } catch {
    throw new Error('Current-value payload was not valid JSON.');
  }
  return { payload, payloadHash: current.payloadHash };
}

function sourceRevision(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const revision = (value as { revision?: unknown }).revision;
  return typeof revision === 'string' && revision.trim() ? revision : null;
}

/** Resolve projection revision requirements into exact current-value
 * assertions. A source change before this read rejects here; a source change
 * after this read is rejected by the engine's actor-atomic precondition. */
export async function resolveAddressedWritePreconditions(
  partitionLabel: string,
  writes: readonly AddressedWrite[],
  readCurrent: AddressedWritePorts['readCurrent'],
): Promise<readonly AddressedWritePrecondition[]> {
  const requirements = new Map<string, string>();
  for (const write of writes) {
    const guard = write.sourceRevisionGuard;
    if (!guard) continue;
    const prior = requirements.get(guard.addressLabel);
    if (prior !== undefined && prior !== guard.revision) {
      throw new Error('One atomic projection batch referenced conflicting source revisions.');
    }
    requirements.set(guard.addressLabel, guard.revision);
  }

  return Promise.all(
    [...requirements]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([addressLabel, revision]): Promise<AddressedWritePrecondition> => {
        const current = await readCurrent(partitionLabel, addressLabel);
        if (!current || sourceRevision(current.payload) !== revision) {
          throw new Error('Computed projection source changed before its atomic write.');
        }
        return {
          addressLabel,
          expectedCurrent: { payloadHash: current.payloadHash },
        };
      }),
  );
}

/** Atomic multi-entry write — one engine request, N addressed records. */
export async function writeAddressedRecords(
  partitionLabel: string,
  writes: readonly AddressedWrite[],
  ports?: Partial<AddressedWritePorts>,
): Promise<void> {
  return writeAddressedRecordsGuarded(partitionLabel, writes, [], ports);
}

function sameExpectedCurrent(
  left: AddressedWritePrecondition['expectedCurrent'],
  right: AddressedWritePrecondition['expectedCurrent'],
): boolean {
  const leftHash = left.payloadHash;
  const rightHash = right.payloadHash;
  if (!leftHash || !rightHash) return leftHash === rightHash;
  return leftHash.length === rightHash.length
    && leftHash.every((value, index) => value === rightHash[index]);
}

function mergeAddressedWritePreconditions(
  groups: readonly (readonly AddressedWritePrecondition[])[],
): readonly AddressedWritePrecondition[] {
  const merged = new Map<string, AddressedWritePrecondition>();
  for (const precondition of groups.flat()) {
    const existing = merged.get(precondition.addressLabel);
    if (existing && !sameExpectedCurrent(existing.expectedCurrent, precondition.expectedCurrent)) {
      throw new Error('One atomic addressed batch supplied conflicting current-value preconditions.');
    }
    merged.set(precondition.addressLabel, precondition);
  }
  return [...merged.values()].sort(
    (left, right) => left.addressLabel.localeCompare(right.addressLabel),
  );
}

/** Generic actor-atomic write with exact precondition-only assertions. This is
 * the activation/migration seam: source facts can guard a write without being
 * rewritten or smuggled into Society-specific sourceRevision fields. */
export async function writeAddressedRecordsGuarded(
  partitionLabel: string,
  writes: readonly AddressedWrite[],
  preconditions: readonly AddressedWritePrecondition[],
  ports?: Partial<AddressedWritePorts>,
): Promise<void> {
  if (writes.length === 0) return;
  const send = ports?.send ?? sendRequestToBitfieldTarget;
  const readCurrent = ports?.readCurrent
    ?? ((partition, address) => readAddressedCurrent(partition, address, send));
  const derivedPreconditions = await resolveAddressedWritePreconditions(
    partitionLabel,
    writes,
    readCurrent,
  );
  const mergedPreconditions = mergeAddressedWritePreconditions([
    preconditions,
    derivedPreconditions,
  ]);
  await send(buildLabelAddressedWriteBatchRequest(partitionLabel, writes, mergedPreconditions));
}

export async function writeAddressedRecord(options: WriteAddressedRecordOptions): Promise<void> {
  const { partitionLabel, ...write } = options;
  await writeAddressedRecords(partitionLabel, [write]);
}

/** ONE primitive, two arities: callable for a single write, `.batch` for an
 *  atomic multi-record write through the same engine request. */
export interface RecordWriter {
  (options: AddressedWrite): Promise<void>;
  batch: (writes: readonly AddressedWrite[]) => Promise<void>;
  /** Generic owner partition retained for independent readback. Custom writers
   * may omit it; mutation coordinators then fail honest as unknown. */
  readonly partitionLabel?: string;
  /** Independent current-value read owned by the same address translation
   * boundary as writes. Settlement coordinators use this after the matching
   * feed projection; it is never substituted with optimistic UI state. */
  readonly readCurrent?: (addressLabel: string) => Promise<AddressedCurrentSnapshot | null>;
}

export function createRecordWriter(partitionLabel: string): RecordWriter {
  const writer = ((options: AddressedWrite) => writeAddressedRecords(partitionLabel, [options])) as RecordWriter;
  writer.batch = (writes) => writeAddressedRecords(partitionLabel, writes);
  Object.defineProperty(writer, 'partitionLabel', {
    configurable: false,
    enumerable: true,
    value: partitionLabel,
    writable: false,
  });
  Object.defineProperty(writer, 'readCurrent', {
    configurable: false,
    enumerable: true,
    value: (addressLabel: string) => readAddressedCurrent(partitionLabel, addressLabel),
    writable: false,
  });
  return writer;
}
