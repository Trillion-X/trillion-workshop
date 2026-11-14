// packages/ui/show/media-preview/MediaPreview.tsx
//
// Purpose: the picture that stands in for one record in a list, gallery or
// board: an image, a video's first frame, a document's first page, a
// recording's waveform, a passage of text, or the record's type and name.
//
// Non-negotiable invariants:
// - Domain-blind. The caller names a renderer id and hands over addresses and
//   text; this file never knows what a record is.
// - Renderers are an OPEN map keyed by id (`MEDIA_PREVIEW_RENDERERS`). An id
//   nobody registered draws the type-icon renderer, never nothing.
// - Never a blank box: a picture shows a shimmer until it has loaded, and a
//   picture, waveform or text that is missing or fails draws the type icon
//   with the record's name.
// - Cheap at a hundred tiles that remount while scrolling: no per-tile timers,
//   one shared IntersectionObserver, and pictures and waveforms already loaded
//   once are remembered, so a remounted tile paints at once without a flash.
// - Appearance lives in screen-look (show/media-preview.css); this file sets
//   classes and data attributes only.

import React, {useEffect, useLayoutEffect, useRef, useState} from 'react'
import {NamedIcon} from '../icon'
import {MarkdownWords} from '../markdown-block/MarkdownWords'

export interface MediaPreviewProps {
  /** Which renderer draws this preview; see MEDIA_PREVIEW_RENDERERS. */
  renderer: string
  /** Address of the picture (image, first frame, first page). */
  source?: string
  /** For `video-frame`: the second of the video at `source` whose frame is shown. */
  at?: number
  /** Address answering `{peaks: number[] (0..1), duration?: number}`. */
  peaksUrl?: string
  /** A waveform already in hand (0..1 per bar); drawn at once, no request. */
  peaks?: readonly number[]
  /** A strip of small frames across a video, side by side in one picture.
   *  Moving the pointer across the tile shows the frame under it. */
  frames?: FrameStrip
  /** A short passage of the record's own text, its line breaks kept. */
  text?: string
  /** The record's name, carried by every renderer. */
  title: string
  /** The words for the record's type, shown with the icon. */
  typeLabel?: string
  /** A named icon for the record's type. */
  icon?: string
  /** The widths the picture at `source` is kept at, and the query key that
   *  asks for one. The tile asks for the smallest width still sharp at its
   *  drawn width times the screen's pixel density, and changes width only
   *  once a resize (a zoom) has settled. Without it `source` is used as is. */
  sourceWidths?: PictureWidths
  onVisible?: () => void
  /** Current proximity to the viewport, using the same shared observer as lazy previews. */
  onVisibilityChange?: (visible: boolean) => void
  onPointerEnter?: () => void
}

/** `count` frames of `width` x `height` pixels, left to right in `source`. */
export interface FrameStrip {
  source: string
  count: number
  width: number
  height: number
}

/** Declared picture widths: `{query_key: 'width', widths: [64, 160, 320, 640]}`. */
export interface PictureWidths {
  query_key: string
  widths: readonly number[]
}

export type MediaPreviewRenderer = (props: MediaPreviewProps) => React.ReactElement

// Pictures that have loaded once in this page. A tile scrolled away and back
// mounts again; knowing the picture is already decoded lets it skip the
// shimmer instead of flashing it for a frame.
const loadedPictures = new Set<string>()
// One request per waveform address for the life of the page, and the peaks
// each answered, so a remounted tile draws its bars in its first paint.
const waveformRequests = new Map<string, Promise<number[]>>()
const loadedPeaks = new Map<string, number[]>()

function readPeaks(url: string): Promise<number[]> {
  let request = waveformRequests.get(url)
  if (!request) {
    request = fetch(url)
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`waveform ${response.status}`)))
      .then(body => {
        const peaks = Array.isArray(body?.peaks) ? body.peaks.map((value: unknown) => Math.max(0, Math.min(1, Number(value) || 0))) : []
        if (!peaks.length) throw new Error('waveform has no peaks')
        loadedPeaks.set(url, peaks)
        return peaks
      })
    // A failed read may succeed later (the file was reconnected), so only a
    // success is remembered.
    request.catch(() => waveformRequests.delete(url))
    waveformRequests.set(url, request)
  }
  return request
}

