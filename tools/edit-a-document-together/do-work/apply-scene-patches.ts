// File: documents/do-work/apply-scene-patches.ts
//
// Purpose
//   Pure application of ScenePatches to a SceneNode tree — the surface uses this
//   to maintain the AUTHORED compact SSOT tree (the one persisted), which is NOT
//   the engine's job (the engine lays out the RESOLVED tree). This is structure +
//   props only; layout/geometry remain the engine's truth. Mirrors the engine's
//   structural patch semantics so the authored tree stays consistent with what the
//   engine renders for non-instance nodes (where authored id == resolved id).
//
// Invariants
//   * Pure: returns a new tree, never mutates input.
//   * Unknown / unfindable targets are no-ops (defensive — never throw on a patch
//     that doesn't apply, e.g. an instance-internal id absent from the authored tree).

import type { SceneNode, ScenePatch } from '../read-data/documents';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function mapNode(node: SceneNode, id: string, fn: (n: SceneNode) => SceneNode): SceneNode {
  if (node.id === id) return fn(node);
  const kids = node.children ?? [];
  if (kids.length === 0) return node;
  return { ...node, children: kids.map((c) => mapNode(c, id, fn)) };
}

function removeSubtree(node: SceneNode, id: string): SceneNode {
  const kids = node.children ?? [];
  return { ...node, children: kids.filter((c) => c.id !== id).map((c) => removeSubtree(c, id)) };
}

function insertInto(node: SceneNode, parentId: string, index: number, child: SceneNode): SceneNode {
  if (node.id === parentId) {
    const kids = [...(node.children ?? [])];
    kids.splice(Math.max(0, Math.min(index, kids.length)), 0, child);
    return { ...node, children: kids };
  }
  return { ...node, children: (node.children ?? []).map((c) => insertInto(c, parentId, index, child)) };
}

function findNode(node: SceneNode, id: string): SceneNode | null {
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

function applyOne(tree: SceneNode, patch: ScenePatch): SceneNode {
  switch (patch.type) {
    case 'SET_ROOT':
      return patch.node;
    case 'UPDATE_PROPS':
      return mapNode(tree, patch.node_id, (n) => {
        let next = n;
        if (patch.changes.props) next = { ...next, props: { ...asRecord(next.props), ...patch.changes.props } };
        if (typeof patch.changes.visible === 'boolean') next = { ...next, visible: patch.changes.visible };
        return next;
      });
    case 'REMOVE_SUBTREE':
      return removeSubtree(tree, patch.node_id);
    case 'INSERT_NODE':
      return insertInto(tree, patch.parent_id, patch.index, patch.node);
    case 'MOVE_NODE': {
      const moving = findNode(tree, patch.node_id);
      if (!moving) return tree;
      return insertInto(removeSubtree(tree, patch.node_id), patch.new_parent_id, patch.new_index, moving);
    }
    case 'REORDER_CHILDREN':
      return mapNode(tree, patch.parent_id, (n) => {
        const byId = new Map((n.children ?? []).map((c) => [c.id, c] as const));
        const ordered = patch.new_order.map((id) => byId.get(id)).filter((c): c is SceneNode => Boolean(c));
        const rest = (n.children ?? []).filter((c) => !patch.new_order.includes(c.id));
        return { ...n, children: [...ordered, ...rest] };
      });
    default:
      return tree;
  }
}

/** Apply a sequence of ScenePatches to a tree, in order. Pure. A null tree is an
 * empty composition: it has no root to attach children to, so only SET_ROOT can
 * establish the first root. This is why the very first page is created via
 * SET_ROOT (INSERT_NODE has no parent to attach to until a root exists). Once a
 * root exists, every patch (including further INSERT_NODE) applies normally. */
export function applyScenePatches(tree: SceneNode | null, patches: ScenePatch[]): SceneNode | null {
  return patches.reduce<SceneNode | null>((acc, patch) => {
    if (!acc) return patch.type === 'SET_ROOT' ? patch.node : acc;
    return applyOne(acc, patch);
  }, tree);
}
