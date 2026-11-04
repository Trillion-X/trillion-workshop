// Pure operations on a split tree.
//
// Why these are separate from anything that draws
//   SplitTreeArranger is already pure: it takes a tree and a function that
//   renders one container, and it emits an intent whenever the person drags,
//   drops or drags a gutter. It deliberately does not change the tree itself.
//   Something has to, and that something is arithmetic on a small recursive
//   structure, so it belongs here where it can be tested without a browser.
//
// Why they take and return whole trees
//   Every operation returns a new tree and never mutates its argument. The
//   caller decides what to do with the result: render it, persist it, throw it
//   away. That makes an undo stack a list of previous return values rather than
//   a feature anyone has to build.
//
// What a container is
//   A string id and nothing else. These functions never look inside one, never
//   ask what it shows, and never care whether it is a video, a table or
//   something added next year. The tree is placement; contents belong to
//   whoever passes renderContainer.

import type {LeafNode, SplitNode, SplitTreeNode} from './layout-types'
import {paneSizesNow} from './pane-sizes.ts'

/** Which side of a frame or container a drop landed on. */
export type Edge = 'left' | 'right' | 'top' | 'bottom'

const DIRECTION_OF: Record<Edge, 'row' | 'column'> = {
  left: 'row', right: 'row', top: 'column', bottom: 'column',
}

/** A dropped container goes before its target on these edges, after on the rest. */
const BEFORE_TARGET: ReadonlySet<Edge> = new Set<Edge>(['left', 'top'])

export function isLeaf(node: SplitTreeNode): node is LeafNode {
  return node.kind === 'leaf'
}

export function leaf(containerId: string): LeafNode {
  return {kind: 'leaf', containerId}
}

/** Every container id in the tree, in the order a reader would meet them. */
export function containerIds(node: SplitTreeNode | null): string[] {
  if (!node) return []
  if (isLeaf(node)) return [node.containerId]
  return node.children.flatMap(containerIds)
}

/** Sizes that sum to exactly 1, so a split never leaves or claims a sliver. */
function evenSizes(count: number): number[] {
  if (count <= 0) return []
  const each = 1 / count
  return Array.from({length: count}, (_, index) => (index === count - 1 ? 1 - each * (count - 1) : each))
}

function split(dir: 'row' | 'column', children: SplitTreeNode[]): SplitNode {
  return {kind: 'split', dir, children, sizes: evenSizes(children.length)}
}

/** Split one pane in two: the newcomer takes the person's new-pane share (read-data/pane-sizes.ts) of it. */
function splitWithNewcomer(dir: 'row' | 'column', node: SplitTreeNode, added: SplitTreeNode, before: boolean): SplitNode {
  const share = Math.min(0.95, Math.max(0.05, paneSizesNow().new_pane_share_percent / 100))
  return {kind: 'split', dir, children: before ? [added, node] : [node, added], sizes: before ? [share, 1 - share] : [1 - share, share]}
}

/**
 * Put `containerId` against one edge of the whole frame.
 *
 * An empty tree becomes a single leaf rather than a split with one child,
 * because a split with one child has a gutter the person can drag that does
 * nothing.
 */
export function addContainerAtEdge(root: SplitTreeNode | null, edge: Edge, containerId: string): SplitTreeNode {
  const added = leaf(containerId)
  if (!root) return added
  const dir = DIRECTION_OF[edge]
  const before = BEFORE_TARGET.has(edge)
  // Growing an existing split in the same direction keeps the tree flat.
  // Nesting instead would still render correctly but gives the person a gutter
  // that resizes a group rather than the pane they are pointing at.
  if (!isLeaf(root) && root.dir === dir) {
    const next = before ? [added, ...root.children] : [...root.children, added]
    if (root.sizeUnit !== 'px') return split(dir, next)
    // Pixel sizes belong to the panes that already have them. The newcomer
    // matches the pane it lands against, and the arrangement grows by that much.
    const neighbour = before ? root.sizes[0] : root.sizes[root.sizes.length - 1]
    const sizes = before ? [neighbour, ...root.sizes] : [...root.sizes, neighbour]
    return {...root, children: next, sizes}
  }
  return splitWithNewcomer(dir, root, added, before)
}

/**
 * Put `containerId` against one edge of an existing container, splitting that
 * container's space rather than the whole frame.
 *
 * When the container sits in a pixel-sized split running the same way, the
 * newcomer joins that split at the container's size instead: nothing already
 * on screen gives up any room, and the arrangement grows.
 */
