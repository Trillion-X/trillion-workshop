import { makeHashCodeHexFromBytes } from '#workspace-records';
import { applyScenePatches } from 'trillion-workshop/tools/edit-a-document-together/do-work/apply-scene-patches.ts';
import {
  CompositionSaveUnverifiedError,
  CompositionWriteConflictError,
  createCompositionDocumentsLogStore,
  type CompositionDocumentSnapshot,
  type CompositionDocumentsLogStore,
} from './write-composition-documents';
import type { CompositionContent, SceneNode, ScenePatch } from '../read-data/documents';
import {
  readTrustedRuntimeClockMs,
  readTrustedRuntimePartition,
  type BitfieldRuntimeContext,
} from '#workspace-records';
import {
  documentsSceneRef,
  documentsSceneAddressMode,
  type DocumentsSceneTargetDependencies,
} from 'trillion-workshop/tools/edit-a-document-together/do-work/scene-target-runtime.ts';

/** A Documents-local virtual parent for a CompositionContent forest. */
export const DOCUMENTS_SCENE_ROOT_ID = '__documents_composition_root__';

type SelectionRevisionReader = (documentRef: string) => Promise<string | null>;
type DocumentsStoreFactory = NonNullable<DocumentsSceneTargetDependencies['createStore']>;

export type ApplyScenePatchRequest = {
  /** Injected/trusted Documents address. It must equal this operation's bound document. */
  document_ref: string;
  scene_address_mode?: 'label_hash' | 'identity_text';
  /** Exact hash from the caller's authoritative Documents readback. */
  expected_document_hash: string;
  /** Partial edits expressed in the existing Documents scene-patch algebra. */
  scene_patches: ScenePatch[];
  /** Selection-scoped edits must carry this exact, trusted-context revision. */
  selection_revision?: string;
  /** Declares that the patch is selection-scoped; no selection state is stored here. */
  selection_node_ids?: string[];
};

export type ScenePatchPathRef = {
  node_id: string;
  path: string[];
};

export type ApplyScenePatchReceipt = {
  schema: 'documents.scene-patch-apply.receipt';
  status: 'success' | 'conflict' | 'unverified';
  document_ref: string;
  expected_document_hash: string;
  current_document_hash: string | null;
  write_count: 0 | 1;
  reason?: string;
  current_selection_revision?: string | null;
  changed_path_refs: ScenePatchPathRef[];
  applied_patch_hash?: string;
  inverse_patches?: ScenePatch[];
  prior_document_hash?: string;
  new_document_hash?: string;
  scene_revision?: string;
  authoritative_readback_refs?: Array<{ document_ref: string; document_hash: string; node_paths: ScenePatchPathRef[] }>;
};

export type ApplyScenePatchOptions = {
  partitionLabel: string;
  documentRef: string;
  /** Clock argument retained by the installed document-store target ABI. */
  readClockMs: () => number;
  readSelectionRevision?: SelectionRevisionReader;
  createStore?: DocumentsStoreFactory;
};

const encoder = new TextEncoder();
const MAX_PATCHES = 256;

/**
 * Creates the Documents-owned operation. The selection reader is intentionally
 * injected by the mounted-surface/context owner: Documents verifies the revision
 * but does not become a second selection-persistence or concurrency owner.
 */
