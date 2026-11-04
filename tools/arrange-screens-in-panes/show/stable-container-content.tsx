// parts/screen-arrangement/show/stable-container-content.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Keeps each container's content mounted exactly once, keyed by container id,
// no matter where the arrangement draws that container. Arrangers render a
// ContainerSlot where the content belongs; the content itself lives in a
// persistent element that moves into whichever slot currently shows it.
//
// Before this, content rendered inline inside each arranger's tree. A split
// wraps a pane in a new split node and shifts sibling indexes, so React saw a
// different element path and rebuilt every existing pane: their open screens
// reloaded from nothing. Moving a pane between tiled, floating, picture-in-
// picture and full-screen views did the same.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. One React owner per container id: the portal keyed by that id. Its React
//    identity never depends on tree shape, arranger, or position.
// 2. The content element is only ever MOVED between slots, never recreated,
//    while at least one slot for that id is mounted.
// 3. Moves happen while both ends are in the document, through `moveBefore`
//    when the browser has it, so iframes, media and focus keep their state.
// 4. When several slots show the same id (a pane shown full screen over its
//    tile), the most recently mounted slot holds the content; closing it
//    returns the content to the previous slot.
// 5. Contexts an arranger provides around its slot travel with the content,
//    listed once in CARRIED_CONTEXTS; the move logic never names an arranger.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client'

import React from 'react'
import { createPortal } from 'react-dom'
import { FloatingWindowContext } from './floating-window-context'
import { OverlayWindowContext } from './OverlayArranger'

/**
 * Contexts an arranger provides around the content it hosts (the floating
 * window's drag grip, the picture-in-picture window's close and dock). The slot
 * reads each where it sits and the content is rendered under the same values.
 * An arranger that hosts content under a new context adds it here.
 */
const CARRIED_CONTEXTS: readonly React.Context<unknown>[] = [
  FloatingWindowContext as React.Context<unknown>,
  OverlayWindowContext as React.Context<unknown>,
]

type SlotEntry = { slot: HTMLElement; carried: readonly unknown[] }

type Registry = {
  attach: (id: string, entry: SlotEntry) => void
  update: (id: string, entry: SlotEntry) => void
  detach: (id: string, entry: SlotEntry) => void
}

const StableContentContext = React.createContext<Registry | null>(null)

const FILL: Partial<CSSStyleDeclaration> = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100%',
  minWidth: '0',
  minHeight: '0',
}

type MovableParent = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void }

/** Moves `node` into `parent`, keeping its live state where the browser allows. */
function place(parent: HTMLElement, node: HTMLElement) {
  if (node.parentNode === parent) return
  const moveBefore = (parent as MovableParent).moveBefore
  if (moveBefore && node.isConnected && parent.isConnected) {
    try {
      moveBefore.call(parent, node, null)
      return
    } catch {
      // A move the browser refuses (different documents) falls back to append.
    }
  }
  parent.appendChild(node)
}

function renderCarried(carried: readonly unknown[], children: React.ReactNode): React.ReactNode {
  return CARRIED_CONTEXTS.reduceRight<React.ReactNode>(
    (inner, Context, index) => <Context.Provider value={carried[index]}>{inner}</Context.Provider>,
    children,
  )
}

/**
 * Owns every container's content. `render(id)` draws the content for one
 * container; it is mounted once per id that has at least one mounted slot.
 */
export function StableContainerContent({
  render,
  children,
}: {
  render: (containerId: string) => React.ReactNode
  children: React.ReactNode
}) {
  const parkRef = React.useRef<HTMLDivElement | null>(null)
  const contentRef = React.useRef(new Map<string, HTMLElement>())
  const stacksRef = React.useRef(new Map<string, SlotEntry[]>())
  const [, repaint] = React.useReducer((count: number) => count + 1, 0)

  const registry = React.useMemo<Registry>(() => {
    const contentFor = (id: string) => {
      let node = contentRef.current.get(id)
      if (!node) {
        node = document.createElement('div')
        Object.assign(node.style, FILL)
        node.dataset.containerContent = id
        contentRef.current.set(id, node)
      }
      return node
    }
    return {
      attach(id, entry) {
        const stack = stacksRef.current.get(id) ?? []
        stack.push(entry)
        stacksRef.current.set(id, stack)
        place(entry.slot, contentFor(id))
        repaint()
      },
      update(id, entry) {
        const stack = stacksRef.current.get(id)
        const at = stack ? stack.findIndex((item) => item.slot === entry.slot) : -1
        if (!stack || at < 0) return
        stack[at] = entry
        if (at === stack.length - 1) repaint()
      },
      detach(id, entry) {
        const stack = (stacksRef.current.get(id) ?? []).filter((item) => item.slot !== entry.slot)
        const node = contentRef.current.get(id)
        const top = stack[stack.length - 1]
        if (top) {
          stacksRef.current.set(id, stack)
          if (node) place(top.slot, node)
        } else {
          stacksRef.current.delete(id)
          // Park the content in the document before its slot leaves, so a slot
          // for the same id mounting in this same commit receives it intact.
          if (node && parkRef.current) place(parkRef.current, node)
        }
        repaint()
      },
    }
  }, [])

  // A container whose every slot went away drops its content; one whose slot
  // came back in the same commit never left the stack and keeps it.
  for (const id of [...contentRef.current.keys()]) {
    if (!stacksRef.current.has(id)) {
      contentRef.current.get(id)?.remove()
      contentRef.current.delete(id)
    }
  }

  return (
    <StableContentContext.Provider value={registry}>
      {children}
      <div ref={parkRef} hidden data-container-content-park="" />
      {[...stacksRef.current].map(([id, stack]) => {
        const node = contentRef.current.get(id)
        const top = stack[stack.length - 1]
        if (!node || !top) return null
        return (
          <React.Fragment key={id}>
            {createPortal(renderCarried(top.carried, render(id)), node, id)}
          </React.Fragment>
        )
      })}
    </StableContentContext.Provider>
  )
}

/**
 * Where an arranger shows a container. It renders one empty element; the
 * container's persistent content moves into it.
 */
export function ContainerSlot({ containerId }: { containerId: string }) {
  const registry = React.useContext(StableContentContext)
  if (!registry) throw new Error('ContainerSlot needs StableContainerContent above it')
  const slotRef = React.useRef<HTMLDivElement | null>(null)
  const entryRef = React.useRef<SlotEntry | null>(null)
  // A fixed list, read in the same order on every render.
  const carried = CARRIED_CONTEXTS.map((Context) => React.useContext(Context))

  React.useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot) return undefined
    const entry: SlotEntry = { slot, carried }
    entryRef.current = entry
    registry.attach(containerId, entry)
    return () => {
      registry.detach(containerId, entryRef.current ?? entry)
      entryRef.current = null
    }
    // Carried context changes are forwarded below without re-attaching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, containerId])

  React.useLayoutEffect(() => {
    const current = entryRef.current
    if (!current || current.carried.every((value, index) => value === carried[index])) return
    const next: SlotEntry = { slot: current.slot, carried }
    entryRef.current = next
    registry.update(containerId, next)
  })

  return (
    <div
      ref={slotRef}
      data-container-slot={containerId}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}
    />
  )
}
