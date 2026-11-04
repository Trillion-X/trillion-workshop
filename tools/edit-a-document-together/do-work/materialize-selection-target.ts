// The composition owner turns its local scene selection into one immutable,
// self-contained projection. Callers receive proven Engine identities plus a
// browser entry descriptor; they never receive a mutable source scene as a root.

import { createTrustedRuntimeIdMinter, sendRequestToBitfieldTarget } from '#workspace-records';
import {
  buildEngineReadCurrentRequestFromLabels,
  buildEngineWriteBatchRequestFromLabels,
  decodeEngineReadCurrentReply,
  makeHashCodeHexFromBytes,
} from '#workspace-records';
import { serializeSelectionContext } from './serialize-selection-context';
import type { SceneNode } from '../read-data/documents';

type ExactRef = { address: string; revision: string; object_hash: string };
type Sender = typeof sendRequestToBitfieldTarget;
type Plain = Record<string, unknown>;
type ProjectionRecord = ExactRef & {
  kind_ref: string;
  dependency_refs: ExactRef[];
  projection_files: Array<{ path: string[]; integrity_hash: string; executable: boolean; source: { kind: 'inline'; bytes: string } | { kind: 'blob_ref'; hash: string } }>;
  browser_import_bindings: Array<{ specifier: string; path: string[] }>;
  authority: { data_refs: ExactRef[]; subscription_refs: ExactRef[]; target_refs: ExactRef[]; navigation_refs: ExactRef[] };
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET = 'documents.materialize-selection';
const SELECTED_RENDERER_BYTES_ADDRESS = 'package::documents::entry-bytes::selected-composition';
const MAX_TEXT = 512;
const MAX_ROOTS = 64;

function plain(value: unknown): value is Plain {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || encoder.encode(value).byteLength > MAX_TEXT) throw new Error(`invalid ${label}`);
  return value.trim();
}

function only(value: Plain, fields: readonly string[]): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error('untrusted materialization input');
}

function bytes(reply: unknown): Uint8Array | null {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (ArrayBuffer.isView(reply)) return new Uint8Array(reply.buffer, reply.byteOffset, reply.byteLength);
  if (plain(reply) && 'payload' in reply) return bytes(reply.payload);
  return null;
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function inlineFile(path: string[], source: string) {
  const bytes = encoder.encode(source);
  return { path, integrity_hash: makeHashCodeHexFromBytes(bytes), executable: true, source: { kind: 'inline' as const, bytes: Buffer.from(bytes).toString('base64') } };
}

function requestFrom(input: unknown): { partition: string; materializationId: string; sceneAddress: string; nodeIds: string[] } {
  if (!plain(input)) throw new Error('invalid selection materialization request');
  only(input, ['partition_label', 'materialization_id', 'selection']);
  const partition = boundedText(input.partition_label, 'partition_label');
  const materializationId = boundedText(input.materialization_id, 'materialization_id');
  if (!UUID.test(materializationId)) throw new Error('invalid materialization_id');
  if (!plain(input.selection)) throw new Error('invalid owner-local selection');
  only(input.selection, ['scene_address', 'node_ids']);
  const sceneAddress = boundedText(input.selection.scene_address, 'selection.scene_address');
  if (!Array.isArray(input.selection.node_ids) || input.selection.node_ids.length === 0 || input.selection.node_ids.length > MAX_ROOTS) throw new Error('invalid selection.node_ids');
  const nodeIds = input.selection.node_ids.map((id) => boundedText(id, 'selection.node_id'));
  if (new Set(nodeIds).size !== nodeIds.length) throw new Error('duplicate selection.node_id');
  return { partition, materializationId, sceneAddress, nodeIds };
}

async function current(sender: Sender, partition: string, address: string) {
  return decodeEngineReadCurrentReply(bytes(await sender(buildEngineReadCurrentRequestFromLabels(partition, address))) ?? new Uint8Array());
}

function recordFrom(reply: { found?: boolean; payload?: Uint8Array; contentHash?: string }, label: string): { value: Plain; hash: string } {
  if (!reply.found || !reply.payload || !reply.contentHash) throw new Error(`${label} is not resolvable`);
  try {
    const value: unknown = JSON.parse(decoder.decode(reply.payload));
    if (!plain(value)) throw new Error('not object');
    return { value, hash: reply.contentHash };
  } catch { throw new Error(`${label} is not a structured record`); }
}

function indexNodes(nodes: readonly SceneNode[]): Map<string, { node: SceneNode; parentId: string | null }> {
  const indexed = new Map<string, { node: SceneNode; parentId: string | null }>();
  const visit = (node: SceneNode, parentId: string | null): void => {
    if (!node || typeof node.id !== 'string' || !node.id || indexed.has(node.id)) throw new Error('scene node identity is invalid');
    indexed.set(node.id, { node, parentId });
    for (const child of node.children ?? []) visit(child, node.id);
  };
  for (const node of nodes) visit(node, null);
  return indexed;
}

function selectedRoots(nodeIds: readonly string[], scene: Plain): SceneNode[] {
  if (!Array.isArray(scene.children)) throw new Error('scene has no children');
  const indexed = indexNodes(scene.children as SceneNode[]);
  for (const id of nodeIds) if (!indexed.has(id)) throw new Error('selection node is not resolvable');
  const selected = new Set(nodeIds);
  return nodeIds.filter((id) => {
    let parentId = indexed.get(id)!.parentId;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = indexed.get(parentId)?.parentId ?? null;
    }
    return true;
  }).map((id) => indexed.get(id)!.node);
}

