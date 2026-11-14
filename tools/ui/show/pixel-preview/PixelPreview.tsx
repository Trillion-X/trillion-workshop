// parts/ui/show/pixel-preview/PixelPreview.tsx
//
// PURPOSE
//   A picture or video drawn through the caller's own pixel function, frame by frame, so a change shows the moment a
//   control moves, long before a full render could. The media plays (muted, looping) in the shared MediaFrame and each
//   frame is drawn onto a canvas, scaled to at most `maxWidth`, through `paint` (RGBA bytes changed in place). Without
//   `paint`, the frame is drawn as it is: the original.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here knows what `paint` does. Any caller (a colour grade, a mask, a filter) brings its own.
//   2. The bytes come from the caller's address on this page's own origin, so the canvas can be read back (a frame of the
//      preview can be compared with a frame of the saved result).
//   3. Paused, a change of `paint` redraws the same frame at once; playing, the next frame uses it.
//   4. The canvas says which frame it shows (`data-preview-time`) and how long the last paint took
//      (`data-preview-paint-ms`), so a check can compare it with the saved copy at the same moment.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';
import { cn } from '../cn';
import { MediaFrame } from '../media-frame/MediaFrame';

export type PixelPaint = (data: Uint8ClampedArray) => unknown;

export type PixelPreviewProps = {
  /** The media's address (same origin). */
  source: string;
  /** Its type, such as video/mp4; a picture when it starts with image/. */
  mediaType: string;
  label: string;
  /** Changes a frame's RGBA bytes in place; null draws the frame as it is. */
  paint: PixelPaint | null;
  /** The widest the canvas is drawn, in pixels; the frame keeps its shape. */
  maxWidth?: number;
  /** Whether the video plays (it loops); paused, the same frame stays and is drawn again on every change. */
  playing?: boolean;
  /** Where to hold a paused video, in seconds. */
  at?: number;
  className?: string;
};

export const PixelPreview = React.forwardRef<HTMLCanvasElement, PixelPreviewProps>(({ source, mediaType, label, paint, maxWidth = 960, playing = true, at, className }, forwarded) => {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const pictureRef = React.useRef<HTMLImageElement | null>(null);
  const paintRef = React.useRef<PixelPaint | null>(paint);
  const isPicture = mediaType.startsWith('image/');
  const setCanvas = React.useCallback((node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
    if (typeof forwarded === 'function') forwarded(node);
    else if (forwarded) (forwarded as React.MutableRefObject<HTMLCanvasElement | null>).current = node;
  }, [forwarded]);

  const draw = React.useCallback(() => {
    const canvas = canvasRef.current;
    const media: HTMLVideoElement | HTMLImageElement | null = isPicture ? pictureRef.current : videoRef.current;
    if (!canvas || !media) return;
    const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
    const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
    if (!width || !height) return;
    const scale = Math.min(1, maxWidth / width);
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(media, 0, 0, w, h);
    const started = performance.now();
    if (paintRef.current) {
      const frame = context.getImageData(0, 0, w, h);
      paintRef.current(frame.data);
      context.putImageData(frame, 0, 0);
    }
    canvas.dataset.previewPaintMs = String(Math.round((performance.now() - started) * 10) / 10);
    canvas.dataset.previewTime = media instanceof HTMLVideoElement ? String(media.currentTime) : '0';
  }, [isPicture, maxWidth]);

  // Invariant 3: a new paint draws the frame on screen again at once.
  React.useEffect(() => { paintRef.current = paint; draw(); }, [paint, draw]);

  // Each decoded frame of a playing video is drawn as it arrives; a paused one when it lands on a new moment.
  React.useEffect(() => {
    const video = videoRef.current;
    if (isPicture || !video) return undefined;
    let stopped = false;
    let handle = 0;
    const withFrames = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number; cancelVideoFrameCallback?: (handle: number) => void };
    const next = () => {
      if (stopped) return;
      draw();
      handle = withFrames.requestVideoFrameCallback ? withFrames.requestVideoFrameCallback(next) : requestAnimationFrame(next);
    };
    const start = () => { if (!handle) next(); };
    video.addEventListener('loadeddata', draw);
    video.addEventListener('seeked', draw);
    video.addEventListener('play', start);
    if (video.readyState >= 2) { draw(); start(); }
    return () => {
      stopped = true;
      if (withFrames.cancelVideoFrameCallback && handle) withFrames.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle);
      video.removeEventListener('loadeddata', draw);
      video.removeEventListener('seeked', draw);
      video.removeEventListener('play', start);
    };
  }, [isPicture, draw, source]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (isPicture || !video) return;
    if (playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [playing, isPicture, source]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (isPicture || !video || at === undefined || !Number.isFinite(at)) return;
    if (Math.abs(video.currentTime - at) > 0.01) video.currentTime = at;
  }, [at, isPicture, source]);

  // A picture is read once, then drawn on every change.
  React.useEffect(() => {
    if (!isPicture) return undefined;
    const picture = new Image();
    picture.onload = () => { pictureRef.current = picture; draw(); };
    picture.src = source;
    return () => { picture.onload = null; };
  }, [isPicture, source, draw]);

  return (
    <div className={cn('relative grid w-full min-w-0 place-items-center overflow-hidden rounded-[var(--radius-card)] bg-black', className)} data-pixel-preview>
      {isPicture ? null : (
        <div className="pointer-events-none absolute inset-0 opacity-0" aria-hidden="true">
          <MediaFrame url={source} mediaType={mediaType} label={label} videoRef={videoRef} muted loop playsInline autoPlay={playing} />
        </div>
      )}
      <canvas ref={setCanvas} role="img" aria-label={label} className="relative block h-auto max-h-[60vh] w-full object-contain" />
    </div>
  );
});

PixelPreview.displayName = 'PixelPreview';
