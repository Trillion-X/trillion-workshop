// packages/ui/show/file-preview/FilePreview.tsx
//
// THE one preview of a file, everywhere a file is shown: a file opened in its own tab, the view an AI app draws for
// one file, and the file inside a hover card or carousel. Which viewer draws a file is DATA (file-viewers.json, read
// by choose-file-viewer.ts): its media type, else its name's extension. Viewers are an open map (FILE_VIEWERS below);
// a new kind of file is a row there, a new way of showing one is an entry here:
//
//   video    -> the shared player (media-playback MediaPlaybackSurface), fitted to the box; a clip may start silently
//   sound    -> the same shared player drawing its sound face: a large play, the sound's own waveform to seek on, the
//               time and speed, and, when the host hands its timed words (`timedText`), the words under it following
//               the sound, the word being said marked, a word clicked to play from there
//   picture  -> the whole picture fitted, zoomable (− / % / +, pinch, ctrl/⌘-scroll, double-click) and draggable
//   pdf      -> its pages drawn by the page reader the host serves (media-preview/pdf-reader.ts): a page count, zoom,
//               a strip of numbered page pictures to jump by when the box is wide, and text that can be selected and
//               copied; only the pages near the view are drawn. A glance draws the first page. A host that serves no
//               reader shows the browser's own page viewer
//   table    -> delimited text (the separator its viewer row names in `settings`) in the same lettered grid a
//               workbook sheet uses
//   text     -> text and code, the first MiB read by range (the first 4 KiB in a glance), with how much was shown
//   markdown -> the same read, drawn as a formatted document by the one markdown renderer (document-page markdownHtml:
//               raw HTML shown as text, only http(s)/same-page links, which open in a new tab) in MarkdownWords
//   office   -> a Word document's paragraphs and tables, an Excel workbook's sheets, a PowerPoint deck's slides,
//               read in the browser (read-office-document.ts)
//   file     -> anything else: its icon, name and a Download button
//
// Non-negotiable invariants:
// 1. Video and sound ALWAYS play in the shared player, never the browser's own controls (a guard test fails on a
//    native-controls element anywhere outside media-playback). Raw elements are legal ONLY inside ui/ primitives;
//    feature code uses <FilePreview/>, never these elements directly.
// 2. No kind of file is named in this file; the DATA rows name them all.
// 3. Reading is by range wherever the viewer can: the player and the page reader ask for the parts they show, text
//    and tables read their first MiB. Only an Office file is read whole, because its directory is at its end, and only up to
//    OFFICE_MAX_BYTES.
// 4. Default is FIT-to-container: the whole file is visible without scrolling the page the moment it opens.
// 5. A file that cannot be read here shows the file card with Download; nothing is left blank or guessed.
import React from 'react';
import { cn } from '../cn';
import type { MediaPlaybackSeekRequest, TimedTextSegment } from '../../../media-playback/show/MediaPlaybackSurface';
import { MediaPlaybackSurface } from '../../../media-playback/show/lazy-playback-surface';
import { Button } from '../coss/ui/button';
import { Spinner } from '../spinner/Spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../coss/ui/table';
import { NamedIcon } from '../icon';
import { chooseFileView, namedType } from './choose-file-viewer';
import { readDelimitedText } from './read-delimited-text';
import { pdfReader, type PdfDocument, type PdfLoading, type PdfTextLayer } from '../media-preview/pdf-reader';
import { readOfficeDocument, type OfficeReading } from './read-office-document';
import { MarkdownWords } from '../markdown-block/MarkdownWords';
import { downloadAddress } from '../file-download/download-file';