function snapshotAddress(id: string): string { return `package::documents::selection-snapshot::${id}`; }
function authorityAddress(id: string): string { return `package::documents::selection-materialization-authority::${id}`; }
function entryPath(id: string): string[] { return ['selected-composition', id, 'entry.mjs']; }
function ownerPath(id: string): string[] { return ['selected-composition', id, 'selected-owner.mjs']; }

function entryModule(contexts: unknown): string {
  return `import mountOwner from './selected-owner.mjs';\nconst selection={contexts:${JSON.stringify(contexts)}};\nexport default function mount({el}){return mountOwner({el,props:{selection}});}\nexport {mountOwner};\n`;
}

async function createOnly(sender: Sender, partition: string, write: { address: string; payload: unknown; kind: string }): Promise<void> {
  await sender(buildEngineWriteBatchRequestFromLabels([{
    partitionLabel: partition, addressLabel: write.address,
    pathLabels: ['current-item', 'published-record', write.kind],
    payloadBytes: encoder.encode(JSON.stringify(write.payload)), expectedCurrent: { payloadHash: null },
  }]));
}

async function persist(sender: Sender, partition: string, candidate: { address: string; payload: Plain; kind: string }, valid: (value: Plain) => boolean, label: string) {
  let reply = await current(sender, partition, candidate.address);
  if (!reply.found) {
    try { await createOnly(sender, partition, candidate); } catch { /* the mandatory readback decides race outcome */ }
    reply = await current(sender, partition, candidate.address);
  }
  const persisted = recordFrom(reply, label);
  if (!valid(persisted.value)) throw new Error(`${label} conflict`);
  return persisted;
}

/** Owner target. Successful output is the exact, caller-ready
 * `selection-materialization-result/v1` contract; all mutable scene IDs end here. */
