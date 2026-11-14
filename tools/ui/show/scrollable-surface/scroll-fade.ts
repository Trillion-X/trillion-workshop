// packages/ui/show/scrollable-surface/scroll-fade.ts
//
// PURPOSE
//   The one scroll-edge fade measurement. It watches a scroll container and
//   tells its mask how much content lies past each chosen edge, so an edge
//   fades only while there is more to scroll to and the fade eases out as the
//   last row arrives. Appearance lives in screen-look/show/scroll-edge-style.ts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Which edges may fade is DATA from the caller (`edges`); the watcher
//      never knows what the container holds.
//   2. No React state per scroll frame: every measurement writes four custom
//      properties on the element directly, and `data-scroll-fade` (the edges
//      fading right now) only when that set changes.
//   3. Measurement follows native geometry: scroll events plus a
//      ResizeObserver on the container and each direct child, re-observed when
//      children change, so a windowed list growing or a pane resizing both
//      re-measure without a scroll.
//   4. The look is installed once per document from the screen-look string.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.

import * as React from 'react'
import { SCROLL_EDGE_STYLE } from 'trillion-workshop/tools/screen-look/show/scroll-edge-style.ts'

export type ScrollFadeEdge = 'top' | 'right' | 'bottom' | 'left'

const EDGES: readonly ScrollFadeEdge[] = ['top', 'right', 'bottom', 'left']
const DEFAULT_FADE = 24

/** Install the shared look once in the element's document. */
function installLook(doc: Document) {
  if (doc.querySelector('style[data-bf-scroll-fade]')) return
  const style = doc.createElement('style')
  style.setAttribute('data-bf-scroll-fade', '')
  style.textContent = SCROLL_EDGE_STYLE
  doc.head.append(style)
}

/** How far past each edge the content runs, in px. */
function remaining(el: HTMLElement): Record<ScrollFadeEdge, number> {
  const maxY = el.scrollHeight - el.clientHeight
  const maxX = el.scrollWidth - el.clientWidth
  return {
    top: el.scrollTop,
    bottom: maxY - el.scrollTop,
    left: el.scrollLeft,
    right: maxX - el.scrollLeft,
  }
}

/**
 * Watch `el` and keep its edge fades current. Returns the stop function.
 * Usable from React (useScrollFade) and from DOM pages alike.
 */
export function watchScrollFade(el: HTMLElement, edges: readonly ScrollFadeEdge[]): () => void {
  installLook(el.ownerDocument)
  el.classList.add('bf-scroll-fade')
  let fading: string | null = null
  // The fade depth is read on resize, never per scroll frame.
  let size = DEFAULT_FADE
  const readSize = () => { size = parseFloat(getComputedStyle(el).getPropertyValue('--scroll-fade-size')) || DEFAULT_FADE }
  const measure = () => {
    const past = remaining(el)
    const now: ScrollFadeEdge[] = []
    for (const edge of EDGES) {
      const amount = edges.includes(edge) ? Math.max(0, Math.min(size, past[edge])) : 0
      el.style.setProperty(`--scroll-fade-${edge}`, `${amount}px`)
      if (amount > 1) now.push(edge)
    }
    const next = now.join(' ')
    if (next !== fading) {
      fading = next
      el.setAttribute('data-scroll-fade', next)
    }
  }
  el.addEventListener('scroll', measure, { passive: true })
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { readSize(); measure() })
  const observeChildren = () => {
    if (!resize) return
    resize.disconnect()
    resize.observe(el)
    for (const child of Array.from(el.children)) resize.observe(child)
  }
  observeChildren()
  const children = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => { observeChildren(); measure() })
  children?.observe(el, { childList: true })
  readSize()
  measure()
  return () => {
    el.removeEventListener('scroll', measure)
    resize?.disconnect()
    children?.disconnect()
    el.classList.remove('bf-scroll-fade')
    el.removeAttribute('data-scroll-fade')
    for (const edge of EDGES) el.style.removeProperty(`--scroll-fade-${edge}`)
  }
}

/** React binding: fade the chosen edges of `el` (hold it with a callback ref). */
export function useScrollFade(el: HTMLElement | null, edges: readonly ScrollFadeEdge[]) {
  const key = edges.join(' ')
  React.useLayoutEffect(() => {
    if (!el || !key) return
    return watchScrollFade(el, key ? (key.split(' ') as ScrollFadeEdge[]) : [])
  }, [el, key])
}
