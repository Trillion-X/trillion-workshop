// packages/group/read-data/read-group-board.ts
//
// PURPOSE
// The live read/write store for an openable Group Board — the last-mile that turns
// the Universal Addressed Group primitive into a surface a person can open, drop
// items into, nest into sections, and have persist. This module is the ONLY I/O
// boundary for the board surface (L098): the panel renders, this store talks to the
// engine. It composes the already-proven group I/O — `foldGroupRecords` (decode),
// `buildGroupWriteBatch` (diff → write-batch) — and bridges the group package's
// high-level WriteBatchRequest into engine-operation protocol bytes.
//
// NON-NEGOTIABLE INVARIANTS
//   - BLIND (L090): the store never enumerates member family or interprets board
//     content. A board node is any AddressRef; a "section" is simply a member whose
//     nodeRef is itself a group (I2 of the leaf). The store reads/writes graphs.
//   - SSOT: membership logic lives in the leaf, persistence shape in group-eeaf.
//     This store invents neither — it only sequences reads and bridges writes.
//   - O(changed) WRITES: mutations diff `before → after`; unchanged groups produce
//     zero writes (structural sharing). A no-op transition writes nothing.
//
// CONCURRENCY
//   A board is single-writer (one person arranging their own board), so writes are
//   unconditional (no `expectedCurrent` basis). Multi-writer boards would thread the
//   per-address payload-hash basis here — the engine contract already supports it.

import { sendRequestToBitfieldTarget } from '#workspace-records';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '#workspace-records';
import {
  groupKey,
  type AddressRef,
  type Group,
  type GroupGraph,
} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { foldGroupRecords, groupRecordAddress, type GroupRecord } from 'trillion-workshop/tools/organize-the-sidebar/read-data/group-eeaf.ts';
import { buildGroupWriteBatch } from 'trillion-workshop/tools/organize-the-sidebar/do-work/group-mutation-writes.ts';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** A sender of an engine-operation request → opaque reply. The browser default talks to the live engine. */
export type BoardRequestSender = (request: { target: string; payload: Uint8Array }) => Promise<unknown>;
export type GroupSourceObservation = { address: string; object_hash: string };

/** The live board store: load the whole board graph, and persist a membership transition. */
export interface GroupBoardStore {
  /** Read the board: BFS from the root, following every member into any sub-group, fold to a graph. */
  load(additionalRoots?: readonly AddressRef[]): Promise<GroupGraph>;
  /** Persist a `before → after` transition (diff → write-batch). No-op transitions write nothing. */
  apply(before: GroupGraph, after: GroupGraph): Promise<void>;
}

/**
 * BFS-load the containment tree(s) reachable from `roots` and fold them into one
 * GroupGraph. Leaf items (addresses with no group record) are skipped — the
 * loader stays blind to which families are groups (leaf invariant I1). This is
 * the ONE live group reader: the board store and the membership mutation
 * executor both delegate here (SSOT — one read path, one addressing choice).
 */