// One observer for every waveform tile on the page.
let sharedObserver: IntersectionObserver | null = null
const whenVisible = new Map<Element, () => void>()
const visibilityChanges = new Map<Element, (visible: boolean) => void>()
function observer(): IntersectionObserver {
  sharedObserver ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      visibilityChanges.get(entry.target)?.(entry.isIntersecting)
      if (!entry.isIntersecting) continue
      const callback = whenVisible.get(entry.target)
      whenVisible.delete(entry.target)
      if (!visibilityChanges.has(entry.target)) sharedObserver?.unobserve(entry.target)
      callback?.()
    }
  }, {rootMargin: '200px'})
  return sharedObserver
}
function observeOnce(node: Element, onVisible: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onVisible()
    return () => {}
  }
  whenVisible.set(node, onVisible)
  observer().observe(node)
  return () => {
    whenVisible.delete(node)
    if (!visibilityChanges.has(node)) sharedObserver?.unobserve(node)
  }
}
function observeVisibility(node: Element, onChange: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') { onChange(true); return () => {} }
  visibilityChanges.set(node, onChange)
  observer().observe(node)
  return () => {
    visibilityChanges.delete(node)
    if (!whenVisible.has(node)) sharedObserver?.unobserve(node)
  }
}

// The smallest declared width at least `drawn` device pixels wide, else the largest.
export function pictureWidthFor(drawn: number, widths: readonly number[]): number {
  const ordered = [...widths].sort((a, b) => a - b)
  return ordered.find(width => width >= drawn) ?? ordered[ordered.length - 1]!
}

// `source` asking for `width` through the declared query key, the rest of the
// address left exactly as the caller wrote it.
export function sourceAtWidth(source: string, key: string, width: number): string {
  const hash = source.indexOf('#')
  const [address, fragment] = hash < 0 ? [source, ''] : [source.slice(0, hash), source.slice(hash)]
  return `${address}${address.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${width}${fragment}`
}

// One ResizeObserver for every sized picture on the page. A zoom resizes every
// tile at once; each tile hears its new width only once resizing has been
// quiet for a moment, so a pinch does not fetch every width it passes through.
const SIZE_SETTLE_MS = 180
let sizeObserver: ResizeObserver | null = null
const onSettledSize = new Map<Element, (width: number) => void>()
const unsettled = new Map<Element, number>()
let settleTimer: ReturnType<typeof setTimeout> | undefined
function watchSize(node: Element, onSettled: (width: number) => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}
  sizeObserver ??= new ResizeObserver(entries => {
    for (const entry of entries) unsettled.set(entry.target, entry.contentRect.width)
    clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      for (const [target, width] of unsettled) onSettledSize.get(target)?.(width)
      unsettled.clear()
    }, SIZE_SETTLE_MS)
  })
  onSettledSize.set(node, onSettled)
  sizeObserver.observe(node)
  return () => {
    onSettledSize.delete(node)
    unsettled.delete(node)
    sizeObserver?.unobserve(node)
  }
}

// The address a sized tile shows: chosen from its drawn width when it mounts,
// then again whenever a resize settles.
function useSizedSource(frame: React.RefObject<HTMLSpanElement | null>, source: string | undefined, sizes: PictureWidths | undefined): string | undefined {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const node = frame.current
    if (!sizes || !node) return
    const density = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    const choose = (drawn: number) => { if (drawn > 0) setWidth(pictureWidthFor(drawn * density, sizes.widths)) }
    choose(node.clientWidth)
    return watchSize(node, choose)
  }, [frame, sizes])
  if (!source || !sizes) return source
  return width ? sourceAtWidth(source, sizes.query_key, width) : undefined
}

interface FrameProps {renderer: string; state: 'loading' | 'ready' | 'absent'; title: string; children: React.ReactNode; onVisible?: () => void; onVisibilityChange?: (visible: boolean) => void; onPointerEnter?: () => void}
const Frame = React.forwardRef<HTMLSpanElement, FrameProps>(function Frame({renderer, state, title, children, onVisible, onVisibilityChange, onPointerEnter}, ref) {
  const node = useRef<HTMLSpanElement>(null)
  React.useImperativeHandle(ref, () => node.current!, [])
  useEffect(() => onVisible && node.current ? observeOnce(node.current, onVisible) : undefined, [onVisible])
  useEffect(() => onVisibilityChange && node.current ? observeVisibility(node.current, onVisibilityChange) : undefined, [onVisibilityChange])
  return (
    <span ref={node} className="media-preview" data-renderer={renderer} data-state={state} role="img" aria-label={title} title={title} onPointerEnter={onPointerEnter}>
      {children}
      {state === 'loading' && <span className="media-preview-shimmer" aria-hidden="true"/>}
    </span>
  )
})

// The record's type as a small mark: its icon and the words for it.
function TypeMark({typeLabel, icon}: Pick<MediaPreviewProps, 'typeLabel' | 'icon'>) {
  return (
    <span className="media-preview-type-mark">
      <NamedIcon name={icon} fallback="File" className="media-preview-type-icon" aria-hidden="true"/>
      {typeLabel && <span className="media-preview-type-label">{typeLabel}</span>}
    </span>
  )
}

