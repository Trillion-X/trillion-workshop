// parts/ui/show/media-preview/pdf-reader.ts
//
// Purpose: the one place a page learns where the PDF page reader (pdf.js, Apache-2.0) is served, and the one loader
// of it. A PDF tile's cover (document-page-maker.ts) and a PDF shown as its pages (file-preview/FilePreview) both read
// the reader through here, so it is loaded once per page and served from one address.
//
// Non-negotiable invariants:
// - Domain-blind: the host says where the reader and its worker are served (`servePdfReader`), once, before a PDF is
//   drawn; nothing here knows which screen or app it runs in.
// - Loaded only when a PDF is first drawn; a page with no PDFs never loads it.
// - The address is a value, so the bundler never follows it: the reader stays its own served file a person can
//   replace (scripts/open-source-notices.json serves it).
// - A page that names no reader gets a refusal, never a guess at an address.

/** Where the host serves the PDF page reader (pdf.min.mjs) and its worker (pdf.worker.min.mjs). */
export interface PdfReaderAddress {
  readonly module: string
  readonly worker: string
}

export interface PdfViewport {
  readonly width: number
  readonly height: number
  readonly scale: number
}
export interface PdfPage {
  getViewport(options: {scale: number}): PdfViewport
  render(options: {canvas: HTMLCanvasElement; viewport: PdfViewport}): {promise: Promise<void>; cancel(): void}
  streamTextContent(): ReadableStream
}
export interface PdfDocument {
  readonly numPages: number
  getPage(number: number): Promise<PdfPage>
}
export interface PdfLoading {
  readonly promise: Promise<PdfDocument>
  destroy(): Promise<void>
}
export interface PdfTextLayer {
  render(): Promise<void>
  cancel(): void
}
export interface PdfReader {
  GlobalWorkerOptions: {workerSrc: string}
  getDocument(options: {url: string; withCredentials?: boolean; disableStream?: boolean; disableAutoFetch?: boolean}): PdfLoading
  TextLayer: new (options: {textContentSource: ReadableStream; container: HTMLElement; viewport: PdfViewport}) => PdfTextLayer
}

let served: PdfReaderAddress | null = null
let reader: Promise<PdfReader> | null = null

/** Says where this page serves the PDF page reader. Called once by the host, before any PDF is drawn. */
export function servePdfReader(address: PdfReaderAddress): void {
  served = address
}

/** The PDF page reader, loaded the first time it is asked for. Rejects when the host serves none. */
export function pdfReader(): Promise<PdfReader> {
  const address = served
  if (!address) return Promise.reject(new Error('This page serves no PDF reader.'))
  return (reader ??= (import(address.module) as Promise<PdfReader>).then(loaded => {
    loaded.GlobalWorkerOptions.workerSrc = address.worker
    return loaded
  }, error => {
    reader = null
    throw error
  }))
}
