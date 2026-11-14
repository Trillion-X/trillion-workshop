// parts/ui/show/live-frame/LiveFrame.tsx
//
// PURPOSE
// A live page shown inside another page: Trillion's own workspace running with throwaway data (a live showcase,
// src/showcases.mjs serves it on its own host), a customer's app built on Trillion, or any page that may be framed.
// The frame loads when it nears the screen, says what it holds for assistive technology, and is as tall as the page
// that draws it asks (`height`, `phoneHeight` on a narrow screen), so a landing, a docs page or a sales page can each
// show the real thing instead of a picture of it.
// With a `poster` (a real picture of the same page), the picture shows at once and the live page replaces it only when
// the live page says its screens show real content (live-frame-ready.mjs). A live page that is slow, busy or cannot
// start leaves the picture in place, never a blank window (asked for 2026-10-12: the landing's frame stayed empty).
//
// NON-NEGOTIABLE INVARIANTS
// 1. The raw <iframe> lives only here (ui/ layer rule); callers pass DATA (address, title, sizes, poster).
// 2. Only an https address is framed; anything else draws nothing.
// 3. The look (border, radius, shadow) comes from the caller's className and the screen look's variables.
// 4. With a poster, the live page is shown only after a ready message from that page's own window and origin.
//
// The documentation in this file is part of the design. Do not simplify or remove it.

import React from 'react';
import { cn } from '../cn';
import { LIVE_FRAME_READY } from './live-frame-ready.mjs';

/** A real picture of the framed page, shown until the live page is ready. */
export interface LiveFramePoster {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

export interface LiveFrameProps {
  /** The page to show live: an https address. */
  readonly src: string;
  /** What the frame holds, read aloud (e.g. "Trillion, live"). */
  readonly title: string;
  /** Height in pixels on a wide screen. */
  readonly height?: number;
  /** Height in pixels on a narrow screen. */
  readonly phoneHeight?: number;
  /** What the framed page may use, as the iframe `allow` list (e.g. "clipboard-write"). */
  readonly allow?: string;
  readonly className?: string;
  /** A real picture of the same page, shown at once and kept until the live page is ready. */
  readonly poster?: LiveFramePoster;
}

// Picture and live page sit in the same box; only which one is seen changes.
const LAYER: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, transition: 'opacity 400ms ease' };

export function LiveFrame({ src, title, height = 720, phoneHeight = 640, allow, className, poster }: LiveFrameProps) {
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = React.useState(false);
  const framable = /^https:\/\//.test(src);
  React.useEffect(() => {
    if (!poster || !framable) return undefined;
    const origin = new URL(src).origin;
    const heard = (event: MessageEvent) => {
      if (event.origin === origin && event.source === frame.current?.contentWindow && event.data?.type === LIVE_FRAME_READY) setReady(true);
    };
    window.addEventListener('message', heard);
    return () => window.removeEventListener('message', heard);
  }, [src, poster, framable]);
  if (!framable) return null;
  const sizes = { '--live-frame-height': `${height}px`, '--live-frame-phone-height': `${phoneHeight}px` } as React.CSSProperties;
  if (!poster) {
    return (
      <iframe
        className={cn('trillion-live-frame', className)}
        src={src}
        title={title}
        loading="lazy"
        allow={allow}
        style={sizes}
        data-live-frame=""
      />
    );
  }
  return (
    <div
      className={cn('trillion-live-frame', className)}
      style={{ ...sizes, position: 'relative', overflow: 'hidden' }}
      data-live-frame=""
      data-live-frame-ready={ready ? '' : undefined}
    >
      <img
        src={poster.src}
        alt={ready ? '' : poster.alt}
        width={poster.width}
        height={poster.height}
        decoding="async"
        aria-hidden={ready || undefined}
        style={{ ...LAYER, objectFit: 'cover', objectPosition: 'top left', opacity: ready ? 0 : 1 }}
      />
      <iframe
        ref={frame}
        src={src}
        title={title}
        loading="lazy"
        allow={allow}
        tabIndex={ready ? undefined : -1}
        aria-hidden={ready ? undefined : true}
        style={{ ...LAYER, opacity: ready ? 1 : 0, pointerEvents: ready ? 'auto' : 'none' }}
      />
    </div>
  );
}
