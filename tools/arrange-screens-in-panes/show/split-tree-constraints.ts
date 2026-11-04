import type { SplitNode, SplitSizeUnit, SplitTreeNode } from '../read-data/layout-types'
import { paneSizesNow } from '../read-data/pane-sizes.ts'

/** The size a pane's screen is laid out at: a narrower or shorter pane shows the part that fits. The person's choice
 *  (read-data/pane-sizes.ts, pane-sizes.json), 320×240 unless changed. */
export function minUsableContainerWidthPx(): number {
  return paneSizesNow().content_minimum_width_px
}
export function minUsableContainerHeightPx(): number {
  return paneSizesNow().content_minimum_height_px
}
/** The smallest a person can drag a pane to along its split, at every screen size: their choice, 20 px unless changed. */
export function paneDragMinimumPx(): number {
  return paneSizesNow().drag_minimum_px
}
/** How far a pane's cut edges fade out: their choice, 28 px unless changed. */
export function paneCutFadePx(): number {
  return paneSizesNow().cut_fade_px
}

export type SplitTreeMinimumSize = { width: number; height: number }

/** What a split's saved sizes measure; layouts saved before pane sizes existed read as shares. */
export function splitSizeUnit(node: SplitNode): SplitSizeUnit {
  return node.sizeUnit === 'px' ? 'px' : 'share'
}

/**
 * Persisted split weights are untrusted at the render boundary. Keep malformed,
 * zero, or effectively-zero weights from collapsing a pane to a blank canvas.
 */
export function renderableSplitShare(value: unknown, childCount: number): number {
  const fallback = 1 / Math.max(1, Math.floor(childCount))
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.max(0.01, value)
}

/**
 * A saved pixel size as it can be drawn: never below what the pane needs to
 * stay usable, and a malformed value reads as exactly that minimum.
 */
export function renderablePanePx(value: unknown, minimumPx: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return minimumPx
  return Math.max(minimumPx, value)
}

/** A content-fitted pane follows its furthest natural extent; only a pane with no content gets the new-pane size. */
export function fittedContentLengthPx(endPx: number, hasContent: boolean, emptyPanePx: number): number {
  if (!hasContent) return Math.max(0, Math.ceil(emptyPanePx))
  return Math.ceil(endPx > 0 ? endPx + 2 : 0)
}

/**
 * The smallest length a person can drag a pane to along a split's axis: the
 * drag minimum, or more when what the pane holds needs more (a split inside it
 * keeps each of its own panes at the drag minimum). The same along both axes.
 */
export function draggablePaneMinimumPx(_row: boolean, childMinimumAlong: number): number {
  return Math.max(childMinimumAlong, paneDragMinimumPx())
}

export type PaneResize = {
  /** Every child's size after the change, in layout pixels. */
  sizes: number[]
  /** True when the pane stopped at its minimum instead of where it was asked to go. */
  atMinimum: boolean
}

/**
 * Change one pane's size inside the stage it sits in. The panes after it give
 * up or take the difference first, then the panes before it, each down to its
 * own minimum, so the split stays exactly as long as the stage and no pane is
 * pushed past the window's edge. Only when every other pane is at its minimum
 * does the dragged pane stop short of where it was asked to go. When even the
 * minima do not fit, every pane stays at its minimum and the arrangement
 * scrolls.
 */
export function resizePaneInStage(
  currentPx: readonly number[],
  index: number,
  requestedPx: number,
  minimumsPx: readonly number[],
  stagePx: number,
): PaneResize {
  const sizes = [...currentPx]
  if (index < 0 || index >= sizes.length || !Number.isFinite(requestedPx) || !Number.isFinite(stagePx)) {
    return { sizes, atMinimum: false }
  }
  const minimumOf = (at: number) => minimumsPx[at] ?? 0
  sizes[index] = Math.max(minimumOf(index), requestedPx)
  let difference = stagePx - sizes.reduce((total, size) => total + size, 0)
  const givers = [
    ...sizes.map((_, at) => at).filter((at) => at > index),
    ...sizes.map((_, at) => at).filter((at) => at < index).reverse(),
    index,
  ]
  for (const at of givers) {
    if (Math.abs(difference) < 0.5) break
    const next = Math.max(minimumOf(at), sizes[at] + difference)
    difference -= next - sizes[at]
    sizes[at] = next
  }
  return { sizes, atMinimum: requestedPx <= minimumOf(index) }
}