export function createApplyScenePatchOperation(options: ApplyScenePatchOptions): (input: ApplyScenePatchRequest) => Promise<ApplyScenePatchReceipt> {
  const documentRef = nonEmpty(options.documentRef, 'documentRef');
  const partitionLabel = nonEmpty(options.partitionLabel, 'partitionLabel');
  const createStore: DocumentsStoreFactory = options.createStore ?? ((partition, clock, reference, mode) =>
    createCompositionDocumentsLogStore(partition, clock, reference, undefined, mode));

  return async (input) => {
    const invalid = validateRequest(input, documentRef);
    if (invalid) return conflictReceipt(input, documentRef, invalid, null, []);

    const addressMode = documentsSceneAddressMode(input.scene_address_mode);
    const store = createStore(partitionLabel, options.readClockMs, documentRef, addressMode);
    const before = await store.readSnapshot();
    const requestedPathRefs = before.content ? patchPathRefs(before.content, input.scene_patches) : [];
    if (before.documentHash !== input.expected_document_hash) {
      return conflictReceipt(input, documentRef, 'document-hash-mismatch', before.documentHash, requestedPathRefs);
    }
    if (!before.content) return conflictReceipt(input, documentRef, 'document-not-found', before.documentHash, []);

    if (isSelectionScoped(input)) {
      const currentSelectionRevision = options.readSelectionRevision
        ? await options.readSelectionRevision(documentRef)
        : null;
      if (!currentSelectionRevision || currentSelectionRevision !== input.selection_revision) {
        return conflictReceipt(input, documentRef, 'selection-revision-mismatch', before.documentHash, requestedPathRefs, currentSelectionRevision);
      }
    }

    const applied = applyPatchesToContent(before.content, input.scene_patches);
    const changedPathRefs = changedPaths(before.content, applied);
    if (changedPathRefs.length === 0) {
      return conflictReceipt(input, documentRef, 'patch-had-no-authored-effect', before.documentHash, []);
    }
    const inversePatches = deriveInversePatches(before.content, input.scene_patches);

    try {
      await store.write(applied);
    } catch (error) {
      if (error instanceof CompositionWriteConflictError) {
        const current = await safeSnapshot(store);
        return conflictReceipt(input, documentRef, 'document-write-conflict', current?.documentHash ?? null, changedPathRefs);
      }
      if (error instanceof CompositionSaveUnverifiedError) {
        const current = await safeSnapshot(store);
        return {
          ...conflictReceipt(input, documentRef, 'document-write-unverified', current?.documentHash ?? null, changedPathRefs),
          status: 'unverified',
        };
      }
      throw error;
    }

    const verified = await store.readSnapshot();
    if (!verified.content || verified.documentHash === before.documentHash) {
      return conflictReceipt(input, documentRef, 'post-write-readback-mismatch', verified.documentHash, changedPathRefs);
    }
    const readbackPaths = changedPaths(before.content, verified.content);
    if (!sameContent(applied, verified.content)) {
      return conflictReceipt(input, documentRef, 'post-write-readback-mismatch', verified.documentHash, readbackPaths);
    }

    const patchHash = contentHash(input.scene_patches);
    return {
      schema: 'documents.scene-patch-apply.receipt',
      status: 'success',
      document_ref: documentRef,
      expected_document_hash: input.expected_document_hash,
      current_document_hash: verified.documentHash,
      write_count: 1,
      changed_path_refs: readbackPaths,
      applied_patch_hash: patchHash,
      inverse_patches: inversePatches,
      prior_document_hash: before.documentHash,
      new_document_hash: verified.documentHash,
      scene_revision: verified.documentHash,
      authoritative_readback_refs: [{
        document_ref: documentRef,
        document_hash: verified.documentHash,
        node_paths: readbackPaths,
      }],
    };
  };
}

/**
 * Target-shaped entry point. Runtime context supplies trusted partition facts;
 * the action guard binds exact document and selection scope before this target.
 */
export async function applyScenePatch(
  input: ApplyScenePatchRequest,
  context?: BitfieldRuntimeContext,
  dependencies: DocumentsSceneTargetDependencies = {},
): Promise<ApplyScenePatchReceipt> {
  const documentRef = documentsSceneRef(input?.document_ref);
  return createApplyScenePatchOperation({
    partitionLabel: readTrustedRuntimePartition(context),
    documentRef,
    readClockMs: () => readTrustedRuntimeClockMs(context),
    createStore: dependencies.createStore,
    readSelectionRevision: dependencies.selectionRevision === undefined
      ? undefined
      : async () => dependencies.selectionRevision ?? null,
  })(input);
}

function validateRequest(input: ApplyScenePatchRequest, documentRef: string): string | null {
  if (!input || typeof input !== 'object') return 'invalid-request';
  if (input.document_ref !== documentRef) return 'untrusted-document-ref';
  if (!nonEmptyOrNull(input.expected_document_hash)) return 'invalid-expected-document-hash';
  if (!Array.isArray(input.scene_patches) || input.scene_patches.length === 0 || input.scene_patches.length > MAX_PATCHES) return 'invalid-scene-patches';
  if (!input.scene_patches.every(isScenePatch)) return 'invalid-scene-patches';
  if (!isSelectionScoped(input)) return null;
  if (!nonEmptyOrNull(input.selection_revision)) return 'missing-selection-revision';
  if (!Array.isArray(input.selection_node_ids) || input.selection_node_ids.length === 0 || input.selection_node_ids.some((id) => !nonEmptyOrNull(id))) return 'invalid-selection-scope';
  return null;
}

