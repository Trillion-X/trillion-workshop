// parts/ui/show/media-preview/heif-picture-maker.ts
//
// Purpose: a HEIC/HEIF photo's still (an iPhone's own format), so its tile
// shows the photo in every browser, not only Safari. The browser's own
// decoder is tried first; where it has none (Chrome, Arc, Firefox) the photo
// is decoded with libheif (LGPL-3.0, WebAssembly) and drawn at the still width.
// The still is then kept with the file by the made-preview store, so each
// photo is decoded once for everyone who opens it.
//
// Non-negotiable invariants:
// - The decoder is loaded from the address the host serves it at, as its own
//   file, only when a HEIF tile is first made; a page with no such photos
//   never loads it, and the decoder stays a separately replaceable file.
// - A photo larger than `largest_bytes` is not read; its tile keeps its icon.
// - Domain-blind: nothing here knows which screen or service holds the file.
// - Plugged in through the open maker map: the host sets
//   `PREVIEW_MAKERS['image/heic'] = heifPictureMaker(...)`.

import type {MadePreview, MadePreviewSizes, PreviewMaker} from './made-preview'

/** Where the host serves the HEIF decoder (libheif-bundle.mjs), and the largest photo it reads. */
export interface HeifDecoderServed {
  module: string
  largest_bytes: number
}

interface HeifImage {
  get_width(): number
  get_height(): number
  display(target: ImageData, done: (shown: ImageData | null) => void): void
  free?(): void
}
interface HeifLibrary {HeifDecoder: new () => {decode(bytes: Uint8Array): HeifImage[]}; ready?: Promise<unknown>}

let library: Promise<HeifLibrary> | null = null
// The address is a value, so the bundler never follows it: the decoder stays its own served file.
const load = (address: string) => (library ??= (import(address) as Promise<{default: () => HeifLibrary}>)
  .then(async module => { const made = module.default(); await made.ready; return made })
  .catch(error => { library = null; throw error }))

/** A maker for HEIF photos: the browser's own still when it can decode one, else the photo decoded with libheif. */
export function heifPictureMaker(served: HeifDecoderServed, native?: PreviewMaker): PreviewMaker {
  return async (url: string, sizes: MadePreviewSizes): Promise<MadePreview> => {
    const own = native ? await native(url, sizes).catch(() => ({} as MadePreview)) : {}
    if (own.poster) return own
    const stop = new AbortController()
    const answer = await fetch(url, {credentials: 'same-origin', signal: stop.signal})
    if (!answer.ok || Number(answer.headers.get('content-length')) > served.largest_bytes) { stop.abort(); return {} }
    const bytes = new Uint8Array(await answer.arrayBuffer())
    const heif = await load(served.module)
    const [image, ...others] = new heif.HeifDecoder().decode(bytes)
    if (!image) return {}
    try {
      const width = image.get_width(), height = image.get_height()
      const full = document.createElement('canvas')
      full.width = width
      full.height = height
      const context = full.getContext('2d')!
      const pixels = context.createImageData(width, height)
      await new Promise<void>((resolve, reject) => image.display(pixels, shown => (shown ? resolve() : reject(new Error('This photo could not be read.')))))
      context.putImageData(pixels, 0, 0)
      const scale = Math.min(1, sizes.poster_width / width)
      const still = document.createElement('canvas')
      still.width = Math.max(1, Math.round(width * scale))
      still.height = Math.max(1, Math.round(height * scale))
      still.getContext('2d')!.drawImage(full, 0, 0, still.width, still.height)
      return {poster: still.toDataURL('image/jpeg', sizes.picture_quality)}
    } finally {
      for (const each of [image, ...others]) each.free?.()
    }
  }
}