/**
 * The smallest canvas that shows every saved pane usably at its saved size.
 *
 * Panes fit the stage's height: a pane scrolls inside itself, so it asks the
 * stage for no height of its own and a share split of any depth divides the
 * window instead of growing past it. Across the stage a pane asks only for the
 * drag minimum: a narrower pane shows the part of its screen that fits.
 *
 * Every split fills whatever it is given, so it only needs the sum of its
 * children's minima. A pixel split is drawn in proportion to its saved sizes
 * (a size dragged on a wider window scales down to fit a narrower one), so it
 * too asks only for its children's draggable minima. A split that keeps its
 * lengths asks for every child at its saved length, and a child with its own
 * length across the split asks for that thickness: both make the arrangement
 * scroll instead of squeezing a pane.
 */
export function minimumSplitTreeSize(node: SplitTreeNode, gapPx = 0): SplitTreeMinimumSize {
  if (node.kind === 'leaf') {
    return { width: paneDragMinimumPx(), height: 0 }
  }

  const children = node.children.map((child) => minimumSplitTreeSize(child, gapPx))
  // Desktop split rendering places a zero-width resize handle between every
  // pair of panes. `gap-1` therefore contributes two flex gaps per boundary.
  const splitGaps = Math.max(0, children.length - 1) * gapPx * 2
  const row = node.dir === 'row'
  const along = (size: SplitTreeMinimumSize) => (row ? size.width : size.height)
  const across = (size: SplitTreeMinimumSize) => (row ? size.height : size.width)
  // Child min-widths are hard flex constraints. Once a child reaches its
  // minimum, CSS flex distributes remaining space among its siblings, so a
  // share split's floor is the sum of child minima. Dividing by saved
  // flex-grow weights would treat every ratio as a hard pixel allocation;
  // nested 1% weights once inflated a 13-pane canvas into hundreds of
  // thousands of pixels. A pixel split is drawn in proportion too, so its
  // floor is each child's draggable minimum.
  const pixels = splitSizeUnit(node) === 'px'
  const kept = pixels && node.keepLengths === true
  const length = children.reduce((total, child, index) => total + (pixels
    ? (kept ? renderablePanePx(node.sizes[index], draggablePaneMinimumPx(row, along(child))) : draggablePaneMinimumPx(row, along(child)))
    : along(child)), 0) + splitGaps
  const thickness = Math.max(...children.map((child, index) => Math.max(across(child), paneCrossPx(node, index) ?? 0)))
  return row ? { width: length, height: thickness } : { width: thickness, height: length }
}

/**
 * A child's own length across its split (its height in a row, its width in a column) as it is drawn: never below
 * the drag minimum; null when it fills the split, as every child did before cross lengths existed.
 */
export function paneCrossPx(node: SplitNode, index: number): number | null {
  const value = node.crossSizes?.[index]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.max(paneDragMinimumPx(), value)
}

/** The tree as drawn on a stage `stageWidthPx` wide: every row with a `stackBelow` wider than the stage is drawn as a
 *  stack, each child at its own length across the row (its saved height) or else at its content's height (a pixel
 *  length of 0), the stack kept at those lengths so the arrangement scrolls. `stacked` names the path of every row drawn stacked (paths are unchanged, so an
 *  edit on the drawn tree finds its saved split). A tree with nothing stacked is returned as it is. */
