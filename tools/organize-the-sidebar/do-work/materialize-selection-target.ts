// Group's owner-side selection materializer.  A caller may name only the board
// it is currently looking at and its LOCAL member ids.  This boundary reads the
// graph, carves a portable board capsule with Group's existing share primitive,
// then persists an immutable projection.  No caller supplied bytes, hashes, or
// authority claims ever become a projection root.

import { createTrustedRuntimeIdMinter, sendRequestToBitfieldTarget } from '#workspace-records';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  makeHashCodeHexFromBytes,
} from '#workspace-records';
import type { AddressRef } from '../../ui/show/group/group-graph';
import { groupRecordAddress } from '../read-data/group-eeaf';
import {
  loadGroupGraphFromRoots,
  type BoardRequestSender,
  type GroupSourceObservation,
} from '../read-data/read-group-board';
import { boardToCapsuleSource } from '../read-data/board-to-capsule-source';
import { buildShareCapsule } from '../read-data/share-capsule';

type Plain = Record<string, unknown>;
type ExactRef = { address: string; revision: string; object_hash: string };
type Sender = typeof sendRequestToBitfieldTarget;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SELECTION = 256;
const MAX_TEXT_BYTES = 512;
const ENTRY_PATH = ['group', 'selection-entry.mjs'] as const;
const RENDERER_PATH = ['group', 'selected-capsule-renderer.mjs'] as const;
const RENDERER_BYTES_ADDRESS = 'package::group::entry-bytes::selected-capsule-renderer';

function plain(value: unknown): value is Plain {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || encoder.encode(value).byteLength > MAX_TEXT_BYTES) {
    throw new Error(`invalid ${label}`);
  }
  return value.trim();
}

function only(value: Plain, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`invalid ${label}`);
}

function addressRef(value: unknown, label: string): AddressRef {
  if (!plain(value)) throw new Error(`invalid ${label}`);
  only(value, ['family', 'parts'], label);
  const family = boundedText(value.family, `${label}.family`);
  if (!plain(value.parts)) throw new Error(`invalid ${label}.parts`);
  const parts: Record<string, string> = {};
  for (const [key, part] of Object.entries(value.parts)) {
    if (!key || typeof part !== 'string' || !part.trim() || encoder.encode(part).byteLength > MAX_TEXT_BYTES) {
      throw new Error(`invalid ${label}.parts`);
    }
    parts[key] = part;
  }
  return { family, parts };
}

function readRequest(input: unknown): { partition: string; id: string; boardRef: AddressRef; memberIds: string[] } {
  if (!plain(input)) throw new Error('invalid selection materialization request');
  only(input, ['partition_label', 'materialization_id', 'selection'], 'selection materialization request');
  const partition = boundedText(input.partition_label, 'partition_label');
  const id = boundedText(input.materialization_id, 'materialization_id');
  if (!UUID.test(id)) throw new Error('invalid materialization_id');
  if (!plain(input.selection)) throw new Error('invalid owner-local selection');
  only(input.selection, ['root_ref', 'member_ids'], 'owner-local selection');
  const boardRef = addressRef(input.selection.root_ref, 'selection.root_ref');
  if (!Array.isArray(input.selection.member_ids) || input.selection.member_ids.length === 0 || input.selection.member_ids.length > MAX_SELECTION) {
    throw new Error('invalid selection.member_ids');
  }
  const memberIds = input.selection.member_ids.map((value) => boundedText(value, 'selection.member_id'));
  if (new Set(memberIds).size !== memberIds.length) throw new Error('duplicate selection.member_id');
  return { partition, id, boardRef, memberIds };
}

function replyBytes(reply: unknown): Uint8Array | null {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  if (plain(reply) && 'payload' in reply) return replyBytes(reply.payload);
  return null;
}

async function current(sender: Sender, partition: string, address: string, identityText = false) {
  const reply = await sender(buildEngineReadCurrentRequestFromLabels(
    partition,
    address,
    identityText ? { addressMode: 'identity-text' } : undefined,
  ));
  return decodeEngineReadCurrentReply(replyBytes(reply) ?? new Uint8Array());
}

