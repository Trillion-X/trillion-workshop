// Put a resizable split workspace on screen from plain imperative code.
//
// Why this exists
//   SplitTreeArranger is pure and it is React. It takes a tree, asks the caller
//   to render each container, and emits an intent whenever someone drags a
//   gutter or drops a pane. Everything else about it — what a container holds,
//   where the tree is kept, what a drop should mean — belongs to whoever is
//   using it.
//
//   That is the right shape, and it is unusable from a classic script without
//   this file. An app that is not a React app still wants panes it can drag
//   things into.
//
// Why it takes no runtime
//   The heavier way into the same arranger resolves its contents from published
//   records through the Bitfield runtime, which means a host, a log and slot
//   admission. Nothing here needs any of that: the caller owns the tree and
//   fills each container itself, so the only things crossing this boundary are
//   a string id and an element to draw into.
//
// Why containers are ids and nothing else
//   This file never looks inside a container and never asks what it shows. A
//   pane holding a video editor and a pane holding a table are the same thing
//   to it. That is what lets the same workspace hold something nobody has
//   written yet.

import React from 'react'
import {createRoot} from 'react-dom/client'
import SplitTreeArranger from './SplitTreeArranger'
import type {SplitTreeNode} from '../read-data/layout-types'
import {
  addContainerAtEdge,
  addContainerBeside,
  containerIds,
  leaf,
  moveContainer,
  removeContainer,
  sizeSplitInPixels,
  swapContainers,
  type Edge,
} from '../read-data/split-tree-operations'
import {claimNode, releaseNode} from '../../ui/show/one-owner-per-node'
import { Container } from '../../ui/show/container';

export type WorkspaceSplitOptions = {
  /** Starting tree. A bare string is the single container to open with. */
  initial?: SplitTreeNode | string | null
  /**
   * Fill `host` with whatever this container shows. Called once per container
   * per mount; the element is reused across resizes and drags so anything
   * stateful inside a pane survives being moved.
   */
  fillContainer: (containerId: string, host: HTMLElement) => void
  /** Called after any change, with the tree to persist. */
  onChange?: (root: SplitTreeNode | null) => void
  /** Called when a container is closed, so the caller can release what was in it. */
  onContainerClosed?: (containerId: string) => void
}

export type WorkspaceSplit = {
  /**
   * Open a container, or reveal it if it is already on screen, and hand back
   * the element it draws into.
   *
   * The element is built before this returns rather than when React next
   * commits. A caller that opens a pane almost always wants to put something
   * in it on the same line, and waiting for an effect means the caller reads
   * an empty pane, concludes the open failed, and falls back to whatever it
   * did before panes existed.
   */
  open: (containerId: string, options?: {edge?: Edge; beside?: string}) => HTMLElement
  close: (containerId: string) => void
  has: (containerId: string) => boolean
  showing: () => string[]
  root: () => SplitTreeNode | null
  destroy: () => void
}

const FILLS_ITS_SPACE = {height: '100%', minHeight: 0} as const

function startingTree(initial: WorkspaceSplitOptions['initial']): SplitTreeNode | null {
  if (!initial) return null
  return typeof initial === 'string' ? leaf(initial) : initial
}

export function mountWorkspaceSplit(node: HTMLElement, options: WorkspaceSplitOptions): WorkspaceSplit {
  releaseNode(node)
  node.replaceChildren()
  const root = createRoot(node)

  let tree: SplitTreeNode | null = startingTree(options.initial)
  let draw: () => void = () => {}

  // One element per container, kept across every re-render. Rebuilding a pane's
  // contents on each resize would reset scroll, selection and anything playing
  // inside it, which is the difference between moving a pane and losing it.
  const panes = new Map<string, HTMLElement>()

  const paneFor = (containerId: string) => {
    let pane = panes.get(containerId)
    if (!pane) {
      pane = document.createElement('div')
      pane.dataset.workspacePane = containerId
      Object.assign(pane.style, {height: '100%', minHeight: '0', overflow: 'auto'})
      panes.set(containerId, pane)
      options.fillContainer(containerId, pane)
    }
    return pane
  }

  const settle = (next: SplitTreeNode | null) => {
    tree = next
    const alive = new Set(containerIds(tree))
    for (const [containerId, pane] of panes) {
      if (alive.has(containerId)) continue
      panes.delete(containerId)
      pane.remove()
      options.onContainerClosed?.(containerId)
    }
    options.onChange?.(tree)
    draw()
  }

  /** Holds one long-lived pane element, so React never owns its children. */
  function Pane({containerId}: {containerId: string}) {
    const host = React.useRef<HTMLDivElement | null>(null)
    React.useEffect(() => {
      host.current?.append(paneFor(containerId))
      // Left in place rather than removed on cleanup: the same pane is about to
      // be appended to its new host, and detaching it first is what makes a
      // dragged video stop playing the moment it lands.
    }, [containerId])
    return <Container ref={host} style={{...FILLS_ITS_SPACE, display: 'flex', flexDirection: 'column'}}/>
  }

  function Workspace() {
    const [, redraw] = React.useReducer((count: number) => count + 1, 0)
    draw = redraw
    if (!tree) return null
    return (
      <SplitTreeArranger
        root={tree}
        onResize={(path, sizesPx) => settle(sizeSplitInPixels(tree, path, sizesPx))}
        onSwapContainers={(a, b) => settle(swapContainers(tree, a, b))}
        onDropTarget={target => {
          const moving = placementId(target, ['containerId', 'sourceId'])
          const onto = placementId(target, ['targetId', 'targetContainerId'])
          if (!moving || !onto) return
          settle(moveContainer(tree, moving, onto, edgeOf(target)))
        }}
        splitAtFrameEdge={async (edge, payload) => {
          const containerId = placementId(payload)
          if (containerId) settle(addContainerAtEdge(tree, edge as Edge, containerId))
        }}
        splitBetween={async (_dir, _beforeId, afterId, payload) => {
          const containerId = placementId(payload)
          if (containerId) settle(addContainerBeside(tree, afterId, 'right', containerId))
        }}
        renderContainer={containerId => <Pane key={containerId} containerId={containerId}/>}
      />
    )
  }

  root.render(<Workspace/>)
  claimNode(node, () => {
    root.unmount()
    panes.clear()
  })

  return {
    open(containerId, {edge = 'right', beside} = {}) {
      // Built first, so the caller has somewhere to put things whether this
      // pane is new or already open.
      const pane = paneFor(containerId)
      if (containerIds(tree).includes(containerId)) {
        pane.scrollIntoView({block: 'nearest'})
        return pane
      }
      settle(beside ? addContainerBeside(tree, beside, edge, containerId) : addContainerAtEdge(tree, edge, containerId))
      return pane
    },
    close: containerId => settle(removeContainer(tree, containerId)),
    has: containerId => containerIds(tree).includes(containerId),
    showing: () => containerIds(tree),
    root: () => tree,
    destroy: () => releaseNode(node),
  }
}

const EDGES: ReadonlySet<string> = new Set(['left', 'right', 'top', 'bottom'])

function edgeOf(target: unknown): Edge {
  const value = (target as Record<string, unknown>)?.edge
  return typeof value === 'string' && EDGES.has(value) ? (value as Edge) : 'right'
}

/**
 * A placement payload names the thing being placed in one of several fields
 * depending on where the drag started. Read rather than assumed, because the
 * arranger is shared with callers that populate different ones.
 */
function placementId(payload: unknown, keys = ['containerId', 'surfaceId', 'tabId', 'id']): string | null {
  const row = (payload ?? {}) as Record<string, unknown>
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}