export function drawnSplitTree(root: SplitTreeNode, stageWidthPx: number, stacksBelow?: (row: SplitNode) => number | undefined): { root: SplitTreeNode; stacked: ReadonlySet<string> } {
  const stacked = new Set<string>()
  const draw = (node: SplitTreeNode, path: number[]): SplitTreeNode => {
    if (node.kind !== 'split') return node
    const children = node.children.map((child, index) => draw(child, [...path, index]))
    const below = node.dir === 'row' ? node.stackBelow ?? stacksBelow?.(node) : undefined
    const stack = typeof below === 'number' && stageWidthPx > 0 && stageWidthPx < below
    if (!stack) return children.every((child, index) => child === node.children[index]) ? node : { ...node, children }
    stacked.add(path.join('.'))
    return {
      kind: 'split',
      dir: 'column',
      sizeUnit: 'px',
      keepLengths: true,
      sizes: node.children.map((_, index) => paneCrossPx(node, index) ?? 0),
      children,
    }
  }
  const drawn = draw(root, [])
  return { root: stacked.size ? drawn : root, stacked }
}

/** The stage a tiled arrangement is drawn on now: its width in layout pixels and the width below which a row is drawn
 *  stacked when the row does not say its own (`SplitNode.stackBelow`). */
export type ArrangementStage = { width: number; stacksBelow?: (row: SplitNode) => number | undefined }

/**
 * A row the person just placed a pane in keeps its panes side by side on the stage they placed it on. Put a pane to
 * the left or right of another on a stage too narrow for both at their usable width (a phone, the Mac menu bar panel)
 * and the row would be drawn stacked, the new pane landing under the others; instead the row is told to stack only
 * below the width its panes need at the drag minimum, where side by side cannot be drawn at all. A pane is placed in a
 * row when it was not in the tree, its parent was not a row, none of its row's other panes were beside it before, it
 * changed order among them, or its earlier row was already drawn side by side (moving a pane rebuilds its row without
 * the row's width). Rows nobody placed into keep stacking as they did. Answers `next` itself when nothing changes.
 */
export function keepPlacedRowsSideBySide(prev: SplitTreeNode | null, next: SplitTreeNode | null, stage: ArrangementStage | null): SplitTreeNode | null {
  if (!next || !stage || !(stage.width > 0)) return next
  const drawnBeside = (row: SplitNode) => !((row.stackBelow ?? stage.stacksBelow?.(row) ?? 0) > stage.width)
  const before = new Map<string, { row: boolean; beside: string[]; drawnBeside: boolean }>()
  const read = (node: SplitTreeNode) => {
    if (node.kind !== 'split') return
    const leaves = node.children.flatMap(child => child.kind === 'leaf' ? [child.containerId] : [])
    const row = node.dir === 'row'
    for (const id of leaves) before.set(id, { row, beside: leaves, drawnBeside: row && drawnBeside(node) })
    node.children.forEach(read)
  }
  if (prev) read(prev)
  const placedIn = (row: SplitNode) => {
    const leaves = row.children.flatMap(child => child.kind === 'leaf' ? [child.containerId] : [])
    return leaves.some(id => {
      const was = before.get(id)
      if (!was || !was.row || was.drawnBeside) return true
      const kept = leaves.filter(other => was.beside.includes(other))
      if (kept.length < 2) return leaves.length > 1
      return kept.some((other, index) => was.beside.filter(prior => kept.includes(prior))[index] !== other)
    })
  }
  const keep = (node: SplitTreeNode): SplitTreeNode => {
    if (node.kind !== 'split') return node
    const children = node.children.map(keep)
    const same = children.every((child, index) => child === node.children[index])
    const below = node.dir === 'row' ? node.stackBelow ?? stage.stacksBelow?.(node) : undefined
    const stacks = typeof below === 'number' && stage.width < below
    if (!stacks || !placedIn(node)) return same ? node : { ...node, children }
    return { ...node, children, stackBelow: node.children.length * paneDragMinimumPx() }
  }
  return keep(next)
}
