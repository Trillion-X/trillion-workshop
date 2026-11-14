// packages/ui/show/hover-preview/PreviewCarousel.tsx
//
// Purpose: what a hover preview's card holds once it opens: one item's screen (./PreviewScreen) with its details and
// file card, or several as a carousel (PreviewCarousel). HoverPreview fetches this the first time a card opens, so a
// list with hover previews never carries the carousel or the file card with it.
//
// Non-negotiable invariants: those of HoverPreview.tsx, which this file draws for.

import React, {useEffect, useRef, useState} from 'react'
import {Button} from '../coss/ui/button'
import {NamedIcon} from '../icon'
// Under every file's screen, its card (facts, what the person can do with it, who is in it, what was said): drawn only
// when the page installed a file card source, so a preview anywhere else stays as it was.
import {FileCardFor} from '../file-card/FileCard'
import {PreviewScreen, type PreviewItem} from './PreviewScreen'

export {PreviewScreen}
export type {PreviewItem, PreviewScreenView} from './PreviewScreen'

// A trackpad's sideways scroll moves one screen once this much has built up;
// the rest of that gesture is ignored so one flick moves one screen.
const SWIPE_SCROLL = 60
const SWIPE_DRAG = 48
const SCROLL_REST_MS = 320

function isTyping(target: EventTarget | null) {
  const node = target as HTMLElement | null
  return Boolean(node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName ?? '')))
}

export interface PreviewCarouselProps<T> {
  items: readonly T[]
  /** Which item shows first (the one the pointer is on). */
  start?: number
  preview: (item: T) => PreviewItem | null
  /** The caller's own lines and actions under the screen. Without it, the item's title. */
  details?: (item: T, index: number) => React.ReactNode
  /** Draws one item's content. Without it, PreviewScreen: the one file preview (FilePreview). */
  renderPreview?: (item: PreviewItem) => React.ReactNode
  label?: string
}

/** One item's screen with its details, or several as a carousel. */
export function PreviewCarousel<T>({items, start = 0, preview, details, renderPreview, label = 'Preview'}: PreviewCarouselProps<T>) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), Math.max(0, items.length - 1)))
  const many = items.length > 1
  const move = (step: number) => setIndex(current => Math.min(items.length - 1, Math.max(0, current + step)))
  const moveRef = useRef(move)
  moveRef.current = move
  useEffect(() => {
    if (!many) return
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'ArrowRight') { event.preventDefault(); moveRef.current(1) }
      if (event.key === 'ArrowLeft') { event.preventDefault(); moveRef.current(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [many])
  const scrolled = useRef({sum: 0, at: -Infinity, spent: false})
  const pressed = useRef<number | null>(null)
  const item = items[Math.min(index, items.length - 1)]
  if (item === undefined) return null
  const shown = preview(item)
  const onWheel = (event: React.WheelEvent) => {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
    const gesture = scrolled.current
    if (event.timeStamp - gesture.at > SCROLL_REST_MS) { gesture.sum = 0; gesture.spent = false }
    gesture.at = event.timeStamp
    if (gesture.spent) return
    gesture.sum += event.deltaX
    if (Math.abs(gesture.sum) >= SWIPE_SCROLL) { move(Math.sign(gesture.sum)); gesture.spent = true }
  }
  return (
    <div
      className="hover-preview"
      role={many ? 'region' : undefined}
      aria-roledescription={many ? 'carousel' : undefined}
      aria-label={many ? label : undefined}
      data-carousel={many ? '' : undefined}
      onWheel={many ? onWheel : undefined}
      onPointerDown={many ? event => { if (event.pointerType !== 'mouse') pressed.current = event.clientX } : undefined}
      onPointerUp={many ? event => {
        const from = pressed.current
        pressed.current = null
        if (from !== null && Math.abs(event.clientX - from) >= SWIPE_DRAG) move(event.clientX < from ? 1 : -1)
      } : undefined}
    >
      {shown && (renderPreview ? <React.Fragment key={shown.id}>{renderPreview(shown)}</React.Fragment> : <PreviewScreen key={shown.id} item={shown}/>)}
      {many && (
        <div className="hover-preview-nav" role="group" aria-label={label}>
          <Button variant="ghost" size="icon-sm" aria-label="Previous" disabled={index === 0} onClick={() => move(-1)}>
            <NamedIcon name="ChevronLeft" aria-hidden="true"/>
          </Button>
          <span className="hover-preview-position" aria-live="polite">{index + 1} of {items.length}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Next" disabled={index === items.length - 1} onClick={() => move(1)}>
            <NamedIcon name="ChevronRight" aria-hidden="true"/>
          </Button>
        </div>
      )}
      {details ? details(item, index) : shown && <strong className="record-preview-title">{shown.title}</strong>}
      {shown?.url ? <FileCardFor key={shown.id} subject={{id: shown.id, title: shown.title, url: shown.url, type: shown.type, poster: shown.poster}}/> : null}
    </div>
  )
}
