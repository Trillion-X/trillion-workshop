// packages/ui/show/media-preview/made-preview.tsx
//
// Purpose: the small pictures a file's tile and hover preview need (a still,
// a strip of frames to scrub, a waveform, a document's first page, the
// opening lines of a written file, its line breaks kept), made in the browser from the file
// itself when no server made them, and kept by the caller under the file's
// content identity so they are made once for every later view and device.
//
// Non-negotiable invariants:
// - Made once per identity: the caller's store is asked first. For a stored
//   video, its optional file owner is asked before browser decoding the original;
//   only a file neither owner can preview is made locally and handed back to keep.
// - Only reads what a picture needs: a video is opened by range and seeked to
//   a few moments (the browser fetches those parts, never the whole file); a
//   picture is drawn smaller (a camera's raw photo gives up the preview
//   picture the camera wrote inside it, read by range, never its sensor data);
//   a written file is read only for its opening bytes; only a sound is read whole, and only when its
//   size is under `largest_sound_bytes`, because its waveform needs every
//   sample. Its samples are decoded at a low rate so a long recording stays
//   small in memory.
// - Only nearby tiles ask for previews. A few posters may decode together;
//   a video strip is made only when someone explores that tile.
// - Domain-blind: the caller names the address, the content type and where
//   results are kept; nothing here knows what service holds the bytes.
// - Makers are an OPEN map keyed by content type (`PREVIEW_MAKERS`): the full
//   type is asked first, then the part before the slash. A host adds a maker
//   (a document's first page, document-page-maker.ts) by adding a key.
// - A file that cannot be made (a format the browser cannot decode) answers
//   nothing and the tile keeps its type icon; it is not retried on this page.

import React, {useEffect, useState} from 'react'
import {MediaPreview, type FrameStrip, type MediaPreviewProps} from './MediaPreview'

/** What is made for one file. Every part is optional: a sound has peaks, a
 *  picture or a document a poster, a video a poster and frames, a written
 *  file its opening lines. `lines` keeps the line breaks, so a renderer that
 *  reads the text's shape (a markdown heading, a quote) can; it replaced a
 *  field that folded them, so what was kept that way is made again once. */
export interface MadePreview {
  poster?: string
  /** Version of the video-frame capture path that produced `poster`. */
  video_poster_version?: number
  frames?: FrameStrip
  peaks?: number[]
  duration?: number
  lines?: string
}

/** Where made previews are kept, by the file's content identity. */
export interface MadePreviewStore {
  read(identity: string): Promise<MadePreview | null>
  keep(identity: string, made: MadePreview): Promise<void>
  /** An optional owner for a stored file without a saved preview. A visible
   * video asks it before opening the original in the browser; the owner may
   * queue work and keep its answer by identity. */
  requestMissingPreviews?(identities: string[]): Promise<Record<string, MadePreview | null>>
}

/** Sizes of what is made. */
export interface MadePreviewSizes {
  poster_width: number
  frame_count: number
  frame_width: number
  peak_count: number
  largest_sound_bytes: number
  picture_quality: number
  /** How many opening bytes of a written file are read for its text. */
  text_bytes: number
  /** How many characters of that text are kept. */
  text_length: number
  /** How many opening bytes of a picture are read to find a preview written inside it. */
  embedded_picture_bytes: number
}

export const MADE_PREVIEW_SIZES: MadePreviewSizes = {
  poster_width: 320,
  frame_count: 12,
  frame_width: 160,
  peak_count: 120,
  largest_sound_bytes: 200 * 1024 * 1024,
  picture_quality: 0.72,
  text_bytes: 4096,
  text_length: 240,
  embedded_picture_bytes: 256 * 1024,
}

const SEEK_TIMEOUT_MS = 12000
// The lowest rate browsers decode at; a waveform of 120 bars needs no more.
const SOUND_RATE = 3000

function waitFor(target: EventTarget, name: string, failName = 'error'): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new Error(`${name} took too long`)) }, SEEK_TIMEOUT_MS)
    const ok = () => { done(); resolve() }
    const bad = () => { done(); reject(new Error(`could not read the file for ${name}`)) }
    const done = () => { clearTimeout(timer); target.removeEventListener(name, ok); target.removeEventListener(failName, bad) }
    target.addEventListener(name, ok, {once: true})
    target.addEventListener(failName, bad, {once: true})
  })
}

