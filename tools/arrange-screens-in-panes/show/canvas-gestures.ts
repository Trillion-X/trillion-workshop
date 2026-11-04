// parts/screen-arrangement/show/canvas-gestures.ts
//
// PURPOSE
// The arrangement's own gestures: scrolling in any direction, zoom, pan by drag, pinch.
//
// NON-NEGOTIABLE INVARIANTS
// 1. One rule for every wheel move: each axis goes to the innermost thing (a list, a pane, the arrangement) that can
//    still scroll that way; a diagonal move over a list scrolls the list down and the arrangement sideways. No screen
//    is named here.
// 2. ctrl, cmd or a trackpad pinch zooms the arrangement anywhere over it; a plain wheel never zooms.
// 3. A wheel nothing can move is left alone, so scrolling past the edge opens the next layout
//    (continuous-layout-navigation.ts); a wheel a screen already took (defaultPrevented) is never touched.
// 4. Touch scrolls natively and hands on from list to pane to arrangement (split-arranger.css); two fingers always
//    pinch the arrangement, read from touch events on the way down, so an inner list never holds them.
// 5. An arrangement inside a locked region (ui/show/locked-region) never zooms, pans or pinches: scrolling still moves
//    its screen, and nothing else of the arrangement answers until the region is unlocked.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { clampArrangementZoom } from './arrangement-zoom'
import { isLockedAt } from '../../ui/show/locked-region'

type ZoomReader = () => number
type ZoomWriter = (zoom: number) => void

type Point = { x: number; y: number }
type PanState = { pointerId: number; x: number; y: number; left: number; top: number; cursor: string }

const WHEEL_ZOOM_SENSITIVITY = 0.001
// WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages.
const WHEEL_LINE_PX = 16

/** One box the wheel can scroll: the DOM element, or a stand-in in tests. */
export type WheelScrollBox = {
  parentElement: WheelScrollBox | null
  scrollLeft: number
  scrollTop: number
  scrollWidth: number
  scrollHeight: number
  clientWidth: number
  clientHeight: number
}
type ReadOverflow = (box: WheelScrollBox) => { overflowX: string; overflowY: string }

const scrollsAlong = (overflow: string) => overflow === 'auto' || overflow === 'scroll'

/** Whether `box` can still move `delta` pixels' way along one axis (it scrolls there and is not at that end). */
function canScroll(box: WheelScrollBox, axis: 'x' | 'y', delta: number, readOverflow: ReadOverflow): boolean {
  if (delta === 0) return false
  const overflow = readOverflow(box)
  if (axis === 'x') {
    if (!scrollsAlong(overflow.overflowX) || box.scrollWidth <= box.clientWidth + 1) return false
    return delta < 0 ? box.scrollLeft > 0.5 : box.scrollLeft + box.clientWidth < box.scrollWidth - 0.5
  }
  if (!scrollsAlong(overflow.overflowY) || box.scrollHeight <= box.clientHeight + 1) return false
  return delta < 0 ? box.scrollTop > 0.5 : box.scrollTop + box.clientHeight < box.scrollHeight - 0.5
}

/**
 * Who takes each axis of one wheel move inside the arrangement: for each axis, the innermost box from the wheel's
 * target up to the viewport (inclusive) that can still scroll that way; null when none can. One rule for every screen,
 * so a diagonal move over a list scrolls the list down and the arrangement sideways, and a list at its end hands the
 * rest of the move to the pane or the arrangement around it.
 */
export function wheelScrollTakers(
  target: WheelScrollBox | null,
  viewport: WheelScrollBox,
  delta: Point,
  readOverflow: ReadOverflow = (box) => window.getComputedStyle(box as unknown as Element),
): { x: WheelScrollBox | null; y: WheelScrollBox | null; innermostScroller: WheelScrollBox | null } {
  let x: WheelScrollBox | null = null
  let y: WheelScrollBox | null = null
  let innermostScroller: WheelScrollBox | null = null
  for (let box = target; box; box = box.parentElement) {
    const overflow = readOverflow(box)
    if (!innermostScroller && ((scrollsAlong(overflow.overflowX) && box.scrollWidth > box.clientWidth + 1)
      || (scrollsAlong(overflow.overflowY) && box.scrollHeight > box.clientHeight + 1))) innermostScroller = box
    if (!x && canScroll(box, 'x', delta.x, readOverflow)) x = box
    if (!y && canScroll(box, 'y', delta.y, readOverflow)) y = box
    if (box === viewport) break
  }
  return { x, y, innermostScroller }
}

