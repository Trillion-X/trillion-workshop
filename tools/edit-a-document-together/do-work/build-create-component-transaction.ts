// File: documents/do-work/build-create-component-transaction.ts
//
// Purpose
//   Pure transform: turn a SELECTED node subtree into a reusable component
//   DEFINITION (a material-descriptor record) plus the scene patches that REPLACE
//   the selection in place with an INSTANCE node referencing that definition.
//   (Mobbin-grounded affordance: Framer "Create Component", Slite "Add to
//   library" — a selection action that promotes the subtree to the asset/material
//   catalog and leaves a linked instance behind.)
//
// Invariants
//   * Pure: no engine, no IO, no randomness baked in (the caller injects
//     makeDefinitionId). The caller persists `descriptor` on the
//     'documents.material-descriptors' channel and commits `patches`.
//   * The component is just a user-authored MaterialDescriptor — ZERO new
//     insertable primitive (the component catalog IS the material catalog).
//   * The instance REUSES the selected node's id (its parent slot / anchor is
//     preserved; edges/refs to that id still resolve). The definition keeps the
//     selected subtree's ids as its definition-LOCAL ids — overrides and
//     resolution (resolve-component-instances.ts) key by them.
//   * The engine never sees the instance: definition_ref / prop_overrides ride
//     under `props` and the resolver strips them before engine handoff.

import type { SceneNode, ScenePatch } from '../read-data/documents';
import {
  DEFINITION_REF_PROP,
  PROP_OVERRIDES_PROP,
  type ComponentDefinitionRecord,
} from '../read-data/resolve-component-instances';

export type { ComponentDefinitionRecord };

export type CreateComponentResult = {
  descriptor: ComponentDefinitionRecord;
  patches: ScenePatch[];
  definitionId: string;
  instanceId: string;
};

function deepClone(node: SceneNode): SceneNode {
  return {
    ...node,
    props: node.props ? { ...node.props } : node.props,
    style: node.style ? { ...node.style } : node.style,
    children: (node.children ?? []).map(deepClone),
  };
}

function findNode(tree: SceneNode, id: string): SceneNode | null {
  if (tree.id === id) return tree;
  for (const child of tree.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function findParent(tree: SceneNode, id: string): { parentId: string; index: number } | null {
  const kids = tree.children ?? [];
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].id === id) return { parentId: tree.id, index: i };
    const found = findParent(kids[i], id);
    if (found) return found;
  }
  return null;
}

function matchTermsFor(name: string): string[] {
  const lower = name.toLowerCase().trim();
  return Array.from(new Set([name, lower, ...lower.split(/\s+/).filter(Boolean)]));
}

/**
 * Build the create-component transaction, or null when the selection cannot be
 * componentized (no tree, selection not found, or the scene root itself).
 */
export function buildCreateComponentTransaction(input: {
  tree: SceneNode | null;
  selectedNodeId: string;
  name: string;
  makeDefinitionId: () => string;
}): CreateComponentResult | null {
  const { tree, selectedNodeId, name, makeDefinitionId } = input;
  if (!tree) return null;
  const selected = findNode(tree, selectedNodeId);
  if (!selected || selected.id === tree.id) return null; // cannot componentize the scene root
  const where = findParent(tree, selectedNodeId);
  if (!where) return null;

  const definitionId = makeDefinitionId();
  const label = name.trim() || 'Component';
  const descriptor: ComponentDefinitionRecord = {
    id: definitionId,
    label,
    match_terms: matchTermsFor(label),
    node: deepClone(selected), // definition-local ids == selected subtree ids
    group: 'Components',
  };

  const instance: SceneNode = {
    id: selectedNodeId, // reuse the slot/anchor id
    kind: selected.kind,
    props: { [DEFINITION_REF_PROP]: definitionId, [PROP_OVERRIDES_PROP]: {} },
    visible: true,
    children: [],
  };

  return {
    descriptor,
    patches: [
      { type: 'REMOVE_SUBTREE', node_id: selectedNodeId },
      { type: 'INSERT_NODE', parent_id: where.parentId, index: where.index, node: instance },
    ],
    definitionId,
    instanceId: selectedNodeId,
  };
}