function TypeIcon({title, typeLabel, icon, onVisible, onVisibilityChange, onPointerEnter}: MediaPreviewProps) {
  return (
    <Frame renderer="type-icon" state="absent" title={title} onVisible={onVisible} onVisibilityChange={onVisibilityChange} onPointerEnter={onPointerEnter}>
      <span className="media-preview-type">
        <TypeMark typeLabel={typeLabel} icon={icon}/>
        <span className="media-preview-type-title">{title}</span>
      </span>
    </Frame>
  )
}

function Picture(props: MediaPreviewProps) {
  const {renderer, source, title, sourceWidths} = props
  const frame = useRef<HTMLSpanElement>(null)
  const wanted = useSizedSource(frame, source, sourceWidths)
  // The address on screen. A new width loads beside the one showing and
  // replaces it once decoded, so a zoom never flashes back to the shimmer.
  const [shown, setShown] = useState<string | undefined>(() => wanted)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(() => wanted && loadedPictures.has(wanted) ? 'ready' : 'loading')
  const image = useRef<HTMLImageElement>(null)
  useEffect(() => {
    if (!wanted || wanted === shown) return
    if (!shown || state !== 'ready' || loadedPictures.has(wanted)) { setShown(wanted); return }
    let live = true
    const next = new Image()
    next.decoding = 'async'
    next.onload = () => { loadedPictures.add(wanted); if (live) setShown(wanted) }
    next.src = wanted
    return () => { live = false; next.onload = null; next.src = '' }
  }, [wanted, shown, state])
  useLayoutEffect(() => {
    // A picture the browser already holds reports complete before any load
    // event can fire; read it now so the tile paints without a shimmer.
    const node = image.current
    setState(shown && (loadedPictures.has(shown) || (node?.complete && node.naturalWidth > 0)) ? 'ready' : 'loading')
  }, [shown])
  if (!source || state === 'failed') return <TypeIcon {...props}/>
  return (
    <Frame ref={frame} renderer={renderer} state={state === 'ready' ? 'ready' : 'loading'} title={title} onVisible={props.onVisible} onVisibilityChange={props.onVisibilityChange} onPointerEnter={props.onPointerEnter}>
      {props.frames && <FrameScrub strip={props.frames}/>}
      {shown && <img
        ref={image}
        className="media-preview-picture"
        src={shown}
        alt=""
        decoding="async"
        loading="lazy"
        draggable={false}
        onLoad={() => { loadedPictures.add(shown); setState('ready') }}
        onError={() => setState('failed')}
      />}
    </Frame>
  )
}

// The frame under the pointer, from a strip of small frames. Nothing shows until
// the pointer moves over the tile, and leaving it returns the still picture.
// The strip is one small picture, so scrubbing never reads the video itself.
function FrameScrub({strip}: {strip: FrameStrip}) {
  const [at, setAt] = useState<number | null>(null)
  const count = Math.max(1, Math.floor(strip.count))
  const choose = (event: React.PointerEvent<HTMLSpanElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const share = box.width > 0 ? (event.clientX - box.left) / box.width : 0
    setAt(Math.min(count - 1, Math.max(0, Math.floor(share * count))))
  }
  return (
    <span className="media-preview-scrub" data-scrubbing={at === null ? undefined : ''} onPointerMove={choose} onPointerLeave={() => setAt(null)} aria-hidden="true">
      {at !== null && <span
        className="media-preview-scrub-frame"
        style={{
          '--media-preview-frame-aspect': strip.width / Math.max(1, strip.height),
          backgroundImage: `url("${strip.source}")`,
          backgroundSize: `${count * 100}% 100%`,
          backgroundPositionX: count > 1 ? `${(at / (count - 1)) * 100}%` : '0%',
        } as React.CSSProperties}
      />}
      {at !== null && <span className="media-preview-scrub-line" style={{width: `${((at + 1) / count) * 100}%`}}/>}
    </span>
  )
}

function Waveform(props: MediaPreviewProps) {
  const {peaksUrl, title} = props
  if (props.peaks?.length) return <WaveformBars peaks={props.peaks} title={title} onVisibilityChange={props.onVisibilityChange}/>
  return <LoadedWaveform {...props} peaksUrl={peaksUrl}/>
}

function WaveformBars({peaks, title, frame, ready = true, onVisibilityChange}: {peaks: readonly number[] | null; title: string; frame?: React.Ref<HTMLSpanElement>; ready?: boolean; onVisibilityChange?: (visible: boolean) => void}) {
  return (
    <Frame ref={frame} renderer="waveform" state={ready && peaks ? 'ready' : 'loading'} title={title} onVisibilityChange={onVisibilityChange}>
      {peaks && (
        <svg className="media-preview-waveform" viewBox={`0 0 ${peaks.length} 100`} preserveAspectRatio="none" aria-hidden="true">
          {peaks.map((peak, index) => {
            const height = Math.max(4, Math.max(0, Math.min(1, peak)) * 88)
            return <rect key={index} className="media-preview-waveform-bar" x={index + 0.18} y={50 - height / 2} width={0.64} height={height}/>
          })}
        </svg>
      )}
    </Frame>
  )
}

