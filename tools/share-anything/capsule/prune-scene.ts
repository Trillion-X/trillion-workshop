// packages/public-scene-share/capsule/prune-scene.ts
//
// The presentation descriptor's `root` mechanism: scope a scene to a single
// sub-root so a shared capsule carries ONLY that view (e.g. "just the workspace",
// "just this board") — not the whole studio scene. This is the content half of
// the share mandate ("a document / a board / a presentation"), complementing the
// chrome half (the subtractive ChromeVisibilityMap, which hides shell at render):
// prune decides what is IN the capsule; chrome decides what of it renders.
//
// BLIND (L090): the walk depends ONLY on `id` (match) + `children` (recursion).
// It NEVER switches on a node's `kind`/`component_id`/taxonomy — a node kind
// invented tomorrow is scoped for free. Returning the matched node AS the new
// scene root keeps the result a valid scene tree the format-blind closure builder
// walks unchanged. Fail-closed: an unknown root id returns null (the caller
// refuses to mint rather than silently sharing the whole scene).

interface SceneNodeLike {
  readonly id?: unknown;
  readonly children?: unknown;
}

function asNode(value: unknown): SceneNodeLike | null {
  return value && typeof value === 'object' ? (value as SceneNodeLike) : null;
}

/**
 * Return the subtree rooted at the node whose `id === rootNodeId` (that node
 * becomes the new scene root), or null if no such node exists. Pure + blind.
 */
export function pruneSceneToRoot(sceneTree: unknown, rootNodeId: string): unknown | null {
  const visit = (value: unknown): unknown | null => {
    const node = asNode(value);
    if (!node) return null;
    if (node.id === rootNodeId) return value;
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        const found = visit(child);
        if (found != null) return found;
      }
    }
    return null;
  };
  return visit(sceneTree);
}

/** The top-level shareable roots of a scene: each child of the scene tree's root,
 *  as `{ id, label }` (label from a configured prop field, else the id). DATA-driven
 *  picker source — the UI never hardcodes a root id (no Society / instance-solving). */
export interface ShareableRoot {
  readonly id: string;
  readonly label: string;
}

export interface ListRootsConfig {
  /** Prop field under `props` to read a human label from (else the id is used). */
  readonly labelField?: string;
}

export function listShareableRoots(sceneTree: unknown, config: ListRootsConfig = {}): ShareableRoot[] {
  const root = asNode(sceneTree);
  if (!root || !Array.isArray(root.children)) return [];
  const labelField = config.labelField;
  const out: ShareableRoot[] = [];
  for (const child of root.children) {
    const node = asNode(child);
    if (!node || typeof node.id !== 'string' || !node.id) continue;
    let label = node.id;
    if (labelField) {
      const props = asNode((node as { props?: unknown }).props) as Record<string, unknown> | null;
      const candidate = props?.[labelField];
      if (typeof candidate === 'string' && candidate) label = candidate;
    }
    out.push({ id: node.id, label });
  }
  return out;
}