export interface FilePreviewProps {
  /** Where the file's bytes are read from (an address answering Range requests, or a blob:/data: URL). */
  readonly url: string;
  /** Media type, e.g. "video/mp4", "application/pdf". May name nothing; the label's extension then decides. */
  readonly contentType: string;
  /** The file's name, shown and used for its extension and as the download name. */
  readonly label?: string;
  /** Start video playback automatically (silently) so a dropped clip just begins. */
  readonly autoPlay?: boolean;
  /** A still shown before a video's first frame arrives, and a page's picture in a glance. */
  readonly poster?: string;
  /** A small look (hover card, carousel): less is read and no zoom controls are drawn. */
  readonly glance?: boolean;
  /** A text file's first part the caller already holds (`shownBytes` of its `byteLength`): the text viewer shows it
   * instead of reading the address, for a host whose frame may refuse the read (a view an AI app draws). */
  readonly firstText?: { readonly text: string; readonly shownBytes: number; readonly byteLength: number };
  /** The words said in a sound or video with their times, when the host has them: the player shows them with it. */
  readonly timedText?: readonly TimedTextSegment[];
  /** A sound or video tells where it is playing (seconds, and its length) as it plays, for a host that follows it. */
  readonly onTimeChange?: (currentTime: number, duration: number) => void;
  /** A host moves a sound or video to a second by handing a new request (a new requestId each time). */
  readonly seekRequest?: MediaPlaybackSeekRequest | null;
  readonly className?: string;
}

// How much of a text file is read: enough to read comfortably in a tab, a screenful in a glance.
const TEXT_BYTES = { full: 1024 * 1024, glance: 4096 };
// An Office file larger than this shows its card; its directory is at its end, so it is read whole.
const OFFICE_MAX_BYTES = 64 * 1024 * 1024;

const sizeWords = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;

// The whole size a ranged answer reports ("bytes 0-4095/91234"), else its own length.
function totalSize(response: Response): number | null {
  const range = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '');
  if (range) return Number(range[1]);
  const length = Number(response.headers.get('content-length'));
  return Number.isFinite(length) && length > 0 ? length : null;
}

type Loaded<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed' };

// One read per url; a newer url replaces the answer of an older one.
function useRead<T>(url: string, read: (signal: AbortSignal) => Promise<T>): Loaded<T> {
  const [loaded, setLoaded] = React.useState<Loaded<T>>({ state: 'loading' });
  const reader = React.useRef(read);
  reader.current = read;
  React.useEffect(() => {
    const control = new AbortController();
    setLoaded({ state: 'loading' });
    reader.current(control.signal).then(
      value => { if (!control.signal.aborted) setLoaded({ state: 'ready', value }); },
      () => { if (!control.signal.aborted) setLoaded({ state: 'failed' }); },
    );
    return () => control.abort();
  }, [url]);
  return loaded;
}

function Reading({ label }: { label: string }) {
  return (
    <div className="file-preview-reading" data-screen-state="loading" role="status" aria-label={`Opening ${label}`}>
      <Spinner size="md" aria-hidden />
    </div>
  );
}

// ── Zoomable image ──────────────────────────────────────────────────────────
// The whole picture fits the container at 100% (object-contain). From there the
// user zooms continuously by any of: the on-canvas −/%/+ toolbar, trackpad pinch,
// ctrl/⌘+scroll, or double-click; and pans by dragging while zoomed. Zoom is
// applied as a CSS transform on a full-size wrapper (origin = container center),
// so the same pointer math works regardless of image aspect ratio.
const FIT_SCALE = 1;      // 1.0 = object-contain "whole image fits the box"
const MIN_SCALE = 0.2;    // can shrink below fit (zoom out) to see it smaller / give pan room
const MAX_SCALE = 8;
const BUTTON_STEP = 1.4;

function clampScale(value: number): number {
  return value < MIN_SCALE ? MIN_SCALE : value > MAX_SCALE ? MAX_SCALE : value;
}