function isSelectionScoped(input: ApplyScenePatchRequest): boolean {
  return input.selection_node_ids !== undefined;
}

function isScenePatch(value: unknown): value is ScenePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'SET_ROOT' || type === 'UPDATE_PROPS' || type === 'REMOVE_SUBTREE'
    || type === 'INSERT_NODE' || type === 'MOVE_NODE' || type === 'REORDER_CHILDREN';
}

function applyPatchesToContent(content: CompositionContent, patches: ScenePatch[]): CompositionContent {
  let root = forestRoot(content.children);
  for (const patch of patches) {
    root = patch.type === 'SET_ROOT'
      ? { ...root, children: [clone(patch.node)] }
      : patch.type === 'REMOVE_SUBTREE' && patch.node_id === DOCUMENTS_SCENE_ROOT_ID
        ? { ...root, children: [] }
        : applyScenePatches(root, [clone(patch)]) ?? root;
  }
  return { ...content, children: root.children ?? [] };
}

/**
 * Derive inverses against the actual authored tree, not an engine-resolved
 * layout. Reversal is calculated patch-by-patch so a remove/move sees exactly
 * the scene state it changed. A full-root inverse is used only when the patch
 * algebra cannot represent restoring an absent optional field.
 */
export function deriveInversePatches(content: CompositionContent, patches: ScenePatch[]): ScenePatch[] {
  let working = clone(content);
  const reverse: ScenePatch[] = [];
  for (const patch of patches) {
    const inverse = inverseForPatch(working, patch);
    const next = applyPatchesToContent(working, [patch]);
    if (!sameContent(working, next)) reverse.unshift(...inverse);
    working = next;
  }
  return reverse;
}

function inverseForPatch(content: CompositionContent, patch: ScenePatch): ScenePatch[] {
  const root = forestRoot(content.children);
  if (patch.type === 'SET_ROOT') return restoreForest(content.children);
  if (patch.type === 'UPDATE_PROPS') {
    const node = findNode(root, patch.node_id);
    if (!node) return [];
    const props = patch.changes.props;
    const missingProp = props && Object.keys(props).some((key) => !(key in (node.props ?? {})));
    const missingVisible = patch.changes.visible !== undefined && node.visible === undefined;
    if (missingProp || missingVisible) return restoreForest(content.children);
    return [{
      type: 'UPDATE_PROPS',
      node_id: patch.node_id,
      changes: {
        ...(props ? { props: Object.fromEntries(Object.keys(props).map((key) => [key, clone((node.props ?? {})[key])] )) } : {}),
        ...(patch.changes.visible !== undefined ? { visible: node.visible as boolean } : {}),
      },
    }];
  }
  if (patch.type === 'REMOVE_SUBTREE') {
    const found = findNodeWithParent(root, patch.node_id);
    return found ? [{ type: 'INSERT_NODE', parent_id: found.parentId, index: found.index, node: clone(found.node) }] : [];
  }
  if (patch.type === 'INSERT_NODE') return [{ type: 'REMOVE_SUBTREE', node_id: patch.node.id }];
  if (patch.type === 'MOVE_NODE') {
    const found = findNodeWithParent(root, patch.node_id);
    return found ? [{ type: 'MOVE_NODE', node_id: patch.node_id, new_parent_id: found.parentId, new_index: found.index }] : [];
  }
  const parent = findNode(root, patch.parent_id);
  return parent ? [{ type: 'REORDER_CHILDREN', parent_id: patch.parent_id, new_order: (parent.children ?? []).map((child) => child.id) }] : [];
}

function restoreForest(children: SceneNode[]): ScenePatch[] {
  if (children.length === 0) return [{ type: 'REMOVE_SUBTREE', node_id: DOCUMENTS_SCENE_ROOT_ID }];
  return [
    { type: 'SET_ROOT', node: clone(children[0]!) },
    ...children.slice(1).map((node, index): ScenePatch => ({ type: 'INSERT_NODE', parent_id: DOCUMENTS_SCENE_ROOT_ID, index: index + 1, node: clone(node) })),
  ];
}

