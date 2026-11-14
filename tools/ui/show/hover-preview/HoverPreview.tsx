// packages/ui/show/hover-preview/HoverPreview.tsx
//
// Purpose: what a file or record looks like when the pointer rests on it, in a
// card beside it: a video playing silently, a sound's waveform with its player,
// a picture larger, a document's first page or the start of its text. With
// several items (everything selected, say) the card is a carousel: one screen
// at a time, moved with the arrow keys, a sideways swipe or trackpad scroll, or
// the buttons, and "2 of 5" saying where it is.
//
// Non-negotiable invariants:
// - One part for every surface: RecordViews (gallery, table, board), the
//   NextStepCard pictures, and any host that places React elements.
// - Every file is drawn by THE one file preview (file-preview/FilePreview, in
//   its `glance` size), whose DATA (file-viewers.json) picks the viewer: a
//   video, a sound (with its waveform above when the caller has one), a
//   picture, a PDF page, text or code, an Office document, else the file card.
//   This part draws no file itself and names no kind of file.
// - Only the screen on show is mounted, so one video plays at a time and a
//   carousel of fifty never opens fifty files. Playback reads by range through
//   the shared player; pictures use the small still the caller hands over
//   (`poster`) before ever the whole file.
// - Domain-blind: the caller maps its own items to PreviewItem and draws its
//   own lines and actions under the screen (`details`).
// - Appearance lives in screen-look (show/hover-preview.css and the
//   record-preview look in show/navigation-preview.css).

import React, {useEffect, useState} from 'react'
import {PreviewCard} from '@base-ui/react/preview-card'
import {LAYER_ORDER} from '../layer-order/layer-order'
import {safeEdgePadding} from '../visible-viewport/safe-area-insets'
import {later} from '../load-later/later'
import type {PreviewCarouselProps} from './PreviewCarousel'
import {cardShown} from './card-shown'
import {useShowChange} from '../show-rules/show-of'

export type {PreviewCarouselProps} from './PreviewCarousel'
export type {PreviewItem, PreviewScreenView} from './PreviewScreen'

// The card's content (its screens, the one file preview, the file card) is fetched when a card first opens
// (./PreviewCarousel), so a list with hover previews carries only the trigger.
const PreviewCarousel = later(() => import('./PreviewCarousel'), module => module.PreviewCarousel as React.ComponentType<PreviewCarouselProps<unknown>>)

export interface HoverPreviewProps<T> extends PreviewCarouselProps<T> {
  /** The element the pointer rests on; it keeps its own behaviour. */
  trigger: React.ReactElement<Record<string, unknown>>
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  delay?: number
  /** A nested editor or action owns the interaction while it is active. */
  disabled?: boolean
  /** The card's control, `cards.hover.<surface>` (./card-shown.ts); a show rule hiding it leaves the trigger alone. */
  control?: string
}

/** A preview card that opens when the pointer rests on `trigger` (with a safe
 *  path so the pointer can travel into it) and shows PreviewCarousel. */
export function HoverPreview<T>({trigger, side = 'right', align = 'start', delay = 500, disabled = false, control, ...carousel}: HoverPreviewProps<T>) {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useShowChange()
  if (!cardShown(control)) return trigger
  return (
    <PreviewCard.Root open={disabled ? false : open} onOpenChange={next => { if (!disabled) setOpen(next) }}>
      <PreviewCard.Trigger render={trigger} delay={delay} closeDelay={120}/>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side={side} align={align} sideOffset={10} collisionPadding={safeEdgePadding(12)} style={{zIndex: LAYER_ORDER.menu}}>
          <PreviewCard.Popup className="coss-ui record-preview" data-slot="record-preview">
            <PreviewCarousel {...(carousel as unknown as PreviewCarouselProps<unknown>)}/>
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  )
}
