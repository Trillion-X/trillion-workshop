// parts/screen-arrangement/show/continuous-layout-navigation.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Scrolling past the edge of the arrangement opens the next or previous
// layout, in the order the Layouts picker shows them. Scrolling inside the
// arrangement stays ordinary scrolling; only a deliberate wheel or trackpad
// move at the arrangement's outer edge, over something that does not scroll
// by itself, switches. The pure parts decide the direction and the neighbour;
// useSwitchLayoutPastEdge binds them to the arrangement's scrolling viewport.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. A switch needs a layout on screen that is one of the choices and a
//    neighbour in the gesture's direction; otherwise the wheel is untouched.
// 2. A wheel another handler already took (canvas zoom, a modifier key) and a
//    wheel over content that scrolls by itself never switch layouts.
// 3. Every switch goes through the one switch (useLayoutChoices().open), so the
//    arrangement it replaces is kept first.
// 4. The thresholds are DATA (switch-layout-past-edge.json).
//
// =============================================================================

'use client'

import * as React from 'react'
import pastEdge from '../switch-layout-past-edge.json'
import { useLayoutChoices } from './use-layout-choices'

export type LayoutEdgeDirection = -1 | 1
export type WheelAxis = 'x' | 'y'

export type LayoutEdgeMetrics = {
  deltaX: number
  deltaY: number
  scrollLeft: number
  scrollTop: number
  scrollWidth: number
  scrollHeight: number
  clientWidth: number
  clientHeight: number
}

/** The axis a wheel move is mostly along. */
export function wheelAxis(deltaX: number, deltaY: number): WheelAxis {
  return Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y'
}

/**
 * The direction to switch in when a wheel move pushes past the viewport's
 * outer edge on its main axis, or null while the viewport can still scroll.
 */
export function layoutDirectionAtScrollEdge(metrics: LayoutEdgeMetrics, edgeTolerance = pastEdge.edge_tolerance_px): LayoutEdgeDirection | null {
  if (wheelAxis(metrics.deltaX, metrics.deltaY) === 'x') {
    const atStart = metrics.scrollLeft <= edgeTolerance
    const atEnd = metrics.scrollLeft + metrics.clientWidth >= metrics.scrollWidth - edgeTolerance
    if (metrics.deltaX < 0 && atStart) return -1
    if (metrics.deltaX > 0 && atEnd) return 1
    return null
  }
  const atTop = metrics.scrollTop <= edgeTolerance
  const atBottom = metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - edgeTolerance
  if (metrics.deltaY < 0 && atTop) return -1
  if (metrics.deltaY > 0 && atBottom) return 1
  return null
}

/** The neighbour in `direction`; null when the current one is not in the list or there is no neighbour. */
export function adjacentSavedLayout<T>(layouts: readonly T[], currentIndex: number, direction: LayoutEdgeDirection): T | null {
  if (currentIndex < 0 || currentIndex >= layouts.length) return null
  return layouts[currentIndex + direction] ?? null
}

type ScrollBox = {
  parentElement: ScrollBox | null
  scrollWidth: number
  scrollHeight: number
  clientWidth: number
  clientHeight: number
}
type ReadOverflow = (box: ScrollBox) => { overflowX: string; overflowY: string }

const scrolls = (overflow: string) => overflow === 'auto' || overflow === 'scroll'

/**
 * Whether something between the wheel's target and the viewport scrolls by
 * itself along `axis`: a list or document inside a pane owns the wheel, even at
 * its own end, so reading to the bottom of a list never switches layouts.
 */
export function innerScrollerHoldsWheel(
  target: ScrollBox | null,
  viewport: ScrollBox,
  axis: WheelAxis,
  readOverflow: ReadOverflow = (box) => window.getComputedStyle(box as unknown as Element),
): boolean {
  for (let box = target; box && box !== viewport; box = box.parentElement) {
    const overflow = readOverflow(box)
    if (axis === 'x' ? scrolls(overflow.overflowX) && box.scrollWidth > box.clientWidth + 1
      : scrolls(overflow.overflowY) && box.scrollHeight > box.clientHeight + 1) return true
  }
  return false
}

/** Bind edge switching to the arrangement's scrolling viewport. */
export function useSwitchLayoutPastEdge(viewportRef: React.RefObject<HTMLElement | null>): void {
  const { choices, currentIndex, open } = useLayoutChoices()
  const latest = React.useRef({ choices, currentIndex, open })
  latest.current = { choices, currentIndex, open }

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    let lastSwitchAt = Number.NEGATIVE_INFINITY
    let switching = false
    const onWheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return
      if (Math.max(Math.abs(event.deltaX), Math.abs(event.deltaY)) < pastEdge.least_motion_px) return
      const direction = layoutDirectionAtScrollEdge({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
        scrollWidth: viewport.scrollWidth,
        scrollHeight: viewport.scrollHeight,
        clientWidth: viewport.clientWidth,
        clientHeight: viewport.clientHeight,
      })
      if (!direction) return
      if (innerScrollerHoldsWheel(event.target instanceof Element ? event.target : null, viewport, wheelAxis(event.deltaX, event.deltaY))) return
      const { choices: now, currentIndex: at, open: openChoice } = latest.current
      const target = adjacentSavedLayout(now, at, direction)
      if (!target) return
      // The wheel is taken whenever a neighbour exists, so the page does not
      // bounce; the pause keeps one swipe's momentum from skipping layouts.
      event.preventDefault()
      const time = performance.now()
      if (switching || time - lastSwitchAt < pastEdge.pause_between_switches_ms) return
      lastSwitchAt = time
      switching = true
      openChoice(target)
        .catch((error) => console.error('Opening the next layout failed', error))
        .finally(() => { switching = false })
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [viewportRef])
}
