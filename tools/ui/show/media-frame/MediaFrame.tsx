// packages/ui/show/media-frame/MediaFrame.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Cinematic preview frame for the DreamCut video editor. Renders the correct
// native media element based on the mediaType MIME prefix: video/<*> renders
// a <video>, audio/<*> renders an <audio> player inside a nested Card, and
// image/<*> renders an <img>. All frames share the same premium dark glass
// container treatment.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. mediaType prefix selects element — never a separate enum prop
// 2. Raw <video>, <audio>, <img> are ONLY legal here (ui/ layer rule)
// 3. Max-height ~48vh prevents overflow in editor layouts
// 4. ALL chrome colors use CSS vars from ApplyCurrentScreenLook
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useEffect } from 'react';
import { cn } from '../cn';
import { Card } from '../card/Card';
import { MediaPlaybackSurface } from '../../../media-playback/show/lazy-playback-surface';

export type MediaFrameTransform = {
  aspectRatio?: string;
  framePreset?: string;
  position?: string;
  width?: number;
  height?: number;
  padding?: number;
  inset?: number;
  corners?: number;
  stroke?: number;
  shadow?: number;
  keepAspectRatio?: boolean;
  /** Show only a sub-rectangle of the source IMAGE, in normalized 0..1 fractions
   *  (`{0,0,1,1}` = the whole image). The image is scaled so the crop fills the frame
   *  and offset so the crop's top-left aligns to the frame's top-left. Image-only —
   *  ignored for video/audio. Owned as DATA by the caller (the board's `extra.crop`). */
  crop?: { x: number; y: number; w: number; h: number };
  /** A CSS `filter` string applied to the IMAGE (e.g. `grayscale(1)`, `sepia(0.7)`),
   *  for color/aesthetic adjustment. Owned as DATA by the caller (a named preset →
   *  CSS string). Absent/empty → no filter. Composes with `crop` (different property). */
  filter?: string;
};

/** The crop covers (effectively) the whole image → render as if uncropped. The
 *  full-crop test is inlined here because `ui` must not import from feature packages
 *  (the canonical `isFullCrop`/`Crop` live in `group/show/crop-rect.ts`). */
function isFullImageCrop(c: { x: number; y: number; w: number; h: number }): boolean {
  const e = 1e-4;
  return c.x <= e && c.y <= e && c.w >= 1 - e && c.h >= 1 - e;
}

/** CSS that shows only `crop` of the source: size the <img> to 1/w × 1/h of the frame
 *  and offset it so the crop's top-left aligns to the frame's top-left, inside an
 *  `overflow:hidden` box. At `{0,0,1,1}` this is 100%/100%/0/0 = a plain cover fill. */
function cropImageStyle(c: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  return {
    position: 'absolute',
    width: `${100 / c.w}%`,
    height: `${100 / c.h}%`,
    left: `${(-c.x / c.w) * 100}%`,
    top: `${(-c.y / c.h) * 100}%`,
    objectFit: 'cover',
    objectPosition: 'center',
  };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Derive a CSSProperties object from a ClipTransform.
 *
 * Mapping:
 *   aspectRatio    → aspect-ratio (colon-separated → slash-separated for CSS)
 *   corners        → border-radius in px
 *   shadow         → box-shadow spread in px (dark glow)
 *   padding        → padding in px
 *   width / height → explicit px dimensions
 *   position       → object-position (e.g. "center", "top left")
 *   keepAspectRatio → object-fit: contain (true) / cover (false)
 */
function transformToStyle(t: MediaFrameTransform): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (t.aspectRatio) style.aspectRatio = t.aspectRatio.replace(':', '/');
  if (typeof t.corners === 'number') style.borderRadius = `${t.corners}px`;
  if (typeof t.shadow === 'number' && t.shadow > 0) style.boxShadow = `0 0 ${t.shadow}px rgba(0,0,0,0.7)`;
  if (typeof t.padding === 'number' && t.padding > 0) style.padding = `${t.padding}px`;
  if (typeof t.width === 'number' && t.width > 0) style.width = `${t.width}px`;
  if (typeof t.height === 'number' && t.height > 0) style.height = `${t.height}px`;
  if (t.position) style.objectPosition = t.position;
  if (typeof t.keepAspectRatio === 'boolean') style.objectFit = t.keepAspectRatio ? 'contain' : 'cover';
  return style;
}

const frameShell = cn(
  'relative flex items-center justify-center',
  'rounded-3xl border border-[var(--border-primary)]',
  'bg-[var(--glass-bg-subtle)]',
  'shadow-[0_8px_40px_rgba(0,0,0,0.6)]',
  'overflow-hidden',
  'w-full',
);

// Full-bleed: drop the preview-card chrome and fill the parent (the container
// sets the bounds — e.g. an immersive viewer). No 48vh cap, no border/shadow.
const frameShellFill = cn(
  'relative flex items-center justify-center',
  'overflow-hidden',
  'w-full h-full',
);

const mediaClass = cn(
  'block w-full object-contain',
  'max-h-[48vh]',
);

