import {
  applyScenePatch,
  DOCUMENTS_SCENE_ROOT_ID,
  type ApplyScenePatchReceipt,
} from './apply-scene-patch';
import type { SceneNode, ScenePatch } from '../read-data/documents';
import type { DocumentsSceneTargetDependencies } from './scene-target-runtime';
import type { BitfieldRuntimeContext } from '#workspace-records';
import { readDocumentsScene } from './read-scene-target';

export type AppendSceneRootsRequest = {
  document_ref: string;
  expected_document_hash: string;
  roots: SceneNode[];
};

const MAX_ROOTS = 128;
const MAX_NODES = 10_000;
const MAX_DEPTH = 128;

/** Documents-owned translation from decoded scene roots into its internal patch algebra. */
export async function appendSceneRoots(
  input: AppendSceneRootsRequest,
  context?: BitfieldRuntimeContext,
  dependencies: DocumentsSceneTargetDependencies = {},
): Promise<ApplyScenePatchReceipt> {
  validateRoots(input?.roots);
  const current = await readDocumentsScene({ document_ref: input.document_ref }, context, dependencies);
  if (current.document_hash !== input.expected_document_hash) {
    return {
      schema: 'documents.scene-patch-apply.receipt', status: 'conflict', document_ref: current.document_ref,
      expected_document_hash: input.expected_document_hash, current_document_hash: current.document_hash,
      write_count: 0, changed_path_refs: [], reason: 'document-hash-mismatch',
    };
  }
  const currentRoots = current.content?.children ?? [];
  const existingIds = sceneNodeIds(currentRoots);
  const missingRoots: SceneNode[] = [];
  for (const node of input.roots) {
    const existingRoot = currentRoots.find((root) => root.id === node.id);
    if (existingRoot && JSON.stringify(existingRoot) === JSON.stringify(node)) continue;
    if ([...sceneNodeIds([node])].some((id) => existingIds.has(id))) {
      return {
        schema: 'documents.scene-patch-apply.receipt', status: 'conflict', document_ref: current.document_ref,
        expected_document_hash: input.expected_document_hash, current_document_hash: current.document_hash,
        write_count: 0, changed_path_refs: [], reason: 'scene-node-id-conflict',
      };
    }
    missingRoots.push(node);
  }
  if (missingRoots.length === 0) {
    return {
      schema: 'documents.scene-patch-apply.receipt', status: 'success', document_ref: current.document_ref,
      expected_document_hash: input.expected_document_hash, current_document_hash: current.document_hash,
      write_count: 0, changed_path_refs: [], reason: 'scene-roots-already-present',
      ...(current.document_hash ? { new_document_hash: current.document_hash, scene_revision: current.document_hash } : {}),
    };
  }
  const patches: ScenePatch[] = missingRoots.map((node) => ({
    type: 'INSERT_NODE',
    parent_id: DOCUMENTS_SCENE_ROOT_ID,
    index: Number.MAX_SAFE_INTEGER,
    node,
  }));
  return applyScenePatch({
    document_ref: input.document_ref,
    expected_document_hash: input.expected_document_hash,
    scene_patches: patches,
  }, context, dependencies);
}

function sceneNodeIds(roots: readonly SceneNode[]): Set<string> {
  const ids = new Set<string>(); const stack = [...roots];
  while (stack.length > 0) { const node = stack.pop()!; ids.add(node.id); for (const child of node.children ?? []) stack.push(child); }
  return ids;
}

function validateRoots(value: unknown): asserts value is SceneNode[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROOTS) {
    throw new Error('roots must be a bounded non-empty array');
  }
  const ids = new Set<string>();
  const active = new WeakSet<object>();
  const stack = value.map((node) => ({ node, depth: 0, leave: false }));
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!current.node || typeof current.node !== 'object' || Array.isArray(current.node)) throw new Error('scene node must be an object');
    if (current.leave) { active.delete(current.node); continue; }
    if (active.has(current.node)) throw new Error('scene roots must not contain cycles');
    if (current.depth > MAX_DEPTH) throw new Error('scene roots exceed depth limit');
    count += 1;
    if (count > MAX_NODES) throw new Error('scene roots exceed node limit');
    if (typeof current.node.id !== 'string' || !current.node.id || typeof current.node.kind !== 'string' || !current.node.kind) {
      throw new Error('scene node identity is invalid');
    }
    if (ids.has(current.node.id)) throw new Error('scene node ids must be unique');
    ids.add(current.node.id);
    active.add(current.node);
    stack.push({ node: current.node, depth: current.depth, leave: true });
    const children = current.node.children;
    if (children !== undefined && !Array.isArray(children)) throw new Error('scene node children must be an array');
    for (let index = (children?.length ?? 0) - 1; index >= 0; index -= 1) {
      stack.push({ node: children![index]!, depth: current.depth + 1, leave: false });
    }
  }
}
