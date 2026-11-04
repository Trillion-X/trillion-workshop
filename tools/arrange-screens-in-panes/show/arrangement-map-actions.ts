import type { SplitTreeNode } from '../read-data/layout-types'
import type { ArrangementNavigatorPane, ArrangementMapPoint } from './ArrangementNavigator'

export type PaneMapEdge = 'left' | 'right' | 'top' | 'bottom'

export type PaneResizeTarget = {
  path: number[]
  dir: 'row' | 'column'
  containerIndex: number
  neighborIndex: number
}

export function edgeAtPanePoint(pane: ArrangementNavigatorPane, point: ArrangementMapPoint): PaneMapEdge {
  const distances: Array<[PaneMapEdge, number]> = [
    ['left', Math.abs(point.x - pane.left)],
    ['right', Math.abs(pane.left + pane.width - point.x)],
    ['top', Math.abs(point.y - pane.top)],
    ['bottom', Math.abs(pane.top + pane.height - point.y)],
  ]
  return distances.reduce((best, next) => next[1] < best[1] ? next : best)[0]
}

/** Find the closest split edge that can resize this pane in the tiled tree. */
export function paneResizeTarget(
  root: SplitTreeNode | null,
  containerId: string,
  edge: PaneMapEdge,
): PaneResizeTarget | null {
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'column'
  const towardPrevious = edge === 'left' || edge === 'top'
  let nearest: PaneResizeTarget | null = null

  const visit = (node: SplitTreeNode, path: number[]): boolean => {
    if (node.kind === 'leaf') return node.containerId === containerId
    for (let index = 0; index < node.children.length; index += 1) {
      const childPath = [...path, index]
      if (!visit(node.children[index], childPath)) continue
      if (node.dir === dir && !nearest) {
        const neighborIndex = index + (towardPrevious ? -1 : 1)
        if (neighborIndex >= 0 && neighborIndex < node.children.length) {
          nearest = { path, dir, containerIndex: index, neighborIndex }
        }
      }
      return true
    }
    return false
  }

  if (root) visit(root, [])
  return nearest
}

/** Move a pane's side and its adjacent sibling by a bounded pixel delta. */
export function resizedSplitSizes(
  current: readonly number[],
  containerIndex: number,
  neighborIndex: number,
  growBy: number,
  minimums: readonly number[],
): number[] | null {
  if (current.length < 2 || current.length !== minimums.length
    || !current.every((size) => Number.isFinite(size) && size > 0)
    || !Number.isFinite(growBy)
    || containerIndex < 0 || containerIndex >= current.length
    || neighborIndex < 0 || neighborIndex >= current.length
    || Math.abs(containerIndex - neighborIndex) !== 1) return null

  const sizes = [...current]
  const minimumContainer = Math.max(1, minimums[containerIndex] || 1)
  const minimumNeighbor = Math.max(1, minimums[neighborIndex] || 1)
  const lower = minimumContainer - sizes[containerIndex]
  const upper = sizes[neighborIndex] - minimumNeighbor
  if (lower > upper) return null
  const delta = Math.max(lower, Math.min(growBy, upper))
  if (!Number.isFinite(delta) || delta === 0) return null
  sizes[containerIndex] += delta
  sizes[neighborIndex] -= delta
  return sizes
}