/** A wheel move in pixels, whatever unit the device reported it in. */
function wheelPixels(event: WheelEvent, viewport: HTMLElement): Point {
  const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? viewport.clientHeight : 1
  // A plain vertical wheel with Shift held is the platform's sideways scroll.
  if (event.shiftKey && event.deltaX === 0) return { x: event.deltaY * unit, y: 0 }
  return { x: event.deltaX * unit, y: event.deltaY * unit }
}

function canvasBackgroundTarget(target: EventTarget | null, viewport: HTMLElement): boolean {
  if (!(target instanceof Element)) return true
  if (target.closest('[data-container-id], [data-split-dir], [role="separator"], [data-arrangement-navigator], button, input, textarea, select, [contenteditable="true"]')) return false
  return viewport.contains(target)
}

function zoomAt(viewport: HTMLElement, readZoom: ZoomReader, writeZoom: ZoomWriter, point: Point, factor: number): void {
  const previous = clampArrangementZoom(readZoom())
  const next = clampArrangementZoom(previous * factor)
  if (next === previous) return

  const rect = viewport.getBoundingClientRect()
  const x = point.x - rect.left - viewport.clientLeft
  const y = point.y - rect.top - viewport.clientTop
  const contentX = (viewport.scrollLeft + x) / previous
  const contentY = (viewport.scrollTop + y) / previous
  writeZoom(next)
  requestAnimationFrame(() => {
    viewport.scrollLeft = Math.max(0, contentX * next - x)
    viewport.scrollTop = Math.max(0, contentY * next - y)
    // A CSS camera transform does not change layout size, so ResizeObserver
    // cannot refresh the pane map. A scroll notification makes its existing
    // viewport observer read the newly painted pane bounds, even when this
    // zoom is anchored at the origin and leaves both offsets unchanged.
    viewport.dispatchEvent(new Event('scroll'))
  })
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** Bind direct canvas zoom and pan gestures to the tiled arrangement viewport. */
export function bindArrangementCanvasGestures(
  viewport: HTMLElement,
  readZoom: ZoomReader,
  writeZoom: ZoomWriter,
): () => void {
  let spaceDown = false
  let pan: PanState | null = null
  let pinchDistance = 0
  let pinchZoom = 1

  const locked = () => isLockedAt(viewport)

  const clearPan = () => {
    if (pan) viewport.style.cursor = pan.cursor
    pan = null
    delete viewport.dataset.canvasPanning
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (event.code !== 'Space' || event.repeat || locked() || target?.closest('button, a, [role="button"], input, textarea, select, [contenteditable="true"]')) return
    event.preventDefault()
    spaceDown = true
  }
  const onKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') spaceDown = false }
  const onBlur = () => { spaceDown = false; clearPan() }

  const onWheel = (event: WheelEvent) => {
    // A screen that handles its own wheel (a map, a drawing canvas) keeps it.
    if (event.defaultPrevented) return
    if (event.ctrlKey || event.metaKey) {
      // The trackpad pinch (and ctrl or cmd with the wheel) zooms the arrangement, over panes as well as gaps.
      event.preventDefault()
      if (locked()) return
      const delta = Math.max(-240, Math.min(240, event.deltaY))
      zoomAt(viewport, readZoom, writeZoom, { x: event.clientX, y: event.clientY }, Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY))
      return
    }
    // Every other wheel scrolls, in any direction: each axis goes to the innermost thing that can still move that way.
    const delta = wheelPixels(event, viewport)
    const target = event.target instanceof Element ? event.target as unknown as WheelScrollBox : null
    const takers = wheelScrollTakers(target, viewport as unknown as WheelScrollBox, delta)
    // Nothing can move: the wheel is left alone (scrolling past the edge to the next layout reads it).
    if (!takers.x && !takers.y) return
    // One inner list takes the whole move and it is the first thing that scrolls: the browser scrolls it natively.
    const single = (!delta.x || takers.x) && (!delta.y || takers.y) && (takers.x ?? takers.y) === (takers.y ?? takers.x)
    if (single && (takers.x ?? takers.y) === takers.innermostScroller && takers.innermostScroller !== (viewport as unknown as WheelScrollBox)) return
    // Otherwise the move is shared out here: a diagonal over a list, or a list at its end handing on to its pane or
    // to the arrangement, which the browser would keep on the list for the rest of the gesture.
    event.preventDefault()
    if (takers.x && delta.x) (takers.x as unknown as HTMLElement).scrollLeft += delta.x
    if (takers.y && delta.y) (takers.y as unknown as HTMLElement).scrollTop += delta.y
  }

  const onPointerDown = (event: PointerEvent) => {
    // A finger scrolls natively: the innermost thing that can still move takes it, then its pane, then the
    // arrangement (split-arranger.css lets inner scrollers hand on). Two fingers pinch (touch events below).
    if (event.pointerType === 'touch' || locked()) return

    const explicitPan = event.button === 1 || (event.button === 0 && spaceDown)
    const canvasPan = event.button === 0 && canvasBackgroundTarget(event.target, viewport)
    if (!explicitPan && !canvasPan) return
    event.preventDefault()
    event.stopPropagation()
    pan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, cursor: viewport.style.cursor }
    viewport.setPointerCapture?.(event.pointerId)
    viewport.dataset.canvasPanning = 'true'
    viewport.style.cursor = 'grabbing'
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!pan || pan.pointerId !== event.pointerId) return
    event.preventDefault()
    viewport.scrollLeft = pan.left - (event.clientX - pan.x)
    viewport.scrollTop = pan.top - (event.clientY - pan.y)
  }

  const finishPointer = (event: PointerEvent) => {
    if (!pan || pan.pointerId !== event.pointerId) return
    clearPan()
    if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId)
  }

  // Pinch reads touch events, which keep coming after a finger has started scrolling a list (pointer events are
  // cancelled then), and is taken on the way down (capture), so no inner list ever holds a second finger.
  const fingers = (event: TouchEvent): [Point, Point] => [
    { x: event.touches[0].clientX, y: event.touches[0].clientY },
    { x: event.touches[1].clientX, y: event.touches[1].clientY },
  ]
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length < 2) return
    if (event.cancelable) event.preventDefault()
    if (locked()) { pinchDistance = 0; return }
    const [a, b] = fingers(event)
    pinchDistance = Math.max(1, distance(a, b))
    pinchZoom = clampArrangementZoom(readZoom())
    pan = null
  }
  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length < 2) return
    if (event.cancelable) event.preventDefault()
    if (locked()) return
    event.stopPropagation()
    const [a, b] = fingers(event)
    const nextDistance = Math.max(1, distance(a, b))
    if (!pinchDistance) { pinchDistance = nextDistance; pinchZoom = clampArrangementZoom(readZoom()); return }
    const factor = nextDistance / pinchDistance
    zoomAt(viewport, () => pinchZoom, writeZoom, midpoint(a, b), factor)
    pinchDistance = nextDistance
    pinchZoom = clampArrangementZoom(pinchZoom * factor)
  }
  const onTouchEnd = (event: TouchEvent) => { if (event.touches.length < 2) pinchDistance = 0 }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  viewport.addEventListener('wheel', onWheel, { passive: false })
  viewport.addEventListener('pointerdown', onPointerDown, true)
  viewport.addEventListener('pointermove', onPointerMove, { passive: false })
  viewport.addEventListener('pointerup', finishPointer)
  viewport.addEventListener('pointercancel', finishPointer)
  viewport.addEventListener('touchstart', onTouchStart, { capture: true, passive: false })
  viewport.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
  viewport.addEventListener('touchend', onTouchEnd, true)
  viewport.addEventListener('touchcancel', onTouchEnd, true)

  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    viewport.removeEventListener('wheel', onWheel)
    viewport.removeEventListener('pointerdown', onPointerDown, true)
    viewport.removeEventListener('pointermove', onPointerMove)
    viewport.removeEventListener('pointerup', finishPointer)
    viewport.removeEventListener('pointercancel', finishPointer)
    viewport.removeEventListener('touchstart', onTouchStart, true)
    viewport.removeEventListener('touchmove', onTouchMove, true)
    viewport.removeEventListener('touchend', onTouchEnd, true)
    viewport.removeEventListener('touchcancel', onTouchEnd, true)
    clearPan()
  }
}