function recordFrom(reply: { found?: boolean; payload?: Uint8Array; contentHash?: string }, label: string): { value: Plain; hash: string } {
  if (!reply.found || !reply.payload || !reply.contentHash) throw new Error(`${label} is not resolvable`);
  try {
    const value: unknown = JSON.parse(decoder.decode(reply.payload));
    if (!plain(value)) throw new Error('not structured');
    return { value, hash: reply.contentHash };
  } catch {
    throw new Error(`${label} is not a structured record`);
  }
}

async function createOnly(sender: Sender, partition: string, address: string, kind: string, payload: unknown): Promise<void> {
  await sender(buildEngineWriteBatchRequestFromLabels([{
    partitionLabel: partition,
    addressLabel: address,
    pathLabels: ['current-item', 'published-record', kind],
    payloadBytes: encoder.encode(JSON.stringify(payload)),
    expectedCurrent: { payloadHash: null },
  }]));
}

async function persistImmutable(
  sender: Sender,
  partition: string,
  address: string,
  kind: string,
  candidate: Plain,
  equivalent: (value: Plain) => boolean,
): Promise<{ value: Plain; hash: string }> {
  let reply = await current(sender, partition, address);
  if (!reply.found) {
    try { await createOnly(sender, partition, address, kind, candidate); } catch { /* contender is resolved by readback */ }
    reply = await current(sender, partition, address);
  }
  const persisted = recordFrom(reply, kind);
  if (!equivalent(persisted.value)) throw new Error('materialization conflict');
  return persisted;
}

function entryModule(capsule: unknown): string {
  // This tiny closure carries only selected portable data.  Rendering remains
  // Group-owned by the prebuilt read-only SharedCapsuleView entry beside it.
  return `import mountRenderer from './selected-capsule-renderer.mjs';\nconst capsule=${JSON.stringify(capsule)};\nexport const mount=({el})=>mountRenderer({el,capsule});\nexport default mount;\n`;
}

function canonicalBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function projectionFields(entryBytes: string, rendererHash: string): Plain {
  return {
    kind_ref: 'group.selection-projection/v1',
    dependency_refs: [],
    projection_files: [{
      path: [...ENTRY_PATH],
      source: { kind: 'inline', bytes: canonicalBase64(encoder.encode(entryBytes)) },
      integrity_hash: makeHashCodeHexFromBytes(encoder.encode(entryBytes)),
      executable: true,
    }, {
      path: [...RENDERER_PATH],
      source: { kind: 'blob_ref', hash: rendererHash },
      integrity_hash: rendererHash,
      executable: true,
    }],
    browser_import_bindings: [],
    authority: { data_refs: [], subscription_refs: [], target_refs: [], navigation_refs: [] },
  };
}

/**
 * Generic owner target: owner-local `root_ref + member_ids` becomes a durable,
 * standalone, buyer-renderable Group projection.  The returned record topology
 * is complete closure data; consumers never re-read Group's mutable source.
 */