export async function materializeCompositionSelectionTarget(
  input: unknown,
  context?: { packageData?: unknown },
  sender: Sender = sendRequestToBitfieldTarget,
): Promise<Plain> {
  try {
    // Revisions are minted from the entropy the runtime drew for this request, so a
    // replay of the same log mints the same two revisions in the same order. A
    // generator this target reached for itself would make the same log produce a
    // different snapshot revision on every run.
    const mintRevision = createTrustedRuntimeIdMinter(context);
    const request = requestFrom(input);
    const source = recordFrom(await current(sender, request.partition, request.sceneAddress), 'scene');
    const rendererReply = await current(sender, request.partition, SELECTED_RENDERER_BYTES_ADDRESS);
    if (!rendererReply.found || !rendererReply.payload || !rendererReply.contentHash) throw new Error('selected renderer bytes are not resolvable');
    const sourceObservations = [
      { address: request.sceneAddress, object_hash: source.hash },
      { address: SELECTED_RENDERER_BYTES_ADDRESS, object_hash: rendererReply.contentHash },
    ];
    const contexts = selectedRoots(request.nodeIds, source.value).map((subtree) => serializeSelectionContext({ subtree, sceneAddress: request.sceneAddress }));
    const path = entryPath(request.materializationId);
    const selectedOwnerPath = ownerPath(request.materializationId);
    const rootAddress = snapshotAddress(request.materializationId);
    const rootRevision = mintRevision();
    const projectionFiles = [
      inlineFile(path, entryModule(contexts)),
      { path: selectedOwnerPath, integrity_hash: rendererReply.contentHash, executable: true, source: { kind: 'blob_ref' as const, hash: rendererReply.contentHash } },
    ];
    const snapshot = {
      address: rootAddress, kind: 'composition-selection-snapshot/v1', version: 1, revision: rootRevision, materialization_id: request.materializationId,
      source_observations: sourceObservations, contexts, entry_byte_path: path, kind_ref: 'documents.selection-snapshot/v1',
      dependency_refs: [], projection_files: projectionFiles, browser_import_bindings: [],
      authority: { data_refs: [], subscription_refs: [], target_refs: [], navigation_refs: [] },
    };
    const snapshotStored = await persist(sender, request.partition, {
      address: rootAddress, kind: 'composition-selection-snapshot', payload: snapshot,
    }, (value) => value.kind === snapshot.kind && value.version === 1 && value.materialization_id === request.materializationId
      && value.address === rootAddress && typeof value.revision === 'string' && UUID.test(value.revision)
      && same(value.source_observations, sourceObservations) && same(value.contexts, snapshot.contexts)
      && same(value.projection_files, projectionFiles) && same(value.entry_byte_path, path), 'selection snapshot');
    const root: ExactRef = { address: rootAddress, revision: snapshotStored.value.revision as string, object_hash: snapshotStored.hash };
    const projection: ProjectionRecord = {
      ...root, kind_ref: 'documents.selection-snapshot/v1', dependency_refs: [],
      projection_files: projectionFiles, browser_import_bindings: [], authority: snapshot.authority,
    };
    const authorityAddressValue = authorityAddress(request.materializationId);
    const authorityRevision = mintRevision();
    const authority = {
      address: authorityAddressValue, kind: 'selection-materialization-authority/v1', version: 1, revision: authorityRevision, materialization_id: request.materializationId,
      materializer: TARGET, source_observations: sourceObservations, root_refs: [root], record_refs: [root], entry_byte_path: path,
    };
    const authorityStored = await persist(sender, request.partition, {
      address: authorityAddressValue, kind: 'selection-materialization-authority', payload: authority,
    }, (value) => value.kind === authority.kind && value.version === 1 && value.materialization_id === request.materializationId && value.materializer === TARGET
      && value.address === authorityAddressValue && typeof value.revision === 'string' && UUID.test(value.revision) && same(value.source_observations, sourceObservations)
      && same(value.root_refs, [root]) && same(value.record_refs, [root]) && same(value.entry_byte_path, path), 'materialization authority');
    return {
      schema: 'selection-materialization-result/v1', root_refs: [root], records: [projection], entry_byte_path: path,
      authority_ref: { address: authorityAddressValue, revision: authorityStored.value.revision as string, object_hash: authorityStored.hash },
    };
  } catch (error) {
    return { schema: 'selection-materialization-result/v1', error: error instanceof Error ? error.message : 'selection materialization failed' };
  }
}