const mediaClassFill = cn(
  'block w-full h-full object-contain',
  'max-h-full',
);

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface MediaFrameProps {
  /** Public or blob URL to the media asset */
  url?: string;
  /** MIME type string (e.g. "video/mp4", "audio/mpeg", "image/png") */
  mediaType: string;
  /** Human-readable label used as alt text and audio card heading */
  label: string;
  className?: string;
  /** Live MediaStream preview. When provided, the frame renders the stream and
   *  ignores `url` for the `<video>` source. Video-only. */
  stream?: MediaStream | null;
  /** Mirror the rendered video — useful for front-facing self-preview. */
  mirrored?: boolean;
  /** Pass through the common live-preview video flags without introducing raw
   *  media tags in feature packages. */
  muted?: boolean;
  autoPlay?: boolean;
  playsInline?: boolean;
  /** Start again at the end (a short recording shown on its own, like a product demo). Video-only. */
  loop?: boolean;
  /** The picture shown before the video's first frame has loaded. Video-only. */
  poster?: string;
  /**
   * Live visual transform from the caller.
   * Applied to the media element via CSS when provided.
   * aspectRatio, corners, shadow, padding, width, height, position,
   * keepAspectRatio fields are all honoured.
   */
  transform?: MediaFrameTransform;
  /**
   * Ref to the underlying <video> element for external playback control
   * (play, pause, currentTime, duration). Ignored for audio and image types.
   */
  videoRef?: React.RefObject<HTMLVideoElement>;
  /**
   * Fill the parent instead of rendering as a capped preview card. When true the
   * media grows to fit its container (`object-contain`, no `48vh` preview cap) and
   * the card chrome (border, shadow, rounded corners, surface) is dropped — for
   * full-bleed contexts like an immersive viewer where the container sets bounds.
   */
  fill?: boolean;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Cinematic media preview frame. Dispatches on mediaType prefix.
 * Accepts `transform` for caller-owned visual adjustments
 * and `videoRef` for external play/pause/seek control.
 *
 * @example
 * ```tsx
 * <MediaFrame url={src} mediaType="video/mp4" label="rough-cut.mp4"
 *             videoRef={videoRef} transform={liveTransform} />
 * <MediaFrame url={src} mediaType="audio/wav" label="voiceover.wav" />
 * <MediaFrame url={src} mediaType="image/png" label="thumbnail.png"
 *             transform={{ corners: 12, shadow: 24 }} />
 * ```
 */
export function MediaFrame({
  url,
  mediaType,
  label,
  className,
  stream,
  mirrored = false,
  muted = false,
  autoPlay,
  playsInline = true,
  loop = false,
  poster,
  transform,
  videoRef,
  fill,
}: MediaFrameProps) {
  const shell = fill ? frameShellFill : frameShell;
  const media = fill ? mediaClassFill : mediaClass;
  // videoCallbackRef is passed to the <video> element via a React.cloneElement
  // shim below — wires the external videoRef and applies live CSS transform
  // without changing the original JSX line that contains the raw element tag.
  const videoElRef = React.useRef<HTMLVideoElement | null>(null);
  const videoCallbackRef = React.useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
    if (videoRef) {
      (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
    }
  }, [videoRef]);

  useEffect(() => {
    const el = videoElRef.current;
    if (!el) return;
    const s = transform ? transformToStyle(transform) : {};
    Object.assign(el.style, s);
  }, [transform]);

  useEffect(() => {
    const el = videoElRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    return () => {
      if (el.srcObject === stream) el.srcObject = null;
    };
  }, [stream]);

  if (mediaType.startsWith('video/')) {
    const videoEl = React.createElement('video', {
      ref: videoCallbackRef,
      ...(stream ? {} : { src: url }),
      className: media,
      muted,
      autoPlay: autoPlay ?? Boolean(stream),
      playsInline,
      loop,
      ...(poster ? { poster } : {}),
      preload: 'metadata',
      style: mirrored ? { transform: 'scaleX(-1)' } : undefined,
    });
    return React.createElement('div', { className: cn(shell, className) }, videoEl);
  }

  if (mediaType.startsWith('audio/')) {
    return (
      <Card variant="nested" padding="md" layout="stack" className={cn('w-full', className)}>
        <span className="text-sm font-semibold text-[var(--text-primary)] truncate">{label}</span>
        <MediaPlaybackSurface media={{ id: url, label, source_kind: 'audio', mime_type: mediaType, playback_url: url }} showFrameChrome={false} />
      </Card>
    );
  }

  /* image/ and any other MIME — render as img. A crop (when present and not full)
   *  fills the frame with the chosen sub-rectangle: the frame becomes an
   *  overflow-hidden window and the <img> is scaled/offset to show only the crop. */
  const crop = transform?.crop;
  const imgFilter = transform?.filter || undefined;
  if (crop && !isFullImageCrop(crop)) {
    return (
      <div className={cn(frameShellFill, className)}>
        <img
          src={url}
          alt={label}
          draggable={false}
          style={{ ...cropImageStyle(crop), ...(imgFilter ? { filter: imgFilter } : {}) }}
        />
      </div>
    );
  }
  return (
    <div className={cn(shell, className)}>
      <img
        src={url}
        alt={label}
        className={media}
        draggable={false}
        style={imgFilter ? { filter: imgFilter } : undefined}
      />
    </div>
  );
}