function LoadedWaveform(props: MediaPreviewProps) {
  const {peaksUrl, title} = props
  const [peaks, setPeaks] = useState<number[] | null>(() => peaksUrl ? loadedPeaks.get(peaksUrl) ?? null : null)
  const [failed, setFailed] = useState(false)
  const frame = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const known = peaksUrl ? loadedPeaks.get(peaksUrl) ?? null : null
    setPeaks(known)
    setFailed(false)
    const node = frame.current
    if (!peaksUrl || !node || known) return
    let live = true
    const stop = observeOnce(node, () => {
      readPeaks(peaksUrl).then(read => { if (live) setPeaks(read) }, () => { if (live) setFailed(true) })
    })
    return () => { live = false; stop() }
  }, [peaksUrl])
  if (!peaksUrl || failed) return <TypeIcon {...props}/>
  return <WaveformBars peaks={peaks} title={title} frame={frame} onVisibilityChange={props.onVisibilityChange}/>
}

function TextSnippet(props: MediaPreviewProps) {
  if (!props.text) return <TypeIcon {...props}/>
  return (
    <Frame renderer="text-snippet" state="ready" title={props.title} onVisibilityChange={props.onVisibilityChange}>
      <span className="media-preview-snippet">{props.text}</span>
      <TypeMark typeLabel={props.typeLabel} icon={props.icon}/>
    </Frame>
  )
}

// A passage written in markdown (a note's opening lines) drawn as the words it says, by the one markdown renderer the
// file preview uses: a heading is a bold line, a quote an indented line, a list its items, never their "#" or ">".
// Links are drawn as their words, since the whole tile is what opens.
function MarkdownSnippet(props: MediaPreviewProps) {
  if (!props.text) return <TypeIcon {...props}/>
  return (
    <Frame renderer="markdown-snippet" state="ready" title={props.title} onVisibilityChange={props.onVisibilityChange}>
      <MarkdownWords words={props.text} links={false} className="media-preview-snippet"/>
      <TypeMark typeLabel={props.typeLabel} icon={props.icon}/>
    </Frame>
  )
}

// One frame of a video at a time (`at`, seconds), read by range from the video itself: a search result shows the
// moment it found, not the video's first frame. The video never plays here and makes no sound; the browser reads
// only what that frame needs. Until the frame is decoded the tile shimmers; a video that cannot be read draws the icon.
function VideoFrame(props: MediaPreviewProps) {
  const {renderer, source, title, at = 0} = props
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => setState('loading'), [source, at])
  if (!source || state === 'failed') return <TypeIcon {...props}/>
  return (
    <Frame renderer={renderer} state={state === 'ready' ? 'ready' : 'loading'} title={title} onVisibilityChange={props.onVisibilityChange}>
      <video
        className="media-preview-picture"
        src={`${source}#t=${Math.max(0, at).toFixed(2)}`}
        muted
        playsInline
        preload="metadata"
        disablePictureInPicture
        tabIndex={-1}
        aria-hidden="true"
        onLoadedData={() => setState('ready')}
        onSeeked={() => setState('ready')}
        onError={() => setState('failed')}
      />
    </Frame>
  )
}

/** Renderers by id. Open: a surface may add an id; an unknown id draws the type icon. */
export const MEDIA_PREVIEW_RENDERERS: Record<string, MediaPreviewRenderer> = {
  image: props => <Picture {...props}/>,
  'video-poster': props => <Picture {...props}/>,
  'document-page': props => <Picture {...props}/>,
  'video-frame': props => <VideoFrame {...props}/>,
  waveform: props => <Waveform {...props}/>,
  'text-snippet': props => <TextSnippet {...props}/>,
  'markdown-snippet': props => <MarkdownSnippet {...props}/>,
  'type-icon': props => <TypeIcon {...props}/>,
}

export function MediaPreview(props: MediaPreviewProps) {
  const render = MEDIA_PREVIEW_RENDERERS[props.renderer] ?? MEDIA_PREVIEW_RENDERERS['type-icon']
  // A renderer may use hooks. Its own component boundary keeps their order stable
  // when an admitted preview replaces a type mark or changes file family.
  return React.createElement(render, props)
}

/** A record's preview as a React element, for hosts that place elements. */
export function mediaPreviewContent(spec: MediaPreviewProps) {
  return <MediaPreview {...spec}/>
}