function canvasOf(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

// The next frame the element presents whose media time `accepts` takes. It is armed BEFORE the seek or playback that
// presents it: a browser presents the sought frame before `seeked` fires and calls back only for frames presented
// after the request, so a request made after `seeked` waits for a frame that never comes (every poster timed out and
// none was kept). Without requestVideoFrameCallback, decoded data (readyState 2) is the closest a browser says.
function presentedFrame(video: HTMLVideoElement, accepts: (mediaTime: number) => boolean): Promise<void> {
  if (typeof video.requestVideoFrameCallback !== 'function') {
    return video.readyState >= 2 ? Promise.resolve() : waitFor(video, 'loadeddata')
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('video frame took too long')), SEEK_TIMEOUT_MS)
    const request = () => video.requestVideoFrameCallback((_now, frame) => {
      if (accepts(frame.mediaTime)) { clearTimeout(timer); resolve() } else request()
    })
    request()
  })
}

async function seekTo(video: HTMLVideoElement, time: number) {
  const presented = presentedFrame(video, mediaTime => Math.abs(mediaTime - time) <= 0.25)
  const seeked = waitFor(video, 'seeked')
  video.currentTime = time
  await seeked
  await presented
}

// A video whose length is not known (a recorded WebM) cannot be sought, and a paused element holding only its
// metadata has presented nothing: a muted, inline playback tick (allowed without a gesture) presents its first frame,
// and the element is paused on it.
async function firstFrame(video: HTMLVideoElement) {
  const presented = presentedFrame(video, () => true)
  if (video.paused !== false && typeof video.play === 'function') void Promise.resolve(video.play()).catch(() => undefined)
  try { await presented } finally { video.pause?.() }
}

