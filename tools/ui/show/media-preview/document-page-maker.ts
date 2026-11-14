// parts/ui/show/media-preview/document-page-maker.ts
//
// Purpose: a document's first page as its still, made in the browser with the
// PDF page reader (pdf.js, Apache-2.0, loaded through pdf-reader.ts), so a PDF
// tile shows its cover the way the Mac app's Library does instead of a type icon.
//
// Non-negotiable invariants:
// - Reads only what the first page needs: the reader asks for the file by
//   range and never streams the rest.
// - The reader is the one the host serves (pdf-reader.ts `servePdfReader`),
//   loaded only when a document tile is first made; a page with no documents
//   never loads it.
// - Domain-blind: nothing here knows which screen or service holds the file.
// - Plugged in through the open maker map: the host sets
//   `PREVIEW_MAKERS['application/pdf'] = documentPageMaker()`.

import type {MadePreview, MadePreviewSizes, PreviewMaker} from './made-preview'
import {pdfReader} from './pdf-reader'

/** A maker that draws a document's first page at the still width. */
export function documentPageMaker(): PreviewMaker {
  return async (url: string, sizes: MadePreviewSizes): Promise<MadePreview> => {
    const pdf = await pdfReader()
    const task = pdf.getDocument({url, withCredentials: true, disableStream: true, disableAutoFetch: true})
    try {
      const page = await (await task.promise).getPage(1)
      const natural = page.getViewport({scale: 1})
      const viewport = page.getViewport({scale: sizes.poster_width / Math.max(1, natural.width)})
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      await page.render({canvas, viewport}).promise
      return {poster: canvas.toDataURL('image/jpeg', sizes.picture_quality)}
    } finally {
      await task.destroy()
    }
  }
}
