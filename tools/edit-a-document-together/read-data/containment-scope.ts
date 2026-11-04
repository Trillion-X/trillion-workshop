// packages/documents/read-data/containment-scope.ts
//
// The CONTAINMENT-SCOPE primitive (L069) — the blind, pure walk that escalating selection (Cmd+A:
// content → block → container → page) configures. It does NOT enumerate a fixed set of scope levels.
// The "levels" ARE the depth of the containment tree at the anchor: a block one level under the page
// escalates block → page (two levels); a block nested three containers deep escalates through all
// three. New nesting depth = more levels for free, ZERO code change (L090 / enum-dissolution). The
// only ceiling is the page root, supplied as DATA (ceilingId). Zero I/O, zero React — unit-testable.

export type ScopeNode = { id: string; children?: readonly ScopeNode[] };

function findNode(root: ScopeNode, id: string): ScopeNode | null {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const found = findNode(c, id);
    if (found) return found;
  }
  return null;
}

function findParentId(root: ScopeNode, id: string): string | null {
  for (const c of root.children ?? []) {
    if (c.id === id) return root.id;
    const deeper = findParentId(c, id);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * The chain of node ids from `anchorId` UP TO AND INCLUDING `ceilingId` (the page root), nearest
 * first: [anchor, container, …, page]. This IS the escalation ladder — Cmd+A steps one rung per
 * press. Returns [] if the anchor isn't under the ceiling (nothing to escalate).
 */
export function ancestorChainToCeiling(root: ScopeNode, anchorId: string, ceilingId: string): string[] {
  const ceiling = findNode(root, ceilingId);
  if (!ceiling || !findNode(ceiling, anchorId)) return [];
  const chain: string[] = [];
  let cursor: string | null = anchorId;
  while (cursor) {
    chain.push(cursor);
    if (cursor === ceilingId) break;
    cursor = findParentId(ceiling, cursor);
  }
  return chain;
}

/** Every descendant id of `id` (inclusive) — the members a container/page selection highlights. */
export function subtreeIds(root: ScopeNode, id: string): string[] {
  const node = findNode(root, id);
  if (!node) return [];
  const out: string[] = [];
  const walk = (n: ScopeNode) => {
    out.push(n.id);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

/**
 * Resolve one escalation step. Given the anchor block, the ceiling (page), and the CURRENT level
 * (0 = content/text, 1 = the anchor block, 2 = its container, …), return the next level plus the
 * node id whose subtree should now be selected (null at level 0 — the browser owns text selection).
 * Levels clamp at the top of the containment chain (the page), so pressing Cmd+A at the page stays.
 */
export function escalateScope(
  root: ScopeNode,
  anchorId: string,
  ceilingId: string,
  currentLevel: number,
): { level: number; targetId: string | null } {
  const chain = ancestorChainToCeiling(root, anchorId, ceilingId);
  if (chain.length === 0) return { level: 0, targetId: null };
  const maxLevel = chain.length; // level 1..chain.length map to chain[0..chain.length-1]
  const level = Math.min(Math.max(currentLevel, 0) + 1, maxLevel);
  return { level, targetId: level >= 1 ? chain[level - 1] : null };
}
