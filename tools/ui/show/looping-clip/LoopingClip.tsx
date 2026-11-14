// parts/ui/show/looping-clip/LoopingClip.tsx
// NO PRIOR: searched bitfield-packages show folders for autoplay or loop video; trillion parts/ui media-frame, hover-preview and file-preview; 21st.dev for autoplay looping muted video in view
//   (SoftwareDemoBlock is an interactive studio replica; HoverPreview and FilePreview are viewers carrying the
//   workspace's packages; media-frame imports the audio player and framer-motion, which a plain site cannot build;
//   21st.dev offered only modal players and scroll scrubbers.)
//
// PURPOSE
//   A short recording that plays by itself, muted and on a loop, the way a product page shows a feature working: its
//   cover first, then the clip while it is on screen. Any page that shows clips (a public page, a directory card, a
//   Marketplace listing, a document) draws them through this one part.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Domain-blind: the caller hands an address, a cover and a label; this file never knows what the clip shows.
//   2. Plays only while on screen (one IntersectionObserver per clip, disconnected on unmount) and stops when it leaves,
//      so a page of twenty clips decodes only the ones in view.
//   3. Someone who asked their system for less motion sees the cover and nothing moves.
//   4. Depends on React alone, so a site that has none of the workspace's packages can draw it.
//   5. Appearance is the caller's class and the look's tokens; the clip fills its box (object-fit: cover).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { createElement, useEffect, useRef } from 'react';

export interface LoopingClipProps {
  /** Address of the clip (an MP4 or WebM). */
  src: string;
  /** The picture shown before the clip plays, and instead of it when motion is turned down. */
  poster?: string;
  /** What the clip shows, read aloud by a screen reader. */
  label: string;
  className?: string;
}

export function LoopingClip({ src, poster, label, className }: LoopingClipProps) {
  const clip = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const element = clip.current;
    if (!element) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const watcher = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void element.play().catch(() => {});
      else element.pause();
    }, { threshold: 0.25 });
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [src]);
  return createElement('video', {
    ref: clip, src, poster, muted: true, loop: true, playsInline: true, preload: 'metadata',
    'aria-label': label, className, style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' },
  });
}
