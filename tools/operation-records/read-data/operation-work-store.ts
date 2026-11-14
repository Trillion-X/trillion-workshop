import { readTrustedRuntimePartition, sendRequestToBitfieldTarget, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { buildEngineReadCurrentRequestFromLabels, buildEngineWriteBatchRequestFromLabels, decodeEngineReadCurrentReply } from '@bitfield/runtime-kit/protocol';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';

type Sender = (request: unknown) => Promise<unknown>;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const identityAddressHex = (label: string) => hex(makeMultihashEncodedBytesFromCodeHex(`1f:${hex(encoder.encode(label))}`));

export interface AtomicOperationWorkRecord { value: unknown; basis: Uint8Array }
export interface AtomicOperationWorkStore {
  read(address: string, options?: { addressMode?: 'identity-text' | 'label-hash' }): Promise<AtomicOperationWorkRecord | null>;
  writeBatch(input: {
    preconditions: Array<{ address: string; expectedBasis: Uint8Array | null; addressMode?: 'identity-text' | 'label-hash' }>;
    writes: Array<{ address: string; value: unknown; addressMode?: 'identity-text' | 'label-hash'; pathLabels?: string[] }>;
  }): Promise<boolean>;
}

function replyBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value && typeof value === 'object' && !Array.isArray(value) && 'payload' in value) return replyBytes((value as { payload: unknown }).payload);
  throw new Error('Operation work engine reply did not contain bytes.');
}

function decodeObject(bytes: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(decoder.decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Operation work record is invalid.');
  return value as Record<string, unknown>;
}

export function createEngineAtomicOperationWorkStore(
  context?: BitfieldRuntimeContext,
  sender: Sender = sendRequestToBitfieldTarget as Sender,
): AtomicOperationWorkStore {
  const partition = readTrustedRuntimePartition(context);
  return {
    read: async (address, options) => {
      const current = decodeEngineReadCurrentReply(replyBytes(await sender(buildEngineReadCurrentRequestFromLabels(
        partition, address, options?.addressMode === 'label-hash' ? undefined : { addressMode: 'identity-text' },
      ))));
      if (!current.found || current.payload === null) return null;
      if (!current.payloadHash) throw new Error('Operation work record has no atomic basis.');
      return { value: decodeObject(current.payload), basis: current.payloadHash };
    },
    writeBatch: async ({ preconditions, writes }) => {
      await sender(buildEngineWriteBatchRequestFromLabels(
        writes.map((write) => ({
          partitionLabel: partition,
          ...(write.addressMode === 'label-hash' ? { addressLabel: write.address } : { addressMultihashHex: identityAddressHex(write.address) }),
          pathLabels: write.pathLabels ?? ['current-item', 'operation-records', write.address.split('::')[2] || 'operation-work-record'],
          payloadBytes: encoder.encode(JSON.stringify(write.value)),
          expectedCurrent: { payloadHash: preconditions.find((condition) => condition.address === write.address)?.expectedBasis ?? null },
        })),
        preconditions.filter((condition) => !writes.some((write) => write.address === condition.address)).map((condition) => ({
          partitionLabel: partition,
          ...(condition.addressMode === 'label-hash' ? { addressLabel: condition.address } : { addressMultihashHex: identityAddressHex(condition.address) }),
          expectedCurrent: { payloadHash: condition.expectedBasis },
        })),
      ));
      return true;
    },
  };
}

const owned = (kind: string, ref: string) => `package::operation-records::${kind}::${encodeURIComponent(ref)}`;
export const operationWorkAddresses = {
  fact: (workRef: string) => owned('work-fact', workRef),
  progress: (workRef: string) => owned('work-progress', workRef),
  result: (workRef: string) => owned('work-result', workRef),
  receipt: (eventRef: string) => owned('work-continuation', eventRef),
  derivative: (resultRef: string) => owned('work-derivative', resultRef),
  surface: 'operation-records.current',
};
