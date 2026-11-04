// Owner-bound read adapter for addressed cell sources. Pure settlement logic
// lives in cell-source-settlement.ts and carries no workspace transport.

import type { VisualDatabaseCellRef } from '../read-data/visual-database';
import type { AddressedCellValueRecord } from './cell-expression';
import { addressedCellValueLabels } from './record-write-builders';
import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '#workspace-records';
export * from './cell-source-settlement';

export type CellSourceReadSender = (request: {
  target: string;
  payload: unknown;
}) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function replyBytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  if (isRecord(reply)) {
    const payload = reply.payload;
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  throw new Error('Cell source read-current reply did not contain bytes.');
}

function multihashBytes(codeHex: string | undefined): Uint8Array | null {
  if (!codeHex) return null;
  const match = /^([0-9a-f]{2}):([0-9a-f]+)$/i.exec(codeHex);
  if (!match || match[2].length % 2 !== 0) throw new Error('Cell source read-current returned an invalid content hash.');
  const digest = match[2].match(/../g) ?? [];
  return Uint8Array.from([Number.parseInt(match[1], 16), ...digest.map((pair) => Number.parseInt(pair, 16))]);
}

/** Independent owner readback for one addressed source. The Runtime Kit owns
 * address/protocol encoding; this boundary only translates the decoded JSON
 * value into the caller-ready cell-source record. */
export async function readCurrentCellSource(
  partitionLabel: string,
  cellRef: VisualDatabaseCellRef,
  sender: CellSourceReadSender = sendRequestToBitfieldTarget,
): Promise<AddressedCellValueRecord | null> {
  if (!partitionLabel.trim()) throw new Error('Cell source readback requires an owner partition.');
  const reply = decodeEngineReadCurrentReply(replyBytes(await sender(
    buildEngineReadCurrentRequestFromLabels(
      partitionLabel,
      addressedCellValueLabels(cellRef).expression,
    ),
  )));
  if (!reply.found || reply.payload === null) return null;
  const payload = JSON.parse(new TextDecoder().decode(reply.payload)) as unknown;
  if (!isRecord(payload)) throw new Error('Cell source readback payload must be an object.');
  const revision = typeof payload.revision === 'string' && payload.revision.trim()
    ? payload.revision
    : undefined;
  const payloadHash = multihashBytes(reply.contentHash);
  return {
    payload,
    ...(revision ? { revision } : {}),
    ...(payloadHash ? { expectedCurrent: { payloadHash } } : { expectedCurrent: null }),
  };
}