export function addContainerBeside(
  root: SplitTreeNode | null,
  targetContainerId: string,
  edge: Edge,
  containerId: string,
): SplitTreeNode {
  if (!root) return leaf(containerId)
  if (!containerIds(root).includes(targetContainerId)) return addContainerAtEdge(root, edge, containerId)
  const dir = DIRECTION_OF[edge]
  const added = leaf(containerId)
  const before = BEFORE_TARGET.has(edge)
  const place = (node: SplitTreeNode): SplitTreeNode => {
    if (isLeaf(node)) {
      return node.containerId === targetContainerId ? splitWithNewcomer(dir, node, added, before) : node
    }
    const at = node.children.findIndex(child => isLeaf(child) && child.containerId === targetContainerId)
    if (at >= 0 && node.dir === dir && node.sizeUnit === 'px') {
      const insertAt = before ? at : at + 1
      const children = [...node.children.slice(0, insertAt), added, ...node.children.slice(insertAt)]
      const sizes = [...node.sizes.slice(0, insertAt), node.sizes[at], ...node.sizes.slice(insertAt)]
      return {...node, children, sizes}
    }
    return {...node, children: node.children.map(place)}
  }
  return place(root)
}

/** Take a container out of the tree, collapsing any split left with one child. */
export function removeContainer(root: SplitTreeNode | null, containerId: string): SplitTreeNode | null {
  if (!root) return null
  if (isLeaf(root)) return root.containerId === containerId ? null : root
  const kept: SplitTreeNode[] = []
  const keptSizes: number[] = []
  root.children.forEach((child, index) => {
    const next = removeContainer(child, containerId)
    if (!next) return
    kept.push(next)
    keptSizes.push(root.sizes[index] ?? 0)
  })
  if (kept.length === 0) return null
  // A split with one child is a gutter that does nothing, so it collapses into
  // whatever it was wrapping.
  if (kept.length === 1) return kept[0]
  // A pixel size belongs to its pane, so the panes that remain keep theirs and
  // the arrangement simply gets shorter.
  if (root.sizeUnit === 'px') return {...root, children: kept, sizes: keptSizes}
  const total = keptSizes.reduce((sum, one) => sum + one, 0)
  // Shares are renormalised rather than reset, so the panes that remain keep
  // their relative widths instead of jumping back to even.
  const sizes = total > 0 ? keptSizes.map(one => one / total) : evenSizes(kept.length)
  return {...root, children: kept, sizes}
}

/** Exchange two containers' positions, leaving every size where it was. */
export function swapContainers(root: SplitTreeNode | null, a: string, b: string): SplitTreeNode | null {
  if (!root || a === b) return root
  const swap = (node: SplitTreeNode): SplitTreeNode => {
    if (isLeaf(node)) {
      if (node.containerId === a) return leaf(b)
      if (node.containerId === b) return leaf(a)
      return node
    }
    return {...node, children: node.children.map(swap)}
  }
  return swap(root)
}

/** Move a container to a new home in one step, so the tree is never mid-move. */
export function moveContainer(
  root: SplitTreeNode | null,
  containerId: string,
  targetContainerId: string,
  edge: Edge,
): SplitTreeNode | null {
  if (containerId === targetContainerId) return root
  const without = removeContainer(root, containerId)
  if (!without) return leaf(containerId)
  return addContainerBeside(without, targetContainerId, edge, containerId)
}

/** The split node at `path`, walking children by index from the root. */
function nodeAt(root: SplitTreeNode, path: number[]): SplitTreeNode | null {
  let node: SplitTreeNode = root
  for (const index of path) {
    if (isLeaf(node)) return null
    const next = node.children[index]
    if (!next) return null
    node = next
  }
  return node
}

function replaceAt(root: SplitTreeNode, path: number[], make: (found: SplitNode) => SplitNode): SplitTreeNode {
  if (path.length === 0) return isLeaf(root) ? root : make(root)
  if (isLeaf(root)) return root
  const [index, ...rest] = path
  const child = root.children[index]
  if (!child) return root
  return {...root, children: root.children.map((one, at) => (at === index ? replaceAt(one, rest, make) : one))}
}

/**
 * Give the split at `path` these child sizes, in layout pixels.
 *
 * The renderer measures and clamps; this only records the result. A split
 * measured in pixels keeps every pane exactly as large as it was made, so a
 * resize of one pane never moves space out of another. Sizes that do not name
 * one finite positive value per child change nothing.
 */
export function sizeSplitInPixels(
  root: SplitTreeNode | null,
  path: number[],
  sizesPx: number[],
): SplitTreeNode | null {
  if (!root) return root
  const target = nodeAt(root, path)
  if (!target || isLeaf(target)) return root
  if (sizesPx.length !== target.children.length) return root
  if (!sizesPx.every(size => Number.isFinite(size) && size > 0)) return root
  return replaceAt(root, path, found => ({...found, sizes: [...sizesPx], sizeUnit: 'px'}))
}