async function makeFromVideo(url: string, sizes: MadePreviewSizes): Promise<MadePreview> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'
  const loaded = waitFor(video, 'loadedmetadata')
  video.src = url
  try {
    await loaded
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const aspect = video.videoWidth / Math.max(1, video.videoHeight) || 16 / 9
    const firstMoment = Math.min(1, duration * 0.1)
    if (firstMoment > 0) await seekTo(video, firstMoment)
    else await firstFrame(video)
    const still = canvasOf(sizes.poster_width, sizes.poster_width / aspect)
    still.getContext('2d')!.drawImage(video, 0, 0, still.width, still.height)
    const poster = still.toDataURL('image/jpeg', sizes.picture_quality)
    return {poster, duration, video_poster_version: 1}
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

async function makeVideoFrames(url: string, sizes: MadePreviewSizes): Promise<FrameStrip | null> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'
  const loaded = waitFor(video, 'loadedmetadata')
  video.src = url
  try {
    await loaded
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (!(duration > 0)) return null
    const aspect = video.videoWidth / Math.max(1, video.videoHeight) || 16 / 9
    const frameHeight = Math.round(sizes.frame_width / aspect)
    const strip = canvasOf(sizes.frame_width * sizes.frame_count, frameHeight)
    const context = strip.getContext('2d')!
    for (let index = 0; index < sizes.frame_count; index++) {
      await seekTo(video, (duration * (index + 0.5)) / sizes.frame_count)
      context.drawImage(video, index * sizes.frame_width, 0, sizes.frame_width, frameHeight)
    }
    return {source: strip.toDataURL('image/jpeg', sizes.picture_quality), count: sizes.frame_count, width: sizes.frame_width, height: frameHeight}
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

async function stillOf(url: string, sizes: MadePreviewSizes): Promise<MadePreview> {
  const picture = new Image()
  picture.decoding = 'async'
  const loaded = waitFor(picture, 'load')
  picture.src = url
  await loaded
  const scale = Math.min(1, sizes.poster_width / Math.max(1, picture.naturalWidth))
  const still = canvasOf(picture.naturalWidth * scale, picture.naturalHeight * scale)
  still.getContext('2d')!.drawImage(picture, 0, 0, still.width, still.height)
  return {poster: still.toDataURL('image/jpeg', sizes.picture_quality)}
}

async function readRange(url: string, start: number, length: number): Promise<Uint8Array> {
  const answer = await fetch(url, {credentials: 'same-origin', headers: {Range: `bytes=${start}-${start + length - 1}`}})
  if (!answer.ok) throw new Error(`could not read the file (${answer.status})`)
  // A server that ignores the range sends the whole file; only the asked part is kept.
  return new Uint8Array(await answer.arrayBuffer()).subarray(0, length)
}

/** The largest JPEG a TIFF-shaped picture carries inside it (a camera's raw photo keeps
 *  one for its own screen), as `{offset, length}`, from the picture's opening bytes. */
export function embeddedJpegIn(head: Uint8Array): {offset: number; length: number} | null {
  if (head.length < 8) return null
  const little = head[0] === 0x49 && head[1] === 0x49
  if (!little && !(head[0] === 0x4d && head[1] === 0x4d)) return null
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const u16 = (at: number) => view.getUint16(at, little)
  const u32 = (at: number) => view.getUint32(at, little)
  const found: {offset: number; length: number}[] = []
  const seen = new Set<number>()
  const walk = (start: number) => {
    for (let at = start; at > 0 && at + 2 <= head.length && !seen.has(at); ) {
      seen.add(at)
      const count = u16(at)
      if (at + 2 + count * 12 + 4 > head.length) return
      const tags = new Map<number, {type: number; count: number; value: number}>()
      for (let index = 0; index < count; index++) {
        const entry = at + 2 + index * 12
        const type = u16(entry + 2)
        tags.set(u16(entry), {type, count: u32(entry + 4), value: type === 3 ? u16(entry + 8) : u32(entry + 8)})
      }
      // The camera's own sensor data is JPEG-shaped too but no browser draws it: a picture whose samples are
      // wider than 8 bits, or that is laid out as the sensor's colour grid, is never a preview.
      const bits = tags.get(0x102)
      const sampleBits = !bits ? 8 : bits.count === 1 ? bits.value : bits.value + 2 <= head.length ? u16(bits.value) : 16
      const sensor = sampleBits > 8 || [32803, 34892].includes(tags.get(0x106)?.value ?? 0)
      // A JPEG named by its own two tags, one stored as a single strip of JPEG data, or one kept whole in one tag.
      const strip = [6, 7].includes(tags.get(0x103)?.value ?? 0) && tags.get(0x111)?.count === 1 ? [tags.get(0x111)!.value, tags.get(0x117)?.value] : []
      const whole = tags.get(0x2e)
      const candidates = [[tags.get(0x201)?.value, tags.get(0x202)?.value], strip, whole ? [whole.value, whole.count] : []]
      if (!sensor) for (const [offset, length] of candidates) if (offset && length) found.push({offset, length})
      // Pictures kept below this one (the camera's larger previews).
      const below = tags.get(0x14a)
      if (below) {
        if (below.count === 1) walk(below.value)
        else if (below.value + below.count * 4 <= head.length) for (let index = 0; index < below.count; index++) walk(u32(below.value + index * 4))
      }
      at = u32(at + 2 + count * 12)
    }
  }
  walk(u32(4))
  return found.sort((a, b) => b.length - a.length)[0] ?? null
}

// A picture shaped as a TIFF (a camera's raw photo) that carries a preview JPEG is drawn
// from that preview, read by range, so its tens of megabytes of sensor data are never
// fetched; any other picture the browser draws is drawn smaller.
async function makeFromPicture(url: string, sizes: MadePreviewSizes): Promise<MadePreview> {
  const found = embeddedJpegIn(await readRange(url, 0, sizes.embedded_picture_bytes).catch(() => new Uint8Array()))
  const jpeg = found ? await readRange(url, found.offset, found.length) : null
  if (!jpeg || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return stillOf(url, sizes)
  const address = URL.createObjectURL(new Blob([jpeg as BlobPart], {type: 'image/jpeg'}))
  try { return await stillOf(address, sizes) } finally { URL.revokeObjectURL(address) }
}

/** The opening lines of a written file, at most `length` characters: each line's runs of spaces folded to one and its
 *  end trimmed, more than one empty line between two folded to one, and the line breaks kept. */
export function openingText(bytes: Uint8Array, length: number): string {
  const lines = new TextDecoder('utf-8', {fatal: false}).decode(bytes).replace(/\uFFFD+$/, '')
    .split(/\r\n?|\n/).map(line => line.replace(/[^\S\n]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return lines.length > length ? lines.slice(0, length - 1).trimEnd() + '…' : lines
}

async function makeFromText(url: string, sizes: MadePreviewSizes): Promise<MadePreview> {
  const lines = openingText(await readRange(url, 0, sizes.text_bytes), sizes.text_length)
  return lines ? {lines} : {}
}

async function makeFromSound(url: string, sizes: MadePreviewSizes): Promise<MadePreview> {
  // Ask for one byte first. A large sound must never be downloaded merely to
  // draw its waveform, including when the server omits Content-Length on GET.
  const stop = new AbortController()
  const probe = await fetch(url, {credentials: 'same-origin', headers: {Range: 'bytes=0-0'}, signal: stop.signal})
  const rangeSize = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(probe.headers.get('content-range') ?? '')
  const declaredSize = Number(probe.status === 206 ? rangeSize?.[1] : probe.headers.get('content-length'))
  if (!probe.ok || !Number.isFinite(declaredSize) || declaredSize <= 0 || declaredSize > sizes.largest_sound_bytes) {
    stop.abort()
    return {}
  }
  // A range-aware source needs a second request for the complete small sound;
  // a source that ignored Range already returned that sound in the probe.
  if (probe.status === 206) await probe.body?.cancel()
  const answer = probe.status === 206
    ? await fetch(url, {credentials: 'same-origin', signal: stop.signal})
    : probe
  if (!answer.ok || !answer.body) { stop.abort(); return {} }
  const reader = answer.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const {done, value} = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > sizes.largest_sound_bytes) { stop.abort(); return {} }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const decoder = new OfflineAudioContext(1, 1, SOUND_RATE)
  const sound = await decoder.decodeAudioData(bytes.buffer)
  const samples = sound.getChannelData(0)
  const bucket = Math.max(1, Math.floor(samples.length / sizes.peak_count))
  const raw: number[] = []
  for (let start = 0; start + bucket <= samples.length && raw.length < sizes.peak_count; start += bucket) {
    let loudest = 0
    for (let at = start; at < start + bucket; at++) loudest = Math.max(loudest, Math.abs(samples[at]!))
    raw.push(loudest)
  }
  const top = Math.max(...raw, 0.0001)
  return {peaks: raw.map(value => Math.round((value / top) * 1000) / 1000), duration: sound.duration}
}

export type PreviewMaker = (url: string, sizes: MadePreviewSizes) => Promise<MadePreview>

/** Which maker reads a content type: the full type first, then the part before
 *  the slash. Open: a host adds a key. A type no maker reads makes nothing. */
export const PREVIEW_MAKERS: Record<string, PreviewMaker> = {
  video: makeFromVideo,
  image: makeFromPicture,
  audio: makeFromSound,
  text: makeFromText,
  'application/json': makeFromText,
}

// A made preview worth keeping has something to draw.
const drawable = (made: MadePreview | null | undefined) => Boolean(made && (made.poster || made.peaks || made.lines))

/** Makes a file's previews in this browser. Resolves `{}` when nothing can be made. */
export function makePreview(url: string, contentType: string, sizes: MadePreviewSizes = MADE_PREVIEW_SIZES): Promise<MadePreview> {
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  const maker = PREVIEW_MAKERS[type] ?? PREVIEW_MAKERS[type.split('/')[0]!]
  return maker ? maker(url, sizes) : Promise.resolve({})
}

// One answer per identity for the life of the page. Decoding is bounded, but
// one slow video cannot hold every poster in the gallery behind its frame strip.
const answers = new Map<string, Promise<MadePreview | null>>()
// Answers already in, for a caller that draws synchronously (a hover card
// opened on a tile that has already shown its pictures).
const settled = new Map<string, MadePreview | null>()
const frameAnswers = new Map<string, Promise<MadePreview | null>>()
function bounded(limit: number) {
  let active = 0
  const waiting: Array<() => void> = []
  const runNext = () => { if (active < limit) waiting.shift()?.() }
  return <T,>(job: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const run = () => {
      active++
      job().then(resolve, reject).finally(() => { active--; runNext() })
    }
    if (active < limit) run()
    else waiting.push(run)
  })
}
const makePoster = bounded(4)
const makeStrip = bounded(1)
const currentVideoPoster = (value: MadePreview) => value.video_poster_version === 1 && value.duration !== 0

/** The kept previews for a file, made and kept first if the store has none. */
export function readOrMakePreview(identity: string, url: string, contentType: string, store: MadePreviewStore, sizes: MadePreviewSizes = MADE_PREVIEW_SIZES): Promise<MadePreview | null> {
  const isVideo = contentType.split(';')[0]!.trim().toLowerCase().startsWith('video/')
  let answer = answers.get(identity)
  if (!answer) {
    answer = store.read(identity).then(async kept => {
      if (drawable(kept) && (!isVideo || currentVideoPoster(kept))) return kept
      // A newly uploaded local File is already in hand. Its blob URL can make
      // the poster immediately without waiting for the remote file owner.
      if (isVideo && store.requestMissingPreviews && !url.startsWith('blob:')) {
        const ensured = (await store.requestMissingPreviews([identity]))[identity]
        if (drawable(ensured) && currentVideoPoster(ensured)) return ensured
      }
      const made = makePoster(() => makePreview(url, contentType, sizes))
      return made.then(async value => {
        if (!drawable(value)) return null
        await store.keep(identity, value).catch(() => undefined)
        return value
      }, () => null)
    })
    answers.set(identity, answer)
    answer.then(value => {
      if (value) settled.set(identity, value)
      else answers.delete(identity)
    }, () => { answers.delete(identity) })
  }
  return answer
}

/** A video's scrub strip is optional work, requested only on pointer intent. */
export function readOrMakeFrames(identity: string, url: string, contentType: string, store: MadePreviewStore, sizes: MadePreviewSizes = MADE_PREVIEW_SIZES): Promise<MadePreview | null> {
  if (contentType.split('/')[0] !== 'video') return readOrMakePreview(identity, url, contentType, store, sizes)
  let answer = frameAnswers.get(identity)
  if (!answer) {
    answer = readOrMakePreview(identity, url, contentType, store, sizes).then(async base => {
      if (!base?.poster || base.frames) return base
      const frames = await makeStrip(() => makeVideoFrames(url, sizes)).catch(() => null)
      if (!frames) return base
      const enriched = {...base, frames}
      await store.keep(identity, enriched).catch(() => undefined)
      settled.set(identity, enriched)
      answers.set(identity, Promise.resolve(enriched))
      return enriched
    })
    frameAnswers.set(identity, answer)
    answer.then(value => { if (!value?.frames) frameAnswers.delete(identity) })
  }
  return answer
}

/** The previews already read or made for a file on this page, else undefined. */
export function settledPreview(identity: string): MadePreview | null | undefined {
  return settled.get(identity)
}

/** A saved preview included with a bounded page is ready before its tile mounts. The caller supplies the same
 * content identity and current preview result that `store.read` would return; no file bytes are read here. */
export function primeSavedPreview(identity: string, contentType: string, made: MadePreview): void {
  if (!drawable(made)) return
  if (contentType.split(';')[0]!.trim().toLowerCase().startsWith('video/') && !currentVideoPoster(made)) return
  settled.set(identity, made)
  answers.set(identity, Promise.resolve(made))
}

/** A file's previews once read or made, else null (the tile shows its type icon meanwhile). */
export function useMadePreview(identity: string | null | undefined, url: string | undefined, contentType: string, store: MadePreviewStore | undefined, visible = true): MadePreview | null {
  const [made, setMade] = useState<MadePreview | null>(() => identity ? settled.get(identity) ?? null : null)
  useEffect(() => {
    setMade(identity ? settled.get(identity) ?? null : null)
    if (!identity || !url || !store || !visible) return
    let live = true
    readOrMakePreview(identity, url, contentType, store).then(value => {
      if (!live) return
      setMade(value)
    }, () => { if (live) setMade(null) })
    return () => { live = false }
  }, [identity, url, contentType, store, visible])
  return made
}

export interface MadeMediaPreviewProps extends MediaPreviewProps {
  identity: string | null | undefined
  url: string | undefined
  contentType: string
  store: MadePreviewStore | undefined
}

/** A MediaPreview whose picture, frames, waveform and text come from the made previews. */
export function MadeMediaPreview({identity, url, contentType, store, ...preview}: MadeMediaPreviewProps) {
  const [visible, setVisible] = useState(false)
  const [rich, setRich] = useState<MadePreview | null>(null)
  const made = useMadePreview(identity, url, contentType, store, visible)
  const shown = rich ?? made
  return <MediaPreview {...preview} source={shown?.poster ?? preview.source} frames={shown?.frames} peaks={shown?.peaks} text={shown?.lines ?? preview.text}
    onVisible={visible ? undefined : () => setVisible(true)}
    onPointerEnter={identity && url && store && contentType.startsWith('video/') ? () => { void readOrMakeFrames(identity, url, contentType, store).then(setRich, () => undefined) } : undefined}/>
}

/** The element, for hosts that place React elements (a record-views field `render`). */
export function madeMediaPreviewContent(spec: MadeMediaPreviewProps) {
  return <MadeMediaPreview {...spec}/>
}