export async function materializeGroupSelectionTarget(
  input: unknown,
  context?: { packageData?: unknown },
  sender: Sender = sendRequestToBitfieldTarget,
): Promise<{ schema: 'selection-materialization-result/v1'; root_refs?: ExactRef[]; records?: Plain[]; entry_byte_path?: readonly string[]; authority_ref?: ExactRef; error?: string }> {
  try {
    // Both revisions below are minted from the entropy the runtime drew for this
    // request, so a replay of the same log mints the same two in the same order. A
    // generator this target reached for itself would make every replay disagree
    // with the refs that point at these records.
    const mintRevision = createTrustedRuntimeIdMinter(context);
    const request = readRequest(input);
    const rootAddress = groupRecordAddress(request.boardRef);
    const renderer = await current(sender, request.partition, RENDERER_BYTES_ADDRESS);
    if (!renderer.found || !renderer.payload || !renderer.contentHash) throw new Error('selected renderer bytes are not resolvable');
    const observedGroups: GroupSourceObservation[] = [];
    const graph = await loadGroupGraphFromRoots(
      request.partition,
      [request.boardRef],
      sender as BoardRequestSender,
      (observation) => observedGroups.push(observation),
    );
    const items = boardToCapsuleSource(graph, request.boardRef);
    const available = new Set(items.map((item) => item.memberId));
    if (request.memberIds.some((id) => !available.has(id))) throw new Error('selection member is not resolvable');
    const capsule = buildShareCapsule([{
      boardId: rootAddress,
      title: 'Selection',
      items,
      scope: { kind: 'selection', selectedIds: request.memberIds },
    }], 'Selection');
    if (capsule.boards.length === 0) throw new Error('selection has no renderable content');

    // Engine current reads yield a content identity but no universal semantic
    // revision.  Preserve that fact as an observation; never fabricate an exact
    // source ref merely to satisfy a consumer-shaped schema.
    const sourceObservations = [...new Map([
      ...observedGroups,
      { address: RENDERER_BYTES_ADDRESS, object_hash: renderer.contentHash },
    ].map((observation) => [observation.address, observation])).values()]
      .sort((left, right) => left.address.localeCompare(right.address));

    const projectionAddress = `package::group::selection-projection::${request.id}`;
    const entryBytes = entryModule(capsule);
    const fields = projectionFields(entryBytes, renderer.contentHash);
    const projectionCandidate: Plain = {
      address: projectionAddress,
      kind: 'group-selection-projection/v1', version: 1, revision: mintRevision(), materialization_id: request.id,
      source_observations: sourceObservations, capsule, entry_byte_path: [...ENTRY_PATH], entry_bytes: entryBytes,
      ...fields,
    };
    const persistedProjection = await persistImmutable(sender, request.partition, projectionAddress, 'group-selection-projection', projectionCandidate, (value) =>
      value.address === projectionAddress && value.kind === projectionCandidate.kind && value.version === 1 && value.materialization_id === request.id && same(value.source_observations, sourceObservations)
      && same(value.capsule, capsule) && same(value.entry_byte_path, [...ENTRY_PATH]) && value.entry_bytes === entryBytes && same(
        Object.fromEntries(Object.keys(fields).map((key) => [key, value[key]])), fields,
      )
      && typeof value.revision === 'string' && UUID.test(value.revision),
    );
    const rootRef: ExactRef = { address: projectionAddress, revision: persistedProjection.value.revision as string, object_hash: persistedProjection.hash };
    const authorityAddress = `package::group::selection-materialization-authority::${request.id}`;
    const authorityCandidate: Plain = {
      address: authorityAddress,
      kind: 'selection-materialization-authority/v1', version: 1, revision: mintRevision(), materialization_id: request.id,
      materializer: 'group.materialize-selection-target', root_refs: [rootRef], record_refs: [rootRef],
      entry_byte_path: [...ENTRY_PATH], source_observations: sourceObservations,
    };
    const persistedAuthority = await persistImmutable(sender, request.partition, authorityAddress, 'selection-materialization-authority', authorityCandidate, (value) =>
      value.address === authorityAddress && value.kind === authorityCandidate.kind && value.version === 1 && value.materialization_id === request.id && value.materializer === authorityCandidate.materializer
      && same(value.root_refs, [rootRef]) && same(value.record_refs, [rootRef]) && same(value.entry_byte_path, [...ENTRY_PATH])
      && same(value.source_observations, sourceObservations) && typeof value.revision === 'string' && UUID.test(value.revision),
    );
    return {
      schema: 'selection-materialization-result/v1',
      root_refs: [rootRef],
      records: [{ ...rootRef, ...fields }],
      entry_byte_path: ENTRY_PATH,
      authority_ref: { address: authorityAddress, revision: persistedAuthority.value.revision as string, object_hash: persistedAuthority.hash },
    };
  } catch (error) {
    return { schema: 'selection-materialization-result/v1', error: error instanceof Error ? error.message : 'selection materialization failed' };
  }
}