export async function loadGroupGraphFromRoots(
  partitionLabel: string,
  roots: readonly AddressRef[],
  sender: BoardRequestSender = sendRequestToBitfieldTarget as BoardRequestSender,
  onObservation?: (observation: GroupSourceObservation) => void,
): Promise<GroupGraph> {
  const partition = nonEmpty(partitionLabel, 'partitionLabel');

  async function readGroupRecord(ref: AddressRef): Promise<{ record: GroupRecord; observation?: GroupSourceObservation } | null> {
    const address = groupRecordAddress(ref);
    // The write path (buildGroupWriteBatch → group-mutation-writes) stores each
    // group under `address_mode: 'identity_text'` — the address IS the serialized
    // nodeRef text, not a hashed label. The read MUST address the same way or it
    // would never find what it wrote. (identity-text ⇄ identity_text symmetry.)
    let reply: unknown;
    try {
      reply = await sender(
        buildEngineReadCurrentRequestFromLabels(partition, address, { addressMode: 'identity-text' }),
      );
    } catch (error) {
      // A member ref is allowed to terminate at any non-group address. Some
      // engine transports represent that ordinary absence as a thrown
      // FE_ADDRESS_NOT_FOUND instead of a decoded found:false reply. Treat only
      // that typed absence as a leaf; every transport/protocol failure remains
      // fatal so a broken graph can never be mistaken for an empty one.
      if (isAddressNotFoundError(error)) return null;
      throw error;
    }
    const current = decodeEngineReadCurrentReply(payloadBytesFromReply(reply));
    if (!current.found) return null;
    const value_json = safeJson(textDecoder.decode(current.payload));
    if (value_json === undefined) return null;
    if (onObservation) {
      if (!current.contentHash) throw new Error(`Group Board source observation has no Engine content identity: ${address}`);
    }
    return {
      record: { address, value_json },
      observation: current.contentHash ? { address, object_hash: current.contentHash } : undefined,
    };
  }

  const records: GroupRecord[] = [];
  const seen = new Set<string>();
  const queue: AddressRef[] = [...roots];
  while (queue.length) {
    // Sibling reads have no data dependency. Bound concurrent owner requests
    // while folding results in queue order, independent of completion order.
    const batch: AddressRef[] = [];
    while (queue.length && batch.length < 8) {
      const ref = queue.shift()!;
      const key = groupKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      batch.push(ref);
    }
    const loaded = await Promise.all(batch.map(readGroupRecord));
    for (const result of loaded) {
      if (!result) continue;
      // Publish observations in traversal order only after the batch succeeds.
      // An outstanding sibling must not call the observer after load rejected.
      if (result.observation) onObservation?.(result.observation);
      const record = result.record;
      records.push(record);
      for (const member of membersOfRecord(record.value_json)) {
        if (member.nodeRef) queue.push(member.nodeRef);
      }
    }
  }
  return foldGroupRecords(records);
}

function isAddressNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === 'FE_ADDRESS_NOT_FOUND'
    || (typeof record.message === 'string' && /(?:^|\b)FE_ADDRESS_NOT_FOUND(?:\b|:)/u.test(record.message));
}

export function createGroupBoardStore(
  partitionLabel: string,
  rootRef: AddressRef,
  sender: BoardRequestSender = sendRequestToBitfieldTarget as BoardRequestSender,
): GroupBoardStore {
  const partition = nonEmpty(partitionLabel, 'partitionLabel');

  async function load(additionalRoots: readonly AddressRef[] = []): Promise<GroupGraph> {
    return loadGroupGraphFromRoots(partition, [rootRef, ...additionalRoots], sender);
  }

  async function apply(before: GroupGraph, after: GroupGraph): Promise<void> {
    // buildGroupWriteBatch ALREADY produces the correct identity-text JSON
    // write-batch request (`engine.operation.label-addressed` with per-entry
    // `address_mode:'identity_text'`) — the same request `persistGroupMutation`
    // and every other product writer (e.g. guided-overlay) sends directly. Send
    // it AS-IS. Re-encoding it through the binary `buildEngineWriteBatchRequestFromLabels`
    // builder (label-hash only, no identity-text) silently wrote the record to a
    // hashed address that load()'s identity-text read never looks at → the board
    // never persisted. Read and write addressing are ONE choice (SSOT).
    const batch = buildGroupWriteBatch(before, after);
    if (batch.payload.writes.length === 0) return;
    await sender(batch as unknown as Parameters<BoardRequestSender>[0]);
  }

  return { load, apply };
}

/** Pull the member edges out of a raw persisted group value (tolerant of malformed records). */
function membersOfRecord(value: unknown): Array<{ nodeRef: AddressRef | null }> {
  if (!value || typeof value !== 'object') return [];
  const group = value as Partial<Group>;
  const order = Array.isArray(group.memberOrder) ? group.memberOrder : [];
  const members = (group.members ?? {}) as Record<string, { nodeRef?: AddressRef }>;
  return order.map((id) => ({ nodeRef: members[id]?.nodeRef ?? null }));
}

function payloadBytesFromReply(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  if (typeof reply === 'string') return textEncoder.encode(reply);
  if (reply && typeof reply === 'object') {
    const payload = (reply as { payload?: unknown }).payload;
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    if (typeof payload === 'string') return textEncoder.encode(payload);
  }
  throw new Error('engine.operation read-current reply did not include decodable payload bytes');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function nonEmpty(value: string, label: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new Error(`Group Board ${label} is empty`);
  return trimmed;
}