function forestRoot(children: SceneNode[]): SceneNode {
  return { id: DOCUMENTS_SCENE_ROOT_ID, kind: 'documents-root', children: clone(children) };
}

function findNode(node: SceneNode, id: string): SceneNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function findNodeWithParent(root: SceneNode, id: string): { node: SceneNode; parentId: string; index: number } | null {
  for (const [index, child] of (root.children ?? []).entries()) {
    if (child.id === id) return { node: child, parentId: root.id, index };
    const nested = findNodeWithParent(child, id);
    if (nested) return nested;
  }
  return null;
}

function changedPaths(before: CompositionContent, after: CompositionContent): ScenePatchPathRef[] {
  const beforeNodes = indexNodes(before.children);
  const afterNodes = indexNodes(after.children);
  const ids = new Set([...beforeNodes.keys(), ...afterNodes.keys()]);
  return [...ids].sort().flatMap((id) => {
    const prior = beforeNodes.get(id);
    const next = afterNodes.get(id);
    return prior && next && JSON.stringify(prior.node) === JSON.stringify(next.node) && JSON.stringify(prior.path) === JSON.stringify(next.path)
      ? []
      : [{ node_id: id, path: next?.path ?? prior?.path ?? [] }];
  });
}

/** Paths named by a rejected request, so a caller can re-read only the stale region. */
function patchPathRefs(content: CompositionContent, patches: ScenePatch[]): ScenePatchPathRef[] {
  const nodes = indexNodes(content.children);
  const ids = new Set<string>();
  for (const patch of patches) {
    if (patch.type === 'SET_ROOT') ids.add(patch.node.id);
    if (patch.type === 'UPDATE_PROPS' || patch.type === 'REMOVE_SUBTREE' || patch.type === 'MOVE_NODE') ids.add(patch.node_id);
    if (patch.type === 'INSERT_NODE') { ids.add(patch.parent_id); ids.add(patch.node.id); }
    if (patch.type === 'MOVE_NODE') ids.add(patch.new_parent_id);
    if (patch.type === 'REORDER_CHILDREN') ids.add(patch.parent_id);
  }
  return [...ids].sort().map((id) => ({ node_id: id, path: nodes.get(id)?.path ?? [] }));
}

function indexNodes(nodes: SceneNode[]): Map<string, { node: SceneNode; path: string[] }> {
  const indexed = new Map<string, { node: SceneNode; path: string[] }>();
  const visit = (node: SceneNode, path: string[]) => {
    if (node.id !== DOCUMENTS_SCENE_ROOT_ID && !indexed.has(node.id)) indexed.set(node.id, { node, path });
    (node.children ?? []).forEach((child, index) => visit(child, [...path, 'children', String(index)]));
  };
  nodes.forEach((node, index) => visit(node, ['children', String(index)]));
  return indexed;
}

function contentHash(value: unknown): string {
  return makeHashCodeHexFromBytes(encoder.encode(JSON.stringify(value)));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameContent(left: CompositionContent, right: CompositionContent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function safeSnapshot(store: CompositionDocumentsLogStore): Promise<CompositionDocumentSnapshot | null> {
  try { return await store.readSnapshot(); } catch { return null; }
}

function conflictReceipt(
  input: Partial<ApplyScenePatchRequest>,
  documentRef: string,
  reason: string,
  currentDocumentHash: string | null,
  changedPathRefs: ScenePatchPathRef[],
  currentSelectionRevision?: string | null,
): ApplyScenePatchReceipt {
  return {
    schema: 'documents.scene-patch-apply.receipt',
    status: 'conflict',
    document_ref: documentRef,
    expected_document_hash: typeof input.expected_document_hash === 'string' ? input.expected_document_hash : '',
    current_document_hash: currentDocumentHash,
    write_count: 0,
    reason,
    ...(currentSelectionRevision !== undefined ? { current_selection_revision: currentSelectionRevision } : {}),
    changed_path_refs: changedPathRefs,
  };
}

function nonEmpty(value: string, label: string): string {
  if (!nonEmptyOrNull(value)) throw new Error(`Documents ${label} is empty`);
  return value.trim();
}

function nonEmptyOrNull(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
