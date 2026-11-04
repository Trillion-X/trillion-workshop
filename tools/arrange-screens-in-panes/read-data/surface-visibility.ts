import type { LayoutState, SplitTreeNode } from './layout-types';

/** Temporary caller visibility never removes a saved tab or changes its placement. */
export function visibleTabIds(state: LayoutState, tabIds: readonly string[], hidden: ReadonlySet<string> | null): readonly string[] {
  if (!hidden?.size) return tabIds;
  return tabIds.filter(id => {
    const surface = state.tabs[id]?.metadata?.placeable_surface_id;
    return typeof surface !== 'string' || !hidden.has(surface);
  });
}

export function containerIsVisible(state: LayoutState, id: string, hidden: ReadonlySet<string> | null): boolean {
  const group = state.tabGroups[state.containers[id]?.groupId];
  // An intentionally empty pane remains available for placing work.
  return !group?.tabIds.length || visibleTabIds(state, group.tabIds, hidden).length > 0;
}

/** Measurement-only projection. Rendering keeps saved paths for every action. */
export function visibleSplitTree(node: SplitTreeNode, visible: (id: string) => boolean): SplitTreeNode | null {
  if (node.kind === 'leaf') return visible(node.containerId) ? node : null;
  const children: SplitTreeNode[] = [], sizes: number[] = [], crossSizes: (number | null)[] = [];
  node.children.forEach((child, index) => {
    const shown = visibleSplitTree(child, visible);
    if (!shown) return;
    children.push(shown); sizes.push(node.sizes[index]); crossSizes.push(node.crossSizes?.[index] ?? null);
  });
  if (!children.length) return null;
  if (children.length === node.children.length && children.every((child, index) => child === node.children[index])) return node;
  return { ...node, children, sizes, ...(node.crossSizes ? { crossSizes } : {}) };
}
