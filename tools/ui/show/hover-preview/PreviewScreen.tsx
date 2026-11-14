// packages/ui/show/hover-preview/PreviewScreen.tsx
//
// Purpose: one item drawn as a screen (PreviewScreen): its file through THE one file preview, or its small picture,
// text or icon. The open hover card (PreviewCarousel) and a list's media cells (record-views) both draw it.
//
// Non-negotiable invariants: those of HoverPreview.tsx, which this file draws for.

import React from 'react'
import { lazyPart } from '../load-later/later';
import {MediaPreview, type FrameStrip} from '../media-preview/MediaPreview'
import {chooseFileViewer} from '../file-preview/choose-file-viewer'
import {setPlaceableSurfaceDragData, type PlaceableSurfacePayload} from '../placeable-surface-intent/placeable-surface-intent'

// The one file preview (and its player) is fetched when a preview first opens, so a list with hover previews never
// loads the player with its screen.
const FilePreview = lazyPart(() => import('../file-preview/FilePreview'), module => module.FilePreview)

/** One thing a hover preview can show. Every address is read only when its screen is on show. */
export interface PreviewItem {
  id: string
  title: string
  /** Where the content plays or shows from, read by range. */
  url?: string
  /** Content type ("video/mp4"); with the title's extension it chooses the viewer (file-preview/file-viewers.json). */
  type?: string
  /** A small still: a video's first frame, a document's first page, a picture made smaller. */
  poster?: string
  frames?: FrameStrip
  /** A waveform in hand, or the address of one (`{peaks: number[]}`). */
  peaks?: readonly number[]
  peaksUrl?: string
  /** Text shown when there is no file to read. */
  text?: string
  icon?: string
  typeLabel?: string
  /** What opens when the screen is dragged onto the screen arrangement (a tab for this file). Without it the
   *  screen is not draggable. */
  open?: PlaceableSurfacePayload
}

/** One item drawn as a screen. */
export type PreviewScreenView = (item: PreviewItem) => React.ReactElement

// The waveform drawn above a sound's player, when the caller has one.
function Waveform({item}: {item: PreviewItem}) {
  if (!item.peaks?.length && !item.peaksUrl) return null
  return (
    <div className="hover-preview-waveform">
      <MediaPreview renderer="waveform" peaks={item.peaks} peaksUrl={item.peaksUrl} title={item.title} icon={item.icon} typeLabel={item.typeLabel}/>
    </div>
  )
}

/** The screen for one item: its bytes through the one file preview (FilePreview, whose DATA picks the viewer), or,
 *  with nothing to read, the item's own small picture, text or icon (MediaPreview). A video waits on its poster (or,
 *  with none made yet, its own first frame) until the person presses play, so a glance never shows a black box. */
export function PreviewScreen({item}: {item: PreviewItem}) {
  const viewer = item.url ? chooseFileViewer({contentType: item.type, name: item.title}) : 'card'
  const open = item.open
  const drag = open ? {draggable: true, onDragStart: (event: React.DragEvent) => setPlaceableSurfaceDragData(event.dataTransfer, open, item.title)} : {}
  return (
    <div className="hover-preview-screen" data-preview-screen={viewer} {...drag}>
      {item.url ? (
        <>
          {viewer === 'sound' && <Waveform item={item}/>}
          <React.Suspense fallback={null}><FilePreview url={item.url} contentType={item.type ?? ''} label={item.title} poster={item.poster} glance autoPlay={false}/></React.Suspense>
        </>
      ) : (
        <MediaPreview renderer={item.poster ? 'image' : item.text ? 'text-snippet' : 'type-icon'} source={item.poster} text={item.text} title={item.title} icon={item.icon} typeLabel={item.typeLabel}/>
      )}
    </div>
  )
}