interface ImageView {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

const FIT_VIEW: ImageView = { scale: 1, tx: 0, ty: 0 };

function ZoomableImage({ url, label }: { url: string; label: string }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [view, setView] = React.useState<ImageView>(FIT_VIEW);
  const [dragging, setDragging] = React.useState(false);
  const viewRef = React.useRef<ImageView>(view);
  viewRef.current = view;

  // Cursor/gesture position relative to the container CENTER (= transform origin).
  const pointFromCenter = React.useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }, []);

  // Multiply the current scale by `factor`, keeping the point (px,py) — measured
  // from the container center — visually fixed. The whole transform is computed
  // inside a functional state update so rapid successive zooms (held +, fast
  // pinch) always compose from the LATEST scale, never a stale render snapshot.
  // Snapping back to exactly 1 resets the pan so a fit image is always centered.
  const zoomAround = React.useCallback((px: number, py: number, factor: number) => {
    setView((current) => {
      const next = clampScale(current.scale * factor);
      if (next === current.scale) return current;
      if (next === FIT_SCALE) return FIT_VIEW;
      const ratio = next / current.scale;
      return {
        scale: next,
        tx: px - (px - current.tx) * ratio,
        ty: py - (py - current.ty) * ratio,
      };
    });
  }, []);

  const zoomFromButton = React.useCallback((factor: number) => zoomAround(0, 0, factor), [zoomAround]);
  const resetView = React.useCallback(() => setView(FIT_VIEW), []);

  // Pinch / ctrl-scroll must be native, non-passive listeners so we can
  // preventDefault and stop the browser (incl. WKWebView) from page-zooming.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return; // pinch/⌘ = zoom; plain wheel = browser scroll
      event.preventDefault();
      const point = pointFromCenter(event.clientX, event.clientY);
      zoomAround(point.x, point.y, Math.exp(-event.deltaY * 0.01));
    };

    // WebKit (the macOS shell) reports trackpad pinch as gesture* events whose
    // `scale` is cumulative since gesturestart — convert to a per-event factor.
    let lastGestureScale = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      lastGestureScale = (event as unknown as { scale?: number }).scale ?? 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const e = event as unknown as { scale?: number; clientX?: number; clientY?: number };
      const next = e.scale ?? 1;
      const factor = next / (lastGestureScale || 1);
      lastGestureScale = next;
      const point = pointFromCenter(e.clientX ?? 0, e.clientY ?? 0);
      zoomAround(point.x, point.y, factor);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart, { passive: false });
    el.addEventListener('gesturechange', onGestureChange, { passive: false });
    el.addEventListener('gestureend', onGestureStart, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureStart);
    };
  }, [pointFromCenter, zoomAround]);

  // Drag to pan while zoomed in (only meaningful when the image is bigger than the box).
  const drag = React.useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (viewRef.current.scale <= FIT_SCALE) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty };
    setDragging(true);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    setView((value) => ({ ...value, tx: start.tx + (event.clientX - start.x), ty: start.ty + (event.clientY - start.y) }));
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (viewRef.current.scale !== FIT_SCALE) {
      resetView();
      return;
    }
    const point = pointFromCenter(event.clientX, event.clientY);
    zoomAround(point.x, point.y, 2.5);
  };

  const zoomedIn = view.scale > FIT_SCALE;
  const atFit = view.scale === FIT_SCALE;
  const percent = Math.round(view.scale * 100);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-black/20 [touch-action:none] select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      style={{ cursor: zoomedIn ? (dragging ? 'grabbing' : 'grab') : 'zoom-in' }}
    >
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`, transformOrigin: 'center center' }}
      >
        <img src={url} alt={label} draggable={false} className="max-h-full max-w-full object-contain" />
      </div>

      <div
        role="toolbar"
        aria-label="Zoom controls"
        className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/70 p-1 text-white shadow-lg backdrop-blur"
      >
        <ZoomButton ariaLabel="Zoom out" disabled={view.scale <= MIN_SCALE} onClick={() => zoomFromButton(1 / BUTTON_STEP)}>−</ZoomButton>
        <button
          type="button"
          aria-label={atFit ? 'Fit' : 'Reset zoom to fit'}
          onClick={resetView}
          className="min-w-[3.25rem] rounded-full px-2 py-1 text-xs font-medium tabular-nums hover:bg-white/15"
        >
          {percent}%
        </button>
        <ZoomButton ariaLabel="Zoom in" disabled={view.scale >= MAX_SCALE} onClick={() => zoomFromButton(BUTTON_STEP)}>+</ZoomButton>
      </div>
    </div>
  );
}

function ZoomButton({
  ariaLabel,
  disabled,
  onClick,
  children,
}: {
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-full text-lg leading-none hover:bg-white/15 disabled:opacity-30"
    >
      {children}
    </button>
  );
}

// ── The viewers ────────────────────────────────────────────────────────────
type ViewerProps = Required<Pick<FilePreviewProps, 'url' | 'contentType' | 'label'>> & Pick<FilePreviewProps, 'autoPlay' | 'poster' | 'glance' | 'firstText' | 'timedText' | 'onTimeChange' | 'seekRequest' | 'className'> & {
  /** What the file's viewer row in file-viewers.json says about reading it (a table's `separator`). */
  readonly settings?: Readonly<Record<string, unknown>>;
};

function Player({ url, contentType, label, autoPlay, poster, timedText, onTimeChange, seekRequest, className, video }: ViewerProps & { video: boolean }) {
  return (
    <div className={cn('flex h-full w-full flex-col justify-center [&>*]:w-full', className)} data-file-preview-player="">
      <MediaPlaybackSurface
        media={{ id: url, label, source_kind: video ? 'video' : 'audio', mime_type: namedType(contentType) || undefined, playback_url: url, poster_url: poster }}
        showFrameChrome={false}
        timedTextSegments={timedText}
        onTimeChange={onTimeChange}
        seekRequest={seekRequest}
        autoPlay={video && autoPlay}
      />
    </div>
  );
}

// In a glance the small still the caller made is shown before ever the whole picture.
function Picture({ url, label, poster, glance, className }: ViewerProps) {
  if (glance) return <img className={cn('file-preview-picture', className)} src={poster ?? url} alt={label} decoding="async" draggable={false} />;
  return <ZoomableImage url={url} label={label} />;
}

// ── Paged documents ─────────────────────────────────────────────────────────
// A PDF's pages drawn by the page reader the host serves (media-preview/pdf-reader.ts): fitted to the box's width
// (never wider than a comfortable reading width), zoomable, each page drawn only when it comes near the view. A
// glance draws the first page alone. A host that serves no reader gets the browser's own page viewer.
const PAGE_ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const PAGE_MAX_WIDTH = 960;
const PAGE_MARGIN = 24;
const RAIL_PAGE_WIDTH = 96;

type PdfState = { kind: 'loading' } | { kind: 'pages'; doc: PdfDocument } | { kind: 'browser' } | { kind: 'failed' };

function Pdf(props: ViewerProps) {
  const { url, contentType, label, poster, glance, className } = props;
  const [state, setState] = React.useState<PdfState>({ kind: 'loading' });
  React.useEffect(() => {
    if (glance && poster) return undefined;
    let gone = false;
    let loading: PdfLoading | null = null;
    setState({ kind: 'loading' });
    pdfReader().then(
      reader => {
        if (gone) return undefined;
        loading = reader.getDocument({ url, withCredentials: true, disableAutoFetch: true });
        return loading.promise.then(doc => { if (!gone) setState({ kind: 'pages', doc }); });
      },
      () => { if (!gone) setState({ kind: 'browser' }); },
    ).catch(() => { if (!gone) setState({ kind: 'failed' }); });
    return () => { gone = true; void loading?.destroy(); };
  }, [url, glance, poster]);
  if (glance && poster) return <img className={cn('file-preview-picture', className)} src={poster} alt={label} decoding="async" draggable={false} />;
  if (state.kind === 'browser') return <BrowserPdf {...props} />;
  if (state.kind === 'failed') return <FileCard url={url} label={label} contentType={contentType} note="This file could not be read here." />;
  if (state.kind === 'loading') return <Reading label={label} />;
  return <PdfPages doc={state.doc} label={label} glance={glance} className={className} />;
}

interface PageSize { readonly width: number; readonly height: number }

// The width a box offers its content, kept current as the box is resized.
function useBoxWidth(box: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    setWidth(element.clientWidth);
    const watch = new ResizeObserver(() => setWidth(element.clientWidth));
    watch.observe(element);
    return () => watch.disconnect();
  }, [box]);
  return width;
}

function PdfPages({ doc, label, glance, className }: { doc: PdfDocument; label: string; glance?: boolean; className?: string }) {
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const width = useBoxWidth(scroller);
  const [first, setFirst] = React.useState<PageSize | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const [current, setCurrent] = React.useState(1);
  const [rail, setRail] = React.useState(true);
  const count = glance ? 1 : doc.numPages;
  React.useEffect(() => {
    let gone = false;
    doc.getPage(1).then(page => { const size = page.getViewport({ scale: 1 }); if (!gone) setFirst({ width: size.width, height: size.height }); }, () => {});
    return () => { gone = true; };
  }, [doc]);
  const fit = first && width ? Math.min(width - (glance ? 0 : PAGE_MARGIN * 2), PAGE_MAX_WIDTH) / first.width : 0;
  const scale = fit * zoom;

  // The page whose top has passed the upper third of the view is the page being read.
  const onScroll = React.useCallback(() => {
    const element = scroller.current;
    if (!element || glance) return;
    const line = element.scrollTop + element.clientHeight / 3;
    let reading = 1;
    for (const page of element.querySelectorAll<HTMLElement>('[data-pdf-page]')) {
      if (page.offsetTop <= line) reading = Number(page.dataset.pdfPage);
      else break;
    }
    setCurrent(reading);
  }, [glance]);
  const show = (number: number) => {
    scroller.current?.querySelector<HTMLElement>(`[data-pdf-page="${number}"]`)?.scrollIntoView({ block: 'start' });
    setCurrent(number);
  };
  const step = (direction: 1 | -1) => setZoom(now => {
    const at = PAGE_ZOOMS.findIndex(value => value >= now - 0.001);
    const next = PAGE_ZOOMS[Math.min(PAGE_ZOOMS.length - 1, Math.max(0, (at < 0 ? PAGE_ZOOMS.length - 1 : at) + direction))];
    return next;
  });
  const numbers = React.useMemo(() => Array.from({ length: count }, (_, index) => index + 1), [count]);

  return (
    <div className={cn('file-preview-pdf', className)} data-glance={glance ? '' : undefined} data-rail={rail && count > 1 ? '' : undefined}>
      {!glance && (
        <div className="file-preview-pdf-bar">
          {count > 1 && (
            <Button className="file-preview-pdf-rail-toggle" variant="ghost" size="icon-sm" aria-label={rail ? 'Hide pages' : 'Show pages'} aria-pressed={rail} onClick={() => setRail(open => !open)}>
              <NamedIcon name="PanelLeft" size="sm" />
            </Button>
          )}
          <div className="file-preview-pdf-count" aria-live="polite">Page {current} of {count}</div>
          <div className="file-preview-pdf-zoom">
            <Button variant="ghost" size="icon-sm" aria-label="Zoom out" disabled={zoom <= PAGE_ZOOMS[0]} onClick={() => step(-1)}><NamedIcon name="Minus" size="sm" /></Button>
            <Button variant="ghost" size="xs" aria-label="Fit to width" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button>
            <Button variant="ghost" size="icon-sm" aria-label="Zoom in" disabled={zoom >= PAGE_ZOOMS[PAGE_ZOOMS.length - 1]} onClick={() => step(1)}><NamedIcon name="Plus" size="sm" /></Button>
          </div>
        </div>
      )}
      <div className="file-preview-pdf-body">
        {!glance && count > 1 && rail && first && (
          <div className="file-preview-pdf-rail" role="list" aria-label="Pages">
            {numbers.map(number => (
              <div key={number} role="listitem" className="file-preview-pdf-rail-item" data-current={number === current ? '' : undefined}>
                <Button variant="ghost" className="file-preview-pdf-rail-page" aria-label={`Page ${number}`} aria-current={number === current ? 'page' : undefined} onClick={() => show(number)}>
                  <PdfPageView doc={doc} number={number} scale={RAIL_PAGE_WIDTH / first.width} guess={first} rootRef={null} />
                </Button>
                <div className="file-preview-pdf-rail-number">{number}</div>
              </div>
            ))}
          </div>
        )}
        <div ref={scroller} className="file-preview-pdf-pages" onScroll={onScroll} aria-label={label} tabIndex={glance ? undefined : 0}>
          {first && scale > 0 && numbers.map(number => (
            <PdfPageView key={number} doc={doc} number={number} scale={scale} guess={first} rootRef={scroller} text={!glance} />
          ))}
        </div>
      </div>
    </div>
  );
}

// One page: a box of the page's size at once (so scrolling is steady), drawn when it comes within a screen of the
// view, redrawn at the new size when the scale changes. Its words lie over it, invisible and selectable.
function PdfPageView({ doc, number, scale, guess, rootRef, text = false }: {
  doc: PdfDocument;
  number: number;
  scale: number;
  guess: PageSize;
  rootRef: React.RefObject<HTMLElement | null> | null;
  text?: boolean;
}) {
  const box = React.useRef<HTMLDivElement | null>(null);
  const canvas = React.useRef<HTMLCanvasElement | null>(null);
  const words = React.useRef<HTMLDivElement | null>(null);
  const [near, setNear] = React.useState(false);
  const [size, setSize] = React.useState<PageSize>(guess);
  const [drawn, setDrawn] = React.useState(false);
  React.useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const watch = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setNear(true); watch.disconnect(); } }, { root: rootRef?.current ?? null, rootMargin: '100% 0px' });
    watch.observe(element);
    return () => watch.disconnect();
  }, [rootRef]);
  React.useEffect(() => {
    if (!near || scale <= 0) return undefined;
    let gone = false;
    let drawing: { cancel(): void } | null = null;
    let layer: PdfTextLayer | null = null;
    doc.getPage(number).then(async page => {
      if (gone) return;
      const base = page.getViewport({ scale: 1 });
      setSize({ width: base.width, height: base.height });
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      const view = page.getViewport({ scale: scale * ratio });
      const surface = canvas.current;
      if (!surface) return;
      const next = document.createElement('canvas');
      next.width = Math.floor(view.width);
      next.height = Math.floor(view.height);
      const task = page.render({ canvas: next, viewport: view });
      drawing = task;
      await task.promise;
      if (gone) return;
      surface.width = next.width;
      surface.height = next.height;
      surface.getContext('2d')?.drawImage(next, 0, 0);
      setDrawn(true);
      const host = words.current;
      if (!text || !host) return;
      const reader = await pdfReader();
      if (gone) return;
      host.replaceChildren();
      layer = new reader.TextLayer({ textContentSource: page.streamTextContent(), container: host, viewport: page.getViewport({ scale }) });
      await layer.render().catch(() => {});
    }).catch(() => {});
    return () => { gone = true; drawing?.cancel(); layer?.cancel(); };
  }, [near, doc, number, scale, text]);
  const shape = { '--pdf-page-width': `${size.width * scale}px`, '--pdf-page-height': `${size.height * scale}px`, '--total-scale-factor': String(scale) } as React.CSSProperties;
  return (
    <div ref={box} className="file-preview-pdf-page" data-pdf-page={number} data-drawn={drawn ? '' : undefined} style={shape} aria-label={`Page ${number}`}>
      <canvas ref={canvas} className="file-preview-pdf-canvas" aria-hidden />
      {text && <div ref={words} className="textLayer file-preview-pdf-words" />}
    </div>
  );
}

// A host that serves no page reader: the browser's own page viewer reads a PDF by range. It needs the file served as a PDF; a file whose stored type
// names nothing is read once and handed over as one.
function BrowserPdf({ url, contentType, label, poster, glance, className }: ViewerProps) {
  const typed = namedType(contentType) === 'application/pdf';
  const [address, setAddress] = React.useState<string | null>(typed ? url : null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (typed || (glance && poster)) { setAddress(url); return undefined; }
    const control = new AbortController();
    let made: string | null = null;
    fetch(url, { credentials: 'same-origin', signal: control.signal })
      .then(response => response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status))))
      .then(bytes => { made = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); setAddress(made); }, () => { if (!control.signal.aborted) setFailed(true); });
    return () => { control.abort(); if (made) URL.revokeObjectURL(made); };
  }, [url, typed, glance, poster]);
  if (glance && poster) return <img className={cn('file-preview-picture', className)} src={poster} alt={label} decoding="async" draggable={false} />;
  if (failed) return <FileCard url={url} label={label} contentType={contentType} note="This file could not be read here." />;
  if (!address) return <Reading label={label} />;
  return <iframe className={cn('file-preview-page', className)} src={glance ? `${address}#toolbar=0&view=FitH` : address} tabIndex={0} title={label} />;
}

