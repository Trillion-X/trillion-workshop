// packages/ui/show/record-views/windowing.ts
//
// Purpose
//   Draws only what is on screen. A list of any length is a column of lines
//   with known heights; the scroller that holds the surface says which pixel
//   range is visible; the lines inside that range (plus a margin) are drawn and
//   everything else is spacer. Table rows, board cards and gallery rows all use
//   this one measure, so 23,000 records cost what 60 cost.
//
// Non-negotiable invariants
//   - The scroller is found, never passed: the nearest ancestor that scrolls,
//     or the document. A surface mounted in a pane, a window or a page all work.
//   - Scroll and resize updates are batched to one per animation frame.
//   - Line offsets are prefix sums computed once per layout change; finding the
//     visible range is a binary search, O(log lines) per frame.

import {useEffect, useLayoutEffect, useRef, useState} from 'react'

export function scrollerOf(node: HTMLElement | null): HTMLElement {
  let at = node?.parentElement ?? null
  while (at && !/(auto|scroll)/.test(getComputedStyle(at).overflowY)) at = at.parentElement
  return at ?? (document.scrollingElement as HTMLElement) ?? document.documentElement
}

/** Where `anchor` begins inside its scroller's content, in pixels. */
export function contentTopOf(anchor: HTMLElement, scroller: HTMLElement): number {
  const scrollerTop = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top
  return anchor.getBoundingClientRect().top - scrollerTop + scroller.scrollTop
}

export type ScrollWindow = {top: number; bottom: number; width: number; /** Re-read the position now, inside a layout effect after moving the scroll. */ sync: () => void}

/** The visible pixel range relative to the top of `anchor`, and the anchor's
 *  width, kept current through scrolling and resizing. */
export function useScrollWindow(anchor: HTMLElement | null, margin: number): ScrollWindow {
  const [window_, setWindow] = useState<Omit<ScrollWindow, 'sync'>>({top: 0, bottom: 1600, width: 0})
  const [sync] = useState(() => ({run: () => {}}))
  useLayoutEffect(() => {
    if (!anchor) return
    let frame = 0
    // The scroller is looked up on every measure: a pane can become the
    // scroller after this surface mounts, and a listener bound to the wrong
    // element would leave the window stuck where it started.
    const measure = () => {
      frame = 0
      const scroller = scrollerOf(anchor)
      const top = scroller.scrollTop - contentTopOf(anchor, scroller)
      const height = scroller === document.scrollingElement ? window.innerHeight : scroller.clientHeight
      const next = {top: top - margin, bottom: top + height + margin, width: anchor.clientWidth}
      setWindow(current => Math.abs(current.top - next.top) < 1 && Math.abs(current.bottom - next.bottom) < 1 && current.width === next.width ? current : next)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    // One capturing listener hears every scroll on the page, whichever element scrolls.
    const onScroll = (event: Event) => { const target = event.target; if (target === document || (target instanceof Node && target.contains(anchor))) schedule() }
    sync.run = measure
    measure()
    document.addEventListener('scroll', onScroll, {capture: true, passive: true})
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resize?.observe(anchor)
    const scroller = scrollerOf(anchor)
    if (scroller !== document.scrollingElement) resize?.observe(scroller)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onScroll, {capture: true})
      resize?.disconnect()
      window.removeEventListener('resize', schedule)
      sync.run = () => {}
    }
  }, [anchor, margin, sync])
  return {...window_, sync: () => sync.run()}
}

/** Prefix sums of line heights: offsets[i] is where line i starts, and the
 *  last entry is the whole height. */
export function offsetsOf(heights: ArrayLike<number>): Float64Array {
  const offsets = new Float64Array(heights.length + 1)
  for (let index = 0; index < heights.length; index++) offsets[index + 1] = offsets[index]! + heights[index]!
  return offsets
}

/** The half-open range of lines that intersect [top, bottom). */
export function visibleRange(offsets: Float64Array, top: number, bottom: number): [number, number] {
  const lines = offsets.length - 1
  if (lines <= 0) return [0, 0]
  const first = Math.max(0, upperBound(offsets, top) - 1)
  const end = Math.min(lines, upperBound(offsets, bottom))
  return [Math.min(first, lines), Math.max(first, end)]
}

function upperBound(offsets: Float64Array, value: number): number {
  let low = 0, high = offsets.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (offsets[middle]! <= value) low = middle + 1
    else high = middle
  }
  return low
}

/** Measures drawn elements once they exist, so estimated line heights become
 *  the real ones after the first frame. With `pitch`, the distance from the
 *  first match to the second (a row plus its gap) when two are drawn. A gallery
 *  uses the tallest visible card and keeps that height while scrolling, so a
 *  longer card cannot overlap the next windowed row. */
export function useMeasuredHeight(host: HTMLElement | null, selector: string, fallback: number, key: unknown, pitch = false, tallest = false): number {
  const [height, setHeight] = useState(fallback)
  const previousKey = useRef(key)
  const previousFallback = useRef(fallback)
  useEffect(() => {
    if (Object.is(previousKey.current, key) && previousFallback.current === fallback) return
    previousKey.current = key
    previousFallback.current = fallback
    setHeight(fallback)
  }, [key, fallback])
  useEffect(() => {
    const found = host?.querySelectorAll<HTMLElement>(selector)
    const first = found?.[0]?.getBoundingClientRect()
    if (!first) return
    const second = pitch ? found?.[1]?.getBoundingClientRect() : undefined
    const measured = tallest ? Math.max(...[...found!].map(element => element.getBoundingClientRect().height))
      : second && second.top > first.top ? second.top - first.top : first.height
    if (measured && Math.abs(measured - height) > 0.5 && (!tallest || measured > height)) setHeight(measured)
  })
  return height
}