function TextFile({ url, contentType, label, glance, firstText, className, markdown = false }: ViewerProps & { markdown?: boolean }) {
  const limit = glance ? TEXT_BYTES.glance : TEXT_BYTES.full;
  const loaded = useRead(url, async signal => {
    if (firstText) return { text: firstText.text, shown: firstText.shownBytes, total: firstText.byteLength };
    const response = await fetch(url, { headers: { Range: `bytes=0-${limit - 1}` }, credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(String(response.status));
    const bytes = new Uint8Array(await response.arrayBuffer());
    const total = totalSize(response) ?? bytes.length;
    // A server that ignores Range sends everything; show the same first part either way.
    const shown = bytes.subarray(0, limit);
    return { text: new TextDecoder().decode(shown), shown: shown.length, total };
  });
  if (loaded.state === 'loading') return <Reading label={label} />;
  if (loaded.state === 'failed') return <FileCard url={url} label={label} contentType={contentType} note="This file could not be read here." />;
  const { text, shown, total } = loaded.value;
  return (
    <div className={cn('file-preview-text', className)} data-glance={glance ? '' : undefined}>
      {markdown
        ? <MarkdownWords words={text} />
        : <div className="file-preview-text-body">{text}</div>}
      {!glance && total > shown && <div className="file-preview-note">Showing the first {sizeWords(shown)} of {sizeWords(total)}.</div>}
    </div>
  );
}

// Delimited text read as a table: the first MiB (a screenful in a glance) split by the separator its viewer row
// names, drawn in the same lettered grid a workbook sheet uses.
function DelimitedTable({ url, contentType, label, glance, firstText, settings, className }: ViewerProps) {
  const separator = typeof settings?.separator === 'string' ? settings.separator : '';
  const limit = glance ? TEXT_BYTES.glance : TEXT_BYTES.full;
  const loaded = useRead(url, async signal => {
    if (!separator) throw new Error('No separator is named for this table.');
    if (firstText) return readDelimitedText(firstText.text, separator, firstText.shownBytes < firstText.byteLength);
    const response = await fetch(url, { headers: { Range: `bytes=0-${limit - 1}` }, credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(String(response.status));
    const bytes = new Uint8Array(await response.arrayBuffer());
    const total = totalSize(response) ?? bytes.length;
    const shown = bytes.subarray(0, limit);
    return readDelimitedText(new TextDecoder().decode(shown), separator, total > shown.length);
  });
  if (loaded.state === 'loading') return <Reading label={label} />;
  if (loaded.state === 'failed') return <FileCard url={url} label={label} contentType={contentType} note="This file could not be read here." />;
  const { rows, cut } = loaded.value;
  return (
    <div className={cn('file-preview-workbook', className)} data-glance={glance ? '' : undefined}>
      <div className="file-preview-workbook-grid"><Grid rows={rows} numbered /></div>
      {!glance && cut && <div className="file-preview-note">Only the first {rows.length} rows are shown.</div>}
    </div>
  );
}

function OfficeFile({ url, contentType, label, glance, className }: ViewerProps) {
  const loaded = useRead(url, async signal => {
    const response = await fetch(url, { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error(String(response.status));
    const size = totalSize(response);
    if (size !== null && size > OFFICE_MAX_BYTES) { await response.body?.cancel(); return null; }
    return readOfficeDocument(new Uint8Array(await response.arrayBuffer()));
  });
  if (loaded.state === 'loading') return <Reading label={label} />;
  if (loaded.state === 'failed' || !loaded.value) {
    const note = loaded.state === 'failed' ? 'This file could not be read here.' : 'This file is too large to show here.';
    return <FileCard url={url} label={label} contentType={contentType} note={note} />;
  }
  return <OfficeReadingView reading={loaded.value} glance={glance} className={className} />;
}

// Column letters as a spreadsheet names them: 0 → A, 26 → AA.
function columnName(index: number): string {
  let name = '';
  for (let at = index + 1; at > 0; at = Math.floor((at - 1) / 26)) name = String.fromCharCode(65 + ((at - 1) % 26)) + name;
  return name;
}

function Grid({ rows, numbered }: { rows: readonly (readonly string[])[]; numbered: boolean }) {
  const width = rows.reduce((most, row) => Math.max(most, row.length), 0);
  return (
    <Table className="file-preview-grid">
      {numbered && (
        <TableHeader>
          <TableRow>
            <TableHead className="file-preview-grid-corner" />
            {Array.from({ length: width }, (_, index) => <TableHead key={index}>{columnName(index)}</TableHead>)}
          </TableRow>
        </TableHeader>
      )}
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index}>
            {numbered && <TableHead className="file-preview-grid-row">{index + 1}</TableHead>}
            {Array.from({ length: width }, (_, column) => <TableCell key={column}>{row[column] ?? ''}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function OfficeReadingView({ reading, glance, className }: { reading: OfficeReading; glance?: boolean; className?: string }) {
  const [sheet, setSheet] = React.useState(0);
  if (reading.kind === 'document') {
    return (
      <div className={cn('file-preview-document', className)} data-glance={glance ? '' : undefined}>
        <div className="file-preview-page-sheet">
          {reading.blocks.map((block, index) => block.kind === 'table'
            ? <Grid key={index} rows={block.rows} numbered={false} />
            : <div key={index} className="file-preview-paragraph" data-heading={block.heading ?? undefined}>{block.text || ' '}</div>)}
          {reading.cut && <div className="file-preview-note">The rest of this document is not shown here.</div>}
        </div>
      </div>
    );
  }
  if (reading.kind === 'workbook') {
    const shown = reading.sheets[Math.min(sheet, reading.sheets.length - 1)];
    return (
      <div className={cn('file-preview-workbook', className)}>
        <div className="file-preview-workbook-grid">{shown ? <Grid rows={shown.rows} numbered /> : null}</div>
        {shown?.cut && <div className="file-preview-note">Only the first rows and columns of this sheet are shown.</div>}
        {reading.sheets.length > 1 && (
          <div className="file-preview-sheets" role="tablist" aria-label="Sheets">
            {reading.sheets.map((item, index) => (
              <Button key={index} role="tab" aria-selected={index === sheet} size="xs" variant={index === sheet ? 'secondary' : 'ghost'} onClick={() => setSheet(index)}>{item.name}</Button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={cn('file-preview-slides', className)}>
      {reading.slides.map((lines, index) => (
        <div key={index} className="file-preview-slide" aria-label={`Slide ${index + 1}`}>
          <div className="file-preview-slide-number">{index + 1}</div>
          {lines.map((line, at) => <div key={at} className="file-preview-paragraph" data-heading={at === 0 ? 2 : undefined}>{line}</div>)}
        </div>
      ))}
    </div>
  );
}

function FileCard({ url, label, contentType, note, className }: { url: string; label: string; contentType: string; note?: string; className?: string }) {
  const type = namedType(contentType);
  return (
    <div className={cn('file-preview-card', className)}>
      <NamedIcon name="File" size="xl" />
      <div className="file-preview-card-name">{label || 'This file'}</div>
      <div className="file-preview-note">{note ?? (type ? `${type} files are not shown here.` : 'Files like this are not shown here.')}</div>
      <Button variant="outline" size="sm" pendingLabel="Downloading" onClick={() => downloadAddress(url, label || 'file')}>
        <NamedIcon name="Download" size="sm" />
        Download
      </Button>
    </div>
  );
}

/** Viewers by id. Open: a new way of showing a file is one entry here and one row in file-viewers.json. */
export const FILE_VIEWERS: Record<string, (props: ViewerProps) => React.ReactElement> = {
  video: props => <Player {...props} video />,
  sound: props => <Player {...props} video={false} />,
  picture: props => <Picture {...props} />,
  pdf: props => <Pdf {...props} />,
  table: props => <DelimitedTable {...props} />,
  text: props => <TextFile {...props} />,
  markdown: props => <TextFile {...props} markdown />,
  office: props => <OfficeFile {...props} />,
  file: props => <FileCard url={props.url} label={props.label} contentType={props.contentType} className={props.className} />,
};

export function FilePreview({ url, contentType, label = '', autoPlay = true, poster, glance, firstText, timedText, onTimeChange, seekRequest, className }: FilePreviewProps) {
  const { viewer, settings } = chooseFileView({ contentType, name: label });
  const View = FILE_VIEWERS[viewer] ?? FILE_VIEWERS.file;
  return (
    <div className="file-preview" data-file-viewer={viewer}>
      <View url={url} contentType={contentType || ''} label={label} autoPlay={autoPlay} poster={poster} glance={glance} firstText={firstText} timedText={timedText} onTimeChange={onTimeChange} seekRequest={seekRequest} settings={settings} className={className} />
    </div>
  );
}
